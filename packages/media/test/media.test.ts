import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiskStorage, buildObjectKey, extensionFor, synthesizeMockMedia } from '../src/index.js'

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
