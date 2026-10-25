import { describe, expect, it } from 'vitest'
import { catalogSpecFor, declaredDurationModalities, declaresDuration, findCatalogModel, listCatalogs, specSourceOf } from '../src/catalog.js'

/**
 * SD-166: a hand-added model row used to be born with an empty spec, and the empty spec is
 * what made the plan path fall back to the vendor default — a paid batch shipped 5 s at
 * 720P while the storyboard had planned otherwise. The fix starts here, in the matching:
 * if we already describe the model, typing its name must inherit what we describe.
 */
describe('findCatalogModel — the row a hand-entered name means', () => {
  it('inherits the full spec of a catalog row matched by id, case-insensitively', () => {
    const exact = findCatalogModel('dashscope', 'wan3.0-video', 'i2v')
    expect(exact?.spec).toMatchObject({ duration: { kind: 'range', min: 2, max: 30 }, resolutions: ['480P', '720P', '1080P'] })

    // The vendor console shows this name in caps; a row copied off that screen is the same
    // model, and treating it as unknown is what threw the declaration away.
    for (const typed of ['WAN3.0-VIDEO', '  wan3.0-video  ', 'Wan3.0-Video']) {
      expect(findCatalogModel('dashscope', typed, 'i2v')).toEqual(exact)
    }
  })

  it('prefers the row for the asked modality and falls back to the same id', () => {
    // The two wan3.0-video rows differ: the i2v row carries a reference byte cap the t2v
    // row does not, so answering with the wrong one would be a different claim.
    expect(findCatalogModel('dashscope', 'wan3.0-video', 't2v')?.spec).not.toHaveProperty('referenceMaxBytes')
    expect(findCatalogModel('dashscope', 'wan3.0-video', 'i2v')?.spec).toHaveProperty('referenceMaxBytes')

    // An id we list but a modality we have not filed for it: the id's own declaration of
    // lengths and tiers still belongs to the same model, so it beats writing nothing.
    const unlistedModality = findCatalogModel('dashscope', 'wan3.0-video', 'r2v')
    expect(unlistedModality?.modality).toBe('t2v')
    expect(unlistedModality?.spec).toMatchObject({ duration: { kind: 'range', min: 2, max: 30 } })
  })

  it('comes back undefined for a name no catalog carries, and for a provider it does not know', () => {
    expect(findCatalogModel('dashscope', 'qwen-audio-3.1-tts-next', 'tts')).toBeUndefined()
    expect(findCatalogModel('dashscope', '', 'tts')).toBeUndefined()
    expect(findCatalogModel('not-a-vendor', 'wan3.0-video', 'i2v')).toBeUndefined()
    // A model we list under another vendor is not a description of this connection's model.
    expect(findCatalogModel('kling', 'wan3.0-video', 'i2v')).toBeUndefined()
  })

  it('matches every catalog row by its own id, in any modality it is filed under', () => {
    const misses = listCatalogs().flatMap(catalog =>
      catalog.models
        .filter(model => findCatalogModel(catalog.provider, model.model, model.modality) !== model)
        .map(model => `${catalog.provider}/${model.model}/${model.modality}`),
    )
    expect(misses).toEqual([])
  })
})

describe('specSourceOf — what the models page tells the operator', () => {
  it('hands back nothing to inherit from a catalog row that declares nothing', () => {
    expect(catalogSpecFor('dashscope', 'wan3.0-video', 'i2v')).toMatchObject({ duration: { kind: 'range', min: 2, max: 30 } })
    // `mock` ships video rows with no declaration: inheriting "nothing" would read back to
    // the operator as a fact we hold, when it is the absence of one.
    expect(catalogSpecFor('mock', 'mock-t2v', 't2v')).toBeUndefined()
    expect(catalogSpecFor('dashscope', 'no-such-model', 'i2v')).toBeUndefined()
  })

  it('reads an inherited catalog spec as catalog, however the store ordered its keys', () => {
    const row = findCatalogModel('dashscope', 'wan3.0-video', 'i2v')!
    expect(specSourceOf('dashscope', 'wan3.0-video', 'i2v', row.spec)).toBe('catalog')
    // Prisma hands JSON back in storage order, and a nested array must survive the compare.
    const reshuffled = { resolutions: ['480P', '720P', '1080P'], note: row.spec!.note, referenceMaxBytes: row.spec!.referenceMaxBytes, duration: { max: 30, kind: 'range', min: 2 } }
    expect(specSourceOf('dashscope', 'wan3.0-video', 'i2v', reshuffled)).toBe('catalog')
  })

  it('reads an operator-declared spec as manual and a missing one as unknown', () => {
    expect(specSourceOf('openai_compatible', 'my-fine-tune', 'i2v', { duration: { kind: 'range', min: 4, max: 15 } })).toBe('manual')
    // A hand-declared value over a row we also describe is the operator's claim, not ours.
    expect(specSourceOf('dashscope', 'wan3.0-video', 'i2v', { duration: { kind: 'fixed', value: 5 } })).toBe('manual')
    for (const empty of [null, undefined, {}, []]) {
      expect(specSourceOf('dashscope', 'wan3.0-video', 'i2v', empty)).toBe('unknown')
    }
  })

  it('calls a catalog row that declares nothing unknown, because nothing is declared', () => {
    // mock builds no vendor request, so its rows state no lengths on purpose. Showing that
    // as "from the catalog" would answer a question nobody asked; the operator needs to see
    // that no length is pinned and the vendor default is what gets bought.
    expect(findCatalogModel('mock', 'mock-t2v', 't2v')?.spec).toBeUndefined()
    expect(specSourceOf('mock', 'mock-t2v', 't2v', null)).toBe('unknown')
  })

  it('labels every catalog video row from its own catalog entry', () => {
    const mislabelled = listCatalogs().flatMap(catalog =>
      catalog.models
        .filter(model => declaresDuration(model.modality) && model.spec !== undefined)
        .filter(model => specSourceOf(catalog.provider, model.model, model.modality, model.spec) !== 'catalog')
        .map(model => `${catalog.provider}/${model.model}`),
    )
    expect(mislabelled).toEqual([])
  })
})

describe('declaresDuration', () => {
  it('names only the per-second billed video modalities', () => {
    expect(declaredDurationModalities).toEqual(['t2v', 'i2v', 'r2v'])
    for (const modality of ['t2v', 'i2v', 'r2v']) expect(declaresDuration(modality)).toBe(true)
    for (const modality of ['image', 'tts', 'music', 'text', 'vlm', 'sfx']) expect(declaresDuration(modality)).toBe(false)
  })
})
