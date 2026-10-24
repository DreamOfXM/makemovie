import { describe, expect, it } from 'vitest'
import { DURATION_KEY, durationSecondsOf, maxDurationSeconds, minDurationSeconds, pinDuration, readDurationSpec, withoutDurationKey } from '../src/index.js'

describe('readDurationSpec', () => {
  it('reads each declared shape as itself', () => {
    expect(readDurationSpec({ duration: { kind: 'range', min: 2, max: 15 } })).toEqual({ kind: 'range', min: 2, max: 15 })
    expect(readDurationSpec({ duration: { kind: 'steps', values: [8, 4, 6] } })).toEqual({ kind: 'steps', values: [4, 6, 8] })
    expect(readDurationSpec({ duration: { kind: 'fixed', value: 5 } })).toEqual({ kind: 'fixed', value: 5 })
  })

  it('declares nothing rather than guessing from a legacy array', () => {
    // The old `durations` shape is exactly what this reader must refuse: `[5, 10]` meant
    // "5 or 10" for Kling and "anything between" for nobody else, and nothing in the array says which.
    expect(readDurationSpec({ durations: [5, 10] })).toBeUndefined()
    expect(readDurationSpec({ duration: [2, 15] })).toBeUndefined()
    expect(readDurationSpec(null)).toBeUndefined()
    expect(readDurationSpec(undefined)).toBeUndefined()
    expect(readDurationSpec({})).toBeUndefined()
  })

  it('refuses a malformed declaration instead of half-trusting it', () => {
    expect(readDurationSpec({ duration: { kind: 'range', min: 15, max: 2 } })).toBeUndefined()
    expect(readDurationSpec({ duration: { kind: 'range', min: 2.5, max: 15 } })).toBeUndefined()
    expect(readDurationSpec({ duration: { kind: 'steps', values: [] } })).toBeUndefined()
    expect(readDurationSpec({ duration: { kind: 'steps', values: [4, 'six'] } })).toBeUndefined()
    expect(readDurationSpec({ duration: { kind: 'whenever' } })).toBeUndefined()
  })

  it('takes the ceiling from whichever shape declared it', () => {
    expect(maxDurationSeconds(readDurationSpec({ duration: { kind: 'range', min: 2, max: 30 } }))).toBe(30)
    expect(maxDurationSeconds(readDurationSpec({ duration: { kind: 'steps', values: [4, 6, 8] } }))).toBe(8)
    expect(maxDurationSeconds(readDurationSpec({ duration: { kind: 'fixed', value: 5 } }))).toBe(5)
    expect(maxDurationSeconds(readDurationSpec({ durations: [5] }))).toBeUndefined()
  })

  it('takes the floor from whichever shape declared it', () => {
    expect(minDurationSeconds(readDurationSpec({ duration: { kind: 'range', min: 2, max: 30 } }))).toBe(2)
    expect(minDurationSeconds(readDurationSpec({ duration: { kind: 'steps', values: [4, 6, 8] } }))).toBe(4)
    expect(minDurationSeconds(readDurationSpec({ duration: { kind: 'fixed', value: 5 } }))).toBe(5)
    expect(minDurationSeconds(readDurationSpec({ durations: [5] }))).toBeUndefined()
    expect(minDurationSeconds(undefined)).toBeUndefined()
  })
})

describe('pinDuration', () => {
  it('keeps a request the model can honour', () => {
    expect(pinDuration({ kind: 'range', min: 2, max: 15 }, 12)).toEqual({ seconds: 12, capped: false })
    // 计划 7 秒就买 7 秒:范围声明不是"每镜都买满上限"。
    expect(pinDuration({ kind: 'range', min: 4, max: 15 }, 7)).toEqual({ seconds: 7, capped: false })
    expect(pinDuration({ kind: 'range', min: 4, max: 15 }, 15)).toEqual({ seconds: 15, capped: false })
    expect(pinDuration({ kind: 'steps', values: [4, 6, 8] }, 6)).toEqual({ seconds: 6, capped: false })
  })

  it('drops to the largest accepted value below the request', () => {
    expect(pinDuration({ kind: 'range', min: 4, max: 15 }, 30)).toEqual({ seconds: 15, capped: true })
    expect(pinDuration({ kind: 'range', min: 4, max: 15 }, 20)).toEqual({ seconds: 15, capped: true })
    // A shot planned at 15 s that lands on Veo buys 8, not the 9 that would be a guess.
    expect(pinDuration({ kind: 'steps', values: [4, 6, 8] }, 15)).toEqual({ seconds: 8, capped: true })
    // Kling takes 5 or 10: 7 is not on the menu and must never reach the vendor.
    expect(pinDuration({ kind: 'steps', values: [5, 10] }, 7)).toEqual({ seconds: 5, capped: true })
    expect(pinDuration({ kind: 'fixed', value: 5 }, 12)).toEqual({ seconds: 5, capped: true })
  })

  it('raises to the model floor when the request sits below every accepted value', () => {
    expect(pinDuration({ kind: 'steps', values: [5, 10] }, 3)).toEqual({ seconds: 5, capped: true })
    expect(pinDuration({ kind: 'range', min: 4, max: 15 }, 1)).toEqual({ seconds: 4, capped: true })
  })

  it('declines to decide when either side is missing', () => {
    expect(pinDuration(undefined, 12)).toBeUndefined()
    expect(pinDuration({ kind: 'range', min: 2, max: 15 }, undefined)).toBeUndefined()
  })
})

describe('the canonical field', () => {
  it('reads only whole positive seconds', () => {
    expect(durationSecondsOf({ [DURATION_KEY]: 8 })).toBe(8)
    for (const value of [{}, { [DURATION_KEY]: null }, { [DURATION_KEY]: 7.5 }, { [DURATION_KEY]: 0 }, { [DURATION_KEY]: -3 }, { [DURATION_KEY]: '8' }]) {
      expect(durationSecondsOf(value)).toBeUndefined()
    }
  })

  it('takes the canonical key out of a map that will be spread to the vendor', () => {
    expect(withoutDurationKey({ seed: 3, [DURATION_KEY]: 8 })).toEqual({ seed: 3 })
    // The same object back, untouched, when there was nothing to remove.
    const without = { seed: 3 }
    expect(withoutDurationKey(without)).toBe(without)
  })
})
