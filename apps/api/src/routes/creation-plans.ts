import type { FastifyInstance } from 'fastify'
import { isGenerationStage, type GenerationStage } from '@studio/domain'
import { buildCreationPlan, planFingerprint, triggerStage, type CreationPlanInput } from '@studio/pipeline'
import { recordAudit } from '../lib/audit.js'
import { pipelineJobs } from '../lib/jobs.js'
import { requirePermission } from '../plugins/auth.js'

/**
 * US-011 制作计划与提交幂等(§14):
 *  POST /episodes/:id/creation-plans —— 固定输入并出指纹/任务量,不落库不花钱;
 *  POST /episodes/:id/production-runs —— 提交:指纹比对(漂移 409)+ Idempotency-Key
 *  隔离重发(同键同参=复用结果,同键异参=冲突),执行复用 triggerStage 原路径。
 * 计划有效性由指纹决定,不设过期时间。
 */
interface PlanBody {
  stage?: unknown
  storyboardIds?: unknown
  promptNote?: unknown
  regenerate?: unknown
  styleId?: unknown
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

/** 幂等执行记录:同键(组织+操作+key)同指纹→复用;同键异参→409。进程内不落库,
 * 由计划指纹的确定性保证——同输入重复提交时 triggerStage 自身按幂等键去重,
 * 这里只需要挡住「键一样、参数变了」的误用。 */
const runsByKey = new Map<string, { fingerprint: string; batchId: string }>()

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
      const targetCount = ['IMAGE', 'VIDEO', 'AUDIO'].includes(parsed.input.stage)
        ? (parsed.input.storyboardIds ?? episode.storyboards.map(shot => shot.id)).length
        : 1
      const plan = buildCreationPlan(auth.organizationId, parsed.input, targetCount)
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
      const current = planFingerprint(auth.organizationId, parsed.input)
      if (fingerprint !== current) {
        return reply.code(409).send({ code: 'version_conflict', message: '计划输入已变化——重新生成计划后提交', retryable: false, billingRisk: 'none' })
      }

      const idempotencyKey = request.headers['idempotency-key']
      const runKey = typeof idempotencyKey === 'string' && idempotencyKey !== '' ? `${auth.organizationId}:run:${idempotencyKey}` : null
      if (runKey !== null) {
        const prior = runsByKey.get(runKey)
        if (prior) {
          if (prior.fingerprint !== current) {
            return reply.code(409).send({ code: 'invalid_argument', message: '同幂等键不能携带不同参数', retryable: false, billingRisk: 'none' })
          }
          return reply.code(200).send({ batchId: prior.batchId, idempotentReplay: true })
        }
      }

      const result = await triggerStage({ db: app.db, enqueueJob }, auth.organizationId, auth.userId, episode.id, parsed.input.stage, {
        ...(parsed.input.storyboardIds !== undefined ? { storyboardIds: parsed.input.storyboardIds } : {}),
        ...(parsed.input.promptNote !== undefined ? { promptNote: parsed.input.promptNote } : {}),
        ...(parsed.input.regenerate ? { regenerate: true } : {}),
        ...(parsed.input.styleId !== undefined ? { styleId: parsed.input.styleId } : {}),
      })
      if (!result.ok) return reply.code(result.code ?? 409).send({ error: result.error, reasons: 'reasons' in result ? (result as { reasons: string[] }).reasons : undefined })

      if (runKey !== null) runsByKey.set(runKey, { fingerprint: current, batchId: result.batchId })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'generation.run', entityType: 'GenerationBatch', entityId: result.batchId, payload: { stage: parsed.input.stage, fingerprint: current, idempotencyKey: runKey } })
      return reply.code(201).send({ batchId: result.batchId, idempotentReplay: false })
    },
  )
}
