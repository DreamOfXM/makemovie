import { describe, expect, it } from 'vitest'
import { conformToEditMedia, editFingerprint, editMediaCacheKey } from '../src/index.js'
import {
  clipFrameCount, frameToSeconds, quantizeInFrame, quantizeOutFrame,
  recordStartFrames, sequenceFrameCount, validateClipRange,
} from '../../../packages/domain/src/index.js'
type ClipRange = { sourceInFrame: number; sourceOutFrame: number }
type RationalFps = { fpsNum: number; fpsDen: number }
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const fps25: RationalFps = { fpsNum: 25, fpsDen: 1 }

describe('editMedia cache key', () => {
  it('keys on checksum + fps + policy version', () => {
    const a = editMediaCacheKey({ originalChecksum: 'abc', fpsNum: 25, fpsDen: 1, conformPolicyVersion: 1 })
    const b = editMediaCacheKey({ originalChecksum: 'abc', fpsNum: 25, fpsDen: 1, conformPolicyVersion: 1 })
    const c = editMediaCacheKey({ originalChecksum: 'abc', fpsNum: 30, fpsDen: 1, conformPolicyVersion: 1 })
    const d = editMediaCacheKey({ originalChecksum: 'xyz', fpsNum: 25, fpsDen: 1, conformPolicyVersion: 1 })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toBe(d)
  })
})

describe('edit fingerprint', () => {
  it('is deterministic for same clips/tracks, different for any change', () => {
    const base = {
      fpsNum: 25, fpsDen: 1,
      clips: [{ clipId: 'c1', artifactId: 'a1', sourceInFrame: 0, sourceOutFrame: 50 }],
      tracks: [{ elementId: 't1', sourceArtifactId: 'a1', anchor: 'clip' }],
    }
    expect(editFingerprint(base)).toBe(editFingerprint(base))
    expect(editFingerprint(base)).not.toBe(editFingerprint({ ...base, clips: [...base.clips, { clipId: 'c2', artifactId: 'a1', sourceInFrame: 0, sourceOutFrame: 25 }] }))
    expect(editFingerprint(base)).not.toBe(editFingerprint({ ...base, fpsNum: 30 }))
  })
})

describe('conformToEditMedia (real ffmpeg)', () => {
  it('conforms a mock video to CFR and reports the probed frame count', async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-editmedia-'))
    try {
      // 用 synthesizeMockMedia 同款参数造一段 25fps 3 秒测试源。
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const exec = promisify(execFile)
      const source = path.join(workdir, 'source.mp4')
      await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25', '-pix_fmt', 'yuv420p', source])

      const result = await conformToEditMedia(source, 25, 1, workdir)
      expect(result).not.toBeNull()
      expect(result!.probe.frameCount).toBeGreaterThanOrEqual(74) // 3s@25fps ≈ 75,容差 1
      expect(result!.probe.frameCount).toBeLessThanOrEqual(76)
      expect(result!.probe.width).toBe(320)
      expect(result!.probe.fpsNum).toBe(25)
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  }, 30_000)

  it('returns null for a nonexistent file (no precise trim on broken media)', async () => {
    const result = await conformToEditMedia('/nonexistent/file.mp4', 25, 1, '/tmp')
    expect(result).toBeNull()
  })
})

describe('mixed/VFR/nonzero-PTS cutpoint math (§10.2 examples)', () => {
  it('frame indices are editMedia indices, not source video frame numbers', () => {
    // 29.97fps 源先转 25fps editMedia;[30,80) = editMedia 帧,即源介质的 1.2s–3.2s。
    const range: ClipRange = { sourceInFrame: 30, sourceOutFrame: 80 }
    expect(frameToSeconds(range.sourceInFrame, fps25)).toBeCloseTo(1.2, 10)
    expect(frameToSeconds(range.sourceOutFrame, fps25)).toBeCloseTo(3.2, 10)
    expect(clipFrameCount(range)).toBe(50)
    expect(validateClipRange(range, 100)).toBeNull()
  })

  it('accumulates record starts in whole frames; total is the sum', () => {
    const ranges: ClipRange[] = [
      { sourceInFrame: 0, sourceOutFrame: 25 },
      { sourceInFrame: 30, sourceOutFrame: 80 },
    ]
    expect(recordStartFrames(ranges)).toEqual([0, 25])
    expect(sequenceFrameCount(ranges)).toBe(75)
  })

  it('seconds quantize: in floors, out ceils', () => {
    expect(quantizeInFrame(1.21, fps25)).toBe(30)
    expect(quantizeOutFrame(3.19, fps25)).toBe(80)
  })

  it('rejects out-of-range, empty and negative ranges against the probed count', () => {
    expect(validateClipRange({ sourceInFrame: 0, sourceOutFrame: 101 }, 100)).toBe('beyond_media')
    expect(validateClipRange({ sourceInFrame: 30, sourceOutFrame: 30 }, 100)).toBe('empty')
    expect(validateClipRange({ sourceInFrame: -1, sourceOutFrame: 10 }, 100)).toBe('negative')
  })
})
