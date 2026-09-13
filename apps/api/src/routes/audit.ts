import type { FastifyInstance } from 'fastify'
import { requirePermission } from '../plugins/auth.js'

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: string; before?: string; action?: string } }>(
    '/audit-events',
    { preHandler: requirePermission('audit:read') },
    async (request, reply) => {
      const auth = request.auth!
      const limit = Math.min(Math.max(Number(request.query.limit ?? 50) || 50, 1), 200)
      const events = await app.db.auditEvent.findMany({
        where: {
          organizationId: auth.organizationId,
          ...(request.query.before ? { id: { lt: request.query.before } } : {}),
          ...(request.query.action ? { action: request.query.action } : {}),
        },
        include: { user: { select: { email: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      })
      return {
        events: events.map(event => ({
          id: event.id,
          action: event.action,
          entityType: event.entityType,
          entityId: event.entityId,
          userEmail: event.user?.email ?? null,
          payload: JSON.parse(event.payload),
          createdAt: event.createdAt,
        })),
        nextCursor: events.length === limit ? events[events.length - 1]?.id : null,
      }
    },
  )

  app.delete('/sessions/expired', { preHandler: requirePermission('audit:read') }, async (_request, reply) => {
    const result = await app.db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } })
    return reply.send({ pruned: result.count })
  })
}
