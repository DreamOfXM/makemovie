import { describe, expect, it } from 'vitest'
import { buildFilmScriptPrompt, buildMusicPrompt, buildScriptPrompt, buildStoryboardPrompt, outputLanguageDirective, voiceLine } from '../src/prompts.js'

// The bytes a Chinese project sent before content languages existed. Restated here
// rather than derived from the builders, so changing a template has to be decided
// twice: once in the prompt, once in this file.
const SCRIPT_ZH_BASELINE = '根据以下源文档，写出这一集的完整拍摄剧本：\n\n剧本素材：雨夜失踪案'
const STORYBOARD_ZH_BASELINE = [
  '把以下剧本拆分成连续的分镜镜头，并从中提取这一集要用到的角色、道具和场景。',
  '只输出一个 JSON 对象，不要任何其它说明，结构如下：',
  '{"shots":[{"title":"镜头标题","shotRole":"主镜/插入/反应/空镜/字卡","transition":"硬切/叠化/淡入/淡出/黑场/闪白","transitionMs":0,"description":"画面与动作","dialogue":"该镜头台词原文（不写说话人前缀；无台词留空字符串）","speaker":"该镜头说话人：角色名，或 VO / 系统音 / 创作者（无台词留空）","lines":[{"speaker":"角色名","text":"台词原文"}],"sourceExcerpt":"对应的剧本原文","durationMs":5000,"scene":场次号,"location":"这一镜发生在哪","sound":"这一镜的环境音床（允许写 无）","continuityIn":"承接上一镜的具体空间事实","continuityOut":"本镜末帧画面里看得见的状态"}],',
  '"assets":[{"kind":"character","name":"唯一名称","description":"外形与气质，用于生成参考图"}]}',
  '分镜容量与节奏规则（最高优先级，单镜时长按 5 秒规划，违反任何一条整集都会变成碎片拼贴）：',
  '- 主镜优先：每个场景至少 1 颗 shotRole 为「主镜」的镜头，承载这一场最重要的连续动作或完整对白，占满 5 秒。不得把一段连续动作切成多颗无信息的短镜；只有内容真的超过 5 秒时，才在动作完成点拆镜。',
  '- 一镜承载一个连续的视听瞬间：description 描述的动作必须能在 5 秒画面里完成，但不要为了切碎而切：反应、停顿和短动作可以给短镜，完整动作与完整对白优先给主镜。',
  '- 默认一镜一个说话人；同一空间、同一连续瞬间的双人对白，在后期配音下可以用 lines 一镜说完（每句带 speaker），不要为了「换说话人」拆成两颗无声反应镜。旁白与对白仍不得混入同一镜。',
  '- dialogue 必须是该说话人完整的一句话原文，总量不超过约 18 个汉字（5 秒的自然语速），禁止截成语气残句（如"……不……"）；剧本里的每一句台词都必须完整出现在某个镜头的 dialogue 或 lines 里，不得丢失、不得改写。',
  '- description 必须呈现该镜台词的说话瞬间或其听者反应——画面与台词说的是同一件事。',
  '- durationMs 一律填 5000（视频按 5 秒生成）。',
  '转场决策（每镜必带 transition，默认硬切）：',
  '- 同一动作跨切（手伸向门把 → 握住）、同一视线/构图/形状：硬切（cut），不加叠化。',
  '- 同一空间换机位或时间小幅推进：硬切（cut）；声音由合成层的音频桥接住，不需要画面过渡。',
  '- 跨空间、跨时间、跨世界（真人 ↔ 元叙事界面）：叠化（dissolve）或黑场过桥（black）。',
  '- 章节、字卡、世界切换：黑场（black）。字卡镜自身已有淡入淡出。',
  '- 情绪断裂或时间回环（「第 N 次」）：闪白（flash），约 1–2 帧。',
  '- transitionMs：硬切填 0；叠化/淡入/淡出/黑场填 300–500；闪白填 60。',
  '同场空间锚点（与容量规则同级）：同一场景内相邻的镜头共享已确立的空间事实。',
  '- continuityIn 必须写具体空间事实，不许写"场景N内第X镜之后"这类纯顺序话：谁在什么位置/姿势、手里有什么、新入场者从画面哪一侧进入、双方视线方向。',
  '- description 对同场上一镜已在场的人物必须交代其位置沿用（如"许知意仍坐在长桌边，笔搁在协议上，抬头看向门口"），不得让已确立的位置凭空改变。',
  '- 场景切换（新地点/新时间）时 continuityIn 写"新场景：{地点与时间}"，两镜空间互不约束。',
  '画面事实的稳定性（与空间锚点同级，违反任何一条都要付费重抽）：',
  '- 可数五金件只有一套：画面含门、窗、抽屉、箱体、器械等带开启五金件的对象时，description 必须写明该件的数量、所在立边与上下位置（如「门只有一套把手，位于右侧立边中部，左侧立边只有合页」）；同一处不得出现两套把手/锁芯/插销，description 未写的五金件不得在镜头中途长出来。',
  '- 穿着与体貌是状态不是事件：description 要写「全程穿着什么」（如「灰色连帽外套全程穿好、帽兜平搭颈后」），同一场次相邻镜头的服装与体貌措辞必须逐字一致；镜头中途不得穿脱或塌改衣物、不得改变胡茬长度或显龄。',
  '- continuityOut 必须是本镜末帧画面里看得见的状态：谁的手在哪、手里拿着什么、门是开还是关、物体停在画面哪个位置。不得写成"接下来他推门出去"这类纯顺序话——末帧是下一镜的起手画面，写不出可见末帧说明这一镜该与相邻镜合并或改写。',
  '- 带可读数字的道具（钟、屏幕、价签、字卡）只有在本镜 description 明确点名时才允许出现，且读数必须取剧本给定的值；未点名的镜头不得出现这类器具，免得画面自造出与剧情冲突的读数。',
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
  '沈亦在雨夜捡起半张老照片。',
].join('\n')
const MUSIC_ZH_BASELINE = `为这一集制作一段可循环的纯器乐背景音乐，贴合以下剧情的情绪与节奏：\n\n沈亦在雨夜捡起半张老照片。`

