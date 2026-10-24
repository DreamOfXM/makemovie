import { describe, expect, it } from 'vitest'
import {
  FALLBACK_SHOT_DURATION_MS,
  MAX_SHOT_DURATION_MS,
  preflightShotDurations,
  resolveShotDurationCeiling,
  shotDurationGap,
  type ShotDurationAssessment,
} from '../src/index.js'

// S2 exit checks: the effective ceiling is the smallest of project tier, bound-model
// declared max and the product cap; a model that declares nothing opens no tier.
describe('resolveShotDurationCeiling', () => {
  it('takes the model declaration when the project tier is higher', () => {
    const ceiling = resolveShotDurationCeiling(30_000, [{ minMs: 5_000, maxMs: 10_000 }])
    expect(ceiling.effectiveMs).toBe(10_000)
    expect(ceiling.selectableMs).toEqual([10_000])
  })

  it('falls back to the conservative 5s and offers no tier when the model declares nothing', () => {
    const ceiling = resolveShotDurationCeiling(null, [])
    expect(ceiling.modelMs).toBeNull()
    expect(ceiling.effectiveMs).toBe(FALLBACK_SHOT_DURATION_MS)
    expect(ceiling.selectableMs).toEqual([])
  })

  it('never offers the 30s tier to a model that only declares 15s', () => {
    const ceiling = resolveShotDurationCeiling(null, [{ minMs: 5_000, maxMs: 15_000 }])
    expect(ceiling.effectiveMs).toBe(15_000)
    expect(ceiling.selectableMs).toEqual([10_000, 15_000])
    expect(ceiling.selectableMs).not.toContain(30_000)
  })

  it('caps a 30s-capable model at the product ceiling', () => {
    const ceiling = resolveShotDurationCeiling(30_000, [{ minMs: 5_000, maxMs: 60_000 }])
    expect(ceiling.effectiveMs).toBe(MAX_SHOT_DURATION_MS)
    expect(ceiling.selectableMs).toEqual([10_000, 15_000, 30_000])
  })

  it('keeps a tier only when some declared model actually covers it', () => {
    const ceiling = resolveShotDurationCeiling(null, [
      { minMs: 10_000, maxMs: 10_000 },
      { minMs: 3_000, maxMs: 5_000 },
    ])
    expect(ceiling.effectiveMs).toBe(10_000)
    expect(ceiling.selectableMs).toEqual([10_000])
  })

  it('offers every model-covered tier even when the project currently sits at 10s', () => {
    // The project tier decides the effective ceiling, not the menu: raising it
    // later must not require a second trip through settings.
    const ceiling = resolveShotDurationCeiling(10_000, [{ minMs: 5_000, maxMs: 30_000 }])
    expect(ceiling.effectiveMs).toBe(10_000)
    expect(ceiling.selectableMs).toEqual([10_000, 15_000, 30_000])
  })
})

function assessment(declared: { minMs: number; maxMs: number }[], projectMs: number | null = null): ShotDurationAssessment {
  const ceiling = resolveShotDurationCeiling(projectMs, declared)
  return {
    minMs: declared.length === 0 ? ceiling.effectiveMs : Math.min(...declared.map(spec => spec.minMs)),
    maxMs: ceiling.effectiveMs,
    ceiling,
    offers: declared.map((spec, index) => ({
      capabilityId: `cap-${index}`,
      connectionName: `conn-${index}`,
      provider: 'mock',
      model: `model-${index}`,
      displayName: null,
      minMs: spec.minMs,
      maxMs: spec.maxMs,
      evidence: null,
    })),
  }
}

function shot(durationMs: number, id = 'shot-1') {
  return { id, number: 1, title: 'S1', durationMs }
}

describe('preflightShotDurations', () => {
  it('flags a shot longer than the bound model and offers splice with whole takes', () => {
    const [item] = preflightShotDurations([shot(40_000)], assessment([{ minMs: 5_000, maxMs: 15_000 }]))
    expect(item.intentMs).toBe(40_000)
    expect(item.ceilingMs).toBe(15_000)
    expect(item.overByMs).toBe(25_000)
    expect(item.options.find(option => option.strategy === 'splice')).toMatchObject({ available: true, takeCount: 3, perTakeMs: 13_334 })
  })

  it('offers switch_model only when a bound candidate actually covers the intent', () => {
    const covered = preflightShotDurations([shot(20_000)], assessment([{ minMs: 5_000, maxMs: 15_000 }, { minMs: 5_000, maxMs: 30_000 }], 15_000))
    expect(covered[0].ceilingMs).toBe(15_000)
    expect(covered[0].options.find(option => option.strategy === 'switch_model')).toMatchObject({ available: true, capabilityId: 'cap-1', maxMs: 30_000 })

    // 产品上限之外没有任何模型能接到：40 秒的意图只能拼或拆。
    const beyondProduct = preflightShotDurations([shot(40_000)], assessment([{ minMs: 5_000, maxMs: 30_000 }]))
    expect(beyondProduct[0].options.find(option => option.strategy === 'switch_model')).toMatchObject({ available: false })
  })

  it('stays silent when the bound chain declares nothing — 5s is a planning fallback, not a cap', () => {
    // 拿没证据的 5 秒当硬上限，会把一颗 8 秒的正常镜头也变成三选一。
    expect(preflightShotDurations([shot(8_000)], assessment([]))).toEqual([])
  })

  it('still flags anything past the product cap even without a model declaration', () => {
    const [item] = preflightShotDurations([shot(40_000)], assessment([]))
    expect(item.ceilingMs).toBe(MAX_SHOT_DURATION_MS)
    expect(item.options.find(option => option.strategy === 'splice')).toMatchObject({ available: true, takeCount: 2, perTakeMs: 20_000 })
  })

  it('lets the shot through once it fits the ceiling', () => {
    expect(preflightShotDurations([shot(10_000)], assessment([{ minMs: 5_000, maxMs: 15_000 }]))).toEqual([])
  })
})

describe('shotDurationGap', () => {
  it('reports the shortfall against the episode target', () => {
    expect(shotDurationGap(60_000, [{ durationMs: 5_000 }, { durationMs: 5_000 }])).toEqual({
      targetMs: 60_000,
      plannedMs: 10_000,
      gapMs: 50_000,
    })
  })

  it('never reports a negative gap when the shots run long', () => {
    expect(shotDurationGap(10_000, [{ durationMs: 15_000 }])?.gapMs).toBe(0)
  })

  it('has no opinion when the episode has no target', () => {
    expect(shotDurationGap(null, [{ durationMs: 5_000 }])).toBeNull()
  })
})
