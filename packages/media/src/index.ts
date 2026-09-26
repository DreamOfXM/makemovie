import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

export * from './reference-image.js'

/**
 * The one child-process helper this package spawns through. Exported so sibling
 * modules (`reference-image.ts`) probe and encode with the same call rather than each
 * writing their own `execFile` wrapper. `STUDIO_FFMPEG_DIR` re-points ffmpeg and ffprobe
 * at a different build: the system one may be a slim build without drawtext or
 * libass, and the AI label must burn when the operator has a full build to point at.
 */
const execFileAsync = promisify(execFile)
export async function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const dir = process.env.STUDIO_FFMPEG_DIR
  const binary = dir && (command === 'ffmpeg' || command === 'ffprobe') ? path.join(dir, command) : command
  return execFileAsync(binary, args)
}

export interface MediaArtifact {
  key: string
  checksum: string
  mimeType: string
  width?: number
  height?: number
  durationMs?: number
}

export function buildObjectKey(input: { tenantId: string; projectId: string; episodeId: string; stage: string; entityId: string; version: number; extension: string }): string {
  return [input.tenantId, input.projectId, input.episodeId, input.stage, input.entityId, `v${input.version}.${input.extension}`].join('/')
}

export interface StoredObject {
  key: string
  checksum: string
  sizeBytes: number
  mimeType: string
}

export interface StorageStream {
  body: Readable
  /**
   * Carried beside the body because the `MediaArtifact` row has no size column, so the
   * backend is the only place a content-length can come from. S3 returns it on the same
   * `GetObject` call that returns the body, so this costs no extra round-trip.
   */
  sizeBytes: number
}

export interface Storage {
  put(key: string, data: Uint8Array, mimeType: string): Promise<StoredObject>
  read(key: string): Promise<Uint8Array>
  exists(key: string): Promise<boolean>
  /**
   * Opens the object for HTTP delivery. Resolves `null` when it is absent rather than
   * throwing: the API turns that into its `artifact file not found` response, and a
   * missing object is an expected outcome here, not a fault.
   */
  open(key: string): Promise<StorageStream | null>
  /**
   * Releases whatever the backend holds open. An S3 client keeps a live socket agent
   * that will otherwise hold the process up; the disk backend has nothing to release.
   */
  close(): Promise<void>
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export class DiskStorage implements Storage {
  // Strip-only TypeScript (the runtime for source-exported packages) cannot erase
  // parameter properties, so the field is declared explicitly.
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  // Private: a filesystem path is an implementation detail no object-store backend can
  // offer. The traversal guard stays, because every public method resolves through it.
  private resolve(key: string): string {
    const resolved = path.resolve(this.root, key)
    const root = path.resolve(this.root)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`object key escapes storage root: ${key}`)
    }
    return resolved
  }

  async put(key: string, data: Uint8Array, mimeType: string): Promise<StoredObject> {
    const target = this.resolve(key)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, data)
    return { key, checksum: sha256(data), sizeBytes: data.byteLength, mimeType }
  }

  async read(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.resolve(key)))
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolve(key))
      return true
    } catch {
      return false
    }
  }

  async open(key: string): Promise<StorageStream | null> {
    const target = this.resolve(key)
    let sizeBytes: number
    try {
      sizeBytes = (await stat(target)).size
    } catch {
      return null
    }
    return { body: createReadStream(target), sizeBytes }
  }

  async close(): Promise<void> {
    // Nothing is held open between calls; each one opens and closes its own handle.
  }
}

export interface S3Options {
  endpoint: string
  bucket: string
  region: string
  accessKey: string
  secretKey: string
}

/**
 * The two commands used here signal absence differently: `GetObject` answers
 * `NoSuchKey` with an XML body, `HeadObject` answers a bare 404 with none and the SDK
 * names that `NotFound`. The status code is checked as well because it is the one part
 * that does not depend on how a particular gateway shapes its error body.
 *
 * UNVERIFIED against a real service — no credentials and no MinIO are available here.
 * `test/s3-storage.test.ts` drives a real `S3Client` against an in-process server that
 * answers the documented responses, so request shaping, length extraction and absence
 * handling are covered. That server ignores the `Authorization` header, so whether a
 * real endpoint accepts our signature is not.
 */
function isAbsentObject(error: unknown): boolean {
  const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return failure?.name === 'NoSuchKey' || failure?.name === 'NotFound' || failure?.$metadata?.httpStatusCode === 404
}

export class S3Storage implements Storage {
  private readonly client: S3Client
  private readonly bucket: string

  constructor(options: S3Options) {
    this.bucket = options.bucket
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
      // MinIO and most S3-compatible gateways have no wildcard DNS for bucket
      // subdomains, so the bucket belongs in the path rather than the host.
      forcePathStyle: true,
      // Otherwise the SDK signs uploads as aws-chunked in order to attach a checksum,
      // putting transfer framing on the wire in place of the caller's bytes and
      // breaking gateways that do not implement it.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
  }

