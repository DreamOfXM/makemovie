export type Stage = 'source_audit' | 'script' | 'asset' | 'storyboard' | 'first_frame' | 'video' | 'audio' | 'composition' | 'delivery'
export const workflowStatuses = ['draft', 'ready', 'running', 'needs_review', 'approved', 'blocked', 'completed', 'cancelled'] as const
export type WorkflowStatus = typeof workflowStatuses[number]
export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return (workflowStatuses as readonly string[]).includes(value as string)
}
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled'

export type ModelModality = 'text' | 'image' | 't2v' | 'i2v' | 'r2v' | 'tts' | 'music' | 'vlm'

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

export interface GenerationPlan {
  hasReferenceInput: boolean
  candidates: ModelCapability[]
}

export function planVideoModels(capabilities: ModelCapability[], hasReferenceInput: boolean): GenerationPlan {
  const allowed = hasReferenceInput ? new Set<ModelModality>(['r2v', 'i2v']) : new Set<ModelModality>(['t2v', 'r2v', 'i2v'])
  const seen = new Set<string>()
  const candidates = capabilities.filter(capability => {
    if (!allowed.has(capability.modality) || !capability.entitlementVerifiedAt || seen.has(capability.model)) return false
    seen.add(capability.model)
    return true
  })
  return { hasReferenceInput, candidates }
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

