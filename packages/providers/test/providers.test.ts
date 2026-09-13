import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { ModelCapability } from '@studio/domain'
import {
  buildCredentialProbeRequest,
  buildPollRequest,
  buildSubmitRequest,
  createAdapter,
  DashScopeAdapter,
  getCatalog,
  isKnownProvider,
  listCatalogs,
  MockProviderAdapter,
  resetMockTasks,
  sanitizeError,
  validateReferenceRequest,
} from '../src/index.js'

function capability(partial: Partial<ModelCapability> & { modality: ModelCapability['modality'] }): ModelCapability {
  return {
    provider: 'dashscope',
    model: 'test-model',
    acceptsFirstFrame: false,
    acceptsReferenceImages: false,
    maxReferenceImages: 0,
    ...partial,
  }
}

describe('catalog', () => {
  it('lists dashscope and mock catalogs', () => {
    const providers = listCatalogs().map(c => c.provider).sort()
    expect(providers).toEqual(['dashscope', 'mock'])
    expect(isKnownProvider('dashscope')).toBe(true)
    expect(isKnownProvider('nope')).toBe(false)
  })

  it('dashscope catalog only contains modalities with public endpoints', () => {
    const catalog = getCatalog('dashscope')
    expect(catalog).toBeDefined()
    const modalities = new Set(catalog!.models.map(m => m.modality))
    expect(modalities.has('text')).toBe(true)
    expect(modalities.has('image')).toBe(true)
    expect(modalities.has('t2v')).toBe(true)
    expect(modalities.has('i2v')).toBe(true)
    expect(modalities.has('r2v')).toBe(false)
    expect(modalities.has('tts')).toBe(false)
  })

  it('every i2v catalog model accepts a first frame', () => {
    for (const catalog of listCatalogs()) {
      for (const model of catalog.models.filter(m => m.modality === 'i2v')) {
        expect(model.acceptsFirstFrame).toBe(true)
      }
    }
  })

  it('mock catalog covers every modality', () => {
    const modalities = new Set(getCatalog('mock')!.models.map(m => m.modality))
    expect(modalities).toEqual(new Set(['text', 'vlm', 'image', 't2v', 'i2v', 'r2v', 'tts', 'music']))
  })
})

describe('createAdapter', () => {
  it('creates known adapters and rejects unknown providers', () => {
    expect(createAdapter('mock', { apiKey: 'k', baseUrl: 'mock://local' })).toBeInstanceOf(MockProviderAdapter)
    expect(createAdapter('dashscope', { apiKey: 'k', baseUrl: 'https://dashscope.aliyuncs.com' }).provider).toBe('dashscope')
    expect(() => createAdapter('unknown', { apiKey: 'k', baseUrl: '' })).toThrow(/unknown provider/)
  })
})

describe('mock adapter lifecycle', () => {
  beforeEach(() => resetMockTasks())

  it('probes ok with a valid key and 401 with "invalid"', async () => {
    const ok = new MockProviderAdapter({ apiKey: 'key', baseUrl: 'mock://local' })
    const bad = new MockProviderAdapter({ apiKey: 'invalid', baseUrl: 'mock://local' })
    const cap = capability({ modality: 't2v' })
    expect((await ok.probe(cap)).ok).toBe(true)
    const failed = await bad.probe(cap)
    expect(failed.ok).toBe(false)
    expect(failed.status).toBe(401)
  })

  it('submit then poll: running first, completed second', async () => {
    const adapter = new MockProviderAdapter({ apiKey: 'key', baseUrl: 'mock://local' })
    const cap = capability({ provider: 'mock', model: 'mock-i2v', modality: 'i2v', acceptsFirstFrame: true })
    const { taskId } = await adapter.submit(cap, { model: 'mock-i2v', input: {}, parameters: {} })
    expect((await adapter.poll(cap, taskId)).status).toBe('running')
    const done = await adapter.poll(cap, taskId)
    expect(done.status).toBe('completed')
    expect(done.artifactUrl).toBe(`mock://artifacts/${taskId}/i2v`)
  })

  it('poll of unknown task fails', async () => {
    const adapter = new MockProviderAdapter({ apiKey: 'key', baseUrl: 'mock://local' })
    const result = await adapter.poll(capability({ modality: 'text' }), 'missing')
    expect(result.status).toBe('failed')
  })
})

