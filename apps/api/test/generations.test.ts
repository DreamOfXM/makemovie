import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPipelineQueue, type ComposeEpisodePayload, type RunTaskPayload } from '@studio/jobs'
import { generationSeed, getStyleVisualDirective,
  getStyleAssetDirective, OFFICIAL_STYLES, VISUAL_STYLE_DIRECTIVE } from '@studio/pipeline'
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
  version: number
  width: number | null
  height: number | null
  durationMs: number | null
  downloadUrl: string
}

interface TaskDto {
  id: string
  stage: string
  storyboardId: string | null
  status: string
  attempts: number
  provider: string | null
  model: string | null
  error: string | null
  createdAt: string
  updatedAt: string
  artifacts: ArtifactDto[]
  qc: { kind: string; score: number; status: string } | null
  scores: number[]
  retryTrace: { attempt: number | null; candidateErrors: string[]; reference: { model: string; conditioned: boolean; reason?: string }[] } | null
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
  score: ArtifactDto | null
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
    const added = await env.app.inject({ method: 'POST', url: '/api/members', headers: env.authHeaders(ownerToken), payload: { email, role } })
    expect(added.statusCode).toBe(201)
    const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123', organizationId } })
    expect(login.statusCode).toBe(200)
    if (role === 'EDITOR') editorToken = login.json().token as string
    else viewerToken = login.json().token as string
  }

  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: env.authHeaders(ownerToken), payload: { name: 'Generation Drama' } })
  expect(project.statusCode).toBe(201)
  projectId = project.json().id as string

  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: env.authHeaders(ownerToken), payload: { number: 1, title: 'EP1' } })
  expect(episode.statusCode).toBe(201)
  episodeId = episode.json().id as string

  for (const [number, title, description] of [[1, 'SB1', 'Opening scene'], [2, 'SB2', 'Chase scene']] as const) {
    const storyboard = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: env.authHeaders(ownerToken),
      payload: { number, title, durationMs: 8000, description, sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(storyboard.statusCode).toBe(201)
    storyboardIds.push(storyboard.json().id as string)
  }

  const connection = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: env.authHeaders(ownerToken), payload: { provider: 'mock', name: 'gen-main', apiKey: 'test-key' } })
  expect(connection.statusCode).toBe(201)
  const capabilities = (connection.json() as Connection).capabilities
  const probe = await env.app.inject({ method: 'POST', url: `/api/providers/connections/${(connection.json() as Connection).id}/probe`, headers: env.authHeaders(ownerToken) })
  expect(probe.statusCode).toBe(200)
  for (const [slot, model] of [['script_text', 'mock-text'], ['video_t2v', 'mock-t2v']] as const) {
    const binding = await env.app.inject({
      method: 'POST', url: '/api/bindings', headers: env.authHeaders(ownerToken),
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
    const forbidden = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(viewerToken), payload: { stage: 'SCRIPT' } })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toMatch(/generation:trigger/)

    const missing = await env.app.inject({ method: 'POST', url: '/api/episodes/does-not-exist/generations', headers: authHeaders(editorToken), payload: { stage: 'SCRIPT' } })
    expect(missing.statusCode).toBe(404)

    const badStage = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'DELIVERY' } })
    expect(badStage.statusCode).toBe(400)
  })

  it('creates one batch and one queued task for an episode-level stage, and enqueues the job', async () => {
    const sourceContent = '原小说：雨夜的滨江老城区，一桩离奇失踪案。'
    await env.db.sourceDocumentVersion.create({ data: { episodeId, version: 1, content: sourceContent, checksum: 'src-ep1', status: 'APPROVED' } })

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'SCRIPT' } })
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
    // Episode-level work belongs to no shot.
    expect(task.storyboardId).toBeNull()
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
    // 集自 API 建出即带短剧默认 8 分钟时长,prompt 因此含时长与场景规则(形态真驱动)。
    expect(JSON.parse(stored.requestSnapshot ?? '')).toEqual({ input: { prompt: `根据以下源文档，写出这一集的完整拍摄剧本。\n\n时长与结构要求（最高优先级）：\n- 本集目标时长约 8 分钟。\n- 篇幅预算：中文剧本全篇约 2800 字以内，英文剧本约 1440 词以内（按每分钟约 350 字 / 180 词折算）。宁可精炼，不得注水。\n- 剧本必须按场景分段：每个场景以「场景 1」「场景 2」……这样的场景标记行开头（标记独占一行，场景正文写在标记之后）。场景标记是后续分镜切分的锚点，必须逐场编号、不得省略。\n\n源文档：\n${sourceContent}` } })
  })

  it('fans a storyboard stage out over the requested storyboards only', async () => {
    // The media gate now requires an approved script before any image/video/audio
    // is generated, so the shared episode needs one before this VIDEO trigger.
    await env.db.scriptVersion.create({ data: { episodeId, version: 1, content: 'approved script for media', checksum: 'media-script', status: 'APPROVED' } })
    const res = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(editorToken),
      payload: { stage: 'VIDEO', storyboardIds: [storyboardIds[1]] },
    })
    expect(res.statusCode).toBe(201)
    const batch = res.json().batch as BatchDto
    expect(batch.stage).toBe('VIDEO')
    expect(batch.plannedCount).toBe(1)
    videoTaskId = batch.tasks[0].id
    // The row the console builds its shot table from: this task is SB2's clip, not the
    // batch's clip.
    expect(batch.tasks[0].storyboardId).toBe(storyboardIds[1])

    const job = await queue.getJob(`run-${videoTaskId}-1`)
    const payload = job?.data as RunTaskPayload
    expect(payload.candidates.map(candidate => candidate.model)).toEqual(['mock-t2v'])

    const stored = await env.db.generationTask.findUniqueOrThrow({ where: { id: videoTaskId } })
    expect(stored.idempotencyKey).toBe(`${episodeId}:VIDEO:${storyboardIds[1]}`)
    // A paid media request pins its base seed in the snapshot, derived from that key.
    // P7 守卫给每条无风格的媒体 prompt 补上真人质感基准，并把改写留痕写进快照——
    // 快照不再是"原样的输入"，而是"实际付钱买的东西"。
    // 新建项目默认写实风预设,且预设先于守卫应用:style-anchor 认得「视觉风格」
    // 标记即让路,快照里只有预设注入、没有守卫改写。
    const realistic = OFFICIAL_STYLES.find(style => style.id === 'realistic')!
    expect(JSON.parse(stored.requestSnapshot ?? '')).toEqual({
      input: { prompt: `SB2: Chase scene\n\n画面文字规则（最高优先级）：画面中出现的任何文字（标题、标签、招牌、文书内容）一律使用简体中文，禁止出现英文单词或字母。\n\n视觉风格：${getStyleVisualDirective(realistic, 'VIDEO')}` },
      parameters: { seed: generationSeed(stored.idempotencyKey!) },
    })

    // The composition worker finds each clip through the batch → storyboards link.
    const linked = await env.db.generationBatch.findUniqueOrThrow({ where: { id: batch.id }, include: { storyboards: true } })
    expect(linked.storyboards.map(storyboard => storyboard.id)).toEqual([storyboardIds[1]])

    const foreign = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(editorToken),
      payload: { stage: 'VIDEO', storyboardIds: ['not-this-episode'] },
    })
    expect(foreign.statusCode).toBe(400)
  })

  it('returns the existing batch on a duplicate submit', async () => {
    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'SCRIPT' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().batch.id).toBe(scriptBatchId)
    expect(await env.db.generationTask.count({ where: { batchId: scriptBatchId } })).toBe(1)
    expect(await env.db.generationBatch.count({ where: { episodeId } })).toBe(2)
  })

  it('re-queues only FAILED tasks on a plain re-trigger and never burns a new batch', async () => {
    // 一键重试失败项的契约底座:幂等撞库时死任务重置排队、活任务不动、批次不新增。
    await env.db.generationTask.update({ where: { id: scriptTaskId }, data: { status: 'FAILED', attempts: 3, provider: 'mock', model: 'mock-text', errorSnapshot: 'quota exhausted after 3 attempts' } })

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'SCRIPT' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().batch.id).toBe(scriptBatchId)

    const stored = await env.db.generationTask.findUniqueOrThrow({ where: { id: scriptTaskId } })
    expect(stored).toMatchObject({ status: 'QUEUED', attempts: 0, provider: null, model: null, errorSnapshot: null })
    expect(await env.db.generationBatch.count({ where: { episodeId } })).toBe(2)

    const retryEvent = await env.db.auditEvent.findFirst({ where: { organizationId, action: 'generation.retry' }, orderBy: { createdAt: 'desc' } })
    expect(retryEvent).not.toBeNull()
    expect(JSON.parse(retryEvent!.payload)).toMatchObject({ stage: 'SCRIPT', retried: 1, created: 0 })
  })

  it('rejects a stage whose slot has no verified binding', async () => {
    for (const stage of ['IMAGE', 'AUDIO']) {
      const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage } })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/no verified candidates for slot/)
    }
    expect(await env.db.generationBatch.count({ where: { episodeId } })).toBe(2)
  })
})

describe('generation listing', () => {
  it('lists batches with tasks that have no artifacts or quality checks yet', async () => {
    const res = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(viewerToken) })
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

    const missing = await env.app.inject({ method: 'GET', url: '/api/episodes/does-not-exist/generations', headers: authHeaders(viewerToken) })
    expect(missing.statusCode).toBe(404)
  })
})

