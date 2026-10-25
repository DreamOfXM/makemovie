/**
 * AI 生成文字（剧本 / 分镜）的确定性体检。
 *
 * 只拦「明显坏了」，不拦「可能不够好」。两类错误的代价不对称：误判要白烧一次生成
 * （这一抽被判失败、换下一个候选），漏判则是下游拿到一份切不动的东西。所以判据
 * 全部取自 prompt 的成文契约（prompts.ts 的「时长与结构要求（最高优先级）」），
 * 不掺任何品味判断。
 *
 * 与质检的分工：worker 的 QualityChecker 给有画面的产物打分，而文字没有画面可看
 * ——qc.ts 的 auditPlanFor 对 text 模态直接放行（score 1）。文字侧的门因此在这里，
 * 且它是零成本、确定性的：不调用任何模型，不会 unjudged，不会因能力槽没绑定而
 * 让整批文字任务失败。
 */

import { SCENE_MARKER, type StoryboardShot } from './storyboard.js'
import { contractCardText, normalizeContractText, parseStoryboardContract, shotContractText, type StoryboardContract, type StoryboardContractRow } from './storyboard-contract.js'
import { normalizeShotRole, normalizeTransition, type ShotRole } from './shot-layer.js'
import { shotProduction } from './shot-method.js'

export interface ContentFinding {
  /** 机器可读的原因码，进任务日志与失败快照。 */
  code: string
  /** 给人看的一句话，说明这一抽错在哪。 */
  detail: string
}

/**
 * 剧本正文的体检。判据只有一条，但它是硬契约：prompt 把「剧本必须按场景分段、
 * 场景标记逐场编号、不得省略」列为最高优先级，因为 4b 的分镜切块正是按场景标记
 * 切的（storyboard.ts 的 splitSceneUnits 用同一个正则）。缺了它，长剧本会退化成
 * 整篇一次请求——而模型的单次回复长度是有限的，那是静默截断。
 */
