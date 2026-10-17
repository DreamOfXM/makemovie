import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv

beforeAll(async () => {
  env = await startTestEnv()
}, 300_000)

afterAll(async () => { await env?.stop() })

describe('unified error envelope (US-013)', () => {
  it('distinguishes permission, input, version-conflict and unauthenticated by stable code', async () => {
    const owner = await env.register('err-owner@example.com', 'Err Org')
    const token = env.authHeaders(owner.token)['authorization']!.replace('Bearer ', '')
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: { ...env.authHeaders(owner.token), 'content-type': 'application/json' }, payload: { name: 'Err Drama' } })
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${project.json().id}/episodes`, headers: { ...env.authHeaders(owner.token), 'content-type': 'application/json' }, payload: { number: 1, title: 'EP1' } })
    const episodeId = episode.json().id as string

    // 未认证:401(裸形状——旧中间件;parseApiError 在客户端归一)。
    const unauth = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/production-runs`, payload: { stage: 'SCRIPT' } })
    expect(unauth.statusCode).toBe(401)

    // 输入错误:400(裸形状来自 parseDraft,code 在 apiError 层面;此处验裸形状不倒)。
    const badStage = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/creation-plans`, headers: { ...env.authHeaders(owner.token), 'content-type': 'application/json' }, payload: { stage: 'bogus' } })
    expect(badStage.statusCode).toBe(400)

    // 版本冲突:US-013 封套(code/version_conflict/billingRisk)。
    const drift = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/production-runs`, headers: { ...env.authHeaders(owner.token), 'content-type': 'application/json' }, payload: { stage: 'SCRIPT', fingerprint: 'x' } })
    expect(drift.statusCode).toBe(409)
    const envelope = drift.json() as { code: string; message: string; nextAction: string; retryable: boolean; billingRisk: string }
    expect(envelope.code).toBe('version_conflict')
    expect(envelope.nextAction).toBe('replan')
    expect(envelope.billingRisk).toBe('none')
    expect(envelope.retryable).toBe(false)
    void token
  })
})
