import { createHash } from 'node:crypto'
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type PrismaClient } from '@studio/db'
import { formatDefaults, PROJECT_SOURCE_CHAR_LIMIT, SCRIPT_CHARS_PER_MINUTE } from '@studio/domain'
import { isChapterMarkerLine, splitChapters } from '@studio/pipeline'
import { recordAudit } from '../lib/audit.js'
import { unzipEntries, BadZipError } from '../lib/zip.js'
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
  async function ingestBook(request: FastifyRequest, project: { id: string; organizationId: string }, content: string, filename: string, reply: FastifyReply, filesCount?: number) {
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
      // Folder uploads report how many chapter files built the book.
      ...(filesCount !== undefined && filesCount > 1 ? { files: filesCount } : {}),
    })
  }

  // Whole-book upload: multipart file(s) in, versioned source plus mechanical
  // chapter segmentation out. One file keeps today's semantics (chapters are
  // found inside the text); a folder of chapter files is equally first-class —
  // every .txt/.md part becomes exactly one chapter, ordered by natural
  // filename sort, headed by its filename.
  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/source/upload',
    { preHandler: requirePermission('project:update') },
    async (request, reply) => {
      const project = await findProjectInOrg(app.db, request.params.projectId, request.auth!.organizationId)
      if (!project) return reply.code(404).send({ error: 'Project not found' })

      const collected: Array<{ filename: string; buffer: Buffer }> = []
      let sawUnsupported = false
      for await (const part of request.files()) {
        // Every part is consumed before any filtering decision — an unread
        // stream stalls the iterator and the whole request with it.
        const buffer = await part.toBuffer()
        const base = path.basename(part.filename)
        const ext = path.extname(base).toLowerCase()
        // OS droppings (`.DS_Store`) must not become chapters; anything that is
        // not .txt/.md/.zip is skipped rather than failing the whole folder.
        if (base.startsWith('.')) continue
        if (ext !== '.txt' && ext !== '.md' && ext !== '.zip') {
          sawUnsupported = true
          continue
        }
        collected.push({ filename: base, buffer })
      }
      if (collected.length === 0) {
        return reply.code(400).send({
          error: sawUnsupported
            ? 'only .txt, .md and .zip files are supported (.docx is planned)'
            : 'file is required',
        })
      }

      // A zip is the universal door for a folder of chapter files: every host
      // that can hand the app ONE file can hand it a zip. Entries are ordered
      // by FILENAME (chapter files carry their numbers there) — folder names
      // must not reorder the book; macOS packaging junk (__MACOSX/, .DS_Store)
      // and non-text entries are skipped.
      const chapters: Array<{ filename: string; content: string }> = []
      let unzippedBytes = 0
      const pushChapter = (filename: string, buffer: Buffer) => {
        const content = decodeBook(buffer)
        if (content === null) return 'badEncoding' as const
        if (content.trim().length === 0) return undefined
        chapters.push({ filename, content })
        return undefined
      }
      for (const part of collected) {
        if (part.filename.toLowerCase().endsWith('.zip')) {
          let entries
          try {
            // Names are decoded with the same policy as file content (strict
            // UTF-8, then GB18030) — see lib/zip.ts for why fflate's own
            // decoding is not used. unzipSync materializes every entry before
            // we can cap the total — the request-size ceiling (multipart
            // fileSize, 4 MB per part) bounds the compressed input; the byte
            // cap below bounds the accumulated output as entries enumerate.
            entries = unzipEntries(part.buffer)
          } catch (error) {
            if (error instanceof BadZipError) return reply.code(400).send({ error: 'projectSources:badZip' })
            throw error
          }
          for (const entry of entries) {
            const inner = entry.name.replace(/\\/g, '/')
            if (inner.endsWith('/') || inner.split('/').includes('__MACOSX')) continue
            const base = path.posix.basename(inner)
            if (base.startsWith('.')) continue
            const ext = path.posix.extname(base).toLowerCase()
            if (ext !== '.txt' && ext !== '.md') continue
            unzippedBytes += entry.data.byteLength
            if (unzippedBytes > PROJECT_SOURCE_CHAR_LIMIT * 4) {
              return reply.code(400).send({ error: 'projectSources:tooLarge' })
            }
            const problem = pushChapter(base, entry.data)
            if (problem) return reply.code(400).send({ error: `projectSources:${problem}` })
          }
          continue
        }
        const problem = pushChapter(part.filename, part.buffer)
        if (problem) return reply.code(400).send({ error: `projectSources:${problem}` })
      }
      if (chapters.length > 500) {
        return reply.code(400).send({ error: 'projectSources:tooManyFiles' })
      }

      if (chapters.length <= 1) {
        const only = chapters[0]
        return ingestBook(request, project, only?.content ?? '', only?.filename ?? 'book.txt', reply)
      }

      // Folder mode: 第2章 must sort before 第10章, so numeric-aware compare.
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
      chapters.sort((a, b) => collator.compare(a.filename, b.filename))
      const parts: string[] = []
      chapters.forEach((chapter, index) => {
        const ext = path.extname(chapter.filename)
        const stem = chapter.filename.slice(0, chapter.filename.length - ext.length).trim()
        // A filename that already reads as a marker headlines itself; otherwise
        // the position number does, with the filename (minus leading digits) as
        // the chapter's display name.
        const header = isChapterMarkerLine(stem)
          ? stem
          : `第${index + 1}章 ${stem.replace(/^[0-9０-９]+[\s._-]*/, '').trim()}`.trimEnd()
        // One file = one chapter: the file's own opening marker line, when
        // present, is redundant next to the filename-derived header.
        const lines = chapter.content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
        const firstText = lines.findIndex(line => line.trim() !== '')
        if (firstText >= 0 && isChapterMarkerLine(lines[firstText].trim())) lines.splice(firstText, 1)
        parts.push(`${header}\n${lines.join('\n').trim()}`)
      })
      const book = parts.join('\n\n')
      return ingestBook(request, project, book, `${chapters[0].filename} (+${chapters.length - 1} files)`, reply, chapters.length)
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

  // One chapter's full text. The matrix reads shapes, not words — a whole book in
  // the list payload would be megabytes — so the content the "did it split right?"
  // check needs is fetched here, one segment at a time, when a row is expanded.
  app.get<{ Params: { projectId: string; segmentId: string } }>(
    '/projects/:projectId/source/segments/:segmentId',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await findProjectInOrg(app.db, request.params.projectId, auth.organizationId)
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const segment = await app.db.sourceSegment.findFirst({
        where: { id: request.params.segmentId, version: { projectId: project.id } },
      })
      if (!segment) return reply.code(404).send({ error: 'Segment not found' })
      return {
        segment: {
          id: segment.id,
          index: segment.index,
          title: segment.title,
          marked: segment.marked,
          charCount: segment.charCount,
          content: segment.content,
        },
      }
    },
  )

  // Chapter text fixes happen here — the matrix row expands into a full-screen
  // editor, and what it saves must flow into every later apply (a new episode
  // source version), not mutate versions already materialized.
  app.patch<{ Params: { projectId: string; segmentId: string }; Body: { content?: string } }>(
    '/projects/:projectId/source/segments/:segmentId',
    { preHandler: requirePermission('project:update') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await findProjectInOrg(app.db, request.params.projectId, auth.organizationId)
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const segment = await app.db.sourceSegment.findFirst({
        where: { id: request.params.segmentId, version: { projectId: project.id } },
      })
      if (!segment) return reply.code(404).send({ error: 'Segment not found' })
      const content = request.body?.content
      if (typeof content !== 'string') return reply.code(400).send({ error: 'content is required' })
      if (!content.trim()) return reply.code(400).send({ error: 'projectSources:empty' })
      if (content.length > PROJECT_SOURCE_CHAR_LIMIT) return reply.code(400).send({ error: 'projectSources:tooLarge' })

      const updated = await app.db.sourceSegment.update({
        where: { id: segment.id },
        data: { content, charCount: content.length },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'projectSource.segmentUpdate',
        entityType: 'SourceSegment',
        entityId: segment.id,
        payload: { projectId: project.id, charCount: updated.charCount },
      })
      return {
        segment: {
          id: updated.id,
          index: updated.index,
          title: updated.title,
          marked: updated.marked,
          charCount: updated.charCount,
          content: updated.content,
        },
      }
    },
  )

  // Removing a chapter is the explicit edit path for junk segments (copyright
  // pages, announcements): the segment and its allocation go, later applies
  // simply never see it. Versions already materialized into episodes are
  // untouched — they are history.
  app.delete<{ Params: { projectId: string; segmentId: string } }>(
    '/projects/:projectId/source/segments/:segmentId',
    { preHandler: requirePermission('project:update') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await findProjectInOrg(app.db, request.params.projectId, auth.organizationId)
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const segment = await app.db.sourceSegment.findFirst({
        where: { id: request.params.segmentId, version: { projectId: project.id } },
      })
      if (!segment) return reply.code(404).send({ error: 'Segment not found' })
      await app.db.sourceSegment.delete({ where: { id: segment.id } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'projectSource.segmentDelete',
        entityType: 'SourceSegment',
        entityId: segment.id,
        payload: { projectId: project.id, title: segment.title, charCount: segment.charCount },
      })
      return reply.code(204).send()
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

  // Auto-split: the one-click answer to "when do episodes happen, which button?".
  // Packs chapters in book order into episodes sized by the project's target
  // duration (350 chars/minute), creating the episodes it needs; mechanical and
  // free. The map stays editable afterwards — this only writes allocations.
  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/source/auto-split',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await findProjectInOrg(app.db, request.params.projectId, auth.organizationId)
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const latest = await app.db.projectSourceVersion.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' } })
      if (!latest) return reply.code(404).send({ error: 'projectSources:notUploaded' })

      const segments = await app.db.sourceSegment.findMany({ where: { projectSourceVersionId: latest.id }, orderBy: { index: 'asc' } })
      if (segments.length === 0) return reply.code(409).send({ error: 'projectSources:nothingAllocated' })

      const fmt = project.format.toLowerCase() as 'short_drama' | 'series' | 'film'
      const targetMs = project.targetDurationMs ?? formatDefaults[fmt].targetDurationMs
      const charBudget = Math.max(1, Math.round((targetMs / 60_000) * SCRIPT_CHARS_PER_MINUTE))

      // Film lands in its one episode; everything else packs in order. A chapter
      // larger than the budget keeps the episode to itself rather than splitting
      // mid-chapter — chapters are the atomic unit the matrix shows.
      const groups: typeof segments[] = []
      if (project.format === 'FILM') {
        groups.push(segments)
      } else {
        let current: typeof segments = []
        let budget = charBudget
        for (const segment of segments) {
          if (current.length > 0 && segment.charCount > budget) {
            groups.push(current)
            current = []
            budget = charBudget
          }
          current.push(segment)
          budget -= segment.charCount
        }
        if (current.length > 0) groups.push(current)
      }

      const existing = await app.db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } })
      let nextNumber = (existing.at(-1)?.number ?? 0) + 1
      // Existing episodes are never touched: new groups append after them.
      const allocations: Array<{ segmentId: string; episodeId: string }> = []
      let episodesCreated = 0
      for (const group of groups) {
        let episodeId: string | undefined
        if (project.format === 'FILM' && existing.length > 0) {
          episodeId = existing[0].id
        } else {
          // Episodes are numbered artifacts, not chapter digests: a chapter title
          // on the episode row reads as "EP1 is chapter 1", which it is not —
          // the chapters it packs are visible one click away in the matrix.
          const created = await app.db.episode.create({
            data: { projectId: project.id, number: nextNumber, title: `第 ${nextNumber} 集`, targetDurationMs: project.targetDurationMs ?? formatDefaults[fmt].targetDurationMs },
          })
          episodeId = created.id
          nextNumber += 1
          episodesCreated += 1
        }
        for (const segment of group) allocations.push({ segmentId: segment.id, episodeId: episodeId! })
      }

      await app.db.$transaction(async tx => {
        await tx.segmentAllocation.deleteMany({ where: { segment: { projectSourceVersionId: latest.id } } })
        await tx.segmentAllocation.createMany({ data: allocations })
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'projectSource.autoSplit',
        entityType: 'ProjectSourceVersion',
        entityId: latest.id,
        payload: { projectId: project.id, episodesCreated, targetDurationMs: targetMs, charBudget },
      })
      return { episodesCreated, allocated: allocations.length }
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
