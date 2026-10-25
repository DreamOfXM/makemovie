import type { FastifyInstance } from 'fastify'
import type { Composition, GenerationBatch, GenerationTask, MediaArtifact, PrismaClient, QualityCheck, TaskStatus, WorkflowStatus } from '@studio/db'
import { syncBatchStatus } from '@studio/db'
import { COMPOSITION_STEP, QC_THRESHOLD, advancePipeline, buildGenerationPlan, createComposition, episodeRetryBudget, generationStages, isGenerationStage, liveStoryboards, parseGenerationReview, recordAssetVersion, toApiStage, triggerStage, type GenerationReviewSnapshot, type GenerationStage } from '@studio/pipeline'
import { classifyComposeBlock, type ComposeBlockKind } from '@studio/domain'
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

/** 豁免落版本时补上这次请求的提示词:快照由本服务提交时写入,解析失败不阻断豁免。 */
function promptFromSnapshot(snapshot: string | null): string {
  if (!snapshot) return ''
  try {
    const parsed = JSON.parse(snapshot) as { input?: { prompt?: unknown } }
    return typeof parsed.input?.prompt === 'string' ? parsed.input.prompt : ''
  } catch {
    return ''
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
  /** SD-082：用户起的连接名。任务行只存厂商，连接身份留在提交台账上；没有台账
   *  （还没提交过 / 连接已删）时为 null，界面退回报厂商。 */
  connectionName: string | null
  model: string | null
  error: string | null
  createdAt: Date
  updatedAt: Date
  artifacts: ArtifactDto[]
  qc: QcDto | null
  /** 每次尝试的质检分，最新在前。一镜重抽三次就有三份被评过的产物，
   *  而最后一次不是最高那次 —— 历史栏写「最高分」只能靠这个全量列表。 */
  scores: number[]
  retryTrace: RetryTraceDto | null
  /** 「先问」的当前状态：pending = 任务停下等人决定；retried / waived = 已裁决，保留原因与计数。 */
  review: GenerationReviewSnapshot | null
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
  /** SD-177：这一轮合成为什么停在「已阻塞」。kind 是界面说人话的键，detail 是
   * worker 原文（只进 Tooltip/展开行，不进正文）。 */
  block: { kind: ComposeBlockKind; detail: string } | null
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
  /** 人已看过整集时长缺口并确认继续；没有它就拒绝整集视频触发。 */
  acceptDurationGap?: boolean
  /** 超长镜的逐镜决议：同镜拼接或换模型。拆成两镜要先改分镜，不在生成里执行。 */
  durationDecisions?: Array<{ storyboardId: string; strategy: 'splice' | 'split' | 'switch_model'; capabilityId?: string }>
}

const DURATION_STRATEGIES = ['splice', 'split', 'switch_model'] as const

/** 解析并拒绝整条决议里的任何一条坏数据，而不是悄悄丢掉它。 */
function parseDurationDecisions(value: unknown): GenerationBody['durationDecisions'] | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  const parsed: NonNullable<GenerationBody['durationDecisions']> = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null
    const row = entry as { storyboardId?: unknown; strategy?: unknown; capabilityId?: unknown }
    if (typeof row.storyboardId !== 'string' || row.storyboardId === '') return null
    if (typeof row.strategy !== 'string' || !DURATION_STRATEGIES.includes(row.strategy as typeof DURATION_STRATEGIES[number])) return null
    if (row.capabilityId !== undefined && typeof row.capabilityId !== 'string') return null
    parsed.push({ storyboardId: row.storyboardId, strategy: row.strategy as typeof DURATION_STRATEGIES[number], ...(row.capabilityId ? { capabilityId: row.capabilityId } : {}) })
  }
  return parsed
}

async function findEpisodeInOrg(db: PrismaClient, episodeId: string, organizationId: string) {
  return db.episode.findFirst({ where: { id: episodeId, project: { organizationId } } })
}

async function latestChecks(db: PrismaClient, tasks: TaskRow[]): Promise<QualityCheck[]> {
  const artifactIds = tasks.flatMap(task => task.mediaArtifacts.map((artifact: MediaArtifact) => artifact.id))
  if (artifactIds.length === 0) return []
  return db.qualityCheck.findMany({ where: { artifactId: { in: artifactIds } }, orderBy: { id: 'desc' } })
}

