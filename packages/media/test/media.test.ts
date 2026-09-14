import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiskStorage, buildObjectKey, extensionFor, extractFrame, frameArgs, synthesizeMockMedia } from '../src/index.js'

describe('disk storage', () => {
  let root: string
  let storage: DiskStorage

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'studio-media-'))
    storage = new DiskStorage(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('round-trips objects with a checksum', async () => {
    const key = buildObjectKey({
      tenantId: 'org-1',
      projectId: 'proj-1',
      episodeId: 'ep-1',
      stage: 'VIDEO',
      entityId: 'task-1',
      version: 1,
      extension: 'mp4',
    })
    const stored = await storage.put(key, new Uint8Array([1, 2, 3]), 'video/mp4')
    expect(stored.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(stored.sizeBytes).toBe(3)
    expect(await storage.exists(key)).toBe(true)
    expect([...(await storage.read(key))]).toEqual([1, 2, 3])
  })

  it('rejects keys that escape the storage root', () => {
    expect(() => storage.localPath('../../etc/passwd')).toThrow(/escapes storage root/)
  })
})

describe('mock media synthesis', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'studio-synth-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('produces a playable clip for video modalities', async () => {
    const out = path.join(root, `clip.${extensionFor('video/mp4')}`)
    const meta = await synthesizeMockMedia('t2v', out, { durationMs: 1000 })
    expect(meta.mimeType).toBe('video/mp4')
    const { stat } = await import('node:fs/promises')
    expect((await stat(out)).size).toBeGreaterThan(0)
  })

  it('falls back to placeholder bytes for text modalities', async () => {
    const out = path.join(root, 'script.bin')
    const meta = await synthesizeMockMedia('text', out)
    expect(meta.mimeType).toBe('text/plain')
  })
})

describe('representative frame extraction', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'studio-frame-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('seeks to the middle of the clip and asks for exactly one frame', () => {
    const args = frameArgs('/tmp/in.mp4', '/tmp/out.jpg', 6000)
    expect(args.slice(0, 7)).toEqual(['-y', '-v', 'error', '-ss', '3.000', '-i', '/tmp/in.mp4'])
    expect(args.slice(7)).toEqual(['-frames:v', '1', '-vf', "scale='min(1024,iw)':-2", '-q:v', '3', '/tmp/out.jpg'])
  })

  it('clamps a negative or missing duration to the first frame', () => {
    expect(frameArgs('in.mp4', 'out.jpg', 0)[4]).toBe('0.000')
    expect(frameArgs('in.mp4', 'out.jpg', -500)[4]).toBe('0.000')
  })

  it('writes a JPEG when given a real clip', async () => {
    const clip = path.join(root, 'clip.mp4')
    await synthesizeMockMedia('t2v', clip, { durationMs: 6000 })
    const frame = path.join(root, 'frame.jpg')
    await extractFrame(clip, frame, 6000)
    const bytes = await readFile(frame)
    expect(bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff')
    expect(bytes.byteLength).toBeGreaterThan(1000)
  })

  it('lands mid-clip rather than on the first frame', async () => {
    const clip = path.join(root, 'clip.mp4')
    await synthesizeMockMedia('t2v', clip, { durationMs: 6000 })
    const first = path.join(root, 'first.jpg')
    const middle = path.join(root, 'middle.jpg')
    await extractFrame(clip, first, 0)
    await extractFrame(clip, middle, 6000)
    expect(Buffer.compare(await readFile(first), await readFile(middle))).not.toBe(0)
  })

  it('probes the duration when the caller does not know it', async () => {
    const clip = path.join(root, 'clip.mp4')
    await synthesizeMockMedia('t2v', clip, { durationMs: 4000 })
    const frame = path.join(root, 'probed.jpg')
    await extractFrame(clip, frame)
    expect((await readFile(frame)).subarray(0, 3).toString('hex')).toBe('ffd8ff')
  })
})
