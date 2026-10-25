import type { PrismaClient } from '@studio/db'
import type { RunTaskCandidate } from '@studio/jobs'

/**
 * 重抽三档与「先问」的共享词汇。
 *
 * 判定发生在 worker（它手里有质检结论与任务台账），读取发生在 API（任务 DTO）
 * 与 web（问询面板）。三处必须用同一套枚举与同一份解析，否则「不一致」在界面上
 * 会变成「创作性」，或者一条坏 JSON 直接把批次卡打崩。
 */

export const retryClasses = ['technical', 'consistency', 'creative'] as const
export type RetryClass = (typeof retryClasses)[number]

export const retryPolicies = ['ask', 'auto1', 'auto2'] as const
export type RetryPolicy = (typeof retryPolicies)[number]

export type ReviewState = 'pending' | 'retried' | 'waived'

/** 为什么停在问：策略本身就是先问 / 每镜上限用完 / 每集额度用完。 */
export type AskReason = 'policy' | 'cap' | 'budget'

export interface GenerationReviewSnapshot {
  /** pending = 停在这里等人决定；retried / waived = 已裁决，保留计数器与原因作记录。 */
  state: ReviewState
  retryClass: RetryClass
  /** 触发点：质检器名（fake-qc / visual-audit）、segment:N、provider-exhausted。 */
  kind: string
  reasons: string[]
  findings: { dimension: string; message: string; severity?: string; evidenceTimeSeconds?: number | null }[]
  score: number | null
  /** 这次停下之前，本任务已经跑过的尝试数（含首次）。 */
  attempt: number
  /** 每镜重抽上限（次数，不含首次）。 */
  cap: number
  retriesUsed: number
  /** 本集自动重抽额度 = 在用的镜数 × 每镜上限；额度用尽只停自动重抽，不拦人工。 */
  budgetLimit: number | null
  budgetUsed: number
  policy: RetryPolicy
  /** 该策略允许的自动重抽次数（ask=0 / auto1=1 / auto2=2），仍受 cap 与额度约束。 */
  autoRetries: number
  askReason: AskReason
  /** 人工重抽要复用同一条候选链——它在 triggerStage 里组装，事后无法重算。 */
  candidates: RunTaskCandidate[]
  artifactId: string | null
  error: string | null
  createdAt: string
  decidedAt?: string
  decidedBy?: string | null
  waiveReason?: string
}

export function isRetryClass(value: unknown): value is RetryClass {
  return typeof value === 'string' && (retryClasses as readonly string[]).includes(value)
}

export function isRetryPolicy(value: unknown): value is RetryPolicy {
  return typeof value === 'string' && (retryPolicies as readonly string[]).includes(value)
}

/** 三档默认处置：技术自动 2 次，一致性与创作性先问（2026-10-19 拍板 Q3）。 */
export function defaultRetryPolicy(retryClass: RetryClass): RetryPolicy {
  return retryClass === 'technical' ? 'auto2' : 'ask'
}

export function policyAutoRetries(policy: RetryPolicy): number {
  return policy === 'auto2' ? 2 : policy === 'auto1' ? 1 : 0
}

interface RetrySettings {
  maxRetriesPerShot: number | null
  retryTechnical: string | null
  retryConsistency: string | null
  retryCreative: string | null
}

/** 每镜重抽上限（不含首次）。null = 迁移前的默认 1 次。 */
export function retryCapOf(project: Pick<RetrySettings, 'maxRetriesPerShot'>): number {
  const value = project.maxRetriesPerShot
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3 ? value : 1
}

/**
 * 每集重抽额度的唯一算法：镜数 × 每镜上限，用量只数镜头绑定的媒体任务。
 * 素材（ASSET）、剧本、分镜不按镜计——它们没有「镜数」可乘，只有每任务上限。
 * 判定发生在 worker，展示发生在 API/console——两处必须算出同一个数，
 * 否则「本集重抽额度」会在界面和台账之间各说各话。
 */
export const budgetedRetryStages = ['FIRST_FRAME', 'VIDEO', 'AUDIO'] as const

export async function episodeRetryBudget(
  db: PrismaClient,
  episodeId: string,
  project: Pick<RetrySettings, 'maxRetriesPerShot'>,
): Promise<{ used: number; limit: number }> {
  const cap = retryCapOf(project)
  const [shots, tasks] = await Promise.all([
    db.storyboard.count({ where: { episodeId, supersededAt: null } }),
    db.generationTask.findMany({
      where: { storyboardId: { not: null }, stage: { in: [...budgetedRetryStages] }, batch: { episodeId } },
      select: { attempts: true },
    }),
  ])
  const used = tasks.reduce((sum, task) => sum + Math.max(task.attempts - 1, 0), 0)
  return { used, limit: shots * cap }
}

