import type { FastifyInstance } from 'fastify'
import type { Composition, GenerationBatch, GenerationTask, MediaArtifact, PrismaClient, QualityCheck, TaskStatus, WorkflowStatus } from '@studio/db'
import { syncBatchStatus } from '@studio/db'
import { createPipelineQueue, enqueue, type PipelinePayload } from '@studio/jobs'
import { advancePipeline, generationStages, isGenerationStage, toApiStage, triggerStage, type GenerationStage } from '@studio/pipeline'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'
import { toArtifactDto, type ArtifactDto } from './artifacts.js'

type PipelineQueue = ReturnType<typeof createPipelineQueue>

interface QcDto {
  kind: string
  score: number
  status: WorkflowStatus
}

interface TaskDto {
  id: string
  stage: GenerationStage
  status: TaskStatus
  attempts: number
  provider: string | null
  model: string | null
  error: string | null
  createdAt: Date
  updatedAt: Date
  artifacts: ArtifactDto[]
  qc: QcDto | null
}

interface BatchDto {
  id: string
  stage: GenerationStage
  status: WorkflowStatus
  plannedCount: number
  createdAt: Date
  tasks: TaskDto[]
}

interface CompositionDto {
  id: string
  status: WorkflowStatus
  artifact: ArtifactDto | null
}

type TaskRow = GenerationTask & { artifacts: MediaArtifact[] }
type BatchRow = GenerationBatch & { tasks: TaskRow[] }

interface GenerationBody {
  stage?: string
  storyboardIds?: string[]
  regenerate?: boolean
}

async function findEpisodeInOrg(db: PrismaClient, episodeId: string, organizationId: string) {
  return db.episode.findFirst({ where: { id: episodeId, project: { organizationId } } })
}

async function latestChecks(db: PrismaClient, tasks: TaskRow[]): Promise<QualityCheck[]> {
  const artifactIds = tasks.flatMap(task => task.artifacts.map(artifact => artifact.id))
  if (artifactIds.length === 0) return []
  return db.qualityCheck.findMany({ where: { artifactId: { in: artifactIds } }, orderBy: { id: 'desc' } })
}

function toTaskDto(task: TaskRow, checks: QualityCheck[]): TaskDto {
  const artifactIds = new Set(task.artifacts.map(artifact => artifact.id))
  const check = checks.find(candidate => candidate.artifactId !== null && artifactIds.has(candidate.artifactId))
  return {
    id: task.id,
    stage: toApiStage(task.stage),
    status: task.status,
    attempts: task.attempts,
    provider: task.provider,
    model: task.model,
    error: task.errorSnapshot,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    artifacts: task.artifacts.map(toArtifactDto),
    qc: check ? { kind: check.kind, score: check.score ?? 0, status: check.status } : null,
  }
}

async function toTaskDtos(db: PrismaClient, tasks: TaskRow[]): Promise<TaskDto[]> {
  const checks = await latestChecks(db, tasks)
  return tasks.map(task => toTaskDto(task, checks))
}

async function toBatchDtos(db: PrismaClient, batches: BatchRow[]): Promise<BatchDto[]> {
  const checks = await latestChecks(db, batches.flatMap(batch => batch.tasks))
  return batches.map(batch => ({
    id: batch.id,
    stage: toApiStage(batch.stage),
    status: batch.status,
    plannedCount: batch.plannedCount,
    // GenerationBatch has no timestamp columns; the batch and its tasks are
    // written together, so the first task stamps the batch.
    createdAt: batch.tasks[0]?.createdAt ?? new Date(0),
    tasks: batch.tasks.map(task => toTaskDto(task, checks)),
  }))
}

