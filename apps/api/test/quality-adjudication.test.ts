import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Stage } from '@studio/db'
import { startTestEnv, type TestEnv } from './env.js'

/**
 * US-034 质量问题队列与人工裁决——AC19「问题可定位、可接受有理由,修复后旧证据失效」。
 * 母带用 ffmpeg testsrc 生成真实可解码 mp4(带正弦音轨,避免 no_audio_track 噪声),
 * artifact.durationMs 故意写 10000(实际 1s)让技术检查稳定产出 duration_mismatch
 * warning——这就是本套用例裁决的对象。
 */

interface FindingDto {
  id: string
  findingKey: string
  dimension: string
  severity: string
  message: string
  evidenceTimeSeconds: number | null
  status: string
  decidedBy: string | null
  reason: string | null
}

let env: TestEnv
let ownerToken: string
let outsiderToken: string
let organizationId: string
let projectId: string
let episodeId: string
let storyboardIds: string[] = []
let masterObjectKey: string
let compositionId: string
/** duration_mismatch warning 的 QualityFinding 行 id,各用例按序接力使用。 */
let warningFindingId: string
/** 生成时实际写进存储的母带好字节,(e) 破坏后用于恢复。 */
let goodMasterBytes: Uint8Array

const objectKey = (stage: string, storyboard: string, file: string): string =>
  `${organizationId}/${projectId}/${episodeId}/${stage}/${storyboard}/${file}`

/** 每镜一颗成功 VIDEO 制品——交付门禁按「该镜有成功切片」放行。 */
async function seedStoryboardVideo(index: number) {
  const storyboardId = storyboardIds[index]!
  const batch = await env.db.generationBatch.create({
    data: {
      organizationId,
      episodeId,
      stage: 'VIDEO',
      status: 'COMPLETED',
      plannedCount: 1,
      storyboards: { connect: [{ id: storyboardId }] },
    },
  })
  const task = await env.db.generationTask.create({
    data: { organizationId, batchId: batch.id, stage: 'VIDEO' as Stage, status: 'SUCCEEDED', storyboardId },
  })
  return env.db.mediaArtifact.create({
    data: {
      organizationId,
      taskId: task.id,
      stage: 'VIDEO',
      objectKey: objectKey('video', `sb${index + 1}`, 'v1.mp4'),
      checksum: `video-sb${index + 1}`,
      mimeType: 'video/mp4',
      version: 1,
      width: 1280,
      height: 720,
      durationMs: 4000 + index * 1000,
    },
  })
}