  async put(key: string, data: Uint8Array, mimeType: string): Promise<StoredObject> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: mimeType }))
    return { key, checksum: sha256(data), sizeBytes: data.byteLength, mimeType }
  }

  async read(key: string): Promise<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    return await response.Body!.transformToByteArray()
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return true
    } catch (error) {
      if (isAbsentObject(error)) return false
      throw error
    }
  }

  async open(key: string): Promise<StorageStream | null> {
    let response
    try {
      response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    } catch (error) {
      if (isAbsentObject(error)) return null
      throw error
    }
    // A 200 carrying no length means something between us and the service rewrote the
    // response. Reporting 0 would serve an empty body and hide that as a blank artifact.
    const sizeBytes = response.ContentLength
    if (sizeBytes === undefined) throw new Error(`s3: GetObject for ${key} reported no ContentLength`)
    // GetObject answers with the length beside the body, so no HeadObject is needed.
    return { body: response.Body as unknown as Readable, sizeBytes }
  }

  async close(): Promise<void> {
    this.client.destroy()
  }
}

export interface StorageOptions {
  storageBackend: 'disk' | 's3'
  artifactsDir: string
  s3Endpoint: string
  s3Bucket: string
  s3Region: string
  s3AccessKey: string
  s3SecretKey: string
}

/**
 * Builds the one backend both processes use, so neither grows its own switch. Options
 * are structural rather than `AppConfig` — which satisfies them — to keep this package
 * from depending on `@studio/config`.
 */
export function storageFrom(options: StorageOptions): Storage {
  if (options.storageBackend !== 's3') return new DiskStorage(options.artifactsDir)
  return new S3Storage({
    endpoint: options.s3Endpoint,
    bucket: options.s3Bucket,
    region: options.s3Region,
    accessKey: options.s3AccessKey,
    secretKey: options.s3SecretKey,
  })
}

export interface ComposeResult {
  durationMs: number
  /**
   * What the GB 45438-2025 label request actually got: the implicit metadata is written
   * whenever a label was asked for, the explicit badge only when this ffmpeg build can
   * burn text. A skip is a visible compliance fact, so it travels back for the caller
   * to record next to the master — silence is the one outcome the audit may not have.
   */
  labeling?: { explicit: 'burned' | 'skipped'; reason?: string; implicit: 'written' }
}

export interface AigcLabel {
  /** Text of the corner badge burned into the picture (显式标识). */
  badgeText: string
  /** Structured fields muxed into the container as an AIGC tag (隐式标识). */
  metadata: Record<string, string>
}

/**
 * 这一镜成片里听到什么。`voice` 只用人声轨，`native` 只留模型自带音轨，
 * `voice_native` 把原声当氛围垫在配音下面。null = 没人钦定，沿用老语义
 * （有配音就丢原声，没配音才留原声）——保持未改动镜头的成片逐字节不变。
 */
export type ShotAudioMode = 'voice' | 'native' | 'voice_native'

export interface ComposeInput {
  /** Final video clips, in shot order. */
  clips: string[]
  /** Spoken audio per clip, aligned by index; null or missing means the shot is silent. */
  voices?: (string | null)[]
  /** Audio source per clip, aligned by index; see `ShotAudioMode`. */
  audioSources?: (ShotAudioMode | null)[]
  /**
   * 人工导入的环境音 per clip, aligned by index. Orthogonal to `audioSources`: whatever
   * the shot's voice is, this beds under it at the ambience level — so a shot whose
   * model-native audio carries its own spoken words can still get a room tone.
   */
  ambiences?: (string | null)[]
  /** Music bed, looped under the voice (ducked when the ffmpeg build has sidechaincompress, otherwise a fixed level) and cut to the master. */
  bgm?: string
  /** SubRip file muxed as a soft subtitle track; burning in would re-encode the whole video. */
  srt?: string
  /** AI-content labeling for the delivered master; absent means the master ships unlabeled. */
  label?: AigcLabel
}

export interface Composer {
  /** Concatenates clips in order, mixing voice, music and subtitles in when they exist. */
  compose(input: ComposeInput, output: string): Promise<ComposeResult>
  /** Quality-floor pass over the finished master; see `FfmpegComposer.postProcess`. */
  postProcess(master: string, workdir: string, options?: PostProcessOptions): Promise<MasterPostProcessResult>
}

export interface PostProcessOptions {
  /**
   * The GB 45438 label to re-apply. Custom mp4 tags only survive a re-mux when the
   * write flag is passed again — a post-pass that forgets this silently erases the
   * implicit mark the compose step just burned in.
   */
  label?: AigcLabel
}

export interface MasterPostProcessRecord {
  status: 'applied' | 'fallback'
  steps: Array<{ step: 'loudnorm' | 'upscale' | 'interpolate' | 'grade'; outcome: 'applied' | 'skipped'; reason?: string }>
  /** Measured EBU R128 readings (LUFS / dBTP) — the audio item's evidence in the manifest. */
  loudness?: { before: { i: number; tp: number }; after?: { i: number; tp: number } }
  target?: { i: number; tp: number }
  /** Why the untouched master shipped when status is `fallback`; never silent. */
  reason?: string
}

export interface MasterPostProcessResult {
  /** The file to ship: the processed copy when applied, the untouched master on fallback. */
  file: string
  record: MasterPostProcessRecord
}

export async function probeDuration(file: string): Promise<number> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ])
    return Math.round(parseFloat(stdout.trim()) * 1000) || 0
  } catch {
    return 0
  }
}

