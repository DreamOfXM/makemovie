import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MediaArtifact, Prisma, Stage, TaskStatus } from '@studio/db'
import type { CompositionReviewReadings } from '@studio/pipeline'
import { startTestEnv, type TestEnv } from './env.js'

interface ManifestArtifact {
  stage: Stage | null
  objectKey: string
  checksum: string
  mimeType: string
  version: number
  width: number | null
  height: number | null
  durationMs: number | null
}

interface ManifestAcceptance {
  acceptedAt?: string
  rejectedAt?: string
  reason: string | null
}

interface DeliveryManifest {
  schemaVersion: number
  packagedAt: string
  episode: { id: string; number: number; title: string }
  source: { version: number; checksum: string; status: string } | null
  script: { version: number; checksum: string; status: string } | null
  storyboards: { number: number; title: string; durationMs: number; artifacts: ManifestArtifact[] }[]
  labeling: { standard: string; badgeText: string; explicit: string; implicit: string; reason?: string } | null
  postProcess: { status: string; steps: { step: string; outcome: string; reason?: string }[]; loudness?: { before: { i: number; tp: number }; after?: { i: number; tp: number } }; target?: { i: number; tp: number }; reason?: string } | null
  composition: { objectKey: string; checksum: string; mimeType: string; durationMs: number | null; tracks: ManifestArtifact[] }
  quality: { checks: number; approved: number; rejected: number; threshold: number }
  review: CompositionReviewReadings
  acceptance?: ManifestAcceptance
}

interface DeliveryDto {
  id: string
  status: string
  manifest: DeliveryManifest
}

interface SeedArtifact {
  stage: Stage
  objectKey: string
  checksum: string
  mimeType: string
  version: number
  width?: number | null
  height?: number | null
  durationMs?: number | null
}

let env: TestEnv
let ownerToken: string
let editorToken: string
let viewerToken: string
let outsiderToken: string
let organizationId: string
let projectId: string
let episodeId: string
let storyboardIds: string[] = []

let masterArtifactId: string
let masterObjectKey: string
let deliveryOneId: string
let deliveryTwoId: string
let packagedManifest: DeliveryManifest

// Fixed offsets keep "newest task first" deterministic inside one test run.
const clock = Date.now()
const at = (secondsAgo: number): Date => new Date(clock - secondsAgo * 1000)

const objectKey = (stage: string, storyboard: string, file: string): string =>
  `${organizationId}/${projectId}/${episodeId}/${stage}/${storyboard}/${file}`

/**
 * 合成整集时 worker 回写的母带台账——S5 验收三读数的唯一输入：逐镜跨度（一刀表）、
 * 排队定格的 `resolved.shots`（台词与转场列）、按 storyboardId 记账的声音台账。
 * 种子必须按 worker 的形状写全：只给 `storyboardIds` 是读数上线前的旧合成，
 * 那种交付按设计停在草稿，拿它测「能验收」等于测一个不存在的路径。
 */
function masterLedger(): Record<string, unknown> {
  const shots = storyboardIds.map((storyboardId, index) => ({
    storyboardId,
    clipId: null,
    videoArtifactId: `video-seed-${index}`,
    videoSource: 'generated',
    dialogue: index === 0 ? '第一句台词' : '',
    subtitle: index === 0 ? '第一句台词' : '',
    audioSource: index === 0 ? 'voice' : 'native',
    voiceArtifactId: index === 0 ? 'voice-seed' : null,
    transition: 'cut',
    transitionMs: 0,
  }))
  return {
    storyboardIds,
    resolved: { musicArtifactId: null, shots },
    // 声音台账记的是「这一条人声真的被读进了本次渲染」，与排队快照分开：件后来被删时
    // 快照仍有 id，拿快照判静音等于永远判不出 SD-181。
    audio: Object.fromEntries(shots.map(shot => [shot.storyboardId, {
      mode: shot.audioSource,
      voiceArtifactId: shot.voiceArtifactId,
      ambienceArtifactId: null,
    }])),
    beds: [],
    cuts: {
      fps: 25, clipMs: [4000, 5000], kindAt: ['cut', 'cut'], overlapMs: [0, 0],
      shotStartMs: [0, 4000], headFadeMs: 0, tailFadeMs: 0, totalMs: 9000, storyboardIds, blended: false,
    },
  }
}

async function seedTask(
  stage: Stage,
  storyboardIndexes: number[],
  artifacts: SeedArtifact[],
  options: { status?: TaskStatus; createdAt?: Date } = {},
) {
  const batch = await env.db.generationBatch.create({
    data: {
      organizationId,
      episodeId,
      stage,
      status: options.status === 'SUCCEEDED' || !options.status ? 'COMPLETED' : 'BLOCKED',
      plannedCount: Math.max(storyboardIndexes.length, 1),
      storyboards: { connect: storyboardIndexes.map(index => ({ id: storyboardIds[index]! })) },
    },
  })
  // One shot per call: the gate and the manifest both read a task's media off its
  // own storyboardId, so a task without one belongs to no shot and is invisible.
  const task = await env.db.generationTask.create({
    data: {
      organizationId,
      batchId: batch.id,
      stage,
      status: options.status ?? 'SUCCEEDED',
      createdAt: options.createdAt ?? at(0),
      storyboardId: storyboardIds[storyboardIndexes[0]!] ?? null,
    },
  })
  const created: MediaArtifact[] = []
  for (const artifact of artifacts) {
    created.push(await env.db.mediaArtifact.create({
      data: {
        organizationId,
        taskId: task.id,
        stage: artifact.stage,
        objectKey: artifact.objectKey,
        checksum: artifact.checksum,
        mimeType: artifact.mimeType,
        version: artifact.version,
        width: artifact.width ?? null,
        height: artifact.height ?? null,
        durationMs: artifact.durationMs ?? null,
      },
    }))
  }
  return { batch, task, artifacts: created }
}

