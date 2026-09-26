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

/** 模型自带音轨的片段:画面 testsrc + 一个高频正弦,用来和配音(440Hz)区分。 */
async function clipWithNativeAudio(file: string, seconds: number, frequency: number): Promise<void> {
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=15`,
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`,
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ])
}

/**
 * 只问「这个频段有没有声」,不问响度:成片要过 loudnorm,平均电平一律被拉回
 * -16 LUFS,用音量判「原声留没留」四种模式会测出同一个数。
 * `windowMs` 量画面的某一段:氛围底越界进下一镜时,全片平均会把证据抹平。
 */
async function bandLevel(file: string, fromHz: number, toHz: number, windowMs?: readonly [number, number]): Promise<number> {
  const seek = windowMs
    ? ['-ss', (windowMs[0] / 1000).toFixed(3), '-t', ((windowMs[1] - windowMs[0]) / 1000).toFixed(3)]
    : []
  const { stderr } = await run('ffmpeg', [
    ...seek, '-i', file, '-vn',
    '-af', `highpass=f=${fromHz},lowpass=f=${toHz},volumedetect`,
    '-f', 'null', '-',
  ])
  const mean = /mean_volume: (-?[\d.]+|-?inf) dB/.exec(stderr)
  if (!mean) return Number.NEGATIVE_INFINITY
  const value = Number.parseFloat(mean[1])
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
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

  // 声音来源四档的成片契约:选哪档、听到什么。配音用 440Hz、原声用 2kHz,
  // 两条频段各自探能,不接受"有声音流"这种糊弄断言。
  describe('per-shot audio source', () => {
    const VOICE_BAND: readonly [number, number] = [300, 700]
    const NATIVE_BAND: readonly [number, number] = [1500, 2600]

    async function composeWith(mode: 'voice' | 'native' | 'voice_native' | null) {
      const a = path.join(workdir, 'a.mp4')
      await clipWithNativeAudio(a, 2, 2000)
      const voice = path.join(workdir, 'voice.wav')
      await tone(voice, 440, 2)
      const output = path.join(workdir, 'out.mp4')
      await composer.compose({ clips: [a], voices: [voice], ...(mode ? { audioSources: [mode] } : {}) }, output)
      return { voice: await bandLevel(output, ...VOICE_BAND), native: await bandLevel(output, ...NATIVE_BAND) }
    }

    // aac 编码会把纯正弦泄漏到相邻频段(实测缺席一侧约 -46dB、在场一侧约 -22dB),
    // 所以判据是「该响的比不该响的响 12dB 以上」,不是某个绝对音量。
    it('plays only the voice when the shot is set to voice', async () => {
      const levels = await composeWith('voice')
      expect(levels.voice).toBeGreaterThan(-35)
      expect(levels.voice - levels.native).toBeGreaterThan(12)
    })

    it('plays only the model audio when the shot is set to native, even though a voice exists', async () => {
      const levels = await composeWith('native')
      expect(levels.native).toBeGreaterThan(-35)
      expect(levels.native - levels.voice).toBeGreaterThan(12)
    })

    it('keeps both when the shot is set to voice plus native', async () => {
      const levels = await composeWith('voice_native')
      expect(levels.voice).toBeGreaterThan(-35)
      expect(levels.native).toBeGreaterThan(-35)
    })

    // 没人钦定时不许改行为:有配音就丢原声,和这套控件上线前逐字节一致。
    it('drops the model audio when nobody picked a source', async () => {
      const levels = await composeWith(null)
      expect(levels.voice).toBeGreaterThan(-35)
      expect(levels.voice - levels.native).toBeGreaterThan(12)
    })

    it('stays silent when a native-only shot has no audio stream to play', async () => {
      const a = path.join(workdir, 'a.mp4')
      await clip(a, 2)
      const voice = path.join(workdir, 'voice.wav')
      await tone(voice, 440, 2)
      const output = path.join(workdir, 'out.mp4')

      await composer.compose({ clips: [a], voices: [voice], audioSources: ['native'] }, output)

      const result = await probe(output)
      expect(result.streams.filter(s => s.codec_type === 'audio').length).toBeLessThanOrEqual(1)
      expect(await bandLevel(output, 300, 2600)).toBeLessThan(-70)
    })
  })

  // 环境音是与声音来源正交的一栏:档说人声从哪来,这一条说配音底下垫什么。
  // 三条断言各钉住一件事——它能进混、它占的是原声那一格、它出不了这一镜。
  describe('imported ambience bed', () => {
    const VOICE_BAND: readonly [number, number] = [300, 700]
    // 底用 120Hz：与配音(440)和原声(2k)都拉开两个倍频以上。aac 编码会把纯正弦泄漏到
    // 相邻频段(实测缺席一侧约 -46dB、在场一侧约 -22dB),挨得太近就分不出谁在响。
    const BED_BAND: readonly [number, number] = [60, 220]
    const NATIVE_BAND: readonly [number, number] = [1500, 2600]

    // 「只用配音」原本意味着这一镜只有人声、底是空的;导入一条底就该填上,
    // 不必去赌模型原声里有没有它自己念出来的词。
    it('beds an imported file under a shot that plays only the voice', async () => {
      const a = path.join(workdir, 'a.mp4')
      await clip(a, 2)
      const voice = path.join(workdir, 'voice.wav')
      await tone(voice, 440, 2)
      const bed = path.join(workdir, 'bed.wav')
      await tone(bed, 120, 2)
      const output = path.join(workdir, 'out.mp4')

      await composer.compose({ clips: [a], voices: [voice], audioSources: ['voice'], ambiences: [bed] }, output)

      const levels = {
        voice: await bandLevel(output, ...VOICE_BAND),
        bed: await bandLevel(output, ...BED_BAND),
      }
      expect(levels.voice).toBeGreaterThan(-35)
      expect(levels.bed).toBeGreaterThan(-35)
    })

    // 同一条底不许和模型原声叠在一起:两层环境声糊成一片,比只有一层更难用。
    it('takes the slot the model audio would use instead of stacking on it', async () => {
      const a = path.join(workdir, 'a.mp4')
      await clipWithNativeAudio(a, 2, 2000)
      const voice = path.join(workdir, 'voice.wav')
      await tone(voice, 440, 2)
      const bed = path.join(workdir, 'bed.wav')
      await tone(bed, 120, 2)
      const output = path.join(workdir, 'out.mp4')

      await composer.compose({ clips: [a], voices: [voice], audioSources: ['voice_native'], ambiences: [bed] }, output)

      const bedLevel = await bandLevel(output, ...BED_BAND)
      const nativeLevel = await bandLevel(output, ...NATIVE_BAND)
      expect(bedLevel).toBeGreaterThan(-35)
      expect(nativeLevel - bedLevel).toBeLessThan(-12)
    })

    // 底比镜头长只能切到这一镜末尾:它一旦越过剪点,下一镜就凭空多了上一条街的声音。
    it('trims a bed that outlives its shot instead of spilling into the next', async () => {
      const a = path.join(workdir, 'a.mp4')
      const b = path.join(workdir, 'b.mp4')
      await clip(a, 2)
      await clip(b, 2)
      const bed = path.join(workdir, 'bed.wav')
      await tone(bed, 120, 4)
      const output = path.join(workdir, 'out.mp4')

      await composer.compose({ clips: [a, b], ambiences: [bed, null] }, output)

      const inside = await bandLevel(output, ...BED_BAND, [250, 1750])
      const after = await bandLevel(output, ...BED_BAND, [2250, 3750])
      expect(inside).toBeGreaterThan(-35)
      expect(after - inside).toBeLessThan(-12)
    })
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
