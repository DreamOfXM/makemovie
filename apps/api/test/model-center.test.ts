import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decryptSecret } from '@studio/security'
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

interface Connection { id: string; provider: string; name: string; baseUrl: string; apiKeySet?: boolean; accessKeySet?: boolean; capabilities: { id: string; model: string; modality: string }[] }

async function createMockConnection(token: string, name: string, apiKey = 'test-key'): Promise<Connection> {
  const res = await env.app.inject({ method: 'POST', url: '/providers/connections', headers: authHeaders(token), payload: { provider: 'mock', name, apiKey } })
  expect(res.statusCode).toBe(201)
  return res.json() as Connection
}

describe('provider catalogs', () => {
  it('lists catalogs to any authenticated member', async () => {
    const owner = await env.register('mc-catalog@example.com', 'Catalog Org')
    const res = await env.app.inject({ method: 'GET', url: '/providers/catalogs', headers: authHeaders(owner.token) })
    expect(res.statusCode).toBe(200)
    const catalogs = res.json() as { provider: string; defaultBaseUrl?: string; requiresAccessKey?: boolean; models: { model: string }[] }[]
    expect(catalogs.map(c => c.provider).sort()).toEqual(['anthropic', 'dashscope', 'google', 'kling', 'mock', 'openai', 'openai_compatible', 'seedance'])
    const dashscope = catalogs.find(c => c.provider === 'dashscope')!
    expect(dashscope.models.some(m => m.model === 'qwen-max')).toBe(true)
    const seedance = catalogs.find(c => c.provider === 'seedance')!
    expect(seedance.defaultBaseUrl).toBe('https://ark.cn-beijing.volces.com')
    expect(catalogs.find(c => c.provider === 'kling')!.defaultBaseUrl).toBe('https://api-beijing.klingai.com')
    expect(catalogs.filter(c => c.requiresAccessKey).map(c => c.provider)).toEqual(['kling'])
    // A gateway has no host and no model list we could name for the operator, so the
    // form has to demand both instead of pre-filling a guess.
    const gateway = catalogs.find(c => c.provider === 'openai_compatible')!
    expect(gateway.defaultBaseUrl).toBeUndefined()
    expect(gateway.models).toEqual([])
  })

  it('rejects anonymous access', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/providers/catalogs' })
    expect(res.statusCode).toBe(401)
  })
})

