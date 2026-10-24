const TEXT_LANGUAGE_RULE_ZH = '画面文字规则（最高优先级）：标题、标签、招牌等短文字一律使用简体中文，清晰可读；禁止出现可辨认的英文单词或字母；长文书类（协议/证书/书页）的正文文字可作虚化模糊处理，不必逐字可读，但不得出现可读的英文。'
const MOTION_RULE_ZH = '运动规则（与画面文字规则同级）：画面中人物的一切动作与镜头运动只能来自上文描述明确写出的内容——描述没有写的动作不得出现。描述未提及任何动作时，只保持呼吸起伏、眨眼与光线的缓慢变化，机位固定、不推不拉。'

import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma, type CapabilitySlot } from '@studio/db'
import { MOCK_SCRIPT_TEXT, MOCK_SCRIPT_TEXT_EN, MOCK_STORYBOARD_JSON, MOCK_STORYBOARD_JSON_EN, MOCK_VLM_VERDICT, MockProviderAdapter } from '@studio/providers'
import { advancePipeline, compositionCutChanged, createComposition, generationSeed, planComposition, readCompositionReview, triggerStage, usableFirstFrames, VISUAL_STYLE_DIRECTIVE } from '@studio/pipeline'
import { AUDIO_BRIDGE_PRE_MS, AUDIO_BRIDGE_TAIL_MS, probeDuration, synthesizeMockMedia, toReferenceImage } from '@studio/media'
import { encryptSecret } from '@studio/security'
import type { RunTaskCandidate } from '@studio/jobs'
import { composeEpisode } from '../src/compose.js'
import { recordGeneratedContent } from '../src/content.js'
import type { QcSubject, QualityChecker } from '../src/qc.js'
import { measureMissingMeta, pinBilledParameters, runTask } from '../src/run-task.js'
import { runArtifactOperation } from '../src/run-artifact-operation.js'
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

/**
 * 字幕交付方式由用例自己指定,不由宿主 ffmpeg 的构建决定:libass 有没有取决于「谁装的
 * ffmpeg」(本机默认装的是精简版,.env 把 STUDIO_FFMPEG_DIR 指到 ffmpeg-full 之后就带),
 * 拿它当判据的话同一个断言在不同机器上会得出相反结论。
 */
const savedSubtitleMode = process.env.STUDIO_SUBTITLE_MODE
afterEach(() => {
  if (savedSubtitleMode === undefined) delete process.env.STUDIO_SUBTITLE_MODE
  else process.env.STUDIO_SUBTITLE_MODE = savedSubtitleMode
})

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

  it('stops and asks on the first creative rework under the default policy', async () => {
    // 2026-10-19 拍板：创作性失败默认先问。首次判回不自动重抽，任务停下并留下
    // 一份 pending 快照——候选链原样保存，人工「重抽」直接复用。
    const seed = await env.seed()
    const deps = env.deps({ qcMode: 'fail', pollIntervalMs: 10 })

    await runTask(env.runPayload(seed, 1), deps)

    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('FAILED')
    expect(task.attempts).toBe(1)
    const review = JSON.parse(task.reviewSnapshot!) as {
      state: string
      retryClass: string
      policy: string
      askReason: string
      attempt: number
      retriesUsed: number
      candidates: unknown[]
    }
    expect(review).toMatchObject({ state: 'pending', retryClass: 'creative', policy: 'ask', askReason: 'policy', attempt: 1, retriesUsed: 0 })
    expect(review.candidates).toEqual(seed.candidates)

    const checks = await env.db.qualityCheck.findMany({ where: { artifact: { taskId: seed.taskId } } })
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ status: 'NEEDS_REVIEW', kind: 'fake-qc', score: 0.1 })
    expect(await env.db.mediaArtifact.count({ where: { taskId: seed.taskId } })).toBe(1)
    expect(await env.db.usageLedger.count({ where: { taskId: seed.taskId } })).toBe(0)
  })

  it('auto-retries once when creative failures are set to auto1, then asks', async () => {
    const seed = await env.seed()
    // 每镜上限 3（新建项目的界面默认值）：这里要验的是策略只买到一次，而不是上限先到。
    await env.db.project.update({ where: { id: seed.projectId }, data: { retryCreative: 'auto1', maxRetriesPerShot: 3 } })
    const deps = env.deps({ qcMode: 'fail', pollIntervalMs: 10 })

    await runTask(env.runPayload(seed, 1), deps)
    const second = (await env.takeWaitingRunTasks())[0]!
    expect(second.attempt).toBe(2)
    expect(second.candidates).toEqual(seed.candidates)
    await runTask(second, deps)

    // 策略只买到一次自动重抽；第二次判回就停下问，不是继续烧。
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('FAILED')
    expect(task.attempts).toBe(2)
    const review = JSON.parse(task.reviewSnapshot!) as { state: string; policy: string; askReason: string; retryClass: string; retriesUsed: number }
    expect(review).toMatchObject({ state: 'pending', retryClass: 'creative', policy: 'auto1', askReason: 'policy', retriesUsed: 1 })

    // 返工抽必须带着审计否决原因（2026-09-29 用户拍板）：同一提示词盲抽是烧钱。
    const logs = await env.db.generationLog.findMany({ where: { taskId: seed.taskId, event: 'qc.reworkPrompt' } })
    expect(logs.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(logs[0]!.data)).toContain('below threshold')
  })

  it('auto-retries technical failures up to the default two, then asks', async () => {
    const seed = await env.seed({ connectionEnabled: false })
    await env.db.project.update({ where: { id: seed.projectId }, data: { maxRetriesPerShot: 3 } })
    const deps = env.deps({ qcMode: 'pass', pollIntervalMs: 10 })

    await runTask(env.runPayload(seed, 1), deps)
    const second = (await env.takeWaitingRunTasks())[0]!
    expect(second.attempt).toBe(2)
    await runTask(second, deps)
    const third = (await env.takeWaitingRunTasks())[0]!
    expect(third.attempt).toBe(3)
    await runTask(third, deps)

    // 技术档默认自动 2 次（attempt 2、3）；第 3 次仍失败才停下问。
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('FAILED')
    expect(task.attempts).toBe(3)
    const errors = JSON.parse(task.errorSnapshot!) as string[]
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('mock/mock-t2v')
    expect(errors[0]).toContain('unavailable')
    const review = JSON.parse(task.reviewSnapshot!) as { state: string; retryClass: string; askReason: string; kind: string }
    expect(review).toMatchObject({ state: 'pending', retryClass: 'technical', askReason: 'policy', kind: 'provider-exhausted' })
    expect(await env.db.mediaArtifact.count({ where: { taskId: seed.taskId } })).toBe(0)
    expect(await env.db.qualityCheck.count({ where: { artifact: { taskId: seed.taskId } } })).toBe(0)
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

  it('continues the artifact version across tasks for the same shot — a rerun mints v2, not a second v1', async () => {
    // 2026-09-28 事故回放：重跑开新任务，版本号曾按本任务计数从 v1 重新起跳，
    // 同一镜的版本胶片条上出现两个 v1。版本是给用户看的「第 N 版」，跨任务连续。
    const seed = await env.seed({ model: 'mock-image', modality: 'image', stage: 'FIRST_FRAME' })
    const shotId = seed.storyboardIds![0]!
    await env.db.generationTask.update({ where: { id: seed.taskId }, data: { storyboardId: shotId } })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    const first = await env.db.mediaArtifact.findFirstOrThrow({ where: { taskId: seed.taskId } })
    expect(first.version).toBe(1)

    const base = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    const rerun = await env.db.generationTask.create({
      data: {
        organizationId: base.organizationId,
        batchId: base.batchId,
        stage: base.stage,
        idempotencyKey: `${base.idempotencyKey}:rerun`,
        storyboardId: shotId,
        requestSnapshot: base.requestSnapshot,
        status: 'QUEUED',
      },
    })
    await runTask({ ...env.runPayload(seed), taskId: rerun.id }, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const second = await env.db.mediaArtifact.findFirstOrThrow({ where: { taskId: rerun.id } })
    expect(second.version).toBe(2)
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

  it('asks on a rejected artifact, and a continuity finding is classed as consistency', async () => {
    const seed = await env.seed()
    // 创作性给了自动额度也不该吞掉一致性问题：连续性优先归类，默认先问（Q3）。
    await env.db.project.update({ where: { id: seed.projectId }, data: { retryCreative: 'auto1' } })
    const rejecting: QualityChecker = {
      async check() {
        return {
          kind: 'visual-audit',
          decision: 'rework',
          score: 0.2,
          reasons: ['lead actor is missing from the shot'],
          findings: [{ dimension: 'continuity', severity: 'warning', message: 'lead actor is missing from the shot', evidenceTimeSeconds: 0.5 }],
        }
      },
    }
    const deps = modelDeps(rejecting)

    await runTask(env.runPayload(seed, 1), deps)

    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('FAILED')
    expect(task.attempts).toBe(1)
    const review = JSON.parse(task.reviewSnapshot!) as {
      state: string
      retryClass: string
      kind: string
      findings: Array<{ dimension: string }>
      artifactId: string | null
    }
    expect(review).toMatchObject({ state: 'pending', retryClass: 'consistency', kind: 'visual-audit' })
    expect(review.findings[0]).toMatchObject({ dimension: 'continuity' })

    const checks = await env.db.qualityCheck.findMany({ where: { artifact: { taskId: seed.taskId } } })
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ status: 'NEEDS_REVIEW', kind: 'visual-audit', score: 0.2 })
    expect(review.artifactId).toBe(checks[0]!.artifactId)
    expect(await env.db.usageLedger.count({ where: { taskId: seed.taskId } })).toBe(0)
  })

  // SD-098: an auditor that only ever sees the first frame scores a scripted fade-out as
  // the scene breaking apart, and the only remedy it offers is another paid take. The
  // shot's own script therefore has to reach the checker — from the task's storyboard.
  it('hands the checker what the shot asked to show, and nothing when no shot is behind the task', async () => {
    const seen: QcSubject[] = []
    const spy: QualityChecker = {
      async check(subject) {
        seen.push(subject)
        return { kind: 'visual-audit', decision: 'pass', score: 1 }
      },
    }

    const seed = await env.seed()
    const shot = seed.storyboardIds[0]!
    await env.db.storyboard.update({ where: { id: shot }, data: { description: '灯逐盏熄灭，一个弯腰的黑影拾起电缆', continuityOut: '林栖独自站在黑暗里' } })
    await env.db.generationTask.update({ where: { id: seed.taskId }, data: { storyboardId: shot } })
    await runTask(env.runPayload(seed), modelDeps(spy))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.shotIntent).toEqual({ description: '灯逐盏熄灭，一个弯腰的黑影拾起电缆', continuityOut: '林栖独自站在黑暗里' })

    // A queued task with no shot behind it gets no intent rather than a fabricated one,
    // and the audit prompt then keeps its old absolute continuity rule.
    const unbound = await env.seed()
    seen.length = 0
    await runTask(env.runPayload(unbound), modelDeps(spy))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.shotIntent).toBeUndefined()
  })

  it('stops on the episode budget even when the policy still allows an auto retry', async () => {
    const seed = await env.seed({ connectionEnabled: false })
    const shot = seed.storyboardIds[0]!
    // 1 镜 × 每镜上限 3 = 额度 3。另一条镜头任务已经用掉 2 次重抽，本任务只剩 1 次：
    // 首次失败自动重抽，第二次失败时额度见底——策略 auto2 还剩一次也不许再买。
    await env.db.project.update({ where: { id: seed.projectId }, data: { maxRetriesPerShot: 3 } })
    await env.db.generationTask.update({ where: { id: seed.taskId }, data: { storyboardId: shot } })
    await env.db.generationTask.create({
      data: { organizationId: seed.organizationId, batchId: seed.batchId, stage: 'VIDEO', status: 'SUCCEEDED', attempts: 3, storyboardId: shot },
    })
    const deps = env.deps({ qcMode: 'pass', pollIntervalMs: 10 })

    await runTask(env.runPayload(seed, 1), deps)
    const second = (await env.takeWaitingRunTasks())[0]!
    expect(second.attempt).toBe(2)
    await runTask(second, deps)

    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('FAILED')
    const review = JSON.parse(task.reviewSnapshot!) as { askReason: string; budgetUsed: number; budgetLimit: number; retryClass: string }
    expect(review).toMatchObject({ askReason: 'budget', budgetUsed: 3, budgetLimit: 3, retryClass: 'technical' })
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

  it('leaves a failed task stopped for a decision alone when a plain trigger collides', async () => {
    // 停在问询上的 FAILED 欠的不是一次自动重抽,而是人先回答抽不抽;普通触发若把
    // 它当失败复活,人还没看到问询面板,这一镜就又被买了一次。
    const seed = await env.seed({ storyboards: 2 })
    await approveScript(seed)
    await bindImageSlot(seed)
    const scene = await env.db.asset.create({ data: { episodeId: seed.episodeId, kind: 'scene', name: '青石巷', description: '夜色下的青石板路', status: 'APPROVED' } })
    for (const storyboardId of seed.storyboardIds as string[]) {
      await env.db.storyboardAsset.create({ data: { storyboardId, assetId: scene.id, role: 'scene' } })
    }
    const first = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE')
    expect(first.ok).toBe(true)
    const queued = await env.takeWaitingRunTasks()
    expect(queued).toHaveLength(2)

    const reviewSnapshot = JSON.stringify({
      state: 'pending',
      retryClass: 'creative',
      kind: 'visual-audit',
      reasons: [],
      findings: [{ dimension: 'aesthetic', message: '招牌上的英文清晰可辨' }],
      score: 0.42,
      attempt: 2,
      cap: 3,
      retriesUsed: 1,
      budgetLimit: 6,
      budgetUsed: 1,
      policy: 'ask',
      autoRetries: 0,
      askReason: 'policy',
      candidates: queued[0]!.candidates,
      artifactId: null,
      error: 'below threshold',
      createdAt: new Date().toISOString(),
    })
    const tasks = await env.db.generationTask.findMany({ where: { batchId: (first as { batchId: string }).batchId } })
    for (const task of tasks) {
      await env.db.generationTask.update({
        where: { id: task.id },
        data: { status: 'FAILED', attempts: 2, provider: 'mock', model: 'mock-image', errorSnapshot: 'below threshold', reviewSnapshot },
      })
    }

    const again = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE')
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.created).toBe(false)

    const stored = await env.db.generationTask.findMany({ where: { batchId: (first as { batchId: string }).batchId } })
    expect(stored.every(task => task.status === 'FAILED' && task.attempts === 2 && task.reviewSnapshot === reviewSnapshot)).toBe(true)
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
  })
})

/**
 * UX-P01（2026-10-19 实测 UX-04 根因二）：显式重试的提交身份。撞键重试把 FAILED
 * 任务按 attempt 1 重新入队，而上一轮真实烧过的 SubmissionAttempt 台账还占着
 * (taskId, 1, slot)——旧候选的失败检查点被套到新候选头上，改绑后的模型整排被
 * 「previous candidate already failed」跳过。重试必须按既有契约换基到新 attempt
 * （任务行 attempt 递增、新 jobId、新台账空间）；submission_unknown 的停止续烧与
 * 查单保护不得放松。
 */
