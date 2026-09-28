const TEXT_LANGUAGE_RULE_ZH = '画面文字规则（最高优先级）：标题、标签、招牌等短文字一律使用简体中文，清晰可读；禁止出现可辨认的英文单词或字母；长文书类（协议/证书/书页）的正文文字可作虚化模糊处理，不必逐字可读，但不得出现可读的英文。'
const MOTION_RULE_ZH = '运动规则（与画面文字规则同级）：画面中人物的一切动作与镜头运动只能来自上文描述明确写出的内容——描述没有写的动作不得出现。描述未提及任何动作时，只保持呼吸起伏、眨眼与光线的缓慢变化，机位固定或极缓慢推近。'

import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma, type CapabilitySlot } from '@studio/db'
import { MOCK_SCRIPT_TEXT, MOCK_SCRIPT_TEXT_EN, MOCK_STORYBOARD_JSON, MOCK_STORYBOARD_JSON_EN, MOCK_VLM_VERDICT, MockProviderAdapter } from '@studio/providers'
import { advancePipeline, generationSeed, planComposition, triggerStage, usableFirstFrames, VISUAL_STYLE_DIRECTIVE } from '@studio/pipeline'
import { toReferenceImage } from '@studio/media'
import { encryptSecret } from '@studio/security'
import type { RunTaskCandidate } from '@studio/jobs'
import { composeEpisode } from '../src/compose.js'
import { recordGeneratedContent } from '../src/content.js'
import type { QcSubject, QualityChecker } from '../src/qc.js'
import { pinBilledParameters, runTask } from '../src/run-task.js'
import { ModelQualityChecker } from '../src/visual-audit.js'
import { MASTER_KEY, startTestEnv, type Seed, type WorkerTestEnv } from './env.js'

const run = promisify(execFile)

// The mock auditor's fixed answer, read rather than restated so a change to it
// moves these assertions instead of silently invalidating them.
const MOCK_VLM_SCORE = (JSON.parse(MOCK_VLM_VERDICT) as { score: number }).score

// One storyboard reply now carries both halves of the contract: the shot list and
// the episode's cast, props and scenes.
const MOCK_STORYBOARD = JSON.parse(MOCK_STORYBOARD_JSON) as {
  shots: Array<{ title: string; description: string }>
  assets: Array<{ kind: string; name: string; description: string }>
}
const MOCK_STORYBOARD_EN = JSON.parse(MOCK_STORYBOARD_JSON_EN) as typeof MOCK_STORYBOARD

let env: WorkerTestEnv

beforeAll(async () => {
  env = await startTestEnv()
}, 300_000)

beforeEach(async () => {
  await env.drain()
})

// The adapter the worker builds is a fresh instance per candidate, so the tests that read
// what reached a provider watch the class instead, and that hook has to come off again.
afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await env?.stop()
})

describe('run-task', () => {
  it('materialises a mock artifact, approves it and bills usage', async () => {
    const prompt = 'a rainy night market'
    const seed = await env.seed({ prompt })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')
    expect(task.attempts).toBe(1)
    expect(task.provider).toBe('mock')
    expect(task.model).toBe('mock-t2v')
    expect(task.errorSnapshot).toBeNull()
    const response = JSON.parse(task.responseSnapshot!) as { artifactId: string; candidate: { model: string }; qc: { score: number; threshold: number } }
    expect(response.qc).toEqual({ score: 1, threshold: 0.7 })
    expect(response.candidate.model).toBe('mock-t2v')

    const artifact = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: response.artifactId } })
    expect(artifact.taskId).toBe(task.id)
    expect(artifact.stage).toBe('VIDEO')
    expect(artifact.version).toBe(1)
    expect(artifact.mimeType).toBe('video/mp4')
    expect(artifact.width).toBe(320)
    expect(artifact.height).toBe(240)
    expect(artifact.durationMs).toBe(1000)
    expect(artifact.objectKey).toContain(`/${seed.projectId}/${seed.episodeId}/VIDEO/${seed.taskId}/v1.mp4`)
    expect(await env.storage.exists(artifact.objectKey)).toBe(true)

    const bytes = await env.storage.read(artifact.objectKey)
    expect(bytes.byteLength).toBeGreaterThan(1024)

    const checks = await env.db.qualityCheck.findMany({ where: { artifactId: artifact.id } })
    expect(checks).toHaveLength(1)
    expect(checks[0]!.status).toBe('APPROVED')
    expect(checks[0]!.kind).toBe('fake-qc')
    expect(checks[0]!.score).toBe(1)
    expect(JSON.parse(checks[0]!.report)).toMatchObject({ threshold: 0.7, mode: 'pass', candidate: seed.candidates[0] })

    const usage = await env.db.usageLedger.findMany({ where: { taskId: task.id } })
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ organizationId: seed.organizationId, provider: 'mock', model: 'mock-t2v', modality: 't2v', inputUnits: prompt.length, outputUnits: bytes.byteLength })

    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
  })

  it('reworks a rejected artifact up to three attempts and then fails the task', async () => {
    const seed = await env.seed()
    const deps = env.deps({ qcMode: 'fail', pollIntervalMs: 10 })

    await runTask(env.runPayload(seed, 1), deps)
    const running = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(running.status).toBe('RUNNING')

    const second = await env.takeWaitingRunTasks()
    expect(second.map(payload => payload.attempt)).toEqual([2])
    expect(second[0]!.candidates).toEqual(seed.candidates)
    await runTask(second[0]!, deps)

    const third = await env.takeWaitingRunTasks()
    expect(third.map(payload => payload.attempt)).toEqual([3])
    await runTask(third[0]!, deps)

    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('FAILED')
    expect(task.attempts).toBe(3)
    expect(task.errorSnapshot).toBe('fake-qc: threshold not met after 3 attempts')

    const checks = await env.db.qualityCheck.findMany({ where: { artifact: { taskId: seed.taskId } } })
    expect(checks).toHaveLength(3)
    expect(checks.every(check => check.status === 'NEEDS_REVIEW' && check.kind === 'fake-qc' && check.score === 0.1)).toBe(true)
    expect(await env.db.mediaArtifact.count({ where: { taskId: seed.taskId } })).toBe(3)
    expect(await env.db.usageLedger.count({ where: { taskId: seed.taskId } })).toBe(0)
  })

  it('fails with per-candidate errors when no candidate is usable', async () => {
    const seed = await env.seed({ connectionEnabled: false })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('FAILED')
    const errors = JSON.parse(task.errorSnapshot!) as string[]
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('mock/mock-t2v')
    expect(errors[0]).toContain('unavailable')
    expect(await env.db.mediaArtifact.count({ where: { taskId: seed.taskId } })).toBe(0)
    expect(await env.db.qualityCheck.count({ where: { artifact: { taskId: seed.taskId } } })).toBe(0)
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
  })

  it('leaves a cancelled task untouched', async () => {
    const seed = await env.seed()
    await env.db.generationTask.update({ where: { id: seed.taskId }, data: { status: 'CANCELLED' } })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass' }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('CANCELLED')
    expect(await env.db.mediaArtifact.count({ where: { taskId: seed.taskId } })).toBe(0)
  })
})

describe('asset versions', () => {
  const asset = { kind: 'character', name: 'Lin Wan', description: 'a resilient young woman in a red dress' }

  it('records the first version when an ASSET task succeeds', async () => {
    const prompt = 'character Lin Wan: a resilient young woman in a red dress'
    const seed = await env.seed({ model: 'mock-image', modality: 'image', stage: 'ASSET', asset, prompt })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')
    const response = JSON.parse(task.responseSnapshot!) as { artifactId: string }

    const versions = await env.db.assetVersion.findMany({ where: { assetId: seed.assetId! } })
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({
      assetId: seed.assetId!,
      version: 1,
      status: 'DRAFT',
      description: asset.description,
      promptSnapshot: prompt,
      artifactId: response.artifactId,
    })
  })

  it('appends the next version when the asset already has one', async () => {
    const seed = await env.seed({ model: 'mock-image', modality: 'image', stage: 'ASSET', asset })
    await env.db.assetVersion.create({ data: { assetId: seed.assetId!, version: 1, description: 'first sketch' } })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')

    const versions = await env.db.assetVersion.findMany({ where: { assetId: seed.assetId! }, orderBy: { version: 'asc' } })
    expect(versions).toHaveLength(2)
    expect(versions[0]).toMatchObject({ version: 1, description: 'first sketch' })
    expect(versions[1]).toMatchObject({ version: 2, status: 'DRAFT' })
  })

  it('records nothing for a non-ASSET task', async () => {
    const seed = await env.seed({ model: 'mock-image', modality: 'image', stage: 'FIRST_FRAME' })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')
    expect(await env.db.assetVersion.count({ where: { asset: { episodeId: seed.episodeId } } })).toBe(0)
  })

  it('still succeeds when the ASSET snapshot carries no assetId', async () => {
    const seed = await env.seed({
      model: 'mock-image',
      modality: 'image',
      stage: 'ASSET',
      requestSnapshot: JSON.stringify({ model: 'mock-image', input: { prompt: 'a character study' }, parameters: {} }),
    })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')
    expect(await env.db.assetVersion.count({ where: { asset: { episodeId: seed.episodeId } } })).toBe(0)
  })
})

describe('model-driven visual audit', () => {
  function modelDeps(checker?: QualityChecker) {
    return env.deps({
      qcMode: 'model',
      pollIntervalMs: 10,
      checker: checker ?? new ModelQualityChecker({ db: env.db, masterKey: MASTER_KEY, pollIntervalMs: 10, pollTimeoutMs: 5_000 }),
    })
  }

  it('fails the task loudly when no visual_audit model is bound', async () => {
    const seed = await env.seed()
    await runTask(env.runPayload(seed), modelDeps())

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('FAILED')
    expect(task.errorSnapshot).toBe('visual-audit: no verified visual_audit binding')

    // Generation was already paid for before the audit ran, so the artifact exists.
    expect(await env.db.mediaArtifact.count({ where: { taskId: seed.taskId } })).toBe(1)
    const checks = await env.db.qualityCheck.findMany({ where: { artifact: { taskId: seed.taskId } } })
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ status: 'NEEDS_REVIEW', kind: 'visual-audit', score: null })
    expect(JSON.parse(checks[0]!.report)).toMatchObject({
      kind: 'visual-audit',
      mode: 'model',
      reasons: ['no verified visual_audit binding'],
    })

    // An audit fault must not spend money regenerating content nobody rejected.
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
    expect(await env.db.usageLedger.count({ where: { taskId: seed.taskId } })).toBe(0)
  })

  it('treats an unverified auditor as no auditor', async () => {
    const seed = await env.seed()
    await bindVisualAudit(seed, { verified: false })
    await runTask(env.runPayload(seed), modelDeps())

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('FAILED')
    expect(task.errorSnapshot).toBe('visual-audit: no verified visual_audit binding')
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
  })

  it('reworks a rejected artifact through the retry path', async () => {
    const seed = await env.seed()
    const rejecting: QualityChecker = {
      async check() {
        return { kind: 'visual-audit', decision: 'rework', score: 0.2, reasons: ['lead actor is missing from the shot'] }
      },
    }
    const deps = modelDeps(rejecting)

    await runTask(env.runPayload(seed, 1), deps)
    const second = await env.takeWaitingRunTasks()
    expect(second.map(payload => payload.attempt)).toEqual([2])
    await runTask(second[0]!, deps)

    const third = await env.takeWaitingRunTasks()
    expect(third.map(payload => payload.attempt)).toEqual([3])
    await runTask(third[0]!, deps)

    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('FAILED')
    expect(task.attempts).toBe(3)
    expect(task.errorSnapshot).toBe('visual-audit: threshold not met after 3 attempts')

    const checks = await env.db.qualityCheck.findMany({ where: { artifact: { taskId: seed.taskId } } })
    expect(checks).toHaveLength(3)
    expect(checks.every(check => check.status === 'NEEDS_REVIEW' && check.kind === 'visual-audit' && check.score === 0.2)).toBe(true)
    expect(JSON.parse(checks[0]!.report)).toMatchObject({ reasons: ['lead actor is missing from the shot'] })
    expect(await env.db.usageLedger.count({ where: { taskId: seed.taskId } })).toBe(0)
  })

  it('approves a video through a frame extracted by ffmpeg', async () => {
    const seed = await env.seed()
    await bindVisualAudit(seed)
    await runTask(env.runPayload(seed), modelDeps())

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')
    expect(task.errorSnapshot).toBeNull()
    const response = JSON.parse(task.responseSnapshot!) as { qc: { score: number; threshold: number } }
    expect(response.qc).toEqual({ score: MOCK_VLM_SCORE, threshold: 0.7 })

    const checks = await env.db.qualityCheck.findMany({ where: { artifact: { taskId: seed.taskId } } })
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ status: 'APPROVED', kind: 'visual-audit', score: MOCK_VLM_SCORE })
    expect(await env.db.usageLedger.count({ where: { taskId: seed.taskId } })).toBe(1)
  })

  it('approves an image by sending the artifact itself', async () => {
    const seed = await env.seed({ model: 'mock-image', modality: 'image', stage: 'FIRST_FRAME' })
    await bindVisualAudit(seed)
    await runTask(env.runPayload(seed), modelDeps())

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')
    const artifact = await env.db.mediaArtifact.findFirstOrThrow({ where: { taskId: seed.taskId } })
    expect(artifact.mimeType).toBe('image/png')
    const check = await env.db.qualityCheck.findFirstOrThrow({ where: { artifactId: artifact.id } })
    expect(check).toMatchObject({ status: 'APPROVED', kind: 'visual-audit', score: MOCK_VLM_SCORE })
  })

  it('fails instead of regenerating when the auditor call throws', async () => {
    const seed = await env.seed()
    await bindVisualAudit(seed, { apiKey: 'invalid' })
    await runTask(env.runPayload(seed), modelDeps())

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('FAILED')
    expect(task.errorSnapshot).toBe('visual-audit: mock/mock-vlm call failed: mock: invalid api key')
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
  })
})

