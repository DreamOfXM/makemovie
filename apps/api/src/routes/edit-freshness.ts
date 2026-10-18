import type { FastifyInstance } from 'fastify'
import { requirePermission } from '../plugins/auth.js'

/**
 * US-028 内容依赖与成片失效:GET /episodes/:id/edit/freshness
 * 回答「最新合成还代表当前编辑吗?」——比较合成记录的 inputFingerprint
 * 与当前编辑 head 的 fingerprint。不匹配 = 旧渲染,不能冒充当前。
 */
export async function editFreshnessRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/edit/freshness',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } } })
      if (!episode) return reply.code(404).send({ error: 'episode not found' })

      const [edit, latestComposition] = await Promise.all([
        app.db.episodeEdit.findUnique({ where: { episodeId: episode.id }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } }),
        app.db.composition.findFirst({ where: { episodeId: episode.id, status: 'COMPLETED' }, orderBy: { id: 'desc' } }),
      ])

      const currentFingerprint = edit?.revisions[0]?.fingerprint ?? null
      const compositionFingerprint = latestComposition?.inputFingerprint ?? null

      // 无编辑/无合成 → 不能判断。
      if (currentFingerprint === null) return { status: 'no_edit' as const, message: 'episode has no edit timeline' }
      if (latestComposition === null) return { status: 'no_composition' as const, message: 'episode has no completed composition' }

      const fresh = currentFingerprint === compositionFingerprint
      return {
        status: fresh ? 'fresh' as const : 'stale' as const,
        message: fresh ? 'composition matches the current edit revision' : 'edit has changed since the last composition — re-render to update',
        editRevision: edit!.revisions[0]!.revision,
        compositionId: latestComposition.id,
        currentFingerprint,
        compositionFingerprint,
      }
    },
  )
}
