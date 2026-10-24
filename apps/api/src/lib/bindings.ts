import type { PrismaClient } from '@studio/db'
import { canBind, isCapabilitySlot, type BindingLike, type ConnectionLike, type CapabilitySlot } from '@studio/domain'
import { toDbSlot } from '@studio/db'
import { recordAudit } from './audit.js'

/**
 * The single write path for capability bindings. `POST /bindings` (one row, hand-picked)
 * and `POST /bindings/auto` (rows picked by `planAutoBind`) both funnel through here, so
 * the checks can never drift between a human's binding and an automated one: capability
 * must belong to this org, `canBind` must accept it, the vendor must have verified the
 * entitlement or at least the key, the scope must exist, and the same row must not be
 * bound twice at the same scope.
 */

export interface CreateBindingInput {
  slot: CapabilitySlot
  capabilityId: string
  projectId?: string | null
  priority?: number
  enabled?: boolean
}

export interface CreateBindingActor {
  organizationId: string
  userId?: string | null
}

export type CreateBindingResult =
  | { ok: true; binding: { id: string; slot: string; capability: unknown }; model: string }
  | { ok: false; status: number; error: string }

export async function createBinding(
  db: PrismaClient,
  actor: CreateBindingActor,
  input: CreateBindingInput,
): Promise<CreateBindingResult> {
  if (!isCapabilitySlot(input.slot)) {
    return { ok: false, status: 400, error: `slot must be one of the capability slots` }
  }

  const capability = await db.modelCapability.findFirst({
    where: { id: input.capabilityId, connection: { organizationId: actor.organizationId } },
    include: { connection: true },
  })
  if (!capability) return { ok: false, status: 404, error: 'capability not found in this organization' }

  const check = canBind(input.slot, {
    provider: capability.connection.provider,
    model: capability.model,
    modality: capability.modality as never,
    acceptsFirstFrame: capability.acceptsFirstFrame,
    acceptsReferenceImages: capability.acceptsReferenceImages,
    maxReferenceImages: capability.maxReferenceImages,
    entitlementVerifiedAt: capability.entitlementVerifiedAt,
  })
  if (!check.ok) return { ok: false, status: 422, error: check.reason! }
  // Entitlement means a call addressed this exact model. A connection probe only proves
  // the key (credentialVerifiedAt) — enough to bind, and the first real generation
  // either proves the model or fails loudly.
  if (!capability.entitlementVerifiedAt && !capability.credentialVerifiedAt) {
    return { ok: false, status: 422, error: `model "${capability.model}" has no verified entitlement; run a provider probe first` }
  }

  let projectId: string | null = null
  if (input.projectId) {
    const project = await db.project.findFirst({ where: { id: input.projectId, organizationId: actor.organizationId } })
    if (!project) return { ok: false, status: 404, error: 'project not found' }
    projectId = project.id
  }

  const duplicate = await db.capabilityBinding.findFirst({
    where: { organizationId: actor.organizationId, projectId, slot: toDbSlot(input.slot), capabilityId: input.capabilityId },
  })
  if (duplicate) return { ok: false, status: 409, error: 'this capability is already bound to this slot at the same scope' }

  const binding = await db.capabilityBinding.create({
    data: {
      organizationId: actor.organizationId,
      projectId,
      slot: toDbSlot(input.slot),
      capabilityId: input.capabilityId,
      priority: input.priority ?? 0,
      enabled: input.enabled ?? true,
    },
    include: { capability: true },
  })
  await recordAudit(db, {
    organizationId: actor.organizationId,
    userId: actor.userId,
    action: 'binding.create',
    entityType: 'CapabilityBinding',
    entityId: binding.id,
    payload: { slot: input.slot, model: capability.model, projectId, priority: binding.priority },
  })
  // The stored enum is uppercase; every consumer speaks the lowercase domain vocabulary.
  return { ok: true, binding: { ...binding, slot: input.slot }, model: capability.model }
}

/**
 * Everything planAutoBind and the readiness rules need to look at, in the structural
 * shapes @studio/domain accepts. The Prisma rows already satisfy them — only the slot
 * enum needs lowercasing — so the server-side view and the console's DTOs run through
 * the same predicates without a mapping layer that could drift.
 */
export async function loadOrgModelPool(db: PrismaClient, organizationId: string): Promise<{ connections: ConnectionLike[]; bindings: BindingLike[] }> {
  const [connections, bindings] = await Promise.all([
    db.providerConnection.findMany({
      where: { organizationId },
      include: { capabilities: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.capabilityBinding.findMany({
      where: { organizationId },
      include: { capability: { include: { connection: { select: { provider: true, enabled: true } } } } },
    }),
  ])
  return {
    connections,
    bindings: bindings.map(binding => ({ ...binding, slot: binding.slot.toLowerCase() })),
  }
}

/**
 * 目标项目的有效配置视图：组织继承（projectId=null）+ 本项目覆盖，其他项目的专属
 * 绑定不可见——与执行器 resolveSlotCandidates 的取数语义逐条一致（2026-10-19 R03：
 * 曾把全组织绑定直接喂 slotReadiness，A 的项目级绑定让 B 误报 4/4 就绪、实际零候选）。
 * 项目级就绪、自动绑定规划一律从这里取数；组织控制台的全量视图继续用 loadOrgModelPool。
 */
export async function loadProjectModelPool(
  db: PrismaClient,
  organizationId: string,
  projectId: string | null,
): Promise<{ connections: ConnectionLike[]; bindings: BindingLike[] }> {
  const pool = await loadOrgModelPool(db, organizationId)
  return { connections: pool.connections, bindings: pool.bindings.filter(binding => binding.projectId === null || binding.projectId === projectId) }
}
