import { describe, expect, it } from 'vitest'
import { runTechnicalCheck } from '../src/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

describe('technical quality check (US-031)', () => {
  it('passes a valid video with matching dimensions and duration', async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'qc-ok-'))
    try {
      const file = path.join(workdir, 'ok.mp4')
      await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25', '-pix_fmt', 'yuv420p', file])
      const result = await runTechnicalCheck(file, { expectedWidth: 320, expectedDurationMs: 3000 })
      expect(result.passed).toBe(true)
      expect(result.findings.filter(f => f.severity === 'blocking')).toHaveLength(0)
    } finally { await rm(workdir, { recursive: true, force: true }) }
  }, 30_000)

  it('blocks on unreadable/corrupted files', async () => {
    const missing = await runTechnicalCheck('/nonexistent/file.mp4')
    expect(missing.passed).toBe(false)
    expect(missing.findings[0]!.id).toBe('file_unreadable')

    const workdir = await mkdtemp(path.join(os.tmpdir(), 'qc-bad-'))
    try {
      const garbage = path.join(workdir, 'garbage.mp4')
      await (await import('node:fs/promises')).writeFile(garbage, 'not a video file')
      const corrupt = await runTechnicalCheck(garbage)
      expect(corrupt.passed).toBe(false)
      expect(corrupt.findings.some(f => f.id === 'probe_failed' || f.id === 'no_video_stream')).toBe(true)
    } finally { await rm(workdir, { recursive: true, force: true }) }
  }, 30_000)

  it('reports dimension and duration mismatches as warnings, not blocking', async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'qc-warn-'))
    try {
      const file = path.join(workdir, 'warn.mp4')
      await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=640x480:rate=25', '-pix_fmt', 'yuv420p', file])
      const result = await runTechnicalCheck(file, { expectedWidth: 320, expectedDurationMs: 3000 })
      expect(result.findings.filter(f => f.severity === 'blocking'), JSON.stringify(result.findings)).toHaveLength(0)
      expect(result.findings.some(f => f.id === 'dimension_mismatch' && f.severity === 'warning')).toBe(true)
      expect(result.findings.some(f => f.id === 'duration_mismatch' && f.severity === 'warning')).toBe(true)
    } finally { await rm(workdir, { recursive: true, force: true }) }
  }, 30_000)

  it('detects suspected black frames as warnings with timestamps', async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'qc-black-'))
    try {
      const file = path.join(workdir, 'black.mp4')
      // 造一段 2 秒黑屏 + 2 秒测试图。
      await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:size=320x240:duration=2:rate=25', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=25', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-pix_fmt', 'yuv420p', file])
      const result = await runTechnicalCheck(file)
      expect(result.passed).toBe(true) // 黑帧是疑点,不阻塞
      const blackFinding = result.findings.find(f => f.id.startsWith('black_frame_'))
      expect(blackFinding).toBeDefined()
      expect(blackFinding!.severity).toBe('warning')
      expect(blackFinding!.evidenceTimeSeconds).not.toBeNull()
    } finally { await rm(workdir, { recursive: true, force: true }) }
  }, 30_000)
})

import { extractMultiPointFrames } from '../src/index.js'

describe('multi-point visual audit (US-032)', () => {
  it('extracts frames at 10%/50%/90% with timestamps, deduplicates positions', async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'mp-audit-'))
    try {
      const file = path.join(workdir, 'source.mp4')
      await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=10:size=320x240:rate=25', '-pix_fmt', 'yuv420p', file])
      const result = await extractMultiPointFrames({ artifactPath: file, workdir: `${workdir}/frames`, positions: [0.1, 0.5, 0.9, 0.5] })
      // 0.5 重复出现只抽一次。
      expect(result.frames).toHaveLength(3)
      expect(result.failedPositions).toHaveLength(0)
      expect(result.frames[0]!.position).toBe(0.1)
      expect(result.frames[0]!.timestampSeconds).toBeCloseTo(1.0, 0)
      expect(result.frames[1]!.position).toBe(0.5)
      expect(result.frames[1]!.timestampSeconds).toBeCloseTo(5.0, 0)
      expect(result.frames[2]!.position).toBe(0.9)
      expect(result.frames[2]!.timestampSeconds).toBeCloseTo(9.0, 0)
    } finally { await rm(workdir, { recursive: true, force: true }) }
  }, 30_000)

  it('returns empty for unreadable files (capability gap, not blocking)', async () => {
    const result = await extractMultiPointFrames({ artifactPath: '/nonexistent', workdir: '/tmp' })
    expect(result.frames).toHaveLength(0)
    expect(result.failedPositions.length).toBeGreaterThanOrEqual(0)
  })
})
