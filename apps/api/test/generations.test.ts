import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPipelineQueue, type ComposeEpisodePayload, type RunTaskPayload } from '@studio/jobs'
import { startTestEnv, type TestEnv } from './env.js'

// The api suite shares the Redis instance with the worker suite; a private
// logical database keeps these queued jobs away from another suite's worker.
const ambientEnv = {
  REDIS_URL: process.env.REDIS_URL,
}
process.env.REDIS_URL = 'redis://127.0.0.1:6380/7'

function restoreEnv(key: keyof typeof ambientEnv): void {
  const value = ambientEnv[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

let env: TestEnv
let queue: ReturnType<typeof createPipelineQueue>

let ownerToken: string
let editorToken: string
let viewerToken: string
let organizationId: string
let projectId: string
let episodeId: string
let storyboardIds: string[] = []
let scriptBatchId: string
let scriptTaskId: string
let videoTaskId: string

interface ArtifactDto {
  id: string
  mimeType: string
  objectKey: string
  width: number | null
  height: number | null
  durationMs: number | null
  downloadUrl: string
}

interface TaskDto {
  id: string
  stage: string
  status: string
  attempts: number
  provider: string | null
  model: string | null
  error: string | null
  createdAt: string
  updatedAt: string
  artifacts: ArtifactDto[]
  qc: { kind: string; score: number; status: string } | null
}

interface BatchDto {
  id: string
  stage: string
  status: string
  plannedCount: number
  createdAt: string
  tasks: TaskDto[]
}

interface CompositionDto {
  id: string
  status: string
  artifact: ArtifactDto | null
}

interface Connection {
  id: string
  capabilities: { id: string; model: string }[]
}

beforeAll(async () => {
  env = await startTestEnv()
  queue = createPipelineQueue()

  const owner = await env.register('gen-owner@example.com', 'Generation Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
  await env.register('gen-editor@example.com', 'Generation Editor Org')
  await env.register('gen-viewer@example.com', 'Generation Viewer Org')
  for (const [email, role] of [['gen-editor@example.com', 'EDITOR'], ['gen-viewer@example.com', 'VIEWER']] as const) {
    const added = await env.app.inject({ method: 'POST', url: '/members', headers: env.authHeaders(ownerToken), payload: { email, role } })
    expect(added.statusCode).toBe(201)
    const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123', organizationId } })
    expect(login.statusCode).toBe(200)
    if (role === 'EDITOR') editorToken = login.json().token as string
    else viewerToken = login.json().token as string
  }

  const project = await env.app.inject({ method: 'POST', url: '/projects', headers: env.authHeaders(ownerToken), payload: { name: 'Generation Drama' } })
  expect(project.statusCode).toBe(201)
  projectId = project.json().id as string

  const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: env.authHeaders(ownerToken), payload: { number: 1, title: 'EP1' } })
  expect(episode.statusCode).toBe(201)
  episodeId = episode.json().id as string

  for (const [number, title, description] of [[1, 'SB1', 'Opening scene'], [2, 'SB2', 'Chase scene']] as const) {
    const storyboard = await env.app.inject({
      method: 'POST', url: `/episodes/${episodeId}/storyboards`, headers: env.authHeaders(ownerToken),
      payload: { number, title, durationMs: 8000, description, sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(storyboard.statusCode).toBe(201)
    storyboardIds.push(storyboard.json().id as string)
  }

  const connection = await env.app.inject({ method: 'POST', url: '/providers/connections', headers: env.authHeaders(ownerToken), payload: { provider: 'mock', name: 'gen-main', apiKey: 'test-key' } })
  expect(connection.statusCode).toBe(201)
  const capabilities = (connection.json() as Connection).capabilities
  const probe = await env.app.inject({ method: 'POST', url: `/providers/connections/${(connection.json() as Connection).id}/probe`, headers: env.authHeaders(ownerToken) })
  expect(probe.statusCode).toBe(200)
  for (const [slot, model] of [['script_text', 'mock-text'], ['video_t2v', 'mock-t2v']] as const) {
    const binding = await env.app.inject({
      method: 'POST', url: '/bindings', headers: env.authHeaders(ownerToken),
      payload: { slot, capabilityId: capabilities.find(capability => capability.model === model)!.id },
    })
    expect(binding.statusCode).toBe(201)
  }
}, 300_000)

afterAll(async () => {
  for (const key of Object.keys(ambientEnv) as (keyof typeof ambientEnv)[]) restoreEnv(key)
  if (queue) {
    // No worker consumes this suite's jobs, so drop them instead of leaving them
    // queued in the shared Redis instance.
    await queue.obliterate({ force: true }).catch(() => undefined)
    await queue.close()
  }
  await env?.stop()
})

const authHeaders = (token: string) => env.authHeaders(token)

describe('generation trigger', () => {
  it('refuses viewers and unknown episodes', async () => {
    const forbidden = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/generations`, headers: authHeaders(viewerToken), payload: { stage: 'SCRIPT' } })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toMatch(/generation:trigger/)

    const missing = await env.app.inject({ method: 'POST', url: '/episodes/does-not-exist/generations', headers: authHeaders(editorToken), payload: { stage: 'SCRIPT' } })
    expect(missing.statusCode).toBe(404)

    const badStage = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'DELIVERY' } })
    expect(badStage.statusCode).toBe(400)
  })

  it('creates one batch and one queued task for an episode-level stage, and enqueues the job', async () => {
    const sourceContent = '原小说：雨夜的滨江老城区，一桩离奇失踪案。'
    await env.db.sourceDocumentVersion.create({ data: { episodeId, version: 1, content: sourceContent, checksum: 'src-ep1', status: 'APPROVED' } })

    const res = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'SCRIPT' } })
    expect(res.statusCode).toBe(201)
    const batch = res.json().batch as BatchDto
    expect(batch.stage).toBe('SCRIPT')
    expect(batch.plannedCount).toBe(1)
    // Derived from the queued task, not left at the DRAFT column default.
    expect(batch.status).toBe('RUNNING')
    expect(batch.tasks).toHaveLength(1)
    const task = batch.tasks[0]
    expect(task.stage).toBe('SCRIPT')
    expect(task.status).toBe('QUEUED')
    expect(task.attempts).toBe(0)
    expect(task.provider).toBeNull()
    expect(task.artifacts).toEqual([])
    expect(task.qc).toBeNull()
    scriptBatchId = batch.id
    scriptTaskId = task.id

    const job = await queue.getJob(`run-${task.id}-1`)
    expect(job?.name).toBe('run-task')
    const payload = job?.data as RunTaskPayload
    expect(payload).toMatchObject({ kind: 'run-task', taskId: task.id, organizationId, attempt: 1 })
    expect(payload.candidates.map(candidate => [candidate.provider, candidate.model])).toEqual([['mock', 'mock-text']])
    expect(payload.candidates[0].connectionId).toBeTruthy()
    expect(payload.candidates[0].capabilityId).toBeTruthy()

    const stored = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(stored.stage).toBe('SCRIPT')
    expect(stored.idempotencyKey).toBe(`${episodeId}:SCRIPT:${episodeId}`)
    expect(JSON.parse(stored.requestSnapshot ?? '')).toEqual({ input: { prompt: `根据以下源文档，写出这一集的完整拍摄剧本：\n\n${sourceContent}` } })
  })

  it('fans a storyboard stage out over the requested storyboards only', async () => {
    const res = await env.app.inject({
      method: 'POST', url: `/episodes/${episodeId}/generations`, headers: authHeaders(editorToken),
      payload: { stage: 'VIDEO', storyboardIds: [storyboardIds[1]] },
    })
    expect(res.statusCode).toBe(201)
    const batch = res.json().batch as BatchDto
    expect(batch.stage).toBe('VIDEO')
    expect(batch.plannedCount).toBe(1)
    videoTaskId = batch.tasks[0].id

    const job = await queue.getJob(`run-${videoTaskId}-1`)
    const payload = job?.data as RunTaskPayload
    expect(payload.candidates.map(candidate => candidate.model)).toEqual(['mock-t2v'])

    const stored = await env.db.generationTask.findUniqueOrThrow({ where: { id: videoTaskId } })
    expect(stored.idempotencyKey).toBe(`${episodeId}:VIDEO:${storyboardIds[1]}`)
    expect(JSON.parse(stored.requestSnapshot ?? '')).toEqual({ input: { prompt: 'SB2: Chase scene' } })

    // The composition worker finds each clip through the batch → storyboards link.
    const linked = await env.db.generationBatch.findUniqueOrThrow({ where: { id: batch.id }, include: { storyboards: true } })
    expect(linked.storyboards.map(storyboard => storyboard.id)).toEqual([storyboardIds[1]])

    const foreign = await env.app.inject({
      method: 'POST', url: `/episodes/${episodeId}/generations`, headers: authHeaders(editorToken),
      payload: { stage: 'VIDEO', storyboardIds: ['not-this-episode'] },
    })
    expect(foreign.statusCode).toBe(400)
  })

  it('returns the existing batch on a duplicate submit', async () => {
    const res = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'SCRIPT' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().batch.id).toBe(scriptBatchId)
    expect(await env.db.generationTask.count({ where: { batchId: scriptBatchId } })).toBe(1)
    expect(await env.db.generationBatch.count({ where: { episodeId } })).toBe(2)
  })

  it('rejects a stage whose slot has no verified binding', async () => {
    for (const stage of ['IMAGE', 'AUDIO']) {
      const res = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage } })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/no verified candidates for slot/)
    }
    expect(await env.db.generationBatch.count({ where: { episodeId } })).toBe(2)
  })
})

describe('generation listing', () => {
  it('lists batches with tasks that have no artifacts or quality checks yet', async () => {
    const res = await env.app.inject({ method: 'GET', url: `/episodes/${episodeId}/generations`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { batches: BatchDto[]; composition: CompositionDto | null }
    expect(body.composition).toBeNull()
    expect(body.batches.map(batch => batch.stage).sort()).toEqual(['SCRIPT', 'VIDEO'])
    for (const batch of body.batches) {
      expect(batch.tasks).toHaveLength(1)
      for (const task of batch.tasks) {
        expect(task.artifacts).toEqual([])
        expect(task.qc).toBeNull()
        expect(task.error).toBeNull()
        expect(task.createdAt).toBeTruthy()
      }
    }

    const missing = await env.app.inject({ method: 'GET', url: '/episodes/does-not-exist/generations', headers: authHeaders(viewerToken) })
    expect(missing.statusCode).toBe(404)
  })
})

describe('task cancellation', () => {
  it('cancels a queued task once and refuses a second cancel', async () => {
    const forbidden = await env.app.inject({ method: 'POST', url: `/generations/tasks/${videoTaskId}/cancel`, headers: authHeaders(viewerToken) })
    expect(forbidden.statusCode).toBe(403)

    const res = await env.app.inject({ method: 'POST', url: `/generations/tasks/${scriptTaskId}/cancel`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(200)
    expect((res.json().task as TaskDto).status).toBe('CANCELLED')
    const stored = await env.db.generationTask.findUniqueOrThrow({ where: { id: scriptTaskId } })
    expect(stored.status).toBe('CANCELLED')

    const again = await env.app.inject({ method: 'POST', url: `/generations/tasks/${scriptTaskId}/cancel`, headers: authHeaders(editorToken) })
    expect(again.statusCode).toBe(409)

    const missing = await env.app.inject({ method: 'POST', url: '/generations/tasks/does-not-exist/cancel', headers: authHeaders(editorToken) })
    expect(missing.statusCode).toBe(404)
  })
})

describe('artifact content', () => {
  it('streams stored bytes with their mime type and 404s on a missing file', async () => {
    const objectKey = `${organizationId}/${projectId}/${episodeId}/video/${storyboardIds[0]}/v1.png`
    const bytes = Buffer.from('mock png bytes')
    await env.app.storage.put(objectKey, bytes, 'image/png')

    const artifact = await env.db.mediaArtifact.create({
      data: { organizationId, taskId: videoTaskId, stage: 'VIDEO', objectKey, checksum: 'checksum-1', mimeType: 'image/png', version: 1, width: 320, height: 240 },
    })
    const res = await env.app.inject({ method: 'GET', url: `/artifacts/${artifact.id}/content`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['content-length']).toBe(String(bytes.length))
    expect(res.rawPayload.equals(bytes)).toBe(true)

    const missing = await env.db.mediaArtifact.create({
      data: { organizationId, objectKey: `${organizationId}/gone/v1.mp4`, checksum: 'checksum-2', mimeType: 'video/mp4', version: 1 },
    })
    expect((await env.app.inject({ method: 'GET', url: `/artifacts/${missing.id}/content`, headers: authHeaders(viewerToken) })).statusCode).toBe(404)

    const foreign = await env.db.mediaArtifact.create({
      data: { organizationId: 'another-org', objectKey, checksum: 'checksum-3', mimeType: 'image/png', version: 2 },
    })
    expect((await env.app.inject({ method: 'GET', url: `/artifacts/${foreign.id}/content`, headers: authHeaders(viewerToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'GET', url: '/artifacts/does-not-exist/content', headers: authHeaders(viewerToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'GET', url: `/artifacts/${artifact.id}/content` })).statusCode).toBe(401)
  })

  it('surfaces artifacts and their latest quality check through the batch DTO', async () => {
    const artifact = await env.db.mediaArtifact.findFirstOrThrow({ where: { organizationId, taskId: videoTaskId } })
    for (const [kind, score] of [['visual', 0.4], ['visual', 0.9]] as const) {
      await env.db.qualityCheck.create({ data: { status: 'COMPLETED', kind, score, report: '{}', artifactId: artifact.id, batchId: null } })
    }
    const res = await env.app.inject({ method: 'GET', url: `/episodes/${episodeId}/generations`, headers: authHeaders(viewerToken) })
    const body = res.json() as { batches: BatchDto[] }
    const task = body.batches.flatMap(batch => batch.tasks).find(candidate => candidate.id === videoTaskId)!
    expect(task.artifacts).toEqual([{
      id: artifact.id,
      mimeType: 'image/png',
      objectKey: artifact.objectKey,
      width: 320,
      height: 240,
      durationMs: null,
      downloadUrl: `/artifacts/${artifact.id}/content`,
    }])
    expect(task.qc).toEqual({ kind: 'visual', score: 0.9, status: 'COMPLETED' })
  })
})

describe('episode composition', () => {
  it('creates a running composition and enqueues the compose job', async () => {
    const forbidden = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/compositions`, headers: authHeaders(viewerToken) })
    expect(forbidden.statusCode).toBe(403)

    const res = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/compositions`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(201)
    const composition = res.json().composition as CompositionDto
    expect(composition.status).toBe('RUNNING')
    expect(composition.artifact).toBeNull()

    const job = await queue.getJob(`compose-${composition.id}`)
    expect(job?.name).toBe('compose-episode')
    expect(job?.data as ComposeEpisodePayload).toMatchObject({ kind: 'compose-episode', compositionId: composition.id, episodeId, organizationId })

    const stored = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(JSON.parse(stored.manifest)).toEqual({ storyboardIds })

    const listed = await env.app.inject({ method: 'GET', url: `/episodes/${episodeId}/generations`, headers: authHeaders(viewerToken) })
    expect((listed.json() as { composition: CompositionDto | null }).composition?.id).toBe(composition.id)
  })

  it('records trigger, cancel and composition events in the audit trail', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/audit-events', headers: authHeaders(ownerToken) })
    expect(res.statusCode).toBe(200)
    const events = res.json().events as { action: string; entityType: string }[]
    expect(events.some(event => event.action === 'generation.trigger' && event.entityType === 'generation-batch')).toBe(true)
    expect(events.some(event => event.action === 'generation.cancel')).toBe(true)
    expect(events.some(event => event.action === 'composition.trigger')).toBe(true)
  })
})

// The trigger route resolves candidates with its own copy of the ordering and
// filtering rules behind GET /bindings/resolve. These pin that copy from the
// generation side, on fresh episodes so the shared-episode assertions above hold.
describe('generation candidate resolution', () => {
  async function newEpisode(name: string): Promise<{ projectId: string; episodeId: string }> {
    const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: `${name} EP1` } })
    expect(episode.statusCode).toBe(201)
    return { projectId, episodeId: episode.json().id as string }
  }

  async function addStoryboard(targetEpisodeId: string): Promise<void> {
    const storyboard = await env.app.inject({
      method: 'POST', url: `/episodes/${targetEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 1, title: 'SB1', durationMs: 5000, description: 'Rooftop chase', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(storyboard.statusCode).toBe(201)
  }

  async function newConnection(name: string): Promise<Connection> {
    const created = await env.app.inject({ method: 'POST', url: '/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name, apiKey: 'test-key' } })
    expect(created.statusCode).toBe(201)
    const connection = created.json() as Connection
    const probe = await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    return connection
  }

  async function bindSlot(slot: string, capabilityId: string, scope?: string, priority = 0): Promise<void> {
    const binding = await env.app.inject({ method: 'POST', url: '/bindings', headers: authHeaders(ownerToken), payload: { slot, capabilityId, projectId: scope, priority } })
    expect(binding.statusCode).toBe(201)
  }

  const capabilityOf = (connection: Connection, model: string) => connection.capabilities.find(capability => capability.model === model)!.id

  it('enqueues project scope first, priority descending within a scope, deduplicated by capability', async () => {
    const { projectId, episodeId: freshEpisodeId } = await newEpisode('Resolve Order Drama')
    await addStoryboard(freshEpisodeId)
    const first = await newConnection('order-first')
    const second = await newConnection('order-second')
    const scoped = await newConnection('order-scoped')
    const image = (connection: Connection) => capabilityOf(connection, 'mock-image')
    // image_gen is unbound in beforeAll, so these four are the whole candidate pool.
    await bindSlot('image_gen', image(scoped), projectId, 1)
    await bindSlot('image_gen', image(scoped), undefined, 9)
    await bindSlot('image_gen', image(first), undefined, 5)
    await bindSlot('image_gen', image(second), undefined, 0)

    const res = await env.app.inject({ method: 'POST', url: `/episodes/${freshEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'IMAGE' } })
    expect(res.statusCode).toBe(201)
    const task = (res.json().batch as BatchDto).tasks[0]
    const payload = (await queue.getJob(`run-${task.id}-1`))?.data as RunTaskPayload
    // The project-scoped binding wins despite priority 1, its org-scoped twin is
    // dropped as a duplicate capability, then org scope follows in priority order.
    expect(payload.candidates.map(candidate => [candidate.connectionId, candidate.capabilityId])).toEqual([
      [scoped.id, image(scoped)],
      [first.id, image(first)],
      [second.id, image(second)],
    ])
    expect(payload.candidates.every(candidate => candidate.provider === 'mock' && candidate.model === 'mock-image')).toBe(true)
  })

  it('refuses a stage whose only candidate lost its connection or its entitlement', async () => {
    const { episodeId: connectionEpisodeId } = await newEpisode('Resolve Disabled Drama')
    await addStoryboard(connectionEpisodeId)
    const connection = await newConnection('filter-gen')
    await bindSlot('image_gen', capabilityOf(connection, 'mock-image'))
    await bindSlot('tts_voice', capabilityOf(connection, 'mock-tts'))

    const whileEnabled = await env.app.inject({ method: 'POST', url: `/episodes/${connectionEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'IMAGE' } })
    expect(whileEnabled.statusCode).toBe(201)

    const disabled = await env.app.inject({ method: 'PATCH', url: `/providers/connections/${connection.id}`, headers: authHeaders(ownerToken), payload: { enabled: false } })
    expect(disabled.statusCode).toBe(200)
    // A different stage on the same episode, so the idempotency key cannot mask the 409.
    const afterDisable = await env.app.inject({ method: 'POST', url: `/episodes/${connectionEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'AUDIO' } })
    expect(afterDisable.statusCode).toBe(409)
    expect(afterDisable.json().error).toBe('no verified candidates for slot tts_voice')

    const { episodeId: entitlementEpisodeId } = await newEpisode('Resolve Unverified Drama')
    await env.db.scriptVersion.create({ data: { episodeId: entitlementEpisodeId, version: 1, content: 'a script', checksum: 'resolve-unverified', status: 'APPROVED' } })
    const unverifiedConnection = await newConnection('filter-stale-gen')
    const capabilityId = capabilityOf(unverifiedConnection, 'mock-text')
    await bindSlot('storyboard_text', capabilityId)
    await env.db.modelCapability.update({ where: { id: capabilityId }, data: { entitlementVerifiedAt: null } })

    const afterRevoke = await env.app.inject({ method: 'POST', url: `/episodes/${entitlementEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'STORYBOARD' } })
    expect(afterRevoke.statusCode).toBe(409)
    expect(afterRevoke.json().error).toBe('no verified candidates for slot storyboard_text')
  })
})

describe('asset generation trigger', () => {
  async function newEpisode(name: string): Promise<{ projectId: string; episodeId: string }> {
    const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: `${name} EP1` } })
    expect(episode.statusCode).toBe(201)
    return { projectId, episodeId: episode.json().id as string }
  }

  async function newConnection(name: string): Promise<Connection> {
    const created = await env.app.inject({ method: 'POST', url: '/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name, apiKey: 'test-key' } })
    expect(created.statusCode).toBe(201)
    const connection = created.json() as Connection
    const probe = await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    return connection
  }

  async function bindSlot(slot: string, capabilityId: string, scope?: string, priority = 0): Promise<void> {
    const binding = await env.app.inject({ method: 'POST', url: '/bindings', headers: authHeaders(ownerToken), payload: { slot, capabilityId, projectId: scope, priority } })
    expect(binding.statusCode).toBe(201)
  }

  const capabilityOf = (connection: Connection, model: string) => connection.capabilities.find(capability => capability.model === model)!.id

  let assetProjectId: string
  let assetEpisodeId: string
  let assetBatchId: string
  const assetIds: string[] = []
  const assetSeeds = [
    { kind: 'character', name: '小雨', description: '雨夜中撑伞的少女' },
    { kind: 'prop', name: '黑伞', description: '一把旧黑伞' },
  ]

  it('plans one image task per asset and enqueues each with the bound image candidate', async () => {
    const { projectId, episodeId } = await newEpisode('Asset Drama')
    assetProjectId = projectId
    assetEpisodeId = episodeId
    const connection = await newConnection('asset-gen')
    // Project-scoped: earlier tests pin the org-scoped image_gen candidate pool.
    await bindSlot('image_gen', capabilityOf(connection, 'mock-image'), projectId)

    for (const seed of assetSeeds) {
      const created = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/assets`, headers: authHeaders(editorToken), payload: seed })
      expect(created.statusCode).toBe(201)
      assetIds.push(created.json().asset.id as string)
    }

    const res = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'ASSET' } })
    expect(res.statusCode).toBe(201)
    const batch = res.json().batch as BatchDto
    expect(batch.stage).toBe('ASSET')
    expect(batch.status).toBe('RUNNING')
    expect(batch.plannedCount).toBe(2)
    expect(batch.tasks).toHaveLength(2)
    assetBatchId = batch.id

    for (const task of batch.tasks) {
      expect(task.stage).toBe('ASSET')
      expect(task.status).toBe('QUEUED')
      const payload = (await queue.getJob(`run-${task.id}-1`))?.data as RunTaskPayload
      expect(payload).toMatchObject({ kind: 'run-task', taskId: task.id, organizationId, attempt: 1 })
      expect(payload.candidates[0]).toMatchObject({ connectionId: connection.id, capabilityId: capabilityOf(connection, 'mock-image'), provider: 'mock', model: 'mock-image' })
      expect(payload.candidates.every(candidate => candidate.provider === 'mock' && candidate.model === 'mock-image')).toBe(true)
    }

    const stored = await env.db.generationTask.findMany({ where: { batchId: batch.id } })
    expect(stored).toHaveLength(2)
    for (const [index, assetId] of assetIds.entries()) {
      const task = stored.find(candidate => candidate.idempotencyKey === `${episodeId}:ASSET:${assetId}`)
      expect(task).toBeTruthy()
      expect(task!.stage).toBe('ASSET')
      const seed = assetSeeds[index]
      expect(JSON.parse(task!.requestSnapshot ?? '')).toEqual({ input: { prompt: `${seed.kind} ${seed.name}: ${seed.description}` }, assetId })
    }

    // A per-asset batch connects no storyboards.
    const linked = await env.db.generationBatch.findUniqueOrThrow({ where: { id: batch.id }, include: { storyboards: true } })
    expect(linked.storyboards).toEqual([])
  })

  it('returns the existing batch on a duplicate asset trigger', async () => {
    const res = await env.app.inject({ method: 'POST', url: `/episodes/${assetEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'ASSET' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().batch.id).toBe(assetBatchId)
    expect(await env.db.generationTask.count({ where: { batchId: assetBatchId } })).toBe(2)
  })

  it('refuses viewers and episodes without assets', async () => {
    const forbidden = await env.app.inject({ method: 'POST', url: `/episodes/${assetEpisodeId}/generations`, headers: authHeaders(viewerToken), payload: { stage: 'ASSET' } })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toMatch(/generation:trigger/)

    const empty = await env.app.inject({ method: 'POST', url: `/projects/${assetProjectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 2, title: 'Asset Drama EP2' } })
    expect(empty.statusCode).toBe(201)
    const res = await env.app.inject({ method: 'POST', url: `/episodes/${empty.json().id as string}/generations`, headers: authHeaders(editorToken), payload: { stage: 'ASSET' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'episode has no assets to generate' })
  })
})

describe('storyboard media', () => {
  it('exposes each storyboard\'s latest succeeded first-frame and video, and null when absent', async () => {
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 7, title: 'Media EP' } })
    expect(episode.statusCode).toBe(201)
    const mediaEpisodeId = episode.json().id as string

    const storyboardIdsLocal: string[] = []
    for (const [number, title] of [[1, 'Media SB1'], [2, 'Media SB2']] as const) {
      const created = await env.app.inject({
        method: 'POST', url: `/episodes/${mediaEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
        payload: { number, title, durationMs: 5000, description: 'a quiet street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
      })
      expect(created.statusCode).toBe(201)
      storyboardIdsLocal.push(created.json().id as string)
    }
    const [withMedia, withoutMedia] = storyboardIdsLocal

    const batch = await env.db.generationBatch.create({ data: { organizationId, episodeId: mediaEpisodeId, stage: 'FIRST_FRAME', status: 'COMPLETED', plannedCount: 1 } })
    const firstFrameTask = await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage: 'FIRST_FRAME', status: 'SUCCEEDED', idempotencyKey: `${mediaEpisodeId}:IMAGE:${withMedia}` },
    })
    const firstFrame = await env.db.mediaArtifact.create({
      data: { organizationId, taskId: firstFrameTask.id, stage: 'FIRST_FRAME', objectKey: `${organizationId}/media-ep/ff/v1.png`, checksum: 'ff-1', mimeType: 'image/png', version: 1, width: 320, height: 240 },
    })
    const videoTask = await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage: 'VIDEO', status: 'SUCCEEDED', idempotencyKey: `${mediaEpisodeId}:VIDEO:${withMedia}` },
    })
    const video = await env.db.mediaArtifact.create({
      data: { organizationId, taskId: videoTask.id, stage: 'VIDEO', objectKey: `${organizationId}/media-ep/video/v1.mp4`, checksum: 'v-1', mimeType: 'video/mp4', version: 1, durationMs: 5000 },
    })

    const res = await env.app.inject({ method: 'GET', url: `/episodes/${mediaEpisodeId}/storyboards`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ id: string; firstFrame: ArtifactDto | null; video: ArtifactDto | null }>
    const populated = rows.find(row => row.id === withMedia)!
    expect(populated.firstFrame).toMatchObject({ id: firstFrame.id, mimeType: 'image/png', downloadUrl: `/artifacts/${firstFrame.id}/content` })
    expect(populated.video).toMatchObject({ id: video.id, mimeType: 'video/mp4', downloadUrl: `/artifacts/${video.id}/content` })
    const bare = rows.find(row => row.id === withoutMedia)!
    expect(bare.firstFrame).toBeNull()
    expect(bare.video).toBeNull()
  })
})

describe('AI content stage gating', () => {
  it('refuses SCRIPT generation without an approved source', async () => {
    const ep = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 20, title: 'No Source EP' } })
    const epId = ep.json().id as string
    const res = await env.app.inject({ method: 'POST', url: `/episodes/${epId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'SCRIPT' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('generations:noApprovedSource')
  })

  it('refuses STORYBOARD generation without an approved script', async () => {
    const ep = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 21, title: 'No Script EP' } })
    const epId = ep.json().id as string
    await env.db.sourceDocumentVersion.create({ data: { episodeId: epId, version: 1, content: 'a source', checksum: 'gate-src', status: 'APPROVED' } })
    const res = await env.app.inject({ method: 'POST', url: `/episodes/${epId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'STORYBOARD' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('generations:noApprovedScript')
  })

  it('links generated storyboards to the approved script in the request snapshot', async () => {
    const capability = await env.db.modelCapability.findFirstOrThrow({ where: { model: 'mock-text', connection: { organizationId } } })
    await env.app.inject({ method: 'POST', url: '/bindings', headers: authHeaders(ownerToken), payload: { slot: 'storyboard_text', capabilityId: capability.id } })

    const ep = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 22, title: 'Script EP' } })
    const epId = ep.json().id as string
    const script = await env.db.scriptVersion.create({ data: { episodeId: epId, version: 1, content: 'the approved script', checksum: 'gate-script', status: 'APPROVED' } })

    const res = await env.app.inject({ method: 'POST', url: `/episodes/${epId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'STORYBOARD' } })
    expect(res.statusCode).toBe(201)
    const batch = res.json().batch as BatchDto
    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: batch.tasks[0].id } })
    const snapshot = JSON.parse(task.requestSnapshot ?? '') as { input: { prompt: string }; scriptVersionId?: string }
    expect(snapshot.scriptVersionId).toBe(script.id)
    expect(snapshot.input.prompt).toContain('the approved script')
  })
})