/**
 * Binds a verified mock image model to the `image_gen` slot. IMAGE (first frames) shares
 * the slot with ASSET (character sheets), so this is also what lets a frame plan resolve.
 */
async function bindImageSlot(seed: Seed, model = 'mock-image', flags: { acceptsReferenceImages?: boolean; maxReferenceImages?: number } = {}): Promise<void> {
  const connection = await env.db.providerConnection.create({
    data: {
      organizationId: seed.organizationId,
      provider: 'mock',
      name: `image-${randomUUID().slice(0, 8)}`,
      baseUrl: 'mock://local',
      encryptedSecret: encryptSecret('image-key', MASTER_KEY),
      capabilities: { create: [{ model, modality: 'image', entitlementVerifiedAt: new Date(), ...flags }] },
    },
  })
  const capability = await env.db.modelCapability.findFirstOrThrow({ where: { connectionId: connection.id } })
  await env.db.capabilityBinding.create({
    data: { organizationId: seed.organizationId, slot: 'IMAGE_GEN', capabilityId: capability.id, priority: 10 },
  })
}

describe('asset-approval gate', () => {
  it('re-queues FAILED tasks when a plain trigger collides with their idempotency keys', async () => {
    // 额度烧完的那批任务占着 plain 幂等键;再次触发同一阶段必须重试它们,
    // 而不是撞键后安静地返回旧批次——那会让"生成缺失"按钮变成谎言。
    const seed = await env.seed({ storyboards: 2 })
    await approveScript(seed)
    await bindImageSlot(seed)
    // IMAGE 守卫会拦下没绑素材的镜头;这一测试钉的是撞键重试路径,给两镜各绑一个
    // 已定稿场景,让任务正常排队。
    const scene = await env.db.asset.create({ data: { episodeId: seed.episodeId, kind: 'scene', name: '青石巷', description: '夜色下的青石板路', status: 'APPROVED' } })
    for (const storyboardId of seed.storyboardIds as string[]) {
      await env.db.storyboardAsset.create({ data: { storyboardId, assetId: scene.id, role: 'scene' } })
    }
    const first = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE')
    expect(first.ok).toBe(true)
    await env.takeWaitingRunTasks()

    // 首跑全体阵亡(额度耗尽的样子),并把快照改成过期现场:模拟"失败时首帧还不存在"。
    const tasks = await env.db.generationTask.findMany({ where: { batchId: (first as { batchId: string }).batchId } })
    for (const task of tasks) {
      await env.db.generationTask.update({ where: { id: task.id }, data: { status: 'FAILED', attempts: 1, errorSnapshot: '["quota exhausted"]', provider: 'mock', model: 'mock-image', requestSnapshot: '{"input":{"prompt":"stale snapshot from the failed run"},"referenceArtifacts":[]}' } })
    }

    const second = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE')
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.created).toBe(false)

    const retried = await env.db.generationTask.findMany({ where: { batchId: (first as { batchId: string }).batchId } })
    expect(retried.every(task => task.status === 'QUEUED' && task.attempts === 0 && task.errorSnapshot === null && task.model === null)).toBe(true)
    // 快照按当前输入重排:过期的旧现场被替换回真实提示词。
    expect(retried.every(task => !(JSON.parse(task.requestSnapshot!).input as { prompt: string }).prompt.includes('stale'))).toBe(true)
    // 重试入队带上了槽位当前的候选,worker 拿到就能直接跑。
    const queued = await env.takeWaitingRunTasks()
    expect(queued).toHaveLength(tasks.length)
    expect(queued.every(payload => payload.candidates[0]?.model === 'mock-image')).toBe(true)

    // 全部成功之后再触发:没有失败可重试,安静 no-op,不再入队。
    for (const task of retried) {
      await env.db.generationTask.update({ where: { id: task.id }, data: { status: 'SUCCEEDED' } })
    }
    const third = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE')
    expect(third.ok).toBe(true)
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
  })
  it('refuses IMAGE and names the draft assets its shots are bound to', async () => {
    const seed = await env.seed({ storyboards: 2, asset: { kind: 'character', name: '关师傅', description: '纸扎铺老师傅' } })
    const [first, second] = seed.storyboardIds as [string, string]
    await approveScript(seed)
    await bindImageSlot(seed)
    const asset = await env.db.asset.findFirstOrThrow({ where: { episodeId: seed.episodeId } })
    await env.db.storyboardAsset.createMany({ data: [{ storyboardId: first, assetId: asset.id, role: 'character' }, { storyboardId: second, assetId: asset.id, role: 'character' }] })

    const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the IMAGE stage to be refused')
    expect(result.error).toBe('generations:assetsNotApproved')
    expect(result.reasons).toEqual(['关师傅'])
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)

    // 定稿后同一触发放行:审批不是额外步骤,它就是首帧的前置条件。
    await env.db.asset.update({ where: { id: asset.id }, data: { status: 'APPROVED' } })
    const after = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE')
    expect(after.ok).toBe(true)
    const queued = await env.takeWaitingRunTasks()
    expect(queued).toHaveLength(2)
    expect(queued.every(payload => payload.candidates[0]?.model === 'mock-image')).toBe(true)
  })

  it('does not touch shots bound to no asset, or assets bound to no live shot', async () => {
    const seed = await env.seed({ storyboards: 1 })
    await approveScript(seed)
    await bindImageSlot(seed)
    // 草稿素材存在,但没有镜头引用它:不拦路。
    await env.db.asset.create({ data: { episodeId: seed.episodeId, kind: 'prop', name: '油灯', description: '一盏旧油灯', status: 'DRAFT' } })

    const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE')
    expect(result.ok).toBe(true)
  })

  it('stops the chain on the asset gate instead of skipping to a later stage', async () => {
    const seed = await env.seed({ storyboards: 1, asset: { kind: 'character', name: '小满', description: '十六岁少女' } })
    await approveScript(seed)
    // 故意不绑任何模型:旧逻辑会因"没候选"跳过 IMAGE 去追 VIDEO;闸门语义下,
    // 人工审批没完成,链条必须停在 IMAGE 并说明原因。
    const asset = await env.db.asset.findFirstOrThrow({ where: { episodeId: seed.episodeId } })
    const [shot] = seed.storyboardIds as [string]
    await env.db.storyboardAsset.create({ data: { storyboardId: shot, assetId: asset.id, role: 'character' } })

    const result = await advancePipeline({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the advance to stop on the asset gate')
    expect(result.error).toBe('generations:assetsNotApproved')
    expect(result.reasons).toEqual(['小满'])
    // seed() 自带一个 VIDEO 批次;断言的是推进没有绕过 IMAGE 去新建任何首帧批次。
    expect(await env.db.generationBatch.count({ where: { episodeId: seed.episodeId, stage: 'FIRST_FRAME' } })).toBe(0)
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
  })
})

describe('asset-sheet references', () => {
  /** 批一个素材的定妆照版本:一个 APPROVED 的 artifact,首帧触发时会被解析成参考图。 */
  async function approveAssetSheet(seed: Seed, artifact: { artifactId: string }, assetId?: string): Promise<void> {
    const asset = await env.db.asset.findFirstOrThrow({ where: { id: assetId ?? { not: '' }, episodeId: seed.episodeId } })
    await env.db.assetVersion.create({
      data: { assetId: asset.id, version: 1, description: '三视图', status: 'APPROVED', artifactId: artifact.artifactId },
    })
    // 与审批端点同一语义:版本和素材一起定稿,素材门禁看的是素材行的状态。
    await env.db.asset.update({ where: { id: asset.id }, data: { status: 'APPROVED' } })
  }

  it('plans a first frame carrying the approved asset sheets and sends them as reference images', async () => {
    const seed = await env.seed({ storyboards: 1, asset: { kind: 'character', name: '关师傅', description: '纸扎铺老师傅' } })
    await approveScript(seed)
    await bindImageSlot(seed, 'qwen-image-edit', { acceptsReferenceImages: true, maxReferenceImages: 3 })
    const [shot] = seed.storyboardIds as [string]
    // 参考图只送画面文本提到的素材:描述里写明关师傅入场。
    await env.db.storyboard.update({ where: { id: shot }, data: { description: 'a rainy night market, 关师傅 stands at the door' } })
    const asset = await env.db.asset.findFirstOrThrow({ where: { episodeId: seed.episodeId } })
    await env.db.storyboardAsset.create({ data: { storyboardId: shot, assetId: asset.id, role: 'character' } })
    // 第二个素材绑定了但画面文本没提到她(只在台词里出现):她的定妆照不该进参考图。
    const extra = await env.db.asset.create({ data: { episodeId: seed.episodeId, kind: 'character', name: '小满', description: '十六岁少女', status: 'APPROVED' } })
    await env.db.storyboardAsset.create({ data: { storyboardId: shot, assetId: extra.id, role: 'character' } })
    const sheet = await env.attachSucceededMedia(seed, { stage: 'ASSET', modality: 'image' })
    await approveAssetSheet(seed, sheet, asset.id)
    const extraSheet = await env.attachSucceededMedia(seed, { stage: 'ASSET', modality: 'image' })
    await env.db.assetVersion.create({ data: { assetId: extra.id, version: 1, description: 'v', status: 'APPROVED', artifactId: extraSheet.artifactId } })
    await env.db.asset.update({ where: { id: extra.id }, data: { status: 'APPROVED' } })

    const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE')
    expect(result.ok).toBe(true)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId: (result as { batchId: string }).batchId } })
    expect(JSON.parse(task.requestSnapshot!)).toMatchObject({ referenceArtifacts: [{ type: 'reference_image', artifactId: sheet.artifactId }] })
    const refs = (JSON.parse(task.requestSnapshot!) as { referenceArtifacts: Array<{ artifactId: string }> }).referenceArtifacts
    expect(refs.some(reference => reference.artifactId === extraSheet.artifactId)).toBe(false)

    const [payload] = await env.takeWaitingRunTasks()
    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    await runTask(payload!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const calls = submitted.mock.calls.filter(([capability]) => capability.modality === 'image')
    expect(calls).toHaveLength(1)
    const media = calls[0]![1].input.media as { type: string; url: string }[]
    expect(media).toHaveLength(1)
    expect(media[0]!.type).toBe('reference_image')
    expect(media[0]!.url).toMatch(/^data:image\//)

    const succeeded = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(succeeded.status).toBe('SUCCEEDED')

    // 执行日志:任务全程的打点沉淀,事后追溯的唯一依据。
    // candidate.params:付费请求实际按什么参数记账(种子/清晰度档)也是打点的一部分。
    const logs = await env.db.generationLog.findMany({ where: { taskId: task.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    expect(logs.map(log => log.event)).toEqual(['task.start', 'candidate.start', 'candidate.params', 'qc.verdict', 'candidate.success', 'task.success'])
    expect(logs[0]!.message).toContain('qwen-image-edit')
    const response = JSON.parse(succeeded.responseSnapshot!) as { reference?: { conditioned: boolean }[] }
    expect(response.reference).toEqual([{ model: 'qwen-image-edit', conditioned: true }])
  })

  it('orders image candidates by the task: sheets take plain t2i first, referenced frames take the edit model first', async () => {
    // 定妆照(纯文字出图)用编辑模型裸跑,质感明显弱于文生图模型——路由按任务形态分:
    // 有参考图的首帧 → 编辑模型优先;纯文字出图的定妆照 → 纯文生图优先,编辑模型垫底。
    const seed = await env.seed({ storyboards: 1, asset: { kind: 'character', name: '小满', description: '十六岁少女' } })
    await approveScript(seed)
    await bindImageSlot(seed, 'qwen-image-edit', { acceptsReferenceImages: true, maxReferenceImages: 3 })
    await bindImageSlot(seed, 'mock-t2i')
    await env.db.capabilityBinding.updateMany({ where: { slot: 'IMAGE_GEN', capability: { model: 'mock-t2i' } }, data: { priority: 1 } })
    const [shot] = seed.storyboardIds as [string]
    await env.db.storyboard.update({ where: { id: shot }, data: { description: 'a rainy night market, 小满 peers out' } })
    const asset = await env.db.asset.findFirstOrThrow({ where: { episodeId: seed.episodeId } })
    await env.db.storyboardAsset.create({ data: { storyboardId: shot, assetId: asset.id, role: 'character' } })
    const sheet = await env.attachSucceededMedia(seed, { stage: 'ASSET', modality: 'image' })
    await approveAssetSheet(seed, sheet, asset.id)

    // 定妆照任务:纯文生图先上。
    const assetRun = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'ASSET')
    expect(assetRun.ok).toBe(true)
    const assetJobs = await env.takeWaitingRunTasks()
    expect(assetJobs[0]!.candidates[0]!.model).toBe('mock-t2i')
    expect(assetJobs[0]!.candidates[1]!.model).toBe('qwen-image-edit')

    // 首帧任务(带定妆照参考):编辑模型先上。
    const frameRun = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE', { storyboardIds: [shot], regenerate: true })
    expect(frameRun.ok).toBe(true)
    const frameJobs = await env.takeWaitingRunTasks()
    expect(frameJobs).toHaveLength(1)
    expect(frameJobs[0]!.candidates[0]!.model).toBe('qwen-image-edit')
    expect(frameJobs[0]!.candidates[1]!.model).toBe('mock-t2i')
  })

  it('keeps a text-only image model working and records the fallback it had to take', async () => {
    const seed = await env.seed({ storyboards: 1, asset: { kind: 'character', name: '小满', description: '十六岁少女' } })
    await approveScript(seed)
    await bindImageSlot(seed, 'mock-image')
    const [shot] = seed.storyboardIds as [string]
    await env.db.storyboard.update({ where: { id: shot }, data: { description: 'a rainy night market, 小满 peers out' } })
    const asset = await env.db.asset.findFirstOrThrow({ where: { episodeId: seed.episodeId } })
    await env.db.storyboardAsset.create({ data: { storyboardId: shot, assetId: asset.id, role: 'character' } })
    const sheet = await env.attachSucceededMedia(seed, { stage: 'ASSET', modality: 'image' })
    await approveAssetSheet(seed, sheet)

    const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE')
    expect(result.ok).toBe(true)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId: (result as { batchId: string }).batchId } })

    const [payload] = await env.takeWaitingRunTasks()
    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    await runTask(payload!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    // 不吃参考图的模型照常出图,但降级要留痕:参考图一张都没发,原因写进 response。
    const calls = submitted.mock.calls.filter(([capability]) => capability.modality === 'image')
    expect(calls).toHaveLength(1)
    expect('media' in calls[0]![1].input && Array.isArray(calls[0]![1].input.media)).toBe(false)
    const succeeded = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(succeeded.status).toBe('SUCCEEDED')
    const response = JSON.parse(succeeded.responseSnapshot!) as { reference?: { model: string; conditioned: boolean; reason?: string }[] }
    expect(response.reference?.[0]).toMatchObject({ model: 'mock-image', conditioned: false })
    expect(response.reference?.[0]?.reason).toContain('does not take reference images')
  })
})

