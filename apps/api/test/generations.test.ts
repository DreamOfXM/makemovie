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
  subtitle: ArtifactDto | null
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
    // The media gate now requires an approved script before any image/video/audio
    // is generated, so the shared episode needs one before this VIDEO trigger.
    await env.db.scriptVersion.create({ data: { episodeId, version: 1, content: 'approved script for media', checksum: 'media-script', status: 'APPROVED' } })
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

    // An audit that could not happen writes a null score. It must stay null: a
    // coerced 0 would render as a red 0%, i.e. a failed judgment nobody made.
    await env.db.qualityCheck.create({
      data: { status: 'NEEDS_REVIEW', kind: 'visual-audit', score: null, report: '{}', artifactId: artifact.id, batchId: null },
    })
    const unjudged = await env.app.inject({ method: 'GET', url: `/episodes/${episodeId}/generations`, headers: authHeaders(viewerToken) })
    const unjudgedTask = (unjudged.json() as { batches: BatchDto[] }).batches
      .flatMap(batch => batch.tasks)
      .find(candidate => candidate.id === videoTaskId)!
    expect(unjudgedTask.qc).toEqual({ kind: 'visual-audit', score: null, status: 'NEEDS_REVIEW' })
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

  it('offers the subtitle track of a finished composition as its own download', async () => {
    // The cues are an artifact rather than a blob on the composition: a subtitle file
    // is reviewed and re-uploaded by a human like any other stage output.
    const master = await env.db.mediaArtifact.create({
      data: { organizationId, stage: 'COMPOSITION', objectKey: `${organizationId}/comp/master/v1.mp4`, checksum: 'comp-master', mimeType: 'video/mp4', version: 1, durationMs: 6000 },
    })
    const cues = '1\n00:00:00,000 --> 00:00:02,000\n这条街不能待了。\n'
    const subtitle = await env.app.storage.put(`${organizationId}/comp/subtitle/v1.srt`, Buffer.from(cues, 'utf8'), 'application/x-subrip')
    const subtitleArtifact = await env.db.mediaArtifact.create({
      data: { organizationId, stage: 'SUBTITLE', objectKey: subtitle.key, checksum: subtitle.checksum, mimeType: subtitle.mimeType, version: 1 },
    })
    const finished = await env.db.composition.create({
      data: { episodeId, status: 'COMPLETED', manifest: JSON.stringify({ storyboardIds }), artifactId: master.id, subtitleArtifactId: subtitleArtifact.id },
    })

    const res = await env.app.inject({ method: 'GET', url: `/episodes/${episodeId}/generations`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    const composition = (res.json() as { composition: CompositionDto | null }).composition!
    expect(composition.id).toBe(finished.id)
    expect(composition.artifact).toMatchObject({ id: master.id, downloadUrl: `/artifacts/${master.id}/content` })
    expect(composition.subtitle).toMatchObject({ id: subtitleArtifact.id, mimeType: 'application/x-subrip', downloadUrl: `/artifacts/${subtitleArtifact.id}/content` })

    const downloaded = await env.app.inject({ method: 'GET', url: `/artifacts/${subtitleArtifact.id}/content`, headers: authHeaders(viewerToken) })
    expect(downloaded.statusCode).toBe(200)
    expect(downloaded.rawPayload.toString('utf8')).toBe(cues)
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
    // IMAGE is gated on an approved script.
    await env.db.scriptVersion.create({ data: { episodeId: freshEpisodeId, version: 1, content: 'a script', checksum: 'resolve-order-script', status: 'APPROVED' } })
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
    // IMAGE and AUDIO are both gated on an approved script.
    await env.db.scriptVersion.create({ data: { episodeId: connectionEpisodeId, version: 1, content: 'a script', checksum: 'resolve-disabled-script', status: 'APPROVED' } })
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
      data: { organizationId, batchId: batch.id, stage: 'FIRST_FRAME', status: 'SUCCEEDED', storyboardId: withMedia, idempotencyKey: `${mediaEpisodeId}:IMAGE:${withMedia}` },
    })
    const firstFrame = await env.db.mediaArtifact.create({
      data: { organizationId, taskId: firstFrameTask.id, stage: 'FIRST_FRAME', objectKey: `${organizationId}/media-ep/ff/v1.png`, checksum: 'ff-1', mimeType: 'image/png', version: 1, width: 320, height: 240 },
    })
    const videoTask = await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage: 'VIDEO', status: 'SUCCEEDED', storyboardId: withMedia, idempotencyKey: `${mediaEpisodeId}:VIDEO:${withMedia}` },
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

  it('prefers the latest revision when a storyboard has been regenerated', async () => {
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 8, title: 'Revision EP' } })
    expect(episode.statusCode).toBe(201)
    const revisionEpisodeId = episode.json().id as string
    const created = await env.app.inject({
      method: 'POST', url: `/episodes/${revisionEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 1, title: 'Rev SB1', durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(created.statusCode).toBe(201)
    const sbId = created.json().id as string

    // A regenerate is a separate batch whose task key carries an ':r1' revision
    // suffix; both tasks point at the same storyboard through their own
    // `storyboardId`. The base is stamped older so the newest revision must win
    // in the media map.
    const baseBatch = await env.db.generationBatch.create({ data: { organizationId, episodeId: revisionEpisodeId, stage: 'FIRST_FRAME', status: 'COMPLETED', plannedCount: 1 } })
    const baseTask = await env.db.generationTask.create({
      data: { organizationId, batchId: baseBatch.id, stage: 'FIRST_FRAME', status: 'SUCCEEDED', storyboardId: sbId, idempotencyKey: `${revisionEpisodeId}:IMAGE:${sbId}`, createdAt: new Date('2024-01-01T00:00:00Z') },
    })
    const baseArtifact = await env.db.mediaArtifact.create({
      data: { organizationId, taskId: baseTask.id, stage: 'FIRST_FRAME', objectKey: `${organizationId}/rev/ff-base.png`, checksum: 'rev-base', mimeType: 'image/png', version: 1, width: 320, height: 240 },
    })
    const regenBatch = await env.db.generationBatch.create({ data: { organizationId, episodeId: revisionEpisodeId, stage: 'FIRST_FRAME', status: 'COMPLETED', plannedCount: 1 } })
    const regenTask = await env.db.generationTask.create({
      data: { organizationId, batchId: regenBatch.id, stage: 'FIRST_FRAME', status: 'SUCCEEDED', storyboardId: sbId, idempotencyKey: `${revisionEpisodeId}:IMAGE:${sbId}:r1`, createdAt: new Date('2024-06-01T00:00:00Z') },
    })
    const regenArtifact = await env.db.mediaArtifact.create({
      data: { organizationId, taskId: regenTask.id, stage: 'FIRST_FRAME', objectKey: `${organizationId}/rev/ff-regen.png`, checksum: 'rev-regen', mimeType: 'image/png', version: 1, width: 320, height: 240 },
    })

    const res = await env.app.inject({ method: 'GET', url: `/episodes/${revisionEpisodeId}/storyboards`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ id: string; firstFrame: ArtifactDto | null }>
    const row = rows.find(candidate => candidate.id === sbId)!
    expect(row.firstFrame).toMatchObject({ id: regenArtifact.id, downloadUrl: `/artifacts/${regenArtifact.id}/content` })
    expect(row.firstFrame?.id).not.toBe(baseArtifact.id)
  })

  it('files a hand-added shot in the live revision and scopes number conflicts to it', async () => {
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 9, title: 'Hand Add EP' } })
    expect(episode.statusCode).toBe(201)
    const handEpisodeId = episode.json().id as string
    const first = await env.app.inject({
      method: 'POST', url: `/episodes/${handEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 1, title: 'Hand SB1', durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(first.statusCode).toBe(201)
    expect(first.json().revision).toBe(1)

    // Simulate a regenerate: revision 1 is archived and revision 2 is the
    // breakdown in use. A shot added by hand now has to land in revision 2, or
    // it sits outside the live list.
    await env.db.storyboard.updateMany({ where: { episodeId: handEpisodeId, revision: 1 }, data: { supersededAt: new Date() } })
    await env.db.storyboard.create({
      data: { episodeId: handEpisodeId, revision: 2, number: 1, title: 'Regen SB1', durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })

    const added = await env.app.inject({
      method: 'POST', url: `/episodes/${handEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 2, title: 'Hand SB2', durationMs: 5000, description: 'an alley', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(added.statusCode).toBe(201)
    expect(added.json().revision).toBe(2)
    expect(added.json().supersededAt).toBeNull()

    // Number 1 is taken in the live revision but free in the archived one, so
    // the conflict is reported against the revision, not the episode.
    const clash = await env.app.inject({
      method: 'POST', url: `/episodes/${handEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 1, title: 'Hand SB1 dup', durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error).toContain('already exists in this revision')

    const live = await env.app.inject({ method: 'GET', url: `/episodes/${handEpisodeId}/storyboards`, headers: authHeaders(viewerToken) })
    const rows = live.json() as Array<{ revision: number; number: number }>
    expect(rows.map(row => `${row.revision}.${row.number}`).sort()).toEqual(['2.1', '2.2'])
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

  it('refuses media stages without an approved script', async () => {
    const ep = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 23, title: 'No Script Media EP' } })
    const epId = ep.json().id as string
    // A storyboard so IMAGE/VIDEO reach the script gate rather than the
    // "no storyboards to generate" 400.
    const sb = await env.app.inject({
      method: 'POST', url: `/episodes/${epId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 1, title: 'SB1', durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(sb.statusCode).toBe(201)
    for (const stage of ['IMAGE', 'VIDEO', 'AUDIO']) {
      const res = await env.app.inject({ method: 'POST', url: `/episodes/${epId}/generations`, headers: authHeaders(editorToken), payload: { stage } })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBe('generations:noApprovedScript')
    }
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

describe('run-pipeline', () => {
  it('refuses when nothing is runnable and advances to SCRIPT once a source is approved', async () => {
    const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(ownerToken), payload: { name: 'Pipeline Drama' } })
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'EP' } })
    const episodeId = episode.json().id as string

    const nothing = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(nothing.statusCode).toBe(409)
    expect(nothing.json().error).toBe('pipeline:nothingRunnable')

    // Approved in the store rather than through the endpoint: an approval request now
    // starts the chain itself, and this test is about the button doing the advancing.
    await env.db.sourceDocumentVersion.create({ data: { episodeId, version: 1, content: 'a source document', checksum: 'pipeline-src', status: 'APPROVED' } })

    const res = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(201)
    expect(res.json().stage).toBe('SCRIPT')
    expect((res.json().batch as BatchDto).stage).toBe('SCRIPT')

    // Clicking again does not buy the same stage twice.
    const again = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('pipeline:nothingRunnable')
  })

  it('advances past IMAGE to VIDEO once first frames already ran', async () => {
    const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(ownerToken), payload: { name: 'Advance Drama' } })
    const advanceProjectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${advanceProjectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'EP' } })
    const advanceEpisodeId = episode.json().id as string
    // An approved script and a storyboard make IMAGE and VIDEO eligible; mark
    // SCRIPT, STORYBOARD and FIRST_FRAME (the DB value for IMAGE) as already run
    // so the next runnable stage is VIDEO, not a re-run of IMAGE.
    await env.db.scriptVersion.create({ data: { episodeId: advanceEpisodeId, version: 1, content: 'a script', checksum: 'advance-script', status: 'APPROVED' } })
    await env.app.inject({
      method: 'POST', url: `/episodes/${advanceEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 1, title: 'SB1', durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    for (const stage of ['SCRIPT', 'STORYBOARD', 'FIRST_FRAME'] as const) {
      await env.db.generationBatch.create({ data: { organizationId, episodeId: advanceEpisodeId, stage, status: 'COMPLETED', plannedCount: 1 } })
    }

    const res = await env.app.inject({ method: 'POST', url: `/episodes/${advanceEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(201)
    expect(res.json().stage).toBe('VIDEO')
  })
})

describe('regenerate', () => {
  it('creates a new revision batch with suffixed keys, leaves the base intact, and audits distinctly', async () => {
    const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(ownerToken), payload: { name: 'Regenerate Drama' } })
    expect(project.statusCode).toBe(201)
    const regenProjectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${regenProjectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'Regen EP' } })
    expect(episode.statusCode).toBe(201)
    const regenEpisodeId = episode.json().id as string
    // SCRIPT is gated on an approved source.
    await env.db.sourceDocumentVersion.create({ data: { episodeId: regenEpisodeId, version: 1, content: 'a source', checksum: 'regen-src', status: 'APPROVED' } })

    // Base run: no revision suffix.
    const base = await env.app.inject({ method: 'POST', url: `/episodes/${regenEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'SCRIPT' } })
    expect(base.statusCode).toBe(201)
    const baseBatch = base.json().batch as BatchDto
    const baseTask = await env.db.generationTask.findUniqueOrThrow({ where: { id: baseBatch.tasks[0].id } })
    expect(baseTask.idempotencyKey).toBe(`${regenEpisodeId}:SCRIPT:${regenEpisodeId}`)

    // First regenerate: revision 1 → ':r1', a brand-new batch and task.
    const regen = await env.app.inject({ method: 'POST', url: `/episodes/${regenEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'SCRIPT', regenerate: true } })
    expect(regen.statusCode).toBe(201)
    const regenBatch = regen.json().batch as BatchDto
    expect(regenBatch.id).not.toBe(baseBatch.id)
    const regenTask = await env.db.generationTask.findUniqueOrThrow({ where: { id: regenBatch.tasks[0].id } })
    expect(regenTask.idempotencyKey).toBe(`${regenEpisodeId}:SCRIPT:${regenEpisodeId}:r1`)
    // A regenerate is enqueued exactly like a first trigger.
    expect(await queue.getJob(`run-${regenTask.id}-1`)).toBeTruthy()

    // The base batch is untouched: same key, still exactly one task.
    const baseAfter = await env.db.generationTask.findUniqueOrThrow({ where: { id: baseTask.id } })
    expect(baseAfter.idempotencyKey).toBe(`${regenEpisodeId}:SCRIPT:${regenEpisodeId}`)
    expect(await env.db.generationTask.count({ where: { batchId: baseBatch.id } })).toBe(1)

    // A second regenerate increments the revision instead of colliding with ':r1'.
    const regen2 = await env.app.inject({ method: 'POST', url: `/episodes/${regenEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'SCRIPT', regenerate: true } })
    expect(regen2.statusCode).toBe(201)
    const regen2Batch = regen2.json().batch as BatchDto
    const regen2Task = await env.db.generationTask.findUniqueOrThrow({ where: { id: regen2Batch.tasks[0].id } })
    expect(regen2Task.idempotencyKey).toBe(`${regenEpisodeId}:SCRIPT:${regenEpisodeId}:r2`)

    // Three distinct SCRIPT batches: the base plus two revisions.
    expect(await env.db.generationBatch.count({ where: { episodeId: regenEpisodeId, stage: 'SCRIPT' } })).toBe(3)

    // Regenerating is audited as generation.regenerate, carrying the revision;
    // the plain trigger is not.
    const audit = await env.app.inject({ method: 'GET', url: '/audit-events?action=generation.regenerate', headers: authHeaders(ownerToken) })
    expect(audit.statusCode).toBe(200)
    const events = audit.json().events as { entityId: string; payload: { stage: string; revision: number } }[]
    const byBatch = new Map(events.map(event => [event.entityId, event]))
    expect(byBatch.get(regenBatch.id)?.payload).toMatchObject({ stage: 'SCRIPT', revision: 1 })
    expect(byBatch.get(regen2Batch.id)?.payload).toMatchObject({ stage: 'SCRIPT', revision: 2 })
    expect(byBatch.has(baseBatch.id)).toBe(false)
  })
})

interface StoryboardRowDto {
  id: string
  revision: number
  number: number
  title: string
  scriptVersionId: string | null
  generationTaskId: string | null
  supersededAt: string | null
}

describe('storyboard revisions', () => {
  const supersededStamp = new Date('2026-03-01T00:00:00Z')

  async function newEpisode(name: string): Promise<{ projectId: string; episodeId: string }> {
    const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: `${name} EP1` } })
    expect(episode.statusCode).toBe(201)
    return { projectId, episodeId: episode.json().id as string }
  }

  async function addShots(targetEpisodeId: string, scriptVersionId?: string): Promise<string[]> {
    const ids: string[] = []
    for (const [number, title] of [[1, 'SB1'], [2, 'SB2']] as const) {
      const created = await env.app.inject({
        method: 'POST', url: `/episodes/${targetEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
        payload: { number, title, durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '', ...(scriptVersionId ? { scriptVersionId } : {}) },
      })
      expect(created.statusCode).toBe(201)
      ids.push(created.json().id as string)
    }
    return ids
  }

  // A regenerate does not delete: the worker writes the new breakdown as the next
  // revision and stamps every prior shot, so both revisions stay readable.
  async function regenerateShots(targetEpisodeId: string, revision: number): Promise<{ superseded: string[]; live: string[] }> {
    const prior = await env.db.storyboard.findMany({ where: { episodeId: targetEpisodeId, supersededAt: null }, orderBy: { number: 'asc' } })
    await env.db.storyboard.createMany({
      data: prior.map(shot => ({
        episodeId: targetEpisodeId,
        scriptVersionId: shot.scriptVersionId,
        revision,
        number: shot.number,
        title: `${shot.title} r${revision}`,
        durationMs: shot.durationMs,
        description: shot.description,
        sourceExcerpt: shot.sourceExcerpt,
        continuityIn: shot.continuityIn,
        continuityOut: shot.continuityOut,
      })),
    })
    await env.db.storyboard.updateMany({ where: { id: { in: prior.map(shot => shot.id) } }, data: { supersededAt: supersededStamp } })
    const live = await env.db.storyboard.findMany({ where: { episodeId: targetEpisodeId, supersededAt: null }, orderBy: { number: 'asc' } })
    return { superseded: prior.map(shot => shot.id), live: live.map(shot => shot.id) }
  }

  async function newConnection(name: string): Promise<Connection> {
    const created = await env.app.inject({ method: 'POST', url: '/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name, apiKey: 'test-key' } })
    expect(created.statusCode).toBe(201)
    const connection = created.json() as Connection
    const probe = await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    return connection
  }

  async function bindSlot(slot: string, capabilityId: string, scope?: string): Promise<void> {
    const binding = await env.app.inject({ method: 'POST', url: '/bindings', headers: authHeaders(ownerToken), payload: { slot, capabilityId, projectId: scope } })
    expect(binding.statusCode).toBe(201)
  }

  const capabilityOf = (connection: Connection, model: string) => connection.capabilities.find(capability => capability.model === model)!.id

  it('lists the live shots with their lineage, and returns the superseded ones on request', async () => {
    const { projectId: historyProjectId, episodeId: historyEpisodeId } = await newEpisode('Revision History Drama')
    const firstRevision = await addShots(historyEpisodeId)
    const { superseded, live } = await regenerateShots(historyEpisodeId, 2)
    expect(superseded).toEqual(firstRevision)

    const listed = await env.app.inject({ method: 'GET', url: `/episodes/${historyEpisodeId}/storyboards`, headers: authHeaders(viewerToken) })
    expect(listed.statusCode).toBe(200)
    const rows = listed.json() as StoryboardRowDto[]
    expect(rows.map(row => row.id)).toEqual(live)
    expect(rows.map(row => [row.revision, row.number])).toEqual([[2, 1], [2, 2]])
    expect(rows.every(row => row.supersededAt === null && row.generationTaskId === null)).toBe(true)

    const history = await env.app.inject({ method: 'GET', url: `/episodes/${historyEpisodeId}/storyboards?includeSuperseded=true`, headers: authHeaders(viewerToken) })
    expect(history.statusCode).toBe(200)
    const all = history.json() as StoryboardRowDto[]
    expect(all.map(row => [row.revision, row.number])).toEqual([[1, 1], [1, 2], [2, 1], [2, 2]])
    expect(all.filter(row => row.supersededAt !== null).map(row => row.id)).toEqual(firstRevision)
    expect(all.find(row => row.id === firstRevision[0])!.supersededAt).toBe(supersededStamp.toISOString())

    // The episode's nested shot list is what the console counts, so it describes the
    // breakdown in use rather than its history.
    const episodes = await env.app.inject({ method: 'GET', url: `/projects/${historyProjectId}/episodes`, headers: authHeaders(viewerToken) })
    expect(episodes.statusCode).toBe(200)
    expect((episodes.json() as { id: string; storyboards: StoryboardRowDto[] }[])[0].storyboards.map(shot => shot.id)).toEqual(live)
  })

  it('targets only live shots with IMAGE and VIDEO, and refuses a superseded id asked for directly', async () => {
    const { projectId: mediaProjectId, episodeId: mediaEpisodeId } = await newEpisode('Revision Media Drama')
    const connection = await newConnection('revision-media')
    await bindSlot('image_gen', capabilityOf(connection, 'mock-image'), mediaProjectId)
    await bindSlot('video_t2v', capabilityOf(connection, 'mock-t2v'), mediaProjectId)
    // Media stages are gated on an approved script.
    await env.db.scriptVersion.create({ data: { episodeId: mediaEpisodeId, version: 1, content: 'a script', checksum: 'revision-media-script', status: 'APPROVED' } })
    await addShots(mediaEpisodeId)
    const { superseded, live } = await regenerateShots(mediaEpisodeId, 2)

    for (const stage of ['IMAGE', 'VIDEO'] as const) {
      const res = await env.app.inject({ method: 'POST', url: `/episodes/${mediaEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage } })
      expect(res.statusCode).toBe(201)
      const batch = res.json().batch as BatchDto
      expect(batch.plannedCount).toBe(2)

      const linked = await env.db.generationBatch.findUniqueOrThrow({ where: { id: batch.id }, include: { storyboards: true } })
      expect(linked.storyboards.map(shot => shot.id).sort()).toEqual([...live].sort())

      // The key's entity segment is the storyboard, so this is also what the
      // storyboard-media map would resolve these tasks back to.
      const targeted = (await env.db.generationTask.findMany({ where: { batchId: batch.id } })).map(task => task.idempotencyKey!.split(':')[2]).sort()
      expect(targeted).toEqual([...live].sort())
      expect(targeted.some(id => superseded.includes(id))).toBe(false)
    }

    const explicit = await env.app.inject({
      method: 'POST', url: `/episodes/${mediaEpisodeId}/generations`, headers: authHeaders(editorToken),
      payload: { stage: 'VIDEO', storyboardIds: [superseded[0]] },
    })
    expect(explicit.statusCode).toBe(400)
    expect(explicit.json().error).toBe('storyboardIds must belong to this episode')
  })

  it('writes a composition manifest of live shots only', async () => {
    const { episodeId: composeEpisodeId } = await newEpisode('Revision Compose Drama')
    await addShots(composeEpisodeId)
    const { superseded, live } = await regenerateShots(composeEpisodeId, 2)

    const res = await env.app.inject({ method: 'POST', url: `/episodes/${composeEpisodeId}/compositions`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(201)
    const composition = res.json().composition as CompositionDto
    const stored = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    // A manifest listing the superseded duplicates would block forever on clips
    // nobody is going to make.
    expect(JSON.parse(stored.manifest)).toEqual({ storyboardIds: live })
    expect(live.some(id => superseded.includes(id))).toBe(false)
  })
})

describe('pipeline advance to composition', () => {
  async function newEpisode(name: string): Promise<{ projectId: string; episodeId: string }> {
    const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: `${name} EP1` } })
    expect(episode.statusCode).toBe(201)
    return { projectId, episodeId: episode.json().id as string }
  }

  async function addShots(targetEpisodeId: string): Promise<string[]> {
    const ids: string[] = []
    for (const [number, title] of [[1, 'SB1'], [2, 'SB2']] as const) {
      const created = await env.app.inject({
        method: 'POST', url: `/episodes/${targetEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
        payload: { number, title, durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
      })
      expect(created.statusCode).toBe(201)
      ids.push(created.json().id as string)
    }
    return ids
  }

  // A succeeded VIDEO task for the shot, with a VIDEO artifact: exactly what the
  // compose worker and the delivery gate look for when they pick a clip.
  async function seedClip(targetEpisodeId: string, storyboardId: string): Promise<void> {
    const batch = await env.db.generationBatch.create({
      data: { organizationId, episodeId: targetEpisodeId, stage: 'VIDEO', status: 'COMPLETED', plannedCount: 1, storyboards: { connect: { id: storyboardId } } },
    })
    const task = await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage: 'VIDEO', status: 'SUCCEEDED', storyboardId, idempotencyKey: `${targetEpisodeId}:VIDEO:${storyboardId}` },
    })
    await env.db.mediaArtifact.create({
      data: { organizationId, taskId: task.id, stage: 'VIDEO', objectKey: `${organizationId}/${targetEpisodeId}/clip/${storyboardId}/v1.mp4`, checksum: `clip-${storyboardId}`, mimeType: 'video/mp4', version: 1, durationMs: 5000 },
    })
  }

  it('re-runs a media stage whose shots were all superseded', async () => {
    const { projectId: staleProjectId, episodeId: staleEpisodeId } = await newEpisode('Stale Media Drama')
    const connection = await env.app.inject({ method: 'POST', url: '/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name: 'stale-media', apiKey: 'test-key' } })
    expect(connection.statusCode).toBe(201)
    const capabilities = (connection.json() as Connection).capabilities
    await env.app.inject({ method: 'POST', url: `/providers/connections/${(connection.json() as Connection).id}/probe`, headers: authHeaders(ownerToken) })
    const binding = await env.app.inject({ method: 'POST', url: '/bindings', headers: authHeaders(ownerToken), payload: { slot: 'image_gen', capabilityId: capabilities.find(capability => capability.model === 'mock-image')!.id, projectId: staleProjectId } })
    expect(binding.statusCode).toBe(201)

    await env.db.scriptVersion.create({ data: { episodeId: staleEpisodeId, version: 1, content: 'a script', checksum: 'stale-media-script', status: 'APPROVED' } })
    const firstRevision = await addShots(staleEpisodeId)
    for (const stage of ['SCRIPT', 'STORYBOARD'] as const) {
      await env.db.generationBatch.create({ data: { organizationId, episodeId: staleEpisodeId, stage, status: 'COMPLETED', plannedCount: 1 } })
    }
    // First frames already ran — for the breakdown the episode no longer uses.
    const staleBatch = await env.db.generationBatch.create({
      data: { organizationId, episodeId: staleEpisodeId, stage: 'FIRST_FRAME', status: 'COMPLETED', plannedCount: 2, storyboards: { connect: firstRevision.map(id => ({ id })) } },
    })
    await env.db.storyboard.createMany({
      data: firstRevision.map((id, index) => ({ episodeId: staleEpisodeId, revision: 2, number: index + 1, title: `SB${index + 1} r2`, durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' })),
    })
    await env.db.storyboard.updateMany({ where: { id: { in: firstRevision } }, data: { supersededAt: new Date('2026-03-01T00:00:00Z') } })

    const res = await env.app.inject({ method: 'POST', url: `/episodes/${staleEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(201)
    expect(res.json().stage).toBe('IMAGE')
    const batch = res.json().batch as BatchDto
    expect(batch.id).not.toBe(staleBatch.id)
    const linked = await env.db.generationBatch.findUniqueOrThrow({ where: { id: batch.id }, include: { storyboards: true } })
    expect(linked.storyboards.every(shot => shot.supersededAt === null && shot.revision === 2)).toBe(true)
    expect(linked.storyboards).toHaveLength(2)
    // The stale batch stays readable as the history of what was paid for.
    expect(await env.db.generationBatch.findUniqueOrThrow({ where: { id: staleBatch.id }, include: { storyboards: true } })).toMatchObject({ status: 'COMPLETED' })
  })

  it('composes once every live shot has a clip, and re-composes after a regenerate supersedes them', async () => {
    const { episodeId: terminalEpisodeId } = await newEpisode('Terminal Step Drama')
    await env.db.scriptVersion.create({ data: { episodeId: terminalEpisodeId, version: 1, content: 'a script', checksum: 'terminal-script', status: 'APPROVED' } })
    const live = await addShots(terminalEpisodeId)
    for (const stage of ['SCRIPT', 'STORYBOARD', 'FIRST_FRAME'] as const) {
      await env.db.generationBatch.create({ data: { organizationId, episodeId: terminalEpisodeId, stage, status: 'COMPLETED', plannedCount: 1 } })
    }

    // A shot without a clip leaves the pipeline idle: composing now would only park
    // the master in BLOCKED.
    await seedClip(terminalEpisodeId, live[0])
    const idle = await env.app.inject({ method: 'POST', url: `/episodes/${terminalEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(idle.statusCode).toBe(409)
    expect(idle.json().error).toBe('pipeline:nothingRunnable')
    expect(await env.db.composition.count({ where: { episodeId: terminalEpisodeId } })).toBe(0)

    await seedClip(terminalEpisodeId, live[1])
    const res = await env.app.inject({ method: 'POST', url: `/episodes/${terminalEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(201)
    expect(res.json().stage).toBe('COMPOSITION')
    const composition = res.json().composition as CompositionDto
    expect(composition.status).toBe('RUNNING')
    expect(composition.artifact).toBeNull()
    const stored = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(JSON.parse(stored.manifest)).toEqual({ storyboardIds: live })
    const job = await queue.getJob(`compose-${composition.id}`)
    expect(job?.name).toBe('compose-episode')
    expect(job?.data as ComposeEpisodePayload).toMatchObject({ kind: 'compose-episode', compositionId: composition.id, episodeId: terminalEpisodeId, organizationId })

    // Composition is the terminal step, so a second advance has nothing left to do
    // rather than re-making a master that already exists.
    const again = await env.app.inject({ method: 'POST', url: `/episodes/${terminalEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('pipeline:nothingRunnable')
    expect(await env.db.composition.count({ where: { episodeId: terminalEpisodeId } })).toBe(1)

    // A regenerate supersedes the breakdown that master was cut from, so the terminal
    // step is worth taking again — otherwise an edited episode could never be re-cut.
    await env.db.storyboard.updateMany({ where: { id: { in: live } }, data: { supersededAt: new Date('2026-03-01T00:00:00Z') } })
    const revised: string[] = []
    for (const [number, title] of [[1, 'SB1 r2'], [2, 'SB2 r2']] as const) {
      const created = await env.db.storyboard.create({
        data: { episodeId: terminalEpisodeId, revision: 2, number, title, durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
      })
      revised.push(created.id)
    }
    for (const storyboardId of revised) await seedClip(terminalEpisodeId, storyboardId)

    const recut = await env.app.inject({ method: 'POST', url: `/episodes/${terminalEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(recut.statusCode).toBe(201)
    expect(recut.json().stage).toBe('COMPOSITION')
    const second = recut.json().composition as CompositionDto
    expect(second.id).not.toBe(composition.id)
    expect(JSON.parse((await env.db.composition.findUniqueOrThrow({ where: { id: second.id } })).manifest)).toEqual({ storyboardIds: revised })
    // The superseded master is not deleted: it is the record of what was delivered.
    expect(await env.db.composition.count({ where: { episodeId: terminalEpisodeId } })).toBe(2)

    const audit = await env.app.inject({ method: 'GET', url: '/audit-events?action=pipeline.advance', headers: authHeaders(ownerToken) })
    expect(audit.statusCode).toBe(200)
    const events = audit.json().events as { entityId: string; payload: { step?: string; compositionId?: string; storyboards?: number } }[]
    expect(events.some(event => event.entityId === terminalEpisodeId && event.payload.step === 'COMPOSITION' && event.payload.compositionId === composition.id && event.payload.storyboards === 2)).toBe(true)
  })
})

describe('script approval cascade', () => {
  let cascadeEpisodeId: string
  let approvedScriptId: string

  it('re-runs STORYBOARD as a regenerate when the live shots trace an older script version', async () => {
    const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(ownerToken), payload: { name: 'Cascade Drama' } })
    expect(project.statusCode).toBe(201)
    const cascadeProjectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${cascadeProjectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'Cascade EP1' } })
    expect(episode.statusCode).toBe(201)
    cascadeEpisodeId = episode.json().id as string

    const connection = await env.app.inject({ method: 'POST', url: '/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name: 'cascade-gen', apiKey: 'test-key' } })
    expect(connection.statusCode).toBe(201)
    const probe = await env.app.inject({ method: 'POST', url: `/providers/connections/${(connection.json() as Connection).id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    const capability = (connection.json() as Connection).capabilities.find(candidate => candidate.model === 'mock-text')!
    const binding = await env.app.inject({ method: 'POST', url: '/bindings', headers: authHeaders(ownerToken), payload: { slot: 'storyboard_text', capabilityId: capability.id, projectId: cascadeProjectId } })
    expect(binding.statusCode).toBe(201)

    const scriptV1 = await env.db.scriptVersion.create({ data: { episodeId: cascadeEpisodeId, version: 1, content: '第一版剧本', checksum: 'cascade-v1', status: 'APPROVED' } })
    const base = await env.app.inject({ method: 'POST', url: `/episodes/${cascadeEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'STORYBOARD' } })
    expect(base.statusCode).toBe(201)
    const baseBatch = base.json().batch as BatchDto

    // The worker wrote the breakdown out of version 1.
    for (const [number, title] of [[1, 'SB1'], [2, 'SB2']] as const) {
      const created = await env.app.inject({
        method: 'POST', url: `/episodes/${cascadeEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
        payload: { number, title, durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '', scriptVersionId: scriptV1.id },
      })
      expect(created.statusCode).toBe(201)
    }

    // A human edits the script and approves the edit.
    await env.db.scriptVersion.create({ data: { episodeId: cascadeEpisodeId, version: 2, content: '第二版剧本：追逐戏改到天台', checksum: 'cascade-v2', status: 'DRAFT' } })
    const res = await env.app.inject({ method: 'POST', url: `/episodes/${cascadeEpisodeId}/script-versions/2/approve`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(200)
    expect(res.json().cascaded).toBe(true)
    expect(res.json().storyboardsUpdated).toBe(0)
    const approved = res.json().version as { id: string; status: string }
    expect(approved.status).toBe('APPROVED')
    approvedScriptId = approved.id

    // The cascade is a regenerate: a second STORYBOARD batch with revision-suffixed
    // keys, enqueued like any other trigger, leaving the first batch intact.
    const batches = await env.db.generationBatch.findMany({ where: { episodeId: cascadeEpisodeId, stage: 'STORYBOARD' }, orderBy: { id: 'asc' } })
    expect(batches).toHaveLength(2)
    expect(batches[0].id).toBe(baseBatch.id)
    const cascadeBatchId = batches[1].id
    expect(cascadeBatchId).not.toBe(baseBatch.id)
    const tasks = await env.db.generationTask.findMany({ where: { batchId: cascadeBatchId } })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].idempotencyKey).toBe(`${cascadeEpisodeId}:STORYBOARD:${cascadeEpisodeId}:r1`)
    expect(await queue.getJob(`run-${tasks[0].id}-1`)).toBeTruthy()
    expect((await env.db.generationTask.findMany({ where: { batchId: baseBatch.id } })).map(task => task.idempotencyKey)).toEqual([`${cascadeEpisodeId}:STORYBOARD:${cascadeEpisodeId}`])

    // The breakdown being superseded keeps the version it was actually broken out of;
    // the regeneration carries the approved one in its request snapshot, which is what
    // the worker stamps on the revision it writes.
    const live = await env.db.storyboard.findMany({ where: { episodeId: cascadeEpisodeId, supersededAt: null } })
    expect(live.every(shot => shot.scriptVersionId === scriptV1.id)).toBe(true)
    const cascadeSnapshot = JSON.parse(tasks[0].requestSnapshot ?? '') as { scriptVersionId?: string; input: { prompt: string } }
    expect(cascadeSnapshot.scriptVersionId).toBe(approvedScriptId)
    expect(cascadeSnapshot.input.prompt).toContain('第二版剧本')

    const cascadeAudit = await env.app.inject({ method: 'GET', url: '/audit-events?action=script.approve.cascade', headers: authHeaders(ownerToken) })
    expect(cascadeAudit.statusCode).toBe(200)
    const cascadeEvents = cascadeAudit.json().events as { entityId: string; entityType: string; payload: { episodeId: string; stage: string; batchId: string } }[]
    const cascadeEvent = cascadeEvents.filter(event => event.entityId === approvedScriptId)
    expect(cascadeEvent).toHaveLength(1)
    expect(cascadeEvent[0]).toMatchObject({ entityType: 'ScriptVersion', payload: { episodeId: cascadeEpisodeId, stage: 'STORYBOARD', batchId: cascadeBatchId } })

    const regenerateAudit = await env.app.inject({ method: 'GET', url: '/audit-events?action=generation.regenerate', headers: authHeaders(ownerToken) })
    const regenerateEvents = regenerateAudit.json().events as { entityId: string; payload: { stage: string } }[]
    expect(regenerateEvents.some(event => event.entityId === cascadeBatchId && event.payload.stage === 'STORYBOARD')).toBe(true)
  })

  it('does not cascade when the live shots already trace the version being approved', async () => {
    // The state the worker leaves behind once the regeneration lands: the live shots
    // are the ones broken out of version 2, so there is nothing left to regenerate.
    await env.db.storyboard.updateMany({ where: { episodeId: cascadeEpisodeId, supersededAt: null }, data: { scriptVersionId: approvedScriptId } })

    const edited = await env.app.inject({ method: 'PATCH', url: `/episodes/${cascadeEpisodeId}/script-versions/2`, headers: authHeaders(editorToken), payload: { content: '第二版剧本：只改一句台词' } })
    expect(edited.statusCode).toBe(200)
    expect(edited.json().version.status).toBe('DRAFT')

    const batchesBefore = await env.db.generationBatch.count({ where: { episodeId: cascadeEpisodeId, stage: 'STORYBOARD' } })
    const res = await env.app.inject({ method: 'POST', url: `/episodes/${cascadeEpisodeId}/script-versions/2/approve`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(200)
    expect(res.json().cascaded).toBe(false)
    expect(res.json().storyboardsUpdated).toBe(2)
    // Re-approving the version the breakdown already came from must not pay for the
    // same shots again.
    expect(await env.db.generationBatch.count({ where: { episodeId: cascadeEpisodeId, stage: 'STORYBOARD' } })).toBe(batchesBefore)

    const audit = await env.app.inject({ method: 'GET', url: '/audit-events?action=script.approve.cascade', headers: authHeaders(ownerToken) })
    const events = audit.json().events as { entityId: string }[]
    expect(events.filter(event => event.entityId === approvedScriptId)).toHaveLength(1)
  })
})

describe('approval opens the next step', () => {
  async function newEpisode(name: string): Promise<{ projectId: string; episodeId: string }> {
    const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: `${name} EP1` } })
    expect(episode.statusCode).toBe(201)
    return { projectId, episodeId: episode.json().id as string }
  }

  // Project scope, so these tests do not ride on the org-wide bindings the suite
  // header made for other stages.
  async function bindContentSlots(targetProjectId: string, name: string): Promise<void> {
    const created = await env.app.inject({ method: 'POST', url: '/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name, apiKey: 'test-key' } })
    expect(created.statusCode).toBe(201)
    const connection = created.json() as Connection
    const probe = await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    for (const [slot, model] of [['script_text', 'mock-script'], ['storyboard_text', 'mock-storyboard']] as const) {
      const capability = connection.capabilities.find(candidate => candidate.model === model)!
      const binding = await env.app.inject({ method: 'POST', url: '/bindings', headers: authHeaders(ownerToken), payload: { slot, capabilityId: capability.id, projectId: targetProjectId } })
      expect(binding.statusCode).toBe(201)
    }
  }

  /** The advance an approval started, read straight from the audit trail. */
  async function advanceStartedBy(episodeId: string): Promise<{ batchId: string; stage: string; userEmail: string | null }> {
    const event = await env.db.auditEvent.findFirst({
      where: { action: 'pipeline.advance', entityType: 'episode', entityId: episodeId },
      orderBy: { id: 'desc' },
      include: { user: { select: { email: true } } },
    })
    expect(event).toBeTruthy()
    const payload = JSON.parse(event!.payload) as { stage: string; batchId: string }
    return { ...payload, userEmail: event!.user?.email ?? null }
  }

  it('starts SCRIPT from the source approval alone, attributed to whoever approved', async () => {
    const { projectId: sourceProjectId, episodeId: sourceEpisodeId } = await newEpisode('Approval Source Drama')
    await bindContentSlots(sourceProjectId, 'approval-source')

    const uploaded = await env.app.inject({ method: 'POST', url: `/episodes/${sourceEpisodeId}/source-versions`, headers: authHeaders(editorToken), payload: { content: '雨夜，滨江老城区。半张烧焦的老照片躺在积水里。' } })
    expect(uploaded.statusCode).toBe(201)
    expect(await env.db.generationBatch.count({ where: { episodeId: sourceEpisodeId } })).toBe(0)

    const approved = await env.app.inject({ method: 'POST', url: `/episodes/${sourceEpisodeId}/source-versions/1/approve`, headers: authHeaders(editorToken) })
    expect(approved.statusCode).toBe(200)

    // Uploading is not a decision, approving is — so the chain starts here, without a
    // second click on **Advance pipeline**.
    const advance = await advanceStartedBy(sourceEpisodeId)
    expect(advance.stage).toBe('SCRIPT')
    expect(advance.userEmail).toBe('gen-editor@example.com')

    const batch = await env.db.generationBatch.findUniqueOrThrow({ where: { id: advance.batchId }, include: { tasks: true } })
    expect(batch.stage).toBe('SCRIPT')
    expect(batch.tasks).toHaveLength(1)
    expect(await queue.getJob(`run-${batch.tasks[0].id}-1`)).toBeTruthy()
    // The script is written from the words that were just signed off on.
    const snapshot = JSON.parse(batch.tasks[0].requestSnapshot ?? '') as { input: { prompt: string } }
    expect(snapshot.input.prompt).toContain('半张烧焦的老照片')
  })

  it('starts STORYBOARD from a script approval that has nothing to cascade, without buying another script', async () => {
    const { projectId: scriptProjectId, episodeId: scriptEpisodeId } = await newEpisode('Approval Script Drama')
    await bindContentSlots(scriptProjectId, 'approval-script')

    // A script the human produced themselves: derived from the approved source, so no
    // SCRIPT batch exists for the chain to skip past.
    await env.db.sourceDocumentVersion.create({ data: { episodeId: scriptEpisodeId, version: 1, content: '雨夜追踪的源文档', checksum: 'approval-src', status: 'APPROVED' } })
    const derived = await env.app.inject({ method: 'POST', url: `/episodes/${scriptEpisodeId}/script-versions`, headers: authHeaders(editorToken), payload: { sourceVersion: 1 } })
    expect(derived.statusCode).toBe(201)
    const scriptVersionId = (derived.json().version as { id: string }).id

    const approved = await env.app.inject({ method: 'POST', url: `/episodes/${scriptEpisodeId}/script-versions/1/approve`, headers: authHeaders(editorToken) })
    expect(approved.statusCode).toBe(200)
    expect(approved.json().storyboardsUpdated).toBe(0)

    const advance = await advanceStartedBy(scriptEpisodeId)
    expect(advance.stage).toBe('STORYBOARD')
    const batch = await env.db.generationBatch.findUniqueOrThrow({ where: { id: advance.batchId }, include: { tasks: true } })
    expect(batch.stage).toBe('STORYBOARD')
    expect(await queue.getJob(`run-${batch.tasks[0].id}-1`)).toBeTruthy()
    const snapshot = JSON.parse(batch.tasks[0].requestSnapshot ?? '') as { input: { prompt: string }; scriptVersionId?: string }
    expect(snapshot.scriptVersionId).toBe(scriptVersionId)
    expect(snapshot.input.prompt).toContain('雨夜追踪的源文档')

    // The approved script is the output SCRIPT would have produced, so the chain does
    // not pay for one and leave a draft the human never asked for.
    expect(await env.db.generationBatch.count({ where: { episodeId: scriptEpisodeId, stage: 'SCRIPT' } })).toBe(0)
    expect(await env.db.scriptVersion.count({ where: { episodeId: scriptEpisodeId } })).toBe(1)
  })

  it('still approves when the next step cannot be planned', async () => {
    // A second organization: none of the suite's slot bindings reach it, so SCRIPT has
    // no verified candidate to run on.
    const other = await env.register('approval-unbound@example.com', 'Approval Unbound Org')
    const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(other.token), payload: { name: 'Approval Unbound Drama' } })
    expect(project.statusCode).toBe(201)
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${project.json().id as string}/episodes`, headers: authHeaders(other.token), payload: { number: 1, title: 'EP1' } })
    expect(episode.statusCode).toBe(201)
    const unboundEpisodeId = episode.json().id as string

    await env.app.inject({ method: 'POST', url: `/episodes/${unboundEpisodeId}/source-versions`, headers: authHeaders(other.token), payload: { content: 'a source with nowhere to run' } })
    const approved = await env.app.inject({ method: 'POST', url: `/episodes/${unboundEpisodeId}/source-versions/1/approve`, headers: authHeaders(other.token) })
    // The approval is already persisted by the time the chain is asked to move, so a
    // step that could not be started is logged, never thrown back as a failed approval.
    expect(approved.statusCode).toBe(200)
    expect(approved.json().version.status).toBe('APPROVED')
    expect(await env.db.generationBatch.count({ where: { episodeId: unboundEpisodeId } })).toBe(0)
    expect(await env.db.auditEvent.count({ where: { action: 'pipeline.advance', entityId: unboundEpisodeId } })).toBe(0)
  })
})

// The audio chain as the console drives it: which shots AUDIO plans, what the
// synthesizer is actually asked to say, what a shot exposes back, and what
// composition refuses to cut until the lines have landed.
describe('per-shot voice', () => {
  let voiceProjectId: string
  let voiceEpisodeId: string
  const speakingIds: string[] = []
  const silentIds: string[] = []
  let audioBatchId: string

  interface ShotDto {
    id: string
    number: number
    dialogue: string
    speaker: string | null
    voice: ArtifactDto | null
  }

  async function newEpisode(name: string): Promise<{ projectId: string; episodeId: string }> {
    const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: `${name} EP1` } })
    expect(episode.statusCode).toBe(201)
    return { projectId, episodeId: episode.json().id as string }
  }

  // Project scope, so these bindings cannot change what the earlier tests resolve.
  async function bindAudioSlot(targetProjectId: string, slot: 'tts_voice' | 'music_gen', model: string, name: string): Promise<void> {
    const created = await env.app.inject({ method: 'POST', url: '/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name, apiKey: 'test-key' } })
    expect(created.statusCode).toBe(201)
    const connection = created.json() as Connection
    const probe = await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    const capability = connection.capabilities.find(candidate => candidate.model === model)!
    const binding = await env.app.inject({ method: 'POST', url: '/bindings', headers: authHeaders(ownerToken), payload: { slot, capabilityId: capability.id, projectId: targetProjectId } })
    expect(binding.statusCode).toBe(201)
  }

  async function addShot(targetEpisodeId: string, number: number, dialogue: string, speaker?: string): Promise<string> {
    const created = await env.app.inject({
      method: 'POST', url: `/episodes/${targetEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number, title: `SB${number}`, durationMs: 5000, description: 'a street', dialogue, speaker, sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(created.statusCode).toBe(201)
    return created.json().id as string
  }

  // A finished task that produced one artifact for one shot — the lineage both the
  // composition gate and the shot DTO read.
  async function seedMedia(targetEpisodeId: string, stage: 'VIDEO' | 'AUDIO', storyboardId: string): Promise<void> {
    const batch = await env.db.generationBatch.create({
      data: { organizationId, episodeId: targetEpisodeId, stage, status: 'COMPLETED', plannedCount: 1, storyboards: { connect: { id: storyboardId } } },
    })
    const task = await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage, status: 'SUCCEEDED', storyboardId, idempotencyKey: `seed:${targetEpisodeId}:${stage}:${storyboardId}` },
    })
    await env.db.mediaArtifact.create({
      data: {
        organizationId,
        taskId: task.id,
        stage,
        objectKey: `${organizationId}/${voiceProjectId}/${targetEpisodeId}/${stage}/${task.id}/v1.${stage === 'AUDIO' ? 'wav' : 'mp4'}`,
        checksum: `${stage}-${task.id}`,
        mimeType: stage === 'AUDIO' ? 'audio/wav' : 'video/mp4',
        version: 1,
        durationMs: 5000,
      },
    })
  }

  it('plans one voice task per speaking shot, with the line itself as the prompt', async () => {
    const { projectId, episodeId } = await newEpisode('Voice Drama')
    voiceProjectId = projectId
    voiceEpisodeId = episodeId
    await bindAudioSlot(projectId, 'tts_voice', 'mock-tts', 'voice-tts')
    await env.db.scriptVersion.create({ data: { episodeId, version: 1, content: '沈亦：照片背面有字……', checksum: 'voice-script', status: 'APPROVED' } })
    speakingIds.push(await addShot(episodeId, 1, '这条街不能待了。', '林晚'))
    speakingIds.push(await addShot(episodeId, 2, '我跟你走。'))
    silentIds.push(await addShot(episodeId, 3, ''))

    const res = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'AUDIO' } })
    expect(res.statusCode).toBe(201)
    const batch = res.json().batch as BatchDto
    expect(batch.stage).toBe('AUDIO')
    expect(batch.plannedCount).toBe(2)
    audioBatchId = batch.id

    const tasks = await env.db.generationTask.findMany({ where: { batchId: batch.id }, orderBy: { id: 'asc' } })
    expect(tasks.map(task => task.storyboardId)).toEqual(speakingIds)
    expect(tasks.map(task => task.idempotencyKey)).toEqual(speakingIds.map(id => `${episodeId}:AUDIO:${id}`))
    // The shot's own words go to the synthesizer — not the title, not the episode name.
    expect(tasks.map(task => (JSON.parse(task.requestSnapshot ?? '') as { input: { prompt: string } }).input.prompt)).toEqual([
      '【林晚】这条街不能待了。',
      '我跟你走。',
    ])
    expect((await queue.getJob(`run-${tasks[0].id}-1`))?.data).toMatchObject({ kind: 'run-task' })
    const candidates = (await queue.getJob(`run-${tasks[0].id}-1`))?.data as RunTaskPayload
    expect(candidates.candidates.map(candidate => candidate.model)).toEqual(['mock-tts'])

    // The batch covers exactly the shots it planned, so a shot that gains a line
    // later leaves the stage open again instead of reading as already done.
    const linked = await env.db.generationBatch.findUniqueOrThrow({ where: { id: batch.id }, include: { storyboards: true } })
    expect(linked.storyboards.map(storyboard => storyboard.id).sort()).toEqual([...speakingIds].sort())

    // The silent shot is not silently dropped from the episode: it is still a shot,
    // it simply owns no voice, so it owes no money.
    const silent = await env.db.storyboard.findUniqueOrThrow({ where: { id: silentIds[0]! } })
    expect(silent.dialogue).toBe('')
    expect(silent.speaker).toBeNull()
  })

  it('re-triggering reuses the batch and only a regenerate buys fresh keys', async () => {
    const again = await env.app.inject({ method: 'POST', url: `/episodes/${voiceEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'AUDIO' } })
    expect(again.statusCode).toBe(200)
    expect((again.json().batch as BatchDto).id).toBe(audioBatchId)

    const regenerated = await env.app.inject({ method: 'POST', url: `/episodes/${voiceEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'AUDIO', regenerate: true } })
    expect(regenerated.statusCode).toBe(201)
    const fresh = regenerated.json().batch as BatchDto
    expect(fresh.id).not.toBe(audioBatchId)
    const tasks = await env.db.generationTask.findMany({ where: { batchId: fresh.id }, orderBy: { id: 'asc' } })
    expect(tasks.map(task => task.idempotencyKey)).toEqual(speakingIds.map(id => `${voiceEpisodeId}:AUDIO:${id}:r1`))
    // The first run stays as the record of what was paid for.
    expect(await env.db.generationBatch.findUniqueOrThrow({ where: { id: audioBatchId } })).toMatchObject({ status: 'RUNNING' })
  })

  it('refuses to voice an episode whose shots all stay silent', async () => {
    const { projectId, episodeId } = await newEpisode('Silent Drama')
    await bindAudioSlot(projectId, 'tts_voice', 'mock-tts', 'silent-tts')
    await env.db.scriptVersion.create({ data: { episodeId, version: 1, content: '纯动作，无台词', checksum: 'silent-script', status: 'APPROVED' } })
    await addShot(episodeId, 1, '')

    const res = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'AUDIO' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('episode has no shots with dialogue to voice')
    expect(await env.db.generationBatch.count({ where: { episodeId } })).toBe(0)
  })

  it('exposes the line, its speaker and the shot voice, and lets a human rewrite them', async () => {
    await seedMedia(voiceEpisodeId, 'AUDIO', speakingIds[0])

    const listed = await env.app.inject({ method: 'GET', url: `/episodes/${voiceEpisodeId}/storyboards`, headers: authHeaders(editorToken) })
    expect(listed.statusCode).toBe(200)
    const shots = listed.json() as ShotDto[]
    expect(shots).toHaveLength(3)
    expect(shots[0]).toMatchObject({ number: 1, dialogue: '这条街不能待了。', speaker: '林晚' })
    expect(shots[0]!.voice).toMatchObject({ mimeType: 'audio/wav', objectKey: expect.stringContaining('/AUDIO/') })
    expect(shots[0]!.voice!.downloadUrl).toBe(`/artifacts/${shots[0]!.voice!.id}/content`)
    // A shot that has not been voiced yet says so, rather than pretending.
    expect(shots[1]!.voice).toBeNull()
    expect(shots[2]!.dialogue).toBe('')

    const edited = await env.app.inject({ method: 'PATCH', url: `/storyboards/${speakingIds[1]}`, headers: authHeaders(editorToken), payload: { dialogue: '  你先走。 ', speaker: '沈亦' } })
    expect(edited.statusCode).toBe(200)
    expect(edited.json().dialogue).toBe('你先走。')
    expect(edited.json().speaker).toBe('沈亦')

    const cleared = await env.app.inject({ method: 'PATCH', url: `/storyboards/${speakingIds[1]}`, headers: authHeaders(editorToken), payload: { dialogue: '', speaker: null } })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json()).toMatchObject({ dialogue: '', speaker: null })

    // Put the line back: the composition assertions below depend on two speaking shots.
    await env.app.inject({ method: 'PATCH', url: `/storyboards/${speakingIds[1]}`, headers: authHeaders(editorToken), payload: { dialogue: '我跟你走。', speaker: '' } })
    const afterEdit = await env.app.inject({ method: 'GET', url: `/episodes/${voiceEpisodeId}/storyboards`, headers: authHeaders(editorToken) })
    expect((afterEdit.json() as ShotDto[])[1]).toMatchObject({ dialogue: '我跟你走。', speaker: null })

    const audit = await env.app.inject({ method: 'GET', url: '/audit-events?action=storyboard.update', headers: authHeaders(ownerToken) })
    const events = audit.json().events as { entityId: string; payload: { fields: string[] } }[]
    expect(events.some(event => event.entityId === speakingIds[1] && event.payload.fields.includes('dialogue'))).toBe(true)
  })

  it('holds composition until every speaking shot has its voice, then cuts the master', async () => {
    // Upstream stages marked as already run: the claim here is about the voice gate.
    for (const stage of ['SCRIPT', 'STORYBOARD', 'FIRST_FRAME'] as const) {
      await env.db.generationBatch.create({ data: { organizationId, episodeId: voiceEpisodeId, stage, status: 'COMPLETED', plannedCount: 1 } })
    }
    for (const storyboardId of [...speakingIds, ...silentIds]) await seedMedia(voiceEpisodeId, 'VIDEO', storyboardId)

    // With a TTS bound, a shot whose line has no audio would compose into a master
    // where that line is simply missing — so the chain waits instead.
    const blocked = await env.app.inject({ method: 'POST', url: `/episodes/${voiceEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error).toBe('pipeline:nothingRunnable')
    // The generic error says the chain has no next step; the reason says what is missing.
    expect(blocked.json().reasons).toEqual(['composition:missingVoice'])
    expect(await env.db.composition.count({ where: { episodeId: voiceEpisodeId } })).toBe(0)

    await seedMedia(voiceEpisodeId, 'AUDIO', speakingIds[1])
    const res = await env.app.inject({ method: 'POST', url: `/episodes/${voiceEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(201)
    // music_gen is unbound here, so the chain walks past the music step rather than
    // stalling on a capability this installation never signed up for.
    expect(res.json().stage).toBe('COMPOSITION')
    const composition = res.json().composition as CompositionDto
    expect(composition.subtitle).toBeNull()
    const stored = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(JSON.parse(stored.manifest)).toEqual({ storyboardIds: [...speakingIds, ...silentIds] })
  })

  it('takes the music step once a generator is bound, from the approved script', async () => {
    const { projectId, episodeId } = await newEpisode('Music Drama')
    await bindAudioSlot(projectId, 'music_gen', 'mock-music', 'music-gen')
    await env.db.scriptVersion.create({ data: { episodeId, version: 1, content: '雨夜的滨江老城区，一桩离奇失踪案。', checksum: 'music-script', status: 'APPROVED' } })
    await addShot(episodeId, 1, '')
    for (const stage of ['SCRIPT', 'STORYBOARD'] as const) {
      await env.db.generationBatch.create({ data: { organizationId, episodeId, stage, status: 'COMPLETED', plannedCount: 1 } })
    }

    const res = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'MUSIC' } })
    expect(res.statusCode).toBe(201)
    const batch = res.json().batch as BatchDto
    expect(batch.stage).toBe('MUSIC')
    expect(batch.plannedCount).toBe(1)
    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: batch.tasks[0].id } })
    // One bed for the episode, asked for in terms of the story it has to sit under.
    expect((JSON.parse(task.requestSnapshot ?? '') as { input: { prompt: string } }).input.prompt).toContain('一桩离奇失踪案')
    expect(task.storyboardId).toBeNull()
  })
})
