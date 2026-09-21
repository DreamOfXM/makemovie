import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv

const authHeaders = (token: string) => env.authHeaders(token)

interface ShotboardShot {
  id: string
  number: number
  revision: number
  description: string
  dialogue: string
  speaker: string | null
  sourceExcerpt: string
  continuityIn: string
  continuityOut: string
  status: string
  assets: { id: string; kind: string; name: string; status: string; role: string; hasVersions: boolean; reference: boolean }[]
  firstFrame: { id: string; downloadUrl: string } | null
  video: { id: string } | null
  voice: { id: string } | null
  firstFrameError: string | null
  videoError: string | null
  inflight: string[]
  qc: { kind: string; status: string; score: number | null }[]
  selectedVideoArtifactId: string | null
  videoCandidates: { artifactId: string; taskId: string; version: number; mimeType: string; durationMs: number | null; createdAt: string; selected: boolean; qc: { kind: string; status: string; score: number | null } | null }[]
  usage: { inputUnits: number; outputUnits: number; models: string[]; calls: number } | null
  slot: string
  attention: string[]
}

interface ShotboardCastAsset {
  id: string
  kind: string
  name: string
  status: string
  hasVersions: boolean
  appearances: string[]
  referenceCount: number
  thumbnail: { id: string; downloadUrl: string } | null
}

interface ShotboardResponse {
  episodeId: string
  number: number
  title: string
  status: string
  shots: ShotboardShot[]
  assets: ShotboardCastAsset[]
  assetsPending: { id: string; kind: string; name: string; status: string }[]
}

async function shotboard(token: string, episodeId: string): Promise<{ statusCode: number; body: ShotboardResponse }> {
  const res = await env.app.inject({ method: 'GET', url: `/episodes/${episodeId}/shotboard`, headers: authHeaders(token) })
  return { statusCode: res.statusCode, body: res.json() as ShotboardResponse }
}

let ownerToken: string
let viewerToken: string
let rivalToken: string
let organizationId: string
let episodeId: string
let rivalEpisodeId: string
let shotOneId: string
let shotTwoId: string
let failedVideoTaskId: string

beforeAll(async () => {
  env = await startTestEnv()

  const owner = await env.register('shotboard-owner@example.com', 'Shotboard Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
  const viewer = await env.register('shotboard-viewer@example.com', 'Shotboard Viewer Org')
  const added = await env.app.inject({ method: 'POST', url: '/members', headers: authHeaders(ownerToken), payload: { email: 'shotboard-viewer@example.com', role: 'VIEWER' } })
  expect(added.statusCode).toBe(201)
  const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'shotboard-viewer@example.com', password: 'password123', organizationId } })
  expect(login.statusCode).toBe(200)
  viewerToken = login.json().token as string

  const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(ownerToken), payload: { name: 'Shotboard Drama' } })
  expect(project.statusCode).toBe(201)
  const projectId = project.json().id as string
  const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'EP1' } })
  expect(episode.statusCode).toBe(201)
  episodeId = episode.json().id as string

  const rival = await env.register('shotboard-rival@example.com', 'Shotboard Rival Org')
  rivalToken = rival.token
  const rivalProject = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(rival.token), payload: { name: 'Rival' } })
  const rivalEpisode = await env.app.inject({ method: 'POST', url: `/projects/${rivalProject.json().id}/episodes`, headers: authHeaders(rival.token), payload: { number: 1, title: 'Rival EP1' } })
  rivalEpisodeId = rivalEpisode.json().id as string

  const first = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken), payload: { number: 1, title: '巷口相遇', durationMs: 3000, description: '小雨在巷口撑伞' } })
  expect(first.statusCode).toBe(201)
  shotOneId = first.json().id as string
  const second = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken), payload: { number: 2, title: '雨夜分别', durationMs: 5000, description: '两人在巷口道别', dialogue: '我会想你的。', speaker: '小雨' } })
  expect(second.statusCode).toBe(201)
  shotTwoId = second.json().id as string
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

