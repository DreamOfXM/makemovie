import { describe, expect, it } from 'vitest'
import { DEFAULT_PROMPT_GUARDS, VISUAL_STYLE_DIRECTIVE, runPromptGuards, type GuardContext } from '../src/guards.js'

function run(prompt: string, context: GuardContext) {
  return runPromptGuards(DEFAULT_PROMPT_GUARDS, prompt, context)
}

describe('prompt guards', () => {
  it('blocks an IMAGE shot with zero bound assets and short-circuits the chain', () => {
    const result = run('#3 空巷: 夜色下的青石板路', { stage: 'IMAGE', boundAssetCount: 0 })
    expect(result.blockedReason).toContain('未绑定任何素材')
    // 拦下的任务不会被送去烧:后面的修复型守卫没有理由再改它的文字。
    expect(result.prompt).toBe('#3 空巷: 夜色下的青石板路')
    expect(result.findings).toEqual([])
  })

  it('never blocks VIDEO for missing bindings — the frame, not the prompt, carries identity there', () => {
    const result = run('#3 空巷: 夜色下的青石板路', { stage: 'VIDEO', boundAssetCount: 0 })
    expect(result.blockedReason).toBeUndefined()
  })

  it('treats a missing binding count as no objection (fail-open on absent data)', () => {
    const result = run('#3 空巷: 夜色下的青石板路', { stage: 'IMAGE' })
    expect(result.blockedReason).toBeUndefined()
  })

  it('appends the style baseline once and records the repair', () => {
    const result = run('#1 点睛: 手悬在砚台上方', { stage: 'IMAGE', boundAssetCount: 1 })
    expect(result.prompt).toBe(`#1 点睛: 手悬在砚台上方\n\n${VISUAL_STYLE_DIRECTIVE}`)
    expect(result.findings).toEqual([
      { guard: 'style-anchor', action: 'repair', note: expect.any(String) },
    ])
  })

  it('leaves a prompt that already declares a visual style alone', () => {
    for (const marker of ['真人实拍', '电影质感', 'photorealistic', 'cinematic']) {
      const result = run(`水墨画风但保持${marker}的光影`, { stage: 'IMAGE', boundAssetCount: 1 })
      expect(result.findings.filter(f => f.guard === 'style-anchor')).toEqual([])
      expect(result.prompt).not.toContain(VISUAL_STYLE_DIRECTIVE)
    }
  })

  const master = { name: '关师傅', description: '六十岁老匠人，灰白长须，粗布对襟衫', mentioned: false }
  const handShot = { stage: 'IMAGE' as const, boundAssetCount: 1, shot: { number: 1, title: '点睛', description: '一只枯瘦的手悬在砚台上方' } }

  it('injects the bound character as an appearance anchor when body words appear without a name', () => {
    const result = run('#1 点睛: 一只枯瘦的手悬在砚台上方', { ...handShot, characters: [master] })
    expect(result.prompt).toContain('画面中出现的人物必须与以下已绑定角色的外观设定严格一致')
    expect(result.prompt).toContain('关师傅：六十岁老匠人')
    expect(result.findings.map(f => f.guard)).toEqual(['style-anchor', 'character-anchor'])
  })

  it('stays out of the way when the character is already named (the asset context owns that case)', () => {
    const result = run('#1 点睛: 关师傅抬起手', { ...handShot, characters: [{ ...master, mentioned: true }] })
    expect(result.findings.map(f => f.guard)).toEqual(['style-anchor'])
  })

  it('stays out of the way when no person or body part appears in the frame text', () => {
    const result = run('#2 街景: 雨后的青石板路反着灯影', {
      ...handShot,
      shot: { number: 2, title: '街景', description: '雨后的青石板路反着灯影' },
      characters: [master],
    })
    expect(result.findings.map(f => f.guard)).toEqual(['style-anchor'])
    expect(result.prompt).not.toContain('外观设定严格一致')
  })

  it('warns on a motion sequence packed into one frame but never blocks it', () => {
    const result = run('#1 点睛: 黑屏→墨滴坠落→手腕下移→最后点睛', {
      stage: 'IMAGE',
      boundAssetCount: 1,
      shot: { number: 1, title: '点睛', description: '黑屏→墨滴坠落→手腕下移→最后点睛' },
    })
    const warn = result.findings.find(f => f.guard === 'motion-sequence')
    expect(warn?.action).toBe('warn')
    expect(warn?.note).toContain('时序推进')
    expect(result.blockedReason).toBeUndefined()
  })

  it('lets a single static moment through the motion guard', () => {
    const result = run('#1 定格: 少女缓缓抬起头', {
      stage: 'IMAGE',
      boundAssetCount: 1,
      shot: { number: 1, title: '定格', description: '少女缓缓抬起头' },
    })
    expect(result.findings.map(f => f.guard)).not.toContain('motion-sequence')
  })

  it('does not touch prompts of stages outside its contract', () => {
    const result = runPromptGuards(DEFAULT_PROMPT_GUARDS, '【关师傅】这笔，得点活。', { stage: 'AUDIO' as never })
    expect(result).toEqual({ prompt: '【关师傅】这笔，得点活。', findings: [] })
  })
})
