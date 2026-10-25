import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

/**
 * SD-022：整批分镜审批端点。批准直接写活体行（与素材/剧本/源文档审批同一先例），
 * 被取代的旧版与别的剧集绝不触碰；SD-020：generations 端点本来就把批次 status 与
 * 任务 error 一起下发——流程页读同一份数据，不另开 fetch，这里证明数据确实在。
 */

let env: TestEnv
let ownerToken: string
let viewerToken: string
let organizationId: string
let episodeId: string
let otherEpisodeId: string
let shotIds: string[] = []
let supersededShotId: string

const post = (token: string, payload: Record<string, unknown>, episode = episodeId) =>
  env.app.inject({ method: 'POST', url: `/api/episodes/${episode}/storyboard-status`, headers: env.authHeaders(token), payload })

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('bulk-owner@example.com', 'Bulk Approve Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
  await env.register('bulk-viewer@example.com', 'Bulk Viewer Org')
  const added = await env.app.inject({ method: 'POST', url: '/api/members', headers: env.authHeaders(ownerToken), payload: { email: 'bulk-viewer@example.com', role: 'VIEWER' } })
  expect(added.statusCode).toBe(201)
  const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'bulk-viewer@example.com', password: 'password123', organizationId } })
  expect(login.statusCode).toBe(200)
  viewerToken = login.json().token as string

  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: env.authHeaders(ownerToken), payload: { name: 'Bulk Drama' } })
  expect(project.statusCode).toBe(201)
  const projectId = project.json().id as string
  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: env.authHeaders(ownerToken), payload: { number: 1, title: 'EP1' } })
  expect(episode.statusCode).toBe(201)
  episodeId = episode.json().id as string
  const otherEpisode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: env.authHeaders(ownerToken), payload: { number: 2, title: 'EP2' } })
  expect(otherEpisode.statusCode).toBe(201)
  otherEpisodeId = otherEpisode.json().id as string

  for (const number of [1, 2, 3]) {
    const shot = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: env.authHeaders(ownerToken),
      payload: { number, title: `镜头${number}`, durationMs: 3000, description: `第七次死亡的镜头 ${number}` },
    })
    expect(shot.statusCode).toBe(201)
    shotIds.push(shot.json().id as string)
  }
  const foreignShot = await env.app.inject({
    method: 'POST', url: `/api/episodes/${otherEpisodeId}/storyboards`, headers: env.authHeaders(ownerToken),
    payload: { number: 1, title: '别集的镜头', durationMs: 3000, description: '不该被整批批准碰到' },
  })
  expect(foreignShot.statusCode).toBe(201)

  // 一条被取代的旧版镜头：整批审批只说现在在册的那一批，历史不许动。
  const old = await env.app.inject({
    method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: env.authHeaders(ownerToken),
    payload: { number: 9, title: '旧版镜头', durationMs: 3000, description: '上一版分镜的残留' },
  })
  expect(old.statusCode).toBe(201)
  supersededShotId = old.json().id as string
  await env.db.storyboard.update({ where: { id: supersededShotId }, data: { supersededAt: new Date() } })
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

