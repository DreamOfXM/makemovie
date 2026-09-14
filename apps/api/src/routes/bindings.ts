import type { FastifyInstance } from 'fastify'
import { resolveSlotCandidates, toDbSlot } from '@studio/db'
import { canBind, capabilitySlots, isCapabilitySlot, type CapabilitySlot } from '@studio/domain'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

interface BindingBody {
  slot?: string
  capabilityId?: string
  projectId?: string | null
  priority?: number
  enabled?: boolean
}

function fromDbSlot(value: string): CapabilitySlot {
  return value.toLowerCase() as CapabilitySlot
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

    const capability = await app.db.modelCapability.findFirst({
      where: { id: capabilityId, connection: { organizationId: auth.organizationId } },
      include: { connection: true },
    })
    if (!capability) return reply.code(404).send({ error: 'capability not found in this organization' })

    const check = canBind(slot, {
      provider: capability.connection.provider,
      model: capability.model,
      modality: capability.modality as never,
      acceptsFirstFrame: capability.acceptsFirstFrame,
      acceptsReferenceImages: capability.acceptsReferenceImages,
      maxReferenceImages: capability.maxReferenceImages,
      entitlementVerifiedAt: capability.entitlementVerifiedAt,
    })
    if (!check.ok) return reply.code(422).send({ error: check.reason })
    if (!capability.entitlementVerifiedAt) {
      return reply.code(422).send({ error: `model "${capability.model}" has no verified entitlement; run a provider probe first` })
    }

    let projectId: string | null = null
    if (request.body?.projectId) {
      const project = await app.db.project.findFirst({ where: { id: request.body.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'project not found' })
      projectId = project.id
    }

    const duplicate = await app.db.capabilityBinding.findFirst({
      where: { organizationId: auth.organizationId, projectId, slot: toDbSlot(slot), capabilityId },
    })
    if (duplicate) return reply.code(409).send({ error: 'this capability is already bound to this slot at the same scope' })

    const binding = await app.db.capabilityBinding.create({
      data: {
        organizationId: auth.organizationId,
        projectId,
        slot: toDbSlot(slot),
        capabilityId,
        priority: request.body?.priority ?? 0,
        enabled: request.body?.enabled ?? true,
      },
      include: { capability: true },
    })
    await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'binding.create', entityType: 'CapabilityBinding', entityId: binding.id, payload: { slot, model: capability.model, projectId, priority: binding.priority } })
    return reply.code(201).send({ ...binding, slot })
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
