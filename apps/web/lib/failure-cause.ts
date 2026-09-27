import { classifyFailure, type FailureKind } from '@studio/domain'
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
export function assetFailureCopy(t: TranslateFn, raw: string | null): string {
  const kind = classifyFailure(raw)
  if (kind === 'audit') {
    const count = auditAttempts(raw)
    return count === null ? t('assets.generateFailedHint') : t('assets.failure.audit', { count })
  }
  const causeKey = FAILURE_CAUSE_KEY[kind]
  return causeKey ? t(causeKey) : t('assets.generateFailedHint')
}
