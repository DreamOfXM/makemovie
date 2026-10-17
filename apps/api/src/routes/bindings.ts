import type { FastifyInstance } from 'fastify'
import { resolveSlotCandidates, toDbSlot } from '@studio/db'
import { capabilitySlots, isCapabilitySlot, planAutoBind, wiredRequiredSlots, type CapabilitySlot } from '@studio/domain'
import { getCatalog } from '@studio/providers'
import { createBinding, loadOrgModelPool } from '../lib/bindings.js'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

interface BindingBody {
  slot?: string
  capabilityId?: string
  projectId?: string | null
  priority?: number
  enabled?: boolean
}

interface AutoBindBody {
  projectId?: string | null
  slots?: string[]
  /** Auto-binding an optional slot is auto-spending on someone's next generation, so it is never the default. */
  includeOptional?: boolean
  dryRun?: boolean
}

function fromDbSlot(value: string): CapabilitySlot {
  return value.toLowerCase() as CapabilitySlot
}

/**
 * The catalog's explicit `recommendedFor` marking, as a planAutoBind predicate: when a
 * vendor marks a tier for a slot, that tier wins over pool order (which is catalog order
 * at probe time and historically starts at the most expensive row). Unmarked vendors keep
 * pool order — the marking is a product decision per row, not an obligation.
 */
export function recommendedForPredicate() {
  return (candidate: { provider: string; model: string }, slot: CapabilitySlot): boolean => {
    const models = getCatalog(candidate.provider)?.models
    if (!models) return false
    return models.some(row => row.model === candidate.model && row.recommendedFor?.includes(slot))
  }
}

