import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { run } from './index.js'

/**
 * Gate for handing a generated first frame to a video model as its conditioning
 * image (image-to-video).
 *
 * The frame lives in our own object storage and is sent inline as a `data:` URL, so
 * the only constraints that matter are the ones the vendors publish: an accepted
 * format, both edges inside 240-8000 px, a byte ceiling per model family, and — for
 * the older family — no transparent PNG.
 *
 * A refusal is a value, not a fault. The product rule is that a shot which cannot be
 * conditioned must still be produced, so this never throws for a frame the vendors
 * would reject: it comes back with a reason that quotes the actual numbers, which is
 * what an operator reads in the log to work out why the shot lost its frame.
 */

export interface ReferenceImageLimits {
  /** Byte ceiling for the model family making the call: 10 MB older, 20 MB newer. */
  maxBytes: number
  /** Shortest edge the vendor accepts. Defaults to `REFERENCE_IMAGE_MIN_EDGE`. */
  minEdge?: number
  /** Longest edge the vendor accepts. Defaults to `REFERENCE_IMAGE_MAX_EDGE`. */
  maxEdge?: number
}

export type ReferenceImage =
  | { ok: true; bytes: Uint8Array; mimeType: string; width: number; height: number; reencoded: boolean }
  | { ok: false; reason: string }

export const REFERENCE_IMAGE_MIN_EDGE = 240
export const REFERENCE_IMAGE_MAX_EDGE = 8000
export const REFERENCE_IMAGE_MAX_BYTES_10MB = 10 * 1024 * 1024
export const REFERENCE_IMAGE_MAX_BYTES_20MB = 20 * 1024 * 1024

/**
 * The published formats. `canonical` is what we report back and put in the data URL —
 * `image/jpg` is a name the docs list but no media type registry carries, so a frame
 * accepted under it is still announced to the vendor as `image/jpeg`.
 */
const ACCEPTED_FORMATS: { mimeType: string; canonical: string; extension: string }[] = [
  { mimeType: 'image/jpeg', canonical: 'image/jpeg', extension: 'jpg' },
  { mimeType: 'image/jpg', canonical: 'image/jpeg', extension: 'jpg' },
  { mimeType: 'image/png', canonical: 'image/png', extension: 'png' },
  { mimeType: 'image/bmp', canonical: 'image/bmp', extension: 'bmp' },
  { mimeType: 'image/webp', canonical: 'image/webp', extension: 'webp' },
]

const ACCEPTED_NAMES = ACCEPTED_FORMATS.map(format => format.mimeType).join(', ')

function acceptedFormat(mimeType: string) {
  const wanted = mimeType.trim().toLowerCase()
  return ACCEPTED_FORMATS.find(format => format.mimeType === wanted || format.canonical === wanted)
}

/**
 * Pixel formats whose decoded frame carries an alpha plane. ffmpeg names a format by
 * its channel group and appends the bit depth and endianness, so testing the prefix
 * rather than "does it contain an `a`" is what keeps this honest: `yuvj420p` — the
 * format a plain JPEG decodes to — and `gray16be`, `bayer_rggb8` all hold an `a` with
 * no alpha plane anywhere.
 *
 * A palette PNG (`pal8`) can hold a transparent entry but decodes without an alpha
 * plane, so it stays as it is; guessing at it would re-encode frames the vendor accepts.
 */
const ALPHA_PIX_FMT_PREFIXES = ['rgba', 'argb', 'abgr', 'bgra', 'gbrap', 'yuva', 'ayuv', 'ya']

function hasAlphaChannel(pixFmt: string): boolean {
  return ALPHA_PIX_FMT_PREFIXES.some(prefix => pixFmt.startsWith(prefix))
}

function refuse(reason: string): ReferenceImage {
  return { ok: false, reason }
}

interface FrameProbe {
  width: number
  height: number
  pixFmt: string
}

/**
 * Reads the real pixels, not the container's claim: a stored artifact's dimensions are
 * whatever the encoder wrote, and only ffprobe knows.
 */
