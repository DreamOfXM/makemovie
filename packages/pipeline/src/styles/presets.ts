/**
 * 风格预设系统
 *
 * 风格预设影响流水线中图像和视频生成环节的 prompt。
 * 每个风格包含：
 * - id: 唯一标识
 * - name: 显示名称
 * - description: 风格描述
 * - visualStyle: 视觉风格描述（追加到图/视频 prompt）
 * - tone: 氛围语气
 * - colorPalette: 色彩倾向（可选）
 * - cameraStyle: 镜头风格（可选）
 * - extraPrompt: 额外追加的提示词（可选）
 */

export interface StylePreset {
  /** 风格 ID */
  readonly id: string
  /** 显示名称 */
  readonly name: string
  /** 英文名称（可选） */
  readonly nameEn?: string
  /** 风格描述 */
  readonly description: string
  /** 是否为官方预设（不可删除） */
  readonly isOfficial: boolean
  /** 视觉风格描述 - 追加到图像/视频生成 prompt */
  readonly visualStyle: string
  /** 氛围语气 - 追加到分镜/剧本 prompt */
  readonly tone: string
  /** 色彩倾向（可选） */
  readonly colorPalette?: string
  /** 镜头风格（可选） */
  readonly cameraStyle?: string
  /** 额外追加的提示词（可选） */
  readonly extraPrompt?: string
}

/**
 * 官方风格预设
 *
 * 这些是系统内置的风格，用户可以选用但不能删除。
 */
export const OFFICIAL_STYLES: readonly StylePreset[] = [
  {
    id: 'realistic',
    name: '写实风',
    nameEn: 'Realistic',
    description: '贴近真实世界的视觉风格，适合纪录片和现实题材',
    isOfficial: true,
    visualStyle: 'photorealistic, realistic lighting, natural colors, documentary style, 8K detail, cinematic quality',
    tone: '写实、真实、自然',
    colorPalette: 'natural, muted tones',
    cameraStyle: 'documentary, handheld camera feel, natural movement',
  },
  {
    id: 'cinematic',
    name: '电影感',
    nameEn: 'Cinematic',
    description: '电影级别的视觉风格，适合剧情片和短剧',
    isOfficial: true,
    visualStyle: 'cinematic, film grain, dramatic lighting, anamorphic bokeh, movie quality, 4K cinematic color grading',
    tone: '戏剧化、有张力、叙事感强',
    colorPalette: 'cinematic color grading, rich contrast',
    cameraStyle: 'cinematic composition, dramatic angles, smooth camera movements',
    extraPrompt: 'cinematic lighting, film grain texture, movie poster quality',
  },
  {
    id: 'animation',
    name: '动画风',
    nameEn: 'Animation',
    description: '卡通/动画风格，适合儿童内容或创意表达',
    isOfficial: true,
    visualStyle: 'animation style, cartoon, vibrant colors, Pixar-like quality, Disney style, animated character',
    tone: '活泼、明快、适合全年龄',
    colorPalette: 'vibrant, saturated colors',
    cameraStyle: 'dynamic animation camera',
    extraPrompt: 'high quality animation, Pixar style, smooth frame rate',
  },
  {
    id: 'anime',
    name: '动漫风',
    nameEn: 'Anime',
    description: '日式动漫风格，适合二次元内容',
    isOfficial: true,
    visualStyle: 'anime style, Japanese animation, Studio Ghibli inspired, cel shading, detailed anime background',
    tone: '日式叙事、情感细腻',
    colorPalette: 'anime color palette, soft pastels',
    cameraStyle: 'anime cinematic angles, dramatic close-ups',
    extraPrompt: 'anime art style, detailed anime eyes, Studio Ghibli quality',
  },
  {
    id: 'noir',
    name: '黑白 / Noir',
    nameEn: 'Noir',
    description: '黑白电影风格，适合悬疑和复古题材',
    isOfficial: true,
    visualStyle: 'black and white photography, film noir style, high contrast black and white, vintage cinema aesthetic',
    tone: '神秘、紧张、复古',
    colorPalette: 'black and white only',
    cameraStyle: 'noir cinematography, dramatic shadows',
    extraPrompt: 'film noir aesthetic, classic black and white, dramatic shadows and lighting',
  },
  {
    id: 'sci-fi',
    name: '科幻风',
    nameEn: 'Sci-Fi',
    description: '未来科技风格，适合科幻题材',
    isOfficial: true,
    visualStyle: 'sci-fi, futuristic technology, cyberpunk, science fiction aesthetic, holographic effects, neon lighting',
    tone: '未来感、科技感、宏大叙事',
    colorPalette: 'neon, cyberpunk colors, blue and purple tones',
    cameraStyle: 'wide angle sci-fi shots, dramatic perspective',
    extraPrompt: 'futuristic sci-fi aesthetic, advanced technology, cyberpunk style',
  },
  {
    id: 'fantasy',
    name: '奇幻风',
    nameEn: 'Fantasy',
    description: '魔法与奇幻元素，适合神话和幻想题材',
    isOfficial: true,
    visualStyle: 'fantasy art, magical, ethereal lighting, mystical atmosphere, epic fantasy landscape, magical effects',
    tone: '奇幻、神秘、史诗感',
    colorPalette: 'magical colors, golden hour, mystical glow',
    cameraStyle: 'epic fantasy cinematography',
    extraPrompt: 'epic fantasy style, magical atmosphere, mystical lighting, ethereal glow',
  },
  {
    id: 'commercial',
    name: '商业广告风',
    nameEn: 'Commercial',
    description: '专业广告级别视觉，适合产品和品牌内容',
    isOfficial: true,
    visualStyle: 'commercial photography, product advertising style, professional studio lighting, high-end commercial quality',
    tone: '专业、高端、品牌感',
    colorPalette: 'professional color grading, brand-consistent',
    cameraStyle: 'commercial cinematography, product shots, studio quality',
    extraPrompt: 'professional commercial quality, studio lighting, advertising aesthetic',
  },
]

