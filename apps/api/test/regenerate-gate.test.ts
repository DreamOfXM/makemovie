import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPipelineQueue } from '@studio/jobs'
import { startTestEnv, type TestEnv } from './env.js'

// The api suite shares the Redis instance with the worker suite; a private
// logical database keeps these queued jobs away from another suite's worker.
const ambientEnv = {
  REDIS_URL: process.env.REDIS_URL,
}
process.env.REDIS_URL = 'redis://127.0.0.1:6380/9'

function restoreEnv(key: keyof typeof ambientEnv): void {
  const value = ambientEnv[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

let env: TestEnv
let queue: ReturnType<typeof createPipelineQueue>
let ownerToken: string
let organizationId: string

interface BatchDto {
  id: string
  stage: string
  status: string
  plannedCount: number
}

/**
 * SD-175｜逐镜重跑绕过时长/分辨率缺口门。
 * 台账实测：镜头卡「重跑「视频片段」」四镜（wanx2.1-i2v-plus 在目录里明写 fixed 5 s /
 * 只有 720P），零提示掉到 720×1280 / 5.37 s，本集从此混了两种分辨率。根因是整集那条
 * 缺口确认门的条件 `durationGap.gapMs > 0 && !options.storyboardIds`——逐镜动作被自己
 * 的条件跳过。这里锁的是补上之后的对外契约：重买一镜时状态码、错误码与 reasons 形状
 * 与整集路径逐字相同，界面只需一套确认逻辑。
 */
async function videoReadyEpisode(name: string, targetDurationMs: number, shotDurations: number[]) {
  const authHeaders = env.authHeaders(ownerToken)
  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders, payload: { name } })
  expect(project.statusCode).toBe(201)
  const projectId = project.json().id as string
  const episode = await env.app.inject({
    method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders,
    payload: { number: 1, title: 'EP1', targetDurationMs },
  })
  expect(episode.statusCode).toBe(201)
  const episodeId = episode.json().id as string
  // 媒体阶段一律卡在「剧本已批准」后面；本文件测的是缺口门，不是那道门。
  await env.db.scriptVersion.create({ data: { episodeId, version: 1, content: `场景 1\n${name}`, checksum: `gap-${randomUUID()}`, status: 'APPROVED' } })
  const shotIds: string[] = []
  for (const [index, durationMs] of shotDurations.entries()) {
    const shot = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders,
      payload: { number: index + 1, title: `镜头${index + 1}`, durationMs, description: '雨夜路灯下的对视', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(shot.statusCode).toBe(201)
    shotIds.push(shot.json().id as string)
  }
  return { projectId, episodeId, shotIds }
}

/** 这一镜已经买过一次并交付了一版视频（1080×1920 / 15 s 档）：逐镜再点一次就是重买。 */
async function seedBilledVideo(episodeId: string, shotId: string) {
  const batch = await env.db.generationBatch.create({
    data: { organizationId, episodeId, stage: 'VIDEO', status: 'COMPLETED', plannedCount: 1, storyboards: { connect: { id: shotId } } },
  })
  const task = await env.db.generationTask.create({
    data: { organizationId, batchId: batch.id, stage: 'VIDEO', status: 'SUCCEEDED', storyboardId: shotId, provider: 'mock', model: 'mock-t2v', attempts: 1, idempotencyKey: `${episodeId}:VIDEO:${shotId}` },
  })
  await env.db.mediaArtifact.create({
    data: { organizationId, taskId: task.id, stage: 'VIDEO', objectKey: `${organizationId}/sd175/${shotId}/v1.mp4`, checksum: `sd175-${shotId}`, mimeType: 'video/mp4', version: 1, durationMs: 15_000, width: 1080, height: 1920 },
  })
  return batch.id
}

async function trigger(episodeId: string, body: Record<string, unknown>) {
  return env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: env.authHeaders(ownerToken), payload: body })
}

