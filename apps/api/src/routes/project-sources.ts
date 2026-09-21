import { createHash } from 'node:crypto'
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type PrismaClient } from '@studio/db'
import { formatDefaults, PROJECT_SOURCE_CHAR_LIMIT } from '@studio/domain'
import { splitChapters } from '@studio/pipeline'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

interface SegmentDto {
  id: string
  index: number
  title: string | null
  marked: boolean
  charCount: number
  episodeId: string | null
}

interface EpisodeLiteDto {
  id: string
  number: number
  title: string
  targetDurationMs: number | null
}

async function findProjectInOrg(db: PrismaClient, projectId: string, organizationId: string) {
  return db.project.findFirst({ where: { id: projectId, organizationId } })
}

function checksumOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Uploaded books arrive as opaque bytes: try strict UTF-8 first, then GB18030 —
 * which covers GBK and GB2312 — because a UTF-8 failure on a Chinese novel is
 * almost always a legacy encoding, not corruption. Anything that still cannot
 * decode cleanly (or decodes only through replacement characters) is rejected:
 * silently storing mojibake is worse than asking the author to re-save as UTF-8.
 */
function decodeBook(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    const decoded = new TextDecoder('gb18030').decode(buffer)
    return decoded.includes('\uFFFD') ? null : decoded
  }
}