describe('POST /episodes/:episodeId/storyboard-status', () => {
  it('bulk-approves every live shot and leaves superseded rows and other episodes alone', async () => {
    const res = await post(ownerToken, { to: 'approved' })
    expect(res.statusCode).toBe(200)
    expect(res.json().updated).toBe(3)
    const rows = await env.db.storyboard.findMany({ where: { id: { in: [...shotIds, supersededShotId] } }, select: { id: true, status: true } })
    const statusOf = new Map(rows.map(row => [row.id, row.status]))
    for (const id of shotIds) expect(statusOf.get(id)).toBe('APPROVED')
    expect(statusOf.get(supersededShotId)).toBe('DRAFT')
    const foreign = await env.db.storyboard.findMany({ where: { episodeId: otherEpisodeId }, select: { status: true } })
    expect(foreign.every(row => row.status === 'DRAFT')).toBe(true)
  })

  it('carries the new status out through the enriched storyboards endpoint the flow page already reads', async () => {
    const list = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/storyboards`, headers: env.authHeaders(viewerToken) })
    expect(list.statusCode).toBe(200)
    const shots = list.json() as { id: string; status: string }[]
    expect(shots.filter(shot => shotIds.includes(shot.id)).every(shot => shot.status === 'APPROVED')).toBe(true)
  })

  it('bulk-reopens approved shots back to draft (storyboard:write path)', async () => {
    const res = await post(ownerToken, { to: 'draft' })
    expect(res.statusCode).toBe(200)
    expect(res.json().updated).toBe(3)
    expect(await env.db.storyboard.count({ where: { id: { in: shotIds }, status: 'DRAFT' } })).toBe(3)
  })

  it('scopes to storyboardIds so one shot can be approved without the state machine', async () => {
    const res = await post(ownerToken, { to: 'approved', storyboardIds: [shotIds[0]] })
    expect(res.statusCode).toBe(200)
    expect(res.json().updated).toBe(1)
    expect((await env.db.storyboard.findUniqueOrThrow({ where: { id: shotIds[0]! } })).status).toBe('APPROVED')
    expect((await env.db.storyboard.findUniqueOrThrow({ where: { id: shotIds[1]! } })).status).toBe('DRAFT')
  })

  it('400s on unknown targets and malformed storyboardIds; 403s a viewer on both branches', async () => {
    expect((await post(ownerToken, { to: 'completed' })).statusCode).toBe(400)
    expect((await post(ownerToken, {})).statusCode).toBe(400)
    expect((await post(ownerToken, { to: 'approved', storyboardIds: 'not-an-array' })).statusCode).toBe(400)
    expect((await post(ownerToken, { to: 'approved', storyboardIds: [] })).statusCode).toBe(400)
    expect((await post(ownerToken, { to: 'approved', storyboardIds: [42] })).statusCode).toBe(400)

    const deniedApprove = await post(viewerToken, { to: 'approved' })
    expect(deniedApprove.statusCode).toBe(403)
    expect(deniedApprove.json().error).toMatch(/review:decide/)
    const deniedReopen = await post(viewerToken, { to: 'draft' })
    expect(deniedReopen.statusCode).toBe(403)
    expect(deniedReopen.json().error).toMatch(/storyboard:write/)
  })

  it('404s unknown and cross-organization episodes', async () => {
    const rival = await env.register('bulk-rival@example.com', 'Bulk Rival Org')
    const rivalProject = await env.app.inject({ method: 'POST', url: '/api/projects', headers: env.authHeaders(rival.token), payload: { name: 'Rival' } })
    const rivalEpisode = await env.app.inject({
      method: 'POST', url: `/api/projects/${rivalProject.json().id as string}/episodes`,
      headers: env.authHeaders(rival.token), payload: { number: 1, title: 'Rival EP' },
    })
    expect((await post(ownerToken, { to: 'approved' }, 'does-not-exist')).statusCode).toBe(404)
    expect((await post(ownerToken, { to: 'approved' }, rivalEpisode.json().id as string)).statusCode).toBe(404)
  })

  it('records one audit event per request under the new action codes', async () => {
    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events', headers: env.authHeaders(ownerToken) })
    expect(audit.statusCode).toBe(200)
    const events = audit.json().events as { action: string; entityType: string; entityId: string; payload: { count?: number } }[]
    const approve = events.filter(event => event.action === 'storyboard.bulkApprove' && event.entityType === 'Episode' && event.entityId === episodeId)
    expect(approve.length).toBeGreaterThanOrEqual(2)
    expect(approve.some(event => event.payload.count === 1)).toBe(true)
    const reopen = events.filter(event => event.action === 'storyboard.bulkReopen' && event.entityType === 'Episode' && event.entityId === episodeId)
    expect(reopen.length).toBe(1)
  })
})

describe('generations 端点把分镜批次的失败信号带在同一份响应里（SD-020）', () => {
  it('returns the newest STORYBOARD batch BLOCKED with the failed task error — no second fetch needed', async () => {
    // 先埋一次旧的成功批次，再落最新一次的失败批次：新→旧排序下第一条必须是失败的。
    const oldBatch = await env.db.generationBatch.create({
      data: { organizationId, episodeId, stage: 'STORYBOARD', status: 'COMPLETED', plannedCount: 1 },
    })
    await env.db.generationTask.create({
      data: { organizationId, batchId: oldBatch.id, stage: 'STORYBOARD', status: 'SUCCEEDED', provider: 'mock', model: 'mock-text', attempts: 1 },
    })
    const failedBatch = await env.db.generationBatch.create({
      data: { organizationId, episodeId, stage: 'STORYBOARD', status: 'BLOCKED', plannedCount: 1 },
    })
    await env.db.generationTask.create({
      data: {
        organizationId, batchId: failedBatch.id, stage: 'STORYBOARD', status: 'FAILED', attempts: 1,
        errorSnapshot: JSON.stringify(['AllocationQuota.FreeTierOnly: free quota exhausted']),
      },
    })

    const res = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/generations`, headers: env.authHeaders(ownerToken) })
    expect(res.statusCode).toBe(200)
    const batches = res.json().batches as { id: string; stage: string; status: string; tasks: { status: string; error: string | null }[] }[]
    const [newestStoryboard] = batches.filter(batch => batch.stage === 'STORYBOARD')
    expect(newestStoryboard?.id).toBe(failedBatch.id)
    expect(newestStoryboard?.status).toBe('BLOCKED')
    expect(newestStoryboard?.tasks.some(task => task.status === 'FAILED' && /AllocationQuota/.test(task.error ?? ''))).toBe(true)
    expect(batches.find(batch => batch.id === oldBatch.id)?.status).toBe('COMPLETED')
  })
})
