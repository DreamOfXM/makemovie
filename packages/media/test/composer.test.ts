import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FfmpegComposer, buildSrt, synthesizeMockMedia } from '../src/index.js'

const run = promisify(execFile)

interface ProbeResult {
  streams: { codec_type: string; codec_name?: string; tags?: Record<string, string> }[]
  format: { duration?: string }
}

async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file])
  return JSON.parse(stdout) as ProbeResult
}

async function clip(file: string, seconds: number): Promise<void> {
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=15`, '-pix_fmt', 'yuv420p', file])
}

async function tone(file: string, frequency: number, seconds: number): Promise<void> {
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`, file])
}

describe('ffmpeg composer', () => {
  let workdir: string
  let composer: FfmpegComposer

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-composer-'))
    composer = new FfmpegComposer()
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('keeps a dialogue-free episode silent', async () => {
    const a = path.join(workdir, 'a.mp4')
    const b = path.join(workdir, 'b.mp4')
    await clip(a, 1)
    await clip(b, 1)
    const output = path.join(workdir, 'out.mp4')
    const composed = await composer.compose({ clips: [a, b] }, output)

    const result = await probe(output)
    expect(result.streams.map(s => s.codec_type)).toEqual(['video'])
    expect(composed.durationMs).toBeGreaterThanOrEqual(1900)
    expect(composed.durationMs).toBeLessThanOrEqual(2100)
  })

  it('mixes voice, music and soft subtitles without re-encoding video', async () => {
    const a = path.join(workdir, 'a.mp4')
    const b = path.join(workdir, 'b.mp4')
    await clip(a, 1)
    await clip(b, 1)
    // The first voice runs long past its shot and the second shot is silent, so the
    // track has to be both trimmed and padded from the picture's own timing.
    const voice = path.join(workdir, 'voice.wav')
    await tone(voice, 440, 3)
    const bgm = path.join(workdir, 'bgm.wav')
    await tone(bgm, 220, 2)
    const srt = path.join(workdir, 'subs.srt')
    await writeFile(srt, buildSrt([
      { text: '第一句', fromMs: 0, toMs: 1000 },
      { text: '第二句', fromMs: 1000, toMs: 2000 },
    ]))
    const output = path.join(workdir, 'out.mp4')

    const composed = await composer.compose({ clips: [a, b], voices: [voice, null], bgm, srt }, output)

    const result = await probe(output)
    expect(result.streams.filter(s => s.codec_type === 'video').map(s => s.codec_name)).toEqual(['h264'])
    expect(result.streams.filter(s => s.codec_type === 'audio').map(s => s.codec_name)).toEqual(['aac'])
    const subtitle = result.streams.find(s => s.codec_type === 'subtitle')
    expect(subtitle?.codec_name).toBe('mov_text')
    expect(subtitle?.tags?.language).toBe('zho')
    expect(composed.durationMs).toBeGreaterThanOrEqual(1900)
    expect(composed.durationMs).toBeLessThanOrEqual(2100)
  })

  it('keeps silent shots that follow the last line', async () => {
    const a = path.join(workdir, 'a.mp4')
    const b = path.join(workdir, 'b.mp4')
    const c = path.join(workdir, 'c.mp4')
    await clip(a, 1)
    await clip(b, 1)
    await clip(c, 1)
    const voice = path.join(workdir, 'voice.wav')
    await tone(voice, 440, 1)
    const srt = path.join(workdir, 'subs.srt')
    await writeFile(srt, buildSrt([{ text: '只有第一镜有台词', fromMs: 0, toMs: 1000 }]))
    const output = path.join(workdir, 'out.mp4')

    const composed = await composer.compose({ clips: [a, b, c], voices: [voice, null, null], srt }, output)

    const result = await probe(output)
    expect(result.streams.map(s => s.codec_type)).toEqual(['video', 'audio', 'subtitle'])
    // The cue stops at the end of the first shot; the two that follow are still the film.
    expect(composed.durationMs).toBeGreaterThanOrEqual(2900)
    expect(composed.durationMs).toBeLessThanOrEqual(3100)
  })

  it('falls back to a music bed when nothing is spoken', async () => {
    const a = path.join(workdir, 'a.mp4')
    await clip(a, 2)
    const bgm = path.join(workdir, 'bgm.wav')
    await tone(bgm, 220, 1)
    const output = path.join(workdir, 'out.mp4')

    const composed = await composer.compose({ clips: [a], voices: [null], bgm }, output)

    const result = await probe(output)
    expect(result.streams.filter(s => s.codec_type === 'audio').length).toBe(1)
    // The one-second loop has to cover a two-second picture.
    expect(composed.durationMs).toBeGreaterThanOrEqual(1900)
    expect(composed.durationMs).toBeLessThanOrEqual(2100)
  })

  it('builds subrip timestamps from millisecond offsets', () => {
    expect(buildSrt([
      { text: '第一句', fromMs: 0, toMs: 2_500 },
      { text: '第二句\n换行', fromMs: 2_500, toMs: 3_600_000 + 61_000 },
    ])).toBe(
      '1\n00:00:00,000 --> 00:00:02,500\n第一句\n\n2\n00:00:02,500 --> 01:01:01,000\n第二句\n换行\n',
    )
  })
})
