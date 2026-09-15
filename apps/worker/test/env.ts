import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import net from 'node:net'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Queue } from 'bullmq'
import EmbeddedPostgres from 'embedded-postgres'
import { PrismaClient, type Stage } from '@studio/db'
import { createPipelineQueue, enqueue, type ComposeEpisodePayload, type PipelinePayload, type RunTaskCandidate, type RunTaskPayload } from '@studio/jobs'
import { DiskStorage, FfmpegComposer, buildObjectKey, extensionFor, synthesizeMockMedia, type Storage } from '@studio/media'
import { encryptSecret } from '@studio/security'
import type { PipelineDeps } from '../src/deps.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export const MASTER_KEY = '0'.repeat(64)
// The mock provider materialises files with ffmpeg, which picks the container from
// the output extension, so the seed helper needs the same modality map it uses.
const MOCK_EXTENSION: Record<string, string> = { image: 'png', t2v: 'mp4', i2v: 'mp4', r2v: 'mp4', tts: 'wav', music: 'wav' }
// Logical DB 5 keeps these tests away from the queue the API suite drives on DB 7.
const REDIS_URL = 'redis://127.0.0.1:6380/5'

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
    const port = 55500 + Math.floor(Math.random() * 90)
    if (await isPortFree(port)) return port
  }
  throw new Error('could not find a free port for embedded PostgreSQL')
}

export interface SeedInput {
  model?: string
  modality?: string
  connectionEnabled?: boolean
  stage?: Stage
  prompt?: string
  requestSnapshot?: string | null
  storyboards?: number
  asset?: { kind: string; name: string; description: string }
}

export interface Seed {
  organizationId: string
  projectId: string
  episodeId: string
  assetId?: string
  storyboardIds: string[]
  connectionId: string
  capabilityId: string
  batchId: string
  taskId: string
  candidates: RunTaskCandidate[]
}

export interface WorkerTestEnv {
  db: PrismaClient
  queue: Queue<PipelinePayload>
  storage: Storage
  deps(overrides?: Partial<PipelineDeps>): PipelineDeps
  seed(input?: SeedInput): Promise<Seed>
  runPayload(seed: Seed, attempt?: number): RunTaskPayload
  composePayload(compositionId: string, seed: Seed): ComposeEpisodePayload
  attachSucceededVideo(seed: Seed, storyboardId: string, version: number, options?: { durationMs?: number }): Promise<void>
  attachSucceededMedia(seed: Seed, input: { stage: Stage; modality: string; storyboardId?: string; version?: number; durationMs?: number }): Promise<void>
  takeWaitingRunTasks(): Promise<RunTaskPayload[]>
  drain(): Promise<void>
  stop(): Promise<void>
}

