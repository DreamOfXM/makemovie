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
 * 分镜的体检。三条都取自 prompt 的成文要求：
 *
 * - 每镜要有 description。空描述让首帧没有可生成的画面，也让「按镜头文本匹配素材」
 *   的绑定整片失效——那是画面一致性的源头。
 * - scene 从 1 起连续编号。prompt 要求同一场次的镜头在同一地点与时间段内，换地点
 *   或明显换时间即开新场次，且逐场编号不得省略。
 * - scene 整集缺失不算错：旧模型不带该字段，全 null 与改造前的行为一致（content.ts
 *   落库时同样按 null 处理）。只有「一部分有、编号还对不上」才是违约。
 */
export function auditStoryboardShots(shots: readonly StoryboardShot[]): ContentFinding[] {
  const findings: ContentFinding[] = []
  if (shots.length === 0) return [{ code: 'storyboard:noShots', detail: '分镜没有产出任何镜头' }]

  const blank = shots.filter(shot => text(shot.description) === '').length
  if (blank > 0) findings.push({ code: 'storyboard:blankDescription', detail: `${blank} 个镜头没有画面描述` })

  const scenes = [...new Set(shots.map(shot => sceneNumber(shot.scene)).filter((n): n is number => n !== null))].sort((a, b) => a - b)
  if (scenes.length > 0 && (scenes[0] !== 1 || scenes.some((n, index) => n !== index + 1))) {
    findings.push({ code: 'storyboard:sceneGap', detail: `场次号不从 1 起、或有缺口：${scenes.join('、')}` })
  }
  return findings
}

/** 把体检结论压成一行，用作这一抽的失败原因。 */
export function describeFindings(findings: readonly ContentFinding[]): string {
  return findings.map(finding => `${finding.code}（${finding.detail}）`).join('；')
}
