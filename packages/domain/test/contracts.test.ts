import { describe, expect, it } from 'vitest'
import {
  clipFrameCount, frameToSeconds, isValidSequenceFps, quantizeInFrame, quantizeOutFrame,
  recordStartFrames, sequenceFrameCount, validateClipRange, type ClipRange, type RationalFps,
} from '../src/index.js'

const fps25: RationalFps = { fpsNum: 25, fpsDen: 1 }

describe('sequence fps contract', () => {
  it('allows 24/25/30 and rejects drop-frame style rates', () => {
    expect(isValidSequenceFps(fps25)).toBe(true)
    expect(isValidSequenceFps({ fpsNum: 30000, fpsDen: 1001 })).toBe(false)
  })
})

describe('frame math (方案 §10.2 工作例)', () => {
  it('maps [30,80) at 25fps to 1.2s–3.2s and 50 frames', () => {
    const range: ClipRange = { sourceInFrame: 30, sourceOutFrame: 80 }
    expect(frameToSeconds(range.sourceInFrame, fps25)).toBeCloseTo(1.2, 10)
    expect(frameToSeconds(range.sourceOutFrame, fps25)).toBeCloseTo(3.2, 10)
    expect(clipFrameCount(range)).toBe(50)
  })

  it('quantizes seconds: in floors, out ceils — the editor shows the quantized frames', () => {
    expect(quantizeInFrame(1.21, fps25)).toBe(30)
    expect(quantizeOutFrame(3.19, fps25)).toBe(80)
    expect(quantizeInFrame(1.2, fps25)).toBe(30)
    expect(quantizeOutFrame(3.2, fps25)).toBe(80)
  })

  it('accumulates record starts in whole frames only', () => {
    const starts = recordStartFrames([
      { sourceInFrame: 0, sourceOutFrame: 25 },
      { sourceInFrame: 30, sourceOutFrame: 80 },
    ])
    expect(starts).toEqual([0, 25])
    expect(sequenceFrameCount([
      { sourceInFrame: 0, sourceOutFrame: 25 },
      { sourceInFrame: 30, sourceOutFrame: 80 },
    ])).toBe(75)
  })
})

describe('clip range validation', () => {
  const ok: ClipRange = { sourceInFrame: 30, sourceOutFrame: 80 }
  it('accepts a legal range against the probed frame count', () => {
    expect(validateClipRange(ok, 100)).toBeNull()
    expect(validateClipRange({ sourceInFrame: 0, sourceOutFrame: 100 }, 100)).toBeNull()
  })
  it('rejects empty, negative, non-integer and beyond-media ranges with distinct codes', () => {
    expect(validateClipRange({ sourceInFrame: 30, sourceOutFrame: 30 }, 100)).toBe('empty')
    expect(validateClipRange({ sourceInFrame: -1, sourceOutFrame: 10 }, 100)).toBe('negative')
    expect(validateClipRange({ sourceInFrame: 30.5, sourceOutFrame: 80 }, 100)).toBe('non_integer')
    expect(validateClipRange({ sourceInFrame: 0, sourceOutFrame: 101 }, 100)).toBe('beyond_media')
  })
})
