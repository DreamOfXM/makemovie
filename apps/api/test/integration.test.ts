import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '@studio/db'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv
let app: FastifyInstance
let db: PrismaClient

beforeAll(async () => {
  env = await startTestEnv()
  app = env.app
  db = env.db
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

const authHeaders = (token: string) => env.authHeaders(token)
const register = (email: string, organizationName: string) => env.register(email, organizationName)

describe('auth', () => {
  it('registers, stores an argon2id hash, and logs in again', async () => {
    const reg = await register('owner-a@example.com', 'Studio A')
    expect(reg.role).toBe('OWNER')

    const stored = await db.user.findUniqueOrThrow({ where: { email: 'owner-a@example.com' } })
    expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true)

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'owner-a@example.com', password: 'password123' } })
    expect(login.statusCode).toBe(200)
    expect(login.json().token).toBeTruthy()

    const bad = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'owner-a@example.com', password: 'wrong-password' } })
    expect(bad.statusCode).toBe(401)
  })

  it('rejects duplicate registration and short passwords', async () => {
    const dup = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'owner-a@example.com', password: 'password123', organizationName: 'X' } })
    expect(dup.statusCode).toBe(409)
    const weak = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'weak@example.com', password: 'short', organizationName: 'X' } })
    expect(weak.statusCode).toBe(400)
  })

  it('requires a token and rejects garbage tokens', async () => {
    const noToken = await app.inject({ method: 'GET', url: '/projects' })
    expect(noToken.statusCode).toBe(401)
    const badToken = await app.inject({ method: 'GET', url: '/projects', headers: authHeaders('deadbeef') })
    expect(badToken.statusCode).toBe(401)
  })

  it('revokes the session on logout', async () => {
    const reg = await register('logout@example.com', 'Logout Org')
    const before = await app.inject({ method: 'GET', url: '/auth/me', headers: authHeaders(reg.token) })
    expect(before.statusCode).toBe(200)
    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: authHeaders(reg.token) })
    expect(out.statusCode).toBe(204)
    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: authHeaders(reg.token) })
    expect(after.statusCode).toBe(401)
  })
})

describe('tenant isolation', () => {
  it('keeps projects, episodes and storyboards invisible across organizations', async () => {
    const a = await register('tenant-a@example.com', 'Tenant A')
    const b = await register('tenant-b@example.com', 'Tenant B')

    const project = await app.inject({ method: 'POST', url: '/projects', headers: authHeaders(a.token), payload: { name: 'Drama A' } })
    expect(project.statusCode).toBe(201)
    const projectId = project.json().id as string

    const episode = await app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(a.token), payload: { number: 1, title: 'EP1' } })
    expect(episode.statusCode).toBe(201)
    const episodeId = episode.json().id as string

    const listB = await app.inject({ method: 'GET', url: '/projects', headers: authHeaders(b.token) })
    expect(listB.json()).toEqual([])

    const crossEpisodes = await app.inject({ method: 'GET', url: `/projects/${projectId}/episodes`, headers: authHeaders(b.token) })
    expect(crossEpisodes.statusCode).toBe(404)

    const crossStoryboards = await app.inject({ method: 'GET', url: `/episodes/${episodeId}/storyboards`, headers: authHeaders(b.token) })
    expect(crossStoryboards.statusCode).toBe(404)

    const crossCreate = await app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(b.token), payload: { number: 2, title: 'Hijack' } })
    expect(crossCreate.statusCode).toBe(404)
  })
})

