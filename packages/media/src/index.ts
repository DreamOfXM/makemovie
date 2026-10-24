export * from './quality-check.js'
export * from './edit-media.js'
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
  /** 后端类别,启动诊断用它报「产物落在哪」,不暴露路径细节。 */
  readonly kind: 'disk' | 's3'
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
  readonly kind = 'disk' as const
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
  readonly kind = 's3' as const
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
  /**
   * S4① 声床在成片时间线上的真实落位（含音频桥的越界量与淡入淡出）。母带里底从哪
   * 一秒响到哪一秒是听觉事实，只按镜头边界记账就会把「上一场的底拖进下一场」记成
   * 没有——返修时听不出接缝的人，需要的正是这几个数。
   */
  beds?: BedPlacement[]
  /**
   * S4② 真正落进母带的那一刀表（重叠毫秒、逐镜起点、片头/集尾淡入淡出）。转场是
   * 听觉与视觉的事实，「剧本点了叠化但渲染吃掉了 40ms」必须能被反查——这一份与
   * 输入那份计划可能不同（素材实测长度决定的夹取），记输入就等于记一个没发生的数。
   */
  cuts?: MasterCutPlan
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
   * S4①: consecutive shots given the *same* file are one sound bed for that scene —
   * it is placed once across the whole run (see `planAudioBridges`), not restarted at
   * every cut, and it crosses each boundary by the audio bridge.
   */
  ambiences?: (string | null)[]
  /** Music bed, looped under the voice (ducked when the ffmpeg build has sidechaincompress, otherwise a fixed level) and cut to the master. */
  bgm?: string
  /** SubRip file muxed as a soft subtitle track; burning in would re-encode the whole video. */
  srt?: string
  /**
   * 独立音频轨（编辑时间线 US-026）：序列相对起始毫秒 + 增益 + 静音。与逐镜
   * voices/ambiences 正交——它们是镜头内声音，extras 是剪辑台摆上去的任意素材，
   * adelay 定位、volume 定增益后混进成片。
   */
  extras?: Array<{ file: string; startMs: number; gain: number; muted: boolean }>
  /** 输出规格（编辑时间线 outputSpec）：aspect 统一画幅，素材异形时 scale+pad 规范。 */
  outputSpec?: { aspect?: '9:16' | '16:9' }
  /** AI-content labeling for the delivered master; absent means the master ships unlabeled. */
  label?: AigcLabel
  /**
   * 母带时间线计划（S4② 转场）。用 `planMasterCutsForClips` 从**同一批文件**算出来
   * 再传进来：字幕、配音落位、编辑音轨锚点都必须在 compose 之前就落在同一条时间线
   * 上，两处各算一次就会出现「画面按重叠走、字幕按标称走」。缺省 = 全硬切，母带
   * 仍走 stream-copy 老路（逐字节不变，不吃一代画质）。
   */
  cuts?: MasterCutPlan
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

export interface MediaMeta {
  width?: number
  height?: number
  durationMs?: number
}

/** 从字节落盘的文件里实测宽高与时长。供应商回执经常只给 URL(百炼的下载产物三个
 *  字段全 NULL),而下游把 NULL 当「素材长度」用——时间线只能拿分镜计划时长冒充,
 *  4 秒成片被裁成 2 秒。读不出就返回 null,绝不抛:元数据探测没资格失败一个已付费
 *  的产物。 */
export async function probeMediaMeta(file: string): Promise<MediaMeta | null> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,width,height,duration:format=duration',
      '-of', 'json',
      file,
    ])
    const probed = JSON.parse(stdout) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>
      format?: { duration?: string }
    }
    const streams = probed.streams ?? []
    const video = streams.find(s => s.codec_type === 'video' && Number(s.width) > 0 && Number(s.height) > 0)
    const finite = (value: string | undefined): number | undefined => {
      const seconds = Number(value)
      return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
    }
    // 时长取视频流而非容器:mp4 的 format 时长由音轨决定(实测 4.096s),画面只有
    // 97 帧@24fps=4.0417s。按 4.096 换算 25fps 序列会多要一帧并不存在的画面。
    const meta: MediaMeta = {}
    if (video) {
      meta.width = Number(video.width)
      meta.height = Number(video.height)
    }
    const durationMs = finite(video?.duration) ?? finite(probed.format?.duration) ?? finite(streams.find(s => s.codec_type === 'audio')?.duration)
    if (durationMs !== undefined) meta.durationMs = durationMs
    return Object.keys(meta).length > 0 ? meta : null
  } catch {
    return null
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
  /** NLE 源监视器里显示的切片文件名——媒体包内必须是可重链的相对路径(media/xxx.mp4)。 */
  sourceFile: string
  /** true = 实测自切片文件; false = 回退到分镜规划时长。 */
  measured: boolean
  /** Q04:源素材入点(毫秒)。裁切过的剪辑必须给 NLE 源入出点,否则导入从 0 起取整条源。 */
  sourceInMs?: number
  audio?: boolean
}

