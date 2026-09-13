import { describe, expect, it } from 'vitest'
import { canBind, canTransition, capabilitySlots, planVideoModels, slotModality, type ModelCapability } from '../src/index.js'

function capability(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    provider: 'dashscope',
    model: 'test-model',
    modality: 'text',
    acceptsFirstFrame: false,
    acceptsReferenceImages: false,
    maxReferenceImages: 0,
    entitlementVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

describe('canTransition', () => {
  it('allows the documented forward path', () => {
    expect(canTransition('draft', 'ready')).toBe(true)
    expect(canTransition('ready', 'running')).toBe(true)
    expect(canTransition('running', 'needs_review')).toBe(true)
    expect(canTransition('needs_review', 'approved')).toBe(true)
    expect(canTransition('approved', 'completed')).toBe(true)
  })

  it('rejects illegal jumps', () => {
    expect(canTransition('draft', 'completed')).toBe(false)
    expect(canTransition('needs_review', 'completed')).toBe(false)
    expect(canTransition('blocked', 'approved')).toBe(false)
  })

  it('treats terminal states as final', () => {
    for (const to of ['draft', 'ready', 'running', 'completed'] as const) {
      expect(canTransition('completed', to)).toBe(false)
      expect(canTransition('cancelled', to)).toBe(false)
    }
  })
})

describe('planVideoModels', () => {
  it('excludes t2v when the task has reference input', () => {
    const t2v = capability({ model: 't2v-model', modality: 't2v' })
    const i2v = capability({ model: 'i2v-model', modality: 'i2v', acceptsFirstFrame: true })
    const plan = planVideoModels([t2v, i2v], true)
    expect(plan.candidates.map(c => c.model)).toEqual(['i2v-model'])
  })

  it('allows t2v only for tasks without reference input', () => {
    const t2v = capability({ model: 't2v-model', modality: 't2v' })
    const plan = planVideoModels([t2v], false)
    expect(plan.candidates.map(c => c.model)).toEqual(['t2v-model'])
  })

  it('drops capabilities without verified entitlement', () => {
    const unverified = capability({ model: 'unverified', modality: 'i2v', acceptsFirstFrame: true, entitlementVerifiedAt: null })
    expect(planVideoModels([unverified], true).candidates).toHaveLength(0)
  })

  it('deduplicates by model name and keeps order', () => {
    const a = capability({ model: 'same', modality: 'i2v', acceptsFirstFrame: true, provider: 'p1' })
    const b = capability({ model: 'same', modality: 'i2v', acceptsFirstFrame: true, provider: 'p2' })
    expect(planVideoModels([a, b], true).candidates).toHaveLength(1)
  })
})

describe('canBind', () => {
  it('covers every slot with a required modality', () => {
    for (const slot of capabilitySlots) {
      expect(slotModality[slot]).toBeDefined()
    }
  })

  it('rejects modality mismatch', () => {
    const result = canBind('image_gen', capability({ modality: 'text' }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('requires modality "image"')
  })

  it('rejects i2v binding for a model without first-frame support', () => {
    const result = canBind('video_i2v', capability({ modality: 'i2v', acceptsFirstFrame: false }))
    expect(result.ok).toBe(false)
  })

  it('rejects r2v binding for a model without reference-image support', () => {
    const result = canBind('video_r2v', capability({ modality: 'r2v', acceptsReferenceImages: false }))
    expect(result.ok).toBe(false)
  })

  it('accepts a fully compatible binding', () => {
    expect(canBind('video_r2v', capability({ modality: 'r2v', acceptsFirstFrame: true, acceptsReferenceImages: true, maxReferenceImages: 4 })).ok).toBe(true)
    expect(canBind('script_text', capability({ modality: 'text' })).ok).toBe(true)
  })
})