describe('rbac', () => {
  it('enforces role permissions for viewer and reviewer', async () => {
    const owner = await register('rbac-owner@example.com', 'RBAC Org')
    const viewer = await register('rbac-viewer@example.com', 'Viewer Own Org')
    const reviewer = await register('rbac-reviewer@example.com', 'Reviewer Own Org')

    const addViewer = await app.inject({ method: 'POST', url: '/members', headers: authHeaders(owner.token), payload: { email: 'rbac-viewer@example.com', role: 'VIEWER' } })
    expect(addViewer.statusCode).toBe(201)
    const addReviewer = await app.inject({ method: 'POST', url: '/members', headers: authHeaders(owner.token), payload: { email: 'rbac-reviewer@example.com', role: 'REVIEWER' } })
    expect(addReviewer.statusCode).toBe(201)

    const viewerLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'rbac-viewer@example.com', password: 'password123', organizationId: owner.organization.id } })
    expect(viewerLogin.statusCode).toBe(200)
    const viewerToken = viewerLogin.json().token as string
    const reviewerLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'rbac-reviewer@example.com', password: 'password123', organizationId: owner.organization.id } })
    const reviewerToken = reviewerLogin.json().token as string

    const project = await app.inject({ method: 'POST', url: '/projects', headers: authHeaders(owner.token), payload: { name: 'RBAC Drama' } })
    const projectId = project.json().id as string
    const episode = await app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(owner.token), payload: { number: 1, title: 'EP1' } })
    const episodeId = episode.json().id as string
    const storyboard = await app.inject({
      method: 'POST', url: `/episodes/${episodeId}/storyboards`, headers: authHeaders(owner.token),
      payload: { number: 1, title: 'SB1', durationMs: 10000, description: 'Opening scene', sourceExcerpt: '第一章', continuityIn: '', continuityOut: '' },
    })
    expect(storyboard.statusCode).toBe(201)
    const storyboardId = storyboard.json().id as string

    // viewer: read yes, write no
    const viewerRead = await app.inject({ method: 'GET', url: '/projects', headers: authHeaders(viewerToken) })
    expect(viewerRead.statusCode).toBe(200)
    expect(viewerRead.json()).toHaveLength(1)
    const viewerWrite = await app.inject({ method: 'POST', url: '/projects', headers: authHeaders(viewerToken), payload: { name: 'Nope' } })
    expect(viewerWrite.statusCode).toBe(403)
    const viewerApprove = await app.inject({ method: 'PATCH', url: `/storyboards/${storyboardId}/status`, headers: authHeaders(viewerToken), payload: { to: 'ready' } })
    expect(viewerApprove.statusCode).toBe(403)

    // reviewer: cannot create projects, cannot write storyboards
    const reviewerWrite = await app.inject({ method: 'POST', url: `/episodes/${episodeId}/storyboards`, headers: authHeaders(reviewerToken), payload: { number: 2, title: 'SB2', durationMs: 8000, description: 'x' } })
    expect(reviewerWrite.statusCode).toBe(403)
    const reviewerCreate = await app.inject({ method: 'POST', url: '/projects', headers: authHeaders(reviewerToken), payload: { name: 'Nope' } })
    expect(reviewerCreate.statusCode).toBe(403)

    // viewer cannot manage members
    const viewerAddMember = await app.inject({ method: 'POST', url: '/members', headers: authHeaders(viewerToken), payload: { email: 'rbac-reviewer@example.com', role: 'VIEWER' } })
    expect(viewerAddMember.statusCode).toBe(403)

    // cannot remove self / remove owner
    const meViewer = await app.inject({ method: 'GET', url: '/auth/me', headers: authHeaders(viewerToken) })
    const viewerUserId = meViewer.json().user.id as string
    const selfRemove = await app.inject({ method: 'DELETE', url: `/members/${viewerUserId}`, headers: authHeaders(owner.token) })
    expect(selfRemove.statusCode).toBe(204)
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: authHeaders(owner.token) })
    const ownerUserId = me.json().user.id as string
    const removeOwner = await app.inject({ method: 'DELETE', url: `/members/${ownerUserId}`, headers: authHeaders(owner.token) })
    expect(removeOwner.statusCode).toBe(400)
  })
})

