import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv
let ownerToken: string
let organizationId: string

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('example-owner@example.com', 'Example Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
}, 300_000)

afterAll(async () => { await env?.stop() })

const authHeaders = (token: string) => env.authHeaders(token)

describe('example projects (US-008)', () => {
  it('installs idempotently with playable media, visible source note and no model calls (V09)', async () => {
    const first = await env.app.inject({ method: 'POST', url: '/api/projects/install-example', headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: {} })
    expect(first.statusCode).toBe(201)
    expect(first.json().installed).toBe(true)
    const again = await env.app.inject({ method: 'POST', url: '/api/projects/install-example', headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: {} })
    expect(again.statusCode).toBe(200)
    expect(again.json().installed).toBe(false)
    expect(again.json().projectId).toBe(first.json().projectId)
    const project = await env.db.project.findUniqueOrThrow({ where: { id: first.json().projectId } })
    expect(project.isExample).toBe(true)
    expect(project.exampleSourceNote).toContain('示例项目')

    // V09:零供应商 key 的可播放示例——每镜都有钦定成片,媒体真实存在,挂在
    // example-bundle 任务链下(零真实模型调用=零用量台账)。
    const episode = await env.db.episode.findFirstOrThrow({ where: { projectId: project.id } })
    const shots = await env.db.storyboard.findMany({ where: { episodeId: episode.id }, orderBy: { number: 'asc' } })
    expect(shots).toHaveLength(3)
    expect(shots.every(shot => shot.selectedVideoArtifactId !== null)).toBe(true)
    const tasks = await env.db.generationTask.findMany({ where: { organizationId } })
    expect(tasks.length).toBe(3)
    expect(tasks.every(task => task.provider === 'example-bundle' && task.status === 'SUCCEEDED')).toBe(true)
    expect(await env.db.usageLedger.count({ where: { organizationId } })).toBe(0)
    for (const shot of shots) {
      const artifact = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: shot.selectedVideoArtifactId! } })
      expect(artifact.mimeType).toBe('video/mp4')
      // 零 key 直接播放:内容端点拿得到真实字节。
      const content = await env.app.inject({ method: 'GET', url: `/api/artifacts/${artifact.id}/content`, headers: authHeaders(ownerToken) })
      expect(content.statusCode).toBe(200)
      expect(content.headers['content-type']).toContain('video/mp4')
      expect(content.rawPayload.length).toBeGreaterThan(1000)
    }
  })

  it('is read-only in place but clones into an independent editable copy', async () => {
    const install = await env.app.inject({ method: 'POST', url: '/api/projects/install-example', headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: {} })
    const exampleId = install.json().projectId as string
    // 原地改名/删除都被拒。
    expect((await env.app.inject({ method: 'PATCH', url: `/api/projects/${exampleId}`, headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: { name: '污染' } })).statusCode).toBe(403)
    expect((await env.app.inject({ method: 'DELETE', url: `/api/projects/${exampleId}`, headers: authHeaders(ownerToken) })).statusCode).toBe(403)
    // 复制:独立副本,可编辑,示例原件未动。
    const clone = await env.app.inject({ method: 'POST', url: `/api/projects/${exampleId}/clone-example`, headers: authHeaders(ownerToken) })
    expect(clone.statusCode).toBe(201)
    const cloneId = clone.json().projectId as string
    expect(cloneId).not.toBe(exampleId)
    const renamed = await env.app.inject({ method: 'PATCH', url: `/api/projects/${cloneId}`, headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: { name: '我的练习' } })
    expect(renamed.statusCode).toBe(200)
    const source = await env.db.project.findUniqueOrThrow({ where: { id: exampleId } })
    expect(source.isExample).toBe(true)
    expect(await env.db.project.findUniqueOrThrow({ where: { id: cloneId } })).toMatchObject({ isExample: false, name: '我的练习' })
    // 剧集/分镜/源文档都进了副本。
    const cloneEpisode = await env.db.episode.findFirstOrThrow({ where: { projectId: cloneId } })
    const cloneShots = await env.db.storyboard.findMany({ where: { episodeId: cloneEpisode.id }, orderBy: { number: 'asc' } })
    expect(cloneShots.length).toBeGreaterThan(0)
    expect(await env.db.sourceDocumentVersion.count({ where: { episodeId: cloneEpisode.id } })).toBe(1)
    // V09:每镜媒体随副本进入目标组织(字节共享、行独立、钦定就位)。
    expect(cloneShots.every(shot => shot.selectedVideoArtifactId !== null)).toBe(true)
    const cloneArtifact = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: cloneShots[0]!.selectedVideoArtifactId! } })
    expect(cloneArtifact.organizationId).toBe(organizationId)
    expect(cloneArtifact.objectKey).toBeTruthy()
    // 非示例项目走 clone 接口 404——它不是教材。
    const normal = await env.app.inject({ method: 'POST', url: '/api/projects', headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: { name: '普通' } })
    expect((await env.app.inject({ method: 'POST', url: `/api/projects/${normal.json().id}/clone-example`, headers: authHeaders(ownerToken) })).statusCode).toBe(404)
  })
})