describe('validateReferenceRequest', () => {
  it('rejects reference media on t2v', () => {
    expect(() => validateReferenceRequest(capability({ modality: 't2v' }), { media: ['a.png'] })).toThrow(/T2V cannot receive reference media/)
  })

  it('requires reference media on i2v and r2v', () => {
    expect(() => validateReferenceRequest(capability({ modality: 'i2v' }), {})).toThrow(/require reference media/)
    expect(() => validateReferenceRequest(capability({ modality: 'r2v' }), { media: [] })).toThrow(/require reference media/)
  })

  it('rejects media beyond maxReferenceImages', () => {
    const cap = capability({ modality: 'r2v', acceptsReferenceImages: true, maxReferenceImages: 2 })
    expect(() => validateReferenceRequest(cap, { media: ['a', 'b', 'c'] })).toThrow(/exceeds model capability/)
    expect(() => validateReferenceRequest(cap, { media: ['a', 'b'] })).not.toThrow()
  })
})

describe('dashscope request building', () => {
  const base = 'https://dashscope.aliyuncs.com'

  it('builds a synchronous text request', () => {
    const req = buildSubmitRequest(base, 'sk-test', capability({ modality: 'text', model: 'qwen-max' }), {
      model: 'qwen-max',
      input: { messages: [{ role: 'user', content: 'hello' }] },
      parameters: { result_format: 'message' },
    })
    expect(req.url).toBe(`${base}/api/v1/services/aigc/text-generation/generation`)
    expect(req.headers.Authorization).toBe('Bearer sk-test')
    expect(req.headers['X-DashScope-Async']).toBeUndefined()
    expect(req.body).toMatchObject({ model: 'qwen-max', input: { messages: [{ role: 'user', content: 'hello' }] } })
  })

  it('falls back to prompt-as-user-message for text', () => {
    const req = buildSubmitRequest(base, 'sk-test', capability({ modality: 'text' }), {
      model: 'qwen-plus',
      input: { prompt: 'write episode 1' },
      parameters: {},
    })
    const body = req.body as { input: { messages: Array<{ role: string; content: string }> } }
    expect(body.input.messages).toEqual([{ role: 'user', content: 'write episode 1' }])
  })

  it('builds an async image request', () => {
    const req = buildSubmitRequest(base, 'sk-test', capability({ modality: 'image', model: 'wanx2.1-t2i-turbo' }), {
      model: 'wanx2.1-t2i-turbo',
      input: { prompt: 'a rainy street' },
      parameters: { size: '1024*1024', n: 1 },
    })
    expect(req.url).toBe(`${base}/api/v1/services/aigc/text2image/image-synthesis`)
    expect(req.headers['X-DashScope-Async']).toBe('enable')
    expect(req.body).toMatchObject({ input: { prompt: 'a rainy street' }, parameters: { size: '1024*1024' } })
  })

  it('builds an i2v request with img_url and rejects missing first frame', () => {
    const cap = capability({ modality: 'i2v', model: 'wanx2.1-i2v-turbo', acceptsFirstFrame: true })
    const req = buildSubmitRequest(base, 'sk-test', cap, {
      model: 'wanx2.1-i2v-turbo',
      input: { prompt: 'camera pans left', firstFrameUrl: 'https://cdn/first.png' },
      parameters: {},
    })
    expect(req.url).toBe(`${base}/api/v1/services/aigc/video-generation/video-synthesis`)
    expect(req.body).toMatchObject({ input: { img_url: 'https://cdn/first.png' } })
    expect(() => buildSubmitRequest(base, 'sk-test', cap, { model: 'wanx2.1-i2v-turbo', input: { prompt: 'x' }, parameters: {} }))
      .toThrow(/firstFrameUrl/)
  })

  it('rejects modalities without a public dashscope endpoint', () => {
    expect(() => buildSubmitRequest(base, 'k', capability({ modality: 'tts' }), { model: 'm', input: {}, parameters: {} }))
      .toThrow(/does not support modality/)
    expect(() => buildSubmitRequest(base, 'k', capability({ modality: 'r2v' }), { model: 'm', input: {}, parameters: {} }))
      .toThrow(/does not support modality/)
  })

  it('builds a poll request against the task endpoint', () => {
    const req = buildPollRequest(`${base}/`, 'sk-test', 'task-123')
    expect(req.url).toBe(`${base}/api/v1/tasks/task-123`)
    expect(req.method).toBe('GET')
    expect(req.headers.Authorization).toBe('Bearer sk-test')
  })

  it('builds a credential probe against the text endpoint for any capability', () => {
    const req = buildCredentialProbeRequest(`${base}/`, 'sk-test')
    expect(req.url).toBe(`${base}/api/v1/services/aigc/text-generation/generation`)
    expect(req.body).toMatchObject({ model: 'qwen-turbo', parameters: { max_tokens: 1 } })
    expect(req.headers['X-DashScope-Async']).toBeUndefined()
  })
})

