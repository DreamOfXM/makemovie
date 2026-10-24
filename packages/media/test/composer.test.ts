import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUDIO_BRIDGE_PRE_MS, AUDIO_BRIDGE_TAIL_MS, FfmpegComposer, bgmVoiceMixFilter, buildSrt, planAudioBridges, planMasterCuts, run, subtitleModeFromEnv, synthesizeMockMedia, type ShotBed } from '../src/index.js'

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

/**
 * 字幕断言必须自己定交付方式。走硬烧还是软轨由**被测代码会用的那个 ffmpeg**
 * 有没有 libass 决定,而 libass 有无是构建差异(精简构建没有,apt 版有),不是被
 * 测代码的性质——不定死的话同一个断言在不同机器上会得出相反结论。
 * 见 describe('subtitle delivery')。
 */
const savedSubtitleMode = process.env.STUDIO_SUBTITLE_MODE
afterEach(() => {
  if (savedSubtitleMode === undefined) delete process.env.STUDIO_SUBTITLE_MODE
  else process.env.STUDIO_SUBTITLE_MODE = savedSubtitleMode
})

/**
 * 探测走包里的 `run()`——它会按 STUDIO_FFMPEG_DIR 解析 ffmpeg,而裸 execFile 只看
 * PATH。两者可能不是同一个构建(本机默认装的是精简版,.env 又把 STUDIO_FFMPEG_DIR
 * 指向 ffmpeg-full,一个没 libass 一个有),各探各的就会让测试对宿主能力的判断与
 * 被测代码相反:测试以为烧不了,代码其实烧成了。
 */
async function hostCanBurnSubtitles(): Promise<boolean> {
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-filters'])
    return stdout.includes(' subtitles ')
  } catch {
    return false
  }
}

