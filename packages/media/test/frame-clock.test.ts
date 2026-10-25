import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FfmpegComposer, planMasterCutsForClips, probeDuration, probePictureDuration, probeVideoFrames, run } from '../src/index.js'

/**
 * SD-182 的尺子：画面时钟 ≠ 容器时钟。
 * mp4 的 format=duration 由最长的那条流决定，音轨收尾比画面晚几十毫秒是厂商常态
 * （本集实测：画面 101 帧@25fps=4.04s，容器 4.2s）。母带时间线、字幕落位、
 * Composition.durationMs 只要按容器排，每一镜就凭空多出不到一帧的「影子时间」，
 * 几十镜累加起来字幕越拖越远，母带长度也和编辑文档对不上。
 */
async function tailClip(file: string, frames: number, fps: number, audioSeconds: number): Promise<void> {
  const picture = (frames / fps).toFixed(6)
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${picture}:size=320x240:rate=${fps}`,
    '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=44100:duration=${audioSeconds}`,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    file,
  ])
}

describe('picture clock vs container clock (SD-182)', () => {
  let workdir: string
  let composer: FfmpegComposer

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'media-frameclock-'))
    composer = new FfmpegComposer()
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('measures the picture frames, not the audio tail', async () => {
    const clip = path.join(workdir, 'tail.mp4')
    await tailClip(clip, 101, 25, 4.2)

    // 容器确实带尾巴——这就是旧口径读到的数（4200ms = 105 帧）。
    expect(await probeDuration(clip)).toBe(4200)
    // 画面只有 101 帧 = 4040ms：交付帧数与画面时长都必须落在这把尺上。
    expect(await probeVideoFrames(clip)).toBe(101)
    expect(await probePictureDuration(clip)).toBe(4040)
  })

  it('plans the master timeline on measured frames so subtitle anchors land on picture', async () => {
    const a = path.join(workdir, 'a.mp4')
    const b = path.join(workdir, 'b.mp4')
    await tailClip(a, 101, 25, 4.2)
    await tailClip(b, 101, 25, 4.2)

    const plan = await planMasterCutsForClips([a, b], [{ transition: 'cut', transitionMs: 0 }, null])

    // 101 帧 @25fps = 4040ms。按容器排会得到 4200ms，第二镜的字幕就凭空晚 160ms，
    // 62 刀累计正是台账里那 2.5 秒漂移的量级。
    expect(plan.fps).toBe(25)
    expect(plan.clipMs).toEqual([4040, 4040])
    expect(plan.shotStartMs).toEqual([0, 4040])
    expect(plan.totalMs).toBe(8080)
    // 每个字幕锚点都必须落在整帧上——毫秒表与帧号不许各说各话。
    for (const [index, startMs] of plan.shotStartMs.entries()) {
      expect(startMs * plan.fps / 1000 % 1).toBeCloseTo(0, 6)
      expect(plan.clipMs[index]! * plan.fps / 1000 % 1).toBeCloseTo(0, 6)
    }
  })

  it('reports the delivered master by its picture duration', async () => {
    const a = path.join(workdir, 'a.mp4')
    const b = path.join(workdir, 'b.mp4')
    await tailClip(a, 101, 25, 4.2)
    await tailClip(b, 101, 25, 4.2)
    const output = path.join(workdir, 'master.mp4')

    const composed = await composer.compose({ clips: [a, b] }, output)

    expect(await probeVideoFrames(output)).toBe(202)
    expect(composed.durationMs).toBe(8080)
    // 交付文件的容器仍然带着两条音轨的尾巴——正说明「实测时长」必须问画面。
    expect(await probeDuration(output)).toBeGreaterThan(composed.durationMs)
  })

  it('does not lose a frame at the cut when the previous shot has an audio tail', async () => {
    // 复刻 worker 实测到的丢帧形状：上一镜音轨长过画面，concat demuxer 按「上一段结束
    // 时间」续 PTS，下一镜首帧被当成已经排过 → copy 拼接交回 201 帧（应为 102+100）。
    const a = path.join(workdir, 'a.mp4')
    const b = path.join(workdir, 'b.mp4')
    await tailClip(a, 102, 25, 4.2)
    await tailClip(b, 100, 25, 4.2)
    const output = path.join(workdir, 'master.mp4')

    await composer.compose({ clips: [a, b] }, output)

    expect(await probeVideoFrames(a)).toBe(102)
    expect(await probeVideoFrames(b)).toBe(100)
    // 帧守恒：母带必须等于逐镜帧数之和，字幕表才可能压在这一格的画面上。
    expect(await probeVideoFrames(output)).toBe(202)
  })
})
