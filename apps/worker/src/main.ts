import { processPipelineJob } from './process-job.js'
import { Worker } from 'bullmq'
import { PrismaClient } from '@studio/db'
import { ensureMasterKey } from '@studio/config'
import { PIPELINE_QUEUE, createPipelineQueue, enqueue, jobIdFor, type PipelinePayload } from '@studio/jobs'
import { recordJobIntent } from '@studio/pipeline'
import { FfmpegComposer, storageFrom } from '@studio/media'
import { loadWorkerConfig } from './config.js'
import type { PipelineDeps } from './deps.js'
import { ModelQualityChecker } from './visual-audit.js'

// 与 api 同一段引导：worker 也要解密 provider 凭据，密钥必须同源。
ensureMasterKey()

const config = loadWorkerConfig()
const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } })
const queue = createPipelineQueue({ url: config.redisUrl })

const deps: PipelineDeps = {
  db,
  storage: storageFrom(config.storage),
  composer: new FfmpegComposer(),
  masterKey: config.masterKey,
  qcMode: config.qcMode,
  pollTimeoutMs: config.pollTimeoutMs,
  enqueueJob: async payload => {
    const intent = await recordJobIntent(db, payload)
    try {
      await enqueue(queue, payload)
      await db.jobOutbox.update({ where: { id: intent.id }, data: { status: 'dispatched', dispatchedAt: new Date() } })
    } catch (error) {
      process.stderr.write(`job ${intent.id} dispatch deferred: ${String(error)}\n`)
    }
  },
  // Opt-in: every other mode leaves this unset and run-task falls back to the hash
  // placeholder. Model mode costs a vision-model call per artifact and is not
  // deterministic, so it is never a CI default.
  checker:
    config.qcMode === 'model'
      ? new ModelQualityChecker({ db, masterKey: config.masterKey, pollTimeoutMs: config.pollTimeoutMs })
      : undefined,
}

const worker = new Worker<PipelinePayload>(
  PIPELINE_QUEUE,
  job => processPipelineJob(job, deps),
  { connection: { url: config.redisUrl } },
)

worker.on('failed', (job, error) => {
  process.stderr.write(`job ${job?.id ?? 'unknown'} failed: ${error.message}\n`)
})

// §17/US-035 可恢复 outbox 对账:API 侧投递先落库再推队列,推失败或进程崩溃留下
// 的 pending 行由这里周期重推。jobId=jobIdFor(payload)(api 侧同约定),重推同一行时
// BullMQ 按 jobId 去重,消费端至多执行一次。worker 常驻,是周期对账的常任方。
const OUTBOX_SWEEP_INTERVAL_MS = 30_000

async function sweepJobOutbox(): Promise<void> {
  const rows = await db.jobOutbox.findMany({
    where: { status: 'pending', createdAt: { lt: new Date(Date.now() - OUTBOX_SWEEP_INTERVAL_MS) } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as PipelinePayload
      await queue.add(payload.kind, payload, { jobId: jobIdFor(payload) })
      await db.jobOutbox.update({ where: { id: row.id }, data: { status: 'dispatched', dispatchedAt: new Date() } })
    } catch (error) {
      process.stderr.write(`job outbox ${row.id} sweep failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}

const outboxSweeper = setInterval(() => {
  sweepJobOutbox().catch(error => {
    process.stderr.write(`job outbox sweep failed: ${error instanceof Error ? error.message : String(error)}\n`)
  })
}, OUTBOX_SWEEP_INTERVAL_MS)
outboxSweeper.unref()
sweepJobOutbox().catch(error => {
  process.stderr.write(`job outbox startup sweep failed: ${error instanceof Error ? error.message : String(error)}\n`)
})

process.stdout.write('worker ready\n')

async function shutdown(): Promise<void> {
  clearInterval(outboxSweeper)
  await worker.close()
  await queue.close()
  await deps.storage.close()
  await db.$disconnect()
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    shutdown().then(() => process.exit(0), () => process.exit(1))
  })
}
