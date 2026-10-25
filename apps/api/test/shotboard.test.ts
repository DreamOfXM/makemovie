import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv

const authHeaders = (token: string) => env.authHeaders(token)

interface QcReadingsWire {
  frameScores?: { position: number; score: number }[]
  structureDrift?: { measured: boolean; earlyLateDistance: number | null; firstMidDistance: number | null; maxStepDistance: number | null; sampleSeconds: number[] } | null
  auditRepetition?: { matchedArtifactId: string | null; pictureDistance: number | null; status: string } | null
}

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
  transition: string
  transitionMs: number
  status: string
  assets: { id: string; kind: string; name: string; status: string; role: string; hasVersions: boolean; reference: boolean }[]
  firstFrame: { id: string; downloadUrl: string } | null
  video: { id: string } | null
  voice: { id: string } | null
  firstFrameError: string | null
  videoError: string | null
  inflight: string[]
  qc: (QcReadingsWire & { kind: string; status: string; score: number | null })[]
  selectedVideoArtifactId: string | null
  videoCandidates: { artifactId: string; taskId: string; version: number; mimeType: string; durationMs: number | null; createdAt: string; selected: boolean; awaitingDecision?: boolean; qc: (QcReadingsWire & { kind: string; status: string; score: number | null; reasons?: string[] }) | null }[]
  usage: { inputUnits: number; outputUnits: number; models: string[]; calls: number } | null
  slot: string
  attention: string[]
  /** 分镜文本逐镜软检（storyboard-gaps.ts）：只提示不拦路，开烧前把付费产物跑偏的
   *  已知原因摆出来。空数组 = 这一镜的文字没被挑出问题。 */
  storyboardGaps: string[]
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
  const res = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/shotboard`, headers: authHeaders(token) })
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
  const added = await env.app.inject({ method: 'POST', url: '/api/members', headers: authHeaders(ownerToken), payload: { email: 'shotboard-viewer@example.com', role: 'VIEWER' } })
  expect(added.statusCode).toBe(201)
  const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'shotboard-viewer@example.com', password: 'password123', organizationId } })
  expect(login.statusCode).toBe(200)
  viewerToken = login.json().token as string

  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'Shotboard Drama' } })
  expect(project.statusCode).toBe(201)
  const projectId = project.json().id as string
  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'EP1' } })
  expect(episode.statusCode).toBe(201)
  episodeId = episode.json().id as string

  const rival = await env.register('shotboard-rival@example.com', 'Shotboard Rival Org')
  rivalToken = rival.token
  const rivalProject = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(rival.token), payload: { name: 'Rival' } })
  const rivalEpisode = await env.app.inject({ method: 'POST', url: `/api/projects/${rivalProject.json().id}/episodes`, headers: authHeaders(rival.token), payload: { number: 1, title: 'Rival EP1' } })
  rivalEpisodeId = rivalEpisode.json().id as string

  const first = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken), payload: { number: 1, title: '巷口相遇', durationMs: 3000, description: '小雨在巷口撑伞' } })
  expect(first.statusCode).toBe(201)
  shotOneId = first.json().id as string
  const second = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken), payload: { number: 2, title: '雨夜分别', durationMs: 5000, description: '两人在巷口道别', dialogue: '我会想你的。', speaker: '小雨' } })
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
    expect(shot2).toMatchObject({ dialogue: '我会想你的。', speaker: '小雨', sourceExcerpt: '', continuityIn: '', continuityOut: '', transition: 'cut', transitionMs: 0 })
    expect(shot2.inflight).toEqual(['AUDIO'])
    // 配音在产但还没有任何能上画面的片段或分镜图。
    expect(shot2.slot).toBe('running')
    expect(shot2.usage).toBeNull()
    expect(shot2.attention).toEqual([])
  })

  it('SD-123：零绑定的实拍镜在开烧前就被点名，绑上素材后这条消失', async () => {
    // #23/#25 两次付费重抽买回的都是模型自己编的道具：素材叫「床头钟」，那一镜只绑了
    // 「卧室」，界面在开烧前看不出任何异常。这条判据只陈述「一个素材都没绑」这一事实，
    // 不替人判断该绑谁；绑上任何一条素材（哪怕绑错了）都会让它消失，所以判据必须与
    // 绑定接口共用同一份数据。
    const source = await env.db.episode.findUnique({ where: { id: episodeId }, select: { projectId: true } })
    const solo = await env.app.inject({ method: 'POST', url: `/api/projects/${source!.projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 2, title: 'SD-123' } })
    expect(solo.statusCode).toBe(201)
    const soloId = solo.json().id as string
    const created = await env.app.inject({
      method: 'POST', url: `/api/episodes/${soloId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: 1, title: '钟体入水', durationMs: 4000, description: '（特写·侧面·跟随）钟体脱离手掌飞向水面' },
    })
    expect(created.statusCode).toBe(201)
    const shotId = created.json().id as string
    const prop = await env.db.asset.create({ data: { episodeId: soloId, kind: 'prop', name: '床头钟', description: '木质床头钟', status: 'APPROVED' } })

    const before = await shotboard(ownerToken, soloId)
    expect(before.body.shots.find(shot => shot.id === shotId)!.storyboardGaps).toContain('no_asset_binding')

    const bound = await env.app.inject({
      method: 'PUT', url: `/api/storyboards/${shotId}/assets`, headers: authHeaders(ownerToken),
      payload: { assets: [{ assetId: prop.id }] },
    })
    expect(bound.statusCode).toBe(200)

    const after = await shotboard(ownerToken, soloId)
    expect(after.body.shots.find(shot => shot.id === shotId)!.storyboardGaps).not.toContain('no_asset_binding')
  })

  it('reads back the transition the workbench writes, and clamps the length it asks for', async () => {
    // 转场列是母带时间线的唯一输入：界面写进去的值必须原样读回来，否则「叠化」在
    // 格子里亮着、合成吃的却是别的数，22 刀回填就没人能逐镜核对。
    const write = await env.app.inject({
      method: 'PATCH', url: `/api/storyboards/${shotTwoId}`, headers: authHeaders(ownerToken),
      payload: { transition: '叠化', transitionMs: 600 },
    })
    expect(write.statusCode).toBe(200)
    const after = await shotboard(ownerToken, episodeId)
    expect(after.body.shots.find(shot => shot.id === shotTwoId)).toMatchObject({ transition: 'dissolve', transitionMs: 600 })

    // 只改时长时沿用现有转场；越界的数夹进 50–1000ms，因为重叠超过整镜就把画面吃穿了。
    const clamp = await env.app.inject({
      method: 'PATCH', url: `/api/storyboards/${shotTwoId}`, headers: authHeaders(ownerToken),
      payload: { transitionMs: 5000 },
    })
    expect(clamp.statusCode).toBe(200)
    const clamped = await shotboard(ownerToken, episodeId)
    expect(clamped.body.shots.find(shot => shot.id === shotTwoId)).toMatchObject({ transition: 'dissolve', transitionMs: 1000 })

    // 词表外的写法不许静默变成硬切：那是把用户的意图改成另一种形状。
    const bogus = await env.app.inject({
      method: 'PATCH', url: `/api/storyboards/${shotTwoId}`, headers: authHeaders(ownerToken),
      payload: { transition: 'wipe' },
    })
    expect(bogus.statusCode).toBe(400)
    expect(bogus.json().error).toContain('cut, dissolve')
  })

  it('flags unapproved assets with versions on the shot and in the episode lane, and only while gate-relevant', async () => {
    const assetRes = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/assets`, headers: authHeaders(ownerToken), payload: { kind: 'character', name: '小雨', description: '雨夜中撑伞的少女' } })
    expect(assetRes.statusCode).toBe(201)
    const assetId = assetRes.json().asset.id as string
    // 参考图预览要跟 triggerStage 同源:只有"已审批 + 带定妆实体 + 画面文本提到名字"才点亮。
    const costume = await env.db.mediaArtifact.create({
      data: { organizationId, stage: 'ASSET', objectKey: `shotboard/casting-${assetId}.png`, checksum: 'cst', mimeType: 'image/png', version: 1 },
    })
    await env.db.assetVersion.create({ data: { assetId, version: 1, description: '版本一', status: 'DRAFT', artifactId: costume.id } })
    const put = await env.app.inject({
      method: 'PUT', url: `/api/storyboards/${shotOneId}/assets`, headers: authHeaders(ownerToken),
      payload: { assets: [{ assetId }] },
    })
    expect(put.statusCode).toBe(200)

    const before = await shotboard(ownerToken, episodeId)
    const shot1 = before.body.shots.find(shot => shot.id === shotOneId)!
    expect(shot1.assets).toEqual([{ id: assetId, kind: 'character', name: '小雨', status: 'DRAFT', role: 'character', hasVersions: true, reference: false }])
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
    expect(cleared.assets).toEqual([{ id: assetId, kind: 'character', name: '小雨', status: 'APPROVED', role: 'character', hasVersions: true, reference: true }])
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
    const strayRes = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/assets`, headers: authHeaders(ownerToken), payload: { kind: 'prop', name: '旧怀表', description: '一只停走的怀表' } })
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
    const anonymous = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/shotboard` })
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
    env.app.inject({ method: 'POST', url: `/api/storyboards/${storyboardId}/video-selection`, headers: authHeaders(token), payload })

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
    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=storyboard.select-video', headers: authHeaders(ownerToken) })
    const events = audit.json().events as { entityId: string; payload: { artifactId: string | null } }[]
    expect(events.some(event => event.entityId === shotOneId && event.payload.artifactId === clipNewId)).toBe(true)
  })
})