export async function startTestEnv(): Promise<WorkerTestEnv> {
  const port = await acquirePort()
  const dataDir = mkdtempSync(path.join(tmpdir(), 'studio-worker-it-'))
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'studio-worker-artifacts-'))
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
    rmSync(artifactsDir, { recursive: true, force: true })
    throw new Error(`prisma migrate deploy failed: ${stderr}`)
  }

  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  const storage = new DiskStorage(artifactsDir)
  const queue = createPipelineQueue({ url: REDIS_URL })
  await queue.obliterate({ force: true })

  const env: WorkerTestEnv = {
    db,
    queue,
    storage,
    deps(overrides = {}) {
      return {
        db,
        storage,
        composer: new FfmpegComposer(),
        masterKey: MASTER_KEY,
        qcMode: 'random',
        // The mock settles on its second poll, so seconds are ample; keeping it low
        // means a provider that never settles fails the test instead of parking the
        // suite behind the 15-minute production ceiling.
        pollTimeoutMs: 5_000,
        enqueueJob: payload => enqueue(queue, payload),
        ...overrides,
      }
    },
    async seed(input = {}) {
      const suffix = randomUUID().slice(0, 8)
      const model = input.model ?? 'mock-t2v'
      const modality = input.modality ?? 't2v'
      const stage = input.stage ?? 'VIDEO'
      const organization = await db.organization.create({ data: { name: `Org ${suffix}`, slug: `org-${suffix}` } })
      const project = await db.project.create({ data: { organizationId: organization.id, name: `Project ${suffix}` } })
      const episode = await db.episode.create({ data: { projectId: project.id, number: 1, title: 'Episode 1' } })
      const asset = input.asset
        ? await db.asset.create({
            data: { episodeId: episode.id, kind: input.asset.kind, name: input.asset.name, description: input.asset.description, status: 'DRAFT' },
          })
        : undefined

      const storyboardCount = input.storyboards ?? 1
      const storyboards = []
      for (let index = 0; index < storyboardCount; index += 1) {
        storyboards.push(
          await db.storyboard.create({
            data: {
              episodeId: episode.id,
              number: index + 1,
              title: `Shot ${index + 1}`,
              durationMs: 1000,
              description: 'a rainy night market',
              sourceExcerpt: 'excerpt',
              continuityIn: 'in',
              continuityOut: 'out',
            },
          }),
        )
      }

      const connection = await db.providerConnection.create({
        data: {
          organizationId: organization.id,
          provider: 'mock',
          name: `mock-${suffix}`,
          baseUrl: 'mock://local',
          enabled: input.connectionEnabled ?? true,
          encryptedSecret: encryptSecret('test-key', MASTER_KEY),
          capabilities: { create: [{ model, modality }] },
        },
      })
      const capability = await db.modelCapability.findFirstOrThrow({ where: { connectionId: connection.id } })

      const batch = await db.generationBatch.create({
        data: {
          organizationId: organization.id,
          episodeId: episode.id,
          stage,
          status: 'RUNNING',
          plannedCount: storyboards.length,
          storyboards: { connect: storyboards.map(storyboard => ({ id: storyboard.id })) },
        },
      })
      const prompt = input.prompt ?? 'a rainy night market, neon reflections'
      const defaultSnapshot = asset
        ? { model, input: { prompt }, parameters: {}, assetId: asset.id }
        : { model, input: { prompt }, parameters: {} }
      const task = await db.generationTask.create({
        data: {
          organizationId: organization.id,
          batchId: batch.id,
          stage,
          status: 'QUEUED',
          requestSnapshot: input.requestSnapshot === undefined ? JSON.stringify(defaultSnapshot) : input.requestSnapshot,
        },
      })

      return {
        organizationId: organization.id,
        projectId: project.id,
        episodeId: episode.id,
        assetId: asset?.id,
        storyboardIds: storyboards.map(storyboard => storyboard.id),
        connectionId: connection.id,
        capabilityId: capability.id,
        batchId: batch.id,
        taskId: task.id,
        candidates: [{ connectionId: connection.id, capabilityId: capability.id, provider: 'mock', model }],
      }
    },
    runPayload(seed, attempt = 1) {
      return { kind: 'run-task', taskId: seed.taskId, organizationId: seed.organizationId, attempt, candidates: seed.candidates }
    },
    composePayload(compositionId, seed) {
      return { kind: 'compose-episode', compositionId, episodeId: seed.episodeId, organizationId: seed.organizationId }
    },
    async attachSucceededVideo(seed, storyboardId, version, options) {
      await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 't2v', storyboardId, version, durationMs: options?.durationMs })
    },
    async attachSucceededMedia(seed, input) {
      const version = input.version ?? 1
      const batch = await db.generationBatch.create({
        data: {
          organizationId: seed.organizationId,
          episodeId: seed.episodeId,
          stage: input.stage,
          status: 'COMPLETED',
          plannedCount: 1,
          ...(input.storyboardId ? { storyboards: { connect: { id: input.storyboardId } } } : {}),
        },
      })
      const task = await db.generationTask.create({
        data: { organizationId: seed.organizationId, batchId: batch.id, stage: input.stage, status: 'SUCCEEDED', attempts: version, ...(input.storyboardId ? { storyboardId: input.storyboardId } : {}) },
      })
      const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-seed-'))
      try {
        const source = path.join(workdir, `clip.${MOCK_EXTENSION[input.modality] ?? 'bin'}`)
        const media = await synthesizeMockMedia(input.modality, source, { durationMs: input.durationMs ?? 1000 })
        const stored = await storage.put(
          buildObjectKey({
            tenantId: seed.organizationId,
            projectId: seed.projectId,
            episodeId: seed.episodeId,
            stage: input.stage,
            entityId: task.id,
            version,
            extension: extensionFor(media.mimeType),
          }),
          new Uint8Array(await readFile(source)),
          media.mimeType,
        )
        await db.mediaArtifact.create({
          data: {
            organizationId: seed.organizationId,
            taskId: task.id,
            stage: input.stage,
            objectKey: stored.key,
            checksum: stored.checksum,
            mimeType: stored.mimeType,
            version,
            durationMs: media.durationMs,
          },
        })
      } finally {
        await rm(workdir, { recursive: true, force: true })
      }
    },
    async takeWaitingRunTasks() {
      const jobs = await queue.getJobs(['waiting', 'delayed', 'active'])
      const payloads = jobs.map(job => job.data).filter((payload): payload is RunTaskPayload => payload.kind === 'run-task')
      await Promise.all(jobs.map(job => job.remove().catch(() => undefined)))
      return payloads.sort((a, b) => a.attempt - b.attempt)
    },
    async drain() {
      await queue.obliterate({ force: true })
    },
    async stop() {
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close()
      await db.$disconnect()
      try { await pg.stop() } catch { /* already stopped */ }
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(artifactsDir, { recursive: true, force: true })
    },
  }
  return env
}
