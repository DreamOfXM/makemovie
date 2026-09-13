import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { PrismaClient } from '@studio/db'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const app = Fastify({ logger: true })
const db = new PrismaClient()
const sessions = new Map<string, { userId: string; organizationId: string; expiresAt: number }>()

type AuthRequest = FastifyRequest

function authorization(request: FastifyRequest): string | undefined {
  return request.headers.authorization?.replace(/^Bearer\s+/i, '')
}

type ProjectBody = { name?: string }
type EpisodeBody = { number?: number; title?: string }
type StoryboardBody = { number?: number; title?: string; durationMs?: number; description?: string; sourceExcerpt?: string; continuityIn?: string; continuityOut?: string }

function passwordHash(password: string, salt = randomBytes(16).toString('hex')): string {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, digest] = stored.split(':')
  if (!salt || !digest) return false
  const actual = scryptSync(password, salt, 64)
  const expected = Buffer.from(digest, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

async function auth(request: AuthRequest, reply: FastifyReply) {
  const token = authorization(request)
  const session = token ? sessions.get(token) : undefined
  if (!session || session.expiresAt < Date.now()) return reply.code(401).send({ error: 'Unauthorized' })
  return session
}

app.get('/health', async () => ({ status: 'ok', service: 'api' }))

app.post<{ Body: { email?: string; password?: string; organizationName?: string } }>('/auth/register', async (request, reply) => {
  const { email, password, organizationName } = request.body
  if (!email || !password || !organizationName || password.length < 8) return reply.code(400).send({ error: 'email, organizationName and password of 8+ characters are required' })
  const existing = await db.user.findUnique({ where: { email } })
  if (existing) return reply.code(409).send({ error: 'Email already registered' })
  const user = await db.user.create({ data: { email, passwordHash: passwordHash(password) } })
  const organization = await db.organization.create({ data: { name: organizationName, slug: `${organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomBytes(3).toString('hex')}` } })
  await db.organizationMember.create({ data: { organizationId: organization.id, userId: user.id, role: 'OWNER' } })
  const token = randomBytes(32).toString('hex')
  sessions.set(token, { userId: user.id, organizationId: organization.id, expiresAt: Date.now() + 86_400_000 })
  return reply.code(201).send({ token, organization: { id: organization.id, name: organization.name } })
})

app.post<{ Body: { email?: string; password?: string } }>('/auth/login', async (request, reply) => {
  const { email, password } = request.body
  if (!email || !password) return reply.code(400).send({ error: 'email and password are required' })
  const user = await db.user.findUnique({ where: { email }, include: { memberships: true } })
  if (!user || !verifyPassword(password, user.passwordHash) || user.memberships.length === 0) return reply.code(401).send({ error: 'Invalid credentials' })
  const membership = user.memberships[0]
  const token = randomBytes(32).toString('hex')
  sessions.set(token, { userId: user.id, organizationId: membership.organizationId, expiresAt: Date.now() + 86_400_000 })
  return { token, organizationId: membership.organizationId }
})

app.get('/projects', async (request, reply) => {
  const session = await auth(request, reply)
  if (!session) return
  return db.project.findMany({ where: { organizationId: session.organizationId }, orderBy: { createdAt: 'desc' } })
})

app.post<{ Body: ProjectBody }>('/projects', async (request, reply) => {
  const session = await auth(request, reply)
  if (!session) return
  if (!request.body.name?.trim()) return reply.code(400).send({ error: 'name is required' })
  return reply.code(201).send(await db.project.create({ data: { organizationId: session.organizationId, name: request.body.name.trim() } }))
})

app.post<{ Params: { projectId: string }; Body: EpisodeBody }>('/projects/:projectId/episodes', async (request, reply) => {
  const session = await auth(request, reply)
  if (!session) return
  const project = await db.project.findFirst({ where: { id: request.params.projectId, organizationId: session.organizationId } })
  if (!project) return reply.code(404).send({ error: 'Project not found' })
  if (!request.body.number || !request.body.title?.trim()) return reply.code(400).send({ error: 'number and title are required' })
  return reply.code(201).send(await db.episode.create({ data: { projectId: project.id, number: request.body.number, title: request.body.title.trim() } }))
})

app.get<{ Params: { projectId: string } }>('/projects/:projectId/episodes', async (request, reply) => {
  const session = await auth(request, reply)
  if (!session) return
  const project = await db.project.findFirst({ where: { id: request.params.projectId, organizationId: session.organizationId } })
  if (!project) return reply.code(404).send({ error: 'Project not found' })
  return db.episode.findMany({ where: { projectId: project.id }, include: { storyboards: true }, orderBy: { number: 'asc' } })
})

app.post<{ Params: { episodeId: string }; Body: StoryboardBody }>('/episodes/:episodeId/storyboards', async (request, reply) => {
  const session = await auth(request, reply)
  if (!session) return
  const episode = await db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: session.organizationId } } })
  if (!episode) return reply.code(404).send({ error: 'Episode not found' })
  const body = request.body
  if (!body.number || !body.title?.trim() || !body.durationMs || !body.description?.trim()) return reply.code(400).send({ error: 'number, title, durationMs and description are required' })
  return reply.code(201).send(await db.storyboard.create({ data: { episodeId: episode.id, number: body.number, title: body.title.trim(), durationMs: body.durationMs, description: body.description.trim(), sourceExcerpt: body.sourceExcerpt || '', continuityIn: body.continuityIn || '', continuityOut: body.continuityOut || '' } }))
})

app.get<{ Params: { episodeId: string } }>('/episodes/:episodeId/storyboards', async (request, reply) => {
  const session = await auth(request, reply)
  if (!session) return
  const episode = await db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: session.organizationId } } })
  if (!episode) return reply.code(404).send({ error: 'Episode not found' })
  return db.storyboard.findMany({ where: { episodeId: episode.id }, orderBy: { number: 'asc' } })
})

app.addHook('onClose', async () => db.$disconnect())

app.listen({ host: '0.0.0.0', port: Number(process.env.PORT || 4010) }).catch(error => {
  app.log.error(error)
  process.exit(1)
})
