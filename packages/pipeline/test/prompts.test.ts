import { describe, expect, it } from 'vitest'
import { buildMusicPrompt, buildScriptPrompt, buildStoryboardPrompt, outputLanguageDirective, voiceLine } from '../src/prompts.js'

// The bytes a Chinese project sent before content languages existed. Restated here
// rather than derived from the builders, so changing a template has to be decided
// twice: once in the prompt, once in this file.
const SCRIPT_ZH_BASELINE = '根据以下源文档，写出这一集的完整拍摄剧本：\n\n剧本素材：雨夜失踪案'
const STORYBOARD_ZH_BASELINE = [
  '把以下剧本拆分成连续的分镜镜头，并从中提取这一集要用到的角色、道具和场景。',
  '只输出一个 JSON 对象，不要任何其它说明，结构如下：',
  '{"shots":[{"title":"镜头标题","description":"画面与动作","dialogue":"该镜头台词原文（无台词留空字符串）","speaker":"该镜头说话人（无台词留空）","sourceExcerpt":"对应的剧本原文","durationMs":5000,"continuityIn":"承接上一镜","continuityOut":"留给下一镜"}],',
  '"assets":[{"kind":"character","name":"唯一名称","description":"外形与气质，用于生成参考图"}]}',
  'shots 按剧情先后排列，镜头编号由顺序决定，不要自己写；durationMs 是该镜头的毫秒时长。',
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
