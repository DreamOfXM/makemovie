import type { PrismaClient } from '@studio/db'
import type { Role } from '@studio/domain'
import { generateToken, hashToken } from '@studio/security'
import type { AuthContext } from '../types.js'

export async function createSession(db: PrismaClient, userId: string, organizationId: string, ttlMs: number): Promise<string> {
  const token = generateToken()
  await db.session.create({
    data: { tokenHash: hashToken(token), userId, organizationId, expiresAt: new Date(Date.now() + ttlMs) },
  })
  return token
}

export async function resolveSession(db: PrismaClient, token: string): Promise<AuthContext | null> {
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { memberships: true } } },
  })
  if (!session) return null
  if (session.expiresAt.getTime() < Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined)
    return null
  }
  const membership = session.user.memberships.find(item => item.organizationId === session.organizationId)
  if (!membership) return null
  return {
    sessionId: session.id,
    userId: session.userId,
    organizationId: session.organizationId,
    role: membership.role as Role,
    userEmail: session.user.email,
  }
}

export async function revokeSession(db: PrismaClient, token: string): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash: hashToken(token) } })
}

export async function revokeSessionsForMembership(db: PrismaClient, userId: string, organizationId: string): Promise<void> {
  await db.session.deleteMany({ where: { userId, organizationId } })
}

export async function pruneExpiredSessions(db: PrismaClient): Promise<number> {
  const result = await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  return result.count
}
