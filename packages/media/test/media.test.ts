import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiskStorage, buildObjectKey, extensionFor, extractFrame, frameArgs, probeMediaMeta, renderTitleCard, run, synthesizeMockMedia, titleCardCapability } from '../src/index.js'

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

  it('opens a stored object as a stream carrying its size', async () => {
    const key = 'org-1/proj-1/ep-1/VIDEO/task-1/v1.mp4'
    await storage.put(key, new Uint8Array([9, 8, 7, 6]), 'video/mp4')
    const opened = await storage.open(key)
    expect(opened).not.toBeNull()
    expect(opened!.sizeBytes).toBe(4)
    const chunks: Buffer[] = []
    for await (const chunk of opened!.body) chunks.push(chunk as Buffer)
    expect([...Buffer.concat(chunks)]).toEqual([9, 8, 7, 6])
  })

  it('resolves null for an object that was never stored', async () => {
    expect(await storage.open('org-1/proj-1/ep-1/VIDEO/task-1/v9.mp4')).toBeNull()
  })

  it('rejects keys that escape the storage root', async () => {
    await expect(storage.put('../../etc/passwd', new Uint8Array([1]), 'text/plain')).rejects.toThrow(/escapes storage root/)
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

describe('measured media metadata', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'studio-probe-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads the frame size and duration the vendor never reported', async () => {
    const clip = path.join(root, 'clip.mp4')
    await synthesizeMockMedia('t2v', clip, { durationMs: 4000 })
    const meta = await probeMediaMeta(clip)
    expect(meta).not.toBeNull()
    expect(meta!.width).toBeGreaterThan(0)
    expect(meta!.height).toBeGreaterThan(0)
    expect(meta!.durationMs).toBeGreaterThan(3000)
    expect(meta!.durationMs).toBeLessThan(5000)
  })

  it('measures the picture, not the container, when the audio track outlives it', async () => {
    // 百炼成片实测:画面 97 帧@24fps=4.0417s、音轨 4.096s,容器时长取的是音轨。
    // 裁切按序列帧号走,报成 4.096 会让时间线多要一帧不存在的画面。
    const clip = path.join(root, 'mismatch.mp4')
    await run('ffmpeg', ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=128x128:rate=25',
      '-f', 'lavfi', '-i', 'sine=duration=3:frequency=440',
      '-c:v', 'libx264', '-c:a', 'aac', clip])
    const meta = await probeMediaMeta(clip)
    expect(meta!.durationMs).toBe(2000)
    expect(meta!.width).toBe(128)
  })

  it('returns null instead of throwing on bytes no demuxer can read', async () => {
    const junk = path.join(root, 'junk.mp4')
    await writeFile(junk, Buffer.from('this is not a media container'))
    expect(await probeMediaMeta(junk)).toBeNull()
    expect(await probeMediaMeta(path.join(root, 'missing.mp4'))).toBeNull()
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

const canDrawTitleCards = await titleCardCapability().then(capability => capability.canRender)

describe('title card fade', () => {
  // 缺 drawtext 或缺中文字体的机器画不出字卡：这一组在那两台机器上是「跳过」，不是通过。
  let cardDir = ''

  beforeEach(async () => {
    cardDir = await mkdtemp(path.join(os.tmpdir(), 'studio-title-card-'))
  })

  afterEach(async () => {
    await rm(cardDir, { recursive: true, force: true })
  })

  /**
   * 逐帧平均亮度（YAVG）：渐变是整帧灭到黑，只有量亮度才钉得住。
   * 阈值一律相对取值——yuv420p 是受限量程，全黑帧的 YAVG 约 16 而不是 0，写死 0 会在
   * 量程约定不同的 ffmpeg 构建上判假失败。
   */
  async function frameLuma(file: string): Promise<number[]> {
    // metadata=print 把逐帧读数打在 info 级别：带 -v error 时一个字节都不吐（本机实测
    // 0 行 vs 100 行），拿空数组比阈值等于把「没测到」读成「测过了」。
    const { stderr } = await run(
      'ffmpeg',
      ['-hide_banner', '-i', file, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'],
    )
    return [...stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map(match => Number.parseFloat(match[1]))
  }

  it.skipIf(!canDrawTitleCards)('fades in from black and back out so the card can join the next shot', async () => {
    const out = path.join(cardDir, 'card.mp4')
    await renderTitleCard({ text: '第七次死亡', outPath: out, durationMs: 4000, width: 720, height: 1280 })
    const luma = await frameLuma(out)
    expect(luma.length).toBeGreaterThanOrEqual(90)
    const floor = Math.min(...luma)
    const peak = Math.max(...luma)
    const span = peak - floor
    // 首尾灭到黑、中段满亮：恒定亮度的卡硬切进下一镜，等于在片子里拍了一下黑板。
    expect(span).toBeGreaterThan(10)
    expect(luma[0]).toBeLessThan(floor + span * 0.05)
    // fade out 收在时长末尾，最后一帧差一点点才到底，按量程成数放行而不是按绝对值。
    expect(luma[luma.length - 1]).toBeLessThan(floor + span * 0.2)
    expect(Math.max(...luma.slice(20, luma.length - 20))).toBeCloseTo(peak, 1)
    // 斜坡不是台阶：淡入段里必须有连续的逐帧抬升，否则「有 fade 参数」和「硬切」在
    // 首末帧读数上长得一样。
    expect(luma.filter((value, i) => i > 0 && i < 15 && value > luma[i - 1] + 0.5).length).toBeGreaterThanOrEqual(10)
  })

  it.skipIf(!canDrawTitleCards)('does not spend a short card entirely on the fade', async () => {
    const out = path.join(cardDir, 'short-card.mp4')
    await renderTitleCard({ text: '他记得每一次', outPath: out, durationMs: 2000, width: 720, height: 1280 })
    const luma = await frameLuma(out)
    const floor = Math.min(...luma)
    const peak = Math.max(...luma)
    const span = peak - floor
    // 一秒以内的卡不许整段都在渐变：淡的时长按时长收顶后，中间必须留下看清字的帧。
    expect(span).toBeGreaterThan(10)
    expect(luma.filter(value => value > peak - span * 0.05).length).toBeGreaterThanOrEqual(10)
  })
})
