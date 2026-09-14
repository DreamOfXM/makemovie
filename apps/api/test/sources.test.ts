import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv

let ownerToken: string
let editorToken: string
let viewerToken: string
let organizationId: string
let projectId: string
let episodeId: string
let rivalEpisodeId: string
let storyboardIds: string[] = []

// CJK content keeps the char/byte distinction visible in contentLength.
const sourceContentV1 = '第一章 雨夜\n主角在巷口停下，回头看了一眼。'
const sourceContentV2 = '第二章 天台\n追逐戏改到天台，风声盖过台词。'

interface VersionSummary {
  id: string
  version: number
  checksum: string
  status: string
  contentLength: number
  content?: string
  // Only script versions trace back to a generating task.
  generationTaskId?: string | null
}

const sha256 = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex')

beforeAll(async () => {
  env = await startTestEnv()

  const owner = await env.register('src-owner@example.com', 'Source Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
  await env.register('src-editor@example.com', 'Source Editor Org')
  await env.register('src-viewer@example.com', 'Source Viewer Org')
  for (const [email, role] of [['src-editor@example.com', 'EDITOR'], ['src-viewer@example.com', 'VIEWER']] as const) {
    const added = await env.app.inject({ method: 'POST', url: '/members', headers: env.authHeaders(ownerToken), payload: { email, role } })
    expect(added.statusCode).toBe(201)
    const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123', organizationId } })
    expect(login.statusCode).toBe(200)
    if (role === 'EDITOR') editorToken = login.json().token as string
    else viewerToken = login.json().token as string
  }

  const rival = await env.register('src-rival@example.com', 'Rival Org')
  const rivalProject = await env.app.inject({ method: 'POST', url: '/projects', headers: env.authHeaders(rival.token), payload: { name: 'Rival Drama' } })
  expect(rivalProject.statusCode).toBe(201)
  const rivalEpisode = await env.app.inject({
    method: 'POST', url: `/projects/${rivalProject.json().id as string}/episodes`,
    headers: env.authHeaders(rival.token), payload: { number: 1, title: 'Rival EP1' },
  })
  expect(rivalEpisode.statusCode).toBe(201)
  rivalEpisodeId = rivalEpisode.json().id as string

  const project = await env.app.inject({ method: 'POST', url: '/projects', headers: env.authHeaders(ownerToken), payload: { name: 'Source Drama' } })
  expect(project.statusCode).toBe(201)
  projectId = project.json().id as string

  const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: env.authHeaders(ownerToken), payload: { number: 1, title: 'EP1' } })
  expect(episode.statusCode).toBe(201)
  episodeId = episode.json().id as string

  for (const [number, title, description] of [[1, 'SB1', 'Opening scene'], [2, 'SB2', 'Rooftop chase']] as const) {
    const storyboard = await env.app.inject({
      method: 'POST', url: `/episodes/${episodeId}/storyboards`, headers: env.authHeaders(ownerToken),
      payload: { number, title, durationMs: 8000, description, sourceExcerpt: '原文', continuityIn: '', continuityOut: '' },
    })
    expect(storyboard.statusCode).toBe(201)
    storyboardIds.push(storyboard.json().id as string)
  }

  sourceUrl = `/episodes/${episodeId}/source-versions`
  scriptUrl = `/episodes/${episodeId}/script-versions`
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

const authHeaders = (token: string) => env.authHeaders(token)
// Assigned in beforeAll: episodeId does not exist until the fixtures are created.
let sourceUrl: string
let scriptUrl: string

let sourceV1Id: string
let sourceV2Id: string
let scriptV1Id: string
let scriptV2Id: string

describe('source document versions', () => {
  it('refuses viewers, unknown episodes and episodes of another organization', async () => {
    const forbidden = await env.app.inject({ method: 'POST', url: sourceUrl, headers: authHeaders(viewerToken), payload: { content: sourceContentV1 } })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toMatch(/episode:write/)

    const missing = await env.app.inject({ method: 'POST', url: '/episodes/does-not-exist/source-versions', headers: authHeaders(editorToken), payload: { content: sourceContentV1 } })
    expect(missing.statusCode).toBe(404)

    const foreign = await env.app.inject({ method: 'GET', url: `/episodes/${rivalEpisodeId}/source-versions`, headers: authHeaders(editorToken) })
    expect(foreign.statusCode).toBe(404)
    const foreignWrite = await env.app.inject({ method: 'POST', url: `/episodes/${rivalEpisodeId}/source-versions`, headers: authHeaders(editorToken), payload: { content: sourceContentV1 } })
    expect(foreignWrite.statusCode).toBe(404)

    // Reads only need membership.
    const readable = await env.app.inject({ method: 'GET', url: sourceUrl, headers: authHeaders(viewerToken) })
    expect(readable.statusCode).toBe(200)
    expect(readable.json()).toEqual({ versions: [] })
  })

  it('rejects missing, blank and oversized content', async () => {
    for (const content of [undefined, '', '   \n  ']) {
      const res = await env.app.inject({ method: 'POST', url: sourceUrl, headers: authHeaders(editorToken), payload: { content } })
      expect(res.statusCode).toBe(400)
    }
    const oversized = await env.app.inject({ method: 'POST', url: sourceUrl, headers: authHeaders(editorToken), payload: { content: 'a'.repeat(200_001) } })
    expect(oversized.statusCode).toBe(400)
    expect(await env.db.sourceDocumentVersion.count({ where: { episodeId } })).toBe(0)
  })

  it('uploads version 1 and rejects identical content as a duplicate', async () => {
    const created = await env.app.inject({ method: 'POST', url: sourceUrl, headers: authHeaders(editorToken), payload: { content: sourceContentV1 } })
    expect(created.statusCode).toBe(201)
    const version = created.json().version as VersionSummary
    expect(version.version).toBe(1)
    expect(version.status).toBe('DRAFT')
    expect(version.checksum).toBe(sha256(sourceContentV1))
    expect(version.content).toBe(sourceContentV1)
    expect(version.contentLength).toBe(sourceContentV1.length)
    sourceV1Id = version.id

    const duplicate = await env.app.inject({ method: 'POST', url: sourceUrl, headers: authHeaders(ownerToken), payload: { content: sourceContentV1 } })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json()).toEqual({ error: 'sources:duplicate' })
    expect(await env.db.sourceDocumentVersion.count({ where: { episodeId } })).toBe(1)

    const second = await env.app.inject({ method: 'POST', url: sourceUrl, headers: authHeaders(editorToken), payload: { content: sourceContentV2 } })
    expect(second.statusCode).toBe(201)
    expect(second.json().version.version).toBe(2)
    expect(second.json().version.status).toBe('DRAFT')
    sourceV2Id = second.json().version.id as string
  })

  it('lists versions newest first with a content length but no content', async () => {
    const res = await env.app.inject({ method: 'GET', url: sourceUrl, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    const versions = res.json().versions as VersionSummary[]
    expect(versions.map(version => version.version)).toEqual([2, 1])
    expect(versions.map(version => version.id)).toEqual([sourceV2Id, sourceV1Id])
    expect(versions.map(version => version.contentLength)).toEqual([sourceContentV2.length, sourceContentV1.length])
    expect(versions.map(version => version.status)).toEqual(['DRAFT', 'DRAFT'])
    for (const version of versions) {
      expect(Object.keys(version).sort()).toEqual(['checksum', 'contentLength', 'id', 'status', 'version'])
    }
  })

  it('returns one version with its content and 404s on an unknown version', async () => {
    const res = await env.app.inject({ method: 'GET', url: `${sourceUrl}/1`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    expect(res.json().version).toEqual({
      id: sourceV1Id,
      version: 1,
      checksum: sha256(sourceContentV1),
      status: 'DRAFT',
      contentLength: sourceContentV1.length,
      content: sourceContentV1,
    })

    expect((await env.app.inject({ method: 'GET', url: `${sourceUrl}/99`, headers: authHeaders(viewerToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'GET', url: `${sourceUrl}/abc`, headers: authHeaders(viewerToken) })).statusCode).toBe(404)
    // Version numbers are episode-scoped, so a rival's episode stays invisible.
    expect((await env.app.inject({ method: 'GET', url: `/episodes/${rivalEpisodeId}/source-versions/1`, headers: authHeaders(viewerToken) })).statusCode).toBe(404)
  })

  it('approves a source version once and refuses to approve it twice', async () => {
    const forbidden = await env.app.inject({ method: 'POST', url: `${sourceUrl}/1/approve`, headers: authHeaders(viewerToken) })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toMatch(/episode:write/)

    const res = await env.app.inject({ method: 'POST', url: `${sourceUrl}/1/approve`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(200)
    expect(res.json().version.status).toBe('APPROVED')
    expect((await env.db.sourceDocumentVersion.findUniqueOrThrow({ where: { id: sourceV1Id } })).status).toBe('APPROVED')

    const again = await env.app.inject({ method: 'POST', url: `${sourceUrl}/1/approve`, headers: authHeaders(editorToken) })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toEqual({ error: 'sources:alreadyApproved' })

    expect((await env.app.inject({ method: 'POST', url: `${sourceUrl}/99/approve`, headers: authHeaders(editorToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'POST', url: '/episodes/does-not-exist/source-versions/1/approve', headers: authHeaders(editorToken) })).statusCode).toBe(404)
  })
})

describe('script versions', () => {
  it('refuses to derive from a source version that is not approved', async () => {
    const forbidden = await env.app.inject({ method: 'POST', url: scriptUrl, headers: authHeaders(viewerToken), payload: { sourceVersion: 1 } })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toMatch(/episode:write/)

    // Version 2 is still DRAFT.
    for (const body of [{ sourceVersion: 2 }, { sourceVersion: 99 }, {}, { sourceVersion: '1' }]) {
      const res = await env.app.inject({ method: 'POST', url: scriptUrl, headers: authHeaders(editorToken), payload: body })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'sources:sourceNotApproved' })
    }
    expect(await env.db.scriptVersion.count({ where: { episodeId } })).toBe(0)
  })

  it('derives script version 1 from the approved source version', async () => {
    const res = await env.app.inject({ method: 'POST', url: scriptUrl, headers: authHeaders(editorToken), payload: { sourceVersion: 1 } })
    expect(res.statusCode).toBe(201)
    const version = res.json().version as VersionSummary
    expect(version.version).toBe(1)
    expect(version.status).toBe('DRAFT')
    expect(version.content).toBe(sourceContentV1)
    expect(version.checksum).toBe(sha256(sourceContentV1))
    expect(version.contentLength).toBe(sourceContentV1.length)
    scriptV1Id = version.id

    const stored = await env.db.scriptVersion.findUniqueOrThrow({ where: { id: scriptV1Id } })
    expect(stored.episodeId).toBe(episodeId)
    expect(stored.content).toBe(sourceContentV1)
  })

  it('re-points every storyboard at the script version being approved', async () => {
    for (const storyboardId of storyboardIds) {
      expect((await env.db.storyboard.findUniqueOrThrow({ where: { id: storyboardId } })).scriptVersionId).toBeNull()
    }

    const forbidden = await env.app.inject({ method: 'POST', url: `${scriptUrl}/1/approve`, headers: authHeaders(viewerToken) })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toMatch(/episode:write/)

    const res = await env.app.inject({ method: 'POST', url: `${scriptUrl}/1/approve`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(200)
    expect(res.json().storyboardsUpdated).toBe(storyboardIds.length)
    expect((res.json().version as VersionSummary).status).toBe('APPROVED')

    for (const storyboardId of storyboardIds) {
      const storyboard = await env.db.storyboard.findUniqueOrThrow({ where: { id: storyboardId } })
      expect(storyboard.scriptVersionId).toBe(scriptV1Id)
    }

    const again = await env.app.inject({ method: 'POST', url: `${scriptUrl}/1/approve`, headers: authHeaders(editorToken) })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toEqual({ error: 'sources:alreadyApproved' })
    expect((await env.app.inject({ method: 'POST', url: `${scriptUrl}/99/approve`, headers: authHeaders(editorToken) })).statusCode).toBe(404)
  })

  it('increments the script version and lists scripts newest first', async () => {
    expect((await env.app.inject({ method: 'POST', url: `${sourceUrl}/2/approve`, headers: authHeaders(ownerToken) })).statusCode).toBe(200)

    const derived = await env.app.inject({ method: 'POST', url: scriptUrl, headers: authHeaders(editorToken), payload: { sourceVersion: 2 } })
    expect(derived.statusCode).toBe(201)
    expect(derived.json().version.version).toBe(2)
    scriptV2Id = derived.json().version.id as string

    const res = await env.app.inject({ method: 'GET', url: scriptUrl, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    const versions = res.json().versions as VersionSummary[]
    expect(versions.map(version => version.version)).toEqual([2, 1])
    expect(versions.map(version => version.id)).toEqual([scriptV2Id, scriptV1Id])
    expect(versions.map(version => version.contentLength)).toEqual([sourceContentV2.length, sourceContentV1.length])
    expect(versions.map(version => version.status)).toEqual(['DRAFT', 'APPROVED'])
    for (const version of versions) {
      expect(Object.keys(version).sort()).toEqual(['checksum', 'contentLength', 'generationTaskId', 'id', 'status', 'version'])
    }
  })

  it('returns one script version with its content and 404s on an unknown version', async () => {
    // The list above carries no text, so reading a single version is what makes
    // an AI-written script reviewable before a human approves it.
    const res = await env.app.inject({ method: 'GET', url: `${scriptUrl}/1`, headers: authHeaders(viewerToken) })
    expect(res.statusCode).toBe(200)
    expect(res.json().version).toEqual({
      id: scriptV1Id,
      version: 1,
      checksum: sha256(sourceContentV1),
      status: 'APPROVED',
      contentLength: sourceContentV1.length,
      content: sourceContentV1,
      generationTaskId: null,
    })

    expect((await env.app.inject({ method: 'GET', url: `${scriptUrl}/99`, headers: authHeaders(viewerToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'GET', url: `${scriptUrl}/abc`, headers: authHeaders(viewerToken) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'GET', url: '/episodes/does-not-exist/script-versions/1', headers: authHeaders(viewerToken) })).statusCode).toBe(404)
    // Version numbers are episode-scoped, so a rival's episode stays invisible.
    expect((await env.app.inject({ method: 'GET', url: `/episodes/${rivalEpisodeId}/script-versions/1`, headers: authHeaders(viewerToken) })).statusCode).toBe(404)
  })

  it('moves the storyboards to the newest approved script version', async () => {
    const res = await env.app.inject({ method: 'POST', url: `${scriptUrl}/2/approve`, headers: authHeaders(editorToken) })
    expect(res.statusCode).toBe(200)
    expect(res.json().storyboardsUpdated).toBe(storyboardIds.length)

    const storyboards = await env.db.storyboard.findMany({ where: { episodeId }, orderBy: { number: 'asc' } })
    expect(storyboards.map(storyboard => storyboard.scriptVersionId)).toEqual([scriptV2Id, scriptV2Id])
  })

  it('edits a script version, recomputes its checksum, and resets it to draft', async () => {
    const edited = '修改后的剧本：沈亦在雨夜中追踪线索。'

    const forbidden = await env.app.inject({ method: 'PATCH', url: `${scriptUrl}/2`, headers: authHeaders(viewerToken), payload: { content: edited } })
    expect(forbidden.statusCode).toBe(403)

    const res = await env.app.inject({ method: 'PATCH', url: `${scriptUrl}/2`, headers: authHeaders(editorToken), payload: { content: edited } })
    expect(res.statusCode).toBe(200)
    const version = res.json().version as VersionSummary
    expect(version.content).toBe(edited)
    expect(version.checksum).toBe(sha256(edited))
    expect(version.status).toBe('DRAFT')

    const blank = await env.app.inject({ method: 'PATCH', url: `${scriptUrl}/2`, headers: authHeaders(editorToken), payload: { content: '   ' } })
    expect(blank.statusCode).toBe(400)
    expect((await env.app.inject({ method: 'PATCH', url: `${scriptUrl}/99`, headers: authHeaders(editorToken), payload: { content: edited } })).statusCode).toBe(404)

    const readBack = await env.app.inject({ method: 'GET', url: `${scriptUrl}/2`, headers: authHeaders(viewerToken) })
    expect(readBack.statusCode).toBe(200)
    expect(readBack.json().version.content).toBe(edited)
    expect(readBack.json().version.status).toBe('DRAFT')
  })

  it('records the source and script events in the audit trail', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/audit-events', headers: authHeaders(ownerToken) })
    expect(res.statusCode).toBe(200)
    const events = res.json().events as { action: string; entityType: string }[]
    expect(events.some(event => event.action === 'source.upload' && event.entityType === 'SourceDocumentVersion')).toBe(true)
    expect(events.some(event => event.action === 'source.approve' && event.entityType === 'SourceDocumentVersion')).toBe(true)
    expect(events.some(event => event.action === 'script.derive' && event.entityType === 'ScriptVersion')).toBe(true)
    expect(events.some(event => event.action === 'script.approve' && event.entityType === 'ScriptVersion')).toBe(true)
    expect(events.some(event => event.action === 'script.edit' && event.entityType === 'ScriptVersion')).toBe(true)
  })
})
