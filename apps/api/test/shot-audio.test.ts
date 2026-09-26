import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

/**
 * 每镜「声音来源」的四档与音频导入。这四档是成片的四种真相，所以门禁测的是
 * 「拒掉空选择」而不是「存下了字符串」：一个没台词也没导入音频的镜头选「只用
 * 配音」，成片只会静默，必须在写入前被拦。
 */
let env: TestEnv
let ownerToken: string
let editorToken: string
let viewerToken: string
let organizationId: string
let projectId: string
let episodeId: string
let spokenId: string
let muteId: string
let foreignStoryboardId: string

const authHeaders = (token: string) => env.authHeaders(token)

/** 手写合法 WAV 头，不依赖 ffmpeg：时长 = 数据字节 / 每秒字节数。 */
function wav(seconds: number, sampleRate = 8000): Buffer {
  const dataBytes = Math.round(seconds * sampleRate) * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  return Buffer.concat([header, Buffer.alloc(dataBytes)])
}

/** 两条导入轨走同一段流程，只有落点不同，所以夹具也共用一个、按 role 换 URL。 */
function upload(storyboardId: string, filename: string, bytes: Buffer, token = ownerToken, role: 'voice' | 'ambience' = 'voice') {
  const boundary = '----studiovoicetest'
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return env.app.inject({
    method: 'POST',
    url: `/api/storyboards/${storyboardId}/${role}-import`,
    headers: { ...authHeaders(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  })
}

const importAmbience = (storyboardId: string, filename: string, bytes: Buffer, token = ownerToken) => upload(storyboardId, filename, bytes, token, 'ambience')

const removeImported = (storyboardId: string, role: 'voice' | 'ambience' = 'voice', token = ownerToken) => env.app.inject({
  method: 'DELETE', url: `/api/storyboards/${storyboardId}/${role}-import`, headers: authHeaders(token),
})

const setSource = (storyboardId: string, audioSource: unknown, token = ownerToken) => env.app.inject({
  method: 'POST', url: `/api/storyboards/${storyboardId}/audio-source`, headers: authHeaders(token), payload: { audioSource },
})

interface AudioDto {
  id: string
  audioSource: string | null
  importedVoiceArtifactId: string | null
  importedAmbienceArtifactId?: string | null
  artifact?: { id: string; version: number; durationMs: number | null; filename: string | null; objectKey: string; mimeType: string }
}

interface StoryboardListRow {
  id: string
  audioSource: string | null
  importedVoice: { id: string; filename: string | null; durationMs: number | null } | null
  importedAmbience: { id: string; filename: string | null; durationMs: number | null } | null
  voice: { id: string; filename: string | null } | null
}

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('audio-owner@example.com', 'Audio Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
  await env.register('audio-editor@example.com', 'Audio Editor Org')
  await env.register('audio-viewer@example.com', 'Audio Viewer Org')
  for (const [email, role] of [['audio-editor@example.com', 'EDITOR'], ['audio-viewer@example.com', 'VIEWER']] as const) {
    expect((await env.app.inject({ method: 'POST', url: '/api/members', headers: authHeaders(ownerToken), payload: { email, role } })).statusCode).toBe(201)
    const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123', organizationId } })
    expect(login.statusCode).toBe(200)
    if (role === 'EDITOR') editorToken = login.json().token as string
    else viewerToken = login.json().token as string
  }

  const rival = await env.register('audio-rival@example.com', 'Audio Rival Org')
  const rivalProject = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(rival.token), payload: { name: 'Rival Drama' } })
  const rivalEpisode = await env.app.inject({
    method: 'POST', url: `/api/projects/${rivalProject.json().id as string}/episodes`,
    headers: authHeaders(rival.token), payload: { number: 1, title: 'Rival EP1' },
  })
  const rivalShot = await env.app.inject({
    method: 'POST', url: `/api/episodes/${rivalEpisode.json().id as string}/storyboards`, headers: authHeaders(rival.token),
    payload: { number: 1, title: 'Rival Shot', durationMs: 3000, description: '对手的分镜', dialogue: '别碰我的音轨' },
  })
  foreignStoryboardId = rivalShot.json().id as string

  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'Audio Drama' } })
  projectId = project.json().id as string
  const episode = await env.app.inject({
    method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'EP1' },
  })
  episodeId = episode.json().id as string

  const spoken = await env.app.inject({
    method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken),
    payload: { number: 1, title: '巷口相遇', durationMs: 3000, description: '小雨在巷口撑伞', dialogue: '你也被困在这里了？' },
  })
  expect(spoken.statusCode).toBe(201)
  spokenId = spoken.json().id as string

  // 空镜：没有一句台词，只有模型自带的街道声。
  const mute = await env.app.inject({
    method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken),
    payload: { number: 2, title: '空镜·长街', durationMs: 2000, description: '雨后长街，无人' },
  })
  expect(mute.statusCode).toBe(201)
  muteId = mute.json().id as string
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

