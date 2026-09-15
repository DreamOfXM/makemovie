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