beforeAll(async () => {
  env = await startTestEnv()

  const owner = await env.register('delivery-owner@example.com', 'Delivery Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
  const outsider = await env.register('delivery-outsider@example.com', 'Rival Org')
  outsiderToken = outsider.token
  await env.register('delivery-editor@example.com', 'Delivery Editor Org')
  await env.register('delivery-viewer@example.com', 'Delivery Viewer Org')
  for (const [email, role] of [['delivery-editor@example.com', 'EDITOR'], ['delivery-viewer@example.com', 'VIEWER']] as const) {
    const added = await env.app.inject({ method: 'POST', url: '/api/members', headers: env.authHeaders(ownerToken), payload: { email, role } })
    expect(added.statusCode).toBe(201)
    const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123', organizationId } })
    expect(login.statusCode).toBe(200)
    if (role === 'EDITOR') editorToken = login.json().token as string
    else viewerToken = login.json().token as string
  }

  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: env.authHeaders(ownerToken), payload: { name: 'Delivery Drama' } })
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
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

const authHeaders = (token: string) => env.authHeaders(token)

const createDelivery = async (token: string) =>
  env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/deliveries`, headers: authHeaders(token) })

describe('delivery acceptance gate', () => {
  it('refuses an episode with no composition and says so in one line', async () => {
    const res = await createDelivery(editorToken)
    expect(res.statusCode).toBe(409)
    const body = res.json() as { error: string; reasons: string[]; shotNumbers: number[] }
    expect(body.error).toBe('delivery:notReady')
    expect(body.reasons).toEqual(['delivery.gap.noComposition'])
    expect(body.shotNumbers).toEqual([])
    expect(await env.db.delivery.count({ where: { episodeId } })).toBe(0)

    const missing = await env.app.inject({ method: 'POST', url: '/api/episodes/does-not-exist/deliveries', headers: authHeaders(editorToken) })
    expect(missing.statusCode).toBe(404)
  })

  it('refuses while a live shot is not in the master, and names it', async () => {
    const master = await env.db.mediaArtifact.create({
      data: {
        organizationId,
        stage: 'COMPOSITION',
        objectKey: `${organizationId}/${projectId}/${episodeId}/composition/master/v1.mp4`,
        checksum: 'master-checksum',
        mimeType: 'video/mp4',
        version: 1,
        durationMs: 9000,
      },
    })
    masterArtifactId = master.id
    masterObjectKey = master.objectKey
    // V07:打包门禁会对母带跑真实技术检查——测试种子必须放一份真实可解码的
    // mp4 字节,而不是只建 DB 行(那是复现「损坏文件也能打包」的老前提)。
    {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const os = await import('node:os')
      const path = await import('node:path')
      const { mkdtemp, readFile, rm } = await import('node:fs/promises')
      const dir = await mkdtemp(path.join(os.tmpdir(), 'delivery-master-'))
      try {
        const file = path.join(dir, 'master.mp4')
        await promisify(execFile)('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=9:size=320x240:rate=25', '-pix_fmt', 'yuv420p', file], { timeout: 60_000 })
        await env.app.storage.put(masterObjectKey, new Uint8Array(await readFile(file)), 'video/mp4')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
    await env.db.composition.create({
      data: {
        episodeId,
        status: 'COMPLETED',
        durationMs: 9000,
        // The compose worker's labeling + quality-floor records, as the worker writes them.
        manifest: JSON.stringify({
          ...masterLedger(),
          // 母带只切进了第一镜——第二镜是后来补的分镜，还没进过任何一版母带。
          storyboardIds: [storyboardIds[0]],
          labeling: { standard: 'GB 45438-2025', badgeText: 'AI生成内容 · AI-Generated Content', explicit: 'burned', implicit: 'written' },
          postProcess: { status: 'applied', steps: [{ step: 'loudnorm', outcome: 'applied' }], loudness: { before: { i: -3.2, tp: 0.1 }, after: { i: -16.1, tp: -1.5 } }, target: { i: -16, tp: -1.5 } },
        }),
        artifactId: master.id,
      },
    })

    await seedTask('FIRST_FRAME', [0], [{
      stage: 'FIRST_FRAME', objectKey: objectKey('first-frame', 'sb1', 'v1.png'), checksum: 'ff-sb1', mimeType: 'image/png', version: 1, width: 1280, height: 720,
    }], { createdAt: at(120) })
    await seedTask('VIDEO', [0], [{
      stage: 'VIDEO', objectKey: objectKey('video', 'sb1', 'v1.mp4'), checksum: 'video-sb1', mimeType: 'video/mp4', version: 1, width: 1280, height: 720, durationMs: 5000,
    }], { createdAt: at(60) })
    // A clip the storyboard never got, plus an attempt that failed: neither may open the gate.
    await seedTask('VIDEO', [1], [{
      stage: 'VIDEO', objectKey: objectKey('video', 'sb2', 'failed.mp4'), checksum: 'video-sb2-failed', mimeType: 'video/mp4', version: 1,
    }], { status: 'FAILED', createdAt: at(30) })

    const res = await createDelivery(editorToken)
    expect(res.statusCode).toBe(409)
    const body = res.json() as { error: string; reasons: string[]; shotNumbers: number[] }
    expect(body.error).toBe('delivery:notReady')
    expect(body.reasons).toEqual(['delivery.gap.shotNoClip'])
    expect(body.shotNumbers).toEqual([2])
    expect(await env.db.delivery.count({ where: { episodeId } })).toBe(0)
  })

  it('opens the gate on what the master actually contains, not on per-shot VIDEO tasks', async () => {
    // SD-191：字卡镜、导入片段和编辑文档钦定的 cut 都不挂在逐镜生成任务下。旧口径按
    // 「这一镜有没有 SUCCEEDED 的 VIDEO 任务」判画面，于是母带已经出了、打包却永远说
    // 缺镜头（实测一集 63 镜报 30 镜）。这里第二镜只有一条 FAILED 的 VIDEO 任务，
    // 母带台账却把它算在内了——门必须开。
    const composition = await env.db.composition.findFirstOrThrow({ where: { episodeId } })
    const ledger = JSON.parse(composition.manifest) as Record<string, unknown>
    await env.db.composition.update({
      where: { id: composition.id },
      data: { manifest: JSON.stringify({ ...ledger, storyboardIds }) },
    })
    const res = await createDelivery(editorToken)
    expect(res.json().error).not.toBe('delivery:notReady')
    expect(res.statusCode).toBe(201)
    // 后面那条用例从「还没有交付包」起步，这里只是取证，不留行。
    await env.db.delivery.deleteMany({ where: { episodeId } })
  })

  it('packages every storyboard artifact, the composition and the quality counts', async () => {
    await seedTask('FIRST_FRAME', [1], [{
      stage: 'FIRST_FRAME', objectKey: objectKey('first-frame', 'sb2', 'v1.png'), checksum: 'ff-sb2', mimeType: 'image/png', version: 1, width: 1280, height: 720,
    }], { createdAt: at(120) })
    await seedTask('VIDEO', [1], [{
      stage: 'VIDEO', objectKey: objectKey('video', 'sb2', 'v1.mp4'), checksum: 'video-sb2-v1', mimeType: 'video/mp4', version: 1, width: 1280, height: 720, durationMs: 6000,
    }], { createdAt: at(60) })
    await seedTask('VIDEO', [1], [{
      stage: 'VIDEO', objectKey: objectKey('video', 'sb2', 'v2.mp4'), checksum: 'video-sb2-v2', mimeType: 'video/mp4', version: 2, width: 1280, height: 720, durationMs: 6100,
    }], { createdAt: at(30) })

    // Versions are picked by number, not by insertion order.
    for (const [version, checksum, status] of [[1, 'source-1', 'DRAFT'], [2, 'source-2', 'APPROVED']] as const) {
      await env.db.sourceDocumentVersion.create({ data: { episodeId, version, content: `source v${version}`, checksum, status } })
    }
    for (const [version, checksum] of [[3, 'script-3'], [1, 'script-1'], [2, 'script-2']] as const) {
      await env.db.scriptVersion.create({ data: { episodeId, version, content: `script v${version}`, checksum, status: 'DRAFT' } })
    }

    const sb1Video = await env.db.mediaArtifact.findFirstOrThrow({ where: { stage: 'VIDEO', checksum: 'video-sb1' } })
    const sb2VideoV1 = await env.db.mediaArtifact.findFirstOrThrow({ where: { stage: 'VIDEO', checksum: 'video-sb2-v1' } })
    const sb1VideoBatch = await env.db.generationBatch.findFirstOrThrow({ where: { stage: 'VIDEO', tasks: { some: { id: sb1Video.taskId ?? '' } } } })
    const sourceV1 = await env.db.sourceDocumentVersion.findFirstOrThrow({ where: { episodeId, version: 1 } })
    const checks: Prisma.QualityCheckCreateInput[] = [
      { status: 'APPROVED', kind: 'visual', score: 0.9, report: '{}', artifact: { connect: { id: sb1Video.id } } },
      { status: 'NEEDS_REVIEW', kind: 'visual', score: 0.2, report: '{}', artifact: { connect: { id: sb2VideoV1.id } } },
      { status: 'APPROVED', kind: 'continuity', score: 0.8, report: '{}', batch: { connect: { id: sb1VideoBatch.id } } },
      { status: 'APPROVED', kind: 'script', score: 0.95, report: '{}', storyboard: { connect: { id: storyboardIds[0]! } } },
      { status: 'NEEDS_REVIEW', kind: 'source_audit', score: 0.4, report: '{}', sourceDocumentVersion: { connect: { id: sourceV1.id } } },
      // Unattached to this episode, so it must not inflate the counts.
      { status: 'APPROVED', kind: 'elsewhere', score: 1, report: '{}' },
    ]
    for (const data of checks) await env.db.qualityCheck.create({ data })

    const res = await createDelivery(editorToken)
    expect(res.statusCode).toBe(201)
    const delivery = (res.json() as { delivery: DeliveryDto }).delivery
    deliveryOneId = delivery.id
    expect(delivery.status).toBe('DRAFT')

    const manifest = delivery.manifest
    packagedManifest = manifest
    expect(manifest.schemaVersion).toBe(1)
    expect(new Date(manifest.packagedAt).toISOString()).toBe(manifest.packagedAt)
    expect(manifest.episode).toEqual({ id: episodeId, number: 1, title: 'EP1' })
    expect(manifest.source).toEqual({ version: 2, checksum: 'source-2', status: 'APPROVED' })
    expect(manifest.script).toEqual({ version: 3, checksum: 'script-3', status: 'DRAFT' })
    expect(manifest.storyboards.map(storyboard => [storyboard.number, storyboard.title, storyboard.durationMs])).toEqual([[1, 'SB1', 5000], [2, 'SB2', 6000]])
    expect(manifest.storyboards[0]!.artifacts.map(artifact => artifact.objectKey)).toEqual([
      objectKey('video', 'sb1', 'v1.mp4'),
      objectKey('first-frame', 'sb1', 'v1.png'),
    ])
    expect(manifest.storyboards[1]!.artifacts.map(artifact => artifact.objectKey)).toEqual([
      objectKey('video', 'sb2', 'v2.mp4'),
      objectKey('video', 'sb2', 'v1.mp4'),
      objectKey('first-frame', 'sb2', 'v1.png'),
    ])
    expect(manifest.storyboards[1]!.artifacts[0]).toEqual({
      id: expect.any(String),
      stage: 'VIDEO',
      objectKey: objectKey('video', 'sb2', 'v2.mp4'),
      checksum: 'video-sb2-v2',
      mimeType: 'video/mp4',
      version: 2,
      width: 1280,
      height: 720,
      durationMs: 6100,
    })
    // No subtitle and no score were mixed in, so the master is stated as silent.
    expect(manifest.composition).toEqual({ objectKey: masterObjectKey, checksum: 'master-checksum', mimeType: 'video/mp4', durationMs: 9000, tracks: [] })
    // 交付清单必须原样转述合成员写入的双标识记录:买家看清单就知道文件带不带标。
    expect(manifest.labeling).toEqual({ standard: 'GB 45438-2025', badgeText: 'AI生成内容 · AI-Generated Content', explicit: 'burned', implicit: 'written' })
    // 质量地板记录同样透传:音质/音量项的实测证据要能在清单里读到。
    expect(manifest.postProcess).toMatchObject({ status: 'applied', loudness: { before: { i: -3.2 }, after: { i: -16.1 } }, target: { i: -16 } })
    expect(manifest.quality).toEqual({ checks: 5, approved: 3, rejected: 2, threshold: 0.7 })
    // S5:清单带着从这条母带自己的台账量出来的三读数——打包不拦人，但证据必须先在。
    expect(manifest.review).toEqual({
      rhythm: {
        present: true,
        gaps: [],
        masterDurationMs: 9000,
        readings: {
          shotCount: 2, totalMs: 9000, avgShotMs: 4500, maxShotMs: 5000, longTakeMinMs: 8000,
          longTakeCount: 0, longTakeMs: 0, longTakeShare: 0, shortShotCount: 0, shortShotShare: 0,
        },
        // 平均 4500ms 正好压线达标（门是「低于」才失败），只缺长镜占比这一条。
        gate: { pass: false, failures: ['longTakeShare'] },
        settings: { avgShotMs: 4500, longTakeMinMs: 8000, longTakeShareMin: 0.2 },
      },
      transition: {
        present: true, gaps: [], kinds: ['cut', 'cut'], blendedSeamCount: 0,
        requestedNonCutCount: 0, blended: false, headFadeMs: 0, tailFadeMs: 0, fps: 25, shotCount: 2,
      },
      sound: {
        present: true, gaps: [], dialogueShotCount: 1, silentDialogueShots: [], bedCount: 0, importedBedCount: 0, hasMusic: false,
      },
      complete: true,
    })
    expect(manifest.acceptance).toBeUndefined()

    const stored = await env.db.delivery.findUniqueOrThrow({ where: { id: delivery.id } })
    expect(stored.status).toBe('DRAFT')
    expect(stored.artifactId).toBe(masterArtifactId)
    expect(JSON.parse(stored.manifest)).toEqual(manifest)
  })
})

describe('delivery reading', () => {
  it('lists deliveries newest first and serves the manifest on its own', async () => {
    const list = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/deliveries`, headers: authHeaders(viewerToken) })
    expect(list.statusCode).toBe(200)
    const deliveries = (list.json() as { deliveries: DeliveryDto[] }).deliveries
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.id).toBe(deliveryOneId)
    expect(deliveries[0]!.manifest).toEqual(packagedManifest)

    const manifest = await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/manifest`, headers: authHeaders(viewerToken) })
    expect(manifest.statusCode).toBe(200)
    expect(manifest.json()).toEqual(packagedManifest)

    expect((await env.app.inject({ method: 'GET', url: '/api/deliveries/does-not-exist/manifest', headers: authHeaders(viewerToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/manifest` })).statusCode).toBe(401)
    expect((await env.app.inject({ method: 'GET', url: '/api/episodes/does-not-exist/deliveries', headers: authHeaders(viewerToken) })).statusCode).toBe(404)
  })
})

