import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MediaArtifact, Prisma, Stage, TaskStatus } from '@studio/db'
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
  composition: { objectKey: string; checksum: string; mimeType: string; durationMs: number | null }
  quality: { checks: number; approved: number; rejected: number; threshold: number }
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
    const added = await env.app.inject({ method: 'POST', url: '/members', headers: env.authHeaders(ownerToken), payload: { email, role } })
    expect(added.statusCode).toBe(201)
    const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123', organizationId } })
    expect(login.statusCode).toBe(200)
    if (role === 'EDITOR') editorToken = login.json().token as string
    else viewerToken = login.json().token as string
  }

  const project = await env.app.inject({ method: 'POST', url: '/projects', headers: env.authHeaders(ownerToken), payload: { name: 'Delivery Drama' } })
  expect(project.statusCode).toBe(201)
  projectId = project.json().id as string

  const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: env.authHeaders(ownerToken), payload: { number: 1, title: 'EP1' } })
  expect(episode.statusCode).toBe(201)
  episodeId = episode.json().id as string

  for (const [number, title] of [[1, 'SB1'], [2, 'SB2']] as const) {
    const storyboard = await env.app.inject({
      method: 'POST', url: `/episodes/${episodeId}/storyboards`, headers: env.authHeaders(ownerToken),
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
  env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/deliveries`, headers: authHeaders(token) })

describe('delivery acceptance gate', () => {
  it('refuses an episode with no composition and names every missing clip', async () => {
    const res = await createDelivery(editorToken)
    expect(res.statusCode).toBe(409)
    const body = res.json() as { error: string; reasons: string[] }
    expect(body.error).toBe('delivery:notReady')
    expect(body.reasons).toEqual([
      'the episode has no composition yet',
      'storyboard 1 has no succeeded video artifact',
      'storyboard 2 has no succeeded video artifact',
    ])
    expect(await env.db.delivery.count({ where: { episodeId } })).toBe(0)

    const missing = await env.app.inject({ method: 'POST', url: '/episodes/does-not-exist/deliveries', headers: authHeaders(editorToken) })
    expect(missing.statusCode).toBe(404)
  })

  it('refuses while one storyboard has no succeeded video artifact', async () => {
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
    await env.db.composition.create({
      data: { episodeId, status: 'COMPLETED', manifest: JSON.stringify({ storyboardIds }), artifactId: master.id },
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
    const body = res.json() as { error: string; reasons: string[] }
    expect(body.error).toBe('delivery:notReady')
    expect(body.reasons).toEqual(['storyboard 2 has no succeeded video artifact'])
    expect(await env.db.delivery.count({ where: { episodeId } })).toBe(0)
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
      stage: 'VIDEO',
      objectKey: objectKey('video', 'sb2', 'v2.mp4'),
      checksum: 'video-sb2-v2',
      mimeType: 'video/mp4',
      version: 2,
      width: 1280,
      height: 720,
      durationMs: 6100,
    })
    expect(manifest.composition).toEqual({ objectKey: masterObjectKey, checksum: 'master-checksum', mimeType: 'video/mp4', durationMs: 9000 })
    expect(manifest.quality).toEqual({ checks: 5, approved: 3, rejected: 2, threshold: 0.7 })
    expect(manifest.acceptance).toBeUndefined()

    const stored = await env.db.delivery.findUniqueOrThrow({ where: { id: delivery.id } })
    expect(stored.status).toBe('DRAFT')
    expect(stored.artifactId).toBe(masterArtifactId)
    expect(JSON.parse(stored.manifest)).toEqual(manifest)
  })
})

describe('delivery reading', () => {
  it('lists deliveries newest first and serves the manifest on its own', async () => {
    const list = await env.app.inject({ method: 'GET', url: `/episodes/${episodeId}/deliveries`, headers: authHeaders(viewerToken) })
    expect(list.statusCode).toBe(200)
    const deliveries = (list.json() as { deliveries: DeliveryDto[] }).deliveries
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.id).toBe(deliveryOneId)
    expect(deliveries[0]!.manifest).toEqual(packagedManifest)

    const manifest = await env.app.inject({ method: 'GET', url: `/deliveries/${deliveryOneId}/manifest`, headers: authHeaders(viewerToken) })
    expect(manifest.statusCode).toBe(200)
    expect(manifest.json()).toEqual(packagedManifest)

    expect((await env.app.inject({ method: 'GET', url: '/deliveries/does-not-exist/manifest', headers: authHeaders(viewerToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'GET', url: `/deliveries/${deliveryOneId}/manifest` })).statusCode).toBe(401)
    expect((await env.app.inject({ method: 'GET', url: '/episodes/does-not-exist/deliveries', headers: authHeaders(viewerToken) })).statusCode).toBe(404)
  })
})

describe('delivery acceptance decisions', () => {
  it('accepts a draft once and refuses to accept it again', async () => {
    const res = await env.app.inject({ method: 'POST', url: `/deliveries/${deliveryOneId}/accept`, headers: authHeaders(editorToken) })
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

    const again = await env.app.inject({ method: 'POST', url: `/deliveries/${deliveryOneId}/accept`, headers: authHeaders(editorToken) })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('delivery:alreadyAccepted')
    expect((await env.app.inject({ method: 'POST', url: '/deliveries/does-not-exist/accept', headers: authHeaders(editorToken) })).statusCode).toBe(404)
  })

  it('requires a reason to reject and never reopens an accepted delivery', async () => {
    const second = await createDelivery(editorToken)
    expect(second.statusCode).toBe(201)
    deliveryTwoId = (second.json() as { delivery: DeliveryDto }).delivery.id

    for (const payload of [{ reason: '   ' }, {}]) {
      const blank = await env.app.inject({ method: 'POST', url: `/deliveries/${deliveryTwoId}/reject`, headers: authHeaders(editorToken), payload })
      expect(blank.statusCode).toBe(400)
    }
    expect((await env.db.delivery.findUniqueOrThrow({ where: { id: deliveryTwoId } })).status).toBe('DRAFT')

    const tooLate = await env.app.inject({ method: 'POST', url: `/deliveries/${deliveryOneId}/reject`, headers: authHeaders(editorToken), payload: { reason: 'changed our mind' } })
    expect(tooLate.statusCode).toBe(409)
    expect(tooLate.json().error).toBe('delivery:alreadyAccepted')

    const res = await env.app.inject({ method: 'POST', url: `/deliveries/${deliveryTwoId}/reject`, headers: authHeaders(editorToken), payload: { reason: ' audio drift in SB2 ' } })
    expect(res.statusCode).toBe(200)
    const delivery = (res.json() as { delivery: DeliveryDto }).delivery
    expect(delivery.status).toBe('NEEDS_REVIEW')
    expect(delivery.manifest.acceptance?.reason).toBe('audio drift in SB2')
    expect(typeof delivery.manifest.acceptance?.rejectedAt).toBe('string')
    expect(delivery.manifest.acceptance?.acceptedAt).toBeUndefined()
    expect((await env.db.delivery.findUniqueOrThrow({ where: { id: deliveryTwoId } })).status).toBe('NEEDS_REVIEW')

    const list = await env.app.inject({ method: 'GET', url: `/episodes/${episodeId}/deliveries`, headers: authHeaders(viewerToken) })
    const ids = (list.json() as { deliveries: DeliveryDto[] }).deliveries.map(candidate => candidate.id)
    expect(ids).toEqual([deliveryTwoId, deliveryOneId])
  })

  it('denies viewers every write and hides deliveries from other organizations', async () => {
    const viewerWrites: ['POST', string, { reason: string }?][] = [
      ['POST', `/episodes/${episodeId}/deliveries`],
      ['POST', `/deliveries/${deliveryTwoId}/accept`],
      ['POST', `/deliveries/${deliveryTwoId}/reject`, { reason: 'viewer says no' }],
    ]
    for (const [method, url, payload] of viewerWrites) {
      const res = await env.app.inject({ method, url, headers: authHeaders(viewerToken), ...(payload ? { payload } : {}) })
      expect(res.statusCode).toBe(403)
      expect(res.json().error).toMatch(/episode:write/)
    }

    // An owner of another organization passes RBAC but never sees these rows.
    const rivalRequests: ['GET' | 'POST', string, { reason: string }?][] = [
      ['POST', `/episodes/${episodeId}/deliveries`],
      ['GET', `/episodes/${episodeId}/deliveries`],
      ['GET', `/deliveries/${deliveryOneId}/manifest`],
      ['POST', `/deliveries/${deliveryTwoId}/accept`],
      ['POST', `/deliveries/${deliveryTwoId}/reject`, { reason: 'rival says no' }],
    ]
    for (const [method, url, payload] of rivalRequests) {
      const res = await env.app.inject({ method, url, headers: authHeaders(outsiderToken), ...(payload ? { payload } : {}) })
      expect(res.statusCode).toBe(404)
    }
    expect(await env.db.delivery.count({ where: { episodeId } })).toBe(2)
  })

  it('records create, accept and reject in the audit trail', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/audit-events', headers: authHeaders(ownerToken) })
    expect(res.statusCode).toBe(200)
    const events = res.json().events as { action: string; entityType: string; entityId: string }[]
    expect(events.some(event => event.action === 'delivery.create' && event.entityType === 'delivery' && event.entityId === deliveryOneId)).toBe(true)
    expect(events.some(event => event.action === 'delivery.accept' && event.entityId === deliveryOneId)).toBe(true)
    expect(events.some(event => event.action === 'delivery.reject' && event.entityId === deliveryTwoId)).toBe(true)
  })
})
