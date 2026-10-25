import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPipelineQueue } from '@studio/jobs'
import { startTestEnv, type TestEnv } from './env.js'

// 私有逻辑库：本套只读计划、真触发一次 VIDEO，不能让共享实例里的 worker 抢走任务。
process.env.REDIS_URL = 'redis://127.0.0.1:6380/8'

let env: TestEnv
let queue: ReturnType<typeof createPipelineQueue>
let ownerToken: string
let episodeId: string
let localEpisodeId: string
let videoShotId: string
let titleCardShotId: string
let uiShotId: string
let cardShotId: string

const authHeaders = (token: string) => env.authHeaders(token)
const json = (token: string) => ({ ...authHeaders(token), 'content-type': 'application/json' })

interface PlanItem {
  id: string
  label: string
  disposition: 'new' | 'retry' | 'skipped' | 'local'
}

interface Plan {
  stage: string
  items: PlanItem[]
  newCount: number
  retryCount: number
  skippedCount: number
  localCount: number
  durationMs: number | null
}

interface Batch {
  id: string
  plannedCount: number
  tasks: { storyboardId: string | null; stage: string }[]
}

beforeAll(async () => {
  env = await startTestEnv()
  queue = createPipelineQueue()

  const owner = await env.register('method-owner@example.com', 'Shot Method Org')
  ownerToken = owner.token

  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: json(ownerToken), payload: { name: 'Method Drama' } })
  expect(project.statusCode).toBe(201)
  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${project.json().id}/episodes`, headers: json(ownerToken), payload: { number: 1, title: 'EP1' } })
  expect(episode.statusCode).toBe(201)
  episodeId = episode.json().id as string

  // 这三档走库写：'UI' 是分镜模型留下的旧英文写法，人写入口（SD-109）只收五档人话，
  // 所以这里只能按落库路径打标——被测的是计划/触发怎么读它。
  for (const [number, title, durationMs] of [[1, 'Video shot', 5000], [2, 'Title card', 3000], [3, 'UI screen', 4000]] as const) {
    const storyboard = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: json(ownerToken),
      payload: { number, title, durationMs, description: title, sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(storyboard.statusCode).toBe(201)
    const id = storyboard.json().id as string
    if (number === 1) videoShotId = id
    else if (number === 2) titleCardShotId = id
    else uiShotId = id
  }
  await env.db.storyboard.update({ where: { id: titleCardShotId }, data: { method: '字卡', dialogue: '第七次，也是最后一次。' } })
  await env.db.storyboard.update({ where: { id: uiShotId }, data: { method: 'UI' } })

  await env.db.scriptVersion.create({ data: { episodeId, version: 1, content: 'approved script', checksum: 'method-script', status: 'APPROVED' } })

  // 整集只有手工镜：没有显式点名时，预审该说「没有可生成的目标」而不是列一串镜号。
  const localEpisode = await env.app.inject({ method: 'POST', url: `/api/projects/${project.json().id}/episodes`, headers: json(ownerToken), payload: { number: 2, title: 'EP2' } })
  expect(localEpisode.statusCode).toBe(201)
  localEpisodeId = localEpisode.json().id as string
  const localShot = await env.app.inject({
    method: 'POST', url: `/api/episodes/${localEpisodeId}/storyboards`, headers: json(ownerToken),
    payload: { number: 1, title: 'Only a card', durationMs: 3000, description: 'card', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
  })
  expect(localShot.statusCode).toBe(201)
  await env.db.storyboard.update({ where: { id: localShot.json().id as string }, data: { method: '字卡' } })
  await env.db.scriptVersion.create({ data: { episodeId: localEpisodeId, version: 1, content: 'approved script', checksum: 'method-script-2', status: 'APPROVED' } })

  const connection = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: json(ownerToken), payload: { provider: 'mock', name: 'method-mock', apiKey: 'test-key' } })
  expect(connection.statusCode).toBe(201)
  const capabilities = (connection.json() as { id: string; capabilities: { id: string; model: string }[] }).capabilities
  const probe = await env.app.inject({ method: 'POST', url: `/api/providers/connections/${connection.json().id}/probe`, headers: authHeaders(ownerToken) })
  expect(probe.statusCode).toBe(200)
  for (const [slot, model] of [['video_t2v', 'mock-t2v'], ['tts_voice', 'mock-tts']] as const) {
    const binding = await env.app.inject({
      method: 'POST', url: '/api/bindings', headers: json(ownerToken),
      payload: { slot, capabilityId: capabilities.find(capability => capability.model === model)!.id },
    })
    expect(binding.statusCode).toBe(201)
  }
}, 300_000)

afterAll(async () => {
  if (queue) {
    // 本套没有 worker 消费，任务留在共享 Redis 里会干扰别套的队列断言。
    await queue.obliterate({ force: true }).catch(() => undefined)
    await queue.close()
  }
  await env?.stop()
})

const getPlan = async (query: string) => env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/generation-plan?${query}`, headers: authHeaders(ownerToken) })

