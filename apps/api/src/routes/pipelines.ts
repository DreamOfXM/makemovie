import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

interface PipelineBody {
  name?: string
  description?: string
  styleId?: string | null
  config?: Record<string, unknown>
  isDefault?: boolean
}

export async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  // GET /pipelines - list pipelines (official + org-scoped)
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/pipelines',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const limit = request.query.limit ? Number(request.query.limit) : 50
      const offset = request.query.offset ? Number(request.query.offset) : 0
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return reply.code(400).send({ error: 'limit must be an integer between 1 and 200' })
      }
      if (!Number.isInteger(offset) || offset < 0) {
        return reply.code(400).send({ error: 'offset must be a non-negative integer' })
      }
      const pipelines = await app.db.pipelineConfig.findMany({
        where: {},
        orderBy: [{ isOfficial: 'desc' }, { isDefault: 'desc' }, { createdAt: 'desc' }],
        skip: offset,
        take: limit,
      })
      const total = await app.db.pipelineConfig.count({ where: {} })
      return { pipelines, total, limit, offset }
    },
  )

  // GET /pipelines/:id - get pipeline by ID
  app.get<{ Params: { pipelineId: string } }>(
    '/pipelines/:pipelineId',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const pipeline = await app.db.pipelineConfig.findFirst({
        where: { id: request.params.pipelineId },
      })
      if (!pipeline) return reply.code(404).send({ error: 'Pipeline not found' })
      return pipeline
    },
  )

  // POST /pipelines - create pipeline
  app.post<{ Body: PipelineBody }>(
    '/pipelines',
    { preHandler: requirePermission('project:create') },
    async (request, reply) => {
      const auth = request.auth!
      const name = request.body?.name?.trim()
      if (!name) return reply.code(400).send({ error: 'name is required' })
      if (name.length > 100) return reply.code(400).send({ error: 'name must be 100 characters or less' })
      if (request.body?.config === undefined) return reply.code(400).send({ error: 'config is required' })

      // Validate styleId if provided
      if (request.body?.styleId) {
        const style = await app.db.stylePreset.findFirst({
          where: { id: request.body.styleId, OR: [{ organizationId: null }, { organizationId: auth.organizationId }] },
        })
        if (!style) return reply.code(400).send({ error: 'styleId references a non-existent or inaccessible style' })
      }

      const pipeline = await app.db.pipelineConfig.create({
        data: {
          name,
          description: request.body?.description || '',
          styleId: request.body?.styleId || null,
          config: request.body.config as Parameters<typeof app.db.pipelineConfig.create>[0]['data']['config'],
          isDefault: request.body?.isDefault ?? false,
          isOfficial: false,
        },
      } as Parameters<typeof app.db.pipelineConfig.create>[0])
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'pipeline.create',
        entityType: 'PipelineConfig',
        entityId: pipeline.id,
        payload: { name, description: pipeline.description },
      })
      return reply.code(201).send(pipeline)
    },
  )

  // PATCH /pipelines/:id - update pipeline
  app.patch<{ Params: { pipelineId: string }; Body: PipelineBody }>(
    '/pipelines/:pipelineId',
    { preHandler: requirePermission('project:create') },
    async (request, reply) => {
      const auth = request.auth!
      const pipeline = await app.db.pipelineConfig.findFirst({
        where: { id: request.params.pipelineId, isOfficial: false },
      })
      if (!pipeline) {
        return reply.code(404).send({ error: 'Pipeline not found or cannot be modified' })
      }

      const data: Record<string, unknown> = {}

      if (request.body?.name !== undefined) {
        const trimmed = request.body.name.trim()
        if (!trimmed) return reply.code(400).send({ error: 'name cannot be empty' })
        if (trimmed.length > 100) return reply.code(400).send({ error: 'name must be 100 characters or less' })
        data.name = trimmed
      }
      if (request.body?.description !== undefined) data.description = request.body.description
      if (request.body?.styleId !== undefined) data.styleId = request.body.styleId
      if (request.body?.config !== undefined) data.config = request.body.config
      if (request.body?.isDefault !== undefined) data.isDefault = request.body.isDefault

      const updated = await app.db.pipelineConfig.update({
        where: { id: pipeline.id },
        data: data as Parameters<typeof app.db.pipelineConfig.update>[0]['data'],
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'pipeline.update',
        entityType: 'PipelineConfig',
        entityId: pipeline.id,
        payload: { name: updated.name },
      })
      return updated
    },
  )

  // DELETE /pipelines/:id - delete pipeline
  app.delete<{ Params: { pipelineId: string } }>(
    '/pipelines/:pipelineId',
    { preHandler: requirePermission('project:delete') },
    async (request, reply) => {
      const auth = request.auth!
      const pipeline = await app.db.pipelineConfig.findFirst({
        where: { id: request.params.pipelineId, isOfficial: false },
      })
      if (!pipeline) {
        return reply.code(404).send({ error: 'Pipeline not found or cannot be deleted' })
      }
      // Unlink from any projects using this pipeline
      await app.db.project.updateMany({
        where: { pipelineConfigId: pipeline.id },
        data: { pipelineConfigId: null },
      })
      await app.db.pipelineConfig.delete({ where: { id: pipeline.id } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'pipeline.delete',
        entityType: 'PipelineConfig',
        entityId: pipeline.id,
        payload: { name: pipeline.name },
      })
      return reply.code(204).send()
    },
  )
}