export function resolveRetryPolicy(project: RetrySettings, retryClass: RetryClass): RetryPolicy {
  const raw = retryClass === 'technical' ? project.retryTechnical : retryClass === 'consistency' ? project.retryConsistency : project.retryCreative
  if (isRetryPolicy(raw)) {
    // 创作性只接受 ask / auto1：多给一档就等于绕过拍板稿里的「没有唯一正确答案」。
    if (retryClass === 'creative' && raw === 'auto2') return 'auto1'
    return raw
  }
  return defaultRetryPolicy(retryClass)
}

/**
 * 质检失败归哪一档。连续性/一致性优先：角色长相、服装、场景对不上，重抽是
 * 「再买一次同样的赌」，默认该由人决定；其余审美与内容问题归创作性。
 * 技术失败不从这里来——它发生在候选链，不到质检。
 */
export function classifyQcFailure(findings: Array<{ dimension?: unknown }> | undefined): RetryClass {
  if (!findings || findings.length === 0) return 'creative'
  return findings.some(finding => finding.dimension === 'continuity') ? 'consistency' : 'creative'
}

/** 一条自动重抽是否放行；null = 可以自动，否则给出停在问的原因。 */
export function askReasonFor(args: {
  policy: RetryPolicy
  cap: number
  retriesUsed: number
  budgetLimit: number | null
  budgetUsed: number
}): AskReason | null {
  if (args.policy === 'ask') return 'policy'
  if (args.retriesUsed >= args.cap) return 'cap'
  if (args.budgetLimit !== null && args.budgetUsed >= args.budgetLimit) return 'budget'
  // 策略允许的自动次数先被用完（auto2 + cap 3 用了 2 次）：停在问是因为策略，
  // 不是每镜上限——界面上的解释必须能对上真正拦住它的那条。
  if (args.retriesUsed >= policyAutoRetries(args.policy)) return 'policy'
  return null
}

export function parseGenerationReview(raw: string | null | undefined): GenerationReviewSnapshot | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const value = parsed as Record<string, unknown>
  const state = value.state
  if (state !== 'pending' && state !== 'retried' && state !== 'waived') return null
  if (!isRetryClass(value.retryClass) || !isRetryPolicy(value.policy)) return null
  if (typeof value.kind !== 'string' || typeof value.createdAt !== 'string') return null
  if (typeof value.attempt !== 'number' || typeof value.cap !== 'number' || typeof value.retriesUsed !== 'number') return null
  const askReason = value.askReason
  if (askReason !== 'policy' && askReason !== 'cap' && askReason !== 'budget') return null
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.flatMap((entry): RunTaskCandidate[] => {
        const candidate = entry as { connectionId?: unknown; capabilityId?: unknown; provider?: unknown; model?: unknown }
        if (typeof candidate?.connectionId !== 'string' || typeof candidate.capabilityId !== 'string' || typeof candidate.provider !== 'string' || typeof candidate.model !== 'string') return []
        return [{ connectionId: candidate.connectionId, capabilityId: candidate.capabilityId, provider: candidate.provider, model: candidate.model }]
      })
    : []
  const findings = Array.isArray(value.findings)
    ? value.findings.flatMap((entry): GenerationReviewSnapshot['findings'] => {
        const finding = entry as { dimension?: unknown; message?: unknown; severity?: unknown; evidenceTimeSeconds?: unknown }
        if (typeof finding?.dimension !== 'string' || typeof finding.message !== 'string') return []
        return [{
          dimension: finding.dimension,
          message: finding.message,
          ...(typeof finding.severity === 'string' ? { severity: finding.severity } : {}),
          ...(typeof finding.evidenceTimeSeconds === 'number' || finding.evidenceTimeSeconds === null ? { evidenceTimeSeconds: finding.evidenceTimeSeconds as number | null } : {}),
        }]
      })
    : []
  return {
    state,
    retryClass: value.retryClass,
    kind: value.kind,
    reasons: Array.isArray(value.reasons) ? value.reasons.filter((reason): reason is string => typeof reason === 'string').slice(0, 20) : [],
    findings,
    score: typeof value.score === 'number' ? value.score : null,
    attempt: value.attempt,
    cap: value.cap,
    retriesUsed: value.retriesUsed,
    budgetLimit: typeof value.budgetLimit === 'number' ? value.budgetLimit : null,
    budgetUsed: typeof value.budgetUsed === 'number' ? value.budgetUsed : 0,
    policy: value.policy,
    autoRetries: typeof value.autoRetries === 'number' ? value.autoRetries : policyAutoRetries(value.policy),
    askReason,
    candidates,
    artifactId: typeof value.artifactId === 'string' ? value.artifactId : null,
    error: typeof value.error === 'string' ? value.error : null,
    createdAt: value.createdAt,
    ...(typeof value.decidedAt === 'string' ? { decidedAt: value.decidedAt } : {}),
    ...(typeof value.decidedBy === 'string' || value.decidedBy === null ? { decidedBy: value.decidedBy as string | null } : {}),
    ...(typeof value.waiveReason === 'string' ? { waiveReason: value.waiveReason } : {}),
  }
}
