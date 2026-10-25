import { describe, expect, it } from 'vitest'
import {
  isSetLocation,
  isShotVisible,
  matchShotAssetLinks,
  missingShotAssetLinks,
  normalizeAssetName,
  sceneMasterGroupKey,
  type ReconcileShot,
} from '../src/index.js'

function shot(overrides: Partial<ReconcileShot> = {}): ReconcileShot {
  return {
    id: 's1',
    title: '睁眼',
    description: '陈默伸手按掉床头钟',
    dialogue: '',
    speaker: null,
    location: '卧室',
    lockedReferences: false,
    ...overrides,
  }
}

const ASSETS = [
  { id: 'c1', name: '陈默', kind: 'character' },
  { id: 'p1', name: '床头钟', kind: 'prop' },
  { id: 'sc1', name: '卧室', kind: 'scene' },
]

function fakeDb(existing: { storyboardId: string; assetId: string }[]) {
  return { storyboardAsset: { findMany: async () => existing } } as never
}

describe('normalizeAssetName', () => {
  it('strips the parenthetical annotation, not the name', () => {
    expect(normalizeAssetName('陈默（青年）')).toBe('陈默')
    expect(normalizeAssetName('床头钟 (7:08)')).toBe('床头钟')
  })
})

describe('matchShotAssetLinks', () => {
  it('binds a named character and prop, plus the scene by its place', () => {
    const links = matchShotAssetLinks([shot()], ASSETS)
    expect(links).toEqual([
      { storyboardId: 's1', assetId: 'c1', role: 'character' },
      { storyboardId: 's1', assetId: 'p1', role: 'prop' },
      { storyboardId: 's1', assetId: 'sc1', role: 'scene' },
    ])
  })

  it('binds a character whose name only appears as the speaker', () => {
    // 台词里的人就是这一镜的声音；是否画进画面由 isShotVisible 决定，两步分工。
    const links = matchShotAssetLinks(
      [shot({ title: '空镜', description: '床头的钟走到 7:08', dialogue: '陈默：又来了。', speaker: '陈默', location: '播放器' })],
      [{ id: 'c1', name: '陈默', kind: 'character' }],
    )
    expect(links.map(link => link.assetId)).toEqual(['c1'])
  })

  it('does not stretch a place name onto a scene asset that does not match it', () => {
    // 内容侧已知缺口：剧本第 5 镜写「走廊」，场景素材叫「楼道」——平台没有别名机制。
    const links = matchShotAssetLinks(
      [shot({ title: '下楼', description: '脚步声回响', location: '走廊' })],
      [{ id: 'sc1', name: '楼道', kind: 'scene' }],
    )
    expect(links).toEqual([])
  })

  it('binds a prop that the shot names by one of its parts (SD-123)', () => {
    // 实测事故：#9 描述写「钟体」（素材叫「床头钟」），整串包含判不出，那一镜的白抽
    // 就是模型自己另画了一口木壳挂钟。中心语 + 部位词是中文里指认道具的常态写法。
    const links = matchShotAssetLinks(
      [shot({ id: 's9', title: '钟落水', description: '（特写·侧面·跟随）钟体脱离手掌飞向水面', dialogue: '', location: '浴室' })],
      [{ id: 'p1', name: '床头钟', kind: 'prop' }],
    )
    expect(links).toEqual([{ storyboardId: 's9', assetId: 'p1', role: 'prop' }])
  })

  it('does not let a two-character prop name match a common word that starts with its tail', () => {
    // 「手表」的末字是融合名词的一部分，不是被修饰的中心语——「表面上」不该绑手表，
    // 「门把手」的末字「手」也不该被「把手机」绑上。
    const watch = [{ id: 'p1', name: '手表', kind: 'prop' }]
    expect(matchShotAssetLinks([shot({ description: '他把手放在表面上' })], watch)).toEqual([])
    const handle = [{ id: 'p2', name: '门把手', kind: 'prop' }]
    expect(matchShotAssetLinks([shot({ description: '他把手机塞进兜里' })], handle)).toEqual([])
  })

  it('never matches a scene asset from a non-set location', () => {
    for (const location of ['字卡', '黑屏', '空间', '播放器', '新项目', '真实 UI']) {
      expect(isSetLocation(location)).toBe(false)
    }
    const links = matchShotAssetLinks(
      [shot({ title: '字幕升起', description: '一行白字', location: '字卡' })],
      [{ id: 'sc1', name: '卧室', kind: 'scene' }],
    )
    expect(links).toEqual([])
  })

  it('falls back to 「他/她」 only when the episode has exactly one character', () => {
    const pronounShot = shot({ title: '他按下闹钟', description: '他伸手按掉床头的钟', location: '播放器' })
    expect(matchShotAssetLinks([pronounShot], [{ id: 'c1', name: '陈默', kind: 'character' }]).map(link => link.assetId)).toEqual(['c1'])
    expect(
      matchShotAssetLinks([pronounShot], [
        { id: 'c1', name: '陈默', kind: 'character' },
        { id: 'c2', name: '林小雨', kind: 'character' },
      ]),
    ).toEqual([])
  })
})

