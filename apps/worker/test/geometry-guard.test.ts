// SD-180：i2v 静默丢弃首帧仍按成功出片（横屏废片混进竖屏母带）。
// 判据是实测——供应商自报的成功与宽高一律不算，交付字节自己量出来的画幅对不上
// 我们送出去的那张条件帧，这一单就是买错了素材。
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { geometryDrift, orientationOf, runTask } from '../src/run-task.js'
import type { QcSubject } from '../src/qc.js'
import { startTestEnv } from './env.js'

/** 本机 ffmpeg 造一张纯色帧当条件帧：竖屏 270x480 / 横屏 480x320 都过参考图闸门。 */
async function stillFrame(size: string): Promise<Uint8Array> {
  const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-geometry-'))
  try {
    const file = path.join(workdir, 'frame.png')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x2f6f4f:size=${size}`, '-pix_fmt', 'rgb24', '-frames:v', '1', file])
    return new Uint8Array(await readFile(file))
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

/** mock 供应商对 i2v 一律出 320x240 横屏片，正好演一遍「首帧被丢、回一段无关素材」。 */
async function videoTask(frameSize: string) {
  const env = await startTestEnv()
  const seed = await env.seed({ stage: 'VIDEO', modality: 'i2v', model: 'mock-i2v' })
  const [shot] = seed.storyboardIds as [string]
  const frame = await env.attachSucceededMedia(seed, {
    stage: 'FIRST_FRAME',
    modality: 'image',
    storyboardId: shot,
    source: { bytes: await stillFrame(frameSize), mimeType: 'image/png' },
  })
  await env.db.generationTask.update({
    where: { id: seed.taskId },
    data: {
      storyboardId: shot,
      requestSnapshot: JSON.stringify({
        model: 'mock-i2v',
        input: { prompt: 'the rooftop fall, vertical' },
        parameters: {},
        referenceArtifacts: [{ type: 'first_frame', artifactId: frame.artifactId }],
      }),
    },
  })
  const audited: QcSubject[] = []
  const deps = env.deps({
    qcMode: 'pass',
    pollIntervalMs: 1,
    checker: { async check(subject) { audited.push(subject); return { kind: 'fake-qc', decision: 'pass', score: 1 } } },
  })
  return { env, seed, shot, frame, audited, deps }
}

it('refuses a clip whose measured orientation contradicts the frame it was conditioned on', async () => {
  const { env, seed, frame, audited, deps } = await videoTask('270x480')
  try {
    await runTask(env.runPayload(seed), deps)

    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    // 竖屏首帧 + 横屏交付：这一单绝不写 SUCCEEDED。
    expect(task.status).not.toBe('SUCCEEDED')

    const attempt = await env.db.submissionAttempt.findFirstOrThrow({ where: { taskId: seed.taskId }, orderBy: { id: 'desc' } })
    expect(attempt.status).toBe('settled')
    expect(attempt.resolution).toBe('failed')
    // 判据里是两边的实测数字，不是供应商的说法。
    expect(attempt.errorSnapshot).toContain('320x240')
    expect(attempt.errorSnapshot).toContain('270x480')

    const artifact = await env.db.mediaArtifact.findFirst({ where: { taskId: seed.taskId, stage: 'VIDEO' } })
    // 钱已经花：产物行留下，但只带一条待审记录，没有过审结论。
    expect(artifact).not.toBeNull()
    expect(await env.db.qualityCheck.count({ where: { artifactId: artifact!.id, status: 'APPROVED' } })).toBe(0)
    const review = await env.db.qualityCheck.findFirstOrThrow({ where: { artifactId: artifact!.id } })
    expect(JSON.parse(review.report).check).toBe('delivered-geometry')
    // 判退发生在审核之前：一段与本片无关的素材不该再花一次审核调用。
    expect(audited).toHaveLength(0)
    // 首帧仍然只属于首帧档：废片没有被当成这一镜的画面。
    expect(await env.db.mediaArtifact.count({ where: { id: frame.artifactId, stage: 'FIRST_FRAME' } })).toBe(1)
  } finally {
    await env.stop()
  }
})

it('still accepts a clip that keeps the conditioned frame orientation', async () => {
  const { env, seed, audited, deps } = await videoTask('480x320')
  try {
    await runTask(env.runPayload(seed), deps)
    const task = await env.db.generationTask.findUniqueOrThrow({ where: { id: seed.taskId } })
    // 同朝向（mock 出 320x240）就是正常交付，闸门不许顺手拦下好片。
    expect(task.status).toBe('SUCCEEDED')
    expect(audited).toHaveLength(1)
    expect(await env.db.qualityCheck.count({ where: { artifact: { taskId: seed.taskId }, status: 'APPROVED' } })).toBe(1)
  } finally {
    await env.stop()
  }
})

it('measures the aspect contract: same ratio passes, flipped or cropped picture is named', () => {
  expect(orientationOf(1080, 1920)).toBe('portrait')
  expect(orientationOf(1920, 1080)).toBe('landscape')
  expect(orientationOf(1080, 1080)).toBe('square')

  // 9:16 首帧 → 720x1280 交付：同一块画布，只是低一档分辨率，放行。
  expect(geometryDrift({ width: 720, height: 1280 }, { width: 1080, height: 1920 })).toBeNull()
  // SD-180 实测那一单：竖屏请求换回横屏废片。
  expect(geometryDrift({ width: 1280, height: 720 }, { width: 1080, height: 1920 })).toContain('landscape')
  // SD-069 同族：竖屏首帧被裁成方片，朝向先对不上。
  expect(geometryDrift({ width: 1080, height: 1080 }, { width: 1080, height: 1920 })).toContain('square')
  // 同朝向但画幅比漂移越界（竖屏首帧被裁成横带仍属竖屏时也要拦下）。
  expect(geometryDrift({ width: 1080, height: 1500 }, { width: 1080, height: 1920 })).toContain('cropped or padded')
  // 读不出实测/没有条件帧时不判——元数据探测没资格失败一条已付费产物。
  expect(geometryDrift(null, { width: 1080, height: 1920 })).toBeNull()
  expect(geometryDrift({ width: 1280, height: 720 }, null)).toBeNull()
})
