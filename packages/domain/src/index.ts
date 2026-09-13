export const referenceVideoModels = [
  'wan2.7-r2v-2026-06-12',
  'happyhorse-1.1-r2v',
  'happyhorse-1.1-i2v',
] as const

export type ReferenceVideoModel = typeof referenceVideoModels[number]
export type Stage = 'source_audit' | 'script' | 'asset' | 'storyboard' | 'first_frame' | 'video' | 'audio' | 'composition' | 'delivery'
export type WorkflowStatus = 'draft' | 'ready' | 'running' | 'needs_review' | 'approved' | 'blocked' | 'completed' | 'cancelled'

export type ModelModality = 'text' | 'image' | 't2v' | 'i2v' | 'r2v' | 'audio'

export interface ModelCapability {
  provider: string
  model: string
  modality: ModelModality
  acceptsFirstFrame: boolean
  acceptsReferenceImages: boolean
  maxReferenceImages: number
  entitlementVerifiedAt?: Date
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
