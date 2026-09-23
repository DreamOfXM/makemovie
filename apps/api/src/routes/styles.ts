import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

interface StyleBody {
  name?: string
  description?: string
  visualStyle?: string | null
  tone?: string | null
  colorPalette?: string | null
  cameraStyle?: string | null
  extraPrompt?: string | null
}

export async function styleRoutes(app: FastifyInstance): Promise<void> {
  // GET /styles - list all styles (official + org-scoped)
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/styles',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const limit = request.query.limit ? Number(request.query.limit) : 50
      const offset = request.query.offset ? Number(request.query.offset) : 0
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return reply.code(400).send({ error: 'limit must be an integer between 1 and 200' })
      }
      if (!Number.isInteger(offset) || offset < 0) {
        return reply.code(400).send({ error: 'offset must be a non-negative integer' })
      }
      const styles = await app.db.stylePreset.findMany({
        where: {
          OR: [{ organizationId: null }, { organizationId: auth.organizationId }],
        },
        orderBy: [{ isOfficial: 'desc' }, { createdAt: 'desc' }],
        skip: offset,
        take: limit,
      })
      const total = await app.db.stylePreset.count({
        where: {
          OR: [{ organizationId: null }, { organizationId: auth.organizationId }],
        },
      })
      return { styles, total, limit, offset }
    },
  )

  // GET /styles/:id - get style by ID
  app.get<{ Params: { styleId: string } }>(
    '/styles/:styleId',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const style = await app.db.stylePreset.findFirst({
        where: {
          id: request.params.styleId,
          OR: [{ organizationId: null }, { organizationId: auth.organizationId }],
        },
      })
      if (!style) return reply.code(404).send({ error: 'Style not found' })
      return style
    },
  )

  // POST /styles - create custom style
  app.post<{ Body: StyleBody }>(
    '/styles',
    { preHandler: requirePermission('project:create') },
    async (request, reply) => {
      const auth = request.auth!
      const name = request.body?.name?.trim()
      if (!name) return reply.code(400).send({ error: 'name is required' })
      if (name.length > 100) return reply.code(400).send({ error: 'name must be 100 characters or less' })

      const style = await app.db.stylePreset.create({
        data: {
          organizationId: auth.organizationId,
          name,
          description: request.body?.description || '',
          visualStyle: request.body?.visualStyle || null,
          tone: request.body?.tone || null,
          colorPalette: request.body?.colorPalette || null,
          cameraStyle: request.body?.cameraStyle || null,
          extraPrompt: request.body?.extraPrompt || null,
          isOfficial: false,
        },
      } as Parameters<typeof app.db.stylePreset.create>[0])
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'style.create',
        entityType: 'StylePreset',
        entityId: style.id,
        payload: { name, description: style.description },
      })
      return reply.code(201).send(style)
    },
  )

  // PATCH /styles/:id - update custom style
  app.patch<{ Params: { styleId: string }; Body: StyleBody }>(
    '/styles/:styleId',
    { preHandler: requirePermission('project:create') },
    async (request, reply) => {
      const auth = request.auth!
      const style = await app.db.stylePreset.findFirst({
        where: { id: request.params.styleId, organizationId: auth.organizationId, isOfficial: false },
      })
      if (!style) {
        return reply.code(404).send({ error: 'Custom style not found or cannot be modified' })
      }

      const data: Record<string, unknown> = {}
      if (request.body?.name !== undefined) {
        const trimmed = request.body.name.trim()
        if (!trimmed) return reply.code(400).send({ error: 'name cannot be empty' })
        if (trimmed.length > 100) return reply.code(400).send({ error: 'name must be 100 characters or less' })
        data.name = trimmed
      }
      if (request.body?.description !== undefined) data.description = request.body.description
      if (request.body?.visualStyle !== undefined) data.visualStyle = request.body.visualStyle
      if (request.body?.tone !== undefined) data.tone = request.body.tone
      if (request.body?.colorPalette !== undefined) data.colorPalette = request.body.colorPalette
      if (request.body?.cameraStyle !== undefined) data.cameraStyle = request.body.cameraStyle
      if (request.body?.extraPrompt !== undefined) data.extraPrompt = request.body.extraPrompt

      const updated = await app.db.stylePreset.update({
        where: { id: style.id },
        data: data as Parameters<typeof app.db.stylePreset.update>[0]['data'],
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'style.update',
        entityType: 'StylePreset',
        entityId: style.id,
        payload: { name: updated.name },
      })
      return updated
    },
  )

  // DELETE /styles/:id - delete custom style
  app.delete<{ Params: { styleId: string } }>(
    '/styles/:styleId',
    { preHandler: requirePermission('project:delete') },
    async (request, reply) => {
      const auth = request.auth!
      const style = await app.db.stylePreset.findFirst({
        where: { id: request.params.styleId, organizationId: auth.organizationId, isOfficial: false },
      })
      if (!style) {
        return reply.code(404).send({ error: 'Custom style not found or cannot be deleted' })
      }
      // Unlink from any projects using this style
      await app.db.project.updateMany({
        where: { stylePresetId: style.id },
        data: { stylePresetId: null },
      })
      await app.db.stylePreset.delete({ where: { id: style.id } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'style.delete',
        entityType: 'StylePreset',
        entityId: style.id,
        payload: { name: style.name },
      })
      return reply.code(204).send()
    },
  )
}