describe('explicit retry identity (UX-P01)', () => {
  /** 把一个已验证的 mock 文本模型绑到分镜槽位，优先级决定它在候选链里的顺位。 */
  async function bindStoryboardModel(seed: Seed, model: string, priority: number): Promise<RunTaskCandidate> {
    const connection = await env.db.providerConnection.create({
      data: {
        organizationId: seed.organizationId,
        provider: 'mock',
        name: `storyboard-${model}-${randomUUID().slice(0, 8)}`,
        baseUrl: 'mock://local',
        encryptedSecret: encryptSecret('storyboard-key', MASTER_KEY),
        capabilities: { create: [{ model, modality: 'text', entitlementVerifiedAt: new Date() }] },
      },
    })
    const capability = await env.db.modelCapability.findFirstOrThrow({ where: { connectionId: connection.id } })
    await env.db.capabilityBinding.create({
      data: { organizationId: seed.organizationId, slot: 'STORYBOARD_TEXT', capabilityId: capability.id, priority },
    })
    return { connectionId: connection.id, capabilityId: capability.id, provider: 'mock', model }
  }

  it('runs the rebound model on a fresh attempt instead of tripping over the old settled ledger', async () => {
    // 复刻现场：分镜槽位绑上 mock-script（文本类模型），真实烧一次——mock 按模型名
    // 回剧本文本，分镜解析失败，留下 settled/content_rejected 台账。
    const seed = await env.seed({ model: 'mock-script', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    await approveScript(seed)
    await bindStoryboardModel(seed, 'mock-script', 10)
    const first = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'STORYBOARD')
    expect(first.ok).toBe(true)
    const [firstJob] = await env.takeWaitingRunTasks()
    expect(firstJob!.candidates.map(candidate => candidate.model)).toEqual(['mock-script'])
    await runTask(firstJob!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const failed = await env.db.generationTask.findUniqueOrThrow({ where: { id: firstJob!.taskId } })
    expect(failed.status).toBe('FAILED')
    expect(await env.db.storyboard.count({ where: { episodeId: seed.episodeId } })).toBe(0)
    // 本案钉的是「失败任务撞键重排」的提交身份,不是 Q3 的先问闸门:摘掉问询快照,
    // 还原成已裁决 / 迁移前的普通失败,让重排路径照旧可测(先问另有用例守着)。
    await env.db.generationTask.update({ where: { id: firstJob!.taskId }, data: { reviewSnapshot: null } })
    const deadLedger = await env.db.submissionAttempt.findUniqueOrThrow({
      where: { taskId_attemptNumber_slot: { taskId: firstJob!.taskId, attemptNumber: 1, slot: 0 } },
    })
    expect(deadLedger.status).toBe('settled')
    expect(deadLedger.resolution).toBe('content_rejected')

    // 人工改绑：mock-storyboard 优先级更高，重试的候选链里它排第一。
    await bindStoryboardModel(seed, 'mock-storyboard', 20)
    const second = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'STORYBOARD')
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.created).toBe(false)
    const [retryJob] = await env.takeWaitingRunTasks()
    expect(retryJob!.attempt).toBe(1)
    expect(retryJob!.candidates.map(candidate => candidate.model)).toEqual(['mock-storyboard', 'mock-script'])

    // 修复点：这封 attempt 1 投递不再被旧台账拦死，而是换基到全新 attempt 2
    // （新 jobId、新台账空间）让当前绑定真正执行。
    await runTask(retryJob!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    const [rebased] = await env.takeWaitingRunTasks()
    expect(rebased).toBeDefined()
    expect(rebased!.attempt).toBe(2)
    expect(rebased!.taskId).toBe(retryJob!.taskId)
    expect(rebased!.candidates).toEqual(retryJob!.candidates)
    await expect(env.db.jobOutbox.findUniqueOrThrow({ where: { id: `intent-run-${retryJob!.taskId}-2` } })).resolves.toBeTruthy()

    await runTask(rebased!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    const succeeded = await env.db.generationTask.findUniqueOrThrow({ where: { id: retryJob!.taskId } })
    expect(succeeded.status).toBe('SUCCEEDED')
    expect(succeeded.model).toBe('mock-storyboard')
    expect(succeeded.attempts).toBe(2)

    // 旧失败提交原样留证（审计链不动），新 attempt 在自己的空间里落定成功。
    const preserved = await env.db.submissionAttempt.findUniqueOrThrow({
      where: { taskId_attemptNumber_slot: { taskId: retryJob!.taskId, attemptNumber: 1, slot: 0 } },
    })
    expect(preserved.resolution).toBe('content_rejected')
    expect(preserved.model).toBe('mock-script')
    const fresh = await env.db.submissionAttempt.findUniqueOrThrow({
      where: { taskId_attemptNumber_slot: { taskId: retryJob!.taskId, attemptNumber: 2, slot: 0 } },
    })
    expect(fresh.model).toBe('mock-storyboard')
    expect(fresh.resolution).toBe('succeeded')

    const boards = await env.db.storyboard.findMany({ where: { episodeId: seed.episodeId } })
    expect(boards).toHaveLength(MOCK_STORYBOARD.shots.length)
  })

  it('a stale redelivery of the same attempt still skips the settled candidate instead of re-billing it', async () => {
    // 崩溃重放语义保持不变：投递的 attempt 与任务行相等（没有重试重置的落差）时，
    // 已终局失败的槽位让位下一候选，绝不重新提交、绝不换基。
    const seed = await env.seed({ model: 'mock-script', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    const mockStoryboard = await bindStoryboardModel(seed, 'mock-storyboard', 20)
    const dead = await env.db.submissionAttempt.create({
      data: {
        taskId: seed.taskId,
        attemptNumber: 1,
        slot: 0,
        status: 'settled',
        resolution: 'failed',
        provider: 'mock',
        model: 'mock-script',
        connectionId: seed.connectionId,
        capabilityId: seed.capabilityId,
        promptChars: 40,
      },
    })
    await env.db.generationTask.update({ where: { id: seed.taskId }, data: { status: 'QUEUED', attempts: 1 } })

    await runTask(
      { kind: 'run-task', taskId: seed.taskId, organizationId: seed.organizationId, attempt: 1, candidates: [seed.candidates[0]!, mockStoryboard] },
      env.deps({ qcMode: 'pass', pollIntervalMs: 10 }),
    )

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')
    expect(task.model).toBe('mock-storyboard')
    // 槽位 0 的旧失败行原样只有一条（没被重提、没被换基），槽位 1 是新提交。
    expect(await env.db.submissionAttempt.count({ where: { taskId: seed.taskId, attemptNumber: 1, slot: 0 } })).toBe(1)
    const slotOne = await env.db.submissionAttempt.findUniqueOrThrow({
      where: { taskId_attemptNumber_slot: { taskId: seed.taskId, attemptNumber: 1, slot: 1 } },
    })
    expect(slotOne.model).toBe('mock-storyboard')
    expect(await env.db.submissionAttempt.count({ where: { taskId: seed.taskId } })).toBe(2)
    expect(dead.resolution).toBe('failed')
  })

  it('a submission_unknown ledger stays fail-closed through the retry path — no re-submit, no rebase', async () => {
    // 未知提交是安全边界：上游可能已接单。显式重试落到这种任务上，也必须被
    // 台账唯一键挡回 BLOCKED「人工查单」，绝不自动换基、绝不再提交。
    const seed = await env.seed({ model: 'mock-storyboard', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    await approveScript(seed)
    await env.db.generationTask.update({
      where: { id: seed.taskId },
      data: { idempotencyKey: `${seed.episodeId}:STORYBOARD:${seed.episodeId}`, status: 'BLOCKED', attempts: 1, errorSnapshot: 'submission unknown — manual verification required' },
    })
    await env.db.submissionAttempt.create({
      data: {
        taskId: seed.taskId,
        attemptNumber: 1,
        slot: 0,
        status: 'submission_unknown',
        errorSnapshot: 'socket hang up',
        provider: 'mock',
        model: 'mock-storyboard',
        connectionId: seed.connectionId,
        capabilityId: seed.capabilityId,
        promptChars: 40,
      },
    })
    await bindStoryboardModel(seed, 'mock-storyboard', 20)

    // 撞键重试会把 BLOCKED 一并复活重排（triggerStage 的 retryable 语义）。
    const retry = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'STORYBOARD')
    expect(retry.ok).toBe(true)
    const [retryJob] = await env.takeWaitingRunTasks()
    expect(retryJob).toBeDefined()

    await runTask(retryJob!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('BLOCKED')
    expect(task.errorSnapshot).toContain('refusing to re-submit')
    // 台账没有第二行，也没有任何新投递——查单人工裁决是唯一出口。
    expect(await env.db.submissionAttempt.count({ where: { taskId: seed.taskId } })).toBe(1)
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
  })

  it('an unknown submission the provider actually rejected (预扣费额度失败) unblocks the retry instead of occupying the slot forever', async () => {
    // 2026-10-23 实测：第 1 集 16 个镜头全部 BLOCKED，每次点「生成视频片段」都撞回
    // 「submission ledger slot (1/0) is already occupied」。台账里那行 submission_unknown
    // 是火山同步回的「预扣费额度失败」——没接单、没扣钱，本该按 settled failed 让位，
    // 却被当年的分类器当成含糊失败永久占槽，而 BLOCKED 任务没有审核快照，问询重抽
    // /豁免端点够不到它。这条钉住：明确的「没接单」报文不锁死重抽路。
    const seed = await env.seed({ model: 'mock-storyboard', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    await approveScript(seed)
    await env.db.generationTask.update({
      where: { id: seed.taskId },
      data: { idempotencyKey: `${seed.episodeId}:STORYBOARD:${seed.episodeId}`, status: 'BLOCKED', attempts: 1, errorSnapshot: 'submission unknown — manual verification required' },
    })
    await env.db.submissionAttempt.create({
      data: {
        taskId: seed.taskId,
        attemptNumber: 1,
        slot: 0,
        status: 'submission_unknown',
        errorSnapshot: 'insufficient_user_quota | 预扣费额度失败, 用户剩余额度: 灵感2.180000, 需要预扣费额度: 灵感2.300000',
        provider: 'mock',
        model: 'mock-script',
        connectionId: seed.connectionId,
        capabilityId: seed.capabilityId,
        promptChars: 40,
      },
    })
    await bindStoryboardModel(seed, 'mock-storyboard', 20)

    const retry = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'STORYBOARD')
    expect(retry.ok).toBe(true)
    const [retryJob] = await env.takeWaitingRunTasks()
    expect(retryJob).toBeDefined()

    await runTask(retryJob!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    const [rebased] = await env.takeWaitingRunTasks()
    expect(rebased?.attempt).toBe(2)
    await runTask(rebased!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')
    // 旧那行未知提交原样留证（谁占过槽、供应商当时答了什么），新提交落在自己的 attempt 空间。
    const preserved = await env.db.submissionAttempt.findUniqueOrThrow({
      where: { taskId_attemptNumber_slot: { taskId: seed.taskId, attemptNumber: 1, slot: 0 } },
    })
    expect(preserved.status).toBe('submission_unknown')
    const fresh = await env.db.submissionAttempt.findUniqueOrThrow({
      where: { taskId_attemptNumber_slot: { taskId: seed.taskId, attemptNumber: 2, slot: 0 } },
    })
    expect(fresh.resolution).toBe('succeeded')
    expect(await env.db.storyboard.count({ where: { episodeId: seed.episodeId } })).toBe(MOCK_STORYBOARD.shots.length)
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
    await bindImageSlot(seed, 'mock-image-edit', { acceptsReferenceImages: true, maxReferenceImages: 3 })
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
    expect(logs[0]!.message).toContain('mock-image-edit')
    const response = JSON.parse(succeeded.responseSnapshot!) as { reference?: { conditioned: boolean }[] }
    expect(response.reference).toEqual([{ model: 'mock-image-edit', conditioned: true }])
  })

  it('orders image candidates by the task: sheets take plain t2i first, referenced frames take the edit model first', async () => {
    // 定妆照(纯文字出图)用编辑模型裸跑,质感明显弱于文生图模型——路由按任务形态分:
    // 有参考图的首帧 → 编辑模型优先;纯文字出图的定妆照 → 纯文生图优先,编辑模型垫底。
    const seed = await env.seed({ storyboards: 1, asset: { kind: 'character', name: '小满', description: '十六岁少女' } })
    await approveScript(seed)
    await bindImageSlot(seed, 'mock-image-edit', { acceptsReferenceImages: true, maxReferenceImages: 3 })
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
    expect(assetJobs[0]!.candidates[1]!.model).toBe('mock-image-edit')

    // 首帧任务(带定妆照参考):编辑模型先上。
    const frameRun = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE', { storyboardIds: [shot], regenerate: true })
    expect(frameRun.ok).toBe(true)
    const frameJobs = await env.takeWaitingRunTasks()
    expect(frameJobs).toHaveLength(1)
    expect(frameJobs[0]!.candidates[0]!.model).toBe('mock-image-edit')
    expect(frameJobs[0]!.candidates[1]!.model).toBe('mock-t2i')
  })

  it('blocks a referenced shot when no model on the slot takes reference images, and revives it after one is bound', async () => {
    // 定妆照是首帧唯一的长相锚点。候选链里一个都不吃参考图时,过去会静默降级成纯文生图:
    // 钱照烧、视觉 QC 照样通过,买回一张陌生的脸(2026-10-21 SD-066 实测)。现在在计划层拦下。
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
    expect(task.status).toBe('BLOCKED')
    expect(task.errorSnapshot).toContain('参考图模型缺失')
    expect(task.errorSnapshot).toContain('mock-image')
    // 拦下就是拦下:不入队、不预留调用、不产出帧。
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
    expect(await env.db.mediaArtifact.count({ where: { task: { is: { storyboardId: shot } } } })).toBe(0)

    // 补一个吃参考图的模型到同一槽位——同一条 BLOCKED 复活路径(与场景主帧等待共用),重触发即排。
    await bindImageSlot(seed, 'mock-image-edit', { acceptsReferenceImages: true, maxReferenceImages: 3 })
    const retried = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE')
    expect(retried.ok).toBe(true)
    const revived = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(revived.status).toBe('QUEUED')
    expect(JSON.parse(revived.requestSnapshot!)).toMatchObject({ referenceArtifacts: [{ type: 'reference_image', artifactId: sheet.artifactId }] })

    const [payload] = await env.takeWaitingRunTasks()
    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    await runTask(payload!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const calls = submitted.mock.calls.filter(([capability]) => capability.modality === 'image')
    expect(calls).toHaveLength(1)
    expect(calls[0]![0].model).toBe('mock-image-edit')
    const media = calls[0]![1].input.media as { type: string }[]
    expect(media).toHaveLength(1)
    expect(media[0]!.type).toBe('reference_image')
    const succeeded = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(succeeded.status).toBe('SUCCEEDED')
    const response = JSON.parse(succeeded.responseSnapshot!) as { reference?: { model: string; conditioned: boolean }[] }
    expect(response.reference).toEqual([{ model: 'mock-image-edit', conditioned: true }])
  })
})

describe('compose-episode', () => {
  const pipelineStore = () => ({ db: env.db, enqueueJob: async () => {} })

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

  it('leaves the master ledger that the acceptance readings are measured from', async () => {
    // S5 的门判的是「这条母带自己记下了哪些数」，所以 worker 侧的契约是台账不是读数：
    // Composition.durationMs 是 ffprobe 探到的文件长度，cuts/audio 是渲染真吃下的那份，
    // resolved.shots 是排队时定格的台词与转场。这里用审片门同一个函数读这份真台账——
    // 门不许只靠测试夹具里的假快照撑着。
    const seed = await env.seed({ storyboards: 2 })
    const [first, second] = seed.storyboardIds as [string, string]
    await env.attachSucceededVideo(seed, first, 1, { durationMs: 1_000 })
    await env.attachSucceededVideo(seed, second, 1, { durationMs: 1_000 })
    // 台词挂第二镜并配一条人声件：有台词没配音的镜正是 SD-181 那类静音，
    // 拿它测「三项齐全」就等于把门最该拦的情形漏在测不到的地方。
    await env.db.storyboard.update({ where: { id: second }, data: { dialogue: '第二镜的台词' } })
    await env.attachSucceededMedia(seed, { stage: 'AUDIO', modality: 'tts', storyboardId: second, durationMs: 1_000 })

    const compositionId = await createComposition(pipelineStore(), seed.organizationId, seed.episodeId, seed.storyboardIds)
    await composeEpisode(env.composePayload(compositionId, seed), env.deps())
    const composition = await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })
    expect(composition.status).toBe('COMPLETED')
    expect(composition.durationMs).not.toBeNull()
    expect(composition.durationMs!).toBeGreaterThan(0)

    const manifest = JSON.parse(composition.manifest) as {
      cuts?: { clipMs?: number[]; kindAt?: string[]; blended: boolean; storyboardIds: string[] }
      audio?: Record<string, { mode: string; voiceArtifactId: string | null }>
    }
    expect(manifest.cuts!.storyboardIds).toEqual([first, second])
    // 一刀不使的整集也记全表：片头恒为 cut，没有这一行节奏读数就没有分母。
    expect(manifest.cuts!.kindAt).toEqual(['cut', 'cut'])
    expect(manifest.cuts!.clipMs).toEqual([1_000, 1_000])
    expect(manifest.cuts!.blended).toBe(false)
    // 声音台账按 storyboardId 记账，一镜不落——缺格就是「这镜在成片里听到什么」读不出来。
    expect(Object.keys(manifest.audio!).sort()).toEqual([first, second].sort())

    const review = readCompositionReview({ manifest: composition.manifest, masterDurationMs: composition.durationMs })
    expect(review.complete).toBe(true)
    expect(review.rhythm.masterDurationMs).toBe(composition.durationMs)
    // 节奏的分母是探到的母带长度，不是逐镜跨度求和：一重叠两者就分家（SD-182）。
    expect(review.rhythm.readings!.totalMs).toBe(composition.durationMs)
    // 碎不等于错：2 镜各 1 秒远低项目节奏门槛，但三项读数齐全，门照样放行。
    expect(review.rhythm.gate.pass).toBe(false)
    expect(review.transition.blendedSeamCount).toBe(0)
    expect(review.transition.requestedNonCutCount).toBe(0)
    expect(review.sound.dialogueShotCount).toBe(1)
    expect(review.sound.silentDialogueShots).toEqual([])
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
    // 「烧不了」在这里是明确要求的交付方式,不是本机碰巧没有 libass。不写死的话,
    // .env 把 ffmpeg 指到带 libass 的构建,这条就会改成硬烧、断言随之落空。
    process.env.STUDIO_SUBTITLE_MODE = 'soft'
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
    // 本机 ffmpeg 有没有烧录滤镜不由这条用例决定:交付方式上面已定死为软轨,
    // 所以成片里必然带一条独立字幕流。
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
    // 无声镜头现在会被垫一条等长静音轨（SD-114：concat demuxer 用第一段的流布局当整条
    // 母带的布局，一个无声头会把后面每个镜头的原声一起静默丢掉）。所以母带恒有音轨，
    // 「听不见」这件事由 packages/media 的频段响度实测钉住，不靠「没有音轨」这个形状。
    expect(streamTypes(await env.storage.read(master.objectKey))).toEqual(['video', 'audio'])
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
    // 同上:软字幕轨是有台词就要有的交付物,与宿主能不能硬烧无关。
    process.env.STUDIO_SUBTITLE_MODE = 'soft'
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
    // 台词有、配音没落地：字幕轨照给，音轨是母带自带的静音垫（见上一条的 SD-114 注释）。
    expect(streamTypes(await env.storage.read(master.objectKey))).toEqual(['video', 'audio', 'subtitle'])
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

    // 同一场戏几镜共用一条街声:母带清单里它必须是一条连续声床(带 storyboardIds),
    // 而不是逐镜各一条——逐镜那条会让每一刀都听见「这条街从头响」。换底的那一刀则要
    // 看到音频桥:新底提前 400ms 进、旧底拖 200ms 出,否则剪点中台声场瞬断。
    // 三镜按真实界面走:导入是一镜一上传,前两镜传的是同一个文件(两个制品、同一串字节)。
    it('runs one shared bed straight through the shots that use it', async () => {
      const seed = await env.seed({ storyboards: 3 })
      const [first, second, third] = seed.storyboardIds as [string, string, string]
      for (const shot of [first, second, third]) await env.attachSucceededVideo(seed, shot, 1, { durationMs: 1000 })
      const streetOnFirst = await importedBed(seed, first, 1)
      const streetOnSecond = await importedBed(seed, second, 1)
      const room = await importedBed(seed, third, 2)
      await env.db.storyboard.update({ where: { id: first }, data: { importedAmbienceArtifactId: streetOnFirst } })
      await env.db.storyboard.update({ where: { id: second }, data: { importedAmbienceArtifactId: streetOnSecond } })
      await env.db.storyboard.update({ where: { id: third }, data: { importedAmbienceArtifactId: room } })

      const composition = await env.db.composition.create({
        data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: seed.storyboardIds }) },
      })
      await composeEpisode(env.composePayload(composition.id, seed), env.deps())

      const updated = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
      expect(updated.status).toBe('COMPLETED')
      const beds = (JSON.parse(updated.manifest) as { beds?: unknown[] }).beds ?? []
      expect(beds).toHaveLength(2)
      expect(beds[0]).toMatchObject({
        imported: true, ambienceArtifactId: streetOnFirst, storyboardIds: [first, second], fadeInMs: 0, fadeOutMs: AUDIO_BRIDGE_TAIL_MS,
      })
      expect(beds[1]).toMatchObject({
        imported: true, ambienceArtifactId: room, storyboardIds: [third], fadeInMs: AUDIO_BRIDGE_PRE_MS, fadeOutMs: 0,
      })
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

  it('拒收空描述或有场次缺口的分镜，且一个镜头都不写', async () => {
    const seed = await seedStoryboard()
    await expect(
      recordGeneratedContent(env.db, contentTask(seed), JSON.stringify({
        shots: [
          { title: 'A', description: '（全景·平视）屋内', scene: 1 },
          { title: 'B', description: '   ', scene: 3 },
        ],
      })),
    ).rejects.toThrow('storyboard content rejected')
    expect(await env.db.storyboard.count({ where: { episodeId: seed.episodeId } })).toBe(0)
  })

  // 2026-10-20 线上实测：63 行分镜表里模型只把第 53 行 2s 抄成 3s，整批付费结果被
  // 契约审计作废。表内时长是作者拍板的确定性数据，行数对得上时以表为准落库。
  const contractScript = [
    '场景 1：雨夜老城区',
    '',
    '| # | 时长 | 画面 | 台词 | 生成 |',
    '| --- | --- | --- | --- | --- |',
    '| 1 | 2s | 雨夜街道 | | |',
    '| 2 | 3s | 半张照片 | | 字幕：第七次死亡 |',
    '| 3 | 2s | 陈默回头 | 陈默：谁？ | |',
  ].join('\n')

  async function contractTask(seed: Seed) {
    const script = await env.db.scriptVersion.create({
      data: { episodeId: seed.episodeId, version: 1, content: contractScript, checksum: `contract-${randomUUID()}`, status: 'APPROVED' },
    })
    const taskId = await nextTask(seed)
    const requestSnapshot = JSON.stringify({ model: 'mock-storyboard', input: {}, parameters: {}, scriptVersionId: script.id })
    await env.db.generationTask.update({ where: { id: taskId }, data: { requestSnapshot } })
    return { id: taskId, stage: 'STORYBOARD', requestSnapshot, batch: { episodeId: seed.episodeId } }
  }

  it('以剧本分镜表的时长落库，不让模型转录的误差作废整批结果', async () => {
    const seed = await seedStoryboard()
    await recordGeneratedContent(env.db, await contractTask(seed), JSON.stringify({
      shots: [
        { title: '雨夜街道', description: '雨夜街道，霓虹映在积水里', durationMs: 2000, continuityOut: '积水里霓虹的倒影' },
        { title: '半张照片', description: '半张照片漂在积水上，浮出“第七次死亡”', durationMs: 3000, continuityIn: '积水里霓虹的倒影', continuityOut: '照片背面朝上' },
        // 模型把第 3 行 2s 抄成 3s——落库应回到表里的 2s。
        { title: '陈默回头', description: '陈默回头', dialogue: '谁？', speaker: '陈默', durationMs: 3000, continuityIn: '照片背面朝上' },
      ],
    }))

    const boards = await env.db.storyboard.findMany({ where: { episodeId: seed.episodeId }, orderBy: { number: 'asc' } })
    expect(boards.map(board => board.durationMs)).toEqual([2000, 3000, 2000])
    expect(boards.reduce((sum, board) => sum + board.durationMs, 0)).toBe(7000)
  })

  it('镜数与分镜表不一致时仍拒收，一个镜头都不写', async () => {
    const seed = await seedStoryboard()
    await expect(recordGeneratedContent(env.db, await contractTask(seed), JSON.stringify({
      shots: [
        { title: '雨夜街道', description: '雨夜街道，霓虹映在积水里', durationMs: 2000 },
        { title: '半张照片', description: '半张照片漂在积水上，浮出“第七次死亡”', durationMs: 3000 },
      ],
    }))).rejects.toThrow('storyboard:contractShotCount')
    expect(await env.db.storyboard.count({ where: { episodeId: seed.episodeId } })).toBe(0)
  })

  it('still accepts a bare shot array, which carries no assets', async () => {
    const seed = await seedStoryboard()
    await recordGeneratedContent(env.db, contentTask(seed), '```json\n[{"title":"Rainy street","description":"neon","durationMs":5000,"continuityOut":"neon on wet asphalt"},{"description":"no title given","durationMs":5000,"continuityIn":"neon on wet asphalt"}]\n```')

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

  it('拒收没有场景标记的剧本——分镜按场景切块，缺了它长剧本会退化成一次整篇请求', async () => {
    const seed = await env.seed({ model: 'mock-script', modality: 'text', stage: 'SCRIPT', storyboards: 0 })
    await expect(recordGeneratedContent(env.db, scriptTask(seed), '许知意推开门，风灌进来。\n她没说第二句话。'))
      .rejects.toThrow('script:noSceneMarker')
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

  it('stops auto-advance before money stages — ASSET waits for a human trigger', async () => {
    // 2026-09-29 政策翻转（用户实测「只点了重新分镜，13 个首帧自己排上队」）：
    // 自动推进只接力文字阶段；ASSET/首帧/视频/配音/配乐都是花钱大户，下一步由人按。
    const seed = await env.seed({ model: 'mock-storyboard', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    await env.db.scriptVersion.create({ data: { episodeId: seed.episodeId, version: 1, content: 'the approved script', checksum: 'advance-script', status: 'APPROVED' } })
    await bindImageGen(seed)

    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')
    const boards = await env.db.storyboard.findMany({ where: { episodeId: seed.episodeId } })
    expect(boards).toHaveLength(MOCK_STORYBOARD.shots.length)
    const assets = await env.db.asset.findMany({ where: { episodeId: seed.episodeId } })
    expect(assets).toHaveLength(MOCK_STORYBOARD.assets.length)

    // 分镜照写、素材照提；但 ASSET 批不自动排——一分钱不动，等按钮。
    expect(await env.db.generationBatch.count({ where: { episodeId: seed.episodeId, stage: 'ASSET' } })).toBe(0)
    expect(await env.db.generationBatch.count({ where: { episodeId: seed.episodeId, stage: 'FIRST_FRAME' } })).toBe(0)
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
    expect(await env.db.auditEvent.count({ where: { organizationId: seed.organizationId, action: 'pipeline.autoAdvance' } })).toBe(0)

    // 人按下推进（非 auto）后接力照常：ASSET 批正常排队。
    const manual = await advancePipeline({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId)
    expect(manual.ok).toBe(true)
    const assetBatch = await env.db.generationBatch.findFirstOrThrow({ where: { episodeId: seed.episodeId, stage: 'ASSET' } })
    expect(assetBatch.plannedCount).toBe(assets.length)
    const queued = await env.takeWaitingRunTasks()
    expect(queued).toHaveLength(assets.length)
    expect(queued.every(payload => payload.candidates[0]?.model === 'mock-image')).toBe(true)
  })

  it('auto 档越过花钱阶段自己跑下去——同一起手，差别只在档位', async () => {
    // 与上一条完全相同的起手（分镜跑完、剧本已批、素材已提，ASSET 是下一个可跑阶段），
    // 只把项目的 automationGate 设成 auto：默认档停下来等人的那一步，这一档自己排上队。
    // 两条测试并排放在一起，就是「档位只改了停/走，没改别的」的证明。
    const seed = await env.seed({ model: 'mock-storyboard', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    await env.db.scriptVersion.create({ data: { episodeId: seed.episodeId, version: 1, content: 'the approved script', checksum: 'advance-auto-script', status: 'APPROVED' } })
    await bindImageGen(seed)
    await env.db.project.updateMany({ where: { organizationId: seed.organizationId }, data: { automationGate: 'auto' } })

    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const assets = await env.db.asset.findMany({ where: { episodeId: seed.episodeId } })
    const assetBatch = await env.db.generationBatch.findFirstOrThrow({ where: { episodeId: seed.episodeId, stage: 'ASSET' } })
    expect(assetBatch.plannedCount).toBe(assets.length)
    const queued = await env.takeWaitingRunTasks()
    expect(queued).toHaveLength(assets.length)
    expect(queued.every(payload => payload.candidates[0]?.model === 'mock-image')).toBe(true)

    // 再往下仍然会停在素材定稿：首帧按素材外观生成，素材还在草稿就该停在这里让人定稿。
    // 这一条与档位无关，是 nextRunnableStage 的结构保证——auto 不是无护栏的。
    expect(await env.db.generationBatch.count({ where: { episodeId: seed.episodeId, stage: 'FIRST_FRAME' } })).toBe(0)
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

describe('sfx (the silent half of AUDIO)', () => {
  it('plans one sfx task per dialogue-free shot, billed against the sfx slot', async () => {
    const seed = await env.seed({ storyboards: 2 })
    const [voicedShot, silentShot] = seed.storyboardIds as [string, string]
    await env.db.storyboard.update({ where: { id: voicedShot }, data: { dialogue: '借过。', speaker: '路人' } })
    await approveScript(seed)
    const tts = await bindVideoSlot(seed, 'TTS_VOICE', 'mock-tts')
    const sfx = await bindVideoSlot(seed, 'SFX', 'mock-sfx')

    const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'AUDIO')
    if (!result.ok) throw new Error(`AUDIO refused: ${result.error}`)
    const tasks = await env.db.generationTask.findMany({ where: { batchId: result.batchId } })
    // 台词镜只排配音,无台词镜只排音效——两侧互不越界。
    expect(tasks).toHaveLength(2)
    const voiceTask = tasks.find(task => task.storyboardId === voicedShot)!
    const sfxTask = tasks.find(task => task.storyboardId === silentShot)!
    expect(JSON.parse(voiceTask.requestSnapshot!).input.prompt).toContain('借过')
    expect(JSON.parse(sfxTask.requestSnapshot!).input.prompt).toContain('环境/动作音效')

    const payloads = await env.takeWaitingRunTasks()
    const voicePayload = payloads.find(payload => payload.taskId === voiceTask.id)!
    const sfxPayload = payloads.find(payload => payload.taskId === sfxTask.id)!
    expect(voicePayload.candidates).toEqual([tts])
    expect(sfxPayload.candidates).toEqual([sfx])

    await runTask(sfxPayload, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    const artifact = await env.db.mediaArtifact.findFirstOrThrow({ where: { taskId: sfxTask.id } })
    expect(artifact.mimeType).toBe('audio/wav')
    expect((await env.db.generationTask.findUniqueOrThrow({ where: { id: sfxTask.id } })).status).toBe('SUCCEEDED')
  })

  it('keeps a fully silent episode plannable once the sfx slot is bound', async () => {
    const seed = await env.seed({ storyboards: 1 })
    await approveScript(seed)
    await bindVideoSlot(seed, 'TTS_VOICE', 'mock-tts')
    // 未绑 sfx 时:全静音集维持旧口径,400。
    const refused = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'AUDIO')
    expect(refused.ok).toBe(false)
    expect((refused as { error: string }).error).toContain('no shots with dialogue')
    // 绑上 sfx:同样的集子可以排了——音效就是它的声音。
    await bindVideoSlot(seed, 'SFX', 'mock-sfx')
    const ok = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'AUDIO')
    expect(ok.ok).toBe(true)
    expect(await env.db.generationTask.count({ where: { batchId: (ok as { batchId: string }).batchId } })).toBe(1)
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
    // and promptGuards records what was touched. The parameters carry the shot's own
    // planned length under the platform's name — no vendor's spelling belongs in a snapshot
    // that any candidate in the slot may run.
    const planned = await env.db.storyboard.findUniqueOrThrow({ where: { id: shot }, select: { durationMs: true } })
    expect(JSON.parse(task.requestSnapshot!)).toEqual({
      input: { prompt: `Shot 1: a rainy night market\n\n${TEXT_LANGUAGE_RULE_ZH}\n\n${MOTION_RULE_ZH}\n\n${VISUAL_STYLE_DIRECTIVE}` },
      parameters: { seed: generationSeed(task.idempotencyKey!), durationSeconds: Math.round(planned.durationMs / 1000) },
      promptGuards: [{ guard: 'style-anchor', action: 'repair', note: expect.any(String) }],
    })

    const queued = await env.takeWaitingRunTasks()
    expect(queued.map(payload => payload.taskId)).toEqual([task.id])
    expect(queued[0]!.candidates).toEqual([t2v])
  })

  it('anchors a later shot\'s first frame to its scene master, and blocks it until the master exists', async () => {
    // r06·A（用户拍板）：场内非首镜的首帧挂本场主帧（=场首镜的钦定/最新可用帧）作
    // 第 1 参考图；主帧未就绪时任务落 BLOCKED 等待——不烧钱，重试路径复活。
    const seed = await env.seed({ storyboards: 2 })
    const [first, second] = seed.storyboardIds as [string, string]
    await approveScript(seed)
    await env.db.storyboard.update({ where: { id: first }, data: { sceneNumber: 1 } })
    await env.db.storyboard.update({ where: { id: second }, data: { sceneNumber: 1 } })
    // 主帧本身就是参考图,槽位里必须有一个吃参考图的模型,否则 SD-066 的计划层闸门会先拦下。
    await bindImageSlot(seed, 'mock-image', { acceptsReferenceImages: true, maxReferenceImages: 3 })
    // 无素材守卫会先拦没绑素材的镜——各绑一个已定稿场景让守卫放行，专测主帧闸门。
    const scene = await env.db.asset.create({ data: { episodeId: seed.episodeId, kind: 'scene', name: '老城客厅', description: '九十年代客厅', status: 'APPROVED' } })
    for (const storyboardId of [first, second]) {
      await env.db.storyboardAsset.create({ data: { storyboardId, assetId: scene.id, role: 'scene' } })
    }

    // 主帧未就绪：第二镜 BLOCKED，第一镜照常排队。
    const noMaster = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE')
    if (!noMaster.ok) throw new Error(`IMAGE refused: ${noMaster.error}`)
    const tasks1 = await env.db.generationTask.findMany({ where: { batchId: noMaster.batchId } })
    expect(tasks1).toHaveLength(2)
    const blocked = tasks1.find(task => task.storyboardId === second)!
    expect(blocked.status).toBe('BLOCKED')
    expect(blocked.errorSnapshot).toContain('等待「场景 1」主帧')
    expect(tasks1.find(task => task.storyboardId === first)!.status).toBe('QUEUED')

    // 首镜落帧并钦定 → 重试第二镜：参考图第 1 张=主帧，提示词含「图1＝场景主帧」。
    const frame = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: first })
    await env.db.storyboard.update({ where: { id: first }, data: { selectedFrameArtifactId: frame.artifactId } })
    const retry = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'IMAGE', { storyboardIds: [second] })
    if (!retry.ok) throw new Error(`IMAGE retry refused: ${retry.error}`)
    // 幂等重试复用旧批次——按镜头取任务，别按批次乱抓。
    const task2 = await env.db.generationTask.findFirstOrThrow({ where: { storyboardId: second }, orderBy: { id: 'desc' } })
    expect(task2.status).toBe('QUEUED')
    const snapshot = JSON.parse(task2.requestSnapshot!) as { referenceArtifacts?: { artifactId: string }[]; input: { prompt: string } }
    expect(snapshot.referenceArtifacts?.[0]?.artifactId).toBe(frame.artifactId)
    expect(snapshot.input.prompt).toContain('图1＝场景主帧｜同一场景、换机位基准')
  })

  it('carries the previous shot\'s established space into the VIDEO prompt (spatial continuity)', async () => {
    // 2026-09-29 用户实测镜2：许知意在镜1坐在长桌边，镜2独立生成的首帧却不知她在哪。
    // 首帧/视频各自独立生成，空间事实必须由 continuityIn 文字锚进提示词。
    const seed = await env.seed()
    const [shot] = seed.storyboardIds as [string]
    await env.db.storyboard.update({
      where: { id: shot },
      data: { continuityIn: '许知意仍坐在长桌东侧，笔搁在协议上，赵桂芬从画面左侧门口进入' },
    })
    await approveScript(seed)
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')

    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })
    const prompt = (JSON.parse(task.requestSnapshot!) as { input: { prompt: string } }).input.prompt
    expect(prompt).toContain('空间连续（上一镜已确立，不得与之矛盾）：许知意仍坐在长桌东侧，笔搁在协议上，赵桂芬从画面左侧门口进入')
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
    const planned = await env.db.storyboard.findUniqueOrThrow({ where: { id: shot }, select: { durationMs: true } })
    expect(JSON.parse(task.requestSnapshot!)).toEqual({
      input: { prompt: `Shot 1: a rainy night market\n\n${TEXT_LANGUAGE_RULE_ZH}\n\n${MOTION_RULE_ZH}\n\n${VISUAL_STYLE_DIRECTIVE}` },
      parameters: { seed: generationSeed(task.idempotencyKey!), durationSeconds: Math.round(planned.durationMs / 1000) },
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

  it('routes a shot with approved sheets to the r2v model even without a frame (gate relaxed)', async () => {
    // video_r2v 接线：定妆照直达视频模型（可灵主体库同路）。缺帧镜头绑了 r2v 且带
    // 定妆照时不再被缺帧闸门拦下——定妆照就是它的主体锚。
    const seed = await env.seed({ storyboards: 1, asset: { kind: 'character', name: '关师傅', description: '纸扎铺老师傅' } })
    await approveScript(seed)
    const t2v = await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    await bindVideoSlot(seed, 'VIDEO_I2V', 'mock-i2v')
    const r2v = await bindVideoSlot(seed, 'VIDEO_R2V', 'mock-r2v')
    const [shot] = seed.storyboardIds as [string]
    await env.db.storyboard.update({ where: { id: shot }, data: { description: 'a rainy night market, 关师傅 stands at the door' } })
    const asset = await env.db.asset.findFirstOrThrow({ where: { episodeId: seed.episodeId } })
    await env.db.storyboardAsset.create({ data: { storyboardId: shot, assetId: asset.id, role: 'character' } })
    const sheet = await env.attachSucceededMedia(seed, { stage: 'ASSET', modality: 'image' })
    await env.db.assetVersion.create({ data: { assetId: asset.id, version: 1, description: '角色板', status: 'APPROVED', artifactId: sheet.artifactId } })
    await env.db.asset.update({ where: { id: asset.id }, data: { status: 'APPROVED' } })

    // i2v 已绑而这一镜没有首帧：旧闸门会 409；现在 r2v+定妆照在，放行。
    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })
    expect(JSON.parse(task.requestSnapshot!)).toMatchObject({
      referenceArtifacts: [{ type: 'reference_image', artifactId: sheet.artifactId }],
    })
    const [payload] = await env.takeWaitingRunTasks()
    // 无帧的 i2v 不进计划，r2v 领跑，t2v 垫底。
    expect(payload!.candidates).toEqual([r2v, t2v])

    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    await runTask(payload!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    const calls = submitted.mock.calls.filter(([capability]) => capability.modality === 'r2v')
    expect(calls).toHaveLength(1)
    expect((calls[0]![1].input.media as { type: string }[]).map(media => media.type)).toEqual(['reference_image'])
    const succeeded = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(succeeded.status).toBe('SUCCEEDED')
    expect(succeeded.model).toBe('mock-r2v')
  })

  it('keeps frame and sheets side by side in one snapshot (the merge bug), r2v first', async () => {
    // 首帧与定妆照同镜共存:两个分支各写各的 referenceArtifacts 键时,后写的会覆盖
    // 先写的——带帧又带参考图的任务丢数据。合并写入后两种类型并存,r2v 排最前。
    const seed = await env.seed({ storyboards: 1, asset: { kind: 'character', name: '关师傅', description: '纸扎铺老师傅' } })
    await approveScript(seed)
    const t2v = await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    const i2v = await bindVideoSlot(seed, 'VIDEO_I2V', 'mock-i2v')
    const r2v = await bindVideoSlot(seed, 'VIDEO_R2V', 'mock-r2v')
    const [shot] = seed.storyboardIds as [string]
    await env.db.storyboard.update({ where: { id: shot }, data: { description: 'a rainy night market, 关师傅 stands at the door' } })
    const asset = await env.db.asset.findFirstOrThrow({ where: { episodeId: seed.episodeId } })
    await env.db.storyboardAsset.create({ data: { storyboardId: shot, assetId: asset.id, role: 'character' } })
    const sheet = await env.attachSucceededMedia(seed, { stage: 'ASSET', modality: 'image' })
    await env.db.assetVersion.create({ data: { assetId: asset.id, version: 1, description: '角色板', status: 'APPROVED', artifactId: sheet.artifactId } })
    await env.db.asset.update({ where: { id: asset.id }, data: { status: 'APPROVED' } })
    const frame = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: shot })

    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })
    expect(JSON.parse(task.requestSnapshot!)).toMatchObject({
      referenceArtifacts: [
        { type: 'first_frame', artifactId: frame.artifactId },
        { type: 'reference_image', artifactId: sheet.artifactId },
      ],
    })
    const [payload] = await env.takeWaitingRunTasks()
    expect(payload!.candidates).toEqual([r2v, i2v, t2v])
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
    const [shot] = seed.storyboardIds as [string]
    await approveScript(seed)
    const t2v = await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')

    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })

    const planned = await env.db.storyboard.findUniqueOrThrow({ where: { id: shot }, select: { durationMs: true } })
    expect(JSON.parse(task.requestSnapshot!)).toEqual({
      input: { prompt: `Shot 1: a rainy night market\n\n${TEXT_LANGUAGE_RULE_ZH}\n\n${MOTION_RULE_ZH}\n\n${VISUAL_STYLE_DIRECTIVE}` },
      // Same canonical length whether or not a conditioning model is bound: the shot asked
      // for its own duration, and the vendor field is decided by whichever candidate runs.
      parameters: { seed: generationSeed(task.idempotencyKey!), durationSeconds: Math.round(planned.durationMs / 1000) },
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
    // Every video task states the length it bought, including when it bought none: a model
    // that declares nothing must not leave the log silent about who set the clip's duration.
    const first = request({ seed: 41 })
    expect(pinBilledParameters(first, videoCap('i2v'), null, 1)).toEqual({ seed: 41, duration: 'vendor-default' })
    const second = request({ seed: 41 })
    expect(pinBilledParameters(second, videoCap('i2v'), null, 2)).toEqual({ seed: 42, duration: 'vendor-default' })
    expect(second.parameters.seed).toBe(42)
  })

  it('pins the 1080-class tier the model declares, in the model\u2019s own spelling', () => {
    const upper = request({ seed: 7 })
    expect(pinBilledParameters(upper, videoCap('t2v'), { resolutions: ['480P', '720P', '1080P'] }, 1)).toEqual({ seed: 7, resolution: '1080P', duration: 'vendor-default' })
    const lower = request({})
    expect(pinBilledParameters(lower, videoCap('i2v'), { resolutions: ['480p', '720p', '1080p', '4k'] }, 1)).toEqual({ resolution: '1080p', duration: 'vendor-default' })
    // A model that ships one tier only is pinned to exactly that tier; 4k is never a default.
    const sole = request({})
    expect(pinBilledParameters(sole, videoCap('i2v'), { resolutions: ['720P'] }, 1)).toEqual({ resolution: '720P', duration: 'vendor-default' })
    const fourKOnly = request({})
    expect(pinBilledParameters(fourKOnly, videoCap('t2v'), { resolutions: ['2160p', '4k'] }, 1)).toEqual({ resolution: '2160p', duration: 'vendor-default' })
  })

  it('bounds the length the shot asked for to what the winning model declares', () => {
    // 15 planned on a 4\u201315 model is bought whole.
    const inside = request({ durationSeconds: 15 })
    expect(pinBilledParameters(inside, videoCap('i2v'), { duration: { kind: 'range', min: 4, max: 15 } }, 1)).toEqual({ duration: 15 })
    expect(inside.parameters.durationSeconds).toBe(15)

    // The same shot falls to a 12-second model: the request is rewritten, and the number
    // asked for is recorded beside it so a re-run can tell a plan from a purchase.
    const trimmed = request({ durationSeconds: 15 })
    expect(pinBilledParameters(trimmed, videoCap('i2v'), { duration: { kind: 'range', min: 2, max: 12 } }, 1)).toEqual({ duration: 12, durationAsked: 15 })
    expect(trimmed.parameters.durationSeconds).toBe(12)

    // Enumerated lengths buy one of the listed values only \u2014 7 is not on Kling's menu, and
    // neither is the 9 between Veo's 8 and its next tier.
    const stepped = request({ durationSeconds: 7 })
    expect(pinBilledParameters(stepped, videoCap('t2v'), { duration: { kind: 'steps', values: [4, 6, 8] } }, 1)).toEqual({ duration: 6, durationAsked: 7 })
    expect(stepped.parameters.durationSeconds).toBe(6)

    // A model that declares nothing cannot be bounded, so nothing is sent: leaving the
    // canonical key in place would hand a vendor an unmapped number and a bill nobody read.
    const undeclared = request({ durationSeconds: 10 })
    expect(pinBilledParameters(undeclared, videoCap('i2v'), { durations: [5] }, 1)).toEqual({ duration: 'vendor-default' })
    expect(undeclared.parameters.durationSeconds).toBeUndefined()
  })

  it('leaves what the spec does not declare to the vendor, and never overwrites what the caller set', () => {
    const undeclared = request({ seed: 3 })
    expect(pinBilledParameters(undeclared, videoCap('i2v'), { durations: [5] }, 1)).toEqual({ seed: 3, duration: 'vendor-default' })
    expect(undeclared.parameters.resolution).toBeUndefined()
    const setByCaller = request({ resolution: '480P' })
    // Nothing new is pinned for it (billed carries only the length the vendor will decide)
    // and the caller's number survives untouched.
    expect(pinBilledParameters(setByCaller, videoCap('t2v'), { resolutions: ['480P', '1080P'] }, 1)).toEqual({ duration: 'vendor-default' })
    expect(setByCaller.parameters.resolution).toBe('480P')
    // Only video models bill by a resolution tier; an image row's sizes follow other keys
    // entirely, so nothing is invented for it here.
    const image = request({})
    expect(pinBilledParameters(image, videoCap('image'), { resolutions: ['1024x1024'] }, 1)).toEqual({})
  })

  it('sends the seed, the pinned tier and the pinned length on the wire and records them on the task', async () => {
    const seed = await env.seed()
    const [shot] = seed.storyboardIds as [string]
    await approveScript(seed)
    const planned = await env.db.storyboard.findUniqueOrThrow({ where: { id: shot }, select: { durationMs: true } })
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v', { resolutions: ['480P', '720P', '1080P'], duration: { kind: 'range', min: 2, max: 15 } })
    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })

    const queued = await env.takeWaitingRunTasks()
    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    await runTask(queued[0]!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    // The snapshot held the plan; the wire carries what was bought. Both land in rows a
    // later "what did we pay for" question can be answered from without re-deriving.
    const asked = Math.round(planned.durationMs / 1000)
    const bought = Math.min(Math.max(asked, 2), 15)
    const billed = { seed: generationSeed(task.idempotencyKey!), resolution: '1080P', duration: bought }
    const call = submitted.mock.calls.find(([capability]) => capability.modality === 't2v')
    // Both the wire and the stored row name the length with the platform's own key: the
    // vendor's spelling is added inside the adapter at the last moment, and the execution
    // log carries the plain `duration=<seconds>` a billing question is read from.
    const wire = { seed: billed.seed, resolution: billed.resolution, durationSeconds: billed.duration }
    expect(call?.[1].parameters).toEqual(wire)
    const succeeded = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(JSON.parse(succeeded.responseSnapshot!).parameters).toEqual(wire)
  })
})


describe('video extend (artifact operation)', () => {
  it('blocks the operation on an ambiguous submit — redelivery never resubmits; a prior accepted submission resumes polling instead of re-submitting (Q01)', async () => {
    const seed = await env.seed({ storyboards: 1 })
    const [shot] = seed.storyboardIds as [string]
    await approveScript(seed)
    const candidate = await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    const clip = await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 't2v', storyboardId: shot, durationMs: 5000 })
    const makeOperation = () => env.db.artifactOperation.create({
      data: {
        organizationId: seed.organizationId,
        kind: 'video_extend',
        sourceArtifactId: clip.artifactId,
        connectionId: candidate.connectionId,
        capabilityId: candidate.capabilityId,
        provider: candidate.provider,
        model: candidate.model,
        requestSnapshot: JSON.stringify({ input: { prompt: '延长这一镜' }, parameters: { durationMs: 5000 }, sourceArtifactId: clip.artifactId, storyboardId: shot, applyPolicy: 'candidate_only' }),
        applyPolicy: 'candidate_only',
      },
    })

    // 首次:上游可能接单但回包丢失——操作 BLOCKED,extend 恰被调 1 次。
    const opBlocked = await makeOperation()
    const extend = vi.spyOn(MockProviderAdapter.prototype, 'extend')
      .mockImplementationOnce(() => { throw new Error('ECONNRESET: socket hang up — the request may have reached the provider') })
    const payload = { kind: 'run-artifact-operation' as const, operationId: opBlocked.id, organizationId: seed.organizationId, attempt: 1, candidate }
    await runArtifactOperation(payload, env.deps({ pollIntervalMs: 10 }))
    expect(extend).toHaveBeenCalledTimes(1)
    const blocked = await env.db.artifactOperation.findUniqueOrThrow({ where: { id: opBlocked.id } })
    expect(blocked.status).toBe('BLOCKED')
    expect(blocked.errorSnapshot).toContain('submission unknown')
    expect(await env.db.submissionAttempt.count({ where: { operationId: opBlocked.id, status: 'submission_unknown' } })).toBe(1)

    // 队列重投同操作:终态去重,一次都不许再调用供应商。
    extend.mockClear()
    extend.mockImplementation(() => { throw new Error('must not be called on redelivery') })
    await runArtifactOperation({ ...payload, attempt: 2 }, env.deps({ pollIntervalMs: 10 }))
    expect(extend).not.toHaveBeenCalled()
    expect((await env.db.artifactOperation.findUniqueOrThrow({ where: { id: opBlocked.id } })).status).toBe('BLOCKED')

    // 恢复路径:另一次操作提交成功拿到 providerTaskId 后中断,重投不得重新提交,
    // 而是续查同一个上游任务。
    const opResume = await makeOperation()
    extend.mockClear()
    extend.mockRestore()
    const resumePayload = { kind: 'run-artifact-operation' as const, operationId: opResume.id, organizationId: seed.organizationId, attempt: 1, candidate }
    // 先真实提交一次拿到 providerTaskId,然后人工把操作拉回 RUNNING 模拟中途崩溃。
    await runArtifactOperation(resumePayload, env.deps({ pollIntervalMs: 10 }))
    const accepted = await env.db.submissionAttempt.findFirstOrThrow({ where: { operationId: opResume.id, providerTaskId: { not: null } } })
    const counted = await env.db.submissionAttempt.count({ where: { operationId: opResume.id } })
    expect(counted).toBe(1)
    const extendSpy2 = vi.spyOn(MockProviderAdapter.prototype, 'extend')
    await runArtifactOperation({ ...resumePayload, attempt: 2 }, env.deps({ pollIntervalMs: 10 }))
    expect(extendSpy2).not.toHaveBeenCalled()
    extendSpy2.mockRestore()
    // 续查走的是同一个 providerTaskId,不新开台账行。
    expect(await env.db.submissionAttempt.count({ where: { operationId: opResume.id } })).toBe(counted)
    expect((await env.db.submissionAttempt.findFirstOrThrow({ where: { operationId: opResume.id, providerTaskId: { not: null } } })).providerTaskId).toBe(accepted.providerTaskId)
    expect((await env.db.artifactOperation.findUniqueOrThrow({ where: { id: opResume.id } })).status).toBe('SUCCEEDED')
  })

  it('extends the shot\u2019s clip and pins the longer cut as the master selection', async () => {
    const seed = await env.seed({ storyboards: 1 })
    const [shot] = seed.storyboardIds as [string]
    await approveScript(seed)
    const candidate = await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    // Q05 回归前提:源片 5 秒——延长输出必须保留源前段,总长 = 源 + 追加。
    const clip = await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 't2v', storyboardId: shot, durationMs: 5000 })

    const operation = await env.db.artifactOperation.create({
      data: {
        organizationId: seed.organizationId,
        kind: 'video_extend',
        sourceArtifactId: clip.artifactId,
        connectionId: candidate.connectionId,
        capabilityId: candidate.capabilityId,
        provider: candidate.provider,
        model: candidate.model,
        requestSnapshot: JSON.stringify({ input: { prompt: '延长这一镜' }, parameters: { durationMs: 5000 }, sourceArtifactId: clip.artifactId, storyboardId: shot, applyPolicy: 'apply_if_unchanged' }),
        applyPolicy: 'apply_if_unchanged',
        expectedShotRevision: (await env.db.storyboard.findUniqueOrThrow({ where: { id: shot }, select: { stateRevision: true } })).stateRevision,
      },
    })
    // 诊断:看操作行实际存了什么
    await runArtifactOperation(
      { kind: 'run-artifact-operation', operationId: operation.id, organizationId: seed.organizationId, attempt: 1, candidate },
      env.deps({ pollIntervalMs: 10 }),
    )

    const done = await env.db.artifactOperation.findUniqueOrThrow({ where: { id: operation.id } })
    expect(done.status).toBe('SUCCEEDED')
    expect(done.outputArtifactId).toBeTruthy()
    expect(done.applyStatus).toBe('applied')
    const output = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: done.outputArtifactId! } })
    expect(output.mimeType).toBe('video/mp4')
    expect(output.stage).toBe('VIDEO')
    // 延长即采用:加长版直接落钦定,否则自动选版(只看任务制品)永远看不见它。
    const storyboard = await env.db.storyboard.findUniqueOrThrow({ where: { id: shot } })
    expect(storyboard.selectedVideoArtifactId).toBe(output.id)

    // R02:延长契约=源片时长+追加时长。压缩字节估算曾把 5 秒源片估成 1 秒,输出
    // 「5 秒加长片」冒充成功;现在 worker 用 ffprobe 实测源时长传给适配器——断言
    // 输出 ≈ 实测源 + 5s 追加(各留 0.5s 容器取整容差)。
    {
      const clipRow = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: clip.artifactId } })
      const srcBytes = await env.deps().storage.read(clipRow.objectKey)
      const probeDir = await mkdtemp(path.join(os.tmpdir(), 'extend-check-'))
      try {
        const srcFile = path.join(probeDir, 'src.mp4')
        const { writeFile } = await import('node:fs/promises')
        await writeFile(srcFile, srcBytes)
        const srcMs = await probeDuration(srcFile)
        expect(srcMs).toBeGreaterThan(0)
        expect(output.durationMs!).toBeGreaterThanOrEqual(srcMs + 4500)
        expect(output.durationMs!).toBeLessThanOrEqual(srcMs + 5500)
        // Q05:延长=保留源前段的完整加长片——输出的第一帧必须是源片的第一帧,
        // 而不是从 0 起的全新 testsrc。逐帧身份用首帧缩放成 8x8 的 RGB 均值对比。
        const { execFile: probeExec } = await import('node:child_process')
        const { promisify: probePromisify } = await import('node:util')
        const probeRun = probePromisify(probeExec)
        const frameSignature = async (file: string): Promise<number[]> => {
          const { stdout } = await probeRun('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=8:8', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24, encoding: 'buffer' }) as { stdout: Buffer }
          const first = stdout.subarray(0, 8 * 8 * 3)
          const means: number[] = []
          for (let channel = 0; channel < 3; channel++) {
            let sum = 0
            for (let pixel = 0; pixel < 64; pixel++) sum += first[pixel * 3 + channel]!
            means.push(sum / 64)
          }
          return means
        }
        const outputRow = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: done.outputArtifactId! } })
        const outputFile = path.join(probeDir, 'out.mp4')
        await (await import('node:fs/promises')).writeFile(outputFile, await env.deps().storage.read(outputRow.objectKey))
        const [srcSig, outSig] = await Promise.all([frameSignature(srcFile), frameSignature(outputFile)])
        const distance = Math.max(Math.abs(srcSig[0]! - outSig[0]!), Math.abs(srcSig[1]! - outSig[1]!), Math.abs(srcSig[2]! - outSig[2]!))
        expect(distance).toBeLessThan(16)
      } finally {
        await rm(probeDir, { recursive: true, force: true })
      }
    }

    // 钦定必须真正被合成消费:曾出现"钦定字段写了、compose 解析不到(操作产物
    // 无任务),静默回退取最新任务产物"——加长片永远进不了母带。断言入片的那一
    // 版就是延长输出,且来源是 manual。
    const composition = await env.db.composition.create({
      data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: [shot] }) },
    })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())
    const composed = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(composed.status).toBe('COMPLETED')
    const selections = (JSON.parse(composed.manifest) as { selections: Record<string, { artifactId: string; source: string }> }).selections
    expect(selections[shot]).toEqual({ artifactId: output.id, source: 'manual' })

    // 链式延长:加长版本身没有任务,统一归属解析器经成功操作链认它——再次延长
    // 必须走通,否则延长产物是一次性死胡同。
    const chain = await env.db.artifactOperation.create({
      data: {
        organizationId: seed.organizationId,
        kind: 'video_extend',
        sourceArtifactId: output.id,
        connectionId: candidate.connectionId,
        capabilityId: candidate.capabilityId,
        provider: candidate.provider,
        model: candidate.model,
        requestSnapshot: JSON.stringify({ input: { prompt: '再延长' }, parameters: { durationMs: 3000 }, sourceArtifactId: output.id, storyboardId: shot, applyPolicy: 'apply_if_unchanged' }),
        applyPolicy: 'apply_if_unchanged',
        expectedShotRevision: (await env.db.storyboard.findUniqueOrThrow({ where: { id: shot }, select: { stateRevision: true } })).stateRevision,
      },
    })
    await runArtifactOperation(
      { kind: 'run-artifact-operation', operationId: chain.id, organizationId: seed.organizationId, attempt: 1, candidate },
      env.deps({ pollIntervalMs: 10 }),
    )
    const chained = await env.db.artifactOperation.findUniqueOrThrow({ where: { id: chain.id } })
    expect(chained.status).toBe('SUCCEEDED')
    expect((await env.db.storyboard.findUniqueOrThrow({ where: { id: shot } })).selectedVideoArtifactId).toBe(chained.outputArtifactId)
  })

  it('refuses a pinned artifact whose ownership cannot be proven (no task, no succeeded operation)', async () => {
    const seed = await env.seed({ storyboards: 1 })
    const [shot] = seed.storyboardIds as [string]
    await approveScript(seed)
    const clip = await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 't2v', storyboardId: shot })
    // 一个凭空的无任务制品被塞进钦定位:不是任务产物、也不在任何成功操作链上,
    // 合成必须拒绝它并回退自动选版——「没有任务」不是归属证明。
    const orphan = await env.db.mediaArtifact.create({
      data: { organizationId: seed.organizationId, stage: 'VIDEO', objectKey: `${seed.organizationId}/orphan.mp4`, checksum: 'orphan', mimeType: 'video/mp4', version: 1 },
    })
    await env.db.storyboard.update({ where: { id: shot }, data: { selectedVideoArtifactId: orphan.id } })

    const composition = await env.db.composition.create({
      data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: [shot] }) },
    })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())
    const composed = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    const selections = (JSON.parse(composed.manifest) as { selections: Record<string, { artifactId: string; source: string }> }).selections
    expect(selections[shot].source).toBe('auto')
    expect(selections[shot].artifactId).toBe(clip.artifactId)
  })
})