describe('delivery edit handoff export', () => {
  it('serves an EDL whose record timecodes accumulate over the packaged clips', async () => {
    const res = await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/edit-list`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.headers['content-disposition']).toContain('episode-1-edit.edl')
    // SB1 实测 5000ms=125 帧；SB2 取最新 v2.mp4 的 6100ms→152.5 四舍五入 153 帧。
    const edl = res.body
    expect(edl).toContain('TITLE: EP1 EP1')
    expect(edl).toContain('FCM: NON-DROP FRAME')
    expect(edl).toMatch(/^001 {2}AX {23}V {5}C {8}00:00:00:00 00:00:05:00 00:00:00:00 00:00:05:00$/m)
    expect(edl).toMatch(/^002 {2}AX {23}V {5}C {8}00:00:00:00 00:00:06:03 00:00:05:00 00:00:11:03$/m)
    expect(edl).toContain('* FROM CLIP NAME: #2 SB2')
    expect(edl).toContain(`* SOURCE: ${objectKey('video', 'sb2', 'v2.mp4')}`)
    // 两份切片都带实测时长，导出就不该出现回退标注。
    expect(edl).not.toContain('planned duration')
  })

  it('serves an FCPXML timeline with the same frame math and spine order', async () => {
    const res = await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/edit-list?format=fcpxml`, headers: authHeaders(ownerToken) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/xml')
    expect(res.headers['content-disposition']).toContain('episode-1-edit.fcpxml')
    expect(res.body).toContain('<fcpxml version="1.10">')
    // 序列画幅取自切片实测(种子视频 1280×720),不再写死竖屏。
    expect(res.body).toContain('width="1280" height="720"')
    expect(res.body).not.toContain('width="1080"')
    expect(res.body).toContain('duration="125/25s"')
    expect(res.body).toContain('duration="153/25s"')
    expect(res.body).toContain('ref="x2" offset="125/25s"')
    expect(res.body).toContain('tcDuration="278/25s"')
  })

  it('serves an OTIO timeline whose V1 carries the packaged clips', async () => {
    const res = await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/edit-list?format=otio`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.headers['content-disposition']).toContain('episode-1-edit.otio')
    const timeline = res.json() as { OTIO_SCHEMA: string; name: string; tracks: { children: Array<{ name: string; kind: string; children: unknown[] }> } }
    expect(timeline.OTIO_SCHEMA).toBe('Timeline.1')
    expect(timeline.name).toBe('EP1 EP1')
    // 这一版母带没混配乐,只有 V1——配乐轨的有无必须诚实于合成记录。
    expect(timeline.tracks.children).toHaveLength(1)
    expect(timeline.tracks.children[0]).toMatchObject({ name: 'V1', kind: 'Video' })
    expect(timeline.tracks.children[0]!.children).toHaveLength(2)
  })

  it('freezes the edit handoff to the revision the packaged master was cut from (F13)', async () => {
    // 打包后编辑继续演进:剪辑清单必须仍指向打包那次合成消费的修订,而不是最新
    // head——旧交付的母带不变,清单不能跟着最新编辑漂移。修复前读的是当前 head,
    // 且 OTIO 格式误落进 buildFcpxml 返回 XML。
    const [sb1, sb2] = storyboardIds
    // Q04:导出引用的是可重链媒体名(media/<artifactId>.mp4),素材行必须真实存在。
    const frozenSb2 = await env.db.mediaArtifact.create({ data: { organizationId, stage: 'VIDEO', objectKey: objectKey('video', 'sb2', 'frozen.mp4'), checksum: 'frozen-sb2', mimeType: 'video/mp4', version: 9, width: 1280, height: 720, durationMs: 4000 } })
    const frozenSb1 = await env.db.mediaArtifact.create({ data: { organizationId, stage: 'VIDEO', objectKey: objectKey('video', 'sb1', 'frozen.mp4'), checksum: 'frozen-sb1', mimeType: 'video/mp4', version: 9, width: 1280, height: 720, durationMs: 5000 } })
    const edit = await env.db.episodeEdit.create({
      data: {
        episodeId, organizationId, headRevision: 2,
        revisions: {
          create: [
            { revision: 1, fpsNum: 25, fpsDen: 1, clips: JSON.stringify([
              { clipId: 'clip-1', storyboardId: sb2!, artifactId: frozenSb2.id, sourceInFrame: 25, sourceOutFrame: 100 },
              { clipId: 'clip-2', storyboardId: sb1!, artifactId: frozenSb1.id, sourceInFrame: 0, sourceOutFrame: 125 },
            ]), tracks: '[]', outputSpec: '{}', fingerprint: 'frozen-r1', author: 'test' },
            { revision: 2, fpsNum: 25, fpsDen: 1, clips: JSON.stringify([
              { clipId: 'clip-1', storyboardId: sb1!, artifactId: 'new-art-sb1', sourceInFrame: 0, sourceOutFrame: 50 },
            ]), tracks: '[]', outputSpec: '{}', fingerprint: 'new-r2', author: 'test' },
          ],
        },
      },
      include: { revisions: true },
    })
    const frozen = edit.revisions.find(revision => revision.revision === 1)!
    // 合成 worker 同款写入:产出该交付母带的 composition 记录它消费的编辑修订。
    await env.db.composition.updateMany({ where: { artifactId: masterArtifactId }, data: { editRevisionId: frozen.id, inputFingerprint: 'frozen-r1' } })

    const res = await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/edit-list`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    // 冻结修订的调序与可重链媒体名:SB2 在前;最新 head 的素材(单镜 50 帧)不得出现。
    expect(res.body.indexOf(`media/${frozenSb2.id}.mp4`)).toBeGreaterThan(-1)
    expect(res.body.indexOf(`media/${frozenSb1.id}.mp4`)).toBeGreaterThan(res.body.indexOf(`media/${frozenSb2.id}.mp4`))
    expect(res.body).not.toContain('new-art-sb1')

    // OTIO 走同一份冻结修订,内容是 JSON(修复前误回 FCPXML 的 XML),源入点随剪辑导出。
    const otio = await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/edit-list?format=otio`, headers: authHeaders(viewerToken) })
    expect(otio.statusCode).toBe(200)
    expect(otio.headers['content-type']).toContain('application/json')
    const timeline = otio.json() as { OTIO_SCHEMA: string; tracks: { children: Array<{ children: Array<{ source_range: { start_time: { value: number } } }> }> } }
    expect(timeline.OTIO_SCHEMA).toBe('Timeline.1')
    expect(timeline.tracks.children[0]!.children).toHaveLength(2)
    // 25fps 下 SB2 的源入点 25 帧 = 1 秒——裁切入点进了 source_range,不再固定从 0。
    expect(timeline.tracks.children[0]!.children[0]!.source_range.start_time.value).toBe(25)

    // FCPXML 与 xmeml 同样冻结在修订 1,引用包内媒体名。
    const fcpxml = await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/edit-list?format=fcpxml`, headers: authHeaders(ownerToken) })
    expect(fcpxml.statusCode).toBe(200)
    expect(fcpxml.body).toContain(`media/${frozenSb2.id}.mp4`)
    expect(fcpxml.body).not.toContain('new-art-sb1')
    const xmeml = await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/edit-list?format=xmeml`, headers: authHeaders(ownerToken) })
    expect(xmeml.statusCode).toBe(200)
    expect(xmeml.headers['content-type']).toContain('application/xml')
    expect(xmeml.body).toContain('<xmeml version="5">')
    expect(xmeml.body).toContain(`media/${frozenSb2.id}.mp4`)
    // 30fps 混合帧率修订的入点按修订 fps 换算(此例 25fps×25帧=1s=25 时间基帧)。
    expect(xmeml.body).toContain('<in>25</in>')

    // 媒体包:zip 内含冻结剪辑媒体与四种清单,文件名与引用同名。
    const sourceBytes = await env.app.storage.read(masterObjectKey)
    await env.app.storage.put(frozenSb1.objectKey, sourceBytes, 'video/mp4')
    await env.app.storage.put(frozenSb2.objectKey, sourceBytes, 'video/mp4')
    const pkg = await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/media-package`, headers: authHeaders(viewerToken) })
    expect(pkg.statusCode).toBe(200)
    expect(pkg.headers['content-type']).toContain('application/zip')
    expect(pkg.body.length).toBeGreaterThan(1000)
  })

  it('refuses unknown formats and hides other organizations\' deliveries', async () => {
    const bad = await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/edit-list?format=xml`, headers: authHeaders(editorToken) })
    expect(bad.statusCode).toBe(400)
    const missing = await env.app.inject({ method: 'GET', url: '/api/deliveries/does-not-exist/edit-list', headers: authHeaders(ownerToken) })
    expect(missing.statusCode).toBe(404)
    const foreign = await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/edit-list`, headers: authHeaders(outsiderToken) })
    expect(foreign.statusCode).toBe(404)
    expect((await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/edit-list` })).statusCode).toBe(401)
  })

  it('derives the sequence frame from outputSpec and places independent audio structurally (V06)', async () => {
    // 冻结修订带 aspect=9:16 与两条同起点的独立音轨:序列画幅必须是 9:16 的
    // 1080×1920(源素材是 1280×720 横屏),两条声音各自一条轨、以 Gap 定位——
    // 同一 Track 顺序排列会把后一条挤到前一条结束之后,位置语义丢失。
    const linked = await env.db.composition.findFirstOrThrow({ where: { artifactId: masterArtifactId } })
    const frozen = await env.db.episodeEditRevision.findUniqueOrThrow({ where: { id: linked.editRevisionId! } })
    const audioA = await env.db.mediaArtifact.create({ data: { organizationId, stage: 'AUDIO', objectKey: objectKey('audio', 'edit', 'a.wav'), checksum: 'aud-a', mimeType: 'audio/wav', version: 1, durationMs: 3000 } })
    const audioB = await env.db.mediaArtifact.create({ data: { organizationId, stage: 'AUDIO', objectKey: objectKey('audio', 'edit', 'b.wav'), checksum: 'aud-b', mimeType: 'audio/wav', version: 1, durationMs: 3000 } })
    await env.db.episodeEditRevision.update({
      where: { id: frozen.id },
      data: {
        outputSpec: JSON.stringify({ aspect: '9:16' }),
        tracks: JSON.stringify([
          { elementId: 'trk-a', sourceArtifactId: audioA.id, anchor: 'sequence', offsetFrame: 50, gain: 0.5, muted: false, locked: false },
          { elementId: 'trk-b', sourceArtifactId: audioB.id, anchor: 'sequence', offsetFrame: 50, gain: 1, muted: true, locked: false },
        ]),
      },
    })

    const fcpxml = await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/edit-list?format=fcpxml`, headers: authHeaders(ownerToken) })
    expect(fcpxml.statusCode).toBe(200)
    // 序列画幅来自 outputSpec(9:16 → 1080×1920),不再是源素材的 1280×720。
    expect(fcpxml.body).toContain('width="1080" height="1920"')
    expect(fcpxml.body).not.toContain('width="1280"')
    // 独立音轨以播放结构定位:音频 asset-clip 带 offset(2s=50/25s),音量/静音走 note。
    expect(fcpxml.body).toContain(`src="file:///media/${audioA.id}-track-0.wav"`)
    expect(fcpxml.body).toContain('offset="50/25s"')
    expect(fcpxml.body).toContain('<note>makemovie: gain=1, muted=false</note>')

    const otio = await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/edit-list?format=otio`, headers: authHeaders(viewerToken) })
    expect(otio.statusCode).toBe(200)
    const timeline = otio.json() as {
      tracks: { children: Array<{ OTIO_SCHEMA: string; name: string; kind: string; children: Array<{ OTIO_SCHEMA: string; name?: string; source_range?: { duration: { value: number } }; metadata?: { makemovie?: { gain: number; muted: boolean } } }> }> }
    }
    const audioTracks = timeline.tracks.children.filter(track => track.kind === 'Audio')
    expect(audioTracks).toHaveLength(2)
    for (const track of audioTracks) {
      // 每条独立音轨一条 Track:先 Gap 定位到 2s(50 帧),再放 Clip——位置是结构,
      // 不再依赖自定义 metadata 才能还原。
      expect(track.children[0]).toMatchObject({ OTIO_SCHEMA: 'Gap.1' })
      expect(track.children[0]!.source_range!.duration.value).toBe(50)
      expect(track.children[1]).toMatchObject({ OTIO_SCHEMA: 'Clip.2' })
    }
    expect(audioTracks[0]!.children[1]!.metadata!.makemovie).toEqual({ timeline_start_ms: 2000, gain: 1, muted: false })
    expect(audioTracks[1]!.children[1]!.metadata!.makemovie).toEqual({ timeline_start_ms: 2000, gain: 1, muted: true })

    const xmeml = await env.app.inject({ method: 'GET', url: `/api/deliveries/${deliveryOneId}/edit-list?format=xmeml`, headers: authHeaders(ownerToken) })
    expect(xmeml.statusCode).toBe(200)
    // 位置与禁用状态使用播放字段;增益已预处理入交接媒体。
    expect(xmeml.body).toContain('<start>50</start>')
    expect(xmeml.body).toContain('<mastercomment1>makemovie: gain=1, muted=false</mastercomment1>')
  })
})

describe('delivery acceptance decisions', () => {
  it('refuses to accept while the master ledger is missing a reading, and names which one', async () => {
    // 验收门读的是母带当前的台账，不是打包那刻冻在清单里的读数：台账后来缺了一格，
    // 已经打包的草稿照样不许签——否则「回去补一次合成」和「把记录改一下」在界面上长的一样。
    const composition = await env.db.composition.findFirstOrThrow({ where: { artifactId: masterArtifactId } })
    const full = composition.manifest
    /** 只改台账里那几格，其余记录（标识、质量地板、质检戳）原样留着：整份覆盖会把质检戳
     *  一起删掉，那时先拦住验收的是技术质检门，根本测不到读数门。 */
    const patchLedger = (mutate: (ledger: Record<string, unknown>) => void) => {
      const ledger = JSON.parse(full) as Record<string, unknown>
      mutate(ledger)
      return JSON.stringify(ledger)
    }
    const refuse = async () => {
      const res = await env.app.inject({ method: 'POST', url: `/api/deliveries/${deliveryOneId}/accept`, headers: authHeaders(editorToken) })
      expect(res.statusCode).toBe(409)
      const body = res.json() as { error: string; reasons: string[]; review: CompositionReviewReadings }
      expect(body.error).toBe('delivery:reviewIncomplete')
      expect((await env.db.delivery.findUniqueOrThrow({ where: { id: deliveryOneId } })).status).toBe('DRAFT')
      return body
    }
    try {
      // 一刀表整格没记：跨度也读不出，声音轴同样失去对照——缺几项报几项，不合成一句人话。
      await env.db.composition.update({ where: { id: composition.id }, data: { manifest: patchLedger(ledger => { delete ledger.cuts }) } })
      expect((await refuse()).reasons).toEqual(['rhythm:shotSpans', 'transition:cutTable', 'sound:audioLedger'])

      // 只有声音台账没记：另两轴齐，门只缺这一项。
      await env.db.composition.update({ where: { id: composition.id }, data: { manifest: patchLedger(ledger => { delete ledger.audio }) } })
      expect((await refuse()).reasons).toEqual(['sound:audioLedger'])

      // 快照里有配音件、母带台账里没读进去（SD-181）：这一镜在成片里是静音，拦。
      await env.db.composition.update({
        where: { id: composition.id },
        data: {
          manifest: patchLedger(ledger => {
            const audio = ledger.audio as Record<string, Record<string, unknown>>
            audio[storyboardIds[0]!] = { ...audio[storyboardIds[0]!], voiceArtifactId: null }
          }),
        },
      })
      const silent = await refuse()
      expect(silent.reasons).toEqual(['sound:silentDialogue'])
      // 409 同时回带完整读数：界面要把缺的摊在行上，而不是只弹一句「不能验收」。
      expect(silent.review.sound.silentDialogueShots).toEqual([1])
      expect(silent.review.complete).toBe(false)
    } finally {
      await env.db.composition.update({ where: { id: composition.id }, data: { manifest: full } })
    }
  })

  it('accepts a draft once and refuses to accept it again', async () => {
    const res = await env.app.inject({ method: 'POST', url: `/api/deliveries/${deliveryOneId}/accept`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(200)
    const delivery = (res.json() as { delivery: DeliveryDto }).delivery
    expect(delivery.status).toBe('APPROVED')
    expect(delivery.manifest.acceptance?.reason).toBeNull()
    expect(typeof delivery.manifest.acceptance?.acceptedAt).toBe('string')
    // The decision is merged in; the packaged manifest survives untouched.
    expect(delivery.manifest.storyboards).toHaveLength(2)
    expect(delivery.manifest.composition).toEqual(packagedManifest.composition)

    const stored = await env.db.delivery.findUniqueOrThrow({ where: { id: deliveryOneId } })
    expect(stored.status).toBe('APPROVED')
    expect(JSON.parse(stored.manifest).acceptance).toEqual(delivery.manifest.acceptance)

    const again = await env.app.inject({ method: 'POST', url: `/api/deliveries/${deliveryOneId}/accept`, headers: authHeaders(editorToken) })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('delivery:alreadyAccepted')
    expect((await env.app.inject({ method: 'POST', url: '/api/deliveries/does-not-exist/accept', headers: authHeaders(editorToken) })).statusCode).toBe(404)
  })

  it('requires a reason to reject and never reopens an accepted delivery', async () => {
    const second = await createDelivery(editorToken)
    expect(second.statusCode).toBe(201)
    deliveryTwoId = (second.json() as { delivery: DeliveryDto }).delivery.id

    for (const payload of [{ reason: '   ' }, {}]) {
      const blank = await env.app.inject({ method: 'POST', url: `/api/deliveries/${deliveryTwoId}/reject`, headers: authHeaders(editorToken), payload })
      expect(blank.statusCode).toBe(400)
    }
    expect((await env.db.delivery.findUniqueOrThrow({ where: { id: deliveryTwoId } })).status).toBe('DRAFT')

    const tooLate = await env.app.inject({ method: 'POST', url: `/api/deliveries/${deliveryOneId}/reject`, headers: authHeaders(editorToken), payload: { reason: 'changed our mind' } })
    expect(tooLate.statusCode).toBe(409)
    expect(tooLate.json().error).toBe('delivery:alreadyAccepted')

    const res = await env.app.inject({ method: 'POST', url: `/api/deliveries/${deliveryTwoId}/reject`, headers: authHeaders(editorToken), payload: { reason: ' audio drift in SB2 ' } })
    expect(res.statusCode).toBe(200)
    const delivery = (res.json() as { delivery: DeliveryDto }).delivery
    expect(delivery.status).toBe('NEEDS_REVIEW')
    expect(delivery.manifest.acceptance?.reason).toBe('audio drift in SB2')
    expect(typeof delivery.manifest.acceptance?.rejectedAt).toBe('string')
    expect(delivery.manifest.acceptance?.acceptedAt).toBeUndefined()
    expect((await env.db.delivery.findUniqueOrThrow({ where: { id: deliveryTwoId } })).status).toBe('NEEDS_REVIEW')

    const list = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/deliveries`, headers: authHeaders(viewerToken) })
    const ids = (list.json() as { deliveries: DeliveryDto[] }).deliveries.map(candidate => candidate.id)
    expect(ids).toEqual([deliveryTwoId, deliveryOneId])
  })

  it('denies viewers every write and hides deliveries from other organizations', async () => {
    const viewerWrites: ['POST', string, { reason: string }?][] = [
      ['POST', `/api/episodes/${episodeId}/deliveries`],
      ['POST', `/api/deliveries/${deliveryTwoId}/accept`],
      ['POST', `/api/deliveries/${deliveryTwoId}/reject`, { reason: 'viewer says no' }],
    ]
    for (const [method, url, payload] of viewerWrites) {
      const res = await env.app.inject({ method, url, headers: authHeaders(viewerToken), ...(payload ? { payload } : {}) })
      expect(res.statusCode).toBe(403)
      expect(res.json().error).toMatch(/episode:write/)
    }

    // An owner of another organization passes RBAC but never sees these rows.
    const rivalRequests: ['GET' | 'POST', string, { reason: string }?][] = [
      ['POST', `/api/episodes/${episodeId}/deliveries`],
      ['GET', `/api/episodes/${episodeId}/deliveries`],
      ['GET', `/api/deliveries/${deliveryOneId}/manifest`],
      ['POST', `/api/deliveries/${deliveryTwoId}/accept`],
      ['POST', `/api/deliveries/${deliveryTwoId}/reject`, { reason: 'rival says no' }],
    ]
    for (const [method, url, payload] of rivalRequests) {
      const res = await env.app.inject({ method, url, headers: authHeaders(outsiderToken), ...(payload ? { payload } : {}) })
      expect(res.statusCode).toBe(404)
    }
    expect(await env.db.delivery.count({ where: { episodeId } })).toBe(2)
  })

  it('records create, accept and reject in the audit trail', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/audit-events', headers: authHeaders(ownerToken) })
    expect(res.statusCode).toBe(200)
    const events = res.json().events as { action: string; entityType: string; entityId: string }[]
    expect(events.some(event => event.action === 'delivery.create' && event.entityType === 'delivery' && event.entityId === deliveryOneId)).toBe(true)
    expect(events.some(event => event.action === 'delivery.accept' && event.entityId === deliveryOneId)).toBe(true)
    expect(events.some(event => event.action === 'delivery.reject' && event.entityId === deliveryTwoId)).toBe(true)
  })
})