describe('dashscope adapter probe', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function adapter(apiKey = 'sk-test'): DashScopeAdapter {
    return new DashScopeAdapter({ apiKey, baseUrl: 'https://dashscope.aliyuncs.com' })
  }

  /** The catalog the way a connection materialises it: every model, defaults filled in. */
  function catalogCapabilities(): ModelCapability[] {
    const catalog = getCatalog('dashscope')!
    return catalog.models.map(model => ({
      provider: catalog.provider,
      model: model.model,
      modality: model.modality,
      acceptsFirstFrame: model.acceptsFirstFrame ?? false,
      acceptsReferenceImages: model.acceptsReferenceImages ?? false,
      maxReferenceImages: model.maxReferenceImages ?? 0,
    }))
  }

  it('probes every catalog model, including ones with no dashscope endpoint', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    const capabilities = catalogCapabilities()
    const results = await Promise.all(capabilities.map(item => adapter().probe(item)))
    expect(results.every(result => result.ok)).toBe(true)
    expect(results[0].message).toContain(capabilities[0].model)
  })

  it('verifies the shared credential once, not once per capability', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    const prober = adapter()
    await Promise.all(catalogCapabilities().map(item => prober.probe(item)))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('/text-generation/generation')
  })

  it('reports the provider error for every capability when the key is rejected', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ code: 'InvalidApiKey', message: 'bad key', request_id: 'r-1' }),
    })
    const results = await Promise.all(catalogCapabilities().map(item => adapter().probe(item)))
    expect(results.every(result => !result.ok && result.status === 401)).toBe(true)
    expect(results[0].message).toBe('InvalidApiKey | bad key | request_id=r-1')
  })

  it('survives an unreachable endpoint', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'))
    const result = await adapter().probe(capability({ modality: 'i2v', acceptsFirstFrame: true }))
    expect(result).toEqual({ ok: false, status: 0, message: 'fetch failed' })
  })
})

describe('sanitizeError', () => {
  it('formats dashscope error bodies', () => {
    expect(sanitizeError({ code: 'InvalidApiKey', message: 'bad key', request_id: 'r-1' }))
      .toBe('InvalidApiKey | bad key | request_id=r-1')
  })

  it('truncates unknown payloads', () => {
    expect(sanitizeError('x'.repeat(600))).toHaveLength(500)
  })
})
