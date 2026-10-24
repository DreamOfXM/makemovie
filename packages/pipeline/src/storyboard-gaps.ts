/**
 * 分镜文本的逐镜体检：落库之后、开烧之前，把「这一镜现在这样写，付费生成会出什么
 * 问题」逐镜列出来。
 *
 * 与 content-audit.ts 的分工是硬门与软检两层。那边在落库前只问字段在不在（没有
 * 时长、没有衔接就是交错了作业，直接拒收这一抽）；这里问的是**内容对不对得上它要
 * 生成的东西**——镜头语言缺段、末帧状态写成了过程、说话人不在角色档案、画面里长出
 * 剧本没有的读数。这类判据一旦放进硬门就会误拦，而误拦一次的代价是白烧一次生成。
 * 所以这里一条都不拦：它只把结论摆到镜头卡和预审门上，让人在花钱之前看见。
 *
 * 判据全部取自 prompts.ts 的成文契约（「镜头语言（每镜必带）」「continuityOut 必须
 * 是末帧画面里看得见的状态」「带可读数字的道具……读数必须取剧本给定的值」），不掺
 * 品味判断。凡是只能靠读画面才知道的缺陷（五金件长出第二套、外套塌成卷边）不归这
 * 里，归付费产物的审核侧。
 *
 * 中英共用一份判据的做法：能对**结构**判的就不对**词**判。镜头语言用括号与「·」的
 * 段数判，读数用数字串判，这两条与输出语言无关。只有「写成过程」依赖中文时序词，
 * 英文分镜上它恒为不命中——漏报一条软提示，不会误拦，也不会给英文项目造假缺陷。
 */

import { SEQUENCE_MARKERS } from './guards.js'
import { shotProduction } from './shot-method.js'

export interface StoryboardGapShot {
  id: string
  description: string
  dialogue: string
  speaker: string | null
  continuityIn: string | null
  continuityOut: string | null
  durationMs: number
  method: string | null
}

export interface StoryboardGapOptions {
  /** 本集角色档案（asset kind=character）的名字。空数组时跳过说话人核对——没有档案就没资格判越名。 */
  castNames?: readonly string[]
  /** 已批准的剧本正文，用于核对画面里的可读数字。缺省则跳过该检。 */
  scriptContent?: string | null
  /** 当前绑定链能买到的最短单镜时长（ms）。低于它的镜头会被厂商抬到这个地板：多买的秒数花的是钱。 */
  minDurationMs?: number | null
}

/** 台词声源的成文标记：prompt 要求 speaker 逐字填 VO / 系统音 / 创作者，它们不是角色名。
 *  英文项目由模型译成同义说法，一并收进白名单——漏收只会多提示，不会少提示。 */
const SOURCE_MARKER = /^(VO|voice[- ]?over|narrator|系统音|创作者|system|creator)$/i

/** 括号里必须数得出三段（景别·机位·运动）。只数结构，不认词，因此中英文输出同一判据。 */
const CAMERA_GROUP = /^[（(]([^）)]{2,})[）)]/

/**
 * 上屏文本的成文写法。这些字要出现在画面上，就得由本机的字卡镜或合成的字幕层来画
 * （`packages/media/src/index.ts:1120` 的 burn 路径）；写进实拍镜的描述等于请模型
 * 把字烧进动作帧，而且模型真的会照办——实测一版 4 秒里有 1.2 秒是它自己长出来的
 * 黑底计数卡，买的是画面的钱、退回来的是字卡。
 *
 * 判据按句子位置收紧，不按词命中：「黑屏」「第 N 次」只有独立成句才是在要字，
 * 「他盯着黑屏的手机」「这是他第 3 次尝试」是在描述画面或剧情，不许报。字幕、字卡、
 * 标题《》没有正当的句中用法，出现即报。英文同等写法一并收；漏收只会少一条软提示。
 */
const ON_SCREEN_TEXT: readonly RegExp[] = [
  /字幕/,
  /字卡/,
  /标题《/,
  /(^|[。；;])\s*黑屏/,
  /(^|[。；;])\s*第\s*\d+\s*次/,
  /\bsub-?titles?\b/i,
  /\bcaption\b/i,
  /\btitle card\b/i,
  /(^|[.;])\s*black screen/i,
]

function readouts(text: string): string[] {
  const found = text.match(/\d{1,2}[:：]\d{2}/g) ?? []
  return [...new Set(found.map(value => value.replace('：', ':').replace(/^0(\d):/, '$1:')))]
}

function bareCastName(name: string): string {
  return name.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
}

function matchedCast(speaker: string, castNames: readonly string[]): boolean {
  const value = bareCastName(speaker)
  if (value === '') return false
  return castNames.some(name => {
    const cast = bareCastName(name)
    return cast !== '' && (cast === value || cast.includes(value) || value.includes(cast))
  })
}

/**
 * 逐镜体检。返回镜头 id → 缺口代码（snake_case，与 shotboard 的 attention 同一形态）。
 * 输入必须是本集在册镜头按出片顺序排好的数组：首镜与末镜的判据依赖它在序列里的位置。
 */
export function inspectStoryboardGaps(shots: readonly StoryboardGapShot[], options: StoryboardGapOptions = {}): Map<string, string[]> {
  const gaps = new Map<string, string[]>()
  const castNames = options.castNames ?? []
  const scriptReadouts = options.scriptContent ? readouts(options.scriptContent) : null
  const last = shots.length - 1

  shots.forEach((shot, index) => {
    const found: string[] = []
    const description = (shot.description ?? '').trim()
    const video = shotProduction(shot.method) === 'video'

    if (video) {
      const group = CAMERA_GROUP.exec(description)
      if (!group) {
        found.push('camera_mark_missing')
      } else if (group[1].split(/[·・]/).filter(part => part.trim() !== '').length < 3) {
        found.push('camera_movement_missing')
      }
      if (ON_SCREEN_TEXT.some(pattern => pattern.test(description))) found.push('on_screen_text_in_shot')
    }

    if (index > 0 && (shot.continuityIn ?? '').trim() === '') found.push('continuity_in_missing')
    const out = (shot.continuityOut ?? '').trim()
    if (index < last && out === '') found.push('continuity_out_missing')
    // 时序推进写进末帧，末帧就成了「这一镜讲完的故事」而不是「下一镜的起手画面」；
    // 与 motion-sequence 守卫同一阈值、同一词表。
    if (out !== '' && SEQUENCE_MARKERS.filter(marker => out.includes(marker)).length >= 2) found.push('continuity_out_process')

    const dialogue = (shot.dialogue ?? '').trim()
    const speaker = (shot.speaker ?? '').trim()
    if (dialogue !== '' && speaker === '') found.push('dialogue_without_speaker')
    if (speaker !== '' && castNames.length > 0 && !SOURCE_MARKER.test(speaker) && !matchedCast(speaker, castNames)) found.push('speaker_not_in_cast')

    if (scriptReadouts && description !== '') {
      const foreign = readouts(description).filter(value => !scriptReadouts.includes(value))
      if (foreign.length > 0) found.push('readout_not_in_script')
    }

    if (options.minDurationMs && shot.durationMs > 0 && shot.durationMs < options.minDurationMs) found.push('duration_below_floor')

    if (found.length > 0) gaps.set(shot.id, found)
  })

  return gaps
}
