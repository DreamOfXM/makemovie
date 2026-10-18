import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { access, constants } from 'node:fs/promises'

/**
 * US-023 editMedia 规范化:原片 → 全尺寸 CFR(序列帧率)编辑介质。
 * 时间零点归一(非零 PTS 消除)、VFR 转 CFR(ffmpeg -fps_mode cfr)、
 * 保持原画幅与方向;固定高质量编码 preset——这是编辑与渲染共用的真源,
 * 不是低清预览代理。缓存身份 = 原素材 + 序列帧率 + conformPolicyVersion。
 */

export interface EditMediaProbe {
  frameCount: number
  width: number
  height: number
  durationMs: number
  fpsNum: number
  fpsDen: number
}

export interface EditMediaConformResult {
  objectKey: string
  probe: EditMediaProbe
  fingerprint: string
}

/** 计算缓存身份:原素材 checksum + 序列帧率 + 策略版本。 */
export function editMediaCacheKey(input: {
  originalChecksum: string
  fpsNum: number
  fpsDen: number
  conformPolicyVersion: number
}): string {
  return `editmedia/${input.originalChecksum}/${input.fpsNum}_${input.fpsDen}_v${input.conformPolicyVersion}.mp4`
}

/** 计算 EpisodeEditRevision 的 fingerprint(字段稳定序列化)。 */
export function editFingerprint(input: {
  fpsNum: number
  fpsDen: number
  clips: ReadonlyArray<{ clipId: string; artifactId: string; sourceInFrame: number; sourceOutFrame: number }>
  tracks: ReadonlyArray<{ elementId: string; sourceArtifactId: string; anchor: string }>
}): string {
  const canonical = JSON.stringify({
    fpsNum: input.fpsNum,
    fpsDen: input.fpsDen,
    clips: [...input.clips].map(clip => [clip.clipId, clip.artifactId, clip.sourceInFrame, clip.sourceOutFrame]),
    tracks: [...input.tracks].map(track => [track.elementId, track.sourceArtifactId, track.anchor]),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * 用 ffmpeg probe 原片并规范化为 CFR editMedia。
 * 返回规范化产物的临时文件路径——调用方负责上传存储并登记 EditMedia 行。
 * 转换失败时返回 null(不开放精确裁切,按 §10.2 规则)。
 */
export async function conformToEditMedia(
  sourcePath: string,
  fpsNum: number,
  fpsDen: number,
  workdir: string,
): Promise<{ outputPath: string; probe: EditMediaProbe } | null> {
  const fps = `${fpsNum}/${fpsDen}`
  const outputPath = path.join(workdir, `editmedia_${fps.replace('/', '_')}.mp4`)
  try {
    // 先 probe 源片拿真实参数。
    const probe = await probeVideo(sourcePath)
    if (probe === null) return null

    // 规范化:CFR、归零 PTS、保持画幅、固定编码质量。
    // -vsync 0 = 按时间戳不丢帧;-fps_mode cfr 确保恒定帧率输出。
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error',
      '-i', sourcePath,
      '-fps_mode', 'cfr',   // ffmpeg 9+: -vsync 已移除
      '-r', fps,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      outputPath,
    ], { timeout: 120_000 })

    const conformed = await probeVideo(outputPath)
    if (conformed === null) return null
    return { outputPath, probe: conformed }
  } catch {
    return null
  }
}

/** ffprobe 常用参数。 */
async function probeVideo(filePath: string): Promise<EditMediaProbe | null> {
  try {
    await access(filePath, constants.F_OK)
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,nb_frames,duration',
      '-of', 'json',
      filePath,
    ], { timeout: 15_000 })
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number; r_frame_rate?: string; nb_frames?: string; duration?: string }>
    }
    const stream = parsed.streams?.[0]
    if (!stream?.width || !stream.height) return null
    const [num, den] = (stream.r_frame_rate ?? '25/1').split('/').map(Number)
    const frameCount = stream.nb_frames ? Number(stream.nb_frames) : Math.round(Number(stream.duration ?? 0) * (num / den))
    if (!Number.isFinite(frameCount) || frameCount <= 0) return null
    return {
      frameCount,
      width: stream.width,
      height: stream.height,
      durationMs: Math.round(Number(stream.duration ?? 0) * 1000),
      fpsNum: num || 25,
      fpsDen: den || 1,
    }
  } catch {
    return null
  }
}

export { probeVideo }