async function toBatchDto(db: PrismaClient, batchId: string): Promise<BatchDto> {
  const batch = await db.generationBatch.findUniqueOrThrow({
    where: { id: batchId },
    include: { tasks: { include: { artifacts: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  })
  const [dto] = await toBatchDtos(db, [batch])
  return dto
}

async function toCompositionDto(db: PrismaClient, composition: Composition): Promise<CompositionDto> {
  const artifact = composition.artifactId ? await db.mediaArtifact.findUnique({ where: { id: composition.artifactId } }) : null
  return { id: composition.id, status: composition.status, artifact: artifact ? toArtifactDto(artifact) : null }
}

export async function generationRoutes(app: FastifyInstance): Promise<void> {
  // Lazily created: an instance that never triggers a generation keeps no Redis
  // connection open, and the one queue it does create is closed with the app.
  let queue: PipelineQueue | undefined
  app.addHook('onClose', async () => {
    await queue?.close()
  })
  function pipeline(): PipelineQueue {
    queue ??= createPipelineQueue()
    return queue
  }

  const enqueueJob = (payload: PipelinePayload): Promise<void> => enqueue(pipeline(), payload)

  app.post<{ Params: { episodeId: string }; Body: GenerationBody }>(
    '/episodes/:episodeId/generations',
    { preHandler: requirePermission('generation:trigger') },
    async (request, reply) => {
      const auth = request.auth!
      const stage = request.body?.stage
      if (!isGenerationStage(stage)) return reply.code(400).send({ error: `stage must be one of: ${generationStages.join(', ')}` })
      const result = await triggerStage({ db: app.db, enqueueJob }, auth.organizationId, auth.userId, request.params.episodeId, stage, { storyboardIds: request.body?.storyboardIds, regenerate: request.body?.regenerate === true })
      if (!result.ok) return reply.code(result.code).send({ error: result.error })
      return reply.code(result.created ? 201 : 200).send({ batch: await toBatchDto(app.db, result.batchId) })
    },
  )

  // Advances the pipeline one step: triggers the next stage whose prerequisites
  // are met and which has not run yet. This is the "one-click" entry point that
  // lets the pipeline flow instead of re-triggering every stage by hand; the
  // worker relays through the same advancePipeline when a batch completes.
  app.post<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/run-pipeline',
    { preHandler: requirePermission('generation:trigger') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const result = await advancePipeline({ db: app.db, enqueueJob }, auth.organizationId, auth.userId, episode.id)
      if (!result.ok) return reply.code(result.code).send({ error: result.error })
      return reply.code(result.created ? 201 : 200).send({ stage: result.stage, batch: await toBatchDto(app.db, result.batchId) })
    },
  )

  app.get<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/generations',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const batches = await app.db.generationBatch.findMany({
        where: { episodeId: episode.id },
        include: { tasks: { include: { artifacts: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
        // Neither GenerationBatch nor Composition carries a createdAt column;
        // cuid ids sort chronologically.
        orderBy: { id: 'desc' },
      })
      const composition = await app.db.composition.findFirst({ where: { episodeId: episode.id }, orderBy: { id: 'desc' } })
      return {
        batches: await toBatchDtos(app.db, batches),
        composition: composition ? await toCompositionDto(app.db, composition) : null,
      }
    },
  )

  app.post<{ Params: { taskId: string } }>(
    '/generations/tasks/:taskId/cancel',
    { preHandler: requirePermission('generation:trigger') },
    async (request, reply) => {
      const auth = request.auth!
      const task = await app.db.generationTask.findFirst({ where: { id: request.params.taskId, organizationId: auth.organizationId }, include: { artifacts: true } })
      if (!task) return reply.code(404).send({ error: 'task not found' })
      if (task.status !== 'QUEUED') return reply.code(409).send({ error: 'only queued tasks can be cancelled' })
      const cancelled = await app.db.generationTask.update({ where: { id: task.id }, data: { status: 'CANCELLED' }, include: { artifacts: true } })
      await syncBatchStatus(app.db, cancelled.batchId)
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'generation.cancel', entityType: 'generation-task', entityId: cancelled.id, payload: { batchId: cancelled.batchId, stage: toApiStage(cancelled.stage) } })
      const [dto] = await toTaskDtos(app.db, [cancelled])
      return { task: dto }
    },
  )

  app.post<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/compositions',
    { preHandler: requirePermission('generation:trigger') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({
        where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } },
        include: { storyboards: { orderBy: { number: 'asc' }, select: { id: true } } },
      })
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const composition = await app.db.composition.create({
        data: {
          episodeId: episode.id,
          status: 'RUNNING',
          manifest: JSON.stringify({ storyboardIds: episode.storyboards.map(storyboard => storyboard.id) }),
        },
      })
      await enqueue(pipeline(), { kind: 'compose-episode', compositionId: composition.id, episodeId: episode.id, organizationId: auth.organizationId })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'composition.trigger', entityType: 'composition', entityId: composition.id, payload: { storyboards: episode.storyboards.length } })
      return reply.code(201).send({ composition: await toCompositionDto(app.db, composition) })
    },
  )
}
