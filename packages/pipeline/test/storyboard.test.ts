import { describe, expect, it } from 'vitest'
import {
  STORYBOARD_SPLIT_CHAR_THRESHOLD,
  STORYBOARD_SPLIT_SHOT_THRESHOLD,
  mergeStoryboardReplies,
  parseStoryboardJson,
  planStoryboardSegments,
  shouldSplitStoryboard,
} from '../src/storyboard.js'

// 一段约 608 字符的场景:两场聚成一段(~1218 ≤ 1500),三场就超,边界清晰可断言。
const scene = (label: string) => `场景 ${label}：夜色\n${'雨'.repeat(600)}`

describe('shouldSplitStoryboard thresholds', () => {
  it('splits only past the character threshold when no duration is set', () => {
    expect(shouldSplitStoryboard('一'.repeat(STORYBOARD_SPLIT_CHAR_THRESHOLD), undefined, 5_000)).toBe(false)
    expect(shouldSplitStoryboard('一'.repeat(STORYBOARD_SPLIT_CHAR_THRESHOLD + 1), undefined, 5_000)).toBe(true)
  })

  it('splits on the estimated shot count of the target duration alone', () => {
    expect(shouldSplitStoryboard('短剧本', STORYBOARD_SPLIT_SHOT_THRESHOLD * 5_000, 5_000)).toBe(false)
    expect(shouldSplitStoryboard('短剧本', (STORYBOARD_SPLIT_SHOT_THRESHOLD + 1) * 5_000, 5_000)).toBe(true)
  })

  it('plans no segments below the thresholds — the single-call path stays untouched', () => {
    expect(planStoryboardSegments('短剧本', { targetDurationMs: 60_000, shotMs: 5_000 })).toEqual([])
  })
})