/**
 * SD-082：每个任务最后一次提交所用的连接名。任务行只记厂商，连接身份在提交台账上
 * （`SubmissionAttempt.connectionId`，无外键），所以按任务取最新一条再回表查名字。
 * 连接删掉后台账行还在——查不到名字就报 null，界面退回厂商，不编一个名字。
 */
async function latestConnectionNames(db: PrismaClient, tasks: TaskRow[]): Promise<Map<string, string>> {
  if (tasks.length === 0) return new Map()
  const attempts = await db.submissionAttempt.findMany({
    where: { taskId: { in: tasks.map(task => task.id) }, connectionId: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { taskId: true, connectionId: true },
  })
  const connectionByTask = new Map<string, string>()
  for (const attempt of attempts) {
    if (!attempt.taskId || !attempt.connectionId || connectionByTask.has(attempt.taskId)) continue
    connectionByTask.set(attempt.taskId, attempt.connectionId)
  }
  if (connectionByTask.size === 0) return new Map()
  const connections = await db.providerConnection.findMany({
    where: { id: { in: [...new Set(connectionByTask.values())] } },
    select: { id: true, name: true },
  })
  const nameById = new Map(connections.map(connection => [connection.id, connection.name]))
  const names = new Map<string, string>()
  for (const [taskId, connectionId] of connectionByTask) {
    const name = nameById.get(connectionId)
    if (name) names.set(taskId, name)
  }
  return names
}

function toTaskDto(task: TaskRow, checks: QualityCheck[], connectionName: string | null): TaskDto {
  const artifactIds = new Set(task.mediaArtifacts.map((artifact: MediaArtifact) => artifact.id))
  const own = checks.filter(candidate => candidate.artifactId !== null && artifactIds.has(candidate.artifactId))
  const [newest] = own
  return {
    id: task.id,
    stage: toApiStage(task.stage),
    storyboardId: task.storyboardId,
    status: task.status,
    attempts: task.attempts,
    provider: task.provider,
    connectionName,
    model: task.model,
    error: task.errorSnapshot,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    artifacts: task.mediaArtifacts.map(toArtifactDto),
    qc: newest ? { kind: newest.kind, score: newest.score, status: newest.status } : null,
    scores: own.flatMap(check => (check.score === null ? [] : [check.score])),
    retryTrace: parseRetryTrace(task.responseSnapshot),
    review: parseGenerationReview(task.reviewSnapshot),
  }
}

async function toTaskDtos(db: PrismaClient, tasks: TaskRow[]): Promise<TaskDto[]> {
  const [checks, connectionNames] = await Promise.all([latestChecks(db, tasks), latestConnectionNames(db, tasks)])
  return tasks.map(task => toTaskDto(task, checks, connectionNames.get(task.id) ?? null))
}

async function toBatchDtos(db: PrismaClient, batches: BatchRow[]): Promise<BatchDto[]> {
  const tasks = batches.flatMap(batch => batch.tasks)
  const [checks, connectionNames] = await Promise.all([latestChecks(db, tasks), latestConnectionNames(db, tasks)])
  return batches.map(batch => ({
    id: batch.id,
    stage: toApiStage(batch.stage),
    status: batch.status,
    plannedCount: batch.plannedCount,
    // GenerationBatch has no timestamp columns; the batch and its tasks are
    // written together, so the first task stamps the batch.
    createdAt: batch.tasks[0]?.createdAt ?? new Date(0),
    tasks: batch.tasks.map(task => toTaskDto(task, checks, connectionNames.get(task.id) ?? null)),
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
    block: composition.status === 'BLOCKED' && composition.errorSnapshot
      ? { kind: classifyComposeBlock(composition.errorSnapshot), detail: composition.errorSnapshot }
      : null,
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
      const durationDecisions = parseDurationDecisions(request.body?.durationDecisions)
      if (durationDecisions === null) return reply.code(400).send({ error: 'durationDecisions is malformed' })
      // SD-175：时长缺口确认门过去只认「没有 storyboardIds」的整集触发，逐镜那一击
      // 因此在零提示下把钱花在更短/更低分辨率的一档上（实测四镜重拍后掉到 720P / 5.37 s，
      // 本集从此混了两种分辨率）。triggerStage 里那条 `!options.storyboardIds` 不在本
      // agent 的可改范围内，这里用与它同源的只读预审把契约补上：状态码、错误码与
      // reasons 形状逐字一致，界面只需一套确认逻辑，两条路径不会分叉。
      const gapMs = await perShotDurationGap(app.db, auth.organizationId, request.params.episodeId, stage, {
        storyboardIds: request.body?.storyboardIds,
        regenerate: request.body?.regenerate === true,
        acceptDurationGap: request.body?.acceptDurationGap === true,
      })
      if (gapMs !== null) return reply.code(409).send({ error: 'generations:durationGap', reasons: [`${Math.ceil(gapMs / 1000)}s`] })
      const result = await triggerStage({ db: app.db, enqueueJob }, auth.organizationId, auth.userId, request.params.episodeId, stage, {
        storyboardIds: request.body?.storyboardIds,
        assetIds: request.body?.assetIds,
        promptNote: request.body?.promptNote?.slice(0, 500),
        regenerate: request.body?.regenerate === true,
        styleId: request.body?.styleId,
        acceptDurationGap: request.body?.acceptDurationGap === true,
        durationDecisions,
      })
      if (!result.ok) return reply.code(result.code).send({ error: result.error, ...(result.reasons ? { reasons: result.reasons } : {}) })
      // created/requeued 合起来才是这次点击的全部后果：created:false + requeued:0 才表示
      // 命中已有幂等结果、一笔任务也没排（同键已成功/已阻塞/停在问询）。
      // 只给一个布尔会把「失败任务已按当前绑定重排、正在烧钱」报成「什么都没发生」。
      return reply.code(result.created ? 201 : 200).send({ created: result.created, requeued: result.requeued, batch: await toBatchDto(app.db, result.batchId) })
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
      const episode = await app.db.episode.findFirst({
        where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } },
        include: { project: true },
      })
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const batches = await app.db.generationBatch.findMany({
        where: { episodeId: episode.id },
        include: { tasks: { include: { mediaArtifacts: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
        // Neither GenerationBatch nor Composition carries a createdAt column;
        // cuid ids sort chronologically.
        orderBy: { id: 'desc' },
      })
      const composition = await app.db.composition.findFirst({ where: { episodeId: episode.id }, orderBy: { id: 'desc' } })
      // SD-170：本集重抽额度是活算值（与 worker 同一套 episodeRetryBudget）。
      // 界面要展示「现在用了多少」就只能从这里读；任务快照里那份是那次裁决当时的
      // 用量，把它印成现值就会在不同日子读出互相矛盾的数。
      const retryBudget = await episodeRetryBudget(app.db, episode.id, episode.project)
      return {
        batches: await toBatchDtos(app.db, batches),
        composition: composition ? await toCompositionDto(app.db, composition) : null,
        // 质检线随数据一起下发:界面自己写死一份,worker 一改阈值界面就开始说谎。
        limits: { qcThreshold: QC_THRESHOLD },
        retryBudget,
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

  // 先问的出口：一致性/创作性失败停在「等你决定」后，人在这里选择再买一次或收下。
  // 重抽按快照里原样保存的候选链重排下一 attempt，不受策略/每镜上限/每集额度拦截
  // ——那三样只约束自动重抽，人工决定永远有效。豁免的理由选填：填了同时进任务快照
  // 与审计，没填就只记「谁在什么时候收下了」；两种都要把被豁免产物从待审改为通过，
  // 否则下游（首帧喂 i2v、成片合成）仍会把它当成未过审而拒用，豁免就成了一个只改标签
  // 不改行为的假动作。
  //
  // SD-179｜`rerun` 是「收下之后仍然不想要这一版」的那一刀：收下解锁了合成，却也把这一镜
  // 钉成「已覆盖」——任务不再是 FAILED，重跑入口随之消失，而补跑那条路撞回同一幂等键
  // （界面读成「这一镜已有一笔提交在途或待核对」）。于是收下坏版本＝永久锁死这一镜。
  // 这里给的是出口：对**已经裁决为收下**的那一版再点一次重跑，走 regenerate 的新幂等键，
  // 已settled的收下任务不再被当成在途。与「重跑「视频片段」」同一道缺口确认门，不改写
  // 收下的记录——那一版为什么被收下，仍是履历里的事实。
  app.post<{ Params: { taskId: string }; Body: { action?: string; reason?: string; acceptDurationGap?: boolean } }>(
    '/generations/tasks/:taskId/review',
    { preHandler: requirePermission('generation:trigger') },
    async (request, reply) => {
      const auth = request.auth!
      const action = request.body?.action
      if (action !== 'retry' && action !== 'waive' && action !== 'rerun') {
        return reply.code(400).send({ error: "action must be 'retry', 'waive' or 'rerun'" })
      }
      const reason = request.body?.reason?.trim()

      const task = await app.db.generationTask.findFirst({ where: { id: request.params.taskId, organizationId: auth.organizationId } })
      if (!task) return reply.code(404).send({ error: 'task not found' })
      const review = parseGenerationReview(task.reviewSnapshot)

      if (action === 'rerun') {
        if (!review) return reply.code(409).send({ error: 'task has no review record' })
        if (review.state !== 'waived') return reply.code(409).send({ error: 'rerun is only for a take a human has accepted' })
        if (!task.storyboardId) return reply.code(409).send({ error: 'rerun works on shot-level tasks only' })
        // 付费重跑必须带着人的方向：无方向盲抽是这条产品线的红线（与「调整这一镜」同一要求）。
        if (!reason) return reply.code(400).send({ error: 'rerun:directionRequired' })
        const batch = await app.db.generationBatch.findUnique({ where: { id: task.batchId }, select: { episodeId: true } })
        if (!batch?.episodeId) return reply.code(409).send({ error: 'task has no episode to rerun in' })
        const stage = toApiStage(task.stage)
        // 与 POST /generations 同一道 SD-175 缺口门：同一个理由、同一个状态码，两条路不分叉。
        const gapMs = await perShotDurationGap(app.db, auth.organizationId, batch.episodeId, stage, {
          storyboardIds: [task.storyboardId],
          regenerate: true,
          acceptDurationGap: request.body?.acceptDurationGap === true,
        })
        if (gapMs !== null) return reply.code(409).send({ error: 'generations:durationGap', reasons: [`${Math.ceil(gapMs / 1000)}s`] })
        const result = await triggerStage({ db: app.db, enqueueJob }, auth.organizationId, auth.userId, batch.episodeId, stage, {
          storyboardIds: [task.storyboardId],
          regenerate: true,
          promptNote: reason.slice(0, 500),
          acceptDurationGap: request.body?.acceptDurationGap === true,
        })
        if (!result.ok) return reply.code(result.code).send({ error: result.error, ...(result.reasons ? { reasons: result.reasons } : {}) })
        await recordAudit(app.db, {
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: 'generation.rerunAfterWaive',
          entityType: 'generation-task',
          entityId: task.id,
          payload: { batchId: result.batchId, stage, storyboardId: task.storyboardId, reason: reason.slice(0, 500) },
        })
        // created:false 只会发生在幂等命中上；对一条已settled的收下任务，这一击必然开新批次，
        // 界面仍按同一段代码区分「已排队」与「什么都没发生」，不谎报。
        return reply.code(result.created ? 201 : 200).send({ created: result.created, requeued: result.requeued, batch: await toBatchDto(app.db, result.batchId) })
      }

      if (!review) return reply.code(409).send({ error: 'task has no pending review' })
      if (review.state !== 'pending') return reply.code(409).send({ error: 'review already decided' })
      if (task.status !== 'FAILED') return reply.code(409).send({ error: 'only failed tasks can be reviewed' })
      if (action === 'waive' && !review.artifactId) return reply.code(409).send({ error: 'nothing to waive: the task produced no judged artifact' })
      if (action === 'retry' && review.candidates.length === 0) return reply.code(409).send({ error: 'review snapshot carries no candidate chain to retry' })

      const decided: GenerationReviewSnapshot = {
        ...review,
        state: action === 'retry' ? 'retried' : 'waived',
        decidedAt: new Date().toISOString(),
        decidedBy: auth.userId,
        ...(action === 'waive' && reason ? { waiveReason: reason.slice(0, 500) } : {}),
      }
      // CAS 在 reviewSnapshot 原文上：两个人同时点，只有一个能把 pending 改写成功。
      const applied = await app.db.$transaction(async tx => {
        const written = await tx.generationTask.updateMany({
          where: { id: task.id, status: 'FAILED', reviewSnapshot: task.reviewSnapshot },
          data: {
            status: action === 'retry' ? 'QUEUED' : 'SUCCEEDED',
            errorSnapshot: null,
            reviewSnapshot: JSON.stringify(decided),
          },
        })
        if (written.count !== 1) return false
        if (action === 'waive' && review.artifactId) {
          await tx.qualityCheck.updateMany({ where: { artifactId: review.artifactId, status: 'NEEDS_REVIEW' }, data: { status: 'APPROVED' } })
          // 被豁免的产物就是这一次的交付:不落版本,素材卡会显示「0 版」,下游也找不到
          // 可用图。版本同样记为 DRAFT——豁免只免了重抽,不等于替用户签了「通过」。
          await recordAssetVersion(tx as unknown as PrismaClient, task, review.artifactId, promptFromSnapshot(task.requestSnapshot))
        }
        return true
      })
      if (!applied) return reply.code(409).send({ error: 'review already decided' })

      const attempt = action === 'retry' ? task.attempts + 1 : task.attempts
      if (action === 'retry') {
        await enqueueJob({ kind: 'run-task', taskId: task.id, organizationId: auth.organizationId, attempt, candidates: review.candidates })
      }
      await syncBatchStatus(app.db, task.batchId)
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: action === 'retry' ? 'generation.retry' : 'generation.waive',
        entityType: 'generation-task',
        entityId: task.id,
        payload: { batchId: task.batchId, stage: toApiStage(task.stage), retryClass: review.retryClass, askReason: review.askReason, attempt, ...(reason ? { reason: reason.slice(0, 500) } : {}) },
      })
      const updated = await app.db.generationTask.findUniqueOrThrow({ where: { id: task.id }, include: { mediaArtifacts: true } })
      const [dto] = await toTaskDtos(app.db, [updated])
      return { task: dto }
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

/**
 * SD-175：逐镜重跑（storyboardIds 点名的 VIDEO 触发）要不要先让人确认时长缺口。
 * 台账的口径是「逐镜重跑绕过时长/分辨率缺口门」——绕过的正是「这一镜已经买过一次、
 * 现在按第二次价再买一遍」那条路径：第一次的档已在片里，第二次买到 5 s / 720P 就把
 * 整集从承诺的时长与统一画幅上拽下来，而界面零提示。所以拦的判据是重买，不是首买
 * （首买那一档由整集路径的门负责，逐镜补它会把「修单点」也一起卡死）。
 *
 * 让路给更硬的话：
 * - 预审自身不放行 ⇒ 交回 triggerStage：缺首帧、剧本没批这类「根本跑不起来」的错
 *   必须先上屏，缺口只是最后一道确认。
 * - 这一批里还有超出单次时长上限、等人给决议的镜头 ⇒ 同样让路，触发端会报
 *   generations:shotDurationOverflow / generations:shotNeedsSplit，那是这一镜的真问题。
 * 只读一次计划，不建批次、不排队、不花钱。
 */
async function perShotDurationGap(
  db: PrismaClient,
  organizationId: string,
  episodeId: string,
  stage: GenerationStage,
  options: { storyboardIds?: string[]; regenerate: boolean; acceptDurationGap: boolean },
): Promise<number | null> {
  if (stage !== 'VIDEO') return null
  const storyboardIds = options.storyboardIds
  if (!storyboardIds || storyboardIds.length === 0) return null
  if (options.acceptDurationGap) return null
  // 只有「这一镜已经有一版成功的视频」才算重买：没有成功版本时，这一击是在补片，
  // 不是在把已有的档换掉。
  const alreadyBilled = await db.generationTask.findFirst({
    where: { organizationId, storyboardId: { in: storyboardIds }, stage: 'VIDEO', status: 'SUCCEEDED' },
    select: { id: true },
  })
  if (!alreadyBilled) return null
  const result = await buildGenerationPlan(db, organizationId, episodeId, 'VIDEO', { storyboardIds, regenerate: options.regenerate })
  if (!result.ok) return null
  if (result.plan.durationPreflight.length > 0) return null
  const gapMs = result.plan.durationGapMs ?? 0
  return gapMs > 0 ? gapMs : null
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