export interface EditListInput {
  title: string
  clips: EditClip[]
  /** 时间线帧率，默认 25。 */
  fps?: number
  /** 序列画幅。缺省回落 1080×1920 竖屏旧默认——仅供拿不到切片实测尺寸的老交付；
   *  新导出必须传入真实尺寸，NLE 按它建序，横屏素材不能被竖屏 format 吞掉。 */
  frame?: { width: number; height: number }
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
    const recordIn = recordFrames
    const recordOut = recordFrames + frames
    recordFrames += frames
    // Q04:源入出点是源素材里的位置(裁切入点),记录入出点是时间线位置——EDL 两对
    // 时码各有其位,不能拿记录轨时码冒充源时码。
    const sourceIn = toFrames(clip.sourceInMs ?? 0, fps)
    const sourceOut = sourceIn + frames
    const event = String(index + 1).padStart(3, '0')
    lines.push(`${event}  AX                       V     C        ${timecode(sourceIn, fps)} ${timecode(sourceOut, fps)} ${timecode(recordIn, fps)} ${timecode(recordOut, fps)}`)
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
export interface FcpxmlInput extends EditListInput {
  /** V06:编辑时间线的独立音轨——按时间线位置接成连接片段,音量/静音以 note 注记
   *  (FCPXML 没有跨版本稳定的逐剪辑音量元素,注记是导入后可见的诚实表达)。 */
  audioTracks?: Array<{ name: string; sourceUrl: string; startMs: number; sourceInMs?: number; durationMs: number | null; gain: number; muted: boolean }>
}

export function buildFcpxml(input: FcpxmlInput): string {
  const fps = input.fps ?? EDIT_FPS
  const frame = input.frame ?? { width: 1080, height: 1920 }
  const rational = (frames: number) => `${frames}/${fps}s`
  const total = input.clips.reduce((sum, clip) => sum + toFrames(clip.durationMs, fps), 0)
  const assets: string[] = []
  const spine: string[] = []
  let offset = 0
  input.clips.forEach((clip, index) => {
    const frames = toFrames(clip.durationMs, fps)
    // Q04:asset 覆盖源入点起的可用范围,asset-clip 的 start 即源入点——裁切过的
    // 剪辑在 NLE 里落在源的正确位置,而不是永远从 0 起整条。
    const sourceInFrames = toFrames(clip.sourceInMs ?? 0, fps)
    const availableFrames = sourceInFrames + frames
    const id = `x${index + 1}`
    const name = `#${clip.number} ${clip.title}${clip.measured ? '' : ' (planned)'}`
    assets.push(`    <asset id="${id}" name="${xmlEscape(name)}" src="file:///${xmlEscape(clip.sourceFile)}" start="0s" duration="${rational(availableFrames)}" hasVideo="1" hasAudio="${clip.audio === false ? 0 : 1}" format="r1" />`)
    spine.push(`        <asset-clip ref="${id}" offset="${rational(offset)}" duration="${rational(frames)}" format="r1" name="${xmlEscape(name)}" start="${rational(sourceInFrames)}" />`)
    offset += frames
  })
  // V06:独立音轨按时间线位置接成音频连接片段——位置/时长/源起点是播放结构,
  // gain/muted 使用调整与启用字段,注记保留审计值。
  let audioLane = 1
  const audioClips = input.audioTracks ?? []
  audioClips.forEach((track, index) => {
    const startFrames = toFrames(track.startMs, fps)
    const frames = track.durationMs != null ? toFrames(track.durationMs, fps) : Math.max(1, offset - startFrames)
    const id = `a${index + 1}`
    const sourceIn = toFrames(track.sourceInMs ?? 0, fps)
    const note = `makemovie: gain=${Number.isFinite(track.gain) ? track.gain : 1}, muted=${track.muted === true}`
    assets.push(`    <asset id="${id}" name="${xmlEscape(track.name)}" src="file:///${xmlEscape(track.sourceUrl)}" start="0s" duration="${rational(sourceIn + frames)}" hasVideo="0" hasAudio="1" />`)
    spine.push(
      `        <asset-clip ref="${id}" offset="${rational(startFrames)}" duration="${rational(frames)}" name="${xmlEscape(track.name)}" start="${rational(sourceIn)}" enabled="${track.muted ? 0 : 1}" lane="${audioLane++}">`,
      `          <adjust-volume amount="${track.gain > 0 ? (20 * Math.log10(track.gain)).toFixed(6) : -96}dB" />`,
      `          <note>${xmlEscape(note)}</note>`,
      '        </asset-clip>',
    )
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.10">',
    '  <resources>',
    `    <format id="r1" frameDuration="1/${fps}s" width="${frame.width}" height="${frame.height}" />`,
    ...assets,
    `    <sequence id="r0" name="${xmlEscape(input.title)}" format="r1" tcStart="0s" tcDuration="${rational(Math.max(total, offset))}" audioLayout="stereo" audioRate="48k">`,
    '      <spine>',
    ...spine,
    '      </spine>',
    '    </sequence>',
    '  </resources>',
    '</fcpxml>',
    '',
  ].join('\n')
}

/** OTIO 的配乐轨素材引用:合成清单里记录了它才排 A1;EDL 把配乐丢了,OTIO 找回。 */
export interface OtioScoreInput {
  sourceUrl: string
  durationMs: number | null
}

export interface OtioInput extends EditListInput {
  score?: OtioScoreInput
  /** Q04:编辑时间线的独立音轨——按时间线位置排成 Audio 轨,NLE 才能还原混音布局。 */
  audioTracks?: Array<{ name: string; sourceUrl: string; startMs: number; sourceInMs?: number; durationMs: number | null; gain: number; muted: boolean }>
}

/**
 * OpenTimelineIO(OTIO):ASFW 标准、多数 NLE 原生可读的工程交接格式,也是「LLM 生成
 * 时间线」类工具的通用载体。与 EDL/FCPXML 同一份数学与回退口径:逐镜 Clip 顺序排满
 * V1,planned 回退照实标在 clip 名与 metadata。配乐经合成清单排成 A1 音轨;字幕不进
 * OTIO——它有自己的 SRT 交付,塞非标字幕轨只会让导入器噎住。序列画幅不属于 Timeline
 * 语义,由导入侧 NLE 自行解释,故这里没有 frame 参数。
 */
export function buildOtio(input: OtioInput): string {
  const fps = input.fps ?? EDIT_FPS
  const rationalTime = (frames: number) => ({ OTIO_SCHEMA: 'RationalTime.1', rate: fps, value: frames })
  const timeRange = (startFrames: number, durationFrames: number) => ({
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: rationalTime(startFrames),
    duration: rationalTime(durationFrames),
  })
  let cursor = 0
  const videoChildren = input.clips.map(clip => {
    const frames = toFrames(clip.durationMs, fps)
    cursor += frames
    // Q04:source_range 从源入点起取 used 范围——裁切入点交给导入器,不再固定从 0。
    const sourceInFrames = toFrames(clip.sourceInMs ?? 0, fps)
    return {
      OTIO_SCHEMA: 'Clip.1',
      name: `#${clip.number} ${clip.title}${clip.measured ? '' : ' (planned)'}`,
      source_range: timeRange(sourceInFrames, frames),
      media_reference: {
        OTIO_SCHEMA: 'ExternalReference.1',
        target_url: `file:///${clip.sourceFile}`,
        available_range: timeRange(0, sourceInFrames + frames),
      },
      metadata: { makemovie: { shot: clip.number, measured_duration: clip.measured } },
    }
  })
  const tracks: object[] = [
    { OTIO_SCHEMA: 'Track.1', name: 'V1', kind: 'Video', children: videoChildren },
  ]
  if (input.score) {
    const frames = input.score.durationMs != null ? Math.min(toFrames(input.score.durationMs, fps), cursor) : cursor
    tracks.push({
      OTIO_SCHEMA: 'Track.1',
      name: 'A1',
      kind: 'Audio',
      children: [
        {
          OTIO_SCHEMA: 'Clip.1',
          name: 'Score',
          source_range: timeRange(0, frames),
          media_reference: {
            OTIO_SCHEMA: 'ExternalReference.1',
            target_url: `file:///${input.score.sourceUrl}`,
            available_range: timeRange(0, frames),
          },
        },
      ],
    })
  }
  if (input.audioTracks && input.audioTracks.length > 0) {
    // V06:每条独立音轨一条 Track、以 Gap 定位时间线起点——同一时刻的两条声音
    // 在同一 Track 里顺序排列会把后一条挤到前一条结束之后,位置语义完全丢失。
    // muted 使用 enabled;跨软件音量由交接包预处理媒体保证,metadata 保留审计值。
    let audioIndex = tracks.filter(track => (track as { kind?: string }).kind === 'Audio').length
    for (const track of input.audioTracks) {
      audioIndex += 1
      const startFrames = toFrames(track.startMs, fps)
      const frames = track.durationMs != null ? toFrames(track.durationMs, fps) : Math.max(1, cursor - startFrames)
      const children: object[] = []
      if (startFrames > 0) {
        children.push({ OTIO_SCHEMA: 'Gap.1', name: 'lead-in', source_range: timeRange(0, startFrames) })
      }
      children.push({
        OTIO_SCHEMA: 'Clip.2',
        name: track.name,
        enabled: !track.muted,
        source_range: timeRange(toFrames(track.sourceInMs ?? 0, fps), frames),
        media_reference: {
          OTIO_SCHEMA: 'ExternalReference.1',
          target_url: `file:///${track.sourceUrl}`,
          available_range: timeRange(0, toFrames(track.sourceInMs ?? 0, fps) + frames),
        },
        metadata: { makemovie: { timeline_start_ms: Math.round(track.startMs), gain: track.gain, muted: track.muted } },
      })
      tracks.push({ OTIO_SCHEMA: 'Track.1', name: `A${audioIndex}`, kind: 'Audio', children })
    }
  }
  const timeline = {
    OTIO_SCHEMA: 'Timeline.1',
    name: input.title,
    global_start_time: rationalTime(0),
    tracks: { OTIO_SCHEMA: 'Stack.1', name: 'tracks', children: tracks },
  }
  return `${JSON.stringify(timeline, null, 2)}\n`
}

/**
 * Q04:Premiere Pro 的 xmeml(5.1)——第四种交接格式。源入出点/时间线入出点分列,
 * 文件引用媒体包相对路径,序列带 fps 与画幅;Premiere 与部分老工具只认这一格式。
 */
export function buildXmeml(input: EditListInput & { audioTracks?: Array<{ name: string; sourceUrl: string; startMs: number; sourceInMs?: number; durationMs: number | null; gain: number; muted: boolean }> }): string {
  const fps = input.fps ?? EDIT_FPS
  const frame = input.frame ?? { width: 1080, height: 1920 }
  const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`
  const sampleCharacteristics = `<samplecharacteristics>${rate}<width>${frame.width}</width><height>${frame.height}</height></samplecharacteristics>`
  let recordFrame = 0
  const clipItems = input.clips.map((clip, index) => {
    const frames = toFrames(clip.durationMs, fps)
    const sourceIn = toFrames(clip.sourceInMs ?? 0, fps)
    const recordStart = recordFrame
    recordFrame += frames
    const fileId = `f${index + 1}`
    return [
      `          <clipitem id="clipitem-${index + 1}">`,
      `            <name>#${clip.number} ${xmlEscape(clip.title)}</name>`,
      `            <duration>${sourceIn + frames}</duration>`,
      `            ${rate}`,
      `            <start>${recordStart}</start>`,
      `            <end>${recordStart + frames}</end>`,
      `            <in>${sourceIn}</in>`,
      `            <out>${sourceIn + frames}</out>`,
      `            <file id="${fileId}">`,
      `              <name>${xmlEscape(clip.sourceFile)}</name>`,
      `              <pathurl>file://localhost/${xmlEscape(clip.sourceFile)}</pathurl>`,
      `              ${rate}`,
      `              <media><video><samplecharacteristics><width>${frame.width}</width><height>${frame.height}</height></samplecharacteristics></video><audio><channelcount>2</channelcount></audio></media>`,
      `            </file>`,
      `          </clipitem>`,
    ].join('\n')
  })
  const audioClipItems = (input.audioTracks ?? []).map((track, index) => {
    const start = toFrames(track.startMs, fps)
    const sourceIn = toFrames(track.sourceInMs ?? 0, fps)
    const frames = track.durationMs != null ? toFrames(track.durationMs, fps) : Math.max(1, recordFrame - start)
    // Each source stem occupies its own track so it can be enabled for remixing.
    const gain = Number.isFinite((track as { gain?: number }).gain) ? (track as { gain: number }).gain : 1
    const muted = (track as { muted?: boolean }).muted === true
    return [
      `          <clipitem id="aclipitem-${index + 1}">`,
      `            <name>${xmlEscape(track.name)}</name>`,
      `            <enabled>${muted ? 'FALSE' : 'TRUE'}</enabled>`,
      `            <filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audio</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><value>${gain}</value></parameter></effect></filter>`,
      `            <duration>${frames}</duration>`,
      `            ${rate}`,
      `            <start>${start}</start>`,
      `            <end>${start + frames}</end>`,
      `            <in>${sourceIn}</in>`,
      `            <out>${sourceIn + frames}</out>`,
      `            <file id="af${index + 1}">`,
      `              <name>${xmlEscape(track.sourceUrl)}</name>`,
      `              <pathurl>file://localhost/${xmlEscape(track.sourceUrl)}</pathurl>`,
      `              ${rate}`,
      `              <media><audio><channelcount>2</channelcount></audio></media>`,
      `            </file>`,
      `            <comments><mastercomment1>makemovie: gain=${gain}, muted=${muted}</mastercomment1></comments>`,
      `          </clipitem>`,
    ].join('\n')
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="5">',
    `  <sequence id="makemovie-seq">`,
    `    <name>${xmlEscape(input.title)}</name>`,
    `    <duration>${recordFrame}</duration>`,
    `    ${rate}`,
    '    <media>',
    '      <video>',
    `        <format>${sampleCharacteristics}</format>`,
    '        <track>',
    ...clipItems,
    '        </track>',
    '      </video>',
    '      <audio>',
    ...audioClipItems.flatMap(item => ['        <track>', item, '        </track>']),
    '      </audio>',
    '    </media>',
    '  </sequence>',
    '</xmeml>',
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

/**
 * 字幕交付方式。`auto` 交给本机能力探测;`burn`(硬烧进画面)与 `soft`(mov_text
 * 软轨)是显式指定,由 STUDIO_SUBTITLE_MODE 给。
 *
 * 显式 `burn` 而本机没有 libass 时直接报错,不静默退回软轨——字幕是交付物的一部分,
 * 静默换一种交付形态等于交付了另一个东西,看交付清单的人无从察觉。
 */
export type SubtitleMode = 'auto' | 'burn' | 'soft'

export function subtitleModeFromEnv(raw: string | undefined = process.env.STUDIO_SUBTITLE_MODE): SubtitleMode {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '' || value === 'auto') return 'auto'
  if (value === 'burn' || value === 'soft') return value
  throw new Error(`STUDIO_SUBTITLE_MODE must be auto, burn or soft, got "${raw}"`)
}

async function resolveBurnSubtitles(): Promise<boolean> {
  const mode = subtitleModeFromEnv()
  if (mode === 'soft') return false
  const available = await detectSubtitlesFilter()
  if (mode === 'burn' && !available) {
    throw new Error('STUDIO_SUBTITLE_MODE=burn needs an ffmpeg build with the subtitles filter (libass); this build has none')
  }
  return available
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
/** 一次性探测一组滤镜是否存在(如 subtitles/drawtext)——启动诊断与体检共用,
 * 结果只到「这一版 ffmpeg 有没有编译进来」,不涉及字体或业务判断。 */
export async function probeFilterPresence(names: readonly string[]): Promise<Record<string, boolean>> {
  const found: Record<string, boolean> = {}
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-filters'])
    for (const name of names) found[name] = stdout.includes(` ${name} `)
  } catch {
    for (const name of names) found[name] = false
  }
  return found
}

export async function aigcBadgeCapability(): Promise<{ canBurn: boolean; drawtext: boolean; fontFile?: string }> {
  const drawtext = await detectDrawtextFilter()
  const fontFile = await labelFontFile()
  return { canBurn: drawtext && fontFile !== undefined, drawtext, ...(fontFile ? { fontFile } : {}) }
}

/**
 * 供体检与运营探活:这台机器能不能把字幕硬烧进画面(libass 的 subtitles 滤镜)。
 * 与 drawtext 同类——有没有是「谁装的 ffmpeg」决定的,不是配置项。缺了它 auto
 * 会静默降级成 mov_text 软轨,显式 burn 则直接报错,两种都该在开跑前知道。
 */
export async function subtitleBurnCapability(): Promise<{ canBurn: boolean }> {
  return { canBurn: await detectSubtitlesFilter() }
}

/** 字卡能不能由本机画出来——缺 drawtext 或缺中文字体都画不了，缺哪一块要说清，
 *  因为界面要报的是「这台机器画不了」而不是「生成失败」。 */
export interface TitleCardCapability {
  canRender: boolean
  blocker: 'no_text_filter' | 'no_cjk_font' | null
}

export async function titleCardCapability(): Promise<TitleCardCapability> {
  if (!(await detectDrawtextFilter())) return { canRender: false, blocker: 'no_text_filter' }
  if (!(await labelFontFile())) return { canRender: false, blocker: 'no_cjk_font' }
  return { canRender: true, blocker: null }
}

/** 与合成同源的画幅→画布：字号按高度算，画布换了字卡才不会在时间线里被二次缩放。 */
export function titleCardCanvas(aspect: '9:16' | '16:9'): { width: number; height: number } {
  return aspect === '16:9' ? { width: 1280, height: 720 } : { width: 720, height: 1280 }
}

export interface TitleCardInput {
  text: string
  outPath: string
  durationMs: number
  width: number
  height: number
  fps?: number
  background?: string
}

export interface TitleCardResult {
  mimeType: string
  width: number
  height: number
  durationMs: number
  lines: number
}

/** 画布装不下就是装不下：静默截断等于把作者写的字吞掉，宁可停下来让人缩短。 */
export const TITLE_CARD_MAX_LINES = 6
export class TitleCardTooLongError extends Error {
  constructor(public readonly lines: number) {
    super(`title card needs ${lines} lines at the smallest size; this canvas holds ${TITLE_CARD_MAX_LINES}`)
  }
}

/** drawtext 没有自动换行：按字号与画布宽度预算每行字符数，先在有气口的地方断，
 *  断不开再按字数硬切——空格与中英标点（全角半角）都算气口。 */
const BREAK_AFTER = /[，。、！？；：,.!?;:\s]/
function wrapTitleText(text: string, perLine: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    let rest = paragraph.trim()
    if (rest === '') continue
    while (rest.length > perLine) {
      const window = rest.slice(0, perLine)
      let breakAt = -1
      for (const [index, char] of [...window].entries()) if (BREAK_AFTER.test(char)) breakAt = index
      const cut = breakAt >= 0 ? breakAt + 1 : perLine
      lines.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) lines.push(rest)
  }
  return lines
}