describe('compose-episode', () => {
  it('concatenates the newest succeeded video artifact of every storyboard', async () => {
    const seed = await env.seed({ storyboards: 2 })
    const [first, second] = seed.storyboardIds as [string, string]
    await env.attachSucceededVideo(seed, first, 1)
    await env.attachSucceededVideo(seed, first, 2)
    await env.attachSucceededVideo(seed, second, 1)

    const composition = await env.db.composition.create({
      data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: seed.storyboardIds }) },
    })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())

    const updated = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(updated.status).toBe('COMPLETED')
    // GB 45438 双标识:角标能不能烧由本机 ffmpeg 决定,但结果必须落在清单里——
    // 'unrecorded' 只允许出现在假 composer 上,隐式元数据则任何路径都要写入。
    const recorded = JSON.parse(updated.manifest) as {
      storyboardIds: string[]
      labeling?: { standard: string; explicit: string; implicit: string; reason?: string }
      postProcess?: { status: string; steps: { step: string; outcome: string; reason?: string }[]; loudness?: { before: { i: number }; after?: { i: number } }; reason?: string }
    }
    expect(recorded.storyboardIds).toEqual(seed.storyboardIds)
    expect(recorded.labeling?.standard).toBe('GB 45438-2025')
    expect(['burned', 'skipped']).toContain(recorded.labeling?.explicit)
    expect(recorded.labeling?.implicit).toBe('written')
    if (recorded.labeling?.explicit === 'skipped') expect(recorded.labeling.reason).toBeTruthy()
    // 质量地板同样必须留痕:处理过带实测,回退过带原因,不许无声。
    expect(['applied', 'fallback']).toContain(recorded.postProcess?.status)
    if (recorded.postProcess?.status === 'fallback') expect(recorded.postProcess.reason).toBeTruthy()
    if (recorded.postProcess?.loudness?.after) {
      expect(Math.abs(recorded.postProcess.loudness.after.i - -16)).toBeLessThanOrEqual(3)
    }
    const artifact = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: updated.artifactId! } })
    expect(artifact.stage).toBe('COMPOSITION')
    expect(artifact.version).toBe(1)
    expect(artifact.mimeType).toBe('video/mp4')
    expect(artifact.durationMs).toBeGreaterThan(0)
    expect(artifact.objectKey).toContain(`/COMPOSITION/${composition.id}/v1.mp4`)
    expect(await env.storage.exists(artifact.objectKey)).toBe(true)
  })

  it('prefers the newest task over the highest rework version when composing', async () => {
    // 实景事故:同一任务内重做三次的文生视频侥幸产物(version 3)霸占成片,
    // 重新生成的正确视频(新任务 version 1)永远选不上。"最新"必须按任务时间,
    // version 只在任务内部区分重做次序。
    const seed = await env.seed({ storyboards: 1 })
    const [shot] = seed.storyboardIds as [string]
    await env.attachSucceededVideo(seed, shot, 3, { durationMs: 1000 })
    const staleArtifact = await env.db.mediaArtifact.findFirstOrThrow({
      where: { stage: 'VIDEO', version: 3, task: { storyboardId: shot } },
    })
    await env.db.generationTask.update({
      where: { id: staleArtifact.taskId! },
      data: { createdAt: new Date(Date.now() - 3_600_000) },
    })
    await env.attachSucceededVideo(seed, shot, 1, { durationMs: 3000 })

    const composition = await env.db.composition.create({
      data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: seed.storyboardIds }) },
    })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())

    const updated = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(updated.status).toBe('COMPLETED')
    const master = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: updated.artifactId! } })
    // 按任务时间选了新任务的 3000ms 片段;按 version desc 会选旧任务的 1000ms。
    expect(master.durationMs).toBeGreaterThanOrEqual(2900)
  })

  it('cuts the shot from the manually pinned clip rather than the newest one, and says so in the manifest', async () => {
    // 选优门:人钦定过版本,成片必须用钦定的那一版——"取最新"只是机器猜测,让位给人。
    const seed = await env.seed({ storyboards: 1 })
    const [shot] = seed.storyboardIds as [string]
    const pinned = await env.attachSucceededVideo(seed, shot, 1, { durationMs: 1000 })
    await env.attachSucceededVideo(seed, shot, 2, { durationMs: 3000 })
    await env.db.storyboard.update({ where: { id: shot }, data: { selectedVideoArtifactId: pinned.artifactId } })

    const composition = await env.db.composition.create({
      data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: seed.storyboardIds }) },
    })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())

    const updated = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(updated.status).toBe('COMPLETED')
    const master = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: updated.artifactId! } })
    // 自动规则会选 3000ms 的新版;母带只有约 1000ms,证明剪的是钦定的旧版。
    expect(master.durationMs).toBeGreaterThanOrEqual(900)
    expect(master.durationMs).toBeLessThanOrEqual(2500)
    // 母带用了哪一版、是谁定的,必须落在清单里——不许"选了 A 剪出来是 B"。
    const recorded = JSON.parse(updated.manifest) as { selections: Record<string, { artifactId: string; source: string }> }
    expect(recorded.selections[shot]).toEqual({ artifactId: pinned.artifactId, source: 'manual' })
  })

  it('falls back to the newest clip when the pin dangles, and records the fallback', async () => {
    // selectedVideoArtifactId 是裸 id:行永不删除,但可能被钉到别镜的版本上。
    // 读侧校验归属是最后一道防线——悬空即回退"最新",绝不炸整次合成。
    const seed = await env.seed({ storyboards: 2 })
    const [first, second] = seed.storyboardIds as [string, string]
    const secondClip = await env.attachSucceededVideo(seed, second, 1, { durationMs: 3000 })
    await env.attachSucceededVideo(seed, first, 1, { durationMs: 1000 })
    const firstNewest = await env.attachSucceededVideo(seed, first, 2, { durationMs: 2000 })
    await env.db.storyboard.update({ where: { id: first }, data: { selectedVideoArtifactId: secondClip.artifactId } })

    const composition = await env.db.composition.create({
      data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: seed.storyboardIds }) },
    })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())

    const updated = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(updated.status).toBe('COMPLETED')
    const recorded = JSON.parse(updated.manifest) as { selections: Record<string, { artifactId: string; source: string }> }
    expect(recorded.selections[first]).toEqual({ artifactId: firstNewest.artifactId, source: 'auto' })
    expect(recorded.selections[second]).toEqual({ artifactId: secondClip.artifactId, source: 'auto' })
    const master = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: updated.artifactId! } })
    // first 用自动的 2000ms、second 用 3000ms：合计约 5000。
    expect(master.durationMs).toBeGreaterThanOrEqual(4900)
    expect(master.durationMs).toBeLessThanOrEqual(5100)
  })

  it('cuts each shot from its own clip rather than the newest one in the batch', async () => {
    const seed = await env.seed({ storyboards: 2 })
    const [first, second] = seed.storyboardIds as [string, string]
    await env.attachSucceededVideo(seed, first, 1, { durationMs: 1000 })
    await env.attachSucceededVideo(seed, second, 1, { durationMs: 3000 })

    const composition = await env.db.composition.create({
      data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: seed.storyboardIds }) },
    })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())

    const updated = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(updated.status).toBe('COMPLETED')
    const master = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: updated.artifactId! } })
    // Resolving a shot's clip through its batch would have picked the same artifact
    // twice and produced 2000ms or 6000ms. Only both distinct clips add up to 4000.
    expect(master.durationMs).toBeGreaterThanOrEqual(3900)
    expect(master.durationMs).toBeLessThanOrEqual(4100)
  })

  it('blocks the composition when a storyboard has no succeeded video artifact', async () => {
    const seed = await env.seed({ storyboards: 2 })
    await env.attachSucceededVideo(seed, seed.storyboardIds[0]!, 1)

    const composition = await env.db.composition.create({
      data: { episodeId: seed.episodeId, status: 'RUNNING', manifest: JSON.stringify({ storyboardIds: seed.storyboardIds }) },
    })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())

    const updated = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(updated.status).toBe('BLOCKED')
    expect(updated.artifactId).toBeNull()
    expect(await env.db.mediaArtifact.count({ where: { stage: 'COMPOSITION', organizationId: seed.organizationId } })).toBe(0)
  })

  it('mixes per-shot voice and music and embeds the subtitle track when burning is unavailable', async () => {
    const seed = await env.seed({ storyboards: 2 })
    const [first, second] = seed.storyboardIds as [string, string]
    await env.db.storyboard.update({ where: { id: first }, data: { dialogue: '这条街不能待了。', speaker: '林晚' } })
    await env.attachSucceededVideo(seed, first, 1, { durationMs: 1000 })
    await env.attachSucceededVideo(seed, second, 1, { durationMs: 1000 })
    await env.attachSucceededMedia(seed, { stage: 'AUDIO', modality: 'tts', storyboardId: first })
    await env.attachSucceededMedia(seed, { stage: 'MUSIC', modality: 'music', durationMs: 2000 })

    const composition = await env.db.composition.create({
      data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: seed.storyboardIds }) },
    })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())

    const updated = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(updated.status).toBe('COMPLETED')
    const master = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: updated.artifactId! } })
    // 本机 ffmpeg 无烧录滤镜 → 软字幕轨回退;带 libass 的构建会硬烧进画面。
    expect(streamTypes(await env.storage.read(master.objectKey))).toEqual(['video', 'audio', 'subtitle'])

    const subtitle = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: updated.subtitleArtifactId! } })
    expect(subtitle.stage).toBe('SUBTITLE')
    expect(subtitle.objectKey).toContain(`/SUBTITLE/${composition.id}/v1.srt`)
    const cues = Buffer.from(await env.storage.read(subtitle.objectKey)).toString('utf8')
    expect(cues).toContain('这条街不能待了。')
    // Only the speaking shot is cued; the silent one carries no subtitle.
    expect(cues.match(/-->/g)).toHaveLength(1)
    // The bed that went into the file is named by id, so a later regeneration cannot
    // be mistaken for what the master actually carries.
    const score = await env.db.mediaArtifact.findFirstOrThrow({ where: { stage: 'MUSIC', organizationId: seed.organizationId } })
    expect(updated.scoreArtifactId).toBe(score.id)
  })

  it('leaves a dialogue-free episode silent', async () => {
    const seed = await env.seed({ storyboards: 2 })
    await env.attachSucceededVideo(seed, seed.storyboardIds[0]!, 1)
    await env.attachSucceededVideo(seed, seed.storyboardIds[1]!, 1)

    const composition = await env.db.composition.create({
      data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: seed.storyboardIds }) },
    })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())

    const updated = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(updated.status).toBe('COMPLETED')
    const master = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: updated.artifactId! } })
    expect(streamTypes(await env.storage.read(master.objectKey))).toEqual(['video'])
    expect(updated.subtitleArtifactId).toBeNull()
    expect(updated.scoreArtifactId).toBeNull()
  })

  it('lays a music bed under a silent picture', async () => {
    const seed = await env.seed({ storyboards: 1 })
    await env.attachSucceededVideo(seed, seed.storyboardIds[0]!, 1, { durationMs: 2000 })
    await env.attachSucceededMedia(seed, { stage: 'MUSIC', modality: 'music', durationMs: 1000 })

    const composition = await env.db.composition.create({
      data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: seed.storyboardIds }) },
    })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())

    const updated = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    const master = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: updated.artifactId! } })
    expect(streamTypes(await env.storage.read(master.objectKey))).toEqual(['video', 'audio'])
    // The looped bed has to cover the whole picture it sits under.
    expect(master.durationMs).toBeGreaterThanOrEqual(1900)
    // A bed with no cues still gets named: the two track columns are independent.
    expect(updated.subtitleArtifactId).toBeNull()
    expect(updated.scoreArtifactId).toBe((await env.db.mediaArtifact.findFirstOrThrow({ where: { stage: 'MUSIC', organizationId: seed.organizationId } })).id)
  })

  it('subtitles a line whose voice never landed', async () => {
    const seed = await env.seed({ storyboards: 1 })
    await env.db.storyboard.update({ where: { id: seed.storyboardIds[0]! }, data: { dialogue: '走吧。' } })
    await env.attachSucceededVideo(seed, seed.storyboardIds[0]!, 1)

    const composition = await env.db.composition.create({
      data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: seed.storyboardIds }) },
    })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())

    const updated = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(updated.status).toBe('COMPLETED')
    const master = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: updated.artifactId! } })
    expect(streamTypes(await env.storage.read(master.objectKey))).toEqual(['video', 'subtitle'])
    expect(Buffer.from(await env.storage.read((await env.db.mediaArtifact.findFirstOrThrow({ where: { stage: 'SUBTITLE', organizationId: seed.organizationId } })).objectKey)).toString('utf8')).toContain('走吧。')
  })

  // 导入的音频念的常常不是剧本里那句。字幕硬烧进画面、交付后改不掉，所以这一镜
  // 必须能单独说一句话：覆盖生效，且台词本身一个字不动。
  it('burns the per-shot subtitle override instead of the dialogue', async () => {
    const seed = await env.seed({ storyboards: 2 })
    const [first, second] = seed.storyboardIds as [string, string]
    await env.db.storyboard.update({ where: { id: first }, data: { dialogue: '这条街不能待了。', subtitleText: '这条街我待够了。' } })
    // 空镜没有台词，也可以只有一行字幕：音频里念了什么，画面下沿就该写什么。
    await env.db.storyboard.update({ where: { id: second }, data: { subtitleText: '（远处传来警笛）' } })
    await env.attachSucceededVideo(seed, first, 1, { durationMs: 1000 })
    await env.attachSucceededVideo(seed, second, 1, { durationMs: 1000 })

    const composition = await env.db.composition.create({
      data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: seed.storyboardIds }) },
    })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())

    const updated = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(updated.status).toBe('COMPLETED')
    const subtitle = await env.db.mediaArtifact.findFirstOrThrow({ where: { stage: 'SUBTITLE', organizationId: seed.organizationId } })
    const cues = Buffer.from(await env.storage.read(subtitle.objectKey)).toString('utf8')
    expect(cues).toContain('这条街我待够了。')
    expect(cues).toContain('（远处传来警笛）')
    expect(cues).not.toContain('这条街不能待了。')
    // 两镜两条 cue：覆盖不会把没台词的那一镜挤出字幕轨。
    expect(cues.match(/-->/g)).toHaveLength(2)
    expect((await env.db.storyboard.findUniqueOrThrow({ where: { id: first }, select: { dialogue: true } })).dialogue).toBe('这条街不能待了。')
  })

  // 四档不只是界面标签：母带清单要能反查「这一镜的声音是哪来的」，
  // 否则日后「双声从哪来」只能靠重抽猜。
  describe('per-shot audio source', () => {
    async function composeShot(shot: string, seed: Seed, storyboardIds: string[]) {
      const composition = await env.db.composition.create({
        data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds }) },
      })
      await composeEpisode(env.composePayload(composition.id, seed), env.deps())
      const updated = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
      expect(updated.status).toBe('COMPLETED')
      return (JSON.parse(updated.manifest) as { audio: Record<string, { mode: string; voiceArtifactId: string | null; ambienceArtifactId: string | null }> }).audio[shot]
    }

    /**
     * 人导入的文件不挂在任何生成任务下，夹具必须照搬这一点：一条带成功任务的 AUDIO 产物
     * 会被「取这一镜最新配音」的规则当成配音，那样测的就不是底，而是一条假配音。
     */
    async function importedBed(seed: Seed, storyboardId: string, seconds: number): Promise<string> {
      const sampleRate = 8000
      const data = Buffer.alloc(Math.round(seconds * sampleRate) * 2)
      const header = Buffer.alloc(44)
      header.write('RIFF', 0)
      header.writeUInt32LE(36 + data.byteLength, 4)
      header.write('WAVE', 8)
      header.write('fmt ', 12)
      header.writeUInt32LE(16, 16)
      header.writeUInt16LE(1, 20)
      header.writeUInt16LE(1, 22)
      header.writeUInt32LE(sampleRate, 24)
      header.writeUInt32LE(sampleRate * 2, 28)
      header.writeUInt16LE(2, 32)
      header.writeUInt16LE(16, 34)
      header.write('data', 36)
      header.writeUInt32LE(data.byteLength, 40)
      const bytes = new Uint8Array(Buffer.concat([header, data]))
      const stored = await env.storage.put(`${seed.organizationId}/${seed.episodeId}/AUDIO/imported/${randomUUID()}.wav`, bytes, 'audio/wav')
      const artifact = await env.db.mediaArtifact.create({
        data: {
          organizationId: seed.organizationId,
          stage: 'AUDIO',
          storyboardId,
          objectKey: stored.key,
          checksum: stored.checksum,
          mimeType: 'audio/wav',
          version: (await env.db.mediaArtifact.count({ where: { storyboardId, stage: 'AUDIO' } })) + 1,
          durationMs: Math.round(seconds * 1000),
          metadata: JSON.stringify({ imported: true, role: 'ambience', filename: '街道环境声.wav' }),
        },
      })
      return artifact.id
    }

    it('names the TTS line a defaulted shot used and the import that replaces it', async () => {
      const seed = await env.seed({ storyboards: 1 })
      const [shot] = seed.storyboardIds as [string]
      await env.db.storyboard.update({ where: { id: shot }, data: { dialogue: '这条街不能待了。' } })
      await env.attachSucceededVideo(seed, shot, 1)
      const tts = await env.attachSucceededMedia(seed, { stage: 'AUDIO', modality: 'tts', storyboardId: shot })

      // 没钦定 = 走镜型默认：有台词即配音，但清单要如实记下用的是哪条。
      expect(await composeShot(shot, seed, [shot])).toEqual({ mode: 'voice', voiceArtifactId: tts.artifactId, ambienceArtifactId: null })

      const imported = await env.attachSucceededMedia(seed, { stage: 'AUDIO', modality: 'tts', storyboardId: shot, version: 5 })
      await env.db.storyboard.update({ where: { id: shot }, data: { audioSource: 'IMPORTED', importedVoiceArtifactId: imported.artifactId } })
      expect(await composeShot(shot, seed, [shot])).toEqual({ mode: 'imported', voiceArtifactId: imported.artifactId, ambienceArtifactId: null })
    })

    // 「导入音频」这一档的意思就是这个人给的那个文件，晚到的 TTS 不许插队。
    it('takes the imported file over the newer TTS line when the shot is set to import', async () => {
      const seed = await env.seed({ storyboards: 1 })
      const [shot] = seed.storyboardIds as [string]
      await env.db.storyboard.update({ where: { id: shot }, data: { dialogue: '这条街不能待了。' } })
      await env.attachSucceededVideo(seed, shot, 1)
      const imported = await env.attachSucceededMedia(seed, { stage: 'AUDIO', modality: 'tts', storyboardId: shot })
      const newerTts = await env.attachSucceededMedia(seed, { stage: 'AUDIO', modality: 'tts', storyboardId: shot })
      await env.db.generationTask.update({ where: { id: imported.taskId }, data: { createdAt: new Date(Date.now() - 3_600_000) } })

      await env.db.storyboard.update({ where: { id: shot }, data: { audioSource: 'IMPORTED', importedVoiceArtifactId: imported.artifactId } })
      expect(await composeShot(shot, seed, [shot])).toEqual({ mode: 'imported', voiceArtifactId: imported.artifactId, ambienceArtifactId: null })
      // 对照：同一镜改回「只用配音」，取的就是那条更新的任务产物。
      await env.db.storyboard.update({ where: { id: shot }, data: { audioSource: 'VOICE' } })
      expect(await composeShot(shot, seed, [shot])).toEqual({ mode: 'voice', voiceArtifactId: newerTts.artifactId, ambienceArtifactId: null })
    })

    it('feeds no voice at all to a shot set to native', async () => {
      const seed = await env.seed({ storyboards: 1 })
      const [shot] = seed.storyboardIds as [string]
      await env.db.storyboard.update({ where: { id: shot }, data: { dialogue: '这条街不能待了。' } })
      await env.attachSucceededVideo(seed, shot, 1)
      await env.attachSucceededMedia(seed, { stage: 'AUDIO', modality: 'tts', storyboardId: shot })
      await env.db.storyboard.update({ where: { id: shot }, data: { audioSource: 'NATIVE' } })

      expect(await composeShot(shot, seed, [shot])).toEqual({ mode: 'native', voiceArtifactId: null, ambienceArtifactId: null })
    })

    // 指针是裸 id，文件行可能被钉到别处；这种情况回落到默认并留痕，绝不炸掉整次合成。
    it('falls back to the shot-type default when the import dangles', async () => {
      const seed = await env.seed({ storyboards: 1 })
      const [shot] = seed.storyboardIds as [string]
      await env.db.storyboard.update({ where: { id: shot }, data: { dialogue: '这条街不能待了。' } })
      await env.attachSucceededVideo(seed, shot, 1)
      const tts = await env.attachSucceededMedia(seed, { stage: 'AUDIO', modality: 'tts', storyboardId: shot })
      await env.db.storyboard.update({ where: { id: shot }, data: { audioSource: 'IMPORTED', importedVoiceArtifactId: 'ghost-artifact' } })

      // 不拿一条人没要过的 TTS 冒充导入文件：宁可不响，也不谎报来源。
      expect(await composeShot(shot, seed, [shot])).toEqual({ mode: 'default', voiceArtifactId: null, ambienceArtifactId: null })
    })

    // 环境音与声音来源是两栏：档说人声从哪来，这一条说配音底下垫什么。
    // 清单里两个 id 同时出现，才证明「配音 + 导入环境音」真的进了母带。
    it('records the imported bed alongside the voice it beds under', async () => {
      const seed = await env.seed({ storyboards: 1 })
      const [shot] = seed.storyboardIds as [string]
      await env.db.storyboard.update({ where: { id: shot }, data: { dialogue: '这条街不能待了。' } })
      await env.attachSucceededVideo(seed, shot, 1)
      const tts = await env.attachSucceededMedia(seed, { stage: 'AUDIO', modality: 'tts', storyboardId: shot })
      const bed = await importedBed(seed, shot, 2)
      await env.db.storyboard.update({ where: { id: shot }, data: { audioSource: 'VOICE', importedAmbienceArtifactId: bed } })

      expect(await composeShot(shot, seed, [shot])).toEqual({ mode: 'voice', voiceArtifactId: tts.artifactId, ambienceArtifactId: bed })
    })

    // 与配音同一口径：悬空即当作没导入，退回这一镜原本的声音，绝不谎报氛围底来自哪里。
    it('drops a bed whose file row is gone instead of failing the cut', async () => {
      const seed = await env.seed({ storyboards: 1 })
      const [shot] = seed.storyboardIds as [string]
      await env.db.storyboard.update({ where: { id: shot }, data: { dialogue: '这条街不能待了。' } })
      await env.attachSucceededVideo(seed, shot, 1)
      const tts = await env.attachSucceededMedia(seed, { stage: 'AUDIO', modality: 'tts', storyboardId: shot })
      await env.db.storyboard.update({ where: { id: shot }, data: { audioSource: 'VOICE', importedAmbienceArtifactId: 'ghost-artifact' } })

      expect(await composeShot(shot, seed, [shot])).toEqual({ mode: 'voice', voiceArtifactId: tts.artifactId, ambienceArtifactId: null })
    })

    // 换一条氛围底 = 母带里的声音变了，即使镜头清单、声音来源、已落地的配音都没动。
    // 两条底都在母带规划之前导入，所以放行只可能来自 ambienceArtifactId 这一项。
    it('re-cuts a planned master when only the bed changed', async () => {
      const seed = await env.seed({ storyboards: 1 })
      const [shot] = seed.storyboardIds as [string]
      await env.db.storyboard.update({ where: { id: shot }, data: { dialogue: '这条街不能待了。' } })
      await env.attachSucceededVideo(seed, shot, 1)
      await env.attachSucceededMedia(seed, { stage: 'AUDIO', modality: 'tts', storyboardId: shot })
      const firstBed = await importedBed(seed, shot, 2)
      const secondBed = await importedBed(seed, shot, 3)
      await env.db.storyboard.update({ where: { id: shot }, data: { audioSource: 'VOICE', importedAmbienceArtifactId: firstBed } })

      const composition = await env.db.composition.create({
        data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: [shot] }) },
      })
      await composeEpisode(env.composePayload(composition.id, seed), env.deps())
      expect((await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })).status).toBe('COMPLETED')

      expect(await planComposition(env.db, seed.episodeId)).toMatchObject({ ready: false, reason: 'composition:alreadyPlanned' })

      await env.db.storyboard.update({ where: { id: shot }, data: { importedAmbienceArtifactId: secondBed } })
      expect(await planComposition(env.db, seed.episodeId)).toMatchObject({ ready: true })
    })
  })
})

