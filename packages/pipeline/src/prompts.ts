import type { ContentLocale } from '@studio/domain'
import { MAX_CONSECUTIVE_CARDS, type ShotRhythmSettings } from './content-audit.js'
import { parseStoryboardContract } from './storyboard-contract.js'
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

export function buildScriptPrompt(locale: ContentLocale, sourceContent: string, targetDurationMs?: number, rhythm?: ShotRhythmSettings): string {
  // 没有时长(旧集/未填)时一个字节都不变:缺省路径是既有行为的基线,不是特例。
  // 带时长时也只有这一个中文底模板——英文项目沿用「底模板 + withDirective 附加
  // 语言指令」的既有契约,不为时长另开英文底稿;该契约由测试逐字节钉死。
  if (targetDurationMs === undefined) {
    return withDirective(locale, `根据以下源文档，写出这一集的完整拍摄剧本：\n\n${sourceContent}`)
  }
  const rhythmRules = rhythm === undefined ? [] : storyRhythmRules(rhythm)
  return withDirective(locale, ['根据以下源文档，写出这一集的完整拍摄剧本。', '', ...durationRules(targetDurationMs), ...sceneRules(), ...rhythmRules, '', '源文档：', sourceContent].join('\n'))
}

/**
 * 节奏契约(plan_2026-10-24 §3)。写进剧本 prompt 而不是只写在分镜 prompt 里,因为
 * 一份自带分镜表的剧本会被下游逐行转录、不再重新估算——节奏决策只能在这一层做。
 * 三个阈值全部来自项目设置(缺省见 DEFAULT_SHOT_RHYTHM),不是写死的成片标准。
 */
function storyRhythmRules(rhythm: ShotRhythmSettings): string[] {
  const avgSeconds = (rhythm.avgShotMs / 1000).toFixed(1)
  const longSeconds = Math.round(rhythm.longTakeMinMs / 1000)
  const sharePercent = Math.round(rhythm.longTakeShareMin * 100)
  return [
    '',
    '分镜节奏契约（与场景标记同级；下面这张表会被分镜阶段逐行转录）：',
    '- 先写场次表：场次 / 地点·时间 / 在场人物 / 这场戏推进什么 / 从上场怎么进来 / 怎么退出到下场 / 声音床。',
    '- 再写镜头表：列 #｜时间｜时长｜场景｜镜头类型｜画面｜台词/VO｜声音｜生成方式，一行一镜。镜头类型只能是 主镜 / 插入 / 反应 / 空镜 / 字卡。',
    `- 每个场景至少 1 颗主镜，时长 ${longSeconds}–15 秒；主镜承载这一场最重要的连续动作或完整对白，不得把连续动作拆成多颗。`,
    '- 无对白的段落（情绪、空间、氛围）优先用一颗 6–12 秒的镜头，不要切成多颗短镜。',
    `- 全片平均镜长不低于 ${avgSeconds} 秒；≥${longSeconds} 秒的镜头合计占片长不低于 ${sharePercent}%。`,
    '- 每镜「声音」列写这一镜的环境音床（雨、脚步、电流、心跳…），允许写「无」。',
    '- 「时长」是这一镜的真值：分镜阶段按表转录，不会按内容重新估算。',
  ]
}

/**
 * 电影提炼层(阶段 5):整本小说 → 一部目标时长的电影剧本。这是提炼压缩,不是
 * 逐集改写——保留主线、砍支线是 prompt 的第一要求,篇幅预算与场景标记则和
 * buildScriptPrompt 共用同一套规则,让下游分镜照常按场景切块。
 */
export function buildFilmScriptPrompt(locale: ContentLocale, bookContent: string, targetDurationMs?: number, rhythm?: ShotRhythmSettings): string {
  // 与 buildScriptPrompt 同一口径:唯一中文底模板,英文项目靠 withDirective 附加。
  const distill = [
    '改编要求（最高优先级）：',
    '- 这是提炼，不是逐段改写：保留推动主线的关键人物与事件，果断砍掉支线情节、次要人物和重复桥段；故事必须讲完整。',
  ]
  const duration = targetDurationMs === undefined ? [] : durationRules(targetDurationMs)
  const rhythmRules = targetDurationMs === undefined || rhythm === undefined ? [] : storyRhythmRules(rhythm)
  return withDirective(locale, ['根据以下整部小说，提炼改编为一部完整电影的拍摄剧本。', '', ...distill, ...duration, ...sceneRules(), ...rhythmRules, '', '小说原文：', bookContent].join('\n'))
}

