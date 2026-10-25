import { describe, expect, it } from 'vitest'
import { applySceneMasterWaves, type PlanWaveInput, type SceneMasterFirst } from '../src/index.js'

/**
 * SD-065 #201：预审门曾把「本轮根本不会派」的镜算进新产出——同景非首镜要等首镜的
 * 主帧，真触发把它们排成 BLOCKED、不入队、不烧钱，计划却照样承诺。这里钉住预审端
 * 唯一的等待分账：wave 2 不进本轮派出数，deferred 点名它等的是哪一镜的主帧。
 */

const master: SceneMasterFirst = { id: 'shot-1', number: 1, label: '滨江楼道' }
const sceneFirstByShot = new Map<string, SceneMasterFirst>([
  ['shot-1', master],
  ['shot-2', master],
  ['shot-3', master],
  ['shot-4', master],
  ['shot-5', master],
])
const blockedByMaster = new Map<string, string>([
  ['shot-2', '等待「滨江楼道」主帧：先生成并钦定该景首镜（#1）的首帧，再重试这一镜'],
])
const modelByShot = new Map<string, string | null>([
  ['shot-1', 'conn · mock/mock-image'],
  ['shot-2', 'conn · mock/mock-image'],
  ['shot-3', 'conn · mock/mock-image'],
])

function waveItems(): PlanWaveInput[] {
  return [
    { id: 'shot-1', label: '#1 开场', shotNumber: 1, disposition: 'new' },
    { id: 'shot-2', label: '#2 反打', shotNumber: 2, disposition: 'new' },
    { id: 'shot-3', label: '#3 收尾', shotNumber: 3, disposition: 'retry' },
    { id: 'shot-4', label: '#4 字卡', shotNumber: 4, disposition: 'local' },
    { id: 'shot-5', label: '#5 已覆盖', shotNumber: 5, disposition: 'skipped' },
  ]
}

describe('预审的场景主帧分账（SD-065 #201）', () => {
  it('等主帧的镜落 wave 2、不报模型、不计入本轮派出数', () => {
    const waves = applySceneMasterWaves(waveItems(), blockedByMaster, sceneFirstByShot, modelByShot)
    const byId = new Map(waves.items.map(item => [item.id, item]))

    expect(byId.get('shot-2')).toMatchObject({ wave: 2, model: null })
    // #1 是首镜本身，#3 是同一景但主帧等待表里没有它：两者本轮都派。
    expect(byId.get('shot-1')).toMatchObject({ wave: 1, model: 'conn · mock/mock-image' })
    expect(byId.get('shot-3')).toMatchObject({ wave: 1, model: 'conn · mock/mock-image' })
    expect(waves.dispatchCount).toBe(2)
    expect(waves.deferredCount).toBe(1)
    // deferred 必须点名「等哪一镜的主帧」，光说「等主帧」用户不知道去催谁。
    expect(waves.deferred).toEqual([
      { shotNumber: 2, label: '#2 反打', waitsForShotNumber: 1, waitsForLabel: '滨江楼道' },
    ])
  })

  it('本机镜与已覆盖镜不受等待表影响：不排队、不计数、不进 deferred', () => {
    const waves = applySceneMasterWaves(
      waveItems(),
      new Map([...blockedByMaster, ['shot-4', '不该被读到的原因'], ['shot-5', '不该被读到的原因']]),
      sceneFirstByShot,
      modelByShot,
    )
    const byId = new Map(waves.items.map(item => [item.id, item]))
    for (const id of ['shot-4', 'shot-5']) {
      expect(byId.get(id)).toMatchObject({ wave: 1, model: null })
      expect(waves.deferred.some(entry => entry.label === byId.get(id)!.label)).toBe(false)
    }
    expect(waves.items.map(item => item.disposition)).toEqual(['new', 'new', 'retry', 'local', 'skipped'])
  })

  it('主帧已就位（不在等待表）→ 同景每颗可计费镜都留在本轮', () => {
    const waves = applySceneMasterWaves(waveItems(), new Map(), sceneFirstByShot, modelByShot)
    expect(waves.items.filter(item => item.disposition === 'new' || item.disposition === 'retry').every(item => item.wave === 1)).toBe(true)
    expect(waves.dispatchCount).toBe(3)
    expect(waves.deferred).toEqual([])
    expect(waves.deferredCount).toBe(0)
  })

  it('非逐镜条目没有镜头号：即使等待表里有同 id 也不虚构 deferred', () => {
    const waves = applySceneMasterWaves(
      [{ id: 'episode-1', label: '第一集', shotNumber: null, disposition: 'new' }],
      new Map([['episode-1', '不该被读到的原因']]),
      sceneFirstByShot,
      new Map([['episode-1', 'conn · mock/mock-image']]),
    )
    expect(waves.items).toEqual([
      { id: 'episode-1', label: '第一集', disposition: 'new', model: 'conn · mock/mock-image', wave: 1 },
    ])
    expect(waves.dispatchCount).toBe(1)
    expect(waves.deferredCount).toBe(0)
  })
})