export function auditScriptText(content: string): ContentFinding[] {
  if (content.trim() === '') return [{ code: 'script:empty', detail: '剧本正文为空' }]
  const marked = content.split(/\r?\n/).some(line => SCENE_MARKER.test(line))
  if (!marked) {
    return [{ code: 'script:noSceneMarker', detail: '剧本没有任何场景标记行（如「场景 1」），分镜无法按场切分' }]
  }
  return []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sceneNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/**
 * 分镜的体检。前三条取自 prompt 的通用成文要求：
 *
 * - 每镜要有 description。空描述让首帧没有可生成的画面，也让「按镜头文本匹配素材」
 *   的绑定整片失效——那是画面一致性的源头。
 * - scene 从 1 起连续编号。prompt 要求同一场次的镜头在同一地点与时间段内，换地点
 *   或明显换时间即开新场次，且逐场编号不得省略。
 * - scene 整集缺失不算错：旧模型不带该字段，全 null 与改造前的行为一致（content.ts
 *   落库时同样按 null 处理）。只有「一部分有、编号还对不上」才是违约。
 *
 * 后三条是「信息全不全」的地板（2026-10-21 用户要求：做完分镜必须有机制保障分镜
 * 信息是全的、是对的）。它们只问字段在不在，不问写得好不好，所以误判空间为零：
 *
 * - durationMs 缺失或非正。worker 的 `asDuration` 会把它静默补成 5000——那是
 *   「信息缺失却装作完整」：界面显示 5 秒、实际按这个数排队买时长，谁都不知道
 *   这一镜本来要几秒。宁可拒收，让人重新生成一次。
 * - 第 2 镜起必须有 continuityIn。独立生成的首帧只读得到文字，没有空间锚点就
 *   各自为政（2026-09-29 实测：镜 1 坐在长桌边，镜 2 不知在哪）。
 * - 非末镜必须有 continuityOut。它是下一镜的起手画面，缺了就没有任何机制能保障
 *   镜与镜接得上；末镜允许留空，因为它后面没有镜头要接。
 *
 * 传入剧本时，再按剧本自带的分镜表做契约核对：行数、每镜时长、总时长，以及字卡上
 * 逐字出现的字幕/标题文字（描述性字卡只核对行，不核对措辞）。
 * 另有连续字卡上限（SD-187，见 auditCardWall）：四连以上的字卡墙在落库前拒收。
 * 这不是风格判断——表里的每一行都是作者已经拍板的镜头，模型压镜或省略字卡就是
 * 交错了作业。没有分镜表的剧本（绝大多数模型自写剧本）完全走原有三条。
 */
export function auditStoryboardShots(shots: readonly StoryboardShot[], scriptContent?: string): ContentFinding[] {
  const findings: ContentFinding[] = []
  if (shots.length === 0) return [{ code: 'storyboard:noShots', detail: '分镜没有产出任何镜头' }]

  const blank = shots.filter(shot => text(shot.description) === '').length
  if (blank > 0) findings.push({ code: 'storyboard:blankDescription', detail: `${blank} 个镜头没有画面描述` })

  const scenes = [...new Set(shots.map(shot => sceneNumber(shot.scene)).filter((n): n is number => n !== null))].sort((a, b) => a - b)
  if (scenes.length > 0 && (scenes[0] !== 1 || scenes.some((n, index) => n !== index + 1))) {
    findings.push({ code: 'storyboard:sceneGap', detail: `场次号不从 1 起、或有缺口：${scenes.join('、')}` })
  }

  const noDuration = shots.map((shot, index) => (durationOf(shot) === null ? index + 1 : null)).filter((n): n is number => n !== null)
  if (noDuration.length > 0) findings.push({ code: 'storyboard:durationMissing', detail: `${noDuration.length} 个镜头没有填 durationMs：第 ${noDuration.slice(0, 8).join('、')} 镜` })

  const noContinuityIn = shots.slice(1).map((shot, index) => (text(shot.continuityIn) === '' ? index + 2 : null)).filter((n): n is number => n !== null)
  if (noContinuityIn.length > 0) findings.push({ code: 'storyboard:continuityInMissing', detail: `${noContinuityIn.length} 个镜头没有 continuityIn（承接上一镜的空间事实）：第 ${noContinuityIn.slice(0, 8).join('、')} 镜` })

  const noContinuityOut = shots.slice(0, -1).map((shot, index) => (text(shot.continuityOut) === '' ? index + 1 : null)).filter((n): n is number => n !== null)
  if (noContinuityOut.length > 0) findings.push({ code: 'storyboard:continuityOutMissing', detail: `${noContinuityOut.length} 个镜头没有 continuityOut（末帧画面里看得见的状态）：第 ${noContinuityOut.slice(0, 8).join('、')} 镜` })

  const contract = scriptContent === undefined ? null : parseStoryboardContract(scriptContent)
  findings.push(...auditShotLayer(shots, contract))
  findings.push(...auditCardWall(shots, contract))
  if (contract) findings.push(...auditContract(shots, contract))
  return findings
}

/**
 * 连续字卡上限（SD-187：EP1 实测 #31 起 33 镜仅 3 镜实拍，靠 16 连字卡墙推进剧情，
 * 观感从「剧」退化成「PPT」）。
 *
 * 3 不是量出来的最优值，是本仓库既有的一条重复界线：prompts.ts 早就写「不许连续三镜
 * 同景别」（改前已在 HEAD），那条管景别，这条管字卡——同一类产品判断（三连还可能是
 * 章节/时码组，第四颗起就不是推进剧情而是没完没了的报幕）搬到一个新轴上。搬到新轴
 * 就要认下代价：命中的是整批拒收（worker 换候选，一次分镜生成白跑），所以留了逃生门
 * ——作者真想要四连，把这一段写进剧本的分镜表（isCardRow 那条豁免）就不会被拦。
 * 若后续实测发现拒收主要来自合法的四连开场，改的是这条豁免的写法，不是把上限调大。
 */
export const MAX_CONSECUTIVE_CARDS = 3

/** 一镜是不是字卡：镜头类型说「字卡」，或生成方式认成 title-card。空值都不是。 */
function isCardShot(shot: StoryboardShot): boolean {
  return normalizeShotRole(shot.shotRole) === 'card' || shotProduction(text(shot.method)) === 'title-card'
}

/** 作者分镜表把这一行拍成字卡：这一镜的字卡身份是表里的决定，不是模型自由发挥。 */
function isCardRow(row: StoryboardContractRow): boolean {
  return normalizeShotRole(row.shotRole) === 'card' || shotProduction(row.method) === 'title-card'
}

function auditCardWall(shots: readonly StoryboardShot[], contract: StoryboardContract | null): ContentFinding[] {
  const rows = contract !== null && contract.rows.length === shots.length ? contract.rows : null
  const findings: ContentFinding[] = []
  let start = -1
  for (let index = 0; index <= shots.length; index += 1) {
    const inRun = index < shots.length && isCardShot(shots[index]!)
    if (inRun) {
      if (start === -1) start = index
      continue
    }
    if (start !== -1) {
      const run = index - start
      // 整段都被作者表拍板时不在这里拦：模型只能逐行转录，拒收等于无限重抽——
      // 卡墙若真来自表本身，要改的是剧本层的分镜表，不是这一抽。
      const prescribed = rows !== null && shots.slice(start, index).every((_, offset) => isCardRow(rows[start + offset]!))
      if (run > MAX_CONSECUTIVE_CARDS && !prescribed) {
        findings.push({
          code: 'storyboard:cardWall',
          detail: `第 ${start + 1}–${index} 镜连续 ${run} 张字卡，超过上限 ${MAX_CONSECUTIVE_CARDS} 颗（字卡只作锚点，剧情推进必须回到实拍镜头）`,
        })
      }
      start = -1
    }
  }
  return findings
}

/**
 * 分镜层（plan_2026-10-24 §3–§5）的硬检。只在「这一份分镜真的声明了镜头类型 /
 * 转场」时生效：旧模型与自由拆解不带这两个字段，全空时行为与改造前完全一致。
 *
 * - 镜头类型必须在词表内，且每一场至少一颗主镜——主镜承载这一场最重要的连续
 *   动作或完整对白；一场全是插入/反应，观众看到的就是一堆碎切，没有事件。
 * - 转场必须在词表内。缺省即硬切，所以「没写」不算错；写了但认不出来才算错，
 *   否则合成时会静默退回硬切，作者以为加了叠化、成片却是硬跳。
 *
 * 契约行里的值优先于模型自由填的值（与 worker 落库的覆盖顺序一致）：作者写死的
 * 那一列是拍板结果，模型转录时漏抄不该让整批重来。
 */
function auditShotLayer(shots: readonly StoryboardShot[], contract: StoryboardContract | null): ContentFinding[] {
  const findings: ContentFinding[] = []
  const rows = contract !== null && contract.rows.length === shots.length ? contract.rows : null
  const pick = (index: number, fromShot: unknown, fromRow: string | undefined): string => {
    const shotValue = text(fromShot)
    if (shotValue !== '') return shotValue
    return fromRow ?? ''
  }

  const roles = shots.map((shot, index) => pick(index, shot.shotRole, rows?.[index]?.shotRole))
  if (roles.some(value => value !== '')) {
    const invalid = roles.flatMap((value, index) => {
      if (value === '') return [`第 ${index + 1} 镜（未填）`]
      return normalizeShotRole(value) === null ? [`第 ${index + 1} 镜「${value}」`] : []
    })
    if (invalid.length > 0) {
      findings.push({ code: 'storyboard:shotRoleInvalid', detail: `${invalid.length} 镜的镜头类型缺失或不在词表内：${invalid.slice(0, 8).join('、')}` })
    } else {
      const normalized = roles.map(value => normalizeShotRole(value)!) as ShotRole[]
      const scenes = [...new Set(shots.map(shot => sceneNumber(shot.scene)).filter((n): n is number => n !== null))].sort((a, b) => a - b)
      if (scenes.length > 0) {
        const noMain = scenes.filter(scene => !shots.some((shot, index) => sceneNumber(shot.scene) === scene && normalized[index] === 'main'))
        if (noMain.length > 0) {
          findings.push({ code: 'storyboard:sceneNoMainShot', detail: `场次 ${noMain.join('、')} 没有主镜（这一场最重要的连续动作没有承载镜）` })
        }
      } else if (!normalized.includes('main')) {
        findings.push({ code: 'storyboard:noMainShot', detail: '整集没有一颗主镜，全部是插入/反应/空镜/字卡' })
      }
    }
  }

  const transitions = shots.map((shot, index) => pick(index, shot.transition, rows?.[index]?.transition))
  if (transitions.some(value => value !== '')) {
    const unknown = transitions.flatMap((value, index) => {
      if (value === '') return []
      return normalizeTransition(value) === null ? [`第 ${index + 1} 镜「${value}」`] : []
    })
    if (unknown.length > 0) {
      findings.push({ code: 'storyboard:transitionInvalid', detail: `${unknown.length} 镜的转场不在词表内（会静默退回硬切）：${unknown.slice(0, 8).join('、')}` })
    }
  }
  return findings
}

function durationOf(shot: StoryboardShot): number | null {
  return typeof shot.durationMs === 'number' && Number.isFinite(shot.durationMs) && shot.durationMs > 0 ? shot.durationMs : null
}

function auditContract(shots: readonly StoryboardShot[], contract: StoryboardContract): ContentFinding[] {
  const findings: ContentFinding[] = []
  if (shots.length !== contract.rows.length) {
    findings.push({ code: 'storyboard:contractShotCount', detail: `分镜表为 ${contract.rows.length} 行，实际输出 ${shots.length} 镜` })
  }

  const totalMs = shots.reduce((sum, shot) => sum + (durationOf(shot) ?? 0), 0)
  if (totalMs !== contract.totalMs) {
    findings.push({ code: 'storyboard:contractTotalDuration', detail: `分镜总时长 ${Math.round(totalMs / 1000)} 秒，分镜表为 ${Math.round(contract.totalMs / 1000)} 秒` })
  }

  // 行数不一致时按下标逐镜比对会从第一个被合并/删除的行开始整片错位，
  // 报出来全是噪声；此时只报总数与字卡，等模型先把行数交对。
  if (shots.length === contract.rows.length) {
    const mismatched = contract.rows.flatMap((row, index) => {
      const actual = durationOf(shots[index]!)
      return actual === row.durationMs ? [] : [`第 ${row.number} 行 ${actual === null ? '缺失' : `${Math.round(actual / 1000)} 秒`}（应为 ${Math.round(row.durationMs / 1000)} 秒）`]
    })
    if (mismatched.length > 0) {
      findings.push({ code: 'storyboard:contractDuration', detail: `${mismatched.length} 个镜头时长与分镜表不符：${mismatched.slice(0, 8).join('、')}${mismatched.length > 8 ? ` 等 ${mismatched.length} 行` : ''}` })
    }
  }

  const shotTexts = shots.map(shot => normalizeContractText(shotContractText(shot))).filter(value => value !== '')
  const missing = contract.rows.flatMap(row => {
    const card = contractCardText(row)
    if (card === null) return []
    const normalized = normalizeContractText(card)
    if (normalized === '' || shotTexts.some(value => value.includes(normalized))) return []
    return [`第 ${row.number} 行「${card.length > 24 ? `${card.slice(0, 24)}…` : card}」`]
  })
  if (missing.length > 0) {
    findings.push({ code: 'storyboard:contractCard', detail: `${missing.length} 张字卡文字缺失：${missing.join('、')}` })
  }
  return findings
}

/** 把体检结论压成一行，用作这一抽的失败原因。 */
export function describeFindings(findings: readonly ContentFinding[]): string {
  return findings.map(finding => `${finding.code}（${finding.detail}）`).join('；')
}

/**
 * 分镜节奏读数（S1 · 剧本层）。
 *
 * 与上面的体检分开：体检判「这一抽明显坏了、要重来」，节奏判「这份剧本切得碎不碎」。
 * 碎不等于错，所以它不拦 AI 产物落地，只在人工批准前把数摆出来——低于项目设置时
 * 批准人要显式勾选接受。阈值归项目设置所有，这里给的只是起始默认。
 */
export interface ShotRhythmSettings {
  /** 全片平均镜长下限（毫秒）。 */
  avgShotMs: number
  /** 算作长镜的门槛（毫秒）。 */
  longTakeMinMs: number
  /** 长镜合计占片长的最低比例（0–1）。 */
  longTakeShareMin: number
}

/**
 * 起始默认（不是本平台实测阈值，设置页必须如实这么标）：
 * - 4500ms 取自 plan_2026-10-24 §8 的返修目标：2.86 秒/镜 → 4.5–5 秒以上；
 * - 8000ms 是他点名要能装进一颗镜头的内容量级（8 / 10 / 15 秒）；
 * - 0.2 与 4500ms 自洽：两成片长放进 ≥8 秒长镜，其余平均约 3.6 秒。
 */
export const DEFAULT_SHOT_RHYTHM: ShotRhythmSettings = { avgShotMs: 4_500, longTakeMinMs: 8_000, longTakeShareMin: 0.2 }

/** 读数里的短镜带：与 plan §1 的实测口径一致（≤3 秒），只进读数，不参与门。 */
export const SHORT_SHOT_MS = 3_000

export interface ShotRhythmReadings {
  shotCount: number
  totalMs: number
  avgShotMs: number
  maxShotMs: number
  longTakeMinMs: number
  longTakeCount: number
  longTakeMs: number
  /** 长镜合计占片长，0–1。 */
  longTakeShare: number
  shortShotCount: number
  /** ≤3 秒镜头占镜头数的比例，0–1。 */
  shortShotShare: number
}

/** 门只认这两条；`pass` 为 true 时 `failures` 为空。 */
export interface ShotRhythmGate {
  pass: boolean
  failures: ('avgShot' | 'longTakeShare')[]
}

const RHYTHM_BOUNDS = {
  avgShotMs: { min: 1_000, max: 20_000 },
  longTakeMinMs: { min: 2_000, max: 30_000 },
  longTakeShareMin: { min: 0, max: 1 },
} as const

function boundedInt(value: unknown, fallback: number, bounds: { min: number; max: number }): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= bounds.min && value <= bounds.max ? value : fallback
}

