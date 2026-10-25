import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPipelineQueue } from '@studio/jobs'
import { resolveShotTake } from '@studio/db'
import { startTestEnv, type TestEnv } from './env.js'

// 与 regenerate-gate 同款：api 套件共用 worker 那台 Redis，私有逻辑库隔开别人的消费者。
const ambientEnv = { REDIS_URL: process.env.REDIS_URL }
process.env.REDIS_URL = 'redis://127.0.0.1:6380/11'

function restoreEnv(key: keyof typeof ambientEnv): void {
  const value = ambientEnv[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

let env: TestEnv
let queue: ReturnType<typeof createPipelineQueue>
let ownerToken: string
let organizationId: string

interface ArtifactDto {
  id: string
  version: number
  veto: { at: string; reason: string } | null
}

interface BatchDto {
  id: string
  stage: string
  plannedCount: number
  tasks: { id: string; status: string }[]
}

interface ShotboardShot {
  id: string
  number: number
  video: ArtifactDto | null
  videoCandidates: { artifactId: string; taskId: string | null; veto: { at: string; reason: string } | null; waived: boolean; waiveReason: string | null; awaitingDecision?: boolean }[]
}

/**
 * 一集两镜的最小底子：剧本已批准（媒体阶段的门），两镜合计正好等于本集目标（不欠缺口确认，
 * 与 regenerate-gate 里 'No Gap Drama' 同一套档：30 s 目标 / 两个 15 s 镜）。
 * 返回的 shotId 是 #1，测试都在它上面买片；#2 留空，用来证明逐镜动作不会被邻居带偏。
 */
async function episodeWithShot(name: string) {
  const headers = env.authHeaders(ownerToken)
  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name } })
  expect(project.statusCode).toBe(201)
  const projectId = project.json().id as string
  const episode = await env.app.inject({
    method: 'POST', url: `/api/projects/${projectId}/episodes`, headers,
    payload: { number: 1, title: 'EP1', targetDurationMs: 30_000 },
  })
  expect(episode.statusCode).toBe(201)
  const episodeId = episode.json().id as string
  await env.db.scriptVersion.create({ data: { episodeId, version: 1, content: `场景 1\n${name}`, checksum: `veto-${randomUUID()}`, status: 'APPROVED' } })
  const shotIds: string[] = []
  for (const [index, title] of ['栏杆断裂', '落地'].entries()) {
    const shot = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers,
      payload: { number: index + 1, title, durationMs: 15_000, description: '远景·高角度俯拍：栏杆断裂，他坠下去', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(shot.statusCode).toBe(201)
    shotIds.push(shot.json().id as string)
  }
  return { projectId, episodeId, shotId: shotIds[0]!, shotIds }
}

/** 取这一镜那一行（两镜集里按 number 排序，#1 就是被测镜）。 */
async function shotRow(episodeId: string) {
  const shots = await shotboard(episodeId)
  return shots.find(shot => shot.number === 1)!
}

/**
 * 一条已经买到成片的 VIDEO 任务。
 * waived=true 按「机器判退 → 人收下」的真实落库形状写（SUCCEEDED + 快照留着裁决）；
 * pending=true 是还没人决定的那条（FAILED + 快照 state pending），用来证明这一刀只给收下的版本。
 */
