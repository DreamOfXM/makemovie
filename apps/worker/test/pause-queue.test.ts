import { it, expect, vi } from 'vitest'
import { Worker } from 'bullmq'
import { jobIdFor } from '@studio/jobs'
import { MockProviderAdapter } from '@studio/providers'
import { startTestEnv } from './env.js'
import { processPipelineJob } from '../src/process-job.js'

it('retains a paused BullMQ delivery and executes it once after resume', async () => {
  const env = await startTestEnv()
  const submit = vi.spyOn(MockProviderAdapter.prototype, 'submit')
  let worker: Worker | undefined
  try {
    const seed = await env.seed({ stage: 'MUSIC', modality: 'music', model: 'mock-music' })
    const payload = env.runPayload(seed)
    await env.db.generationBatch.update({ where: { id: seed.batchId }, data: { paused: true } })
    worker = new Worker(env.queue.name, job => processPipelineJob(job, env.deps({ pollIntervalMs: 1 })), { connection: { host: '127.0.0.1', port: 6380, db: 5 } })
    await env.queue.add(payload.kind, payload, { jobId: jobIdFor(payload) })
    await vi.waitFor(async () => {
      const job = await env.queue.getJob(jobIdFor(payload))
      expect(await job?.getState()).toBe('delayed')
      expect(job?.attemptsMade).toBe(0)
    }, { timeout: 5_000 })
    expect(submit).not.toHaveBeenCalled()
    await env.db.generationBatch.update({ where: { id: seed.batchId }, data: { paused: false } })
    await vi.waitFor(async () => {
      expect((await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })).status).toBe('SUCCEEDED')
    }, { timeout: 8_000 })
    expect(submit).toHaveBeenCalledTimes(1)
  } finally {
    await worker?.close()
    submit.mockRestore()
    await env.stop()
  }
})

it('pauses before the next candidate submits and resumes without repeating the failed candidate', async () => {
  const env = await startTestEnv()
  const submit = vi.spyOn(MockProviderAdapter.prototype, 'submit')
  try {
    const seed = await env.seed({ stage: 'MUSIC', modality: 'music', model: 'mock-music' })
    const payload = env.runPayload(seed)
    payload.candidates.push(payload.candidates[0]!)
    vi.spyOn(MockProviderAdapter.prototype, 'poll').mockImplementationOnce(async () => {
      await env.db.generationBatch.update({ where: { id: seed.batchId }, data: { paused: true } })
      return { status: 'failed', error: 'confirmed upstream rejection' }
    })
    const { runTask } = await import('../src/run-task.js')
    expect(await runTask(payload, env.deps({ qcMode: 'pass', pollIntervalMs: 1 }))).toBe('paused')
    expect(submit).toHaveBeenCalledTimes(1)
    expect((await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })).status).toBe('QUEUED')
    await env.db.generationBatch.update({ where: { id: seed.batchId }, data: { paused: false } })
    await runTask(payload, env.deps({ qcMode: 'pass', pollIntervalMs: 1 }))
    expect(submit).toHaveBeenCalledTimes(2)
    expect((await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })).status).toBe('SUCCEEDED')
  } finally { vi.restoreAllMocks(); await env.stop() }
})
