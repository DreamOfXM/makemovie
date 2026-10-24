import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { checkAudioTechnicals, diffTranscript } from '../src/index.js'

const exec = promisify(execFile)

describe('diffTranscript (US-033)', () => {
  it('reports nothing when the transcript matches up to punctuation and whitespace', () => {
    expect(diffTranscript('又是这种天气。', { transcript: '又是这种天气' })).toEqual([])
    expect(diffTranscript('There is writing on the back...', { transcript: 'there is writing on the back' })).toEqual([])
    expect(diffTranscript('你也被困在这里了？', { transcript: '你也被困在这里了? ', segments: [{ startMs: 0, endMs: 2000, text: '你也被困在这里了?' }] })).toEqual([])
  })

  it('reports nothing when the segments jointly cover the line even split across cuts', () => {
    const result = diffTranscript('又是这种天气。照片背面有字。', {
      transcript: '又是这种天气。照片背面有字。',
      segments: [
        { startMs: 0, endMs: 1500, text: '又是这种天气。' },
        { startMs: 1500, endMs: 3000, text: '照片背面有字。' },
      ],
    })
    expect(result).toEqual([])
  })

  // FR-Q06:没有段信息时不伪造词级定位——整段一条,不带时间。
  it('degrades to one whole-level item when there are no segments', () => {
    expect(diffTranscript('你也被困在这里了？', { transcript: '' })).toEqual([{ kind: 'missing', expectedText: '你也被困在这里了？' }])
    expect(diffTranscript('', { transcript: '这里什么都没有。' })).toEqual([{ kind: 'extra', actualText: '这里什么都没有。' }])
    expect(diffTranscript('快跟我走。', { transcript: '快离开这里。' })).toEqual([
      { kind: 'mismatch', expectedText: '快跟我走。', actualText: '快离开这里。' },
    ])
    // 有 segments 字段但全是空段:同样不猜定位。
    expect(diffTranscript('快跟我走。', { transcript: '快离开这里。', segments: [] })).toEqual([
      { kind: 'mismatch', expectedText: '快跟我走。', actualText: '快离开这里。' },
    ])
  })

  it('locates a one-for-one mismatch to its segment with times', () => {
    const result = diffTranscript('快跟我走。', {
      transcript: '快离开这里。',
      segments: [{ startMs: 1200, endMs: 2600, text: '快离开这里。' }],
    })
    expect(result).toEqual([{ kind: 'mismatch', expectedText: '快跟我走。', actualText: '快离开这里。', startMs: 1200, endMs: 2600 }])
  })

  it('keeps a noise-only segment as its own extra rather than pairing it into a mismatch', () => {
    const result = diffTranscript('快跟我走。', {
      transcript: '（杂音）快离开这里。',
      segments: [
        { startMs: 0, endMs: 1200, text: '（杂音）' },
        { startMs: 1200, endMs: 2600, text: '快离开这里。' },
      ],
    })
    expect(result).toEqual([
      { kind: 'missing', expectedText: '快跟我走。' },
      { kind: 'extra', actualText: '（杂音）', startMs: 0, endMs: 1200 },
      { kind: 'extra', actualText: '快离开这里。', startMs: 1200, endMs: 2600 },
    ])
  })

  it('splits missing and extra when the counts do not pair up', () => {
    const result = diffTranscript('第一句。第二句。', {
      transcript: '念了别的。',
      segments: [{ startMs: 0, endMs: 1800, text: '念了别的。' }],
    })
    expect(result).toEqual([
      { kind: 'missing', expectedText: '第一句。' },
      { kind: 'missing', expectedText: '第二句。' },
      { kind: 'extra', actualText: '念了别的。', startMs: 0, endMs: 1800 },
    ])
  })

  it('flags every unexpected segment as extra against an empty expected line, with times', () => {
    const result = diffTranscript('', {
      transcript: '多了一句。又多了一句。',
      segments: [
        { startMs: 0, endMs: 1000, text: '多了一句。' },
        { startMs: 1000, endMs: 2000, text: '又多了一句。' },
      ],
    })
    expect(result).toEqual([
      { kind: 'extra', actualText: '多了一句。', startMs: 0, endMs: 1000 },
      { kind: 'extra', actualText: '又多了一句。', startMs: 1000, endMs: 2000 },
    ])
  })

  it('reports a clause no segment contains as missing without inventing a time', () => {
    const result = diffTranscript('第一句。漏掉的一句。', {
      transcript: '第一句。',
      segments: [{ startMs: 0, endMs: 900, text: '第一句。' }],
    })
    expect(result).toEqual([{ kind: 'missing', expectedText: '漏掉的一句。' }])
  })

  it('falls back to whole-level when every clause is matched but the transcripts still differ', () => {
    const result = diffTranscript('快走。', {
      transcript: '快走。快走。',
      segments: [{ startMs: 0, endMs: 2000, text: '快走。' }],
    })
    expect(result).toEqual([{ kind: 'mismatch', expectedText: '快走。', actualText: '快走。快走。' }])
  })
})

describe('checkAudioTechnicals (US-033)', () => {
  let workdir: string

  beforeAll(async () => {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'asr-tech-'))
  })

  afterAll(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('warns on near-full-scale audio (suspected clipping) and stays quiet on a healthy level', async () => {
    const hot = path.join(workdir, 'hot.wav')
    // lavfi sine 默认约 -18dB,补 18dB 拉到满幅附近:实测 max_volume ≈ -0.1dB,越 -0.5dB 阈。
    await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-af', 'volume=18dB', hot])
    const findings = await checkAudioTechnicals(hot)
    expect(findings.some(f => f.id === 'audio_clipping' && f.severity === 'warning' && f.dimension === 'audio')).toBe(true)

    const healthy = path.join(workdir, 'healthy.wav')
    await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-af', 'volume=-12dB', healthy])
    const quiet = await checkAudioTechnicals(healthy)
    expect(quiet.some(f => f.id === 'audio_clipping')).toBe(false)
    expect(quiet.some(f => f.id === 'audio_silence')).toBe(false)
  }, 30_000)

  it('warns on near-silent audio', async () => {
    const silent = path.join(workdir, 'silent.wav')
    await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-af', 'volume=-70dB', silent])
    const findings = await checkAudioTechnicals(silent)
    expect(findings.some(f => f.id === 'audio_silence' && f.severity === 'warning')).toBe(true)
  }, 30_000)

  it('treats a probe failure as no findings, not as a fault', async () => {
    expect(await checkAudioTechnicals('/nonexistent/audio.wav')).toEqual([])
  })
})