async function probeFrame(file: string): Promise<FrameProbe | null> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,pix_fmt',
    '-of', 'json',
    file,
  ])
  const probed = JSON.parse(stdout) as { streams?: { width?: number; height?: number; pix_fmt?: string }[] }
  const stream = probed.streams?.[0]
  if (!stream?.width || !stream?.height) return null
  return { width: stream.width, height: stream.height, pixFmt: stream.pix_fmt ?? '' }
}

/**
 * Turns stored frame bytes into the conditioning image a video model will accept, or
 * refuses with a reason that quotes the numbers behind the decision.
 *
 * `workdir` belongs to the caller — the one frame is written there and left there for
 * the caller's own cleanup. Nothing here creates a directory or removes one, and every
 * refusal that can happen without touching the disk happens before we touch the disk.
 */
export async function toReferenceImage(input: {
  bytes: Uint8Array
  mimeType: string
  workdir: string
  limits: ReferenceImageLimits
}): Promise<ReferenceImage> {
  const format = acceptedFormat(input.mimeType)
  if (!format) {
    return refuse(`mimeType "${input.mimeType}" is not one the video models accept; accepted: ${ACCEPTED_NAMES}`)
  }

  const { maxBytes } = input.limits
  if (input.bytes.byteLength > maxBytes) {
    return refuse(`frame is ${input.bytes.byteLength} bytes, over the vendor limit of ${maxBytes} bytes`)
  }

  const minEdge = input.limits.minEdge ?? REFERENCE_IMAGE_MIN_EDGE
  const maxEdge = input.limits.maxEdge ?? REFERENCE_IMAGE_MAX_EDGE

  // Deterministic names under one stem: the caller owns this directory, so a retry of
  // the same shot overwrites its own frame rather than leaving a trail behind.
  const stem = path.join(input.workdir, 'reference-frame')
  const source = `${stem}.${format.extension}`
  await writeFile(source, input.bytes)

  let frame: FrameProbe | null
  try {
    frame = await probeFrame(source)
  } catch (error) {
    return refuse(`ffprobe could not read the ${format.mimeType} frame: ${(error as Error).message}`)
  }
  if (!frame) {
    return refuse(`ffprobe found no decodable video stream in the ${input.bytes.byteLength} byte ${format.mimeType} frame`)
  }

  const { width, height, pixFmt } = frame
  if (width < minEdge || height < minEdge || width > maxEdge || height > maxEdge) {
    // Deliberately not rescaled: a frame we shrank is not the frame the director
    // approved, and a downscale that changes nothing visible is not worth the ambiguity.
    return refuse(`frame is ${width}x${height} px, outside the vendor limit of ${minEdge}-${maxEdge} px per edge`)
  }

  // PNG is the one accepted container our own chain can hand over with an alpha plane,
  // and a transparent reference image is rejected outright — flattened to an opaque
  // JPEG it still conditions the shot. The other formats pass through as stored.
  if (format.canonical === 'image/png' && hasAlphaChannel(pixFmt)) {
    const flattened = `${stem}.jpg`
    await run('ffmpeg', [
      '-y', '-v', 'error',
      '-i', source,
      '-frames:v', '1',
      '-vf', 'format=yuv420p',
      '-q:v', '3',
      flattened,
    ])
    const bytes = new Uint8Array(await readFile(flattened))
    if (bytes.byteLength > maxBytes) {
      return refuse(`frame flattened to an opaque JPEG is ${bytes.byteLength} bytes, still over the vendor limit of ${maxBytes} bytes`)
    }
    return { ok: true, bytes, mimeType: 'image/jpeg', width, height, reencoded: true }
  }

  return { ok: true, bytes: input.bytes, mimeType: format.canonical, width, height, reencoded: false }
}

/**
 * The payload an adapter puts on the wire. Base64 in Node never wraps, so the URL is
 * one line as the vendors require.
 */
export function toDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
}