describe('structured control injection (US-016)', () => {
  it('injects framing/movement/mood into the VIDEO prompt and omits nulls', async () => {
    const seed = await env.seed({ storyboards: 1 })
    const [shot] = seed.storyboardIds as [string]
    await approveScript(seed)
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    // 结构化控制:特写 + 手持 + 紧张;负面约束不出现人脸。
    await env.db.shotControl.create({
      data: { storyboardId: shot, framing: 'close_up', cameraMovement: 'handheld', mood: '紧张', negativePrompt: '文字水印' },
    })

    const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'VIDEO')
    if (!result.ok) throw new Error(`VIDEO refused: ${result.error}`)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId: result.batchId } })
    const prompt = (JSON.parse(task.requestSnapshot!) as { input: { prompt: string } }).input.prompt
    // 确定性注入:标签翻译为中文,字段分号分隔,跟在描述之后。
    expect(prompt).toContain('景别: 特写')
    expect(prompt).toContain('镜头运动: 手持')
    expect(prompt).toContain('情绪与节奏: 紧张')
    expect(prompt).toContain('禁止出现: 文字水印')
    // null 字段不写「自动」——干净的不在比假的在更诚实。
    expect(prompt).not.toContain('自动')
  })

  it('leaves prompts untouched when no controls exist (backward compatibility)', async () => {
    const seed = await env.seed({ storyboards: 1 })
    const [shot] = seed.storyboardIds as [string]
    await approveScript(seed)
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')

    const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'VIDEO')
    if (!result.ok) throw new Error(`VIDEO refused: ${result.error}`)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId: result.batchId } })
    const prompt = (JSON.parse(task.requestSnapshot!) as { input: { prompt: string } }).input.prompt
    expect(prompt).not.toContain('景别:')
    expect(prompt).not.toContain('机位:')
    void shot
  })
})

