import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

// 就绪度面板要说「现在跑不跑得通」，这只有真实调用履历能回答：探测时间戳在额度
// 用尽、权限被收回之后不会自己变红。每条报文都从本机 GenerationTask.errorSnapshot
// 里原样抄出来，分类器错一条，界面上就是一句假的原因。
const QUOTA_SNAPSHOT = '["dashscope/wan2.7-t2v: AllocationQuota.FreeTierOnly | Free quota exhausted."]'

let env: TestEnv

beforeAll(async () => {
  env = await startTestEnv()
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

const clock = Date.now()
const at = (minutesAgo: number): Date => new Date(clock - minutesAgo * 60_000)

interface Evidence { ok: number; failed: number; lastStatus: string; lastAt: string; lastKind: string }

async function seedOrg(email: string, orgName: string) {
  const me = await env.register(email, orgName)
  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: env.authHeaders(me.token), payload: { name: `${orgName} drama` } })
  expect(project.statusCode).toBe(201)
  const episode = await env.app.inject({
    method: 'POST', url: `/api/projects/${project.json().id as string}/episodes`, headers: env.authHeaders(me.token),
    payload: { number: 1, title: 'EP1' },
  })
  expect(episode.statusCode).toBe(201)
  return { token: me.token, organizationId: me.organization.id, episodeId: episode.json().id as string }
}

// GenerationTask.batchId 是必填外键，所以一条任务要连着建一个批次。
async function seedCall(
  org: { organizationId: string; episodeId: string },
  data: { provider: string | null; model: string | null; status: 'SUCCEEDED' | 'FAILED' | 'QUEUED'; errorSnapshot?: string; at: Date },
) {
  const batch = await env.db.generationBatch.create({
    data: { organizationId: org.organizationId, episodeId: org.episodeId, stage: 'VIDEO', status: 'COMPLETED', plannedCount: 1 },
  })
  return env.db.generationTask.create({
    data: {
      organizationId: org.organizationId,
      batchId: batch.id,
      stage: 'VIDEO',
      status: data.status,
      provider: data.provider,
      model: data.model,
      errorSnapshot: data.errorSnapshot ?? null,
      updatedAt: data.at,
    },
  })
}

const evidence = async (token: string) => {
  const res = await env.app.inject({ method: 'GET', url: '/api/providers/call-evidence', headers: env.authHeaders(token) })
  expect(res.statusCode).toBe(200)
  return res.json() as Record<string, Evidence>
}

describe('GET /providers/call-evidence', () => {
  it('按 "<provider>|<model>" 汇总每个模型的真实战绩，失败按终因分类', async () => {
    const org = await seedOrg('evidence-owner@example.com', 'Evidence Org')
    await seedCall(org, { provider: 'dashscope', model: 'wan2.7-t2v', status: 'SUCCEEDED', at: at(30) })
    // 候选链整条都真的试过并失败了，所以两个模型都要记账。
    await seedCall(org, { provider: 'dashscope', model: 'wan2.7-t2v → wan2.7-plus', status: 'FAILED', errorSnapshot: QUOTA_SNAPSHOT, at: at(5) })

    const body = await evidence(org.token)
    expect(Object.keys(body).sort()).toEqual(['dashscope|wan2.7-plus', 'dashscope|wan2.7-t2v'])
    expect(body['dashscope|wan2.7-t2v']).toMatchObject({ ok: 1, failed: 1, lastStatus: 'FAILED', lastKind: 'quota' })
    expect(body['dashscope|wan2.7-plus']).toMatchObject({ ok: 0, failed: 1, lastStatus: 'FAILED', lastKind: 'quota' })
    // lastAt 跟最新那次调用，不是最早那次——面板要说「最近一次（某日）失败」。
    expect(new Date(body['dashscope|wan2.7-t2v']!.lastAt).getTime()).toBe(at(5).getTime())
  })

  it('没 provider 的任务照样记得到，未落定的任务不进履历', async () => {
    const org = await seedOrg('evidence-keyless@example.com', 'Keyless Org')
    await seedCall(org, { provider: null, model: 'some-model', status: 'FAILED', errorSnapshot: 'some-model: fetch failed', at: at(2) })
    await seedCall(org, { provider: 'dashscope', model: null, status: 'FAILED', at: at(1) })
    await seedCall(org, { provider: 'dashscope', model: 'wan2.7-t2v', status: 'QUEUED', at: at(1) })

    const body = await evidence(org.token)
    expect(Object.keys(body)).toEqual(['?|some-model'])
    expect(body['?|some-model']).toMatchObject({ failed: 1, lastKind: 'network' })
  })

  it('只报本组织的调用，别组织的战绩不会漏进来', async () => {
    const mine = await seedOrg('evidence-side-a@example.com', 'Side A Org')
    const theirs = await seedOrg('evidence-side-b@example.com', 'Side B Org')
    await seedCall(mine, { provider: 'dashscope', model: 'my-model', status: 'FAILED', errorSnapshot: '["x: AccessDenied | Access denied."]', at: at(9) })
    await seedCall(theirs, { provider: 'dashscope', model: 'their-model', status: 'FAILED', errorSnapshot: QUOTA_SNAPSHOT, at: at(9) })

    const mineBody = await evidence(mine.token)
    expect(Object.keys(mineBody)).toEqual(['dashscope|my-model'])
    expect(mineBody['dashscope|my-model']).toMatchObject({ lastKind: 'access' })
    expect(await Object.keys(await evidence(theirs.token))).toEqual(['dashscope|their-model'])
  })

  it('拒绝匿名访问', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/providers/call-evidence' })
    expect(res.statusCode).toBe(401)
  })
})
