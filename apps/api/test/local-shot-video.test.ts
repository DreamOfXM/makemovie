import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestEnv, type TestEnv } from './env.js'
import { synthesizeMockMedia, titleCardCapability } from '@studio/media'

/**
 * 手工制作镜（字卡 / 界面 / 屏幕录制 / 合成）的画面入口（SD-108）。
 *
 * 这四档镜头平台不排模型调用，此前界面上一个入口都没有：进这一镜只看到「手工制作」
 * 徽章，整集合成时后端直接抛缺片段。这里锁的是几件事——
 * ① 机内真的能出片并「上传即选中」，走与模型片段完全相同的钦定/入片路径；
 * ② 三账诚实：本机产物没有 GenerationTask、没有 ArtifactOperation，用量表上不该出现它；
 * ③ 卡上的文案是这一镜的全部内容，重画不能把它换成分镜表里的占位镜号（SD-117）；
 * ④ 档位是「视频」的镜头也允许导入（SD-178）：模型出不了片时，人的这一条画面是唯一出口。
 */
let env: TestEnv
let ownerToken: string
let viewerToken: string
let organizationId = ''
let episodeId: string
let cardId: string
let placeholderCardId: string
let uiShotId: string
let modelShotId: string
let scratch = ''
/** 缺 drawtext 或缺中文字体的机器画不出字卡；那两台机器上这组用例改判 501，不判假绿。 */
let canDrawCards = false

const authHeaders = (token: string) => env.authHeaders(token)

interface ShotVideoDto {
  id: string
  selectedVideoArtifactId: string | null
  stateRevision: number
  artifact?: { id: string; version: number; mimeType: string; durationMs: number | null; width: number | null; height: number | null; filename: string | null }
}

interface CandidateRow {
  artifactId: string
  taskId: string | null
  origin: string
  cardText?: string | null
  version: number
  durationMs: number | null
  selected: boolean
  qc: unknown
}

async function renderCard(storyboardId: string, text?: string | null, token = ownerToken) {
  return env.app.inject({
    method: 'POST', url: `/api/storyboards/${storyboardId}/title-card`,
    headers: authHeaders(token),
    // null = 发一栏非字符串 text（走注入体，helpers 会把 body 原样当 payload）；undefined = 根本不传这一栏。
    payload: text === null ? { text: 42 } : text === undefined ? {} : { text },
  })
}

