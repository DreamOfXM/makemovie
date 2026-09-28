/**
 * 风格应用器
 *
 * 将风格预设应用到流水线中各环节的 prompt。
 * 风格影响以下环节：
 * - STORYBOARD: 追加氛围语气
 * - ASSET: 追加视觉风格描述（参考图必须与成片同一画风，否则逐镜都在跟参考图打架）
 * - IMAGE: 追加视觉风格描述
 * - VIDEO: 追加视觉风格描述
 */

import type { GenerationStage } from '../index.js'
import { getStyleById, getStyleVisualDirective, getStyleToneDirective, getStyleAssetDirective, type StylePreset } from './presets.js'

/** 长相由提示词决定的阶段：参考图、首帧、视频吃同一份视觉风格；SCRIPT/AUDIO/MUSIC 不吃。 */
const VISUAL_STAGES: readonly GenerationStage[] = ['ASSET', 'IMAGE', 'VIDEO']

/**
 * 检查风格是否影响某个生成阶段
 * @param stage 生成阶段
 * @returns 是否影响
 */
export function isStageAffectedByStyle(stage: GenerationStage): boolean {
  return ['STORYBOARD', ...VISUAL_STAGES].includes(stage)
}

/** 长相由视觉风格决定的阶段：流水线据此决定要不要把预设拼进 prompt。 */
export function isVisualStyleStage(stage: GenerationStage): boolean {
  return VISUAL_STAGES.includes(stage)
}

/**
 * 将风格应用到某个阶段的 prompt
 *
 * @param stage 生成阶段
 * @param originalPrompt 原始 prompt
 * @param style 风格预设
 * @returns 应用风格后的 prompt
 */
export function applyStyleToPrompt(
  stage: GenerationStage,
  originalPrompt: string,
  style: StylePreset,
): string {
  if (!isStageAffectedByStyle(stage)) {
    return originalPrompt
  }

  switch (stage) {
    case 'STORYBOARD': {
      // 分镜阶段：追加氛围语气
      const toneDirective = getStyleToneDirective(style)
      return `${originalPrompt}\n\n风格要求：${toneDirective}`
    }

    case 'ASSET': {
      // 参考图是身份档案，不是风格源：完整剧照 directive（含镜头语言/海报质感）会压过
      // 设定板版式。ASSET 只取质感与色彩层并显式声明版式优先——同一画风靠色彩质感
      // 延续，而不是靠把剧照语言拍在设定板上。IMAGE/VIDEO 仍用完整 directive。
      const texture = getStyleAssetDirective(style)
      return `${originalPrompt}\n\n视觉风格（只约束色彩与质感；严格遵守上方的设定板分区版式与纯色背景，禁止输出单张剧照或场景背景）：${texture}`
    }

    case 'IMAGE':
    case 'VIDEO': {
      // 首帧/视频：追加完整视觉风格描述。与参考图的质感层同一色彩基因，成片不分裂。
      const visualDirective = getStyleVisualDirective(style, 'IMAGE')
      return `${originalPrompt}\n\n视觉风格：${visualDirective}`
    }

    default:
      return originalPrompt
  }
}

/**
 * 应用风格到多阶段 prompt
 *
 * @param promptsByStage 各阶段的 prompt
 * @param style 风格预设
 * @returns 应用风格后的 prompt
 */
export function applyStyleToPrompts(
  promptsByStage: Partial<Record<GenerationStage, string>>,
  style: StylePreset,
): Partial<Record<GenerationStage, string>> {
  const result: Partial<Record<GenerationStage, string>> = {}

  for (const [stage, prompt] of Object.entries(promptsByStage)) {
    if (prompt && isStageAffectedByStyle(stage as GenerationStage)) {
      result[stage as GenerationStage] = applyStyleToPrompt(
        stage as GenerationStage,
        prompt,
        style,
      )
    } else {
      result[stage as GenerationStage] = prompt
    }
  }

  return result
}

/**
 * 获取风格的显示名称
 *
 * @param styleId 风格 ID
 * @returns 显示名称，不存在返回风格 ID
 */
export function getStyleDisplayName(styleId: string): string {
  const style = getStyleById(styleId)
  return style?.name ?? styleId
}

/**
 * 验证风格 ID 是否有效
 *
 * @param styleId 风格 ID
 * @param throwIfInvalid 无效时是否抛出异常
 * @returns 风格预设
 * @throws 如果 throwIfInvalid 为 true 且风格不存在
 */
export function validateStyle(styleId: string, throwIfInvalid = false): StylePreset | null {
  const style = getStyleById(styleId)

  if (!style && throwIfInvalid) {
    throw new Error(`Invalid style: ${styleId}`)
  }

  return style ?? null
}

/**
 * 风格应用错误
 */
export class StyleApplicationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StyleApplicationError'
  }
}
