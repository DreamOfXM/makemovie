import type { FastifyInstance } from 'fastify'
import { ProjectFormat } from '@studio/db'
import { contentLocales, durationOutOfRange, formatDefaults, formatDurationRange, isContentLocale, isProjectFormat, projectFormats } from '@studio/domain'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: string; before?: string } }>('/projects', { preHandler: requirePermission('read') }, async (request, reply) => {
    const auth = request.auth!
    // The project list is a lifecycle board, not a name table: each row carries the
    // episode status summary the lifecycle bar renders from, so the list needs no
    // per-project drill-down request to draw itself.
    //
    // Without query params the response stays the bare array every existing
    // consumer reads. Passing limit opts into cursor pagination (id cursor over
    // the createdAt+id ordering) and answers { projects, nextCursor } instead —
    // a space with hundreds of projects must not ship as one endless page.
    const include = {
      episodes: {
        orderBy: { number: 'asc' as const },
        select: { id: true, number: true, title: true, status: true },
      },
    }
    if (request.query?.limit !== undefined) {
      const limit = Number(request.query.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return reply.code(400).send({ error: 'limit must be an integer between 1 and 100' })
      }
      const rows = await app.db.project.findMany({
        where: { organizationId: auth.organizationId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(request.query.before ? { cursor: { id: request.query.before }, skip: 1 } : {}),
        take: limit + 1,
        include,
      })
      const nextCursor = rows.length > limit ? rows[limit - 1].id : null
      return { projects: rows.slice(0, limit), nextCursor }
    }
    return app.db.project.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include,
    })
  })

  app.post<{ Body: { name?: string; contentLocale?: string; format?: string; targetDurationMs?: number } }>('/projects', { preHandler: requirePermission('project:create') }, async (request, reply) => {
    const auth = request.auth!
    const name = request.body?.name?.trim()
    if (!name) return reply.code(400).send({ error: 'name is required' })
    const contentLocale = request.body?.contentLocale
    if (contentLocale !== undefined && !isContentLocale(contentLocale)) {
      return reply.code(400).send({ error: `contentLocale must be one of ${contentLocales.join(', ')}` })
    }
    const format = request.body?.format ?? 'short_drama'
    if (!isProjectFormat(format)) {
      return reply.code(400).send({ error: `format must be one of ${projectFormats.join(', ')}` })
    }
    // A custom default is the whole point of the format ranges: dramas running
    // 90-second episodes or a 95-minute film set it here once, per-episode.
    const range = formatDurationRange[format]
    if (request.body?.targetDurationMs !== undefined && durationOutOfRange(format, request.body.targetDurationMs)) {
      return reply.code(400).send({ error: `targetDurationMs must be between ${range.minMs} and ${range.maxMs} for format ${format}` })
    }
    const prismaFormat = ProjectFormat[format.toUpperCase() as keyof typeof ProjectFormat]
    const project = await app.db.$transaction(async tx => {
      const created = await tx.project.create({
        data: {
          organizationId: auth.organizationId,
          name,
          contentLocale,
          format: prismaFormat,
          ...(request.body?.targetDurationMs === undefined ? {} : { targetDurationMs: request.body?.targetDurationMs }),
        },
      })
      // A film is a one-episode project, so its single episode exists from the
      // start, seeded with the effective target duration.
      if (prismaFormat === 'FILM') {
        await tx.episode.create({
          data: { projectId: created.id, number: 1, title: '正片', targetDurationMs: created.targetDurationMs ?? formatDefaults.film.targetDurationMs },
        })
      }
      return created
    })
    await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'project.create', entityType: 'Project', entityId: project.id, payload: { name, contentLocale: project.contentLocale, format: project.format, targetDurationMs: project.targetDurationMs } })
    return reply.code(201).send(project)
  })

  app.patch<{ Params: { projectId: string }; Body: { name?: string; contentLocale?: string; format?: string; targetDurationMs?: number } }>(
    '/projects/:projectId',
    { preHandler: requirePermission('project:update') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      // The format is fixed at creation by design; silently ignoring it here made
      // third-party callers believe a rename also re-shaped the project.
      if (request.body?.format !== undefined || request.body?.targetDurationMs !== undefined) {
        return reply.code(400).send({ error: 'format and targetDurationMs are set at project creation and cannot be changed here' })
      }
      const { name, contentLocale } = request.body ?? {}
      if (name === undefined && contentLocale === undefined) {
        return reply.code(400).send({ error: 'name or contentLocale is required' })
      }
      if (name !== undefined && !name.trim()) return reply.code(400).send({ error: 'name is required' })
      if (contentLocale !== undefined && !isContentLocale(contentLocale)) {
        return reply.code(400).send({ error: `contentLocale must be one of ${contentLocales.join(', ')}` })
      }
      const updated = await app.db.project.update({
        where: { id: project.id },
        data: { ...(name === undefined ? {} : { name: name.trim() }), ...(contentLocale === undefined ? {} : { contentLocale }) },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'project.update',
        entityType: 'Project',
        entityId: project.id,
        payload: { from: { name: project.name, contentLocale: project.contentLocale }, to: { name: updated.name, contentLocale: updated.contentLocale } },
      })
      return updated
    },
  )

  app.delete<{ Params: { projectId: string } }>(
    '/projects/:projectId',
    { preHandler: requirePermission('project:delete') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      await app.db.project.delete({ where: { id: project.id } })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'project.delete', entityType: 'Project', entityId: project.id, payload: { name: project.name } })
      return reply.code(204).send()
    },
  )
}