/** 片段是否带音轨:图生视频模型(如 wanx2.1)无声,而 wan3.0 带环境音——合成时区别对待。 */
export async function hasAudioStream(file: string): Promise<boolean> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ])
    return stdout.includes('audio')
  } catch {
    return false
  }
}

export interface SubtitleEntry {
  text: string
  fromMs: number
  toMs: number
}

export function buildSrt(entries: SubtitleEntry[]): string {
  return entries
    .map((entry, index) => `${index + 1}\n${srtTimestamp(entry.fromMs)} --> ${srtTimestamp(entry.toMs)}\n${entry.text}\n`)
    .join('\n')
}

function srtTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms))
  const pad = (value: number, width: number) => String(value).padStart(width, '0')
  return `${pad(Math.floor(clamped / 3_600_000), 2)}:${pad(Math.floor(clamped / 60_000) % 60, 2)}:${pad(Math.floor(clamped / 1000) % 60, 2)},${pad(clamped % 1000, 3)}`
}

/**
 * 剪辑交接(EDL / FCPXML):把成片逐镜时间线交给 NLE,让精剪在专业工具里做,
 * 而不是逼人在浏览器里重剪。两份导出共用同一组帧数学——时长一律换算到整帧
 * (四舍五入),record 侧偏移严格累计,导出与母带的镜头顺序逐一对应。
 */
export interface EditClip {
  number: number
  title: string
  durationMs: number
  /** NLE 源监视器里显示的切片文件名。 */
  sourceFile: string
  /** true = 实测自切片文件; false = 回退到分镜规划时长。 */
  measured: boolean
}

export interface EditListInput {
  title: string
  clips: EditClip[]
  /** 时间线帧率，默认 25。 */
  fps?: number
}

const EDIT_FPS = 25

function toFrames(ms: number, fps: number): number {
  return Math.max(0, Math.round((Math.max(0, ms) / 1000) * fps))
}

function timecode(frames: number, fps: number): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(Math.floor(frames / (3600 * fps)))}:${pad(Math.floor(frames / (60 * fps)) % 60)}:${pad(Math.floor(frames / fps) % 60)}:${pad(frames % fps)}`
}

/** CMX 3600 EDL：剪辑师与套底工具通吃的最小公分母。 */
export function buildEdl(input: EditListInput): string {
  const fps = input.fps ?? EDIT_FPS
  const lines = [`TITLE: ${input.title}`, 'FCM: NON-DROP FRAME', '']
  let recordFrames = 0
  input.clips.forEach((clip, index) => {
    const frames = toFrames(clip.durationMs, fps)
    const sourceIn = recordFrames
    const sourceOut = recordFrames + frames
    recordFrames += frames
    const event = String(index + 1).padStart(3, '0')
    lines.push(`${event}  AX                       V     C        ${timecode(0, fps)} ${timecode(frames, fps)} ${timecode(sourceIn, fps)} ${timecode(sourceOut, fps)}`)
    lines.push(`* FROM CLIP NAME: #${clip.number} ${clip.title}`)
    lines.push(`* SOURCE: ${clip.sourceFile}${clip.measured ? '' : ' (planned duration, clip unmeasured)'}`)
    lines.push('')
  })
  return lines.join('\n')
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** FCPXML 1.10：Final Cut Pro / 达芬奇可直接导入的整集粗剪。 */
export function buildFcpxml(input: EditListInput): string {
  const fps = input.fps ?? EDIT_FPS
  const rational = (frames: number) => `${frames}/${fps}s`
  const total = input.clips.reduce((sum, clip) => sum + toFrames(clip.durationMs, fps), 0)
  const assets: string[] = []
  const spine: string[] = []
  let offset = 0
  input.clips.forEach((clip, index) => {
    const frames = toFrames(clip.durationMs, fps)
    const id = `x${index + 1}`
    const name = `#${clip.number} ${clip.title}${clip.measured ? '' : ' (planned)'}`
    assets.push(`    <asset id="${id}" name="${xmlEscape(name)}" src="file:///${xmlEscape(clip.sourceFile)}" start="0s" duration="${rational(frames)}" hasVideo="1" hasAudio="1" format="r1" />`)
    spine.push(`        <asset-clip ref="${id}" offset="${rational(offset)}" duration="${rational(frames)}" format="r1" name="${xmlEscape(name)}" start="0s" />`)
    offset += frames
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.10">',
    '  <resources>',
    `    <format id="r1" frameDuration="1/${fps}s" width="1080" height="1920" />`,
    ...assets,
    `    <sequence id="r0" name="${xmlEscape(input.title)}" format="r1" tcStart="0s" tcDuration="${rational(total)}" audioLayout="stereo" audioRate="48k">`,
    '      <spine>',
    ...spine,
    '      </spine>',
    '    </sequence>',
    '  </resources>',
    '</fcpxml>',
    '',
  ].join('\n')
}

const AUDIO_SHAPE = 'aformat=sample_rates=44100:channel_layouts=stereo'
let subtitlesFilterAvailable: boolean | null = null

/** 本机 ffmpeg 是否带字幕烧录滤镜(libass)。精简构建没有,探测一次并缓存。 */
async function detectSubtitlesFilter(): Promise<boolean> {
  if (subtitlesFilterAvailable !== null) return subtitlesFilterAvailable
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-filters'])
    subtitlesFilterAvailable = stdout.includes(' subtitles ')
  } catch {
    subtitlesFilterAvailable = false
  }
  return subtitlesFilterAvailable
}
const BGM_VOLUME = '0.25'
/** 有 ducking 时垫底音量可以更高:台词间隙 BGM 该有存在感,说话时再压下去。 */
const BGM_DUCK_BED = '0.5'