describe('audio source selection', () => {
  it('stores the pick and restores the shot-type default when cleared', async () => {
    for (const mode of ['VOICE', 'VOICE_NATIVE', 'NATIVE'] as const) {
      const res = await setSource(spokenId, mode, editorToken)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ id: spokenId, audioSource: mode })
    }

    const cleared = await setSource(spokenId, null, editorToken)
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().audioSource).toBeNull()

    const list = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(viewerToken) })
    const rows = list.json() as StoryboardListRow[]
    expect(rows.find(row => row.id === spokenId)?.audioSource).toBeNull()
    // 未钦定不是「默认值被写进了库」：清空后这一列必须是 null，默认规则才留在代码里。
    expect(await env.db.storyboard.findUniqueOrThrow({ where: { id: spokenId }, select: { audioSource: true } })).toMatchObject({ audioSource: null })

    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=storyboard.set-audio-source', headers: authHeaders(ownerToken) })
    const events = audit.json().events as { action: string; entityId: string; payload: { audioSource: string | null } }[]
    expect(events.some(event => event.entityId === spokenId && event.payload.audioSource === 'VOICE_NATIVE')).toBe(true)
    expect(events.some(event => event.entityId === spokenId && event.payload.audioSource === null)).toBe(true)
  })

  it('refuses a mode with nothing to play instead of shipping a silent shot', async () => {
    const voice = await setSource(muteId, 'VOICE')
    expect(voice.statusCode).toBe(409)
    expect(voice.json().error).toMatch(/no dialogue and no imported audio/)
    const both = await setSource(muteId, 'VOICE_NATIVE')
    expect(both.statusCode).toBe(409)
    const imported = await setSource(muteId, 'IMPORTED')
    expect(imported.statusCode).toBe(409)
    expect(imported.json().error).toMatch(/import an audio file for this shot first/)
    // 「只用原声」永远可选——空镜的默认就是它。
    expect((await setSource(muteId, 'NATIVE')).statusCode).toBe(200)
    expect((await setSource(muteId, null)).statusCode).toBe(200)
  })

  it('rejects an unknown mode and a body that forgot the field', async () => {
    expect((await setSource(spokenId, 'BOTH')).statusCode).toBe(400)
    expect((await setSource(spokenId, 42)).statusCode).toBe(400)
    const missing = await env.app.inject({ method: 'POST', url: `/api/storyboards/${spokenId}/audio-source`, headers: authHeaders(ownerToken), payload: {} })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toMatch(/null restores/)
  })

  it('404s unknown and foreign shots, and 403s viewers', async () => {
    expect((await setSource('does-not-exist', 'VOICE')).statusCode).toBe(404)
    expect((await setSource(foreignStoryboardId, 'VOICE', editorToken)).statusCode).toBe(404)
    expect((await upload(foreignStoryboardId, 'x.wav', wav(1), editorToken)).statusCode).toBe(404)

    const forbidden = await setSource(spokenId, 'VOICE', viewerToken)
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toMatch(/storyboard:write/)
    expect((await upload(spokenId, 'x.wav', wav(1), viewerToken)).statusCode).toBe(403)
    expect((await env.app.inject({ method: 'DELETE', url: `/api/storyboards/${spokenId}/voice-import`, headers: authHeaders(viewerToken) })).statusCode).toBe(403)
  })

  it('409s a superseded shot so a dead revision cannot be re-voiced', async () => {
    await env.db.storyboard.update({ where: { id: spokenId }, data: { supersededAt: new Date() } })
    try {
      const res = await setSource(spokenId, 'VOICE')
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/superseded/)
      expect((await upload(spokenId, 'x.wav', wav(1))).statusCode).toBe(409)
    } finally {
      await env.db.storyboard.update({ where: { id: spokenId }, data: { supersededAt: null } })
    }
  })
})