/** Stream kinds in container order — what the composer actually put into the file. */
function streamTypes(bytes: Uint8Array): string[] {
  const file = path.join(os.tmpdir(), `studio-probe-${randomUUID()}.bin`)
  writeFileSync(file, bytes)
  try {
    const stdout = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { encoding: 'utf8' }) as string
    return stdout.trim().split('\n').map(line => line.trim()).filter(Boolean)
  } finally {
    rmSync(file, { force: true })
  }
}

/**
 * Binds a mock `vlm` model to the `visual_audit` slot. `entitlementVerifiedAt` has
 * to be set explicitly — `env.seed` leaves it null and an unverified capability is
 * filtered out of candidate resolution, which is the behaviour one test relies on.
 */
async function bindVisualAudit(seed: Seed, options: { verified?: boolean; apiKey?: string } = {}): Promise<void> {
  const connection = await env.db.providerConnection.create({
    data: {
      organizationId: seed.organizationId,
      provider: 'mock',
      name: `audit-${randomUUID().slice(0, 8)}`,
      baseUrl: 'mock://local',
      encryptedSecret: encryptSecret(options.apiKey ?? 'audit-key', MASTER_KEY),
      capabilities: {
        create: [{
          model: 'mock-vlm',
          modality: 'vlm',
          entitlementVerifiedAt: options.verified === false ? null : new Date(),
        }],
      },
    },
  })
  const capability = await env.db.modelCapability.findFirstOrThrow({ where: { connectionId: connection.id } })
  await env.db.capabilityBinding.create({
    data: { organizationId: seed.organizationId, slot: 'VISUAL_AUDIT', capabilityId: capability.id, priority: 10 },
  })
}