/** 本机 ffmpeg 是否带某滤镜。精简构建与完整构建的差集很大,探测一次并缓存。 */
const filterAvailability = new Map<string, boolean>()
async function hasFilter(name: string): Promise<boolean> {
  const cached = filterAvailability.get(name)
  if (cached !== undefined) return cached
  let available = false
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-filters'])
    available = stdout.includes(` ${name} `)
  } catch {
    available = false
  }
  filterAvailability.set(name, available)
  return available
}

/** 本机 ffmpeg 是否带文字烧录滤镜(drawtext/freetype)。精简构建没有,探测一次并缓存。 */
let drawtextFilterAvailable: boolean | null = null
async function detectDrawtextFilter(): Promise<boolean> {
  if (drawtextFilterAvailable !== null) return drawtextFilterAvailable
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-filters'])
    drawtextFilterAvailable = stdout.includes(' drawtext ')
  } catch {
    drawtextFilterAvailable = false
  }
  return drawtextFilterAvailable
}

/**
 * The badge is bilingual, so the font must cover CJK. First existing candidate wins;
 * an operator with fonts elsewhere points STUDIO_AIGC_LABEL_FONT_FILE at them.
 */
const LABEL_FONT_CANDIDATES = [
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/STHeiti Medium.ttc',
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
]
async function labelFontFile(): Promise<string | undefined> {
  const configured = process.env.STUDIO_AIGC_LABEL_FONT_FILE
  const candidates = configured ? [configured, ...LABEL_FONT_CANDIDATES] : LABEL_FONT_CANDIDATES
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // next candidate
    }
  }
  return undefined
}

/** drawtext 的参数用单引号包裹,值里的 \ : ' 都要先转义。 */
function escapeFilterValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'")
}

function badgeFilter(text: string, fontFile: string): string {
  return `drawtext=fontfile='${escapeFilterValue(fontFile)}':text='${escapeFilterValue(text)}':fontcolor=white:fontsize=24:borderw=2:bordercolor=black@0.7:x=w-tw-24:y=24`
}

/** 隐式标识:容器元数据里的 AIGC 标签。use_metadata_tags 让自定义键存活于 mp4。 */
function labelMetadataArgs(label: AigcLabel | undefined): string[] {
  if (!label) return []
  return ['-movflags', 'use_metadata_tags', '-metadata', `AIGC=${JSON.stringify(label.metadata)}`]
}

/**
 * 供体检与运营探活:这台机器能不能烧显式角标,缺哪一块。合规能力在开跑前
 * 就该知道自己缺什么,而不是等成片标着 skipped 才发现。
 */
export async function aigcBadgeCapability(): Promise<{ canBurn: boolean; drawtext: boolean; fontFile?: string }> {
  const drawtext = await detectDrawtextFilter()
  const fontFile = await labelFontFile()
  return { canBurn: drawtext && fontFile !== undefined, drawtext, ...(fontFile ? { fontFile } : {}) }
}

