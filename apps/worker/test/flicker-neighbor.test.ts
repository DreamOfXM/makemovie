// SD-183/SD-184：两条质量读数的接线用例。
// 单元层钉判定通道（读数怎么进 pass/rework/findings），实测层钉真实 ffmpeg 读数，
// 最后用完整 worker 链路证明读数确实落到 qualityCheck.report 与 review board 的
// finding 行——台账指控的是「生成了却什么都没测出来」，这里就要在落库处见到数。
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { startTestEnv } from './env.js'
import { runTask } from '../src/run-task.js'
import type { QcVerdict } from '../src/qc.js'
import {
  applyIntraShotFlicker,
  flickerStatusOf,
  measureIntraShotFlicker,
  FLICKER_REWORK_CUT_COUNT,
  FLICKER_WARNING_CUT_COUNT,
  type IntraShotFlickerReading,
} from '../src/visual-audit.js'

const execFileAsync = promisify(execFile)

// 与 packages/media/test/quality-readings.test.ts 同一把尺：把 N 种纯色各 0.5 s
// 拼成一条素材——单看是一条「镜」，画面里却藏着 N-1 个硬切（台账 #5 的坏法）。
async function splice(file: string, colors: string[], segmentSeconds: number): Promise<void> {
  const segs: string[] = []
  for (const [index, color] of colors.entries()) {
    const seg = `${file}.seg${index}.mp4`
    segs.push(seg)
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `color=c=${color}:size=320x240:rate=15:duration=${segmentSeconds}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      seg,
    ], { timeout: 60_000 })
  }
  const list = `${file}.list.txt`
  await writeFile(list, segs.map(seg => `file '${seg}'`).join('\n'))
  await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', file], { timeout: 60_000 })
}

const PASS: Extract<QcVerdict, { decision: 'pass' }> = { kind: 'visual-audit', decision: 'pass', score: 0.9, findings: [], frameScores: [] }
const REWORK: Extract<QcVerdict, { decision: 'rework' }> = { kind: 'visual-audit', decision: 'rework', score: 0.4, reasons: ['模型判退'] }
const UNJUDGED: Extract<QcVerdict, { decision: 'unjudged' }> = { kind: 'visual-audit', decision: 'unjudged', reasons: ['审核不可用'] }

function reading(cutCount: number | null, measured = cutCount !== null): IntraShotFlickerReading {
  return { measured, sceneCutCount: cutCount, maxSceneScore: cutCount === null ? null : 1 }
}

describe('镜内闪变接进判定通道（SD-183）', () => {
  it('pass + 台账缺陷档（7 次跳变）→ 强制 rework，理由与 finding 都带读数', () => {
    const verdict = applyIntraShotFlicker(PASS, reading(FLICKER_REWORK_CUT_COUNT))
    expect(verdict.decision).toBe('rework')
    if (verdict.decision !== 'rework') return
    expect(verdict.reasons.join()).toContain('SD-183')
    expect(verdict.reasons.join()).toContain(String(FLICKER_REWORK_CUT_COUNT))
    const finding = verdict.findings?.[0]
    expect(finding?.dimension).toBe('continuity')
    expect(finding?.evidenceTimeSeconds).toBeNull()
  })

  it('warn 档（2..6 次）只追加发现，不改判定——实测被接受素材上限是 1 次', () => {
    const verdict = applyIntraShotFlicker(PASS, reading(FLICKER_WARNING_CUT_COUNT))
    expect(verdict.decision).toBe('pass')
    if (verdict.decision === 'unjudged') throw new Error('warn 档读数不许把已发生的审核打成「没审」')
    expect(verdict.findings?.[0]?.message).toContain('SD-183')
    expect(flickerStatusOf(reading(FLICKER_WARNING_CUT_COUNT))).toBe('warning')
    expect(flickerStatusOf(reading(FLICKER_REWORK_CUT_COUNT - 1))).toBe('warning')
  })

  it('测不出与原判定是 pass/rework/unjudged 时都不许被读数翻案', () => {
    // unknown（measured:false）绝不制造假阳性，也绝不伪装成「已测干净」。
    expect(applyIntraShotFlicker(PASS, reading(null))).toBe(PASS)
    expect(flickerStatusOf(reading(null, false))).toBe('unknown')
    expect(flickerStatusOf(reading(0))).toBe('clean')
    expect(applyIntraShotFlicker(PASS, reading(0))).toBe(PASS)
    // 审核本来没发生：读数解释不了为什么，不许替它编结论。
    expect(applyIntraShotFlicker(UNJUDGED, reading(7))).toBe(UNJUDGED)
    // 已经 rework 的：合并理由，不丢原判决原因，也不换判决。
    const merged = applyIntraShotFlicker(REWORK, reading(7))
    expect(merged.decision).toBe('rework')
    if (merged.decision !== 'rework') return
    expect(merged.reasons[0]).toBe('模型判退')
    expect(merged.reasons.join()).toContain('SD-183')
  })

  it('真素材实测：8 段硬切读出 ≥7 次并判 rework；单场景读出 0 判 clean；坏文件判 unknown', async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'worker-flicker-'))
    try {
      const spliced = path.join(workdir, 'eight-cuts.mp4')
      await splice(spliced, ['red', 'blue', 'red', 'blue', 'red', 'blue', 'red', 'blue'], 0.5)
      const flicker = await measureIntraShotFlicker(spliced)
      expect(flicker.measured).toBe(true)
      expect(flicker.sceneCutCount).toBeGreaterThanOrEqual(7)
      expect(flicker.maxSceneScore).not.toBeNull()
      expect(flickerStatusOf(flicker)).toBe('rework')
      // 判定通道同样吃实测读数：pass 素材被实测打回。
      expect(applyIntraShotFlicker(PASS, flicker).decision).toBe('rework')

      const clean = path.join(workdir, 'single-scene.mp4')
      await execFileAsync('ffmpeg', [
        '-y', '-v', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        clean,
      ], { timeout: 60_000 })
      const cleanReading = await measureIntraShotFlicker(clean)
      expect(cleanReading.measured).toBe(true)
      expect(cleanReading.sceneCutCount).toBe(0)
      expect(flickerStatusOf(cleanReading)).toBe('clean')

      const broken = await measureIntraShotFlicker(path.join(workdir, 'missing.mp4'))
      expect(broken).toEqual({ measured: false, sceneCutCount: null, maxSceneScore: null })
      expect(flickerStatusOf(broken)).toBe('unknown')
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  })
})

// 完整链路：t2v 交付镜（mock t2v 是确定性 testsrc）+ 前邻两镜同画面落库 →
// 闪变读数随 report 落库、邻镜三连重复进 review board finding 通道。
describe('读数随任务落库并到达判定通道（SD-183/SD-184 链路）', () => {
  it('邻镜重复三连在 runTask 后进入 qualityCheck.report 与 qualityFinding', async () => {
    const env = await startTestEnv()
    try {
      const seed = await env.seed({ storyboards: 3 })
      const [shot1, shot2, shot3] = seed.storyboardIds as [string, string, string]
      // 前两镜的「已交付」素材：默认 mock t2v，与第三镜将要生成的是同一支确定性
      // testsrc——中段灰帧逐像素相同，正是 #44/#45/#46 三连重复的离线复刻。
      await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 't2v', storyboardId: shot1, version: 1 })
      await env.attachSucceededMedia(seed, { stage: 'VIDEO', modality: 't2v', storyboardId: shot2, version: 1 })
      await env.db.generationTask.update({ where: { id: seed.taskId }, data: { storyboardId: shot3 } })

      await runTask(env.runPayload(seed), env.deps({ qcMode: 'pass', pollIntervalMs: 10 }))
      const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
      expect(task.status).toBe('SUCCEEDED')

      const check = await env.db.qualityCheck.findFirstOrThrow({ where: { artifact: { taskId: seed.taskId } }, orderBy: { id: 'desc' } })
      const report = JSON.parse(check.report) as {
        flicker?: IntraShotFlickerReading
        neighborDuplicate?: { status: string; maxRunLength: number; windowShotNumbers: number[]; pairDistances: Array<number | null> }
      }
      // SD-183：flicker 必须「测出来了」——unknown 落在这一步就是没接线。
      expect(report.flicker?.measured).toBe(true)
      expect(report.flicker?.sceneCutCount).toBe(0)
      // SD-184：三镜窗口、两对邻距都读得出，且 3 连重复报警。
      expect(report.neighborDuplicate?.windowShotNumbers).toEqual([1, 2, 3])
      expect(report.neighborDuplicate?.pairDistances).toHaveLength(2)
      expect(report.neighborDuplicate?.pairDistances[0]).toBeLessThanOrEqual(0.03)
      expect(report.neighborDuplicate?.status).toBe('warning')
      expect(report.neighborDuplicate?.maxRunLength).toBe(3)

      // warning 走既有 finding 通道进 review board；不改 pass 判定（重抽治不了选版重复）。
      const finding = await env.db.qualityFinding.findFirstOrThrow({
        where: { compositionId: `artifact:${(await env.db.mediaArtifact.findFirstOrThrow({ where: { taskId: seed.taskId }, orderBy: { id: 'desc' } })).id}`, findingKey: 'neighbor-duplicate' },
      })
      expect(finding.message).toContain('SD-184')
      expect(finding.message).toContain('13.00 s')
      expect(finding.dimension).toBe('continuity')
      expect(finding.severity).toBe('warning')
      expect(finding.storyboardId).toBe(shot3)
      expect(check.status).toBe('APPROVED')
    } finally {
      await env.stop()
    }
  }, 180_000)
})
