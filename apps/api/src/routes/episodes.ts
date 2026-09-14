import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PrismaClient } from '@studio/db'
import { can, canTransition, isWorkflowStatus, workflowStatuses, type Action, type WorkflowStatus } from '@studio/domain'
import { recordAudit } from '../lib/audit.js'
import { authenticate, requirePermission } from '../plugins/auth.js'
import type { AuthContext } from '../types.js'
import { toArtifactDto, type ArtifactDto } from './artifacts.js'

function toDbStatus(status: WorkflowStatus): string {
  return status.toUpperCase()
}

function fromDbStatus(status: string): WorkflowStatus {
  return status.toLowerCase() as WorkflowStatus
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
}

async function findEpisodeInOrg(db: PrismaClient, episodeId: string, organizationId: string) {
  return db.episode.findFirst({ where: { id: episodeId, project: { organizationId } } })
}

// A task's idempotency key is `${episodeId}:${stage}:${entityId}`, and for the per-storyboard
// IMAGE/VIDEO stages the entity is the storyboard, so the third segment maps a succeeded task
// back to its storyboard. Returns the latest succeeded first-frame and video artifact per storyboard.
async function storyboardMedia(db: PrismaClient, episodeId: string): Promise<{ firstFrame: Map<string, ArtifactDto>; video: Map<string, ArtifactDto> }> {
  const firstFrame = new Map<string, ArtifactDto>()
  const video = new Map<string, ArtifactDto>()
  const tasks = await db.generationTask.findMany({
    where: { batch: { episodeId }, stage: { in: ['FIRST_FRAME', 'VIDEO'] }, status: 'SUCCEEDED' },
    include: { artifacts: { orderBy: { version: 'desc' }, take: 1 } },
  })
  for (const task of tasks) {
    const storyboardId = task.idempotencyKey?.split(':')[2]
    const artifact = task.artifacts[0]
    if (!storyboardId || !artifact) continue
    if (task.stage === 'FIRST_FRAME') firstFrame.set(storyboardId, toArtifactDto(artifact))
    else if (task.stage === 'VIDEO') video.set(storyboardId, toArtifactDto(artifact))
  }
  return { firstFrame, video }
}

interface StoryboardAssetDto {
  id: string
  kind: string
  name: string
  status: string
  role: string
}

type StoryboardAssetLink = { role: string; asset: { id: string; kind: string; name: string; status: string } }

function toStoryboardAssetDto(link: StoryboardAssetLink): StoryboardAssetDto {
  return { id: link.asset.id, kind: link.asset.kind, name: link.asset.name, status: link.asset.status, role: link.role }
}

async function findStoryboardInOrg(db: PrismaClient, storyboardId: string, organizationId: string) {
  return db.storyboard.findFirst({ where: { id: storyboardId, episode: { project: { organizationId } } } })
}

function statusAction(target: WorkflowStatus): Action {
  return target === 'approved' || target === 'blocked' ? 'review:decide' : 'storyboard:write'
}

async function guardStatusAction(auth: AuthContext, target: WorkflowStatus, reply: FastifyReply): Promise<boolean> {
  const action = statusAction(target)
  if (!can(auth.role, action)) {
    await reply.code(403).send({ error: `Role ${auth.role} is not allowed to perform "${action}"` })
    return false
  }
  return true
}