export class FfmpegComposer implements Composer {
  async compose(input: ComposeInput, output: string): Promise<ComposeResult> {
    const { clips, voices, audioSources, ambiences, bgm, srt, label } = input
    if (clips.length === 0) throw new Error('compose requires at least one clip')
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-compose-'))
    try {
      const master = path.join(workdir, 'master.mp4')
      await copyConcat(clips, master, workdir)

      // 显式标识按能力降级:有 drawtext 有中文字体才烧角标,缺哪个都记为
      // skipped 并带原因——交付物是否带标是合规事实,不允许无声。
      const labelArgs = labelMetadataArgs(label)
      let labeling: ComposeResult['labeling']
      let badge: string | undefined
      if (label) {
        labeling = { explicit: 'skipped', reason: undefined, implicit: 'written' }
        if (!(await detectDrawtextFilter())) {
          labeling.reason = 'this ffmpeg build has no drawtext filter'
        } else {
          const font = await labelFontFile()
          if (font) badge = badgeFilter(label.badgeText, font)
          else labeling.reason = 'no CJK-capable font found (set STUDIO_AIGC_LABEL_FONT_FILE)'
        }
        if (badge) labeling = { explicit: 'burned', implicit: 'written' }
      }

      // 只有真需要拼轨时才建轨：没人钦定声音来源、又没有一句配音的整集，
      // 走的还是「母带自带原声」那条老路（原声按拼接时的原始电平入片）。
      const needsTrack = Boolean(voices?.some(Boolean) || audioSources?.some(Boolean) || ambiences?.some(Boolean))
      const voiceResult = needsTrack ? await buildVoiceTrack(voices ?? [], clips, workdir, audioSources, ambiences) : undefined
      const voice = voiceResult?.track
      const audio = bgm ? await mixBgm(bgm, voice, master, workdir) : voice
      // 台词溢出(一句话比画面长)时用末帧定格补齐画面——L-cut 的收尾,
      // 保证最后半句台词不被视频截断。补帧需要重编码视频,不能用 stream copy。
      const overflowSeconds = (voiceResult?.overflowMs ?? 0) / 1000
      const needsFrameHold = overflowSeconds > 0.2
      if (!audio && !srt && !badge) {
        await rm(output, { force: true })
        if (needsFrameHold) {
          await run('ffmpeg', ['-y', '-v', 'error', '-i', master, '-vf', `tpad=stop_mode=clone:stop_duration=${overflowSeconds.toFixed(3)}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', ...labelArgs, output])
        } else {
          await run('ffmpeg', ['-y', '-v', 'error', '-i', master, '-c', 'copy', ...labelArgs, output])
        }
        return { durationMs: await probeDuration(output), ...(labeling ? { labeling } : {}) }
      }

      // 字幕双路径:本机 ffmpeg 带烧录滤镜(libass)→ 硬烧进画面(短剧交付标准);
      // 精简构建没有该滤镜 → 退回 mov_text 软字幕轨(外部播放器可见,网页端由
      // 播放器组件叠加渲染)。与末帧定格(tpad)、AI 角标合并在同一条 -vf 里。
      const canBurn = srt ? await detectSubtitlesFilter() : false
      const videoFilters: string[] = []
      if (needsFrameHold) videoFilters.push(`tpad=stop_mode=clone:stop_duration=${overflowSeconds.toFixed(3)}`)
      if (badge) videoFilters.push(badge)
      if (srt && canBurn) videoFilters.push(`subtitles=filename='${srt.replaceAll("'", String.fromCharCode(92) + "'").replaceAll(':', String.fromCharCode(92) + ':')}':force_style='FontSize=18,Outline=1,Shadow=0,MarginV=28'`)

      const args = ['-y', '-v', 'error', '-i', master]
      if (audio) args.push('-i', audio)
      args.push('-map', '0:v:0')
      if (audio) args.push('-map', '1:a:0')
      if (videoFilters.length > 0) args.push('-vf', videoFilters.join(','))
      if (videoFilters.length > 0) {
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18')
      } else {
        args.push('-c:v', 'copy')
      }
      if (audio) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest')
      const staged = srt && !canBurn ? path.join(workdir, 'staged.mp4') : output
      await run('ffmpeg', [...args, ...(staged === output ? labelArgs : []), staged])

      if (srt && !canBurn) {
        // 软字幕回退:mov_text 轨挂到成片上,外部播放器(VLC/QuickTime/剪映)可渲染。
        await run('ffmpeg', [
          '-y', '-v', 'error', '-i', staged, '-i', srt,
          '-map', '0', '-map', '1:s:0',
          '-c', 'copy', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=zho',
          ...labelArgs,
          output,
        ])
      }
      return { durationMs: await probeDuration(output), ...(labeling ? { labeling } : {}) }
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  }

  /**
   * 质量地板:母带完成后强制过一遍的下限处理。loudnorm(EBU R128 两遍法,
   * 目标 -16 LUFS / -1.5 dBTP——短视频平台的通行响度)默认开;超分/补帧/调色
   * 是挂点,默认关,分别由 STUDIO_POSTPROCESS_MIN_HEIGHT、STUDIO_POSTPROCESS_FPS、
   * STUDIO_GRADE_VIDEO_FILTER 启用。任一环节失败就回退原母带并带原因——地板
   * 不该让交付比不做更差;处理前后的实测 LUFS 随记录返回,是交付清单里
   * 音质项的唯一真相。视频流未被处理时用 stream copy,角标与画质零损失。
   */
  async postProcess(master: string, workdir: string, options: PostProcessOptions = {}): Promise<MasterPostProcessResult> {
    const steps: MasterPostProcessRecord['steps'] = []
    let loudness: MasterPostProcessRecord['loudness']
    try {
      const minH = envSetting('STUDIO_POSTPROCESS_MIN_HEIGHT')
      const targetFps = envSetting('STUDIO_POSTPROCESS_FPS')
      const grade = (process.env.STUDIO_GRADE_VIDEO_FILTER ?? '').trim()
      const stream = await probeVideoStream(master)
      const videoFilters: string[] = []

      if (minH !== undefined) {
        if (stream && stream.height > 0 && stream.height < minH) {
          videoFilters.push(`scale=-2:${Math.round(minH)}:flags=lanczos`)
          steps.push({ step: 'upscale', outcome: 'applied' })
        } else {
          steps.push({ step: 'upscale', outcome: 'skipped', reason: stream ? `already ${stream.height}p` : 'video stream unreadable' })
        }
      }
      if (targetFps !== undefined) {
        if (stream && stream.fps > 0 && stream.fps < targetFps - 0.5) {
          // blend 而非 mci:地板要跑得动,运动估计的代价留给显式的高配选项。
          videoFilters.push(`minterpolate=fps=${targetFps}:mi_mode=blend`)
          steps.push({ step: 'interpolate', outcome: 'applied' })
        } else {
          steps.push({ step: 'interpolate', outcome: 'skipped', reason: stream ? `already ${stream.fps.toFixed(2)} fps` : 'video stream unreadable' })
        }
      }
      if (grade !== '') {
        videoFilters.push(grade)
        steps.push({ step: 'grade', outcome: 'applied' })
      }

      let audioFilter: string | undefined
      if (!(await hasAudioStream(master))) {
        steps.push({ step: 'loudnorm', outcome: 'skipped', reason: 'master has no audio stream' })
      } else if (!(await hasFilter('loudnorm'))) {
        steps.push({ step: 'loudnorm', outcome: 'skipped', reason: 'this ffmpeg build has no loudnorm' })
      } else {
        const before = await measureLoudness(master)
        if (before.i < NEAR_SILENCE_LUFS) {
          steps.push({ step: 'loudnorm', outcome: 'skipped', reason: `audio is near-silent (${before.i.toFixed(1)} LUFS), nothing to normalize` })
        } else {
          loudness = { before: { i: round1(before.i), tp: round1(before.tp) } }
          audioFilter = loudnormApplyFilter(before)
          steps.push({ step: 'loudnorm', outcome: 'applied' })
        }
      }

      if (videoFilters.length === 0 && !audioFilter) {
        return { file: master, record: { status: 'applied', steps } }
      }

      const processed = path.join(workdir, 'master-processed.mp4')
      const args = ['-y', '-v', 'error', '-i', master, '-map', '0:v:0']
      if (audioFilter) args.push('-map', '0:a:0')
      args.push('-map', '0:s?')
      if (videoFilters.length > 0) {
        args.push('-vf', videoFilters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18')
      } else {
        args.push('-c:v', 'copy')
      }
      if (audioFilter) {
        args.push('-af', audioFilter, '-c:a', 'aac', '-b:a', '192k')
      } else {
        args.push('-c:a', 'copy')
      }
      args.push('-c:s', 'copy', ...labelMetadataArgs(options.label), processed)
      await run('ffmpeg', args)
      if (audioFilter && loudness) {
        const after = await measureLoudness(processed)
        loudness = { ...loudness, after: { i: round1(after.i), tp: round1(after.tp) } }
      }
      return {
        file: processed,
        record: { status: 'applied', steps, ...(loudness ? { loudness } : {}), target: { i: LOUDNORM_TARGET_I, tp: LOUDNORM_TARGET_TP } },
      }
    } catch (error) {
      const message = error instanceof Error ? `${error.message}${(error as { stderr?: string }).stderr ? ` | ${(error as { stderr?: string }).stderr}` : ''}` : String(error)
      return { file: master, record: { status: 'fallback', steps: [], reason: message.slice(0, 400) } }
    }
  }
}

const LOUDNORM_TARGET_I = -16
const LOUDNORM_TARGET_TP = -1.5
const LOUDNORM_TARGET_LRA = 11
/** 低于此响度按静音处理:对无声轨跑 loudnorm 只会得到 -999999 的垃圾读数。 */
const NEAR_SILENCE_LUFS = -70

interface LoudnessReading {
  i: number
  tp: number
  lra: number
  thresh: number
}

async function measureLoudness(file: string): Promise<LoudnessReading> {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'])
  const match = /\{[^{}]*"input_i"[^{}]*\}/s.exec(stderr)
  if (!match) throw new Error('loudnorm produced no parseable measurement report')
  const report = JSON.parse(match[0]) as Record<string, string>
  const reading = { i: Number(report.input_i), tp: Number(report.input_tp), lra: Number(report.input_lra), thresh: Number(report.input_thresh) }
  if (!Number.isFinite(reading.i) || !Number.isFinite(reading.thresh)) throw new Error('loudnorm measurement returned non-finite values')
  return reading
}

/** 两遍法:第一遍实测,第二遍按实测值线性增益——单遍动态模式会"泵"。 */
function loudnormApplyFilter(measured: LoudnessReading): string {
  return `loudnorm=I=${LOUDNORM_TARGET_I}:TP=${LOUDNORM_TARGET_TP}:LRA=${LOUDNORM_TARGET_LRA}:measured_I=${measured.i}:measured_TP=${measured.tp}:measured_LRA=${measured.lra}:measured_thresh=${measured.thresh}:offset=0:linear=true`
}

async function probeVideoStream(file: string): Promise<{ height: number; fps: number } | undefined> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=height,avg_frame_rate',
      '-of', 'json', file,
    ])
    const stream = (JSON.parse(stdout).streams ?? [])[0] as { height?: number; avg_frame_rate?: string } | undefined
    if (!stream) return undefined
    const [num, den] = (stream.avg_frame_rate ?? '0/1').split('/')
    const fps = Number(den) > 0 ? Number(num) / Number(den) : 0
    return { height: Number(stream.height ?? 0), fps: Number.isFinite(fps) ? fps : 0 }
  } catch {
    return undefined
  }
}

function envSetting(key: string): number | undefined {
  const raw = (process.env[key] ?? '').trim()
  if (raw === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number, got "${raw}"`)
  return value
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

async function copyConcat(clips: string[], target: string, workdir: string): Promise<void> {
  const list = path.join(workdir, 'clips.txt')
  const entries = clips.map(clip => `file '${clip.replaceAll("'", "'\\''")}'`).join('\n')
  await writeFile(list, entries + '\n')
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', target])
}

/**
 * One segment per clip, each exactly as long as that clip (probed, never the nominal
 * duration), so the voice track stays in step with the picture even when a provider
 * misses its target. A voice shorter than its shot is padded with silence; a longer
 * one is cut at the shot boundary.
 */
async function buildVoiceTrack(
  voices: (string | null)[],
  clips: string[],
  workdir: string,
  audioSources?: (ShotAudioMode | null)[],
  ambiences?: (string | null)[],
): Promise<{ track: string; overflowMs: number }> {
  let videoCursorMs = 0
  let audioCursorMs = 0
  const placed: Array<{ file: string; startMs: number }> = []
  const ambient: Array<{ file: string; startMs: number }> = []
  const inputs: string[] = []
  for (const [index, clip] of clips.entries()) {
    const shotStartMs = videoCursorMs
    const clipSeconds = Math.max(1, await probeDuration(clip)) / 1000
    const voice = voices[index] ?? null
    const mode: ShotAudioMode = audioSources?.[index] ?? (voice ? 'voice' : 'native')
    const useVoice = voice !== null && mode !== 'native'
    const useNative = mode !== 'voice'
    const ambience = ambiences?.[index] ?? null
    if (useVoice && voice) {
      // 台词比前一句还长时按 L-cut 顺延起播点;音频轨长过画面由 overflow 交给末帧定格。
      const startMs = Math.max(shotStartMs, audioCursorMs)
      placed.push({ file: voice, startMs })
      audioCursorMs = startMs + Math.max(100, await probeDuration(voice))
    }
    // 这一镜的氛围底：导入的环境音优先，它按镜头长度切齐后走与原生音轨同一条
    // 0.6 压电平的路。人既然点名了这条街声，就不该再叠一层模型自己混好的原声
    // （那里面可能带着它自己"念"出来的词）。
    const bedSource = ambience ?? (useNative && (await hasAudioStream(clip)) ? clip : null)
    if (bedSource) {
      const segment = path.join(workdir, `ambient-${index}.wav`)
      await run('ffmpeg', [
        '-y', '-v', 'error', '-i', bedSource,
        '-af', `${AUDIO_SHAPE},apad,atrim=0:${clipSeconds.toFixed(3)}`,
        '-c:a', 'pcm_s16le', segment,
      ])
      ambient.push({ file: segment, startMs: shotStartMs })
    }
    videoCursorMs += Math.max(1, await probeDuration(clip))
  }

  const totalVideoMs = videoCursorMs
  const totalAudioMs = Math.max(audioCursorMs, totalVideoMs)
  const bedSeconds = (totalAudioMs / 1000).toFixed(3)
  const bed = path.join(workdir, 'bed.wav')
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`,
    '-t', bedSeconds,
    '-c:a', 'pcm_s16le', bed,
  ])

  // The bed is input 0 — every filter index below counts from it.
  const filterParts = [`[0:a]${AUDIO_SHAPE}[bed]`]
  placed.forEach((entry, placedIndex) => {
    inputs.push('-i', entry.file)
    filterParts.push(`[${placedIndex + 1}:a]${AUDIO_SHAPE},adelay=${Math.round(entry.startMs)}:all=1[v${placedIndex + 1}]`)
  })
  for (const [ambientIndex, ambientEntry] of ambient.entries()) {
    inputs.push('-i', ambientEntry.file)
    // 环境声也必须按各自镜头的起点进轨,否则第三镜的街道声会在第一镜响起来。
    filterParts.push(`[${placed.length + ambientIndex + 1}:a]${AUDIO_SHAPE},adelay=${Math.round(ambientEntry.startMs)}:all=1,volume=0.6[amb${ambientIndex + 1}]`)
  }
  const mixInputs = ['[bed]', ...placed.map((_, i) => `[v${i + 1}]`), ...ambient.map((_, i) => `[amb${i + 1}]`)].join('')
  filterParts.push(`${mixInputs}amix=inputs=${1 + placed.length + ambient.length}:duration=first:normalize=0`)

  const voice = path.join(workdir, 'voice.wav')
  await run('ffmpeg', ['-y', '-v', 'error', '-i', bed, ...inputs, '-filter_complex', filterParts.join(';'), '-c:a', 'pcm_s16le', voice])
  return { track: voice, overflowMs: Math.max(0, Math.round(audioCursorMs - totalVideoMs)) }
}

async function mixBgm(bgm: string, voice: string | undefined, master: string, workdir: string): Promise<string> {
  const mixed = path.join(workdir, 'mixed.wav')
  if (!voice) {
    const seconds = Math.max(1, await probeDuration(master)) / 1000
    // 无配音轨时,若成片母带自带原生音轨(wan3.0 一类),配乐只做垫底,不整体替换。
    if (await hasAudioStream(master)) {
      await run('ffmpeg', [
        '-y', '-v', 'error', '-i', master, '-stream_loop', '-1', '-i', bgm,
        '-filter_complex', `[0:a]${AUDIO_SHAPE}[native];[1:a]${AUDIO_SHAPE},volume=${BGM_VOLUME}[bed];[bed][native]amix=inputs=2:duration=first:normalize=0`,
        '-vn', '-c:a', 'pcm_s16le', mixed,
      ])
      return mixed
    }
    await run('ffmpeg', [
      '-y', '-v', 'error', '-stream_loop', '-1', '-i', bgm,
      '-af', `${AUDIO_SHAPE},volume=${BGM_VOLUME}`,
      '-t', seconds.toFixed(3),
      '-c:a', 'pcm_s16le', mixed,
    ])
    return mixed
  }
  await run('ffmpeg', [
    '-y', '-v', 'error', '-stream_loop', '-1', '-i', bgm, '-i', voice,
    '-filter_complex', bgmVoiceMixFilter(await hasFilter('sidechaincompress')),
    '-vn', '-c:a', 'pcm_s16le', mixed,
  ])
  return mixed
}

/**
 * 配乐与台词的混音图。带 sidechaincompress 时走 ducking:台词响起,压缩机按
 * 信号把 BGM 自动压低(ratio 12 ≈ 最多 -26dB),停了再回弹——固定 0.25 是
 * "没人说话时 BGM 也闷、说话时照样糊"的双输。纯函数导出:两条分支都能不起
 * ffmpeg 直接测。
 */
export function bgmVoiceMixFilter(sidechain: boolean): string {
  if (!sidechain) {
    return `[0:a]${AUDIO_SHAPE},volume=${BGM_VOLUME}[bed];[1:a]${AUDIO_SHAPE}[speech];[speech][bed]amix=inputs=2:duration=first:normalize=0`
  }
  return `[0:a]${AUDIO_SHAPE},volume=${BGM_DUCK_BED}[bed];[1:a]${AUDIO_SHAPE}[speech];[speech]asplit=2[sc][vox];[bed][sc]sidechaincompress=threshold=0.05:ratio=12:attack=20:release=500[duck];[vox][duck]amix=inputs=2:duration=first:normalize=0`
}

/**
 * Builds the ffmpeg argument list for pulling one representative frame out of a
 * clip. The seek lands mid-clip: a first frame is usually a fade-in and says
 * nothing about the shot. `min(1024,iw)` caps the width without ever upscaling,
 * and `-2` keeps the aspect ratio at an even height, which JPEG requires. A
 * duration of 0 — probe failed, or the input is not a clip — falls back to the
 * first frame rather than failing.
 */
export function frameArgs(inputPath: string, outputPath: string, durationMs: number): string[] {
  return [
    '-y', '-v', 'error',
    '-ss', Math.max(0, durationMs / 1000 / 2).toFixed(3),
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', "scale='min(1024,iw)':-2",
    '-q:v', '3',
    outputPath,
  ]
}

export async function extractFrame(inputPath: string, outputPath: string, durationMs?: number): Promise<void> {
  const known = durationMs ?? await probeDuration(inputPath)
  await run('ffmpeg', frameArgs(inputPath, outputPath, known))
}

export interface SynthesizedMedia {
  mimeType: string
  width?: number
  height?: number
  durationMs?: number
}

/**
 * Materialises a stand-in artifact for the mock provider so the pipeline produces
 * real, playable files offline. Falls back to placeholder bytes when ffmpeg is
 * not installed.
 */
export async function synthesizeMockMedia(
  modality: string,
  outPath: string,
  options: { durationMs?: number } = {},
): Promise<SynthesizedMedia> {
  const seconds = Math.max(1, Math.round((options.durationMs ?? 1000) / 1000))
  const args = argsFor(modality, seconds, outPath)
  if (args) {
    try {
      await run('ffmpeg', ['-y', '-v', 'error', ...args])
      return metaFor(modality, seconds)
    } catch {
      // fall through to placeholder bytes
    }
  }
  await writeFile(outPath, Buffer.from(`mock ${modality} placeholder\n`))
  return metaFor(modality, 0)
}

function argsFor(modality: string, seconds: number, outPath: string): string[] | null {
  switch (modality) {
    case 'image':
      return ['-f', 'lavfi', '-i', 'color=c=0x6d28d9:size=320x240', '-frames:v', '1', outPath]
    case 't2v':
    case 'i2v':
    case 'r2v':
      return [
        '-f', 'lavfi',
        '-i', `testsrc=duration=${seconds}:size=320x240:rate=15`,
        '-pix_fmt', 'yuv420p',
        outPath,
      ]
    case 'tts':
    case 'music':
      return ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, outPath]
    default:
      return null
  }
}

function metaFor(modality: string, seconds: number): SynthesizedMedia {
  switch (modality) {
    case 'image':
      return { mimeType: 'image/png', width: 320, height: 240 }
    case 't2v':
    case 'i2v':
    case 'r2v':
      return { mimeType: 'video/mp4', width: 320, height: 240, durationMs: seconds * 1000 }
    case 'tts':
    case 'music':
      return { mimeType: 'audio/wav', durationMs: seconds * 1000 }
    default:
      return { mimeType: 'text/plain' }
  }
}

export function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png'
    case 'video/mp4':
      return 'mp4'
    case 'audio/wav':
      return 'wav'
    case 'text/plain':
      return 'txt'
    case 'application/json':
      return 'json'
    default:
      return 'bin'
  }
}
