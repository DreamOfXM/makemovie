import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const run = promisify(execFile)

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
}

export interface Composer {
  /** Concatenates clips in order into a single container file. */
  compose(clips: string[], output: string): Promise<ComposeResult>
}

async function probeDurationMs(file: string): Promise<number> {
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

export class FfmpegComposer implements Composer {
  async compose(clips: string[], output: string): Promise<ComposeResult> {
    if (clips.length === 0) throw new Error('compose requires at least one clip')
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-compose-'))
    const list = path.join(workdir, 'clips.txt')
    try {
      const entries = clips.map(clip => `file '${clip.replaceAll("'", "'\\''")}'`).join('\n')
      await writeFile(list, entries + '\n')
      await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', output])
      return { durationMs: await probeDurationMs(output) }
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  }
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
  const known = durationMs ?? await probeDurationMs(inputPath)
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