describe('AI content generation', () => {
  it('writes an AI-generated script into a new ScriptVersion', async () => {
    const seed = await env.seed({ model: 'mock-script', modality: 'text', stage: 'SCRIPT', storyboards: 0 })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')

    const versions = await env.db.scriptVersion.findMany({ where: { episodeId: seed.episodeId } })
    expect(versions).toHaveLength(1)
    expect(versions[0]!.version).toBe(1)
    expect(versions[0]!.status).toBe('DRAFT')
    expect(versions[0]!.content).toBe(MOCK_SCRIPT_TEXT)
  })

  it('does not duplicate a script whose content is unchanged', async () => {
    const seed = await env.seed({ model: 'mock-script', modality: 'text', stage: 'SCRIPT', storyboards: 0 })
    const checksum = createHash('sha256').update(MOCK_SCRIPT_TEXT.trim(), 'utf8').digest('hex')
    await env.db.scriptVersion.create({
      data: { episodeId: seed.episodeId, version: 1, content: MOCK_SCRIPT_TEXT, checksum, status: 'APPROVED' },
    })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    expect(await env.db.scriptVersion.count({ where: { episodeId: seed.episodeId } })).toBe(1)
  })

  it('fans an AI shot list out into Storyboard rows linked to the script', async () => {
    const seed = await env.seed({ model: 'mock-storyboard', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    const script = await env.db.scriptVersion.create({
      data: { episodeId: seed.episodeId, version: 1, content: 'the script', checksum: 'script-checksum', status: 'APPROVED' },
    })
    await env.db.generationTask.update({
      where: { id: seed.taskId },
      data: { requestSnapshot: JSON.stringify({ model: 'mock-storyboard', input: { prompt: 'break the script into shots' }, parameters: {}, scriptVersionId: script.id }) },
    })

    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')

    const shots = MOCK_STORYBOARD.shots
    const boards = await env.db.storyboard.findMany({ where: { episodeId: seed.episodeId }, orderBy: { number: 'asc' } })
    expect(boards).toHaveLength(shots.length)
    expect(boards[0]!.number).toBe(1)
    expect(boards[0]!.revision).toBe(1)
    expect(boards[0]!.supersededAt).toBeNull()
    expect(boards[0]!.title).toBe(shots[0]!.title)
    expect(boards[0]!.description).toBe(shots[0]!.description)
    expect(boards[0]!.scriptVersionId).toBe(script.id)
    expect(boards[0]!.generationTaskId).toBe(task.id)
    expect(boards[0]!.status).toBe('DRAFT')

    // The same reply carries the episode's cast, props and scenes, which is what
    // lets the ASSET stage run without a human authoring the first asset.
    const assets = await env.db.asset.findMany({ where: { episodeId: seed.episodeId }, orderBy: { name: 'asc' } })
    expect(assets.map(asset => `${asset.kind}:${asset.name}`).sort()).toEqual(
      MOCK_STORYBOARD.assets.map(asset => `${asset.kind}:${asset.name}`).sort(),
    )
    expect(assets.every(asset => asset.status === 'DRAFT' && asset.generationTaskId === task.id)).toBe(true)
  })

  // The English locale has to be proven through the worker rather than through the
  // prompt alone: content.ts matches on English key names and drops an asset whose
  // kind is not character/prop/scene in silence. A locale that leaked into the
  // protocol instead of the content would produce zero shots, not a failure.
  it('records an English script when the task carries an English content locale', async () => {
    const seed = await env.seed({
      model: 'mock-script',
      modality: 'text',
      stage: 'SCRIPT',
      storyboards: 0,
      requestSnapshot: JSON.stringify({ model: 'mock-script', input: { prompt: 'Write the episode script.', contentLocale: 'en' }, parameters: {} }),
    })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const versions = await env.db.scriptVersion.findMany({ where: { episodeId: seed.episodeId } })
    expect(versions).toHaveLength(1)
    expect(versions[0]!.content).toBe(MOCK_SCRIPT_TEXT_EN)
  })

  it('parses an English shot list into the same episode shape as a Chinese one', async () => {
    const seed = await env.seed({
      model: 'mock-storyboard',
      modality: 'text',
      stage: 'STORYBOARD',
      storyboards: 0,
      requestSnapshot: JSON.stringify({ model: 'mock-storyboard', input: { prompt: 'Break the script into shots.', contentLocale: 'en' }, parameters: {} }),
    })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const boards = await env.db.storyboard.findMany({ where: { episodeId: seed.episodeId }, orderBy: { number: 'asc' } })
    expect(boards.map(shot => shot.title)).toEqual(MOCK_STORYBOARD_EN.shots.map(shot => shot.title))
    expect(boards.map(shot => shot.description)).toEqual(MOCK_STORYBOARD_EN.shots.map(shot => shot.description))

    const assets = await env.db.asset.findMany({ where: { episodeId: seed.episodeId } })
    expect(assets).toHaveLength(MOCK_STORYBOARD_EN.assets.length)
    expect([...new Set(assets.map(asset => asset.kind))].sort()).toEqual(['character', 'prop', 'scene'])
  })

  it('fails the task when the storyboard output is not parseable', async () => {
    const seed = await env.seed({ model: 'mock-text', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('FAILED')
    expect(await env.db.storyboard.count({ where: { episodeId: seed.episodeId } })).toBe(0)
  })
})

describe('segmented storyboard (4b)', () => {
  // 十场、每场 ~693 字符的长剧本:总长 ~6.9k 字符越过 6000 阈值,相邻场聚成
  // ~1.4k 字符/段 → 5 段;mock 对每段都回同一份 3 镜 JSON,合并后 15 镜。
  const sceneBody = '雨水顺着屋檐落下，沈亦在灯下翻看照片。'.repeat(36)
  const longScript = Array.from({ length: 10 }, (_, index) => `场景 ${index + 1}：老城区\n${sceneBody}`).join('\n\n')

  async function seedLongScriptTask(): Promise<Seed> {
    const seed = await env.seed({ model: 'mock-storyboard', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    const script = await env.db.scriptVersion.create({
      data: { episodeId: seed.episodeId, version: 1, content: longScript, checksum: `seg-${randomUUID()}`, status: 'APPROVED' },
    })
    await env.db.episode.update({ where: { id: seed.episodeId }, data: { targetDurationMs: 8 * 60_000 } })
    await env.db.generationTask.update({
      where: { id: seed.taskId },
      data: { requestSnapshot: JSON.stringify({ model: 'mock-storyboard', input: { prompt: 'break the script into shots' }, parameters: {}, scriptVersionId: script.id }) },
    })
    return seed
  }

  it('splits a long script by scene and numbers the merged shots continuously in one revision', async () => {
    const seed = await seedLongScriptTask()
    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')

    // 五段,每段只带自己那两场的剧本,并携带按占比折算的镜头预算。
    const calls = submitted.mock.calls.filter(([capability]) => capability.modality === 'text')
    expect(calls).toHaveLength(5)
    const firstPrompt = calls[0]![1].input.prompt as string
    expect(firstPrompt).toContain('场景 1：')
    expect(firstPrompt).toContain('场景 2：')
    expect(firstPrompt).not.toContain('场景 3：')
    expect(calls[4]![1].input.prompt as string).toContain('场景 10：')
    for (const call of calls) expect(call[1].input.prompt as string).toContain('本段剧本约拆')

    // 拼接结果:15 镜落在同一个 revision、编号 1..15 连续;每段重报的同批素材
    // 合并成一份,不把 (episodeId, kind, name) 唯一键撞成一串静默跳过。
    const boards = await env.db.storyboard.findMany({ where: { episodeId: seed.episodeId }, orderBy: { number: 'asc' } })
    expect(boards).toHaveLength(15)
    expect(boards.map(board => board.number)).toEqual(Array.from({ length: 15 }, (_, index) => index + 1))
    expect(new Set(boards.map(board => board.revision))).toEqual(new Set([1]))
    expect(boards.every(board => board.generationTaskId === seed.taskId)).toBe(true)
    expect(await env.db.asset.findMany({ where: { episodeId: seed.episodeId } })).toHaveLength(MOCK_STORYBOARD.assets.length)

    // 一段一件 artifact、一条 usage;回执记段数与段产物清单,审计跳得到每一段。
    expect(await env.db.mediaArtifact.count({ where: { taskId: seed.taskId } })).toBe(5)
    expect(await env.db.usageLedger.count({ where: { taskId: seed.taskId } })).toBe(5)
    const response = JSON.parse(task.responseSnapshot!) as { storyboardSegments: { count: number; artifactIds: string[] } }
    expect(response.storyboardSegments.count).toBe(5)
    expect(response.storyboardSegments.artifactIds).toHaveLength(5)
  })

  it('keeps the single-call path byte-for-byte for a script under the threshold', async () => {
    const seed = await env.seed({ model: 'mock-storyboard', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    const script = await env.db.scriptVersion.create({
      data: { episodeId: seed.episodeId, version: 1, content: '场景 1：短剧本，一镜到底。', checksum: `short-${randomUUID()}`, status: 'APPROVED' },
    })
    await env.db.generationTask.update({
      where: { id: seed.taskId },
      data: { requestSnapshot: JSON.stringify({ model: 'mock-storyboard', input: { prompt: 'break the script into shots' }, parameters: {}, scriptVersionId: script.id }) },
    })
    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')
    // 快照里的原始 prompt 原样上线:阈值内的行为与分段化之前完全一致。
    const calls = submitted.mock.calls.filter(([capability]) => capability.modality === 'text')
    expect(calls).toHaveLength(1)
    expect(calls[0]![1].input.prompt).toBe('break the script into shots')
    expect((JSON.parse(task.responseSnapshot!) as { storyboardSegments?: unknown }).storyboardSegments).toBeUndefined()
  })
})

describe('format-driven script prompts (4a/5)', () => {
  /** Binds a verified mock text model to the script_text slot so a SCRIPT stage can plan. */
  async function bindScriptSlot(seed: Seed): Promise<void> {
    const connection = await env.db.providerConnection.create({
      data: {
        organizationId: seed.organizationId,
        provider: 'mock',
        name: `script-${randomUUID().slice(0, 8)}`,
        baseUrl: 'mock://local',
        encryptedSecret: encryptSecret('script-key', MASTER_KEY),
        capabilities: { create: [{ model: 'mock-script', modality: 'text', entitlementVerifiedAt: new Date() }] },
      },
    })
    const capability = await env.db.modelCapability.findFirstOrThrow({ where: { connectionId: connection.id } })
    await env.db.capabilityBinding.create({
      data: { organizationId: seed.organizationId, slot: 'SCRIPT_TEXT', capabilityId: capability.id, priority: 10 },
    })
  }

  async function approveSource(seed: Seed, content: string): Promise<void> {
    await env.db.sourceDocumentVersion.create({
      data: { episodeId: seed.episodeId, version: 1, content, checksum: `source-${randomUUID()}`, status: 'APPROVED' },
    })
  }

  async function plannedPrompt(seed: Seed): Promise<string> {
    const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'SCRIPT')
    if (!result.ok) throw new Error(`the SCRIPT stage refused to plan: ${result.code} ${result.error}`)
    await env.takeWaitingRunTasks()
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId: (result as { batchId: string }).batchId } })
    return (JSON.parse(task.requestSnapshot!) as { input: { prompt: string } }).input.prompt
  }

  it('distills a FILM project from the whole book under its target duration', async () => {
    const seed = await env.seed({ model: 'mock-script', modality: 'text', stage: 'SCRIPT', storyboards: 0 })
    await env.db.project.update({ where: { id: seed.projectId }, data: { format: 'FILM' } })
    await env.db.episode.update({ where: { id: seed.episodeId }, data: { targetDurationMs: 120 * 60_000 } })
    await approveSource(seed, '整本小说：沈亦追查旧案……')
    await bindScriptSlot(seed)

    const prompt = await plannedPrompt(seed)
    expect(prompt).toContain('提炼改编为一部完整电影的拍摄剧本')
    expect(prompt).toContain('保留推动主线的关键人物与事件')
    expect(prompt).toContain('约 120 分钟')
    expect(prompt).toContain('「场景 1」')
    expect(prompt).toContain('整本小说：沈亦追查旧案……')
  })

  it('budgets a regular episode by its target duration without the film framing', async () => {
    const seed = await env.seed({ model: 'mock-script', modality: 'text', stage: 'SCRIPT', storyboards: 0 })
    await env.db.episode.update({ where: { id: seed.episodeId }, data: { targetDurationMs: 90_000 } })
    await approveSource(seed, '本集素材：雨夜来客。')
    await bindScriptSlot(seed)

    const prompt = await plannedPrompt(seed)
    expect(prompt).toContain('写出这一集的完整拍摄剧本')
    expect(prompt).toContain('约 2 分钟')
    expect(prompt).toContain('「场景 1」')
    expect(prompt).not.toContain('电影')
  })
})

describe('storyboard content contract', () => {
  const breakdown = {
    shots: [
      { number: 1, title: 'Rainy street', description: 'neon bleeding into wet asphalt', dialogue: '这条街不能待了。', speaker: '林晚', sourceExcerpt: 'the street at night', durationMs: 4000, continuityIn: '', continuityOut: 'push in on the puddle' },
      { number: 2, title: 'Half a photograph', description: 'a torn photo floating in the puddle', sourceExcerpt: 'only half a photo survived', durationMs: 5000, continuityIn: 'push in on the puddle', continuityOut: '' },
    ],
    assets: [
      { kind: 'character', name: 'Lin Wan', description: 'a reporter in a soaked khaki jacket' },
      { kind: 'prop', name: 'Torn photograph', description: 'a black and white photo ripped in half' },
      { kind: 'scene', name: 'Old town at night', description: 'a narrow street under heavy rain' },
    ],
  }

  async function seedStoryboard(storyboards = 0): Promise<Seed> {
    return env.seed({ model: 'mock-storyboard', modality: 'text', stage: 'STORYBOARD', storyboards })
  }

  function contentTask(seed: Seed, taskId = seed.taskId) {
    return { id: taskId, stage: 'STORYBOARD', requestSnapshot: null, batch: { episodeId: seed.episodeId } }
  }

  // A regenerate is a separate task, so lineage stays per generation.
  async function nextTask(seed: Seed): Promise<string> {
    const task = await env.db.generationTask.create({
      data: { organizationId: seed.organizationId, batchId: seed.batchId, stage: 'STORYBOARD', status: 'QUEUED' },
    })
    return task.id
  }

  it('writes the shots and extracts the assets from one reply wrapped in prose', async () => {
    const seed = await seedStoryboard()
    await recordGeneratedContent(env.db, contentTask(seed), `Here is the breakdown:\n\n\`\`\`json\n${JSON.stringify(breakdown)}\n\`\`\`\n`)

    const boards = await env.db.storyboard.findMany({ where: { episodeId: seed.episodeId }, orderBy: { number: 'asc' } })
    expect(boards).toHaveLength(2)
    expect(boards[0]).toMatchObject({
      revision: 1,
      number: 1,
      title: 'Rainy street',
      description: 'neon bleeding into wet asphalt',
      sourceExcerpt: 'the street at night',
      durationMs: 4000,
      continuityOut: 'push in on the puddle',
      status: 'DRAFT',
      generationTaskId: seed.taskId,
      supersededAt: null,
    })
    expect(boards[1]).toMatchObject({ revision: 1, number: 2, durationMs: 5000, continuityIn: 'push in on the puddle', dialogue: '', speaker: null })
    expect(boards[0]!.dialogue).toBe('这条街不能待了。')
    expect(boards[0]!.speaker).toBe('林晚')

    const assets = await env.db.asset.findMany({ where: { episodeId: seed.episodeId }, orderBy: { name: 'asc' } })
    expect(assets.map(asset => [asset.kind, asset.name])).toEqual([
      ['character', 'Lin Wan'],
      ['scene', 'Old town at night'],
      ['prop', 'Torn photograph'],
    ])
    expect(assets[0]!.description).toBe('a reporter in a soaked khaki jacket')
    expect(assets.every(asset => asset.status === 'DRAFT' && asset.generationTaskId === seed.taskId)).toBe(true)
  })

  it('binds shots to the assets their text mentions, so frames can ground on the sheets', async () => {
    // 说话人「林晚」的名字与素材名一致 → 绑定林晚;镜头 2 描述里只有 "photo"
    // 而素材名是全称 "撕破的照片" → 不含全称,不绑。匹配靠名字整体出现。
    const zhBreakdown = {
      ...breakdown,
      assets: [
        { kind: 'character', name: '林晚', description: '穿卡其色风衣的记者' },
        { kind: 'prop', name: '撕破的照片', description: '黑白照片撕成两半' },
      ],
    }
    const seed = await seedStoryboard()
    await recordGeneratedContent(env.db, contentTask(seed), JSON.stringify(zhBreakdown))

    const boards = await env.db.storyboard.findMany({ where: { episodeId: seed.episodeId }, orderBy: { number: 'asc' } })
    const [shot1, shot2] = boards
    const bound = await env.db.storyboardAsset.findMany({ where: { storyboardId: shot1!.id } })
    expect(bound).toHaveLength(1)
    const linWan = await env.db.asset.findFirstOrThrow({ where: { episodeId: seed.episodeId, name: '林晚' } })
    expect(bound[0]).toMatchObject({ assetId: linWan.id, role: 'character' })
    expect(await env.db.storyboardAsset.count({ where: { storyboardId: shot2!.id } })).toBe(0)

    // 重复拆解同一份内容:绑定幂等,不因 unique 冲突而失败。
    await recordGeneratedContent(env.db, contentTask(seed, await nextTask(seed)), JSON.stringify(zhBreakdown))
    const newShot1 = await env.db.storyboard.findFirstOrThrow({ where: { episodeId: seed.episodeId, number: 1, supersededAt: null } })
    expect(await env.db.storyboardAsset.count({ where: { storyboardId: newShot1.id } })).toBe(1)
  })

  it('supersedes the prior shots and numbers the new revision from 1', async () => {
    const seed = await seedStoryboard(2)
    expect((await env.db.storyboard.findMany({ where: { episodeId: seed.episodeId } })).map(board => board.revision)).toEqual([1, 1])

    await recordGeneratedContent(env.db, contentTask(seed), JSON.stringify(breakdown))
    const regenerateTaskId = await nextTask(seed)
    await recordGeneratedContent(env.db, contentTask(seed, regenerateTaskId), JSON.stringify(breakdown))

    const boards = await env.db.storyboard.findMany({ where: { episodeId: seed.episodeId }, orderBy: [{ revision: 'asc' }, { number: 'asc' }] })
    expect(boards.map(board => `${board.revision}.${board.number}`)).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1', '3.2'])
    // Nothing is deleted: a superseded shot may carry a first frame and video already paid for.
    expect(boards.slice(0, 4).every(board => board.supersededAt instanceof Date)).toBe(true)
    expect(boards.slice(4).every(board => board.supersededAt === null && board.generationTaskId === regenerateTaskId)).toBe(true)
  })

  it('keeps one asset per kind and name when the same breakdown is regenerated', async () => {
    const seed = await seedStoryboard()
    await recordGeneratedContent(env.db, contentTask(seed), JSON.stringify(breakdown))
    await recordGeneratedContent(env.db, contentTask(seed, await nextTask(seed)), JSON.stringify(breakdown))

    const assets = await env.db.asset.findMany({ where: { episodeId: seed.episodeId } })
    expect(assets).toHaveLength(3)
    // The first extraction owns the asset, so a re-run cannot steal its lineage.
    expect(assets.every(asset => asset.generationTaskId === seed.taskId)).toBe(true)
  })

  it('leaves a hand-authored asset of the same kind and name alone', async () => {
    const seed = await env.seed({
      model: 'mock-storyboard',
      modality: 'text',
      stage: 'STORYBOARD',
      storyboards: 0,
      asset: { kind: 'character', name: 'Lin Wan', description: 'hand authored by the art director' },
    })
    await recordGeneratedContent(env.db, contentTask(seed), JSON.stringify(breakdown))

    const assets = await env.db.asset.findMany({ where: { episodeId: seed.episodeId }, orderBy: { name: 'asc' } })
    expect(assets).toHaveLength(3)
    expect(assets[0]).toMatchObject({ name: 'Lin Wan', description: 'hand authored by the art director', generationTaskId: null })
  })

  it('still accepts a bare shot array, which carries no assets', async () => {
    const seed = await seedStoryboard()
    await recordGeneratedContent(env.db, contentTask(seed), '```json\n[{"title":"Rainy street","description":"neon"},{"description":"no title given"}]\n```')

    const boards = await env.db.storyboard.findMany({ where: { episodeId: seed.episodeId }, orderBy: { number: 'asc' } })
    expect(boards.map(board => board.title)).toEqual(['Rainy street', 'Shot 2'])
    expect(boards[0]!.durationMs).toBe(5000)
    expect(boards.every(board => board.revision === 1 && board.supersededAt === null)).toBe(true)
    expect(await env.db.asset.count({ where: { episodeId: seed.episodeId } })).toBe(0)
  })

  it('skips assets with a blank name or a kind outside the authoring vocabulary', async () => {
    const seed = await seedStoryboard()
    await recordGeneratedContent(env.db, contentTask(seed), JSON.stringify({
      shots: breakdown.shots,
      assets: [
        { kind: 'character', name: '  \n ', description: 'unnamed extra' },
        { kind: 'costume', name: 'Red dress', description: 'not a kind the console authors' },
        { kind: 'CHARACTER', name: 'Shen Yi', description: 'a detective in a dark coat' },
        { name: 'No kind', description: 'kind missing entirely' },
      ],
    }))

    const assets = await env.db.asset.findMany({ where: { episodeId: seed.episodeId } })
    expect(assets).toHaveLength(1)
    expect(assets[0]).toMatchObject({ kind: 'character', name: 'Shen Yi' })
  })

  it('throws on an unusable reply and writes nothing', async () => {
    const seed = await seedStoryboard()
    await expect(recordGeneratedContent(env.db, contentTask(seed), 'I could not break this script into shots.'))
      .rejects.toThrow('storyboard generation returned no parseable shot list')
    // An empty shot list is not a shot list; the assets half must not be written as shots.
    await expect(recordGeneratedContent(env.db, contentTask(seed), JSON.stringify({ shots: [], assets: breakdown.assets })))
      .rejects.toThrow('storyboard generation returned no parseable shot list')

    expect(await env.db.storyboard.count({ where: { episodeId: seed.episodeId } })).toBe(0)
    expect(await env.db.asset.count({ where: { episodeId: seed.episodeId } })).toBe(0)
  })
})

describe('script content contract', () => {
  function scriptTask(seed: Seed) {
    return { id: seed.taskId, stage: 'SCRIPT', requestSnapshot: null, batch: { episodeId: seed.episodeId } }
  }

  it('records which task generated the script version', async () => {
    const seed = await env.seed({ model: 'mock-script', modality: 'text', stage: 'SCRIPT', storyboards: 0 })
    await recordGeneratedContent(env.db, scriptTask(seed), `  ${MOCK_SCRIPT_TEXT}  `)

    const version = await env.db.scriptVersion.findFirstOrThrow({ where: { episodeId: seed.episodeId } })
    expect(version).toMatchObject({ version: 1, status: 'DRAFT', content: MOCK_SCRIPT_TEXT, generationTaskId: seed.taskId })
  })

  it('still throws when the script content is empty', async () => {
    const seed = await env.seed({ model: 'mock-script', modality: 'text', stage: 'SCRIPT', storyboards: 0 })
    await expect(recordGeneratedContent(env.db, scriptTask(seed), '   \n ')).rejects.toThrow('script generation returned empty content')
    expect(await env.db.scriptVersion.count({ where: { episodeId: seed.episodeId } })).toBe(0)
  })
})

describe('auto-advance', () => {
  /**
   * Binds a verified mock image model to the `image_gen` slot so an auto-advance
   * into ASSET (or IMAGE, which shares the slot) can resolve a candidate. Like
   * `bindVisualAudit`, the entitlement has to be verified explicitly — `env.seed`
   * leaves it null and an unverified capability is filtered out of candidate
   * resolution.
   */
  async function bindImageGen(seed: Seed): Promise<void> {
    const connection = await env.db.providerConnection.create({
      data: {
        organizationId: seed.organizationId,
        provider: 'mock',
        name: `image-${randomUUID().slice(0, 8)}`,
        baseUrl: 'mock://local',
        encryptedSecret: encryptSecret('image-key', MASTER_KEY),
        capabilities: { create: [{ model: 'mock-image', modality: 'image', entitlementVerifiedAt: new Date() }] },
      },
    })
    const capability = await env.db.modelCapability.findFirstOrThrow({ where: { connectionId: connection.id } })
    await env.db.capabilityBinding.create({
      data: { organizationId: seed.organizationId, slot: 'IMAGE_GEN', capabilityId: capability.id, priority: 10 },
    })
  }

  it('relays a completed storyboard batch into an ASSET batch for the extracted cast', async () => {
    const seed = await env.seed({ model: 'mock-storyboard', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    // ASSET resolves the same image_gen slot IMAGE does, and needs an approved script
    // only from IMAGE onwards.
    await env.db.scriptVersion.create({ data: { episodeId: seed.episodeId, version: 1, content: 'the approved script', checksum: 'advance-script', status: 'APPROVED' } })
    await bindImageGen(seed)

    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')

    // The storyboard task wrote its shots and extracted the assets, which rolled the
    // batch to COMPLETED and auto-advanced the pipeline into ASSET — the stage that
    // used to stall until a human authored an asset by hand.
    const boards = await env.db.storyboard.findMany({ where: { episodeId: seed.episodeId } })
    expect(boards).toHaveLength(MOCK_STORYBOARD.shots.length)
    const assets = await env.db.asset.findMany({ where: { episodeId: seed.episodeId } })
    expect(assets).toHaveLength(MOCK_STORYBOARD.assets.length)

    const assetBatch = await env.db.generationBatch.findFirstOrThrow({ where: { episodeId: seed.episodeId, stage: 'ASSET' } })
    expect(assetBatch.plannedCount).toBe(assets.length)
    expect(assetBatch.status).toBe('RUNNING')
    expect(await env.db.generationBatch.count({ where: { episodeId: seed.episodeId, stage: 'FIRST_FRAME' } })).toBe(0)

    const assetTasks = await env.db.generationTask.findMany({ where: { batchId: assetBatch.id } })
    expect(assetTasks.map(task => (JSON.parse(task.requestSnapshot!) as { assetId: string }).assetId).sort()).toEqual(assets.map(asset => asset.id).sort())

    // One ASSET run-task job was enqueued per extracted asset, each carrying the image candidate.
    const queued = await env.takeWaitingRunTasks()
    expect(queued).toHaveLength(assets.length)
    expect(queued.every(payload => payload.candidates[0]?.model === 'mock-image')).toBe(true)

    // The relay is attributed to the system, not to a user.
    const advance = await env.db.auditEvent.findFirst({ where: { organizationId: seed.organizationId, action: 'pipeline.autoAdvance' } })
    expect(advance).toBeTruthy()
    expect(advance!.entityId).toBe(seed.episodeId)
  })

  it('does not advance when the next stage is gated or has no candidate', async () => {
    // No approved script and no image_gen binding: the extracted assets make ASSET the
    // next runnable stage but it has no verified candidate to resolve, and IMAGE/VIDEO
    // stay gated on the approval — so no batch is created and nothing is queued.
    const seed = await env.seed({ model: 'mock-storyboard', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')
    expect(await env.db.generationBatch.count({ where: { episodeId: seed.episodeId, stage: { in: ['ASSET', 'FIRST_FRAME'] } } })).toBe(0)
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
  })
})

describe('usable first frames', () => {
  it('takes each shot the newest of its own frames a review left alone', async () => {
    const seed = await env.seed({ storyboards: 2 })
    const [audited, unjudged] = seed.storyboardIds as [string, string]
    // One shot's newer frame is the one a director pulled back for review, the other shot has
    // no verdict at all: the review is optional, so the absence of a verdict is not a verdict.
    const approved = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: audited, version: 1 })
    const refused = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: audited, version: 2 })
    const numbered = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: unjudged, version: 2 })
    const newest = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: unjudged, version: 1 })
    await stampFrame(approved.artifactId, FRAME_AGED)
    await stampFrame(refused.artifactId, FRAME_LATEST)
    await stampFrame(numbered.artifactId, FRAME_AGED)
    await stampFrame(newest.artifactId, FRAME_LATEST)
    await verdictOnFrame(refused.artifactId, 'NEEDS_REVIEW')

    const frames = await usableFirstFrames(env.db, seed.organizationId, seed.episodeId, [audited, unjudged, 'shot-with-no-frame-at-all'])

    // Conditioning a paid clip on the frame a review exists to catch is the failure this filter
    // is for, and a shot's newest frame is the one made last whatever number it was given.
    expect(frames.get(audited)).toBe(approved.artifactId)
    expect(frames.get(unjudged)).toBe(newest.artifactId)
    expect(frames.size).toBe(2)
  })

  it('breaks a tie between one shot\'s frames on their version rather than the clock', async () => {
    const seed = await env.seed()
    const [shot] = seed.storyboardIds as [string]
    const first = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: shot, version: 1 })
    const second = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: shot, version: 2 })
    // The instant two frames of one shot can share: `createdAt` alone cannot order them,
    // and a test that left this to the wall clock would pass either way.
    await stampFrame(first.artifactId, FRAME_TWIN)
    await stampFrame(second.artifactId, FRAME_TWIN)

    const frames = await usableFirstFrames(env.db, seed.organizationId, seed.episodeId, [shot])
    expect(frames.get(shot)).toBe(second.artifactId)
  })

  it('ignores media whose task failed and a clip, which is not a frame', async () => {
    const seed = await env.seed()
    const [shot] = seed.storyboardIds as [string]
    const failed = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: shot })
    const clip = await env.attachSucceededVideo(seed, shot, 1)
    await env.db.generationTask.update({ where: { id: failed.taskId }, data: { status: 'FAILED' } })

    const frames = await usableFirstFrames(env.db, seed.organizationId, seed.episodeId, [shot])
    // A frame from a task that never settled was never approved by anything, and a clip is
    // the work a frame conditions, not a substitute for it.
    expect(frames.size).toBe(0)
    expect(await env.db.mediaArtifact.count({ where: { id: { in: [failed.artifactId, clip.artifactId] } } })).toBe(2)
  })

  it('reads a frame only for the episode and the organization that own it', async () => {
    const home = await env.seed()
    const away = await env.seed()
    const [homeShot] = home.storyboardIds as [string]
    const [awayShot] = away.storyboardIds as [string]
    const mine = await env.attachSucceededMedia(home, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: homeShot })
    await env.attachSucceededMedia(away, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: awayShot })

    // Another episode's shot list, asked for with this episode's id: a character appearing in
    // a scene they were never cast in is exactly what a frame read across episodes causes.
    const acrossEpisodes = await usableFirstFrames(env.db, home.organizationId, home.episodeId, [awayShot])
    expect(acrossEpisodes.size).toBe(0)

    // The tenant column is checked on the artifact itself, not inherited from the episode:
    // a row whose organization disagrees is not this organization's frame.
    await env.db.mediaArtifact.update({ where: { id: mine.artifactId }, data: { organizationId: away.organizationId } })
    const acrossTenants = await usableFirstFrames(env.db, home.organizationId, home.episodeId, [homeShot])
    expect(acrossTenants.size).toBe(0)
  })
})

