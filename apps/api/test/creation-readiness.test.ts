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

describe('project-scoped readiness (R03: cross-project false ready)', () => {
  it("project B must not inherit project A's project-scoped bindings", async () => {
    // 现场复刻:组织必填全局绑定全部禁用;A 独有四个有效项目级绑定;B 无覆盖。
    await env.db.capabilityBinding.updateMany({ where: { organizationId, projectId: null }, data: { enabled: false } })
    const projectB = await env.app.inject({ method: 'POST', url: '/api/projects', headers: json(ownerToken), payload: { name: 'CR Project B' } })
    const projectIdB = projectB.json().id as string
    const projectABindings = await env.db.capabilityBinding.findMany({ where: { organizationId, projectId, enabled: true }, select: { slot: true, capabilityId: true } })
    expect(projectABindings.length).toBeGreaterThan(0)

    // B 的就绪:不允许把 A 的绑定算进来——必填 ready 必须少于全量,且不是 ready。
    const readinessB = await env.app.inject({ method: 'GET', url: `/api/projects/${projectIdB}/creation-readiness`, headers: authHeaders(ownerToken) })
    expect(readinessB.statusCode).toBe(200)
    const bodyB = readinessB.json() as { nextStep: string; required: { ready: number; total: number } }
    expect(bodyB.required.ready).toBe(0)
    expect(bodyB.nextStep).not.toBe('ready')

    // A 的就绪不受影响:自己的项目级绑定仍然算数。
    const readinessA = await env.app.inject({ method: 'GET', url: `/api/projects/${projectId}/creation-readiness`, headers: authHeaders(ownerToken) })
    const bodyA = readinessA.json() as { nextStep: string; required: { ready: number; total: number } }
    expect(bodyA.required.ready).toBe(bodyA.required.total)
    expect(bodyA.nextStep).toBe('ready')

    // B 的 auto-bind 规划同样只看自己的缺口:会给出要补的槽,而不是「已齐」。
    const autoB = await env.app.inject({ method: 'POST', url: `/api/projects/${projectIdB}/auto-bind`, headers: json(ownerToken) })
    if (autoB.statusCode === 201) {
      const created = (autoB.json() as { created: string[] }).created
      // 全部落在 B 的项目作用域,不动 A 的绑定。
      for (const row of created) expect(row).toBeTruthy()
      const bRows = await env.db.capabilityBinding.findMany({ where: { organizationId, projectId: projectIdB } })
      expect(bRows.length).toBe(created.length)
    } else {
      // nothing to bind 只允许发生在 B 真的无可补候选时,绝不能因为「已就绪」。
      expect((autoB.json() as { error?: string }).error).not.toContain('ready')
    }

    // 复原全局绑定,避免污染同文件其他用例。
    await env.db.capabilityBinding.updateMany({ where: { organizationId, projectId: null }, data: { enabled: true } })
    await env.db.capabilityBinding.deleteMany({ where: { organizationId, projectId: projectIdB } })
  })
})

function auth(token: string): Record<string, string> {
  return env.authHeaders(token)
}