describe('task cancellation', () => {
  it('cancels a queued task once and refuses a second cancel', async () => {
    const forbidden = await env.app.inject({ method: 'POST', url: `/api/generations/tasks/${videoTaskId}/cancel`, headers: authHeaders(viewerToken) })
    expect(forbidden.statusCode).toBe(403)

    const res = await env.app.inject({ method: 'POST', url: `/api/generations/tasks/${scriptTaskId}/cancel`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(200)
    expect((res.json().task as TaskDto).status).toBe('CANCELLED')
    const stored = await env.db.generationTask.findUniqueOrThrow({ where: { id: scriptTaskId } })
    expect(stored.status).toBe('CANCELLED')

    const again = await env.app.inject({ method: 'POST', url: `/api/generations/tasks/${scriptTaskId}/cancel`, headers: authHeaders(editorToken) })
    expect(again.statusCode).toBe(409)

    const missing = await env.app.inject({ method: 'POST', url: '/api/generations/tasks/does-not-exist/cancel', headers: authHeaders(editorToken) })
    expect(missing.statusCode).toBe(404)
  })
})

describe('batch cancellation', () => {
  it('cancels only the queued tasks of a batch, refuses a second stop, and audits it', async () => {
    const missing = await env.app.inject({ method: 'POST', url: '/api/generations/batches/no-such-batch/cancel', headers: authHeaders(editorToken) })
    expect(missing.statusCode).toBe(404)

    const batch = await env.db.generationBatch.create({
      data: {
        organizationId, episodeId, stage: 'MUSIC', status: 'RUNNING', plannedCount: 3,
        tasks: { create: [
          { organizationId, stage: 'MUSIC', status: 'QUEUED', idempotencyKey: `${episodeId}:batch-stop:1` },
          { organizationId, stage: 'MUSIC', status: 'QUEUED', idempotencyKey: `${episodeId}:batch-stop:2` },
          { organizationId, stage: 'MUSIC', status: 'RUNNING', idempotencyKey: `${episodeId}:batch-stop:3` },
        ] },
      },
    })
    const forbidden = await env.app.inject({ method: 'POST', url: `/api/generations/batches/${batch.id}/cancel`, headers: authHeaders(viewerToken) })
    expect(forbidden.statusCode).toBe(403)

    const res = await env.app.inject({ method: 'POST', url: `/api/generations/batches/${batch.id}/cancel`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { cancelled: number; batch: BatchDto }
    expect(body.cancelled).toBe(2)
    expect(body.batch.tasks.filter(task => task.status === 'CANCELLED')).toHaveLength(2)
    // 执行中的任务不掐:provider 请求已发出,那笔已经烧掉;批次仍 RUNNING,
    // 等它落定后由 rollUp 归位(部分成功 → NEEDS_REVIEW),自动推进链随之停住。
    const running = await env.db.generationTask.findFirstOrThrow({ where: { idempotencyKey: `${episodeId}:batch-stop:3` } })
    expect(running.status).toBe('RUNNING')
    expect((await env.db.generationBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe('RUNNING')

    const again = await env.app.inject({ method: 'POST', url: `/api/generations/batches/${batch.id}/cancel`, headers: authHeaders(editorToken) })
    expect(again.statusCode).toBe(409)

    const event = await env.db.auditEvent.findFirst({ where: { organizationId, action: 'generation.cancel', entityType: 'generation-batch' }, orderBy: { createdAt: 'desc' } })
    expect(event).not.toBeNull()
    expect(JSON.parse(event!.payload)).toMatchObject({ stage: 'MUSIC', cancelled: 2 })

    // 清场:这条批次不属于本集的真实账,后面的批次计数测试不能被它污染。
    await env.db.generationTask.deleteMany({ where: { batchId: batch.id } })
    await env.db.generationBatch.delete({ where: { id: batch.id } })
  })
})

describe('prompt guards on trigger', () => {
  async function newProject(name: string): Promise<{ projectId: string; episodeId: string }> {
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'EP1' } })
    expect(episode.statusCode).toBe(201)
    return { projectId, episodeId: episode.json().id as string }
  }

  async function addShot(targetEpisodeId: string, number: number, title: string, description: string): Promise<string> {
    const created = await env.app.inject({
      method: 'POST', url: `/api/episodes/${targetEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number, title, durationMs: 5000, description, sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(created.statusCode).toBe(201)
    return created.json().id as string
  }

  let guardEpisodeId: string
  let unboundShotId: string

  it('blocks the unbound shot, repairs the bound one, and records both in the snapshot and audit', async () => {
    const { projectId: guardProjectId, episodeId } = await newProject(`Guard Drama ${randomUUID().slice(0, 8)}`)
    guardEpisodeId = episodeId
    const anchoredShotId = await addShot(episodeId, 1, '点睛', '一只枯瘦的手悬在砚台上方')
    unboundShotId = await addShot(episodeId, 2, '空巷', '夜色下的青石板路')
    await env.db.scriptVersion.create({ data: { episodeId, version: 1, content: '守夜人点睛', checksum: `guard-${randomUUID()}`, status: 'APPROVED' } })

    const asset = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/assets`, headers: authHeaders(editorToken), payload: { kind: 'character', name: '关师傅', description: '六十岁老匠人，灰白长须，粗布对襟衫' } })
    expect(asset.statusCode).toBe(201)
    const assetId = asset.json().asset.id as string
    await env.db.asset.update({ where: { id: assetId }, data: { status: 'APPROVED' } })
    await env.db.storyboardAsset.create({ data: { storyboardId: anchoredShotId, assetId, role: 'character' } })

    const connection = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name: 'guard-gen', apiKey: 'test-key' } })
    const capabilities = (connection.json() as Connection).capabilities
    const probe = await env.app.inject({ method: 'POST', url: `/api/providers/connections/${(connection.json() as Connection).id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    const binding = await env.app.inject({
      method: 'POST', url: '/api/bindings', headers: authHeaders(ownerToken),
      payload: { slot: 'image_gen', capabilityId: capabilities.find(capability => capability.model === 'mock-image')!.id, projectId: guardProjectId },
    })
    expect(binding.statusCode).toBe(201)

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'IMAGE' } })
    expect(res.statusCode).toBe(201)
    const batch = res.json().batch as BatchDto
    expect(batch.plannedCount).toBe(2)

    const blocked = batch.tasks.find(task => task.storyboardId === unboundShotId)!
    expect(blocked.status).toBe('BLOCKED')
    expect(blocked.error).toContain('未绑定任何素材')
    // 拦下的任务不排队:额度一分不烧。
    expect(await queue.getJob(`run-${blocked.id}-1`)).toBeUndefined()

    const repaired = batch.tasks.find(task => task.storyboardId === anchoredShotId)!
    expect(repaired.status).toBe('QUEUED')
    expect(await queue.getJob(`run-${repaired.id}-1`)).toBeDefined()
    const snapshot = JSON.parse((await env.db.generationTask.findUniqueOrThrow({ where: { id: repaired.id } })).requestSnapshot ?? '')
    // 人物没被画面文本点名 → 素材上下文只给了"其他出场素材"一行;外观锚点由守卫补上,
    // 风格基准同批注入 —— 两者都留痕,审计能回答"这条 prompt 被动过什么"。
    expect(snapshot.input.prompt).toContain('画面中出现的人物必须与以下已绑定角色的外观设定严格一致')
    expect(snapshot.input.prompt).toContain('关师傅：六十岁老匠人')
    expect(snapshot.promptGuards.map((finding: { guard: string }) => finding.guard)).toEqual(['character-anchor'])
    expect(snapshot.promptGuards.every((finding: { action: string }) => finding.action === 'repair')).toBe(true)

    const triggerEvent = await env.db.auditEvent.findFirst({ where: { organizationId, action: 'generation.trigger', entityType: 'generation-batch', entityId: batch.id } })
    expect(JSON.parse(triggerEvent!.payload)).toMatchObject({ stage: 'IMAGE', guardsBlocked: 1 })
  })

  it('revives the blocked shot through the retry path once a human binds an asset', async () => {
    const scene = await env.app.inject({ method: 'POST', url: `/api/episodes/${guardEpisodeId}/assets`, headers: authHeaders(editorToken), payload: { kind: 'scene', name: '青石巷', description: '夜色下的青石板路' } })
    const sceneId = scene.json().asset.id as string
    await env.db.asset.update({ where: { id: sceneId }, data: { status: 'APPROVED' } })
    await env.db.storyboardAsset.create({ data: { storyboardId: unboundShotId, assetId: sceneId, role: 'scene' } })

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${guardEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'IMAGE' } })
    expect(res.statusCode).toBe(200)
    const blockedBefore = await env.db.generationTask.findFirstOrThrow({ where: { storyboardId: unboundShotId, stage: 'FIRST_FRAME' } })
    expect(blockedBefore.status).toBe('QUEUED')
    expect(blockedBefore.errorSnapshot).toBeNull()
    expect(await queue.getJob(`run-${blockedBefore.id}-1`)).not.toBeNull()
    // 复活后的快照按当前事实重排:这一镜不再缺锚。
    const revived = JSON.parse(blockedBefore.requestSnapshot ?? '')
    expect(revived.input.prompt).toContain('青石巷')
    expect(revived.input.prompt).toContain('视觉风格：')
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
    const res = await env.app.inject({ method: 'GET', url: `/api/artifacts/${artifact.id}/content`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['content-length']).toBe(String(bytes.length))
    expect(res.rawPayload.equals(bytes)).toBe(true)

    const missing = await env.db.mediaArtifact.create({
      data: { organizationId, objectKey: `${organizationId}/gone/v1.mp4`, checksum: 'checksum-2', mimeType: 'video/mp4', version: 1 },
    })
    expect((await env.app.inject({ method: 'GET', url: `/api/artifacts/${missing.id}/content`, headers: authHeaders(viewerToken) })).statusCode).toBe(404)

    const foreign = await env.db.mediaArtifact.create({
      data: { organizationId: 'another-org', objectKey, checksum: 'checksum-3', mimeType: 'image/png', version: 2 },
    })
    expect((await env.app.inject({ method: 'GET', url: `/api/artifacts/${foreign.id}/content`, headers: authHeaders(viewerToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'GET', url: '/api/artifacts/does-not-exist/content', headers: authHeaders(viewerToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'GET', url: `/api/artifacts/${artifact.id}/content` })).statusCode).toBe(401)
  })

  it('surfaces artifacts and their latest quality check through the batch DTO', async () => {
    const artifact = await env.db.mediaArtifact.findFirstOrThrow({ where: { organizationId, taskId: videoTaskId } })
    for (const [kind, score] of [['visual', 0.4], ['visual', 0.9]] as const) {
      await env.db.qualityCheck.create({ data: { status: 'COMPLETED', kind, score, report: '{}', artifactId: artifact.id, batchId: null } })
    }
    const res = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(viewerToken) })
    const body = res.json() as { batches: BatchDto[] }
    const task = body.batches.flatMap(batch => batch.tasks).find(candidate => candidate.id === videoTaskId)!
    expect(task.artifacts).toEqual([{
      id: artifact.id,
      mimeType: 'image/png',
      objectKey: artifact.objectKey,
      version: artifact.version,
      width: 320,
      height: 240,
      durationMs: null,
      downloadUrl: `/artifacts/${artifact.id}/content`,
      // 生成产物永远没有原始文件名：那个名字只属于人自己传上来的音频。
      filename: null,
    }])
    expect(task.qc).toEqual({ kind: 'visual', score: 0.9, status: 'COMPLETED' })
    // qc 是最新一次的裁决；历史栏的「最高分」要的是全部尝试，两者必须同时下发。
    expect(task.scores).toEqual([0.9, 0.4])

    // An audit that could not happen writes a null score. It must stay null: a
    // coerced 0 would render as a red 0%, i.e. a failed judgment nobody made.
    await env.db.qualityCheck.create({
      data: { status: 'NEEDS_REVIEW', kind: 'visual-audit', score: null, report: '{}', artifactId: artifact.id, batchId: null },
    })
    const unjudged = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(viewerToken) })
    const unjudgedTask = (unjudged.json() as { batches: BatchDto[] }).batches
      .flatMap(batch => batch.tasks)
      .find(candidate => candidate.id === videoTaskId)!
    expect(unjudgedTask.qc).toEqual({ kind: 'visual-audit', score: null, status: 'NEEDS_REVIEW' })
    // 判不了的那次不进 scores：UI 拿它算最高分会凭空多出一回判定。
    expect(unjudgedTask.scores).toEqual([0.9, 0.4])
  })
})

describe('episode composition', () => {
  it('creates a running composition and enqueues the compose job', async () => {
    const forbidden = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/compositions`, headers: authHeaders(viewerToken) })
    expect(forbidden.statusCode).toBe(403)

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/compositions`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(201)
    const composition = res.json().composition as CompositionDto
    expect(composition.status).toBe('RUNNING')
    expect(composition.artifact).toBeNull()

    const job = await queue.getJob(`compose-${composition.id}`)
    expect(job?.name).toBe('compose-episode')
    expect(job?.data as ComposeEpisodePayload).toMatchObject({ kind: 'compose-episode', compositionId: composition.id, episodeId, organizationId })

    const stored = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
    expect(JSON.parse(stored.manifest)).toEqual({ storyboardIds })

    const listed = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(viewerToken) })
    expect((listed.json() as { composition: CompositionDto | null }).composition?.id).toBe(composition.id)
  })

  it('offers a finished composition its subtitle and score through the composition itself', async () => {
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
    const score = await env.db.mediaArtifact.create({
      data: { organizationId, stage: 'MUSIC', objectKey: `${organizationId}/comp/score/v1.m4a`, checksum: 'score-in-the-file', mimeType: 'audio/mp4', version: 1, durationMs: 6000 },
    })
    const finished = await env.db.composition.create({
      data: { episodeId, status: 'COMPLETED', manifest: JSON.stringify({ storyboardIds }), artifactId: master.id, subtitleArtifactId: subtitleArtifact.id, scoreArtifactId: score.id },
    })

    const res = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    const composition = (res.json() as { composition: CompositionDto | null }).composition!
    expect(composition.id).toBe(finished.id)
    expect(composition.artifact).toMatchObject({ id: master.id, downloadUrl: `/artifacts/${master.id}/content` })
    expect(composition.subtitle).toMatchObject({ id: subtitleArtifact.id, mimeType: 'application/x-subrip', downloadUrl: `/artifacts/${subtitleArtifact.id}/content` })
    // A newer score exists for this episode and is deliberately not the one named:
    // a score bought after the compose is not in this file.
    await env.db.mediaArtifact.create({
      data: { organizationId, stage: 'MUSIC', objectKey: `${organizationId}/comp/score/v2.m4a`, checksum: 'score-bought-later', mimeType: 'audio/mp4', version: 2, durationMs: 6000 },
    })
    const relisted = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(viewerToken) })
    expect((relisted.json() as { composition: CompositionDto | null }).composition?.score).toMatchObject({
      id: score.id,
      objectKey: `${organizationId}/comp/score/v1.m4a`,
      downloadUrl: `/artifacts/${score.id}/content`,
    })

    const downloaded = await env.app.inject({ method: 'GET', url: `/api/artifacts/${subtitleArtifact.id}/content`, headers: authHeaders(viewerToken) })
    expect(downloaded.statusCode).toBe(200)
    expect(downloaded.rawPayload.toString('utf8')).toBe(cues)
  })

  it('records trigger, cancel and composition events in the audit trail', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/audit-events', headers: authHeaders(ownerToken) })
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
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: `${name} EP1` } })
    expect(episode.statusCode).toBe(201)
    return { projectId, episodeId: episode.json().id as string }
  }

  async function addStoryboard(targetEpisodeId: string): Promise<void> {
    const storyboard = await env.app.inject({
      method: 'POST', url: `/api/episodes/${targetEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 1, title: 'SB1', durationMs: 5000, description: 'Rooftop chase', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(storyboard.statusCode).toBe(201)
  }

  // IMAGE triggers now run the prompt guard chain, and an unbound shot is blocked
  // before it can reach the candidate pool. This suite pins candidate ordering, so
  // its shots carry one bound asset each.
  async function bindSceneTo(targetEpisodeId: string, name: string): Promise<void> {
    const storyboard = await env.db.storyboard.findFirstOrThrow({ where: { episodeId: targetEpisodeId } })
    const created = await env.app.inject({
      method: 'POST', url: `/api/episodes/${targetEpisodeId}/assets`, headers: authHeaders(editorToken),
      payload: { kind: 'scene', name, description: `${name}，夜景` },
    })
    expect(created.statusCode).toBe(201)
    const assetId = created.json().asset.id as string
    await env.db.asset.update({ where: { id: assetId }, data: { status: 'APPROVED' } })
    await env.db.storyboardAsset.create({ data: { storyboardId: storyboard.id, assetId, role: 'scene' } })
  }

  async function newConnection(name: string): Promise<Connection> {
    const created = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name, apiKey: 'test-key' } })
    expect(created.statusCode).toBe(201)
    const connection = created.json() as Connection
    const probe = await env.app.inject({ method: 'POST', url: `/api/providers/connections/${connection.id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    return connection
  }

  async function bindSlot(slot: string, capabilityId: string, scope?: string, priority = 0): Promise<void> {
    const binding = await env.app.inject({ method: 'POST', url: '/api/bindings', headers: authHeaders(ownerToken), payload: { slot, capabilityId, projectId: scope, priority } })
    expect(binding.statusCode).toBe(201)
  }

  const capabilityOf = (connection: Connection, model: string) => connection.capabilities.find(capability => capability.model === model)!.id

  it('enqueues project scope first, priority descending within a scope, deduplicated by capability', async () => {
    const { projectId, episodeId: freshEpisodeId } = await newEpisode('Resolve Order Drama')
    await addStoryboard(freshEpisodeId)
    await bindSceneTo(freshEpisodeId, '天台')
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

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${freshEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'IMAGE' } })
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

    const whileEnabled = await env.app.inject({ method: 'POST', url: `/api/episodes/${connectionEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'IMAGE' } })
    expect(whileEnabled.statusCode).toBe(201)

    const disabled = await env.app.inject({ method: 'PATCH', url: `/api/providers/connections/${connection.id}`, headers: authHeaders(ownerToken), payload: { enabled: false } })
    expect(disabled.statusCode).toBe(200)
    // A different stage on the same episode, so the idempotency key cannot mask the 409.
    const afterDisable = await env.app.inject({ method: 'POST', url: `/api/episodes/${connectionEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'AUDIO' } })
    expect(afterDisable.statusCode).toBe(409)
    expect(afterDisable.json().error).toBe('no verified candidates for slot tts_voice')

    const { episodeId: entitlementEpisodeId } = await newEpisode('Resolve Unverified Drama')
    await env.db.scriptVersion.create({ data: { episodeId: entitlementEpisodeId, version: 1, content: 'a script', checksum: 'resolve-unverified', status: 'APPROVED' } })
    const unverifiedConnection = await newConnection('filter-stale-gen')
    const capabilityId = capabilityOf(unverifiedConnection, 'mock-text')
    await bindSlot('storyboard_text', capabilityId)
    // Revoke both tiers: the connection probe's credential stamp and any model-level belief.
    await env.db.modelCapability.update({ where: { id: capabilityId }, data: { entitlementVerifiedAt: null, credentialVerifiedAt: null } })

    const afterRevoke = await env.app.inject({ method: 'POST', url: `/api/episodes/${entitlementEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'STORYBOARD' } })
    expect(afterRevoke.statusCode).toBe(409)
    expect(afterRevoke.json().error).toBe('no verified candidates for slot storyboard_text')
  })
})

