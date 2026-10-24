import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

/**
 * UX-P04：延长/定向编辑的操作产物必须真正进入 shotboard 候选。
 * 旧候选查询 inner join task，把 taskId=null 的操作输出整条排除——操作成功落库
 * 后页面版本列表仍只有原视频一条。这里验证并入后的读模型：来源标注、与任务产物
 * 去重、QC 行 join、操作状态列表，以及统一归属解析器对伪造操作行的拒绝
 * （跨组织/跨镜/失败/无归属的行绝不进候选）。
 */
let env: TestEnv

const authHeaders = (token: string) => env.authHeaders(token)

interface CandidateRow {
  artifactId: string
  taskId: string | null
  origin: string
  version: number
  createdAt: string
  selected: boolean
  qc: { kind: string; status: string; score: number | null } | null
}

interface ShotRow {
  id: string
  video: { id: string } | null
  videoCandidates: CandidateRow[]
  operations: { id: string; kind: string; status: string; error: string | null }[]
  attention: string[]
}

let ownerToken: string
let organizationId: string
let episodeId: string
let shotOneId: string
let shotTwoId: string
let sourceArtifactId: string
let rivalOrganizationId: string
let rivalStoryboardId: string

/** 建一条延长/编辑操作行 + 输出制品（模拟 worker 成功落库后的形状：输出无任务行，
 *  归属只存在于操作行快照）。 */
