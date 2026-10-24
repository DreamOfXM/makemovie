import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

/**
 * US-035 暂停 Run:POST /generation-batches/:id/pause 停止该批次的新派发——暂停的
 * 批次里 QUEUED 任务保持排队,worker 的领取条件带 batch.paused=false,不会被消费;
 * resume 恢复派发,排队任务照常被领取执行。
 *
 * 语义边界(与取消不同):暂停只停「新派发」,不掐 RUNNING 任务、不释放已发生调用
 * 的预算——provider 请求已发出,那部分次数已经烧掉,等调用落定自然结算。
 */
export async function batchRoutes(app: FastifyInstance): Promise<void> {
  const findBatchInOrg = async (batchId: string, organizationId: string) =>
    app.db.generationBatch.findFirst({
      // 组织归属沿 batch→episode→project 链校验,不信任行上的裸 organizationId。
      where: { id: batchId, episode: { project: { organizationId } } },
      select: { id: true, stage: true, paused: true },
    })

  app.post<{ Params: { id: string } }>(
    '/generation-batches/:id/pause',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const batch = await findBatchInOrg(request.params.id, auth.organizationId)
      if (!batch) return reply.code(404).send({ error: 'batch not found' })
      if (batch.paused) return reply.code(409).send({ error: 'batch already paused' })
      await app.db.generationBatch.update({ where: { id: batch.id }, data: { paused: true } })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'generation.pause', entityType: 'generation-batch', entityId: batch.id, payload: { stage: batch.stage } })
      return { id: batch.id, paused: true }
    },
  )

  app.post<{ Params: { id: string } }>(
    '/generation-batches/:id/resume',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const batch = await findBatchInOrg(request.params.id, auth.organizationId)
      if (!batch) return reply.code(404).send({ error: 'batch not found' })
      if (!batch.paused) return reply.code(409).send({ error: 'batch is not paused' })
      await app.db.generationBatch.update({ where: { id: batch.id }, data: { paused: false } })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'generation.resume', entityType: 'generation-batch', entityId: batch.id, payload: { stage: batch.stage } })
      return { id: batch.id, paused: false }
    },
  )
}
