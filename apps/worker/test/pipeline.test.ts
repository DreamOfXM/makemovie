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
import { triggerStage, usableFirstFrames } from '@studio/pipeline'
import { toReferenceImage } from '@studio/media'
import { encryptSecret } from '@studio/security'
import type { RunTaskCandidate } from '@studio/jobs'
import { composeEpisode } from '../src/compose.js'
import { recordGeneratedContent } from '../src/content.js'
import type { QcSubject, QualityChecker } from '../src/qc.js'
import { runTask } from '../src/run-task.js'
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
      description: prompt,
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
    const artifact = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: updated.artifactId! } })
    expect(artifact.stage).toBe('COMPOSITION')
    expect(artifact.version).toBe(1)
    expect(artifact.mimeType).toBe('video/mp4')
    expect(artifact.durationMs).toBeGreaterThan(0)
    expect(artifact.objectKey).toContain(`/COMPOSITION/${composition.id}/v1.mp4`)
    expect(await env.storage.exists(artifact.objectKey)).toBe(true)
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

  it('mixes per-shot voice and music and keeps the video stream untouched', async () => {
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

    // The exact bytes a VIDEO task carried before conditioning existed: no model and no
    // parameters, because those belong to whichever candidate ends up running. Pinned rather
    // than derived, so growing the snapshot has to be decided twice.
    expect(task.requestSnapshot).toBe('{"input":{"prompt":"Shot 1: a rainy night market"}}')

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
    // row already carries its checksum. The key is written last, after input.
    expect(task.requestSnapshot).toBe(`{"input":{"prompt":"Shot 1: a rainy night market"},"referenceArtifacts":[{"type":"first_frame","artifactId":"${frame.artifactId}"}]}`)

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

  it('cuts the clip on the older frame when the newest one came back from review', async () => {
    const seed = await env.seed({ storyboards: 2 })
    const [refused, onlyFrame] = seed.storyboardIds as [string, string]
    await approveScript(seed)
    const t2v = await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    const i2v = await bindVideoSlot(seed, 'VIDEO_I2V', 'mock-i2v')
    const approved = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: refused, version: 1 })
    const rejected = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: refused, version: 2 })
    const alsoRejected = await env.attachSucceededMedia(seed, { stage: 'FIRST_FRAME', modality: 'image', storyboardId: onlyFrame, version: 1 })
    await stampFrame(approved.artifactId, FRAME_AGED)
    await stampFrame(rejected.artifactId, FRAME_LATEST)
    await stampFrame(alsoRejected.artifactId, FRAME_LATEST)
    await verdictOnFrame(rejected.artifactId, 'NEEDS_REVIEW')
    await verdictOnFrame(alsoRejected.artifactId, 'NEEDS_REVIEW')

    const batchId = await planVideo(seed)
    const tasks = await plannedTasks(batchId)
    expect(tasks.get(refused)!.requestSnapshot).toContain(approved.artifactId)
    // A shot whose one and only frame is out for review is planned as a frameless one: the
    // conditioning model would be refused the frame it requires, so it is not offered.
    expect(tasks.get(onlyFrame)!.requestSnapshot).toBe('{"input":{"prompt":"Shot 2: a rainy night market"}}')

    const queued = new Map((await env.takeWaitingRunTasks()).map(payload => [payload.taskId, payload]))
    expect(queued.get(tasks.get(refused)!.id)?.candidates).toEqual([i2v, t2v])
    expect(queued.get(tasks.get(onlyFrame)!.id)?.candidates).toEqual([t2v])

    const deps = env.deps({ qcMode: 'pass', pollIntervalMs: 10 })
    await runTask(queued.get(tasks.get(refused)!.id)!, deps)
    await runTask(queued.get(tasks.get(onlyFrame)!.id)!, deps)

    // Both shots are still produced: a review on a frame is never a reason to lose a clip.
    const conditioned = await env.db.generationTask.findUniqueOrThrow({ where: { id: tasks.get(refused)!.id } })
    expect(conditioned.status).toBe('SUCCEEDED')
    expect(conditioned.model).toBe('mock-i2v')
    const response = JSON.parse(conditioned.responseSnapshot!) as { providerTaskId: string; artifactUrl: string; reference?: unknown[] }
    expect(response.reference).toEqual([{ model: 'mock-i2v', conditioned: true }])
    expect(response.artifactUrl).toBe(`mock://artifacts/${response.providerTaskId}/i2v?refs=first_frame`)

    const fromText = await env.db.generationTask.findUniqueOrThrow({ where: { id: tasks.get(onlyFrame)!.id } })
    expect(fromText.status).toBe('SUCCEEDED')
    expect(fromText.model).toBe('mock-t2v')
    const fallback = JSON.parse(fromText.responseSnapshot!) as { providerTaskId: string; artifactUrl: string; reference?: Record<string, unknown> }
    expect(fallback.reference).toBeUndefined()
    expect(fallback.artifactUrl).toBe(`mock://artifacts/${fallback.providerTaskId}/t2v`)
  })

  it('offers a shot with no frame no model that would be refused one', async () => {
    const seed = await env.seed()
    await approveScript(seed)
    const t2v = await bindVideoSlot(seed, 'VIDEO_T2V', 'mock-t2v')
    await bindVideoSlot(seed, 'VIDEO_I2V', 'mock-i2v')

    const batchId = await planVideo(seed)
    const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId } })

    expect(task.requestSnapshot).toBe('{"input":{"prompt":"Shot 1: a rainy night market"}}')
    const queued = await env.takeWaitingRunTasks()
    // An i2v call with no frame is refused by every vendor that takes frames, so offering it
    // would spend an attempt on a request that cannot answer.
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
    expect(submitted.mock.calls[0]![1].input).toEqual({ prompt: 'Shot 1: a rainy night market' })

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
