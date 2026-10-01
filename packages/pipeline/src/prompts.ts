import type { ContentLocale } from '@studio/domain'
import type { StylePreset } from './styles/index.js'

/**
 * The prompt text for the stages that *write content* (script, storyboard, music
 * brief). Everything downstream — an image of a shot, a clip, a voice line — is
 * assembled from content this module already produced, so a project's language is
 * decided once here and carries itself through the rest of the chain.
 *
 * Chinese is the base template and the non-Chinese languages are an instruction
 * block appended to it. `outputLanguageDirective('zh')` returns the empty string,
 * so a Chinese project sends exactly the bytes it sent before this module existed:
 * the default path costs nothing and cannot regress.
 */

/**
 * Highest-priority language contract for a non-Chinese project.
 *
 * The protocol literals are spelled out because our structured output is JSON in
 * the message body, not a tool call: a model that helpfully translates `"shots"`
 * or emits `kind: "人物"` produces a response the parser cannot read, and the
 * storyboard worker turns that into zero assets rather than an error. Naming the
 * keys is what keeps an English episode parseable.
 */
export function outputLanguageDirective(locale: ContentLocale): string {
  if (locale === 'zh') return ''
  return [
    '## Output language (highest priority)',
    'Write every piece of content in English: titles, descriptions, dialogue, speaker names and continuity notes.',
    'This overrides anything above that asks for Chinese. The Chinese strings in the example are placeholders describing what each field holds — do not copy them into the answer.',
    'These literals are part of the response contract, not content. Reproduce them verbatim in ASCII, or the answer cannot be parsed:',
    '- JSON keys: shots, title, description, dialogue, speaker, sourceExcerpt, durationMs, continuityIn, continuityOut, assets, kind, name',
    '- kind values: character, prop, scene',
  ].join('\n')
}

function withDirective(locale: ContentLocale, base: string): string {
  const directive = outputLanguageDirective(locale)
  return directive === '' ? base : `${base}\n\n${directive}`
}

// 剧本篇幅按口语语速折算:中文每分钟约 350 字,英文每分钟约 180 词。两个速率
// 都写进 prompt,让模型按自己的输出语言自控——预算是给模型的约束,不是给调用方的。
const SCRIPT_CHARS_PER_MINUTE = 350
const SCRIPT_WORDS_PER_MINUTE = 180

function durationMinutes(targetDurationMs: number): number {
  return Math.max(1, Math.round(targetDurationMs / 60_000))
}

/**
 * 时长预算 + 场景分段要求。场景标记（中文「场景 1」/ 英文 "SCENE 1"）是第 4b 步
 * 分镜切块的锚点:剧本 prompt 钉下标记,分镜才能按场切块——两步是配套的,改标记
 * 格式必须同时改 storyboard.ts 的识别正则。
 */
function durationRules(targetDurationMs: number): string[] {
  const minutes = durationMinutes(targetDurationMs)
  const charBudget = minutes * SCRIPT_CHARS_PER_MINUTE
  const wordBudget = minutes * SCRIPT_WORDS_PER_MINUTE
  return [
    '时长与结构要求（最高优先级）：',
    `- 本集目标时长约 ${minutes} 分钟。`,
    `- 篇幅预算：中文剧本全篇约 ${charBudget} 字以内，英文剧本约 ${wordBudget} 词以内（按每分钟约 ${SCRIPT_CHARS_PER_MINUTE} 字 / ${SCRIPT_WORDS_PER_MINUTE} 词折算）。宁可精炼，不得注水。`,
  ]
}

// 场景标记规则独立于时长:没有时长的集剧本走旧基线(不含此行),而电影剧本无论
// 有无时长都必须场景化——它的分镜注定要按场景切块。标记中英各表(模型按输出
// 语言自然选择),storyboard.ts 的 SCENE_MARKER 两种都认;改这里必须同核那边。
function sceneRules(): string[] {
  return [
    '- 剧本必须按场景分段：每个场景以「场景 1」「场景 2」……这样的场景标记行开头（标记独占一行，场景正文写在标记之后）。场景标记是后续分镜切分的锚点，必须逐场编号、不得省略。',
  ]
}

