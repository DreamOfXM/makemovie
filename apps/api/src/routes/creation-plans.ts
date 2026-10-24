import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { Prisma } from '@studio/db'
import { isGenerationStage, type GenerationStage } from '@studio/domain'
import { buildCreationPlan, planFingerprint, resolvePlanInputs, triggerStage, type CreationPlanInput } from '@studio/pipeline'
import { recordAudit } from '../lib/audit.js'
import { pipelineJobs } from '../lib/jobs.js'
import { requirePermission } from '../plugins/auth.js'
import { apiError } from '../lib/api-error.js'

/**
 * US-011 制作计划与提交幂等(§14):
 *  POST /episodes/:id/creation-plans —— 固定输入并出指纹/任务量,不落库不花钱;
 *  POST /episodes/:id/production-runs —— 提交:指纹比对(漂移 409)+ Idempotency-Key
 *  隔离重发(同键同参=复用结果,同键异参=冲突),执行复用 triggerStage 原路径。
 * V08:指纹绑定 resolvePlanInputs 的实际输入集(全集/revision 向量/剧本修订)——
 * 计划后加镜头,旧指纹立即失效;幂等键落库(CreationRun)先占位后执行,进程重启/
 * 多实例下重发同键复用同一结果。
 */
interface PlanBody {
  stage?: unknown
  storyboardIds?: unknown
  promptNote?: unknown
  regenerate?: unknown
  styleId?: unknown
  /** 确认整集时长缺口；只是这次执行的许可，不是计划输入，不进指纹。 */
  acceptDurationGap?: unknown
}

function parseInput(episodeId: string, body: PlanBody | undefined): { ok: true; input: CreationPlanInput } | { ok: false; status: number; error: string } {
  const stage = body?.stage
  if (typeof stage !== 'string' || !isGenerationStage(stage)) return { ok: false, status: 400, error: `stage must be one of script, storyboard, asset, image, video, audio, music` }
  const storyboardIds = Array.isArray(body?.storyboardIds) && body.storyboardIds.every((id): id is string => typeof id === 'string') ? body!.storyboardIds as string[] : undefined
  return {
    ok: true,
    input: {
      episodeId,
      stage: stage as GenerationStage,
      storyboardIds,
      promptNote: typeof body?.promptNote === 'string' ? body.promptNote : undefined,
      regenerate: body?.regenerate === true,
      styleId: typeof body?.styleId === 'string' ? body.styleId : undefined,
    },
  }
}

/** 幂等执行记录:CreationRun 表落库(同键同指纹→复用;同键异参→409)。V01 之前
 * 的进程内 Map 覆盖不了重启/并发/多实例——占位必须与执行同寿命。 */


