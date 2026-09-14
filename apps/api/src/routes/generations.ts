import type { FastifyInstance } from 'fastify'
import type { Composition, GenerationBatch, GenerationTask, MediaArtifact, PrismaClient, QualityCheck, SlotCandidate, Stage, TaskStatus, WorkflowStatus } from '@studio/db'
import { nextRunnableStage, resolveSlotCandidates, syncBatchStatus } from '@studio/db'
import type { CapabilitySlot } from '@studio/domain'
import { createPipelineQueue, enqueue, type RunTaskCandidate } from '@studio/jobs'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'
import { toArtifactDto, type ArtifactDto } from './artifacts.js'

type PipelineQueue = ReturnType<typeof createPipelineQueue>

const generationStages = ['SCRIPT', 'ASSET', 'STORYBOARD', 'IMAGE', 'VIDEO', 'AUDIO'] as const
type GenerationStage = (typeof generationStages)[number]

const stageSlots: Record<GenerationStage, CapabilitySlot> = {
  SCRIPT: 'script_text',
  ASSET: 'image_gen',
  STORYBOARD: 'storyboard_text',
  IMAGE: 'image_gen',
  VIDEO: 'video_t2v',
  AUDIO: 'tts_voice',
}

// Storyboard imagery is modelled as FIRST_FRAME in the schema; the pipeline API
// and the console both call that stage IMAGE.
const stageDbValues: Record<GenerationStage, Stage> = {
  SCRIPT: 'SCRIPT',
  ASSET: 'ASSET',
  STORYBOARD: 'STORYBOARD',
  IMAGE: 'FIRST_FRAME',
  VIDEO: 'VIDEO',
  AUDIO: 'AUDIO',
}

const apiStageByDbStage: Partial<Record<Stage, GenerationStage>> = { FIRST_FRAME: 'IMAGE' }

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
}

interface GenerationTarget {
  entityId: string
  prompt: string
  assetId?: string
  scriptVersionId?: string
}

function isGenerationStage(value: unknown): value is GenerationStage {
  return (generationStages as readonly string[]).includes(value as string)
}

function toApiStage(stage: Stage): GenerationStage {
  return apiStageByDbStage[stage] ?? (stage as GenerationStage)
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
}

async function findEpisodeInOrg(db: PrismaClient, episodeId: string, organizationId: string) {
  return db.episode.findFirst({ where: { id: episodeId, project: { organizationId } } })
}

