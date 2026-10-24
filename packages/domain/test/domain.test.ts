import { describe, expect, it } from 'vitest'
import { canBind, canTransition, capabilitySlots, isVoiceOverSpeaker, modalityInputs, normalizeSoundBed, normalizeSpeaker, planVideoModels, slotModality, type ModelCapability } from '../src/index.js'

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
  it('puts the conditioning model first and keeps t2v as the fallback', () => {
    const t2v = capability({ model: 't2v-model', modality: 't2v' })
    const i2v = capability({ model: 'i2v-model', modality: 'i2v', acceptsFirstFrame: true })
    const plan = planVideoModels([t2v, i2v], true)
    expect(plan.candidates.map(c => c.model)).toEqual(['i2v-model', 't2v-model'])
  })

  it('offers only t2v for a shot with no frame', () => {
    const t2v = capability({ model: 't2v-model', modality: 't2v' })
    const i2v = capability({ model: 'i2v-model', modality: 'i2v', acceptsFirstFrame: true })
    const r2v = capability({ model: 'r2v-model', modality: 'r2v', acceptsReferenceImages: true, maxReferenceImages: 4 })
    const plan = planVideoModels([i2v, r2v, t2v], false)
    expect(plan.candidates.map(c => c.model)).toEqual(['t2v-model'])
  })

  it('puts r2v first when asset sheets are present, frame or not', () => {
    const t2v = capability({ model: 't2v-model', modality: 't2v' })
    const i2v = capability({ model: 'i2v-model', modality: 'i2v', acceptsFirstFrame: true })
    const r2v = capability({ model: 'r2v-model', modality: 'r2v', acceptsReferenceImages: true, maxReferenceImages: 4 })
    // 定妆照在、首帧也在：r2v 排最前，i2v 次之，t2v 垫底。
    expect(planVideoModels([t2v, i2v, r2v], true, true).candidates.map(c => c.model)).toEqual(['r2v-model', 'i2v-model', 't2v-model'])
    // 只有定妆照、没有首帧：i2v 没有可花的输入不进计划，r2v 领跑，t2v 兜底。
    expect(planVideoModels([t2v, i2v, r2v], false, true).candidates.map(c => c.model)).toEqual(['r2v-model', 't2v-model'])
  })

  it('drops r2v when the shot carries no asset sheets', () => {
    const t2v = capability({ model: 't2v-model', modality: 't2v' })
    const i2v = capability({ model: 'i2v-model', modality: 'i2v', acceptsFirstFrame: true })
    const r2v = capability({ model: 'r2v-model', modality: 'r2v', acceptsReferenceImages: true, maxReferenceImages: 4 })
    // 参考图给视频模型的硬前提（adapter 会拒无参考图的 r2v），计划层就把它挡下。
    expect(planVideoModels([r2v, i2v, t2v], true, false).candidates.map(c => c.model)).toEqual(['i2v-model', 't2v-model'])
  })

  it('allows t2v only for tasks without reference input', () => {
    const t2v = capability({ model: 't2v-model', modality: 't2v' })
    const plan = planVideoModels([t2v], false)
    expect(plan.candidates.map(c => c.model)).toEqual(['t2v-model'])
  })

  it('plans a candidate that carries only a model and a modality', () => {
    // What resolveSlotCandidates actually hands over: no entitlement field, because it
    // already filtered on one. A planner that required it would drop every shot.
    expect(planVideoModels([{ model: 'i2v-model', modality: 'i2v' }], true).candidates).toEqual([{ model: 'i2v-model', modality: 'i2v' }])
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

describe('normalizeSpeaker', () => {
  it('canonicalizes voice-over aliases so VO never gets matched as a character name', () => {
    for (const alias of ['VO', 'vo', 'V.O.', 'voice-over', '画外音', '旁白', '内心独白']) {
      expect(normalizeSpeaker(alias)).toBe('VO')
      expect(isVoiceOverSpeaker(alias)).toBe(true)
    }
  })

  it('trims and strips a trailing colon, and keeps character names untouched', () => {
    expect(normalizeSpeaker('  陈默： ')).toBe('陈默')
    expect(normalizeSpeaker('陈默')).toBe('陈默')
    expect(normalizeSpeaker('系统：')).toBe('系统音')
    expect(normalizeSpeaker('创作者')).toBe('创作者')
  })

  it('treats empty and whitespace as no speaker', () => {
    expect(normalizeSpeaker(null)).toBeNull()
    expect(normalizeSpeaker(undefined)).toBeNull()
    expect(normalizeSpeaker('   ')).toBeNull()
  })
})

describe('normalizeSoundBed', () => {
  /**
   * 分镜 prompt 明确允许作者在「声音」列写「无」，而这一列的值会进付费请求
   * （逐镜连续段的声床提示）。所以这一组的重点不是能认出多少种写法，是别把
   * 「巷口无风」这种带字的正常描述误判成不要底——那等于悄悄删掉剧本要的氛围。
   */
  it('recognizes the author saying "no bed" in both output languages', () => {
    for (const no of ['无', '无 ', 'NONE', 'No', 'n/a', '-', '—']) {
      expect(normalizeSoundBed(no)).toBeNull()
    }
    expect(normalizeSoundBed(null)).toBeNull()
    expect(normalizeSoundBed(undefined)).toBeNull()
    expect(normalizeSoundBed('   ')).toBeNull()
  })

  it('passes the requested atmosphere through untouched, including text that merely mentions 无', () => {
    expect(normalizeSoundBed('  巷口雨声压过远处的车流  ')).toBe('巷口雨声压过远处的车流')
    expect(normalizeSoundBed('巷口无风，只有远处车流')).toBe('巷口无风，只有远处车流')
    expect(normalizeSoundBed('no rain, only traffic')).toBe('no rain, only traffic')
  })
})

describe('modalityInputs', () => {
  it('lets an image row declare reference images, since an edited frame is still an image model', () => {
    expect(modalityInputs('image')).toEqual({ takesInput: true, firstFrame: false })
  })

  it('keeps video rows offering both switches and text rows neither', () => {
    expect(modalityInputs('i2v')).toEqual({ takesInput: true, firstFrame: true })
    expect(modalityInputs('r2v')).toEqual({ takesInput: true, firstFrame: false })
    expect(modalityInputs('t2v')).toEqual({ takesInput: false, firstFrame: false })
    expect(modalityInputs('text')).toEqual({ takesInput: false, firstFrame: false })
    expect(modalityInputs('tts')).toEqual({ takesInput: false, firstFrame: false })
  })
})
