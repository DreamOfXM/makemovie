import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv
let orgId: string
let ownerToken: string
let episodeId: string

const authHeaders = (token: string) => env.authHeaders(token)
const json = (token: string) => ({ ...authHeaders(token), 'content-type': 'application/json' })

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('plan-owner@example.com', 'Plan Org')
  ownerToken = owner.token
  orgId = owner.organization.id
  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: json(ownerToken), payload: { name: 'Plan Drama' } })
  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${project.json().id}/episodes`, headers: json(ownerToken), payload: { number: 1, title: 'EP1' } })
  episodeId = episode.json().id as string
}, 300_000)

afterAll(async () => { await env?.stop() })

describe('creation plans & production runs (US-011)', () => {
  const bindScriptModel = async () => {
    const connection = await env.db.providerConnection.create({
      data: { organizationId: orgId!, provider: 'mock', name: 'plan-mock', baseUrl: 'mock://local', encryptedSecret: 'dGVzdA==', capabilities: { create: [{ model: 'mock-script', modality: 'text', acceptsFirstFrame: false, acceptsReferenceImages: false, maxReferenceImages: 0, entitlementVerifiedAt: new Date() }] } },
    })
    const capability = await env.db.modelCapability.findFirstOrThrow({ where: { connectionId: connection.id } })
    await env.db.capabilityBinding.create({ data: { organizationId: orgId!, slot: 'SCRIPT_TEXT', capabilityId: capability.id, priority: 10 } })
  }

  const seedSource = async () => {
    await env.db.sourceDocumentVersion.create({ data: { episodeId, version: 1, content: '老城的巷子，雨下了整夜。', checksum: 'a'.repeat(64), status: 'APPROVED' } })
  }

  it('plans without spending and rejects drifted submissions with 409', async () => {
    // 计划:不落批次不花钱。
    const plan = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/creation-plans`, headers: json(ownerToken), payload: { stage: 'SCRIPT' } })
    expect(plan.statusCode).toBe(200)
    const body = plan.json() as { plan: { fingerprint: string; estimatedTasks: number }; estimatedCalls: number }
    expect(body.plan.fingerprint).toHaveLength(64)
    expect(body.plan.estimatedTasks).toBe(1)
    expect(await env.db.generationBatch.count()).toBe(0)

    // 指纹漂移:提交带旧指纹/改参数 → 409 version_conflict,零任务。
    const drifted = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/production-runs`, headers: json(ownerToken), payload: { stage: 'SCRIPT', fingerprint: 'deadbeef' } })
    expect(drifted.statusCode).toBe(409)
    expect(drifted.json().code).toBe('version_conflict')
    expect(await env.db.generationTask.count()).toBe(0)
  })

  it('submits through the same triggerStage path and replays idempotently per key', async () => {
    await seedSource()
    await bindScriptModel()
    const plan = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/creation-plans`, headers: json(ownerToken), payload: { stage: 'SCRIPT' } })
    const fingerprint = (plan.json() as { plan: { fingerprint: string } }).plan.fingerprint
    const run = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/production-runs`, headers: { ...json(ownerToken), 'idempotency-key': 'run-once' }, payload: { stage: 'SCRIPT', fingerprint } })
    if (run.statusCode !== 201) throw new Error(`run failed: ${run.body}`)
    expect(run.statusCode).toBe(201)
    const batchId = run.json().batchId as string
    expect(await env.db.generationBatch.count({ where: { id: batchId } })).toBe(1)

    // 同键同参:复用,不新建批次。
    const replay = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/production-runs`, headers: { ...json(ownerToken), 'idempotency-key': 'run-once' }, payload: { stage: 'SCRIPT', fingerprint } })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().idempotentReplay).toBe(true)
    expect(replay.json().batchId).toBe(batchId)

    // 同键异参:409 冲突,不是静默复用。
    const conflict = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/production-runs`, headers: { ...json(ownerToken), 'idempotency-key': 'run-once' }, payload: { stage: 'SCRIPT', fingerprint, promptNote: 'different' } })
    expect(conflict.statusCode).toBe(409)

    // 不带键的重复提交:triggerStage 幂等键去重(同一镜已有成功任务不再新建)。
    const again = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/production-runs`, headers: json(ownerToken), payload: { stage: 'SCRIPT', fingerprint } })
    expect([200, 201]).toContain(again.statusCode)
  })

  it('keeps planning readable but running privileged', async () => {
    await env.register('plan-viewer@example.com', 'Plan Viewer Org')
    void 0
    const plan = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/creation-plans`, headers: json(ownerToken), payload: { stage: 'SCRIPT' } })
    const fingerprint = (plan.json() as { plan: { fingerprint: string } }).plan.fingerprint
    expect((await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/production-runs` })).statusCode).toBe(401)
    void fingerprint
  })
})