describe('provider connections', () => {
  it('creates a connection with catalog capabilities and encrypts the api key', async () => {
    const owner = await env.register('mc-conn@example.com', 'Conn Org')
    const connection = await createMockConnection(owner.token, 'mock-main')
    expect(connection.capabilities.length).toBe(10)

    const stored = await env.db.providerConnection.findUniqueOrThrow({ where: { id: connection.id } })
    expect(stored.encryptedSecret.startsWith('v1.')).toBe(true)
    expect(stored.encryptedSecret).not.toContain('test-key')

    const list = await env.app.inject({ method: 'GET', url: '/providers/connections', headers: authHeaders(owner.token) })
    expect(list.statusCode).toBe(200)
    const body = list.json() as Record<string, unknown>[]
    expect(body[0]).not.toHaveProperty('encryptedSecret')
    expect(body[0].apiKeySet).toBe(true)
  })

  it('creates a seedance connection over its two text-to-video models', async () => {
    const owner = await env.register('mc-seedance@example.com', 'Seedance Org')
    const res = await env.app.inject({
      method: 'POST',
      url: '/providers/connections',
      headers: authHeaders(owner.token),
      payload: { provider: 'seedance', name: 'ark-main', apiKey: 'test-ark-key' },
    })
    expect(res.statusCode).toBe(201)
    const connection = res.json() as Connection
    expect(connection.baseUrl).toBe('https://ark.cn-beijing.volces.com')
    expect(connection.capabilities.map(c => c.model).sort()).toEqual(['doubao-seedance-1-0-pro-250528', 'doubao-seedance-1-5-pro-251215'])
    expect(new Set(connection.capabilities.map(c => c.modality))).toEqual(new Set(['t2v']))

    const stored = await env.db.providerConnection.findUniqueOrThrow({ where: { id: connection.id } })
    expect(stored.encryptedSecret).not.toContain('test-ark-key')
  })

  it('creates a kling connection over its access key + secret key pair and never echoes either half', async () => {
    const owner = await env.register('mc-kling@example.com', 'Kling Org')
    const res = await env.app.inject({
      method: 'POST',
      url: '/providers/connections',
      headers: authHeaders(owner.token),
      payload: { provider: 'kling', name: 'kling-main', apiKey: 'test-sk', accessKey: 'test-ak' },
    })
    expect(res.statusCode).toBe(201)
    const connection = res.json() as Connection
    expect(connection.baseUrl).toBe('https://api-beijing.klingai.com')
    expect(connection.capabilities.map(c => c.model).sort()).toEqual(['kling-v1-6', 'kling-v2-5-turbo'])
    expect(new Set(connection.capabilities.map(c => c.modality))).toEqual(new Set(['t2v']))
    expect(connection.apiKeySet).toBe(true)
    expect(connection.accessKeySet).toBe(true)
    expect(res.payload).not.toContain('test-ak')
    expect(res.payload).not.toContain('test-sk')

    const stored = await env.db.providerConnection.findUniqueOrThrow({ where: { id: connection.id } })
    expect(stored.accessKeyEncrypted?.startsWith('v1.')).toBe(true)
    expect(stored.accessKeyEncrypted).not.toContain('test-ak')
    expect(stored.encryptedSecret).not.toContain('test-sk')

    const list = await env.app.inject({ method: 'GET', url: '/providers/connections', headers: authHeaders(owner.token) })
    const rows = list.json() as Record<string, unknown>[]
    expect(rows[0]).not.toHaveProperty('encryptedSecret')
    expect(rows[0]).not.toHaveProperty('accessKeyEncrypted')
    expect(rows[0].apiKeySet).toBe(true)
    expect(rows[0].accessKeySet).toBe(true)
    expect(list.payload).not.toContain('test-ak')
    expect(list.payload).not.toContain('test-sk')
  })

  it('rejects a kling connection carrying only half of its key pair', async () => {
    const owner = await env.register('mc-kling-half@example.com', 'Kling Half Org')
    const res = await env.app.inject({
      method: 'POST',
      url: '/providers/connections',
      headers: authHeaders(owner.token),
      payload: { provider: 'kling', name: 'kling-no-ak', apiKey: 'test-sk' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('access key + secret key pair')
    expect(await env.db.providerConnection.count({ where: { organizationId: owner.organization.id } })).toBe(0)
  })

  it('creates a single-key connection with no second credential', async () => {
    const owner = await env.register('mc-dashscope@example.com', 'DashScope Org')
    const res = await env.app.inject({
      method: 'POST',
      url: '/providers/connections',
      headers: authHeaders(owner.token),
      payload: { provider: 'dashscope', name: 'bailian-main', apiKey: 'test-key' },
    })
    expect(res.statusCode).toBe(201)
    const connection = res.json() as Connection
    expect(connection.accessKeySet).toBe(false)
    const stored = await env.db.providerConnection.findUniqueOrThrow({ where: { id: connection.id } })
    expect(stored.accessKeyEncrypted).toBeNull()
  })

  it('rotates the access key without touching the secret key', async () => {
    const owner = await env.register('mc-kling-rotate@example.com', 'Kling Rotate Org')
    const created = await env.app.inject({
      method: 'POST',
      url: '/providers/connections',
      headers: authHeaders(owner.token),
      payload: { provider: 'kling', name: 'kling-rotate', apiKey: 'test-sk', accessKey: 'test-ak' },
    })
    const connection = created.json() as Connection
    const before = await env.db.providerConnection.findUniqueOrThrow({ where: { id: connection.id } })

    const res = await env.app.inject({
      method: 'PATCH',
      url: `/providers/connections/${connection.id}`,
      headers: authHeaders(owner.token),
      payload: { accessKey: 'test-ak-rotated' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).not.toHaveProperty('accessKeyEncrypted')
    expect(res.payload).not.toContain('test-ak-rotated')
    expect(res.payload).not.toContain('test-sk')

    const after = await env.db.providerConnection.findUniqueOrThrow({ where: { id: connection.id } })
    expect(after.accessKeyEncrypted).not.toBeNull()
    expect(after.accessKeyEncrypted).not.toBe(before.accessKeyEncrypted)
    expect(decryptSecret(after.accessKeyEncrypted!, env.app.config.masterKey)).toBe('test-ak-rotated')
    expect(after.encryptedSecret).toBe(before.encryptedSecret)
  })

  it('rejects duplicate names, unknown providers and missing keys', async () => {
    const owner = await env.register('mc-dup@example.com', 'Dup Org')
    await createMockConnection(owner.token, 'dup-main')
    const dup = await env.app.inject({ method: 'POST', url: '/providers/connections', headers: authHeaders(owner.token), payload: { provider: 'mock', name: 'dup-main', apiKey: 'k' } })
    expect(dup.statusCode).toBe(409)
    const unknown = await env.app.inject({ method: 'POST', url: '/providers/connections', headers: authHeaders(owner.token), payload: { provider: 'openai-ish', name: 'x', apiKey: 'k' } })
    expect(unknown.statusCode).toBe(400)
    const noKey = await env.app.inject({ method: 'POST', url: '/providers/connections', headers: authHeaders(owner.token), payload: { provider: 'mock', name: 'y' } })
    expect(noKey.statusCode).toBe(400)
  })

  it('requires providers:manage (ADMIN+) to create connections', async () => {
    const owner = await env.register('mc-perm@example.com', 'Perm Org')
    await env.register('mc-editor@example.com', 'Editor Own Org')
    await env.app.inject({ method: 'POST', url: '/members', headers: authHeaders(owner.token), payload: { email: 'mc-editor@example.com', role: 'EDITOR' } })
    const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'mc-editor@example.com', password: 'password123', organizationId: owner.organization.id } })
    const editorToken = login.json().token as string
    const res = await env.app.inject({ method: 'POST', url: '/providers/connections', headers: authHeaders(editorToken), payload: { provider: 'mock', name: 'nope', apiKey: 'k' } })
    expect(res.statusCode).toBe(403)
  })

  it('keeps connections invisible across organizations', async () => {
    const a = await env.register('mc-tenant-a@example.com', 'Tenant A')
    const b = await env.register('mc-tenant-b@example.com', 'Tenant B')
    const connection = await createMockConnection(a.token, 'tenant-main')

    const listB = await env.app.inject({ method: 'GET', url: '/providers/connections', headers: authHeaders(b.token) })
    expect(listB.json()).toEqual([])
    const patchB = await env.app.inject({ method: 'PATCH', url: `/providers/connections/${connection.id}`, headers: authHeaders(b.token), payload: { name: 'hijack' } })
    expect(patchB.statusCode).toBe(404)
    const probeB = await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.id}/probe`, headers: authHeaders(b.token) })
    expect(probeB.statusCode).toBe(404)
  })
})

describe('provider base URLs', () => {
  const create = (token: string, payload: Record<string, string>, app = env.app) =>
    app.inject({ method: 'POST', url: '/providers/connections', headers: authHeaders(token), payload })

  it('refuses an address that would put a request on the worker’s own network', async () => {
    const owner = await env.register('mc-url@example.com', 'Base URL Org')

    const metadata = await create(owner.token, { provider: 'dashscope', name: 'via-metadata', apiKey: 'k', baseUrl: 'http://169.254.169.254' })
    expect(metadata.statusCode).toBe(400)
    expect(metadata.json().error).toContain('private, loopback or link-local')

    const scheme = await create(owner.token, { provider: 'dashscope', name: 'via-file', apiKey: 'k', baseUrl: 'file:///etc/passwd' })
    expect(scheme.statusCode).toBe(400)
    expect(scheme.json().error).toContain('http(s)')

    const credentials = await create(owner.token, { provider: 'dashscope', name: 'via-creds', apiKey: 'k', baseUrl: 'https://user:pw@api.example.com' })
    expect(credentials.statusCode).toBe(400)
    expect(credentials.json().error).toContain('credentials')

    expect(await env.db.providerConnection.count({ where: { organizationId: owner.organization.id } })).toBe(0)
  })

  it('keeps a hand-typed public address exactly as it was entered', async () => {
    const owner = await env.register('mc-url-ok@example.com', 'Base URL OK Org')
    const res = await create(owner.token, { provider: 'dashscope', name: 'own-gateway', apiKey: 'k', baseUrl: 'https://api.example.com/v1' })
    expect(res.statusCode).toBe(201)
    // Adapters append their own path, so a normalising rewrite here would produce a
    // double slash the gateway answers with a 404.
    expect(res.json().baseUrl).toBe('https://api.example.com/v1')
  })

  it('refuses to move a live connection onto loopback unless the operator opted in', async () => {
    const owner = await env.register('mc-url-patch@example.com', 'Base URL Patch Org')
    const created = await create(owner.token, { provider: 'dashscope', name: 'patchable', apiKey: 'k' })
    expect(created.statusCode).toBe(201)
    const connection = created.json() as Connection

    const denied = await env.app.inject({
      method: 'PATCH',
      url: `/providers/connections/${connection.id}`,
      headers: authHeaders(owner.token),
      payload: { baseUrl: 'http://127.0.0.1:18080/v1' },
    })
    expect(denied.statusCode).toBe(400)
    expect(denied.json().error).toContain('STUDIO_ALLOW_PRIVATE_PROVIDER_URLS')

    // The switch is a boot-time operator decision, so the variant app differs by
    // nothing else — same database, same key material.
    const permissive = await buildApp({ config: { ...env.config, allowPrivateProviderUrls: true }, db: env.db, logger: false })
    await permissive.ready()
    try {
      const allowed = await permissive.inject({
        method: 'PATCH',
        url: `/providers/connections/${connection.id}`,
        headers: authHeaders(owner.token),
        payload: { baseUrl: 'http://127.0.0.1:18080/v1' },
      })
      expect(allowed.statusCode).toBe(200)
      expect(allowed.json().baseUrl).toBe('http://127.0.0.1:18080/v1')
    } finally {
      await permissive.close()
    }
  })

  it('leaves the mock provider’s address unchecked, since no request is ever made to it', async () => {
    const owner = await env.register('mc-url-mock@example.com', 'Base URL Mock Org')
    const connection = await createMockConnection(owner.token, 'mock-address')
    expect(connection.baseUrl).toBe('mock://local')

    // The console resends the stored address on every edit, so rejecting it here
    // would make an existing mock connection impossible to rename.
    const renamed = await env.app.inject({
      method: 'PATCH',
      url: `/providers/connections/${connection.id}`,
      headers: authHeaders(owner.token),
      payload: { name: 'mock-address', baseUrl: 'mock://local' },
    })
    expect(renamed.statusCode).toBe(200)
  })
})

describe('entitlement probing', () => {
  it('marks capabilities verified after a successful probe', async () => {
    const owner = await env.register('mc-probe@example.com', 'Probe Org')
    const connection = await createMockConnection(owner.token, 'probe-ok')
    const res = await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.id}/probe`, headers: authHeaders(owner.token) })
    expect(res.statusCode).toBe(200)
    const results = res.json().results as { ok: boolean }[]
    expect(results.every(r => r.ok)).toBe(true)
    const capabilities = await env.db.modelCapability.findMany({ where: { connectionId: connection.id } })
    expect(capabilities.every(c => c.probeStatus === 'verified' && c.entitlementVerifiedAt !== null)).toBe(true)
  })

  it('records failure without granting entitlement for a bad key', async () => {
    const owner = await env.register('mc-probe-bad@example.com', 'Probe Bad Org')
    const connection = await createMockConnection(owner.token, 'probe-bad', 'invalid')
    const res = await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.id}/probe`, headers: authHeaders(owner.token) })
    expect(res.statusCode).toBe(200)
    const results = res.json().results as { ok: boolean; status: number }[]
    expect(results.every(r => !r.ok && r.status === 401)).toBe(true)
    const capabilities = await env.db.modelCapability.findMany({ where: { connectionId: connection.id } })
    expect(capabilities.every(c => c.probeStatus === 'failed' && c.entitlementVerifiedAt === null)).toBe(true)
    const stored = await env.db.providerConnection.findUniqueOrThrow({ where: { id: connection.id } })
    expect(stored.lastError).toBeTruthy()
  })
})

describe('models entered by hand', () => {
  const addModel = (token: string, connectionId: string, payload: Record<string, unknown>) =>
    env.app.inject({ method: 'POST', url: `/providers/connections/${connectionId}/models`, headers: authHeaders(token), payload })

  it('refuses a gateway connection with no host to point at', async () => {
    const owner = await env.register('mc-gateway@example.com', 'Gateway Org')
    const res = await env.app.inject({
      method: 'POST', url: '/providers/connections', headers: authHeaders(owner.token),
      payload: { provider: 'openai_compatible', name: 'vllm-local', apiKey: 'k' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('baseUrl is required')

    const filled = await env.app.inject({
      method: 'POST', url: '/providers/connections', headers: authHeaders(owner.token),
      payload: { provider: 'openai_compatible', name: 'vllm-local', apiKey: 'k', baseUrl: 'http://127.0.0.1:8000/v1' },
    })
    // A gateway is a socket the worker will actually open, so the address guard that
    // skips the mock provider applies here — a local vLLM needs the operator's opt-in.
    expect(filled.statusCode).toBe(400)
    expect(filled.json().error).toContain('STUDIO_ALLOW_PRIVATE_PROVIDER_URLS')

    const permissive = await buildApp({ config: { ...env.config, allowPrivateProviderUrls: true }, db: env.db, logger: false })
    await permissive.ready()
    try {
      const opened = await permissive.inject({
        method: 'POST', url: '/providers/connections', headers: authHeaders(owner.token),
        payload: { provider: 'openai_compatible', name: 'vllm-typed', apiKey: 'k', baseUrl: 'http://127.0.0.1:8000/v1' },
      })
      expect(opened.statusCode).toBe(201)
      expect(opened.json().capabilities).toEqual([])
      expect(opened.json().baseUrl).toBe('http://127.0.0.1:8000/v1')
    } finally {
      await permissive.close()
    }
  })

  it('accepts a named model, refuses to repeat one, and rejects a modality we do not speak', async () => {
    const owner = await env.register('mc-add@example.com', 'Add Model Org')
    const connection = await createMockConnection(owner.token, 'add-main')
    expect(connection.capabilities).toHaveLength(10)

    const added = await addModel(owner.token, connection.id, { model: '  qwen2.5-72b-instruct  ', modality: 'text', displayName: 'Lab Qwen' })
    expect(added.statusCode).toBe(201)
    expect(added.json()).toMatchObject({ model: 'qwen2.5-72b-instruct', displayName: 'Lab Qwen', modality: 'text', acceptsFirstFrame: false, maxReferenceImages: 0, probeStatus: 'unverified' })

    const listed = await env.app.inject({ method: 'GET', url: '/providers/connections', headers: authHeaders(owner.token) })
    const rows = listed.json() as Connection[]
    expect(rows.find(c => c.id === connection.id)!.capabilities.map(c => c.model)).toContain('qwen2.5-72b-instruct')

    const again = await addModel(owner.token, connection.id, { model: 'qwen2.5-72b-instruct', modality: 'text' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toContain('already configured on this connection')

    // Same name on another connection is a different model on a different host.
    const other = await createMockConnection(owner.token, 'add-alt')
    expect((await addModel(owner.token, other.id, { model: 'qwen2.5-72b-instruct', modality: 'text' })).statusCode).toBe(201)

    expect((await addModel(owner.token, connection.id, { modality: 'text' })).statusCode).toBe(400)
    const badModality = await addModel(owner.token, connection.id, { model: 'm', modality: 'video' })
    expect(badModality.statusCode).toBe(400)
    expect(badModality.json().error).toContain('r2v')
    expect((await addModel(owner.token, connection.id, { model: 'x'.repeat(121), modality: 'text' })).statusCode).toBe(400)
  })

  it('refuses to store reference-input claims about a model that cannot take them', async () => {
    const owner = await env.register('mc-flags@example.com', 'Flags Org')
    const connection = await createMockConnection(owner.token, 'flags-main')

    // Silently dropping the flag would leave a row that fails at generation time with
    // a message about reference media, several steps away from where it was set.
    const onText = await addModel(owner.token, connection.id, { model: 'claim-text', modality: 'text', acceptsFirstFrame: true })
    expect(onText.statusCode).toBe(400)
    expect(onText.json().error).toMatch(/not a "text" one/)
    const tooMany = await addModel(owner.token, connection.id, { model: 'claim-i2v', modality: 'i2v', maxReferenceImages: 9 })
    expect(tooMany.statusCode).toBe(400)
    expect(tooMany.json().error).toMatch(/between 0 and 8/)

    const honest = await addModel(owner.token, connection.id, { model: 'claim-r2v', modality: 'r2v', acceptsReferenceImages: true, maxReferenceImages: 3 })
    expect(honest.statusCode).toBe(201)
    expect(honest.json()).toMatchObject({ modality: 'r2v', acceptsReferenceImages: true, maxReferenceImages: 3 })
    expect(await env.db.modelCapability.count({ where: { connectionId: connection.id } })).toBe(11)
  })

  it('blocks deleting a row a slot still points at, then lets it go', async () => {
    const owner = await env.register('mc-delmodel@example.com', 'Delete Model Org')
    const connection = await createMockConnection(owner.token, 'delmodel-main')
    await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.id}/probe`, headers: authHeaders(owner.token) })
    const added = await addModel(owner.token, connection.id, { model: 'mock-disposable', modality: 'text' })
    const capabilityId = added.json().id as string
    await env.app.inject({ method: 'POST', url: `/providers/capabilities/${capabilityId}/probe`, headers: authHeaders(owner.token) })

    const bind = await env.app.inject({ method: 'POST', url: '/bindings', headers: authHeaders(owner.token), payload: { slot: 'script_text', capabilityId } })
    expect(bind.statusCode).toBe(201)

    const blocked = await env.app.inject({ method: 'DELETE', url: `/providers/capabilities/${capabilityId}`, headers: authHeaders(owner.token) })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error).toMatch(/still bound to 1 slot/)

    expect((await env.app.inject({ method: 'DELETE', url: `/bindings/${bind.json().id}`, headers: authHeaders(owner.token) })).statusCode).toBe(204)
    expect((await env.app.inject({ method: 'DELETE', url: `/providers/capabilities/${capabilityId}`, headers: authHeaders(owner.token) })).statusCode).toBe(204)
    expect(await env.db.modelCapability.findUnique({ where: { id: capabilityId } })).toBeNull()
    // Deleting a whole connection still has to reach the rows the catalog never offered.
    expect((await env.app.inject({ method: 'DELETE', url: `/providers/connections/${connection.id}`, headers: authHeaders(owner.token) })).statusCode).toBe(204)
  })

  it('keeps another organisation’s rows invisible to both write routes', async () => {
    const a = await env.register('mc-model-tenant-a@example.com', 'Model Tenant A')
    const b = await env.register('mc-model-tenant-b@example.com', 'Model Tenant B')
    const connection = await createMockConnection(a.token, 'model-tenant-main')
    const capabilityId = connection.capabilities.find(c => c.model === 'mock-text')!.id

    expect((await addModel(b.token, connection.id, { model: 'mock-sneak', modality: 'text' })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'POST', url: `/providers/capabilities/${capabilityId}/probe`, headers: authHeaders(b.token) })).statusCode).toBe(404)
    expect((await env.app.inject({ method: 'DELETE', url: `/providers/capabilities/${capabilityId}`, headers: authHeaders(b.token) })).statusCode).toBe(404)
    expect((await addModel(a.token, 'does-not-exist', { model: 'mock-x', modality: 'text' })).statusCode).toBe(404)
    expect(await env.db.modelCapability.count({ where: { connectionId: connection.id } })).toBe(10)
  })
})