// Last, because it packages a third delivery and the listing above counts them.
describe('delivery audio tracks', () => {
  it('names the audio that was mixed in, not whatever the newest of that stage is now', async () => {
    const composition = await env.db.composition.findFirstOrThrow({ where: { episodeId } })
    const seed = (stage: Stage, file: string, checksum: string, mimeType: string, durationMs: number | null) =>
      env.db.mediaArtifact.create({
        data: { organizationId, stage, objectKey: objectKey(stage.toLowerCase(), 'master', file), checksum, mimeType, version: 1, durationMs },
      })
    const subtitle = await seed('SUBTITLE', 'v1.srt', 'srt-checksum', 'application/x-subrip', null)
    const score = await seed('MUSIC', 'v1.wav', 'score-in-the-file', 'audio/wav', 9000)
    await env.db.composition.update({
      where: { id: composition.id },
      data: { subtitleArtifactId: subtitle.id, scoreArtifactId: score.id },
    })
    // Regenerating the score after the compose must not rewrite what the master holds.
    await seedTask('MUSIC', [], [{
      stage: 'MUSIC', objectKey: objectKey('music', 'master', 'v2.wav'), checksum: 'score-regenerated', mimeType: 'audio/wav', version: 2, durationMs: 9000,
    }])

    const res = await createDelivery(editorToken)
    expect(res.statusCode).toBe(201)
    const manifest = (res.json() as { delivery: DeliveryDto }).delivery.manifest
    expect(manifest.composition.tracks.map(track => [track.stage, track.checksum])).toEqual([
      ['SUBTITLE', 'srt-checksum'],
      ['MUSIC', 'score-in-the-file'],
    ])
    expect(manifest.composition.tracks[1]).toEqual(expect.objectContaining({ objectKey: objectKey('music', 'master', 'v1.wav'), durationMs: 9000 }))
  })
})

