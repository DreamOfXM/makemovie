import type { PrismaClient } from '@studio/db'

export interface AuditEntry {
  organizationId: string
  userId?: string | null
  action: string
  entityType: string
  entityId: string
  payload?: unknown
}

export async function recordAudit(db: PrismaClient, entry: AuditEntry): Promise<void> {
  await db.auditEvent.create({
    data: {
      organizationId: entry.organizationId,
      userId: entry.userId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      payload: JSON.stringify(entry.payload ?? {}),
    },
  })
}