/**
 * 获取所有官方风格预设
 */
export function getOfficialStyles(): readonly StylePreset[] {
  return OFFICIAL_STYLES
}

/**
 * 根据 ID 获取风格预设
 * @param id 风格 ID
 * @returns 风格预设，不存在返回 undefined
 */
export function getStyleById(id: string): StylePreset | undefined {
  return OFFICIAL_STYLES.find(s => s.id === id) ?? customStyles.get(id)
}

/**
 * 检查风格 ID 是否有效
 * @param id 风格 ID
 * @returns 是否有效
 */
export function isValidStyleId(id: string): boolean {
  return OFFICIAL_STYLES.some(s => s.id === id) || customStyles.has(id)
}

/**
 * 获取风格预设的视觉风格文本
 * 用于追加到图像/视频生成 prompt
 *
 * @param style 风格预设
 * @param stage 生成阶段 'IMAGE' | 'VIDEO'
 * @returns 风格描述文本
 */
export function getStyleVisualDirective(style: StylePreset, stage: 'IMAGE' | 'VIDEO'): string {
  const parts: string[] = []

  // 视觉风格是核心
  parts.push(style.visualStyle)

  // 色彩倾向（如果有）
  if (style.colorPalette) {
    parts.push(style.colorPalette)
  }

  // 镜头风格（如果有）
  if (style.cameraStyle) {
    parts.push(style.cameraStyle)
  }

  // 额外提示词（如果有）
  if (style.extraPrompt) {
    parts.push(style.extraPrompt)
  }

  return parts.join(', ')
}

/**
 * 获取风格预设的氛围语气文本
 * 用于追加到分镜/剧本 prompt
 *
 * @param style 风格预设
 * @returns 氛围语气文本
 */
export function getStyleToneDirective(style: StylePreset): string {
  return style.tone
}

/**
 * 风格预设不存在错误
 */
export class StyleNotFoundError extends Error {
  constructor(styleId: string) {
    super(`Style not found: ${styleId}`)
    this.name = 'StyleNotFoundError'
  }
}

/**
 * 自定义风格注册表
 * 用户可以通过 registry 注册自定义风格
 */
export const customStyles = new Map<string, StylePreset>()

/**
 * 注册自定义风格
 * @param style 风格预设
 * @throws 如果风格 ID 已存在
 */
export function registerCustomStyle(style: StylePreset): void {
  if (isValidStyleId(style.id)) {
    throw new Error(`Style already exists: ${style.id}`)
  }
  customStyles.set(style.id, style)
}

/**
 * 注销自定义风格
 * @param id 风格 ID
 * @returns 是否成功注销（如果不存在返回 false）
 */
export function unregisterCustomStyle(id: string): boolean {
  if (!customStyles.has(id)) {
    return false
  }
  return customStyles.delete(id)
}

/**
 * 获取所有可用风格（包括官方和自定义）
 */
export function getAllStyles(): StylePreset[] {
  return [...OFFICIAL_STYLES, ...customStyles.values()]
}