describe('voice import', () => {
  it('accepts a file, names it, and selects it in one move', async () => {
    const res = await upload(spokenId, '配音_终版_v3.wav', wav(4.2))
    expect(res.statusCode).toBe(201)
    const body = res.json() as AudioDto
    expect(body.audioSource).toBe('IMPORTED')
    expect(body.importedVoiceArtifactId).toBe(body.artifact?.id)
    // 对象键是按租户/项目/阶段重建的路径，人认不出自己传的是什么，所以原始文件名必须回来。
    expect(body.artifact?.filename).toBe('配音_终版_v3.wav')
    expect(body.artifact?.version).toBe(1)
    expect(body.artifact?.mimeType).toBe('audio/wav')
    expect(body.artifact?.durationMs).toBeGreaterThanOrEqual(4100)
    expect(body.artifact?.durationMs).toBeLessThanOrEqual(4300)
    expect(body.artifact?.objectKey).toContain('-voice')

    const list = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(viewerToken) })
    const row = (list.json() as StoryboardListRow[]).find(item => item.id === spokenId)
    expect(row?.importedVoice?.filename).toBe('配音_终版_v3.wav')
    // 导入件不是生成产物：voice 那一格仍然只挂 TTS 的产物。
    expect(row?.voice).toBeNull()

    const content = await env.app.inject({ method: 'GET', url: `/api/artifacts/${body.artifact?.id as string}/content`, headers: authHeaders(viewerToken) })
    expect(content.statusCode).toBe(200)
    expect(content.rawPayload.byteLength).toBe(wav(4.2).byteLength)

    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=storyboard.import-voice', headers: authHeaders(ownerToken) })
    const events = audit.json().events as { entityId: string; payload: { filename: string } }[]
    expect(events.some(event => event.entityId === spokenId && event.payload.filename === '配音_终版_v3.wav')).toBe(true)
  })

  it('makes a second import version 2 and keeps the file it replaced', async () => {
    const res = await upload(spokenId, '配音_终版_v4.wav', wav(3))
    expect(res.statusCode).toBe(201)
    const body = res.json() as AudioDto
    expect(body.artifact?.version).toBe(2)
    expect(body.artifact?.filename).toBe('配音_终版_v4.wav')
    expect((await env.db.storyboard.findUniqueOrThrow({ where: { id: spokenId } })).importedVoiceArtifactId).toBe(body.artifact?.id)
    expect(await env.db.mediaArtifact.count({ where: { storyboardId: spokenId, stage: 'AUDIO' } })).toBe(2)
  })

  it('unlocks the voice modes once there is audio to play', async () => {
    expect((await setSource(muteId, 'VOICE')).statusCode).toBe(409)
    expect((await upload(muteId, '街道环境声.wav', wav(2))).statusCode).toBe(201)
    expect((await setSource(muteId, 'VOICE_NATIVE')).statusCode).toBe(200)
    expect((await setSource(muteId, 'VOICE')).statusCode).toBe(200)
  })

  it('rejects non-audio names, empty files and a missing part', async () => {
    const txt = await upload(spokenId, '剧本.txt', Buffer.from('不是音频'))
    expect(txt.statusCode).toBe(400)
    expect(txt.json().error).toMatch(/only \.wav \.mp3/)

    const empty = await upload(spokenId, 'empty.wav', Buffer.alloc(0))
    expect(empty.statusCode).toBe(400)
    expect(empty.json().error).toMatch(/empty/)

    const boundary = '----studiovoicetest'
    const noFile = await env.app.inject({
      method: 'POST', url: `/api/storyboards/${spokenId}/voice-import`,
      headers: { ...authHeaders(ownerToken), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhi\r\n--${boundary}--\r\n`),
    })
    expect(noFile.statusCode).toBe(400)
    expect(noFile.json().error).toMatch(/audio file is required/)
  })

  // 超限的文件会被 busboy 截断到上限而不是报错，只比长度等于没比：截剩的那半条
  // 配音会以「完整的 32MB 文件」入库，尾音静音且无人知情。
  it('413s a file over the ceiling instead of storing the truncated remainder', async () => {
    const res = await upload(spokenId, '超大.wav', wav(2200))
    expect(res.statusCode).toBe(413)
    expect(res.json().error).toMatch(/larger than 32 MB/)
    expect(await env.db.mediaArtifact.count({ where: { storyboardId: spokenId, stage: 'AUDIO' } })).toBe(2)
  })

  it('clears the pointer on remove and falls back to the default, but keeps the file', async () => {
    expect((await setSource(muteId, 'IMPORTED')).statusCode).toBe(200)
    const res = await env.app.inject({ method: 'DELETE', url: `/api/storyboards/${muteId}/voice-import`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: muteId, audioSource: null, importedVoiceArtifactId: null, importedAmbienceArtifactId: null })
    // 素材是人提供的，撤掉一次选择不该连文件一起销毁。
    expect(await env.db.mediaArtifact.count({ where: { storyboardId: muteId, stage: 'AUDIO' } })).toBe(1)

    const list = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(viewerToken) })
    const row = (list.json() as StoryboardListRow[]).find(item => item.id === muteId)
    expect(row?.importedVoice).toBeNull()
  })

  it('leaves a mode the human set by hand alone when the import is removed', async () => {
    expect((await setSource(spokenId, 'NATIVE')).statusCode).toBe(200)
    const res = await env.app.inject({ method: 'DELETE', url: `/api/storyboards/${spokenId}/voice-import`, headers: authHeaders(ownerToken) })
    expect(res.statusCode).toBe(200)
    expect(res.json().audioSource).toBe('NATIVE')
  })

  it('404s removal for unknown and foreign shots', async () => {
    expect((await env.app.inject({ method: 'DELETE', url: '/api/storyboards/does-not-exist/voice-import', headers: authHeaders(ownerToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'DELETE', url: `/api/storyboards/${foreignStoryboardId}/voice-import`, headers: authHeaders(editorToken) })).statusCode).toBe(404)
  })
})

// 环境音是与声音来源正交的一栏：档说这一镜的人声从哪来，这一条说配音底下垫什么。
// 所以这组断言盯的是「不越界」——导入一条底不许把人已钦定的那一档顶掉，移除它也不许
// 连带清掉配音；否则这两栏就成了互相覆盖的两个入口，而不是一层叠一层。
describe('ambience import', () => {
  it('stores the bed without touching the audio source the human picked', async () => {
    expect((await setSource(spokenId, 'VOICE')).statusCode).toBe(200)

    const res = await importAmbience(spokenId, '巷口雨声.wav', wav(3.5))
    expect(res.statusCode).toBe(201)
    const body = res.json() as AudioDto
    expect(body.audioSource).toBe('VOICE')
    expect(body.importedAmbienceArtifactId).toBe(body.artifact?.id)
    // 底不是人声：它入库时绝不能把声音来源顺手改成「导入音频」。
    expect(body.importedVoiceArtifactId).toBeNull()
    expect(body.artifact?.filename).toBe('巷口雨声.wav')
    expect(body.artifact?.mimeType).toBe('audio/wav')
    // 两条轨共用一个版本计数器（它是这一镜已导入几条），靠对象键里的 role 分开，
    // 否则第二条底会覆盖第一条配音的文件。
    expect(body.artifact?.objectKey).toContain('-ambience')
    const bedId = body.artifact?.id as string

    const list = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(viewerToken) })
    const row = (list.json() as StoryboardListRow[]).find(item => item.id === spokenId)
    expect(row?.importedAmbience).toMatchObject({ id: bedId, filename: '巷口雨声.wav' })
    expect(row?.importedVoice).toBeNull()

    const board = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/shotboard`, headers: authHeaders(viewerToken) })
    const shot = (board.json().shots as { id: string; importedAmbience: { id: string } | null }[]).find(item => item.id === spokenId)
    expect(shot?.importedAmbience?.id).toBe(bedId)

    const content = await env.app.inject({ method: 'GET', url: `/api/artifacts/${bedId}/content`, headers: authHeaders(viewerToken) })
    expect(content.statusCode).toBe(200)
    expect(content.rawPayload.byteLength).toBe(wav(3.5).byteLength)

    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=storyboard.import-ambience', headers: authHeaders(ownerToken) })
    const events = audit.json().events as { entityId: string; payload: { filename: string } }[]
    expect(events.some(event => event.entityId === spokenId && event.payload.filename === '巷口雨声.wav')).toBe(true)
  })

  it('keeps the dub and the bed as two separate files on one shot', async () => {
    const before = await env.db.mediaArtifact.count({ where: { storyboardId: spokenId, stage: 'AUDIO' } })
    const dub = await upload(spokenId, '配音_终版.wav', wav(2))
    expect(dub.statusCode).toBe(201)
    // 配音那一档上传即选中；底保持在原位，两条同时挂在这一镜上。
    expect(dub.json().audioSource).toBe('IMPORTED')

    const stored = await env.db.storyboard.findUniqueOrThrow({
      where: { id: spokenId }, select: { audioSource: true, importedVoiceArtifactId: true, importedAmbienceArtifactId: true },
    })
    expect(stored.importedVoiceArtifactId).toBe((dub.json() as AudioDto).artifact?.id)
    expect(stored.importedAmbienceArtifactId).not.toBeNull()
    expect(stored.importedVoiceArtifactId).not.toBe(stored.importedAmbienceArtifactId)
    expect(await env.db.mediaArtifact.count({ where: { storyboardId: spokenId, stage: 'AUDIO' } })).toBe(before + 1)

    const list = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(viewerToken) })
    const row = (list.json() as StoryboardListRow[]).find(item => item.id === spokenId)
    expect(row?.importedVoice?.filename).toBe('配音_终版.wav')
    expect(row?.importedAmbience?.filename).toBe('巷口雨声.wav')
  })

  it('replaces the bed on a second import and keeps the file it replaced', async () => {
    const first = await env.db.storyboard.findUniqueOrThrow({ where: { id: spokenId }, select: { importedAmbienceArtifactId: true } })
    const res = await importAmbience(spokenId, '长街叫卖.wav', wav(2))
    expect(res.statusCode).toBe(201)
    const body = res.json() as AudioDto
    // 版本号按这一镜已导入几条累计，所以换一条底一定是新号，且比上一条大。
    expect(body.artifact?.version).toBeGreaterThan((await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: first.importedAmbienceArtifactId! } })).version)
    expect(body.importedAmbienceArtifactId).toBe(body.artifact?.id)
    expect(body.artifact?.id).not.toBe(first.importedAmbienceArtifactId)
    // 素材是人提供的，换一次不该把它销毁。
    expect(await env.db.mediaArtifact.findUnique({ where: { id: first.importedAmbienceArtifactId! } })).not.toBeNull()
  })

  it('clears only the bed on remove, leaving the dub and the pick in place', async () => {
    const dubId = (await env.db.storyboard.findUniqueOrThrow({ where: { id: spokenId }, select: { importedVoiceArtifactId: true } })).importedVoiceArtifactId
    const res = await removeImported(spokenId, 'ambience', editorToken)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: spokenId, audioSource: 'IMPORTED', importedAmbienceArtifactId: null })
    // 撤掉一条底不该连人声那条文件一起摘掉：两栏各自有指针，各清各的。
    expect(res.json().importedVoiceArtifactId).toBe(dubId)
    expect(dubId).not.toBeNull()

    const list = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(viewerToken) })
    const row = (list.json() as StoryboardListRow[]).find(item => item.id === spokenId)
    expect(row?.importedAmbience).toBeNull()
    expect(row?.importedVoice?.filename).toBe('配音_终版.wav')

    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=storyboard.remove-ambience-import', headers: authHeaders(ownerToken) })
    const events = audit.json().events as { entityId: string }[]
    expect(events.some(event => event.entityId === spokenId)).toBe(true)
  })

  it('409s removing a bed this shot never had', async () => {
    const res = await removeImported(muteId, 'ambience')
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/no imported ambience audio/)
  })

  it('reuses every guard the dub route has', async () => {
    const before = await env.db.mediaArtifact.count({ where: { storyboardId: spokenId, stage: 'AUDIO' } })
    expect((await importAmbience('does-not-exist', 'x.wav', wav(1))).statusCode).toBe(404)
    expect((await importAmbience(foreignStoryboardId, 'x.wav', wav(1), editorToken)).statusCode).toBe(404)
    expect((await importAmbience(spokenId, 'x.wav', wav(1), viewerToken)).statusCode).toBe(403)
    expect((await importAmbience(spokenId, '剧本.txt', Buffer.from('不是音频'))).statusCode).toBe(400)
    expect((await importAmbience(spokenId, '超大.wav', wav(2200))).statusCode).toBe(413)

    await env.db.storyboard.update({ where: { id: spokenId }, data: { supersededAt: new Date() } })
    try {
      expect((await importAmbience(spokenId, 'x.wav', wav(1))).statusCode).toBe(409)
    } finally {
      await env.db.storyboard.update({ where: { id: spokenId }, data: { supersededAt: null } })
    }
    // 被拒的导入不许留下半条文件：版本号与文件数都得原地不动。
    expect(await env.db.mediaArtifact.count({ where: { storyboardId: spokenId, stage: 'AUDIO' } })).toBe(before)
  })
})