/**
 * 字卡镜头（分镜表「生成方式=字卡」）由本机 ffmpeg 画，不占任何模型额度。
 *
 * 这一镜的存在理由是「没有可拍的素材，只有一句话」，所以平台不能把它留给
 * 「你去剪辑里自己做」——那是把雷原样交给下一个人。文字逐行写进临时文件用
 * textfile 传给 drawtext：文本里的冒号、引号、逗号都是滤镜语法字符，走 text=
 * 参数要么被截断要么把滤镜链拆散，而字卡上写的正是人给的原文。
 */
export async function renderTitleCard(input: TitleCardInput): Promise<TitleCardResult> {
  const capability = await titleCardCapability()
  if (!capability.canRender) {
    throw new Error(
      capability.blocker === 'no_cjk_font'
        ? 'no CJK-capable font found — set STUDIO_AIGC_LABEL_FONT_FILE to a font file'
        : 'this ffmpeg build has no drawtext filter, so title cards cannot be rendered',
    )
  }
  const fontFile = await labelFontFile()
  const text = input.text.trim()
  if (text === '') throw new Error('title card text is empty — there is nothing to draw')
  const seconds = Math.max(1, Math.round(input.durationMs / 1000))
  const fps = input.fps ?? 25
  let fontsize = 0
  let lines: string[] = []
  for (const divisor of [9, 11, 13, 16, 20, 26]) {
    fontsize = Math.max(20, Math.round(input.height / divisor))
    lines = wrapTitleText(text, Math.max(2, Math.floor((input.width * 0.86) / fontsize)))
    if (lines.length <= TITLE_CARD_MAX_LINES) break
  }
  if (lines.length > TITLE_CARD_MAX_LINES) throw new TitleCardTooLongError(lines.length)
  const lineHeight = Math.round(fontsize * 1.45)
  const textPaths: string[] = []
  try {
    for (const [index, line] of lines.entries()) {
      const textPath = `${input.outPath}.line-${index}.txt`
      await writeFile(textPath, line)
      textPaths.push(textPath)
    }
    const chain = lines
      .map((_, index) => {
        const dy = Math.round((index - (lines.length - 1) / 2) * lineHeight)
        return (
          `drawtext=fontfile='${escapeFilterValue(fontFile ?? '')}':textfile='${escapeFilterValue(`${input.outPath}.line-${index}.txt`)}'` +
          `:fontcolor=white:fontsize=${fontsize}:line_spacing=${Math.round(fontsize * 0.28)}` +
          `:x=(w-text_w)/2:y=(h-text_h)/2${dy >= 0 ? '+' : '-'}${Math.abs(dy)}`
        )
      })
      .join(',')
    // 字卡必须淡入淡出：它前后接的是真画面，硬切入硬切出等于在片子里拍了一下黑板。
    // 淡的时长按时长封顶（四分之一的秒数但不超过 0.5 s），否则一秒卡整段都在渐变，
    // 上面写的那句话根本看不清。fade 挂在 drawtext 之后——渐的是整帧，字跟着底一起灭。
    const fadeSeconds = Math.min(0.5, seconds / 4)
    const fadeChain =
      `,fade=t=in:st=0:d=${fadeSeconds.toFixed(3)},fade=t=out:st=${(seconds - fadeSeconds).toFixed(3)}:d=${fadeSeconds.toFixed(3)}`
    await run('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${input.background ?? '0x101014'}:s=${input.width}x${input.height}:r=${fps}:d=${seconds}`,
      '-vf',
      `${chain}${fadeChain}`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      input.outPath,
    ])
  } finally {
    await Promise.all(textPaths.map(p => rm(p, { force: true })))
  }
  const meta = await probeMediaMeta(input.outPath)
  return {
    mimeType: 'video/mp4',
    width: meta?.width ?? input.width,
    height: meta?.height ?? input.height,
    durationMs: meta?.durationMs ?? seconds * 1000,
    lines: lines.length,
  }
}

