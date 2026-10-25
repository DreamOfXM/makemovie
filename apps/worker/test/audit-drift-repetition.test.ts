// SD-087/SD-088/SD-081：结构漂移读数与「复印件式 pass」的守卫用例。
// 漂移这条轴 2026-10-25 实测不可分（见 visual-audit.ts 的实测分布），所以它只落库不判级；
// 真正改判定的是 SD-081 的区分度纪律：不同画面得到逐字相同的回答就不是判断过的证据。
// 两层都要见到：单元层钉判定通道，链路层钉 qualityCheck.report 里确实落了这两个读数。
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { startTestEnv } from './env.js'
import { runTask } from '../src/run-task.js'
import type { QcVerdict } from '../src/qc.js'
import {
  applyAuditRepetition,
  auditAnswerFingerprint,
  measureClipStructureDrift,
  STRUCTURE_DRIFT_SAMPLE_FRACTIONS,
} from '../src/visual-audit.js'

const execFileAsync = promisify(execFile)

async function solid(file: string, color: string, seconds: number): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:size=320x240:rate=15:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    file,
  ], { timeout: 60_000 })
}

/** 前一半一个画面、后一半另一个画面：SD-087 那种「中途变了」的最小离线形状。 */
async function halfAndHalf(file: string, first: string, second: string): Promise<void> {
  const a = `${file}.a.mp4`
  const b = `${file}.b.mp4`
  await solid(a, first, 2)
  await solid(b, second, 2)
  const list = `${file}.list.txt`
  await writeFile(list, `file '${a}'\nfile '${b}'\n`)
  await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', file], { timeout: 60_000 })
}

// 台账 SD-081 的原文形状：三条片子逐字相同的 0.92 + 三个逐帧分 + 零发现。
const SD081_ANSWER = {
  kind: 'visual-audit' as const,
  decision: 'pass' as const,
  score: 0.92,
  findings: [],
  frameScores: [
    { position: 0.1, score: 0.95 },
    { position: 0.5, score: 0.93 },
    { position: 0.9, score: 0.88 },
  ],
}

describe('结构漂移读数只摆数（SD-087/SD-088 实测不可分）', () => {
  it('同一画面量出 ~0，中途换画面量出大距离，坏文件量不出（measured:false ≠ 干净）', async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'worker-drift-'))
    try {
      const still = path.join(workdir, 'still.mp4')
      await solid(still, 'gray', 4)
      const stillReading = await measureClipStructureDrift({ videoFile: still, workdir })
      expect(stillReading.measured).toBe(true)
      expect(stillReading.sampleSeconds).toHaveLength(STRUCTURE_DRIFT_SAMPLE_FRACTIONS.length)
      expect(stillReading.earlyLateDistance!).toBeLessThan(0.02)
      expect(stillReading.firstMidDistance!).toBeLessThan(0.02)
      expect(stillReading.maxStepDistance!).toBeLessThan(0.02)

      const changed = path.join(workdir, 'changed.mp4')
      await halfAndHalf(changed, 'black', 'white')
      const changedReading = await measureClipStructureDrift({ videoFile: changed, workdir })
      expect(changedReading.measured).toBe(true)
      // 早 15% 还在黑场、晚 85% 已是白场：这条轴看得见「中途变了」，
      // 看不见的是「变的是衣服还是机位」——那正是它不判级的理由。
      expect(changedReading.earlyLateDistance!).toBeGreaterThan(0.5)
      expect(changedReading.maxStepDistance!).toBeGreaterThan(0.5)

      const broken = await measureClipStructureDrift({ videoFile: path.join(workdir, 'missing.mp4'), workdir })
      expect(broken).toEqual({ measured: false, earlyLateDistance: null, firstMidDistance: null, maxStepDistance: null, sampleSeconds: [] })
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  }, 180_000)
})