describe('first-frame conditioning', () => {
  it('plans a video task exactly as it did before any conditioning model was bound', async () => {
    const seed = await env.seed()
    const [shot] = seed.storyboardIds as [string]
    await approveScript(seed)
    const t2v = await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    // The frame is there and usable; with nothing bound that could take it, planning it is a
    // query whose answer no request could carry, and the snapshot would grow a key.
    await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: shot })

    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })

    // The full shape a VIDEO task snapshot carries: no model (that belongs to whichever
    // candidate ends up running), plus the base seed the billing audit answers from —
    // derived from the idempotency key, so a re-plan of the same shot re-derives it.
    // The guard chain has already run by now: the bare prompt gains the style anchor,
    // and promptGuards records what was touched.
    expect(JSON.parse(task.requestSnapshot!)).toEqual({
      input: { prompt: `Shot 1: a rainy night market\n\n${TEXT_LANGUAGE_RULE_ZH}\n\n${MOTION_RULE_ZH}\n\n${VISUAL_STYLE_DIRECTIVE}` },
      parameters: { seed: generationSeed(task.idempotencyKey!) },
      promptGuards: [{ guard: 'style-anchor', action: 'repair', note: expect.any(String) }],
    })

    const queued = await env.takeWaitingRunTasks()
    expect(queued.map(payload => payload.taskId)).toEqual([task.id])
    expect(queued[0]!.candidates).toEqual([t2v])
  })

  it('conditions a shot on its own approved frame and puts the conditioning model first', async () => {
    const seed = await env.seed()
    const [shot] = seed.storyboardIds as [string]
    await approveScript(seed)
    const t2v = await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    const i2v = await bindVideoSlot(seed, 'VIDEO_I2V', 'mock-i2v')
    const frame = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: shot })

    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })
    // Only the id travels in the snapshot; an approved frame is megabytes and the artifact
    // row already carries its checksum. parameters still sits between input and
    // referenceArtifacts, and the guard trail is appended last so every pre-guard key keeps
    // its place — growing either end has to be decided twice.
    expect(JSON.parse(task.requestSnapshot!)).toEqual({
      input: { prompt: `Shot 1: a rainy night market\n\n${TEXT_LANGUAGE_RULE_ZH}\n\n${MOTION_RULE_ZH}\n\n${VISUAL_STYLE_DIRECTIVE}` },
      parameters: { seed: generationSeed(task.idempotencyKey!) },
      referenceArtifacts: [{ type: 'first_frame', artifactId: frame.artifactId }],
      promptGuards: [{ guard: 'style-anchor', action: 'repair', note: expect.any(String) }],
    })

    const queued = await env.takeWaitingRunTasks()
    // Conditioning first, text-to-video behind it: a conditioning model that is down still
    // yields a picture — a lesser one, but the shot is not lost over a quality gain.
    expect(queued[0]!.candidates).toEqual([i2v, t2v])

    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    const audited: QcSubject[] = []
    await runTask(queued[0]!, env.deps({ qcMode: 'pass', pollIntervalMs: 10, checker: recordingChecker(audited) }))

    const calls = submitted.mock.calls.filter(([capability]) => capability.modality === 'i2v')
    expect(calls).toHaveLength(1)
    expect(calls[0]![1].input.media).toEqual([{ type: 'first_frame', url: expect.stringMatching(/^data:image\//) }])
    const wireUrl = (calls[0]![1].input.media as { url: string }[])[0]!.url

    const succeeded = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(succeeded.status).toBe('SUCCEEDED')
    expect(succeeded.model).toBe('mock-i2v')
    const response = JSON.parse(succeeded.responseSnapshot!) as { providerTaskId: string; artifactUrl: string; reference?: unknown[] }
    // The log names the model that took the frame, not the frame's bytes — the artifact id is
    // already on the request side of the row and this column is for what the worker did.
    expect(response.reference).toEqual([{ model: 'mock-i2v', conditioned: true }])
    // The URL is the mock's receipt for what it was handed, stored verbatim by the worker.
    expect(response.artifactUrl).toBe(`mock://artifacts/${response.providerTaskId}/i2v?refs=first_frame`)
    // The auditor judges the clip against the very image the model was conditioned with —
    // a different one would be judging nothing.
    expect(audited[0]!.referenceDataUrl).toBe(wireUrl)
  })

  it('cuts each clip on the newest frame a review left alone, falling back within the same shot', async () => {
    const seed = await env.seed({ storyboards: 2 })
    const [refused, onlyFrame] = seed.storyboardIds as [string, string]
    await approveScript(seed)
    const t2v = await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    const i2v = await bindVideoSlot(seed, 'VIDEO_I2V', 'mock-i2v')
    const approved = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: refused, version: 1 })
    const rejected = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: refused, version: 2 })
    const olderUsable = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: onlyFrame, version: 1 })
    const latestRejected = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: onlyFrame, version: 2 })
    await stampFrame(approved.artifactId, FRAME_AGED)
    await stampFrame(rejected.artifactId, FRAME_LATEST)
    await stampFrame(olderUsable.artifactId, FRAME_AGED)
    await stampFrame(latestRejected.artifactId, FRAME_LATEST)
    await verdictOnFrame(rejected.artifactId, 'NEEDS_REVIEW')
    await verdictOnFrame(latestRejected.artifactId, 'NEEDS_REVIEW')

    const batchId = await planVideo(seed)
    const tasks = await plannedTasks(batchId)
    expect(tasks.get(refused)!.requestSnapshot).toContain(approved.artifactId)
    // A shot whose newest frame is out for review still cuts on its older approved one —
    // a review takes back that one frame, not the shot's whole reference history.
    expect(tasks.get(onlyFrame)!.requestSnapshot).toContain(olderUsable.artifactId)
    expect(tasks.get(onlyFrame)!.requestSnapshot).not.toContain(latestRejected.artifactId)

    const queued = new Map((await env.takeWaitingRunTasks()).map(payload => [payload.taskId, payload]))
    expect(queued.get(tasks.get(refused)!.id)?.candidates).toEqual([i2v, t2v])
    expect(queued.get(tasks.get(onlyFrame)!.id)?.candidates).toEqual([i2v, t2v])

    const deps = env.deps({ qcMode: 'pass', pollIntervalMs: 10 })
    await runTask(queued.get(tasks.get(refused)!.id)!, deps)
    await runTask(queued.get(tasks.get(onlyFrame)!.id)!, deps)

    // Both shots are conditioned: a review on the newest frame is never a reason to lose
    // the character's face in the clip.
    for (const id of [tasks.get(refused)!.id, tasks.get(onlyFrame)!.id]) {
      const conditioned = await env.db.generationTask.findUniqueOrThrow({ where: { id } })
      expect(conditioned.status).toBe('SUCCEEDED')
      expect(conditioned.model).toBe('mock-i2v')
      const response = JSON.parse(conditioned.responseSnapshot!) as { providerTaskId: string; artifactUrl: string; reference?: unknown[] }
      expect(response.reference).toEqual([{ model: 'mock-i2v', conditioned: true }])
      expect(response.artifactUrl).toBe(`mock://artifacts/${response.providerTaskId}/i2v?refs=first_frame`)
    }
  })

  it('refuses the stage when a shot has no frame left at all after a review', async () => {
    const seed = await env.seed({ storyboards: 2 })
    const [approved, refused] = seed.storyboardIds as [string, string]
    await approveScript(seed)
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    await bindVideoSlot(seed, 'VIDEO_I2V', 'mock-i2v')
    await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: approved })
    const onlyFrame = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: refused })
    await verdictOnFrame(onlyFrame.artifactId, 'NEEDS_REVIEW')

    const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'VIDEO')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the VIDEO stage to be refused')
    expect(result.error).toBe('generations:videoMissingFrames')
    expect(result.reasons).toEqual([`#${(await env.db.storyboard.findUniqueOrThrow({ where: { id: refused } })).number}`])
  })

  it('refuses VIDEO for a shot whose newest first-frame attempt is still queued or running', async () => {
    // 首帧在途时放行视频,视频会按旧画面(或无画面)生成——新首帧落位后图文不符,
    // 一次视频额度就白烧了(实景:重试的视频没拿到在途新帧,纯文生视频幻觉出无关画面)。
    // 判定取"最新一次首帧尝试":旧帧可用不算数,除非它仍是最新的那次尝试。
    const seed = await env.seed()
    const [shot] = seed.storyboardIds as [string]
    await approveScript(seed)
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    await bindVideoSlot(seed, 'VIDEO_I2V', 'mock-i2v')
    await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: shot })
    const queuedBatch = await env.db.generationBatch.create({ data: { organizationId: seed.organizationId, episodeId: seed.episodeId, stage: 'FIRST_FRAME', status: 'RUNNING', plannedCount: 1 } })
    await env.db.generationTask.create({
      data: {
        organizationId: seed.organizationId,
        batchId: queuedBatch.id,
        stage: 'FIRST_FRAME', status: 'QUEUED', storyboardId: shot,
        idempotencyKey: `${seed.episodeId}:IMAGE:${shot}:inflight`,
        createdAt: new Date(Date.now() + 60_000),
      },
    })

    const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'VIDEO', { storyboardIds: [shot], regenerate: true })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the VIDEO stage to be refused while the newest frame attempt is in flight')
    expect(result.error).toBe('generations:frameInFlight')
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)

    // 在途尝试落定(失败也算落定,错误横幅会说明)之后,同一次触发就放行了。
    const queuedTask = await env.db.generationTask.findFirstOrThrow({ where: { idempotencyKey: `${seed.episodeId}:IMAGE:${shot}:inflight` } })
    await env.db.generationTask.update({ where: { id: queuedTask.id }, data: { status: 'FAILED', errorSnapshot: '["bad luck"]' } })
    const retried = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'VIDEO', { storyboardIds: [shot], regenerate: true })
    expect(retried.ok).toBe(true)
  })

  it('refuses the whole VIDEO stage and names the shots missing a frame once a conditioning model is bound', async () => {
    const seed = await env.seed({ storyboards: 2 })
    const [withFrame, withoutFrame] = seed.storyboardIds as [string, string]
    await approveScript(seed)
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    await bindVideoSlot(seed, 'VIDEO_I2V', 'mock-i2v')
    await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: withFrame })

    // Silent fallback to text-to-video would spend money on a clip that does not carry the
    // character's face, so the stage refuses up front instead — naming the shots to fix.
    const batchesBefore = await env.db.generationBatch.count({ where: { episodeId: seed.episodeId, stage: 'VIDEO' } })
    const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'VIDEO')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the VIDEO stage to be refused')
    expect(result.error).toBe('generations:videoMissingFrames')
    expect(result.reasons).toEqual([`#${(await env.db.storyboard.findUniqueOrThrow({ where: { id: withoutFrame } })).number}`])
    expect(await env.db.generationBatch.count({ where: { episodeId: seed.episodeId, stage: 'VIDEO' } })).toBe(batchesBefore)
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
  })

  it('keeps planning video freely when no conditioning model is bound, frames or not', async () => {
    const seed = await env.seed()
    await approveScript(seed)
    const t2v = await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')

    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })

    expect(JSON.parse(task.requestSnapshot!)).toEqual({
      input: { prompt: `Shot 1: a rainy night market\n\n${TEXT_LANGUAGE_RULE_ZH}\n\n${MOTION_RULE_ZH}\n\n${VISUAL_STYLE_DIRECTIVE}` },
      parameters: { seed: generationSeed(task.idempotencyKey!) },
      promptGuards: [{ guard: 'style-anchor', action: 'repair', note: expect.any(String) }],
    })
    const queued = await env.takeWaitingRunTasks()
    expect(queued[0]!.candidates).toEqual([t2v])
  })

  it('still cuts the clip when the frame is bigger than the model says it may take', async () => {
    // A ceiling under the frame ffmpeg writes for a still: the refusal is the bound model's
    // own number, read out of its row, not a limit no real frame could ever cross.
    const ceiling = 512
    const seed = await env.seed()
    const [shot] = seed.storyboardIds as [string]
    await approveScript(seed)
    const t2v = await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    const i2v = await bindVideoSlot(seed, 'VIDEO_I2V', 'mock-i2v', { referenceMaxBytes: ceiling })
    const frame = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: shot })

    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })
    expect(task.requestSnapshot).toContain(frame.artifactId)
    const queued = await env.takeWaitingRunTasks()
    expect(queued[0]!.candidates).toEqual([i2v, t2v])

    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    const audited: QcSubject[] = []
    await runTask(queued[0]!, env.deps({ qcMode: 'pass', pollIntervalMs: 10, checker: recordingChecker(audited) }))

    // The refused frame never reaches the wire at all: the worker declines the conditioning
    // candidate on the spot, so the only attempt the vendor sees is the text-only one.
    const attempts = submitted.mock.calls.map(([capability, request]) => ({ model: capability.model, media: 'media' in request.input }))
    expect(attempts).toEqual([{ model: 'mock-t2v', media: false }])

    const succeeded = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(succeeded.status).toBe('SUCCEEDED')
    expect(succeeded.model).toBe('mock-t2v')
    const response = JSON.parse(succeeded.responseSnapshot!) as { providerTaskId: string; artifactUrl: string; reference?: { model: string; conditioned: boolean; reason?: string }[] }
    expect(response.artifactUrl).toBe(`mock://artifacts/${response.providerTaskId}/t2v`)
    expect(audited[0]!.referenceDataUrl).toBeUndefined()

    // The shot fell back to text and the row says why, in the numbers the gate that decided it
    // actually saw — the bytes it read and the ceiling from the bound model's own row.
    expect(response.reference).toHaveLength(1)
    expect(response.reference![0]).toMatchObject({ model: 'mock-i2v', conditioned: false })

    const stored = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: frame.artifactId } })
    const bytes = await env.storage.read(stored.objectKey)
    const refusal = await toReferenceImage({ bytes, mimeType: stored.mimeType, workdir: await mkdtemp(path.join(os.tmpdir(), 'studio-reference-')), limits: { maxBytes: ceiling } })
    expect(refusal.ok).toBe(false)
    if (refusal.ok) throw new Error('expected the frame to be refused')
    expect(response.reference![0]!.reason).toBe(refusal.reason)
    expect(refusal.reason).toContain(`${bytes.byteLength} bytes`)
    expect(refusal.reason).toContain(`${ceiling} bytes`)
  })

  it('flattens a transparent frame to the opaque JPEG the vendors accept before sending it', async () => {
    const seed = await env.seed()
    const [shot] = seed.storyboardIds as [string]
    await approveScript(seed)
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    const i2v = await bindVideoSlot(seed, 'VIDEO_I2V', 'mock-i2v')
    // The same alpha chain the media suite pins: what is stored has to be the case under test.
    const transparent = await stillFrame('480x360', { alpha: true })
    await env.attachSucceededMedia(seed, {
      stage: 'FIRST_FRAME',
      modality: 'image',
      storyboardId: shot,
      source: { bytes: transparent, mimeType: 'image/png' },
    })

    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })
    const queued = await env.takeWaitingRunTasks()
    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    await runTask(queued[0]!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const calls = submitted.mock.calls.filter(([capability]) => capability.modality === 'i2v')
    expect(calls).toHaveLength(1)
    expect(calls[0]![1].input.media).toEqual([{ type: 'first_frame', url: expect.stringMatching(/^data:image\/jpeg;base64,/) }])
    const sent = (calls[0]![1].input.media as { url: string }[])[0]!.url

    const succeeded = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(succeeded.model).toBe('mock-i2v')
    const response = JSON.parse(succeeded.responseSnapshot!) as { providerTaskId: string; artifactUrl: string; reference?: unknown[] }
    expect(response.reference).toEqual([{ model: 'mock-i2v', conditioned: true }])
    expect(response.artifactUrl).toBe(`mock://artifacts/${response.providerTaskId}/i2v?refs=first_frame`)
    // A frame flattened to an opaque JPEG still conditions the shot; one sent as it was
    // stored would be refused for its alpha plane and the shot would fall back to text.
    expect(Buffer.from(sent.slice(sent.indexOf(',') + 1), 'base64').equals(Buffer.from(transparent))).toBe(false)
  })

  it('keeps a planned frame away from a candidate that cannot take one', async () => {
    const seed = await env.seed()
    const [shot] = seed.storyboardIds as [string]
    await approveScript(seed)
    const t2v = await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    const i2v = await bindVideoSlot(seed, 'VIDEO_I2V', 'mock-i2v')
    const frame = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: shot })

    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })
    expect(task.requestSnapshot).toContain(frame.artifactId)
    const queued = await env.takeWaitingRunTasks()

    // The frame was planned against a model that had gone away between planning and the
    // worker opening it, so a text-to-video candidate has to run with the same snapshot.
    await env.db.providerConnection.update({ where: { id: i2v.connectionId }, data: { enabled: false } })
    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    await runTask(queued[0]!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    expect(submitted.mock.calls).toHaveLength(1)
    // Absent, not empty: a `media` key a text-to-video adapter forwarded as-is is what
    // several vendors answer 200 to, and the shot then costs full price with no conditioning.
    // The prompt is the guarded one the snapshot carries — the worker forwards input verbatim.
    expect(submitted.mock.calls[0]![1].input).toEqual({ prompt: `Shot 1: a rainy night market\n\n${TEXT_LANGUAGE_RULE_ZH}\n\n${MOTION_RULE_ZH}\n\n${VISUAL_STYLE_DIRECTIVE}` })

    const succeeded = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(succeeded.status).toBe('SUCCEEDED')
    expect(succeeded.model).toBe('mock-t2v')
    const response = JSON.parse(succeeded.responseSnapshot!) as { providerTaskId: string; artifactUrl: string; reference?: Record<string, unknown> }
    expect(response.reference).toBeUndefined()
    expect(response.artifactUrl).toBe(`mock://artifacts/${response.providerTaskId}/t2v`)
  })
})

