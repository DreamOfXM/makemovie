import { it, expect, vi } from 'vitest'
import { MockProviderAdapter } from '@studio/providers'
import type { Prisma } from '@studio/db'
import { startTestEnv } from './env.js'
import { runTask } from '../src/run-task.js'

it('replays a durable result after a rolled-back completion without duplicate artifacts, QC, domain rows or usage', async () => {
  const env = await startTestEnv()
  const submit = vi.spyOn(MockProviderAdapter.prototype, 'submit')
  try {
    const seed = await env.seed({ stage: 'STORYBOARD', modality: 'text', model: 'mock-storyboard', storyboards: 0 })
    const transaction = env.db.$transaction.bind(env.db)
    let fail = true
    const fault = ((action: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => transaction(async tx => {
      const result = await action(tx)
      if (fail) { fail = false; throw new Error('injected commit connection failure') }
      return result
    }, options as never)) as unknown as typeof env.db.$transaction
    const faultyDb = new Proxy(env.db, { get: (target, key) => key === '$transaction' ? fault : Reflect.get(target, key) })
    await runTask(env.runPayload(seed), env.deps({ db: faultyDb, qcMode: 'pass', pollIntervalMs: 1 }))
    expect((await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })).status).toBe('BLOCKED')
    // A blocked task must not leave the batch looking alive: the console derives
    // "running" from the batch and would hide the retry path behind it.
    expect((await env.db.generationBatch.findUniqueOrThrow({ where: { id: seed.batchId } })).status).toBe('BLOCKED')
    expect(await env.db.storyboard.count({ where: { episodeId: seed.episodeId } })).toBe(0)
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 1 }))
    const recovered = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(recovered.status).toBe('SUCCEEDED')
    // The console treats errorSnapshot as the task's *current* error; a recovered task
    // that keeps the rolled-back stack reads as "succeeded with a red error column".
    expect(recovered.errorSnapshot).toBeNull()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(await env.db.mediaArtifact.count({ where: { taskId: seed.taskId } })).toBe(1)
    expect(await env.db.qualityCheck.count({ where: { artifact: { taskId: seed.taskId } } })).toBe(1)
    expect(await env.db.usageLedger.count({ where: { taskId: seed.taskId } })).toBe(1)
    expect(await env.db.storyboard.count({ where: { episodeId: seed.episodeId } })).toBe(3)
  } finally { vi.restoreAllMocks(); await env.stop() }
})

it('records a repeated breakdown when the episode already holds the extracted cast', async () => {
  const env = await startTestEnv()
  try {
    // The regenerated breakdown re-extracts 沈亦, who already exists from the previous
    // revision. A caught unique violation still aborts the Postgres transaction, so the
    // write path has to be idempotent rather than tolerant of the conflict.
    const seed = await env.seed({
      stage: 'STORYBOARD',
      modality: 'text',
      model: 'mock-storyboard',
      storyboards: 0,
      asset: { kind: 'character', name: '沈亦', description: 'cast member from the previous breakdown' },
    })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 1 }))
    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')
    expect(await env.db.storyboard.count({ where: { episodeId: seed.episodeId, revision: 1 } })).toBe(3)
    // 沈亦 kept, 林晚晴 / 半张老照片 / 滨江老城区雨夜街道 added.
    expect(await env.db.asset.count({ where: { episodeId: seed.episodeId } })).toBe(4)
    expect(await env.db.storyboardAsset.count({ where: { assetId: seed.assetId! } })).toBeGreaterThan(0)
    expect((await env.db.generationBatch.findUniqueOrThrow({ where: { id: seed.batchId } })).status).toBe('COMPLETED')
  } finally { await env.stop() }
})

it('round-trips inline Buffer and Uint8Array provider results through the durable checkpoint', async () => {
  const { saveProviderResult, restoreProviderResult } = await import('../src/run-task.js')
  for (const bytes of [Buffer.from([0, 128, 255]), new Uint8Array([0, 128, 255])]) {
    const restored = restoreProviderResult(saveProviderResult({ status: 'completed', inlineArtifact: { bytes, mimeType: 'image/png' } }))
    expect([...restored.inlineArtifact!.bytes]).toEqual([0, 128, 255])
  }
})
