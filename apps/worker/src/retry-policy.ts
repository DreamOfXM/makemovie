import type { PipelineDeps } from './deps.js'
import {
  askReasonFor,
  policyAutoRetries,
  resolveRetryPolicy,
  retryCapOf,
  type AskReason,
  type GenerationReviewSnapshot,
  type RetryClass,
  type RetryPolicy,
} from '@studio/pipeline'
import type { RunTaskCandidate } from '@studio/jobs'

/**
 * 每集重抽额度的唯一算法：镜数 × 每镜上限，用量只数镜头绑定的媒体任务。
 * 素材（ASSET）、剧本、分镜不按镜计——它们没有「镜数」可乘，只有每任务上限。
 */
const BUDGETED_STAGES = ['FIRST_FRAME', 'VIDEO', 'AUDIO'] as const

interface RetryProject {
  maxRetriesPerShot: number | null
  retryTechnical: string | null
  retryConsistency: string | null
  retryCreative: string | null
}

export interface RetryDecision {
  retryClass: RetryClass
  policy: RetryPolicy
  cap: number
  retriesUsed: number
  budgetLimit: number | null
  budgetUsed: number
  autoRetries: number
  /** null = 这次可以自动重抽；否则是停在问的原因。 */
  askReason: AskReason | null
}

export async function episodeRetryBudget(
  db: PipelineDeps['db'],
  episodeId: string,
  project: RetryProject,
): Promise<{ used: number; limit: number }> {
  const cap = retryCapOf(project)
  const [shots, tasks] = await Promise.all([
    db.storyboard.count({ where: { episodeId, supersededAt: null } }),
    db.generationTask.findMany({
      where: { storyboardId: { not: null }, stage: { in: [...BUDGETED_STAGES] }, batch: { episodeId } },
      select: { attempts: true },
    }),
  ])
  const used = tasks.reduce((sum, task) => sum + Math.max(task.attempts - 1, 0), 0)
  return { used, limit: shots * cap }
}

/**
 * 一次失败的处置决议。`budgetApplies` 只对镜头绑定的媒体任务为真：对
 * SCRIPT/STORYBOARD/ASSET 来说每集额度没有意义（没有镜数可乘），若把它套上去，
 * 一个还没拆镜的剧集额度是 0，会连首次技术重抽都拦掉。
 */
export async function decideRetry(args: {
  db: PipelineDeps['db']
  episodeId: string
  project: RetryProject
  retryClass: RetryClass
  attempt: number
  budgetApplies: boolean
}): Promise<RetryDecision> {
  const policy = resolveRetryPolicy(args.project, args.retryClass)
  const cap = retryCapOf(args.project)
  const retriesUsed = Math.max(args.attempt - 1, 0)
  const budget = args.budgetApplies ? await episodeRetryBudget(args.db, args.episodeId, args.project) : null
  const budgetLimit = budget?.limit ?? null
  const budgetUsed = budget?.used ?? 0
  return {
    retryClass: args.retryClass,
    policy,
    cap,
    retriesUsed,
    budgetLimit,
    budgetUsed,
    autoRetries: policyAutoRetries(policy),
    askReason: askReasonFor({ policy, cap, retriesUsed, budgetLimit, budgetUsed }),
  }
}

/** 停在问时写进 GenerationTask.reviewSnapshot 的那一份。 */
export function buildReviewSnapshot(args: {
  decision: RetryDecision
  kind: string
  reasons: string[]
  findings?: GenerationReviewSnapshot['findings']
  score: number | null
  attempt: number
  candidates: RunTaskCandidate[]
  artifactId: string | null
  error: string | null
}): GenerationReviewSnapshot {
  return {
    state: 'pending',
    retryClass: args.decision.retryClass,
    kind: args.kind,
    reasons: args.reasons.slice(0, 20),
    findings: (args.findings ?? []).slice(0, 50),
    score: args.score,
    attempt: args.attempt,
    cap: args.decision.cap,
    retriesUsed: args.decision.retriesUsed,
    budgetLimit: args.decision.budgetLimit,
    budgetUsed: args.decision.budgetUsed,
    policy: args.decision.policy,
    autoRetries: args.decision.autoRetries,
    askReason: args.decision.askReason ?? 'cap',
    candidates: args.candidates,
    artifactId: args.artifactId,
    error: args.error,
    createdAt: new Date().toISOString(),
  }
}