describe('edit timeline render (R04)', () => {
  it('mixes edit-timeline tracks into the master and links the consumed revision', async () => {
    // 修复前:compose 解析了 editTracks 却从不传给混音器——轨道参数改了,成片一字
    // 不变。无声素材 + 一条 AUDIO 轨道:成片必须有音轨,且 composition 记录它消费
    // 的编辑修订(freshness/交付冻结的数据基础)。
    const seed = await env.seed({ storyboards: 1 })
    const [shot] = seed.storyboardIds as [string]
    await env.attachSucceededVideo(seed, shot, 1, { durationMs: 5000 })
    const track = await env.attachSucceededMedia(seed, { stage: 'AUDIO', modality: 'tts' })
    const edit = await env.db.episodeEdit.create({
      data: {
        episodeId: seed.episodeId, organizationId: seed.organizationId, headRevision: 1,
        revisions: { create: { revision: 1, fpsNum: 25, fpsDen: 1, clips: JSON.stringify([{ clipId: 'clip-1', storyboardId: shot, artifactId: '', sourceInFrame: 0, sourceOutFrame: 125 }]), tracks: JSON.stringify([{ elementId: 't1', sourceArtifactId: track.artifactId, anchor: 'sequence', offsetFrame: 25, gain: 1, muted: false, locked: false }]), outputSpec: '{}', fingerprint: 'r04-track', author: 'test' } },
      },
      include: { revisions: true },
    })
    const composition = await env.db.composition.create({ data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: [shot] }) } })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())

    const done = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(done.status).toBe('COMPLETED')
    expect(done.editRevisionId).toBe(edit.revisions[0]!.id)
    expect(done.inputFingerprint).toBe('r04-track')
    // 轨道真的进输出:源素材无声,成片的音轨只可能来自 extras 混音。
    const artifact = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: done.artifactId! } })
    const bytes = await env.deps().storage.read(artifact.objectKey)
    const checkDir = await mkdtemp(path.join(os.tmpdir(), 'r04-check-'))
    try {
      const file = path.join(checkDir, 'master.mp4')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(file, bytes)
      const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file])
      const streams = (JSON.parse(stdout) as { streams: Array<{ codec_type: string }> }).streams
      expect(streams.some(stream => stream.codec_type === 'audio')).toBe(true)
    } finally {
      await rm(checkDir, { recursive: true, force: true })
    }
  })
})

