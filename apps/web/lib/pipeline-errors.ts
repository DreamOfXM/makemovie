import { ApiError } from './api'
import type { Locale, TranslateFn } from './i18n'

/**
 * 流水线人工闸门的错误码 → 文案映射。后端拒绝阶段触发时返回
 * `{ error: code, reasons: [...具体对象] }`（如缺首帧的镜头号、草稿素材名），
 * 这里把 code 翻成整句提示、reasons 填进参数。匹配不到的 code 返回 null，
 * 调用方继续走自己的通用错误提示。
 */
const GATE_MESSAGES: Record<string, { key: string; param: string }> = {
  'generations:videoMissingFrames': { key: 'generations.videoMissingFrames', param: 'shots' },
  'generations:frameInFlight': { key: 'generations.frameInFlight', param: 'shots' },
  'generations:assetsNotApproved': { key: 'generations.assetsNotApproved', param: 'names' },
  'composition:selectionOpen': { key: 'generations.selectionOpen', param: 'shots' },
}

export function pipelineGateMessage(error: unknown, t: TranslateFn, locale: Locale): string | null {
  if (!(error instanceof ApiError)) return null
  const gate = GATE_MESSAGES[error.message]
  if (!gate) return null
  const reasons = (Array.isArray(error.body?.reasons) ? error.body.reasons : [])
    .filter((entry): entry is string => typeof entry === 'string')
  return t(gate.key, { [gate.param]: reasons.join(locale === 'zh' ? '、' : ', ') })
}