export async function bindingRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { projectId?: string; slot?: string } }>(
    '/bindings',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const slot = request.query.slot
      if (slot !== undefined && !isCapabilitySlot(slot)) return reply.code(400).send({ error: `unknown slot, expected one of: ${capabilitySlots.join(', ')}` })
      const bindings = await app.db.capabilityBinding.findMany({
        where: {
          organizationId: auth.organizationId,
          ...(request.query.projectId ? { projectId: request.query.projectId } : {}),
          ...(slot ? { slot: toDbSlot(slot) } : {}),
        },
        orderBy: [{ projectId: 'asc' }, { slot: 'asc' }, { priority: 'desc' }],
        include: { capability: { include: { connection: { select: { id: true, provider: true, name: true, enabled: true } } } } },
      })
      return bindings.map(b => ({ ...b, slot: fromDbSlot(b.slot) }))
    },
  )

  app.post<{ Body: BindingBody }>('/bindings', { preHandler: requirePermission('bindings:manage') }, async (request, reply) => {
    const auth = request.auth!
    const slot = request.body?.slot
    const capabilityId = request.body?.capabilityId
    if (!slot || !isCapabilitySlot(slot)) return reply.code(400).send({ error: `slot must be one of: ${capabilitySlots.join(', ')}` })
    if (!capabilityId) return reply.code(400).send({ error: 'capabilityId is required' })

    const result = await createBinding(app.db, auth, { slot, capabilityId, projectId: request.body?.projectId ?? null, priority: request.body?.priority, enabled: request.body?.enabled })
    if (!result.ok) return reply.code(result.status).send({ error: result.error })
    return reply.code(201).send(result.binding)
  })

  /**
   * One-click setup for whoever pasted a key: plan what a `planAutoBind` run would bind,
   * then write it through the same `createBinding` the manual endpoint uses. `dryRun`
   * answers "what would you do" without touching the database — the checkpoint between
   * intending to spend and spending stays a human yes.
   */
  app.post<{ Body: AutoBindBody }>('/bindings/auto', { preHandler: requirePermission('bindings:manage') }, async (request, reply) => {
    const auth = request.auth!
    const body = request.body ?? {}

    let slots: CapabilitySlot[]
    if (body.slots) {
      const invalid = body.slots.filter(slot => !isCapabilitySlot(slot))
      if (invalid.length > 0) return reply.code(400).send({ error: `unknown slots: ${invalid.join(', ')}` })
      slots = body.slots as CapabilitySlot[]
    } else {
      // Required slots only. Auto-binding tts_voice or music_gen means the next generation
      // quietly pays for dubbing the user never asked for; that stays behind includeOptional.
      slots = wiredRequiredSlots()
      if (body.includeOptional) slots = [...slots, 'tts_voice']
    }

    const { connections, bindings } = await loadOrgModelPool(app.db, auth.organizationId)
    const plan = planAutoBind(connections, bindings, slots, recommendedForPredicate())

    if (body.dryRun) {
      return { dryRun: true, slots, planned: plan.planned, unfulfilled: plan.unfulfilled }
    }

    const created: Array<{ slot: CapabilitySlot; model: string; bindingId: string }> = []
    const skipped: Array<{ slot: CapabilitySlot; model: string; reason: string }> = []
    for (const choice of plan.planned) {
      const result = await createBinding(app.db, auth, { slot: choice.slot, capabilityId: choice.capabilityId, projectId: body.projectId ?? null })
      if (result.ok) created.push({ slot: choice.slot, model: choice.model, bindingId: result.binding.id })
      else skipped.push({ slot: choice.slot, model: choice.model, reason: result.error })
    }
    // One summary row on top of the per-binding chain createBinding already writes, so the
    // audit log answers "what did the button do" in one read.
    if (created.length > 0 || skipped.length > 0) {
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'binding.auto',
        entityType: 'CapabilityBinding',
        entityId: created[0]?.bindingId ?? 'none',
        payload: {
          slots: plan.planned.map(choice => ({ slot: choice.slot, model: choice.model, provider: choice.provider })),
          created: created.length,
          skipped,
          unfulfilled: plan.unfulfilled,
          projectId: body.projectId ?? null,
        },
      })
    }
    return { dryRun: false, slots, planned: plan.planned, created, skipped, unfulfilled: plan.unfulfilled }
  })

  app.patch<{ Params: { bindingId: string }; Body: BindingBody }>(
    '/bindings/:bindingId',
    { preHandler: requirePermission('bindings:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const binding = await app.db.capabilityBinding.findFirst({ where: { id: request.params.bindingId, organizationId: auth.organizationId } })
      if (!binding) return reply.code(404).send({ error: 'binding not found' })
      const data: { priority?: number; enabled?: boolean } = {}
      if (request.body?.priority !== undefined) data.priority = request.body.priority
      if (request.body?.enabled !== undefined) data.enabled = request.body.enabled
      const updated = await app.db.capabilityBinding.update({ where: { id: binding.id }, data })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'binding.update', entityType: 'CapabilityBinding', entityId: binding.id, payload: data })
      return { ...updated, slot: fromDbSlot(updated.slot) }
    },
  )

  app.delete<{ Params: { bindingId: string } }>(
    '/bindings/:bindingId',
    { preHandler: requirePermission('bindings:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const binding = await app.db.capabilityBinding.findFirst({ where: { id: request.params.bindingId, organizationId: auth.organizationId } })
      if (!binding) return reply.code(404).send({ error: 'binding not found' })
      await app.db.capabilityBinding.delete({ where: { id: binding.id } })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'binding.delete', entityType: 'CapabilityBinding', entityId: binding.id, payload: { slot: fromDbSlot(binding.slot) } })
      return reply.code(204).send()
    },
  )

  app.get<{ Querystring: { slot: string; projectId?: string } }>(
    '/bindings/resolve',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const slot = request.query.slot
      if (!isCapabilitySlot(slot)) return reply.code(400).send({ error: `slot must be one of: ${capabilitySlots.join(', ')}` })
      const projectId = request.query.projectId ?? null
      return { slot, projectId, candidates: await resolveSlotCandidates(app.db, auth.organizationId, projectId, slot) }
    },
  )
}
