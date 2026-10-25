import { classifyFailure, type ComposeBlockKind, type FailureKind } from '@studio/domain'
import type { TranslateFn } from './i18n'

/**
 * 一次失败因什么 → 说那句原因的键。全站只有这一份：镜头卡、模型就绪度、素材红条
 * 三处各写一遍，就会出现徽章说「重抽无效」、下面那句又让你再抽一次
 * （2026-09-26 验收 B1：额度耗尽被写成「没过线」，用户转头去改提示词）。
 *
 * audit / unknown 没有键。前者要说清这一条自己抽了几次，句子得由调用方组；
 * 后者宁可退回通用文案——认不出的报文顶多不进字典，不许原样上屏。
 */
export const FAILURE_CAUSE_KEY: Record<FailureKind, string | null> = {
  moderation: 'failure.cause.moderation',
  quota: 'failure.cause.quota',
  access: 'failure.cause.access',
  param: 'failure.cause.param',
  network: 'failure.cause.network',
  audit: null,
  unknown: null,
}

/**
 * worker 那句 `…: threshold not met after 3 attempts` 里的尝试次数。
 * 认不出返回 null，由调用方退回通用文案——宁可少说一个数，也不编一个出来。
 */
export function auditAttempts(raw: string | null | undefined): number | null {
  const matched = /after (\d+) attempts?/i.exec(raw ?? '')
  return matched ? Number(matched[1]) : null
}

/**
 * 素材行红条那句人话。审计没过线要说清抽了几次（改描述重抽是唯一出路），
 * 终因要说清去哪修；原始报文由行首失败徽章的 Tooltip 兜着，排查不丢。
 */
/** 审计失声的特征：法官没给结论（解析不出/调不动/拒答），不是内容被判不合格。
 *  与「审了 N 次没过线」分开说——前者重跑通常就过，后者要改描述。 */
const AUDITOR_SILENT_RE = /no parseable verdict|could not judge|call failed|reported failure/i

/** 绑定本身是坏的：厂商侧根本没有这个模型。重跑再多次也不会变好，
 *  必须先改模型中心里的审核绑定——归成「服务波动」等于让人白花钱（SD-038）。 */
const AUDIT_MODEL_MISSING_RE = /model not exist|model not found|model_not_found|unknown model|not served|deployment .*not found/i

export function assetFailureCopy(t: TranslateFn, raw: string | null): string {
  const kind = classifyFailure(raw)
  if (kind === 'audit') {
    if (raw && AUDIT_MODEL_MISSING_RE.test(raw)) return t('assets.failure.auditModelMissing')
    if (raw && AUDITOR_SILENT_RE.test(raw)) return t('assets.failure.auditorSilent')
    const count = auditAttempts(raw)
    return count === null ? t('assets.generateFailedHint') : t('assets.failure.audit', { count })
  }
  const causeKey = FAILURE_CAUSE_KEY[kind]
  return causeKey ? t(causeKey) : t('assets.generateFailedHint')
}

/** 三档句子按阶段查表，不拼模板键：拼出来的键名一旦字典没跟上就原样上屏。 */
const MEDIA_COPY = {
  frame: { failed: 'shotboard.reason.frameFailed', playable: 'shotboard.reason.frameRetry', parked: 'shotboard.reason.frameParked' },
  video: { failed: 'shotboard.reason.videoFailed', playable: 'shotboard.reason.videoRetry', parked: 'shotboard.reason.videoParked' },
  // 配音没有「停在等你裁决」这一档：问询只挂在花钱的视频上，可播与否则由产物自己说。
  audio: { failed: 'storyboards.voiceFailed', playable: 'storyboards.voiceFailed', parked: 'storyboards.voiceFailed' },
} as const

/**
 * SD-167｜镜头卡、逐镜履历那两处红条的人话。
 *
 * 内部报文一律不上屏：`visual-audit: threshold not met — awaiting review (policy)`
 * 这种句子既没说该修什么，也没说这一镜手上还剩什么。认得出的因走全站 `failure.cause.*`
 * （额度/权限/参数/网络都是终因，重抽不会变好）；质检没过线要说清抽了几次；两者都认不出
 * 时退回这一镜的既有句子。原文不丢——红条的 Tooltip 与批次表的「展开」都兜着它。
 */
export function mediaFailureCopy(
  t: TranslateFn,
  stage: keyof typeof MEDIA_COPY,
  raw: string | null | undefined,
  state: { playable: boolean; parked?: boolean } = { playable: false },
): string {
  const kind = classifyFailure(raw)
  const causeKey = FAILURE_CAUSE_KEY[kind]
  if (causeKey) return t(causeKey)
  if (kind === 'audit') {
    const count = auditAttempts(raw)
    if (count !== null) return t('assets.failure.audit', { count })
    if (state.playable) return t(state.parked ? MEDIA_COPY[stage].parked : MEDIA_COPY[stage].playable)
  }
  return t(MEDIA_COPY[stage].failed)
}

/**
 * SD-167｜只说「因什么挂的」，不说「这一镜手上还剩什么」。
 *
 * 履历行每一行都是某一版的尝试记录：那一版有没有画面，行自己（时长、版本、状态徽章）已经说了。
 * 把 `mediaFailureCopy` 那句套上去，会出现一条放得出来的 4s 记录旁边写着「这一镜还没有画面」。
 * 认不出因（audit / unknown）返回 null，由调用方只留状态徽章——宁可少说一句，
 * 也不把内部报文或错的那句话搬上屏。
 */
export function failureCauseCopy(t: TranslateFn, raw: string | null | undefined): string | null {
  const causeKey = FAILURE_CAUSE_KEY[classifyFailure(raw)]
  return causeKey ? t(causeKey) : null
}

/**
 * SD-167｜批次表「错误」列那一格。任务可能落在任何阶段，句子不许替它猜「这一镜还没有画面」
 * 或「调整描述」——那是镜头卡与素材行的话。这里只回答「因什么挂的」，原文由「展开」兜着。
 */
export function taskFailureCopy(t: TranslateFn, raw: string | null): string {
  const cause = failureCauseCopy(t, raw)
  if (cause) return cause
  const count = auditAttempts(raw)
  if (count !== null) return t('generations.errorCause.auditAttempts', { count })
  if (classifyFailure(raw) === 'audit') return t('generations.errorCause.audit')
  return t('generations.errorCause.unknown')
}

/**
 * 合成整集停在「已阻塞」时的那句原因（SD-177）。按 ComposeBlockKind 枚举穷举写成
 * Record——新增一种阻塞而字典没跟上，编译期就报错，而不是界面上印出键名。
 * 每句都要说清「去哪修」，只说「合成失败」等于没解释。
 */
export const COMPOSE_BLOCK_KEY: Record<ComposeBlockKind, string> = {
  missing_video: 'generations.composeBlocked.missing_video',
  selection_stale: 'generations.composeBlocked.selection_stale',
  snapshot_drift: 'generations.composeBlocked.snapshot_drift',
  seam_unconditioned: 'generations.composeBlocked.seam_unconditioned',
  edit_clip_unknown: 'generations.composeBlocked.edit_clip_unknown',
  edit_source_missing: 'generations.composeBlocked.edit_source_missing',
  clip_not_editable: 'generations.composeBlocked.clip_not_editable',
  trim_failed: 'generations.composeBlocked.trim_failed',
  wrong_episode: 'generations.composeBlocked.wrong_episode',
  unknown: 'generations.composeBlocked.unknown',
}
