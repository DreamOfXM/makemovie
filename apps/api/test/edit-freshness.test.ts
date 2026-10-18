import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv
let ownerToken: string
let episodeId: string

const authHeaders = (token: string) => env.authHeaders(token)
const json = (token: string) => ({ ...authHeaders(token), 'content-type': 'application/json' })

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('fresh-owner@example.com', 'Fresh Org')
  ownerToken = owner.token
  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: json(ownerToken), payload: { name: 'Fresh Drama' } })
  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${project.json().id}/episodes`, headers: json(ownerToken), payload: { number: 1, title: 'EP1' } })
  episodeId = episode.json().id as string
}, 300_000)

afterAll(async () => { await env?.stop() })

describe('edit freshness (US-028)', () => {
  it('reports no_composition, then fresh, then stale after edit change', async () => {
    // 初始化编辑(隐式 via GET edit)。
    await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit`, headers: authHeaders(ownerToken) })

    // 无合成。
    const empty = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit/freshness`, headers: authHeaders(ownerToken) })
    expect(empty.statusCode).toBe(200)
    expect(empty.json().status).toBe('no_composition')

    // 造一个带指纹的合成(直接落库,模拟 worker 完成)。
    const edit = await env.db.episodeEdit.findUniqueOrThrow({ where: { episodeId }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } })
    await env.db.composition.create({
      data: { episodeId, status: 'COMPLETED', manifest: '{}', editRevisionId: edit.revisions[0]!.id, inputFingerprint: edit.revisions[0]!.fingerprint },
    })
    const fresh = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit/freshness`, headers: authHeaders(ownerToken) })
    expect(fresh.json().status).toBe('fresh')

    // 改编辑(新修订 → 新指纹) → stale。
    await env.app.inject({
      method: 'PUT', url: `/api/episodes/${episodeId}/edit`,
      headers: json(ownerToken),
      payload: { expectedEditRevision: edit.headRevision, fps: { fpsNum: 30, fpsDen: 1 }, clips: [{ clipId: 'c1', storyboardId: 'sb1', artifactId: '', sourceInFrame: 0, sourceOutFrame: 50 }] },
    })
    const stale = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit/freshness`, headers: authHeaders(ownerToken) })
    expect(stale.json().status).toBe('stale')
    expect(stale.json().message).toContain('edit has changed')
  })
})
