import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MOCK_SCRIPT_TEXT, MOCK_STORYBOARD_JSON, MOCK_VLM_VERDICT } from '@studio/providers'
import { encryptSecret } from '@studio/security'
import { composeEpisode } from '../src/compose.js'
import type { QualityChecker } from '../src/qc.js'
import { runTask } from '../src/run-task.js'
import { ModelQualityChecker } from '../src/visual-audit.js'
import { MASTER_KEY, startTestEnv, type Seed, type WorkerTestEnv } from './env.js'

// The mock auditor's fixed answer, read rather than restated so a change to it
// moves these assertions instead of silently invalidating them.
const MOCK_VLM_SCORE = (JSON.parse(MOCK_VLM_VERDICT) as { score: number }).score

let env: WorkerTestEnv

beforeAll(async () => {
  env = await startTestEnv()
}, 300_000)

beforeEach(async () => {
  await env.drain()
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
      checker: checker ?? new ModelQualityChecker({ db: env.db, masterKey: MASTER_KEY, pollIntervalMs: 10 }),
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
})

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

    const shots = JSON.parse(MOCK_STORYBOARD_JSON) as Array<{ title: string; description: string }>
    const boards = await env.db.storyboard.findMany({ where: { episodeId: seed.episodeId }, orderBy: { number: 'asc' } })
    expect(boards).toHaveLength(shots.length)
    expect(boards[0]!.number).toBe(1)
    expect(boards[0]!.title).toBe(shots[0]!.title)
    expect(boards[0]!.description).toBe(shots[0]!.description)
    expect(boards[0]!.scriptVersionId).toBe(script.id)
    expect(boards[0]!.status).toBe('DRAFT')
  })

  it('fails the task when the storyboard output is not parseable', async () => {
    const seed = await env.seed({ model: 'mock-text', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('FAILED')
    expect(await env.db.storyboard.count({ where: { episodeId: seed.episodeId } })).toBe(0)
  })
})

describe('auto-advance', () => {
  /**
   * Binds a verified mock image model to the `image_gen` slot so an auto-advance
   * into IMAGE can resolve a candidate. Like `bindVisualAudit`, the entitlement has
   * to be verified explicitly — `env.seed` leaves it null and an unverified
   * capability is filtered out of candidate resolution.
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

  it('relays a completed storyboard batch into an IMAGE batch', async () => {
    const seed = await env.seed({ model: 'mock-storyboard', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    // IMAGE is gated on an approved script and resolves its own image_gen candidate.
    await env.db.scriptVersion.create({ data: { episodeId: seed.episodeId, version: 1, content: 'the approved script', checksum: 'advance-script', status: 'APPROVED' } })
    await bindImageGen(seed)

    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')

    // The storyboard task wrote its shots, which rolled the batch to COMPLETED and
    // auto-advanced the pipeline into IMAGE.
    const shots = JSON.parse(MOCK_STORYBOARD_JSON) as unknown[]
    const boards = await env.db.storyboard.findMany({ where: { episodeId: seed.episodeId } })
    expect(boards).toHaveLength(shots.length)

    const imageBatch = await env.db.generationBatch.findFirstOrThrow({ where: { episodeId: seed.episodeId, stage: 'FIRST_FRAME' } })
    expect(imageBatch.plannedCount).toBe(shots.length)
    expect(imageBatch.status).toBe('RUNNING')

    // One IMAGE run-task job was enqueued per storyboard, each carrying the image candidate.
    const queued = await env.takeWaitingRunTasks()
    expect(queued).toHaveLength(shots.length)
    expect(queued.every(payload => payload.candidates[0]?.model === 'mock-image')).toBe(true)

    // The relay is attributed to the system, not to a user.
    const advance = await env.db.auditEvent.findFirst({ where: { organizationId: seed.organizationId, action: 'pipeline.autoAdvance' } })
    expect(advance).toBeTruthy()
    expect(advance!.entityId).toBe(seed.episodeId)
  })

  it('does not advance when the next stage is gated on a missing approval', async () => {
    // No approved script: STORYBOARD still completes, but IMAGE/VIDEO are gated and
    // SCRIPT has no approved source, so nothing is runnable and nothing is queued.
    const seed = await env.seed({ model: 'mock-storyboard', modality: 'text', stage: 'STORYBOARD', storyboards: 0 })
    await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    expect(task.status).toBe('SUCCEEDED')
    expect(await env.db.generationBatch.count({ where: { episodeId: seed.episodeId, stage: 'FIRST_FRAME' } })).toBe(0)
    expect(await env.takeWaitingRunTasks()).toHaveLength(0)
  })
})