describe('复印件式 pass 判成未判定（SD-081）', () => {
  const PASS: Extract<QcVerdict, { decision: 'pass' }> = SD081_ANSWER
  const REPEATED = { matchedArtifactId: 'art-prev', pictureDistance: 0.181, status: 'repeated' as const }

  it('逐帧分与发现全等才算同一份答案，任何一项不同就不算', () => {
    expect(auditAnswerFingerprint(PASS)).toBe(auditAnswerFingerprint({ ...SD081_ANSWER }))
    expect(auditAnswerFingerprint(PASS)).not.toBe(auditAnswerFingerprint({ ...SD081_ANSWER, score: 0.91 }))
    expect(auditAnswerFingerprint(PASS)).not.toBe(auditAnswerFingerprint({ ...SD081_ANSWER, frameScores: SD081_ANSWER.frameScores.map((frame, index) => ({ ...frame, score: index === 1 ? 0.9 : frame.score })) }))
    expect(auditAnswerFingerprint(PASS)).not.toBe(auditAnswerFingerprint({ ...SD081_ANSWER, findings: [{ dimension: 'continuity', severity: 'warning', message: '门把增减', evidenceTimeSeconds: 2.048 }] }))
    // 没答逐帧分的结论（fake-qc/hash）不参与这条轴：拿它判重复等于把没发生过的事当发生过。
    expect(auditAnswerFingerprint({ score: 1, findings: [] })).not.toBe(auditAnswerFingerprint(PASS))
  })

  it('pass + repeated → unjudged；其余三态与非 pass 判定一律原样交回', () => {
    const flipped = applyAuditRepetition(PASS, REPEATED)
    expect(flipped.decision).toBe('unjudged')
    if (flipped.decision !== 'unjudged') throw new Error('复印件 pass 必须判成未判定')
    expect(flipped.reasons.join()).toContain('SD-081')
    expect(flipped.reasons.join()).toContain('art-prev')
    expect(flipped.reasons.join()).toContain('0.181')

    for (const status of ['distinct', 'unknown', 'no-baseline'] as const) {
      expect(applyAuditRepetition(PASS, { ...REPEATED, status })).toBe(PASS)
    }
    const rework: Extract<QcVerdict, { decision: 'rework' }> = { kind: 'visual-audit', decision: 'rework', score: 0.4, reasons: ['模型判退'] }
    expect(applyAuditRepetition(rework, REPEATED)).toBe(rework)
    const unjudged: Extract<QcVerdict, { decision: 'unjudged' }> = { kind: 'visual-audit', decision: 'unjudged', reasons: ['审核不可用'] }
    expect(applyAuditRepetition(unjudged, REPEATED)).toBe(unjudged)
  })
})

