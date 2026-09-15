import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as media from '../src/index.js'
import type { ReferenceImage } from '../src/index.js'
import {
  REFERENCE_IMAGE_MAX_BYTES_10MB,
  REFERENCE_IMAGE_MIN_EDGE,
  toDataUrl,
  toReferenceImage,
} from '../src/index.js'

const run = promisify(execFile)

const LIMITS = { maxBytes: REFERENCE_IMAGE_MAX_BYTES_10MB }

interface ProbeResult {
  streams: { width?: number; height?: number; pix_fmt?: string }[]
}

async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', file])
  return JSON.parse(stdout) as ProbeResult
}

async function pixFmtOf(file: string): Promise<string> {
  return probe(file).then(result => result.streams[0]?.pix_fmt ?? '')
}

/**
 * Real frames, produced by the same ffmpeg the gate shells out to — no binary fixture
 * ever enters the repo. `alpha` writes a PNG whose decoded pixel format is `rgba`.
 */
async function still(file: string, size: string, alpha = false): Promise<Uint8Array> {
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x2f6f4f:size=${size}`]
  if (alpha) args.push('-vf', 'format=rgba,colorchannelmixer=aa=0.4')
  args.push('-frames:v', '1', '-q:v', '3', file)
  await run('ffmpeg', args)
  return new Uint8Array(await readFile(file))
}

function unwrap(result: ReferenceImage) {
  if (!result.ok) throw new Error(`expected the frame to be accepted, got: ${result.reason}`)
  return result
}

function refusal(result: ReferenceImage): string {
  if (result.ok) throw new Error('expected the frame to be refused, but it was accepted')
  return result.reason
}

describe('reference image gate', () => {
  let workdir: string

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-reference-'))
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('passes a plain JPEG through untouched', async () => {
    const file = path.join(workdir, 'frame.jpg')
    const bytes = await still(file, '640x480')

    const result = unwrap(await toReferenceImage({ bytes, mimeType: 'image/jpeg', workdir, limits: LIMITS }))

    expect(result.reencoded).toBe(false)
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.width).toBe(640)
    expect(result.height).toBe(480)
    expect(Buffer.from(result.bytes).equals(Buffer.from(bytes))).toBe(true)
  })

  it('flattens a transparent PNG onto an opaque JPEG', async () => {
    const file = path.join(workdir, 'frame.png')
    const bytes = await still(file, '480x360', true)
    // The fixture has to be the case under test, not a guess at it.
    expect(await pixFmtOf(file)).toBe('rgba')

    const result = unwrap(await toReferenceImage({ bytes, mimeType: 'image/png', workdir, limits: LIMITS }))

    expect(result.reencoded).toBe(true)
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.width).toBe(480)
    expect(result.height).toBe(360)
    expect(Buffer.from(result.bytes).subarray(0, 3).toString('hex')).toBe('ffd8ff')

    // Probed, not trusted: the bytes that come back must have no alpha plane in them.
    const out = path.join(workdir, 'flattened.jpg')
    await writeFile(out, result.bytes)
    const pixFmt = await pixFmtOf(out)
    expect(pixFmt).toMatch(/^yuvj?4/)
    expect(pixFmt).not.toMatch(/rgba|argb|abgr|bgra|gbrap|yuva|ayuv|ya\d/)
  })

  it('leaves an opaque PNG as the PNG it was given', async () => {
    const file = path.join(workdir, 'frame.png')
    const bytes = await still(file, '320x240')
    expect(await pixFmtOf(file)).not.toMatch(/rgba|yuva/)

    const result = unwrap(await toReferenceImage({ bytes, mimeType: 'image/png', workdir, limits: LIMITS }))

    expect(result.reencoded).toBe(false)
    expect(result.mimeType).toBe('image/png')
    expect(Buffer.from(result.bytes).equals(Buffer.from(bytes))).toBe(true)
  })

  it('refuses a frame under the shortest edge and quotes its dimensions', async () => {
    const file = path.join(workdir, 'small.jpg')
    const bytes = await still(file, '200x200')

    const reason = refusal(await toReferenceImage({ bytes, mimeType: 'image/jpeg', workdir, limits: LIMITS }))

    expect(reason).toContain('200x200')
    expect(reason).toContain(String(REFERENCE_IMAGE_MIN_EDGE))
  })

  it('refuses a frame over the longest edge and quotes its dimensions', async () => {
    const file = path.join(workdir, 'wide.jpg')
    const bytes = await still(file, '640x480')

    const reason = refusal(await toReferenceImage({ bytes, mimeType: 'image/jpeg', workdir, limits: { ...LIMITS, maxEdge: 500 } }))

    expect(reason).toContain('640x480')
    expect(reason).toContain('500')
  })

  it('refuses a frame over the byte ceiling without spawning anything', async () => {
    const spawn = vi.spyOn(media, 'run')
    // A frame that does reach the probe has to trip the same spy, or the assertion
    // below proves nothing. `still` spawns ffmpeg through the test's own `execFile`,
    // never through the helper the gate uses, so a call here is the gate's.
    const elsewhere = path.join(workdir, 'sanity')
    await mkdir(elsewhere)
    const accepted = await still(path.join(elsewhere, 'frame.jpg'), '320x240')
    unwrap(await toReferenceImage({ bytes: accepted, mimeType: 'image/jpeg', workdir: elsewhere, limits: LIMITS }))
    expect(spawn).toHaveBeenCalled()
    spawn.mockClear()

    // Undecodable on purpose: were the gate to probe this, the reason would name
    // ffprobe rather than the byte count.
    const reason = refusal(await toReferenceImage({ bytes: new Uint8Array(64).fill(7), mimeType: 'image/png', workdir, limits: { maxBytes: 32 } }))

    expect(reason).toContain('64 bytes')
    expect(reason).toContain('32 bytes')
    expect(spawn).not.toHaveBeenCalled()
    spawn.mockRestore()
    // The only thing in the workdir is the subdirectory this test made for itself.
    expect(await readdir(workdir)).toEqual(['sanity'])
  })

  it('refuses a format the vendors do not accept', async () => {
    const spawn = vi.spyOn(media, 'run')

    const reason = refusal(await toReferenceImage({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/tiff', workdir, limits: LIMITS }))

    expect(reason).toContain('image/tiff')
    expect(reason).toContain('image/jpeg')
    expect(spawn).not.toHaveBeenCalled()
    spawn.mockRestore()
    expect(await readdir(workdir)).toHaveLength(0)
  })

  it('refuses bytes ffprobe cannot read instead of throwing at the caller', async () => {
    const file = path.join(workdir, 'frame.jpg')
    await writeFile(file, 'this is not a picture')

    const reason = refusal(await toReferenceImage({
      bytes: new Uint8Array(await readFile(file)),
      mimeType: 'image/jpeg',
      workdir,
      limits: LIMITS,
    }))

    expect(reason).toMatch(/ffprobe/)
  })

  it('builds a data url that decodes back to the frame bytes', async () => {
    const file = path.join(workdir, 'frame.jpg')
    const bytes = await still(file, '480x360')
    const result = unwrap(await toReferenceImage({ bytes, mimeType: 'image/jpeg', workdir, limits: LIMITS }))

    const url = toDataUrl(result.bytes, result.mimeType)

    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(url).not.toContain('\n')
    expect(Buffer.from(url.slice('data:image/jpeg;base64,'.length), 'base64').equals(Buffer.from(bytes))).toBe(true)
  })

  it('round-trips arbitrary bytes through base64', () => {
    const bytes = new Uint8Array(Array.from({ length: 512 }, (_, index) => index % 256))

    const url = toDataUrl(bytes, 'image/png')

    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    expect([...Buffer.from(url.split(',')[1]!, 'base64')]).toEqual([...bytes])
  })
})
