import type { CapabilitySlot, PrismaClient, TaskStatus, WorkflowStatus } from '@prisma/client'
import type { CapabilitySlot as DomainCapabilitySlot } from '@studio/domain'

export { PrismaClient } from '@prisma/client'
export * from '@prisma/client'

/**
 * Derives a batch's workflow status from its task counts. A batch stays RUNNING
 * while anything is still in flight; once every task settles it is COMPLETED,
 * BLOCKED (a failure needs a human), NEEDS_REVIEW (partly cancelled), or
 * CANCELLED (nothing ran).
 */
export function rollUpBatchStatus(counts: Partial<Record<TaskStatus, number>>): WorkflowStatus {
  const of = (status: TaskStatus): number => counts[status] ?? 0
  const total = (Object.values(counts) as number[]).reduce((sum, value) => sum + value, 0)
  if (total === 0) return 'DRAFT'
  if (of('QUEUED') > 0 || of('RUNNING') > 0) return 'RUNNING'
  if (of('FAILED') > 0 || of('BLOCKED') > 0) return 'BLOCKED'
  if (of('CANCELLED') > 0) return of('SUCCEEDED') > 0 ? 'NEEDS_REVIEW' : 'CANCELLED'
  return 'COMPLETED'
}

/** Recomputes and persists a batch's status; call after every task transition. */
export async function syncBatchStatus(db: PrismaClient, batchId: string): Promise<WorkflowStatus> {
  const grouped = await db.generationTask.groupBy({
    by: ['status'],
    where: { batchId },
    _count: { _all: true },
  })
  const counts = Object.fromEntries(grouped.map(group => [group.status, group._count._all])) as Partial<Record<TaskStatus, number>>
  const status = rollUpBatchStatus(counts)
  await db.generationBatch.update({ where: { id: batchId }, data: { status } })
  return status
}

/** Slots are lowercase in the domain vocabulary and an UPPERCASE enum in the schema. */
export function toDbSlot(slot: DomainCapabilitySlot): CapabilitySlot {
  return slot.toUpperCase() as CapabilitySlot
}

/**
 * One ordered fallback for a capability slot. Carries the superset of what the
 * worker needs to open a provider (connection, capability, provider, model) and
 * what the console needs to explain the ordering to a human (scope, priority,
 * display name, modality).
 */
export interface SlotCandidate {
  bindingId: string
  scope: 'project' | 'organization'
  priority: number
  capabilityId: string
  connectionId: string
  connectionName: string
  provider: string
  model: string
  displayName: string | null
  modality: string
}

/**
 * Resolves the ordered fallbacks for `slot`. A project-scoped binding beats an
 * organization-scoped one regardless of priority, priority descends within a
 * scope, and only verified capabilities on enabled connections survive. Passing
 * `projectId: null` asks for organization scope only.
 *
 * Deduplication is by capability, not by binding: the same model bound at both
 * scopes is one fallback, because retrying it after it failed at the narrower
 * scope would just fail again.
 */
export async function resolveSlotCandidates(
  db: PrismaClient,
  organizationId: string,
  projectId: string | null,
  slot: DomainCapabilitySlot,
): Promise<SlotCandidate[]> {
  const bindings = await db.capabilityBinding.findMany({
    where: { organizationId, slot: toDbSlot(slot), enabled: true },
    orderBy: { priority: 'desc' },
    include: { capability: { include: { connection: true } } },
  })
  const projectScoped = bindings.filter(binding => binding.projectId === projectId)
  const orgScoped = bindings.filter(binding => binding.projectId === null)
  const seen = new Set<string>()
  const candidates: SlotCandidate[] = []
  for (const binding of [...projectScoped, ...orgScoped]) {
    if (seen.has(binding.capabilityId)) continue
    if (!binding.capability.entitlementVerifiedAt) continue
    if (!binding.capability.connection.enabled) continue
    seen.add(binding.capabilityId)
    candidates.push({
      bindingId: binding.id,
      scope: binding.projectId ? 'project' : 'organization',
      priority: binding.priority,
      capabilityId: binding.capability.id,
      connectionId: binding.capability.connectionId,
      connectionName: binding.capability.connection.name,
      provider: binding.capability.connection.provider,
      model: binding.capability.model,
      displayName: binding.capability.displayName,
      modality: binding.capability.modality,
    })
  }
  return candidates
}

/** The generation stages in pipeline order (the API stage vocabulary). */
export const PIPELINE_STAGES = ['SCRIPT', 'STORYBOARD', 'ASSET', 'IMAGE', 'VIDEO'] as const
export type PipelineStage = (typeof PIPELINE_STAGES)[number]

/**
 * The next generation stage whose prerequisites are satisfied and which has not
 * yet been run for this episode, or null when nothing is currently runnable.
 * Prerequisites: SCRIPT needs an approved source, STORYBOARD an approved script,
 * ASSET at least one authored asset, IMAGE/VIDEO at least one storyboard. This is
 * what lets the pipeline advance one step at a time without a human re-triggering
 * each stage.
 */
export async function nextRunnableStage(db: PrismaClient, episodeId: string): Promise<PipelineStage | null> {
  const [approvedSource, approvedScript, assetCount, storyboardCount, batches] = await Promise.all([
    db.sourceDocumentVersion.findFirst({ where: { episodeId, status: 'APPROVED' }, select: { id: true } }),
    db.scriptVersion.findFirst({ where: { episodeId, status: 'APPROVED' }, select: { id: true } }),
    db.asset.count({ where: { episodeId } }),
    db.storyboard.count({ where: { episodeId } }),
    db.generationBatch.findMany({ where: { episodeId }, select: { stage: true } }),
  ])
  const run = new Set(batches.map(batch => batch.stage))

  for (const stage of PIPELINE_STAGES) {
    if (run.has(stage as never)) continue
    const ready =
      stage === 'SCRIPT' ? approvedSource !== null
      : stage === 'STORYBOARD' ? approvedScript !== null
      : stage === 'ASSET' ? assetCount > 0
      : storyboardCount > 0
    if (ready) return stage
  }
  return null
}
