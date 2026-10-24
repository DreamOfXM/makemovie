import { DURATION_KEY, readDurationSpec } from '@studio/domain'
import { describe, expect, it } from 'vitest'
import { listCatalogs } from '../src/catalog.js'
import { mappedDurationProviders, vendorDurationField } from '../src/duration.js'

const VIDEO_MODALITIES = new Set(['t2v', 'i2v', 'r2v'])

describe('vendorDurationField', () => {
  it('writes each vendor’s own name and type for the same request', () => {
    const asked = { [DURATION_KEY]: 10 }
    expect(vendorDurationField('seedance', asked)).toEqual({ duration: 10 })
    expect(vendorDurationField('dashscope', asked)).toEqual({ duration: 10 })
    // Both Kling and Sora validate a string here; sending the number is a 400 on a paid call.
    expect(vendorDurationField('kling', asked)).toEqual({ duration: '10' })
    expect(vendorDurationField('openai', asked)).toEqual({ seconds: '10' })
    // Veo already names it this way, which is why the canonical string was taken from it.
    expect(vendorDurationField('google', asked)).toEqual({ durationSeconds: 10 })
  })

  it('sends no length field at all when none was requested', () => {
    for (const provider of mappedDurationProviders) expect(vendorDurationField(provider, { seed: 3 })).toEqual({})
  })

  it('refuses a provider it cannot map rather than dropping the length', () => {
    // Silent drop is the defect this file exists to remove: the shot would come back at
    // whatever the vendor feels like, and the task log would say nothing.
    expect(() => vendorDurationField('voicebox', { [DURATION_KEY]: 8 })).toThrow('voicebox')
    expect(() => vendorDurationField('voicebox', { [DURATION_KEY]: 8 })).toThrow('must not be dropped')
  })

  it('refuses a length it cannot express', () => {
    for (const value of [7.5, 0, -3, '8', Number.NaN]) {
      expect(() => vendorDurationField('seedance', { [DURATION_KEY]: value })).toThrow('whole number of positive seconds')
    }
  })
})

describe('the catalog and the slot table stay in step', () => {
  /**
   * A vendor added to the catalog without a row in the slot table would accept the
   * platform's length and quietly discard it. `mock` is the one exemption, and it is named
   * rather than inferred: it builds no vendor request, so there is no dialect it could be
   * missing.
   */
  it('maps every vendor that ships a video model', () => {
    const unmapped = listCatalogs()
      .filter(entry => entry.provider !== 'mock')
      .filter(entry => entry.models.some(model => VIDEO_MODALITIES.has(model.modality)))
      .filter(entry => !mappedDurationProviders.includes(entry.provider))
      .map(entry => entry.provider)
    expect(unmapped).toEqual([])
  })

  it('parses every duration a catalog video row declares', () => {
    const unreadable = listCatalogs().flatMap(entry =>
      entry.models
        .filter(model => VIDEO_MODALITIES.has(model.modality) && model.spec?.duration !== undefined && readDurationSpec(model.spec) === undefined)
        .map(model => `${entry.provider}/${model.model}`),
    )
    expect(unreadable).toEqual([])
  })

  it('leaves a video row undeclared only where it says so', () => {
    // A row with no declaration is a decision, not an oversight nobody checked: the worker
    // will send no length for it and log that the clip's duration came from the vendor.
    const undeclared = listCatalogs().flatMap(entry =>
      entry.models
        .filter(model => VIDEO_MODALITIES.has(model.modality) && readDurationSpec(model.spec) === undefined)
        .map(model => `${entry.provider}/${model.model}`),
    )
    expect(undeclared).toEqual(['mock/mock-t2v', 'mock/mock-i2v', 'mock/mock-r2v', 'mock/mock-edit'])
  })
})
