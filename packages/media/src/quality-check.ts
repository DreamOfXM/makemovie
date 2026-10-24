import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, constants } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

/**
 * US-031 技术质量检查:确定性、可复核、四层独立报告的第一层。
 * ffprobe/ffmpeg 确定性检查——文件可读、解码、时长、帧率、尺寸、音轨;
 * 冻结帧/黑帧/静音为「疑点」而非自动判艺术错误(§11)。
 * 硬阻塞仅限:缺失/损坏/越界/不满足明确输出条件(§11.1 决策表)。
 */

export interface TechnicalFinding {
  id: string
  severity: 'blocking' | 'warning' | 'info'
  dimension: 'file' | 'video' | 'audio' | 'duration'
  message: string
  /** 证据:时间点或范围(秒),null = 整体性发现。 */
  evidenceTimeSeconds: number | null
}

export interface TechnicalCheckResult {
  artifactPath: string
  findings: TechnicalFinding[]
  passed: boolean  // false = 有 blocking
}

export async function runTechnicalCheck(
  artifactPath: string,
  options: { expectedDurationMs?: number; expectedWidth?: number; expectedHeight?: number } = {},
): Promise<TechnicalCheckResult> {
  const findings: TechnicalFinding[] = []

  // 1) 文件可读。
  try {
    await access(artifactPath, constants.R_OK)
  } catch {
    return { artifactPath, findings: [{ id: 'file_unreadable', severity: 'blocking', dimension: 'file', message: `file not readable: ${artifactPath}`, evidenceTimeSeconds: null }], passed: false }
  }

  // 2) ffprobe 元数据。
  let probe: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> }
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', artifactPath], { timeout: 15_000 })
    probe = JSON.parse(stdout)
  } catch {
    findings.push({ id: 'probe_failed', severity: 'blocking', dimension: 'file', message: 'ffprobe failed to parse the file — possible corruption', evidenceTimeSeconds: null })
    return { artifactPath, findings, passed: false }
  }

  const videoStream = probe.streams?.find(stream => stream.codec_type === 'video')
  const audioStream = probe.streams?.find(stream => stream.codec_type === 'audio')

  // 3) 视频流。
  if (!videoStream) {
    findings.push({ id: 'no_video_stream', severity: 'blocking', dimension: 'video', message: 'no video stream found', evidenceTimeSeconds: null })
  } else {
    const width = Number(videoStream.width)
    const height = Number(videoStream.height)
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      findings.push({ id: 'invalid_dimensions', severity: 'blocking', dimension: 'video', message: `invalid dimensions: ${width}×${height}`, evidenceTimeSeconds: null })
    } else {
      if (options.expectedWidth && width !== options.expectedWidth) {
        findings.push({ id: 'dimension_mismatch', severity: 'warning', dimension: 'video', message: `width ${width} differs from expected ${options.expectedWidth}`, evidenceTimeSeconds: null })
      }
      // F19: expectedHeight 同样核验——只查宽不查高是不完整的尺寸校验。
      if (options.expectedHeight && height !== options.expectedHeight) {
        findings.push({ id: 'dimension_mismatch_height', severity: 'warning', dimension: 'video', message: `height ${height} differs from expected ${options.expectedHeight}`, evidenceTimeSeconds: null })
      }
    }
  }

  // 4) 音轨。
  if (!audioStream) {
    findings.push({ id: 'no_audio_track', severity: 'info', dimension: 'audio', message: 'no audio track (silent video is legal)', evidenceTimeSeconds: null })
  }

  // 5) 时长。
  const durationSeconds = Number(probe.format?.duration)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    findings.push({ id: 'invalid_duration', severity: 'blocking', dimension: 'duration', message: `invalid duration: ${probe.format?.duration}`, evidenceTimeSeconds: null })
  } else if (options.expectedDurationMs && Math.abs(durationSeconds * 1000 - options.expectedDurationMs) > 2000) {
    findings.push({ id: 'duration_mismatch', severity: 'warning', dimension: 'duration', message: `duration ${durationSeconds.toFixed(2)}s differs from expected ${options.expectedDurationMs / 1000}s by >2s`, evidenceTimeSeconds: null })
  }

  // 6) 黑帧疑点(非阻塞):检测前 5 秒内的黑帧。
  if (videoStream && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    try {
      const checkDuration = Math.min(durationSeconds, 5)
      const { stderr } = await execFileAsync('ffmpeg', [
        '-i', artifactPath, '-t', String(checkDuration),
        '-vf', 'blackdetect=d=0.5:pix_th=0.10',
        '-an', '-f', 'null', '-',
      ], { timeout: 30_000 })
      const blackMatches = stderr.matchAll(/black_start:([\d.]+)/g)
      for (const match of blackMatches) {
        findings.push({ id: `black_frame_${match[1]}`, severity: 'warning', dimension: 'video', message: `suspected black frame at ${match[1]}s (≥0.5s)`, evidenceTimeSeconds: Number(match[1]) })
      }
    } catch {
      // blackdetect 失败不阻塞——是疑点检测,不是硬检查。
    }
  }

  const passed = !findings.some(finding => finding.severity === 'blocking')
  return { artifactPath, findings, passed }
}

// ── US-032 多时点视觉审核 ────────────────────────────────────────────────────

export interface MultiPointFrame {
  /** 相对时间点(0.0–1.0),如 0.1 = 10% 处。 */
  position: number
  /** 抽出的帧文件路径(调用方用 ffmpeg -ss 抽取)。 */
  framePath: string
  /** 帧的绝对时间(秒)。 */
  timestampSeconds: number
}

export interface MultiPointCheckRequest {
  artifactPath: string
  /** 抽帧位置(默认 [0.1, 0.5, 0.9])。 */
  positions?: number[]
  workdir: string
}

export interface MultiPointCheckResult {
  frames: MultiPointFrame[]
  /** 抽帧失败的位置(不算阻塞——是能力缺失,不是素材问题)。 */
  failedPositions: number[]
}

/**
 * 按 §11 的「单镜画面」层规范抽帧:默认取接近 10%/50%/90% 时点,去重并保留
 * 时间戳。不能由稀疏帧证明全程无闪烁——这是能力边界,不是检查通过。
 */
export async function extractMultiPointFrames(request: MultiPointCheckRequest): Promise<MultiPointCheckResult> {
  const positions = request.positions ?? [0.1, 0.5, 0.9]
  const deduped = [...new Set(positions.map(p => Math.min(1, Math.max(0, p))))].sort((a, b) => a - b)

  // 先 probe 总时长。
  let durationSeconds = 0
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', request.artifactPath], { timeout: 15_000 })
    durationSeconds = Number(stdout.trim())
  } catch { /* probe 失败返回空 */ }

  const frames: MultiPointFrame[] = []
  const failedPositions: number[] = []

  // 确保输出目录存在——调用方可能只给路径不给目录。
  const { mkdir } = await import('node:fs/promises')
  await mkdir(request.workdir, { recursive: true }).catch(() => undefined)

  for (const position of deduped) {
    const timestampSeconds = durationSeconds * position
    const framePath = `${request.workdir}/frame_${position.toFixed(2)}.png`
    try {
      await execFileAsync('ffmpeg', [
        '-y', '-v', 'error',
        '-ss', String(timestampSeconds),
        '-i', request.artifactPath,
        '-frames:v', '1',
        framePath,
      ], { timeout: 15_000 })
      frames.push({ position, framePath, timestampSeconds })
    } catch {
      failedPositions.push(position)
    }
  }

  return { frames, failedPositions }
}
