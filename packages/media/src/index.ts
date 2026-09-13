import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

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

export interface Storage {
  put(key: string, data: Uint8Array, mimeType: string): Promise<StoredObject>
  read(key: string): Promise<Uint8Array>
  exists(key: string): Promise<boolean>
  /** Absolute on-disk location, for tools (ffmpeg) that need a real file. */
  localPath(key: string): string
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

  localPath(key: string): string {
    const resolved = path.resolve(this.root, key)
    const root = path.resolve(this.root)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`object key escapes storage root: ${key}`)
    }
    return resolved
  }

  async put(key: string, data: Uint8Array, mimeType: string): Promise<StoredObject> {
    const target = this.localPath(key)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, data)
    return { key, checksum: sha256(data), sizeBytes: data.byteLength, mimeType }
  }

  async read(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.localPath(key)))
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.localPath(key))
      return true
    } catch {
      return false
    }
  }
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