async function importVideo(storyboardId: string, filename: string, bytes: Uint8Array | Buffer, mime = 'video/mp4', token = ownerToken) {
  const boundary = '----studiolocalvideotest'
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return env.app.inject({
    method: 'POST', url: `/api/storyboards/${storyboardId}/video-import`,
    headers: { ...authHeaders(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  })
}

async function shotboardRows(): Promise<{ id: string; production: string; video: { id: string } | null; videoCandidates: CandidateRow[] }[]> {
  const res = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/shotboard`, headers: authHeaders(ownerToken) })
  const body = res.json() as { shots?: { id: string; production: string; video: { id: string } | null; videoCandidates: CandidateRow[] }[] }
  return body.shots ?? []
}

const rowOf = async (storyboardId: string) => (await shotboardRows()).find(row => row.id === storyboardId)

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('local-video-owner@example.com', 'Local Video Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
  // 成员接口只认「已注册用户」，所以先把观众账号建出来再挂进本空间（与 shot-audio 同一顺序）。
  await env.register('local-video-viewer@example.com', 'Local Video Viewer Org')
  expect((await env.app.inject({ method: 'POST', url: '/api/members', headers: authHeaders(ownerToken), payload: { email: 'local-video-viewer@example.com', role: 'VIEWER' } })).statusCode).toBe(201)
  const viewerLogin = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'local-video-viewer@example.com', password: 'password123', organizationId } })
  viewerToken = viewerLogin.json().token as string

  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'Local Video Drama' } })
  const episode = await env.app.inject({
    method: 'POST', url: `/api/projects/${project.json().id as string}/episodes`,
    headers: authHeaders(ownerToken), payload: { number: 1, title: 'EP1' },
  })
  episodeId = episode.json().id as string

  const shots = [
    { key: 'cardId', number: 1, title: '第七次死亡', description: '黑底白字的片头卡', method: '字卡' },
    { key: 'uiShotId', number: 2, title: '系统界面', description: '手机屏幕上的报警界面', method: '录屏' },
    { key: 'modelShotId', number: 3, title: '床头钟', description: 'LED 钟显示 7:07:12', method: undefined },
    // 标题就是分镜表里那种占位镜号，用来验「不带文案重画」到底沿用哪一句（SD-117）。
    { key: 'placeholderCardId', number: 4, title: '镜头4', description: '（字卡）收尾卡', method: '字卡' },
  ] as const
  for (const shot of shots) {
    const res = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number: shot.number, title: shot.title, durationMs: 3000, description: shot.description },
    })
    expect(res.statusCode).toBe(201)
    const id = res.json().id as string
    // method 只有分镜生成会写（创建/编辑接口都不收这一栏），所以夹具按同一条落库路径打标。
    if (shot.method) await env.db.storyboard.update({ where: { id }, data: { method: shot.method } })
    if (shot.key === 'cardId') cardId = id
    if (shot.key === 'uiShotId') uiShotId = id
    if (shot.key === 'modelShotId') modelShotId = id
    if (shot.key === 'placeholderCardId') placeholderCardId = id
  }

  scratch = await mkdtemp(join(tmpdir(), 'studio-local-video-'))
  canDrawCards = (await titleCardCapability()).canRender
}, 300_000)

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
  await env?.stop()
})

describe('title card rendered on this machine', () => {
  it('draws the card, pins it into the shot, and bills nothing', async () => {
    const res = await renderCard(cardId, '第七次死亡\n他记得每一次')
    if (!canDrawCards) {
      // 能力缺位必须报成 501 并说清缺的是哪一件，不能伪装成「生成失败」让人去重抽。
      expect(res.statusCode).toBe(501)
      expect(res.json().error).toMatch(/title cards cannot be drawn/)
      return
    }
    expect(res.statusCode).toBe(201)
    const body = res.json() as ShotVideoDto
    expect(body.artifact?.version).toBe(1)
    expect(body.artifact?.mimeType).toBe('video/mp4')
    expect(body.artifact?.durationMs).toBeGreaterThanOrEqual(2900)
    expect(body.artifact?.durationMs).toBeLessThanOrEqual(3100)
    expect(body.artifact?.width).toBeGreaterThan(0)
    // 上传即选中：本机画面只有这一条，还让人再去版本行点一次钦定等于把空着换成「有了但没选」。
    expect(body.selectedVideoArtifactId).toBe(body.artifact?.id)

    const row = await rowOf(cardId)
    expect(row?.production).toBe('title-card')
    expect(row?.video?.id).toBe(body.artifact?.id)
    expect(row?.videoCandidates).toHaveLength(1)
    expect(row?.videoCandidates[0]).toMatchObject({ artifactId: body.artifact?.id, origin: 'local_render', taskId: null, selected: true, qc: null })

    const content = await env.app.inject({ method: 'GET', url: `/api/artifacts/${body.artifact?.id as string}/content`, headers: authHeaders(viewerToken) })
    expect(content.statusCode).toBe(200)
    expect(content.rawPayload.byteLength).toBeGreaterThan(0)

    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=storyboard.render-title-card', headers: authHeaders(ownerToken) })
    const events = audit.json().events as { entityId: string; payload: { text: string; lines: number } }[]
    expect(events.some(event => event.entityId === cardId && event.payload.lines >= 2)).toBe(true)
  })

  it('makes a second render version 2 and keeps the file it replaced', async () => {
    const res = await renderCard(cardId, '第七次死亡')
    if (!canDrawCards) expect(res.statusCode).toBe(501)
    else {
      expect(res.statusCode).toBe(201)
      expect((res.json() as ShotVideoDto).artifact?.version).toBe(2)
      expect(await env.db.mediaArtifact.count({ where: { storyboardId: cardId, stage: 'VIDEO' } })).toBe(2)
    }
  })

  it('keeps the words already on the card when a re-render sends no text', async () => {
    const first = await renderCard(placeholderCardId, '这一版，第 7 次采用')
    if (!canDrawCards) {
      expect(first.statusCode).toBe(501)
      return
    }
    expect((await rowOf(placeholderCardId))?.videoCandidates[0]?.cardText).toBe('这一版，第 7 次采用')

    await renderCard(placeholderCardId)
    // 这一镜的标题是「镜头4」：占位名。不带文案重画要沿用卡上原文，
    // 把《这一版，第 7 次采用》覆盖成镜号等于一次点击毁掉一句文案。
    const pinned = (await rowOf(placeholderCardId))?.videoCandidates.find(candidate => candidate.selected)
    expect(pinned?.origin).toBe('local_render')
    expect(pinned?.cardText).toBe('这一版，第 7 次采用')
    const stored = await env.db.mediaArtifact.findFirstOrThrow({
      where: { id: pinned?.artifactId as string }, select: { metadata: true },
    })
    expect(JSON.parse(stored.metadata as string).text).toBe('这一版，第 7 次采用')
  })

  it('refuses to fake a card for a shot the model is supposed to shoot', async () => {
    const res = await renderCard(modelShotId, '不该是字卡')
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/not a title card shot/)
  })

  it('stops instead of silently cutting long text', async () => {
    const res = await renderCard(cardId, '雨'.repeat(600))
    if (!canDrawCards) expect(res.statusCode).toBe(501)
    else {
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/does not fit on one card/)
    }
  })

  it('rejects an empty card and a non-string text before spending a render', async () => {
    const empty = await renderCard(cardId, '   ')
    const wrong = await renderCard(cardId, null)
    if (!canDrawCards) {
      expect(empty.statusCode).toBe(501)
      expect(wrong.statusCode).toBe(501)
    } else {
      expect(empty.json().error).toMatch(/title card text is empty/)
      expect(wrong.json().error).toMatch(/text must be a string/)
    }
    expect(await env.db.mediaArtifact.count({ where: { storyboardId: cardId, stage: 'VIDEO' } })).toBe(canDrawCards ? 2 : 0)
  })

  it('keeps every local byte off the billing ledger', async () => {
    // 整个空间一条模型任务、一条编辑操作都没有：本机产物不进三账，用量表上不该出现它。
    expect(await env.db.generationTask.count({ where: { organizationId } })).toBe(0)
    expect(await env.db.artifactOperation.count({ where: { organizationId } })).toBe(0)
  })
})

describe('picture imported by hand', () => {
  it('accepts a real clip, pins it, and reports the length measured from the file', async () => {
    const clipPath = join(scratch, 'screen-recording.mp4')
    await synthesizeMockMedia('t2v', clipPath, { durationMs: 2500 })
    const bytes = await readFile(clipPath)
    const res = await importVideo(uiShotId, '录屏_报警界面_v2.mp4', bytes)
    expect(res.statusCode).toBe(201)
    const body = res.json() as ShotVideoDto
    expect(body.artifact?.version).toBe(1)
    // 时长吃文件实测值，不吃分镜计划值：进时间线的是这段片子实际多长。
    expect(body.artifact?.durationMs).toBeGreaterThanOrEqual(2000)
    expect(body.artifact?.durationMs).toBeLessThanOrEqual(3000)
    expect(body.artifact?.filename).toBe('录屏_报警界面_v2.mp4')
    expect(body.selectedVideoArtifactId).toBe(body.artifact?.id)

    const row = await rowOf(uiShotId)
    expect(row?.production).toBe('screen-recording')
    expect(row?.videoCandidates[0]).toMatchObject({ origin: 'imported', taskId: null, qc: null, selected: true, cardText: null })

    const second = await importVideo(uiShotId, '录屏_报警界面_v3.mp4', bytes)
    expect((second.json() as ShotVideoDto).artifact?.version).toBe(2)
    expect(await env.db.mediaArtifact.count({ where: { storyboardId: uiShotId, stage: 'VIDEO' } })).toBe(2)
  })

  it('lets a human clip close a shot the model could not deliver (SD-178)', async () => {
    const clipPath = join(scratch, 'rescue.mp4')
    await synthesizeMockMedia('t2v', clipPath, { durationMs: 2500 })
    const res = await importVideo(modelShotId, '实拍_床头钟.mp4', await readFile(clipPath))
    expect(res.statusCode).toBe(201)
    const body = res.json() as ShotVideoDto
    expect(body.selectedVideoArtifactId).toBe(body.artifact?.id)
    const row = await rowOf(modelShotId)
    // 档位仍是「视频」——导入不改生成方式，只给这一镜补一条被选中的画面；
    // 否则改档会把这一镜从模型链上摘掉，人想再让模型重拍就没有入口了。
    expect(row?.production).toBe('video')
    expect(row?.videoCandidates[0]).toMatchObject({ origin: 'imported', taskId: null, selected: true })
  })

  it('rejects a missing part, a wrong extension, an empty file and bytes no demuxer can read', async () => {
    const boundary = '----studiolocalvideotest'
    const noFile = await env.app.inject({
      method: 'POST', url: `/api/storyboards/${uiShotId}/video-import`,
      headers: { ...authHeaders(ownerToken), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhi\r\n--${boundary}--\r\n`),
    })
    expect(noFile.statusCode).toBe(400)
    expect(noFile.json().error).toMatch(/video file is required/)

    const txt = await importVideo(uiShotId, '剧本.txt', Buffer.from('不是视频'))
    expect(txt.statusCode).toBe(400)
    expect(txt.json().error).toMatch(/only \.mp4 \.m4v \.mov \.webm files are accepted/)

    expect((await importVideo(uiShotId, 'empty.mp4', Buffer.alloc(0))).json().error).toMatch(/file is empty/)

    const junk = await importVideo(uiShotId, '坏文件.mp4', Buffer.from('this is not a media container'))
    expect(junk.statusCode).toBe(400)
    expect(junk.json().error).toMatch(/cannot be read, export it again as mp4/)

    expect(await env.db.mediaArtifact.count({ where: { storyboardId: uiShotId, stage: 'VIDEO' } })).toBe(2)
  })

  it('403s both doors for a viewer and 404s an unknown shot', async () => {
    expect((await renderCard(cardId, '观众试试', viewerToken)).statusCode).toBe(403)
    expect((await importVideo(uiShotId, '观众.mp4', Buffer.from('x'), 'video/mp4', viewerToken)).statusCode).toBe(403)
    expect((await renderCard('does-not-exist', '不存在')).statusCode).toBe(404)
    expect((await importVideo('does-not-exist', 'x.mp4', Buffer.from('x'))).statusCode).toBe(404)
  })
})
