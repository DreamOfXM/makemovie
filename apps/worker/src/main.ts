import { Worker } from 'bullmq'
import { PrismaClient } from '@studio/db'
import { PIPELINE_QUEUE, createPipelineQueue, enqueue, type PipelinePayload } from '@studio/jobs'
import { DiskStorage, FfmpegComposer } from '@studio/media'
import { composeEpisode } from './compose.js'
import { loadWorkerConfig } from './config.js'
import type { PipelineDeps } from './deps.js'
import { runTask } from './run-task.js'

const config = loadWorkerConfig()
const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } })
const queue = createPipelineQueue({ url: config.redisUrl })

const deps: PipelineDeps = {
  db,
  storage: new DiskStorage(config.artifactsDir),
  composer: new FfmpegComposer(),
  masterKey: config.masterKey,
  qcMode: config.qcMode,
  enqueueJob: payload => enqueue(queue, payload),
}

const worker = new Worker<PipelinePayload>(
  PIPELINE_QUEUE,
  async job => {
    const payload = job.data
    return payload.kind === 'run-task' ? runTask(payload, deps) : composeEpisode(payload, deps)
  },
  { connection: { url: config.redisUrl } },
)

worker.on('failed', (job, error) => {
  process.stderr.write(`job ${job?.id ?? 'unknown'} failed: ${error.message}\n`)
})

process.stdout.write('worker ready\n')

async function shutdown(): Promise<void> {
  await worker.close()
  await queue.close()
  await db.$disconnect()
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    shutdown().then(() => process.exit(0), () => process.exit(1))
  })
}
