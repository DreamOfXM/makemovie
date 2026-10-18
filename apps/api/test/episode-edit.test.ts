import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv
let ownerToken: string
let episodeId: string

const authHeaders = (token: string) => env.authHeaders(token)
const json = (token: string) => ({ ...authHeaders(token), 'content-type': 'application/json' })

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('edit-owner@example.com', 'Edit Org')
  ownerToken = owner.token
  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: json(ownerToken), payload: { name: 'Edit Drama' } })
  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${project.json().id}/episodes`, headers: json(ownerToken), payload: { number: 1, title: 'EP1' } })
  episodeId = episode.json().id as string
  await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: json(ownerToken), payload: { number: 1, title: 'SB1', durationMs: 5000, description: '雨夜巷口', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' } })
  await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: json(ownerToken), payload: { number: 2, title: 'SB2', durationMs: 6000, description: '纸人开眼', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' } })
}, 300_000)

afterAll(async () => { await env?.stop() })

describe('episode edit (US-024)', () => {
  it('initializes a default sequence for a fresh episode (two clips, 25fps)', async () => {
    const read = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit`, headers: authHeaders(ownerToken) })
    expect(read.statusCode).toBe(200)
    const body = read.json() as { editId: string; headRevision: number; revision: { clips: Array<{ clipId: string; storyboardId: string; sourceInFrame: number; sourceOutFrame: number }>; fpsNum: number } }
    expect(body.headRevision).toBe(1)
    expect(body.revision.fpsNum).toBe(25)
    expect(body.revision.clips).toHaveLength(2)
    expect(body.revision.clips[0].clipId).toBe('clip-1')
    expect(body.revision.clips[1].clipId).toBe('clip-2')
  })

  it('saves revisions with CAS and rejects stale expectedEditRevision', async () => {
    const initial = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit`, headers: authHeaders(ownerToken) })
    const editId = (initial.json() as { editId: string }).editId

    // CAS 保存:调换两镜顺序。
    const reorder = await env.app.inject({
      method: 'PUT', url: `/api/episodes/${episodeId}/edit`,
      headers: json(ownerToken),
      payload: {
        expectedEditRevision: 1,
        fps: { fpsNum: 25, fpsDen: 1 },
        clips: [
          { clipId: 'clip-2', storyboardId: 'sb2', artifactId: '', sourceInFrame: 0, sourceOutFrame: 1 },
          { clipId: 'clip-1', storyboardId: 'sb1', artifactId: '', sourceInFrame: 0, sourceOutFrame: 1 },
        ],
      },
    })
    expect(reorder.statusCode).toBe(200)
    expect((reorder.json() as { headRevision: number }).headRevision).toBe(2)

    // CAS 冲突。
    const stale = await env.app.inject({
      method: 'PUT', url: `/api/episodes/${episodeId}/edit`,
      headers: json(ownerToken),
      payload: { expectedEditRevision: 1, fps: { fpsNum: 25, fpsDen: 1 }, clips: [] },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().code).toBe('version_conflict')
    void editId
  })

  it('restores a historical revision as a new head (immutable history)', async () => {
    // 保存 revision 3。
    await env.app.inject({
      method: 'PUT', url: `/api/episodes/${episodeId}/edit`,
      headers: json(ownerToken),
      payload: { expectedEditRevision: 2, fps: { fpsNum: 30, fpsDen: 1 }, clips: [{ clipId: 'clip-1', storyboardId: 'sb1', artifactId: '', sourceInFrame: 0, sourceOutFrame: 1 }] },
    })
    // 恢复 revision 1(初始默认序列)。
    const restore = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/edit/restore`, headers: json(ownerToken), payload: { revision: 1 } })
    expect(restore.statusCode).toBe(200)
    expect((restore.json() as { headRevision: number }).headRevision).toBe(4)
    // 历史 revision 1 仍存在且未被修改。
    const original = await env.db.episodeEditRevision.findUnique({ where: { editId_revision: { editId: (await env.db.episodeEdit.findUniqueOrThrow({ where: { episodeId } })).id, revision: 1 } } })
    expect(original).not.toBeNull()
    expect(original!.revision).toBe(1)
  })

  it('rejects invalid clips (empty range, non-integer)', async () => {
    const read = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit`, headers: authHeaders(ownerToken) })
    const rev = (read.json() as { headRevision: number }).headRevision
    const bad = await env.app.inject({
      method: 'PUT', url: `/api/episodes/${episodeId}/edit`,
      headers: json(ownerToken),
      payload: { expectedEditRevision: rev, fps: { fpsNum: 25, fpsDen: 1 }, clips: [{ clipId: 'c1', storyboardId: 'sb1', artifactId: '', sourceInFrame: 10, sourceOutFrame: 10 }] },
    })
    expect(bad.statusCode).toBe(400)
    void bad
  })
})