// What the worker's parser matches on. An English reply that translates any of these
// is not a style miss, it is zero shots and zero assets.
const PROTOCOL_LITERALS = [
  'shots', 'assets', 'title', 'description', 'dialogue', 'speaker', 'sourceExcerpt',
  'durationMs', 'continuityIn', 'continuityOut', 'kind', 'name',
  'character', 'prop', 'scene',
]

const SOURCE = '剧本素材：雨夜失踪案'
const SCRIPT = '沈亦在雨夜捡起半张老照片。'

describe('buildStoryboardPrompt duration budget', () => {
  it('defaults to the 5-second free-tier cadence', () => {
    const prompt = buildStoryboardPrompt('zh', SCRIPT)
    expect(prompt).toContain('"durationMs":5000')
    expect(prompt).toContain('单镜时长按 5 秒规划')
    expect(prompt).toContain('总量不超过约 18 个汉字')
  })

  it('asks each shot for the length the story needs, inside the model range', () => {
    const prompt = buildStoryboardPrompt('zh', SCRIPT, { minMs: 4_000, maxMs: 15_000 })
    expect(prompt).toContain('"durationMs":15000')
    expect(prompt).toContain('单镜时长按 4–15 秒规划')
    expect(prompt).toContain('按这一镜实际需要填 4 秒到 15 秒之间的整数秒')
    expect(prompt).toContain('不要每镜都填 15000')
    // 15 秒自然语速的上限,只约束单镜不是每镜都要说满。
    expect(prompt).toContain('总量不超过约 53 个汉字')
  })

  it('aims the shots at the episode or segment length without padding', () => {
    const prompt = buildStoryboardPrompt('zh', SCRIPT, { minMs: 4_000, maxMs: 15_000, totalMs: 60_000 })
    expect(prompt).toContain('这些镜头的总时长应接近 60 秒')
    expect(prompt).toContain('不得为凑时长注水')
  })

  it('keeps a genuinely fixed model on one value', () => {
    // Wan 2.2 一类只接受单一时长:范围退化成一个值,旧基线字节不变。
    const prompt = buildStoryboardPrompt('zh', SCRIPT, { minMs: 5_000, maxMs: 5_000 })
    expect(prompt).toContain('单镜时长按 5 秒规划')
    expect(prompt).toContain('durationMs 一律填 5000')
    expect(prompt).not.toContain('按这一镜实际需要填')
  })
})