/**
 * SD-120：「先问」停在等人裁决上的那一版是真实付费产物，用户必须能在版本列表里
 * 看到它、播它、并就地裁决它。旧口径只查 SUCCEEDED 任务，于是界面一边说「成片这一版
 * 还在 · 决定再抽一次还是收下」，一边既不给那一版也不给「收下」的对象。
 */
describe('shotboard parked takes and the accept path', () => {
  let parkedShotId: string
  let parkedTaskId: string
  let parkedClipId: string

  const snapshot = (artifactId: string | null, state: 'pending' | 'retried') => JSON.stringify({
    state,
    retryClass: 'creative',
    kind: 'visual-audit',
    reasons: ['visual-audit: threshold not met — awaiting review (policy)'],
    findings: [{ dimension: 'aesthetic', message: 'LED 数字漂移', evidenceTimeSeconds: 2.048 }],
    score: 0.65,
    attempt: 1,
    cap: 1,
    retriesUsed: 0,
    budgetLimit: null,
    budgetUsed: 0,
    policy: 'ask',
    autoRetries: 0,
    askReason: 'policy',
    candidates: [{ connectionId: 'c1', capabilityId: 'video_gen', provider: 'mock', model: 'mock-t2v' }],
    artifactId,
    error: null,
    createdAt: new Date().toISOString(),
  })

  const select = (payload: { artifactId?: string | null }) =>
    env.app.inject({ method: 'POST', url: `/api/storyboards/${parkedShotId}/video-selection`, headers: authHeaders(ownerToken), payload })

  beforeAll(async () => {
    const shot = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken), payload: { number: 3, title: '床头读秒', durationMs: 4000, description: '他盯着床头的电子钟' } })
    expect(shot.statusCode).toBe(201)
    parkedShotId = shot.json().id as string

    const batch = await env.db.generationBatch.create({ data: { organizationId, episodeId, stage: 'VIDEO', plannedCount: 1 } })
    // 一版被收下过的成功片：它已经过了问询，不该再带「等你裁决」。
    const decidedBatch = await env.db.generationBatch.create({ data: { organizationId, episodeId, stage: 'VIDEO', plannedCount: 1 } })
    const decidedTask = await env.db.generationTask.create({
      data: { organizationId, batchId: decidedBatch.id, stage: 'VIDEO', status: 'FAILED', storyboardId: parkedShotId, provider: 'mock', model: 'mock-t2v', attempts: 1, errorSnapshot: 'VIDEO: threshold not met', reviewSnapshot: snapshot(null, 'retried') },
    })
    const decidedClip = await env.db.mediaArtifact.create({
      data: { organizationId, taskId: decidedTask.id, stage: 'VIDEO', objectKey: `parked/${decidedTask.id}-v1.mp4`, checksum: 'pd-v1', mimeType: 'video/mp4', version: 1, durationMs: 4000 },
    })
    // 改口径：重抽已决定，那一版归历史，不再占候选。
    await env.db.generationTask.update({ where: { id: decidedTask.id }, data: { reviewSnapshot: snapshot(decidedClip.id, 'retried') } })

    const task = await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage: 'VIDEO', status: 'FAILED', storyboardId: parkedShotId, provider: 'mock', model: 'mock-t2v', attempts: 1, errorSnapshot: 'visual-audit: threshold not met — awaiting review (policy)', reviewSnapshot: snapshot(null, 'pending') },
    })
    parkedTaskId = task.id
    parkedClipId = (await env.db.mediaArtifact.create({
      data: { organizationId, taskId: task.id, stage: 'VIDEO', objectKey: `parked/${task.id}-v2.mp4`, checksum: 'pk-v2', mimeType: 'video/mp4', version: 2, durationMs: 4000 },
    })).id
    await env.db.generationTask.update({ where: { id: task.id }, data: { reviewSnapshot: snapshot(parkedClipId, 'pending') } })
    await env.db.qualityCheck.create({ data: { status: 'NEEDS_REVIEW', kind: 'visual-audit', score: 0.65, report: '{}', artifactId: parkedClipId, batchId: null } })
  }, 300_000)

  it('shows the parked paid take, playable but not pinnable, and keeps other failures out', async () => {
    const { body } = await shotboard(ownerToken, episodeId)
    const shot = body.shots.find(item => item.id === parkedShotId)!

    // 已重抽的那一版不回来：只有压在人手上的问询才进候选，否则失败历史会混成版本列表。
    expect(shot.videoCandidates.map(candidate => candidate.artifactId)).toEqual([parkedClipId])
    expect(shot.videoCandidates[0]).toMatchObject({
      version: 2,
      taskId: parkedTaskId,
      selected: false,
      awaitingDecision: true,
      qc: { kind: 'visual-audit', status: 'NEEDS_REVIEW', score: 0.65 },
    })
    // 停在问询上的不是成片：卡片缩略图与「这一镜拿得上画面的东西」都不许指向它。
    expect(shot.video).toBeNull()
    expect(shot.selectedVideoArtifactId).toBeNull()
    expect(shot.slot).not.toBe('video')
    // 「等你裁决」不许报成「等你选优」——单版没有抉择。
    expect(shot.attention).not.toContain('selection_open')
  })

  it('tells the flow page the same truth: no effective clip, but a clip that exists', async () => {
    // SD-168：流程页的分镜 DTO 过去只认 SUCCEEDED，于是同一张卡上「成片重抽没过线」
    // 与读数「还没有成片」并存。读数要分得开「根本没有」和「有但停在等你裁决」，
    // 这一格就必须随 DTO 下发——生效位仍然空着，两边不许反过来。
    const flow = await env.app.inject({
      method: 'GET',
      url: `/api/episodes/${episodeId}/storyboards`,
      headers: authHeaders(ownerToken),
    })
    expect(flow.statusCode).toBe(200)
    const shot = (flow.json() as { id: string; video: { id: string } | null; videoParked: { id: string } | null; videoError: string | null }[])
      .find(item => item.id === parkedShotId)
    expect(shot?.video).toBeNull()
    expect(shot?.videoParked).toMatchObject({ id: parkedClipId })
    expect(shot?.videoError).toContain('awaiting review')
  })

  it('refuses to pin the parked take, then accepts it into a usable version', async () => {
    const rejected = await select({ artifactId: parkedClipId })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().error).toBe('artifact is not a succeeded video of this shot')

    const accept = await env.app.inject({
      method: 'POST',
      url: `/api/generations/tasks/${parkedTaskId}/review`,
      headers: authHeaders(ownerToken),
      payload: { action: 'waive', reason: '钟表停摆正是剧本要的僵持感，LED 漂移在成片画幅内不可辨' },
    })
    expect(accept.statusCode).toBe(200)
    expect(accept.json().task).toMatchObject({ id: parkedTaskId, status: 'SUCCEEDED' })

    const { body } = await shotboard(ownerToken, episodeId)
    const shot = body.shots.find(item => item.id === parkedShotId)!
    expect(shot.videoCandidates[0]).toMatchObject({ artifactId: parkedClipId, awaitingDecision: false })
    // 收下之后它才成为可选版本：钦定不再被拒，质检也从待审转通过。
    expect((await select({ artifactId: parkedClipId })).statusCode).toBe(200)
    expect((await env.db.qualityCheck.findFirstOrThrow({ where: { artifactId: parkedClipId } })).status).toBe('APPROVED')
  })
})