describe('per-model verification', () => {
  const probeModel = (token: string, capabilityId: string) =>
    env.app.inject({ method: 'POST', url: `/providers/capabilities/${capabilityId}/probe`, headers: authHeaders(token) })

  it('verifies one model at a time and makes only that row bindable', async () => {
    const owner = await env.register('mc-single@example.com', 'Single Probe Org')
    const connection = await createMockConnection(owner.token, 'single-main')
    const added = await env.app.inject({
      method: 'POST', url: `/providers/connections/${connection.id}/models`, headers: authHeaders(owner.token),
      payload: { model: 'mock-entered', modality: 'text' },
    })
    const capabilityId = added.json().id as string

    const unverified = await env.app.inject({ method: 'POST', url: '/bindings', headers: authHeaders(owner.token), payload: { slot: 'script_text', capabilityId } })
    expect(unverified.statusCode).toBe(422)
    expect(unverified.json().error).toMatch(/no verified entitlement/)

    const probed = await probeModel(owner.token, capabilityId)
    expect(probed.statusCode).toBe(200)
    expect(probed.json()).toMatchObject({ ok: true, model: 'mock-entered', modality: 'text' })

    expect((await env.app.inject({ method: 'POST', url: '/bindings', headers: authHeaders(owner.token), payload: { slot: 'script_text', capabilityId } })).statusCode).toBe(201)
    // The connection-wide probe stamps every row at once; this one may not.
    const rows = await env.db.modelCapability.findMany({ where: { connectionId: connection.id } })
    expect(rows.find(r => r.id === capabilityId)!.entitlementVerifiedAt).toBeTruthy()
    expect(rows.filter(r => r.id !== capabilityId).every(r => r.entitlementVerifiedAt === null)).toBe(true)
  })

  it('records a model the endpoint denies as failed and drops the belief in it', async () => {
    const owner = await env.register('mc-deny@example.com', 'Deny Org')
    const connection = await createMockConnection(owner.token, 'deny-main')
    await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.id}/probe`, headers: authHeaders(owner.token) })
    const added = await env.app.inject({
      method: 'POST', url: `/providers/connections/${connection.id}/models`, headers: authHeaders(owner.token),
      payload: { model: 'typo-model-name', modality: 'text' },
    })
    const capabilityId = added.json().id as string
    await env.db.modelCapability.update({ where: { id: capabilityId }, data: { entitlementVerifiedAt: new Date() } })

    const probed = await probeModel(owner.token, capabilityId)
    expect(probed.statusCode).toBe(200)
    expect(probed.json()).toMatchObject({ ok: false, status: 404, modelMissing: true })
    expect(probed.json().message).toMatch(/is not served by this endpoint/)

    const row = await env.db.modelCapability.findUniqueOrThrow({ where: { id: capabilityId } })
    expect(row.probeStatus).toBe('failed')
    expect(row.entitlementVerifiedAt).toBeNull()
    // Evidence about one name, not about the line: the catalog rows keep their stamp.
    const kept = await env.db.modelCapability.findFirstOrThrow({ where: { connectionId: connection.id, model: 'mock-text' } })
    expect(kept.entitlementVerifiedAt).toBeTruthy()
    const stored = await env.db.providerConnection.findUniqueOrThrow({ where: { id: connection.id } })
    expect(stored.lastError).toContain('typo-model-name')
  })

  it('refuses to spend money or invent a green light for a model it cannot ask about', async () => {
    const owner = await env.register('mc-refuse@example.com', 'Refuse Org')
    const connection = await createMockConnection(owner.token, 'refuse-main')
    const video = connection.capabilities.find(c => c.model === 'mock-t2v')!

    const spendable = await probeModel(owner.token, video.id)
    expect(spendable.statusCode).toBe(400)
    expect(spendable.json().error).toMatch(/cannot be probed without spending on it/)
    const untouched = await env.db.modelCapability.findUniqueOrThrow({ where: { id: video.id } })
    expect(untouched.probeStatus).toBe('unverified')
    expect(untouched.lastProbedAt).toBeNull()

    // A seedance connection can carry a hand-entered text row, and that vendor has no
    // request that names a model without generating from it.
    const seedance = await env.app.inject({
      method: 'POST', url: '/providers/connections', headers: authHeaders(owner.token),
      payload: { provider: 'seedance', name: 'refuse-ark', apiKey: 'test-ark-key' },
    })
    const entered = await env.app.inject({
      method: 'POST', url: `/providers/connections/${seedance.json().id}/models`, headers: authHeaders(owner.token),
      payload: { model: 'ark-text-pro', modality: 'text' },
    })
    expect(entered.statusCode).toBe(201)
    const noAsk = await probeModel(owner.token, entered.json().id as string)
    expect(noAsk.statusCode).toBe(400)
    expect(noAsk.json().error).toMatch(/names a single model without generating from it/)
  })

  it('will not verify a model on a connection the operator turned off', async () => {
    const owner = await env.register('mc-off@example.com', 'Off Org')
    const connection = await createMockConnection(owner.token, 'off-main')
    const capabilityId = connection.capabilities.find(c => c.model === 'mock-text')!.id
    await env.app.inject({ method: 'PATCH', url: `/providers/connections/${connection.id}`, headers: authHeaders(owner.token), payload: { enabled: false } })
    expect((await probeModel(owner.token, capabilityId)).statusCode).toBe(409)
  })
})

describe('capability slot bindings', () => {
  it('refuses unverified capabilities and modality mismatches, binds verified ones', async () => {
    const owner = await env.register('mc-bind@example.com', 'Bind Org')
    const connection = await createMockConnection(owner.token, 'bind-main')

    const unverified = await env.app.inject({
      method: 'POST', url: '/bindings', headers: authHeaders(owner.token),
      payload: { slot: 'video_i2v', capabilityId: connection.capabilities.find(c => c.model === 'mock-i2v')!.id },
    })
    expect(unverified.statusCode).toBe(422)
    expect(unverified.json().error).toMatch(/verified entitlement/)

    await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.id}/probe`, headers: authHeaders(owner.token) })

    const mismatch = await env.app.inject({
      method: 'POST', url: '/bindings', headers: authHeaders(owner.token),
      payload: { slot: 'video_i2v', capabilityId: connection.capabilities.find(c => c.model === 'mock-t2v')!.id },
    })
    expect(mismatch.statusCode).toBe(422)
    expect(mismatch.json().error).toMatch(/requires modality/)

    const badSlot = await env.app.inject({ method: 'POST', url: '/bindings', headers: authHeaders(owner.token), payload: { slot: 'not_a_slot', capabilityId: 'x' } })
    expect(badSlot.statusCode).toBe(400)

    const ok = await env.app.inject({
      method: 'POST', url: '/bindings', headers: authHeaders(owner.token),
      payload: { slot: 'video_i2v', capabilityId: connection.capabilities.find(c => c.model === 'mock-i2v')!.id, priority: 10 },
    })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().slot).toBe('video_i2v')

    const dup = await env.app.inject({
      method: 'POST', url: '/bindings', headers: authHeaders(owner.token),
      payload: { slot: 'video_i2v', capabilityId: connection.capabilities.find(c => c.model === 'mock-i2v')!.id },
    })
    expect(dup.statusCode).toBe(409)
  })

  it('resolves ordered candidates with project overrides beating org scope', async () => {
    const owner = await env.register('mc-resolve@example.com', 'Resolve Org')
    const main = await createMockConnection(owner.token, 'resolve-main')
    const alt = await createMockConnection(owner.token, 'resolve-alt')
    await env.app.inject({ method: 'POST', url: `/providers/connections/${main.id}/probe`, headers: authHeaders(owner.token) })
    await env.app.inject({ method: 'POST', url: `/providers/connections/${alt.id}/probe`, headers: authHeaders(owner.token) })
    const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(owner.token), payload: { name: 'Resolve Drama' } })
    const projectId = project.json().id as string

    const capId = (connection: Connection, model: string) => connection.capabilities.find(c => c.model === model)!.id
    const bind = (slot: string, capabilityId: string, projectId?: string, priority = 0) =>
      env.app.inject({ method: 'POST', url: '/bindings', headers: authHeaders(owner.token), payload: { slot, capabilityId, projectId, priority } })

    expect((await bind('video_t2v', capId(main, 'mock-t2v'), undefined, 5)).statusCode).toBe(201)
    const mismatch = await bind('video_t2v', capId(main, 'mock-i2v'), undefined, 50)
    expect(mismatch.statusCode).toBe(422) // i2v cannot fill a t2v slot even at high priority
    expect((await bind('video_t2v', capId(alt, 'mock-t2v'), projectId, 1)).statusCode).toBe(201)

    const orgResolve = await env.app.inject({ method: 'GET', url: '/bindings/resolve?slot=video_t2v', headers: authHeaders(owner.token) })
    expect(orgResolve.statusCode).toBe(200)
    const orgCandidates = orgResolve.json().candidates as { model: string; scope: string; capabilityId: string }[]
    expect(orgCandidates.map(c => [c.model, c.scope, c.capabilityId])).toEqual([['mock-t2v', 'organization', capId(main, 'mock-t2v')]])

    const projectResolve = await env.app.inject({ method: 'GET', url: `/bindings/resolve?slot=video_t2v&projectId=${projectId}`, headers: authHeaders(owner.token) })
    const projectCandidates = projectResolve.json().candidates as { scope: string; capabilityId: string }[]
    expect(projectCandidates.map(c => [c.scope, c.capabilityId])).toEqual([
      ['project', capId(alt, 'mock-t2v')],
      ['organization', capId(main, 'mock-t2v')],
    ])

    const badSlot = await env.app.inject({ method: 'GET', url: '/bindings/resolve?slot=bogus', headers: authHeaders(owner.token) })
    expect(badSlot.statusCode).toBe(400)
  })

  it('blocks deleting a connection that still has bindings, then unbinds and deletes', async () => {
    const owner = await env.register('mc-delete@example.com', 'Delete Org')
    const connection = await createMockConnection(owner.token, 'delete-main')
    await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.id}/probe`, headers: authHeaders(owner.token) })
    const capId = connection.capabilities.find(c => c.model === 'mock-text')!.id
    const bind = await env.app.inject({ method: 'POST', url: '/bindings', headers: authHeaders(owner.token), payload: { slot: 'script_text', capabilityId: capId } })
    expect(bind.statusCode).toBe(201)

    const blocked = await env.app.inject({ method: 'DELETE', url: `/providers/connections/${connection.id}`, headers: authHeaders(owner.token) })
    expect(blocked.statusCode).toBe(409)

    const unbind = await env.app.inject({ method: 'DELETE', url: `/bindings/${bind.json().id}`, headers: authHeaders(owner.token) })
    expect(unbind.statusCode).toBe(204)
    const del = await env.app.inject({ method: 'DELETE', url: `/providers/connections/${connection.id}`, headers: authHeaders(owner.token) })
    expect(del.statusCode).toBe(204)
  })

  it('records binding and provider mutations in the audit trail', async () => {
    const owner = await env.register('mc-audit@example.com', 'Audit MC Org')
    const connection = await createMockConnection(owner.token, 'audit-main')
    await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.id}/probe`, headers: authHeaders(owner.token) })
    await env.app.inject({
      method: 'POST', url: '/bindings', headers: authHeaders(owner.token),
      payload: { slot: 'script_text', capabilityId: connection.capabilities.find(c => c.model === 'mock-text')!.id },
    })
    const audit = await env.app.inject({ method: 'GET', url: '/audit-events', headers: authHeaders(owner.token) })
    const actions = (audit.json().events as { action: string }[]).map(e => e.action)
    expect(actions).toContain('provider.create')
    expect(actions).toContain('provider.probe')
    expect(actions).toContain('binding.create')
  })
})

