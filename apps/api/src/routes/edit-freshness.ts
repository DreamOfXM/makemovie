import type { FastifyInstance } from 'fastify'
import { compositionInputDrift } from '@studio/pipeline'
import { requirePermission } from '../plugins/auth.js'

/**
 * US-028 内容依赖与成片失效:GET /episodes/:id/edit/freshness
 * 回答「最新合成还代表当前编辑吗?」——三条轴分别核:合成记录的 inputFingerprint
 * 对当前编辑 head 的 fingerprint(剪辑结构),以及按现在的输入重算出的段集指纹
 * (拼接镜的段)与转场指纹(每一刀怎么进)。任一不匹配 = 旧渲染,不能冒充当前。
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

      // S2d/S4② 另外两条过期轴：重跑拼接镜的任一段会产一颗新母带、改一镜的转场会换
      // 同一批画面的接法，两种情况下剪辑结构一个字没改，编辑指纹照样匹配。只认编辑
      // 指纹就把「段是旧的」「接法是旧的」报成当前成片。
      const drift = await compositionInputDrift(app.db, episode.id, latestComposition.manifest)
      const editStale = currentFingerprint !== compositionFingerprint
      const fresh = !editStale && !drift.takes && !drift.transitions
      const reason = editStale
        ? 'edit has changed since the last composition — re-render to update'
        : drift.takes
          ? 'a segment of a spliced shot was re-cut since this render — re-render to update'
          : 'a shot transition was changed since this render — re-render to update'
      return {
        status: fresh ? 'fresh' as const : 'stale' as const,
        message: fresh ? 'composition matches the current edit revision' : reason,
        editRevision: edit!.revisions[0]!.revision,
        compositionId: latestComposition.id,
        currentFingerprint,
        compositionFingerprint,
        takeCutStale: drift.takes,
        transitionStale: drift.transitions,
      }
    },
  )
}
