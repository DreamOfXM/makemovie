/**
 * 分镜层（plan_2026-10-24 §3–§5）的确定性词表与校验。
 *
 * 这一层回答三个问题，全部用可核对的字符串，不让模型自由发挥：
 * - 这一镜是什么角色（主镜/插入/反应/空镜/字卡）——决定它该长还是该短；
 * - 它从上一镜怎么接进来、往下怎么接出去（转场）——默认硬切；
 * - 它自己的环境音床是什么（声音）——合成时垫在配音下面。
 *
 * 连续段（§4.4）的拆点、帧链校验也在这里：这些判据只读数据，不调模型，零成本。
 */

import { normalizeSoundBed, shotTransitionDefaultMs, shotTransitions, type ShotTransition } from '@studio/domain'
import type { ContentFinding } from './content-audit.js'

export const SHOT_ROLES = ['main', 'insert', 'reaction', 'ambience', 'card'] as const
export type ShotRole = (typeof SHOT_ROLES)[number]

/** 「转场」列的词表与缺省毫秒：真源在 @studio/domain（界面与 DB 读的是同一份），这里沿用分镜层的名字。 */
export const TRANSITIONS = shotTransitions
export type Transition = ShotTransition
export const TRANSITION_DEFAULT_MS = shotTransitionDefaultMs

export interface ShotLine {
  speaker: string
  text: string
}

const ROLE_ALIASES: Record<string, ShotRole> = {
  主镜: 'main',
  主镜头: 'main',
  主线: 'main',
  main: 'main',
  master: 'main',
  插入: 'insert',
  插入镜: 'insert',
  细节: 'insert',
  insert: 'insert',
  detail: 'insert',
  反应: 'reaction',
  反应镜: 'reaction',
  reaction: 'reaction',
  空镜: 'ambience',
  氛围: 'ambience',
  环境: 'ambience',
  ambience: 'ambience',
  empty: 'ambience',
  establishing: 'ambience',
  字卡: 'card',
  字幕: 'card',
  card: 'card',
  title: 'card',
}

const TRANSITION_ALIASES: Record<string, Transition> = {
  硬切: 'cut',
  切: 'cut',
  直切: 'cut',
  cut: 'cut',
  叠化: 'dissolve',
  溶: 'dissolve',
  dissolve: 'dissolve',
  crossfade: 'dissolve',
  淡入: 'fade_in',
  fadein: 'fade_in',
  'fade in': 'fade_in',
  淡出: 'fade_out',
  fadeout: 'fade_out',
  'fade out': 'fade_out',
  黑场: 'black',
  黑场过桥: 'black',
  黑屏: 'black',
  black: 'black',
  闪白: 'flash',
  flash: 'flash',
}

export function normalizeShotRole(value: unknown): ShotRole | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase().replace(/[\s_\-（）()]/g, '')
  return ROLE_ALIASES[key] ?? null
}

export function normalizeTransition(value: unknown): Transition | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase().replace(/[\s_\-（）()]/g, '')
  return TRANSITION_ALIASES[key] ?? null
}

export interface TransitionChoice {
  transition: Transition
  transitionMs: number
}

/** 转场值 + 时长。未知值回落到硬切；硬切恒为 0；其余夹在 100–1000ms。 */
export function resolveTransition(value: unknown, durationMs: unknown): TransitionChoice {
  const transition = normalizeTransition(value) ?? 'cut'
  if (transition === 'cut') return { transition, transitionMs: 0 }
  const fallback = TRANSITION_DEFAULT_MS[transition]
  const ms = typeof durationMs === 'number' && Number.isFinite(durationMs) ? Math.round(durationMs) : fallback
  return { transition, transitionMs: Math.min(1000, Math.max(50, ms)) }
}

/** 镜内多句台词。空数组 / 非法项全部丢弃；不足两句返回 null（单句仍走 dialogue）。 */
export function normalizeShotLines(value: unknown): ShotLine[] | null {
  if (!Array.isArray(value)) return null
  const lines: ShotLine[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const speaker = typeof record.speaker === 'string' ? record.speaker.trim() : ''
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (text === '') continue
    lines.push({ speaker, text })
  }
  return lines.length >= 2 ? lines : null
}