const hostHasLibass = await hostCanBurnSubtitles()

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

    // 钉的是「听不见」，不是「没有音轨」：母带必须每段都带一条音轨，否则后面镜头的
    // 原声会被 concat 一起丢掉（SD-114）。无声镜头带的是静音，交付时依然是静音。
    expect(await bandLevel(output, 20, 20000)).toBeLessThan(-70)
    expect(composed.durationMs).toBeGreaterThanOrEqual(1900)
    expect(composed.durationMs).toBeLessThanOrEqual(2100)
  })

  it('does not drop the next shot audio behind a shot that has none', async () => {
    // 复刻本集真实事故：字卡（无音轨）排第一，第二个镜头带模型原声。修复前母带只剩
    // 视频流、第二个镜头的原声整条消失，而界面一声不吭——用户拿到一条无声整集。
    const card = path.join(workdir, 'card.mp4')
    const shot = path.join(workdir, 'shot.mp4')
    await clip(card, 2)
    await clipWithNativeAudio(shot, 2, 3000)
    const output = path.join(workdir, 'out.mp4')
    const composed = await composer.compose({ clips: [card, shot] }, output)

    expect(await bandLevel(output, 2500, 3500, [2200, 3800])).toBeGreaterThan(-70)
    expect(await bandLevel(output, 2500, 3500, [0, 1800])).toBeLessThan(-70)
    expect(composed.durationMs).toBeGreaterThanOrEqual(3900)
    expect(composed.durationMs).toBeLessThanOrEqual(4100)
  })

  describe('edit-timeline extras (R04)', () => {
    it('mixes an extra track at its timeline offset — audible only in its window', async () => {
      // 3 秒无声画面 + 一条 1 秒 3kHz 音轨,锚定序列 1000ms:1.0–2.0s 必须有声,
      // 之前之后必须静音。修复前 extras 根本不进 composer,全片无声。
      const video = path.join(workdir, 'v.mp4')
      await clip(video, 3)
      const track = path.join(workdir, 't.wav')
      await tone(track, 3000, 1)
      const output = path.join(workdir, 'out.mp4')
      await composer.compose({ clips: [video], extras: [{ file: track, startMs: 1000, gain: 1, muted: false }] }, output)

      const before = await bandLevel(output, 2500, 3500, [0, 900])
      const during = await bandLevel(output, 2500, 3500, [1100, 1900])
      const after = await bandLevel(output, 2500, 3500, [2100, 2900])
      expect(during).toBeGreaterThan(before + 10)
      expect(during).toBeGreaterThan(after + 10)
    })

    it('keeps a muted extra track silent while an unmuted one plays', async () => {
      const video = path.join(workdir, 'v.mp4')
      await clip(video, 3)
      const loud = path.join(workdir, 'loud.wav')
      await tone(loud, 3000, 1)
      const silentTrack = path.join(workdir, 'silent.wav')
      await tone(silentTrack, 500, 1)
      const output = path.join(workdir, 'out.mp4')
      // muted 占位但不发声:窗口内只有 3kHz 那条,500Hz 频段必须无声。
      await composer.compose({ clips: [video], extras: [
        { file: loud, startMs: 1000, gain: 1, muted: false },
        { file: silentTrack, startMs: 1000, gain: 1, muted: true },
      ] }, output)
      const midTone = await bandLevel(output, 2500, 3500, [1100, 1900])
      const mutedBand = await bandLevel(output, 300, 700, [1100, 1900])
      expect(midTone).toBeGreaterThan(-30)
      expect(mutedBand).toBeLessThan(-45)
    })

    it('applies outputSpec aspect by scaling and padding to the target frame', async () => {
      const video = path.join(workdir, 'v.mp4')
      await clip(video, 1) // 320x240
      const output = path.join(workdir, 'out.mp4')
      await composer.compose({ clips: [video], outputSpec: { aspect: '16:9' } }, output)
      const result = await probe(output)
      const stream = result.streams.find(s => s.codec_type === 'video')
      expect(stream?.width).toBe(1920)
      expect(stream?.height).toBe(1080)
    })

    it('keeps a muted extra from truncating the master or replacing its native audio (Q02)', async () => {
      // 5 秒带原声素材 + 1 秒 muted 轨:画面仍 5 秒、原声仍在——muted 轨不建轨、
      // 不截短、不替换。修复前:静音轨混成 finalAudio,再被 -shortest 裁成 1 秒。
      // 3kHz 频段与「完全不加 extras 的基线」对比:两者只差 AAC 底噪(≤3dB),
      // muted 轨没有注入任何内容。
      const video = path.join(workdir, 'v.mp4')
      await clipWithNativeAudio(video, 5, 1000)
      const track = path.join(workdir, 't.wav')
      await tone(track, 3000, 1)
      const baseline = path.join(workdir, 'baseline.mp4')
      await composer.compose({ clips: [video] }, baseline)
      const output = path.join(workdir, 'out.mp4')
      const composed = await composer.compose({ clips: [video], extras: [{ file: track, startMs: 0, gain: 1, muted: true }] }, output)
      expect(composed.durationMs!).toBeGreaterThanOrEqual(4800)
      expect(composed.durationMs!).toBeLessThanOrEqual(5200)
      const native = await bandLevel(output, 800, 1200)
      expect(native).toBeGreaterThan(-35)
      const baselineExtraBand = await bandLevel(baseline, 2500, 3500)
      const extraBand = await bandLevel(output, 2500, 3500)
      expect(Math.abs(extraBand - baselineExtraBand)).toBeLessThan(3)
    })

    it('keeps native audio when only the aspect changes (Q02)', async () => {
      const video = path.join(workdir, 'v.mp4')
      await clipWithNativeAudio(video, 5, 1000)
      const output = path.join(workdir, 'out.mp4')
      await composer.compose({ clips: [video], outputSpec: { aspect: '16:9' } }, output)
      const result = await probe(output)
      expect(result.streams.some(s => s.codec_type === 'audio')).toBe(true)
      const native = await bandLevel(output, 800, 1200)
      expect(native).toBeGreaterThan(-35)
    })

    it('pads a short audible extra to the video timeline instead of cutting the picture (Q02)', async () => {
      const video = path.join(workdir, 'v.mp4')
      await clip(video, 5)
      const track = path.join(workdir, 't.wav')
      await tone(track, 3000, 1)
      const output = path.join(workdir, 'out.mp4')
      const composed = await composer.compose({ clips: [video], extras: [{ file: track, startMs: 1000, gain: 1, muted: false }] }, output)
      expect(composed.durationMs!).toBeGreaterThanOrEqual(4800)
      const during = await bandLevel(output, 2500, 3500, [1100, 1900])
      const after = await bandLevel(output, 2500, 3500, [2500, 4500])
      expect(during).toBeGreaterThan(after + 10)
    })
  })

  it('mixes voice, music and soft subtitles without re-encoding video', async () => {
    process.env.STUDIO_SUBTITLE_MODE = 'soft'
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
    process.env.STUDIO_SUBTITLE_MODE = 'soft'
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
  it('cuts the looping bed at the picture when the master carries native audio', async () => {
    // SD-119：母带自带原声 + 没人配音 + 一条 1 秒循环配乐。修复前 amix 的 duration=first
    // 数的是输入列表里第一个,而那时第一个是 [bed]（-stream_loop -1 无限）——这条命令
    // 永不收尾,实测在临时目录里连写了 81.5 GB 的 mixed.wav（4 秒的画面写了 237 秒还没停）。
    // 这条用例是那条分支唯一的守卫:它跑不完就必然撞测试超时,不会静默把盘写满。
    const native = path.join(workdir, 'native.mp4')
    await clipWithNativeAudio(native, 3, 2000)
    const bgm = path.join(workdir, 'bgm.wav')
    await tone(bgm, 220, 1)
    const output = path.join(workdir, 'out.mp4')

    const composed = await composer.compose({ clips: [native], voices: [null], bgm }, output)

    expect(composed.durationMs).toBeGreaterThanOrEqual(2900)
    expect(composed.durationMs).toBeLessThanOrEqual(3200)
    // 两条都在:配乐确实垫进来了,不是靠丢掉音频流才「跑完」的。
    expect(await bandLevel(output, 1800, 2200)).toBeGreaterThan(-60)
    expect(await bandLevel(output, 180, 260)).toBeGreaterThan(-60)
  })

  it('never re-adds the native track an audio-source decision excluded when extras are mixed in (V04)', async () => {
    // 「只用配音」的镜头:原声(1600Hz)被声音来源档位排除。加一条可闻 extra 后,
    // 修复前 mixExtraTracks 把母带原声无条件混回,1000Hz 与配音一样响——被排除
    // 的声音从后门回来了。修复后主声轨是唯一基底,extra 只叠上去。
    const video = path.join(workdir, 'v.mp4')
    await clipWithNativeAudio(video, 4, 1600)
    const voice = path.join(workdir, 'voice.wav')
    await tone(voice, 440, 2)
    const extra = path.join(workdir, 'extra.wav')
    await tone(extra, 3000, 1)
    const base = path.join(workdir, 'base.mp4')
    await composer.compose({ clips: [video], voices: [voice], audioSources: ['voice'] }, base)
    const mixed = path.join(workdir, 'mixed.mp4')
    await composer.compose({ clips: [video], voices: [voice], audioSources: ['voice'], extras: [{ file: extra, startMs: 0, gain: 0.5, muted: false }] }, mixed)
    const nativeBase = await bandLevel(base, 1400, 1800)
    const nativeMixed = await bandLevel(mixed, 1400, 1800)
    // 原声保持被排除:加 extra 前后的 1000Hz 频段都该接近静音底(±5dB 容差)。
    expect(Math.abs(nativeMixed - nativeBase)).toBeLessThan(5)
    expect(nativeMixed).toBeLessThan(-40)
    // 配音与 extra 各自都在。
    expect(await bandLevel(mixed, 300, 600, [0, 1500])).toBeGreaterThan(-35)
    expect(await bandLevel(mixed, 2500, 3500, [0, 900])).toBeGreaterThan(-40)
  })

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

    // 音频桥（plan §5「环境音提前 0.3–0.5s 进、上一场拖 0.2s 出」）：底越界进前一镜的
    // 画面里,但越界只有那么多——再往前一格必须静音,否则等于把整条底摊成全片背景。
    it('opens the next scene\'s bed under the tail of the previous shot', async () => {
      const a = path.join(workdir, 'a.mp4')
      const b = path.join(workdir, 'b.mp4')
      await clip(a, 2)
      await clip(b, 2)
      const bed = path.join(workdir, 'street.wav')
      await tone(bed, 120, 4)
      const output = path.join(workdir, 'out.mp4')

      // 只有第二镜点名了街声:它必须在前一镜的最后一击里先响起来。
      await composer.compose({ clips: [a, b], ambiences: [null, bed] }, output)

      const before = await bandLevel(output, ...BED_BAND, [250, 1500])
      const preRoll = await bandLevel(output, ...BED_BAND, [1850, 1990])
      const during = await bandLevel(output, ...BED_BAND, [2250, 3750])
      expect(during).toBeGreaterThan(-35)
      // pre-roll 落在淡入斜坡上,允许比满电平低几 dB,但必须是「听得见」且明显高过剪点前那格静音。
      expect(preRoll - before).toBeGreaterThan(12)
      expect(preRoll).toBeGreaterThan(during - 10)
    })

    // 反向那一半:上一场的底拖 0.2s 出画,拖完必须当场断——否则第二镜凭空多了上一条街。
    it('holds the previous bed for the bridge and then stops dead', async () => {
      const a = path.join(workdir, 'a.mp4')
      const b = path.join(workdir, 'b.mp4')
      await clip(a, 2)
      await clip(b, 2)
      const bed = path.join(workdir, 'bed.wav')
      await tone(bed, 120, 4)
      const output = path.join(workdir, 'out.mp4')

      await composer.compose({ clips: [a, b], ambiences: [bed, null] }, output)

      const inside = await bandLevel(output, ...BED_BAND, [250, 1750])
      const tail = await bandLevel(output, ...BED_BAND, [2010, 2100])
      const after = await bandLevel(output, ...BED_BAND, [2400, 3700])
      expect(inside).toBeGreaterThan(-35)
      expect(tail - after).toBeGreaterThan(12)
      expect(tail).toBeGreaterThan(inside - 10)
    })

    // 同一场戏连几镜共用一条底:它是一条声床,不是一段段重播。逐镜重播会让每一刀都
    // 听见「这条街从头响一遍」。顺带钉住短素材自动接上自己循环(SD-119 的教训:
    // 循环必须配硬时长上限,这里 1s 底铺满 4s 而不停)。
    it('plays one bed straight through the shots that share it', async () => {
      const a = path.join(workdir, 'a.mp4')
      const b = path.join(workdir, 'b.mp4')
      await clip(a, 2)
      await clip(b, 2)
      const bed = path.join(workdir, 'bed.wav')
      await tone(bed, 120, 1)
      const output = path.join(workdir, 'out.mp4')

      const composed = await composer.compose({ clips: [a, b], ambiences: [bed, bed] }, output)

      expect(composed.beds).toHaveLength(1)
      expect(composed.beds?.[0]).toMatchObject({ imported: true, shotIndexes: [0, 1], startMs: 0 })
      const firstHalf = await bandLevel(output, ...BED_BAND, [250, 1750])
      // 第二镜这一段已过 1s 素材的原生末尾:只有循环还在跑才可能有声。
      const secondHalf = await bandLevel(output, ...BED_BAND, [2250, 3750])
      expect(firstHalf).toBeGreaterThan(-35)
      expect(secondHalf).toBeGreaterThan(firstHalf - 10)
    })

    // 模型原声不许越界:它带着口型,拖 0.2s 就是把上一镜的台词塞进下一镜的嘴。
    // 下一镜用无声素材,于是剪点后那一格只有两种可能——原声被桥过去了(有声),或者没有(静音)。
    it('keeps a model-native bed inside its own shot', async () => {
      const a = path.join(workdir, 'a.mp4')
      const b = path.join(workdir, 'b.mp4')
      await clipWithNativeAudio(a, 2, 2000)
      await clip(b, 2)
      const output = path.join(workdir, 'out.mp4')

      const composed = await composer.compose({ clips: [a, b], audioSources: ['voice_native', 'voice_native'] }, output)

      expect(composed.beds).toHaveLength(1)
      expect(composed.beds?.[0]).toMatchObject({ imported: false, shotIndexes: [0], fadeInMs: 0, fadeOutMs: 0 })
      expect(await bandLevel(output, ...NATIVE_BAND, [250, 1750])).toBeGreaterThan(-35)
      expect(await bandLevel(output, ...NATIVE_BAND, [2050, 2900])).toBeLessThan(-70)
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
      // 母带现在恒带音轨（缺音轨的段会被垫上等长静音，见 SD-114），所以这里诚实的
      // 理由是「实测近静音」而不是「没有音轨」；loudnorm 对纯静音报 -inf，不许当异常。
      expect(loudnorm?.reason).toContain('near-silent')
      // 无事可做时不许悄悄产出一个"处理过"的副本。
      expect(file).toBe(output)
    })

    it('still names the missing stream when handed a file that has none', async () => {
      const a = path.join(workdir, 'bare.mp4')
      await clip(a, 1)
      const { record } = await composer.postProcess(a, workdir)
      expect(record.steps.find(step => step.step === 'loudnorm')?.reason).toContain('no audio stream')
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

/**
 * 声床落位是纯几何:三条规则各自钉住一个听感缺陷,全部用整数组断言,不需要 ffmpeg。
 * 这里的 totalMs 就是母带总长,首末两镜的越界量必须被它夹住——pre-roll 不能跑到
 * 成片前面之外,tail 不能越过最后一帧(越过只会被裁掉,却把淡出斜坡推到了画面外)。
 */
describe('planAudioBridges', () => {
  const shot = (over: Partial<ShotBed>): ShotBed => ({ file: '/bed.wav', imported: true, shotStartMs: 0, shotDurationMs: 2000, ...over })

  it('pre-rolls an imported bed and tails it out past the cut', () => {
    const [bed] = planAudioBridges([shot({ shotStartMs: 2000 })], 6000)
    expect(bed).toMatchObject({ startMs: 2000 - AUDIO_BRIDGE_PRE_MS, durationMs: 2000 + AUDIO_BRIDGE_PRE_MS + AUDIO_BRIDGE_TAIL_MS, fadeInMs: AUDIO_BRIDGE_PRE_MS, fadeOutMs: AUDIO_BRIDGE_TAIL_MS, shotIndexes: [0] })
  })

  it('clamps the bridge at both ends of the master', () => {
    // 首镜:前面没有画面可垫 → 不 pre-roll。末镜:tail 越过母带末尾 → 不拖。
    const [first, last] = planAudioBridges([shot({}), shot({ file: '/b.wav', shotStartMs: 2000 })], 4000)
    expect(first).toMatchObject({ startMs: 0, fadeInMs: 0, durationMs: 2000 + AUDIO_BRIDGE_TAIL_MS, fadeOutMs: AUDIO_BRIDGE_TAIL_MS })
    expect(last).toMatchObject({ startMs: 2000 - AUDIO_BRIDGE_PRE_MS, fadeInMs: AUDIO_BRIDGE_PRE_MS, fadeOutMs: 0, durationMs: 2000 + AUDIO_BRIDGE_PRE_MS })
    // 末镜只剩 50ms 可拖就只淡 50ms:淡出斜坡必须留在画面内,不许推到母带之外。
    const [short] = planAudioBridges([shot({ file: '/b.wav', shotStartMs: 1950 })], 4000)
    expect(short).toMatchObject({ startMs: 1550, durationMs: 2450, fadeOutMs: 50 })
  })

  it('counts consecutive shots on the same bed as one sound bed', () => {
    // 三镜同一条街:一条 placements 铺满整场,而不是三段各自 pre-roll/tail 互相叠。
    const beds = planAudioBridges([shot({}), shot({ shotStartMs: 2000 }), shot({ shotStartMs: 4000 })], 6000)
    expect(beds).toHaveLength(1)
    expect(beds[0]).toMatchObject({ startMs: 0, durationMs: 6000, fadeInMs: 0, fadeOutMs: 0, shotIndexes: [0, 1, 2] })
    // 分组只看相邻:中间夹了别的底就是另一场戏,后面再回到同一条也不并回来
    // (并过去会让那场戏的声音横跨中间那一镜,正是「凭空多了上一条街」)。
    const split = planAudioBridges([shot({}), shot({ file: '/other.wav', shotStartMs: 2000 }), shot({ shotStartMs: 4000 })], 6000)
    expect(split.map(bed => bed.shotIndexes)).toEqual([[0], [1], [2]])
  })

  it('leaves a model-native bed exactly on its own shot', () => {
    const beds = planAudioBridges([shot({ file: '/a.mp4', imported: false }), shot({ file: '/a.mp4', imported: false, shotStartMs: 2000 })], 4000)
    expect(beds).toHaveLength(2)
    expect(beds[0]).toMatchObject({ imported: false, startMs: 0, durationMs: 2000, fadeInMs: 0, fadeOutMs: 0, shotIndexes: [0] })
    expect(beds[1]).toMatchObject({ imported: false, startMs: 2000, durationMs: 2000, fadeInMs: 0, fadeOutMs: 0, shotIndexes: [1] })
  })

  it('skips a shot with no bed at all', () => {
    const beds = planAudioBridges([shot({ file: null }), shot({ shotStartMs: 2000 })], 4000)
    expect(beds).toHaveLength(1)
    expect(beds[0]!.shotIndexes).toEqual([1])
  })
})

/**
 * 那一刀表是纯几何，先用整数组钉死，再让 ffmpeg 去实现它。三条线各自对应一个真实
 * 事故：①「按标称时长排」会让字幕比画面越来越晚（重叠吃掉的毫秒没人还）；②重叠不
 * 夹取就能把一镜 0.3s 的反应镜吃光，转场变成「这一段没了」；③不足一帧的过渡只会
 * 换来一次重编码，肉眼读不出来。
 */
describe('planMasterCuts', () => {
  const t = (transition: string, transitionMs = 0) => ({ transition, transitionMs })

  it('a plain cut keeps the nominal cumulative timeline', () => {
    const plan = planMasterCuts([2000, 2000, 2000], [t('cut'), t('cut'), t('cut')], 25)
    expect(plan.kindAt).toEqual(['cut', 'cut', 'cut'])
    expect(plan.overlapMs).toEqual([0, 0, 0])
    expect(plan.shotStartMs).toEqual([0, 2000, 4000])
    expect(plan.totalMs).toBe(6000)
    expect(plan.headFadeMs).toBe(0)
    expect(plan.tailFadeMs).toBe(0)
  })

  it('the boundary is written by the shot that comes in', () => {
    const plan = planMasterCuts([4000, 4000], [t('cut'), t('dissolve', 400)], 25)
    expect(plan.kindAt).toEqual(['cut', 'dissolve'])
    expect(plan.overlapMs[1]).toBe(400)
    // 母带当场短这么多：第二镜从 3600ms 起，整集 7600ms 而不是 8000ms。
    expect(plan.shotStartMs).toEqual([0, 3600])
    expect(plan.totalMs).toBe(7600)
  })

  it('a written fade-out still happens even when the next shot names nothing', () => {
    // 前一镜「淡出」+ 后一镜硬切：这一刀必须真的淡到黑再起来，否则这句编辑意图在
    // 成片里一个字都不会发生（时长取前一镜点名的毫秒，并落到整帧上）。
    const plan = planMasterCuts([2000, 2000], [t('fade_out', 480), t('cut')], 25)
    expect(plan.kindAt[1]).toBe('black')
    expect(plan.overlapMs[1]).toBe(480)
    expect(plan.shotStartMs[1]).toBe(1520)
  })

  it('clamps an overlap to half the shorter side, then demotes what is left under 50ms', () => {
    // 400ms 的叠化排在 2s 与 0.3s 之间：0.3s@25fps = 8 帧，一半是 4 帧 = 160ms。
    const clamped = planMasterCuts([2000, 300], [t('cut'), t('dissolve', 400)], 25)
    expect(clamped.overlapMs[1]).toBe(160)
    expect(clamped.shotStartMs[1]).toBe(1840)
    // 反过来：2s 后面接一条 40ms 的极短镜，夹到只剩 1 帧（40ms）——不如裸切。
    const demoted = planMasterCuts([2000, 40], [t('cut'), t('dissolve', 400)], 25)
    expect(demoted.kindAt[1]).toBe('cut')
    expect(demoted.overlapMs[1]).toBe(0)
    expect(demoted.totalMs).toBe(2040)
  })

  it('snaps every shot to whole frames of the timeline rate', () => {
    // 厂商给的 4013.7ms 在 25fps 序列上渲染就是 100 帧 = 4000ms：母带与字幕都以
    // 渲染真实值为准，SD-182 那种「差一帧×62 镜」的漂移不能再靠标称值算。
    const plan = planMasterCuts([4013.7, 4013.7], [t('cut'), t('dissolve', 400)], 25)
    expect(plan.clipMs).toEqual([4000, 4000])
    expect(plan.shotStartMs[1]).toBe(3600)
  })

  it('head and tail fades do not shorten the master', () => {
    const plan = planMasterCuts([2000, 2000], [t('fade_in', 600), t('fade_out', 600)], 25)
    expect(plan.headFadeMs).toBe(600)
    expect(plan.tailFadeMs).toBe(600)
    expect(plan.overlapMs[1]).toBe(0)
    expect(plan.totalMs).toBe(4000)
    // 淡入淡出被夹在本镜画面内（整帧）：200ms = 5 帧的镜头最多淡 2 帧。
    const tight = planMasterCuts([200], [t('fade_in', 600)], 25)
    expect(tight.headFadeMs).toBe(80)
  })

  it('reports a self-consistent table at a non-integral rate', () => {
    // start[i] = start[i-1] + clipMs[i-1] - overlapMs[i] 必须在整数毫秒上逐字成立，
    // 否则消费方（字幕/锚点/声床）按两种算术各推一遍，越到集尾偏得越多。
    const plan = planMasterCuts([1000, 1000, 1000, 1000], [t('cut'), t('dissolve', 333), t('black', 250), t('dissolve', 500)], 29.97)
    expect(plan.overlapMs).toEqual(plan.shotStartMs.map((start, index) => (index === 0 ? 0 : plan.shotStartMs[index - 1]! + plan.clipMs[index - 1]! - start)))
    expect(plan.totalMs).toBe(plan.shotStartMs[3]! + plan.clipMs[3]!)
  })
})

/**
 * 转场必须真的发生在画面上，而不只是数据库里多了一列。纯色片段用来把「叠化」变成
 * 可反驳的读数：中间那一帧既不红也不蓝，两侧通道同时亮。
 */
describe('transition blending (real ffmpeg)', () => {
  let workdir: string
  let composer: FfmpegComposer

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-cuts-'))
    composer = new FfmpegComposer()
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  async function solid(file: string, color: string, seconds: number): Promise<void> {
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:size=320x240:rate=25:duration=${seconds}`, '-pix_fmt', 'yuv420p', file])
  }

  async function frameColor(file: string, atMs: number): Promise<{ r: number; g: number; b: number }> {
    const raw = path.join(workdir, `frame-${atMs}.rgb`)
    await run('ffmpeg', ['-v', 'error', '-i', file, '-ss', (atMs / 1000).toFixed(4), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-y', raw])
    const bytes = await readFile(raw)
    const pixels = Math.max(1, Math.floor(bytes.length / 3))
    let r = 0
    let g = 0
    let b = 0
    for (let index = 0; index < pixels; index += 1) {
      r += bytes[index * 3] ?? 0
      g += bytes[index * 3 + 1] ?? 0
      b += bytes[index * 3 + 2] ?? 0
    }
    return { r: r / pixels, g: g / pixels, b: b / pixels }
  }

  it('dissolves the picture and shortens the master by exactly the overlap', async () => {
    const red = path.join(workdir, 'red.mp4')
    const blue = path.join(workdir, 'blue.mp4')
    await solid(red, 'red', 1)
    await solid(blue, 'blue', 1)
    const cuts = planMasterCuts([1000, 1000], [{ transition: 'cut', transitionMs: 0 }, { transition: 'dissolve', transitionMs: 400 }], 25)
    const output = path.join(workdir, 'out.mp4')
    const composed = await composer.compose({ clips: [red, blue], cuts }, output)

    // 400ms 重叠：两镜各让出 200ms 画面，母带当场短这些——不是「后面全体后移」。
    expect(composed.durationMs).toBeGreaterThanOrEqual(1550)
    expect(composed.durationMs).toBeLessThanOrEqual(1650)
    expect(composed.cuts).toMatchObject({ shotStartMs: [0, 600], totalMs: 1600 })
    const before = await frameColor(output, 300)
    expect(before.r).toBeGreaterThan(180)
    expect(before.b).toBeLessThan(60)
    const middle = await frameColor(output, 800)
    expect(middle.r).toBeGreaterThan(90)
    expect(middle.b).toBeGreaterThan(90)
    expect(middle.r).toBeLessThan(200)
    expect(middle.b).toBeLessThan(200)
    const after = await frameColor(output, 1400)
    expect(after.b).toBeGreaterThan(180)
    expect(after.r).toBeLessThan(60)
  })

  it('mixes the shot audio onto the blended timeline, not the nominal one', async () => {
    // 第二镜的配音落在 600ms（那一刀吃掉 400ms 之后的真实起点）。按标称 1000ms 排
    // 就会让整句台词比画面晚 400ms——本集听出来的「嘴比声慢」就是这个。
    const red = path.join(workdir, 'red.mp4')
    const blue = path.join(workdir, 'blue.mp4')
    await solid(red, 'red', 1)
    await solid(blue, 'blue', 1)
    const voice = path.join(workdir, 'voice.wav')
    await tone(voice, 3000, 0.6)
    const cuts = planMasterCuts([1000, 1000], [{ transition: 'cut', transitionMs: 0 }, { transition: 'dissolve', transitionMs: 400 }], 25)
    const output = path.join(workdir, 'out.mp4')
    await composer.compose({ clips: [red, blue], voices: [null, voice], cuts }, output)

    expect(await bandLevel(output, 2500, 3500, [0, 500])).toBeLessThan(-70)
    expect(await bandLevel(output, 2500, 3500, [700, 1100])).toBeGreaterThan(-50)
  })

  it('keeps an all-cut episode on the stream-copy path', async () => {
    const a = path.join(workdir, 'a.mp4')
    const b = path.join(workdir, 'b.mp4')
    await clip(a, 1)
    await clip(b, 1)
    const cuts = planMasterCuts([1000, 1000], [{ transition: 'cut', transitionMs: 0 }, { transition: 'cut', transitionMs: 0 }], 25)
    const output = path.join(workdir, 'out.mp4')
    const composed = await composer.compose({ clips: [a, b], cuts }, output)
    // 一刀不使就不重编码：报告里没有「实际应用的那一刀表」= 走的是原样直拼。
    expect(composed.cuts).toBeUndefined()
    expect(composed.durationMs).toBeGreaterThanOrEqual(1950)
    expect(composed.durationMs).toBeLessThanOrEqual(2050)
  })
})

/**
 * 字幕的两条交付路径都要被钉住,但判据不能是「宿主的构建差异」:libass 有没有是
 * 谁装的 ffmpeg 决定的(本机默认装的是精简版,.env 把 STUDIO_FFMPEG_DIR 指到
 * ffmpeg-full 之后就带),不是被测代码的性质。走哪条由 STUDIO_SUBTITLE_MODE 定,
 * 于是软轨那条与「硬烧但本机烧不了」这条在本机就能跑,真硬烧那条只在带 libass 的
 * 宿主上跑。两条都按 hostCanBurnSubtitles() 分流,也就是按被测代码会用的那个二进制。
 */
describe('subtitle delivery', () => {
  let workdir: string
  let composer: FfmpegComposer

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-subtitles-'))
    composer = new FfmpegComposer()
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  /** 一个 1 秒画面 + 一句字幕,两条路径都用它。 */
  async function source(): Promise<{ clip: string; srt: string }> {
    const file = path.join(workdir, 'a.mp4')
    await clip(file, 1)
    const srt = path.join(workdir, 'subs.srt')
    await writeFile(srt, buildSrt([{ text: '第一句', fromMs: 0, toMs: 1000 }]))
    return { clip: file, srt }
  }

  it('不填=auto,burn/soft 原样采信,其它值拒绝', () => {
    expect(subtitleModeFromEnv(undefined)).toBe('auto')
    expect(subtitleModeFromEnv('')).toBe('auto')
    expect(subtitleModeFromEnv('  AUTO ')).toBe('auto')
    expect(subtitleModeFromEnv('burn')).toBe('burn')
    expect(subtitleModeFromEnv('soft')).toBe('soft')
    expect(() => subtitleModeFromEnv('hard')).toThrow(/auto, burn or soft/)
  })

  it('指定 soft 时挂 mov_text 软字幕轨', async () => {
    process.env.STUDIO_SUBTITLE_MODE = 'soft'
    const { clip: file, srt } = await source()
    const output = path.join(workdir, 'soft.mp4')

    await composer.compose({ clips: [file], srt }, output)

    const subtitle = (await probe(output)).streams.find(s => s.codec_type === 'subtitle')
    expect(subtitle?.codec_name).toBe('mov_text')
  })

  it.skipIf(!hostHasLibass)('指定 burn 时字幕进画面,成片里不再有独立字幕流', async () => {
    process.env.STUDIO_SUBTITLE_MODE = 'burn'
    const { clip: file, srt } = await source()
    const output = path.join(workdir, 'burn.mp4')

    await composer.compose({ clips: [file], srt }, output)

    const result = await probe(output)
    // 字幕成了像素,所以没有 subtitle 流;烧录必须重编码,视频流仍是 h264。
    // 无声镜头会被垫一条等长静音轨(SD-114),所以这里的音轨是「在的、但听不见」。
    expect(result.streams.map(s => s.codec_type)).toEqual(['video', 'audio'])
    expect(result.streams[0].codec_name).toBe('h264')
  })

  it.skipIf(hostHasLibass)('指定 burn 但本机烧不了时会报错,不静默退回软轨', async () => {
    process.env.STUDIO_SUBTITLE_MODE = 'burn'
    const { clip: file, srt } = await source()

    await expect(composer.compose({ clips: [file], srt }, path.join(workdir, 'x.mp4'))).rejects.toThrow(/libass/)
  })
})