describe('asset generation trigger', () => {
  async function newEpisode(name: string): Promise<{ projectId: string; episodeId: string }> {
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: `${name} EP1` } })
    expect(episode.statusCode).toBe(201)
    return { projectId, episodeId: episode.json().id as string }
  }

  async function newConnection(name: string): Promise<Connection> {
    const created = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name, apiKey: 'test-key' } })
    expect(created.statusCode).toBe(201)
    const connection = created.json() as Connection
    const probe = await env.app.inject({ method: 'POST', url: `/api/providers/connections/${connection.id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    return connection
  }

  async function bindSlot(slot: string, capabilityId: string, scope?: string, priority = 0): Promise<void> {
    const binding = await env.app.inject({ method: 'POST', url: '/api/bindings', headers: authHeaders(ownerToken), payload: { slot, capabilityId, projectId: scope, priority } })
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
      const created = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/assets`, headers: authHeaders(editorToken), payload: seed })
      expect(created.statusCode).toBe(201)
      assetIds.push(created.json().asset.id as string)
    }

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'ASSET' } })
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
      // 定妆照提示词 = 素材描述 + 该类型的设定图规格（角色为角色板新标准）+ 项目风格的视觉指令。
      // 规格只管版式与一致性，质感交给风格：建项目就带默认风格（写实风），所以这句风格
      // 指令是常驻的，而旧那句写死的「严禁照片级真人质感」必须让位，否则定妆照与逐镜
      // 首帧画风分叉，每镜都在跟自己的参考图打架。
      const projectStyle = OFFICIAL_STYLES.find(style => style.id === 'realistic')!
      const spec = seed.kind === 'character'
        ? '角色设定板（Character Board）：单张竖版海报式排版。内容按区块集成——①顶部角色名与身份标签；②脸部特写 4 个角度（正面/左右 45 度/侧面），眼神与表情各异；③全身三视图（正面/侧面/背面并排，头顶到脚底完整入画）；④服装与饰品细节拆解（绣纹、配饰、鞋履等圆形小图）；⑤表情参考 6 种小图（常态/喜/怒/惊/悲/思）。严格遵循描述中的年龄、性别与体型，不得幼化或美化；米白纯色背景，无水印；同一角色全板形象严格一致，一致性优先于美观。'
        : seed.kind === 'scene'
          ? '场景概念图：无人物空镜，构图与光线符合描述，细节清晰，无文字无水印。'
          : '道具设定图：单品居中，中性背景，细节清晰，无文字无水印。'
      // An ASSET task is a paid image request, so its snapshot carries the base seed the
      // reproducibility question is answered from (the worker test pins how it is derived).
      const snapshot = JSON.parse(task!.requestSnapshot ?? '')
      expect(snapshot).toEqual({
        input: { prompt: `${seed.kind} ${seed.name}: ${seed.description}\n\n${spec}\n\n画面文字规则（最高优先级）：画面中出现的任何文字（标题、标签、招牌、文书内容）一律使用简体中文，禁止出现英文单词或字母。\n\n视觉风格（只约束色彩与质感；严格遵守上方的设定板分区版式与纯色背景，禁止输出单张剧照或场景背景）：${getStyleAssetDirective(projectStyle)}` },
        parameters: { seed: expect.any(Number) },
        assetId,
      })
      expect(snapshot.input.prompt).not.toContain('严禁照片级真人质感')
      expect(Number.isInteger(snapshot.parameters.seed) && snapshot.parameters.seed >= 0 && snapshot.parameters.seed < 2_147_483_648).toBe(true)
    }

    // A per-asset batch connects no storyboards.
    const linked = await env.db.generationBatch.findUniqueOrThrow({ where: { id: batch.id }, include: { storyboards: true } })
    expect(linked.storyboards).toEqual([])
  })

  it('returns the existing batch on a duplicate asset trigger', async () => {
    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${assetEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'ASSET' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().batch.id).toBe(assetBatchId)
    expect(await env.db.generationTask.count({ where: { batchId: assetBatchId } })).toBe(2)
  })

  it('refuses viewers and episodes without assets', async () => {
    const forbidden = await env.app.inject({ method: 'POST', url: `/api/episodes/${assetEpisodeId}/generations`, headers: authHeaders(viewerToken), payload: { stage: 'ASSET' } })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toMatch(/generation:trigger/)

    const empty = await env.app.inject({ method: 'POST', url: `/api/projects/${assetProjectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 2, title: 'Asset Drama EP2' } })
    expect(empty.statusCode).toBe(201)
    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${empty.json().id as string}/generations`, headers: authHeaders(editorToken), payload: { stage: 'ASSET' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'episode has no assets to generate' })
  })
})