describe('GET /episodes/:episodeId/shotboard', () => {
  it('lists live shots with their media, errors, in-flight stages and usage', async () => {
    const batch = await env.db.generationBatch.create({
      data: { organizationId, episodeId, stage: 'VIDEO', plannedCount: 2 },
    })
    // A succeeded first frame with one artifact: the card shows it as the thumbnail.
    const frameTask = await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage: 'FIRST_FRAME', status: 'SUCCEEDED', storyboardId: shotOneId, provider: 'mock', model: 'mock-image', attempts: 1 },
    })
    const artifact = await env.db.mediaArtifact.create({
      data: { organizationId, taskId: frameTask.id, stage: 'FIRST_FRAME', objectKey: `shotboard/${frameTask.id}.png`, checksum: 'abc', mimeType: 'image/png', version: 1 },
    })
    // A failed video, three attempts deep: the error belongs to the shot, not the batch.
    const videoTask = await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage: 'VIDEO', status: 'FAILED', storyboardId: shotOneId, provider: 'mock', model: 'mock-t2v', attempts: 3, errorSnapshot: 'VIDEO: threshold not met after 3 attempts' },
    })
    failedVideoTaskId = videoTask.id
    // An audio attempt still in flight for the second shot.
    await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage: 'AUDIO', status: 'RUNNING', storyboardId: shotTwoId },
    })
    await env.db.usageLedger.create({
      data: { organizationId, taskId: frameTask.id, provider: 'mock', model: 'mock-image', modality: 't2i', inputUnits: 42, outputUnits: 4096 },
    })
    await env.db.qualityCheck.create({
      data: { status: 'APPROVED', kind: 'image', score: 0.88, report: '{}', storyboardId: shotOneId, artifactId: artifact.id },
    })

    const { statusCode, body } = await shotboard(ownerToken, episodeId)
    expect(statusCode).toBe(200)
    expect(body.episodeId).toBe(episodeId)
    expect(body.shots.map(shot => shot.number)).toEqual([1, 2])

    const shot1 = body.shots[0]
    expect(shot1.firstFrame).toMatchObject({ id: artifact.id, downloadUrl: `/artifacts/${artifact.id}/content` })
    expect(shot1.video).toBeNull()
    expect(shot1.videoError).toContain('threshold not met')
    expect(shot1.attention).toContain('video_failed')
    // 占位裁决:片段全挂但分镜图在——预映里这一镜顶的是静态画面。
    expect(shot1.slot).toBe('frame')
    expect(shot1.inflight).toEqual([])
    expect(shot1.usage).toEqual({ inputUnits: 42, outputUnits: 4096, models: ['mock/mock-image'], calls: 1 })
    expect(shot1.qc).toEqual([{ kind: 'image', status: 'APPROVED', score: 0.88 }])

    const shot2 = body.shots[1]
    // 镜头卡内联字段:台词/原文/衔接随聚合一起给,弹窗不再二级跳转。
    expect(shot2).toMatchObject({ dialogue: '我会想你的。', speaker: '小雨', sourceExcerpt: '', continuityIn: '', continuityOut: '' })
    expect(shot2.inflight).toEqual(['AUDIO'])
    // 配音在产但还没有任何能上画面的片段或分镜图。
    expect(shot2.slot).toBe('running')
    expect(shot2.usage).toBeNull()
    expect(shot2.attention).toEqual([])
  })

  it('flags unapproved assets with versions on the shot and in the episode lane, and only while gate-relevant', async () => {
    const assetRes = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/assets`, headers: authHeaders(ownerToken), payload: { kind: 'character', name: '小雨', description: '雨夜中撑伞的少女' } })
    expect(assetRes.statusCode).toBe(201)
    const assetId = assetRes.json().asset.id as string
    // 参考图预览要跟 triggerStage 同源:只有"已审批 + 带定妆实体 + 画面文本提到名字"才点亮。
    const costume = await env.db.mediaArtifact.create({
      data: { organizationId, stage: 'ASSET', objectKey: `shotboard/casting-${assetId}.png`, checksum: 'cst', mimeType: 'image/png', version: 1 },
    })
    await env.db.assetVersion.create({ data: { assetId, version: 1, description: '版本一', status: 'DRAFT', artifactId: costume.id } })
    const put = await env.app.inject({
      method: 'PUT', url: `/storyboards/${shotOneId}/assets`, headers: authHeaders(ownerToken),
      payload: { assets: [{ assetId, role: 'lead' }] },
    })
    expect(put.statusCode).toBe(200)

    const before = await shotboard(ownerToken, episodeId)
    const shot1 = before.body.shots.find(shot => shot.id === shotOneId)!
    expect(shot1.assets).toEqual([{ id: assetId, kind: 'character', name: '小雨', status: 'DRAFT', role: 'lead', hasVersions: true, reference: false }])
    expect(shot1.attention).toContain('asset_gate')
    expect(before.body.assetsPending.map(asset => asset.id)).toContain(assetId)

    // Approving the asset clears both the shot flag and the episode-level lane entry.
    await env.db.$transaction([
      env.db.assetVersion.updateMany({ where: { assetId }, data: { status: 'APPROVED' } }),
      env.db.asset.update({ where: { id: assetId }, data: { status: 'APPROVED' } }),
    ])
    const after = await shotboard(ownerToken, episodeId)
    const cleared = after.body.shots.find(shot => shot.id === shotOneId)!
    expect(cleared.attention).not.toContain('asset_gate')
    expect(after.body.assetsPending.map(asset => asset.id)).not.toContain(assetId)
    // 审批后版本带了定妆图，且"小雨"出现在画面文本里——参考图指示灯必须亮。
    expect(cleared.assets).toEqual([{ id: assetId, kind: 'character', name: '小雨', status: 'APPROVED', role: 'lead', hasVersions: true, reference: true }])
  })

  it('keeps the newest verdict per kind and stays silent on superseded shots', async () => {
    const oldQc = await env.db.qualityCheck.create({
      data: { status: 'NEEDS_REVIEW', kind: 'video', score: 0.3, report: '{}', storyboardId: shotTwoId },
    })
    const shot = await env.db.storyboard.findFirstOrThrow({ where: { id: shotTwoId } })
    await env.db.storyboard.create({
      data: { episodeId, revision: 2, number: shot.number, title: '雨夜分别(重排)', durationMs: 5000, description: '新的第二镜', sourceExcerpt: '', continuityIn: '', continuityOut: '', status: 'BLOCKED' },
    })
    await env.db.storyboard.update({ where: { id: shotTwoId }, data: { supersededAt: new Date() } })

    const { body } = await shotboard(ownerToken, episodeId)
    // The live breakdown is shot 1 plus the revision-2 replacement of shot 2.
    expect(body.shots.map(s => [s.number, s.revision])).toEqual([[1, 1], [2, 2]])
    // The old QC and media stay attached to the superseded shot and do not leak up.
    const replacement = body.shots.find(s => s.revision === 2)!
    expect(replacement.status).toBe('BLOCKED')
    expect(replacement.attention).toContain('shot_blocked')
    expect(replacement.qc).toEqual([])
    expect(oldQc.status).toBe('NEEDS_REVIEW')
  })

  it('aggregates the cast block: costume thumbnails, appearance lists and unbound assets', async () => {
    const costume = await env.db.mediaArtifact.findFirstOrThrow({ where: { organizationId, stage: 'ASSET' } })
    const strayRes = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/assets`, headers: authHeaders(ownerToken), payload: { kind: 'prop', name: '旧怀表', description: '一只停走的怀表' } })
    expect(strayRes.statusCode).toBe(201)
    const strayId = strayRes.json().asset.id as string

    const { body } = await shotboard(ownerToken, episodeId)
    // 班底轨道的事实源:主演带定妆图缩略图、出演镜头列表、参考图命中计数。
    const lead = body.assets.find(asset => asset.name === '小雨')!
    expect(lead).toMatchObject({ kind: 'character', status: 'APPROVED', hasVersions: true, referenceCount: 1 })
    expect(lead.appearances).toEqual([shotOneId])
    expect(lead.thumbnail).toMatchObject({ id: costume.id, downloadUrl: `/artifacts/${costume.id}/content` })
    // 没挂任何镜头、也没有版本的素材必须在场——轨道要能给它「去生成定妆照」入口。
    const stray = body.assets.find(asset => asset.id === strayId)!
    expect(stray).toMatchObject({ status: 'DRAFT', hasVersions: false, referenceCount: 0 })
    expect(stray.appearances).toEqual([])
    expect(stray.thumbnail).toBeNull()
    // 占位状态随镜头走:重排后的第二镜什么都没有。
    expect(body.shots.find(shot => shot.id === shotOneId)!.slot).toBe('frame')
    expect(body.shots.find(shot => shot.revision === 2)!.slot).toBe('empty')
  })

  it('serves viewers, hides nothing from readers, and 404s foreign or unknown episodes', async () => {
    const viewer = await shotboard(viewerToken, episodeId)
    expect(viewer.statusCode).toBe(200)
    expect(viewer.body.shots.length).toBeGreaterThan(0)

    expect((await shotboard(ownerToken, 'does-not-exist')).statusCode).toBe(404)
    expect((await shotboard(ownerToken, rivalEpisodeId)).statusCode).toBe(404)
    const anonymous = await env.app.inject({ method: 'GET', url: `/episodes/${episodeId}/shotboard` })
    expect(anonymous.statusCode).toBe(401)
  })

  it('carries no money-shaped field: units in, units out, and that is the boundary', async () => {
    const { body } = await shotboard(ownerToken, episodeId)
    const payload = JSON.stringify(body)
    expect(payload).toMatch(/inputUnits/)
    expect(payload).not.toMatch(/pric|cost|amount|currenc|invoice|quota|refund|balance|[$¥€£₹₩]/i)
    void failedVideoTaskId
  })
})

