/**
 * 风格应用器
 *
 * 将风格预设应用到流水线中各环节的 prompt。
 * 风格影响以下环节：
 * - STORYBOARD: 追加氛围语气
 * - IMAGE: 追加视觉风格描述
 * - VIDEO: 追加视觉风格描述
 */

import type { GenerationStage } from '../index.js'
import { getStyleById, getStyleVisualDirective, getStyleToneDirective, type StylePreset } from './presets.js'

/**
 * 检查风格是否影响某个生成阶段
 * @param stage 生成阶段
 * @returns 是否影响
 */
export function isStageAffectedByStyle(stage: GenerationStage): boolean {
  return ['STORYBOARD', 'IMAGE', 'VIDEO'].includes(stage)
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

    case 'IMAGE': {
      // 图像阶段：追加视觉风格描述
      const visualDirective = getStyleVisualDirective(style, 'IMAGE')
      return `${originalPrompt}\n\n视觉风格：${visualDirective}`
    }

    case 'VIDEO': {
      // 视频阶段：追加视觉风格描述
      const visualDirective = getStyleVisualDirective(style, 'VIDEO')
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
