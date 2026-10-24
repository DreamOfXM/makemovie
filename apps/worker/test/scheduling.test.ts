// US-035 剩余项的调度面测试:暂停 Run、迟到结果 late_result、可恢复 outbox 对账、
// §14 预扣账。执行安全基线(领取/租约/fencing)在 pipeline.test.ts,这里只测新语义。

import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma, type CapabilitySlot } from '@studio/db'
import { MockProviderAdapter } from '@studio/providers'
import { triggerStage } from '@studio/pipeline'
import { encryptSecret } from '@studio/security'
import type { PipelinePayload, RunTaskCandidate } from '@studio/jobs'
import { runTask } from '../src/run-task.js'
import { sweepJobOutbox } from '../../api/src/lib/jobs.js'
import { MASTER_KEY, startTestEnv, type Seed, type WorkerTestEnv } from './env.js'

let env: WorkerTestEnv

beforeAll(async () => {
  env = await startTestEnv()
}, 300_000)

beforeEach(async () => {
  await env.drain()
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await env?.stop()
})

async function approveScript(seed: Seed): Promise<void> {
  await env.db.scriptVersion.create({
    data: { episodeId: seed.episodeId, version: 1, content: 'the approved script', checksum: `scheduling-${randomUUID()}`, status: 'APPROVED' },
  })
}

/** 与 pipeline.test.ts 同型:把一个已验证的 mock 模型绑进视频槽,triggerStage 才有候选。 */
async function bindVideoSlot(seed: Seed, slot: CapabilitySlot, model: string, spec?: Prisma.InputJsonValue): Promise<RunTaskCandidate> {
  const connection = await env.db.providerConnection.create({
    data: {
      organizationId: seed.organizationId,
      provider: 'mock',
      name: `video-${slot.toLowerCase()}-${randomUUID().slice(0, 8)}`,
      baseUrl: 'mock://local',
      encryptedSecret: encryptSecret('video-key', MASTER_KEY),
      capabilities: {
        create: [{
          model,
          modality: ({ VIDEO_I2V: 'i2v', VIDEO_R2V: 'r2v', TTS_VOICE: 'tts', SFX: 'sfx' } as Record<string, string>)[slot] ?? 't2v',
          acceptsFirstFrame: slot === 'VIDEO_I2V',
          acceptsReferenceImages: slot === 'VIDEO_R2V',
          maxReferenceImages: slot === 'VIDEO_R2V' ? 4 : 0,
          entitlementVerifiedAt: new Date(),
          ...(spec ? { spec } : {}),
        }],
      },
    },
  })
  const capability = await env.db.modelCapability.findFirstOrThrow({ where: { connectionId: connection.id } })
  await env.db.capabilityBinding.create({
    data: { organizationId: seed.organizationId, slot, capabilityId: capability.id, priority: 10 },
  })
  return { connectionId: connection.id, capabilityId: capability.id, provider: 'mock', model }
}

/** A plan refuses for a reason an assertion should state outright. */
async function planVideo(seed: Seed): Promise<string> {
  const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'VIDEO')
  if (!result.ok) throw new Error(`the VIDEO stage refused to plan: ${result.error}`)
  return result.batchId
}

