import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv
let ownerToken: string
let editorToken: string
let viewerToken: string
let organizationId: string
let projectId: string

const authHeaders = (token: string) => env.authHeaders(token)
const json = (token: string) => ({ ...authHeaders(token), 'content-type': 'application/json' })

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('cr-owner@example.com', 'CR Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
  for (const [email, role] of [['cr-editor@example.com', 'EDITOR'], ['cr-viewer@example.com', 'VIEWER']] as const) {
    await env.register(email, 'CR Org')
    await env.app.inject({ method: 'POST', url: '/api/members', headers: json(ownerToken), payload: { email, role } })
    const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123', organizationId } })
    if (role === 'EDITOR') editorToken = login.json().token
    else viewerToken = login.json().token
  }
  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: json(ownerToken), payload: { name: 'CR Drama' } })
  projectId = project.json().id as string
}, 300_000)

afterAll(async () => { await env?.stop() })

describe('creation readiness (US-009)', () => {
  it('answers connect_provider first, then walks to ready as the operator configures', async () => {
    const empty = await env.app.inject({ method: 'GET', url: `/api/projects/${projectId}/creation-readiness`, headers: authHeaders(ownerToken) })
    expect(empty.statusCode).toBe(200)
    const first = empty.json() as { nextStep: string; required: { ready: number; total: number }; recommendationVersion: string }
    expect(first.nextStep).toBe('connect_provider')
    expect(first.required.ready).toBe(0)
    expect(first.recommendationVersion).toBeTruthy()

    // 接厂商(未探测) → nextStep 升级为 probe_models。
    await env.db.providerConnection.create({
      data: { organizationId, provider: 'mock', name: 'cr-mock', baseUrl: 'mock://local', encryptedSecret: 'dGVzdA==',
        capabilities: { create: [
          { model: 'mock-script', modality: 'text', acceptsFirstFrame: false, acceptsReferenceImages: false, maxReferenceImages: 0 },
          { model: 'mock-image', modality: 'image', acceptsFirstFrame: false, acceptsReferenceImages: false, maxReferenceImages: 0 },
          { model: 'mock-t2v', modality: 't2v', acceptsFirstFrame: false, acceptsReferenceImages: false, maxReferenceImages: 0 },
        ] } },
    })
    const probed = await env.app.inject({ method: 'GET', url: `/api/projects/${projectId}/creation-readiness`, headers: authHeaders(ownerToken) })
    expect((probed.json() as { nextStep: string }).nextStep).toBe('probe_models')

    // 探测通过 → auto_bind;一键补齐(项目内入口)→ 必填全齐 → ready。
    const conn = await env.db.providerConnection.findFirstOrThrow({ where: { organizationId } })
    await env.db.modelCapability.updateMany({ where: { connectionId: conn.id }, data: { entitlementVerifiedAt: new Date() } })
    const bindable = await env.app.inject({ method: 'GET', url: `/api/projects/${projectId}/creation-readiness`, headers: authHeaders(ownerToken) })
    expect((bindable.json() as { nextStep: string }).nextStep).toBe('auto_bind')

    const bind = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/auto-bind`, headers: auth(ownerToken) })
    expect(bind.statusCode).toBe(201)
    const done = await env.app.inject({ method: 'GET', url: `/api/projects/${projectId}/creation-readiness`, headers: authHeaders(ownerToken) })
    const final = done.json() as { nextStep: string; required: { ready: number; total: number } }
    expect(final.nextStep).toBe('ready')
    expect(final.required.ready).toBe(final.required.total)
  })

  it('keeps permissions honest: viewers read, editors cannot configure org bindings, owners can', async () => {
    // viewer 可读;auto-bind 需要 bindings:manage(viewer 403)。
    expect((await env.app.inject({ method: 'GET', url: `/api/projects/${projectId}/creation-readiness`, headers: authHeaders(viewerToken) })).statusCode).toBe(200)
    expect((await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/auto-bind`, headers: authHeaders(viewerToken) })).statusCode).toBe(403)
    // 组织外/不存在项目 404,凭据永不出现。
    const body = await (await env.app.inject({ method: 'GET', url: `/api/projects/${projectId}/creation-readiness`, headers: authHeaders(editorToken) })).body
    expect(body).not.toContain('encryptedSecret')
  })
})

function auth(token: string): Record<string, string> {
  return env.authHeaders(token)
}