async function seedVideoTake(
  episodeId: string,
  shotId: string,
  options: { version: number; waived?: boolean; pending?: boolean; waiveReason?: string; metadata?: string; createdAt?: Date } = { version: 1 },
) {
  const batch = await env.db.generationBatch.create({
    data: {
      organizationId, episodeId, stage: 'VIDEO', status: 'COMPLETED', plannedCount: 1,
      storyboards: { connect: { id: shotId } },
    },
  })
  const task = await env.db.generationTask.create({
    data: {
      organizationId,
      batchId: batch.id,
      stage: 'VIDEO',
      status: options.pending ? 'FAILED' : 'SUCCEEDED',
      storyboardId: shotId,
      provider: 'mock',
      model: 'mock-t2v',
      attempts: 1,
      idempotencyKey: `${episodeId}:VIDEO:${shotId}${options.version > 1 ? `:r${options.version - 1}` : ''}`,
      createdAt: options.createdAt ?? new Date(),
    },
  })
  const artifact = await env.db.mediaArtifact.create({
    data: {
      organizationId, taskId: task.id, stage: 'VIDEO', storyboardId: shotId,
      objectKey: `${organizationId}/veto/${shotId}/v${options.version}.mp4`,
      checksum: `veto-${shotId}-v${options.version}`, mimeType: 'video/mp4',
      version: options.version, durationMs: 15_000, width: 1080, height: 1920,
      metadata: options.metadata ?? null,
    },
  })
  await env.db.qualityCheck.create({
    data: { status: options.waived ? 'APPROVED' : 'COMPLETED', kind: 'visual', score: options.waived ? 0.41 : 0.82, report: '{}', artifactId: artifact.id },
  })
  if (options.waived || options.pending) {
    // 问询落定（或停在问）后的形状：快照里留着被裁的那件产物。
    await env.db.generationTask.update({
      where: { id: task.id },
      data: {
        reviewSnapshot: JSON.stringify({
          state: options.pending ? 'pending' : 'waived', retryClass: 'creative', kind: 'visual-audit', policy: 'ask', askReason: 'policy',
          reasons: ['画面与本镜要求无关'], findings: [], score: 0.41, attempt: 1, cap: 2, retriesUsed: 0,
          budgetUsed: 0, candidates: [], artifactId: artifact.id, error: null,
          createdAt: '2026-10-23T12:00:00.000Z',
          ...(options.pending ? {} : { decidedAt: '2026-10-23T12:30:00.000Z' }),
          ...(options.waiveReason ? { waiveReason: options.waiveReason } : {}),
        }),
      },
    })
  }
  return { batchId: batch.id, taskId: task.id, artifactId: artifact.id }
}

