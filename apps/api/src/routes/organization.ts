import type { FastifyInstance } from 'fastify'
import { contentLocales, isContentLocale } from '@studio/domain'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

/**
 * 空间级设置。目前只有「新建作品时缺省的内容语言」——它只在建项那一刻被读取，
 * 改它不会重写任何已有作品的 contentLocale（那一项在建项时已锁定）。
 */
export async function organizationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/organization', { preHandler: requirePermission('read') }, async request => {
    const auth = request.auth!
    const organization = await app.db.organization.findUniqueOrThrow({
      where: { id: auth.organizationId },
      select: { id: true, name: true, slug: true, defaultContentLocale: true },
    })
    return organization
  })

  app.patch<{ Body: { defaultContentLocale?: string } }>(
    '/organization',
    { preHandler: requirePermission('org:update') },
    async (request, reply) => {
      const auth = request.auth!
      const { defaultContentLocale } = request.body ?? {}
      if (defaultContentLocale === undefined) {
        return reply.code(400).send({ error: 'defaultContentLocale is required' })
      }
      if (!isContentLocale(defaultContentLocale)) {
        return reply.code(400).send({ error: `defaultContentLocale must be one of ${contentLocales.join(', ')}` })
      }
      const before = await app.db.organization.findUniqueOrThrow({ where: { id: auth.organizationId }, select: { defaultContentLocale: true } })
      const updated = await app.db.organization.update({
        where: { id: auth.organizationId },
        data: { defaultContentLocale },
        select: { id: true, name: true, slug: true, defaultContentLocale: true },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'organization.update',
        entityType: 'Organization',
        entityId: auth.organizationId,
        payload: { from: { defaultContentLocale: before.defaultContentLocale }, to: { defaultContentLocale: updated.defaultContentLocale } },
      })
      return updated
    },
  )
}
