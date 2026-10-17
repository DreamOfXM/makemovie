import type { FastifyInstance } from 'fastify'
import { roles, type Role } from '@studio/domain'
import { createAgentToken } from '../lib/agent-tokens.js'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

type CreateBody = { name?: unknown; role?: unknown }

/**
 * Agent 接入令牌的管理面:签发/列表/吊销。权限挂在 providers:manage——能管供应
 * 商密钥的人才签得出"能用这些供应商花钱"的长期凭据。默认角色 EDITOR:够 agent
 * 干活(绑定槽位、触发阶段),不够它给自己再签令牌。
 */
export async function agentTokenRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/agent-tokens',
    { preHandler: requirePermission('providers:manage') },
    async (request) => {
      const auth = request.auth!
      const tokens = await app.db.agentToken.findMany({
        where: { organizationId: auth.organizationId },
        orderBy: { createdAt: 'desc' },
      })
      // hash 永不回传;secret 只在签发那一次出现。
      return { tokens: tokens.map(token => ({ id: token.id, name: token.name, role: token.role, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt, revokedAt: token.revokedAt })) }
    },
  )

  app.post<{ Body: CreateBody }>(
    '/agent-tokens',
    { preHandler: requirePermission('providers:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
      if (name === '') return reply.code(400).send({ error: 'name is required' })
      // OWNER 是人的座位;agent 永远拿不到组织所有权。
      const role = (typeof request.body?.role === 'string' ? request.body.role : 'EDITOR') as Role
      if (!roles.includes(role) || role === 'OWNER') return reply.code(400).send({ error: `role must be one of ${roles.filter(item => item !== 'OWNER').join(', ')}` })

      const { row, secret } = await createAgentToken(app.db, { organizationId: auth.organizationId, name, role })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'agentToken.create',
        entityType: 'AgentToken',
        entityId: row.id,
        payload: { name, role },
      })
      return reply.code(201).send({ token: row, secret })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/agent-tokens/:id',
    { preHandler: requirePermission('providers:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const existing = await app.db.agentToken.findFirst({ where: { id: request.params.id, organizationId: auth.organizationId } })
      if (!existing) return reply.code(404).send({ error: 'agent token not found' })
      if (existing.revokedAt) return reply.code(409).send({ error: 'agent token already revoked' })
      await app.db.agentToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'agentToken.revoke',
        entityType: 'AgentToken',
        entityId: existing.id,
        payload: { name: existing.name },
      })
      return { revoked: true }
    },
  )
}
