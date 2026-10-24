import { DelayedError, type Job } from 'bullmq'
import type { PipelinePayload } from '@studio/jobs'
import type { PipelineDeps } from './deps.js'
import { runTask } from './run-task.js'
import { composeEpisode } from './compose.js'
import { runArtifactOperation } from './run-artifact-operation.js'

/** Pausing defers the existing delivery; it must never acknowledge unfinished work. */
export async function processPipelineJob(job: Job<PipelinePayload>, deps: PipelineDeps): Promise<void> {
  const payload = job.data
  if (payload.kind === 'run-task') {
    if (await runTask(payload, deps) === 'paused') {
      await job.moveToDelayed(Date.now() + 1_000, job.token)
      throw new DelayedError()
    }
  } else if (payload.kind === 'compose-episode') {
    await composeEpisode(payload, deps)
  } else {
    await runArtifactOperation(payload, deps)
  }
}
