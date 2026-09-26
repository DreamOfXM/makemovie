import { ApiError } from './api'
import type { TranslateFn } from './i18n'

/**
 * 后端拒绝一次操作时返回 `{ error, reasons }`：error 要么是 `阶段:原因` 码串，要么是
 * 一句英文报文，两者都不该原样出现在界面上。字典按「后端原文逐字作键」收录已知报文
 * （i18n.tsx 的 apiError 段），这里只查表并把 reasons 填进整句参数。
 *
 * 码串查不到 → 退成通用文案：宁可少说，也不把 generations:noApprovedScript 打在用户脸上
 * （原文进 console，排查不丢）。整句报文查不到 → 照原样显示：那是一句真话，只是还没翻，
 * 吞掉它反而让用户拿不到可行动的信息。
 *
 * 只吃 t 不吃 locale：分隔符本身进字典（apiError.listSeparator），语言由 t 的闭包决定，
 * 这样 79 处调用点少一个参数，也不会出现「同一句中文提示用英文逗号并列」的漏配。
 */
const CODE_RE = /^[a-z][A-Za-z]*:[a-zA-Z]+$/

/** reasons 里既有「#3 特写」这类人话，也有 `composition:missingVideo` 这类码串。
 *  码串只有在字典里有对应句子时才准进整句，否则宁可省略——拼进码串等于原地泄漏。 */
function nameReason(reason: string, t: TranslateFn): string | null {
  if (!CODE_RE.test(reason)) return reason
  return t(reason) === reason ? null : t(reason)
}

export function apiErrorMessage(error: unknown, t: TranslateFn): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error && error.message ? error.message : t('error.generic')
  }
  if (t(error.message) === error.message) {
    if (!CODE_RE.test(error.message)) return error.message
    console.warn('[api] unmapped error code:', error.message, error.body)
    return t('error.generic')
  }
  const reasons = (Array.isArray(error.body?.reasons) ? error.body.reasons : [])
    .filter((entry): entry is string => typeof entry === 'string')
    .map(reason => nameReason(reason, t))
    .filter((entry): entry is string => entry !== null)
  const list = reasons.join(t('apiError.listSeparator'))
  // 各条文案自带的参数名不同（{shots} 列镜头、{names} 列素材），这里同一份列表三个都填。
  return t(error.message, { shots: list, names: list, items: list })
}
