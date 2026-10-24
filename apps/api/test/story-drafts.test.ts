import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv
let ownerToken: string
let organizationId: string

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('draft-owner@example.com', 'Draft Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
}, 300_000)

afterAll(async () => { await env?.stop() })

const authHeaders = (token: string) => env.authHeaders(token)

async function createDraft(storyText = '老城的巷子，雨下了整夜。纸扎铺的灯还亮着。'): Promise<string> {
  const res = await env.app.inject({ method: 'POST', url: '/api/story-drafts', headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: { storyText, title: '纸人开眼', recipeKey: 'drama-serial' } })
  expect(res.statusCode).toBe(201)
  return (res.json() as { draft: { id: string } }).draft.id
}

describe('story drafts (US-006)', () => {
  it('saves and reads back a draft without touching any generation table', async () => {
    const id = await createDraft()
    const read = await env.app.inject({ method: 'GET', url: `/api/story-drafts/${id}`, headers: authHeaders(ownerToken) })
    expect(read.statusCode).toBe(200)
    const draft = (read.json() as { draft: { storyText: string; recipeKey: string | null; consumedProjectId: string | null } }).draft
    expect(draft.storyText).toContain('纸扎铺')
    expect(draft.recipeKey).toBe('drama-serial')
    expect(draft.consumedProjectId).toBeNull()
    // 保存草稿零模型调用:没有任何生成任务/批次被创建。
    expect(await env.db.generationTask.count({ where: { organizationId } })).toBe(0)
    expect(await env.db.generationBatch.count({ where: { organizationId } })).toBe(0)
  })

  it('updates a draft in place (refresh-safe) and refuses edits after consumption', async () => {
    const id = await createDraft('初稿')
    const put = await env.app.inject({ method: 'PUT', url: `/api/story-drafts/${id}`, headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: { storyText: '二稿——巷子加长', title: '改题' } })
    expect(put.statusCode).toBe(200)
    expect((put.json() as { draft: { storyText: string } }).draft.storyText).toContain('二稿')

    const consume = await env.app.inject({ method: 'POST', url: `/api/story-drafts/${id}/create-project`, headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: {} })
    expect(consume.statusCode).toBe(201)
    const afterEdit = await env.app.inject({ method: 'PUT', url: `/api/story-drafts/${id}`, headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: { storyText: '三稿' } })
    expect(afterEdit.statusCode).toBe(409)
  })

  it('create-project is idempotent on replay and instantiates the recipe snapshot', async () => {
    const projectsBefore = await env.db.project.count({ where: { organizationId } })
    const id = await createDraft()
    const first = await env.app.inject({ method: 'POST', url: `/api/story-drafts/${id}/create-project`, headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: { format: 'short_drama' } })
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201)
    expect(first.json().idempotentReplay).toBe(false)
    const projectId = (first.json() as { project: { id: string } }).project.id

    // 双击/断网重发:返回同一项目,标记 idempotentReplay,不重复建。
    const replay = await env.app.inject({ method: 'POST', url: `/api/story-drafts/${id}/create-project`, headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: { format: 'short_drama' } })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().idempotentReplay).toBe(true)
    expect((replay.json() as { project: { id: string } }).project.id).toBe(projectId)
    expect(await env.db.project.count({ where: { organizationId } })).toBe(projectsBefore + 1)

    // 首集与源文档就位;配方快照固化。
    const project = await env.db.project.findUniqueOrThrow({ where: { id: projectId } })
    expect(project.recipeKey).toBe('drama-serial')
    expect(JSON.parse(project.recipeSnapshot!).aspect).toBe('9:16')
    const episode = await env.db.episode.findFirstOrThrow({ where: { projectId } })
    const source = await env.db.sourceDocumentVersion.findFirstOrThrow({ where: { episodeId: episode.id } })
    expect(source.content).toContain('纸扎铺')
    expect(source.version).toBe(1)
  })

  it('concurrent create-project calls consume the draft exactly once (row-lock claim)', async () => {
    // R07b 回归：并发双请求必须共用同一项目——条件 UPDATE 行锁挡住第二个
    // 事务，等待提交后按已占用读到首个项目，而不是各自建一份。
    const projectsBefore = await env.db.project.count({ where: { organizationId } })
    const id = await createDraft()
    const call = () => env.app.inject({ method: 'POST', url: `/api/story-drafts/${id}/create-project`, headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: { format: 'short_drama' } })
    const [a, b] = await Promise.all([call(), call()])
    const codes = [a.statusCode, b.statusCode].sort()
    expect(codes, JSON.stringify([a.statusCode, a.body, b.statusCode, b.body])).toEqual([200, 201])
    const projectA = (a.json() as { project: { id: string } }).project.id
    const projectB = (b.json() as { project: { id: string } }).project.id
    expect(projectA).toBe(projectB)
    expect(await env.db.project.count({ where: { organizationId } })).toBe(projectsBefore + 1)
    const draftRow = await env.db.storyDraft.findUniqueOrThrow({ where: { id } })
    expect(draftRow.consumedProjectId).toBe(projectA)
  })

  it('keeps drafts org-scoped', async () => {
    const id = await createDraft()
    const rival = await env.register('draft-rival@example.com', 'Rival Draft Org')
    expect((await env.app.inject({ method: 'GET', url: `/api/story-drafts/${id}`, headers: authHeaders(rival.token) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'POST', url: `/api/story-drafts/${id}/create-project`, headers: authHeaders(rival.token) })).statusCode).toBe(404)
  })
})