describe('planStoryboardSegments', () => {
  it('cuts at scene markers, packs neighbouring scenes and shares the budget by size', () => {
    // 42 个预估镜头(210 秒 / 5 秒)超过 40 的阈值 → 分段;四场两两聚成两段。
    const script = [scene('1'), scene('2'), scene('3'), scene('4')].join('\n\n')
    const segments = planStoryboardSegments(script, { targetDurationMs: 210_000, shotMs: 5_000 })

    expect(segments).toHaveLength(2)
    expect(segments[0]!.content).toContain('场景 1：')
    expect(segments[0]!.content).toContain('场景 2：')
    expect(segments[0]!.content).not.toContain('场景 3：')
    expect(segments[1]!.content).toContain('场景 3：')
    expect(segments[1]!.content).toContain('场景 4：')
    // 210 秒 / 5 秒 = 42 个镜头,两段等长 → 各 21;预算按字符占比折算。
    expect(segments.map(segment => segment.shotBudget)).toEqual([21, 21])
  })

  it('recognises SCENE markers and folds a preamble into the first block', () => {
    const script = ['COLD OPEN over black.', `SCENE 1: Old town\n${'rain'.repeat(150)}`, `SCENE 2: The archive\n${'rain'.repeat(150)}`].join('\n\n')
    const segments = planStoryboardSegments(script, { targetDurationMs: 210_000, shotMs: 5_000 })
    expect(segments.length).toBeGreaterThanOrEqual(1)
    expect(segments[0]!.content.startsWith('COLD OPEN')).toBe(true)
    expect(segments[0]!.content).toContain('SCENE 1:')
  })

  it('falls back to blank-line paragraphs when the markers do not actually cut', () => {
    // 单个超长场景:标记存在但切不开,段落聚合接手。四段 600 字段落 → 两块。
    const paragraphs = ['场景 1：夜色\n' + '雨'.repeat(600), ...Array.from({ length: 3 }, () => '雨'.repeat(600))]
    const script = paragraphs.join('\n\n')
    const segments = planStoryboardSegments(script, { targetDurationMs: 210_000, shotMs: 5_000 })
    expect(segments.length).toBe(2)
    expect(segments[0]!.content.length).toBeLessThanOrEqual(1_500)
  })

  it('derives the total budget from script length when the episode has no duration', () => {
    // 十场 ≈ 6090 字符,超过 6000 的字符阈值;无时长路径按 350 字/分钟反推。
    const script = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map(scene).join('\n\n')
    const withDuration = planStoryboardSegments(script, { targetDurationMs: 609_000, shotMs: 5_000 })
    const withoutDuration = planStoryboardSegments(script, { shotMs: 5_000 })
    // 609 秒 / 5 秒 ≈ 122 镜、五段等长 → 各 24;无时长的反推(~17.4 分钟 ≈ 208 镜)→ 各 42。
    expect(withDuration.map(segment => segment.shotBudget)).toEqual([24, 24, 24, 24, 24])
    expect(withoutDuration.map(segment => segment.shotBudget)).toEqual([42, 42, 42, 42, 42])
  })

  it('never hands a segment a zero budget, however small the block', () => {
    const script = [scene('1'), '场景 2：短\n一瞬。', ...['3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].map(scene)].join('\n\n')
    const segments = planStoryboardSegments(script, { targetDurationMs: 30_000, shotMs: 5_000 })
    expect(segments.length).toBeGreaterThan(1)
    for (const segment of segments) {
      expect(segment.shotBudget).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('mergeStoryboardReplies', () => {
  const reply = (titles: string[], extraAsset?: object) =>
    JSON.stringify({
      shots: titles.map((title, index) => ({ number: index + 1, title, dialogue: '', speaker: null })),
      assets: [{ kind: 'character', name: '沈亦', description: '刑警' }, ...(extraAsset ? [extraAsset] : [])],
    })

  it('concatenates shots in segment order with one continuous numbering', () => {
    const merged = mergeStoryboardReplies([reply(['甲', '乙']), reply(['丙'])])
    expect(merged).not.toBeNull()
    const parsed = JSON.parse(merged!) as { shots: Array<{ number: number; title: string }>; assets: unknown[] }
    expect(parsed.shots.map(shot => `${shot.number}:${shot.title}`)).toEqual(['1:甲', '2:乙', '3:丙'])
  })

  it('deduplicates the cast every segment re-reports', () => {
    const merged = mergeStoryboardReplies([reply(['甲'], { kind: 'prop', name: '照片', description: '半张' }), reply(['乙'])])
    const parsed = JSON.parse(merged!) as { assets: Array<{ kind: string; name: string }> }
    expect(parsed.assets.map(asset => `${asset.kind}:${asset.name}`).sort()).toEqual(['character:沈亦', 'prop:照片'])
  })

  it('parses replies wrapped in prose, and fails the whole merge on one bad segment', () => {
    const wrapped = `Here you go:\n\`\`\`json\n${reply(['甲'])}\n\`\`\``
    expect(mergeStoryboardReplies([wrapped])).not.toBeNull()
    // 静默丢一段就是丢一截成片:一段解析失败整个合并失败,候选让位重试。
    expect(mergeStoryboardReplies([reply(['甲']), 'I could not do it.'])).toBeNull()
    expect(mergeStoryboardReplies([])).toBeNull()
  })
})

describe('parseStoryboardJson (moved from the worker)', () => {
  it('still accepts the document shape, a bare shot array and prose wrapping', () => {
    expect(parseStoryboardJson('{"shots":[{"title":"一"}],"assets":[]}')!.shots).toHaveLength(1)
    expect(parseStoryboardJson('[{"title":"一"}]')!.assets).toEqual([])
    expect(parseStoryboardJson('noise {"shots":[{"title":"一"}]} noise')!.shots).toHaveLength(1)
  })

  it('still refuses garbage and an empty shot list', () => {
    expect(parseStoryboardJson('no json here')).toBeNull()
    expect(parseStoryboardJson('{"shots":[],"assets":[{"kind":"character","name":"沈亦"}]}')).toBeNull()
  })
})