describe('isShotVisible', () => {
  const chenmo = { id: 'c1', name: '陈默', kind: 'character' }
  const bedroom = { id: 'sc1', name: '卧室', kind: 'scene' }

  it('keeps scenes in every frame and named assets in the frame that names them', () => {
    expect(isShotVisible(bedroom, '空镜，窗帘被风吹动', null)).toBe(true)
    expect(isShotVisible(chenmo, '陈默睁眼', null)).toBe(true)
    expect(isShotVisible({ id: 'p1', name: '床头钟', kind: 'prop' }, '床头钟指向 7:08', null)).toBe(true)
  })

  it('keeps a prop in the frame when the shot names one of its parts', () => {
    expect(isShotVisible({ id: 'p1', name: '床头钟', kind: 'prop' }, '钟面停在 7:07:12', null)).toBe(true)
    // 绑上了却不送定妆照，这一镜的道具照样是模型自己编的。
    expect(isShotVisible({ id: 'p1', name: '手表', kind: 'prop' }, '他把手放在表面上', null)).toBe(false)
  })

  it('keeps a voice-over character out of the frame', () => {
    expect(isShotVisible(chenmo, '空镜，床头的钟走到 7:08', 'c1')).toBe(false)
  })

  it('lets a sole character through on a pronoun', () => {
    expect(isShotVisible(chenmo, '他伸手按掉床头的钟', 'c1')).toBe(true)
    expect(isShotVisible(chenmo, '他伸手按掉床头的钟', null)).toBe(false)
  })
})

describe('sceneMasterGroupKey', () => {
  it('groups by place, not by scene number', () => {
    expect(sceneMasterGroupKey({ location: '卧室', sceneNumber: 1 })).toEqual({ key: 'place:卧室', label: '卧室' })
    expect(sceneMasterGroupKey({ location: '卧室', sceneNumber: 2 })!.key).toBe('place:卧室')
    expect(sceneMasterGroupKey({ location: '天台', sceneNumber: 2 })!.key).toBe('place:天台')
  })

  it('leaves non-set shots out — a card never becomes a master frame', () => {
    expect(sceneMasterGroupKey({ location: '字卡', sceneNumber: 2 })).toBeNull()
    expect(sceneMasterGroupKey({ location: '黑屏', sceneNumber: 1 })).toBeNull()
    expect(sceneMasterGroupKey({ location: '真实 UI', sceneNumber: 3 })).toBeNull()
  })

  it('falls back to the scene number for rows written before the place column existed', () => {
    expect(sceneMasterGroupKey({ location: null, sceneNumber: 4 })).toEqual({ key: 'scene:4', label: '场景 4' })
    expect(sceneMasterGroupKey({ location: '', sceneNumber: null })).toBeNull()
  })
})

describe('missingShotAssetLinks', () => {
  it('returns only the pairs the database does not have yet', async () => {
    const missing = await missingShotAssetLinks(fakeDb([{ storyboardId: 's1', assetId: 'c1' }]), [shot()], ASSETS)
    expect(missing.map(link => link.assetId)).toEqual(['p1', 'sc1'])
  })

  it('never touches a shot whose references a human locked', async () => {
    const missing = await missingShotAssetLinks(fakeDb([]), [shot({ lockedReferences: true })], ASSETS)
    expect(missing).toEqual([])
  })
})