beforeAll(async () => {
  env = await startTestEnv()

  const owner = await env.register('qa-adjudicator@example.com', 'QA Adjudication Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
  const outsider = await env.register('qa-outsider@example.com', 'Rival QA Org')
  outsiderToken = outsider.token

  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: env.authHeaders(ownerToken), payload: { name: 'QA Drama' } })
  expect(project.statusCode).toBe(201)
  projectId = project.json().id as string

  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: env.authHeaders(ownerToken), payload: { number: 1, title: 'EP1' } })
  expect(episode.statusCode).toBe(201)
  episodeId = episode.json().id as string

  for (const [number, title] of [[1, 'SB1'], [2, 'SB2']] as const) {
    const storyboard = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: env.authHeaders(ownerToken),
      payload: { number, title, durationMs: 4000 + number * 1000, description: `${title} scene`, sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(storyboard.statusCode).toBe(201)
    storyboardIds.push(storyboard.json().id as string)
  }
  await seedStoryboardVideo(0)
  await seedStoryboardVideo(1)

  // 母带:真实 1 秒 mp4(视频 + 正弦音轨),行上 durationMs 记 10000 → reviews 的
  // expectedDurationMs 与实际差 9s,稳定产出 duration_mismatch warning(无 blocking)。
  const masterArtifact = await env.db.mediaArtifact.create({
    data: {
      organizationId,
      stage: 'COMPOSITION',
      objectKey: `${organizationId}/${projectId}/${episodeId}/composition/master/v1.mp4`,
      checksum: 'qa-master-checksum',
      mimeType: 'video/mp4',
      version: 1,
      durationMs: 10000,
    },
  })
  masterObjectKey = masterArtifact.objectKey
  {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const os = await import('node:os')
    const path = await import('node:path')
    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const dir = await mkdtemp(path.join(os.tmpdir(), 'qa-master-'))
    try {
      const file = path.join(dir, 'master.mp4')
      await promisify(execFile)('ffmpeg', [
        '-y', '-v', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
      ], { timeout: 60_000 })
      goodMasterBytes = new Uint8Array(await readFile(file))
      await env.app.storage.put(masterObjectKey, goodMasterBytes, 'video/mp4')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  // 编辑 head 指纹 fp-original;合成绑定同一指纹——裁决与快照由此对齐。
  const edit = await env.db.episodeEdit.create({
    data: {
      episodeId,
      organizationId,
      headRevision: 1,
      revisions: { create: { revision: 1, fpsNum: 25, fpsDen: 1, clips: '[]', tracks: '[]', outputSpec: '{}', fingerprint: 'fp-original', author: 'test' } },
    },
  })
  expect(edit.headRevision).toBe(1)

  const composition = await env.db.composition.create({
    data: {
      episodeId,
      status: 'COMPLETED',
      manifest: JSON.stringify({ storyboardIds }),
      artifactId: masterArtifact.id,
      inputFingerprint: 'fp-original',
    },
  })
  compositionId = composition.id
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

const authHeaders = (token: string) => env.authHeaders(token)

const packageDelivery = () =>
  env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/deliveries`, headers: authHeaders(ownerToken) })

const runReview = () =>
  env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/reviews`, headers: authHeaders(ownerToken) })

const listFindings = () =>
  env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/quality-findings`, headers: authHeaders(ownerToken) })

const adjudicate = (id: string, payload: Record<string, unknown>, token = ownerToken) =>
  env.app.inject({ method: 'PATCH', url: `/api/quality-findings/${id}`, headers: authHeaders(token), payload })

describe('US-034 quality findings queue and adjudication', () => {
  it('(a) persists review findings as adjudicable rows in sync with the manifest', async () => {
    const review = await runReview()
    expect(review.statusCode).toBe(200)
    const reviewed = review.json() as { compositionId: string; passed: boolean; findings: Array<{ id: string; severity: string; dimension: string }> }
    expect(reviewed.compositionId).toBe(compositionId)
    expect(reviewed.passed).toBe(true)
    expect(reviewed.findings.some(finding => finding.id === 'duration_mismatch' && finding.severity === 'warning')).toBe(true)

    // manifest 与 QualityFinding 行是同一份结论的两个落点。
    const manifest = JSON.parse((await env.db.composition.findUniqueOrThrow({ where: { id: compositionId } })).manifest) as { qualityCheckPassed: boolean; qualityFindings: Array<{ id: string }> }
    expect(manifest.qualityCheckPassed).toBe(true)
    const rows = await env.db.qualityFinding.findMany({ where: { compositionId } })
    expect(rows.map(row => row.findingKey).sort()).toEqual(manifest.qualityFindings.map(finding => `technical:${finding.id}`).sort())

    const warning = rows.find(row => row.findingKey === 'technical:duration_mismatch')!
    expect(warning).toBeDefined()
    expect(warning.status).toBe('open')
    expect(warning.severity).toBe('warning')
    expect(warning.fingerprint).toBe('fp-original')
    expect(warning.episodeId).toBe(episodeId)
    expect(warning.organizationId).toBe(organizationId)
    warningFindingId = warning.id

    const list = await listFindings()
    expect(list.statusCode).toBe(200)
    const listed = list.json() as { compositionId: string; passed: boolean; fingerprint: string | null; currentFingerprint: string | null; stale: boolean; findings: FindingDto[] }
    expect(listed.compositionId).toBe(compositionId)
    expect(listed.passed).toBe(true)
    expect(listed.fingerprint).toBe('fp-original')
    expect(listed.currentFingerprint).toBe('fp-original')
    expect(listed.stale).toBe(false)
    expect(listed.findings.some(finding => finding.id === warningFindingId && finding.status === 'open')).toBe(true)
  })

  it('(b) blocks packaging until every warning/info finding is adjudicated, then passes after accept', async () => {
    const blocked = await packageDelivery()
    expect(blocked.statusCode).toBe(409)
    const body = blocked.json() as { error: string; reasons: string[]; nextAction?: string }
    expect(body.error).toBe('delivery:qualityGate')
    expect(body.reasons.some(reason => reason.includes('technical:duration_mismatch'))).toBe(true)
    expect(body.reasons.some(reason => reason.includes('duration'))).toBe(true)
    expect(body.nextAction).toBe('adjudicate')
    expect(await env.db.delivery.count({ where: { episodeId } })).toBe(0)

    // 门禁要求「全部 warning/info 清空」——把队列里每条 open 都带理由接受掉。
    const openRows = await env.db.qualityFinding.findMany({ where: { compositionId, status: 'open' } })
    expect(openRows.some(row => row.id === warningFindingId)).toBe(true)
    for (const row of openRows) {
      const accept = await adjudicate(row.id, { action: 'accept', reason: '  时长口径已知,接受出货  ' })
      expect(accept.statusCode).toBe(200)
      const accepted = (accept.json() as { finding: FindingDto }).finding
      expect(accepted.status).toBe('accepted')
      expect(accepted.reason).toBe('时长口径已知,接受出货')
      expect(typeof accepted.decidedBy).toBe('string')
    }

    // 已接受再接受 → 409,裁决一次性。
    const again = await adjudicate(warningFindingId, { action: 'accept', reason: '再次接受' })
    expect(again.statusCode).toBe(409)

    const pack = await packageDelivery()
    expect(pack.statusCode).toBe(201)

    const audit = await env.app.inject({ method: 'GET', url: '/api/audit-events', headers: authHeaders(ownerToken) })
    expect(audit.statusCode).toBe(200)
    const events = audit.json().events as { action: string; entityType: string; entityId: string }[]
    expect(events.some(event => event.action === 'quality-finding.accept' && event.entityType === 'QualityFinding' && event.entityId === warningFindingId)).toBe(true)
  })

  it('(c) invalidates the accept when the composition is re-rendered (fingerprint moves)', async () => {
    // 重渲染记在同一合成行上:inputFingerprint 前进,旧裁决不再覆盖当前母带。
    await env.db.composition.update({ where: { id: compositionId }, data: { inputFingerprint: 'fp-render-2' } })

    const list = await listFindings()
    expect(list.statusCode).toBe(200)
    const listed = list.json() as { stale: boolean; fingerprint: string | null; currentFingerprint: string | null; findings: FindingDto[] }
    expect(listed.stale).toBe(true)
    expect(listed.fingerprint).toBe('fp-render-2')
    expect(listed.currentFingerprint).toBe('fp-original')
    // 惰性 stale 落库(不只是返回时标志)——审计可查。
    expect(listed.findings.find(finding => finding.id === warningFindingId)!.status).toBe('stale')
    expect((await env.db.qualityFinding.findUniqueOrThrow({ where: { id: warningFindingId } })).status).toBe('stale')

    const pack = await packageDelivery()
    expect(pack.statusCode).toBe(409)
    const body = pack.json() as { error: string; reasons: string[]; nextAction?: string }
    expect(body.error).toBe('delivery:qualityGate')
    expect(body.reasons.some(reason => reason.includes('technical:duration_mismatch'))).toBe(true)
    expect(body.nextAction).toBe('adjudicate')
  })

  it('(d) validates adjudication input, organization scope and staleness', async () => {
    const noReason = await adjudicate(warningFindingId, { action: 'accept' })
    expect(noReason.statusCode).toBe(400)
    expect((noReason.json() as { code: string }).code).toBe('invalid_argument')
    const blankReason = await adjudicate(warningFindingId, { action: 'accept', reason: '   ' })
    expect(blankReason.statusCode).toBe(400)
    const badAction = await adjudicate(warningFindingId, { action: 'dismiss', reason: 'why not' })
    expect(badAction.statusCode).toBe(400)

    // 跨组织: outsider 通过 RBAC(自己是 owner)但行不可见。
    const foreign = await adjudicate(warningFindingId, { action: 'accept', reason: 'rival accepts' }, outsiderToken)
    expect(foreign.statusCode).toBe(404)
    expect((await env.db.qualityFinding.findUniqueOrThrow({ where: { id: warningFindingId } })).status).toBe('stale')

    // stale 裁决 → 409 version_conflict,提示重检。
    const stale = await adjudicate(warningFindingId, { action: 'accept', reason: '过期证据也想接受' })
    expect(stale.statusCode).toBe(409)
    const staleBody = stale.json() as { code: string; nextAction?: string }
    expect(staleBody.code).toBe('version_conflict')
    expect(staleBody.nextAction).toBe('review')
    const missing = await adjudicate('does-not-exist', { action: 'accept', reason: 'nope' })
    expect(missing.statusCode).toBe(404)
    expect((await env.app.inject({ method: 'PATCH', url: `/api/quality-findings/${warningFindingId}`, payload: { action: 'accept', reason: 'no auth' } })).statusCode).toBe(401)
  })

  it('(e) never lets a human accept a blocking finding through the gate', async () => {
    // 破坏母带 → reviews 判 probe_failed/blocking;人工可以登记接受理由,但门禁
    // 不认——blocking 是硬约束,唯一出路是修好母带重检。
    const corrupt = new TextEncoder().encode('this is not an mp4 — blocking for the hard-gate test')
    await env.app.storage.put(masterObjectKey, corrupt, 'video/mp4')
    try {
      const review = await runReview()
      expect(review.statusCode).toBe(200)
      const reviewed = review.json() as { passed: boolean; findings: Array<{ id: string; severity: string }> }
      expect(reviewed.passed).toBe(false)
      expect(reviewed.findings.some(finding => finding.id === 'probe_failed' && finding.severity === 'blocking')).toBe(true)

      const blockingRow = await env.db.qualityFinding.findFirstOrThrow({ where: { compositionId, findingKey: 'technical:probe_failed' } })
      expect(blockingRow.status).toBe('open')

      const accept = await adjudicate(blockingRow.id, { action: 'accept', reason: '人工豁免请求' })
      expect(accept.statusCode).toBe(200)
      expect((accept.json() as { finding: FindingDto }).finding.status).toBe('accepted')

      const pack = await packageDelivery()
      expect(pack.statusCode).toBe(409)
      const body = pack.json() as { error: string; reasons: string[]; nextAction?: string }
      expect(body.error).toBe('delivery:qualityGate')
      expect(body.reasons.some(reason => reason.includes('file'))).toBe(true)
      expect(body.nextAction).toBeUndefined()
    } finally {
      // 修好母带重检:门禁结论随实际状态更新;旧的 warning 裁决在新检查下重建。
      await env.app.storage.put(masterObjectKey, goodMasterBytes, 'video/mp4')
      const restored = await runReview()
      expect(restored.statusCode).toBe(200)
      expect((restored.json() as { passed: boolean }).passed).toBe(true)
    }
  })
})
