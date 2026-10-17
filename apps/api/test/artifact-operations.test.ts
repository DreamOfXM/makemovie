import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv
let ownerToken: string
let organizationId: string
let projectId: string
let episodeId: string
let storyboardId: string
let videoArtifactId: string
let imageArtifactId: string

const authHeaders = (token: string) => env.authHeaders(token)

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('extend-owner@example.com', 'Extend Org')
  ownerToken = owner.token
  organizationId = owner.organization.id

  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'Extend Drama' } })
  projectId = project.json().id as string
  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: authHeaders(ownerToken), payload: { number: 1, title: 'EP1' } })
  episodeId = episode.json().id as string
  const storyboard = await env.app.inject({
    method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: authHeaders(ownerToken),
    payload: { number: 1, title: 'SB1', durationMs: 5000, description: '雨夜巷口', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
  })
  storyboardId = storyboard.json().id as string

  // 一个挂在任务/镜头下的视频制品(延长的前提)和一个图像制品(反例)。
  const batch = await env.db.generationBatch.create({
    data: { organizationId, episodeId, stage: 'VIDEO', status: 'COMPLETED', plannedCount: 1, storyboards: { connect: [{ id: storyboardId }] } },
  })
  const task = await env.db.generationTask.create({ data: { organizationId, batchId: batch.id, stage: 'VIDEO', status: 'SUCCEEDED', storyboardId } })
  const video = await env.db.mediaArtifact.create({
    data: { organizationId, taskId: task.id, stage: 'VIDEO', objectKey: `${organizationId}/${projectId}/${episodeId}/video/sb1/v1.mp4`, checksum: 'video-1', mimeType: 'video/mp4', version: 1 },
  })
  videoArtifactId = video.id
  const image = await env.db.mediaArtifact.create({
    data: { organizationId, taskId: task.id, stage: 'FIRST_FRAME', objectKey: `${organizationId}/${projectId}/${episodeId}/frame/sb1/v1.png`, checksum: 'frame-1', mimeType: 'image/png', version: 1 },
  })
  imageArtifactId = image.id
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

async function bindMockVideo(): Promise<void> {
  const connection = await env.db.providerConnection.create({
    data: {
      organizationId,
      provider: 'mock',
      name: 'extend-mock',
      baseUrl: 'mock://local',
      encryptedSecret: 'dGVzdC1rZXktdGhhdC1pcy1ub3QtbnVsbA==',
      capabilities: { create: [{ model: 'mock-t2v', modality: 't2v', acceptsFirstFrame: false, acceptsReferenceImages: false, maxReferenceImages: 0, entitlementVerifiedAt: new Date() }] },
    },
  })
  const capability = await env.db.modelCapability.findFirstOrThrow({ where: { connectionId: connection.id } })
  await env.db.capabilityBinding.create({ data: { organizationId, slot: 'VIDEO_T2V', capabilityId: capability.id, priority: 10 } })
}

describe('artifact extend route', () => {
  it('requires auth and refuses non-video artifacts and unsupported pools', async () => {
    expect((await env.app.inject({ method: 'POST', url: `/api/artifacts/${videoArtifactId}/extend` })).statusCode).toBe(401)

    const notVideo = await env.app.inject({ method: 'POST', url: `/api/artifacts/${imageArtifactId}/extend`, headers: authHeaders(ownerToken) })
    expect(notVideo.statusCode).toBe(400)
    expect(notVideo.json().error).toContain('video')

    // 没有任何实现了 extend 的视频模型在绑:409 点名,而不是静默排队一个必失败的操作。
    const noSupport = await env.app.inject({ method: 'POST', url: `/api/artifacts/${videoArtifactId}/extend`, headers: authHeaders(ownerToken) })
    expect(noSupport.statusCode).toBe(409)
    expect(noSupport.json().error).toContain('supports extend')
  })

  it('accepts the operation and records it with the requested duration', async () => {
    await bindMockVideo()
    const res = await env.app.inject({
      method: 'POST',
      url: `/api/artifacts/${videoArtifactId}/extend`,
      headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' },
      payload: { durationMs: 4000 },
    })
    expect(res.statusCode).toBe(202)
    const body = res.json() as { operation: { id: string; kind: string; status: string; durationMs: number } }
    expect(body.operation.kind).toBe('video_extend')
    expect(body.operation.status).toBe('QUEUED')
    expect(body.operation.durationMs).toBe(4000)
    const stored = await env.db.artifactOperation.findUniqueOrThrow({ where: { id: body.operation.id } })
    expect(stored.sourceArtifactId).toBe(videoArtifactId)
    expect(JSON.parse(stored.requestSnapshot).parameters.durationMs).toBe(4000)
  })

  it('lets a human re-pin the extended cut through the selection endpoint', async () => {
    // 延长产物没有任务,选版接口经统一归属解析器认它——人可以把加长版换下来,也可以换回去。
    const extended = await env.db.mediaArtifact.create({
      data: { organizationId, taskId: null, stage: 'VIDEO', objectKey: `${organizationId}/${projectId}/${episodeId}/video/op/v1.mp4`, checksum: 'extended-1', mimeType: 'video/mp4', version: 1 },
    })
    const operation = await env.db.artifactOperation.create({
      data: {
        organizationId, kind: 'video_extend', sourceArtifactId: videoArtifactId, outputArtifactId: extended.id,
        connectionId: 'none', capabilityId: 'none', provider: 'mock', model: 'mock-t2v', status: 'SUCCEEDED',
        requestSnapshot: JSON.stringify({ input: { prompt: 'x' }, parameters: {}, storyboardId }),
      },
    })
    void operation
    const pin = await env.app.inject({
      method: 'POST',
      url: `/api/storyboards/${storyboardId}/video-selection`,
      headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' },
      payload: { artifactId: extended.id },
    })
    expect(pin.statusCode).toBe(200)
    expect(pin.json().selectedVideoArtifactId).toBe(extended.id)
    // 无归属的裸制品(没有任务、没有成功操作)仍被拒。
    const orphan = await env.db.mediaArtifact.create({
      data: { organizationId, taskId: null, stage: 'VIDEO', objectKey: `${organizationId}/orphan.mp4`, checksum: 'orphan', mimeType: 'video/mp4', version: 1 },
    })
    const refused = await env.app.inject({
      method: 'POST',
      url: `/api/storyboards/${storyboardId}/video-selection`,
      headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' },
      payload: { artifactId: orphan.id },
    })
    expect(refused.statusCode).toBe(400)
  })
})

describe('unified ownership resolution (US-003)', () => {
  it('resolves imports, legacy pointers and failed-task artifacts through one trust path', async () => {
    const { resolveArtifactOwnership } = await import('@studio/db')
    const imported = await env.db.mediaArtifact.create({
      data: { organizationId, taskId: null, stage: 'AUDIO', objectKey: `${organizationId}/${projectId}/${episodeId}/AUDIO/imp/v1.wav`, checksum: 'imp-1', mimeType: 'audio/wav', version: 1, metadata: JSON.stringify({ imported: true }) },
    })
    await env.db.storyboard.update({ where: { id: storyboardId }, data: { importedVoiceArtifactId: imported.id } })
    await expect(resolveArtifactOwnership(env.db, imported.id, organizationId)).resolves.toMatchObject({ origin: 'manual_import', storyboardId, terminal: true })

    const legacy = await env.db.mediaArtifact.create({
      data: { organizationId, taskId: null, stage: 'VIDEO', objectKey: `${organizationId}/${projectId}/${episodeId}/VIDEO/old/v1.mp4`, checksum: 'legacy-1', mimeType: 'video/mp4', version: 1 },
    })
    await expect(resolveArtifactOwnership(env.db, legacy.id, organizationId)).resolves.toMatchObject({ origin: 'legacy_pointer', storyboardId: null, terminal: false })

    const failedTask = await env.db.generationTask.create({
      data: { organizationId, batchId: (await env.db.generationBatch.findFirstOrThrow({ where: { episodeId } })).id, stage: 'VIDEO', status: 'FAILED', storyboardId },
    })
    const failedArtifact = await env.db.mediaArtifact.create({
      data: { organizationId, taskId: failedTask.id, stage: 'VIDEO', objectKey: `${organizationId}/${projectId}/${episodeId}/VIDEO/fail/v1.mp4`, checksum: 'fail-1', mimeType: 'video/mp4', version: 1 },
    })
    await expect(resolveArtifactOwnership(env.db, failedArtifact.id, organizationId)).resolves.toMatchObject({ origin: 'generation_task', terminal: false })
    const refused = await env.app.inject({
      method: 'POST', url: `/api/storyboards/${storyboardId}/video-selection`,
      headers: { ...authHeaders(ownerToken), 'content-type': 'application/json' }, payload: { artifactId: failedArtifact.id },
    })
    expect(refused.statusCode).toBe(400)

    const outsider = await env.register('us003-outsider@example.com', 'Outsider Org')
    await expect(resolveArtifactOwnership(env.db, videoArtifactId, outsider.organization.id)).resolves.toBeNull()
  })
})
