export type Stage = 'source_audit' | 'script' | 'asset' | 'storyboard' | 'first_frame' | 'video' | 'audio' | 'composition' | 'delivery'
export const workflowStatuses = ['draft', 'ready', 'running', 'needs_review', 'approved', 'blocked', 'completed', 'cancelled'] as const
export type WorkflowStatus = typeof workflowStatuses[number]
export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return (workflowStatuses as readonly string[]).includes(value as string)
}
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled'

export const modelModalities = ['text', 'image', 't2v', 'i2v', 'r2v', 'tts', 'music', 'vlm'] as const
export type ModelModality = typeof modelModalities[number]

export function isModelModality(value: unknown): value is ModelModality {
  return (modelModalities as readonly string[]).includes(value as string)
}

/**
 * Language of the *content* the pipeline writes — script, storyboard, prompts.
 * Independent of the console's own UI locale.
 */
export const contentLocales = ['zh', 'en'] as const
export type ContentLocale = typeof contentLocales[number]

/**
 * The three shapes a project can take. One axis: series and short drama run the
 * same pipeline and differ only in per-episode target duration; film is a
 * one-episode project. The pipeline reads Episode.targetDurationMs (seeded from
 * these defaults), never the format itself.
 */
export const projectFormats = ['short_drama', 'series', 'film'] as const
export type ProjectFormat = typeof projectFormats[number]

export function isProjectFormat(value: unknown): value is ProjectFormat {
  return (projectFormats as readonly string[]).includes(value as string)
}

export const formatDefaults: Record<ProjectFormat, { targetDurationMs: number; maxEpisodes: number | null }> = {
  short_drama: { targetDurationMs: 8 * 60_000, maxEpisodes: null },
  series: { targetDurationMs: 45 * 60_000, maxEpisodes: null },
  film: { targetDurationMs: 120 * 60_000, maxEpisodes: 1 },
}

/**
 * Defaults are only seeds: real dramas run 1-3 minute episodes and films are not
 * necessarily 120 minutes, so each format carries a sane range the user can
 * fine-tune inside. Validation clamps here; the pipeline stays duration-agnostic.
 */
export const formatDurationRange: Record<ProjectFormat, { minMs: number; maxMs: number }> = {
  short_drama: { minMs: 30_000, maxMs: 30 * 60_000 },
  series: { minMs: 5 * 60_000, maxMs: 120 * 60_000 },
  film: { minMs: 10 * 60_000, maxMs: 300 * 60_000 },
}

export function durationOutOfRange(format: ProjectFormat, targetDurationMs: number): boolean {
  const range = formatDurationRange[format]
  return !Number.isInteger(targetDurationMs) || targetDurationMs < range.minMs || targetDurationMs > range.maxMs
}

/** Whole-book uploads get their own ceiling; the 200k per-version limit stays episode-level. */
export const PROJECT_SOURCE_CHAR_LIMIT = 1_000_000

/**
 * Spoken-Chinese script pacing, the same rate the script prompt budgets with.
 * Auto-split packs chapters into episodes sized by this many characters a minute.
 */
export const SCRIPT_CHARS_PER_MINUTE = 350

export function isContentLocale(value: unknown): value is ContentLocale {
  return (contentLocales as readonly string[]).includes(value as string)
}

export const capabilitySlots = [
  'script_text',
  'storyboard_text',
  'image_gen',
  'video_t2v',
  'video_i2v',
  'video_r2v',
  'tts_voice',
  'music_gen',
  'visual_audit',
] as const

export type CapabilitySlot = typeof capabilitySlots[number]

export function isCapabilitySlot(value: unknown): value is CapabilitySlot {
  return (capabilitySlots as readonly string[]).includes(value as string)
}

export const slotModality: Record<CapabilitySlot, ModelModality> = {
  script_text: 'text',
  storyboard_text: 'text',
  image_gen: 'image',
  video_t2v: 't2v',
  video_i2v: 'i2v',
  video_r2v: 'r2v',
  tts_voice: 'tts',
  music_gen: 'music',
  visual_audit: 'vlm',
}