describe('生成方式只排平台负责的镜头 (SD-035)', () => {
  it('VIDEO 计划把字卡/UI 列成 local，不花额度也不算时长', async () => {
    const res = await getPlan('stage=VIDEO')
    if (res.statusCode !== 200) throw new Error(`plan failed: ${res.body}`)
    const plan = (res.json() as { plan: Plan }).plan
    expect(plan.localCount).toBe(2)
    expect(plan.newCount).toBe(1)
    expect(plan.retryCount).toBe(0)
    expect(plan.skippedCount).toBe(0)
    expect(plan.durationMs).toBe(5000)
    expect(plan.items.map(item => [item.id, item.disposition])).toEqual([
      [videoShotId, 'new'],
      [titleCardShotId, 'local'],
      [uiShotId, 'local'],
    ])
  })

  it('显式点名手工镜头：拒绝并报出镜号，而不是静默跳过', async () => {
    const res = await getPlan(`stage=VIDEO&storyboardIds=${titleCardShotId}`)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'generations:shotNotGenerated', reasons: ['#2'] })
  })

  it('只选中手工镜头时点名每一条，而不是假装这批能生成', async () => {
    const res = await getPlan(`stage=VIDEO&storyboardIds=${titleCardShotId},${uiShotId}`)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'generations:shotNotGenerated', reasons: ['#2', '#3'] })
  })

  it('整集全是手工镜头时没有可生成的目标', async () => {
    const res = await env.app.inject({ method: 'GET', url: `/api/episodes/${localEpisodeId}/generation-plan?stage=VIDEO`, headers: authHeaders(ownerToken) })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'generations:nothingToGenerate' })
  })

  it('整集触发只建视频镜的任务', async () => {
    const res = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: json(ownerToken),
      payload: { stage: 'VIDEO', acceptDurationGap: true },
    })
    if (res.statusCode !== 201) throw new Error(`trigger failed: ${res.body}`)
    const batch = res.json().batch as Batch | null
    expect(batch?.plannedCount).toBe(1)
    expect(batch?.tasks.map(task => [task.stage, task.storyboardId])).toEqual([['VIDEO', videoShotId]])
  })

  it('配音不受生成方式影响：字卡镜头有台词，就该进 AUDIO 计划', async () => {
    const res = await getPlan('stage=AUDIO')
    expect(res.statusCode).toBe(200)
    const plan = (res.json() as { plan: Plan }).plan
    expect(plan.localCount).toBe(0)
    expect(plan.newCount).toBe(1)
    expect(plan.items.map(item => [item.id, item.disposition])).toEqual([[titleCardShotId, 'new']])
  })
})

/**
 * 人能改这一栏（SD-109）。此前只有分镜模型写、界面只读：档位一旦标错，
 * 唯一的修法是重跑整份分镜（付费 + 覆盖已审内容）。这里锁的是「改一档就换一条链」，
 * 以及写入口只认五档人话——自由文本进了库就是分类器认不出、整镜落回视频档默默计费。
 */
describe('生成方式的人写入口 (SD-109)', () => {
  const shotboardRow = async (id: string) => {
    const res = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/shotboard`, headers: authHeaders(ownerToken) })
    expect(res.statusCode).toBe(200)
    return ((res.json() as { shots: { id: string; method: string | null; production: string }[] }).shots).find(row => row.id === id)
  }

  it('建镜时就能定档，读回来的是原文而不是英文枚举', async () => {
    const res = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: json(ownerToken),
      payload: { number: 4, title: '片尾字卡', durationMs: 2000, description: '黑底白字的收尾卡', method: '字卡' },
    })
    expect(res.statusCode).toBe(201)
    const id = res.json().id as string
    cardShotId = id
    expect(await shotboardRow(id)).toMatchObject({ method: '字卡', production: 'title-card' })
    // 计划侧当场少一个计费目标：写进去的档真的被读到。
    const planRes = await getPlan('stage=VIDEO')
    expect(planRes.statusCode).toBe(200)
    const plan = (planRes.json() as { plan: Plan }).plan
    expect(plan.items.find(item => item.id === id)?.disposition).toBe('local')
    expect(plan.localCount).toBe(3)
  })

  it('改档把这一镜从计费队列里摘出来——全集都是手工镜时预审说没有可生成的目标', async () => {
    const res = await env.app.inject({
      method: 'PATCH', url: `/api/storyboards/${videoShotId}`, headers: json(ownerToken), payload: { method: '屏幕录制' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().method).toBe('屏幕录制')
    expect(await shotboardRow(videoShotId)).toMatchObject({ method: '屏幕录制', production: 'screen-recording' })
    const plan = await getPlan('stage=VIDEO')
    expect(plan.statusCode).toBe(400)
    expect(plan.json()).toMatchObject({ error: 'generations:nothingToGenerate' })
  })

  it('清空等于交回模型口径（空列按视频处理），非法档位一律 400', async () => {
    const cleared = await env.app.inject({
      method: 'PATCH', url: `/api/storyboards/${cardShotId}`, headers: json(ownerToken), payload: { method: '' },
    })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().method).toBeNull()
    expect(await shotboardRow(cardShotId)).toMatchObject({ production: 'video' })

    const bad = await env.app.inject({
      method: 'PATCH', url: `/api/storyboards/${cardShotId}`, headers: json(ownerToken), payload: { method: '画面' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('method must be one of: 视频, 字卡, 屏幕录制, 合成, 界面')
    const badCreate = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: json(ownerToken),
      payload: { number: 5, title: 'X', durationMs: 1000, description: 'X', method: 42 },
    })
    expect(badCreate.statusCode).toBe(400)
    // 旧的英文同义写法仍能读（分镜模型写过 UI），但不许由人再写进去。
    expect((await env.app.inject({
      method: 'PATCH', url: `/api/storyboards/${uiShotId}`, headers: json(ownerToken), payload: { method: 'UI' },
    })).statusCode).toBe(400)
    expect(await shotboardRow(uiShotId)).toMatchObject({ method: 'UI', production: 'ui' })
  })
})