/** 分镜表里没有「镜头类型」列时，从生成方式与内容猜一个保守值（只用于读数）。 */
export function inferShotRole(input: { method?: unknown; shotRole?: unknown; dialogue?: unknown; lines?: unknown }): ShotRole {
  const explicit = normalizeShotRole(input.shotRole)
  if (explicit) return explicit
  const method = typeof input.method === 'string' ? input.method.trim() : ''
  if (/字卡|字幕|card|title/i.test(method)) return 'card'
  const lines = normalizeShotLines(input.lines)
  const hasDialogue = lines !== null || (typeof input.dialogue === 'string' && input.dialogue.trim() !== '')
  if (hasDialogue) return 'reaction'
  return 'insert'
}

export interface TakeDraft {
  order: number
  plannedMs: number
  promptDelta: string
  /** 这一段覆盖的台词；没有按台词切时为 undefined。 */
  lines?: ShotLine[]
  /** 这一段的入场契约。相邻段的 continuityOut / continuityIn 必须逐字相等。 */
  continuityIn?: string
  /** 这一段的交棒契约，等于下一段的 continuityIn。 */
  continuityOut?: string
}

export interface TakePlan {
  takes: TakeDraft[]
  /** 拆点依据：台词句间停顿 / 动作完成点均分。 */
  splitAt: 'lines' | 'even' | 'none'
  /** 均分是兜底：没有可识别的内容拆点时，拆点不落在语义停顿上，需要人复核。 */
  warnings: string[]
}

/**
 * 段长分配。合计必须精确等于意图时长（预算不能凭空变长），每段不得超过单次能力。
 * 先均分毫秒余数，再把超出上限的部分挪给还有余量的段——`ceil(total/max)` 保证
 * 容量足够，所以这个循环一定会收敛。
 */
function distribute(totalMs: number, count: number, maxMs: number): number[] {
  const base = Math.floor(totalMs / count)
  const amounts = Array.from({ length: count }, (_, index) => base + (index < totalMs - base * count ? 1 : 0))
  let overflow = 0
  for (let index = 0; index < count; index += 1) {
    if (amounts[index]! > maxMs) {
      overflow += amounts[index]! - maxMs
      amounts[index] = maxMs
    }
  }
  while (overflow > 0) {
    const receiver = amounts.findIndex(amount => amount < maxMs)
    if (receiver < 0) break
    const room = maxMs - amounts[receiver]!
    const moved = Math.min(room, overflow)
    amounts[receiver] = amounts[receiver]! + moved
    overflow -= moved
  }
  return amounts
}

const DEFAULT_START = '本镜起幅：承接上一镜的画面、机位与光位，不重设空间。'
const DEFAULT_END = '本镜收束：动作完成后再交给下一镜，不在动作中途切走。'
const DEFAULT_BRIDGE = '动作尚未收尾：本段最后一帧保持当前姿势与机位，下一段从同一帧继续，不换角度、不跨轴。'
const SAME_SHOT_RULES = '同镜约束：机位、景别、光位、人物位置与参考集与上一段完全一致；只允许连续推拉摇移，不得换角度、不得跨轴、不得重新构图。'

/** 末段的交棒值固定取自分镜的 continuityOut；缺省时用一句可执行的收束约定。 */
function endContract(continuityOut: string): string {
  return continuityOut.trim() === '' ? DEFAULT_END : continuityOut.trim()
}

function startContract(continuityIn: string): string {
  return continuityIn.trim() === '' ? DEFAULT_START : continuityIn.trim()
}

function partitionLines(lines: ShotLine[], count: number): ShotLine[][] {
  const groups: ShotLine[][] = []
  let cursor = 0
  for (let index = 0; index < count; index += 1) {
    const remainingGroups = count - index
    const remainingLines = lines.length - cursor
    // 至少给后面的每一组留一句：否则最后一段会拿到空台词，拆点变成没有内容的分镜。
    const maxTake = remainingLines - (remainingGroups - 1)
    const remainingChars = lines.slice(cursor).reduce((sum, line) => sum + Math.max(1, line.text.length), 0)
    const target = remainingChars / remainingGroups
    const group: ShotLine[] = []
    let groupChars = 0
    while (cursor < lines.length && group.length < maxTake) {
      if (group.length > 0 && groupChars >= target) break
      const line = lines[cursor]!
      group.push(line)
      groupChars += Math.max(1, line.text.length)
      cursor += 1
    }
    groups.push(group)
  }
  return groups
}

