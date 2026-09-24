import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv

beforeAll(async () => {
  env = await startTestEnv()
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

const authHeaders = (token: string) => env.authHeaders(token)

interface CatalogRow {
  model: string
  displayName: string
  modality: string
  acceptsReferenceImages?: boolean
  maxReferenceImages?: number
  source?: 'official' | 'custom'
  entryId?: string
}

async function getCatalogs(token: string) {
  const res = await env.app.inject({ method: 'GET', url: '/api/providers/catalogs', headers: authHeaders(token) })
  expect(res.statusCode).toBe(200)
  return res.json() as { provider: string; models: CatalogRow[] }[]
}

async function getHidden(token: string) {
  const res = await env.app.inject({ method: 'GET', url: '/api/providers/catalogs/hidden', headers: authHeaders(token) })
  expect(res.statusCode).toBe(200)
  return res.json() as { providers: { provider: string; label: string }[]; models: { provider: string; model: string; displayName: string }[] }
}

const hide = (token: string, provider: string, model?: string) =>
  env.app.inject({ method: 'POST', url: `/api/providers/catalogs/${provider}/hide`, headers: authHeaders(token), payload: model === undefined ? {} : { model } })
const unhide = (token: string, provider: string, model?: string) =>
  env.app.inject({ method: 'DELETE', url: `/api/providers/catalogs/${provider}/hide${model === undefined ? '' : `?model=${encodeURIComponent(model)}`}`, headers: authHeaders(token) })
const addCustom = (token: string, provider: string, payload: Record<string, unknown>) =>
  env.app.inject({ method: 'POST', url: `/api/providers/catalogs/${provider}/models`, headers: authHeaders(token), payload })

describe('catalog overlay — hiding', () => {
  it('hides a vendor card, reports it under hidden, and restores it', async () => {
    const owner = await env.register('ov-hide-vendor@example.com', 'Hide Vendor Org')

    expect((await hide(owner.token, 'kling')).statusCode).toBe(204)
    expect((await getCatalogs(owner.token)).map(c => c.provider)).not.toContain('kling')
    const hidden = await getHidden(owner.token)
    expect(hidden.providers).toEqual([{ provider: 'kling', label: 'Kuaishou Kling' }])
    expect(hidden.models).toEqual([])

    expect((await unhide(owner.token, 'kling')).statusCode).toBe(204)
    expect((await getCatalogs(owner.token)).map(c => c.provider)).toContain('kling')
    expect((await getHidden(owner.token)).providers).toEqual([])
  })

  it('hides every row filed under a model id, including both video dialects', async () => {
    const owner = await env.register('ov-hide-model@example.com', 'Hide Model Org')

    expect((await hide(owner.token, 'seedance', 'doubao-seedance-2-5-260628')).statusCode).toBe(204)
    const seedance = (await getCatalogs(owner.token)).find(c => c.provider === 'seedance')!
    expect(seedance.models.filter(m => m.model === 'doubao-seedance-2-5-260628')).toEqual([])
    // The vendor's other generations are untouched.
    expect(seedance.models.some(m => m.model === 'doubao-seedance-2-0-260128')).toBe(true)
    const hidden = await getHidden(owner.token)
    expect(hidden.models).toEqual([{ provider: 'seedance', model: 'doubao-seedance-2-5-260628', displayName: 'Seedance 2.5' }])

    expect((await unhide(owner.token, 'seedance', 'doubao-seedance-2-5-260628')).statusCode).toBe(204)
    const restored = (await getCatalogs(owner.token)).find(c => c.provider === 'seedance')!
    expect(restored.models.filter(m => m.model === 'doubao-seedance-2-5-260628').map(m => m.modality).sort()).toEqual(['i2v', 't2v'])
  })

  it('refuses to hide what no catalog carries, and hide is idempotent', async () => {
    const owner = await env.register('ov-hide-bad@example.com', 'Hide Bad Org')

    expect((await hide(owner.token, 'nope-vendor')).statusCode).toBe(400)
    expect((await hide(owner.token, 'dashscope', 'not-a-model')).statusCode).toBe(404)
    expect((await hide(owner.token, 'dashscope', 'qwen3.8-max')).statusCode).toBe(204)
    expect((await hide(owner.token, 'dashscope', 'qwen3.8-max')).statusCode).toBe(204)
    expect((await unhide(owner.token, 'dashscope', 'qwen3.8-max')).statusCode).toBe(204)
    // Nothing left to unhide — the second call must say so instead of pretending.
    expect((await unhide(owner.token, 'dashscope', 'qwen3.8-max')).statusCode).toBe(404)
  })
})

describe('catalog overlay — custom models', () => {
  it('adds a custom row and marks it as the org’s own', async () => {
    const owner = await env.register('ov-add@example.com', 'Add Org')

    const res = await addCustom(owner.token, 'dashscope', { model: 'wan4.0-video', displayName: 'Wan 4.0 Video', modality: 't2v' })
    expect(res.statusCode).toBe(201)
    const entry = res.json() as { id: string }
    const dashscope = (await getCatalogs(owner.token)).find(c => c.provider === 'dashscope')!
    const added = dashscope.models.find(m => m.model === 'wan4.0-video')!
    expect(added.source).toBe('custom')
    expect(added.entryId).toBe(entry.id)
    expect(added.displayName).toBe('Wan 4.0 Video')
  })

  it('shadows the official row it matches, so a stale flag can be corrected', async () => {
    const owner = await env.register('ov-shadow@example.com', 'Shadow Org')

    const res = await addCustom(owner.token, 'dashscope', { model: 'qwen-image-edit', modality: 'image', acceptsReferenceImages: true, maxReferenceImages: 5 })
    expect(res.statusCode).toBe(201)
    const dashscope = (await getCatalogs(owner.token)).find(c => c.provider === 'dashscope')!
    // One row, not two: the custom correction replaces the official claim.
    const rows = dashscope.models.filter(m => m.model === 'qwen-image-edit')
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('custom')
    expect(rows[0].maxReferenceImages).toBe(5)

    // Deleting the correction puts the shipped row back.
    const del = await env.app.inject({ method: 'DELETE', url: `/api/providers/catalogs/entries/${(res.json() as { id: string }).id}`, headers: authHeaders(owner.token) })
    expect(del.statusCode).toBe(204)
    const reverted = (await getCatalogs(owner.token)).find(c => c.provider === 'dashscope')!.models.filter(m => m.model === 'qwen-image-edit')
    expect(reverted).toHaveLength(1)
    expect(reverted[0].source).toBe('official')
    expect(reverted[0].maxReferenceImages).toBe(3)
  })

  it('rejects a duplicate custom row and validates like a connection row', async () => {
    const owner = await env.register('ov-dup@example.com', 'Dup Org')

    await addCustom(owner.token, 'mock', { model: 'mock-extra', modality: 'text' })
    const dup = await addCustom(owner.token, 'mock', { model: 'mock-extra', modality: 'text' })
    expect(dup.statusCode).toBe(409)
    // Same id under another modality is a different claim and goes through.
    expect((await addCustom(owner.token, 'mock', { model: 'mock-extra', modality: 'vlm' })).statusCode).toBe(201)

    const badModality = await addCustom(owner.token, 'mock', { model: 'mock-x', modality: 'stt' })
    expect(badModality.statusCode).toBe(400)
    const badFlags = await addCustom(owner.token, 'mock', { model: 'mock-x', modality: 'text', acceptsFirstFrame: true })
    expect(badFlags.statusCode).toBe(400)
    const unknownProvider = await addCustom(owner.token, 'openai-ish', { model: 'x', modality: 'text' })
    expect(unknownProvider.statusCode).toBe(400)
  })

  it('deleting an entry from another org answers 404, not 403', async () => {
    const a = await env.register('ov-del-a@example.com', 'Del A')
    const b = await env.register('ov-del-b@example.com', 'Del B')
    const created = await addCustom(a.token, 'mock', { model: 'mock-private', modality: 'text' })
    const entryId = (created.json() as { id: string }).id

    expect((await env.app.inject({ method: 'DELETE', url: `/api/providers/catalogs/entries/${entryId}`, headers: authHeaders(b.token) })).statusCode).toBe(404)
    // And the row is still the first org’s.
    expect((await getCatalogs(a.token)).find(c => c.provider === 'mock')!.models.some(m => m.model === 'mock-private')).toBe(true)
  })
})

describe('catalog overlay — seeding and isolation', () => {
  it('seeds a new connection from the visible catalog, not the shipped one', async () => {
    const owner = await env.register('ov-seed@example.com', 'Seed Org')
    // Curate: drop two wan generations, add one the vendor shipped after our release.
    await hide(owner.token, 'dashscope', 'wan2.6-i2v')
    await hide(owner.token, 'dashscope', 'wanx2.1-i2v-turbo')
    await addCustom(owner.token, 'dashscope', { model: 'wan4.0-video', modality: 't2v' })

    const res = await env.app.inject({ method: 'POST', url: '/api/providers/connections', headers: authHeaders(owner.token), payload: { provider: 'dashscope', name: 'curated-main', apiKey: 'k' } })
    expect(res.statusCode).toBe(201)
    const connection = res.json() as { capabilities: { model: string; modality: string }[] }
    expect(connection.capabilities.some(c => c.model === 'wan2.6-i2v')).toBe(false)
    expect(connection.capabilities.some(c => c.model === 'wanx2.1-i2v-turbo')).toBe(false)
    expect(connection.capabilities.some(c => c.model === 'wan4.0-video' && c.modality === 't2v')).toBe(true)
    // Everything else rode along untouched.
    expect(connection.capabilities.some(c => c.model === 'qwen3.8-max')).toBe(true)
  })

  it('keeps one org’s overlay out of another org’s view', async () => {
    const a = await env.register('ov-tenant-a@example.com', 'Tenant A')
    const b = await env.register('ov-tenant-b@example.com', 'Tenant B')
    await hide(a.token, 'anthropic')

    expect((await getCatalogs(b.token)).map(c => c.provider)).toContain('anthropic')
    expect((await getCatalogs(a.token)).map(c => c.provider)).not.toContain('anthropic')
  })

  it('requires providers:manage (ADMIN+) for overlay edits but read for everyone', async () => {
    const owner = await env.register('ov-perm@example.com', 'Perm Org')
    await env.register('ov-editor@example.com', 'Editor Own Org')
    await env.app.inject({ method: 'POST', url: '/api/members', headers: authHeaders(owner.token), payload: { email: 'ov-editor@example.com', role: 'EDITOR' } })
    const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ov-editor@example.com', password: 'password123', organizationId: owner.organization.id } })
    const editorToken = login.json().token as string

    expect((await env.app.inject({ method: 'GET', url: '/api/providers/catalogs', headers: authHeaders(editorToken) })).statusCode).toBe(200)
    expect((await hide(editorToken, 'kling')).statusCode).toBe(403)
    expect((await addCustom(editorToken, 'mock', { model: 'nope', modality: 'text' })).statusCode).toBe(403)
  })
})
