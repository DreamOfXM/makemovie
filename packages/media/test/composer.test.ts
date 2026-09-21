import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FfmpegComposer, bgmVoiceMixFilter, buildSrt, synthesizeMockMedia } from '../src/index.js'

const run = promisify(execFile)

interface ProbeResult {
  streams: { codec_type: string; codec_name?: string; width?: number; height?: number; tags?: Record<string, string> }[]
  format: { duration?: string; tags?: Record<string, string> }
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
    // The first voice is shorter than its shot and the second shot is silent, so the
    // track has to be padded from the picture's own timing.
    const voice = path.join(workdir, 'voice.wav')
    await tone(voice, 440, 1)
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

  // L-cut 收尾的新契约:台词长过画面时不再腰斩台词,改为末帧定格把画面补到
  // 最后一个字——补帧必须重编码,断言里同时钉住时长与 h264。
  it('holds the last frame when a line outlives its shot instead of cutting the words', async () => {
    const a = path.join(workdir, 'a.mp4')
    const b = path.join(workdir, 'b.mp4')
    await clip(a, 1)
    await clip(b, 1)
    const voice = path.join(workdir, 'voice.wav')
    await tone(voice, 440, 3)
    const output = path.join(workdir, 'out.mp4')

    const composed = await composer.compose({ clips: [a, b], voices: [voice, null] }, output)

    expect(composed.durationMs).toBeGreaterThanOrEqual(2900)
    expect(composed.durationMs).toBeLessThanOrEqual(3100)
    const result = await probe(output)
    expect(result.streams.filter(s => s.codec_type === 'video').map(s => s.codec_name)).toEqual(['h264'])
    expect(result.streams.filter(s => s.codec_type === 'audio').map(s => s.codec_name)).toEqual(['aac'])
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

  // GB 45438-2025: the implicit metadata label is pure muxer work, so it must land on
  // EVERY path — including the stream-copy one that touches no frames at all.
  describe('AIGC labeling', () => {
    const label = {
      badgeText: 'AI生成内容 · AI-Generated Content',
      metadata: { Label: '1', Standard: 'GB 45438-2025', ProduceId: 'comp-test' },
    }

    it('writes the implicit label on the plain-copy path', async () => {
      const a = path.join(workdir, 'a.mp4')
      await clip(a, 1)
      const output = path.join(workdir, 'out.mp4')

      const composed = await composer.compose({ clips: [a], label }, output)

      expect(composed.labeling?.implicit).toBe('written')
      const tag = (await probe(output)).format.tags?.AIGC
      expect(tag).toBeTruthy()
      expect(JSON.parse(tag!)).toMatchObject({ Label: '1', Standard: 'GB 45438-2025', ProduceId: 'comp-test' })
    })

    it('reports the explicit badge truthfully, burned when possible and skipped with a reason when not', async () => {
      const a = path.join(workdir, 'a.mp4')
      await clip(a, 1)
      const voice = path.join(workdir, 'voice.wav')
      await tone(voice, 440, 1)
      const srt = path.join(workdir, 'subs.srt')
      await writeFile(srt, buildSrt([{ text: '台词', fromMs: 0, toMs: 1000 }]))
      const output = path.join(workdir, 'out.mp4')

      const composed = await composer.compose({ clips: [a], voices: [voice], srt, label }, output)

      const labeling = composed.labeling!
      expect(labeling.implicit).toBe('written')
      expect(['burned', 'skipped']).toContain(labeling.explicit)
      if (labeling.explicit === 'skipped') {
        // A skip has to name what the build lacked (no drawtext / no CJK font) — an
        // unlabeled master may only ever be an explained master.
        expect(labeling.reason).toBeTruthy()
      }
      expect((await probe(output)).format.tags?.AIGC).toBeTruthy()
    })
  })

  // 质量地板:loudnorm 默认开、挂点默认关、失败必回退——三条契约都要用真
  // ffmpeg 实测,不接受"参数拼对了"这种间接证据。
  describe('quality floor', () => {
    it('ducks the music bed under speech when the build has sidechaincompress', () => {
      const ducked = bgmVoiceMixFilter(true)
      expect(ducked).toContain('sidechaincompress')
      expect(ducked).toContain('asplit=2')
      expect(ducked).not.toContain('volume=0.25')
    })

    it('keeps the fixed-level bed when the build lacks sidechaincompress', () => {
      expect(bgmVoiceMixFilter(false)).toContain('volume=0.25')
    })

    it('normalizes a hot master to the target loudness and keeps the implicit label', async () => {
      const a = path.join(workdir, 'a.mp4')
      await clip(a, 2)
      const voice = path.join(workdir, 'voice.wav')
      await tone(voice, 440, 2)
      const output = path.join(workdir, 'out.mp4')
      await composer.compose({ clips: [a], voices: [voice] }, output)

      const { file, record } = await composer.postProcess(output, workdir, {
        label: { badgeText: 'AI生成内容', metadata: { Label: '1', Standard: 'GB 45438-2025' } },
      })

      expect(record.status).toBe('applied')
      expect(record.steps.find(step => step.step === 'loudnorm')?.outcome).toBe('applied')
      // 正弦源实测约 -21.8 LUFS(比目标轻),线性增益必须把它抬回 -16 附近——
      // 变轻和变响都要被拉回地板,这才叫归一而不是限幅。
      expect(record.loudness?.before.i).toBeLessThan(-18)
      expect(record.loudness?.after!.i).toBeGreaterThanOrEqual(-18)
      expect(record.loudness?.after!.i).toBeLessThanOrEqual(-14)
      // 重封装丢标是静默合规事故:AIGC 必须跟着处理后的文件走。
      expect((await probe(file)).format.tags?.AIGC).toBeTruthy()
      expect(file).not.toBe(output)
    })

    it('records an honest skip instead of normalizing a silent master', async () => {
      const a = path.join(workdir, 'a.mp4')
      await clip(a, 1)
      const output = path.join(workdir, 'out.mp4')
      await composer.compose({ clips: [a] }, output)

      const { file, record } = await composer.postProcess(output, workdir)

      expect(record.status).toBe('applied')
      const loudnorm = record.steps.find(step => step.step === 'loudnorm')
      expect(loudnorm?.outcome).toBe('skipped')
      expect(loudnorm?.reason).toContain('no audio')
      // 无事可做时不许悄悄产出一个"处理过"的副本。
      expect(file).toBe(output)
    })

    it('falls back to the untouched master with a reason when an enabled step fails', async () => {
      const a = path.join(workdir, 'a.mp4')
      await clip(a, 1)
      const output = path.join(workdir, 'out.mp4')
      await composer.compose({ clips: [a] }, output)
      process.env.STUDIO_GRADE_VIDEO_FILTER = 'nosuchfilter=1'
      try {
        const { file, record } = await composer.postProcess(output, workdir)
        expect(file).toBe(output)
        expect(record.status).toBe('fallback')
        expect(record.reason).toBeTruthy()
      } finally {
        delete process.env.STUDIO_GRADE_VIDEO_FILTER
      }
    })

    it('upscales a below-floor master when the min-height hook is on', async () => {
      const a = path.join(workdir, 'a.mp4')
      await clip(a, 1)
      const output = path.join(workdir, 'out.mp4')
      await composer.compose({ clips: [a] }, output)
      process.env.STUDIO_POSTPROCESS_MIN_HEIGHT = '480'
      try {
        const { file, record } = await composer.postProcess(output, workdir)
        expect(record.status).toBe('applied')
        expect(record.steps.find(step => step.step === 'upscale')?.outcome).toBe('applied')
        const video = (await probe(file)).streams.find(s => s.codec_type === 'video')
        expect(video?.height).toBe(480)
      } finally {
        delete process.env.STUDIO_POSTPROCESS_MIN_HEIGHT
      }
    })
  })
})
