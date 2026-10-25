/**
 * SD-081：worker 写进 QualityCheck.report 的读数远不止一个总分，但 API 过去只把它当
 * 「分数 + reasons」读，界面于是只能看见一个数。这里只做边界解析，不重算任何判据。
 *
 * report 是自由格式 JSON，历史上由多条代码路径写过：NaN 或字符串一旦漏到响应里，屏上
 * 就成了 `NaN%`。所以逐字段验证、坏的逐条丢弃，全坏就返回 null——DB 列的垃圾降级成
 * 「没有读数」，绝不升级成 500。
 */
export const QC_AUDIT_REPETITION_STATUSES = ['no-baseline', 'distinct', 'repeated', 'unknown'] as const

export type QcAuditRepetitionStatus = (typeof QC_AUDIT_REPETITION_STATUSES)[number]

export interface QcFrameScoreReading {
  /** 相对片内位置 0..1，与审核提示里的帧标签同一坐标系。 */
  position: number
  /** 逐帧 0..1 分。 */
  score: number
}

export interface QcStructureDriftReading {
  /** false = 一帧都没量出来；它与「量到 0」是两个世界，不能折叠成同一个数。 */
  measured: boolean
  earlyLateDistance: number | null
  firstMidDistance: number | null
  maxStepDistance: number | null
  sampleSeconds: number[]
}

export interface QcAuditRepetitionReading {
  matchedArtifactId: string | null
  pictureDistance: number | null
  status: QcAuditRepetitionStatus
}

export interface QcReadings {
  frameScores: QcFrameScoreReading[]
  structureDrift: QcStructureDriftReading | null
  auditRepetition: QcAuditRepetitionReading | null
}

/** 审核最多按 24 点抽帧；超出这个长度的数组只可能是写坏了或旧格式，截断而不是整份丢弃。 */
const MAX_FRAME_SCORES = 24

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function unitNumber(value: unknown): number | null {
  const number = finiteNumber(value)
  return number !== null && number >= 0 && number <= 1 ? number : null
}

function parseFrameScores(value: unknown): QcFrameScoreReading[] {
  if (!Array.isArray(value)) return []
  const scores: QcFrameScoreReading[] = []
  for (const entry of value) {
    if (scores.length >= MAX_FRAME_SCORES) break
    if (!isRecord(entry)) continue
    const position = unitNumber(entry.position)
    const score = unitNumber(entry.score)
    if (position === null || score === null) continue
    scores.push({ position, score })
  }
  return scores
}

function parseStructureDrift(value: unknown): QcStructureDriftReading | null {
  if (!isRecord(value) || typeof value.measured !== 'boolean') return null
  const sampleSeconds = Array.isArray(value.sampleSeconds)
    ? value.sampleSeconds
        .map(finiteNumber)
        .filter((second): second is number => second !== null)
        .slice(0, MAX_FRAME_SCORES)
    : []
  return {
    measured: value.measured,
    earlyLateDistance: finiteNumber(value.earlyLateDistance),
    firstMidDistance: finiteNumber(value.firstMidDistance),
    maxStepDistance: finiteNumber(value.maxStepDistance),
    sampleSeconds,
  }
}

function parseAuditRepetition(value: unknown): QcAuditRepetitionReading | null {
  if (!isRecord(value)) return null
  if (typeof value.status !== 'string' || !(QC_AUDIT_REPETITION_STATUSES as readonly string[]).includes(value.status)) return null
  return {
    matchedArtifactId: typeof value.matchedArtifactId === 'string' ? value.matchedArtifactId : null,
    pictureDistance: finiteNumber(value.pictureDistance),
    status: value.status as QcAuditRepetitionStatus,
  }
}

/** 纯函数、永不抛：任何解析不出的输入都退成 null，由调用方当作「没有读数」处理。 */
export function parseQcReadings(report: string | null | undefined): QcReadings | null {
  if (typeof report !== 'string' || report.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(report)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const frameScores = parseFrameScores(parsed.frameScores)
  const structureDrift = parseStructureDrift(parsed.structureDrift)
  const auditRepetition = parseAuditRepetition(parsed.auditRepetition)
  if (frameScores.length === 0 && !structureDrift && !auditRepetition) return null
  return { frameScores, structureDrift, auditRepetition }
}
