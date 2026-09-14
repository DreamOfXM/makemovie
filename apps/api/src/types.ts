import type { AppConfig } from '@studio/config'
import type { PrismaClient } from '@studio/db'
import type { Role } from '@studio/domain'
import type { Storage } from '@studio/media'

export interface AuthContext {
  sessionId: string
  userId: string
  organizationId: string
  role: Role
  userEmail: string
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