describe('submission_unknown reliability (R01)', () => {
  it('blocks the task on an ambiguous submit — the next candidate is never called, redelivery never resubmits', async () => {
    // 复现口径对齐第三轮复核:上游已受理后断线(提交抛错但请求可能已到达)。
    // 修复前:抛错被候选循环 catch 成 next → 第二候选继续提交 → 重投再提交,
    // submit 累计 3 次。修复后:unknown 即持久终止。
    const seed = await env.seed()
    const payload = env.runPayload(seed, 1)
    const chain: RunTaskCandidate[] = [payload.candidates[0]!, { ...payload.candidates[0]! }]
    const submit = vi.spyOn(MockProviderAdapter.prototype, 'submit')
      .mockImplementationOnce(() => { throw new Error('ECONNRESET: socket hang up — the request may have reached the provider') })

    await runTask({ ...payload, candidates: chain }, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    // 只有第一个候选提交过——第二候选被阻断,不再产生可能重复计费的调用。
    expect(submit).toHaveBeenCalledTimes(1)

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('BLOCKED')
    expect(task.errorSnapshot).toContain('submission unknown')
    // 来源必须可查单:哪个 provider/model/第几次尝试。
    expect(task.errorSnapshot).toContain('provider mock')
    expect(task.errorSnapshot).toContain('attempt 1')
    const attempt = await env.db.submissionAttempt.findFirst({ where: { taskId: seed.taskId } })
    expect(attempt?.status).toBe('submission_unknown')

    // 队列重投同任务:终态去重,一次都不许再提交。
    submit.mockClear()
    submit.mockImplementation(() => { throw new Error('must not be called on redelivery') })
    await runTask({ ...payload, candidates: chain, attempt: 2 }, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    expect(submit).not.toHaveBeenCalled()
    const still = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(still.status).toBe('BLOCKED')
    // 台账不新增——重投不是新的提交尝试。
    expect(await env.db.submissionAttempt.count({ where: { taskId: seed.taskId } })).toBe(1)
  })

  it('degrades to the next candidate on a deterministic quota rejection instead of blocking the task', async () => {
    // 2026-10-21 实测:DashScope 免费额度耗尽时 submit 抛 4xx 报文
    // (AllocationQuota.FreeTierOnly)。修复前它被归成 submission_unknown → 任务
    // BLOCKED,候选链停在第一个模型,后面还有额度的模型一次都没被尝试。
    // 修复后:确定性拒绝记为 settled/failed,候选链继续,任务照常完成。
    const seed = await env.seed()
    const payload = env.runPayload(seed, 1)
    const chain: RunTaskCandidate[] = [payload.candidates[0]!, { ...payload.candidates[0]! }]
    const submit = vi.spyOn(MockProviderAdapter.prototype, 'submit')
      .mockImplementationOnce(() => {
        throw new Error('AllocationQuota.FreeTierOnly | Free quota exhausted. To continue accessing the model on a paid basis, please add funds or disable the "use free tier only" mode in the management console. | request_id=e56839c')
      })

    await runTask({ ...payload, candidates: chain }, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    // 第一候选被拒后第二候选真的被提交,任务没有被卡成 BLOCKED。
    expect(submit).toHaveBeenCalledTimes(2)
    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')
    const attempts = await env.db.submissionAttempt.findMany({ where: { taskId: seed.taskId }, orderBy: { slot: 'asc' } })
    expect(attempts).toHaveLength(2)
    // 被拒的那次留痕为已裁决的失败(可查单),不是 submission_unknown。
    expect(attempts[0]?.status).toBe('settled')
    expect(attempts[0]?.resolution).toBe('failed')
    expect(attempts[0]?.errorSnapshot).toContain('FreeTierOnly')
    expect(attempts[1]?.status).toBe('settled')
    expect(attempts[1]?.resolution).toBe('succeeded')
  })
})

describe('execution safety: atomic claim, leases, resume (V01)', () => {
  it('a redelivery while the first consumer is mid-submit never submits twice', async () => {
    const seed = await env.seed({ storyboards: 1 })
    await approveScript(seed)
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })
    const queued = await env.takeWaitingRunTasks()

    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const submit = vi.spyOn(MockProviderAdapter.prototype, 'submit')
      .mockImplementation(async () => { await gate; return { taskId: 'hang-1' } })
    const first = runTask(queued[0]!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 })).catch(() => undefined)
    // 第一个消费者真正进入 submit:台账 submitting 行已落库。
    await vi.waitFor(async () => {
      if (!(await env.db.submissionAttempt.findFirst({ where: { taskId: task.id, status: 'submitting' } }))) throw new Error('submitting row not yet visible')
    })
    const before = submit.mock.calls.length
    // 同 taskId/attempt 重投:抢不到租约,一次都不许再碰上游。
    await runTask(queued[0]!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    expect(submit.mock.calls.length).toBe(before)
    expect((await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('RUNNING')
    release()
    await first
    // 挂起释放后第一消费者拿到 taskId 续走;整个生命周期上游恰被提交一次。
    expect(submit.mock.calls.length).toBe(1)
    await vi.waitFor(async () => {
      if ((await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })).status === 'RUNNING') throw new Error('not settled')
    })
    expect(await env.db.submissionAttempt.count({ where: { taskId: task.id } })).toBe(1)
    submit.mockRestore()
  })

  it('treats a poll timeout as pending-query: task BLOCKED without fallback, redelivery resumes polling the same provider task', async () => {
    const seed = await env.seed({ storyboards: 1 })
    await approveScript(seed)
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })
    const queued = await env.takeWaitingRunTasks()

    const submit = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    const poll = vi.spyOn(MockProviderAdapter.prototype, 'poll').mockImplementation(async () => ({ status: 'running' as const }))
    await runTask(queued[0]!, env.deps({ qcMode: 'pass', pollIntervalMs: 5, pollTimeoutMs: 60 }))
    expect(submit).toHaveBeenCalledTimes(1)
    const blocked = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(blocked.status).toBe('BLOCKED')
    expect(blocked.errorSnapshot).toContain('pending query')
    const ledger = await env.db.submissionAttempt.findFirstOrThrow({ where: { taskId: task.id } })
    expect(ledger.providerTaskId).toBeTruthy()
    expect(ledger.status).toBe('accepted') // 续查凭据在,不是 submission_unknown

    poll.mockRestore()
    await runTask(queued[0]!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    expect(submit).toHaveBeenCalledTimes(1) // 续查零新提交
    const done = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('SUCCEEDED')
    const settled = await env.db.submissionAttempt.findFirstOrThrow({ where: { taskId: task.id } })
    expect(settled.status).toBe('settled')
    expect(settled.resolution).toBe('succeeded')
    submit.mockRestore()
  })

  it('refuses to submit without a free attempt slot: an occupied ledger slot blocks instead of re-submitting', async () => {
    const seed = await env.seed({ storyboards: 1 })
    await approveScript(seed)
    await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })
    const queued = await env.takeWaitingRunTasks()
    // 模拟「上一个消费者在 submitting 阶段失联」:同槽位台账行存在但没有 providerTaskId。
    await env.db.submissionAttempt.create({ data: { taskId: task.id, attemptNumber: 1, slot: 0, status: 'submitting' } })

    const submit = vi.spyOn(MockProviderAdapter.prototype, 'submit').mockImplementation(async () => { throw new Error('must not submit over an occupied ledger slot') })
    await runTask(queued[0]!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    expect(submit).not.toHaveBeenCalled()
    const blocked = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(blocked.status).toBe('BLOCKED')
    expect(blocked.errorSnapshot).toContain('ledger slot')
    submit.mockRestore()
  })
})

