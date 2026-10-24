import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MOCK_ASR_TEXT } from '@studio/providers'
import { startTestEnv, type TestEnv } from './env.js'

/**
 * US-033 转写与音画检查链路:绑 mock asr 后,逐镜转写钦定配音 → diff 台词 →
 * QualityFinding 落库(dimension:'asr' + 技术音频),无绑定时 409 明示缺能力。
 * 全链路 mock;真实转写(AC 的真实发音差异)需用户配 asr 模型的 key,不在本套内。
 */
let env: TestEnv
let ownerToken: string
let viewerToken: string
let organizationId: string
let boundProjectId: string
let episodeId: string
let shotAId: string
let shotBId: string
let masterlessEpisodeId: string
let unboundEpisodeId: string
let fallbackEpisodeId: string

const authHeaders = (token: string) => env.authHeaders(token)

/** 手写合法 WAV(全数字静音),不依赖 ffmpeg 造素材:mean_volume ≈ -91dB,必触发静音疑点。 */
function silentWav(seconds: number, sampleRate = 8000): Buffer {
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

function uploadVoice(storyboardId: string, filename: string, bytes: Buffer, token = ownerToken) {
  const boundary = '----studioasrtest'
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return env.app.inject({
    method: 'POST', url: `/api/storyboards/${storyboardId}/voice-import`,
    headers: { ...authHeaders(token), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload,
  })
}

/** 母带制品 + COMPLETED 合成:直接落库,绕开整条渲染链。 */
async function seedComposition(episodeId: string, fingerprint: string, seconds = 4): Promise<string> {
  const objectKey = `${organizationId}/${episodeId}/COMPOSITION/manual/v1.wav`
  const stored = await env.app.storage.put(objectKey, silentWav(seconds), 'audio/wav')
  const artifact = await env.db.mediaArtifact.create({
    data: { organizationId, stage: 'COMPOSITION', objectKey: stored.key, checksum: stored.checksum, mimeType: 'audio/wav', version: 1, durationMs: seconds * 1000 },
  })
  const composition = await env.db.composition.create({
    data: { episodeId, status: 'COMPLETED', manifest: '{}', artifactId: artifact.id, inputFingerprint: fingerprint },
  })
  return composition.id
}

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('asr-owner@example.com', 'ASR Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
  await env.register('asr-viewer@example.com', 'ASR Org')
  expect((await env.app.inject({ method: 'POST', url: '/api/members', headers: authHeaders(ownerToken), payload: { email: 'asr-viewer@example.com', role: 'VIEWER' } })).statusCode).toBe(201)
  const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'asr-viewer@example.com', password: 'password123', organizationId } })
  expect(login.statusCode).toBe(200)
  viewerToken = login.json().token as string

  const boundProject = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'ASR Drama' } })
  boundProjectId = boundProject.json().id as string
  const episode = await env.app.inject({
    method: 'POST', url: `/api/projects/${boundProjectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'EP1' },
  })
  episodeId = episode.json().id as string

  const addShot = async (number: number, dialogue: string) => {
    const res = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken),
      payload: { number, title: `SB${number}`, durationMs: 3000, description: 'a street', dialogue },
    })
    expect(res.statusCode).toBe(201)
    return res.json().id as string
  }
  shotAId = await addShot(1, '你也被困在这里了？')
  // 第二镜台词与 mock 的固定转写完全一致——干净路径必须一无所报。
  shotBId = await addShot(2, MOCK_ASR_TEXT)
  // 两镜都导入配音:路由逐镜转写,各拿各的 AUDIO 制品。
  expect((await uploadVoice(shotAId, 'shotA.wav', silentWav(3))).statusCode).toBe(201)
  expect((await uploadVoice(shotBId, 'shotB.wav', silentWav(3))).statusCode).toBe(201)
  await seedComposition(episodeId, 'fp-ep1')

  // 母带兜底用的集:同项目、无分镜无逐镜音频。
  const fallbackEpisode = await env.app.inject({
    method: 'POST', url: `/api/projects/${boundProjectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 2, title: 'EP2' },
  })
  fallbackEpisodeId = fallbackEpisode.json().id as string
  await seedComposition(fallbackEpisodeId, 'fp-ep2')

  // 无合成物的集。
  const masterless = await env.app.inject({
    method: 'POST', url: `/api/projects/${boundProjectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 3, title: 'EP3' },
  })
  masterlessEpisodeId = masterless.json().id as string

  // 未绑 asr 的项目:org 无组织级绑定 → asr:notBound。
  const unboundProject = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'No ASR Drama' } })
  const unboundEpisode = await env.app.inject({
    method: 'POST', url: `/api/projects/${unboundProject.json().id as string}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'EP1' },
  })
  unboundEpisodeId = unboundEpisode.json().id as string
  await seedComposition(unboundEpisodeId, 'fp-unbound')

  // 绑 mock asr:目录 mock 目录固定 12 行(别处断言),asr 行手插 capability 再绑槽。
  const created = await env.app.inject({
    method: 'POST', url: '/api/providers/connections', headers: authHeaders(ownerToken),
    payload: { provider: 'mock', name: 'mock-asr-conn', apiKey: 'test-key' },
  })
  expect(created.statusCode).toBe(201)
  const connection = created.json() as { id: string }
  expect((await env.app.inject({ method: 'POST', url: `/api/providers/connections/${connection.id}/probe`, headers: authHeaders(ownerToken) })).statusCode).toBe(200)
  const capability = await env.db.modelCapability.create({
    data: { connectionId: connection.id, model: 'mock-asr', displayName: 'Mock ASR', modality: 'asr', probeStatus: 'verified', credentialVerifiedAt: new Date() },
  })
  const binding = await env.app.inject({
    method: 'POST', url: '/api/bindings', headers: authHeaders(ownerToken),
    payload: { slot: 'audio_transcribe', capabilityId: capability.id, projectId: boundProjectId },
  })
  expect(binding.statusCode).toBe(201)
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