/**
 * 把一颗超出单次能力的镜头拆成连续段。优先切在台词句间停顿上（观众本来就在等
 * 对方说话，切点天然成立）；没有台词时按动作完成点均分。段长不追求等长，但
 * 每段都不得超过 maxTakeMs，合计必须等于原镜头时长。
 *
 * 每段的提示词都带同一组契约：本段内容、承接上段、交棒下段、声床、同镜约束。
 * 相邻两段的「交棒下段 / 承接上段」逐字相等——这是帧链之外的第二种确定性，
 * 让两个独立请求描述的是同一个瞬间。
 */
export function planShotTakes(input: {
  durationMs: number
  maxTakeMs: number
  lines?: ShotLine[] | null
  description?: string
  continuityIn?: string
  continuityOut?: string
  ambience?: string | null
}): TakePlan {
  const durationMs = Math.max(1, Math.round(input.durationMs))
  const maxTakeMs = Math.max(1, Math.round(input.maxTakeMs))
  if (durationMs <= maxTakeMs) {
    return { takes: [{ order: 1, plannedMs: durationMs, promptDelta: '' }], splitAt: 'none', warnings: [] }
  }
  const count = Math.ceil(durationMs / maxTakeMs)
  const lines = input.lines && input.lines.length >= count ? input.lines : null
  const amounts = distribute(durationMs, count, maxTakeMs)
  const continuityIn = input.continuityIn ?? ''
  const continuityOut = input.continuityOut ?? ''
  const soundBed = normalizeSoundBed(input.ambience) ?? ''
  const soundLine = soundBed === '' ? '声床：与上一段同一条声床，不换氛围、不重新起声。' : `声床：${soundBed}（与上一段同一条声床，跨接缝不停）。`
  const groups = lines ? partitionLines(lines, count) : null
  // 每个内部拆点一条桥接值；相邻段引用同一条，保证逐字相等。
  const bridge = (index: number): string => {
    if (!groups || !groups[index]) return DEFAULT_BRIDGE
    const next = groups[index]!
    const nextText = next.map(line => line.text).join('')
    return `动作尚未收尾：下一段从「${nextText.length > 24 ? `${nextText.slice(0, 24)}…` : nextText}」这句台词起手，本段结束在这句话之前，画面与机位不停。`
  }
  const takes: TakeDraft[] = amounts.map((plannedMs, index) => {
    const order = index + 1
    const group = groups?.[index]
    const incoming = order === 1 ? startContract(continuityIn) : bridge(index)
    const outgoing = order === count ? endContract(continuityOut) : bridge(index + 1)
    const splitReason = group
      ? `拆点：台词句间停顿，切在第 ${order === count ? '末' : order} 段台词说完之后（不切在半句里）。`
      : order === 1
        ? '拆点：按动作完成点等分起点，本段从起幅开始，拍到一个动作完成点为止。'
        : '拆点：按动作完成点均分，本段严格从上一段末帧起手。'
    const content = group
      ? `本段内容：只让 ${group.map(line => line.speaker || '本镜说话人').join('、')} 说完这几句——${group.map(line => `「${line.text}」`).join('')}；其余人保持同步反应，不抢戏。`
      : order === 1
        ? `本段内容：${input.description?.trim() || '从本镜起手画面开始'}；只拍到这一段动作完成点，末帧保持清楚可接。`
        : order === count
          ? '本段内容：严格从上一段末帧起手，完成本镜剩余动作；末帧必须落在本镜 continuityOut 描述的画面上。'
          : '本段内容：严格从上一段末帧起手，继续完成下一段动作，末帧停在动作完成点。'
    return {
      order,
      plannedMs,
      promptDelta: [
        `第 ${order}/${count} 段${group ? '（台词段）' : ''} · 同镜拼接`,
        splitReason,
        content,
        `承接上段：${incoming}`,
        `交棒下段：${outgoing}`,
        soundLine,
        SAME_SHOT_RULES,
      ].join('\n'),
      ...(group ? { lines: group } : {}),
      continuityIn: incoming,
      continuityOut: outgoing,
    }
  })
  return {
    takes,
    splitAt: groups ? 'lines' : 'even',
    warnings: groups ? [] : ['这一镜没有足够的台词可切，拆点按动作完成点均分——请人工确认每段结束处真的有一个动作完成点。'],
  }
}

