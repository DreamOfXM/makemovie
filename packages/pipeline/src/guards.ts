/**
 * P7 Prompt 守卫:在"提示词组装完成"与"任务排队开烧"之间的最后一道机器检查。
 *
 * 守卫是一条有序规则链，挂在 triggerStage 这一个咽喉点上：每条守卫读到的是
 * 即将发给供应商的最终 prompt，产出四种裁决之一 —— pass / repair(改写法留痕)
 * / warn(只提醒不拦) / block(任务落 BLOCKED，不排队)。block 短路：拦下即止，
 * 后面的守卫不再为一条不会执行的任务修文字。
 *
 * 为什么默认全是规则闸而不是模型闸：模型检查有自己的失败模式(超时、误判、
 * 它自己也要烧一次调用)，规则闸零成本、零漂移、可单测。模型闸是 P7b 的可选
 * 增值项，不是地板。
 */

export type GuardStage = 'IMAGE' | 'VIDEO'

export interface GuardShotInfo {
  number: number
  title: string
  description: string
}

export interface GuardCharacterInfo {
  name: string
  description: string
  /** 角色名是否被画面文本(标题+描述)点名。点名 = 素材上下文已负责其外观。 */
  mentioned: boolean
}

export interface GuardContext {
  stage: GuardStage
  shot?: GuardShotInfo
  /** 该镜头绑定的素材总数；裸绑定守卫的依据。undefined = 数据缺失，不拦。 */
  boundAssetCount?: number
  /** 该镜头绑定的角色素材(含未点名者)；人物锚点守卫的依据。 */
  characters?: GuardCharacterInfo[]
}

export type GuardOutcome =
  | { action: 'pass' }
  | { action: 'repair'; prompt: string; note: string }
  | { action: 'warn'; note: string }
  | { action: 'block'; reason: string }

export interface PromptGuard {
  id: string
  stages: readonly GuardStage[]
  check(prompt: string, context: GuardContext): GuardOutcome
}

export interface GuardFinding {
  guard: string
  action: 'repair' | 'warn'
  note: string
}

export interface GuardedResult {
  prompt: string
  findings: GuardFinding[]
  blockedReason?: string
}

/**
 * 风格锚：短剧成片按真人实拍质感验收，但分镜文本从不承诺风格 ——
 * 没有锚时模型按训练分布自由发挥，"动漫的手"就是这么烧出来的。
 * 判定用标记词而非全等：人已经在 prompt 里写了风格就不要覆盖他的意图。
 */
export const VISUAL_STYLE_DIRECTIVE =
  '视觉风格基准：真人实拍电影质感，写实光影与自然色彩，电影级构图与景深；禁止动漫、卡通、Q版、手绘插画风格。'
const STYLE_MARKERS = ['真人实拍', '电影质感', '写实', 'photorealistic', 'cinematic']

const styleAnchor: PromptGuard = {
  id: 'style-anchor',
  stages: ['IMAGE', 'VIDEO'],
  check(prompt) {
    const haystack = prompt.toLowerCase()
    if (STYLE_MARKERS.some(marker => haystack.includes(marker.toLowerCase()))) return { action: 'pass' }
    return {
      action: 'repair',
      prompt: `${prompt}\n\n${VISUAL_STYLE_DIRECTIVE}`,
      note: '提示词未声明视觉风格，已追加「真人实拍电影质感」默认基准',
    }
  },
}

// 肢体词与人物名词：画面文本出现它们却没点名任何绑定角色，意味着这一镜里有入画的人，
// 但素材上下文的"只送被点名者"规则不会为其供锚 —— 长相就全靠模型想象力。
const PERSON_WORDS = ['男人', '女人', '老人', '老者', '少年', '少女', '女孩', '男孩', '青年', '人物', '身影', '背影', '面孔', '面容', '众人', '师徒', '父女', '父子', '母女', '母子']
const BODY_WORDS = ['手', '腕', '指', '臂', '掌', '眼', '眸', '瞳', '眉', '唇', '脸', '颊', '额', '鼻', '耳', '发', '须', '颈', '肩', '背', '胸', '腿', '膝', '脚', '身']
const PERSON_SIGNAL = new RegExp(`(${[...PERSON_WORDS, ...BODY_WORDS].join('|')})`)