/**
 * How long the storyboard may make each shot. The floor is the bound model's declared
 * minimum; the ceiling is whichever is smallest of the project's tier, the bound
 * model's single-call maximum, and the product ceiling (30s). `totalMs` is the
 * episode (or segment) length the shots should add up to.
 */
export interface ShotDurationPlan {
  minMs: number
  maxMs: number
  totalMs?: number
  /** 项目节奏契约里的长镜门槛；主镜的下限从这里来（缺省 8 秒）。 */
  longTakeMinMs?: number
}

export function buildStoryboardPrompt(locale: ContentLocale, scriptContent: string, plan: ShotDurationPlan = { minMs: 5_000, maxMs: 5_000 }, shotBudget?: number, style?: StylePreset): string {
  // 单镜容量随绑定视频模型的能力伸缩:短模型一镜一句,长模型一镜能承载一整段
  // 对话。时长是给内容用的预算,不是每镜必须买满的固定值——短反应给短镜,
  // 完整台词和连续动作才需要更长。台词预算按自然语速(约 3.5 字/秒)折算,
  // 不让拆分写死在任何一个模型上。
  const maxShotMs = Math.max(plan.maxMs, plan.minMs)
  const minShotMs = Math.min(plan.maxMs, plan.minMs)
  const seconds = Math.max(1, Math.round(maxShotMs / 1000))
  const minSeconds = Math.max(1, Math.round(minShotMs / 1000))
  const dialogueBudget = Math.max(8, Math.round(seconds * 3.5))
  const flexible = minSeconds < seconds
  // 主镜下限取项目节奏契约里的长镜门槛，但不超过单镜上限——绑定的是 5 秒模型时，
  // 「主镜 8 秒」是买不到的要求，宁可让主镜占满 5 秒，也不写一条无法执行的契约。
  const mainSeconds = Math.max(minSeconds, Math.min(seconds, Math.round((plan.longTakeMinMs ?? 8_000) / 1000)))
  // 分段分镜(4b)传入的整集预算折算值:长剧本按段调用时,每段拿到自己那份
  // 镜头配额,防止每段都按"一集"的规模自由发挥导致总镜头数失控。
  const budgetRule = shotBudget === undefined ? '' : `\n- 镜头数量预算：本段剧本约拆 ${shotBudget} 个镜头（按整集目标时长对本段折算）。允许略有出入，但不得为凑数注水，也不得把多个视听瞬间塞进同一镜来压缩数量。`
  const styleTone = style ? `\n\n风格要求：${style.tone}` : ''
  // 剧本自带分镜表时，自由拆分的总时长规则让位给逐行转录：表里每一行的时长
  // 是作者已经定死的预算，再让模型「总数接近目标」只会诱导它压镜。
  const contract = parseStoryboardContract(scriptContent)
  const contractRules = contract
    ? [
        `分镜表契约（最高优先级，高于本提示中的所有自由拆分规则）：本剧本自带一张 ${contract.rows.length} 行的分镜表，合计 ${Math.round(contract.totalMs / 1000)} 秒。`,
        `- 必须按表的行序输出 ${contract.rows.length} 个镜头，一行一镜；不得增删、合并、拆分、重排。`,
        '- 每镜的 durationMs 必须原样采用该行「时长」列的秒数（如 6s → 6000）；不得按内容重新估算。',
        '- 每行「画面」列的内容必须完整进入该镜的 description；「字幕：」之后的字幕文字与「标题《…》」里的标题文字是屏幕上逐字出现的文本，必须原样保留，可以补写镜头描述但不能改写这些文字。',
        '- 「生成方式」为字卡、屏幕录制、UI/合成的行也必须输出；不要因为不是实拍视频而丢弃。',
        '- 「台词/VO」列里的「VO：」「系统音：」「创作者：」是声源标记，不是角色名：speaker 分别填 VO / 系统音 / 创作者，dialogue 只放冒号后的台词原文，不得把标记本身写进 dialogue。',
        '- 「台词/VO」列只写说话人时，台词原文在该行「画面」列里（如「系统音：…」）；必须完整放进 dialogue 并填 speaker，不得丢失或改写。',
        '- 「场景」列的数字就是该镜的 scene，按表原样使用。',
        '- 「镜头类型」列原样转录到 shotRole（主镜/插入/反应/空镜/字卡）；「转场」列原样转录到 transition（硬切/叠化/淡入/淡出/黑场/闪白），没有这一列或写「—」时填「硬切」；「声音」列原样转录到 sound，允许写「无」。',
        '- 如果给出的剧本只包含这张表的一部分（分段拆分），只转录本段出现的行，行序不变。',
      ]
    : []
  const totalRule = plan.totalMs === undefined || contract
    ? ''
    : `\n- 这些镜头的总时长应接近 ${Math.max(1, Math.round(plan.totalMs / 1000))} 秒（目标时长）；镜头数量按内容需要增减，不得为凑时长注水。`
  const mainShotRule = flexible
    ? `- 主镜优先：每个场景至少 1 颗 shotRole 为「主镜」的镜头，承载这一场最重要的连续动作或完整对白，时长 ${mainSeconds}–${seconds} 秒。连续动作不得为了缩短单镜而拆开；只有内容真的超过 ${seconds} 秒时，才在动作完成点拆成下一颗镜头，并把下一镜的 transition 写成该接缝需要的转场。`
    : `- 主镜优先：每个场景至少 1 颗 shotRole 为「主镜」的镜头，承载这一场最重要的连续动作或完整对白，占满 ${seconds} 秒。不得把一段连续动作切成多颗无信息的短镜；只有内容真的超过 ${seconds} 秒时，才在动作完成点拆镜。`
  const capacityRules = flexible
    ? [
        `分镜容量与节奏规则（最高优先级，单镜时长按 ${minSeconds}–${seconds} 秒规划，违反任何一条整集都会变成碎片拼贴）：`,
        mainShotRule,
        `- 一镜承载一个连续的视听瞬间，长度按内容需要取 ${minSeconds}–${seconds} 秒：开场、完整动作、情绪推进、空镜、单人长句对白都优先用一颗镜头；只有说话人特写切换、插入细节、字卡才取短。不得短于 ${minSeconds} 秒，也不得超过 ${seconds} 秒。`,
        `- 只有超过 ${seconds} 秒才能完成的长对话、多步动作序列才拆镜；不要为了凑满 ${seconds} 秒给短内容加无信息量的动作，也不要为了多切几刀把连续动作拆碎。`,
        '- 默认一镜一个说话人；同一空间、同一连续瞬间的双人对白，在后期配音下可以用 lines 一镜说完（每句带 speaker），不要为了「换说话人」拆成两颗无声反应镜。旁白与对白仍不得混入同一镜。',
        `- dialogue 必须是该说话人完整的一句话原文，总量不超过约 ${dialogueBudget} 个汉字（${seconds} 秒的自然语速）；这一镜计划更短时台词也要相应缩短或拆镜。禁止截成语气残句（如"……不……"）；剧本里的每一句台词都必须完整出现在某个镜头的 dialogue 或 lines 里，不得丢失、不得改写。`,
        '- description 必须呈现该镜台词的说话瞬间或其听者反应——画面与台词说的是同一件事。',
        `- 字卡只作锚点，不担叙事：连续 shotRole「字卡」不得超过 ${MAX_CONSECUTIVE_CARDS} 颗，超过即把该拍剧情改写成实拍镜头（落库前审计会拒收更长的连排）。`,
        `- durationMs 按这一镜实际需要填 ${minSeconds} 秒到 ${seconds} 秒之间的整数秒 × 1000，不要每镜都填 ${maxShotMs}。${budgetRule.trim()}${totalRule}`,
      ]
    : [
        `分镜容量与节奏规则（最高优先级，单镜时长按 ${seconds} 秒规划，违反任何一条整集都会变成碎片拼贴）：`,
        mainShotRule,
        `- 一镜承载一个连续的视听瞬间：description 描述的动作必须能在 ${seconds} 秒画面里完成，但不要为了切碎而切：反应、停顿和短动作可以给短镜，完整动作与完整对白优先给主镜。`,
        '- 默认一镜一个说话人；同一空间、同一连续瞬间的双人对白，在后期配音下可以用 lines 一镜说完（每句带 speaker），不要为了「换说话人」拆成两颗无声反应镜。旁白与对白仍不得混入同一镜。',
        `- dialogue 必须是该说话人完整的一句话原文，总量不超过约 ${dialogueBudget} 个汉字（${seconds} 秒的自然语速），禁止截成语气残句（如"……不……"）；剧本里的每一句台词都必须完整出现在某个镜头的 dialogue 或 lines 里，不得丢失、不得改写。`,
        '- description 必须呈现该镜台词的说话瞬间或其听者反应——画面与台词说的是同一件事。',
        `- durationMs 一律填 ${maxShotMs}（视频按 ${seconds} 秒生成）。${budgetRule.trim()}${totalRule}`,
      ]
  return withDirective(locale, [
    '把以下剧本拆分成连续的分镜镜头，并从中提取这一集要用到的角色、道具和场景。',
    '只输出一个 JSON 对象，不要任何其它说明，结构如下：',
    `{"shots":[{"title":"镜头标题","shotRole":"主镜/插入/反应/空镜/字卡","transition":"硬切/叠化/淡入/淡出/黑场/闪白","transitionMs":0,"description":"画面与动作","dialogue":"该镜头台词原文（不写说话人前缀；无台词留空字符串）","speaker":"该镜头说话人：角色名，或 VO / 系统音 / 创作者（无台词留空）","lines":[{"speaker":"角色名","text":"台词原文"}],"sourceExcerpt":"对应的剧本原文","durationMs":${maxShotMs},"scene":场次号,"location":"这一镜发生在哪","sound":"这一镜的环境音床（允许写 无）","continuityIn":"承接上一镜的具体空间事实","continuityOut":"本镜末帧画面里看得见的状态"}],`,
    '"assets":[{"kind":"character","name":"唯一名称","description":"外形与气质，用于生成参考图"}]}',
    ...contractRules,
    ...capacityRules,
    // 转场决策表（plan_2026-10-24 §5）：先看接缝有没有锚点——有锚点时硬切才对，
    // 没有锚点才需要过渡。不做「一键全加转场」：同场连续动作加叠化只会更差。
    '转场决策（每镜必带 transition，默认硬切）：',
    '- 同一动作跨切（手伸向门把 → 握住）、同一视线/构图/形状：硬切（cut），不加叠化。',
    '- 同一空间换机位或时间小幅推进：硬切（cut）；声音由合成层的音频桥接住，不需要画面过渡。',
    '- 跨空间、跨时间、跨世界（真人 ↔ 元叙事界面）：叠化（dissolve）或黑场过桥（black）。',
    '- 章节、字卡、世界切换：黑场（black）。字卡镜自身已有淡入淡出。',
    '- 情绪断裂或时间回环（「第 N 次」）：闪白（flash），约 1–2 帧。',
    '- transitionMs：硬切填 0；叠化/淡入/淡出/黑场填 300–500；闪白填 60。',
    // 同场空间锚点（2026-09-29 用户实测镜2：许知意在镜1坐在长桌边，镜2却不知在哪）——
    // 切镜换机位不换"谁在哪"，独立生成的首帧只有靠文字锚点才能守住空间。
    '同场空间锚点（与容量规则同级）：同一场景内相邻的镜头共享已确立的空间事实。',
    '- continuityIn 必须写具体空间事实，不许写"场景N内第X镜之后"这类纯顺序话：谁在什么位置/姿势、手里有什么、新入场者从画面哪一侧进入、双方视线方向。',
    '- description 对同场上一镜已在场的人物必须交代其位置沿用（如"许知意仍坐在长桌边，笔搁在协议上，抬头看向门口"），不得让已确立的位置凭空改变。',
    '- 场景切换（新地点/新时间）时 continuityIn 写"新场景：{地点与时间}"，两镜空间互不约束。',
    // 画面事实的稳定性（2026-10-21 实测四条成片缺陷的沉淀）。独立生成的首帧/视频只读
    // 得到镜头文本，所以凡"要靠模型自觉"的措辞都不算约束：四条都写成可核对的句子。
    '画面事实的稳定性（与空间锚点同级，违反任何一条都要付费重抽）：',
    '- 可数五金件只有一套：画面含门、窗、抽屉、箱体、器械等带开启五金件的对象时，description 必须写明该件的数量、所在立边与上下位置（如「门只有一套把手，位于右侧立边中部，左侧立边只有合页」）；同一处不得出现两套把手/锁芯/插销，description 未写的五金件不得在镜头中途长出来。',
    '- 穿着与体貌是状态不是事件：description 要写「全程穿着什么」（如「灰色连帽外套全程穿好、帽兜平搭颈后」），同一场次相邻镜头的服装与体貌措辞必须逐字一致；镜头中途不得穿脱或塌改衣物、不得改变胡茬长度或显龄。',
    '- continuityOut 必须是本镜末帧画面里看得见的状态：谁的手在哪、手里拿着什么、门是开还是关、物体停在画面哪个位置。不得写成"接下来他推门出去"这类纯顺序话——末帧是下一镜的起手画面，写不出可见末帧说明这一镜该与相邻镜合并或改写。',
    '- 带可读数字的道具（钟、屏幕、价签、字卡）只有在本镜 description 明确点名时才允许出现，且读数必须取剧本给定的值；未点名的镜头不得出现这类器具，免得画面自造出与剧情冲突的读数。',
    // 机位/景别（2026-09-29 用户拍板：没有镜头语言，独立生成的首帧各自为政，整体割裂）。
    // 词表钉死防 LLM 造词；放在 description 开头括号里，零 schema 改动直达首帧/视频提示词。
    // 运动标记不留"按需"的口子（2026-10-21 实测：全景固定机位的 2 秒镜被模型自行推到
    // 脸部大特写、末帧连门和手都出画）——不写运动就等于默许机位自走。
    '镜头语言（每镜必带）：description 必须以"（景别·机位·运动）"开头，景别从〔远景/全景/中景/近景/特写〕选一，机位/角度从〔平视/低角度/高角度俯拍/过肩/正面/侧面/背面〕选一，运动从〔固定机位/缓推/缓拉/横摇〕选一；三段用「·」分隔，缺一不可。',
    '- 未写明运动的镜头一律按〔固定机位〕处理，机位不许自行移动；需要推近或拉远的必须在同一段写明起止景别（如"（中景·平视·缓推至近景）"）。',
    '- 同一场内相邻镜头要交替景别（建立场景用全景，人物反应用近景或特写），不许连续三镜同景别；切镜的意义就是换一个观看位置。',
    '- scene 为场次号，从 1 起连续编号；同一场次的镜头必须在同一地点与时间段内，换地点或明显换时间即开新场次；每场第 1 镜用全景交代空间（它将作为该场画面基准）。',
    '- 每场都要有进出方式：第 1 镜的 continuityIn 写「新场景：{地点与时间}」并交代怎么从上一场进来；末镜的 continuityOut 写清退出方向或下一个可见状态，不要在场景中间凭空跳走。',
    'shots 按剧情先后排列，镜头编号由顺序决定，不要自己写。',
    'dialogue 只放这一镜真正说出口的台词原文，动作和旁白不要塞进去；没有台词的镜头留空字符串。',
    'lines 只在同一镜里确实有多句台词时出现（至少 2 句，每句带 speaker）；单句台词仍写 dialogue，lines 省略。',
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
