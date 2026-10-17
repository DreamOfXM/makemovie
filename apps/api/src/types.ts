import type { AppConfig } from '@studio/config'
import type { PrismaClient } from '@studio/db'
import type { Role } from '@studio/domain'
import type { Storage } from '@studio/media'

export interface AuthContext {
  sessionId: string
  /** Agent 令牌没有用户——null 表示这次请求来自一个 agent,审计按令牌记账。 */
  userId: string | null
  organizationId: string
  role: Role
  userEmail: string | null
}

declare module 'fastify' {
  interface FastifyInstance {
    db: PrismaClient
    config: AppConfig
    storage: Storage
  }
  interface FastifyRequest {
    auth?: AuthContext
  }
}
