import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects', { preHandler: requirePermission('read') }, async request => {
    const auth = request.auth!
    return app.db.project.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: { createdAt: 'desc' },
    })
  })

  app.post<{ Body: { name?: string } }>('/projects', { preHandler: requirePermission('project:create') }, async (request, reply) => {
    const auth = request.auth!
    const name = request.body?.name?.trim()
    if (!name) return reply.code(400).send({ error: 'name is required' })
    const project = await app.db.project.create({ data: { organizationId: auth.organizationId, name } })
    await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'project.create', entityType: 'Project', entityId: project.id, payload: { name } })
    return reply.code(201).send(project)
  })

  app.patch<{ Params: { projectId: string }; Body: { name?: string } }>(
    '/projects/:projectId',
    { preHandler: requirePermission('project:update') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const name = request.body?.name?.trim()
      if (!name) return reply.code(400).send({ error: 'name is required' })
      const updated = await app.db.project.update({ where: { id: project.id }, data: { name } })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'project.update', entityType: 'Project', entityId: project.id, payload: { from: project.name, to: name } })
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