/**
 * 把外部输入（设置页提交的对象、库里的 JSON）收敛成一套可用的设置。越界或类型不对
 * 的字段回落到起始默认，而不是抛错——设置页有同一套边界的显式校验，这里兜的是
 * 历史数据与手工写入。
 */
export function normalizeShotRhythm(input: Partial<Record<keyof ShotRhythmSettings, unknown>>): ShotRhythmSettings {
  const share = input.longTakeShareMin
  return {
    avgShotMs: boundedInt(input.avgShotMs, DEFAULT_SHOT_RHYTHM.avgShotMs, RHYTHM_BOUNDS.avgShotMs),
    longTakeMinMs: boundedInt(input.longTakeMinMs, DEFAULT_SHOT_RHYTHM.longTakeMinMs, RHYTHM_BOUNDS.longTakeMinMs),
    longTakeShareMin:
      typeof share === 'number' && Number.isFinite(share) && share >= RHYTHM_BOUNDS.longTakeShareMin.min && share <= RHYTHM_BOUNDS.longTakeShareMin.max
        ? share
        : DEFAULT_SHOT_RHYTHM.longTakeShareMin,
  }
}

export function resolveShotRhythm(raw: string | null | undefined): ShotRhythmSettings {
  if (!raw) return DEFAULT_SHOT_RHYTHM
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_SHOT_RHYTHM
    return normalizeShotRhythm(parsed as Partial<Record<keyof ShotRhythmSettings, unknown>>)
  } catch {
    return DEFAULT_SHOT_RHYTHM
  }
}

