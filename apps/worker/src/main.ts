import { Worker } from 'bullmq'
import { PrismaClient } from '@studio/db'
import { PIPELINE_QUEUE, createPipelineQueue, enqueue, type PipelinePayload } from '@studio/jobs'
import { FfmpegComposer, storageFrom } from '@studio/media'
import { composeEpisode } from './compose.js'
import { loadWorkerConfig } from './config.js'
import type { PipelineDeps } from './deps.js'
import { runTask } from './run-task.js'
import { ModelQualityChecker } from './visual-audit.js'

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
  enqueueJob: payload => enqueue(queue, payload),
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
  await deps.storage.close()
  await db.$disconnect()
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    shutdown().then(() => process.exit(0), () => process.exit(1))
  })
}
