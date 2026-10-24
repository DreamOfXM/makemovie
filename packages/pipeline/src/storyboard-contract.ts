/**
 * 剧本自带的 markdown 分镜表 → 可校验的确定性契约。
 *
 * 分镜 prompt 的自由拆分规则只在「剧本没有分镜表」时成立。一旦作者（或上一道
 * 工序）已经把每一镜的时长、画面、台词逐行写死，模型的任务就只剩转录：压镜、
 * 合并、丢字卡都是违约。这里把那张表解析出来，供 prompt 声明契约、供落库前的
 * 审计逐行核对——两边读的是同一份解析结果，不存在「提示词说 46 行、审计数 42 行」
 * 这种各说各话。
 */

import type { StoryboardShot } from './storyboard.js'

export interface StoryboardContractRow {
  /** 表里的镜号；缺列时回退为行序。 */
  number: number
  durationMs: number
  /** 这一镜发生在哪（卧室/楼道/字卡…）。空串 = 表里没有场景列。 */
  location: string
  visual: string
  dialogue: string
  method: string
  /** 「镜头类型」列：主镜/插入/反应/空镜/字卡。空串 = 表里没有这一列。 */
  shotRole: string
  /** 「转场」列：硬切/叠化/淡入/淡出/黑场/闪白。空串 = 表里没有这一列，默认硬切。 */
  transition: string
  /** 「声音」列：这一镜的环境音床。空串 = 表里没有这一列。 */
  sound: string
}

export interface StoryboardContract {
  rows: StoryboardContractRow[]
  totalMs: number
}

function cells(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return []
  const parts = trimmed.split('|')
  if (parts[0]?.trim() === '') parts.shift()
  if (parts[parts.length - 1]?.trim() === '') parts.pop()
  return parts.map(cell => cell.trim())
}

function isSeparator(line: string): boolean {
  const row = cells(line)
  return row.length > 0 && row.every(cell => /^:?-{2,}:?$/.test(cell))
}

function columnIndex(header: string[], matches: (cell: string) => boolean): number {
  return header.findIndex(matches)
}

/** 时长列接受 `6s` / `6 秒` / 裸数字秒；返回毫秒，非整数秒或非正值返回 null。 */
export function parseContractDuration(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(?:s|秒)?$/i.exec(value.trim())
  if (!match) return null
  const seconds = Number(match[1])
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return Math.round(seconds * 1000)
}

/**
 * 找剧本里的分镜表：表头同时含「时长」「画面」，下一行是分隔行，至少 3 行。
 * 三个条件一起用是为了避开剧本里偶尔出现的普通表格——只靠「有表」会把任意
 * 时间表误判成分镜契约，模型随后被要求逐行转录音频表里的空画面。
 */
export function parseStoryboardContract(content: string): StoryboardContract | null {
  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = cells(lines[index]!)
    if (header.length === 0) continue
    const durationIndex = columnIndex(header, cell => cell.includes('时长'))
    const visualIndex = columnIndex(header, cell => cell.includes('画面'))
    if (durationIndex === -1 || visualIndex === -1) continue
    if (!isSeparator(lines[index + 1]!)) continue

    const numberIndex = columnIndex(header, cell => cell === '#' || cell.includes('镜号') || cell.includes('序号'))
    const locationIndex = columnIndex(header, cell => cell.includes('场景') || cell.includes('地点'))
    const dialogueIndex = columnIndex(header, cell => cell.includes('台词'))
    const methodIndex = columnIndex(header, cell => cell.includes('生成'))
    const roleIndex = columnIndex(header, cell => cell.includes('镜头类型') || cell.includes('镜型') || cell === '类型')
    const transitionIndex = columnIndex(header, cell => cell.includes('转场') || cell.includes('衔接'))
    const soundIndex = columnIndex(header, cell => cell.includes('声音') || cell.includes('音效') || cell.includes('环境音'))
    const rows: StoryboardContractRow[] = []
    for (let lineIndex = index + 2; lineIndex < lines.length; lineIndex += 1) {
      const row = cells(lines[lineIndex]!)
      if (row.length === 0) break
      if (row.some(cell => cell.includes('合计') || cell.includes('总计'))) break
      const durationMs = parseContractDuration(row[durationIndex] ?? '')
      const visual = (row[visualIndex] ?? '').trim()
      if (durationMs === null || visual === '') continue
      const listedNumber = Number.parseInt((row[numberIndex] ?? '').trim(), 10)
      rows.push({
        number: Number.isInteger(listedNumber) && listedNumber > 0 ? listedNumber : rows.length + 1,
        durationMs,
        location: locationIndex === -1 ? '' : (row[locationIndex] ?? '').trim(),
        visual,
        dialogue: dialogueIndex === -1 ? '' : (row[dialogueIndex] ?? '').trim(),
        method: methodIndex === -1 ? '' : (row[methodIndex] ?? '').trim(),
        shotRole: roleIndex === -1 ? '' : (row[roleIndex] ?? '').trim(),
        transition: transitionIndex === -1 ? '' : (row[transitionIndex] ?? '').trim(),
        sound: soundIndex === -1 ? '' : (row[soundIndex] ?? '').trim(),
      })
    }
    if (rows.length < 3) continue
    return { rows, totalMs: rows.reduce((sum, row) => sum + row.durationMs, 0) }
  }
  return null
}

/**
 * 字卡行里「屏幕上真会出现的文字」。只有带明确文本标记的才算：`字幕：…` 取冒号
 * 之后、`标题《…》` 取书名号之内、整格被引号包裹的取引号之内。
 *
 * 不能把所有「生成方式=字卡」的行都当逐字文本：像「六个 7:08 时间戳叠化」这类行
 * 是画面描述（模型写成「六个 7:08 的时间戳从不同角落浮出，慢慢叠化在一起」更完整），
 * 按整句精确匹配会把更好的描述判成缺失，白白烧掉一次生成。
 */
const CARD_TEXT_PATTERNS = [
  /^字幕\s*[:：]\s*(.+)$/,
  /^标题\s*[:：]?\s*《(.+?)》/,
  /^[「『“"](.+?)[」』”"]$/,
]

export function contractCardText(row: StoryboardContractRow): string | null {
  const visual = row.visual.trim()
  for (const pattern of CARD_TEXT_PATTERNS) {
    const match = pattern.exec(visual)
    if (!match) continue
    const text = match[1]!.trim()
    return text === '' ? null : text
  }
  return null
}

/** 忽略空白、标点与符号后的文本，用来判定「字卡文字是否被保留」。 */
export function normalizeContractText(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 一个镜头里所有可能承载分镜表画面的文字。 */
export function shotContractText(shot: StoryboardShot): string {
  return [shot.title, shot.description, shot.dialogue, shot.sourceExcerpt, shot.speaker]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
}
