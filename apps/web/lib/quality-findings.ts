import { ApiError, type ApiClient } from './api'

/* -------------------------------------------------------------------------- */
/* US-034 质量问题队列                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 技术检查落在合成母带上的问题条目。severity/dimension 由 @studio/media 的
 * runTechnicalCheck 产出；status 由人工裁决与后续重查推进（stale = 母带指纹
 * 已变，这条结论不再指当前成片）。检查端点按 manifest 快照下发——裁决字段
 * 是后补的，旧快照可能不带，所以入口统一过 normalizeFinding 补默认值。
 */
export interface QualityFinding {
  id: string
  dimension: string
  severity: 'blocking' | 'warning' | 'info' | string
  message: string
  evidenceTimeSeconds: number | null
  storyboardId: string | null
  status: 'open' | 'accepted' | 'resolved' | 'stale' | string
  decidedBy: string | null
  reason: string | null
  /** 行级指纹按契约下发；当前行 DTO 未携带时补空串（界面不读它，stale 由 status 表达）。 */
  fingerprint: string
}

/** GET /episodes/:id/quality-findings 的整体快照；null = 该集还没有可读的检查记录。 */
export interface QualitySnapshot {
  compositionId: string
  passed: boolean | null
  findings: QualityFinding[]
}

/** 裁决动作：accept = 带着这条问题放行；resolve = 人已修复。两者都要理由。 */
export type FindingDecisionAction = 'accept' | 'resolve'

/** 人工裁决提交结果：冲突/漏填理由不抛异常，交给界面按 kind 说人话。 */
export type FindingDecisionResult =
  | { ok: true; finding: QualityFinding }
  | { ok: false; kind: 'reasonRequired' }
  | { ok: false; kind: 'conflict' }

/** Manifest 里可能缺裁决字段的原始行（检查先行、裁决后到的过渡形态）。 */
interface RawQualityFinding {
  id?: string
  dimension?: string
  severity?: string
  message?: string
  evidenceTimeSeconds?: number | null
  storyboardId?: string | null
  status?: string | null
  decidedBy?: string | null
  reason?: string | null
  fingerprint?: string | null
}

interface RawQualitySnapshot {
  compositionId?: string
  passed?: boolean | null
  findings?: RawQualityFinding[]
}

export function normalizeFinding(raw: RawQualityFinding): QualityFinding {
  return {
    id: raw.id ?? '',
    dimension: raw.dimension ?? '',
    severity: raw.severity ?? 'info',
    message: raw.message ?? '',
    evidenceTimeSeconds: raw.evidenceTimeSeconds ?? null,
    storyboardId: raw.storyboardId ?? null,
    status: raw.status ?? 'open',
    decidedBy: raw.decidedBy ?? null,
    reason: raw.reason ?? null,
    fingerprint: raw.fingerprint ?? '',
  }
}

function normalizeSnapshot(raw: RawQualitySnapshot): QualitySnapshot {
  return {
    compositionId: raw.compositionId ?? '',
    passed: raw.passed ?? null,
    findings: (raw.findings ?? []).map(normalizeFinding),
  }
}

/**
 * 读当前快照。404（本集还没有合成母带可检查）不算错误：队列此时该说的是
 * 「尚未检查」，不是一行红色报错。其余失败原样抛给面板的 ErrorState。
 */
export async function listQualityFindings(api: ApiClient, episodeId: string): Promise<QualitySnapshot | null> {
  try {
    return normalizeSnapshot(await api<RawQualitySnapshot>(`/episodes/${episodeId}/quality-findings`))
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/** POST /episodes/:id/reviews —— 对最新母带跑技术检查并返回刷新后的快照。 */
export async function runQualityReview(api: ApiClient, episodeId: string): Promise<QualitySnapshot> {
  return normalizeSnapshot(await api<RawQualitySnapshot>(`/episodes/${episodeId}/reviews`, { method: 'POST' }))
}

/**
 * PATCH /quality-findings/:id —— accept/resolve 都必须带理由（后端 400 拒空理由，
 * 这里先拦，省一次注定失败的请求）。409 = 已 stale 或已被别人裁决：不报错，
 * 返回 conflict 让界面刷新列表后用一句话说明，不打断队列里的下一条。
 */
export async function decideFinding(
  api: ApiClient,
  findingId: string,
  action: FindingDecisionAction,
  reason: string,
): Promise<FindingDecisionResult> {
  const trimmed = reason.trim()
  if (!trimmed) return { ok: false, kind: 'reasonRequired' }
  try {
    const data = await api<{ finding?: RawQualityFinding }>(`/quality-findings/${findingId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action, reason: trimmed }),
    })
    return { ok: true, finding: normalizeFinding(data.finding ?? { id: findingId }) }
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return { ok: false, kind: 'conflict' }
    throw error
  }
}

/** 队列按严重度排：阻断在前，提示垫底；同severity保持后端顺序（稳定排序）。 */
const SEVERITY_RANK: Record<string, number> = { blocking: 0, warning: 1, info: 2 }

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK.info
}

export function sortFindingsBySeverity(findings: QualityFinding[]): QualityFinding[] {
  return [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
}

/** 只有 open 行可以裁决；stale/已裁决行后端会以 409 拒绝，按钮直接禁用。 */
export function findingActionable(finding: QualityFinding): boolean {
  return finding.status === 'open'
}
