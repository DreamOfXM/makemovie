import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import { loadConfig, type AppConfig } from '@studio/config'
import { PrismaClient } from '@studio/db'
import { PROJECT_SOURCE_CHAR_LIMIT } from '@studio/domain'
import { storageFrom, type Storage } from '@studio/media'
import './types.js'
import { authRoutes } from './routes/auth.js'
import { projectRoutes } from './routes/projects.js'
import { episodeRoutes } from './routes/episodes.js'
import { memberRoutes } from './routes/members.js'
import { auditRoutes } from './routes/audit.js'
import { providerRoutes } from './routes/providers.js'
import { bindingRoutes } from './routes/bindings.js'
import { generationRoutes } from './routes/generations.js'
import { artifactRoutes } from './routes/artifacts.js'
import { sourceRoutes } from './routes/sources.js'
import { projectSourceRoutes } from './routes/project-sources.js'
import { assetRoutes } from './routes/assets.js'
import { deliveryRoutes } from './routes/deliveries.js'
import { usageRoutes } from './routes/usage.js'

export interface BuildAppOptions {
  config?: AppConfig
  db?: PrismaClient
  storage?: Storage
  logger?: boolean
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig()
  const db = options.db ?? new PrismaClient({ datasources: { db: { url: config.databaseUrl } } })
  const storage = options.storage ?? storageFrom(config)

  const app = Fastify({ logger: options.logger ?? true })
  app.decorate('db', db)
  app.decorate('config', config)
  app.decorate('storage', storage)

  // @fastify/cors defaults to GET,HEAD,POST, which fails the preflight for every
  // PATCH/PUT/DELETE route — the whole editable surface of the console.
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })
  // The suite drives thousands of inject()s through one app in seconds and shares the
  // 127.0.0.1 key; like the auth routes before it, the global limiter stands down in
  // test so a long file trips its own gates instead of a 429.
  await app.register(rateLimit, app.config.nodeEnv === 'test' ? { max: Number.MAX_SAFE_INTEGER, timeWindow: '1 minute' } : { max: 300, timeWindow: '1 minute' })
  // Whole-book intake. The byte ceiling is generous on purpose: 4 bytes per char
  // covers UTF-8's worst case against the 1M-character limit; bigger files die
  // here instead of buffering in memory first.
  await app.register(multipart, { limits: { fileSize: PROJECT_SOURCE_CHAR_LIMIT * 4, files: 1 } })

  app.get('/health', async () => ({ status: 'ok', service: 'api' }))

  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(projectRoutes)
  await app.register(episodeRoutes)
  await app.register(memberRoutes)
  await app.register(auditRoutes)
  await app.register(providerRoutes)
  await app.register(bindingRoutes)
  await app.register(generationRoutes)
  await app.register(artifactRoutes)
  await app.register(sourceRoutes)
  await app.register(projectSourceRoutes)
  await app.register(assetRoutes)
  await app.register(deliveryRoutes)
  await app.register(usageRoutes)

  app.addHook('onClose', async () => {
    await storage.close()
    await db.$disconnect()
  })

  return app
}