export interface ModelCapability {
  provider: string
  model: string
  modality: ModelModality
  acceptsFirstFrame: boolean
  acceptsReferenceImages: boolean
  maxReferenceImages: number
  entitlementVerifiedAt?: Date | null
}

export interface BindCheck {
  ok: boolean
  reason?: string
}

export function canBind(slot: CapabilitySlot, capability: ModelCapability): BindCheck {
  const required = slotModality[slot]
  if (capability.modality !== required) {
    return { ok: false, reason: `slot "${slot}" requires modality "${required}", model "${capability.model}" is "${capability.modality}"` }
  }
  if (slot === 'video_i2v' && !capability.acceptsFirstFrame) {
    return { ok: false, reason: `slot "video_i2v" requires a model that accepts a first frame` }
  }
  if (slot === 'video_r2v' && !capability.acceptsReferenceImages) {
    return { ok: false, reason: `slot "video_r2v" requires a model that accepts reference images` }
  }
  return { ok: true }
}

/**
 * The minimum a video-plan decision reads.
 *
 * Modality stays a plain string rather than `ModelModality` because a candidate resolved
 * from a binding reads it out of a string column — claiming otherwise here would let the
 * type say something the database does not enforce. Entitlement is deliberately absent:
 * `resolveSlotCandidates` already dropped unverified capabilities, and re-checking a field
 * the caller was never told to supply would silently return an empty plan.
 */
export interface VideoModelCandidate {
  model: string
  modality: string
}

export interface GenerationPlan<T extends VideoModelCandidate = VideoModelCandidate> {
  hasReferenceInput: boolean
  candidates: T[]
}

/**
 * Which models may run a shot, in fallback order.
 *
 * A shot with no frame cannot be served by a model that requires one: it would reach the
 * vendor, be refused, and cost the attempt. A shot with a frame prefers the models that can
 * use it and keeps text-to-video behind them, so a conditioning model that is down still
 * yields a picture — a lesser one, but the shot is not lost over a quality gain.
 */
export function planVideoModels<T extends VideoModelCandidate>(candidates: T[], hasReferenceInput: boolean): GenerationPlan<T> {
  // i2v is the only conditioning slot the pipeline resolves today; a frame cannot be
  // spent on a model that would refuse it.
  const referenceCapable = (candidate: T): boolean => candidate.modality === 'i2v'
  const allowed = (candidate: T): boolean => hasReferenceInput || candidate.modality === 't2v'
  const ordered = hasReferenceInput ? [...candidates].sort((a, b) => Number(referenceCapable(b)) - Number(referenceCapable(a))) : candidates
  const seen = new Set<string>()
  const picked = ordered.filter(candidate => {
    if (!allowed(candidate) || seen.has(candidate.model)) return false
    seen.add(candidate.model)
    return true
  })
  return { hasReferenceInput, candidates: picked }
}

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  const transitions: Record<WorkflowStatus, WorkflowStatus[]> = {
    draft: ['ready', 'cancelled'],
    ready: ['running', 'cancelled'],
    running: ['needs_review', 'blocked', 'completed', 'cancelled'],
    needs_review: ['approved', 'blocked', 'cancelled'],
    approved: ['running', 'completed', 'cancelled'],
    blocked: ['ready', 'cancelled'],
    completed: [],
    cancelled: [],
  }
  return transitions[from].includes(to)
}

export const roles = ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'VIEWER'] as const
export type Role = typeof roles[number]

const roleRank: Record<Role, number> = { OWNER: 50, ADMIN: 40, EDITOR: 30, REVIEWER: 20, VIEWER: 10 }

export const actions = [
  'read',
  'review:decide',
  'project:create',
  'project:update',
  'project:delete',
  'episode:write',
  'storyboard:write',
  'generation:trigger',
  'org:update',
  'members:manage',
  'providers:manage',
  'bindings:manage',
  'audit:read',
] as const
export type Action = typeof actions[number]

const actionMinRole: Record<Action, Role> = {
  read: 'VIEWER',
  'review:decide': 'REVIEWER',
  'project:create': 'EDITOR',
  'project:update': 'EDITOR',
  'project:delete': 'ADMIN',
  'episode:write': 'EDITOR',
  'storyboard:write': 'EDITOR',
  'generation:trigger': 'EDITOR',
  'org:update': 'ADMIN',
  'members:manage': 'ADMIN',
  'providers:manage': 'ADMIN',
  'bindings:manage': 'ADMIN',
  'audit:read': 'ADMIN',
}