describe('US-035 pause run', () => {
  it('a paused batch is never dispatched: the task stays QUEUED and nothing is submitted; resume lets the same delivery run it', async () => {
    const seed = await env.seed({ storyboards: 1 })
    await approveScript(seed)
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })
    const queued = await env.takeWaitingRunTasks()
    expect(queued.length).toBe(1)

    await env.db.generationBatch.update({ where: { id: batchId }, data: { paused: true } })
    const submit = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    await runTask(queued[0]!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    // 暂停停止新派发:领取被拒,上游一次都没被碰,任务仍是 QUEUED。
    expect(submit).not.toHaveBeenCalled()
    expect((await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('QUEUED')

    // 恢复后,同一条投递照常执行成功。
    await env.db.generationBatch.update({ where: { id: batchId }, data: { paused: false } })
    await runTask(queued[0]!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    expect(submit).toHaveBeenCalledTimes(1)
    expect((await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('SUCCEEDED')
  })
})

describe('§17 late_result', () => {
  it('a success whose fenced write lost the lease is recorded as late_result and never overwrites the completed verdict', async () => {
    const seed = await env.seed({ storyboards: 1 })
    await approveScript(seed)
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })
    const queued = await env.takeWaitingRunTasks()

    // 消费者 A 提交成功后挂在轮询上:poll 被闸住,直到"更新的 attempt 已完成任务"。
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(MockProviderAdapter.prototype, 'poll').mockImplementation(async () => {
      await gate
      return { status: 'completed' as const, artifactUrl: 'mock://artifacts/late/t2v' }
    })
    const first = runTask(queued[0]!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 })).catch(() => undefined)
    await vi.waitFor(async () => {
      if (!(await env.db.submissionAttempt.findFirst({ where: { taskId: task.id, status: 'accepted' } }))) throw new Error('accepted ledger row not yet visible')
    })

    // A 挂在轮询期间:更新的 attempt 抢先完成任务(租约易主,终态已写,凭证是人工改判
    // 或接管者的 SUCCEEDED 结论)。
    await env.db.submissionAttempt.create({
      data: { taskId: task.id, attemptNumber: 2, slot: 0, status: 'settled', resolution: 'succeeded', provider: 'mock', connectionId: seed.connectionId, capabilityId: seed.capabilityId, model: 'mock-t2v' },
    })
    await env.db.generationTask.update({
      where: { id: task.id },
      data: { status: 'SUCCEEDED', claimToken: null, leaseUntil: null, provider: 'mock', model: 'mock-t2v', responseSnapshot: JSON.stringify({ verdict: 'completed by attempt 2' }) },
    })

    release()
    await first

    // 旧 attempt 的成功只作候选:台账行 resolution=late_result,既有结论原样。
    const lateRow = await env.db.submissionAttempt.findFirstOrThrow({ where: { taskId: task.id, attemptNumber: 1 } })
    expect(lateRow.status).toBe('settled')
    expect(lateRow.resolution).toBe('late_result')
    const after = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('SUCCEEDED')
    expect(JSON.parse(after.responseSnapshot!)).toEqual({ verdict: 'completed by attempt 2' })
  })

  it('marks a late segmented storyboard success the same way, without overwriting the verdict', async () => {
    // 分段分镜的迟到结果与单次调用同纪律:构造一个"超阈值必分段"的剧本任务,
    // 挂住轮询,期间人工改判完成,释放后整段成功只能落 late_result。
    const seed = await env.seed({ stage: 'STORYBOARD', model: 'mock-storyboard', modality: 'text' })
    // 让分段发生:快照带 scriptVersionId,剧本超 6000 字符阈值且切成多个空行段落,
    // planStoryboardSegments 按 1500 字/段打包出多段。
    const paragraph = '夜市里两人并肩走过长街，灯影在积水里晃。'.repeat(130)
    const script = await env.db.scriptVersion.create({
      data: { episodeId: seed.episodeId, version: 1, status: 'APPROVED', content: [paragraph, paragraph, paragraph, paragraph, paragraph, paragraph].join('\n\n'), checksum: `seg-${randomUUID()}` },
    })
    await env.db.generationTask.update({
      where: { id: seed.taskId },
      data: { requestSnapshot: JSON.stringify({ model: 'mock-storyboard', input: { prompt: 'break down the script' }, parameters: {}, scriptVersionId: script.id }) },
    })

    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let submissions = 0
    vi.spyOn(MockProviderAdapter.prototype, 'submit').mockImplementation(async () => {
      submissions += 1
      return { taskId: `late-seg-${submissions}` }
    })
    vi.spyOn(MockProviderAdapter.prototype, 'poll').mockImplementation(async () => {
      await gate
      return { status: 'completed' as const, text: '{"shots":[{"title":"夜市","description":"两人并肩"}],"assets":[]}' }
    })
    const payload = env.runPayload(seed, 1)
    const first = runTask(payload, env.deps({ qcMode: 'pass', pollIntervalMs: 10 })).catch(() => undefined)
    await vi.waitFor(async () => {
      if (!(await env.db.submissionAttempt.findFirst({ where: { taskId: seed.taskId, status: 'accepted' } }))) throw new Error('accepted ledger row not yet visible')
    })

    // 人工改判完成 + 台账已有更新的 attempt:分段整段成功后只能作候选。
    await env.db.submissionAttempt.create({
      data: { taskId: seed.taskId, attemptNumber: 2, slot: 0, status: 'settled', resolution: 'succeeded', provider: 'mock', connectionId: seed.connectionId, capabilityId: seed.capabilityId, model: 'mock-storyboard' },
    })
    await env.db.generationTask.update({
      where: { id: seed.taskId },
      data: { status: 'SUCCEEDED', claimToken: null, leaseUntil: null, provider: 'mock', model: 'mock-storyboard', responseSnapshot: JSON.stringify({ verdict: 'human' }) },
    })

    release()
    await first

    const rows = await env.db.submissionAttempt.findMany({ where: { taskId: seed.taskId, attemptNumber: 1 } })
    // The first accepted segment is retained; losing ownership prevents paying
    // for the remaining segments after the human has completed the task.
    expect(rows).toHaveLength(1)
    expect(submissions).toBe(1)
    for (const row of rows) expect(row.resolution).toBe('late_result')
    const after = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(after.status).toBe('SUCCEEDED')
    expect(JSON.parse(after.responseSnapshot!)).toEqual({ verdict: 'human' })
  })
})