// 四档不只是界面标签：合成门按档判「这一镜欠不欠人声」。这几条测的是选完档之后
// run-pipeline 的结论，而不是写库是否成功。
describe('composition gates follow the audio source', () => {
  /** 一镜有台词、一镜空镜，画面全部落地的集：剩下的只有声音这一道门。 */
  async function gateEpisode(name: string, line: string): Promise<{ projectId: string; episodeId: string; spoken: string; mute: string }> {
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string
    const episode = await env.app.inject({
      method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: `${name} EP1` },
    })
    expect(episode.statusCode).toBe(201)
    const episodeId = episode.json().id as string
    await env.db.scriptVersion.create({
      data: { episodeId, version: 1, content: '雨夜的滨江老城区，一桩离奇失踪案。', checksum: `gate:${episodeId}`, status: 'APPROVED' },
    })
    const add = async (number: number, dialogue: string) => {
      const created = await env.app.inject({
        method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken),
        payload: { number, title: `SB${number}`, durationMs: 5000, description: 'a street', dialogue },
      })
      expect(created.statusCode).toBe(201)
      return created.json().id as string
    }
    const spoken = await add(1, line)
    const mute = await add(2, '')
    // 上游三道当作「已跑过」，好让 run-pipeline 只剩合成这一步可判。
    for (const stage of ['SCRIPT', 'STORYBOARD', 'FIRST_FRAME'] as const) {
      await env.db.generationBatch.create({ data: { organizationId, episodeId, stage, status: 'COMPLETED', plannedCount: 2 } })
    }
    for (const storyboardId of [spoken, mute]) await seedTaskMedia(episodeId, storyboardId, 'VIDEO')
    return { projectId, episodeId, spoken, mute }
  }

  /** 一条已成功的任务加它的产物：合成门与镜头 DTO 读的都是这条血缘。 */
  async function seedTaskMedia(episodeId: string, storyboardId: string, stage: 'VIDEO' | 'AUDIO'): Promise<void> {
    const batch = await env.db.generationBatch.create({
      data: { organizationId, episodeId, stage, status: 'COMPLETED', plannedCount: 1, storyboards: { connect: { id: storyboardId } } },
    })
    const task = await env.db.generationTask.create({
      data: { organizationId, batchId: batch.id, stage, status: 'SUCCEEDED', storyboardId, idempotencyKey: `gate:${episodeId}:${stage}:${storyboardId}` },
    })
    await env.db.mediaArtifact.create({
      data: {
        organizationId, taskId: task.id, stage,
        objectKey: `${organizationId}/${episodeId}/${stage}/${task.id}/v1.${stage === 'AUDIO' ? 'wav' : 'mp4'}`,
        checksum: `${stage}-${task.id}`, mimeType: stage === 'AUDIO' ? 'audio/wav' : 'video/mp4', version: 1, durationMs: 5000,
      },
    })
  }

  async function bindTts(projectId: string): Promise<void> {
    const created = await env.app.inject({
      method: 'POST', url: '/api/providers/connections', headers: authHeaders(ownerToken),
      payload: { provider: 'mock', name: `gate-tts-${projectId}`, apiKey: 'test-key' },
    })
    expect(created.statusCode).toBe(201)
    const connection = created.json() as { id: string; capabilities: { id: string; model: string }[] }
    expect((await env.app.inject({ method: 'POST', url: `/api/providers/connections/${connection.id}/probe`, headers: authHeaders(ownerToken) })).statusCode).toBe(200)
    const capability = connection.capabilities.find(candidate => candidate.model === 'mock-tts')!
    const binding = await env.app.inject({
      method: 'POST', url: '/api/bindings', headers: authHeaders(ownerToken),
      payload: { slot: 'tts_voice', capabilityId: capability.id, projectId },
    })
    expect(binding.statusCode).toBe(201)
  }

  const runPipeline = (episodeId: string) => env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/run-pipeline`, headers: authHeaders(ownerToken) })

  it('exempts a native-only shot from the voice line it can never use', async () => {
    const { projectId, episodeId, spoken } = await gateEpisode('Gate Native Drama', '我跟你走。')
    await bindTts(projectId)
    // 排产一次配音但不落产物：这一镜欠一条人声，门必须拦。
    expect((await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/generations`, headers: authHeaders(ownerToken), payload: { stage: 'AUDIO' } })).statusCode).toBe(201)
    const blocked = await runPipeline(episodeId)
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().reasons).toEqual(['composition:missingVoice'])

    // 钦定「只用原声」后，这一镜本来就不出人声——同一条门必须为它让开。
    expect((await setSource(spoken, 'NATIVE')).statusCode).toBe(200)
    const res = await runPipeline(episodeId)
    expect(res.statusCode).toBe(201)
    expect(res.json().stage).toBe('COMPOSITION')
    // 空镜从未被算进欠账：它没台词，也没人替它选过档。
    expect(await env.db.generationTask.count({ where: { stage: 'AUDIO', status: 'SUCCEEDED' } })).toBe(0)
  })

  it('waits for the imported file a dialogue-free shot was promised, and releases on re-import', async () => {
    const { projectId, episodeId, spoken, mute } = await gateEpisode('Gate Import Drama', '这条街不能待了。')
    await bindTts(projectId)
    await seedTaskMedia(episodeId, spoken, 'AUDIO')

    // 空镜选了「配音」→ 只能来自导入件；文件被移除后这一档是空的，母带会静默没有这句。
    expect((await upload(mute, '街道环境声.wav', wav(2))).statusCode).toBe(201)
    expect((await setSource(mute, 'VOICE')).statusCode).toBe(200)
    expect((await env.app.inject({ method: 'DELETE', url: `/api/storyboards/${mute}/voice-import`, headers: authHeaders(ownerToken) })).statusCode).toBe(200)

    const blocked = await runPipeline(episodeId)
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().reasons).toEqual(['composition:missingImportedVoice'])
    expect(await env.db.composition.count({ where: { episodeId } })).toBe(0)

    expect((await upload(mute, '街道环境声_重导.wav', wav(2))).statusCode).toBe(201)
    const res = await runPipeline(episodeId)
    expect(res.statusCode).toBe(201)
    expect(res.json().stage).toBe('COMPOSITION')
  })

  it('re-cuts the master when the source changes and holds still when it does not', async () => {
    const { projectId, episodeId, spoken } = await gateEpisode('Gate Restale Drama', '这条街不能待了。')
    await bindTts(projectId)
    await seedTaskMedia(episodeId, spoken, 'AUDIO')

    expect((await runPipeline(episodeId)).statusCode).toBe(201)
    // 同一批镜头、同一套声音、没人改过主意——重出片只是白烧一次 ffmpeg。
    const held = await runPipeline(episodeId)
    expect(held.statusCode).toBe(409)
    expect(held.json().reasons).toEqual(['composition:alreadyPlanned'])

    // 改主意必须能重出片，即使镜头清单一个字没动。
    expect((await setSource(spoken, 'VOICE')).statusCode).toBe(200)
    const again = await runPipeline(episodeId)
    expect(again.statusCode).toBe(201)
    expect(again.json().stage).toBe('COMPOSITION')
    expect(await env.db.composition.count({ where: { episodeId } })).toBe(2)
  })
})

