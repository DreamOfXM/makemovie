import { describe, expect, it } from 'vitest'
import { dictionaries } from '@/lib/i18n'

/**
 * SD-083：选版门是「钦定」这一个动作，全站只许一个词根。实拍里同一个动作在同一屏
 * 留下四枚措辞（按钮「选这版入片」、徽章「✓ 入片」、撤销「取消钦定」、页头「已钦定」），
 * 用户无法确认「取消钦定」撤的是不是刚点的那一下——shot-verdict 自己写着
 * 「同一件事在两处用两个词，读的人就会认为是两件事」。这里断言的是真字典（中英两侧），
 * 不是替身：谁把「入片 / in cut / Chosen」这类换词根措辞带回来，这里就红。
 * 「入片」只留给合成成片这个动作（preview.policy.*），那是两件事，不在本词根管辖内。
 */

/** 上屏渲染「钦定这版 / 已钦定 / 取消钦定 / 待钦定」这一动作的键（zh 侧）。 */
const PICK_KEYS = [
  'workbench.pickVideo',
  'workbench.pickFrame',
  'workbench.pickVoice',
  'workbench.framePinned',
  'workbench.voicePinned',
  'shotboard.candidateChosen',
  'shotboard.strip.chosen',
  'shotboard.choose',
  'shotboard.chosen',
  'shotboard.autoLatest',
  'shotboard.audio.restoreDefault',
  'workbench.filter.pick',
  'shotboard.versionChosen',
  'storyboards.eventChosen',
  'shotboard.reason.selectionOpen',
] as const

describe('钦定词根（SD-083）', () => {
  it('zh：同一动作的每处上屏措辞都含「钦定」词根，不留「入片 / 入成片 / 选定」变体', () => {
    for (const key of PICK_KEYS) {
      const value = dictionaries.zh[key]
      expect(value, `${key} 缺 zh 文案`).toBeDefined()
      expect(value, `${key} 必须说「钦定」`).toContain('钦定')
      expect(value, `${key} 「入片/选定」是换词根`).not.toMatch(/入片|入成片|选定/)
    }
  })

  it('en：同一动作只认 pick 词根，旧三分（Pick this cut / in cut / Unpick 之外的 chosen/pinned）清零', () => {
    for (const key of PICK_KEYS) {
      const value = dictionaries.en[key]
      expect(value, `${key} 缺 en 文案`).toBeDefined()
      expect(value.toLowerCase(), `${key} 必须含 pick`).toContain('pick')
      expect(value.toLowerCase(), `${key} cut/choose/chosen/pinned/master 都是换词根`).not.toMatch(/\bcut\b|chosen|choose|pinned|master/)
    }
  })

  it('一套词根的四种形态都在：钦定这版（动词）/ 已钦定（状态）/ 取消钦定（撤销）/ 待钦定（队列）', () => {
    expect(dictionaries.zh['workbench.pickVideo']).toBe('钦定这版')
    expect(dictionaries.zh['shotboard.candidateChosen']).toBe('已钦定')
    expect(dictionaries.zh['shotboard.autoLatest']).toBe('取消钦定')
    expect(dictionaries.zh['workbench.filter.pick']).toContain('待钦定')
    expect(dictionaries.en['workbench.pickVideo']).toBe('Pick this version')
    expect(dictionaries.en['shotboard.candidateChosen']).toBe('Picked')
    expect(dictionaries.en['shotboard.autoLatest']).toBe('Unpick')
    expect(dictionaries.en['workbench.filter.pick']).toContain('To pick')
  })

  it('「入片」原样留给合成这个动作——preview.policy.* 说的是 compose，本来就是两件事', () => {
    expect(dictionaries.zh['preview.policy.apply_if_empty']).toContain('入片')
    expect(dictionaries.zh['preview.policy.apply_if_unchanged']).toContain('入片')
  })
})