describe('§17 recoverable outbox', () => {
  it('sweepJobOutbox re-pushes stale pending rows exactly once and leaves failing pushes pending', async () => {
    const seed = await env.seed()
    const stalePayload: PipelinePayload = { kind: 'compose-episode', compositionId: 'comp-1', episodeId: seed.episodeId, organizationId: seed.organizationId }
    const stale = await env.db.jobOutbox.create({ data: { payload: JSON.stringify(stalePayload), organizationId: seed.organizationId } })
    // 宽限期外的行才可重推:把 createdAt 拨回 90s 前;失败行拨回 60s 前,顺序确定
    // (扫描按 createdAt 升序),断言可以点名第几次调用。
    await env.db.jobOutbox.update({ where: { id: stale.id }, data: { createdAt: new Date(Date.now() - 90_000) } })
    const young = await env.db.jobOutbox.create({ data: { payload: JSON.stringify(stalePayload), organizationId: seed.organizationId } })
    const failingPayload: PipelinePayload = { kind: 'compose-episode', compositionId: 'comp-2', episodeId: seed.episodeId, organizationId: seed.organizationId }
    const failing = await env.db.jobOutbox.create({ data: { payload: JSON.stringify(failingPayload), organizationId: seed.organizationId } })
    await env.db.jobOutbox.update({ where: { id: failing.id }, data: { createdAt: new Date(Date.now() - 60_000) } })

    const dispatch = vi.fn(async (payload: PipelinePayload, outboxId: string) => {
      if (outboxId === failing.id) throw new Error('queue unreachable')
    })
    const swept = await sweepJobOutbox(env.db, dispatch)
    expect(swept).toBe(1)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenNthCalledWith(1, stalePayload, stale.id)
    expect((await env.db.jobOutbox.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('dispatched')
    // 推失败的行留在 pending 等下一轮;过新的行还没到宽限期。
    expect((await env.db.jobOutbox.findUniqueOrThrow({ where: { id: failing.id } })).status).toBe('pending')
    expect((await env.db.jobOutbox.findUniqueOrThrow({ where: { id: young.id } })).status).toBe('pending')

    // 第二次扫描:已 dispatched 的行不再重推(jobId 去重之外的账面去重),仍只剩
    // 失败行可试。
    await sweepJobOutbox(env.db, dispatch)
    expect(dispatch).toHaveBeenCalledTimes(3)
    expect(dispatch).toHaveBeenLastCalledWith(failingPayload, failing.id)
    expect((await env.db.jobOutbox.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('dispatched')
  })
})

describe('§14 in-flight call budget', () => {
  it('refuses a trigger over the organization limit and allows it when the limit is unset', async () => {
    const seed = await env.seed({ storyboards: 1 })
    await approveScript(seed)
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    await env.db.organization.update({ where: { id: seed.organizationId }, data: { inFlightCallLimit: 1 } })
    // 预置 1 条在途调用:占满上限。
    await env.db.submissionAttempt.create({ data: { taskId: seed.taskId, attemptNumber: 1, slot: 0, status: 'submitting' } })

    const refused = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'VIDEO')
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.code).toBe(429)
      expect(refused.error).toBe('pipeline:inFlightBudget')
      expect(refused.reasons).toContain('organization call reservations exhausted')
    }

    // 解除上限(null=不限):同一触发照常建批派发。
    await env.db.organization.update({ where: { id: seed.organizationId }, data: { inFlightCallLimit: null } })
    const allowed = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'VIDEO')
    expect(allowed.ok).toBe(true)
    if (allowed.ok) {
      const batch = await env.db.generationBatch.findUniqueOrThrow({ where: { id: allowed.batchId } })
      expect(batch.paused).toBe(false)
      expect(await env.takeWaitingRunTasks()).toHaveLength(1)
    }
  })
})
