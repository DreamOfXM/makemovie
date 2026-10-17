import type { FastifyReply, FastifyRequest } from 'fastify'
import { can, type Action } from '@studio/domain'
import { isAgentToken, resolveAgentToken } from '../lib/agent-tokens.js'
import { resolveSession } from '../lib/sessions.js'

export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]?.trim() || undefined
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearerToken(request)
  if (!token) {
    await reply.code(401).send({ error: 'Missing bearer token' })
    return
  }
  // mmt_ 前缀 = agent 令牌,其余按用户会话;两者产出同一 AuthContext,下游
  // 权限检查不需要知道对面是人是 agent。
  const context = isAgentToken(token)
    ? await resolveAgentToken(request.server.db, token)
    : await resolveSession(request.server.db, token)
  if (!context) {
    await reply.code(401).send({ error: isAgentToken(token) ? 'Invalid or revoked agent token' : 'Invalid or expired session' })
    return
  }
  request.auth = context
}

export function requirePermission(action: Action) {
  return [
    authenticate,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.auth
      if (!auth) {
        await reply.code(401).send({ error: 'Unauthorized' })
        return
      }
      if (!can(auth.role, action)) {
        await reply.code(403).send({ error: `Role ${auth.role} is not allowed to perform "${action}"` })
      }
    },
  ]
}