// 导入的音频念的往往不是剧本里那句，而字幕是硬烧进画面的：交付后改不掉，所以改文本
// 必须能在合成前做。这一组测的重点是「覆盖能否被清干净」——留下一个关不掉的覆盖，
// 比压根没有这个功能更糟。
describe('per-shot subtitle text', () => {
  const setSubtitle = (storyboardId: string, subtitleText: unknown, token = ownerToken) => env.app.inject({
    method: 'POST', url: `/api/storyboards/${storyboardId}/subtitle`, headers: authHeaders(token), payload: { subtitleText },
  })

  it('overrides the burned line without touching the script line', async () => {
    const res = await setSubtitle(spokenId, '你也要走？', editorToken)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: spokenId, subtitleText: '你也要走？' })

    const board = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/shotboard`, headers: authHeaders(viewerToken) })
    const shot = (board.json().shots as { id: string; dialogue: string; subtitleText: string | null }[]).find(item => item.id === spokenId)
    // 台词与字幕是两栏：改字幕不该顺手把剧本里那句话换掉。
    expect(shot).toMatchObject({ dialogue: '你也被困在这里了？', subtitleText: '你也要走？' })

    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=storyboard.set-subtitle', headers: authHeaders(ownerToken) })
    const events = audit.json().events as { entityId: string; payload: { subtitleText: string | null } }[]
    expect(events.some(event => event.entityId === spokenId && event.payload.subtitleText === '你也要走？')).toBe(true)
  })

  it('restores the dialogue on any blank: null, empty, and whitespace-only', async () => {
    for (const blank of [null, '', '   ']) {
      const cleared = await setSubtitle(spokenId, blank)
      expect(cleared.statusCode).toBe(200)
      expect(cleared.json().subtitleText).toBeNull()
      expect(await env.db.storyboard.findUniqueOrThrow({ where: { id: spokenId }, select: { subtitleText: true } })).toMatchObject({ subtitleText: null })
    }
    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events?action=storyboard.set-subtitle', headers: authHeaders(ownerToken) })
    const events = audit.json().events as { entityId: string; payload: { subtitleText: string | null } }[]
    expect(events.some(event => event.entityId === spokenId && event.payload.subtitleText === null)).toBe(true)
  })

  // 空镜也可以只有一行字幕——导入的音频念了什么，画面下沿就该写什么。
  it('accepts a line for a shot with no dialogue at all', async () => {
    const res = await setSubtitle(muteId, '（远处传来警笛）')
    expect(res.statusCode).toBe(200)
    expect((await env.db.storyboard.findUniqueOrThrow({ where: { id: muteId }, select: { dialogue: true, subtitleText: true } })).dialogue).toBe('')
  })

  it('refuses a body that forgot the field or sent the wrong type', async () => {
    const missing = await env.app.inject({ method: 'POST', url: `/api/storyboards/${spokenId}/subtitle`, headers: authHeaders(ownerToken), payload: {} })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toMatch(/null restores/)
    for (const wrong of [42, {}, true]) {
      const res = await setSubtitle(spokenId, wrong)
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/string or null/)
    }
    expect((await env.db.storyboard.findUniqueOrThrow({ where: { id: spokenId }, select: { subtitleText: true } })).subtitleText).toBeNull()
  })

  it('404s unknown and foreign shots, 403s viewers, 409s a superseded revision', async () => {
    expect((await setSubtitle('does-not-exist', '随便一句')).statusCode).toBe(404)
    expect((await setSubtitle(foreignStoryboardId, '随便一句', editorToken)).statusCode).toBe(404)

    const forbidden = await setSubtitle(spokenId, '随便一句', viewerToken)
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toMatch(/storyboard:write/)

    await env.db.storyboard.update({ where: { id: spokenId }, data: { supersededAt: new Date() } })
    try {
      const res = await setSubtitle(spokenId, '随便一句')
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/superseded/)
    } finally {
      await env.db.storyboard.update({ where: { id: spokenId }, data: { supersededAt: null } })
    }
  })
})
