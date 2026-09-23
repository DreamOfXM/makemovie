import type { FastifyInstance } from 'fastify'
import type { Composition, GenerationBatch, GenerationTask, MediaArtifact, PrismaClient, QualityCheck, TaskStatus, WorkflowStatus } from '@studio/db'
import { syncBatchStatus } from '@studio/db'
import { COMPOSITION_STEP, advancePipeline, buildGenerationPlan, createComposition, generationStages, isGenerationStage, liveStoryboards, toApiStage, triggerStage, type GenerationStage } from '@studio/pipeline'
import { recordAudit } from '../lib/audit.js'
import { pipelineJobs } from '../lib/jobs.js'
import { requirePermission } from '../plugins/auth.js'
import { toArtifactDto, type ArtifactDto } from './artifacts.js'

interface QcDto {
  kind: string
  /** Null when the checker could not judge the artifact — not a zero, which would read as a failed audit. */
  score: number | null
  status: WorkflowStatus
}

/** 为什么重抽:成功任务的 responseSnapshot 里留着候选被否的名单和参考图降级原因。
 * 这些字符串来自供应商与质检,原文保留,不翻译——它们是要贴进工单的证据。 */
interface RetryTraceDto {
  attempt: number | null
  candidateErrors: string[]
  reference: { model: string; conditioned: boolean; reason?: string }[]
}

function parseRetryTrace(snapshot: string | null): RetryTraceDto | null {
  if (!snapshot) return null
  try {
    const parsed = JSON.parse(snapshot) as { attempt?: unknown; candidateErrors?: unknown; reference?: unknown }
    const candidateErrors = Array.isArray(parsed.candidateErrors)
      ? parsed.candidateErrors.slice(0, 10).map(entry => String(entry).slice(0, 400))
      : []
    const reference = Array.isArray(parsed.reference)
      ? parsed.reference.flatMap((entry): RetryTraceDto['reference'] => {
          const value = entry as { model?: unknown; conditioned?: unknown; reason?: unknown }
          if (typeof value?.model !== 'string' || typeof value.conditioned !== 'boolean') return []
          return [{ model: value.model, conditioned: value.conditioned, ...(typeof value.reason === 'string' ? { reason: value.reason.slice(0, 400) } : {}) }]
        })
      : []
    if (candidateErrors.length === 0 && reference.length === 0) return null
    return { attempt: typeof parsed.attempt === 'number' ? parsed.attempt : null, candidateErrors, reference }
  } catch {
    return null
  }
}

interface TaskDto {
  id: string
  stage: GenerationStage
  /** The shot this task made, null for episode-level work like SCRIPT or the score.
   * Without it a batch that covered three shots renders as three rows none of which
   * says which shot it is, and the console can only guess from the thumbnail. */
  storyboardId: string | null
  status: TaskStatus
  attempts: number
  provider: string | null
  model: string | null
  error: string | null
  createdAt: Date
  updatedAt: Date
  artifacts: ArtifactDto[]
  qc: QcDto | null
  retryTrace: RetryTraceDto | null
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
  subtitle: ArtifactDto | null
  /** The music bed actually mixed into this master, through the composition's own
   * lineage rather than "the newest score", so it cannot drift after a regenerate. */
  score: ArtifactDto | null
}

type TaskRow = GenerationTask & { mediaArtifacts: MediaArtifact[] }
type BatchRow = GenerationBatch & { tasks: TaskRow[] }

interface GenerationBody {
  stage?: string
  storyboardIds?: string[]
  assetIds?: string[]
  promptNote?: string
  regenerate?: boolean
  styleId?: string
}

async function findEpisodeInOrg(db: PrismaClient, episodeId: string, organizationId: string) {
  return db.episode.findFirst({ where: { id: episodeId, project: { organizationId } } })
}

async function latestChecks(db: PrismaClient, tasks: TaskRow[]): Promise<QualityCheck[]> {
  const artifactIds = tasks.flatMap(task => task.mediaArtifacts.map((artifact: MediaArtifact) => artifact.id))
  if (artifactIds.length === 0) return []
  return db.qualityCheck.findMany({ where: { artifactId: { in: artifactIds } }, orderBy: { id: 'desc' } })
}