describe('adoption CAS protects human intent (V02)', () => {
  it('never overwrites a selection a human pinned and locked while the operation ran', async () => {
    const seed = await env.seed({ storyboards: 1 })
    const [shot] = seed.storyboardIds as [string]
    await approveScript(seed)
    const candidate = await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    const clip = await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 't2v', storyboardId: shot, durationMs: 5000 })

    const operation = await env.db.artifactOperation.create({
      data: {
        organizationId: seed.organizationId,
        kind: 'video_extend',
        sourceArtifactId: clip.artifactId,
        connectionId: candidate.connectionId,
        capabilityId: candidate.capabilityId,
        provider: candidate.provider,
        model: candidate.model,
        requestSnapshot: JSON.stringify({ input: { prompt: '延长这一镜' }, parameters: { durationMs: 4000 }, sourceArtifactId: clip.artifactId, storyboardId: shot, applyPolicy: 'apply_if_empty' }),
        applyPolicy: 'apply_if_empty',
      },
    })

    // 在操作读取策略状态之后、CAS 写入之前,人工选 B 并加锁(真实 DB 写,复现
    // 「读取之后、写入之前」的竞态窗口)。monkey-patch 只控制时序,不伪造读值。
    const transaction = env.db.$transaction.bind(env.db)
    let humanChoiceId = ''
    let humanDone = false
    const interleavedTransaction = ((action: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => transaction(async tx => {
      const find = tx.storyboard.findUnique.bind(tx.storyboard)
      tx.storyboard.findUnique = (async (args: Parameters<typeof find>[0]) => {
        const result = await find(args)
        if (!humanDone && args.where.id === shot && args.select?.lockedVideoSelection) {
          humanDone = true
          const chosen = await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 't2v', storyboardId: shot, durationMs: 5000, version: 2 })
          humanChoiceId = chosen.artifactId
          await env.db.storyboard.update({ where: { id: shot }, data: { selectedVideoArtifactId: chosen.artifactId, lockedVideoSelection: true, stateRevision: { increment: 1 } } })
        }
        return result
      }) as unknown as typeof tx.storyboard.findUnique
      return action(tx)
    }, options as never)) as unknown as typeof env.db.$transaction
    const interleavedDb = new Proxy(env.db, { get: (target, key) => key === '$transaction' ? interleavedTransaction : Reflect.get(target, key) })
    {
      await runArtifactOperation({ kind: 'run-artifact-operation', operationId: operation.id, organizationId: seed.organizationId, attempt: 1, candidate }, env.deps({ db: interleavedDb, pollIntervalMs: 10 }))
    }
    expect(humanDone).toBe(true)

    const done = await env.db.artifactOperation.findUniqueOrThrow({ where: { id: operation.id } })
    expect(done.status).toBe('SUCCEEDED')
    expect(done.applyStatus).toBe('skipped')
    expect(done.applyReason).toContain('CAS')
    // 人工的选择与锁原样保留,延长结果只作为候选存在。
    const shotRow = await env.db.storyboard.findUniqueOrThrow({ where: { id: shot } })
    expect(shotRow.selectedVideoArtifactId).toBe(humanChoiceId)
    expect(shotRow.lockedVideoSelection).toBe(true)
  })
})

describe('queue-time resolved inputs (V03) and CFR conform (V05)', () => {
  const pipelineStore = () => ({ db: env.db, enqueueJob: async () => {} })

  it('freezes subtitles at queue time — edits after enqueue do not enter the composition', async () => {
    const seed = await env.seed({ storyboards: 2 })
    const [shotA, shotB] = seed.storyboardIds as [string, string]
    for (const shot of [shotA, shotB]) {
      await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 't2v', storyboardId: shot, durationMs: 5000 })
    }
    // 排队前:两镜各有一行自己的字幕。
    await env.db.storyboard.update({ where: { id: shotA }, data: { subtitleText: 'OLD subtitle frozen at queue' } })
    await env.db.storyboard.update({ where: { id: shotB }, data: { subtitleText: 'OLD second line' } })

    const compositionId = await createComposition(pipelineStore(), seed.organizationId, seed.episodeId, seed.storyboardIds as string[])
    // 排队后改字幕——新字幕绝不能混进这次合成。
    await env.db.storyboard.update({ where: { id: shotA }, data: { subtitleText: 'NEW subtitle after enqueue' } })
    await env.db.storyboard.update({ where: { id: shotB }, data: { subtitleText: 'NEW second line' } })

    await composeEpisode(env.composePayload(compositionId, seed), env.deps())
    const composition = await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })
    expect(composition.status).toBe('COMPLETED')
    expect(composition.subtitleArtifactId).toBeTruthy()
    const subtitleRow = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: composition.subtitleArtifactId! } })
    const srt = new TextDecoder().decode(await env.deps().storage.read(subtitleRow.objectKey))
    expect(srt).toContain('OLD subtitle frozen at queue')
    expect(srt).toContain('OLD second line')
    expect(srt).not.toContain('NEW')
    // manifest 记录的是排队定格的 resolved 输入。
    const manifest = JSON.parse(composition.manifest) as { resolved?: { shots: Array<{ subtitle: string }> } }
    expect(manifest.resolved?.shots).toHaveLength(2)
    expect(manifest.resolved!.shots.every(entry => entry.subtitle.startsWith('OLD'))).toBe(true)
  })

  it('conforms a 30fps source to the 25fps sequence before frame-exact trimming', async () => {
    const seed = await env.seed({ storyboards: 1 })
    const [shot] = seed.storyboardIds as [string]
    // 真实 30fps 源片:修复前直接按秒裁 raw,1 个序列帧(0.04s@25fps)会被裁成
    // 0.033s 的 30fps 帧;修复后先 conform 成 25fps CFR。
    const dir = await mkdtemp(path.join(os.tmpdir(), 'v05-src-'))
    try {
      const src30 = path.join(dir, 'src30.mp4')
      await promisify(execFile)('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=30', '-pix_fmt', 'yuv420p', src30], { timeout: 60_000 })
      const bytes = new Uint8Array(await readFile(src30))
      const attached = await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 't2v', storyboardId: shot, durationMs: 5000, source: { bytes, mimeType: 'video/mp4' } })
      // 编辑:25fps 序列,取 [25,50) = 1 秒。
      await env.db.episodeEdit.create({
        data: {
          episodeId: seed.episodeId, organizationId: seed.organizationId, headRevision: 1,
          revisions: { create: { revision: 1, fpsNum: 25, fpsDen: 1, clips: JSON.stringify([{ clipId: 'clip-1', storyboardId: shot, artifactId: attached.artifactId, sourceInFrame: 25, sourceOutFrame: 50 }]), tracks: '[]', outputSpec: '{}', fingerprint: 'v05-r1', author: 'test' } },
        },
      })
      const compositionId = await createComposition(pipelineStore(), seed.organizationId, seed.episodeId, [shot])
      await composeEpisode(env.composePayload(compositionId, seed), env.deps())
      const composition = await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })
      expect(composition.status).toBe('COMPLETED')
      const master = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: composition.artifactId! } })
      const outDir = await mkdtemp(path.join(os.tmpdir(), 'v05-out-'))
      try {
        const out = path.join(outDir, 'master.mp4')
        await (await import('node:fs/promises')).writeFile(out, await env.deps().storage.read(master.objectKey))
        const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-show_entries', 'format=duration', '-of', 'json', out])
        const probe = JSON.parse(stdout) as { streams: Array<{ avg_frame_rate: string }>; format: { duration: string } }
        expect(probe.streams[0]!.avg_frame_rate).toBe('25/1')
        const duration = Number(probe.format.duration)
        expect(duration).toBeGreaterThan(0.85)
        expect(duration).toBeLessThan(1.3)
      } finally {
        await rm(outDir, { recursive: true, force: true })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('edit track hardening (V03+): negative offsets, source ranges, missing blocks', () => {
  const pipelineStore = () => ({ db: env.db, enqueueJob: async () => {} })

  it('cuts the source head on a negative offset instead of clamping to zero', async () => {
    const seed = await env.seed({ storyboards: 1 })
    const [shot] = seed.storyboardIds as [string]
    const video = await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 't2v', storyboardId: shot, durationMs: 5000 })
    // 3 秒 440Hz 附加轨,序列锚定 offsetFrame=-25(提前 1 秒):听得到的是源片
    // 第 1..3 秒,从时间线 0 起播——修复前钳到 0 会把完整 3 秒从头播。
    const dir = await mkdtemp(path.join(os.tmpdir(), 'v03-extra-'))
    try {
      const extraFile = path.join(dir, 'extra.wav')
      await promisify(execFile)('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'pcm_s16le', extraFile], { timeout: 60_000 })
      const extraBytes = new Uint8Array(await readFile(extraFile))
      const extra = await env.attachSucceededMedia(seed, { stage: 'AUDIO', modality: 'tts', storyboardId: shot, durationMs: 3000, source: { bytes: extraBytes, mimeType: 'audio/wav' } })
      await env.db.episodeEdit.create({
        data: {
          episodeId: seed.episodeId, organizationId: seed.organizationId, headRevision: 1,
          revisions: { create: { revision: 1, fpsNum: 25, fpsDen: 1, clips: JSON.stringify([{ clipId: 'clip-1', storyboardId: shot, artifactId: video.artifactId, sourceInFrame: 0, sourceOutFrame: 125 }]), tracks: JSON.stringify([{ elementId: 'trk-1', sourceArtifactId: extra.artifactId, anchor: 'sequence', offsetFrame: -25, gain: 1, muted: false, locked: false }]), outputSpec: '{}', fingerprint: 'neg-off', author: 'test' } },
        },
      })
      const compositionId = await createComposition(pipelineStore(), seed.organizationId, seed.episodeId, [shot])
      await composeEpisode(env.composePayload(compositionId, seed), env.deps())
      const composition = await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })
      expect(composition.status).toBe('COMPLETED')
      const master = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: composition.artifactId! } })
      const outDir = await mkdtemp(path.join(os.tmpdir(), 'v03-out-'))
      try {
        const out = path.join(outDir, 'master.mp4')
        await (await import('node:fs/promises')).writeFile(out, await env.deps().storage.read(master.objectKey))
        const windowVolume = async (from: number, seconds: number): Promise<number> => {
          try {
            const { stderr } = await promisify(execFile)('ffmpeg', ['-ss', String(from), '-t', String(seconds), '-i', out, '-af', 'highpass=f=350,lowpass=f=550,volumedetect', '-f', 'null', '-'], { timeout: 30_000 })
            const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)
            return match ? Number(match[1]) : -999
          } catch {
            return -999
          }
        }
        const early = await windowVolume(0.2, 0.5) // 附加轨应在响(源片 1.2–1.7s 段)
        const late = await windowVolume(2.6, 0.6) // 附加轨 2s 处已结束,只剩静音底
        expect(early).toBeGreaterThan(-35)
        expect(late).toBeLessThan(early - 10)
      } finally {
        await rm(outDir, { recursive: true, force: true })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocks the composition when an edit track cannot be resolved — no silent skips', async () => {
    const seed = await env.seed({ storyboards: 1 })
    const [shot] = seed.storyboardIds as [string]
    const video = await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 't2v', storyboardId: shot, durationMs: 5000 })
    // 直接构造 manifest:快照音轨引用一个不存在的制品——修复前 stderr 跳过照常
    // 出片,编辑意图蒸发;现在必须 BLOCKED。
    const composition = await env.db.composition.create({
      data: {
        episodeId: seed.episodeId, status: 'RUNNING',
        manifest: JSON.stringify({
          storyboardIds: [shot],
          editSnapshot: {
            revisionId: 'r-x', revision: 1, fpsNum: 25, fpsDen: 1, fingerprint: 'missing-track',
            clips: [{ clipId: 'clip-1', storyboardId: shot, artifactId: video.artifactId, sourceInFrame: 0, sourceOutFrame: 125 }],
            tracks: [{ elementId: 'trk-ghost', sourceArtifactId: 'artifact-that-does-not-exist', anchor: 'sequence', offsetFrame: 0, gain: 1, muted: false, locked: false }],
            outputSpec: {},
          },
          resolved: { shots: [{ storyboardId: shot, videoArtifactId: video.artifactId, videoSource: 'manual', trimInFrame: null, trimOutFrame: null, dialogue: '', subtitle: '', audioSource: null, voiceArtifactId: null, ambienceArtifactId: null }], musicArtifactId: null },
        }),
      },
    })
    await composeEpisode(env.composePayload(composition.id, seed), env.deps())
    expect((await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })).status).toBe('BLOCKED')
  })
})