beforeAll(async () => {
  env = await startTestEnv()
  queue = createPipelineQueue()
  const owner = await env.register('gap-owner@example.com', 'Gap Owner Org')
  ownerToken = owner.token
  organizationId = owner.organization.id

  // 一条 mock 文生视频绑定铺满整个空间：缺口门要跑一条真计划，但这一档不会调用任何厂商。
  const connection = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: env.authHeaders(ownerToken), payload: { provider: 'mock', name: `gap-mock-${randomUUID().slice(0, 8)}`, apiKey: 'test-key' } })
  expect(connection.statusCode).toBe(201)
  const created = connection.json() as { id: string; capabilities: { id: string; model: string }[] }
  expect((await env.app.inject({ method: 'POST', url: `/api/providers/connections/${created.id}/probe`, headers: env.authHeaders(ownerToken) })).statusCode).toBe(200)
  const binding = await env.app.inject({
    method: 'POST', url: '/api/bindings', headers: env.authHeaders(ownerToken),
    payload: { slot: 'video_t2v', capabilityId: created.capabilities.find(capability => capability.model === 'mock-t2v')!.id },
  })
  expect(binding.statusCode).toBe(201)
  // 首帧那条用例要证明「缺口门不越界到别的阶段」，所以画面槽位也得是真的能跑。
  const imageBinding = await env.app.inject({
    method: 'POST', url: '/api/bindings', headers: env.authHeaders(ownerToken),
    payload: { slot: 'image_gen', capabilityId: created.capabilities.find(capability => capability.model === 'mock-image')!.id },
  })
  expect(imageBinding.statusCode).toBe(201)
}, 300_000)

afterAll(async () => {
  for (const key of Object.keys(ambientEnv) as (keyof typeof ambientEnv)[]) restoreEnv(key)
  if (queue) {
    await queue.obliterate({ force: true }).catch(() => undefined)
    await queue.close()
  }
  await env?.stop()
})