export async function episodeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: { number?: number; title?: string } }>(
    '/projects/:projectId/episodes',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const { number, title } = request.body ?? {}
      if (!Number.isInteger(number) || (number as number) < 1) return reply.code(400).send({ error: 'number must be a positive integer' })
      if (!title?.trim()) return reply.code(400).send({ error: 'title is required' })
      try {
        const episode = await app.db.episode.create({ data: { projectId: project.id, number: number as number, title: title.trim() } })
        await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'episode.create', entityType: 'Episode', entityId: episode.id, payload: { number: episode.number, title: episode.title } })
        return reply.code(201).send(episode)
      } catch (error) {
        if (isPrismaUniqueViolation(error)) return reply.code(409).send({ error: `Episode number ${number} already exists in this project` })
        throw error
      }
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/episodes',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      return app.db.episode.findMany({
        where: { projectId: project.id },
        include: { storyboards: { orderBy: { number: 'asc' } } },
        orderBy: { number: 'asc' },
      })
    },
  )

  app.post<{
    Params: { episodeId: string }
    Body: { number?: number; title?: string; durationMs?: number; description?: string; sourceExcerpt?: string; continuityIn?: string; continuityOut?: string; scriptVersionId?: string }
  }>(
    '/episodes/:episodeId/storyboards',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const body = request.body ?? {}
      if (!Number.isInteger(body.number) || (body.number as number) < 1) return reply.code(400).send({ error: 'number must be a positive integer' })
      if (!body.title?.trim()) return reply.code(400).send({ error: 'title is required' })
      if (!Number.isInteger(body.durationMs) || (body.durationMs as number) <= 0) return reply.code(400).send({ error: 'durationMs must be a positive integer' })
      if (!body.description?.trim()) return reply.code(400).send({ error: 'description is required' })
      if (body.scriptVersionId) {
        const script = await app.db.scriptVersion.findFirst({ where: { id: body.scriptVersionId, episodeId: episode.id } })
        if (!script) return reply.code(400).send({ error: 'scriptVersionId does not belong to this episode' })
      }
      try {
        const storyboard = await app.db.storyboard.create({
          data: {
            episodeId: episode.id,
            scriptVersionId: body.scriptVersionId || null,
            number: body.number as number,
            title: body.title.trim(),
            durationMs: body.durationMs as number,
            description: body.description.trim(),
            sourceExcerpt: body.sourceExcerpt ?? '',
            continuityIn: body.continuityIn ?? '',
            continuityOut: body.continuityOut ?? '',
          },
        })
        await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'storyboard.create', entityType: 'Storyboard', entityId: storyboard.id, payload: { number: storyboard.number, title: storyboard.title } })
        return reply.code(201).send(storyboard)
      } catch (error) {
        if (isPrismaUniqueViolation(error)) return reply.code(409).send({ error: `Storyboard number ${body.number} already exists in this episode` })
        throw error
      }
    },
  )

  app.get<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/storyboards',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const storyboards = await app.db.storyboard.findMany({ where: { episodeId: episode.id }, include: { assets: true }, orderBy: { number: 'asc' } })
      const media = await storyboardMedia(app.db, episode.id)
      return storyboards.map(storyboard => ({
        ...storyboard,
        firstFrame: media.firstFrame.get(storyboard.id) ?? null,
        video: media.video.get(storyboard.id) ?? null,
      }))
    },
  )

  app.patch<{
    Params: { storyboardId: string }
    Body: { title?: string; durationMs?: number; description?: string; sourceExcerpt?: string; continuityIn?: string; continuityOut?: string }
  }>(
    '/storyboards/:storyboardId',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => {
      const auth = request.auth!
      const storyboard = await app.db.storyboard.findFirst({ where: { id: request.params.storyboardId, episode: { project: { organizationId: auth.organizationId } } } })
      if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })
      const body = request.body ?? {}
      const data: Record<string, unknown> = {}
      if (body.title !== undefined) {
        if (!body.title.trim()) return reply.code(400).send({ error: 'title must not be empty' })
        data.title = body.title.trim()
      }
      if (body.durationMs !== undefined) {
        if (!Number.isInteger(body.durationMs) || body.durationMs <= 0) return reply.code(400).send({ error: 'durationMs must be a positive integer' })
        data.durationMs = body.durationMs
      }
      if (body.description !== undefined) data.description = body.description
      if (body.sourceExcerpt !== undefined) data.sourceExcerpt = body.sourceExcerpt
      if (body.continuityIn !== undefined) data.continuityIn = body.continuityIn
      if (body.continuityOut !== undefined) data.continuityOut = body.continuityOut
      const updated = await app.db.storyboard.update({ where: { id: storyboard.id }, data })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'storyboard.update', entityType: 'Storyboard', entityId: storyboard.id, payload: { fields: Object.keys(data) } })
      return updated
    },
  )

  app.patch<{ Params: { storyboardId: string }; Body: { to?: string; reason?: string } }>(
    '/storyboards/:storyboardId/status',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const auth = request.auth!
      const { to, reason } = request.body ?? {}
      if (!isWorkflowStatus(to)) return reply.code(400).send({ error: `to must be one of: ${workflowStatuses.join(', ')}` })
      if (!(await guardStatusAction(auth, to, reply))) return

      const storyboard = await app.db.storyboard.findFirst({ where: { id: request.params.storyboardId, episode: { project: { organizationId: auth.organizationId } } } })
      if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })

      const from = fromDbStatus(storyboard.status)
      if (!canTransition(from, to)) {
        return reply.code(409).send({ error: `Illegal transition ${from} → ${to}` })
      }
      const updated = await app.db.storyboard.update({ where: { id: storyboard.id }, data: { status: toDbStatus(to) as typeof storyboard.status } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'storyboard.status',
        entityType: 'Storyboard',
        entityId: storyboard.id,
        payload: { from, to, reason: reason ?? null },
      })
      return updated
    },
  )

  app.get<{ Params: { storyboardId: string } }>(
    '/storyboards/:storyboardId/assets',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const storyboard = await findStoryboardInOrg(app.db, request.params.storyboardId, auth.organizationId)
      if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })
      const links = await app.db.storyboardAsset.findMany({
        where: { storyboardId: storyboard.id },
        include: { asset: { select: { id: true, kind: true, name: true, status: true } } },
        orderBy: { assetId: 'asc' },
      })
      return { assets: links.map(toStoryboardAssetDto) }
    },
  )

  app.put<{
    Params: { storyboardId: string }
    Body: { assets?: { assetId?: unknown; role?: unknown }[] }
  }>(
    '/storyboards/:storyboardId/assets',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => {
      const auth = request.auth!
      const storyboard = await findStoryboardInOrg(app.db, request.params.storyboardId, auth.organizationId)
      if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })

      const entries = request.body?.assets
      if (!Array.isArray(entries)) return reply.code(400).send({ error: 'assets must be an array of { assetId, role }' })
      // A Map deduplicates repeated assetIds; the last occurrence wins.
      const wanted = new Map<string, string>()
      for (const entry of entries) {
        const assetId = entry?.assetId
        if (typeof assetId !== 'string' || !assetId.trim()) return reply.code(400).send({ error: 'each asset requires a non-empty assetId' })
        if (entry.role !== undefined && typeof entry.role !== 'string') return reply.code(400).send({ error: 'role must be a string' })
        wanted.set(assetId, (entry.role as string | undefined) ?? '')
      }

      if (wanted.size > 0) {
        const found = await app.db.asset.findMany({
          where: { id: { in: [...wanted.keys()] }, episodeId: storyboard.episodeId },
          select: { id: true },
        })
        if (found.length !== wanted.size) {
          const valid = new Set(found.map(asset => asset.id))
          const invalid = [...wanted.keys()].find(id => !valid.has(id))
          return reply.code(400).send({ error: `asset ${invalid} does not belong to this episode` })
        }
      }

      await app.db.$transaction([
        app.db.storyboardAsset.deleteMany({ where: { storyboardId: storyboard.id } }),
        app.db.storyboardAsset.createMany({
          data: [...wanted.entries()].map(([assetId, role]) => ({ storyboardId: storyboard.id, assetId, role })),
        }),
      ])
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'storyboard.assets',
        entityType: 'Storyboard',
        entityId: storyboard.id,
        payload: { count: wanted.size, assets: [...wanted.entries()].map(([assetId, role]) => ({ assetId, role })) },
      })

      const links = await app.db.storyboardAsset.findMany({
        where: { storyboardId: storyboard.id },
        include: { asset: { select: { id: true, kind: true, name: true, status: true } } },
        orderBy: { assetId: 'asc' },
      })
      return { assets: links.map(toStoryboardAssetDto) }
    },
  )
}
