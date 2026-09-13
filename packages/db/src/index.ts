import type { PrismaClient, TaskStatus, WorkflowStatus } from '@prisma/client'

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