// SD-068：只有 URL 的供应商回执落库后 width/height/durationMs 全 NULL，而时间线把
// NULL 当素材长度用——4.04 秒的已付费成片被裁成 2 秒。字节到手就得实测补齐。
describe('measured artifact metadata', () => {
  let workdir: string

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-measure-'))
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('fills the size and length a download-only vendor never reported', async () => {
    const source = path.join(workdir, 'source.mp4')
    await synthesizeMockMedia('t2v', source, { durationMs: 4000 })
    const measured = await measureMissingMeta({ bytes: new Uint8Array(await readFile(source)), mimeType: 'video/mp4' }, workdir)
    expect(measured.width).toBeGreaterThan(0)
    expect(measured.height).toBeGreaterThan(0)
    expect(measured.durationMs).toBeGreaterThan(3000)
    expect(measured.durationMs).toBeLessThan(5000)
  })

  it('keeps what the vendor already said', async () => {
    const reported = { bytes: new Uint8Array(0), mimeType: 'video/mp4', width: 720, height: 1280, durationMs: 5000 }
    expect(await measureMissingMeta(reported, workdir)).toBe(reported)
  })

  it('ships paid bytes it cannot read instead of failing or inventing a length', async () => {
    const unreadable = { bytes: new TextEncoder().encode('not a media container'), mimeType: 'video/mp4' }
    expect(await measureMissingMeta(unreadable, workdir)).toBe(unreadable)
    const text = { bytes: new TextEncoder().encode('script body'), mimeType: 'text/plain' }
    expect(await measureMissingMeta(text, workdir)).toBe(text)
  })
})

/**
 * 一颗 12 秒的镜头绑在只卖 5 秒的图生视频模型上：预检逼出一次取舍，人选同镜拼接。
 * 这里要的是真计划——快照里的 takes 与库里的段行都由生产代码产出，测试只负责说出
 * 「拼接」这个决定，不然测的是我手里捏的那份 JSON，不是用户点出来的那条链。
 */
async function planSplicedShot() {
  const seed = await env.seed()
  const [shot] = seed.storyboardIds as [string]
  await env.db.storyboard.update({ where: { id: shot }, data: { durationMs: 12_000 } })
  await approveScript(seed)
  await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
  await bindVideoSlot(seed, 'VIDEO_I2V', 'mock-i2v', { duration: { kind: 'range', min: 2, max: 5 } })
  const frame = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: shot })
  const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'VIDEO', {
    durationDecisions: [{ storyboardId: shot, strategy: 'splice' }],
  })
  if (!result.ok) throw new Error(`VIDEO refused to plan the spliced shot: ${result.error} ${(result as { reasons?: string[] }).reasons ?? ''}`)
  const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId: result.batchId, storyboardId: shot } })
  const snapshot = JSON.parse(task.requestSnapshot!) as {
    referenceArtifacts: { type: string; artifactId: string }[]
    parameters: Record<string, unknown>
    durationPlan: { strategy: string; intentMs: number; ceilingMs: number; takeCount: number; perTakeMs: number; takes: { order: number; plannedMs: number; promptDelta: string }[] }
  }
  return { seed, shot, frame, task, snapshot }
}

describe('spliced shot execution (S2c)', () => {
  it('plans takes from the shot length and the bound ceiling, and starts every row unproduced', async () => {
    const { shot, snapshot } = await planSplicedShot()
    // 整镜意图 12 秒、单次能力 5 秒 → 3 段各 4 秒；这一击买的是段长，不是整镜。
    expect(snapshot.durationPlan).toMatchObject({ strategy: 'splice', intentMs: 12_000, ceilingMs: 5_000, takeCount: 3, perTakeMs: 4_000 })
    expect(snapshot.durationPlan.takes.map(take => take.plannedMs)).toEqual([4_000, 4_000, 4_000])
    expect(snapshot.parameters.durationSeconds).toBe(4)
    expect(snapshot.referenceArtifacts).toEqual([{ type: 'first_frame', artifactId: expect.any(String) }])

    const rows = await env.db.shotTake.findMany({ where: { storyboardId: shot }, orderBy: { order: 'asc' } })
    expect(rows.map(row => [row.order, row.plannedMs, row.status])).toEqual([[1, 4_000, 'DRAFT'], [2, 4_000, 'DRAFT'], [3, 4_000, 'DRAFT']])
    // 段与段之间的契约在落库那一刻就写死了：承接上一段的动作、同一条声床、不许「同上」。
    expect(rows[1]!.promptDelta).toContain('承接上段：')
    expect(rows[1]!.promptDelta).toContain('声床：')
    expect(rows[1]!.promptDelta).not.toContain('同上')
  })

  it('buys each take on the previous take\'s end frame and ships one master for the shot', async () => {
    const { seed, shot, frame, task } = await planSplicedShot()
    const queued = await env.takeWaitingRunTasks()
    const payload = queued.find(entry => entry.taskId === task.id)!
    // 条件模型排前，纯文字兜底排后；拼接任务只有前者能接。
    expect(payload.candidates.map(candidate => candidate.model)).toEqual(['mock-i2v', 'mock-t2v'])

    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    const audited: QcSubject[] = []
    await runTask(payload, env.deps({ qcMode: 'pass', pollIntervalMs: 10, checker: recordingChecker(audited) }))

    // 三段三次下单，每一次都只带一张首帧槽的图。
    expect(submitted.mock.calls).toHaveLength(3)
    const conditioning = submitted.mock.calls.map(([, request]) => (request.input.media as { type: string; url: string }[]).filter(media => media.type === 'first_frame'))
    expect(conditioning.map(media => media.length)).toEqual([1, 1, 1])

    const succeeded = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(succeeded.status).toBe('SUCCEEDED')
    expect(succeeded.model).toBe('mock-i2v')
    const response = JSON.parse(succeeded.responseSnapshot!) as {
      takes: { order: number; plannedMs: number; durationMs: number; artifactId: string; endFrameArtifactId: string; firstFrameArtifactId: string | null; reused: boolean }[]
      artifactId: string
      durationMs: number | null
      reference: { model: string; conditioned: boolean }[]
      qc: { score: number; threshold: number; aggregated: boolean }
    }
    expect(response.takes.map(take => take.order)).toEqual([1, 2, 3])
    expect(response.takes.map(take => take.plannedMs)).toEqual([4_000, 4_000, 4_000])
    // 帧链是同一颗 artifact，不是「长得像」。
    expect(response.takes[0]!.firstFrameArtifactId).toBe(frame.artifactId)
    expect(response.takes[1]!.firstFrameArtifactId).toBe(response.takes[0]!.endFrameArtifactId)
    expect(response.takes[2]!.firstFrameArtifactId).toBe(response.takes[1]!.endFrameArtifactId)
    // 三段的条件帧是三颗不同的 artifact——mock 出的画面字节相同，data URL 分不出彼此，
    // 身份只认号：第 1 段是批准首帧，第 2、3 段各是上一段刚抽出来的末帧。
    expect(new Set(response.takes.map(take => take.firstFrameArtifactId)).size).toBe(3)
    // 首帧只解析一次：候选入口读过一遍，段循环不该再读一遍、更不该记第二笔。
    expect(response.reference).toEqual([{ model: 'mock-i2v', conditioned: true }])
    // 结论是各段合成的，不是对母带字节重新审过一遍：报告里必须写着 aggregated 并带上最差那段的读数。
    expect(response.qc).toMatchObject({ aggregated: true })

    // 台账按段分格（段号×100+候选序号），重投才落得回同一格、不会重复计费。
    const attempts = await env.db.submissionAttempt.findMany({ where: { taskId: task.id }, orderBy: { slot: 'asc' } })
    expect(attempts.map(attempt => attempt.slot)).toEqual([100, 200, 300])
    expect(attempts.map(attempt => attempt.status)).toEqual(['settled', 'settled', 'settled'])
    // 一段过审记一笔：后面某段失败时，前面付过的钱不从账本里消失。
    expect(await env.db.usageLedger.count({ where: { taskId: task.id } })).toBe(3)

    const master = await env.db.mediaArtifact.findFirstOrThrow({ where: { taskId: task.id } })
    expect(master.stage).toBe('VIDEO')
    // 母带时长是量出来的：三段各 ~1 秒，不是计划里的 12 秒。
    expect(master.durationMs).not.toBeNull()
    expect(master.durationMs!).toBeLessThan(12_000)
    const masterCheck = await env.db.qualityCheck.findFirstOrThrow({ where: { artifactId: master.id } })
    expect(masterCheck.status).toBe('APPROVED')
    const report = JSON.parse(masterCheck.report!) as { aggregated: boolean; takes: { order: number }[] }
    expect(report.aggregated).toBe(true)
    expect(report.takes.map(take => take.order)).toEqual([1, 2, 3])

    // 段产物既不挂任务也不挂镜头：它们不是这一镜的可选版本，进了列表就有人把
    // 三分之一段当成整镜收下。归属只写在 metadata 里，供审计从母带回跳。
    expect(await env.db.mediaArtifact.count({ where: { taskId: null, storyboardId: null, organizationId: seed.organizationId } })).toBe(6)

    const rows = await env.db.shotTake.findMany({ where: { storyboardId: shot }, orderBy: { order: 'asc' } })
    expect(rows.map(row => row.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED'])
    expect(rows[1]!.firstFrameArtifactId).toBe(rows[0]!.endFrameArtifactId)
    expect(rows.map(row => row.videoArtifactId)).toEqual(response.takes.map(take => take.artifactId))

    // 每一段都被出示过条件帧——审核看不见接缝，帧链就只是账面上的。
    expect(audited).toHaveLength(3)
    expect(audited.every(subject => subject.referenceDataUrl !== undefined)).toBe(true)
  })

  it('reuses a take that was already paid for and audited instead of buying it twice', async () => {
    const { seed, shot, frame, task } = await planSplicedShot()
    // 上一个消费者停在第 1 段之后：段行、片子、过审结论都在库里。
    const paid = await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 't2v', storyboardId: shot })
    await verdictOnFrame(paid.artifactId, 'APPROVED')
    await env.db.shotTake.update({
      where: { storyboardId_order: { storyboardId: shot, order: 1 } },
      data: { status: 'SUCCEEDED', videoArtifactId: paid.artifactId, firstFrameArtifactId: frame.artifactId },
    })

    const queued = await env.takeWaitingRunTasks()
    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    await runTask(queued.find(entry => entry.taskId === task.id)!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    // 已付过的段不重买：三段里只下两单。
    expect(submitted.mock.calls).toHaveLength(2)
    const rows = await env.db.shotTake.findMany({ where: { storyboardId: shot }, orderBy: { order: 'asc' } })
    expect(rows[0]!.videoArtifactId).toBe(paid.artifactId)
    expect(rows[0]!.status).toBe('SUCCEEDED')
    // 复用段也得有末帧，否则第 2 段无从接起——末帧从已付的片子里抽，不是再买一段。
    expect(rows[0]!.endFrameArtifactId).not.toBeNull()
    expect(rows[1]!.firstFrameArtifactId).toBe(rows[0]!.endFrameArtifactId)
    // 只有新买的两段进账本。
    expect(await env.db.usageLedger.count({ where: { taskId: task.id } })).toBe(2)
    const done = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('SUCCEEDED')
    const response = JSON.parse(done.responseSnapshot!) as { takes: { order: number; artifactId: string; reused: boolean }[] }
    expect(response.takes.map(take => take.reused)).toEqual([true, false, false])
    expect(response.takes[0]!.artifactId).toBe(paid.artifactId)
  })

  it('refuses a spliced shot whose takes the bound model cannot buy in one call', async () => {
    const { shot, task } = await planSplicedShot()
    // 计划时按 8 秒一段批准，绑定后来缩到 5 秒：段买不满计划长度，接缝就是断的。
    // 这时不许买半段、也不许退给纯文字模型，而是在花钱之前整条链退回。
    const snapshot = JSON.parse(task.requestSnapshot!) as { durationPlan: Record<string, unknown> }
    await env.db.generationTask.update({
      where: { id: task.id },
      data: {
        requestSnapshot: JSON.stringify({
          ...snapshot,
          durationPlan: {
            ...snapshot.durationPlan,
            takes: [
              { order: 1, plannedMs: 8_000, promptDelta: '第 1/2 段 · 同镜拼接' },
              { order: 2, plannedMs: 8_000, promptDelta: '第 2/2 段 · 同镜拼接\n承接上段：动作尚未收尾\n声床：雨声' },
            ],
          },
        }),
      },
    })
    await env.db.shotTake.updateMany({ where: { storyboardId: shot }, data: { plannedMs: 8_000 } })

    const queued = await env.takeWaitingRunTasks()
    const submitted = vi.spyOn(MockProviderAdapter.prototype, 'submit')
    const deps = env.deps({ qcMode: 'pass', pollIntervalMs: 10 })
    // 整条候选链都在花钱之前退回，就按技术档的重抽策略走：每一轮都必须还是零下单，
    // 直到策略用完停在问。这里跑到不再有排队意图为止，不把「自动几次」钉进断言。
    let payload = queued.find(entry => entry.taskId === task.id)!
    let rounds = 0
    for (;;) {
      await runTask(payload, deps)
      rounds += 1
      if (rounds > 4) throw new Error('the unbuyable spliced shot kept re-queueing itself')
      const next = (await env.takeWaitingRunTasks()).find(entry => entry.taskId === task.id)
      if (!next) break
      payload = next
    }

    expect(rounds).toBeGreaterThan(1)
    expect(submitted.mock.calls).toHaveLength(0)
    const failed = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(failed.status).toBe('FAILED')
    expect(failed.errorSnapshot).toContain('can only buy 5s')
    const review = JSON.parse(failed.reviewSnapshot!) as { state: string; kind: string; retryClass: string }
    expect(review).toMatchObject({ state: 'pending', kind: 'provider-exhausted', retryClass: 'technical' })
    expect(await env.db.mediaArtifact.count({ where: { taskId: task.id } })).toBe(0)
    expect(await env.db.usageLedger.count({ where: { taskId: task.id } })).toBe(0)
    // 段行停在没 produced 的那一档：半段都不许被记成已付。
    const rows = await env.db.shotTake.findMany({ where: { storyboardId: shot }, orderBy: { order: 'asc' } })
    expect(rows.map(row => row.status)).toEqual(['DRAFT', 'DRAFT', 'DRAFT'])
  })
})

describe('spliced shot consumption (S2d)', () => {
  const pipelineStore = () => ({ db: env.db, enqueueJob: async () => {} })

  interface FrozenTake {
    order: number
    plannedMs: number | null
    videoArtifactId: string
    firstFrameArtifactId: string | null
    endFrameArtifactId: string | null
  }
  interface CompositionManifest {
    storyboardIds: string[]
    selections?: Record<string, { artifactId: string; source: string }>
    resolved?: {
      takeCut: string
      takeSignature: string
      shots: { storyboardId: string; videoArtifactId: string | null; takes: FrozenTake[]; spliceMs: number | null }[]
    }
  }

  /** 段集只从母带自己的 metadata 读——那是唯一与母带同生的来源。 */
  function masterTakes(metadata: string): FrozenTake[] {
    return (JSON.parse(metadata) as { takes: FrozenTake[] }).takes
  }

  async function produceSplicedMaster() {
    const { seed, shot, task } = await planSplicedShot()
    const queued = await env.takeWaitingRunTasks()
    await runTask(queued.find(entry => entry.taskId === task.id)!, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    expect((await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('SUCCEEDED')
    const master = await env.db.mediaArtifact.findFirstOrThrow({ where: { taskId: task.id } })
    return { seed, shot, task, master }
  }

  /** 同一镜再拼一次：出新母带，段行复用已付的那几段。 */
  async function recutSplicedShot(seed: Seed, shot: string) {
    const result = await triggerStage({ db: env.db, enqueueJob: env.deps().enqueueJob }, seed.organizationId, null, seed.episodeId, 'VIDEO', {
      storyboardIds: [shot], regenerate: true, durationDecisions: [{ storyboardId: shot, strategy: 'splice' }],
    })
    if (!result.ok) throw new Error(`VIDEO refused to re-cut the spliced shot: ${result.error}`)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId: result.batchId, storyboardId: shot } })
    const payload = (await env.takeWaitingRunTasks()).find(entry => entry.taskId === task.id)!
    await runTask(payload, env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
    expect((await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('SUCCEEDED')
    return env.db.mediaArtifact.findFirstOrThrow({ where: { taskId: task.id } })
  }

  it('cuts the shot as one clip at its master and freezes the take set beside it', async () => {
    const { seed, shot, master } = await produceSplicedMaster()
    const compositionId = await createComposition(pipelineStore(), seed.organizationId, seed.episodeId, [shot])
    const queued = await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })
    const manifest = JSON.parse(queued.manifest) as CompositionManifest
    const entry = manifest.resolved!.shots[0]!

    // 口径是「一镜一刀，刀指向拼好的母带」：段本身不进时间线，接缝不由编辑文档决定。
    expect(manifest.resolved!.takeCut).toBe('master-clip')
    expect(entry.videoArtifactId).toBe(master.id)
    expect(entry.takes.map(take => take.videoArtifactId)).toEqual(masterTakes(master.metadata!).map(take => take.videoArtifactId))
    expect(entry.takes.map(take => take.plannedMs)).toEqual([4_000, 4_000, 4_000])
    // 同组固化总长：三段各 4 秒就是 12 秒，与镜头计划一致，不是渲染时再猜。
    expect(entry.spliceMs).toBe(12_000)
    expect(manifest.resolved!.takeSignature).toMatch(/^[0-9a-f]{64}$/)
    // 快照里只有一个片段——三段各自成刀的话这里就是三行。
    expect(manifest.resolved!.shots).toHaveLength(1)

    await composeEpisode(env.composePayload(compositionId, seed), env.deps())
    const composition = await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })
    expect(composition.status).toBe('COMPLETED')
    expect((JSON.parse(composition.manifest) as CompositionManifest).selections![shot]!.artifactId).toBe(master.id)

    // 成片里这一镜就母带那么长：多出一刀（段被重复入片）或少一刀都会在这里露出来。
    const rendered = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: composition.artifactId! } })
    const dir = await mkdtemp(path.join(os.tmpdir(), 's2d-render-'))
    try {
      const out = path.join(dir, 'master.mp4')
      await writeFile(out, await env.deps().storage.read(rendered.objectKey))
      const renderedMs = await probeDuration(out)
      expect(Math.abs(renderedMs - master.durationMs!)).toBeLessThan(400)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads a re-cut segment as stale even when the edit never moved', async () => {
    const { seed, shot, master } = await produceSplicedMaster()
    const compositionId = await createComposition(pipelineStore(), seed.organizationId, seed.episodeId, [shot])
    await composeEpisode(env.composePayload(compositionId, seed), env.deps())
    const rendered = await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })
    expect(rendered.status).toBe('COMPLETED')
    // 首合成把自动选版固化（US-015），此刻当前段集就是快照里那份，不该判过期。
    expect(await compositionCutChanged(env.db, seed.episodeId, rendered.manifest)).toBe(false)
    expect(await planComposition(env.db, seed.episodeId)).toMatchObject({ ready: false, reason: 'composition:alreadyPlanned' })

    // 人重跑了这一镜（新母带），然后把钦定清空回到自动——剪辑结构一个字没改，
    // 编辑指纹照样匹配：没有第二条轴的话，旧成片会继续冒充当前。
    const recut = await recutSplicedShot(seed, shot)
    expect(recut.id).not.toBe(master.id)
    await env.db.storyboard.update({ where: { id: shot }, data: { selectedVideoArtifactId: null, lockedVideoSelection: false } })

    expect(await compositionCutChanged(env.db, seed.episodeId, rendered.manifest)).toBe(true)
    expect(await planComposition(env.db, seed.episodeId)).toMatchObject({ ready: true })
  })

  it('normalizes a legacy single-artifact shot to one take and still composes it', async () => {
    const seed = await env.seed()
    const [shot] = seed.storyboardIds as [string]
    const attached = await env.attachSucceededVideo(seed, shot, 1, { durationMs: 5_000 })
    const compositionId = await createComposition(pipelineStore(), seed.organizationId, seed.episodeId, [shot])
    const manifest = JSON.parse((await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })).manifest) as CompositionManifest
    const entry = manifest.resolved!.shots[0]!

    // 存量迁移要的就是这个形态：一段就是一刀，编辑文档一行都不用重写。
    expect(entry.takes).toEqual([{ order: 1, plannedMs: 5_000, videoArtifactId: attached.artifactId, firstFrameArtifactId: null, endFrameArtifactId: null }])
    expect(entry.spliceMs).toBeNull()
    expect(manifest.resolved!.takeSignature).toMatch(/^[0-9a-f]{64}$/)

    await composeEpisode(env.composePayload(compositionId, seed), env.deps())
    const composition = await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })
    expect(composition.status).toBe('COMPLETED')
    // 单段镜头没有段集可言：换掉它的版本走的是选版轴，不是段轴。
    expect(await compositionCutChanged(env.db, seed.episodeId, composition.manifest)).toBe(false)
  })

  it('refuses to render a master whose own segments no longer match the frozen take set', async () => {
    const { seed, shot, master } = await produceSplicedMaster()
    const compositionId = await createComposition(pipelineStore(), seed.organizationId, seed.episodeId, [shot])
    // 母带的第 2 段换成另一颗产物（重建过、或 metadata 被动过）：快照说这一镜的
    // 三段是这几颗，母带自己说不是——渲出来就是一条看着完整、里面错接的片子。
    const tamperedMetadata = JSON.stringify({
      role: 'spliced-master',
      takes: masterTakes(master.metadata!).map((take, index) => (index === 1 ? { ...take, videoArtifactId: 'some-other-take' } : take)),
    })
    await env.db.mediaArtifact.update({ where: { id: master.id }, data: { metadata: tamperedMetadata } })

    await composeEpisode(env.composePayload(compositionId, seed), env.deps())
    const composition = await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })
    expect(composition.status).toBe('BLOCKED')
    expect(composition.artifactId).toBeNull()
  })
})

