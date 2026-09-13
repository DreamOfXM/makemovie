import type { FastifyReply, FastifyRequest } from 'fastify'
import { can, type Action } from '@studio/domain'
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
  const context = await resolveSession(request.server.db, token)
  if (!context) {
    await reply.code(401).send({ error: 'Invalid or expired session' })
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
