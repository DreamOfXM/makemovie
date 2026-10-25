import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv } from './env.js'
import { alignClipFrames, composeEpisode } from '../src/compose.js'
import { probeDuration, probeVideoFrames } from '@studio/media'
import { sequenceFrameCount, type ClipRange } from '@studio/domain'

const execFileAsync = promisify(execFile)

/** 编辑文档里的一条剪辑：契约字段（帧范围）+ 这一版序列落库要的归属字段。 */
type EditClip = ClipRange & { clipId: string; storyboardId: string; artifactId: string }

/**
 * 厂商交付的常态形状（本集实测就是它）：画面 101 帧@25fps=4.04s，音轨把容器撑到 4.2s。
 * 编辑文档是按容器毫秒换算帧数的，于是每镜都比画面多要 1 帧——`trim` 不报错，只交回
 * 它交得出的那些帧，母带比文档短、字幕按文档排，62 刀累计就是台账里那段漂移。
 */
async function audioTailClip(file: string, frames: number, fps: number, audioSeconds: number): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${(frames / fps).toFixed(6)}:size=320x240:rate=${fps}`,
    '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=44100:duration=${audioSeconds}`,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    file,
  ], { timeout: 60_000 })
}

/** SRT 的毫秒读数：字幕落位是不是画面的格子，只能从这张表里读。 */
function parseSrtCues(srt: string): Array<{ fromMs: number; toMs: number; text: string }> {
  return srt.trim().split(/\n\s*\n/).map(block => {
    const lines = block.split('\n')
    const [start, end] = lines[1]!.split('-->')
    const toMs = (value: string): number => {
      const [clock, millis] = value.trim().split(',')
      const [h, m, s] = clock!.split(':').map(Number)
      return ((h! * 60 + m!) * 60 + s!) * 1000 + Number(millis ?? 0)
    }
    return { fromMs: toMs(start!), toMs: toMs(end!), text: lines.slice(2).join(' ').trim() }
  })
}

describe('per-shot frame count lands on the edit request (SD-182)', () => {
  let workdir: string

  beforeAll(async () => {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'worker-framecount-'))
  })

  afterAll(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('delivers the requested frames when the source is one frame short, and cuts when it is long', async () => {
    const source = path.join(workdir, 'unit.mp4')
    await audioTailClip(source, 101, 25, 4.2)
    expect(await probeVideoFrames(source)).toBe(101)

    // 少 1 帧 → 末帧定格补到请求格子（母带长度回到编辑文档，字幕才有正确的格子）。
    const padded = await alignClipFrames(source, 102, 25, path.join(workdir, 'padded.mp4'), 'unit-short')
    expect(await probeVideoFrames(padded.file)).toBe(102)

    // 多 1 帧 → 裁到请求（剪辑意图是真相，画面不许超出文档）。
    const cut = await alignClipFrames(source, 100, 25, path.join(workdir, 'cut.mp4'), 'unit-long')
    expect(await probeVideoFrames(cut.file)).toBe(100)

    // 正好 → 一次编码都不许多花。
    const exact = await alignClipFrames(source, 101, 25, path.join(workdir, 'exact.mp4'), 'unit-exact')
    expect(exact.file).toBe(source)

    // 缺得多（快照过期/素材换版）不许拿定格糊过去：当场阻断，让人重裁。
    await expect(alignClipFrames(source, 105, 25, path.join(workdir, 'beyond.mp4'), 'unit-beyond'))
      .rejects.toThrow(/asks for 105 frames but the clip holds 101/)
  })

  it('renders a master whose measured frame count equals the edit decision list', async () => {
    const env = await startTestEnv()
    try {
      const seed = await env.seed({ storyboards: 2 })
      const [shotA, shotB] = seed.storyboardIds
      const clip = path.join(workdir, 'vendor.mp4')
      await audioTailClip(clip, 101, 25, 4.2)
      const bytes = new Uint8Array(await readFile(clip))
      const source = { bytes, mimeType: 'video/mp4' }
      const videoA = await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 'i2v', storyboardId: shotA!, version: 1, source })
      const videoB = await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 'i2v', storyboardId: shotB!, version: 1, source })

      // 字幕要有，但别拖上配音链：只有 subtitleText、dialogue 留空。
      await env.db.storyboard.update({ where: { id: shotA! }, data: { dialogue: '', subtitleText: '第一句', audioSource: 'NATIVE' } })
      await env.db.storyboard.update({ where: { id: shotB! }, data: { dialogue: '', subtitleText: '第二句', audioSource: 'NATIVE' } })

      // A 要 102 帧（素材只有 101——容器换算多要的那 1 帧），B 要 100 帧（素材 101，裁 1）。
      const ranges: EditClip[] = [
        { clipId: 'clip-a', storyboardId: shotA!, artifactId: videoA.artifactId, sourceInFrame: 0, sourceOutFrame: 102 },
        { clipId: 'clip-b', storyboardId: shotB!, artifactId: videoB.artifactId, sourceInFrame: 0, sourceOutFrame: 100 },
      ]
      await env.db.episodeEdit.create({
        data: {
          episodeId: seed.episodeId, organizationId: seed.organizationId, headRevision: 1,
          revisions: { create: { revision: 1, fpsNum: 25, fpsDen: 1, clips: JSON.stringify(ranges), tracks: '[]', outputSpec: '{}', fingerprint: 'sd182', author: 'test' } },
        },
      })
      const composition = await env.db.composition.create({ data: { episodeId: seed.episodeId, status: 'READY', manifest: JSON.stringify({ storyboardIds: seed.storyboardIds }) } })
      const deps = env.deps()
      await composeEpisode(env.composePayload(composition.id, seed), deps)

      const done = await env.db.composition.findUniqueOrThrow({ where: { id: composition.id } })
      expect(done.status).toBe('COMPLETED')
      expect(done.errorSnapshot).toBeNull()

      const requested = sequenceFrameCount(ranges)
      expect(requested).toBe(202)

      const masterFile = path.join(workdir, 'delivered.mp4')
      await writeFile(masterFile, await env.deps().storage.read((await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: done.artifactId! } })).objectKey))
      const delivered = await probeVideoFrames(masterFile)
      if (delivered === null) throw new Error('the delivered master must be probeable for frames')
      // 钉的是实测帧数：母带必须正好等于编辑文档要的帧数。
      expect(delivered).toBe(requested)
      // 落库的实测时长必须是画面帧数换算的，不是容器（容器多的是两条音轨尾巴）。
      expect(done.durationMs).toBe(Math.round(delivered * 1000 / 25))
      expect(await probeDuration(masterFile)).toBeGreaterThan(done.durationMs!)

      // 字幕表与母带同一把尺：第二句的起点就是第一镜交回的那 102 帧之后。
      const cues = parseSrtCues(new TextDecoder().decode(await env.deps().storage.read((await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: done.subtitleArtifactId! } })).objectKey)))
      expect(cues.map(cue => cue.text)).toEqual(['第一句', '第二句'])
      expect(cues[0]!.fromMs).toBe(0)
      expect(cues[0]!.toMs).toBe(4080)
      expect(cues[1]!.fromMs).toBe(4080)
      expect(cues[1]!.toMs).toBe(8080)
      for (const cue of cues) {
        // 每个锚点都落在整帧上，否则烧上去的字就不是压在这格画面上。
        expect(cue.fromMs * 25 % 1000).toBe(0)
        expect(cue.toMs * 25 % 1000).toBe(0)
      }
    } finally {
      await env.stop()
    }
  })
})