// Last of last: the block above gave the composition a subtitle artifact and packaged
// the third delivery; this one downloads it and then packages a silent fourth.
describe('delivery subtitle file', () => {
  it('serves the SRT that belongs to the packaged composition, byte for byte', async () => {
    const list = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/deliveries`, headers: authHeaders(viewerToken) })
    const third = (list.json() as { deliveries: DeliveryDto[] }).deliveries[0]!
    const srtBody = '1\n00:00:00,000 --> 00:00:03,000\n巷口相遇\n'
    await env.app.storage.put(objectKey('subtitle', 'master', 'v1.srt'), new TextEncoder().encode(srtBody), 'application/x-subrip')

    const res = await env.app.inject({ method: 'GET', url: `/api/deliveries/${third.id}/subtitle`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/x-subrip')
    expect(res.headers['content-disposition']).toContain('episode-1.srt')
    expect(String(res.body)).toBe(srtBody)
  })

  it('answers 404 for a master without subtitles and stays org-scoped and authenticated', async () => {
    const silentMaster = await env.db.mediaArtifact.create({
      data: {
        organizationId,
        stage: 'COMPOSITION',
        objectKey: `${organizationId}/${projectId}/${episodeId}/composition/master/v2.mp4`,
        checksum: 'master-2-checksum',
        mimeType: 'video/mp4',
        version: 2,
        durationMs: 1000,
      },
    })
    // V07:门禁对「最新完成合成」跑真实技术检查——这颗无字幕母带也要有真实字节。
    {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const os = await import('node:os')
      const path = await import('node:path')
      const { mkdtemp, readFile, rm } = await import('node:fs/promises')
      const dir = await mkdtemp(path.join(os.tmpdir(), 'delivery-master2-'))
      try {
        const file = path.join(dir, 'master.mp4')
        await promisify(execFile)('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25', '-pix_fmt', 'yuv420p', file], { timeout: 60_000 })
        await env.app.storage.put(silentMaster.objectKey, new Uint8Array(await readFile(file)), 'video/mp4')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
    await env.db.composition.create({
      data: { episodeId, status: 'COMPLETED', manifest: JSON.stringify({ storyboardIds }), artifactId: silentMaster.id },
    })
    const res = await createDelivery(editorToken)
    expect(res.statusCode).toBe(201)
    const silent = (res.json() as { delivery: DeliveryDto }).delivery

    const no = await env.app.inject({ method: 'GET', url: `/api/deliveries/${silent.id}/subtitle`, headers: authHeaders(ownerToken) })
    expect(no.statusCode).toBe(404)
    expect(no.json().error).toBe('delivery:noSubtitles')

    expect((await env.app.inject({ method: 'GET', url: '/api/deliveries/does-not-exist/subtitle', headers: authHeaders(ownerToken) })).statusCode).toBe(404)
    const list = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/deliveries`, headers: authHeaders(viewerToken) })
    const subtitled = (list.json() as { deliveries: DeliveryDto[] }).deliveries.find(delivery => delivery.id !== silent.id)!
    expect((await env.app.inject({ method: 'GET', url: `/api/deliveries/${subtitled.id}/subtitle`, headers: authHeaders(outsiderToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'GET', url: `/api/deliveries/${silent.id}/subtitle` })).statusCode).toBe(401)
  })
})