/**
 * SD-081：worker 把逐帧分、结构漂移与复印件读数都写进了 report，接口过去只交出分数，
 * 屏上于是只剩一个数。这里钉住三份读数随候选抵达，以及读不出的报文仍照常出候选。
 */
describe('shotboard QC readings', () => {
  it('serves the three readings per candidate and leaves unreadable reports without them', async () => {
    const batch = await env.db.generationBatch.create({ data: { organizationId, episodeId, stage: 'VIDEO', plannedCount: 1 } })
    const task = await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage: 'VIDEO', status: 'SUCCEEDED', storyboardId: shotOneId, provider: 'mock', model: 'mock-t2v', attempts: 1 },
    })
    const readClipId = (await env.db.mediaArtifact.create({
      data: { organizationId, taskId: task.id, stage: 'VIDEO', objectKey: `readings/${task.id}-v1.mp4`, checksum: 'rd-v1', mimeType: 'video/mp4', version: 11, durationMs: 3000 },
    })).id
    const garbageClipId = (await env.db.mediaArtifact.create({
      data: { organizationId, taskId: task.id, stage: 'VIDEO', objectKey: `readings/${task.id}-v2.mp4`, checksum: 'rd-v2', mimeType: 'video/mp4', version: 12, durationMs: 3000 },
    })).id
    const frameScores = [
      { position: 0, score: 0.9 },
      { position: 0.5, score: 0.62 },
      { position: 1, score: 0.3 },
    ]
    const structureDrift = { measured: true, earlyLateDistance: 0.1585, firstMidDistance: 0.1132, maxStepDistance: 0.0741, sampleSeconds: [0, 0.45, 1.5, 2.55] }
    const auditRepetition = { matchedArtifactId: null, pictureDistance: 0.2419, status: 'distinct' }
    await env.db.qualityCheck.create({
      data: {
        status: 'NEEDS_REVIEW',
        kind: 'visual-audit',
        score: 0.62,
        report: JSON.stringify({ kind: 'visual-audit', reasons: ['visual-audit: 结构漂移'], frameScores, structureDrift, auditRepetition }),
        storyboardId: shotOneId,
        artifactId: readClipId,
      },
    })
    await env.db.qualityCheck.create({
      data: { status: 'NEEDS_REVIEW', kind: 'video', score: 0.4, report: 'not json', storyboardId: shotOneId, artifactId: garbageClipId },
    })

    const { statusCode, body } = await shotboard(ownerToken, episodeId)
    expect(statusCode).toBe(200)
    const shot = body.shots.find(item => item.id === shotOneId)!

    const read = shot.videoCandidates.find(candidate => candidate.artifactId === readClipId)!
    expect(read.qc).toMatchObject({
      kind: 'visual-audit',
      status: 'NEEDS_REVIEW',
      score: 0.62,
      frameScores,
      structureDrift,
      auditRepetition,
    })

    // 报错不能因为一份坏报文而失败：分数照展，读数键干脆不出现在响应里。
    const garbage = shot.videoCandidates.find(candidate => candidate.artifactId === garbageClipId)!
    expect(garbage.qc).toMatchObject({ kind: 'video', status: 'NEEDS_REVIEW', score: 0.4 })
    expect(garbage.qc).not.toHaveProperty('frameScores')
    expect(garbage.qc).not.toHaveProperty('structureDrift')
    expect(garbage.qc).not.toHaveProperty('auditRepetition')

    // 镜头级读数同一口径：同一份 report 在两条出口上给出同一组数。
    const shotLevel = shot.qc.find(entry => entry.kind === 'visual-audit')!
    expect(shotLevel).toMatchObject({ frameScores, structureDrift, auditRepetition })
    const shotLevelGarbage = shot.qc.find(entry => entry.kind === 'video')!
    expect(shotLevelGarbage).not.toHaveProperty('frameScores')
  })
})