function toTaskDto(task: TaskRow, checks: QualityCheck[]): TaskDto {
  const artifactIds = new Set(task.mediaArtifacts.map((artifact: MediaArtifact) => artifact.id))
  const check = checks.find(candidate => candidate.artifactId !== null && artifactIds.has(candidate.artifactId))
  return {
    id: task.id,
    stage: toApiStage(task.stage),
    storyboardId: task.storyboardId,
    status: task.status,
    attempts: task.attempts,
    provider: task.provider,
    model: task.model,
    error: task.errorSnapshot,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    artifacts: task.mediaArtifacts.map(toArtifactDto),
    qc: check ? { kind: check.kind, score: check.score, status: check.status } : null,
    retryTrace: parseRetryTrace(task.responseSnapshot),
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
    include: { tasks: { include: { mediaArtifacts: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  })
  const [dto] = await toBatchDtos(db, [batch])
  return dto
}

async function toCompositionDto(db: PrismaClient, composition: Composition): Promise<CompositionDto> {
  const [artifact, subtitle, score] = await Promise.all([
    composition.artifactId ? db.mediaArtifact.findUnique({ where: { id: composition.artifactId } }) : null,
    composition.subtitleArtifactId ? db.mediaArtifact.findUnique({ where: { id: composition.subtitleArtifactId } }) : null,
    composition.scoreArtifactId ? db.mediaArtifact.findUnique({ where: { id: composition.scoreArtifactId } }) : null,
  ])
  return {
    id: composition.id,
    status: composition.status,
    artifact: artifact ? toArtifactDto(artifact) : null,
    subtitle: subtitle ? toArtifactDto(subtitle) : null,
    score: score ? toArtifactDto(score) : null,
  }
}

export async function generationRoutes(app: FastifyInstance): Promise<void> {
  const enqueueJob = pipelineJobs(app)

  app.post<{ Params: { episodeId: string }; Body: GenerationBody }>(
    '/episodes/:episodeId/generations',
    { preHandler: requirePermission('generation:trigger') },
    async (request, reply) => {
      const auth = request.auth!
      const stage = request.body?.stage
      if (!isGenerationStage(stage)) return reply.code(400).send({ error: `stage must be one of: ${generationStages.join(', ')}` })
      const result = await triggerStage({ db: app.db, enqueueJob }, auth.organizationId, auth.userId, request.params.episodeId, stage, {
        storyboardIds: request.body?.storyboardIds,
        assetIds: request.body?.assetIds,
        promptNote: request.body?.promptNote?.slice(0, 500),
        regenerate: request.body?.regenerate === true,
        styleId: request.body?.styleId,
      })
      if (!result.ok) return reply.code(result.code).send({ error: result.error, ...(result.reasons ? { reasons: result.reasons } : {}) })
      return reply.code(result.created ? 201 : 200).send({ batch: await toBatchDto(app.db, result.batchId) })
    },
  )

  // 计划预审(只读):批量触发前把账摊开——新烧/重试/已覆盖的镜头各几何、跑哪串
  // 模型、产出多少秒。与 POST 同一套门禁,被拦时返回与触发完全相同的错误码,
  // 所以确认框里承诺的与实际会发生的不会分叉。纯物理量,没有任何钱 shaped 字段。
  app.get<{ Params: { episodeId: string }; Querystring: { stage?: string; regenerate?: string; storyboardIds?: string; assetIds?: string } }>(
    '/episodes/:episodeId/generation-plan',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const stage = request.query.stage
      if (!isGenerationStage(stage)) return reply.code(400).send({ error: `stage must be one of: ${generationStages.join(', ')}` })
      const list = (value: string | undefined) => (value ? value.split(',').filter(Boolean) : undefined)
      const result = await buildGenerationPlan(app.db, auth.organizationId, request.params.episodeId, stage, {
        storyboardIds: list(request.query.storyboardIds),
        assetIds: list(request.query.assetIds),
        regenerate: request.query.regenerate === '1' || request.query.regenerate === 'true',
      })
      if (!result.ok) return reply.code(result.code).send({ error: result.error, ...(result.reasons ? { reasons: result.reasons } : {}) })
      return { plan: result.plan }
    },
  )

  // 执行日志:一个任务从启动到成败的全程打点。没有它,候选为什么被跳过、
  // 质检判了什么,只能翻进程输出——无法追溯。
  app.get<{ Params: { taskId: string } }>(
    '/generations/tasks/:taskId/logs',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const task = await app.db.generationTask.findFirst({
        where: { id: request.params.taskId, organizationId: auth.organizationId },
        select: { id: true },
      })
      if (!task) return reply.code(404).send({ error: 'Task not found' })
      const logs = await app.db.generationLog.findMany({
        where: { taskId: task.id },
        orderBy: { createdAt: 'asc' },
        take: 500,
      })
      return {
        logs: logs.map(log => ({
          id: log.id,
          level: log.level,
          event: log.event,
          message: log.message,
          data: log.data,
          createdAt: log.createdAt,
        })),
      }
    },
  )

  // Advances the pipeline one step: triggers the next stage whose prerequisites are
  // met and which has not run yet, and once every stage has run, composes the
  // episode. This is the "one-click" entry point that lets the pipeline flow instead
  // of re-triggering every stage by hand; the worker relays through the same
  // advancePipeline when a batch completes.
  app.post<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/run-pipeline',
    { preHandler: requirePermission('generation:trigger') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const result = await advancePipeline({ db: app.db, enqueueJob }, auth.organizationId, auth.userId, episode.id)
      if (!result.ok) return reply.code(result.code).send({ error: result.error, ...(result.reasons ? { reasons: result.reasons } : {}) })
      if (result.step === 'composition') {
        const composition = await app.db.composition.findUniqueOrThrow({ where: { id: result.compositionId } })
        return reply.code(201).send({ stage: COMPOSITION_STEP, composition: await toCompositionDto(app.db, composition) })
      }
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
        include: { tasks: { include: { mediaArtifacts: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
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
      const task = await app.db.generationTask.findFirst({ where: { id: request.params.taskId, organizationId: auth.organizationId }, include: { mediaArtifacts: true } })
      if (!task) return reply.code(404).send({ error: 'task not found' })
      if (task.status !== 'QUEUED') return reply.code(409).send({ error: 'only queued tasks can be cancelled' })
      const cancelled = await app.db.generationTask.update({ where: { id: task.id }, data: { status: 'CANCELLED' }, include: { mediaArtifacts: true } })
      await syncBatchStatus(app.db, cancelled.batchId)
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'generation.cancel', entityType: 'generation-task', entityId: cancelled.id, payload: { batchId: cancelled.batchId, stage: toApiStage(cancelled.stage) } })
      const [dto] = await toTaskDtos(app.db, [cancelled])
      return { task: dto }
    },
  )

  // 批量停止:把整批排队中的任务一次性转为 CANCELLED——worker 出队即跳过,不再开烧。
  // 执行中的任务不掐——provider 请求已经发出,那部分次数已经烧掉;批次落定后由
  // rollUp 归位(部分成功 → NEEDS_REVIEW,全停 → CANCELLED),自动推进链随之停住。
  app.post<{ Params: { batchId: string } }>(
    '/generations/batches/:batchId/cancel',
    { preHandler: requirePermission('generation:trigger') },
    async (request, reply) => {
      const auth = request.auth!
      const batch = await app.db.generationBatch.findFirst({
        where: { id: request.params.batchId, organizationId: auth.organizationId },
        select: { id: true, stage: true },
      })
      if (!batch) return reply.code(404).send({ error: 'batch not found' })
      const { count } = await app.db.generationTask.updateMany({
        where: { batchId: batch.id, status: 'QUEUED' },
        data: { status: 'CANCELLED' },
      })
      if (count === 0) return reply.code(409).send({ error: 'no queued tasks in this batch' })
      await syncBatchStatus(app.db, batch.id)
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'generation.cancel', entityType: 'generation-batch', entityId: batch.id, payload: { stage: toApiStage(batch.stage), cancelled: count } })
      return { cancelled: count, batch: await toBatchDto(app.db, batch.id) }
    },
  )

  // A human may compose at any point: the compose worker parks the composition in
  // BLOCKED when a clip is missing, and BLOCKED stays retriggerable. The manifest
  // lists the live shots only — concatenating superseded ones would block forever on
  // clips nobody is going to make.
  app.post<{ Params: { episodeId: string }; Body: { allowAuto?: boolean } }>(
    '/episodes/:episodeId/compositions',
    { preHandler: requirePermission('generation:trigger') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      // 选优门:人按下合成时,多版本镜头必须已钦定——"取最新"只是机器的默认猜测,
      // 不该是人工交付路径的隐性决定。allowAuto 是逃生门,按下即在审计里留名。
      // 自动推进路径不走这条路由,保持旧语义不变。
      const allowAuto = request.body?.allowAuto === true
      if (!allowAuto) {
        const open = await shotsWithOpenSelection(app.db, episode.id)
        if (open.length > 0) {
          return reply.code(409).send({ error: 'composition:selectionOpen', reasons: open.map(shot => `#${shot.number} ${shot.title}`) })
        }
      }
      const storyboards = await liveStoryboards(app.db, episode.id)
      const compositionId = await createComposition({ db: app.db, enqueueJob }, auth.organizationId, episode.id, storyboards.map(storyboard => storyboard.id))
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'composition.trigger', entityType: 'composition', entityId: compositionId, payload: { storyboards: storyboards.length, allowAuto } })
      const composition = await app.db.composition.findUniqueOrThrow({ where: { id: compositionId } })
      return reply.code(201).send({ composition: await toCompositionDto(app.db, composition) })
    },
  )
}

/** Live shots that own two or more succeeded clips and no human pick: the gate's subjects. */
async function shotsWithOpenSelection(db: PrismaClient, episodeId: string): Promise<{ number: number; title: string }[]> {
  const unchosen = await db.storyboard.findMany({
    where: { episodeId, supersededAt: null, selectedVideoArtifactId: null },
    select: { id: true, number: true, title: true },
  })
  if (unchosen.length === 0) return []
  const tasks = await db.generationTask.findMany({
    where: { storyboardId: { in: unchosen.map(shot => shot.id) }, stage: 'VIDEO', status: 'SUCCEEDED' },
    select: { storyboardId: true, _count: { select: { mediaArtifacts: { where: { stage: 'VIDEO' } } } } },
  })
  const clipsPerShot = new Map<string, number>()
  for (const task of tasks) {
    if (!task.storyboardId) continue
    clipsPerShot.set(task.storyboardId, (clipsPerShot.get(task.storyboardId) ?? 0) + task._count.mediaArtifacts)
  }
  return unchosen.filter(shot => (clipsPerShot.get(shot.id) ?? 0) >= 2)
}