// 链路层：同一条答案 + 两条不同画面 → 未判定；同一条答案 + 同一画面 → 合法通过。
// 台账指控的是「屏上只有一个 0.92」，所以断言全部落在 qualityCheck.report 与任务终态上。
describe('复印件判成未判定确实接进 VIDEO 链路（SD-081 链路）', () => {
  it('上一条画面不同却逐字同分 → 未判定；上一条本就同一画面 → 仍然通过', async () => {
    const env = await startTestEnv()
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'worker-repeat-'))
    try {
      const black = path.join(workdir, 'black.mp4')
      await solid(black, 'black', 2)
      const blackBytes = new Uint8Array(await readFile(black))
      const stubChecker = { async check() { return { ...SD081_ANSWER } } }

      // 案犯形状：#3 v2 与 #2 逐字相同，而两条片子不是同一画面。
      const suspect = await env.seed({ storyboards: 2 })
      const [suspectShot] = suspect.storyboardIds as [string]
      const priorDifferent = await env.attachSucceededMedia(suspect, { stage: 'VIDEO', modality: 't2v', storyboardId: suspect.storyboardIds[1]!, version: 1, source: { bytes: blackBytes, mimeType: 'video/mp4' } })
      await env.db.qualityCheck.create({
        data: { status: 'APPROVED', kind: 'visual-audit', score: SD081_ANSWER.score, report: JSON.stringify({ kind: 'visual-audit', threshold: 0.7, mode: 'model', reasons: [], findings: [], frameScores: SD081_ANSWER.frameScores }), artifactId: priorDifferent.artifactId },
      })
      await env.db.generationTask.update({ where: { id: suspect.taskId }, data: { storyboardId: suspectShot } })
      await runTask(env.runPayload(suspect), env.deps({ qcMode: 'pass', pollIntervalMs: 10, checker: stubChecker }))
      const suspectTask = await env.db.generationTask.findUniqueOrThrow({ where: { id: suspect.taskId } })
      const suspectCheck = await env.db.qualityCheck.findFirstOrThrow({ where: { artifact: { taskId: suspect.taskId } }, orderBy: { id: 'desc' } })
      const suspectReport = JSON.parse(suspectCheck.report) as {
        reasons?: string[]
        frameScores?: Array<{ position: number; score: number }>
        structureDrift?: { measured: boolean; earlyLateDistance: number | null; sampleSeconds: number[] }
        auditRepetition?: { status: string; matchedArtifactId: string | null; pictureDistance: number | null }
      }
      expect(suspectTask.status).toBe('FAILED')
      expect(suspectCheck.status).toBe('NEEDS_REVIEW')
      expect(suspectCheck.score).toBeNull()
      expect(suspectReport.auditRepetition?.status).toBe('repeated')
      expect(suspectReport.auditRepetition?.matchedArtifactId).toBe(priorDifferent.artifactId)
      expect(suspectReport.auditRepetition?.pictureDistance!).toBeGreaterThan(0.03)
      expect(suspectReport.reasons?.join()).toContain('SD-081')
      // 判成未判定也要把那份答案留下：否则下一条片子没有可比对象，缺陷链会在中间断掉。
      expect(suspectReport.frameScores).toHaveLength(3)
      // SD-087/SD-088：屏上那个数必须是内容-derived——漂移距离随片落库并带着可复算的时刻。
      expect(suspectReport.structureDrift?.measured).toBe(true)
      expect(typeof suspectReport.structureDrift?.earlyLateDistance).toBe('number')
      expect(suspectReport.structureDrift?.sampleSeconds).toHaveLength(STRUCTURE_DRIFT_SAMPLE_FRACTIONS.length)

      // 合法形状：同一个镜头重抽两版，画面本来就几乎相同，同分不是「没看图」。
      const legit = await env.seed({ storyboards: 2 })
      const [legitShot] = legit.storyboardIds as [string]
      const priorSame = await env.attachSucceededVideo(legit, legit.storyboardIds[1]!, 1, { durationMs: 1000 })
      await env.db.qualityCheck.create({
        data: { status: 'APPROVED', kind: 'visual-audit', score: SD081_ANSWER.score, report: JSON.stringify({ kind: 'visual-audit', threshold: 0.7, mode: 'model', reasons: [], findings: [], frameScores: SD081_ANSWER.frameScores }), artifactId: priorSame.artifactId },
      })
      await env.db.generationTask.update({ where: { id: legit.taskId }, data: { storyboardId: legitShot } })
      await runTask(env.runPayload(legit), env.deps({ qcMode: 'pass', pollIntervalMs: 10, checker: stubChecker }))
      const legitTask = await env.db.generationTask.findUniqueOrThrow({ where: { id: legit.taskId } })
      const legitCheck = await env.db.qualityCheck.findFirstOrThrow({ where: { artifact: { taskId: legit.taskId } }, orderBy: { id: 'desc' } })
      const legitReport = JSON.parse(legitCheck.report) as { auditRepetition?: { status: string; pictureDistance: number | null } }
      expect(legitReport.auditRepetition?.status).toBe('distinct')
      expect(legitReport.auditRepetition?.pictureDistance!).toBeLessThanOrEqual(0.03)
      expect(legitTask.status).toBe('SUCCEEDED')
      expect(legitCheck.status).toBe('APPROVED')
    } finally {
      await rm(workdir, { recursive: true, force: true })
      await env.stop()
    }
  }, 300_000)
})
