import type { ContentLocale } from '@studio/domain'

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

export function buildScriptPrompt(locale: ContentLocale, sourceContent: string): string {
  return withDirective(locale, `根据以下源文档，写出这一集的完整拍摄剧本：\n\n${sourceContent}`)
}

export function buildStoryboardPrompt(locale: ContentLocale, scriptContent: string): string {
  return withDirective(locale, [
    '把以下剧本拆分成连续的分镜镜头，并从中提取这一集要用到的角色、道具和场景。',
    '只输出一个 JSON 对象，不要任何其它说明，结构如下：',
    '{"shots":[{"title":"镜头标题","description":"画面与动作","dialogue":"该镜头台词原文（无台词留空字符串）","speaker":"该镜头说话人（无台词留空）","sourceExcerpt":"对应的剧本原文","durationMs":5000,"continuityIn":"承接上一镜","continuityOut":"留给下一镜"}],',
    '"assets":[{"kind":"character","name":"唯一名称","description":"外形与气质，用于生成参考图"}]}',
    'shots 按剧情先后排列，镜头编号由顺序决定，不要自己写；durationMs 是该镜头的毫秒时长。',
    'dialogue 只放这一镜真正说出口的台词原文，动作和旁白不要塞进去；没有台词的镜头留空字符串。',
    'assets 的 kind 只能是 character、prop、scene 三者之一，同一个人物或物件只写一次。',
    '',
    '剧本：',
    scriptContent,
  ].join('\n'))
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
 * How a shot's line is handed to a voice model: the speaker marker plus the words
 * to speak. Chinese uses the `【】` script convention the providers have always been
 * sent; English uses the equivalent attribution in its own convention.
 */
export function voiceLine(locale: ContentLocale, speaker: string | null, dialogue: string): string {
  if (!speaker) return dialogue
  return locale === 'zh' ? `【${speaker}】${dialogue}` : `${speaker}: ${dialogue}`
}
