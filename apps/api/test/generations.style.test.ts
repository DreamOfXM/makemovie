import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPipelineQueue } from '@studio/jobs'
import { OFFICIAL_STYLES } from '@studio/pipeline'
import { startTestEnv, type TestEnv } from './env.js'

// The api suite shares the Redis instance with the worker suite; a private
// logical database keeps these queued jobs away from another suite's worker.
const ambientEnv = {
  REDIS_URL: process.env.REDIS_URL,
}
process.env.REDIS_URL = 'redis://127.0.0.1:6380/8'

function restoreEnv(key: keyof typeof ambientEnv): void {
  const value = ambientEnv[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

const anime = OFFICIAL_STYLES.find(style => style.id === 'anime')!
const cinematic = OFFICIAL_STYLES.find(style => style.id === 'cinematic')!

let env: TestEnv
let queue: ReturnType<typeof createPipelineQueue>
let ownerToken: string
let organizationId: string
let projectId: string
let episodeId: string
let shotIds: string[] = []

/** An IMAGE-triggerable episode: one approved script, shots with bound approved
 *  character assets, and an org-level mock image binding. */
async function imageReadyEpisode(token: string, name: string): Promise<{ projectId: string; episodeId: string; shotIds: string[] }> {
  const authHeaders = env.authHeaders(token)
  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders, payload: { name } })
  expect(project.statusCode).toBe(201)
  const projectId = project.json().id as string
  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders, payload: { number: 1, title: 'EP1' } })
  expect(episode.statusCode).toBe(201)
  const episodeId = episode.json().id as string
  await env.db.scriptVersion.create({ data: { episodeId, version: 1, content: `场景 1\n${name} 的夜戏`, checksum: `style-${randomUUID()}`, status: 'APPROVED' } })

  const asset = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/assets`, headers: authHeaders, payload: { kind: 'character', name: '主角', description: '黑色风衣的旅人' } })
  expect(asset.statusCode).toBe(201)
  const assetId = asset.json().asset.id as string
  await env.db.asset.update({ where: { id: assetId }, data: { status: 'APPROVED' } })

  const shotIds: string[] = []
  for (const number of [1, 2, 3]) {
    const shot = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders,
      payload: { number, title: `镜头${number}`, durationMs: 5000, description: '雨夜路灯下的对视', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(shot.statusCode).toBe(201)
    const shotId = shot.json().id as string
    await env.db.storyboardAsset.create({ data: { storyboardId: shotId, assetId, role: 'character' } })
    shotIds.push(shotId)
  }
  return { projectId, episodeId, shotIds }
}

async function bindMockImage(token: string): Promise<void> {
  const authHeaders = env.authHeaders(token)
  const connection = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: authHeaders, payload: { provider: 'mock', name: `style-gen-${randomUUID().slice(0, 8)}`, apiKey: 'test-key' } })
  expect(connection.statusCode).toBe(201)
  const capabilities = (connection.json() as { id: string; capabilities: { id: string; model: string }[] }).capabilities
  const probe = await env.app.inject({ method: 'POST', url: `/api/providers/connections/${(connection.json() as { id: string }).id}/probe`, headers: authHeaders })
  expect(probe.statusCode).toBe(200)
  const binding = await env.app.inject({
    method: 'POST', url: '/api/bindings', headers: authHeaders,
    payload: { slot: 'image_gen', capabilityId: capabilities.find(capability => capability.model === 'mock-image')!.id },
  })
  expect(binding.statusCode).toBe(201)
}

async function triggerImage(token: string, episodeId: string, body: { storyboardIds?: string[]; styleId?: string }): Promise<{ statusCode: number; body: any }> {
  const res = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: env.authHeaders(token), payload: { stage: 'IMAGE', ...body } })
  return { statusCode: res.statusCode, body: res.json() }
}

/** The newest task prompt of a freshly triggered batch. */
async function batchPrompt(batchId: string): Promise<string> {
  const task = await env.db.generationTask.findFirstOrThrow({ where: { batchId }, orderBy: { id: 'desc' } })
  return (JSON.parse(task.requestSnapshot ?? '') as { input: { prompt: string } }).input.prompt
}

beforeAll(async () => {
  env = await startTestEnv()
  queue = createPipelineQueue()
  const owner = await env.register('style-owner@example.com', 'Style Owner Org')
  ownerToken = owner.token
  organizationId = owner.organization.id

  const fixture = await imageReadyEpisode(ownerToken, 'Style Drama')
  projectId = fixture.projectId
  episodeId = fixture.episodeId
  shotIds = fixture.shotIds
  await bindMockImage(ownerToken)
}, 300_000)

afterAll(async () => {
  for (const key of Object.keys(ambientEnv) as (keyof typeof ambientEnv)[]) restoreEnv(key)
  if (queue) {
    await queue.obliterate({ force: true }).catch(() => undefined)
    await queue.close()
  }
  await env?.stop()
})

describe('generation style presets', () => {
  it('bakes an explicitly passed official style into the IMAGE prompt', async () => {
    const res = await triggerImage(ownerToken, episodeId, { storyboardIds: [shotIds[0]], styleId: 'anime' })
    expect(res.statusCode).toBe(201)
    const prompt = await batchPrompt(res.body.batch.id)
    expect(prompt).toContain('视觉风格：')
    expect(prompt).toContain(anime.visualStyle)
  })

  it('falls back to the project default style when no styleId is passed', async () => {
    const applied = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/apply-style`, headers: env.authHeaders(ownerToken), payload: { styleId: 'cinematic' } })
    expect(applied.statusCode).toBe(200)

    const res = await triggerImage(ownerToken, episodeId, { storyboardIds: [shotIds[1]] })
    expect(res.statusCode).toBe(201)
    const prompt = await batchPrompt(res.body.batch.id)
    expect(prompt).toContain('视觉风格：')
    expect(prompt).toContain(cinematic.visualStyle)
  })

  it('rejects an unknown styleId with 400 styles:notFound', async () => {
    const res = await triggerImage(ownerToken, episodeId, { storyboardIds: [shotIds[0]], styleId: `ghost-${randomUUID()}` })
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('styles:notFound')
  })

  it('applies a custom DB style for its owner but refuses it for another organization', async () => {
    const created = await env.app.inject({
      method: 'POST', url: '/api/styles', headers: env.authHeaders(ownerToken),
      payload: { name: '水墨私风', visualStyle: 'ink wash painting, misty mountains' },
    })
    expect(created.statusCode).toBe(201)
    const customStyleId = created.json().id as string

    // The seeded row backs the FK, so the custom style is referenceable end to end.
    const own = await triggerImage(ownerToken, episodeId, { storyboardIds: [shotIds[2]], styleId: customStyleId })
    expect(own.statusCode).toBe(201)
    expect(await batchPrompt(own.body.batch.id)).toContain('ink wash painting, misty mountains')

    const rival = await env.register('style-rival@example.com', 'Style Rival Org')
    const rivalFixture = await imageReadyEpisode(rival.token, 'Rival Drama')
    await bindMockImage(rival.token)
    const cross = await triggerImage(rival.token, rivalFixture.episodeId, { storyboardIds: [rivalFixture.shotIds[0]], styleId: customStyleId })
    expect(cross.statusCode).toBe(400)
    expect(cross.body.error).toBe('styles:notFound')
  })
})