describe('per-shot video rerun and the duration gap gate (SD-175)', () => {
  it('refuses to re-bill a shot while the episode still has an unconfirmed runtime gap', async () => {
    // 两镜各 15 s，本集目标 60 s：缺口 30 s 从没被人看过；#1 已交付过一版视频。
    const { episodeId, shotIds } = await videoReadyEpisode('Gap Drama', 60_000, [15_000, 15_000])
    await seedBilledVideo(episodeId, shotIds[0])
    const batchesBefore = await env.db.generationBatch.count({ where: { episodeId } })
    const tasksBefore = await env.db.generationTask.count({ where: { batch: { episodeId } } })

    const refused = await trigger(episodeId, { stage: 'VIDEO', storyboardIds: [shotIds[0]], regenerate: true })
    expect(refused.statusCode).toBe(409)
    // 与整集路径同一套报文；generations:durationGap 与 reasons[0] 的形状已注册在界面词典。
    expect(refused.json()).toMatchObject({ error: 'generations:durationGap', reasons: ['30s'] })
    // 拦在开烧之前：没有新批次、没有新任务，也就没有那一笔没人确认过的付费重买。
    expect(await env.db.generationBatch.count({ where: { episodeId } })).toBe(batchesBefore)
    expect(await env.db.generationTask.count({ where: { batch: { episodeId } } })).toBe(tasksBefore)
  })

  it('runs the same rerun once the gap is accepted, and the acknowledgement lands in the audit', async () => {
    const { episodeId, shotIds } = await videoReadyEpisode('Accepted Gap Drama', 60_000, [15_000, 15_000])
    await seedBilledVideo(episodeId, shotIds[0])
    const accepted = await trigger(episodeId, { stage: 'VIDEO', storyboardIds: [shotIds[0]], regenerate: true, acceptDurationGap: true })
    expect(accepted.statusCode).toBe(201)
    expect(accepted.json()).toMatchObject({ created: true })
    const batch = accepted.json().batch as BatchDto
    expect(batch).toMatchObject({ stage: 'VIDEO', plannedCount: 1 })

    // 「人确实看过缺口」要能事后回答：审计里留着目标/计划/差值三个物理量。
    // 逐镜重买这一击走的是 generation.regenerate（整集首次触发才是 generation.trigger）。
    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=generation.regenerate', headers: env.authHeaders(ownerToken) })
    const event = (audit.json().events as { entityId: string; payload: Record<string, unknown> }[])
      .find(candidate => candidate.entityId === batch.id)
    expect(event?.payload).toMatchObject({ durationTargetMs: 60_000, durationPlannedMs: 30_000, durationGapMs: 30_000 })
  })

  it('does not gate the first buy of a shot: filling the episode stays one click', async () => {
    // 同一集里 #2 从没买过：这一击是在补片，不是在把已交付的档换掉。
    const { episodeId, shotIds } = await videoReadyEpisode('First Buy Drama', 60_000, [15_000, 15_000])
    await seedBilledVideo(episodeId, shotIds[0])
    const res = await trigger(episodeId, { stage: 'VIDEO', storyboardIds: [shotIds[1]] })
    expect(res.statusCode).toBe(201)
    expect(res.json().batch as BatchDto).toMatchObject({ stage: 'VIDEO', plannedCount: 1 })
  })

  it('does not invent a gap: re-billing an episode that meets its target runs straight through', async () => {
    const { episodeId, shotIds } = await videoReadyEpisode('No Gap Drama', 30_000, [15_000, 15_000])
    await seedBilledVideo(episodeId, shotIds[0])
    const res = await trigger(episodeId, { stage: 'VIDEO', storyboardIds: [shotIds[0]], regenerate: true })
    expect(res.statusCode).toBe(201)
    expect(res.json().batch as BatchDto).toMatchObject({ stage: 'VIDEO', plannedCount: 1 })
  })

  it('leaves the harder word to the trigger: an over-ceiling shot still reports the decision it needs', async () => {
    // 31 s 的意图超出单次上限 30 s：这条硬错比缺口确认更该先上屏，否则人看不到
    // 「拼接 / 拆镜 / 换模型」三条出口，而它正是这一镜的真问题。
    const { episodeId, shotIds } = await videoReadyEpisode('Overflow Drama', 90_000, [31_000, 15_000])
    await seedBilledVideo(episodeId, shotIds[0])
    const refused = await trigger(episodeId, { stage: 'VIDEO', storyboardIds: [shotIds[0]], regenerate: true })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ error: 'generations:shotDurationOverflow' })
    expect((refused.json() as { reasons?: string[] }).reasons?.[0]).toContain('#1')
  })

  it('keeps the whole-episode gate exactly where it was: the same numbers, the same code', async () => {
    const { episodeId, shotIds } = await videoReadyEpisode('Whole Gap Drama', 60_000, [15_000, 15_000])
    await seedBilledVideo(episodeId, shotIds[0])
    const refused = await trigger(episodeId, { stage: 'VIDEO' })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ error: 'generations:durationGap', reasons: ['30s'] })
  })

  it('does not reach into other stages: an image rerun is not asked about runtime', async () => {
    // 缺口只算 VIDEO 买到的成片时长；首帧买的是画面，拦它等于拿时长逼画面决定。
    const { episodeId, shotIds } = await videoReadyEpisode('Image Stage Drama', 60_000, [15_000, 15_000])
    const res = await trigger(episodeId, { stage: 'IMAGE', storyboardIds: [shotIds[0]] })
    expect(res.statusCode).toBe(201)
    expect((res.json().batch as BatchDto).stage).toBe('IMAGE')
  })

  it('answers a foreign episode with 404, never a 403 that leaks it exists', async () => {
    const outsider = await env.register('gap-outsider@example.com', 'Gap Outsider Org')
    const { episodeId, shotIds } = await videoReadyEpisode('Gap Leak Drama', 60_000, [15_000, 15_000])
    await seedBilledVideo(episodeId, shotIds[0])
    const res = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: env.authHeaders(outsider.token),
      payload: { stage: 'VIDEO', storyboardIds: [shotIds[0]], regenerate: true },
    })
    // 补上的预审读的是同一套 findFirst-by-org 口径：跨空间的 id 只会得到 404。
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Episode not found' })
  })
})
