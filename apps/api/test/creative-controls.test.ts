import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv
let ownerToken: string
let episodeId: string
let storyboardId: string

const authHeaders = (token: string) => env.authHeaders(token)
const json = (token: string) => ({ ...authHeaders(token), 'content-type': 'application/json' })

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('ctrl-owner@example.com', 'Ctrl Org')
  ownerToken = owner.token
  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: json(ownerToken), payload: { name: 'Ctrl Drama' } })
  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${project.json().id}/episodes`, headers: json(ownerToken), payload: { number: 1, title: 'EP1' } })
  episodeId = episode.json().id as string
  const storyboard = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: json(ownerToken), payload: { number: 1, title: 'SB1', durationMs: 5000, description: '雨夜巷口', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' } })
  storyboardId = storyboard.json().id as string
}, 300_000)

afterAll(async () => { await env?.stop() })

describe('creative controls (US-014)', () => {
  it('returns all-null controls for an untouched shot (auto = default)', async () => {
    const read = await env.app.inject({ method: 'GET', url: `/api/storyboards/${storyboardId}/creative-controls`, headers: authHeaders(ownerToken) })
    expect(read.statusCode).toBe(200)
    const body = read.json() as { stateRevision: number; controls: Record<string, string | null> }
    expect(body.stateRevision).toBe(0)
    expect(Object.values(body.controls).every(value => value === null)).toBe(true)
  })

  it('saves structured controls with CAS and rejects stale revisions', async () => {
    const read = await env.app.inject({ method: 'GET', url: `/api/storyboards/${storyboardId}/creative-controls`, headers: authHeaders(ownerToken) })
    const rev0 = (read.json() as { stateRevision: number }).stateRevision

    const set = await env.app.inject({
      method: 'PATCH', url: `/api/storyboards/${storyboardId}/creative-controls`,
      headers: json(ownerToken),
      payload: { framing: 'close_up', cameraMovement: 'handheld', mood: '紧张', expectedStateRevision: rev0 },
    })
    expect(set.statusCode).toBe(200)
    expect((set.json() as { stateRevision: number }).stateRevision).toBe(rev0 + 1)
    expect((set.json() as { controls: { framing: string } }).controls.framing).toBe('close_up')

    // CAS 冲突:旧 revision 提交 → 409 并返回当前 revision。
    const stale = await env.app.inject({
      method: 'PATCH', url: `/api/storyboards/${storyboardId}/creative-controls`,
      headers: json(ownerToken),
      payload: { framing: 'wide', expectedStateRevision: rev0 },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().code).toBe('version_conflict')

    // 旧自由描述不被回填。
    const shot = await env.db.storyboard.findUniqueOrThrow({ where: { id: storyboardId } })
    expect(shot.description).toBe('雨夜巷口')
  })

  it('validates enum fields and accepts null to clear', async () => {
    const bad = await env.app.inject({ method: 'PATCH', url: `/api/storyboards/${storyboardId}/creative-controls`, headers: json(ownerToken), payload: { framing: 'bogus' } })
    expect(bad.statusCode).toBe(400)

    const clear = await env.app.inject({ method: 'PATCH', url: `/api/storyboards/${storyboardId}/creative-controls`, headers: json(ownerToken), payload: { framing: null } })
    expect(clear.statusCode).toBe(200)
    expect((clear.json() as { controls: { framing: string | null } }).controls.framing).toBeNull()
  })

  it('keeps controls org-scoped', async () => {
    const rival = await env.register('ctrl-rival@example.com', 'Rival Ctrl Org')
    expect((await env.app.inject({ method: 'GET', url: `/api/storyboards/${storyboardId}/creative-controls`, headers: authHeaders(rival.token) })).statusCode).toBe(404)
  })
})