export interface TakeRecord {
  order: number
  plannedMs: number
  promptDelta: string
  firstFrameArtifactId?: string | null
  endFrameArtifactId?: string | null
  videoArtifactId?: string | null
  status?: string
  continuityIn?: string
  continuityOut?: string
}

/**
 * 连续段的落库校验。四条不变量里能确定性核对的三条都在这里：
 * 帧链（同一 artifact，不是「相似」）、段长合计、段序与拆点说明。
 * 同机位/同声床/同参考集是生成契约，靠 prompt 与同一份快照保证。
 */
export function auditShotTakes(input: { durationMs: number; maxTakeMs: number; takes: readonly TakeRecord[] }): ContentFinding[] {
  const findings: ContentFinding[] = []
  const takes = [...input.takes].sort((a, b) => a.order - b.order)
  if (takes.length === 0) return [{ code: 'shotTake:empty', detail: '这颗镜头没有任何连续段' }]
  const orders = takes.map(take => take.order)
  if (orders[0] !== 1 || orders.some((order, index) => order !== index + 1)) {
    findings.push({ code: 'shotTake:orderGap', detail: `段序必须从 1 连续：${orders.join('、')}` })
  }
  const sum = takes.reduce((total, take) => total + take.plannedMs, 0)
  if (sum !== input.durationMs) {
    findings.push({ code: 'shotTake:durationMismatch', detail: `连续段合计 ${Math.round(sum / 1000)} 秒，镜头计划 ${Math.round(input.durationMs / 1000)} 秒` })
  }
  const over = takes.filter(take => take.plannedMs > input.maxTakeMs)
  if (over.length > 0) {
    findings.push({ code: 'shotTake:overCeiling', detail: `${over.length} 段超过单次能力 ${Math.round(input.maxTakeMs / 1000)} 秒：第 ${over.map(take => take.order).join('、')} 段` })
  }
  const missingDelta = takes.filter(take => take.order > 1 && (take.promptDelta.trim() === '' || /同上/.test(take.promptDelta) || !take.promptDelta.includes('承接上段：')))
  if (missingDelta.length > 0) {
    findings.push({ code: 'shotTake:promptMissing', detail: `${missingDelta.length} 段没有写拆点说明或写了「同上」：第 ${missingDelta.map(take => take.order).join('、')} 段` })
  }
  const missingBed = takes.filter(take => take.order > 1 && !take.promptDelta.includes('声床：'))
  if (missingBed.length > 0) {
    findings.push({ code: 'shotTake:soundBedMissing', detail: `${missingBed.length} 段没有写声床契约：第 ${missingBed.map(take => take.order).join('、')} 段` })
  }
  for (let index = 1; index < takes.length; index += 1) {
    const previous = takes[index - 1]!
    const current = takes[index]!
    if (previous.endFrameArtifactId && current.firstFrameArtifactId !== previous.endFrameArtifactId) {
      findings.push({
        code: 'shotTake:frameChainBroken',
        detail: `第 ${current.order} 段的首帧不是第 ${previous.order} 段的末帧（帧链断开，接缝会被看出来）`,
      })
    }
    if (previous.status === 'SUCCEEDED' && previous.videoArtifactId && !previous.endFrameArtifactId) {
      findings.push({ code: 'shotTake:endFrameMissing', detail: `第 ${previous.order} 段已出片但还没有抽末帧，下一段无从接起` })
    }
    if (previous.continuityOut !== undefined && current.continuityIn !== undefined && previous.continuityOut.trim() !== current.continuityIn.trim()) {
      findings.push({
        code: 'shotTake:continuityDisconnect',
        detail: `第 ${previous.order} 段的交棒描述与第 ${current.order} 段的承接描述不一致（两个请求描述的不是同一个瞬间）`,
      })
    }
  }
  return findings
}
