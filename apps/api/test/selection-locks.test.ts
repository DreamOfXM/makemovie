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
  const owner = await env.register('lock-owner@example.com', 'Lock Org')
  ownerToken = owner.token
  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: json(ownerToken), payload: { name: 'Lock Drama' } })
  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${project.json().id}/episodes`, headers: json(ownerToken), payload: { number: 1, title: 'EP1' } })
  episodeId = episode.json().id as string
  const sb = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: json(ownerToken), payload: { number: 1, title: 'SB1', durationMs: 5000, description: '雨夜巷口', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' } })
  storyboardId = sb.json().id as string
}, 300_000)

afterAll(async () => { await env?.stop() })

describe('selection locks (US-015)', () => {
  it('locks and unlocks with CAS; stale revision is rejected', async () => {
    const shot0 = await env.db.storyboard.findUniqueOrThrow({ where: { id: storyboardId } })
    expect(shot0.lockedVideoSelection).toBe(false)

    const lock = await env.app.inject({ method: 'PATCH', url: `/api/storyboards/${storyboardId}/locks`, headers: json(ownerToken), payload: { lockedVideoSelection: true, expectedStateRevision: shot0.stateRevision } })
    expect(lock.statusCode).toBe(200)
    expect(lock.json().lockedVideoSelection).toBe(true)
    expect(lock.json().stateRevision).toBe(shot0.stateRevision + 1)

    // CAS 冲突。
    const stale = await env.app.inject({ method: 'PATCH', url: `/api/storyboards/${storyboardId}/locks`, headers: json(ownerToken), payload: { lockedReferences: true, expectedStateRevision: shot0.stateRevision } })
    expect(stale.statusCode).toBe(409)

    // 解锁。
    const rev1 = lock.json().stateRevision as number
    const unlock = await env.app.inject({ method: 'PATCH', url: `/api/storyboards/${storyboardId}/locks`, headers: json(ownerToken), payload: { lockedVideoSelection: false, expectedStateRevision: rev1 } })
    expect(unlock.statusCode).toBe(200)
    expect(unlock.json().lockedVideoSelection).toBe(false)
  })

  it('stores lock state persistently and is org-scoped', async () => {
    // 锁定持久化 + 组织隔离。
    await env.db.storyboard.update({ where: { id: storyboardId }, data: { lockedReferences: true } })
    const shot = await env.db.storyboard.findUniqueOrThrow({ where: { id: storyboardId }, select: { lockedReferences: true, lockedVideoSelection: true, lockedVoiceSelection: true } })
    expect(shot.lockedReferences).toBe(true)
    expect(shot.lockedVideoSelection).toBe(false)
    const rival = await env.register('lock-rival@example.com', 'Rival Lock Org')
    expect((await env.app.inject({ method: 'PATCH', url: `/api/storyboards/${storyboardId}/locks`, headers: json(rival.token), payload: { lockedReferences: false } })).statusCode).toBe(404)
    await env.db.storyboard.update({ where: { id: storyboardId }, data: { lockedReferences: false } })
  })
})