describe('shotboard video candidates and the selection endpoint', () => {
  let clipOldId: string
  let clipNewId: string

  const select = (storyboardId: string, token: string, payload: { artifactId?: string | null }) =>
    env.app.inject({ method: 'POST', url: `/storyboards/${storyboardId}/video-selection`, headers: authHeaders(token), payload })

  it('lists every succeeded clip newest first and flags the shot while nobody has picked', async () => {
    const batch = await env.db.generationBatch.create({ data: { organizationId, episodeId, stage: 'VIDEO', plannedCount: 1 } })
    const task = await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage: 'VIDEO', status: 'SUCCEEDED', storyboardId: shotOneId, provider: 'mock', model: 'mock-t2v', attempts: 1 },
    })
    clipOldId = (await env.db.mediaArtifact.create({
      data: { organizationId, taskId: task.id, stage: 'VIDEO', objectKey: `sel/${task.id}-v1.mp4`, checksum: 'sel-v1', mimeType: 'video/mp4', version: 1, durationMs: 3000 },
    })).id
    clipNewId = (await env.db.mediaArtifact.create({
      data: { organizationId, taskId: task.id, stage: 'VIDEO', objectKey: `sel/${task.id}-v2.mp4`, checksum: 'sel-v2', mimeType: 'video/mp4', version: 2, durationMs: 3000 },
    })).id
    await env.db.qualityCheck.create({ data: { status: 'COMPLETED', kind: 'visual-audit', score: 0.91, report: '{}', artifactId: clipOldId, batchId: null } })

    const { body } = await shotboard(ownerToken, episodeId)
    const shot1 = body.shots.find(shot => shot.id === shotOneId)!
    expect(shot1.videoCandidates.map(candidate => candidate.artifactId)).toEqual([clipNewId, clipOldId])
    expect(shot1.videoCandidates[0]).toMatchObject({ version: 2, selected: false, qc: null })
    expect(shot1.videoCandidates[1]).toMatchObject({ version: 1, selected: false, qc: { kind: 'visual-audit', status: 'COMPLETED', score: 0.91 } })
    expect(shot1.selectedVideoArtifactId).toBeNull()
    expect(shot1.attention).toContain('selection_open')
    // 无人钦定时缩略图回到"最新成功"的旧语义。
    expect(shot1.video?.id).toBe(clipNewId)
  })

  it('follows the human pick: the chosen clip wins the card and clears the flag', async () => {
    const pick = await select(shotOneId, ownerToken, { artifactId: clipOldId })
    expect(pick.statusCode).toBe(200)
    expect(pick.json()).toMatchObject({ id: shotOneId, selectedVideoArtifactId: clipOldId })

    const { body } = await shotboard(ownerToken, episodeId)
    const shot1 = body.shots.find(shot => shot.id === shotOneId)!
    expect(shot1.selectedVideoArtifactId).toBe(clipOldId)
    expect(shot1.videoCandidates.find(candidate => candidate.artifactId === clipOldId)!.selected).toBe(true)
    expect(shot1.videoCandidates.find(candidate => candidate.artifactId === clipNewId)!.selected).toBe(false)
    expect(shot1.attention).not.toContain('selection_open')
    // 缩略图跟着钦定版本走:卡片必须展示将入成片的那一版,而不是最新的那版。
    expect(shot1.video?.id).toBe(clipOldId)

    const clear = await select(shotOneId, ownerToken, { artifactId: null })
    expect(clear.statusCode).toBe(200)
    expect(clear.json().selectedVideoArtifactId).toBeNull()
    const relisted = await shotboard(ownerToken, episodeId)
    expect(relisted.body.shots.find(shot => shot.id === shotOneId)!.attention).toContain('selection_open')
  })

  it('refuses picks that are not this live shot, this clip, or this role', async () => {
    expect((await select('does-not-exist', ownerToken, { artifactId: clipOldId })).statusCode).toBe(404)
    // 他组织按 404 回答,与全仓其他路由同一口径。
    expect((await select(shotOneId, rivalToken, { artifactId: clipOldId })).statusCode).toBe(404)
    expect((await select(shotOneId, viewerToken, { artifactId: clipOldId })).statusCode).toBe(403)
    expect((await select(shotOneId, ownerToken, {})).statusCode).toBe(400)

    const frameArtifact = await env.db.mediaArtifact.findFirstOrThrow({ where: { organizationId, stage: 'FIRST_FRAME' } })
    const wrongStage = await select(shotOneId, ownerToken, { artifactId: frameArtifact.id })
    expect(wrongStage.statusCode).toBe(400)
    expect(wrongStage.json().error).toBe('artifact is not a succeeded video of this shot')

    // 被重排取代的镜头没有"成片版本"可选:选它是往废稿里钉东西。
    expect((await select(shotTwoId, ownerToken, { artifactId: clipOldId })).statusCode).toBe(409)

    // 每次钦定都留在审计里,包括取消钦定。
    expect((await select(shotOneId, ownerToken, { artifactId: clipNewId })).statusCode).toBe(200)
    const audit = await env.app.inject({ method: 'GET', url: '/audit-events?action=storyboard.select-video', headers: authHeaders(ownerToken) })
    const events = audit.json().events as { entityId: string; payload: { artifactId: string | null } }[]
    expect(events.some(event => event.entityId === shotOneId && event.payload.artifactId === clipNewId)).toBe(true)
  })
})
