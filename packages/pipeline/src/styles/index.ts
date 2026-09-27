/**
 * Style Presets Module
 *
 * @example
 * ```typescript
 * import { getOfficialStyles, getStyleById, getStyleVisualDirective } from './styles'
 *
 * // Get all official styles
 * const styles = getOfficialStyles()
 *
 * // Get style by ID
 * const cinematic = getStyleById('cinematic')
 * if (cinematic) {
 *   const visualPrompt = getStyleVisualDirective(cinematic, 'VIDEO')
 *   console.log(visualPrompt) // 'cinematic, film grain, dramatic lighting...'
 * }
 * ```
 */

export {
  OFFICIAL_STYLES,
  getOfficialStyles,
  getStyleById,
  isValidStyleId,
  getStyleVisualDirective,
  getStyleToneDirective,
  registerCustomStyle,
  unregisterCustomStyle,
  getAllStyles,
  StyleNotFoundError,
} from './presets.js'

export type { StylePreset } from './presets.js'

export {
  isStageAffectedByStyle,
  isVisualStyleStage,
  applyStyleToPrompt,
  applyStyleToPrompts,
  getStyleDisplayName,
  validateStyle,
  StyleApplicationError,
} from './applier.js'