const characterAnchor: PromptGuard = {
  id: 'character-anchor',
  stages: ['IMAGE', 'VIDEO'],
  check(prompt, context) {
    const unmentioned = (context.characters ?? []).filter(character => !character.mentioned && character.description.trim() !== '')
    if (unmentioned.length === 0) return { action: 'pass' }
    const shot = context.shot
    if (!shot || !PERSON_SIGNAL.test(`${shot.title} ${shot.description}`)) return { action: 'pass' }
    const picked = unmentioned.slice(0, 2)
    const lines = picked.map(character => `- ${character.name}：${character.description}`)
    return {
      action: 'repair',
      prompt: `${prompt}\n\n画面中出现的人物必须与以下已绑定角色的外观设定严格一致：\n${lines.join('\n')}`,
      note: `画面提及人物/肢体但未点名角色，已注入外观锚点：${picked.map(character => character.name).join('、')}`,
    }
  },
}

// 首帧是一张静止画面，"先…随后…最后"是时间序列：塞进去的结局必然是模型对
// 关键词的拼贴海报。拆镜是内容层的事，守卫只在烧之前提醒一次。
const SEQUENCE_MARKERS = ['随后', '接着', '然后', '继而', '渐渐', '缓缓', '先', '再', '最后', '与此同时', '片刻', '切换', '切至', '转为', '变为', '拉远', '推近', '推进', '拉近', '升起', '下移', '上移', '→', '->']

const motionSequence: PromptGuard = {
  id: 'motion-sequence',
  stages: ['IMAGE', 'VIDEO'],
  check(prompt, context) {
    const text = context.shot ? `${context.shot.title} ${context.shot.description}` : prompt
    const found = SEQUENCE_MARKERS.filter(marker => text.includes(marker))
    if (found.length < 2) return { action: 'pass' }
    return {
      action: 'warn',
      note: `画面文本含 ${found.length} 处时序推进（${found.slice(0, 5).join('、')}），首帧只能定格一个瞬间，建议拆镜或只保留核心瞬间`,
    }
  },
}

const unboundShot: PromptGuard = {
  id: 'bound-assets',
  stages: ['IMAGE'],
  check(prompt, context) {
    if (context.boundAssetCount === undefined || context.boundAssetCount > 0) return { action: 'pass' }
    return {
      action: 'block',
      reason: '该镜头未绑定任何素材（角色/场景/道具），首帧没有外观锚点，生成结果不可信；已拦下以免烧额度，请在分镜卡绑定素材后重试',
    }
  },
}

/** 默认守卫链。block 型在前：拦下即止，不为将死之题修文字。 */
export const DEFAULT_PROMPT_GUARDS: readonly PromptGuard[] = [unboundShot, styleAnchor, characterAnchor, motionSequence]

export function runPromptGuards(guards: readonly PromptGuard[], prompt: string, context: GuardContext): GuardedResult {
  const findings: GuardFinding[] = []
  let current = prompt
  for (const guard of guards) {
    if (!guard.stages.includes(context.stage)) continue
    const outcome = guard.check(current, context)
    if (outcome.action === 'pass') continue
    if (outcome.action === 'block') return { prompt: current, findings, blockedReason: outcome.reason }
    if (outcome.action === 'repair') {
      current = outcome.prompt
      findings.push({ guard: guard.id, action: 'repair', note: outcome.note })
    } else {
      findings.push({ guard: guard.id, action: 'warn', note: outcome.note })
    }
  }
  return { prompt: current, findings }
}