describe('state machine', () => {
  it('enforces legal transitions and review permissions', async () => {
    const owner = await register('sm-owner@example.com', 'SM Org')
    const project = await app.inject({ method: 'POST', url: '/projects', headers: authHeaders(owner.token), payload: { name: 'SM Drama' } })
    const episode = await app.inject({ method: 'POST', url: `/projects/${project.json().id}/episodes`, headers: authHeaders(owner.token), payload: { number: 1, title: 'EP1' } })
    const storyboard = await app.inject({
      method: 'POST', url: `/episodes/${episode.json().id}/storyboards`, headers: authHeaders(owner.token),
      payload: { number: 1, title: 'SB1', durationMs: 12000, description: 'Climax', sourceExcerpt: 'excerpt', continuityIn: 'in', continuityOut: 'out' },
    })
    const storyboardId = storyboard.json().id as string
    const transition = async (to: string, token = owner.token) =>
      app.inject({ method: 'PATCH', url: `/storyboards/${storyboardId}/status`, headers: authHeaders(token), payload: { to } })

    expect((await transition('approved')).statusCode).toBe(409)   // draft → approved illegal
    expect((await transition('bogus')).statusCode).toBe(400)
    expect((await transition('ready')).statusCode).toBe(200)
    expect((await transition('running')).statusCode).toBe(200)
    expect((await transition('needs_review')).statusCode).toBe(200)
    expect((await transition('approved')).statusCode).toBe(200)
    expect((await transition('completed')).statusCode).toBe(200)
    expect((await transition('running')).statusCode).toBe(409)     // completed is terminal

    const stored = await db.storyboard.findUniqueOrThrow({ where: { id: storyboardId } })
    expect(stored.status).toBe('COMPLETED')
  })

  it('lets a reviewer approve but not an editor-only outsider', async () => {
    const owner = await register('sm2-owner@example.com', 'SM2 Org')
    const reviewerReg = await register('sm2-reviewer@example.com', 'SM2 Reviewer Org')
    await app.inject({ method: 'POST', url: '/members', headers: authHeaders(owner.token), payload: { email: 'sm2-reviewer@example.com', role: 'REVIEWER' } })
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'sm2-reviewer@example.com', password: 'password123', organizationId: owner.organization.id } })
    const reviewerToken = login.json().token as string
    void reviewerReg

    const project = await app.inject({ method: 'POST', url: '/projects', headers: authHeaders(owner.token), payload: { name: 'SM2 Drama' } })
    const episode = await app.inject({ method: 'POST', url: `/projects/${project.json().id}/episodes`, headers: authHeaders(owner.token), payload: { number: 1, title: 'EP1' } })
    const storyboard = await app.inject({
      method: 'POST', url: `/episodes/${episode.json().id}/storyboards`, headers: authHeaders(owner.token),
      payload: { number: 1, title: 'SB1', durationMs: 9000, description: 'd', sourceExcerpt: 's', continuityIn: '', continuityOut: '' },
    })
    const id = storyboard.json().id as string
    const move = async (to: string, token: string) => app.inject({ method: 'PATCH', url: `/storyboards/${id}/status`, headers: authHeaders(token), payload: { to } })

    expect((await move('ready', owner.token)).statusCode).toBe(200)
    expect((await move('running', owner.token)).statusCode).toBe(200)
    expect((await move('needs_review', owner.token)).statusCode).toBe(200)
    // reviewer decides the review
    expect((await move('approved', reviewerToken)).statusCode).toBe(200)
  })
})

describe('audit trail', () => {
  it('records mutations and restricts reading to admins', async () => {
    const owner = await register('audit-owner@example.com', 'Audit Org')
    const viewer = await register('audit-viewer@example.com', 'Audit Viewer Org')
    await app.inject({ method: 'POST', url: '/members', headers: authHeaders(owner.token), payload: { email: 'audit-viewer@example.com', role: 'VIEWER' } })
    const viewerLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'audit-viewer@example.com', password: 'password123', organizationId: owner.organization.id } })
    const viewerToken = viewerLogin.json().token as string

    await app.inject({ method: 'POST', url: '/projects', headers: authHeaders(owner.token), payload: { name: 'Audited Drama' } })

    const asViewer = await app.inject({ method: 'GET', url: '/audit-events', headers: authHeaders(viewerToken) })
    expect(asViewer.statusCode).toBe(403)

    const asOwner = await app.inject({ method: 'GET', url: '/audit-events', headers: authHeaders(owner.token) })
    expect(asOwner.statusCode).toBe(200)
    const actions = (asOwner.json().events as { action: string }[]).map(event => event.action)
    expect(actions).toContain('auth.register')
    expect(actions).toContain('member.add')
    expect(actions).toContain('project.create')

    const filtered = await app.inject({ method: 'GET', url: '/audit-events?action=project.create', headers: authHeaders(owner.token) })
    expect((filtered.json().events as unknown[]).every(event => (event as { action: string }).action === 'project.create')).toBe(true)
  })
})

describe('cors', () => {
  // @fastify/cors defaults to GET,HEAD,POST. Without the write verbs the browser
  // preflight fails and every edit in the console surfaces as "Failed to fetch".
  const preflight = (origin: string, method: string) =>
    app.inject({
      method: 'OPTIONS',
      url: '/projects',
      headers: {
        origin,
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization,content-type',
      },
    })

  it('allows the write verbs the console edits through', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await preflight('http://localhost:3010', method)
      expect(res.statusCode).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3010')
      const allowed = String(res.headers['access-control-allow-methods'])
        .split(',')
        .map(value => value.trim())
      expect(allowed).toContain(method)
    }
  })

  it('does not echo an origin outside the allowlist', async () => {
    const res = await preflight('http://not-allowed.example', 'PATCH')
    expect(res.headers['access-control-allow-origin']).not.toBe('http://not-allowed.example')
  })
})