/** VIDEO is gated on a script a human approved, so a planned shot is never paid for first. */
async function approveScript(seed: Seed): Promise<void> {
  await env.db.scriptVersion.create({
    data: { episodeId: seed.episodeId, version: 1, content: 'the approved script', checksum: `conditioning-${randomUUID()}`, status: 'APPROVED' },
  })
}

/**
 * Binds one verified mock model into a video slot on its own connection, and hands back the
 * queued-job shape of the binding: `env.seed` leaves its capability unverified, and
 * `resolveSlotCandidates` drops unverified ones, so the bindings the console would have made
 * after a probe have to be made here for a stage to plan at all.
 */
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
          modality: slot === 'VIDEO_I2V' ? 'i2v' : 't2v',
          acceptsFirstFrame: slot === 'VIDEO_I2V',
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

async function verdictOnFrame(artifactId: string, status: 'APPROVED' | 'NEEDS_REVIEW'): Promise<void> {
  await env.db.qualityCheck.create({
    data: {
      status,
      kind: 'visual-audit',
      score: status === 'APPROVED' ? 0.9 : 0.2,
      report: JSON.stringify({ reasons: status === 'APPROVED' ? [] : ['the lead actor is not the approved one'] }),
      artifactId,
    },
  })
}

/**
 * Frames are picked newest-first by `createdAt`, and rows written back to back can come back
 * in either order, so the premise a test is built on is stamped into the row rather than
 * left to the wall clock. `FRAME_TWIN` is the instant two frames of one shot can share.
 */