export class FfmpegComposer implements Composer {
  async compose(input: ComposeInput, output: string): Promise<ComposeResult> {
    const { clips, voices, audioSources, ambiences, bgm, srt, extras, label } = input
    if (clips.length === 0) throw new Error('compose requires at least one clip')
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-compose-'))
    try {
      const master = path.join(workdir, 'master.mp4')
      const applied = input.cuts && cutsBlend(input.cuts) ? input.cuts : undefined
      // 一刀不使的整集继续走 stream copy：混合拼接必须整条重编码，没有转场就不该
      // 让母带白掉一代画质（无转场路径逐字节不变是硬要求）。
      if (applied) await blendConcat(clips, applied, workdir, master)
      else await copyConcat(clips, master, workdir)
      const cutsResult = applied ? { cuts: applied } : {}

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

      // 只有真需要拼轨时才建轨：没人钦定声音来源、又没有一句配音/环境音的整集，
      // 走的还是「母带自带原声」那条老路（原声按拼接时的原始电平入片）。
      // V04:可闻 extras 单独不建主声轨——主声轨会把原声按 0.6 压电平重建,extras
      // 场景没有「排除原声」的意图,原声该按原电平留在母带里再叠 extras。
      const hasAudioDirection = Boolean(voices?.some(Boolean) || audioSources?.some(Boolean) || ambiences?.some(Boolean))
      const needsTrack = hasAudioDirection || (extras ?? []).some(entry => !entry.muted)
      const voiceResult = needsTrack && hasAudioDirection ? await buildVoiceTrack(voices ?? [], clips, workdir, audioSources, ambiences, applied) : undefined
      const bedsResult = voiceResult ? { beds: voiceResult.beds } : {}
      const voice = voiceResult?.track
      const withBgm = bgm ? await mixBgm(bgm, voice, master, workdir) : voice
      const audio = withBgm ?? undefined
      // R04/Q02/V04:独立音轨进混音——只有可闻轨参与(muted 轨不应凭空造一条替换轨
      // 截短母带)。基底规则:存在解析好的主声轨(配音/环境音/声音档位)时它是唯一
      // 基底——「只用配音」排除掉的原声不许从后门混回来;只有无主声轨时,母带自带
      // 原声才是基底(没人表达过排除原声的意图)。
      const audibleExtras = (extras ?? []).filter(entry => !entry.muted)
      const extrasMixed = audibleExtras.length > 0
      const finalAudio = extrasMixed ? await mixExtraTracks(audibleExtras, audio, master, workdir) : audio
      // 台词溢出(一句话比画面长)时用末帧定格补齐画面——L-cut 的收尾,
      // 保证最后半句台词不被视频截断。补帧需要重编码视频,不能用 stream copy。
      const overflowSeconds = (voiceResult?.overflowMs ?? 0) / 1000
      const needsFrameHold = overflowSeconds > 0.2
      // R04:outputSpec.aspect 统一画幅——素材异形时 scale+pad 到目标帧,黑边居中。
      const aspect = input.outputSpec?.aspect
      const aspectFilter = aspect === '9:16'
        ? 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2'
        : aspect === '16:9'
          ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2'
          : undefined
      if (!finalAudio && !srt && !badge && !aspectFilter) {
        await rm(output, { force: true })
        if (needsFrameHold) {
          await run('ffmpeg', ['-y', '-v', 'error', '-i', master, '-vf', `tpad=stop_mode=clone:stop_duration=${overflowSeconds.toFixed(3)}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', ...labelArgs, output])
        } else {
          await run('ffmpeg', ['-y', '-v', 'error', '-i', master, '-c', 'copy', ...labelArgs, output])
        }
        return { durationMs: await probeDuration(output), ...(labeling ? { labeling } : {}), ...cutsResult }
      }

      // 字幕两条交付路径:硬烧进画面(短剧交付标准)或挂 mov_text 软字幕轨(外部
      // 播放器可见,网页端由播放器组件叠加渲染)。走哪条由 STUDIO_SUBTITLE_MODE
      // 定,见 resolveBurnSubtitles。与末帧定格(tpad)、AI 角标合并在同一条 -vf 里。
      const canBurn = srt ? await resolveBurnSubtitles() : false
      const videoFilters: string[] = []
      if (aspectFilter) videoFilters.push(aspectFilter)
      if (needsFrameHold) videoFilters.push(`tpad=stop_mode=clone:stop_duration=${overflowSeconds.toFixed(3)}`)
      if (badge) videoFilters.push(badge)
      if (srt && canBurn) videoFilters.push(`subtitles=filename='${srt.replaceAll("'", String.fromCharCode(92) + "'").replaceAll(':', String.fromCharCode(92) + ':')}':force_style='FontSize=18,Outline=1,Shadow=0,MarginV=28'`)

      const args = ['-y', '-v', 'error', '-i', master]
      if (finalAudio) args.push('-i', finalAudio)
      args.push('-map', '0:v:0')
      if (finalAudio) {
        args.push('-map', '1:a:0')
      } else {
        // Q02:没有替换声轨时保留母带自带原声(有则映射、无则跳过)——重编码画面
        // (画幅/角标/定格)不许顺手丢掉音频流。
        args.push('-map', '0:a?')
      }
      if (videoFilters.length > 0) args.push('-vf', videoFilters.join(','))
      if (videoFilters.length > 0) {
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18')
      } else {
        args.push('-c:v', 'copy')
      }
      if (finalAudio) {
        if (extrasMixed) {
          // Q02:extras 轨长度与画面无关——成片总长以画面时间线为准:不足补静音
          // (apad),超出裁掉(-t),不用 -shortest 反向裁短画面。
          const videoSeconds = (await probeDuration(master)) / 1000 + overflowSeconds
          args.push('-c:a', 'aac', '-b:a', '192k', '-af', 'apad', '-t', videoSeconds.toFixed(3))
        } else {
          args.push('-c:a', 'aac', '-b:a', '192k', '-shortest')
        }
      } else if (videoFilters.length > 0) {
        args.push('-c:a', 'copy')
      }
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
      return { durationMs: await probeDuration(output), ...(labeling ? { labeling } : {}), ...bedsResult, ...cutsResult }
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
          steps.push({ step: 'loudnorm', outcome: 'skipped', reason: `audio is near-silent (${formatLufs(before.i)} LUFS), nothing to normalize` })
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
  // 全静音的音轨 loudnorm 报的是字符串 "-inf"，不是数字——那正是「这里没有可归一的响度」
  // 这件事本身。把它当异常抛出去会让一条无声母带把整个地板判成 fallback（实测：字卡
  // 补上静音轨后 quality floor 就是这么红的），而调用方要的是「诚实跳过」。
  const read = (value: string | undefined) => (value === '-inf' ? Number.NEGATIVE_INFINITY : Number(value))
  const reading = { i: read(report.input_i), tp: read(report.input_tp), lra: read(report.input_lra), thresh: read(report.input_thresh) }
  if (Number.isNaN(reading.i) || (Number.isNaN(reading.thresh) && reading.i !== Number.NEGATIVE_INFINITY)) {
    throw new Error('loudnorm measurement returned non-finite values')
  }
  return reading
}

/** LUFS 读数进文案：-inf 要写成 -inf，不能写成 -Infinity。 */
function formatLufs(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '-inf'
}

/** 两遍法:第一遍实测,第二遍按实测值线性增益——单遍动态模式会"泵"。 */
function loudnormApplyFilter(measured: LoudnessReading): string {
  return `loudnorm=I=${LOUDNORM_TARGET_I}:TP=${LOUDNORM_TARGET_TP}:LRA=${LOUDNORM_TARGET_LRA}:measured_I=${measured.i}:measured_TP=${measured.tp}:measured_LRA=${measured.lra}:measured_thresh=${measured.thresh}:offset=0:linear=true`
}

async function probeVideoStream(file: string): Promise<{ height: number; width: number; fps: number } | undefined> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,avg_frame_rate',
      '-of', 'json', file,
    ])
    const stream = (JSON.parse(stdout).streams ?? [])[0] as { height?: number; width?: number; avg_frame_rate?: string } | undefined
    if (!stream) return undefined
    const [num, den] = (stream.avg_frame_rate ?? '0/1').split('/')
    const fps = Number(den) > 0 ? Number(num) / Number(den) : 0
    return { height: Number(stream.height ?? 0), width: Number(stream.width ?? 0), fps: Number.isFinite(fps) ? fps : 0 }
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
  // concat demuxer 拿第一段的流布局当整条母带的布局：只要有一个镜头不带音轨（本机画的
  // 字卡就是），输出的就只有视频流，后面每一个镜头的原声被一起静默丢掉，实测整集还短
  // 0.4~0.6 s。所以不带音轨的段先按自身实测时长垫一条等长静音——画面仍走 -c:v copy，
  // 不吃一代画质，拼接继续是 copy。
  const aligned: string[] = []
  for (const [index, clip] of clips.entries()) {
    const seconds = await probeDuration(clip)
    if ((await hasAudioStream(clip)) || seconds <= 0) {
      aligned.push(clip)
      continue
    }
    const padded = path.join(workdir, `silent-audio-${index}.mp4`)
    await run('ffmpeg', [
      '-y', '-v', 'error',
      '-i', clip,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest',
      padded,
    ])
    aligned.push(padded)
  }
  const list = path.join(workdir, 'clips.txt')
  const entries = aligned.map(clip => `file '${clip.replaceAll("'", "'\\''")}'`).join('\n')
  await writeFile(list, entries + '\n')
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', target])
}

/**
 * 音频桥（docs/plan_2026-10-24.md §5 决策表「同一空间换机位／时间小幅推进」行）：
 * 硬切处最先听到的断层不是画面，是声场在剪点上瞬断——上一场的底在 cut 前一帧消失，
 * 下一场的声音在 cut 后一帧全量进来。方案给的口径是「环境音提前 0.3–0.5s 进、上一场
 * 拖 0.2s 出」；这里取该区间的中值 400ms 与 0.2s 定为项目常量，要逐刀调只改这两行。
 */
export const AUDIO_BRIDGE_PRE_MS = 400
export const AUDIO_BRIDGE_TAIL_MS = 200

export interface ShotBed {
  /** 这一镜的氛围底：null = 这一镜没有底。 */
  file: string | null
  /** true = 人工导入的环境音，可以越过剪点；false = 模型原声，只能待在本镜画面里。 */
  imported: boolean
  shotStartMs: number
  shotDurationMs: number
}

export interface BedPlacement {
  file: string
  imported: boolean
  /** 这条底在成片时间线上的起点（含 pre-roll，可早于它所属镜头的画面）。 */
  startMs: number
  durationMs: number
  fadeInMs: number
  fadeOutMs: number
  /** 这一条底覆盖了哪几镜（下标）：同一场共用一条底时是一串，不是一个。 */
  shotIndexes: number[]
}

/**
 * 声床落位计划。两条规则各自钉住一个缺陷：
 * - 连续几镜共用同一条导入底 = 同一场戏的声床，只响一次；逐镜重放会让每一刀都听见
 *   「这条街从头开始响」。判据是同一个文件路径（worker 侧按字节 checksum 让同一份
 *   导入落到同一路径，所以界面上一镜一上传也不会把一条街切成几段）。
 * - 导入底的两侧按音频桥越界并淡入淡出；模型原声一律不动——它带着口型，越界就是
 *   把上一镜的台词拖进下一镜的嘴。
 * 首镜不 pre-roll（成片前面没有画面可垫），末镜不 tail（越过母带末尾只会被裁掉）。
 */
export function planAudioBridges(beds: ShotBed[], totalMs: number): BedPlacement[] {
  const placements: BedPlacement[] = []
  for (let index = 0; index < beds.length; index += 1) {
    const bed = beds[index]!
    if (!bed.file) continue
    if (!bed.imported) {
      placements.push({ file: bed.file, imported: false, startMs: bed.shotStartMs, durationMs: bed.shotDurationMs, fadeInMs: 0, fadeOutMs: 0, shotIndexes: [index] })
      continue
    }
    let last = index
    while (beds[last + 1]?.file === bed.file && beds[last + 1]?.imported) last += 1
    const runLast = beds[last]!
    const fadeInMs = Math.min(AUDIO_BRIDGE_PRE_MS, bed.shotStartMs)
    const fadeOutMs = Math.min(AUDIO_BRIDGE_TAIL_MS, Math.max(0, totalMs - (runLast.shotStartMs + runLast.shotDurationMs)))
    placements.push({
      file: bed.file,
      imported: true,
      startMs: bed.shotStartMs - fadeInMs,
      durationMs: runLast.shotStartMs + runLast.shotDurationMs - bed.shotStartMs + fadeInMs + fadeOutMs,
      fadeInMs,
      fadeOutMs,
      shotIndexes: Array.from({ length: last - index + 1 }, (_, offset) => index + offset),
    })
    index = last
  }
  return placements
}

/**
 * 转场（docs/plan_2026-10-24.md §5）。一个镜头的「转场」描述的是**它怎么进入**，所以
 * 一刀的写法优先看来后面那一镜；只有一种情况要看前面那一镜：前一镜明写「淡出」而后面
 * 这镜没点名（硬切）——那时这一刀仍是淡到黑再起来，否则「淡出」这句编辑意图在成片里
 * 一个字都不会发生。`fade_out` 落在集尾时不缩短总长，它只是收尾压黑。
 *
 * 叠化/黑场/闪白都是**重叠**：两侧画面共用 overlapMs，母带当场短这么多。所以这一份
 * 计划同时是成片时间线的唯一算尺——字幕、配音落位、编辑音轨锚点全部按它给出的
 * shotStartMs 排，按镜头标称时长排就是拿一张已经不成立的表去对音。
 */
export const MASTER_CUT_KINDS = ['cut', 'dissolve', 'black', 'flash'] as const
export type MasterCutKind = (typeof MASTER_CUT_KINDS)[number]

const CUT_XFADE: Record<Exclude<MasterCutKind, 'cut'>, string> = {
  dissolve: 'fade',
  black: 'fadeblack',
  flash: 'fadewhite',
}

/** 分镜表「转场」列的定格值：镜头上的原始写法 + 毫秒。 */
export interface ShotTransitionInput {
  transition: string
  transitionMs: number
}

export interface MasterCutPlan {
  /** 这一版时间线的基准帧率：母带按它重采样成 CFR，段长/重叠都以整帧计。 */
  fps: number
  /** 第 i 镜在母带里真正占用的毫秒（实测值对齐到整帧）。 */
  clipMs: number[]
  /** 第 i 镜进入时那一刀最终用什么（index 0 恒为 cut，片头另走 headFadeMs）。 */
  kindAt: MasterCutKind[]
  /** 第 i 镜这一刀实际吃掉的重叠毫秒；0 = 裸切，与母带自带原声都不动。 */
  overlapMs: number[]
  /** 第 i 镜画面在成片时间线上的起点——字幕/配音/锚点的唯一基准。 */
  shotStartMs: number[]
  /** 片头从黑场起来的毫秒（不缩短总长）。 */
  headFadeMs: number
  /** 集尾压黑的毫秒（不缩短总长）。 */
  tailFadeMs: number
  totalMs: number
}

/** 转场列的原文 → 这一刀的形状。`fade_in` 与 `black` 在重叠模型里是同一个动作。 */
function cutKindOf(transition: string): MasterCutKind {
  switch (transition) {
    case 'dissolve':
      return 'dissolve'
    case 'black':
    case 'fade_in':
      return 'black'
    case 'flash':
      return 'flash'
    default:
      return 'cut'
  }
}

/** 时间线基准帧率的兜底：探针读不出帧率时按 25 fps 排（短剧序列的通行档位）。 */
export const DEFAULT_TIMELINE_FPS = 25

/**
 * 纯函数：给每镜实测长度与逐镜转场，算出母带时间线。所有算术先在**整帧**上做——
 * 渲染侧的 xfade 偏移只能落在帧上，先在帧上定案再把毫秒报给消费方，字幕与画面才
 * 不会各拿一把尺。重叠被夹到不超过较短一侧的一半：夹到能吃光一侧画面时，「转场」
 * 就变成了「这一段没了」，那比裸切更糟。夹完不足 50ms 直接当裸切——肉眼读不出来的
 * 过渡，只换来一次重编码。
 */
export function planMasterCuts(
  clipMs: number[],
  transitions: (ShotTransitionInput | null | undefined)[],
  fps: number = DEFAULT_TIMELINE_FPS,
): MasterCutPlan {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_TIMELINE_FPS
  const frames = clipMs.map(ms => Math.max(1, Math.round(Math.max(0, ms) * rate / 1000)))
  const kindAt: MasterCutKind[] = []
  const overlapFrames: number[] = []
  const startFrames: number[] = []
  for (let index = 0; index < clipMs.length; index += 1) {
    const own = index === 0 ? null : transitions[index] ?? null
    const previous = index === 0 ? null : transitions[index - 1] ?? null
    let kind: MasterCutKind = own ? cutKindOf(own.transition) : 'cut'
    let requestedMs = own?.transitionMs ?? 0
    if (kind === 'cut' && previous?.transition === 'fade_out') {
      kind = 'black'
      requestedMs = previous.transitionMs
    }
    let overlap = 0
    if (kind !== 'cut') {
      overlap = Math.min(Math.max(0, Math.round(requestedMs * rate / 1000)), Math.floor(Math.min(frames[index - 1] ?? 0, frames[index] ?? 0) / 2))
      if (overlap * 1000 / rate < 50) kind = 'cut'
      else overlapFrames[index] = overlap
    }
    overlapFrames[index] = overlap
    kindAt[index] = kind
    startFrames[index] = index === 0 ? 0 : startFrames[index - 1]! + frames[index - 1]! - overlap
  }
  const toMs = (value: number) => Math.round(value * 1000 / rate)
  const shotStartMs = startFrames.map(toMs)
  const snapped = frames.map(toMs)
  // 重叠从「相邻两镜的起点差」反推，保证消费方拿到的表自洽：
  // start[i] = start[i-1] + clipMs[i-1] - overlapMs[i] 逐字成立，舍入不会两头不一致。
  const overlapMs = shotStartMs.map((start, index) => (index === 0 ? 0 : shotStartMs[index - 1]! + snapped[index - 1]! - start))
  const last = clipMs.length - 1
  const first = transitions[0] ?? null
  const tail = last >= 0 ? transitions[last] ?? null : null
  const fadeFrames = (ms: number, side: number | undefined) => Math.max(0, Math.min(Math.round(ms * rate / 1000), Math.floor((side ?? 0) / 2)))
  return {
    fps: rate,
    clipMs: snapped,
    kindAt,
    overlapMs,
    shotStartMs,
    headFadeMs: first && (first.transition === 'fade_in' || first.transition === 'black') ? toMs(fadeFrames(first.transitionMs, frames[0])) : 0,
    tailFadeMs: tail?.transition === 'fade_out' ? toMs(fadeFrames(tail.transitionMs, frames[last])) : 0,
    totalMs: last < 0 ? 0 : shotStartMs[last]! + snapped[last]!,
  }
}

/** 从文件本身算母带时间线：实测长度 + 首镜帧率，渲染侧与调用侧同一把尺。 */
export async function planMasterCutsForClips(clips: string[], transitions: (ShotTransitionInput | null | undefined)[]): Promise<MasterCutPlan> {
  const clipMs = await Promise.all(clips.map(clip => probeDuration(clip)))
  const fps = (await probeVideoStream(clips[0] ?? ''))?.fps ?? DEFAULT_TIMELINE_FPS
  return planMasterCuts(clipMs, transitions, fps)
}

/** 这一份计划里有没有真的重叠/淡入淡出——全零就还是那条 stream-copy 老路。 */
function cutsBlend(plan: MasterCutPlan): boolean {
  return plan.headFadeMs > 0 || plan.tailFadeMs > 0 || plan.overlapMs.some(ms => ms > 0)
}

/**
 * 转场母带拼接：一次 ffmpeg、一次编码。硬切段先按 concat 滤镜串成组，组与组之间才走
 * xfade/acrossfade——把 62 镜全部逐刀串成 xfade 会让一条滤镜图长到 ffmpeg 自己吃不消，
 * 而绝大多数刀本来就是硬切。总长缩短 Σ overlap，音频用 acrossfade 同步缩短，两侧
 * 画面/声音因此始终在同一条时间线上。
 */
async function blendConcat(clips: string[], plan: MasterCutPlan, workdir: string, target: string): Promise<void> {
  const rate = plan.fps
  // xfade 要求两侧尺寸/SAR/像素格式/帧率完全一致；缺音轨的段先垫一条等长静音
  //（画面仍 -c:v copy，不吃画质），否则一个字卡就能让整条滤镜图报错并静默丢掉原声。
  const canvas = await probeMediaMeta(clips[0]!)
  const width = canvas?.width ?? 1080
  const height = canvas?.height ?? 1920
  const sources: string[] = []
  for (const [index, clip] of clips.entries()) {
    if (await hasAudioStream(clip)) {
      sources.push(clip)
      continue
    }
    const seconds = (plan.clipMs[index] ?? 0) / 1000
    const padded = path.join(workdir, `blend-silent-${index}.mp4`)
    await run('ffmpeg', [
      '-y', '-v', 'error',
      '-i', clip,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest',
      padded,
    ])
    sources.push(padded)
  }
  const groups: number[][] = [[]]
  for (let index = 0; index < sources.length; index += 1) {
    if (index > 0 && (plan.overlapMs[index] ?? 0) > 0) groups.push([])
    groups[groups.length - 1]!.push(index)
  }
  const parts: string[] = []
  const frameCount = (index: number) => Math.max(1, Math.round((plan.clipMs[index] ?? 0) * rate / 1000))
  sources.forEach((_, index) => {
    parts.push(
      `[${index}:v]fps=${rate},scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,` +
        `trim=end_frame=${frameCount(index)},setpts=N/(${rate}*TB),settb=AVTB[v${index}]`,
    )
    const seconds = (frameCount(index) / rate).toFixed(6)
    parts.push(`[${index}:a]aformat=sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=end=${seconds},asetpts=PTS-STARTPTS[a${index}]`)
  })
  const chained: Array<{ video: string; audio: string; shot: number; frames: number }> = []
  for (const [groupIndex, group] of groups.entries()) {
    if (group.length === 1) {
      const index = group[0]!
      chained.push({ video: `[v${index}]`, audio: `[a${index}]`, shot: index, frames: frameCount(index) })
      continue
    }
    // concat 的输入必须画面/音频逐段交替，不是「全部 v 再全部 a」。
    const labels = group.map(index => `[v${index}][a${index}]`).join('')
    parts.push(`${labels}concat=n=${group.length}:v=1:a=1[gv${groupIndex}][ga${groupIndex}]`)
    chained.push({ video: `[gv${groupIndex}]`, audio: `[ga${groupIndex}]`, shot: group[0]!, frames: group.reduce((sum, index) => sum + frameCount(index), 0) })
  }
  let current = chained[0]!
  let step = 0
  for (const next of chained.slice(1)) {
    const overlapFrames = Math.max(1, Math.round((plan.overlapMs[next.shot] ?? 0) * rate / 1000))
    const seconds = (overlapFrames / rate).toFixed(6)
    const offset = ((current.frames - overlapFrames) / rate).toFixed(6)
    const kind = plan.kindAt[next.shot] ?? 'cut'
    const blend = `x${step}`
    parts.push(`${current.video}${next.video}xfade=transition=${CUT_XFADE[kind === 'cut' ? 'dissolve' : kind]}:duration=${seconds}:offset=${offset}[bv${blend}]`)
    parts.push(`${current.audio}${next.audio}acrossfade=d=${seconds}:c1=tri:c2=tri[ba${blend}]`)
    current = { video: `[bv${blend}]`, audio: `[ba${blend}]`, shot: next.shot, frames: current.frames + next.frames - overlapFrames }
    step += 1
  }
  const headSeconds = (plan.headFadeMs / 1000).toFixed(6)
  const tailStart = ((plan.totalMs - plan.tailFadeMs) / 1000).toFixed(6)
  const tailSeconds = (plan.tailFadeMs / 1000).toFixed(6)
  const videoFades = [
    plan.headFadeMs > 0 ? `fade=t=in:st=0:d=${headSeconds}` : '',
    plan.tailFadeMs > 0 ? `fade=t=out:st=${tailStart}:d=${tailSeconds}` : '',
  ].filter(Boolean)
  const audioFades = [
    plan.headFadeMs > 0 ? `afade=t=in:st=0:d=${headSeconds}` : '',
    plan.tailFadeMs > 0 ? `afade=t=out:st=${tailStart}:d=${tailSeconds}` : '',
  ].filter(Boolean)
  parts.push(`${current.video}${videoFades.length > 0 ? videoFades.join(',') : 'null'}[mv]`)
  parts.push(`${current.audio}${audioFades.length > 0 ? audioFades.join(',') : 'anull'}[ma]`)
  const inputs = sources.flatMap(clip => ['-i', clip])
  await run('ffmpeg', [
    '-y', '-v', 'error',
    ...inputs,
    '-filter_complex', parts.join(';'),
    '-map', '[mv]', '-map', '[ma]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    target,
  ])
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
  cut?: MasterCutPlan,
): Promise<{ track: string; overflowMs: number; beds: BedPlacement[] }> {
  let videoCursorMs = 0
  let audioCursorMs = 0
  const placed: Array<{ file: string; startMs: number }> = []
  const shotBeds: ShotBed[] = []
  for (const [index, clip] of clips.entries()) {
    // 有转场时画面已经吃掉重叠、起点不再是「上一镜末尾」——落位一律按那一刀表排，
    // 再按各自的实测长度累加就会让配音比画面晚到，越往后偏得越多。
    const shotStartMs = cut ? (cut.shotStartMs[index] ?? videoCursorMs) : videoCursorMs
    const clipMs = cut ? Math.max(1, cut.clipMs[index] ?? 1) : Math.max(1, await probeDuration(clip))
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
    // 这一镜的氛围底：导入的环境音优先，人既然点名了这条街声，就不该再叠一层模型
    // 自己混好的原声（那里面可能带着它自己"念"出来的词）。
    shotBeds.push({
      file: ambience ?? (useNative && (await hasAudioStream(clip)) ? clip : null),
      imported: ambience !== null,
      shotStartMs,
      shotDurationMs: clipMs,
    })
    videoCursorMs = shotStartMs + clipMs
  }

  const beds = planAudioBridges(shotBeds, videoCursorMs)
  for (const [index, bed] of beds.entries()) {
    const segment = path.join(workdir, `ambient-${index}.wav`)
    const seconds = (bed.durationMs / 1000).toFixed(3)
    const fades = [
      bed.fadeInMs > 0 ? `afade=t=in:st=0:d=${(bed.fadeInMs / 1000).toFixed(3)}` : '',
      bed.fadeOutMs > 0 ? `afade=t=out:st=${((bed.durationMs - bed.fadeOutMs) / 1000).toFixed(3)}:d=${(bed.fadeOutMs / 1000).toFixed(3)}` : '',
    ].filter(Boolean).join(',')
    if (bed.imported) {
      // 导入底比这一场短就接上自己循环：雨声、街声本来就是连续的，中途哑掉比循环更假。
      // `-stream_loop -1` 必须配 `-t` 硬上限——SD-119 里一条跑飞的混音写出过 81.5 GB。
      await run('ffmpeg', [
        '-y', '-v', 'error', '-stream_loop', '-1', '-i', bed.file,
        '-af', `${AUDIO_SHAPE},atrim=0:${seconds},asetpts=PTS-STARTPTS${fades ? `,${fades}` : ''}`,
        '-t', seconds,
        '-c:a', 'pcm_s16le', segment,
      ])
    } else {
      await run('ffmpeg', [
        '-y', '-v', 'error', '-i', bed.file,
        '-af', `${AUDIO_SHAPE},apad,atrim=0:${seconds}`,
        '-c:a', 'pcm_s16le', segment,
      ])
    }
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
  const inputs: string[] = []
  placed.forEach((entry, placedIndex) => {
    inputs.push('-i', entry.file)
    filterParts.push(`[${placedIndex + 1}:a]${AUDIO_SHAPE},adelay=${Math.round(entry.startMs)}:all=1[v${placedIndex + 1}]`)
  })
  for (const [ambientIndex, ambientEntry] of beds.entries()) {
    inputs.push('-i', path.join(workdir, `ambient-${ambientIndex}.wav`))
    // 环境声也必须按各自声床的起点进轨,否则第三镜的街道声会在第一镜响起来。
    filterParts.push(`[${placed.length + ambientIndex + 1}:a]${AUDIO_SHAPE},adelay=${Math.round(ambientEntry.startMs)}:all=1,volume=0.6[amb${ambientIndex + 1}]`)
  }
  const mixInputs = ['[bed]', ...placed.map((_, i) => `[v${i + 1}]`), ...beds.map((_, i) => `[amb${i + 1}]`)].join('')
  filterParts.push(`${mixInputs}amix=inputs=${1 + placed.length + beds.length}:duration=first:normalize=0`)

  const voice = path.join(workdir, 'voice.wav')
  await run('ffmpeg', ['-y', '-v', 'error', '-i', bed, ...inputs, '-filter_complex', filterParts.join(';'), '-c:a', 'pcm_s16le', voice])
  return { track: voice, overflowMs: Math.max(0, Math.round(audioCursorMs - totalVideoMs)), beds }
}

/**
 * R04/Q02/V04:编辑时间线的独立音轨混音。基底规则:存在解析好的主声轨(mainAudio)
 * 时它是唯一基底——声音档位已经裁决过原声去留,这里不许把被排除的原声从母带重新
 * 混回来;仅无主声轨时(没人表达过排除原声的意图)母带自带原声才作为基底。extra
 * adelay=startMs 定位、volume=gain;时长取最长,最终由调用方按画面时间线补静音/裁剪。
 * 任一输入损坏即抛错——静默丢轨等于编辑意图在成片里蒸发(F10 的教训)。
 */
async function mixExtraTracks(
  extras: Array<{ file: string; startMs: number; gain: number; muted: boolean }>,
  mainAudio: string | undefined,
  master: string,
  workdir: string,
): Promise<string> {
  const mixed = path.join(workdir, 'extras-mixed.wav')
  const args: string[] = ['-y', '-v', 'error']
  const filters: string[] = []
  const labels: string[] = []
  let inputIndex = 0
  if (mainAudio) {
    args.push('-i', mainAudio)
    filters.push(`[${inputIndex}:a]${AUDIO_SHAPE}[m]`)
    labels.push('[m]')
    inputIndex++
  } else if (await hasAudioStream(master)) {
    args.push('-i', master)
    filters.push(`[${inputIndex}:a]${AUDIO_SHAPE}[nat]`)
    labels.push('[nat]')
    inputIndex++
  }
  for (const entry of extras) {
    args.push('-i', entry.file)
    const volume = entry.muted ? 0 : entry.gain
    filters.push(`[${inputIndex}:a]${AUDIO_SHAPE},volume=${volume}${entry.startMs > 0 ? `,adelay=${Math.round(entry.startMs)}:all=1` : ''}[x${inputIndex}]`)
    labels.push(`[x${inputIndex}]`)
    inputIndex++
  }
  if (labels.length === 0) throw new Error('mixExtraTracks: nothing audible to mix')
  filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0`)
  await run('ffmpeg', [...args, '-filter_complex', filters.join(';'), '-vn', '-c:a', 'pcm_s16le', mixed])
  return mixed
}

async function mixBgm(bgm: string, voice: string | undefined, master: string, workdir: string): Promise<string> {
  const mixed = path.join(workdir, 'mixed.wav')
  if (!voice) {
    const seconds = Math.max(1, await probeDuration(master)) / 1000
    // 无配音轨时,若成片母带自带原生音轨(wan3.0 一类),配乐只做垫底,不整体替换。
    if (await hasAudioStream(master)) {
      // amix 的 duration=first 数的是**输入列表里的第一个**，而 [bed] 是 -stream_loop -1
      // 的无限循环：把 [bed] 摆在前面，这条命令就永远跑不完（实测挂满 5 s 测试超时）。
      // 有限的那一段（母带原声）必须排在前面，末尾再按母带实测时长兜底裁一刀。
      await run('ffmpeg', [
        '-y', '-v', 'error', '-i', master, '-stream_loop', '-1', '-i', bgm,
        '-filter_complex', `[0:a]${AUDIO_SHAPE}[native];[1:a]${AUDIO_SHAPE},volume=${BGM_VOLUME}[bed];[native][bed]amix=inputs=2:duration=first:normalize=0`,
        '-vn', '-c:a', 'pcm_s16le', '-t', seconds.toFixed(3), mixed,
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
  // 实测这条图本身会在配音轨长度处收住（3 s 配音 → 529,278 B / 3.00 s），但 SD-119
  // 之后不能再让任何一条 pcm_s16le 写盘命令只靠 amix 的语义收尾：一条跑飞的命令
  // 会一直写下去（4 秒画面写出过 81.5 GB），而测试超时并不会杀死这个子进程。
  // 配音轨就是这条混音的目标长度，按它实测时长钉一刀是零内容损失的硬上限。
  await run('ffmpeg', [
    '-y', '-v', 'error', '-stream_loop', '-1', '-i', bgm, '-i', voice,
    '-filter_complex', bgmVoiceMixFilter(await hasFilter('sidechaincompress')),
    '-vn', '-c:a', 'pcm_s16le', '-t', (Math.max(1, await probeDuration(voice)) / 1000).toFixed(3), mixed,
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

/**
 * 末帧抽取。帧链的确定性来自「下一段的首帧就是这一段的末帧本体」，所以这里
 * 取的是剪辑时间轴末尾前 0.2 秒的一帧——不取最后 1 帧：末帧常落在淡出/运动
 * 模糊上，当首帧用会把糊带进下一段。取不到（极短片段）就退回中点帧的那套参数。
 */
export function endFrameArgs(inputPath: string, outputPath: string, durationMs: number): string[] {
  const seek = Math.max(0, durationMs / 1000 - 0.2)
  return [
    '-y', '-v', 'error',
    '-ss', seek.toFixed(3),
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', "scale='min(1024,iw)':-2",
    '-q:v', '3',
    outputPath,
  ]
}

export async function extractEndFrame(inputPath: string, outputPath: string, durationMs?: number): Promise<void> {
  const known = durationMs ?? await probeDuration(inputPath)
  if (known <= 200) {
    await extractFrame(inputPath, outputPath, known)
    return
  }
  await run('ffmpeg', endFrameArgs(inputPath, outputPath, known))
}

/**
 * 把一条镜头的连续段拼成整镜母带。同源同参数时走 copy（不吃一代画质）；
 * 段间编码参数不一致时 concat demuxer 会直接失败，退回一次重编码——
 * 接缝看不出来比省一次编码重要。
 */
export async function concatVideoClips(clips: string[], target: string, workdir: string): Promise<void> {
  try {
    await copyConcat(clips, target, workdir)
    return
  } catch {
    // fall through to re-encode
  }
  const list = path.join(workdir, 'clips-reencode.txt')
  await writeFile(list, clips.map(clip => `file '${clip.replaceAll("'", "'\\''")}'`).join('\n') + '\n')
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    target,
  ])
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
  options: { durationMs?: number; extendSource?: string } = {},
): Promise<SynthesizedMedia> {
  // Q05:mock 延长契约=保留源前段的完整加长片。带 extendSource 时 durationMs
  // 语义是「追加段时长」——真实拼接源字节+构造追加段,而不是重新生成 testsrc 全片。
  if (options.extendSource?.startsWith('data:')) {
    return synthesizeMockExtend(options.extendSource, Math.max(1, Math.round((options.durationMs ?? 1000) / 1000)), outPath)
  }
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

/** mock 延长:源前段逐帧保留(画面与音频),追加段 testsrc 构造、音频静音补齐。 */
async function synthesizeMockExtend(dataUrl: string, appendSeconds: number, outPath: string): Promise<SynthesizedMedia> {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bytes = Buffer.from(base64, 'base64')
  const srcPath = `${outPath}.src.mp4`
  await writeFile(srcPath, bytes)
  const stream = await probeVideoStream(srcPath).catch(() => null)
  const width = stream?.width && stream.width > 0 ? stream.width : 320
  const height = stream?.height && stream.height > 0 ? stream.height : 240
  const srcHasAudio = await hasAudioStream(srcPath).catch(() => false)
  const srcSeconds = Math.max(0.1, (await probeDuration(srcPath).catch(() => appendSeconds * 1000)) / 1000)
  const extPath = `${outPath}.ext.mp4`
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${appendSeconds}:size=${width}x${height}:rate=25`, '-pix_fmt', 'yuv420p', extPath])
  const filters = [
    `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2[ex]`,
    '[0:v][ex]concat=n=2:v=1:a=0[v]',
  ]
  const args = ['-y', '-v', 'error', '-i', srcPath, '-i', extPath, '-filter_complex', filters.join(';'), '-map', '[v]']
  if (srcHasAudio) args.push('-map', '0:a:0', '-af', 'apad', '-c:a', 'aac', '-b:a', '192k')
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-t', (srcSeconds + appendSeconds).toFixed(3), outPath)
  await run('ffmpeg', args)
  return { mimeType: 'video/mp4', width, height, durationMs: await probeDuration(outPath) }
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
    case 'sfx':
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
    case 'sfx':
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

export * from './transcribe.js'
