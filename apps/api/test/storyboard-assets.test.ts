import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv

let ownerToken: string
let editorToken: string
let viewerToken: string
let organizationId: string
let projectId: string
let episodeId: string
let otherEpisodeId: string
let storyboardId: string
let rivalStoryboardId: string

interface StoryboardAssetDto {
  id: string
  kind: string
  name: string
  status: string
  role: string
}

beforeAll(async () => {
  env = await startTestEnv()

  const owner = await env.register('binding-owner@example.com', 'Binding Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
  await env.register('binding-editor@example.com', 'Binding Editor Org')
  await env.register('binding-viewer@example.com', 'Binding Viewer Org')
  for (const [email, role] of [['binding-editor@example.com', 'EDITOR'], ['binding-viewer@example.com', 'VIEWER']] as const) {
    const added = await env.app.inject({ method: 'POST', url: '/members', headers: env.authHeaders(ownerToken), payload: { email, role } })
    expect(added.statusCode).toBe(201)
    const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123', organizationId } })
    expect(login.statusCode).toBe(200)
    if (role === 'EDITOR') editorToken = login.json().token as string
    else viewerToken = login.json().token as string
  }

  const rival = await env.register('binding-rival@example.com', 'Rival Org')
  const rivalProject = await env.app.inject({ method: 'POST', url: '/projects', headers: env.authHeaders(rival.token), payload: { name: 'Rival Drama' } })
  expect(rivalProject.statusCode).toBe(201)
  const rivalEpisode = await env.app.inject({
    method: 'POST', url: `/projects/${rivalProject.json().id as string}/episodes`,
    headers: env.authHeaders(rival.token), payload: { number: 1, title: 'Rival EP1' },
  })
  expect(rivalEpisode.statusCode).toBe(201)
  const rivalStoryboard = await env.app.inject({
    method: 'POST', url: `/episodes/${rivalEpisode.json().id as string}/storyboards`,
    headers: env.authHeaders(rival.token),
    payload: { number: 1, title: 'Rival Shot', durationMs: 3000, description: '对手的分镜' },
  })
  expect(rivalStoryboard.statusCode).toBe(201)
  rivalStoryboardId = rivalStoryboard.json().id as string

  const project = await env.app.inject({ method: 'POST', url: '/projects', headers: env.authHeaders(ownerToken), payload: { name: 'Binding Drama' } })
  expect(project.statusCode).toBe(201)
  projectId = project.json().id as string

  const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: env.authHeaders(ownerToken), payload: { number: 1, title: 'EP1' } })
  expect(episode.statusCode).toBe(201)
  episodeId = episode.json().id as string

  const otherEpisode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: env.authHeaders(ownerToken), payload: { number: 2, title: 'EP2' } })
  expect(otherEpisode.statusCode).toBe(201)
  otherEpisodeId = otherEpisode.json().id as string

  const storyboard = await env.app.inject({
    method: 'POST', url: `/episodes/${episodeId}/storyboards`,
    headers: env.authHeaders(ownerToken),
    payload: { number: 1, title: '巷口相遇', durationMs: 3000, description: '小雨在巷口撑伞' },
  })
  expect(storyboard.statusCode).toBe(201)
  storyboardId = storyboard.json().id as string
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

const authHeaders = (token: string) => env.authHeaders(token)

let protagonistId: string
let umbrellaId: string
let otherEpisodeAssetId: string