// A resolved candidate also carries what the console needs to explain the
// ordering; the queued job only needs enough to open a provider.
function toRunTaskCandidate(candidate: SlotCandidate): RunTaskCandidate {
  return {
    connectionId: candidate.connectionId,
    capabilityId: candidate.capabilityId,
    provider: candidate.provider,
    model: candidate.model,
  }
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

  type TriggerResult = { ok: true; batchId: string; created: boolean } | { ok: false; code: number; error: string }

  async function triggerStage(
    organizationId: string,
    userId: string | null,
    episodeId: string,
    stage: GenerationStage,
    requestedStoryboardIds?: string[],
  ): Promise<TriggerResult> {
    const episode = await app.db.episode.findFirst({
      where: { id: episodeId, project: { organizationId } },
      include: { storyboards: { orderBy: { number: 'asc' } }, assets: { orderBy: { id: 'asc' } } },
    })
    if (!episode) return { ok: false, code: 404, error: 'Episode not found' }

    const perStoryboard = stage === 'IMAGE' || stage === 'VIDEO'
    const perAsset = stage === 'ASSET'
    const selected = perStoryboard
      ? requestedStoryboardIds
        ? episode.storyboards.filter(storyboard => requestedStoryboardIds.includes(storyboard.id))
        : episode.storyboards
      : []
    if (perStoryboard) {
      if (requestedStoryboardIds && selected.length !== new Set(requestedStoryboardIds).size) return { ok: false, code: 400, error: 'storyboardIds must belong to this episode' }
      if (selected.length === 0) return { ok: false, code: 400, error: 'episode has no storyboards to generate' }
    }
    if (perAsset && episode.assets.length === 0) return { ok: false, code: 400, error: 'episode has no assets to generate' }

    // AI content stages need real context, not just the episode title, and are
    // gated on the upstream version being approved — a script is written from an
    // approved source, and storyboards are broken out of an approved script.
    let scriptVersionId: string | undefined
    let contentPrompt: string | undefined
    if (stage === 'SCRIPT') {
      const source = await app.db.sourceDocumentVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, orderBy: { version: 'desc' } })
      if (!source) return { ok: false, code: 409, error: 'generations:noApprovedSource' }
      contentPrompt = `根据以下源文档，写出这一集的完整拍摄剧本：\n\n${source.content}`
    }
    if (stage === 'STORYBOARD') {
      const script = await app.db.scriptVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, orderBy: { version: 'desc' } })
      if (!script) return { ok: false, code: 409, error: 'generations:noApprovedScript' }
      scriptVersionId = script.id
      contentPrompt = `把以下剧本拆分成连续的分镜镜头，输出一个 JSON 数组，每个元素包含 number、title、description、sourceExcerpt、durationMs（毫秒）、continuityIn、continuityOut。只输出 JSON，不要其它说明。\n\n剧本：\n${script.content}`
    }

    const targets: GenerationTarget[] = perAsset
      ? episode.assets.map(asset => ({ entityId: asset.id, prompt: `${asset.kind} ${asset.name}: ${asset.description}`, assetId: asset.id }))
      : perStoryboard
        ? selected.map(storyboard => ({ entityId: storyboard.id, prompt: `${storyboard.title}: ${storyboard.description}` }))
        : [{ entityId: episode.id, prompt: contentPrompt ?? episode.title, ...(scriptVersionId ? { scriptVersionId } : {}) }]

    const slot = stageSlots[stage]
    const candidates = await resolveSlotCandidates(app.db, organizationId, episode.projectId, slot)
    if (candidates.length === 0) return { ok: false, code: 409, error: `no verified candidates for slot ${slot}` }

    const dbStage = stageDbValues[stage]
    const idempotencyKeys = targets.map(target => `${episode.id}:${stage}:${target.entityId}`)
    try {
      const batch = await app.db.generationBatch.create({
        data: {
          organizationId,
          episodeId: episode.id,
          stage: dbStage,
          plannedCount: targets.length,
          // The composition worker walks batch → storyboards to find each clip.
          storyboards: { connect: selected.map(storyboard => ({ id: storyboard.id })) },
          tasks: {
            create: targets.map((target, index) => ({
              organizationId,
              stage: dbStage,
              idempotencyKey: idempotencyKeys[index],
              // ProviderRequest payload; model and parameters belong to whichever
              // candidate ends up running, so the worker fills them in.
              requestSnapshot: JSON.stringify({ input: { prompt: target.prompt }, ...(target.assetId ? { assetId: target.assetId } : {}), ...(target.scriptVersionId ? { scriptVersionId: target.scriptVersionId } : {}) }),
            })),
          },
        },
        include: { tasks: true },
      })
      // Queued tasks roll the batch up to RUNNING; without this the batch would
      // read DRAFT until the worker happened to pick the first task up.
      await syncBatchStatus(app.db, batch.id)
      for (const task of batch.tasks) {
        await enqueue(pipeline(), { kind: 'run-task', taskId: task.id, organizationId, attempt: 1, candidates: candidates.map(toRunTaskCandidate) })
      }
      await recordAudit(app.db, { organizationId, userId, action: 'generation.trigger', entityType: 'generation-batch', entityId: batch.id, payload: { stage, plannedCount: batch.plannedCount } })
      return { ok: true, batchId: batch.id, created: true }
    } catch (error) {
      if (!isPrismaUniqueViolation(error)) throw error
      const existing = await app.db.generationTask.findFirst({ where: { organizationId, idempotencyKey: { in: idempotencyKeys } } })
      if (!existing) throw error
      return { ok: true, batchId: existing.batchId, created: false }
    }
  }

  app.post<{ Params: { episodeId: string }; Body: GenerationBody }>(
    '/episodes/:episodeId/generations',
    { preHandler: requirePermission('generation:trigger') },
    async (request, reply) => {
      const auth = request.auth!
      const stage = request.body?.stage
      if (!isGenerationStage(stage)) return reply.code(400).send({ error: `stage must be one of: ${generationStages.join(', ')}` })
      const result = await triggerStage(auth.organizationId, auth.userId, request.params.episodeId, stage, request.body?.storyboardIds)
      if (!result.ok) return reply.code(result.code).send({ error: result.error })
      return reply.code(result.created ? 201 : 200).send({ batch: await toBatchDto(app.db, result.batchId) })
    },
  )

  // Advances the pipeline one step: triggers the next stage whose prerequisites
  // are met and which has not run yet. This is the "one-click" entry point that
  // lets the pipeline flow instead of re-triggering every stage by hand.
  app.post<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/run-pipeline',
    { preHandler: requirePermission('generation:trigger') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const stage = await nextRunnableStage(app.db, episode.id)
      if (!stage) return reply.code(409).send({ error: 'pipeline:nothingRunnable' })
      const result = await triggerStage(auth.organizationId, auth.userId, episode.id, stage)
      if (!result.ok) return reply.code(result.code).send({ error: result.error })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'pipeline.advance', entityType: 'episode', entityId: episode.id, payload: { stage } })
      return reply.code(result.created ? 201 : 200).send({ stage, batch: await toBatchDto(app.db, result.batchId) })
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
