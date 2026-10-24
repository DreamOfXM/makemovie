import { recordJobIntent } from '@studio/pipeline'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '@studio/db'
import { createPipelineQueue, jobIdFor, type PipelinePayload } from '@studio/jobs'

type PipelineQueue = ReturnType<typeof createPipelineQueue>

/** §17/US-035 可恢复 outbox:投递先落库再推队列。jobId 用 jobIdFor(payload) 的
 *  确定性形态(run-<taskId>-<attempt> 等)——崩溃后对账扫描重推同一行(同 payload)
 *  时,队列按 jobId 去重,同一条投递意图至多被消费一次;同时消费/测试侧对 jobId
 *  的既有约定(run-/compose-/op- 前缀)保持不变。 */
export const OUTBOX_SWEEP_GRACE_MS = 30_000

/** 每轮对账最多重推的行数:坏行不至于无限霸占扫描。 */
const OUTBOX_SWEEP_BATCH = 100

/** 把一行 outbox 意图推到队列(jobId=jobIdFor(payload),消费端幂等);outboxId 供日志/定位。 */
export type OutboxDispatcher = (payload: PipelinePayload, outboxId: string) => Promise<void>

/**
 * §17/US-035 对账扫描:把 pending 且早于宽限期(默认 30s,给"已推送未标记"的窗口
 * 留出队列侧生效时间)的行重推并标 dispatched。单行推送失败留在 pending,下一轮
 * 再试;返回本轮成功重推的行数。周期性由调用方注册(worker 每 30s;API 进程 ready
 * 后补扫一次崩溃遗留)。
 */
export async function sweepJobOutbox(db: PrismaClient, dispatch: OutboxDispatcher, options: { olderThanMs?: number } = {}): Promise<number> {
  const olderThanMs = options.olderThanMs ?? OUTBOX_SWEEP_GRACE_MS
  const rows = await db.jobOutbox.findMany({
    where: { status: 'pending', createdAt: { lt: new Date(Date.now() - olderThanMs) } },
    orderBy: { createdAt: 'asc' },
    take: OUTBOX_SWEEP_BATCH,
  })
  let swept = 0
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as PipelinePayload
      await dispatch(payload, row.id)
      await db.jobOutbox.update({ where: { id: row.id }, data: { status: 'dispatched', dispatchedAt: new Date() } })
      swept += 1
    } catch {
      // 推送仍失败(队列不可达/载荷损坏):留 pending,下一轮重试。
    }
  }
  return swept
}

/** 每个 app 实例只注册一次 ready 补扫(pipelineJobs 会被多个路由文件各自调用)。 */
const sweptApps = new WeakSet<FastifyInstance>()

/**
 * The app's pipeline queue as an `enqueueJob`, for the routes that hand work to the
 * worker. Lazily created: constructing a BullMQ queue opens a Redis connection, and
 * an instance that never enqueues — a read-only replica, a test that only exercises
 * refusals — should not need one. The queue it does create is closed with the app.
 *
 * §17/US-035 可恢复 outbox:「DB 写任务 → 入队」不再是裸的两步:先 insert
 * JobOutbox(payload, organizationId),再推 BullMQ(jobId=outbox id),成功后标
 * dispatched;推失败留在 pending,由 sweepJobOutbox 重推。投递意图一旦落库,
 * 这里不再向调用方抛错——批次已经创建,晚一点到队首不是失败,是延迟。
 */
export function pipelineJobs(app: FastifyInstance): (payload: PipelinePayload) => Promise<void> {
  let queue: PipelineQueue | undefined
  app.addHook('onClose', async () => {
    await queue?.close()
  })
  if (!sweptApps.has(app)) {
    sweptApps.add(app)
    app.addHook('onReady', async () => {
      // 先扫行再建队列:没有 pending 遗留的实例不因补扫打开 Redis 连接。
      try {
        await sweepJobOutbox(app.db, async payload => {
          queue ??= createPipelineQueue()
          await queue.add(payload.kind, payload, { jobId: jobIdFor(payload) })
        })
      } catch (error) {
        process.stderr.write(`job outbox startup sweep failed: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    })
  }
  return async payload => {
    const row = await recordJobIntent(app.db, payload)
    queue ??= createPipelineQueue()
    try {
      await queue.add(payload.kind, payload, { jobId: jobIdFor(payload) })
      await app.db.jobOutbox.update({ where: { id: row.id }, data: { status: 'dispatched', dispatchedAt: new Date() } })
    } catch (error) {
      process.stderr.write(`job outbox ${row.id} push failed, left pending for sweep: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}