async function stampFrame(artifactId: string, createdAt: Date): Promise<void> {
  await env.db.mediaArtifact.update({ where: { id: artifactId }, data: { createdAt } })
}

const FRAME_AGED = new Date('2026-03-01T00:00:00.000Z')
const FRAME_LATEST = new Date('2026-03-09T00:00:00.000Z')
const FRAME_TWIN = new Date('2026-03-05T00:00:00.000Z')

/** A real frame, made by the ffmpeg the chain itself uses — no binary fixture in the repo. */
async function stillFrame(size: string, options: { alpha?: boolean } = {}): Promise<Uint8Array> {
  const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-frame-'))
  try {
    const file = path.join(workdir, 'frame.png')
    const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x2f6f4f:size=${size}`]
    if (options.alpha) args.push('-vf', 'format=rgba,colorchannelmixer=aa=0.4')
    args.push('-frames:v', '1', file)
    await run('ffmpeg', args)
    return new Uint8Array(await readFile(file))
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

/** The default audit, held open: what the worker showed an auditor is in no database row. */
function recordingChecker(seen: QcSubject[]): QualityChecker {
  return {
    async check(subject) {
      seen.push(subject)
      return { kind: 'fake-qc', decision: 'pass', score: 1 }
    },
  }
}

/** A plan refuses for a reason an assertion should state outright. */
async function planVideo(seed: Seed): Promise<string> {
  const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'VIDEO')
  if (!result.ok) throw new Error(`the VIDEO stage refused to plan: ${result.error}`)
  return result.batchId
}

/** The tasks one plan created, keyed by the shot each one is for. */
async function plannedTasks(batchId: string) {
  const tasks = await env.db.generationTask.findMany({ where: { batchId } })
  return new Map(tasks.map(task => [task.storyboardId, task]))
}

describe('billed parameters', () => {
  const videoCap = (modality: 't2v' | 'i2v' | 'r2v' | 'image') => ({ provider: 'mock', model: 'm', modality }) as unknown as Parameters<typeof pinBilledParameters>[1]
  const request = (parameters: Record<string, unknown>) => ({ model: 'm', input: {}, parameters }) as unknown as Parameters<typeof pinBilledParameters>[0]

  it('rotates the base seed per attempt so a rework never re-bills identical bytes', () => {
    const first = request({ seed: 41 })
    expect(pinBilledParameters(first, videoCap('i2v'), null, 1)).toEqual({ seed: 41 })
    const second = request({ seed: 41 })
    expect(pinBilledParameters(second, videoCap('i2v'), null, 2)).toEqual({ seed: 42 })
    expect(second.parameters.seed).toBe(42)
  })

  it('pins the 1080-class tier the model declares, in the model\u2019s own spelling', () => {
    const upper = request({ seed: 7 })
    expect(pinBilledParameters(upper, videoCap('t2v'), { resolutions: ['480P', '720P', '1080P'] }, 1)).toEqual({ seed: 7, resolution: '1080P' })
    const lower = request({})
    expect(pinBilledParameters(lower, videoCap('i2v'), { resolutions: ['480p', '720p', '1080p', '4k'] }, 1)).toEqual({ resolution: '1080p' })
    // A model that ships one tier only is pinned to exactly that tier; 4k is never a default.
    const sole = request({})
    expect(pinBilledParameters(sole, videoCap('i2v'), { resolutions: ['720P'] }, 1)).toEqual({ resolution: '720P' })
    const fourKOnly = request({})
    expect(pinBilledParameters(fourKOnly, videoCap('t2v'), { resolutions: ['2160p', '4k'] }, 1)).toEqual({ resolution: '2160p' })
  })

  it('leaves what the spec does not declare to the vendor, and never overwrites what the caller set', () => {
    const undeclared = request({ seed: 3 })
    expect(pinBilledParameters(undeclared, videoCap('i2v'), { durations: [5] }, 1)).toEqual({ seed: 3 })
    expect(undeclared.parameters.resolution).toBeUndefined()
    const setByCaller = request({ resolution: '480P' })
    // Nothing new is pinned (billed is empty) and the caller's number survives untouched.
    expect(pinBilledParameters(setByCaller, videoCap('t2v'), { resolutions: ['480P', '1080P'] }, 1)).toEqual({})
    expect(setByCaller.parameters.resolution).toBe('480P')
    // Only video models bill by a resolution tier; an image row's sizes follow other keys
    // entirely, so nothing is invented for it here.
    const image = request({})
    expect(pinBilledParameters(image, videoCap('image'), { resolutions: ['1024x1024'] }, 1)).toEqual({})
  })

  it('sends the seed and the pinned tier on the wire and records them on the task', async () => {
    const seed = await env.seed()
    await approveScript(seed)
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v', { resolutions: ['480P', '720P', '1080P'] })
    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })

    const queued = await env.takeWaitingRunTasks()
    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    await runTask(queued[0]!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    // The snapshot held the base; the wire carries what was billed. Both land in rows a
    // later "what did we pay for" question can be answered from without re-deriving.
    const billed = { seed: generationSeed(task.idempotencyKey!), resolution: '1080P' }
    const call = submitted.mock.calls.find(([capability]) => capability.modality === 't2v')
    expect(call?.[1].parameters).toEqual(billed)
    const succeeded = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(JSON.parse(succeeded.responseSnapshot!).parameters).toEqual(billed)
  })
})
