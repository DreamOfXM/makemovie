import type { FastifyInstance } from 'fastify'
import { isRole } from '@studio/domain'
import { recordAudit } from '../lib/audit.js'
import { revokeSessionsForMembership } from '../lib/sessions.js'
import { requirePermission } from '../plugins/auth.js'

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  app.get('/members', { preHandler: requirePermission('read') }, async request => {
    const auth = request.auth!
    const memberships = await app.db.organizationMember.findMany({
      where: { organizationId: auth.organizationId },
      include: { user: { select: { id: true, email: true, name: true, createdAt: true } } },
      orderBy: { user: { createdAt: 'asc' } },
    })
    return memberships.map(item => ({
      userId: item.userId,
      email: item.user.email,
      name: item.user.name,
      role: item.role,
      joinedAt: item.user.createdAt,
    }))
  })

  app.post<{ Body: { email?: string; role?: string } }>(
    '/members',
    { preHandler: requirePermission('members:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const email = request.body?.email?.trim().toLowerCase()
      const role = request.body?.role
      if (!email) return reply.code(400).send({ error: 'email is required' })
      if (typeof role !== 'string' || !isRole(role) || role === 'OWNER') return reply.code(400).send({ error: 'role must be one of ADMIN, EDITOR, REVIEWER, VIEWER' })

      const db = app.db
      const user = await db.user.findUnique({ where: { email } })
      if (!user) return reply.code(404).send({ error: 'No registered user with this email; ask them to register first' })
      const existing = await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: auth.organizationId, userId: user.id } } })
      if (existing) return reply.code(409).send({ error: 'User is already a member' })

      const membership = await db.organizationMember.create({ data: { organizationId: auth.organizationId, userId: user.id, role } })
      await recordAudit(db, { organizationId: auth.organizationId, userId: auth.userId, action: 'member.add', entityType: 'User', entityId: user.id, payload: { email, role } })
      return reply.code(201).send({ userId: user.id, email, role: membership.role })
    },
  )

  app.patch<{ Params: { userId: string }; Body: { role?: string } }>(
    '/members/:userId',
    { preHandler: requirePermission('members:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const targetUserId = request.params.userId
      const role = request.body?.role
      if (typeof role !== 'string' || !isRole(role) || role === 'OWNER') return reply.code(400).send({ error: 'role must be one of ADMIN, EDITOR, REVIEWER, VIEWER' })
      if (targetUserId === auth.userId) return reply.code(400).send({ error: 'You cannot change your own role' })

      const db = app.db
      const membership = await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: auth.organizationId, userId: targetUserId } } })
      if (!membership) return reply.code(404).send({ error: 'Member not found' })
      if (membership.role === 'OWNER' && auth.role !== 'OWNER') return reply.code(403).send({ error: 'Only the owner can change the owner role' })

      const updated = await db.organizationMember.update({ where: { organizationId_userId: { organizationId: auth.organizationId, userId: targetUserId } }, data: { role } })
      await recordAudit(db, { organizationId: auth.organizationId, userId: auth.userId, action: 'member.role_change', entityType: 'User', entityId: targetUserId, payload: { from: membership.role, to: role } })
      return { userId: targetUserId, role: updated.role }
    },
  )

  app.delete<{ Params: { userId: string } }>(
    '/members/:userId',
    { preHandler: requirePermission('members:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const targetUserId = request.params.userId
      if (targetUserId === auth.userId) return reply.code(400).send({ error: 'You cannot remove yourself' })

      const db = app.db
      const membership = await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: auth.organizationId, userId: targetUserId } } })
      if (!membership) return reply.code(404).send({ error: 'Member not found' })
      if (membership.role === 'OWNER') return reply.code(403).send({ error: 'The owner cannot be removed' })

      await db.organizationMember.delete({ where: { organizationId_userId: { organizationId: auth.organizationId, userId: targetUserId } } })
      await revokeSessionsForMembership(db, targetUserId, auth.organizationId)
      await recordAudit(db, { organizationId: auth.organizationId, userId: auth.userId, action: 'member.remove', entityType: 'User', entityId: targetUserId })
      return reply.code(204).send()
    },
  )
}