async function shotboard(episodeId: string): Promise<ShotboardShot[]> {
  const res = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/shotboard`, headers: env.authHeaders(ownerToken) })
  expect(res.statusCode).toBe(200)
  return (res.json() as { shots: ShotboardShot[] }).shots
}

async function veto(artifactId: string, body: Record<string, unknown>, token = ownerToken) {
  return env.app.inject({ method: 'POST', url: `/api/artifacts/${artifactId}/veto`, headers: env.authHeaders(token), payload: body })
}

beforeAll(async () => {
  env = await startTestEnv()
  queue = createPipelineQueue()
  const owner = await env.register('veto-owner@example.com', 'Veto Owner Org')
  ownerToken = owner.token
  organizationId = owner.organization.id

  const connection = await env.app.inject({
    method: 'POST', url: '/api/providers/connections', headers: env.authHeaders(ownerToken),
    payload: { provider: 'mock', name: `veto-mock-${randomUUID().slice(0, 8)}`, apiKey: 'test-key' },
  })
  expect(connection.statusCode).toBe(201)
  const created = connection.json() as { id: string; capabilities: { id: string; model: string }[] }
  expect((await env.app.inject({ method: 'POST', url: `/api/providers/connections/${created.id}/probe`, headers: env.authHeaders(ownerToken) })).statusCode).toBe(200)
  const binding = await env.app.inject({
    method: 'POST', url: '/api/bindings', headers: env.authHeaders(ownerToken),
    payload: { slot: 'video_t2v', capabilityId: created.capabilities.find(capability => capability.model === 'mock-t2v')!.id },
  })
  expect(binding.statusCode).toBe(201)
}, 300_000)

afterAll(async () => {
  for (const key of Object.keys(ambientEnv) as (keyof typeof ambientEnv)[]) restoreEnv(key)
  if (queue) {
    await queue.obliterate({ force: true }).catch(() => undefined)
    await queue.close()
  }
  await env?.stop()
})

describe('SD-172 human veto on a version', () => {
  it('refuses a veto without a reason: a silent veto is just a vanished version', async () => {
    const { episodeId, shotId } = await episodeWithShot('Reason Required Drama')
    const take = await seedVideoTake(episodeId, shotId, { version: 1 })
    const bare = await veto(take.artifactId, {})
    expect(bare.statusCode).toBe(400)
    expect(bare.json()).toEqual({ error: 'veto:reasonRequired' })
    expect(await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: take.artifactId } }).then(row => row.metadata)).toBeNull()
  })

  it('marks the version unusable with its reason, and keeps whatever else metadata carried', async () => {
    const { episodeId, shotId } = await episodeWithShot('Veto Writes Drama')
    const take = await seedVideoTake(episodeId, shotId, { version: 1, metadata: JSON.stringify({ filename: '栏杆断裂-v1.mp4' }) })
    const res = await veto(take.artifactId, { reason: '时钟从第一帧就是 7:09，「跳到」这个动作没发生' })
    expect(res.statusCode).toBe(200)
    expect(res.json().artifact).toMatchObject({ id: take.artifactId, veto: { reason: '时钟从第一帧就是 7:09，「跳到」这个动作没发生' } })

    const row = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: take.artifactId } })
    const metadata = JSON.parse(row.metadata ?? '{}') as { filename?: string; veto?: { reason?: string } }
    expect(metadata.filename).toBe('栏杆断裂-v1.mp4')
    expect(metadata.veto?.reason).toBe('时钟从第一帧就是 7:09，「跳到」这个动作没发生')

    // 履历看得见：版本行没有被抹掉，它带着否决的理由继续出现在镜头的候选里。
    const shot = await shotRow(episodeId)
    const candidate = shot.videoCandidates.find(entry => entry.artifactId === take.artifactId)
    expect(candidate?.veto?.reason).toBe('时钟从第一帧就是 7:09，「跳到」这个动作没发生')

    const undo = await veto(take.artifactId, { undo: true })
    expect(undo.statusCode).toBe(200)
    expect(undo.json().artifact.veto).toBeNull()
    const afterUndo = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: take.artifactId } })
    expect(JSON.parse(afterUndo.metadata ?? '{}').filename).toBe('栏杆断裂-v1.mp4')
  })

  it('skips the vetoed take when resolving which version this shot uses', async () => {
    const { episodeId, shotId } = await episodeWithShot('Veto Skipped Drama')
    const older = await seedVideoTake(episodeId, shotId, { version: 1, createdAt: new Date('2026-10-22T10:00:00.000Z') })
    const newer = await seedVideoTake(episodeId, shotId, { version: 2, createdAt: new Date('2026-10-23T10:00:00.000Z') })

    // 先证明「自动取最新」本来会拿哪一条：新的那一版。
    expect((await resolveShotTake(env.db, { organizationId, storyboardId: shotId, stage: 'VIDEO' }))?.id).toBe(newer.artifactId)

    expect((await veto(newer.artifactId, { reason: '地点整个错成深夜写字楼' })).statusCode).toBe(200)

    // 同一份解析器（合成与界面读数共用的那一条）现在取上一版可用的。
    expect((await resolveShotTake(env.db, { organizationId, storyboardId: shotId, stage: 'VIDEO' }))?.id).toBe(older.artifactId)
    const shot = await shotRow(episodeId)
    expect(shot.video?.id).toBe(older.artifactId)
    expect(shot.videoCandidates).toHaveLength(2)
  })

  it('clears a pinned vetoed take so the locked selection cannot resurrect it', async () => {
    const { episodeId, shotId } = await episodeWithShot('Veto Unpin Drama')
    const take = await seedVideoTake(episodeId, shotId, { version: 1 })
    await env.db.storyboard.update({ where: { id: shotId }, data: { selectedVideoArtifactId: take.artifactId, lockedVideoSelection: true } })

    expect((await veto(take.artifactId, { reason: '唯一一条 1280×720 横片，串进竖屏母带上下黑边' })).statusCode).toBe(200)

    const shot = await env.db.storyboard.findUniqueOrThrow({ where: { id: shotId } })
    expect(shot.selectedVideoArtifactId).toBeNull()
    // 锁是「就用这条」，人刚说这条不能用；留着锁会让合成按数据矛盾抛错。
    expect(shot.lockedVideoSelection).toBe(false)
    expect(await resolveShotTake(env.db, { organizationId, storyboardId: shotId, stage: 'VIDEO', pinnedArtifactId: take.artifactId })).toBeNull()
  })

  it('answers a foreign artifact with 404, never a 403 that leaks it exists', async () => {
    const { episodeId, shotId } = await episodeWithShot('Veto Leak Drama')
    const take = await seedVideoTake(episodeId, shotId, { version: 1 })
    const outsider = await env.register('veto-outsider@example.com', 'Veto Outsider Org')
    const res = await veto(take.artifactId, { reason: '别人家的镜头' }, outsider.token)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'artifact not found' })
    expect((await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: take.artifactId } })).metadata).toBeNull()
  })
})

describe('SD-179 rerun after a human accepted a rejected take', () => {
  it('opens a fresh batch for the waived shot instead of swallowing the rerun as a duplicate', async () => {
    const { episodeId, shotId } = await episodeWithShot('Waive Rerun Drama')
    const waived = await seedVideoTake(episodeId, shotId, { version: 1, waived: true, waiveReason: '先收下解锁合成，但这条不是我要的' })
    const tasksBefore = await env.db.generationTask.count({ where: { storyboardId: shotId, stage: 'VIDEO' } })

    const res = await env.app.inject({
      method: 'POST', url: `/api/generations/tasks/${waived.taskId}/review`, headers: env.authHeaders(ownerToken),
      payload: { action: 'rerun', reason: '改成竖屏天台，栏杆断裂要在画面里发生' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { created: boolean; batch: BatchDto }
    expect(body.created).toBe(true)
    expect(body.batch.id).not.toBe(waived.batchId)
    expect(body.batch).toMatchObject({ stage: 'VIDEO', plannedCount: 1 })

    // 新的那一击排在途；被收下的那一版与它「为什么被收下」的记录一并留着。
    expect(await env.db.generationTask.count({ where: { storyboardId: shotId, stage: 'VIDEO' } })).toBe(tasksBefore + 1)
    const fresh = await env.db.generationTask.findFirstOrThrow({ where: { storyboardId: shotId, stage: 'VIDEO', id: { not: waived.taskId } } })
    expect(fresh.status).toBe('QUEUED')
    expect(fresh.idempotencyKey).not.toBe(`${episodeId}:VIDEO:${shotId}`)
    const settled = await env.db.generationTask.findUniqueOrThrow({ where: { id: waived.taskId } })
    expect(settled.status).toBe('SUCCEEDED')
    expect(JSON.parse(settled.reviewSnapshot ?? '{}')).toMatchObject({ state: 'waived', waiveReason: '先收下解锁合成，但这条不是我要的' })

    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=generation.rerunAfterWaive', headers: env.authHeaders(ownerToken) })
    const event = (audit.json().events as { entityId: string; payload: Record<string, unknown> }[]).find(entry => entry.entityId === waived.taskId)
    expect(event?.payload).toMatchObject({ batchId: body.batch.id, storyboardId: shotId })
  })

  it('does not let the settled waive block the shot-level rerun verb either', async () => {
    const { episodeId, shotId } = await episodeWithShot('Waive Trigger Drama')
    const waived = await seedVideoTake(episodeId, shotId, { version: 1, waived: true, waiveReason: '收下只为解锁合成' })

    // 「只补缺」仍然如字面意思：这一镜有产物，它不重买，也不会把 settled 的收下当成在途。
    const fill = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: env.authHeaders(ownerToken),
      payload: { stage: 'VIDEO', storyboardIds: [shotId] },
    })
    expect(fill.statusCode).toBe(200)
    expect(fill.json()).toMatchObject({ created: false })

    // 「重跑」是覆盖语义：同一镜、同一条 settled 收下任务，必须开出新批次而不是 409。
    const rerun = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: env.authHeaders(ownerToken),
      payload: { stage: 'VIDEO', storyboardIds: [shotId], regenerate: true },
    })
    expect(rerun.statusCode).toBe(201)
    expect(rerun.json()).toMatchObject({ created: true })
    expect((rerun.json() as { batch: BatchDto }).batch.id).not.toBe(waived.batchId)
  })

  it('still demands the direction for a paid rerun, and only offers it on an accepted take', async () => {
    const { episodeId, shotId } = await episodeWithShot('Rerun Guard Drama')
    const waived = await seedVideoTake(episodeId, shotId, { version: 1, waived: true })

    const noDirection = await env.app.inject({
      method: 'POST', url: `/api/generations/tasks/${waived.taskId}/review`, headers: env.authHeaders(ownerToken),
      payload: { action: 'rerun' },
    })
    expect(noDirection.statusCode).toBe(400)
    expect(noDirection.json()).toEqual({ error: 'rerun:directionRequired' })
    expect(await env.db.generationTask.count({ where: { storyboardId: shotId, stage: 'VIDEO' } })).toBe(1)

    // 还没人决定的那一版没有这一刀：它走 retry/waive 那条问询出口，不是这里。
    const stillPending = await seedVideoTake(episodeId, shotId, { version: 2, pending: true })
    const notWaived = await env.app.inject({
      method: 'POST', url: `/api/generations/tasks/${stillPending.taskId}/review`, headers: env.authHeaders(ownerToken),
      payload: { action: 'rerun', reason: '换个机位' },
    })
    expect(notWaived.statusCode).toBe(409)
    expect(notWaived.json()).toMatchObject({ error: 'rerun is only for a take a human has accepted' })

    // 从没被机器判过的那一版同理：没有裁决履历就没有「收下之后还不满意」这件事。
    const noReview = await seedVideoTake(episodeId, shotId, { version: 3 })
    const neverJudged = await env.app.inject({
      method: 'POST', url: `/api/generations/tasks/${noReview.taskId}/review`, headers: env.authHeaders(ownerToken),
      payload: { action: 'rerun', reason: '换个机位' },
    })
    expect(neverJudged.statusCode).toBe(409)
    expect(neverJudged.json()).toMatchObject({ error: 'task has no review record' })
    expect(await env.db.generationTask.count({ where: { storyboardId: shotId, stage: 'VIDEO' } })).toBe(3)

    const outsider = await env.register('rerun-outsider@example.com', 'Rerun Outsider Org')
    const foreign = await env.app.inject({
      method: 'POST', url: `/api/generations/tasks/${waived.taskId}/review`, headers: env.authHeaders(outsider.token),
      payload: { action: 'rerun', reason: '别人家的镜头' },
    })
    expect(foreign.statusCode).toBe(404)
    expect(foreign.json()).toEqual({ error: 'task not found' })
  })

  it('publishes the accepted take so the version row can render its rerun entry', async () => {
    const { episodeId, shotId } = await episodeWithShot('Waive Read Drama')
    const waived = await seedVideoTake(episodeId, shotId, { version: 1, waived: true, waiveReason: '画质不行但先解锁合成' })
    const shot = await shotRow(episodeId)
    const candidate = shot.videoCandidates.find(entry => entry.artifactId === waived.artifactId)
    expect(candidate).toMatchObject({ waived: true, waiveReason: '画质不行但先解锁合成', taskId: waived.taskId, veto: null })
  })
})