interface ResolveCandidate {
  bindingId: string
  scope: string
  priority: number
  capabilityId: string
  connectionId: string
  provider: string
  connectionName: string
  model: string
  displayName: string
  modality: string
}

interface ResolveBody {
  slot: string
  projectId: string | null
  candidates: ResolveCandidate[]
}

describe('candidate resolution filtering', () => {
  it('drops unverified, disabled and duplicate candidates, keeping project scope first', async () => {
    const owner = await env.register('mc-filter@example.com', 'Filter Org')
    const main = await createMockConnection(owner.token, 'filter-main')
    const alt = await createMockConnection(owner.token, 'filter-alt')
    const dark = await createMockConnection(owner.token, 'filter-dark')
    const stale = await createMockConnection(owner.token, 'filter-stale')
    for (const connection of [main, alt, dark, stale]) {
      await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.id}/probe`, headers: authHeaders(owner.token) })
    }
    const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(owner.token), payload: { name: 'Filter Drama' } })
    const projectId = project.json().id as string

    const capId = (connection: Connection) => connection.capabilities.find(c => c.model === 'mock-t2v')!.id
    const bind = (capabilityId: string, scope: string | undefined, priority: number, enabled = true) =>
      env.app.inject({
        method: 'POST', url: '/bindings', headers: authHeaders(owner.token),
        payload: { slot: 'video_t2v', capabilityId, projectId: scope, priority, enabled },
      })

    expect((await bind(capId(alt), projectId, 9)).statusCode).toBe(201)
    expect((await bind(capId(main), projectId, 1)).statusCode).toBe(201)
    // Org scope: a duplicate of a project-scoped capability, a disabled binding, a
    // capability on a disabled connection, and a capability that lost its entitlement.
    expect((await bind(capId(main), undefined, 5)).statusCode).toBe(201)
    expect((await bind(capId(alt), undefined, 50, false)).statusCode).toBe(201)
    expect((await bind(capId(dark), undefined, 100)).statusCode).toBe(201)
    expect((await bind(capId(stale), undefined, 80)).statusCode).toBe(201)

    await env.app.inject({ method: 'PATCH', url: `/providers/connections/${dark.id}`, headers: authHeaders(owner.token), payload: { enabled: false } })
    await env.db.modelCapability.update({ where: { id: capId(stale) }, data: { entitlementVerifiedAt: null } })

    const scoped = await env.app.inject({ method: 'GET', url: `/bindings/resolve?slot=video_t2v&projectId=${projectId}`, headers: authHeaders(owner.token) })
    expect(scoped.statusCode).toBe(200)
    const scopedBody = scoped.json() as ResolveBody
    expect(scopedBody.slot).toBe('video_t2v')
    expect(scopedBody.projectId).toBe(projectId)
    expect(scopedBody.candidates.map(c => [c.scope, c.priority, c.connectionName])).toEqual([
      ['project', 9, 'filter-alt'],
      ['project', 1, 'filter-main'],
    ])

    // Without a project the project-scoped bindings vanish and the org-scoped
    // duplicate is the only survivor: the disabled, unverified and turned-off ones stay out.
    const orgWide = await env.app.inject({ method: 'GET', url: '/bindings/resolve?slot=video_t2v', headers: authHeaders(owner.token) })
    const orgBody = orgWide.json() as ResolveBody
    expect(orgBody.projectId).toBeNull()
    expect(orgBody.candidates.map(c => [c.scope, c.priority, c.connectionName])).toEqual([['organization', 5, 'filter-main']])

    // The console renders every one of these; a refactor must not drop a field.
    // connectionId is the one addition: the shared resolver returns what the
    // worker needs too, and the id is already exposed by GET /bindings.
    const [candidate] = scopedBody.candidates
    expect(Object.keys(candidate).sort()).toEqual([
      'bindingId', 'capabilityId', 'connectionId', 'connectionName', 'displayName', 'modality', 'model', 'priority', 'provider', 'scope',
    ])
    expect(candidate).toMatchObject({
      scope: 'project',
      priority: 9,
      capabilityId: capId(alt),
      connectionId: alt.id,
      provider: 'mock',
      connectionName: 'filter-alt',
      model: 'mock-t2v',
      displayName: 'Mock T2V',
      modality: 't2v',
    })
    expect(candidate.bindingId).toBeTruthy()
  })
})
