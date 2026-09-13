import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { isRole, type Role } from '@studio/domain'
import { hashPassword, verifyPassword } from '@studio/security'
import { recordAudit } from '../lib/audit.js'
import { createSession, revokeSession } from '../lib/sessions.js'
import { authenticate } from '../plugins/auth.js'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const AUTH_RATE_LIMIT = { rateLimit: { max: 20, timeWindow: '5 minutes' } }

function organizationSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${base || 'org'}-${randomBytes(3).toString('hex')}`
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email?: string; password?: string; name?: string; organizationName?: string } }>(
    '/register',
    { config: AUTH_RATE_LIMIT },
    async (request, reply) => {
      const { email, password, name, organizationName } = request.body ?? {}
      if (!email || !EMAIL_PATTERN.test(email)) return reply.code(400).send({ error: 'A valid email is required' })
      if (!password || password.length < 8) return reply.code(400).send({ error: 'Password must be at least 8 characters' })
      if (!organizationName?.trim()) return reply.code(400).send({ error: 'organizationName is required' })

      const db = app.db
      if (await db.user.findUnique({ where: { email } })) {
        return reply.code(409).send({ error: 'Email already registered' })
      }

      const passwordHash = await hashPassword(password)
      const organization = await db.organization.create({ data: { name: organizationName.trim(), slug: organizationSlug(organizationName) } })
      const user = await db.user.create({
        data: {
          email,
          name: name?.trim() || null,
          passwordHash,
          memberships: { create: { organizationId: organization.id, role: 'OWNER' } },
        },
      })
      await recordAudit(db, { organizationId: organization.id, userId: user.id, action: 'auth.register', entityType: 'Organization', entityId: organization.id, payload: { email } })
      const token = await createSession(db, user.id, organization.id, app.config.sessionTtlMs)
      return reply.code(201).send({
        token,
        user: { id: user.id, email: user.email, name: user.name },
        organization: { id: organization.id, name: organization.name, slug: organization.slug },
        role: 'OWNER',
      })
    },
  )

  app.post<{ Body: { email?: string; password?: string; organizationId?: string } }>(
    '/login',
    { config: AUTH_RATE_LIMIT },
    async (request, reply) => {
      const { email, password, organizationId } = request.body ?? {}
      if (!email || !password) return reply.code(400).send({ error: 'email and password are required' })

      const db = app.db
      const user = await db.user.findUnique({ where: { email }, include: { memberships: { include: { organization: true } } } })
      if (!user || user.memberships.length === 0 || !(await verifyPassword(password, user.passwordHash))) {
        return reply.code(401).send({ error: 'Invalid credentials' })
      }

      const membership = organizationId
        ? user.memberships.find(item => item.organizationId === organizationId)
        : user.memberships[0]
      if (!membership) return reply.code(403).send({ error: 'Not a member of the requested organization' })

      await recordAudit(db, { organizationId: membership.organizationId, userId: user.id, action: 'auth.login', entityType: 'User', entityId: user.id })
      const token = await createSession(db, user.id, membership.organizationId, app.config.sessionTtlMs)
      return {
        token,
        organizationId: membership.organizationId,
        role: membership.role,
        memberships: user.memberships.map(item => ({
          organizationId: item.organizationId,
          organizationName: item.organization.name,
          role: item.role,
        })),
      }
    },
  )

  app.post('/logout', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
    await revokeSession(app.db, token)
    await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'auth.logout', entityType: 'User', entityId: auth.userId })
    return reply.code(204).send()
  })

  app.get('/me', { preHandler: [authenticate] }, async request => {
    const auth = request.auth!
    const db = app.db
    const user = await db.user.findUniqueOrThrow({ where: { id: auth.userId }, include: { memberships: { include: { organization: true } } } })
    return {
      user: { id: user.id, email: user.email, name: user.name, locale: user.locale },
      organization: { id: auth.organizationId, role: auth.role },
      memberships: user.memberships.map(item => ({
        organizationId: item.organizationId,
        organizationName: item.organization.name,
        role: item.role,
      })),
    }
  })

  app.post<{ Body: { organizationId?: string } }>('/switch-organization', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!
    const targetId = request.body?.organizationId
    if (!targetId) return reply.code(400).send({ error: 'organizationId is required' })

    const db = app.db
    const membership = await db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: targetId, userId: auth.userId } },
    })
    if (!membership) return reply.code(403).send({ error: 'Not a member of the requested organization' })

    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
    await revokeSession(db, token)
    await recordAudit(db, { organizationId: targetId, userId: auth.userId, action: 'auth.switch_org', entityType: 'Organization', entityId: targetId, payload: { from: auth.organizationId } })
    const newToken = await createSession(db, auth.userId, targetId, app.config.sessionTtlMs)
    return { token: newToken, organizationId: targetId, role: membership.role as Role }
  })

  app.get<{ Body: { role?: string } }>('/roles', async () => {
    return { roles: ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'VIEWER'].filter(isRole) }
  })
}