describe('storyboard media', () => {
  it('exposes each storyboard\'s latest succeeded first-frame and video, and null when absent', async () => {
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 7, title: 'Media EP' } })
    expect(episode.statusCode).toBe(201)
    const mediaEpisodeId = episode.json().id as string

    const storyboardIdsLocal: string[] = []
    for (const [number, title] of [[1, 'Media SB1'], [2, 'Media SB2']] as const) {
      const created = await env.app.inject({
        method: 'POST', url: `/api/episodes/${mediaEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
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

    const res = await env.app.inject({ method: 'GET', url: `/api/episodes/${mediaEpisodeId}/storyboards`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ id: string; firstFrame: ArtifactDto | null; video: ArtifactDto | null }>
    const populated = rows.find(row => row.id === withMedia)!
    expect(populated.firstFrame).toMatchObject({ id: firstFrame.id, mimeType: 'image/png', downloadUrl: `/artifacts/${firstFrame.id}/content` })
    expect(populated.video).toMatchObject({ id: video.id, mimeType: 'video/mp4', downloadUrl: `/artifacts/${video.id}/content` })
    const bare = rows.find(row => row.id === withoutMedia)!
    expect(bare.firstFrame).toBeNull()
    expect(bare.video).toBeNull()
  })

  it('serves the execution log trail of a task', async () => {
    // 直接给任务种日志行,验证查询端点按时间返回且只属于自己的组织。
    const logTask = await env.db.generationTask.create({
      data: { organizationId, batchId: scriptBatchId ?? (await env.db.generationBatch.create({ data: { organizationId, episodeId, stage: 'SCRIPT', status: 'COMPLETED', plannedCount: 1 } })).id, stage: 'SCRIPT', status: 'RUNNING', idempotencyKey: `${episodeId}:LOG:${randomUUID()}` },
    })
    await env.db.generationLog.createMany({
      data: [
        { organizationId, taskId: logTask.id, batchId: logTask.batchId, episodeId, stage: 'SCRIPT', level: 'info', event: 'task.start', message: 'attempt 1' },
        { organizationId, taskId: logTask.id, batchId: logTask.batchId, episodeId, stage: 'SCRIPT', level: 'warn', event: 'candidate.skip', message: 'wan3.0-video: quota gone' },
      ],
    })

    const res = await env.app.inject({ method: 'GET', url: `/api/generations/tasks/${logTask.id}/logs`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { logs: Array<{ event: string; level: string; message: string }> }
    expect(body.logs.map(log => log.event)).toEqual(['task.start', 'candidate.skip'])

    const missing = await env.app.inject({ method: 'GET', url: '/api/generations/tasks/nope/logs', headers: authHeaders(viewerToken) })
    expect(missing.statusCode).toBe(404)
  })

  it('prefers the latest revision when a storyboard has been regenerated', async () => {
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 8, title: 'Revision EP' } })
    expect(episode.statusCode).toBe(201)
    const revisionEpisodeId = episode.json().id as string
    const created = await env.app.inject({
      method: 'POST', url: `/api/episodes/${revisionEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
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

    const res = await env.app.inject({ method: 'GET', url: `/api/episodes/${revisionEpisodeId}/storyboards`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ id: string; firstFrame: ArtifactDto | null }>
    const row = rows.find(candidate => candidate.id === sbId)!
    expect(row.firstFrame).toMatchObject({ id: regenArtifact.id, downloadUrl: `/artifacts/${regenArtifact.id}/content` })
    expect(row.firstFrame?.id).not.toBe(baseArtifact.id)
  })

  it('clears a stage error the moment a newer take succeeds, and shows a newer failure over an older win', async () => {
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 10, title: 'Error Cleared EP' } })
    expect(episode.statusCode).toBe(201)
    const errorEpisodeId = episode.json().id as string
    const created = await env.app.inject({
      method: 'POST', url: `/api/episodes/${errorEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 1, title: 'Err SB1', durationMs: 5000, description: 'a lane', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(created.statusCode).toBe(201)
    const sbId = created.json().id as string

    async function createTask(stage: 'FIRST_FRAME' | 'VIDEO', status: 'SUCCEEDED' | 'FAILED' | 'QUEUED', at: string, key: string, errorSnapshot?: string) {
      return env.db.generationTask.create({
        data: {
          organizationId, stage, status, storyboardId: sbId,
          idempotencyKey: `${errorEpisodeId}:${stage}:${sbId}${key}`,
          createdAt: new Date(at), ...(errorSnapshot ? { errorSnapshot } : {}),
          batchId: (await env.db.generationBatch.create({ data: { organizationId, episodeId: errorEpisodeId, stage, status: 'COMPLETED', plannedCount: 1 } })).id,
        },
      })
    }

    // 旧失败:额度耗尽,横幅出现在首帧列。
    await createTask('FIRST_FRAME', 'FAILED', '2024-01-01T00:00:00Z', '', '["quota gone"]')
    let rows = (await env.app.inject({ method: 'GET', url: `/api/episodes/${errorEpisodeId}/storyboards`, headers: authHeaders(viewerToken) })).json() as Array<{ id: string; firstFrameError: string | null; firstFrame: unknown }>
    expect(rows.find(row => row.id === sbId)!.firstFrameError).toContain('quota gone')

    // 重生成成功:产物落位,旧失败横幅必须随之消失。
    const okTask = await createTask('FIRST_FRAME', 'SUCCEEDED', '2024-06-01T00:00:00Z', ':r1')
    await env.db.mediaArtifact.create({ data: { organizationId, taskId: okTask.id, stage: 'FIRST_FRAME', objectKey: `${organizationId}/err/ff.png`, checksum: 'err-ff', mimeType: 'image/png', version: 1, width: 320, height: 240 } })
    rows = (await env.app.inject({ method: 'GET', url: `/api/episodes/${errorEpisodeId}/storyboards`, headers: authHeaders(viewerToken) })).json() as Array<{ id: string; firstFrameError: string | null; firstFrame: unknown }>
    const cleared = rows.find(row => row.id === sbId)!
    expect(cleared.firstFrame).not.toBeNull()
    expect(cleared.firstFrameError).toBeNull()

    // 成功之后又失败:显示的是新失败,而不是继续挂着旧失败。
    await createTask('FIRST_FRAME', 'FAILED', '2024-09-01T00:00:00Z', ':r2', '["new failure"]')
    rows = (await env.app.inject({ method: 'GET', url: `/api/episodes/${errorEpisodeId}/storyboards`, headers: authHeaders(viewerToken) })).json() as Array<{ id: string; firstFrameError: string | null; firstFrame: unknown }>
    const refailed = rows.find(row => row.id === sbId)!
    expect(refailed.firstFrameError).toContain('new failure')
    expect(refailed.firstFrameError).not.toContain('quota gone')

    // 点了重新生成:一次更新的尝试在途,旧失败横幅退场(进行中的展示由 busy 指示负责)。
    await createTask('FIRST_FRAME', 'QUEUED', '2024-12-01T00:00:00Z', ':r3')
    rows = (await env.app.inject({ method: 'GET', url: `/api/episodes/${errorEpisodeId}/storyboards`, headers: authHeaders(viewerToken) })).json() as Array<{ id: string; firstFrameError: string | null; firstFrame: unknown }>
    expect(rows.find(row => row.id === sbId)!.firstFrameError).toBeNull()
  })

  it('files a hand-added shot in the live revision and scopes number conflicts to it', async () => {
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 9, title: 'Hand Add EP' } })
    expect(episode.statusCode).toBe(201)
    const handEpisodeId = episode.json().id as string
    const first = await env.app.inject({
      method: 'POST', url: `/api/episodes/${handEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
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
      method: 'POST', url: `/api/episodes/${handEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 2, title: 'Hand SB2', durationMs: 5000, description: 'an alley', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(added.statusCode).toBe(201)
    expect(added.json().revision).toBe(2)
    expect(added.json().supersededAt).toBeNull()

    // Number 1 is taken in the live revision but free in the archived one, so
    // the conflict is reported against the revision, not the episode.
    const clash = await env.app.inject({
      method: 'POST', url: `/api/episodes/${handEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 1, title: 'Hand SB1 dup', durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error).toContain('already exists in this revision')

    const live = await env.app.inject({ method: 'GET', url: `/api/episodes/${handEpisodeId}/storyboards`, headers: authHeaders(viewerToken) })
    const rows = live.json() as Array<{ revision: number; number: number }>
    expect(rows.map(row => `${row.revision}.${row.number}`).sort()).toEqual(['2.1', '2.2'])
  })
})

describe('AI content stage gating', () => {
  it('refuses SCRIPT generation without an approved source', async () => {
    const ep = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 20, title: 'No Source EP' } })
    const epId = ep.json().id as string
    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${epId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'SCRIPT' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('generations:noApprovedSource')
  })

  it('refuses STORYBOARD generation without an approved script', async () => {
    const ep = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 21, title: 'No Script EP' } })
    const epId = ep.json().id as string
    await env.db.sourceDocumentVersion.create({ data: { episodeId: epId, version: 1, content: 'a source', checksum: 'gate-src', status: 'APPROVED' } })
    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${epId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'STORYBOARD' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('generations:noApprovedScript')
  })

  it('refuses media stages without an approved script', async () => {
    const ep = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 23, title: 'No Script Media EP' } })
    const epId = ep.json().id as string
    // A storyboard so IMAGE/VIDEO reach the script gate rather than the
    // "no storyboards to generate" 400.
    const sb = await env.app.inject({
      method: 'POST', url: `/api/episodes/${epId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 1, title: 'SB1', durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(sb.statusCode).toBe(201)
    for (const stage of ['IMAGE', 'VIDEO', 'AUDIO']) {
      const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${epId}/generations`, headers: authHeaders(editorToken), payload: { stage } })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBe('generations:noApprovedScript')
    }
  })

  it('links generated storyboards to the approved script in the request snapshot', async () => {
    const capability = await env.db.modelCapability.findFirstOrThrow({ where: { model: 'mock-text', connection: { organizationId } } })
    await env.app.inject({ method: 'POST', url: '/api/bindings', headers: authHeaders(ownerToken), payload: { slot: 'storyboard_text', capabilityId: capability.id } })

    const ep = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 22, title: 'Script EP' } })
    const epId = ep.json().id as string
    const script = await env.db.scriptVersion.create({ data: { episodeId: epId, version: 1, content: 'the approved script', checksum: 'gate-script', status: 'APPROVED' } })

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${epId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'STORYBOARD' } })
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
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'Pipeline Drama' } })
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'EP' } })
    const episodeId = episode.json().id as string

    const nothing = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(nothing.statusCode).toBe(409)
    expect(nothing.json().error).toBe('pipeline:nothingRunnable')

    // Approved in the store rather than through the endpoint: an approval request now
    // starts the chain itself, and this test is about the button doing the advancing.
    await env.db.sourceDocumentVersion.create({ data: { episodeId, version: 1, content: 'a source document', checksum: 'pipeline-src', status: 'APPROVED' } })

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(201)
    expect(res.json().stage).toBe('SCRIPT')
    expect((res.json().batch as BatchDto).stage).toBe('SCRIPT')

    // Clicking again does not buy the same stage twice.
    const again = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('pipeline:nothingRunnable')
  })

  it('advances past IMAGE to VIDEO once first frames already ran', async () => {
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'Advance Drama' } })
    const advanceProjectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${advanceProjectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'EP' } })
    const advanceEpisodeId = episode.json().id as string
    // An approved script and a storyboard make IMAGE and VIDEO eligible; mark
    // SCRIPT, STORYBOARD and FIRST_FRAME (the DB value for IMAGE) as already run
    // so the next runnable stage is VIDEO, not a re-run of IMAGE.
    await env.db.scriptVersion.create({ data: { episodeId: advanceEpisodeId, version: 1, content: 'a script', checksum: 'advance-script', status: 'APPROVED' } })
    await env.app.inject({
      method: 'POST', url: `/api/episodes/${advanceEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 1, title: 'SB1', durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    for (const stage of ['SCRIPT', 'STORYBOARD', 'FIRST_FRAME'] as const) {
      await env.db.generationBatch.create({ data: { organizationId, episodeId: advanceEpisodeId, stage, status: 'COMPLETED', plannedCount: 1 } })
    }

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${advanceEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(201)
    expect(res.json().stage).toBe('VIDEO')
  })
})

describe('regenerate', () => {
  it('creates a new revision batch with suffixed keys, leaves the base intact, and audits distinctly', async () => {
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'Regenerate Drama' } })
    expect(project.statusCode).toBe(201)
    const regenProjectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${regenProjectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'Regen EP' } })
    expect(episode.statusCode).toBe(201)
    const regenEpisodeId = episode.json().id as string
    // SCRIPT is gated on an approved source.
    await env.db.sourceDocumentVersion.create({ data: { episodeId: regenEpisodeId, version: 1, content: 'a source', checksum: 'regen-src', status: 'APPROVED' } })

    // Base run: no revision suffix.
    const base = await env.app.inject({ method: 'POST', url: `/api/episodes/${regenEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'SCRIPT' } })
    expect(base.statusCode).toBe(201)
    const baseBatch = base.json().batch as BatchDto
    const baseTask = await env.db.generationTask.findUniqueOrThrow({ where: { id: baseBatch.tasks[0].id } })
    expect(baseTask.idempotencyKey).toBe(`${regenEpisodeId}:SCRIPT:${regenEpisodeId}`)

    // First regenerate: revision 1 → ':r1', a brand-new batch and task.
    const regen = await env.app.inject({ method: 'POST', url: `/api/episodes/${regenEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'SCRIPT', regenerate: true } })
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
    const regen2 = await env.app.inject({ method: 'POST', url: `/api/episodes/${regenEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'SCRIPT', regenerate: true } })
    expect(regen2.statusCode).toBe(201)
    const regen2Batch = regen2.json().batch as BatchDto
    const regen2Task = await env.db.generationTask.findUniqueOrThrow({ where: { id: regen2Batch.tasks[0].id } })
    expect(regen2Task.idempotencyKey).toBe(`${regenEpisodeId}:SCRIPT:${regenEpisodeId}:r2`)

    // Three distinct SCRIPT batches: the base plus two revisions.
    expect(await env.db.generationBatch.count({ where: { episodeId: regenEpisodeId, stage: 'SCRIPT' } })).toBe(3)

    // Regenerating is audited as generation.regenerate, carrying the revision;
    // the plain trigger is not.
    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=generation.regenerate', headers: authHeaders(ownerToken) })
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
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: `${name} EP1` } })
    expect(episode.statusCode).toBe(201)
    return { projectId, episodeId: episode.json().id as string }
  }

  async function addShots(targetEpisodeId: string, scriptVersionId?: string): Promise<string[]> {
    const ids: string[] = []
    for (const [number, title] of [[1, 'SB1'], [2, 'SB2']] as const) {
      const created = await env.app.inject({
        method: 'POST', url: `/api/episodes/${targetEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
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
    const created = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name, apiKey: 'test-key' } })
    expect(created.statusCode).toBe(201)
    const connection = created.json() as Connection
    const probe = await env.app.inject({ method: 'POST', url: `/api/providers/connections/${connection.id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    return connection
  }

  async function bindSlot(slot: string, capabilityId: string, scope?: string): Promise<void> {
    const binding = await env.app.inject({ method: 'POST', url: '/api/bindings', headers: authHeaders(ownerToken), payload: { slot, capabilityId, projectId: scope } })
    expect(binding.statusCode).toBe(201)
  }

  const capabilityOf = (connection: Connection, model: string) => connection.capabilities.find(capability => capability.model === model)!.id

  it('lists the live shots with their lineage, and returns the superseded ones on request', async () => {
    const { projectId: historyProjectId, episodeId: historyEpisodeId } = await newEpisode('Revision History Drama')
    const firstRevision = await addShots(historyEpisodeId)
    const { superseded, live } = await regenerateShots(historyEpisodeId, 2)
    expect(superseded).toEqual(firstRevision)

    const listed = await env.app.inject({ method: 'GET', url: `/api/episodes/${historyEpisodeId}/storyboards`, headers: authHeaders(viewerToken) })
    expect(listed.statusCode).toBe(200)
    const rows = listed.json() as StoryboardRowDto[]
    expect(rows.map(row => row.id)).toEqual(live)
    expect(rows.map(row => [row.revision, row.number])).toEqual([[2, 1], [2, 2]])
    expect(rows.every(row => row.supersededAt === null && row.generationTaskId === null)).toBe(true)

    const history = await env.app.inject({ method: 'GET', url: `/api/episodes/${historyEpisodeId}/storyboards?includeSuperseded=true`, headers: authHeaders(viewerToken) })
    expect(history.statusCode).toBe(200)
    const all = history.json() as StoryboardRowDto[]
    expect(all.map(row => [row.revision, row.number])).toEqual([[1, 1], [1, 2], [2, 1], [2, 2]])
    expect(all.filter(row => row.supersededAt !== null).map(row => row.id)).toEqual(firstRevision)
    expect(all.find(row => row.id === firstRevision[0])!.supersededAt).toBe(supersededStamp.toISOString())

    // The episode's nested shot list is what the console counts, so it describes the
    // breakdown in use rather than its history.
    const episodes = await env.app.inject({ method: 'GET', url: `/api/projects/${historyProjectId}/episodes`, headers: authHeaders(viewerToken) })
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
      const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${mediaEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage } })
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
      method: 'POST', url: `/api/episodes/${mediaEpisodeId}/generations`, headers: authHeaders(editorToken),
      payload: { stage: 'VIDEO', storyboardIds: [superseded[0]] },
    })
    expect(explicit.statusCode).toBe(400)
    expect(explicit.json().error).toBe('storyboardIds must belong to this episode')
  })

  it('writes a composition manifest of live shots only', async () => {
    const { episodeId: composeEpisodeId } = await newEpisode('Revision Compose Drama')
    await addShots(composeEpisodeId)
    const { superseded, live } = await regenerateShots(composeEpisodeId, 2)

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${composeEpisodeId}/compositions`, headers: authHeaders(editorToken) })
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
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: `${name} EP1` } })
    expect(episode.statusCode).toBe(201)
    return { projectId, episodeId: episode.json().id as string }
  }

  async function addShots(targetEpisodeId: string): Promise<string[]> {
    const ids: string[] = []
    for (const [number, title] of [[1, 'SB1'], [2, 'SB2']] as const) {
      const created = await env.app.inject({
        method: 'POST', url: `/api/episodes/${targetEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
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
    const connection = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name: 'stale-media', apiKey: 'test-key' } })
    expect(connection.statusCode).toBe(201)
    const capabilities = (connection.json() as Connection).capabilities
    await env.app.inject({ method: 'POST', url: `/api/providers/connections/${(connection.json() as Connection).id}/probe`, headers: authHeaders(ownerToken) })
    const binding = await env.app.inject({ method: 'POST', url: '/api/bindings', headers: authHeaders(ownerToken), payload: { slot: 'image_gen', capabilityId: capabilities.find(capability => capability.model === 'mock-image')!.id, projectId: staleProjectId } })
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

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${staleEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
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

  it('composes once every live shot has a clip, and re-composes after a late voice or a regenerate', async () => {
    const { episodeId: terminalEpisodeId } = await newEpisode('Terminal Step Drama')
    await env.db.scriptVersion.create({ data: { episodeId: terminalEpisodeId, version: 1, content: 'a script', checksum: 'terminal-script', status: 'APPROVED' } })
    const live = await addShots(terminalEpisodeId)
    for (const stage of ['SCRIPT', 'STORYBOARD', 'FIRST_FRAME'] as const) {
      await env.db.generationBatch.create({ data: { organizationId, episodeId: terminalEpisodeId, stage, status: 'COMPLETED', plannedCount: 1 } })
    }

    // A shot without a clip leaves the pipeline idle: composing now would only park
    // the master in BLOCKED.
    await seedClip(terminalEpisodeId, live[0])
    const idle = await env.app.inject({ method: 'POST', url: `/api/episodes/${terminalEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(idle.statusCode).toBe(409)
    expect(idle.json().error).toBe('pipeline:nothingRunnable')
    expect(await env.db.composition.count({ where: { episodeId: terminalEpisodeId } })).toBe(0)

    await seedClip(terminalEpisodeId, live[1])
    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${terminalEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
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
    const again = await env.app.inject({ method: 'POST', url: `/api/episodes/${terminalEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('pipeline:nothingRunnable')
    expect(await env.db.composition.count({ where: { episodeId: terminalEpisodeId } })).toBe(1)

    // Until a line is voiced after that master was planned: the producer added a line,
    // the voice landed, and the file on disk does not contain it. Leaving the episode
    // on a silent master with no way back would trap the very edit the chain promises
    // to carry through.
    const voiceBatch = await env.db.generationBatch.create({
      data: { organizationId, episodeId: terminalEpisodeId, stage: 'AUDIO', status: 'COMPLETED', plannedCount: 1, storyboards: { connect: { id: live[0] } } },
    })
    const voiceTask = await env.db.generationTask.create({ data: { organizationId, batchId: voiceBatch.id, stage: 'AUDIO', status: 'SUCCEEDED', storyboardId: live[0] } })
    await env.db.mediaArtifact.create({
      data: { organizationId, taskId: voiceTask.id, stage: 'AUDIO', objectKey: `${organizationId}/comp/voice/v1.wav`, checksum: 'comp-voice', mimeType: 'audio/wav', version: 1, durationMs: 2000 },
    })
    await env.db.storyboard.update({ where: { id: live[0] }, data: { dialogue: '这条街不能待了。', speaker: '林澈' } })

    const recutAfterVoice = await env.app.inject({ method: 'POST', url: `/api/episodes/${terminalEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(recutAfterVoice.statusCode).toBe(201)
    expect(recutAfterVoice.json().stage).toBe('COMPOSITION')
    expect((recutAfterVoice.json().composition as CompositionDto).id).not.toBe(composition.id)
    expect(await env.db.composition.count({ where: { episodeId: terminalEpisodeId } })).toBe(2)

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

    const recut = await env.app.inject({ method: 'POST', url: `/api/episodes/${terminalEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(recut.statusCode).toBe(201)
    expect(recut.json().stage).toBe('COMPOSITION')
    const second = recut.json().composition as CompositionDto
    expect(second.id).not.toBe(composition.id)
    expect(JSON.parse((await env.db.composition.findUniqueOrThrow({ where: { id: second.id } })).manifest)).toEqual({ storyboardIds: revised })
    // Superseded masters are not deleted: each is the record of what was delivered.
    expect(await env.db.composition.count({ where: { episodeId: terminalEpisodeId } })).toBe(3)

    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=pipeline.advance', headers: authHeaders(ownerToken) })
    expect(audit.statusCode).toBe(200)
    const events = audit.json().events as { entityId: string; payload: { step?: string; compositionId?: string; storyboards?: number } }[]
    expect(events.some(event => event.entityId === terminalEpisodeId && event.payload.step === 'COMPOSITION' && event.payload.compositionId === composition.id && event.payload.storyboards === 2)).toBe(true)
  })
})

describe('script approval cascade', () => {
  let cascadeEpisodeId: string
  let approvedScriptId: string

  it('re-runs STORYBOARD as a regenerate when the live shots trace an older script version', async () => {
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'Cascade Drama' } })
    expect(project.statusCode).toBe(201)
    const cascadeProjectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${cascadeProjectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'Cascade EP1' } })
    expect(episode.statusCode).toBe(201)
    cascadeEpisodeId = episode.json().id as string

    const connection = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name: 'cascade-gen', apiKey: 'test-key' } })
    expect(connection.statusCode).toBe(201)
    const probe = await env.app.inject({ method: 'POST', url: `/api/providers/connections/${(connection.json() as Connection).id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    const capability = (connection.json() as Connection).capabilities.find(candidate => candidate.model === 'mock-text')!
    const binding = await env.app.inject({ method: 'POST', url: '/api/bindings', headers: authHeaders(ownerToken), payload: { slot: 'storyboard_text', capabilityId: capability.id, projectId: cascadeProjectId } })
    expect(binding.statusCode).toBe(201)

    const scriptV1 = await env.db.scriptVersion.create({ data: { episodeId: cascadeEpisodeId, version: 1, content: '第一版剧本', checksum: 'cascade-v1', status: 'APPROVED' } })
    const base = await env.app.inject({ method: 'POST', url: `/api/episodes/${cascadeEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'STORYBOARD' } })
    expect(base.statusCode).toBe(201)
    const baseBatch = base.json().batch as BatchDto

    // The worker wrote the breakdown out of version 1.
    for (const [number, title] of [[1, 'SB1'], [2, 'SB2']] as const) {
      const created = await env.app.inject({
        method: 'POST', url: `/api/episodes/${cascadeEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
        payload: { number, title, durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '', scriptVersionId: scriptV1.id },
      })
      expect(created.statusCode).toBe(201)
    }

    // A human edits the script and approves the edit.
    await env.db.scriptVersion.create({ data: { episodeId: cascadeEpisodeId, version: 2, content: '第二版剧本：追逐戏改到天台', checksum: 'cascade-v2', status: 'DRAFT' } })
    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${cascadeEpisodeId}/script-versions/2/approve`, headers: authHeaders(editorToken) })
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

    const cascadeAudit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=script.approve.cascade', headers: authHeaders(ownerToken) })
    expect(cascadeAudit.statusCode).toBe(200)
    const cascadeEvents = cascadeAudit.json().events as { entityId: string; entityType: string; payload: { episodeId: string; stage: string; batchId: string } }[]
    const cascadeEvent = cascadeEvents.filter(event => event.entityId === approvedScriptId)
    expect(cascadeEvent).toHaveLength(1)
    expect(cascadeEvent[0]).toMatchObject({ entityType: 'ScriptVersion', payload: { episodeId: cascadeEpisodeId, stage: 'STORYBOARD', batchId: cascadeBatchId } })

    const regenerateAudit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=generation.regenerate', headers: authHeaders(ownerToken) })
    const regenerateEvents = regenerateAudit.json().events as { entityId: string; payload: { stage: string } }[]
    expect(regenerateEvents.some(event => event.entityId === cascadeBatchId && event.payload.stage === 'STORYBOARD')).toBe(true)
  })

  it('does not cascade when the live shots already trace the version being approved', async () => {
    // The state the worker leaves behind once the regeneration lands: the live shots
    // are the ones broken out of version 2, so there is nothing left to regenerate.
    await env.db.storyboard.updateMany({ where: { episodeId: cascadeEpisodeId, supersededAt: null }, data: { scriptVersionId: approvedScriptId } })

    const edited = await env.app.inject({ method: 'PATCH', url: `/api/episodes/${cascadeEpisodeId}/script-versions/2`, headers: authHeaders(editorToken), payload: { content: '第二版剧本：只改一句台词' } })
    expect(edited.statusCode).toBe(200)
    expect(edited.json().version.status).toBe('DRAFT')

    const batchesBefore = await env.db.generationBatch.count({ where: { episodeId: cascadeEpisodeId, stage: 'STORYBOARD' } })
    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${cascadeEpisodeId}/script-versions/2/approve`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(200)
    expect(res.json().cascaded).toBe(false)
    expect(res.json().storyboardsUpdated).toBe(2)
    // Re-approving the version the breakdown already came from must not pay for the
    // same shots again.
    expect(await env.db.generationBatch.count({ where: { episodeId: cascadeEpisodeId, stage: 'STORYBOARD' } })).toBe(batchesBefore)

    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=script.approve.cascade', headers: authHeaders(ownerToken) })
    const events = audit.json().events as { entityId: string }[]
    expect(events.filter(event => event.entityId === approvedScriptId)).toHaveLength(1)
  })
})

describe('approval opens the next step', () => {
  async function newEpisode(name: string): Promise<{ projectId: string; episodeId: string }> {
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: `${name} EP1` } })
    expect(episode.statusCode).toBe(201)
    return { projectId, episodeId: episode.json().id as string }
  }

  // Project scope, so these tests do not ride on the org-wide bindings the suite
  // header made for other stages.
  async function bindContentSlots(targetProjectId: string, name: string): Promise<void> {
    const created = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name, apiKey: 'test-key' } })
    expect(created.statusCode).toBe(201)
    const connection = created.json() as Connection
    const probe = await env.app.inject({ method: 'POST', url: `/api/providers/connections/${connection.id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    for (const [slot, model] of [['script_text', 'mock-script'], ['storyboard_text', 'mock-storyboard']] as const) {
      const capability = connection.capabilities.find(candidate => candidate.model === model)!
      const binding = await env.app.inject({ method: 'POST', url: '/api/bindings', headers: authHeaders(ownerToken), payload: { slot, capabilityId: capability.id, projectId: targetProjectId } })
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

    const uploaded = await env.app.inject({ method: 'POST', url: `/api/episodes/${sourceEpisodeId}/source-versions`, headers: authHeaders(editorToken), payload: { content: '雨夜，滨江老城区。半张烧焦的老照片躺在积水里。' } })
    expect(uploaded.statusCode).toBe(201)
    expect(await env.db.generationBatch.count({ where: { episodeId: sourceEpisodeId } })).toBe(0)

    const approved = await env.app.inject({ method: 'POST', url: `/api/episodes/${sourceEpisodeId}/source-versions/1/approve`, headers: authHeaders(editorToken) })
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
    const derived = await env.app.inject({ method: 'POST', url: `/api/episodes/${scriptEpisodeId}/script-versions`, headers: authHeaders(editorToken), payload: { sourceVersion: 1 } })
    expect(derived.statusCode).toBe(201)
    const scriptVersionId = (derived.json().version as { id: string }).id

    const approved = await env.app.inject({ method: 'POST', url: `/api/episodes/${scriptEpisodeId}/script-versions/1/approve`, headers: authHeaders(editorToken) })
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
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(other.token), payload: { name: 'Approval Unbound Drama' } })
    expect(project.statusCode).toBe(201)
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${project.json().id as string}/episodes`, headers: authHeaders(other.token), payload: { number: 1, title: 'EP1' } })
    expect(episode.statusCode).toBe(201)
    const unboundEpisodeId = episode.json().id as string

    await env.app.inject({ method: 'POST', url: `/api/episodes/${unboundEpisodeId}/source-versions`, headers: authHeaders(other.token), payload: { content: 'a source with nowhere to run' } })
    const approved = await env.app.inject({ method: 'POST', url: `/api/episodes/${unboundEpisodeId}/source-versions/1/approve`, headers: authHeaders(other.token) })
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
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: `${name} EP1` } })
    expect(episode.statusCode).toBe(201)
    return { projectId, episodeId: episode.json().id as string }
  }

  // Project scope, so these bindings cannot change what the earlier tests resolve.
  async function bindAudioSlot(targetProjectId: string, slot: 'tts_voice' | 'music_gen', model: string, name: string): Promise<void> {
    const created = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name, apiKey: 'test-key' } })
    expect(created.statusCode).toBe(201)
    const connection = created.json() as Connection
    const probe = await env.app.inject({ method: 'POST', url: `/api/providers/connections/${connection.id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    const capability = connection.capabilities.find(candidate => candidate.model === model)!
    const binding = await env.app.inject({ method: 'POST', url: '/api/bindings', headers: authHeaders(ownerToken), payload: { slot, capabilityId: capability.id, projectId: targetProjectId } })
    expect(binding.statusCode).toBe(201)
  }

  async function addShot(targetEpisodeId: string, number: number, dialogue: string, speaker?: string): Promise<string> {
    const created = await env.app.inject({
      method: 'POST', url: `/api/episodes/${targetEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
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

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'AUDIO' } })
    expect(res.statusCode).toBe(201)
    const batch = res.json().batch as BatchDto
    expect(batch.stage).toBe('AUDIO')
    expect(batch.plannedCount).toBe(2)
    audioBatchId = batch.id

    const tasks = await env.db.generationTask.findMany({ where: { batchId: batch.id }, orderBy: { id: 'asc' } })
    expect(tasks.map(task => task.storyboardId)).toEqual(speakingIds)
    // The console reads the DTO, not the row: a voice that does not name its shot there
    // is indistinguishable from another shot's voice.
    expect(batch.tasks.map(task => task.storyboardId)).toEqual(speakingIds)
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
    const again = await env.app.inject({ method: 'POST', url: `/api/episodes/${voiceEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'AUDIO' } })
    expect(again.statusCode).toBe(200)
    expect((again.json().batch as BatchDto).id).toBe(audioBatchId)

    const regenerated = await env.app.inject({ method: 'POST', url: `/api/episodes/${voiceEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'AUDIO', regenerate: true } })
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

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'AUDIO' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('episode has no shots with dialogue to voice')
    expect(await env.db.generationBatch.count({ where: { episodeId } })).toBe(0)
  })

  it('exposes the line, its speaker and the shot voice, and lets a human rewrite them', async () => {
    await seedMedia(voiceEpisodeId, 'AUDIO', speakingIds[0])

    const listed = await env.app.inject({ method: 'GET', url: `/api/episodes/${voiceEpisodeId}/storyboards`, headers: authHeaders(editorToken) })
    expect(listed.statusCode).toBe(200)
    const shots = listed.json() as ShotDto[]
    expect(shots).toHaveLength(3)
    expect(shots[0]).toMatchObject({ number: 1, dialogue: '这条街不能待了。', speaker: '林晚' })
    expect(shots[0]!.voice).toMatchObject({ mimeType: 'audio/wav', objectKey: expect.stringContaining('/AUDIO/') })
    expect(shots[0]!.voice!.downloadUrl).toBe(`/artifacts/${shots[0]!.voice!.id}/content`)
    // A shot that has not been voiced yet says so, rather than pretending.
    expect(shots[1]!.voice).toBeNull()
    expect(shots[2]!.dialogue).toBe('')

    const edited = await env.app.inject({ method: 'PATCH', url: `/api/storyboards/${speakingIds[1]}`, headers: authHeaders(editorToken), payload: { dialogue: '  你先走。 ', speaker: '沈亦' } })
    expect(edited.statusCode).toBe(200)
    expect(edited.json().dialogue).toBe('你先走。')
    expect(edited.json().speaker).toBe('沈亦')

    const cleared = await env.app.inject({ method: 'PATCH', url: `/api/storyboards/${speakingIds[1]}`, headers: authHeaders(editorToken), payload: { dialogue: '', speaker: null } })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json()).toMatchObject({ dialogue: '', speaker: null })

    // Put the line back: the composition assertions below depend on two speaking shots.
    await env.app.inject({ method: 'PATCH', url: `/api/storyboards/${speakingIds[1]}`, headers: authHeaders(editorToken), payload: { dialogue: '我跟你走。', speaker: '' } })
    const afterEdit = await env.app.inject({ method: 'GET', url: `/api/episodes/${voiceEpisodeId}/storyboards`, headers: authHeaders(editorToken) })
    expect((afterEdit.json() as ShotDto[])[1]).toMatchObject({ dialogue: '我跟你走。', speaker: null })

    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=storyboard.update', headers: authHeaders(ownerToken) })
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
    const blocked = await env.app.inject({ method: 'POST', url: `/api/episodes/${voiceEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error).toBe('pipeline:nothingRunnable')
    // The generic error says the chain has no next step; the reason says what is missing.
    expect(blocked.json().reasons).toEqual(['composition:missingVoice'])
    expect(await env.db.composition.count({ where: { episodeId: voiceEpisodeId } })).toBe(0)

    await seedMedia(voiceEpisodeId, 'AUDIO', speakingIds[1])
    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${voiceEpisodeId}/run-pipeline`, headers: authHeaders(editorToken) })
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

    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(editorToken), payload: { stage: 'MUSIC' } })
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

// A project decides what language the models write. These walk an English episode
// through the stages whose prompt is authored rather than derived from approved
// content, so a locale that reaches the API but never the vendor request cannot
// pass unnoticed.
describe('project content language', () => {
  async function newProject(name: string, contentLocale?: string): Promise<string> {
    const res = await env.app.inject({
      method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken),
      payload: { name, ...(contentLocale ? { contentLocale } : {}) },
    })
    expect(res.statusCode).toBe(201)
    return res.json().id as string
  }

  async function newEpisode(name: string, contentLocale?: string): Promise<{ projectId: string; episodeId: string }> {
    const projectId = await newProject(name, contentLocale)
    const episode = await env.app.inject({
      method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken),
      payload: { number: 1, title: `${name} EP1` },
    })
    expect(episode.statusCode).toBe(201)
    return { projectId, episodeId: episode.json().id as string }
  }

  // Project scope, so these cannot disturb what the earlier tests resolve.
  async function bindSlot(targetProjectId: string, slot: string, model: string, name: string): Promise<void> {
    const created = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name, apiKey: 'test-key' } })
    expect(created.statusCode).toBe(201)
    const connection = created.json() as Connection
    const probe = await env.app.inject({ method: 'POST', url: `/api/providers/connections/${connection.id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    const capability = connection.capabilities.find(candidate => candidate.model === model)!
    const binding = await env.app.inject({ method: 'POST', url: '/api/bindings', headers: authHeaders(ownerToken), payload: { slot, capabilityId: capability.id, projectId: targetProjectId } })
    expect(binding.statusCode).toBe(201)
  }

  async function trigger(targetEpisodeId: string, stage: string): Promise<BatchDto> {
    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${targetEpisodeId}/generations`, headers: authHeaders(editorToken), payload: { stage } })
    expect(res.statusCode).toBe(201)
    return res.json().batch as BatchDto
  }

  async function requestInput(taskId: string): Promise<{ prompt: string; contentLocale?: string }> {
    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: taskId } })
    return (JSON.parse(task.requestSnapshot ?? '') as { input: { prompt: string; contentLocale?: string } }).input
  }

  it('defaults to Chinese, stores an explicit choice and rejects a language the pipeline cannot write', async () => {
    const plainProjectId = await newProject('Locale Default Drama')
    expect((await env.db.project.findUniqueOrThrow({ where: { id: plainProjectId } })).contentLocale).toBe('zh')
    expect(await newProject('Locale English Drama', 'en')).toBeTruthy()

    const unsupported = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'Locale French Drama', contentLocale: 'fr' } })
    expect(unsupported.statusCode).toBe(400)
    expect(unsupported.json().error).toContain('contentLocale')

    const renamed = await env.app.inject({ method: 'PATCH', url: `/api/projects/${plainProjectId}`, headers: authHeaders(ownerToken), payload: { name: 'Renamed In Place' } })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).toMatchObject({ name: 'Renamed In Place', contentLocale: 'zh' })

    const languageOnly = await env.app.inject({ method: 'PATCH', url: `/api/projects/${plainProjectId}`, headers: authHeaders(ownerToken), payload: { contentLocale: 'en' } })
    expect(languageOnly.statusCode).toBe(200)
    expect(languageOnly.json()).toMatchObject({ name: 'Renamed In Place', contentLocale: 'en' })

    const empty = await env.app.inject({ method: 'PATCH', url: `/api/projects/${plainProjectId}`, headers: authHeaders(ownerToken), payload: {} })
    expect(empty.statusCode).toBe(400)
  })

  it('prompts and voices an English project in English', async () => {
    const { projectId, episodeId } = await newEpisode('English Episode Drama', 'en')
    await bindSlot(projectId, 'storyboard_text', 'mock-storyboard', 'locale-storyboard')
    await bindSlot(projectId, 'tts_voice', 'mock-tts', 'locale-tts')
    await env.db.sourceDocumentVersion.create({
      data: { episodeId, version: 1, content: 'Novel excerpt: a disappearance on a rainy night in Binjiang.', checksum: `locale-src-${episodeId}`, status: 'APPROVED' },
    })

    const scriptBatch = await trigger(episodeId, 'SCRIPT')
    const script = await requestInput(scriptBatch.tasks[0].id)
    expect(script.contentLocale).toBe('en')
    // The Chinese template is still the base — the directive is appended to it, which
    // is what keeps a Chinese project's bytes untouched; duration rules ride the base.
    expect(script.prompt).toContain('根据以下源文档')
    expect(script.prompt).toContain('时长与结构要求')
    expect(script.prompt).toContain('## Output language (highest priority)')

    await env.db.scriptVersion.create({
      data: { episodeId, version: 1, content: 'Shen Yi lifts a torn photograph out of a puddle.', checksum: `locale-script-${episodeId}`, status: 'APPROVED' },
    })
    const boardBatch = await trigger(episodeId, 'STORYBOARD')
    const board = await requestInput(boardBatch.tasks[0].id)
    expect(board.contentLocale).toBe('en')
    // The keys and the kind vocabulary are what the worker parses; an English reply
    // that translates either yields an episode with no shots, so both must be named.
    for (const literal of ['"shots"', '"continuityOut"', 'character, prop, scene']) expect(board.prompt).toContain(literal)
    expect(board.prompt).toContain('## Output language (highest priority)')

    const shot = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: {
        number: 1, title: 'Half a Photograph', durationMs: 4000, description: 'a torn photograph in a gloved hand',
        dialogue: 'There is writing on the back.', speaker: 'Shen Yi', sourceExcerpt: 'a photograph', continuityIn: '', continuityOut: '',
      },
    })
    expect(shot.statusCode).toBe(201)
    const audioBatch = await trigger(episodeId, 'AUDIO')
    expect(await requestInput(audioBatch.tasks[0].id)).toEqual({ prompt: 'Shen Yi: There is writing on the back.', contentLocale: 'en' })
  })

  it('sends a Chinese project the same base template, plus only the sanctioned duration block', async () => {
    const { episodeId } = await newEpisode('Chinese Episode Drama')
    await env.db.sourceDocumentVersion.create({
      data: { episodeId, version: 1, content: '原著节选：雨夜的滨江老城区。', checksum: `zh-locale-src-${episodeId}`, status: 'APPROVED' },
    })

    const batch = await trigger(episodeId, 'SCRIPT')
    // 中文集的请求除「时长与场景规则」外没有任何新键:附加而非改写仍是底线,
    // 新增的只有拍板过的时长块——它是形态驱动生成的一部分,不是偷偷加字段。
    expect(await requestInput(batch.tasks[0].id)).toEqual({ prompt: '根据以下源文档，写出这一集的完整拍摄剧本。\n\n时长与结构要求（最高优先级）：\n- 本集目标时长约 8 分钟。\n- 篇幅预算：中文剧本全篇约 2800 字以内，英文剧本约 1440 词以内（按每分钟约 350 字 / 180 词折算）。宁可精炼，不得注水。\n- 剧本必须按场景分段：每个场景以「场景 1」「场景 2」……这样的场景标记行开头（标记独占一行，场景正文写在标记之后）。场景标记是后续分镜切分的锚点，必须逐场编号、不得省略。\n\n源文档：\n原著节选：雨夜的滨江老城区。' })
  })
})

describe('composition selection gate', () => {
  async function newEpisodeWithClips(name: string, clipCount: number): Promise<{ episodeId: string; shotId: string; clips: string[] }> {
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: `${name} EP1` } })
    expect(episode.statusCode).toBe(201)
    const episodeId = episode.json().id as string
    const shot = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 1, title: 'SB1', durationMs: 5000, description: 'a street', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(shot.statusCode).toBe(201)
    const shotId = shot.json().id as string
    const batch = await env.db.generationBatch.create({ data: { organizationId, episodeId, stage: 'VIDEO', status: 'COMPLETED', plannedCount: 1 } })
    const task = await env.db.generationTask.create({ data: { organizationId, batchId: batch.id, stage: 'VIDEO', status: 'SUCCEEDED', storyboardId: shotId } })
    const clips: string[] = []
    for (const version of Array.from({ length: clipCount }, (_, index) => index + 1)) {
      const artifact = await env.db.mediaArtifact.create({
        data: { organizationId, taskId: task.id, stage: 'VIDEO', objectKey: `${organizationId}/${episodeId}/clip/${shotId}/v${version}.mp4`, checksum: `gate-${name}-${version}`, mimeType: 'video/mp4', version, durationMs: 5000 },
      })
      clips.push(artifact.id)
    }
    return { episodeId, shotId, clips }
  }

  it('holds a manual compose while a multi-clip shot has no pick, and releases once a human chooses', async () => {
    const { episodeId, shotId, clips } = await newEpisodeWithClips('Gate Drama', 2)
    const held = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/compositions`, headers: authHeaders(editorToken) })
    expect(held.statusCode).toBe(409)
    expect(held.json().error).toBe('composition:selectionOpen')
    expect(held.json().reasons).toEqual(['#1 SB1'])
    expect(await env.db.composition.count({ where: { episodeId } })).toBe(0)

    const pick = await env.app.inject({ method: 'POST', url: `/api/storyboards/${shotId}/video-selection`, headers: authHeaders(editorToken), payload: { artifactId: clips[0] } })
    expect(pick.statusCode).toBe(200)
    const go = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/compositions`, headers: authHeaders(editorToken) })
    expect(go.statusCode).toBe(201)
    expect((go.json().composition as CompositionDto).status).toBe('RUNNING')
  })

  it('leaves a single-clip shot ungated: one version is not a choice', async () => {
    const { episodeId } = await newEpisodeWithClips('Single Clip Drama', 1)
    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/compositions`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(201)
  })

  it('lets allowAuto through the gate but records the escape in the audit trail', async () => {
    const { episodeId } = await newEpisodeWithClips('Auto Escape Drama', 2)
    const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/compositions`, headers: authHeaders(editorToken), payload: { allowAuto: true } })
    expect(res.statusCode).toBe(201)
    const composition = res.json().composition as CompositionDto
    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=composition.trigger', headers: authHeaders(ownerToken) })
    const events = audit.json().events as { entityId: string; payload: { allowAuto?: boolean } }[]
    expect(events.some(event => event.entityId === composition.id && event.payload.allowAuto === true)).toBe(true)
  })
})

describe('retry trace on the task DTO', () => {
  it('exposes the losing candidates and reference degradations of the winning attempt, capped', async () => {
    const batch = await env.db.generationBatch.create({ data: { organizationId, episodeId, stage: 'VIDEO', plannedCount: 3 } })
    const winner = await env.db.generationTask.create({
      data: {
        organizationId, batchId: batch.id, stage: 'VIDEO', status: 'SUCCEEDED', storyboardId: storyboardIds[0], attempts: 3,
        responseSnapshot: JSON.stringify({
          attempt: 3,
          candidateErrors: Array.from({ length: 12 }, (_, index) => `qc: candidate ${index} below threshold`),
          reference: [
            { model: 'mock-t2v', conditioned: true },
            { model: 'mock-ref', conditioned: false, reason: 'x'.repeat(500) },
            { nonsense: true },
          ],
        }),
      },
    })
    const loser = await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage: 'VIDEO', status: 'FAILED', storyboardId: storyboardIds[1], attempts: 1, responseSnapshot: 'not json at all' },
    })
    const plain = await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage: 'AUDIO', status: 'SUCCEEDED', storyboardId: storyboardIds[1] },
    })

    const res = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(ownerToken) })
    const tasks = (res.json() as { batches: BatchDto[] }).batches.flatMap(item => item.tasks)
    const winnerDto = tasks.find(candidate => candidate.id === winner.id)!
    expect(winnerDto.retryTrace).not.toBeNull()
    expect(winnerDto.retryTrace!.attempt).toBe(3)
    // 面板原样展示这些字符串,所以后端负责封顶:十条错误、每条四百字符。
    expect(winnerDto.retryTrace!.candidateErrors).toHaveLength(10)
    expect(winnerDto.retryTrace!.candidateErrors[0]).toBe('qc: candidate 0 below threshold')
    expect(winnerDto.retryTrace!.reference).toEqual([
      { model: 'mock-t2v', conditioned: true },
      { model: 'mock-ref', conditioned: false, reason: 'x'.repeat(400) },
    ])
    expect(tasks.find(candidate => candidate.id === loser.id)!.retryTrace).toBeNull()
    expect(tasks.find(candidate => candidate.id === plain.id)!.retryTrace).toBeNull()
  })
})

describe('generation plan pre-flight', () => {
  interface PlanDto {
    stage: string
    models: string[]
    items: { id: string; label: string; disposition: string }[]
    newCount: number
    retryCount: number
    skippedCount: number
    durationMs: number | null
    revision: number
  }

  async function plan(token: string, ep: string, query: string): Promise<{ statusCode: number; body: { plan?: PlanDto; error?: string; reasons?: string[] } }> {
    const res = await env.app.inject({ method: 'GET', url: `/api/episodes/${ep}/generation-plan?${query}`, headers: authHeaders(token) })
    return { statusCode: res.statusCode, body: res.json() as { plan?: PlanDto; error?: string; reasons?: string[] } }
  }

  let planEpisodeId: string
  let planStoryboardIds: string[] = []

  it('refuses unknown stages and episodes, and mirrors the trigger gate before promising a run', async () => {
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'Plan Drama' } })
    expect(project.statusCode).toBe(201)
    const planProjectId = project.json().id as string
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${planProjectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'Plan EP1' } })
    expect(episode.statusCode).toBe(201)
    planEpisodeId = episode.json().id as string
    for (const [number, dialogue] of [['1', '我有台词。'], ['2', '我也有一句。'], ['3', '']] as const) {
      const storyboard = await env.app.inject({
        method: 'POST', url: `/api/episodes/${planEpisodeId}/storyboards`, headers: authHeaders(ownerToken),
        payload: { number: Number(number), title: `Plan SB${number}`, durationMs: number === '1' ? 3000 : number === '2' ? 5000 : 4000, description: `镜头 ${number}`, dialogue, ...(dialogue ? { speaker: '小雨' } : {}) },
      })
      expect(storyboard.statusCode).toBe(201)
      planStoryboardIds.push(storyboard.json().id as string)
    }
    const created = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: authHeaders(ownerToken), payload: { provider: 'mock', name: 'plan-gen', apiKey: 'test-key' } })
    expect(created.statusCode).toBe(201)
    const connection = created.json() as Connection
    const capabilities = connection.capabilities
    const probe = await env.app.inject({ method: 'POST', url: `/api/providers/connections/${connection.id}/probe`, headers: authHeaders(ownerToken) })
    expect(probe.statusCode).toBe(200)
    for (const [slot, model] of [['image_gen', 'mock-image'], ['tts_voice', 'mock-tts']] as const) {
      const capabilityId = capabilities.find(capability => capability.model === model)?.id
      if (!capabilityId) continue
      const binding = await env.app.inject({ method: 'POST', url: '/api/bindings', headers: authHeaders(ownerToken), payload: { slot, capabilityId, projectId: planProjectId } })
      expect(binding.statusCode).toBe(201)
    }

    expect((await plan(ownerToken, planEpisodeId, 'stage=DELIVERY')).statusCode).toBe(400)
    expect((await plan(ownerToken, 'does-not-exist', 'stage=IMAGE')).statusCode).toBe(404)
    // No approved script yet: the plan refuses with the very code the trigger would return.
    const gated = await plan(ownerToken, planEpisodeId, 'stage=IMAGE')
    expect(gated.statusCode).toBe(409)
    expect(gated.body.error).toBe('generations:noApprovedScript')

    await env.db.scriptVersion.create({ data: { episodeId: planEpisodeId, version: 1, content: 'plan script', checksum: 'plan-script', status: 'APPROVED' } })
    // Viewers may read the plan — it is a physical-quantity preview, not a spend action.
    const viewerPlan = await plan(viewerToken, planEpisodeId, 'stage=IMAGE')
    expect(viewerPlan.statusCode).toBe(200)
    const imagePlan = viewerPlan.body.plan!
    expect(imagePlan).toMatchObject({ stage: 'IMAGE', newCount: 3, retryCount: 0, skippedCount: 0, durationMs: 12000, revision: 0 })
    expect(imagePlan.models.length).toBeGreaterThan(0)
    expect(imagePlan.models.every(model => model.startsWith('mock/'))).toBe(true)
    expect(imagePlan.items.map(item => item.label)).toEqual(['#1 Plan SB1', '#2 Plan SB2', '#3 Plan SB3'])
    expect(imagePlan.items.every(item => item.disposition === 'new')).toBe(true)
    // AUDIO only voices the shots that speak.
    const audioPlan = (await plan(ownerToken, planEpisodeId, 'stage=AUDIO')).body.plan!
    expect(audioPlan.items.map(item => item.label)).toEqual(['#1 Plan SB1', '#2 Plan SB2'])
    expect(audioPlan).toMatchObject({ newCount: 2, skippedCount: 0 })
    // 预审账面上只有物理量:项数、秒数、模型名,没有任何钱相关字段。
    expect(JSON.stringify(imagePlan)).not.toMatch(/pric|cost|amount|currenc|invoice|quota|refund|balance|[$¥€£₹₩]/i)
  })

  it('splits covered targets into retry and skipped, and reads a regenerate as all-new', async () => {
    const batch = await env.db.generationBatch.create({ data: { organizationId, episodeId: planEpisodeId, stage: 'FIRST_FRAME', plannedCount: 2 } })
    await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage: 'FIRST_FRAME', status: 'SUCCEEDED', storyboardId: planStoryboardIds[0], idempotencyKey: `${planEpisodeId}:IMAGE:${planStoryboardIds[0]}` },
    })
    await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage: 'FIRST_FRAME', status: 'FAILED', storyboardId: planStoryboardIds[1], idempotencyKey: `${planEpisodeId}:IMAGE:${planStoryboardIds[1]}` },
    })

    const mixed = (await plan(ownerToken, planEpisodeId, 'stage=IMAGE')).body.plan!
    expect(mixed).toMatchObject({ newCount: 1, retryCount: 1, skippedCount: 1, revision: 0 })
    // Only what the plan still runs counts toward the runtime it promises.
    expect(mixed.durationMs).toBe(9000)
    expect(mixed.items.map(item => item.disposition)).toEqual(['skipped', 'retry', 'new'])

    // A regenerate carries a fresh revision suffix, so nothing collides and all read new.
    const redo = (await plan(ownerToken, planEpisodeId, 'stage=IMAGE&regenerate=1')).body.plan!
    expect(redo).toMatchObject({ newCount: 3, retryCount: 0, skippedCount: 0, revision: 1, durationMs: 12000 })

    // Scoping to named shots narrows the plan the same way the trigger narrows.
    const scoped = (await plan(ownerToken, planEpisodeId, `stage=IMAGE&storyboardIds=${planStoryboardIds[0]}`)).body.plan!
    expect(scoped.items).toEqual([{ id: planStoryboardIds[0], label: '#1 Plan SB1', disposition: 'skipped' }])
    expect((await plan(ownerToken, planEpisodeId, 'stage=IMAGE&storyboardIds=not-a-shot')).statusCode).toBe(400)
  })

  it('blocks behind the same asset gate the IMAGE trigger refuses, and clears once approved', async () => {
    const assetRes = await env.app.inject({ method: 'POST', url: `/api/episodes/${planEpisodeId}/assets`, headers: authHeaders(ownerToken), payload: { kind: 'character', name: '阿墨', description: '黑衣剑客' } })
    expect(assetRes.statusCode).toBe(201)
    const assetId = assetRes.json().asset.id as string
    const link = await env.app.inject({ method: 'PUT', url: `/api/storyboards/${planStoryboardIds[2]}/assets`, headers: authHeaders(ownerToken), payload: { assets: [{ assetId, role: 'lead' }] } })
    expect(link.statusCode).toBe(200)

    const blocked = await plan(ownerToken, planEpisodeId, 'stage=IMAGE')
    expect(blocked.statusCode).toBe(409)
    expect(blocked.body.error).toBe('generations:assetsNotApproved')
    expect(blocked.body.reasons).toEqual(['阿墨'])

    await env.db.$transaction([
      env.db.assetVersion.updateMany({ where: { assetId }, data: { status: 'APPROVED' } }),
      env.db.asset.update({ where: { id: assetId }, data: { status: 'APPROVED' } }),
    ])
    expect((await plan(ownerToken, planEpisodeId, 'stage=IMAGE')).statusCode).toBe(200)
  })
})