/**
 * 一把尺的两端：剧本契约里的分镜表与母带台账里的逐镜跨度都喂这里，量出来的数才
 * 能对照。「剧本按这张表切」与「母带实际是这样」如果各算各的，验收页就会同时出现
 * 两个平均镜长，人只能挑一个信。
 */
export function rhythmFromSpans(durations: number[], totalMs: number, settings: ShotRhythmSettings): ShotRhythmReadings {
  const longTakeMs = durations.filter(ms => ms >= settings.longTakeMinMs).reduce((sum, ms) => sum + ms, 0)
  const shortShotCount = durations.filter(ms => ms <= SHORT_SHOT_MS).length
  return {
    shotCount: durations.length,
    totalMs,
    avgShotMs: Math.round(totalMs / durations.length),
    maxShotMs: Math.max(...durations),
    longTakeMinMs: settings.longTakeMinMs,
    longTakeCount: durations.filter(ms => ms >= settings.longTakeMinMs).length,
    longTakeMs,
    longTakeShare: totalMs === 0 ? 0 : longTakeMs / totalMs,
    shortShotCount,
    shortShotShare: durations.length === 0 ? 0 : shortShotCount / durations.length,
  }
}

/**
 * 从剧本自带的分镜表算节奏。没有分镜表的剧本返回 null——门只对作者已经把镜头
 * 写死的剧本生效（与分镜契约同一条边界），不拿自由散文去猜镜头。
 */
export function measureShotRhythm(content: string, settings: ShotRhythmSettings = DEFAULT_SHOT_RHYTHM): ShotRhythmReadings | null {
  const contract = parseStoryboardContract(content)
  if (!contract || contract.rows.length === 0) return null
  return rhythmFromSpans(contract.rows.map(row => row.durationMs), contract.totalMs, settings)
}

export function evaluateShotRhythm(readings: ShotRhythmReadings | null, settings: ShotRhythmSettings): ShotRhythmGate {
  if (!readings) return { pass: true, failures: [] }
  const failures: ShotRhythmGate['failures'] = []
  if (readings.avgShotMs < settings.avgShotMs) failures.push('avgShot')
  if (readings.longTakeShare < settings.longTakeShareMin) failures.push('longTakeShare')
  return { pass: failures.length === 0, failures }
}