async function seedOperationOutput(options: {
  kind: 'video_extend' | 'video_edit'
  storyboardId: string | null
  organizationId?: string
  status?: string
  createdAt?: Date
  artifactId?: string
}): Promise<{ operationId: string; artifactId: string }> {
  const org = options.organizationId ?? organizationId
  const artifactId = options.artifactId ?? (await env.db.mediaArtifact.create({
    data: {
      organizationId: org, taskId: null, stage: 'VIDEO',
      objectKey: `op/${org}/${Math.random().toString(36).slice(2)}.mp4`,
      checksum: `op-${Math.random().toString(36).slice(2)}`, mimeType: 'video/mp4', version: 1, durationMs: 8000,
    },
  })).id
  const operation = await env.db.artifactOperation.create({
    data: {
      organizationId: org, kind: options.kind, sourceArtifactId, outputArtifactId: artifactId,
      connectionId: 'none', capabilityId: 'none', provider: 'mock', model: 'mock-t2v',
      status: options.status ?? 'SUCCEEDED',
      requestSnapshot: JSON.stringify({
        input: { prompt: 'x' }, parameters: {}, sourceArtifactId,
        ...(options.storyboardId ? { storyboardId: options.storyboardId } : {}),
      }),
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  })
  return { operationId: operation.id, artifactId }
}

async function shotboard(token: string): Promise<{ statusCode: number; body: { shots: ShotRow[] } }> {
  const res = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/shotboard`, headers: authHeaders(token) })
  return { statusCode: res.statusCode, body: res.json() as { shots: ShotRow[] } }
}

beforeAll(async () => {
  env = await startTestEnv()

  const owner = await env.register('ops-candidates-owner@example.com', 'Ops Candidates Org')
  ownerToken = owner.token
  organizationId = owner.organization.id

  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'Ops Drama' } })
  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${project.json().id}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'EP1' } })
  episodeId = episode.json().id as string
  const first = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken), payload: { number: 1, title: '巷口', durationMs: 3000, description: '雨夜巷口' } })
  shotOneId = first.json().id as string
  const second = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken), payload: { number: 2, title: '道别', durationMs: 5000, description: '两人道别' } })
  shotTwoId = second.json().id as string

  // 源片：挂在成功任务下的一版视频（延长的起点，也是「生成」来源的候选）。
  const batch = await env.db.generationBatch.create({ data: { organizationId, episodeId, stage: 'VIDEO', plannedCount: 1 } })
  const task = await env.db.generationTask.create({
    data: { organizationId, batchId: batch.id, stage: 'VIDEO', status: 'SUCCEEDED', storyboardId: shotOneId, provider: 'mock', model: 'mock-t2v', attempts: 1, createdAt: new Date('2026-10-01T08:00:00Z') },
  })
  sourceArtifactId = (await env.db.mediaArtifact.create({
    data: { organizationId, taskId: task.id, stage: 'VIDEO', objectKey: `ops/${task.id}/v1.mp4`, checksum: 'gen-1', mimeType: 'video/mp4', version: 1, durationMs: 3000 },
  })).id

  // 对手组织与它的一镜：伪造归属的靶子。
  const rival = await env.register('ops-candidates-rival@example.com', 'Ops Rival Org')
  rivalOrganizationId = rival.organization.id
  const rivalProject = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(rival.token), payload: { name: 'Rival' } })
  const rivalEpisode = await env.app.inject({ method: 'POST', url: `/api/projects/${rivalProject.json().id}/episodes`, headers: authHeaders(rival.token), payload: { number: 1, title: 'R1' } })
  const rivalShot = await env.app.inject({ method: 'POST', url: `/api/episodes/${rivalEpisode.json().id}/storyboards`, headers: authHeaders(rival.token), payload: { number: 1, title: 'R', durationMs: 3000, description: 'r' } })
  rivalStoryboardId = rivalShot.json().id as string
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

describe('shotboard candidates include artifact operation outputs', () => {
  it('merges succeeded extend/edit outputs with the right origin, newest first, and joins QC rows', async () => {
    const { artifactId: extendId } = await seedOperationOutput({ kind: 'video_extend', storyboardId: shotOneId, createdAt: new Date('2026-10-02T08:00:00Z') })
    const { artifactId: editId } = await seedOperationOutput({ kind: 'video_edit', storyboardId: shotOneId, createdAt: new Date('2026-10-03T08:00:00Z') })
    await env.db.qualityCheck.create({ data: { status: 'COMPLETED', kind: 'visual-audit', score: 0.82, report: '{}', artifactId: extendId } })

    const { statusCode, body } = await shotboard(ownerToken)
    expect(statusCode).toBe(200)
    const shot1 = body.shots.find(shot => shot.id === shotOneId)!
    expect(shot1.videoCandidates.map(candidate => candidate.artifactId)).toEqual([editId, extendId, sourceArtifactId])
    // 来源如实标注：操作产物没有任务行；生成产物保留任务 id。这是版本行「怎么来的」的数据面。
    expect(shot1.videoCandidates.find(candidate => candidate.artifactId === editId)).toMatchObject({ taskId: null, origin: 'directed_edit', durationMs: 8000 })
    expect(shot1.videoCandidates.find(candidate => candidate.artifactId === extendId)).toMatchObject({ taskId: null, origin: 'extend', qc: { kind: 'visual-audit', score: 0.82 } })
    expect(shot1.videoCandidates.find(candidate => candidate.artifactId === sourceArtifactId)).toMatchObject({ origin: 'generation' })
    // 第二镜不受第一镜操作影响。
    expect(body.shots.find(shot => shot.id === shotTwoId)!.videoCandidates).toEqual([])
  })

  it('attributes by the operation snapshot: an operation claimed for shot two never lands on shot one', async () => {
    const { artifactId: wrongShotId } = await seedOperationOutput({ kind: 'video_extend', storyboardId: shotTwoId, createdAt: new Date('2026-10-04T08:00:00Z') })
    const { body } = await shotboard(ownerToken)
    const shot1 = body.shots.find(shot => shot.id === shotOneId)!
    const shot2 = body.shots.find(shot => shot.id === shotTwoId)!
    expect(shot1.videoCandidates.some(candidate => candidate.artifactId === wrongShotId)).toBe(false)
    expect(shot2.videoCandidates.map(candidate => candidate.artifactId)).toEqual([wrongShotId])
  })

  it('rejects forged operation rows the unified resolver refuses', async () => {
    // 1) 快照指向对手组织的镜头：它不在本集活镜集合里，也过不了统一解析器的组织核对。
    await seedOperationOutput({ kind: 'video_extend', storyboardId: rivalStoryboardId })
    // 2) 对手组织自己行里的操作与输出制品：本组织的查询根本看不见，也不许看见。
    await seedOperationOutput({ kind: 'video_extend', storyboardId: shotOneId, organizationId: rivalOrganizationId })
    // 3) 失败操作即使填了输出指针也不是候选（终态校验）。
    await seedOperationOutput({ kind: 'video_extend', storyboardId: shotOneId, status: 'FAILED' })
    // 4) 快照没有 storyboardId 的行给不出归属，跳过。
    await seedOperationOutput({ kind: 'video_extend', storyboardId: null })
    // 5) 伪造行把任务产物登记成操作输出：解析器会按任务链把它解析回任务归属，
    //    与任务产物同 id——必须去重，绝不能一票计两次。
    await seedOperationOutput({ kind: 'video_extend', storyboardId: shotOneId, artifactId: sourceArtifactId })
    // 6) 快照声称是第二镜、解析器按任务链解析回第一镜：归属以解析器为准，哪镜都不落。
    await seedOperationOutput({ kind: 'video_extend', storyboardId: shotTwoId, artifactId: sourceArtifactId })

    const { body } = await shotboard(ownerToken)
    const shot1 = body.shots.find(shot => shot.id === shotOneId)!
    const shot2 = body.shots.find(shot => shot.id === shotTwoId)!
    // 源片仍只出现一次（任务产物那一票），伪造行没有造出第二票。
    expect(shot1.videoCandidates.filter(candidate => candidate.artifactId === sourceArtifactId)).toHaveLength(1)
    expect(shot1.videoCandidates.find(candidate => candidate.artifactId === sourceArtifactId)!.origin).toBe('generation')
    expect(shot2.videoCandidates.filter(candidate => candidate.artifactId === sourceArtifactId)).toHaveLength(0)
  })

  it('pins an operation output like any candidate: the card follows the human pick', async () => {
    const { artifactId: extendId } = await seedOperationOutput({ kind: 'video_extend', storyboardId: shotOneId, createdAt: new Date('2026-10-05T08:00:00Z') })
    const pin = await env.app.inject({
      method: 'POST', url: `/api/storyboards/${shotOneId}/video-selection`,
      headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: { artifactId: extendId },
    })
    expect(pin.statusCode).toBe(200)
    const { body } = await shotboard(ownerToken)
    const shot1 = body.shots.find(shot => shot.id === shotOneId)!
    expect(shot1.video).toMatchObject({ id: extendId })
    expect(shot1.videoCandidates.find(candidate => candidate.artifactId === extendId)!.selected).toBe(true)
    expect(shot1.attention).not.toContain('selection_open')
  })

  it('exposes live operation status per shot for the workbench polling loop', async () => {
    // 清掉前一段留下的终态操作噪音：operations 列表只收未落定与失败行。
    const { operationId: queued } = await seedOperationOutput({ kind: 'video_extend', storyboardId: shotOneId, status: 'QUEUED' })
    let { body } = await shotboard(ownerToken)
    let shot1 = body.shots.find(shot => shot.id === shotOneId)!
    expect(shot1.operations.map(operation => operation.id)).toContain(queued)
    expect(shot1.operations.find(operation => operation.id === queued)).toMatchObject({ kind: 'video_extend', status: 'QUEUED' })

    await env.db.artifactOperation.update({ where: { id: queued }, data: { status: 'FAILED', errorSnapshot: 'provider boom' } })
    ;({ body } = await shotboard(ownerToken))
    shot1 = body.shots.find(shot => shot.id === shotOneId)!
    expect(shot1.operations.find(operation => operation.id === queued)).toMatchObject({ status: 'FAILED', error: 'provider boom' })

    await env.db.artifactOperation.update({ where: { id: queued }, data: { status: 'SUCCEEDED', errorSnapshot: null } })
    ;({ body } = await shotboard(ownerToken))
    shot1 = body.shots.find(shot => shot.id === shotOneId)!
    // SUCCEEDED 不再占状态行——它的结果已经作为候选出现在版本列表里。
    expect(shot1.operations.some(operation => operation.id === queued)).toBe(false)
  })
})