describe('storyboard table contract (6)', () => {
  const SCRIPT_WITH_TABLE = [
    '## 分镜表',
    '| # | 时间 | 时长 | 场景 | 画面 | 台词/VO | 声音 | 生成方式 |',
    '|---|---|---|---|---|---|---|---|',
    '| 1 | 0:00–0:03 | 3s | 卧室 | （全景·平视）陈默睁眼 | — | 低频 | 视频 |',
    '| 2 | 0:03–0:09 | 6s | 字卡 | 字幕：本片由 MakeMovie 生成 | — | 低频 | 字卡 |',
    '| 3 | 0:09–0:13 | 4s | 字卡 | MakeMovie logo / URL | — | 收尾音 | 字卡 |',
  ].join('\n')

  it('turns the script-side table into row-by-row transcription rules', () => {
    const prompt = buildStoryboardPrompt('zh', SCRIPT_WITH_TABLE, { minMs: 4_000, maxMs: 15_000, totalMs: 13_000 })
    expect(prompt).toContain('本剧本自带一张 3 行的分镜表，合计 13 秒')
    expect(prompt).toContain('必须按表的行序输出 3 个镜头')
    expect(prompt).toContain('durationMs 必须原样采用该行「时长」列的秒数')
    expect(prompt).toContain('「标题《…》」里的标题文字')
    expect(prompt).toContain('台词原文在该行「画面」列里')
    // VO 是声源标记而不是角色名：prompt 必须把标记与台词分开，否则模型会把
    // 「VO：」整个当说话人、把标记留在 dialogue 里（2026-10-20 实测镜 2/6/21/27）。
    expect(prompt).toContain('「VO：」「系统音：」「创作者：」是声源标记')
    expect(prompt).toContain('speaker 分别填 VO / 系统音 / 创作者')
    expect(prompt).toContain('不得把标记本身写进 dialogue')
    // 有契约时不再让模型按「总时长接近目标」自由删减镜头。
    expect(prompt).not.toContain('这些镜头的总时长应接近')
  })

  it('keeps the free-split rules for a script without a storyboard table', () => {
    const prompt = buildStoryboardPrompt('zh', SCRIPT, { minMs: 5_000, maxMs: 5_000, totalMs: 60_000 })
    expect(prompt).not.toContain('分镜表契约')
    expect(prompt).toContain('这些镜头的总时长应接近 60 秒')
  })
})

describe('outputLanguageDirective', () => {
  it('adds nothing to a Chinese project', () => {
    expect(outputLanguageDirective('zh')).toBe('')
  })

  it('spells out every protocol literal an English reply has to keep', () => {
    const directive = outputLanguageDirective('en')
    for (const literal of PROTOCOL_LITERALS) expect(directive).toContain(literal)
  })
})

describe('content prompts', () => {
  it('sends a Chinese project the bytes it has always sent', () => {
    expect(buildScriptPrompt('zh', SOURCE)).toBe(SCRIPT_ZH_BASELINE)
    expect(buildStoryboardPrompt('zh', SCRIPT)).toBe(STORYBOARD_ZH_BASELINE)
    expect(buildMusicPrompt('zh', SCRIPT)).toBe(MUSIC_ZH_BASELINE)
  })

  it('keeps the Chinese base and appends the directive for an English project', () => {
    for (const prompt of [buildScriptPrompt('en', SOURCE), buildStoryboardPrompt('en', SCRIPT), buildMusicPrompt('en', SCRIPT)]) {
      expect(prompt).toContain('## Output language (highest priority)')
      expect(prompt).toContain('Write every piece of content in English')
    }
    expect(buildScriptPrompt('en', SOURCE).startsWith(SCRIPT_ZH_BASELINE)).toBe(true)
    // The contract the model is asked to obey is stated once, in the base template,
    // and survives untouched under the directive.
    expect(buildStoryboardPrompt('en', SCRIPT)).toContain('"continuityOut":"本镜末帧画面里看得见的状态"')
    expect(buildStoryboardPrompt('en', SCRIPT)).toContain('画面事实的稳定性')
    expect(buildStoryboardPrompt('en', SCRIPT)).toContain(SCRIPT)
  })

  it('caps the script a music brief is built from', () => {
    const prompt = buildMusicPrompt('zh', '一'.repeat(5000))
    expect(prompt.endsWith(`\n\n${'一'.repeat(4000)}`)).toBe(true)
    expect(prompt).not.toContain('一'.repeat(4001))
  })
})

describe('script duration budget (4a)', () => {
  it('adds nothing when no target duration is given, not even an explicit undefined', () => {
    expect(buildScriptPrompt('zh', SOURCE)).toBe(SCRIPT_ZH_BASELINE)
    expect(buildScriptPrompt('zh', SOURCE, undefined)).toBe(SCRIPT_ZH_BASELINE)
  })

  it('states minutes, both pacing rates and the scene markers a Chinese episode must use', () => {
    const prompt = buildScriptPrompt('zh', SOURCE, 180_000)
    expect(prompt).toContain('约 3 分钟')
    expect(prompt).toContain('1050 字')
    expect(prompt).toContain('540 词')
    expect(prompt).toContain('每分钟约 350 字')
    expect(prompt).toContain('「场景 1」')
    // 场景标记是 4b 分段切块的锚点,prompt 必须把"逐场编号、不得省略"说死。
    expect(prompt).toContain('不得省略')
  })

  it('keeps the Chinese base for an English episode and appends the directive, as everywhere else', () => {
    const prompt = buildScriptPrompt('en', SOURCE, 180_000)
    // 既有契约:英文项目 = 中文底模板 + 附加语言指令,时长规则不另开英文底稿。
    expect(prompt).toContain('根据以下源文档')
    expect(prompt).toContain('约 3 分钟')
    expect(prompt).toContain('「场景 1」')
    expect(prompt).toContain('Write every piece of content in English')
    expect(prompt).not.toContain('"SCENE 1"')
  })

  it('hands the storyboard a per-segment shot budget without touching the default prompt', () => {
    expect(buildStoryboardPrompt('zh', SCRIPT)).toBe(STORYBOARD_ZH_BASELINE)
    const prompt = buildStoryboardPrompt('zh', SCRIPT, { minMs: 5_000, maxMs: 5_000 }, 12)
    expect(prompt).toContain('本段剧本约拆 12 个镜头')
  })
})