/**
 * S4② 转场消费链：分镜表上那一列必须一路走到母带——排队时定格进快照、渲染时按重叠
 * 重算整条时间线、事后能从文件反查「这一刀真的使了 400ms」。三段各管一个真实缺陷：
 * 快照漏字段＝同一修订能渲出两种接法；时间线不重算＝画面按重叠走、字幕按标称走
 * (SD-182 同一类)；没有失效轴＝改了转场旧成片继续冒充当前。
 */
describe('transition consumption (S4②)', () => {
  const pipelineStore = () => ({ db: env.db, enqueueJob: async () => {} })

  interface CompositionManifest {
    resolved?: {
      transitionSignature: string
      shots: { storyboardId: string; transition: string; transitionMs: number }[]
    }
    cuts?: {
      blended: boolean
      shotStartMs?: number[]
      overlapMs?: number[]
      totalMs: number
      storyboardIds: string[]
    }
  }

  /** 两镜各 1 秒，第二镜点转场；台词挂在第二镜，字幕落位才有可读的证据。 */
  async function seedTransitionedPair(transition: string, transitionMs: number) {
    const seed = await env.seed({ storyboards: 2 })
    const [first, second] = seed.storyboardIds as [string, string]
    await env.attachSucceededVideo(seed, first, 1, { durationMs: 1_000 })
    await env.attachSucceededVideo(seed, second, 1, { durationMs: 1_000 })
    await env.db.storyboard.update({ where: { id: second }, data: { transition, transitionMs, dialogue: '第二镜的台词' } })
    return { seed, first, second }
  }

  /** 把成片母带从存储里取回来实测——断言要落在文件上，不是落在计划上。 */
  async function renderedDurationMs(artifactId: string): Promise<number> {
    const artifact = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: artifactId } })
    const dir = await mkdtemp(path.join(os.tmpdir(), 's42-render-'))
    try {
      const out = path.join(dir, 'master.mp4')
      await writeFile(out, await env.deps().storage.read(artifact.objectKey))
      return await probeDuration(out)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('freezes the storyboard transition into the queued snapshot', async () => {
    const { seed, second } = await seedTransitionedPair('dissolve', 400)
    const compositionId = await createComposition(pipelineStore(), seed.organizationId, seed.episodeId, seed.storyboardIds)
    const manifest = JSON.parse((await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })).manifest) as CompositionManifest

    expect(manifest.resolved!.shots.map(shot => [shot.transition, shot.transitionMs])).toEqual([['cut', 0], ['dissolve', 400]])
    expect(manifest.resolved!.transitionSignature).toMatch(/^[0-9a-f]{64}$/)
    // 首镜那一刀前面没有画面，写什么都进不了重叠——口径由计划侧兜住，快照仍如实记原值。
    expect(second).toBe(manifest.resolved!.shots[1]!.storyboardId)
  })

  it('blends the dissolve into the master and rebases the subtitle onto it', async () => {
    const { seed, second } = await seedTransitionedPair('dissolve', 400)
    const compositionId = await createComposition(pipelineStore(), seed.organizationId, seed.episodeId, seed.storyboardIds)
    await composeEpisode(env.composePayload(compositionId, seed), env.deps())
    const composition = await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })
    expect(composition.status).toBe('COMPLETED')

    const manifest = JSON.parse(composition.manifest) as CompositionManifest
    expect(manifest.cuts!.blended).toBe(true)
    expect(manifest.cuts!.overlapMs).toEqual([0, 400])
    expect(manifest.cuts!.shotStartMs).toEqual([0, 600])
    expect(manifest.cuts!.totalMs).toBe(1_600)
    expect(manifest.cuts!.storyboardIds).toEqual(seed.storyboardIds)

    // 母带当场短 400ms：计划说得漂亮但文件还是 2 秒，就是「点了叠化、成片里一个字没发生」。
    expect(Math.abs(await renderedDurationMs(composition.artifactId!) - 1_600)).toBeLessThan(120)

    // 字幕排在重叠之后的那一格，不是标称的 1000ms。
    const subtitle = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: composition.subtitleArtifactId! } })
    const srt = new TextDecoder().decode(await env.deps().storage.read(subtitle.objectKey))
    expect(srt).toContain('00:00:00,600 --> 00:00:01,600')
    expect(srt).not.toContain('00:00:01,000 --> 00:00:02,000')
    expect(srt).toContain('第二镜的台词')
    expect(second).toBe(seed.storyboardIds[1])
  })

  it('keeps an all-cut episode on the stream-copy path with an identical timeline', async () => {
    const seed = await env.seed({ storyboards: 2 })
    await env.attachSucceededVideo(seed, seed.storyboardIds[0]!, 1, { durationMs: 1_000 })
    await env.attachSucceededVideo(seed, seed.storyboardIds[1]!, 1, { durationMs: 1_000 })
    const compositionId = await createComposition(pipelineStore(), seed.organizationId, seed.episodeId, seed.storyboardIds)
    await composeEpisode(env.composePayload(compositionId, seed), env.deps())
    const composition = await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })

    const manifest = JSON.parse(composition.manifest) as CompositionManifest
    expect(manifest.cuts!.blended).toBe(false)
    expect(manifest.cuts!.totalMs).toBe(2_000)
    expect(Math.abs(await renderedDurationMs(composition.artifactId!) - 2_000)).toBeLessThan(120)
  })

  it('reads a changed transition as stale even when the edit never moved', async () => {
    const { seed, second } = await seedTransitionedPair('cut', 0)
    const compositionId = await createComposition(pipelineStore(), seed.organizationId, seed.episodeId, seed.storyboardIds)
    await composeEpisode(env.composePayload(compositionId, seed), env.deps())
    const rendered = await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })
    expect(rendered.status).toBe('COMPLETED')
    expect(await compositionCutChanged(env.db, seed.episodeId, rendered.manifest)).toBe(false)
    expect(await planComposition(env.db, seed.episodeId)).toMatchObject({ ready: false, reason: 'composition:alreadyPlanned' })

    // 人回头把那一刀改成叠化：剪辑结构、选版、声音一个字没动，旧母带却是按另一套
    // 接法粘出来的。没有这一轴，界面会继续报「成片与当前编辑一致」。
    await env.db.storyboard.update({ where: { id: second }, data: { transition: 'dissolve', transitionMs: 400 } })
    expect(await compositionCutChanged(env.db, seed.episodeId, rendered.manifest)).toBe(true)
    expect(await planComposition(env.db, seed.episodeId)).toMatchObject({ ready: true })
  })

  it('does not invent a fade that the storyboard never asked for', async () => {
    // 词表外的写法（「划像」）必须退回硬切并留痕，而不是静默变成某个别的接法。
    const { seed, second } = await seedTransitionedPair('wipe', 400)
    const compositionId = await createComposition(pipelineStore(), seed.organizationId, seed.episodeId, seed.storyboardIds)
    await composeEpisode(env.composePayload(compositionId, seed), env.deps())
    const composition = await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })
    const manifest = JSON.parse(composition.manifest) as CompositionManifest

    expect(manifest.resolved!.shots[1]).toMatchObject({ transition: 'cut', transitionMs: 0 })
    expect(manifest.cuts!.blended).toBe(false)
    expect(second).toBe(seed.storyboardIds[1])
  })
})