export async function projectSourceRoutes(app: FastifyInstance): Promise<void> {
  // Shared intake for both doors — the multipart file and the pasted text: validate
  // the ceiling, refuse a byte-identical re-intake, split mechanically, and version.
  async function ingestBook(request: FastifyRequest, project: { id: string; organizationId: string }, content: string, filename: string, reply: FastifyReply) {
    const auth = request.auth!
    if (!content.trim()) return reply.code(400).send({ error: 'projectSources:empty' })
    if (content.length > PROJECT_SOURCE_CHAR_LIMIT) return reply.code(400).send({ error: 'projectSources:tooLarge' })

    const checksum = checksumOf(content)
    // Against every prior version, not just the latest: a re-intake after an
    // unrelated version in between must not slip past as "new".
    const duplicate = await app.db.projectSourceVersion.findFirst({ where: { projectId: project.id, checksum } })
    if (duplicate) return reply.code(409).send({ error: 'projectSources:duplicate' })
    const latest = await app.db.projectSourceVersion.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' } })

    const segments = splitChapters(content)
    const created = await app.db.$transaction(async tx => {
      const version = await tx.projectSourceVersion.create({
        data: {
          projectId: project.id,
          version: (latest?.version ?? 0) + 1,
          filename,
          content,
          checksum,
          charCount: content.length,
          status: 'DRAFT',
        },
      })
      await tx.sourceSegment.createMany({
        data: segments.map((segment, index) => ({
          projectSourceVersionId: version.id,
          index,
          title: segment.title,
          marked: segment.marked,
          content: segment.content,
          charCount: segment.content.length,
        })),
      })
      return version
    })
    await recordAudit(app.db, {
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'projectSource.upload',
      entityType: 'ProjectSourceVersion',
      entityId: created.id,
      payload: {
        projectId: project.id,
        version: created.version,
        filename: created.filename,
        charCount: created.charCount,
        segments: segments.length,
        markedSegments: segments.filter(segment => segment.marked).length,
      },
    })
    return reply.code(201).send({
      version: {
        id: created.id,
        version: created.version,
        filename: created.filename,
        charCount: created.charCount,
        checksum: created.checksum,
        status: created.status,
      },
      segments: segments.length,
    })
  }

  // Whole-book upload: multipart file in, versioned source plus mechanical
  // chapter segmentation out. The paste box (episode-level, 200k) stays where it
  // is; this is the project-level intake with its own 1M ceiling.
  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/source/upload',
    { preHandler: requirePermission('project:update') },
    async (request, reply) => {
      const project = await findProjectInOrg(app.db, request.params.projectId, request.auth!.organizationId)
      if (!project) return reply.code(404).send({ error: 'Project not found' })

      const file = await request.file()
      if (!file) return reply.code(400).send({ error: 'file is required' })
      const ext = path.extname(file.filename).toLowerCase()
      if (ext !== '.txt' && ext !== '.md') {
        return reply.code(400).send({ error: 'only .txt and .md files are supported (.docx is planned)' })
      }
      const content = decodeBook(await file.toBuffer())
      if (content === null) return reply.code(400).send({ error: 'projectSources:badEncoding' })
      return ingestBook(request, project, content, file.filename, reply)
    },
  )

  // The paste door: same intake for browsers and environments where a file picker
  // is unavailable (embedded webviews), or simply for text already on the clipboard.
  // Fastify's default 1 MB JSON cap would silently break the promised 1M-character
  // ceiling, so this route carries the byte budget the ceiling implies.
  app.post<{ Params: { projectId: string }; Body: { content?: string; filename?: string } }>(
    '/projects/:projectId/source',
    { preHandler: requirePermission('project:update'), bodyLimit: PROJECT_SOURCE_CHAR_LIMIT * 4 },
    async (request, reply) => {
      const project = await findProjectInOrg(app.db, request.params.projectId, request.auth!.organizationId)
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const content = request.body?.content
      if (typeof content !== 'string') return reply.code(400).send({ error: 'content is required' })
      const filename = request.body?.filename?.trim() || '粘贴的整本.txt'
      return ingestBook(request, project, content, filename, reply)
    },
  )

  // The allocation matrix in one payload: the book's segments with their current
  // allocation, the project's episodes, and the format's constraints. Content is
  // deliberately absent — the matrix reads shapes, not words.
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/source',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await findProjectInOrg(app.db, request.params.projectId, auth.organizationId)
      if (!project) return reply.code(404).send({ error: 'Project not found' })

      const latest = await app.db.projectSourceVersion.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' } })
      if (!latest) {
        return {
          version: null,
          format: project.format,
          defaults: formatDefaults[project.format.toLowerCase() as 'short_drama' | 'series' | 'film'],
          segments: [],
          episodes: [],
        }
      }
      const [segments, episodes] = await Promise.all([
        app.db.sourceSegment.findMany({
          where: { projectSourceVersionId: latest.id },
          orderBy: { index: 'asc' },
          include: { allocation: true },
        }),
        app.db.episode.findMany({
          where: { projectId: project.id },
          orderBy: { number: 'asc' },
          select: { id: true, number: true, title: true, targetDurationMs: true },
        }),
      ])
      const segmentDtos: SegmentDto[] = segments.map(segment => ({
        id: segment.id,
        index: segment.index,
        title: segment.title,
        marked: segment.marked,
        charCount: segment.charCount,
        episodeId: segment.allocation?.episodeId ?? null,
      }))
      const episodeDtos: EpisodeLiteDto[] = episodes.map(episode => ({
        id: episode.id,
        number: episode.number,
        title: episode.title,
        targetDurationMs: episode.targetDurationMs,
      }))
      return {
        version: {
          id: latest.id,
          version: latest.version,
          filename: latest.filename,
          charCount: latest.charCount,
          checksum: latest.checksum,
          status: latest.status,
        },
        format: project.format,
        defaults: formatDefaults[project.format.toLowerCase() as 'short_drama' | 'series' | 'film'],
        segments: segmentDtos,
        episodes: episodeDtos,
      }
    },
  )

  // Move chapters between episodes: one row per segment, the whole map in one
  // request, because "当场改一格" must survive a reload as a single consistent
  // state rather than a stream of per-row patches.
  app.patch<{ Params: { projectId: string }; Body: { allocations?: Array<{ segmentId?: string; episodeId?: string | null }> } }>(
    '/projects/:projectId/source/allocations',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await findProjectInOrg(app.db, request.params.projectId, auth.organizationId)
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const changes = request.body?.allocations
      if (!Array.isArray(changes) || changes.length === 0) return reply.code(400).send({ error: 'allocations is required' })
      // One row per segment is the table's invariant; a repeated segmentId in one
      // payload is a client bug and would trip the unique constraint as a raw 500
      // with a stack trace, so it is refused here with something readable.
      if (new Set(changes.map(change => change.segmentId)).size !== changes.length) {
        return reply.code(400).send({ error: 'projectSources:duplicateSegment' })
      }

      const latest = await app.db.projectSourceVersion.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' } })
      if (!latest) return reply.code(404).send({ error: 'projectSources:notUploaded' })

      const segmentIds = changes.map(change => change.segmentId)
      const segments = await app.db.sourceSegment.findMany({ where: { id: { in: segmentIds as string[] }, projectSourceVersionId: latest.id } })
      if (segments.length !== new Set(segmentIds).size) {
        return reply.code(409).send({ error: 'projectSources:segmentNotInLatestVersion' })
      }

      const episodes = await app.db.episode.findMany({ where: { projectId: project.id }, select: { id: true } })
      const episodeIds = new Set(episodes.map(episode => episode.id))
      const targetIds = new Set<string>()
      for (const change of changes) {
        const target = change.episodeId ?? null
        if (target === null) continue
        if (!episodeIds.has(target)) return reply.code(409).send({ error: 'projectSources:episodeNotInProject' })
        targetIds.add(target)
      }
      // A film is a one-episode project: the map may not fan a book out.
      if (project.format === 'FILM' && targetIds.size > (formatDefaults.film.maxEpisodes ?? 1)) {
        return reply.code(409).send({ error: 'projectSources:filmSingleEpisode' })
      }

      await app.db.$transaction(async tx => {
        await tx.segmentAllocation.deleteMany({ where: { segmentId: { in: segmentIds as string[] } } })
        const rows = changes
          .filter(change => change.episodeId != null)
          .map(change => ({ segmentId: change.segmentId as string, episodeId: change.episodeId as string }))
        if (rows.length > 0) await tx.segmentAllocation.createMany({ data: rows })
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'projectSource.allocate',
        entityType: 'ProjectSourceVersion',
        entityId: latest.id,
        payload: { projectId: project.id, changes: changes.length },
      })
      return { updated: changes.length }
    },
  )

  // Materialize the map: every episode with allocated segments receives a new
  // draft SourceDocumentVersion holding those segments in book order, and the
  // existing approval → script → storyboard chain takes over unchanged.
  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/source/apply',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await findProjectInOrg(app.db, request.params.projectId, auth.organizationId)
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const latest = await app.db.projectSourceVersion.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' } })
      if (!latest) return reply.code(404).send({ error: 'projectSources:notUploaded' })

      const segments = await app.db.sourceSegment.findMany({
        where: { projectSourceVersionId: latest.id },
        orderBy: { index: 'asc' },
        include: { allocation: true },
      })
      const byEpisode = new Map<string, typeof segments>()
      for (const segment of segments) {
        const episodeId = segment.allocation?.episodeId
        if (!episodeId) continue
        const group = byEpisode.get(episodeId) ?? []
        group.push(segment)
        byEpisode.set(episodeId, group)
      }
      if (byEpisode.size === 0) return reply.code(409).send({ error: 'projectSources:nothingAllocated' })

      const episodeIds = [...byEpisode.keys()]
      const episodes = await app.db.episode.findMany({ where: { id: { in: episodeIds }, projectId: project.id } })
      if (episodes.length !== episodeIds.length) return reply.code(409).send({ error: 'projectSources:episodeNotInProject' })

      const results: Array<{ episodeId: string; number: number; version: number | null; skipped: boolean }> = []
      for (const episode of episodes) {
        const group = byEpisode.get(episode.id) ?? []
        const content = group.map(segment => segment.content).join('\n\n')
        const checksum = checksumOf(content)
        const prev = await app.db.sourceDocumentVersion.findFirst({ where: { episodeId: episode.id }, orderBy: { version: 'desc' } })
        if (prev?.checksum === checksum) {
          results.push({ episodeId: episode.id, number: episode.number, version: prev.version, skipped: true })
          continue
        }
        const created = await app.db.sourceDocumentVersion.create({
          data: { episodeId: episode.id, version: (prev?.version ?? 0) + 1, content, checksum, status: 'DRAFT' },
        })
        await recordAudit(app.db, {
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: 'source.upload',
          entityType: 'SourceDocumentVersion',
          entityId: created.id,
          payload: {
            episodeId: episode.id,
            version: created.version,
            checksum: created.checksum,
            contentLength: content.length,
            derivedFrom: { projectSourceVersion: latest.version, segments: group.length },
          },
        })
        results.push({ episodeId: episode.id, number: episode.number, version: created.version, skipped: false })
      }
      // "Approved" must mean the whole book is placed. Chapters left unallocated
      // keep the version in draft so the panel keeps nagging about them instead
      // of the book silently ending at whatever was mapped last.
      const pendingSegments = segments.length - [...byEpisode.values()].reduce((sum, group) => sum + group.length, 0)
      if (pendingSegments === 0) {
        await app.db.projectSourceVersion.update({ where: { id: latest.id }, data: { status: 'APPROVED' } })
      }
      return { results, pendingSegments }
    },
  )
}
