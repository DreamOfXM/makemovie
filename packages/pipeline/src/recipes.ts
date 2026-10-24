import { createHash } from 'node:crypto'

/**
 * US-005 官方配方定义。字段被 pipeline 实际消费才准进 spec(交接包 §8.1 的纪律):
 * aspect(画幅)、targetShotDurationMs(镜头时长范围)、script/storyboard 指令追加、
 * characterExtraction(角色提取规则)、voiceDefaults、quality、delivery 预设。
 * 9:16 与 16:9 共用同一套生产规则——只有画幅与镜头时长档不同,不是两条流水线。
 */
export interface RecipeSpec {
  aspect: '9:16' | '16:9'
  /** 镜头时长规划范围;pipeline 的 duration 预算在此区间内取。 */
  targetShotDurationMs: { min: number; max: number }
  /** 追加进剧本/分镜 prompt 的配方级指令(风格词仍归 StylePreset 管,两层不混)。 */
  scriptDirective?: string
  storyboardDirective?: string
  /** 角色提取规则:分镜阶段把哪些实体登记为角色素材。 */
  characterExtraction: { minPerShot?: number; requireLookDescription: boolean }
  voiceDefaults: { subtitleMode: 'auto' | 'burn' | 'soft'; bgm: boolean }
  quality: { qcMode: 'random' | 'model'; maxAttempts: number }
  delivery: { subtitleDelivery: 'burn' | 'soft' | 'srt'; editFormats: Array<'edl' | 'fcpxml' | 'otio'> }
}

export interface OfficialRecipe {
  recipeKey: string
  version: number
  notes: string
  spec: RecipeSpec
}

const COMMON: Omit<RecipeSpec, 'aspect' | 'targetShotDurationMs'> = {
  scriptDirective: '连续剧情体裁:每集一个完整戏剧动作,结尾留钩子;台词口语化,不写镜头术语。',
  storyboardDirective: '分镜覆盖该集全部剧情节拍;每镜一个主体动作;空间与服化道描述具体到可生成。',
  characterExtraction: { requireLookDescription: true },
  voiceDefaults: { subtitleMode: 'auto', bgm: true },
  quality: { qcMode: 'random', maxAttempts: 2 },
  delivery: { subtitleDelivery: 'srt', editFormats: ['edl', 'fcpxml', 'otio'] },
}

export const OFFICIAL_RECIPES: readonly OfficialRecipe[] = [
  {
    recipeKey: 'drama-serial',
    version: 1,
    notes: '竖屏连续剧情(默认门面):短剧节奏,5–15s 镜头。',
    spec: { aspect: '9:16', targetShotDurationMs: { min: 5000, max: 15000 }, ...COMMON },
  },
  {
    recipeKey: 'drama-short',
    version: 1,
    notes: '横屏剧情短片:8–25s 镜头,节奏更缓。',
    spec: { aspect: '16:9', targetShotDurationMs: { min: 8000, max: 25000 }, ...COMMON },
  },
]

export function recipeChecksum(recipe: OfficialRecipe): string {
  return createHash('sha256').update(JSON.stringify({ recipeKey: recipe.recipeKey, version: recipe.version, spec: recipe.spec })).digest('hex')
}

/**
 * The frame a project delivers. The pinned snapshot wins because a recipe is frozen at
 * creation; a project created before recipes existed falls back to the same mapping new
 * projects get — FILM is the only widescreen format.
 */
export function projectAspect(recipeSnapshot: string | null, format: string): '9:16' | '16:9' {
  const fallback = format === 'FILM' ? '16:9' : '9:16'
  if (!recipeSnapshot) return fallback
  try {
    const aspect = (JSON.parse(recipeSnapshot) as { aspect?: unknown }).aspect
    return aspect === '9:16' || aspect === '16:9' ? aspect : fallback
  } catch {
    return fallback
  }
}
