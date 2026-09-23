import type { FastifyInstance, FastifyReply } from 'fastify'
import { Prisma, type PrismaClient, type WorkflowStatus as DbWorkflowStatus } from '@studio/db'
import { can, canTransition, durationOutOfRange, formatDefaults, formatDurationRange, isWorkflowStatus, workflowStatuses, type Action, type WorkflowStatus } from '@studio/domain'
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

// Tasks are walked oldest-to-newest so the latest revision overwrites any stale one in
// the map. The shot comes from the task's own `storyboardId`, not from a segment of its
// idempotency key: that key is an anti-collision token, and reading a relation out of it
// would silently detach every shot from its media the day the key format changed.
async function storyboardMedia(db: PrismaClient, episodeId: string): Promise<{ firstFrame: Map<string, ArtifactDto>; video: Map<string, ArtifactDto>; voice: Map<string, ArtifactDto>; frameError: Map<string, string>; videoError: Map<string, string>; inflight: Map<string, Set<string>>; taskIds: Map<string, string[]> }> {
  const firstFrame = new Map<string, ArtifactDto>()
  const video = new Map<string, ArtifactDto>()
  const voice = new Map<string, ArtifactDto>()
  // 失败原因与产物同样是一等数据:没有它,用户对着"已失败"三个字只能懵逼。
  // 但错误与产物必须同一场遍历裁决——错误曾独立查询"最新失败",结果重生成
  // 成功之后旧失败仍然是最新的失败,横幅永远挂在成功的视频头上。
  const frameError = new Map<string, string>()
  const videoError = new Map<string, string>()
  const inflight = new Map<string, Set<string>>()
  const taskIds = new Map<string, string[]>()
  const tasks = await db.generationTask.findMany({
    where: { batch: { episodeId }, stage: { in: ['FIRST_FRAME', 'VIDEO', 'AUDIO'] }, storyboardId: { not: null }, status: { in: ['SUCCEEDED', 'FAILED', 'QUEUED', 'RUNNING'] } },
    include: { mediaArtifacts: { orderBy: { version: 'desc' }, take: 1 } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  // 事件序(旧→新)遍历:成功写入产物并清掉同阶段的失败——重生成成功的那一刻,
  // 上一次失败描述的问题已被这次成功解决,横幅必须随之消失;新失败覆盖旧失败。
  // 排队/运行中的尝试同样清掉旧失败:只要有一次更新的尝试在途,旧错误就不再是
  // 当前状态——用户点了重新生成,不该再看着上一轮的失败提示。
  for (const task of tasks) {
    if (!task.storyboardId) continue
    const ids = taskIds.get(task.storyboardId) ?? []
    ids.push(task.id)
    taskIds.set(task.storyboardId, ids)
    if (task.status === 'SUCCEEDED') {
      const artifact = task.mediaArtifacts[0]
      if (!artifact) continue
      if (task.stage === 'FIRST_FRAME') {
        firstFrame.set(task.storyboardId, toArtifactDto(artifact))
        frameError.delete(task.storyboardId)
      } else if (task.stage === 'VIDEO') {
        video.set(task.storyboardId, toArtifactDto(artifact))
        videoError.delete(task.storyboardId)
      } else {
        voice.set(task.storyboardId, toArtifactDto(artifact))
      }
    } else if (task.status === 'FAILED' && task.errorSnapshot) {
      let message = task.errorSnapshot
      try {
        const parsed: unknown = JSON.parse(task.errorSnapshot)
        message = Array.isArray(parsed) ? parsed.map(String).join(' | ') : String(parsed)
      } catch {
        // keep the raw snapshot text
      }
      if (task.stage === 'FIRST_FRAME') frameError.set(task.storyboardId, message.slice(0, 400))
      else if (task.stage === 'VIDEO') videoError.set(task.storyboardId, message.slice(0, 400))
    } else if (task.status === 'QUEUED' || task.status === 'RUNNING') {
      const stages = inflight.get(task.storyboardId) ?? new Set<string>()
      stages.add(task.stage)
      inflight.set(task.storyboardId, stages)
      if (task.stage === 'FIRST_FRAME') frameError.delete(task.storyboardId)
      else if (task.stage === 'VIDEO') videoError.delete(task.storyboardId)
    }
  }
  return { firstFrame, video, voice, frameError, videoError, inflight, taskIds }
}

interface StoryboardAssetDto {
  id: string
  kind: string
  name: string
  status: string
  role: string
}

/** One succeeded VIDEO version of a shot, newest first — the raw material of the selection gate. */
interface VideoCandidateDto {
  artifactId: string
  taskId: string
  version: number
  mimeType: string
  durationMs: number | null
  createdAt: string
  selected: boolean
  qc: { kind: string; status: string; score: number | null } | null
}

type StoryboardAssetLink = { role: string; asset: { id: string; kind: string; name: string; status: string } }

type StoryboardRow = Prisma.StoryboardGetPayload<{ include: { assets: true } }>

/**
 * The shot as the console reads it. `revision` and `supersededAt` are what make a
 * regenerated breakdown navigable: a superseded shot is history, still carrying the
 * media it was paid for, and `generationTaskId` traces it to the task that wrote it.
 */
interface StoryboardDto {
  id: string
  episodeId: string
  scriptVersionId: string | null
  generationTaskId: string | null
  revision: number
  number: number
  title: string
  durationMs: number
  description: string
  dialogue: string
  speaker: string | null
  sourceExcerpt: string
  continuityIn: string
  continuityOut: string
  status: DbWorkflowStatus
  supersededAt: string | null
  assets: StoryboardRow['assets']
  firstFrame: ArtifactDto | null
  video: ArtifactDto | null
  voice: ArtifactDto | null
  firstFrameError: string | null
  videoError: string | null
}

function toStoryboardDto(storyboard: StoryboardRow, media: { firstFrame: Map<string, ArtifactDto>; video: Map<string, ArtifactDto>; voice: Map<string, ArtifactDto>; frameError: Map<string, string>; videoError: Map<string, string> }): StoryboardDto {
  return {
    id: storyboard.id,
    episodeId: storyboard.episodeId,
    scriptVersionId: storyboard.scriptVersionId,
    generationTaskId: storyboard.generationTaskId,
    revision: storyboard.revision,
    number: storyboard.number,
    title: storyboard.title,
    durationMs: storyboard.durationMs,
    description: storyboard.description,
    dialogue: storyboard.dialogue,
    speaker: storyboard.speaker,
    sourceExcerpt: storyboard.sourceExcerpt,
    continuityIn: storyboard.continuityIn,
    continuityOut: storyboard.continuityOut,
    status: storyboard.status,
    supersededAt: storyboard.supersededAt?.toISOString() ?? null,
    assets: storyboard.assets,
    firstFrame: media.firstFrame.get(storyboard.id) ?? null,
    video: media.video.get(storyboard.id) ?? null,
    voice: media.voice.get(storyboard.id) ?? null,
    firstFrameError: media.frameError.get(storyboard.id) ?? null,
    videoError: media.videoError.get(storyboard.id) ?? null,
  }
}

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
  app.post<{ Params: { projectId: string }; Body: { number?: number; title?: string; targetDurationMs?: number } }>(
    '/projects/:projectId/episodes',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const { number, title, targetDurationMs } = request.body ?? {}
      if (!Number.isInteger(number) || (number as number) < 1) return reply.code(400).send({ error: 'number must be a positive integer' })
      if (!title?.trim()) return reply.code(400).send({ error: 'title is required' })
      if (targetDurationMs !== undefined && (!Number.isInteger(targetDurationMs) || targetDurationMs <= 0)) {
        return reply.code(400).send({ error: 'targetDurationMs must be a positive integer' })
      }
      const fmt = project.format.toLowerCase() as 'short_drama' | 'series' | 'film'
      if (targetDurationMs !== undefined && durationOutOfRange(fmt, targetDurationMs)) {
        const range = formatDurationRange[fmt]
        return reply.code(400).send({ error: `targetDurationMs must be between ${range.minMs} and ${range.maxMs} for format ${project.format}` })
      }
      // A film locked to its single episode at project creation: nothing to add.
      if (project.format === 'FILM') {
        const existing = await app.db.episode.findFirst({ where: { projectId: project.id } })
        if (existing) return reply.code(409).send({ error: 'episodes:filmLockedToOne' })
      }
      // Duration defaults cascade: the project's own default wins over the format
      // constant; the pipeline reads the episode value, never the format itself.
      const defaults = formatDefaults[fmt]
      try {
        const episode = await app.db.episode.create({
          data: {
            projectId: project.id,
            number: number as number,
            title: title.trim(),
            targetDurationMs: targetDurationMs ?? project.targetDurationMs ?? defaults.targetDurationMs,
          },
        })
        await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'episode.create', entityType: 'Episode', entityId: episode.id, payload: { number: episode.number, title: episode.title, targetDurationMs: episode.targetDurationMs } })
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
        // Superseded shots are history, so an episode's shot list — and the count the
        // console shows next to it — describes the breakdown in use. Source statuses
        // ride along so the project page can flag "draft source awaiting review"
        // without a per-episode round trip.
        include: {
          storyboards: { where: { supersededAt: null }, orderBy: [{ revision: 'asc' }, { number: 'asc' }] },
          sourceVersions: { select: { status: true } },
        },
        orderBy: { number: 'asc' },
      })
    },
  )

  // An episode is deletable while it is still a shell: text drafts (source,
  // script) cascade away, but anything generated, composed or delivered — work
  // that was paid for — refuses the delete instead of silently dying with it.
  app.delete<{ Params: { projectId: string; episodeId: string } }>(
    '/projects/:projectId/episodes/:episodeId',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, projectId: project.id } })
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })

      const [storyboards, batches, compositions, deliveries] = await Promise.all([
        app.db.storyboard.count({ where: { episodeId: episode.id } }),
        app.db.generationBatch.count({ where: { episodeId: episode.id } }),
        app.db.composition.count({ where: { episodeId: episode.id } }),
        app.db.delivery.count({ where: { episodeId: episode.id } }),
      ])
      if (storyboards > 0 || batches > 0 || compositions > 0 || deliveries > 0) {
        return reply.code(409).send({ error: 'episodes:notDeletable' })
      }

      // Chapter allocations pointing here cascade away — those segments fall
      // back to "unassigned" in the split matrix.
      await app.db.episode.delete({ where: { id: episode.id } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'episode.delete',
        entityType: 'Episode',
        entityId: episode.id,
        payload: { projectId: project.id, number: episode.number, title: episode.title },
      })
      return reply.code(204).send()
    },
  )

  app.post<{
    Params: { episodeId: string }
    Body: { number?: number; title?: string; durationMs?: number; description?: string; dialogue?: string; speaker?: string; sourceExcerpt?: string; continuityIn?: string; continuityOut?: string; scriptVersionId?: string }
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
        // A shot a human adds belongs to the breakdown currently in use, not to
        // revision 1 — once the shot list has been regenerated, revision 1 is
        // superseded and a new shot filed there would sit outside the live list.
        const live = await app.db.storyboard.aggregate({
          where: { episodeId: episode.id, supersededAt: null },
          _max: { revision: true },
        })
        const revision = live._max.revision ?? 1
        const storyboard = await app.db.storyboard.create({
          data: {
            episodeId: episode.id,
            scriptVersionId: body.scriptVersionId || null,
            revision,
            number: body.number as number,
            title: body.title.trim(),
            durationMs: body.durationMs as number,
            description: body.description.trim(),
            // An empty line is a silent shot, not an unfilled one: AUDIO looks at this
            // field to decide which shots are worth buying voice for.
            dialogue: body.dialogue?.trim() ?? '',
            speaker: body.speaker?.trim() || null,
            sourceExcerpt: body.sourceExcerpt ?? '',
            continuityIn: body.continuityIn ?? '',
            continuityOut: body.continuityOut ?? '',
          },
        })
        await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'storyboard.create', entityType: 'Storyboard', entityId: storyboard.id, payload: { revision: storyboard.revision, number: storyboard.number, title: storyboard.title } })
        return reply.code(201).send(storyboard)
      } catch (error) {
        if (isPrismaUniqueViolation(error)) return reply.code(409).send({ error: `Storyboard number ${body.number} already exists in this revision` })
        throw error
      }
    },
  )

  // The live shot list by default. `includeSuperseded=true` adds the revisions a
  // regenerate replaced: superseding instead of deleting is only useful if the
  // previous breakdown and the media it was paid for stay readable.
  app.get<{ Params: { episodeId: string }; Querystring: { includeSuperseded?: string } }>(
    '/episodes/:episodeId/storyboards',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const includeSuperseded = request.query?.includeSuperseded === 'true' || request.query?.includeSuperseded === '1'
      const storyboards = await app.db.storyboard.findMany({
        where: { episodeId: episode.id, ...(includeSuperseded ? {} : { supersededAt: null }) },
        include: { assets: true },
        orderBy: [{ revision: 'asc' }, { number: 'asc' }],
      })
      const media = await storyboardMedia(app.db, episode.id)
      return storyboards.map(storyboard => toStoryboardDto(storyboard, media))
    },
  )

  app.patch<{
    Params: { storyboardId: string }
    Body: { title?: string; durationMs?: number; description?: string; dialogue?: string; speaker?: string | null; sourceExcerpt?: string; continuityIn?: string; continuityOut?: string }
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
      if (body.dialogue !== undefined) data.dialogue = body.dialogue.trim()
      if (body.speaker !== undefined) data.speaker = body.speaker?.trim() || null
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

  // 选优门:一镜多版时由人钦定入片版本,而不是让 compose 猜"最新"。
  // 与素材版本审批同一语义——同镜同时只有一条选定;清空即回到自动取最新。
  app.post<{ Params: { storyboardId: string }; Body: { artifactId?: string | null } }>(
    '/storyboards/:storyboardId/video-selection',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => {
      const auth = request.auth!
      if (request.body?.artifactId === undefined) return reply.code(400).send({ error: 'artifactId is required, null clears the selection' })
      const storyboard = await findStoryboardInOrg(app.db, request.params.storyboardId, auth.organizationId)
      if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })
      if (storyboard.supersededAt) return reply.code(409).send({ error: 'storyboard is superseded' })
      const { artifactId } = request.body
      if (artifactId !== null) {
        const artifact = await app.db.mediaArtifact.findFirst({
          where: { id: artifactId, organizationId: auth.organizationId, stage: 'VIDEO', task: { status: 'SUCCEEDED', stage: 'VIDEO', storyboardId: storyboard.id } },
          select: { id: true },
        })
        if (!artifact) return reply.code(400).send({ error: 'artifact is not a succeeded video of this shot' })
      }
      const updated = await app.db.storyboard.update({
        where: { id: storyboard.id },
        data: { selectedVideoArtifactId: artifactId },
        select: { id: true, selectedVideoArtifactId: true },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'storyboard.select-video',
        entityType: 'Storyboard',
        entityId: storyboard.id,
        payload: { artifactId },
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

  // The shotboard: everything the new overview grid needs in one read, and nothing the
  // engine owns. It aggregates the live breakdown with media, QC verdicts and spend per
  // shot so the console can rank shots by "needs a human" instead of by pipeline stage.
  // Read-only by design — every action on a card still goes through the existing
  // stage routes, so this endpoint can never become a second writer.
  app.get<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/shotboard',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })

      const storyboards = await app.db.storyboard.findMany({
        where: { episodeId: episode.id, supersededAt: null },
        include: {
          assets: {
            include: {
              asset: {
                select: {
                  id: true, kind: true, name: true, status: true,
                  _count: { select: { versions: true } },
                  versions: { where: { status: 'APPROVED', artifactId: { not: null } }, orderBy: { version: 'desc' }, take: 1, select: { id: true } },
                },
              },
            },
            orderBy: { assetId: 'asc' },
          },
        },
        orderBy: [{ revision: 'asc' }, { number: 'asc' }],
      })
      const media = await storyboardMedia(app.db, episode.id)
      const shotIds = storyboards.map(s => s.id)

      // 选优门数据:每一镜全部成功视频版本(新→旧)与各自的质检结论。
      // 「最新」只是机器的猜测,人要在多个版本之间挑,就得先看见全部候选。
      const videoArtifacts = shotIds.length
        ? await app.db.mediaArtifact.findMany({
            where: { stage: 'VIDEO', task: { status: 'SUCCEEDED', stage: 'VIDEO', storyboardId: { in: shotIds } } },
            include: { task: { select: { id: true, storyboardId: true, createdAt: true } } },
          })
        : []
      const videoQcRows = videoArtifacts.length
        ? await app.db.qualityCheck.findMany({ where: { artifactId: { in: videoArtifacts.map(a => a.id) } }, orderBy: { id: 'asc' } })
        : []
      const latestQcByArtifact = new Map<string, { kind: string; status: string; score: number | null }>()
      for (const qc of videoQcRows) {
        if (qc.artifactId) latestQcByArtifact.set(qc.artifactId, { kind: qc.kind, status: qc.status, score: qc.score })
      }
      const artifactsById = new Map(videoArtifacts.map(artifact => [artifact.id, artifact]))
      const candidatesByShot = new Map<string, Omit<VideoCandidateDto, 'selected'>[]>()
      for (const artifact of videoArtifacts) {
        const shotId = artifact.task?.storyboardId
        if (!shotId || !artifact.task) continue
        const list = candidatesByShot.get(shotId) ?? []
        list.push({
          artifactId: artifact.id,
          taskId: artifact.task.id,
          version: artifact.version,
          mimeType: artifact.mimeType,
          durationMs: artifact.durationMs,
          createdAt: artifact.task.createdAt.toISOString(),
          qc: latestQcByArtifact.get(artifact.id) ?? null,
        })
        candidatesByShot.set(shotId, list)
      }
      for (const list of candidatesByShot.values()) {
        list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.version - a.version)
      }

      const [qcRows, assetsPending, episodeAssets] = await Promise.all([
        shotIds.length
          ? app.db.qualityCheck.findMany({ where: { storyboardId: { in: shotIds } }, orderBy: { id: 'asc' } })
          : Promise.resolve([]),
        app.db.asset.findMany({
          where: { episodeId: episode.id, status: { not: 'APPROVED' }, versions: { some: {} } },
          select: { id: true, kind: true, name: true, status: true },
          orderBy: { name: 'asc' },
        }),
        // 班底块:素材自己的档案(长相在最新已审批版本上),出演映射从活体分镜反推。
        app.db.asset.findMany({
          where: { episodeId: episode.id },
          include: {
            _count: { select: { versions: true } },
            versions: { where: { status: 'APPROVED', artifactId: { not: null } }, orderBy: { version: 'desc' }, take: 1, include: { artifact: true } },
          },
          orderBy: { name: 'asc' },
        }),
      ])
      // ids are cuids, so ascending id is ascending time here: last write per (shot, kind) wins.
      const latestQc = new Map<string, { kind: string; status: string; score: number | null }>()
      for (const qc of qcRows) {
        if (!qc.storyboardId) continue
        latestQc.set(`${qc.storyboardId}:${qc.kind}`, { kind: qc.kind, status: qc.status, score: qc.score })
      }

      const allTaskIds = [...media.taskIds.values()].flat()
      const shotByTaskId = new Map<string, string>()
      for (const [shotId, ids] of media.taskIds) for (const id of ids) shotByTaskId.set(id, shotId)
      const ledgerRows = allTaskIds.length
        ? await app.db.usageLedger.findMany({ where: { taskId: { in: allTaskIds } }, select: { taskId: true, provider: true, model: true, modality: true, inputUnits: true, outputUnits: true } })
        : []
      const usageByShot = new Map<string, { inputUnits: number; outputUnits: number; models: Set<string>; calls: number }>()
      for (const row of ledgerRows) {
        if (!row.taskId) continue
        const shotId = shotByTaskId.get(row.taskId)
        if (!shotId) continue
        const agg = usageByShot.get(shotId) ?? { inputUnits: 0, outputUnits: 0, models: new Set<string>(), calls: 0 }
        agg.inputUnits += row.inputUnits
        agg.outputUnits += row.outputUnits
        agg.models.add(`${row.provider}/${row.model}`)
        agg.calls += 1
        usageByShot.set(shotId, agg)
      }

      const appearancesByAsset = new Map<string, string[]>()
      const referenceCountByAsset = new Map<string, number>()
      const shots = storyboards.map(storyboard => {
        const inflightStages = [...(media.inflight.get(storyboard.id) ?? [])]
        const linkedAssets = storyboard.assets.map(link => ({
          id: link.asset.id,
          kind: link.asset.kind,
          name: link.asset.name,
          status: link.asset.status,
          role: link.role,
          hasVersions: link.asset._count.versions > 0,
          // 与 triggerStage 的参考图选择同源:有已审批带实体的版本，且（场景不受限，
          // 其余仅当画面文本——标题+描述——真正提到名字）。否则链接了也不定妆。
          reference:
            link.asset.versions.length > 0 &&
            (link.asset.kind === 'scene' ||
              `${storyboard.title} ${storyboard.description}`.includes(link.asset.name.replace(/（[^）]*）|\([^)]*\)/g, '').trim())),
        }))
        for (const asset of linkedAssets) {
          appearancesByAsset.set(asset.id, [...(appearancesByAsset.get(asset.id) ?? []), storyboard.id])
          if (asset.reference) referenceCountByAsset.set(asset.id, (referenceCountByAsset.get(asset.id) ?? 0) + 1)
        }
        const frameError = media.frameError.get(storyboard.id) ?? null
        const videoError = media.videoError.get(storyboard.id) ?? null
        const candidates: VideoCandidateDto[] = (candidatesByShot.get(storyboard.id) ?? []).map(candidate => ({
          ...candidate,
          selected: candidate.artifactId === storyboard.selectedVideoArtifactId,
        }))
        const attention: string[] = []
        if (storyboard.status === 'BLOCKED') attention.push('shot_blocked')
        if (frameError) attention.push('frame_failed')
        if (videoError) attention.push('video_failed')
        if (linkedAssets.some(a => a.status !== 'APPROVED' && a.hasVersions)) attention.push('asset_gate')
        // 只有真存在多版本可选却没人钦定的镜头才进待处理泳道——单版本没有抉择，
        // 逼人选一次是摩擦不是审计。
        if (candidates.length >= 2 && !candidates.some(c => c.selected)) attention.push('selection_open')
        const usage = usageByShot.get(storyboard.id)
        const qcEntries = [...latestQc.entries()].filter(([key]) => key.startsWith(`${storyboard.id}:`)).map(([, value]) => value)
        // 缩略图跟着选定版本走:卡片展示的必须是将入片的那一版，而不是"最新"。
        const selectedArtifact = candidates.find(candidate => candidate.selected)
          ? artifactsById.get(storyboard.selectedVideoArtifactId!)
          : undefined
        // 每镜占位裁决(放映条与预映共用一个事实源):这一镜现在拿得上画面的东西
        // 是钦定成片 > 最新成功片段 > 在产 > 只有分镜图 > 空。
        const slot = storyboard.selectedVideoArtifactId
          ? 'chosen'
          : media.video.get(storyboard.id)
            ? 'video'
            : inflightStages.length > 0
              ? 'running'
              : media.firstFrame.get(storyboard.id)
                ? 'frame'
                : 'empty'
        return {
          id: storyboard.id,
          number: storyboard.number,
          revision: storyboard.revision,
          title: storyboard.title,
          durationMs: storyboard.durationMs,
          description: storyboard.description,
          dialogue: storyboard.dialogue,
          speaker: storyboard.speaker,
          sourceExcerpt: storyboard.sourceExcerpt,
          continuityIn: storyboard.continuityIn,
          continuityOut: storyboard.continuityOut,
          status: storyboard.status,
          assets: linkedAssets,
          firstFrame: media.firstFrame.get(storyboard.id) ?? null,
          video: selectedArtifact ? toArtifactDto(selectedArtifact) : media.video.get(storyboard.id) ?? null,
          voice: media.voice.get(storyboard.id) ?? null,
          firstFrameError: frameError,
          videoError,
          inflight: inflightStages,
          qc: qcEntries,
          selectedVideoArtifactId: storyboard.selectedVideoArtifactId,
          videoCandidates: candidates,
          usage: usage ? { inputUnits: usage.inputUnits, outputUnits: usage.outputUnits, models: [...usage.models], calls: usage.calls } : null,
          slot,
          attention,
        }
      })

      return {
        episodeId: episode.id,
        number: episode.number,
        title: episode.title,
        status: episode.status,
        shots,
        assets: episodeAssets.map(asset => ({
          id: asset.id,
          kind: asset.kind,
          name: asset.name,
          status: asset.status,
          hasVersions: asset._count.versions > 0,
          appearances: appearancesByAsset.get(asset.id) ?? [],
          referenceCount: referenceCountByAsset.get(asset.id) ?? 0,
          thumbnail: asset.versions[0]?.artifact ? toArtifactDto(asset.versions[0].artifact) : null,
        })),
        assetsPending,
      }
    },
  )
}