export function buildScriptPrompt(locale: ContentLocale, sourceContent: string, targetDurationMs?: number): string {
  // 没有时长(旧集/未填)时一个字节都不变:缺省路径是既有行为的基线,不是特例。
  // 带时长时也只有这一个中文底模板——英文项目沿用「底模板 + withDirective 附加
  // 语言指令」的既有契约,不为时长另开英文底稿;该契约由测试逐字节钉死。
  if (targetDurationMs === undefined) {
    return withDirective(locale, `根据以下源文档，写出这一集的完整拍摄剧本：\n\n${sourceContent}`)
  }
  return withDirective(locale, ['根据以下源文档，写出这一集的完整拍摄剧本。', '', ...durationRules(targetDurationMs), ...sceneRules(), '', '源文档：', sourceContent].join('\n'))
}

/**
 * 电影提炼层(阶段 5):整本小说 → 一部目标时长的电影剧本。这是提炼压缩,不是
 * 逐集改写——保留主线、砍支线是 prompt 的第一要求,篇幅预算与场景标记则和
 * buildScriptPrompt 共用同一套规则,让下游分镜照常按场景切块。
 */
export function buildFilmScriptPrompt(locale: ContentLocale, bookContent: string, targetDurationMs?: number): string {
  // 与 buildScriptPrompt 同一口径:唯一中文底模板,英文项目靠 withDirective 附加。
  const distill = [
    '改编要求（最高优先级）：',
    '- 这是提炼，不是逐段改写：保留推动主线的关键人物与事件，果断砍掉支线情节、次要人物和重复桥段；故事必须讲完整。',
  ]
  const duration = targetDurationMs === undefined ? [] : durationRules(targetDurationMs)
  return withDirective(locale, ['根据以下整部小说，提炼改编为一部完整电影的拍摄剧本。', '', ...distill, ...duration, ...sceneRules(), '', '小说原文：', bookContent].join('\n'))
}