describe('script rhythm contract (S1)', () => {
  const RHYTHM = { avgShotMs: 4_500, longTakeMinMs: 8_000, longTakeShareMin: 0.2 }

  it('adds the shot table and the three thresholds when a target duration is given', () => {
    const prompt = buildScriptPrompt('zh', SOURCE, 180_000, RHYTHM)
    expect(prompt).toContain('分镜节奏契约')
    // 表头与镜头类型是分镜逐行转录的锚点，字面量必须稳定。
    expect(prompt).toContain('#｜时间｜时长｜场景｜镜头类型｜画面｜台词/VO｜声音｜生成方式')
    expect(prompt).toContain('主镜 / 插入 / 反应 / 空镜 / 字卡')
    expect(prompt).toContain('不低于 4.5 秒')
    expect(prompt).toContain('≥8 秒的镜头合计占片长不低于 20%')
    expect(prompt).toContain('每个场景至少 1 颗主镜')
    // 它是 prompt 里唯一的要求来源，不是成片标准：分镜不得重新估时长。
    expect(prompt).toContain('「时长」是这一镜的真值')
  })

  it('reads the thresholds from the project settings instead of hard-coding them', () => {
    const prompt = buildScriptPrompt('zh', SOURCE, 180_000, { avgShotMs: 6_000, longTakeMinMs: 12_000, longTakeShareMin: 0.4 })
    expect(prompt).toContain('不低于 6.0 秒')
    expect(prompt).toContain('≥12 秒的镜头合计占片长不低于 40%')
    expect(prompt).toContain('时长 12–15 秒')
  })

  it('keeps the byte-exact baseline when there is no target duration, rhythm or not', () => {
    expect(buildScriptPrompt('zh', SOURCE, undefined, RHYTHM)).toBe(SCRIPT_ZH_BASELINE)
    expect(buildScriptPrompt('en', SOURCE, undefined, RHYTHM)).toBe(buildScriptPrompt('en', SOURCE))
  })

  it('applies the same rhythm rules to the film distillation prompt', () => {
    const prompt = buildFilmScriptPrompt('zh', '整本小说……', 120 * 60_000, RHYTHM)
    expect(prompt).toContain('分镜节奏契约')
    expect(prompt).toContain('不低于 4.5 秒')
    expect(buildFilmScriptPrompt('zh', '整本小说……', 120 * 60_000)).not.toContain('分镜节奏契约')
  })
})

describe('film distillation prompt (5)', () => {
  it('frames the whole book as one film and keeps the shared duration rules', () => {
    const prompt = buildFilmScriptPrompt('zh', '整本小说……', 120 * 60_000)
    expect(prompt).toContain('提炼改编为一部完整电影的拍摄剧本')
    expect(prompt).toContain('保留推动主线的关键人物与事件')
    expect(prompt).toContain('约 120 分钟')
    expect(prompt).toContain('42000 字')
    expect(prompt).toContain('「场景 1」')
    expect(prompt).toContain('整本小说……')
  })

  it('distills without a duration too, and keeps the English project on the appended directive', () => {
    const undated = buildFilmScriptPrompt('zh', '整本小说……')
    expect(undated).toContain('提炼改编为一部完整电影的拍摄剧本')
    expect(undated).not.toContain('分钟')
    expect(undated).toContain('「场景 1」')

    const english = buildFilmScriptPrompt('en', 'the novel', 90 * 60_000)
    expect(english).toContain('提炼改编为一部完整电影的拍摄剧本')
    expect(english).toContain('约 90 分钟')
    expect(english).toContain('Write every piece of content in English')
  })
})

describe('voiceLine', () => {
  it('keeps the bracket form Chinese tasks have always sent', () => {
    expect(voiceLine('zh', '沈亦', '照片背面有字……')).toBe('照片背面有字……')
  })

  it('sends only the dialogue text, not the speaker attribution', () => {
    expect(voiceLine('en', 'Shen Yi', 'There is writing on the back.')).toBe('There is writing on the back.')
  })

  it('hands a silent shot no speaker at all', () => {
    for (const locale of ['zh', 'en'] as const) expect(voiceLine(locale, null, '')).toBe('')
  })
})
