import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { frameSignatureDistance, measureSceneCuts, probeFrameSignature, run } from '../src/index.js'

/**
 * SD-183/SD-184 的读数原语。素材全部是本地 ffmpeg 合成的：纯色段互拼就是台账里
 * 「镜内闪变」的最小等价物（#5：4.04 s 素材 7 次 scene-change），两张同色素材就是
 * #44-46 那种「同一画面反复入版」的最小等价物。判据方向与台账一致：跳变要数得出、
 * 同图要分得开、读不出必须是 null（unknown）而不是 0（假通过）。
 */

let workdir: string

beforeAll(async () => {
  workdir = await mkdtemp(path.join(os.tmpdir(), 'media-readings-'))
})

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true })
})

/** 纯色段——帧内零差异，正当内容里不该数出任何场景跳。 */
async function solid(file: string, color: string, seconds: number): Promise<void> {
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:duration=${seconds}:size=320x240:rate=15`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', file])
}

/** 逐段互拼：n 段首尾硬接就是 n-1 个镜内跳变。 */
async function splice(file: string, colors: string[], segmentSeconds: number): Promise<void> {
  const base = path.basename(file, '.mp4')
  const parts: string[] = []
  for (const [index, color] of colors.entries()) {
    const part = path.join(workdir, `${base}-seg${index}.mp4`)
    await solid(part, color, segmentSeconds)
    parts.push(part)
  }
  const list = path.join(workdir, `${base}-list.txt`)
  await writeFile(list, parts.map(part => `file '${part}'`).join('\n'))
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', file])
}

describe('measureSceneCuts — intra-shot flicker reading (SD-183)', () => {
  it('counts the hard cuts a spliced clip hides inside one "shot"', async () => {
    const flicker = path.join(workdir, 'flicker.mp4')
    await splice(flicker, ['red', 'blue', 'red', 'blue'], 0.5)
    const measured = await measureSceneCuts(flicker, 0.2)
    expect(measured).not.toBeNull()
    // 4 段互拼 = 3 个硬接点；台账口径（gt(scene,0.2)）必须全数出来。
    expect(measured!.cutCount).toBeGreaterThanOrEqual(3)
    expect(measured!.maxScore).not.toBeNull()
    expect(measured!.maxScore!).toBeGreaterThan(0.2)
  })

  it('reproduces the ledger case: seven sub-second flips inside one take', async () => {
    const seven = path.join(workdir, 'seven-cuts.mp4')
    await splice(seven, ['red', 'blue', 'red', 'blue', 'red', 'blue', 'red', 'blue'], 0.5)
    const measured = await measureSceneCuts(seven, 0.2)
    // #5 的缺陷档 = 4.04 s 素材 7 次跳变；这里 8 段 4 s 造出同一形状，读数不许低于它。
    expect(measured!.cutCount).toBeGreaterThanOrEqual(7)
  })

  it('reads zero inside a single-scene clip, and null when nothing can be decoded', async () => {
    const single = path.join(workdir, 'single.mp4')
    await solid(single, 'green', 2)
    const measured = await measureSceneCuts(single, 0.2)
    expect(measured).not.toBeNull()
    expect(measured!.cutCount).toBe(0)
    expect(measured!.maxScore).toBeNull()
    // 读不出与量到 0 是两个世界：坏文件必须 null（unknown），不许 0（假通过）。
    expect(await measureSceneCuts(path.join(workdir, 'does-not-exist.mp4'), 0.2)).toBeNull()
  })
})

describe('probeFrameSignature / frameSignatureDistance — neighbor duplicate (SD-184)', () => {
  it('the same picture scores ~0 and a different picture scores far above the duplicate threshold', async () => {
    const redA = path.join(workdir, 'red-a.mp4')
    const redB = path.join(workdir, 'red-b.mp4')
    const blue = path.join(workdir, 'blue.mp4')
    await solid(redA, 'red', 2)
    await solid(redB, 'red', 2)
    await solid(blue, 'blue', 2)
    const sigA = await probeFrameSignature(redA, workdir)
    const sigB = await probeFrameSignature(redB, workdir)
    const sigBlue = await probeFrameSignature(blue, workdir)
    expect(sigA).not.toBeNull()
    expect(sigB).not.toBeNull()
    expect(sigBlue).not.toBeNull()
    expect(sigA!.length).toBe(32 * 32)
    // #44-46 案档：同一画面反复入版 → 距离必须在重复阈 0.03 之下。
    expect(frameSignatureDistance(sigA!, sigB!)).toBeLessThanOrEqual(0.03)
    // 不同画面（实测不同镜最低也有 0.08）→ 必须被分出来，读数才有区分度（SD-081）。
    expect(frameSignatureDistance(sigA!, sigBlue!)!).toBeGreaterThan(0.03)
  })

  it('degrades to null, never to a fabricated distance', async () => {
    expect(await probeFrameSignature(path.join(workdir, 'missing.mp4'), workdir)).toBeNull()
    expect(frameSignatureDistance(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBeNull()
    expect(frameSignatureDistance(new Uint8Array(0), new Uint8Array(0))).toBeNull()
  })
})