export async function creationPlanRoutes(app: FastifyInstance): Promise<void> {
  const enqueueJob = pipelineJobs(app)

  app.post<{ Params: { episodeId: string }; Body: PlanBody }>(
    '/episodes/:episodeId/creation-plans',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } }, include: { storyboards: { where: { supersededAt: null }, select: { id: true } } } })
      if (!episode) return reply.code(404).send({ error: 'episode not found' })
      const parsed = parseInput(episode.id, request.body)
      if (!parsed.ok) return reply.code(parsed.status).send({ error: parsed.error })
      const resolved = await resolvePlanInputs(app.db, episode.id, parsed.input)
      const targetCount = ['IMAGE', 'VIDEO', 'AUDIO'].includes(parsed.input.stage)
        ? (parsed.input.storyboardIds ?? episode.storyboards.map(shot => shot.id)).length
        : 1
      const plan = buildCreationPlan(auth.organizationId, parsed.input, resolved, targetCount)
      return reply.code(200).send({ plan, estimatedCalls: plan.estimatedTasks, blocked: [] })
    },
  )

  app.post<{ Params: { episodeId: string }; Body: PlanBody & { fingerprint?: unknown } }>(
    '/episodes/:episodeId/production-runs',
    { preHandler: requirePermission('generation:trigger') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } } })
      if (!episode) return reply.code(404).send({ error: 'episode not found' })
      const parsed = parseInput(episode.id, request.body)
      if (!parsed.ok) return reply.code(parsed.status).send({ error: parsed.error })
      const fingerprint = typeof request.body?.fingerprint === 'string' ? request.body.fingerprint : ''
      const idempotencyKey = request.headers['idempotency-key']
      const runKey = typeof idempotencyKey === 'string' && idempotencyKey !== '' ? `${auth.organizationId}:run:${idempotencyKey}` : null
      const inputSnapshot = JSON.stringify(parsed.input)
      const priorRun = runKey ? await app.db.creationRun.findUnique({ where: { requestKey: runKey } }) : null
      if (priorRun) {
        if (priorRun.fingerprint !== fingerprint || priorRun.episodeId !== episode.id || priorRun.stage !== parsed.input.stage || (priorRun.inputSnapshot !== null && priorRun.inputSnapshot !== inputSnapshot)) {
          return reply.code(409).send(apiError('invalid_argument', '同幂等键不能携带不同参数', { nextAction: 'use_a_new_key', billingRisk: 'none' }).body)
        }
        if (priorRun.batchId && priorRun.inputSnapshot !== null) return reply.code(200).send({ batchId: priorRun.batchId, idempotentReplay: true })
      }
      const resolved = await resolvePlanInputs(app.db, episode.id, parsed.input)
      const current = planFingerprint(auth.organizationId, parsed.input, resolved)
      if (fingerprint !== current) {
        const { statusCode, body } = apiError('version_conflict', '计划输入已变化——重新生成计划后提交', { nextAction: 'replan', billingRisk: 'none' })
        return reply.code(statusCode).send(body)
      }

      const runToken = randomUUID()
      // V08 先占位后执行:CreationRun 的 requestKey 唯一约束就是原子占用——并发
      // 第二个同键请求在 create 处失败,只能读到第一个请求的占位/结果。
      if (runKey !== null) {
        let occupied = false
        try {
          await app.db.creationRun.create({
            data: { organizationId: auth.organizationId, requestKey: runKey, episodeId: episode.id, stage: parsed.input.stage, fingerprint: current, inputSnapshot, claimToken: runToken, leaseUntil: new Date(Date.now() + 120_000) },
          })
          occupied = true
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
        }
        if (!occupied) {
          const prior = await app.db.creationRun.findUnique({ where: { requestKey: runKey } })
          if (prior && (prior.fingerprint !== current || (prior.inputSnapshot !== null && prior.inputSnapshot !== inputSnapshot))) {
            const conflict = apiError('invalid_argument', '同幂等键不能携带不同参数', { nextAction: 'use_a_new_key', billingRisk: 'none' })
            return reply.code(409).send(conflict.body)
          }
          if (prior?.batchId) return reply.code(200).send({ batchId: prior.batchId, idempotentReplay: true })
          // 占位存在但结果未回填:同键的第一个请求仍在执行(或执行中崩溃)。
          const reclaimed = await app.db.creationRun.updateMany({
            where: { requestKey: runKey, batchId: null, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
            data: { claimToken: runToken, leaseUntil: new Date(Date.now() + 120_000) },
          })
          if (reclaimed.count !== 1) return reply.code(200).send({ batchId: null, idempotentReplay: true, pending: true })
        }
      }

      const result = await triggerStage({ db: app.db, enqueueJob }, auth.organizationId, auth.userId, episode.id, parsed.input.stage, {
        ...(runKey ? { runClaim: { requestKey: runKey, token: runToken } } : {}),
        ...(parsed.input.storyboardIds !== undefined ? { storyboardIds: parsed.input.storyboardIds } : {}),
        ...(parsed.input.promptNote !== undefined ? { promptNote: parsed.input.promptNote } : {}),
        ...(parsed.input.regenerate ? { regenerate: true } : {}),
        ...(parsed.input.styleId !== undefined ? { styleId: parsed.input.styleId } : {}),
        // 缺口确认只影响这次执行，不进 inputSnapshot/指纹：同键重发不该因为
        // 勾没勾这一下被判成「同键异参」。
        ...(request.body?.acceptDurationGap === true ? { acceptDurationGap: true } : {}),
      })
      if (!result.ok) {
        // 执行被拒(无候选/门槛拦下):占位作废,同键重试必须能重新执行。
        if (runKey !== null) await app.db.creationRun.delete({ where: { requestKey: runKey, claimToken: runToken } }).catch(() => undefined)
        // §14/US-035 预扣账拒绝:组织在途调用已达上限。统一封套透传——计费无风险
        // (整批未开烧),重试有效,动作是等在途落定或提升上限。
        if (result.error === 'pipeline:inFlightBudget') {
          const { body } = apiError('pipeline:inFlightBudget', '组织在途供应商调用已达上限——等待在途调用落定或提升上限后再触发', { nextAction: 'wait_or_raise_limit', billingRisk: 'none', retryable: true })
          return reply.code(429).send({ ...body, reasons: result.reasons })
        }
        return reply.code(result.code ?? 409).send({ error: result.error, reasons: 'reasons' in result ? (result as { reasons: string[] }).reasons : undefined })
      }

      if (runKey !== null) {
        await app.db.creationRun.update({ where: { requestKey: runKey }, data: { batchId: result.batchId } }).catch(() => undefined)
      }
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'plan_confirmed', entityType: 'GenerationBatch', entityId: result.batchId, payload: { stage: parsed.input.stage, fingerprint: current } })
      return reply.code(201).send({ batchId: result.batchId, idempotentReplay: false })
    },
  )
  // US-012 批量入口:GET 返回本集所有镜头的就绪状态(哪些有素材/有视频/可跑)。
  app.get<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/generation-readiness',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } } })
      if (!episode) return reply.code(404).send({ error: 'episode not found' })
      const storyboards = await app.db.storyboard.findMany({
        where: { episodeId: episode.id, supersededAt: null },
        orderBy: { number: 'asc' },
        select: {
          id: true, number: true, title: true, durationMs: true,
          _count: { select: { assets: true, generationTasks: { where: { status: 'SUCCEEDED', stage: 'VIDEO' } } } },
        },
      })
      return {
        shots: storyboards.map(shot => ({
          id: shot.id, number: shot.number, title: shot.title,
          hasAssets: shot._count.assets > 0,
          hasVideo: shot._count.generationTasks > 0,
          ready: shot._count.assets > 0,
        })),
        summary: {
          total: storyboards.length,
          withVideo: storyboards.filter(s => s._count.generationTasks > 0).length,
          withAssets: storyboards.filter(s => s._count.assets > 0).length,
        },
      }
    },
  )

}
