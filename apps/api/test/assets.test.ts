import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv

let ownerToken: string
let editorToken: string
let viewerToken: string
let organizationId: string
let projectId: string
let episodeId: string
let rivalEpisodeId: string

interface AssetVersionDto {
  id: string
  version: number
  description: string
  status: string
  artifact: { id: string; mimeType: string; objectKey: string; downloadUrl: string } | null
}

interface AssetDto {
  id: string
  kind: string
  name: string
  description: string
  status: string
  versions: AssetVersionDto[]
  generationTaskId: string | null
}

beforeAll(async () => {
  env = await startTestEnv()

  const owner = await env.register('asset-owner@example.com', 'Asset Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
  await env.register('asset-editor@example.com', 'Asset Editor Org')
  await env.register('asset-viewer@example.com', 'Asset Viewer Org')
  for (const [email, role] of [['asset-editor@example.com', 'EDITOR'], ['asset-viewer@example.com', 'VIEWER']] as const) {
    const added = await env.app.inject({ method: 'POST', url: '/members', headers: env.authHeaders(ownerToken), payload: { email, role } })
    expect(added.statusCode).toBe(201)
    const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123', organizationId } })
    expect(login.statusCode).toBe(200)
    if (role === 'EDITOR') editorToken = login.json().token as string
    else viewerToken = login.json().token as string
  }

  const rival = await env.register('asset-rival@example.com', 'Rival Org')
  const rivalProject = await env.app.inject({ method: 'POST', url: '/projects', headers: env.authHeaders(rival.token), payload: { name: 'Rival Drama' } })
  expect(rivalProject.statusCode).toBe(201)
  const rivalEpisode = await env.app.inject({
    method: 'POST', url: `/projects/${rivalProject.json().id as string}/episodes`,
    headers: env.authHeaders(rival.token), payload: { number: 1, title: 'Rival EP1' },
  })
  expect(rivalEpisode.statusCode).toBe(201)
  rivalEpisodeId = rivalEpisode.json().id as string

  const project = await env.app.inject({ method: 'POST', url: '/projects', headers: env.authHeaders(ownerToken), payload: { name: 'Asset Drama' } })
  expect(project.statusCode).toBe(201)
  projectId = project.json().id as string

  const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: env.authHeaders(ownerToken), payload: { number: 1, title: 'EP1' } })
  expect(episode.statusCode).toBe(201)
  episodeId = episode.json().id as string

  assetsUrl = `/episodes/${episodeId}/assets`
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

const authHeaders = (token: string) => env.authHeaders(token)
// Assigned in beforeAll: episodeId does not exist until the fixtures are created.
let assetsUrl: string

let protagonistId: string
let umbrellaId: string

describe('episode assets', () => {
  it('refuses viewers, unknown episodes and episodes of another organization', async () => {
    const forbidden = await env.app.inject({ method: 'POST', url: assetsUrl, headers: authHeaders(viewerToken), payload: { kind: 'character', name: '小雨', description: '雨夜中撑伞的少女' } })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toMatch(/episode:write/)

    const missing = await env.app.inject({ method: 'POST', url: '/episodes/does-not-exist/assets', headers: authHeaders(editorToken), payload: { kind: 'character', name: '小雨', description: '雨夜中撑伞的少女' } })
    expect(missing.statusCode).toBe(404)

    const foreign = await env.app.inject({ method: 'GET', url: `/episodes/${rivalEpisodeId}/assets`, headers: authHeaders(editorToken) })
    expect(foreign.statusCode).toBe(404)
    const foreignWrite = await env.app.inject({ method: 'POST', url: `/episodes/${rivalEpisodeId}/assets`, headers: authHeaders(editorToken), payload: { kind: 'character', name: '小雨', description: '雨夜中撑伞的少女' } })
    expect(foreignWrite.statusCode).toBe(404)

    // Reads only need membership.
    const readable = await env.app.inject({ method: 'GET', url: assetsUrl, headers: authHeaders(viewerToken) })
    expect(readable.statusCode).toBe(200)
    expect(readable.json()).toEqual({ assets: [] })
  })

  it('rejects missing, blank and oversized kind, name and description', async () => {
    for (const payload of [
      {},
      { kind: 'character' },
      { kind: 'character', name: '小雨' },
      { kind: '   ', name: '小雨', description: '雨夜中撑伞的少女' },
      { kind: 'character', name: '  \n ', description: '雨夜中撑伞的少女' },
      { kind: 'character', name: '小雨', description: '   ' },
    ]) {
      const res = await env.app.inject({ method: 'POST', url: assetsUrl, headers: authHeaders(editorToken), payload })
      expect(res.statusCode).toBe(400)
    }
    const oversized = await env.app.inject({ method: 'POST', url: assetsUrl, headers: authHeaders(editorToken), payload: { kind: 'character', name: '小雨', description: 'a'.repeat(200_001) } })
    expect(oversized.statusCode).toBe(400)
    expect(await env.db.asset.count({ where: { episodeId } })).toBe(0)
  })

  it('creates a DRAFT asset with no versions and rejects a duplicate (kind, name)', async () => {
    const created = await env.app.inject({ method: 'POST', url: assetsUrl, headers: authHeaders(editorToken), payload: { kind: 'character', name: '小雨', description: '雨夜中撑伞的少女' } })
    expect(created.statusCode).toBe(201)
    const asset = created.json().asset as AssetDto
    expect(Object.keys(asset).sort()).toEqual(['description', 'generationTaskId', 'id', 'kind', 'name', 'status', 'versions'])
    // Authored by a human, so no task produced it yet.
    expect(asset.generationTaskId).toBeNull()
    expect(asset.kind).toBe('character')
    expect(asset.name).toBe('小雨')
    expect(asset.description).toBe('雨夜中撑伞的少女')
    expect(asset.status).toBe('DRAFT')
    expect(asset.versions).toEqual([])
    protagonistId = asset.id

    const duplicate = await env.app.inject({ method: 'POST', url: assetsUrl, headers: authHeaders(ownerToken), payload: { kind: 'character', name: '小雨', description: '另一个重复' } })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json()).toEqual({ error: 'assets:duplicate' })
    expect(await env.db.asset.count({ where: { episodeId } })).toBe(1)

    // The same name stays allowed under a different kind.
    const prop = await env.app.inject({ method: 'POST', url: assetsUrl, headers: authHeaders(editorToken), payload: { kind: 'prop', name: '小雨', description: '小雨从不离身的黑伞' } })
    expect(prop.statusCode).toBe(201)
    expect(prop.json().asset.status).toBe('DRAFT')
    expect(prop.json().asset.versions).toEqual([])
    umbrellaId = prop.json().asset.id as string
  })

  it('lists assets newest first with their versions and artifacts', async () => {
    const artifact = await env.db.mediaArtifact.create({
      data: { organizationId, objectKey: `${organizationId}/assets/v2.png`, checksum: 'checksum-asset', mimeType: 'image/png', version: 1 },
    })
    await env.db.assetVersion.create({ data: { assetId: protagonistId, version: 1, description: '第一版参考图', promptSnapshot: 'character 小雨: 雨夜中撑伞的少女', status: 'APPROVED' } })
    await env.db.assetVersion.create({ data: { assetId: protagonistId, version: 2, description: '第二版参考图', promptSnapshot: 'character 小雨: 雨夜中撑伞的少女', artifactId: artifact.id, status: 'DRAFT' } })

    const res = await env.app.inject({ method: 'GET', url: assetsUrl, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    const assets = res.json().assets as AssetDto[]
    expect(assets.map(asset => asset.id)).toEqual([umbrellaId, protagonistId])
    expect(assets[0].versions).toEqual([])
    expect(assets[1].versions.map(version => version.version)).toEqual([2, 1])
    for (const version of assets[1].versions) {
      expect(Object.keys(version).sort()).toEqual(['artifact', 'description', 'id', 'status', 'version'])
    }
    expect(assets[1].versions[0]).toEqual({
      id: expect.any(String),
      version: 2,
      description: '第二版参考图',
      status: 'DRAFT',
      artifact: {
        id: artifact.id,
        mimeType: 'image/png',
        objectKey: `${organizationId}/assets/v2.png`,
        width: null,
        height: null,
        durationMs: null,
        downloadUrl: `/artifacts/${artifact.id}/content`,
      },
    })
    expect(assets[1].versions[1]).toMatchObject({ version: 1, description: '第一版参考图', status: 'APPROVED', artifact: null })
  })
})

describe('asset version approval', () => {
  let approvedAssetId: string
  let approveUrl: string

  it('approves a seeded version once and flips the asset to APPROVED', async () => {
    const created = await env.app.inject({ method: 'POST', url: assetsUrl, headers: authHeaders(editorToken), payload: { kind: 'scene', name: '巷口', description: '雨夜的巷口' } })
    expect(created.statusCode).toBe(201)
    approvedAssetId = created.json().asset.id as string
    const seeded = await env.db.assetVersion.create({ data: { assetId: approvedAssetId, version: 1, description: '生成的参考图', promptSnapshot: 'scene 巷口: 雨夜的巷口', status: 'DRAFT' } })
    approveUrl = `${assetsUrl}/${approvedAssetId}/versions/1/approve`

    const forbidden = await env.app.inject({ method: 'POST', url: approveUrl, headers: authHeaders(viewerToken) })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toMatch(/episode:write/)

    const res = await env.app.inject({ method: 'POST', url: approveUrl, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(200)
    expect(res.json().version).toMatchObject({ id: seeded.id, version: 1, status: 'APPROVED', artifact: null })
    expect(res.json().asset).toMatchObject({ id: approvedAssetId, status: 'APPROVED' })
    expect((await env.db.assetVersion.findUniqueOrThrow({ where: { id: seeded.id } })).status).toBe('APPROVED')
    expect((await env.db.asset.findUniqueOrThrow({ where: { id: approvedAssetId } })).status).toBe('APPROVED')

    const again = await env.app.inject({ method: 'POST', url: approveUrl, headers: authHeaders(editorToken) })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toEqual({ error: 'assets:alreadyApproved' })
  })

  it('404s on unknown assets, versions and episodes of another organization', async () => {
    expect((await env.app.inject({ method: 'POST', url: `${assetsUrl}/does-not-exist/versions/1/approve`, headers: authHeaders(editorToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'POST', url: `${assetsUrl}/${approvedAssetId}/versions/99/approve`, headers: authHeaders(editorToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'POST', url: `${assetsUrl}/${approvedAssetId}/versions/abc/approve`, headers: authHeaders(editorToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'POST', url: '/episodes/does-not-exist/assets/x/versions/1/approve', headers: authHeaders(editorToken) })).statusCode).toBe(404)

    // An asset on a rival episode stays invisible and unapprovable.
    const rivalAsset = await env.db.asset.create({ data: { episodeId: rivalEpisodeId, kind: 'character', name: 'Rival Lead', description: '对手角色' } })
    const rivalVersion = await env.db.assetVersion.create({ data: { assetId: rivalAsset.id, version: 1, description: '对手版本', status: 'DRAFT' } })
    const foreign = await env.app.inject({ method: 'POST', url: `/episodes/${rivalEpisodeId}/assets/${rivalAsset.id}/versions/1/approve`, headers: authHeaders(editorToken) })
    expect(foreign.statusCode).toBe(404)
    expect((await env.db.assetVersion.findUniqueOrThrow({ where: { id: rivalVersion.id } })).status).toBe('DRAFT')
  })

  it('records the asset events in the audit trail', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/audit-events', headers: authHeaders(ownerToken) })
    expect(res.statusCode).toBe(200)
    const events = res.json().events as { action: string; entityType: string }[]
    expect(events.some(event => event.action === 'asset.create' && event.entityType === 'Asset')).toBe(true)
    expect(events.some(event => event.action === 'asset.approve' && event.entityType === 'AssetVersion')).toBe(true)
  })
})