describe('storyboard asset binding', () => {
  it('binds assets with PUT and lists them with details', async () => {
    const first = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/assets`, headers: authHeaders(editorToken), payload: { kind: 'character', name: '小雨', description: '雨夜中撑伞的少女' } })
    expect(first.statusCode).toBe(201)
    protagonistId = first.json().asset.id as string
    const second = await env.app.inject({ method: 'POST', url: `/episodes/${episodeId}/assets`, headers: authHeaders(editorToken), payload: { kind: 'prop', name: '黑伞', description: '小雨从不离身的黑伞' } })
    expect(second.statusCode).toBe(201)
    umbrellaId = second.json().asset.id as string

    const put = await env.app.inject({
      method: 'PUT', url: `/storyboards/${storyboardId}/assets`, headers: authHeaders(editorToken),
      payload: { assets: [{ assetId: protagonistId, role: 'lead' }, { assetId: umbrellaId, role: 'prop' }] },
    })
    expect(put.statusCode).toBe(200)
    const bound = put.json().assets as StoryboardAssetDto[]
    expect(bound).toHaveLength(2)
    expect(bound.map(item => item.id).sort()).toEqual([protagonistId, umbrellaId].sort())
    expect(bound.find(item => item.id === protagonistId)).toEqual({ id: protagonistId, kind: 'character', name: '小雨', status: 'DRAFT', role: 'lead' })

    const get = await env.app.inject({ method: 'GET', url: `/storyboards/${storyboardId}/assets`, headers: authHeaders(viewerToken) })
    expect(get.statusCode).toBe(200)
    expect(get.json().assets).toEqual(bound)

    expect(await env.db.storyboardAsset.count({ where: { storyboardId } })).toBe(2)
  })

  it('replaces the previous set on every PUT', async () => {
    const replace = await env.app.inject({
      method: 'PUT', url: `/storyboards/${storyboardId}/assets`, headers: authHeaders(ownerToken),
      payload: { assets: [{ assetId: umbrellaId, role: 'prop' }] },
    })
    expect(replace.statusCode).toBe(200)
    expect(replace.json().assets).toEqual([{ id: umbrellaId, kind: 'prop', name: '黑伞', status: 'DRAFT', role: 'prop' }])
    expect(await env.db.storyboardAsset.findMany({ where: { storyboardId } })).toMatchObject([{ assetId: umbrellaId, role: 'prop' }])

    // An empty array unbinds everything.
    const clear = await env.app.inject({
      method: 'PUT', url: `/storyboards/${storyboardId}/assets`, headers: authHeaders(ownerToken),
      payload: { assets: [] },
    })
    expect(clear.statusCode).toBe(200)
    expect(clear.json()).toEqual({ assets: [] })
    expect(await env.db.storyboardAsset.count({ where: { storyboardId } })).toBe(0)
  })

  it('rejects malformed bodies and assets of another episode', async () => {
    const missingArray = await env.app.inject({ method: 'PUT', url: `/storyboards/${storyboardId}/assets`, headers: authHeaders(editorToken), payload: {} })
    expect(missingArray.statusCode).toBe(400)

    const missingId = await env.app.inject({
      method: 'PUT', url: `/storyboards/${storyboardId}/assets`, headers: authHeaders(editorToken),
      payload: { assets: [{ role: 'lead' }] },
    })
    expect(missingId.statusCode).toBe(400)

    const badRole = await env.app.inject({
      method: 'PUT', url: `/storyboards/${storyboardId}/assets`, headers: authHeaders(editorToken),
      payload: { assets: [{ assetId: protagonistId, role: 42 }] },
    })
    expect(badRole.statusCode).toBe(400)

    const unknownAsset = await env.app.inject({
      method: 'PUT', url: `/storyboards/${storyboardId}/assets`, headers: authHeaders(editorToken),
      payload: { assets: [{ assetId: 'does-not-exist', role: 'lead' }] },
    })
    expect(unknownAsset.statusCode).toBe(400)
    expect(unknownAsset.json().error).toMatch(/does not belong to this episode/)

    const foreignEpisode = await env.app.inject({ method: 'POST', url: `/episodes/${otherEpisodeId}/assets`, headers: authHeaders(editorToken), payload: { kind: 'scene', name: '巷口', description: '雨夜的巷口' } })
    expect(foreignEpisode.statusCode).toBe(201)
    otherEpisodeAssetId = foreignEpisode.json().asset.id as string
    const crossEpisode = await env.app.inject({
      method: 'PUT', url: `/storyboards/${storyboardId}/assets`, headers: authHeaders(editorToken),
      payload: { assets: [{ assetId: protagonistId, role: 'lead' }, { assetId: otherEpisodeAssetId, role: 'scene' }] },
    })
    expect(crossEpisode.statusCode).toBe(400)
    expect(crossEpisode.json().error).toMatch(/does not belong to this episode/)
    // The failed replace must not touch the existing set.
    expect(await env.db.storyboardAsset.count({ where: { storyboardId } })).toBe(0)
  })

  it('404s on unknown storyboards and storyboards of another organization', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/storyboards/does-not-exist/assets', headers: authHeaders(editorToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'PUT', url: '/storyboards/does-not-exist/assets', headers: authHeaders(editorToken), payload: { assets: [] } })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'GET', url: `/storyboards/${rivalStoryboardId}/assets`, headers: authHeaders(editorToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'PUT', url: `/storyboards/${rivalStoryboardId}/assets`, headers: authHeaders(editorToken), payload: { assets: [] } })).statusCode).toBe(404)
  })

  it('refuses viewers on PUT but allows them to read bindings', async () => {
    const forbidden = await env.app.inject({
      method: 'PUT', url: `/storyboards/${storyboardId}/assets`, headers: authHeaders(viewerToken),
      payload: { assets: [{ assetId: protagonistId, role: 'lead' }] },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toMatch(/storyboard:write/)

    const readable = await env.app.inject({ method: 'GET', url: `/storyboards/${storyboardId}/assets`, headers: authHeaders(viewerToken) })
    expect(readable.statusCode).toBe(200)
  })

  it('exposes the bindings on the storyboard list and records an audit event', async () => {
    const put = await env.app.inject({
      method: 'PUT', url: `/storyboards/${storyboardId}/assets`, headers: authHeaders(editorToken),
      payload: { assets: [{ assetId: protagonistId, role: 'lead' }] },
    })
    expect(put.statusCode).toBe(200)

    const list = await env.app.inject({ method: 'GET', url: `/episodes/${episodeId}/storyboards`, headers: authHeaders(viewerToken) })
    expect(list.statusCode).toBe(200)
    const shot = (list.json() as { id: string; assets: { assetId: string; role: string }[] }[]).find(item => item.id === storyboardId)
    expect(shot?.assets).toEqual([{ storyboardId, assetId: protagonistId, role: 'lead' }])

    const audit = await env.app.inject({ method: 'GET', url: '/audit-events', headers: authHeaders(ownerToken) })
    expect(audit.statusCode).toBe(200)
    const events = audit.json().events as { action: string; entityType: string; entityId: string }[]
    expect(events.some(event => event.action === 'storyboard.assets' && event.entityType === 'Storyboard' && event.entityId === storyboardId)).toBe(true)
  })
})
