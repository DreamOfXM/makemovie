import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv

beforeAll(async () => {
  env = await startTestEnv()
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

const authHeaders = (token: string) => env.authHeaders(token)

interface Connection {
  id: string
  provider: string
  name: string
  capabilities: { id: string; model: string; modality: string }[]
}

async function createProbedMockConnection(token: string, name: string): Promise<Connection> {
  const created = await env.app.inject({
    method: 'POST',
    url: '/api/providers/connections',
    headers: authHeaders(token),
    payload: { provider: 'mock', name, apiKey: 'test-key' },
  })
  expect(created.statusCode).toBe(201)
  const connection = created.json() as Connection
  const probed = await env.app.inject({ method: 'POST', url: `/api/providers/connections/${connection.id}/probe`, headers: authHeaders(token) })
  expect(probed.statusCode).toBe(200)
  return connection
}

interface ReadinessResponse {
  required: { ready: number; total: number }
  slots: { slot: string; state: string; usage: { required: boolean } }[]
  gaps: { slot: string; state: string; required: boolean }[]
}

interface AutoBindResponse {
  dryRun: boolean
  planned: { slot: string; model: string; capabilityId: string }[]
  created?: { slot: string; model: string; bindingId: string }[]
  skipped?: { slot: string; reason: string }[]
  unfulfilled: string[]
}

describe('GET /api/system/readiness', () => {
  it('answers "what is missing" with the same rules the console renders', async () => {
    const owner = await env.register('auto-readiness@example.com', 'Auto Readiness Org')
    const res = await env.app.inject({ method: 'GET', url: '/api/system/readiness', headers: authHeaders(owner.token) })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ReadinessResponse
    expect(body.required).toEqual({ ready: 0, total: 4 })
    expect(body.gaps.filter(gap => gap.required).map(gap => gap.slot)).toEqual(['script_text', 'storyboard_text', 'image_gen', 'video_t2v'])
    // 中立性脚注也在这一个回答里：并列组合与逐槽家数，不必复刻前端。
    const coverage = (res.json() as { catalogCoverage: { perSlot: { slot: string; providers: { provider: string }[] }[]; minimumConnections: { count: number | null } } }).catalogCoverage
    expect(coverage.minimumConnections.count).toBe(1)
    expect(coverage.perSlot.find(entry => entry.slot === 'video_t2v')?.providers.map(entry => entry.provider)).toEqual(['dashscope', 'seedance', 'kling', 'google'])
  })

  it('rejects anonymous access', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/system/readiness' })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /api/bindings/auto', () => {
  it('dryRun says what it would bind without writing anything', async () => {
    const owner = await env.register('auto-dry@example.com', 'Auto Dry Org')
    await createProbedMockConnection(owner.token, 'mock-dry')
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/bindings/auto',
      headers: authHeaders(owner.token),
      payload: { dryRun: true },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as AutoBindResponse
    expect(body.dryRun).toBe(true)
    expect(body.planned.map(item => item.slot).sort()).toEqual(['image_gen', 'script_text', 'storyboard_text', 'video_t2v'])
    expect(body.created).toBeUndefined()
    expect(await env.db.capabilityBinding.count({ where: { organizationId: owner.organization.id } })).toBe(0)
    // 「先说打算做什么，等人点头」：dry-run 也不留审计行，因为什么都没发生。
    expect(await env.db.auditEvent.count({ where: { organizationId: owner.organization.id, action: 'binding.auto' } })).toBe(0)
  })

  it('binds every empty required slot through the same write path as POST /bindings, then readiness reads 4/4', async () => {
    const owner = await env.register('auto-run@example.com', 'Auto Run Org')
    await createProbedMockConnection(owner.token, 'mock-run')

    const before = await env.app.inject({ method: 'GET', url: '/api/system/readiness', headers: authHeaders(owner.token) })
    expect((before.json() as ReadinessResponse).required).toEqual({ ready: 0, total: 4 })

    const res = await env.app.inject({ method: 'POST', url: '/api/bindings/auto', headers: authHeaders(owner.token), payload: {} })
    expect(res.statusCode).toBe(200)
    const body = res.json() as AutoBindResponse
    expect(body.created).toHaveLength(4)
    expect(body.unfulfilled).toEqual([])
    expect(body.skipped).toEqual([])
    // 每条绑定走的是共用 createBinding：逐条 binding.create 审计 + 一条 binding.auto 汇总。
    expect(await env.db.auditEvent.count({ where: { organizationId: owner.organization.id, action: 'binding.create' } })).toBe(4)
    expect(await env.db.auditEvent.count({ where: { organizationId: owner.organization.id, action: 'binding.auto' } })).toBe(1)

    const after = await env.app.inject({ method: 'GET', url: '/api/system/readiness', headers: authHeaders(owner.token) })
    expect((after.json() as ReadinessResponse).required).toEqual({ ready: 4, total: 4 })
  })

  it('is additive: a second run finds every required slot served and plans nothing', async () => {
    const owner = await env.register('auto-twice@example.com', 'Auto Twice Org')
    await createProbedMockConnection(owner.token, 'mock-twice')
    await env.app.inject({ method: 'POST', url: '/api/bindings/auto', headers: authHeaders(owner.token), payload: {} })
    const second = await env.app.inject({ method: 'POST', url: '/api/bindings/auto', headers: authHeaders(owner.token), payload: {} })
    expect(second.statusCode).toBe(200)
    const body = second.json() as AutoBindResponse
    expect(body.planned).toEqual([])
    expect(body.created).toHaveLength(0)
  })

  it('never touches optional slots unless asked — auto-binding tts_voice is auto-spending', async () => {
    const owner = await env.register('auto-optional@example.com', 'Auto Optional Org')
    await createProbedMockConnection(owner.token, 'mock-optional')
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/bindings/auto',
      headers: authHeaders(owner.token),
      payload: { dryRun: true, includeOptional: true },
    })
    const body = res.json() as AutoBindResponse
    expect(body.planned.map(item => item.slot)).toContain('tts_voice')
    expect(body.planned.map(item => item.slot)).not.toContain('music_gen')

    const bare = await env.app.inject({
      method: 'POST',
      url: '/api/bindings/auto',
      headers: authHeaders(owner.token),
      payload: { dryRun: true },
    })
    expect((bare.json() as AutoBindResponse).planned.map(item => item.slot)).not.toContain('tts_voice')
  })

  it('unprobed capabilities are refused, so auto-bind cannot ride an unverified key', async () => {
    const owner = await env.register('auto-unprobed@example.com', 'Auto Unprobed Org')
    // 连接建了但没探测：池子里没有任何已验证能力。
    const created = await env.app.inject({
      method: 'POST',
      url: '/api/providers/connections',
      headers: authHeaders(owner.token),
      payload: { provider: 'mock', name: 'mock-unprobed', apiKey: 'test-key' },
    })
    expect(created.statusCode).toBe(201)
    const res = await env.app.inject({ method: 'POST', url: '/api/bindings/auto', headers: authHeaders(owner.token), payload: {} })
    expect(res.statusCode).toBe(200)
    const body = res.json() as AutoBindResponse
    expect(body.planned).toEqual([])
    expect(body.unfulfilled.sort()).toEqual(['image_gen', 'script_text', 'storyboard_text', 'video_t2v'])
    expect(await env.db.capabilityBinding.count({ where: { organizationId: owner.organization.id } })).toBe(0)
  })

  it('unknown slots are a 400, not a silent skip', async () => {
    const owner = await env.register('auto-badslot@example.com', 'Auto Bad Slot Org')
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/bindings/auto',
      headers: authHeaders(owner.token),
      payload: { slots: ['not_a_slot'] },
    })
    expect(res.statusCode).toBe(400)
  })
})