export function buildStoryboardPrompt(locale: ContentLocale, scriptContent: string, targetShotMs = 5_000, shotBudget?: number, style?: StylePreset): string {
  // 单镜容量随绑定视频模型的能力伸缩:5 秒的免费档一镜一句,30 秒的模型一镜
  // 能承载一整段对话。台词预算按自然语速(约 3.5 字/秒)折算,不让拆分写死在
  // 任何一个模型上。
  const seconds = Math.max(1, Math.round(targetShotMs / 1000))
  const dialogueBudget = Math.max(8, Math.round(seconds * 3.5))
  // 分段分镜(4b)传入的整集预算折算值:长剧本按段调用时,每段拿到自己那份
  // 镜头配额,防止每段都按"一集"的规模自由发挥导致总镜头数失控。
  const budgetRule = shotBudget === undefined ? '' : `\n- 镜头数量预算：本段剧本约拆 ${shotBudget} 个镜头（按整集目标时长对本段折算）。允许略有出入，但不得为凑数注水，也不得把多个视听瞬间塞进同一镜来压缩数量。`
  const styleTone = style ? `\n\n风格要求：${style.tone}` : ''
  return withDirective(locale, [
    '把以下剧本拆分成连续的分镜镜头，并从中提取这一集要用到的角色、道具和场景。',
    '只输出一个 JSON 对象，不要任何其它说明，结构如下：',
    `{"shots":[{"title":"镜头标题","description":"画面与动作","dialogue":"该镜头台词原文（无台词留空字符串）","speaker":"该镜头说话人（无台词留空）","sourceExcerpt":"对应的剧本原文","durationMs":${targetShotMs},"scene":场次号,"continuityIn":"承接上一镜","continuityOut":"留给下一镜"}],`,
    '"assets":[{"kind":"character","name":"唯一名称","description":"外形与气质，用于生成参考图"}]}',
    `拆分容量规则（最高优先级，单镜时长按 ${seconds} 秒规划，违反任何一条整集都会变成碎片拼贴）：`,
    `- 一个镜头只承载一个连续的视听瞬间：description 描述的动作必须能在 ${seconds} 秒画面里完成。超出 ${seconds} 秒能力的长对话、多步动作序列必须拆成多个镜头；宁可多拆，不许塞爆。`,
    '- 一个镜头的 speaker 只能有一个；说话人切换就是切镜头（对方回应单独成镜）。旁白与对白不得混入同一镜。',
    `- dialogue 必须是该说话人完整的一句话原文，总量不超过约 ${dialogueBudget} 个汉字（${seconds} 秒的自然语速），禁止截成语气残句（如"……不……"）；剧本里的每一句台词都必须完整出现在某个镜头的 dialogue 里，不得丢失、不得改写。`,
    '- description 必须呈现该镜台词的说话瞬间或其听者反应——画面与台词说的是同一件事。',
    `- durationMs 一律填 ${targetShotMs}（视频按 ${seconds} 秒生成）。${budgetRule.trim()}`,
    // 同场空间锚点（2026-09-29 用户实测镜2：许知意在镜1坐在长桌边，镜2却不知在哪）——
    // 切镜换机位不换"谁在哪"，独立生成的首帧只有靠文字锚点才能守住空间。
    '同场空间锚点（与容量规则同级）：同一场景内相邻的镜头共享已确立的空间事实。',
    '- continuityIn 必须写具体空间事实，不许写"场景N内第X镜之后"这类纯顺序话：谁在什么位置/姿势、手里有什么、新入场者从画面哪一侧进入、双方视线方向。',
    '- description 对同场上一镜已在场的人物必须交代其位置沿用（如"许知意仍坐在长桌边，笔搁在协议上，抬头看向门口"），不得让已确立的位置凭空改变。',
    '- 场景切换（新地点/新时间）时 continuityIn 写"新场景：{地点与时间}"，两镜空间互不约束。',
    // 机位/景别（2026-09-29 用户拍板：没有镜头语言，独立生成的首帧各自为政，整体割裂）。
    // 词表钉死防 LLM 造词；放在 description 开头括号里，零 schema 改动直达首帧/视频提示词。
    '镜头语言（每镜必带）：description 必须以"（景别·机位）"开头，景别从〔远景/全景/中景/近景/特写〕选一，机位/角度从〔平视/低角度/高角度俯拍/过肩/正面/侧面/背面〕选一；涉及运动再附〔固定机位/缓推/缓拉/横摇〕。',
    '- 同一场内相邻镜头要交替景别（建立场景用全景，人物反应用近景或特写），不许连续三镜同景别；切镜的意义就是换一个观看位置。',
    '- scene 为场次号，从 1 起连续编号；同一场次的镜头必须在同一地点与时间段内，换地点或明显换时间即开新场次；每场第 1 镜用全景交代空间（它将作为该场画面基准）。',
    'shots 按剧情先后排列，镜头编号由顺序决定，不要自己写。',
    'dialogue 只放这一镜真正说出口的台词原文，动作和旁白不要塞进去；没有台词的镜头留空字符串。',
    'assets 的 kind 只能是 character、prop、scene 三者之一，同一个人物或物件只写一次。',
    '',
    '剧本：',
    scriptContent,
  ].join('\n') + styleTone)
}

/**
 * The music brief is built from the script, so it is truncated here rather than at
 * the call site: the budget belongs to the prompt, and a model that is paid per
 * input unit should not have the limit moved on it by whoever calls it next.
 */
export function buildMusicPrompt(locale: ContentLocale, scriptContent: string): string {
  return withDirective(locale, `为这一集制作一段可循环的纯器乐背景音乐，贴合以下剧情的情绪与节奏：\n\n${scriptContent.slice(0, 4000)}`)
}

/**
 * How a shot's line is handed to a voice model: just the words to speak.
 *
 * The speaker name used to travel in the text as 【说话人】 / "Speaker:" — but TTS
 * models read it aloud ("许知意，我妈第二次开口…"), which nobody wants in the master.
 * The speaker selects the voice (via the asset's bound voice profile or the model's
 * own routing); it must not be part of the spoken text. (2026-09-30 user report.)
 */
export function voiceLine(_locale: ContentLocale, _speaker: string | null, dialogue: string): string {
  return dialogue
}