const review = (id: string, token = ownerToken) => env.app.inject({ method: 'POST', url: `/api/episodes/${id}/audio-review`, headers: authHeaders(token) })

describe('audio review (US-033)', () => {
  it('409s with asr:notBound when no transcription capability is bound for the project', async () => {
    const res = await review(unboundEpisodeId)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'asr:notBound' })
  })

  it('404s unknown episodes and 403s viewers, and 409s an episode with nothing composed', async () => {
    expect((await review('does-not-exist')).statusCode).toBe(404)
    const forbidden = await review(episodeId, viewerToken)
    expect(forbidden.statusCode).toBe(403)
    const empty = await review(masterlessEpisodeId)
    expect(empty.statusCode).toBe(409)
    expect(empty.json().error).toMatch(/no completed composition/)
  })

  it('transcribes the pinned per-shot audio, files asr diff findings, and keeps a matching shot silent', async () => {
    const res = await review(episodeId)
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      compositionId: string
      fingerprint: string
      transcriptedShots: number
      findings: Array<{ findingKey: string; dimension: string; severity: string; message: string; evidenceTimeSeconds: number | null; storyboardId: string | null }>
    }
    expect(body.transcriptedShots).toBe(2)
    expect(body.fingerprint).toBe('fp-ep1')

    // 台词与 mock 固定转写不同的那一镜:一句 missing(warning,无定位)+ 两段 extra(info,带段起始秒)。
    const shotA = body.findings.filter(finding => finding.findingKey.startsWith(`asr:${shotAId}:`))
    expect(shotA.map(finding => finding.severity).sort()).toEqual(['info', 'info', 'warning'])
    const missing = shotA.find(finding => finding.severity === 'warning')!
    expect(missing.message).toMatch(/line not heard/)
    // FR-Q06:无段定位的 missing 不伪造时间。
    expect(missing.evidenceTimeSeconds).toBeNull()
    const extras = shotA.filter(finding => finding.severity === 'info')
    expect(extras.every(finding => finding.message.includes('unexpected speech'))).toBe(true)
    expect(extras.map(finding => finding.evidenceTimeSeconds).sort()).toEqual([0, 1.5])

    // 与转写一致的那一镜一条不报。
    expect(body.findings.filter(finding => finding.findingKey.startsWith(`asr:${shotBId}:`))).toEqual([])

    // 技术音频:数字静音母带必触静音疑点。
    const silence = body.findings.find(finding => finding.findingKey === 'audio_silence')
    expect(silence).toMatchObject({ dimension: 'audio', severity: 'warning' })

    // 全部落库,指纹=合成指纹,维度/键与响应一致。
    const rows = await env.db.qualityFinding.findMany({ where: { compositionId: body.compositionId } })
    expect(rows.map(row => row.findingKey).sort()).toEqual(body.findings.map(finding => finding.findingKey).sort())
    expect(new Set(rows.map(row => row.fingerprint))).toEqual(new Set(['fp-ep1']))
    expect(rows.every(row => ['asr', 'audio'].includes(row.dimension))).toBe(true)
  }, 60_000)

  it('falls back to transcribing the master once when no shot has pinned audio', async () => {
    const res = await review(fallbackEpisodeId)
    expect(res.statusCode).toBe(200)
    const body = res.json() as { compositionId: string; transcriptedShots: number; findings: Array<{ findingKey: string; severity: string; evidenceTimeSeconds: number | null }> }
    expect(body.transcriptedShots).toBe(1)
    // 无台词可对 → 每段都是 extra(info),键落 asr:master:{i},时间取段起始秒。
    const masterFindings = body.findings.filter(finding => finding.findingKey.startsWith('asr:master:'))
    expect(masterFindings.length).toBe(2)
    expect(masterFindings.every(finding => finding.severity === 'info')).toBe(true)
    expect(masterFindings.map(finding => finding.evidenceTimeSeconds).sort()).toEqual([0, 2])
    expect(await env.db.qualityFinding.count({ where: { compositionId: body.compositionId, findingKey: { startsWith: 'asr:master:' } } })).toBe(2)
  }, 60_000)

  it('re-runs refresh the facts without duplicating rows or erasing a human decision', async () => {
    const first = await review(episodeId)
    expect(first.statusCode).toBe(200)
    const compositionId = (first.json() as { compositionId: string }).compositionId
    const before = await env.db.qualityFinding.findMany({ where: { compositionId } })
    expect(before.length).toBeGreaterThan(0)

    const decided = before[0]!
    await env.db.qualityFinding.update({ where: { id: decided.id }, data: { status: 'accepted', decidedBy: 'human', reason: 'checked by ear' } })

    const second = await review(episodeId)
    expect(second.statusCode).toBe(200)
    const after = await env.db.qualityFinding.findMany({ where: { compositionId } })
    // (compositionId, findingKey) 去重:重跑不新增行。
    expect(after.length).toBe(before.length)
    const preserved = after.find(row => row.id === decided.id)!
    expect(preserved.status).toBe('accepted')
    expect(preserved.decidedBy).toBe('human')
  }, 60_000)
})
