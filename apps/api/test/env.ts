import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import EmbeddedPostgres from 'embedded-postgres'
import { loadConfig } from '@studio/config'
import { PrismaClient } from '@studio/db'
import { buildApp } from '../src/app.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

// Test files run in parallel and each needs its own PostgreSQL, so confirm the
// port is free instead of trusting a random draw from a shared range.
async function acquirePort(): Promise<number> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const port = 55400 + Math.floor(Math.random() * 90)
    if (await isPortFree(port)) return port
  }
  throw new Error('could not find a free port for embedded PostgreSQL')
}

export interface TestEnv {
  app: FastifyInstance
  db: PrismaClient
  register(email: string, organizationName: string): Promise<{ token: string; organization: { id: string; name: string }; role: string }>
  authHeaders(token: string): Record<string, string>
  stop(): Promise<void>
}

export async function startTestEnv(): Promise<TestEnv> {
  const port = await acquirePort()
  const dataDir = mkdtempSync(path.join(tmpdir(), 'studio-it-'))
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'studio-artifacts-'))
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'studio', password: 'studio', port, persistent: false })
  await pg.initialise()
  await pg.start()

  const databaseUrl = `postgresql://studio:studio@127.0.0.1:${port}/postgres`
  try {
    execFileSync('pnpm', ['--filter', '@studio/db', 'exec', 'prisma', 'migrate', 'deploy'], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error)
    await pg.stop().catch(() => undefined)
    rmSync(dataDir, { recursive: true, force: true })
    throw new Error(`prisma migrate deploy failed: ${stderr}`)
  }

  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  const config = loadConfig({ DATABASE_URL: databaseUrl, STUDIO_ARTIFACTS_DIR: artifactsDir })
  const app = await buildApp({ config, db, logger: false })
  await app.ready()

  return {
    app,
    db,
    authHeaders(token: string) {
      return { authorization: `Bearer ${token}` }
    },
    async register(email: string, organizationName: string) {
      const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'password123', organizationName } })
      if (res.statusCode !== 201) throw new Error(`register failed (${res.statusCode}): ${res.body}`)
      return res.json() as { token: string; organization: { id: string; name: string }; role: string }
    },
    async stop() {
      await app.close()
      await db.$disconnect()
      try { await pg.stop() } catch { /* already stopped */ }
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(artifactsDir, { recursive: true, force: true })
    },
  }
}