export function can(role: Role, action: Action): boolean {
  return roleRank[role] >= roleRank[actionMinRole[action]]
}

/** Lowest role that may perform `action` — lets clients explain a denial. */
export function minRoleFor(action: Action): Role {
  return actionMinRole[action]
}

export function isRole(value: string): value is Role {
  return (roles as readonly string[]).includes(value)
}

/**
 * 一次生成失败的「因」。分类决定界面怎么说、以及重抽有没有意义：
 * 视觉审计没过线该重抽，额度用尽抽一百次也不会变——两者都写成「没过线」，
 * 用户就会去改提示词，而真原因在账单上（2026-09-26 全站验收 B1）。
 */
export const failureKinds = ['quota', 'access', 'param', 'network', 'audit', 'unknown'] as const
export type FailureKind = (typeof failureKinds)[number]

/** 模式只收本机库里真出现过的报文（dashscope 错误码 + worker 自写文案），扩族要带样本。 */
const FAILURE_PATTERNS: readonly [FailureKind, RegExp][] = [
  ['audit', /threshold not met|visual-audit:/i],
  ['quota', /AllocationQuota|FreeTierOnly|free quota exhausted|insufficient balance|arrearage/i],
  ['access', /AccessDenied|NoPermission|Forbidden|Unauthorized|InvalidApiKey/i],
  ['param', /InvalidParameter|BadRequest|url error/i],
  ['network', /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i],
]

/**
 * `errorSnapshot` 是文本列：任务级是一条 JSON 数组（候选链逐个错因），
 * 审计级是 `visual-audit: threshold not met …` 裸句。两种都吃。
 */
export function classifyFailure(raw: string | null | undefined): FailureKind {
  if (!raw) return 'unknown'
  let text = raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) text = parsed.map(String).join(' | ')
  } catch {
    // 裸句，按原样分类
  }
  return FAILURE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'unknown'
}

/** 充值、开通权限或改参数之前，再抽一次也不会改变的因。 */
export function isTerminalFailure(kind: FailureKind): boolean {
  return kind === 'quota' || kind === 'access' || kind === 'param'
}

/** 一个（provider, model）迄今的真实调用履历。 */
export interface CallEvidence {
  ok: number
  failed: number
  lastStatus: 'SUCCEEDED' | 'FAILED'
  lastAt: Date
  lastKind: FailureKind
}

/** `GenerationTask` 里够算履历的那几列；探测时间戳证明不了这个。 */
export interface CallEvidenceRow {
  provider: string | null
  model: string | null
  status: string
  errorSnapshot: string | null
  updatedAt: Date
}

export function callEvidenceKey(provider: string | null | undefined, model: string): string {
  return `${provider ?? '?'}|${model.trim()}`
}

/**
 * 每个（provider, model）最近一次真调用是什么结果。失败任务把整条候选链写进 model
 * （"a → b"），链上每个模型都真的试过并失败了，所以拆开逐个记账。
 */
export function reduceCallEvidence(rows: Iterable<CallEvidenceRow>): Map<string, CallEvidence> {
  const byModel = new Map<string, CallEvidence>()
  for (const row of rows) {
    if (!row.model) continue
    for (const name of row.model.split(' → ')) {
      const key = callEvidenceKey(row.provider, name)
      const entry: CallEvidence = byModel.get(key) ?? {
        ok: 0,
        failed: 0,
        lastStatus: 'FAILED',
        lastAt: new Date(0),
        lastKind: 'unknown',
      }
      if (row.status === 'SUCCEEDED') entry.ok += 1
      else {
        entry.failed += 1
        entry.lastKind = classifyFailure(row.errorSnapshot)
      }
      if (row.updatedAt >= entry.lastAt) {
        entry.lastAt = row.updatedAt
        entry.lastStatus = row.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED'
      }
      byModel.set(key, entry)
    }
  }
  return byModel
}