describe('delivery technical quality gate (V07)', () => {
  it('blocks packaging and acceptance of a corrupt master even though a human asked for it', async () => {
    // 真实损坏:把两颗母带字节覆盖为不可解码内容,对最新合成跑正式 reviews——
    // 技术检查判定 probe_failed/blocking 后,打包与验收都必须拒绝;「没查过」也
    // 不是豁免。deliveryTwo 的母带是 v1(打包时的最新合成),打包门禁看的是当前
    // 最新合成(v2)。
    const compV1 = await env.db.composition.findFirstOrThrow({ where: { artifactId: masterArtifactId } })
    const compV2 = await env.db.composition.findFirstOrThrow({ where: { episodeId, status: 'COMPLETED', artifactId: { not: masterArtifactId } }, orderBy: { id: 'desc' } })
    const masterV2 = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: compV2.artifactId! } })
    const goodV1 = await env.app.storage.read(masterObjectKey)
    const goodV2 = await env.app.storage.read(masterV2.objectKey)
    const corrupt = new TextEncoder().encode('this is not an mp4 — corrupt bytes for the gate test')
    const stamp = async (compositionId: string, manifest: string, passed: boolean) => {
      const parsed = JSON.parse(manifest) as Record<string, unknown>
      parsed.qualityCheckPassed = passed
      parsed.qualityFindings = passed
        ? []
        : [{ id: 'probe_failed', severity: 'blocking', dimension: 'file', message: 'ffprobe failed to parse the file — possible corruption', evidenceTimeSeconds: null }]
      await env.db.composition.update({ where: { id: compositionId }, data: { manifest: JSON.stringify(parsed) } })
    }
    try {
      await env.app.storage.put(masterObjectKey, corrupt, 'video/mp4')
      await env.app.storage.put(masterV2.objectKey, corrupt, 'video/mp4')
      // 正式 reviews 跑在最新合成(v2)上:真实 ffprobe 判定 blocking 并落 manifest。
      const review = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/reviews`, headers: authHeaders(editorToken) })
      expect(review.statusCode).toBe(200)
      expect(review.json().passed).toBe(false)
      expect(JSON.stringify(review.json().findings)).toContain('blocking')
      // v1 不再是最新合成,reviews 够不到它;同一份结论形态由门禁同路径消费。
      await stamp(compV1.id, (await env.db.composition.findUniqueOrThrow({ where: { id: compV1.id } })).manifest, false)

      // 打包:门禁拦下(blocking 不因人工请求而豁免)。
      const blocked = await createDelivery(editorToken)
      expect(blocked.statusCode).toBe(409)
      expect((blocked.json() as { error: string }).error).toBe('delivery:qualityGate')

      // 验收:已打包的交付在其母带被判定 blocking 后不得被批准。
      const acceptBlocked = await env.app.inject({ method: 'POST', url: `/api/deliveries/${deliveryTwoId}/accept`, headers: authHeaders(editorToken) })
      expect(acceptBlocked.statusCode).toBe(409)
      expect((acceptBlocked.json() as { error: string }).error).toBe('delivery:qualityGate')
      expect((await env.db.delivery.findUniqueOrThrow({ where: { id: deliveryTwoId } })).status).toBe('NEEDS_REVIEW')
    } finally {
      // 恢复好字节并重跑检查:门禁结论随母带实际状态更新。
      await env.app.storage.put(masterObjectKey, goodV1, 'video/mp4')
      await env.app.storage.put(masterV2.objectKey, goodV2, 'video/mp4')
      await stamp(compV1.id, (await env.db.composition.findUniqueOrThrow({ where: { id: compV1.id } })).manifest, true)
      const restored = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/reviews`, headers: authHeaders(editorToken) })
      expect(restored.statusCode).toBe(200)
      expect(restored.json().passed).toBe(true)
    }
  })

  it('reports how many warnings still need a decision, not their prose', async () => {
    // SD-192：门禁的 reasons 是一条条 QC 结论原文（实测一集 55 条，每条一整段中英混排）。
    // 界面接不住这个码就退成一句通用报错——人只看到「操作失败」，不知道还差几条、去哪儿清；
    // 照单全铺又等于把裁决队列倒进警告条。pendingCount 才是给界面那个数。
    const composition = await env.db.composition.findFirstOrThrow({
      where: { episodeId, status: 'COMPLETED', artifactId: { not: null } }, orderBy: { id: 'desc' },
    })
    const parsed = JSON.parse(composition.manifest) as Record<string, unknown>
    // 技术结论钉成通过，让门停在裁决队列这一档，不去跑真 ffprobe。
    await env.db.composition.update({
      where: { id: composition.id },
      data: { manifest: JSON.stringify({ ...parsed, qualityCheckPassed: true, qualityFindings: [] }) },
    })
    const fingerprint = composition.inputFingerprint ?? composition.id
    const seeded: string[] = []
    for (const findingKey of ['visual:clip-90', 'visual:clip-91']) {
      const row = await env.db.qualityFinding.create({
        data: {
          organizationId, episodeId, compositionId: composition.id, fingerprint, findingKey,
          dimension: 'continuity', severity: 'warning', message: '结尾状态未在采样帧内达成', status: 'open',
        },
      })
      seeded.push(row.id)
    }
    try {
      const res = await createDelivery(editorToken)
      expect(res.statusCode).toBe(409)
      const body = res.json() as { error: string; pendingCount?: number; nextAction?: string; reasons?: unknown[] }
      expect(body.error).toBe('delivery:qualityGate')
      expect(body.nextAction).toBe('adjudicate')
      expect(body.pendingCount).toBe(2)
      expect(body.reasons).toHaveLength(2)
    } finally {
      await env.db.qualityFinding.deleteMany({ where: { id: { in: seeded } } })
    }
  })

  it('auto-runs the check at packaging time when none was recorded (unjudged is not a pass)', async () => {
    // 一颗新合成,manifest 无质量结论:打包时补查并写回 composition manifest。
    const fresh = await env.db.mediaArtifact.create({
      data: { organizationId, stage: 'COMPOSITION', objectKey: `${organizationId}/${projectId}/${episodeId}/composition/master/v3.mp4`, checksum: 'master-3', mimeType: 'video/mp4', version: 3, durationMs: 1000 },
    })
    {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const os = await import('node:os')
      const path = await import('node:path')
      const { mkdtemp, readFile, rm } = await import('node:fs/promises')
      const dir = await mkdtemp(path.join(os.tmpdir(), 'delivery-master3-'))
      try {
        const file = path.join(dir, 'm.mp4')
        await promisify(execFile)('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25', '-pix_fmt', 'yuv420p', file], { timeout: 60_000 })
        await env.app.storage.put(fresh.objectKey, new Uint8Array(await readFile(file)), 'video/mp4')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
    const composition = await env.db.composition.create({ data: { episodeId, status: 'COMPLETED', manifest: JSON.stringify({ storyboardIds }), artifactId: fresh.id } })
    const res = await createDelivery(editorToken)
    expect(res.statusCode).toBe(201)
    const after = JSON.parse((await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })).manifest) as { qualityCheckPassed?: boolean }
    expect(after.qualityCheckPassed).toBe(true)
  })
})
