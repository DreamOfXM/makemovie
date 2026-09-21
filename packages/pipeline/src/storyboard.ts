/**
 * 分段分镜(阶段 4b)的三个纯函数件:宽容解析(从 worker 的 content.ts 迁入,
 * 供合并重编号复用)、切块与预算分配、多段回复的拼接重编号。worker 只做编排——
 * 逐段调用、落件、把合并结果交给既有的落库路径。
 */

export interface StoryboardShot {
  title?: unknown
  description?: unknown
  dialogue?: unknown
  speaker?: unknown
  sourceExcerpt?: unknown
  durationMs?: unknown
  continuityIn?: unknown
  continuityOut?: unknown
  number?: unknown
}

export interface ExtractedAsset {
  kind?: unknown
  name?: unknown
  description?: unknown
}

export interface ParsedStoryboard {
  shots: StoryboardShot[]
  assets: ExtractedAsset[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Models wrap the payload in prose or code fences, so scan for the balanced JSON
// values in the reply instead of requiring it to be bare JSON. `{shots, assets}` is
// the current contract; a bare array is the shots-only shape the earlier prompt
// produced, and is still accepted.
export function parseStoryboardJson(text: string): ParsedStoryboard | null {
  for (const block of jsonBlocks(text)) {
    // A document that names `shots` is the reply even when the shot list came back
    // empty — falling through to the assets array would write the cast as shots.
    if (isRecord(block) && 'shots' in block) return asStoryboardDocument(block)
    if (Array.isArray(block) && block.length > 0) return { shots: block as StoryboardShot[], assets: [] }
  }
  return null
}

function asStoryboardDocument(document: Record<string, unknown>): ParsedStoryboard | null {
  const shots = document.shots
  if (!Array.isArray(shots) || shots.length === 0) return null
  const assets = document.assets
  return { shots: shots as StoryboardShot[], assets: Array.isArray(assets) ? (assets as ExtractedAsset[]) : [] }
}

function* jsonBlocks(text: string): Generator<unknown> {
  for (let start = 0; start < text.length; start += 1) {
    const open = text[start]
    if (open !== '{' && open !== '[') continue
    const end = balancedEnd(text, start)
    if (end === -1) continue
    try {
      yield JSON.parse(text.slice(start, end + 1)) as unknown
      start = end
    } catch {
      // A brace in the surrounding prose, or a truncated payload: keep looking.
    }
  }
}

function balancedEnd(text: string, start: number): number {
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * 分段阈值:剧本超 6000 字符(约 17 分钟的剧本量),或按集目标时长估算的镜头数
 * 超 40(约 3.5 分钟的 5 秒镜头)就分段。6000 字符内、无时长的旧集一条不差走
 * 单次调用;两个阈值都指向同一件事——单次请求的输入+回复规模开始逼模型的
 * 稳定输出上限,今天的"长集隐性截断"就是从这里开始的。
 */
export const STORYBOARD_SPLIT_CHAR_THRESHOLD = 6_000
export const STORYBOARD_SPLIT_SHOT_THRESHOLD = 40

// 每段的目标体量:段太小,一次分镜拆解被切成几十次调用;段太大,单段回复又回到
// 截断风险。1500 字符约对应 4 分钟剧本,是单次分镜回复能稳定承载的规模。
const SEGMENT_TARGET_CHARS = 1_500

// 与 buildScriptPrompt 的篇幅预算同源:中文剧本每分钟约 350 字。没有集时长时
// 用它从剧本篇幅反推总镜头预算,两边的"一分钟"必须是同一个。
const SCRIPT_CHARS_PER_MINUTE = 350

export interface StoryboardSegment {
  content: string
  /** 该段的镜头数预算,按整集预算乘以本段字符占比折算。 */
  shotBudget: number
}

export function shouldSplitStoryboard(scriptContent: string, targetDurationMs: number | undefined, shotMs: number): boolean {
  if (scriptContent.length > STORYBOARD_SPLIT_CHAR_THRESHOLD) return true
  return targetDurationMs !== undefined && Math.ceil(targetDurationMs / Math.max(1, shotMs)) > STORYBOARD_SPLIT_SHOT_THRESHOLD
}

/**
 * 把一份超阈值剧本切成有序分段并配好镜头预算。阈值内返回空数组——调用方据此
 * 走原有的单次调用路径,那条路径的行为一个字节都不能变。
 */
export function planStoryboardSegments(scriptContent: string, options: { targetDurationMs?: number; shotMs: number }): StoryboardSegment[] {
  if (!shouldSplitStoryboard(scriptContent, options.targetDurationMs, options.shotMs)) return []
  const text = scriptContent.trim()
  // 场景标记是 4a 的剧本 prompt 钉下的锚点,切块优先按场。标记存在但整篇只切出
  // 一段(单个超长场景)时退回空行段落聚合——原样送回去等于没分段,段落边界虽
  // 不如场景边界干净,仍是自然的叙事接缝。
  const sceneUnits = splitSceneUnits(text)
  const units = sceneUnits.length >= 2 ? sceneUnits : splitParagraphUnits(text)
  const blocks = packUnits(units)
  const totalChars = blocks.reduce((sum, block) => sum + block.length, 0)
  const totalBudget = totalShotBudget(totalChars, options.targetDurationMs, options.shotMs)
  return blocks.map(content => ({ content, shotBudget: Math.max(1, Math.round((totalBudget * content.length) / totalChars)) }))
}

function totalShotBudget(totalChars: number, targetDurationMs: number | undefined, shotMs: number): number {
  const durationMs = targetDurationMs ?? (totalChars / SCRIPT_CHARS_PER_MINUTE) * 60_000
  return Math.max(1, Math.ceil(durationMs / Math.max(1, shotMs)))
}

// 「场景 1」「场景一」「SCENE 1」「Scene 12」都算标记;中文数字兼容历史剧本
// (mock 与人工稿常用"场景一")。必须以行首出现,对白里提到"场景"不会被误切。
const SCENE_MARKER = /^[ \t]*(?:场景|SCENE)[ \t]*[0-9０-９〇零一二两三四五六七八九十百]+/

function splitSceneUnits(text: string): string[] {
  const units: string[] = []
  let current: string[] = []
  const flush = () => {
    const unit = current.join('\n').trim()
    if (unit !== '') units.push(unit)
    current = []
  }
  for (const line of text.split('\n')) {
    if (SCENE_MARKER.test(line)) flush()
    current.push(line)
  }
  flush()
  return units
}

function splitParagraphUnits(text: string): string[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map(paragraph => paragraph.trim())
    .filter(paragraph => paragraph !== '')
}

function packUnits(units: string[], target = SEGMENT_TARGET_CHARS): string[] {
  const blocks: string[] = []
  let current = ''
  for (const unit of units) {
    if (current !== '' && current.length + unit.length > target) {
      blocks.push(current)
      current = unit
    } else {
      current = current === '' ? unit : `${current}\n\n${unit}`
    }
  }
  if (current !== '') blocks.push(current)
  return blocks
}

/**
 * 按段序拼接多段分镜回复并全局重编号:各段的 shots 顺次相接、number 从 1 连续
 * 重排,assets 按 kind+name 去重(每段都会重新报一遍主角的定妆,不去重一段一档
 * 素材,落库时全撞在 (episodeId, kind, name) 唯一键上)。任何一段解析失败都返回
 * null——静默丢一段就是丢一截成片,宁可整个候选失败让位重试。
 */
export function mergeStoryboardReplies(replies: string[]): string | null {
  const shots: StoryboardShot[] = []
  const assets = new Map<string, ExtractedAsset>()
  for (const reply of replies) {
    const parsed = parseStoryboardJson(reply)
    if (!parsed) return null
    for (const shot of parsed.shots) shots.push({ ...shot, number: shots.length + 1 })
    for (const asset of parsed.assets) {
      const kind = typeof asset.kind === 'string' ? asset.kind.trim().toLowerCase() : ''
      const name = typeof asset.name === 'string' ? asset.name.trim() : ''
      if (kind === '' || name === '') continue
      const key = `${kind}|${name}`
      if (!assets.has(key)) assets.set(key, { ...asset, kind, name })
    }
  }
  if (shots.length === 0) return null
  return JSON.stringify({ shots, assets: [...assets.values()] })
}
