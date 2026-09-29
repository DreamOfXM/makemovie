import { describe, expect, it } from 'vitest'
import { quantizeShotDuration } from '../src/index.js'
import { buildFilmScriptPrompt, buildMusicPrompt, buildScriptPrompt, buildStoryboardPrompt, outputLanguageDirective, voiceLine } from '../src/prompts.js'

// The bytes a Chinese project sent before content languages existed. Restated here
// rather than derived from the builders, so changing a template has to be decided
// twice: once in the prompt, once in this file.
const SCRIPT_ZH_BASELINE = '根据以下源文档，写出这一集的完整拍摄剧本：\n\n剧本素材：雨夜失踪案'
const STORYBOARD_ZH_BASELINE = [
  '把以下剧本拆分成连续的分镜镜头，并从中提取这一集要用到的角色、道具和场景。',
  '只输出一个 JSON 对象，不要任何其它说明，结构如下：',
  '{"shots":[{"title":"镜头标题","description":"画面与动作","dialogue":"该镜头台词原文（无台词留空字符串）","speaker":"该镜头说话人（无台词留空）","sourceExcerpt":"对应的剧本原文","durationMs":5000,"continuityIn":"承接上一镜","continuityOut":"留给下一镜"}],',
  '"assets":[{"kind":"character","name":"唯一名称","description":"外形与气质，用于生成参考图"}]}',
  '拆分容量规则（最高优先级，单镜时长按 5 秒规划，违反任何一条整集都会变成碎片拼贴）：',
  '- 一个镜头只承载一个连续的视听瞬间：description 描述的动作必须能在 5 秒画面里完成。超出 5 秒能力的长对话、多步动作序列必须拆成多个镜头；宁可多拆，不许塞爆。',
  '- 一个镜头的 speaker 只能有一个；说话人切换就是切镜头（对方回应单独成镜）。旁白与对白不得混入同一镜。',
  '- dialogue 必须是该说话人完整的一句话原文，总量不超过约 18 个汉字（5 秒的自然语速），禁止截成语气残句（如"……不……"）；剧本里的每一句台词都必须完整出现在某个镜头的 dialogue 里，不得丢失、不得改写。',
  '- description 必须呈现该镜台词的说话瞬间或其听者反应——画面与台词说的是同一件事。',
  '- durationMs 一律填 5000（视频按 5 秒生成）。',
  '同场空间锚点（与容量规则同级）：同一场景内相邻的镜头共享已确立的空间事实。',
  '- continuityIn 必须写具体空间事实，不许写"场景N内第X镜之后"这类纯顺序话：谁在什么位置/姿势、手里有什么、新入场者从画面哪一侧进入、双方视线方向。',
  '- description 对同场上一镜已在场的人物必须交代其位置沿用（如"许知意仍坐在长桌边，笔搁在协议上，抬头看向门口"），不得让已确立的位置凭空改变。',
  '- 场景切换（新地点/新时间）时 continuityIn 写"新场景：{地点与时间}"，两镜空间互不约束。',
  '镜头语言（每镜必带）：description 必须以"（景别·机位）"开头，景别从〔远景/全景/中景/近景/特写〕选一，机位/角度从〔平视/低角度/高角度俯拍/过肩/正面/侧面/背面〕选一；涉及运动再附〔固定机位/缓推/缓拉/横摇〕。',
  '- 同一场内相邻镜头要交替景别（建立场景用全景，人物反应用近景或特写），不许连续三镜同景别；切镜的意义就是换一个观看位置。',
  'shots 按剧情先后排列，镜头编号由顺序决定，不要自己写。',
  'dialogue 只放这一镜真正说出口的台词原文，动作和旁白不要塞进去；没有台词的镜头留空字符串。',
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

  it('quantizes model capability into two stable tiers', () => {
    expect(quantizeShotDuration(5_000)).toBe(5_000)
    expect(quantizeShotDuration(10_000)).toBe(5_000)
    expect(quantizeShotDuration(15_000)).toBe(15_000)
    expect(quantizeShotDuration(30_000)).toBe(15_000)
  })

  it('scales the shot capacity to the bound video model', () => {
    const prompt = buildStoryboardPrompt('zh', SCRIPT, 30_000)
    expect(prompt).toContain('"durationMs":30000')
    expect(prompt).toContain('单镜时长按 30 秒规划')
    expect(prompt).toContain('总量不超过约 105 个汉字')
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
    expect(buildStoryboardPrompt('en', SCRIPT)).toContain('"continuityOut":"留给下一镜"')
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
    const prompt = buildStoryboardPrompt('zh', SCRIPT, 5_000, 12)
    expect(prompt).toContain('本段剧本约拆 12 个镜头')
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
    expect(voiceLine('zh', '沈亦', '照片背面有字……')).toBe('【沈亦】照片背面有字……')
  })

  it('attributes an English line the way an English script does', () => {
    expect(voiceLine('en', 'Shen Yi', 'There is writing on the back.')).toBe('Shen Yi: There is writing on the back.')
  })

  it('hands a silent shot no speaker at all', () => {
    for (const locale of ['zh', 'en'] as const) expect(voiceLine(locale, null, '')).toBe('')
  })
})
