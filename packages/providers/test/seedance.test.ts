import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { ModelCapability } from '@studio/domain'
import {
  buildSeedancePollRequest,
  buildSeedanceProbeRequest,
  buildSeedanceSubmitRequest,
  extractSeedanceVideoUrl,
  mergeSeedanceParameters,
  normalizeSeedanceStatus,
  SEEDANCE_DEFAULT_BASE_URL,
  SeedanceAdapter,
} from '../src/seedance.js'

const base = SEEDANCE_DEFAULT_BASE_URL
const API_KEY = 'test-ark-key'

function capability(partial: Partial<ModelCapability> & { modality: ModelCapability['modality'] }): ModelCapability {
  return {
    provider: 'seedance',
    model: 'doubao-seedance-1-0-pro-250528',
    acceptsFirstFrame: false,
    acceptsReferenceImages: false,
    maxReferenceImages: 0,
    ...partial,
  }
}

function t2v(): ModelCapability {
  return capability({ modality: 't2v' })
}

function request(overrides: Partial<{ model: string; input: Record<string, unknown>; parameters: Record<string, unknown> }> = {}) {
  return {
    model: overrides.model ?? 'doubao-seedance-1-0-pro-250528',
    input: overrides.input ?? { prompt: 'rain-soaked street at night, neon reflections' },
    parameters: overrides.parameters ?? {},
  }
}

function adapter(apiKey = API_KEY): SeedanceAdapter {
  return new SeedanceAdapter({ apiKey, baseUrl: base })
}

function jsonResponse(status: number, body: unknown, ok = status < 400) {
  return { ok, status, statusText: ok ? 'OK' : 'Error', json: async () => body }
}

describe('seedance request building', () => {
  it('builds the t2v submit body as model plus a content array', () => {
    const req = buildSeedanceSubmitRequest(base, API_KEY, t2v(), request())
    expect(req.url).toBe(`${base}/api/v3/contents/generations/tasks`)
    expect(req.method).toBe('POST')
    expect(req.headers).toEqual({ Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' })
    expect(req.body).toEqual({
      model: 'doubao-seedance-1-0-pro-250528',
      content: [{ type: 'text', text: 'rain-soaked street at night, neon reflections' }],
    })
  })

  it('trims a trailing slash off the base url', () => {
    expect(buildSeedanceSubmitRequest(`${base}/`, API_KEY, t2v(), request()).url).toBe(`${base}/api/v3/contents/generations/tasks`)
    expect(buildSeedancePollRequest(`${base}/`, API_KEY, 'cgt-1').url).toBe(`${base}/api/v3/contents/generations/tasks/cgt-1`)
    expect(buildSeedanceProbeRequest(`${base}/`, API_KEY).url).toBe(`${base}/api/v3/models`)
  })

  it('merges only the known top-level parameters', () => {
    const req = buildSeedanceSubmitRequest(base, API_KEY, t2v(), request({
      parameters: { duration: 5, resolution: '1080p', ratio: '16:9', watermark: false, seed: 42 },
    }))
    expect(req.body).toEqual({
      model: 'doubao-seedance-1-0-pro-250528',
      content: [{ type: 'text', text: 'rain-soaked street at night, neon reflections' }],
      duration: 5,
      resolution: '1080p',
      ratio: '16:9',
      watermark: false,
      seed: 42,
    })
  })

  it('drops unknown and wrongly-typed parameters', () => {
    expect(mergeSeedanceParameters({ size: '1024x1024', n: 1, duration: '5', seed: Number.NaN, ratio: '1:1' })).toEqual({ ratio: '1:1' })
    expect(mergeSeedanceParameters({})).toEqual({})
  })

  it('reads the prompt from input only', () => {
    const req = buildSeedanceSubmitRequest(base, API_KEY, t2v(), request({ input: { prompt: 42 } }))
    expect((req.body as { content: Array<{ text: string }> }).content).toEqual([{ type: 'text', text: '' }])
  })

  it('rejects every modality but t2v', () => {
    for (const modality of ['i2v', 'r2v', 'image', 'text', 'tts'] as const) {
      expect(() => buildSeedanceSubmitRequest(base, API_KEY, capability({ modality }), request())).toThrow(/does not support modality/)
    }
  })

  it('builds a poll request against the task path', () => {
    const req = buildSeedancePollRequest(base, API_KEY, 'cgt-20260915001')
    expect(req).toEqual({
      url: `${base}/api/v3/contents/generations/tasks/cgt-20260915001`,
      method: 'GET',
      headers: { Authorization: `Bearer ${API_KEY}` },
    })
  })
})

describe('seedance status vocabulary', () => {
  it('normalizes the documented statuses', () => {
    expect(normalizeSeedanceStatus('queued')).toBe('running')
    expect(normalizeSeedanceStatus('running')).toBe('running')
    expect(normalizeSeedanceStatus('succeeded')).toBe('completed')
    expect(normalizeSeedanceStatus('failed')).toBe('failed')
    expect(normalizeSeedanceStatus('cancelled')).toBe('failed')
  })

  it('reports anything else as unknown', () => {
    expect(normalizeSeedanceStatus('revoked')).toBe('unknown')
    expect(normalizeSeedanceStatus(undefined)).toBe('unknown')
    expect(normalizeSeedanceStatus(7)).toBe('unknown')
  })

  it('reads the video url from content.video_url', () => {
    expect(extractSeedanceVideoUrl({ content: { video_url: 'https://ark.tos/v.mp4' } })).toBe('https://ark.tos/v.mp4')
    expect(extractSeedanceVideoUrl({ content: {} })).toBeUndefined()
    expect(extractSeedanceVideoUrl({})).toBeUndefined()
    expect(extractSeedanceVideoUrl(null)).toBeUndefined()
  })
})

describe('seedance adapter submit', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('takes the task id from the top level of the response', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'cgt-abc123', model: 'doubao-seedance-1-0-pro-250528' }))
    const submitted = await adapter().submit(t2v(), request({ parameters: { duration: 5 } }))
    expect(submitted).toEqual({ taskId: 'cgt-abc123' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${base}/api/v3/contents/generations/tasks`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({ duration: 5 })
  })

  it('throws the provider error on a rejected submission', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: { code: 'InvalidParameter', message: 'bad ratio' } }, false))
    await expect(adapter().submit(t2v(), request())).rejects.toThrow('InvalidParameter | bad ratio')
  })

  it('throws when a 2xx carries no id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { message: 'queued' }))
    await expect(adapter().submit(t2v(), request())).rejects.toThrow(/missing top-level id/)
  })

  it('refuses an unsupported modality without calling fetch', async () => {
    await expect(adapter().submit(capability({ modality: 'i2v' }), request())).rejects.toThrow(/does not support modality/)
    await expect(adapter().poll(capability({ modality: 'i2v' }), 'cgt-abc123')).rejects.toThrow(/does not support modality/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('seedance adapter poll', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  async function pollWith(body: unknown, init = jsonResponse(200, body)) {
    fetchMock.mockResolvedValue(init)
    return adapter().poll(t2v(), 'cgt-abc123')
  }

  it('keeps queued and running in flight', async () => {
    expect(await pollWith({ id: 'cgt-abc123', status: 'queued' })).toEqual({ status: 'running' })
    expect(await pollWith({ id: 'cgt-abc123', status: 'running' })).toEqual({ status: 'running' })
  })

  it('completes with the content.video_url, which the caller must download promptly', async () => {
    const done = await pollWith({ id: 'cgt-abc123', status: 'succeeded', content: { video_url: 'https://ark.tos/v.mp4?X-Tos-Expires=86400' } })
    expect(done).toEqual({ status: 'completed', artifactUrl: 'https://ark.tos/v.mp4?X-Tos-Expires=86400' })
  })

  it('fails a succeeded task with no video url', async () => {
    expect(await pollWith({ status: 'succeeded', content: {} })).toEqual({
      status: 'failed',
      error: 'seedance: task succeeded but no content.video_url in response',
    })
  })

  it('surfaces the error envelope for failed and cancelled', async () => {
    expect(await pollWith({ status: 'failed', error: { code: 'InternalServiceError', message: 'gpu busy' } })).toEqual({
      status: 'failed',
      error: 'InternalServiceError | gpu busy',
    })
    expect(await pollWith({ status: 'cancelled' })).toEqual({ status: 'failed', error: 'seedance task cancelled' })
  })

  it('treats an unrecognised status as still running', async () => {
    const result = await pollWith({ status: 'pending_review' })
    expect(result.status).toBe('running')
    expect(result.error).toContain('unrecognised task status')
  })

  it('tolerates transport errors: 5xx keeps running, 404 fails', async () => {
    expect(await pollWith({ code: 'ServiceUnavailable' }, jsonResponse(503, { code: 'ServiceUnavailable', message: 'retry' }, false)))
      .toEqual({ status: 'running', error: 'ServiceUnavailable | retry' })
    expect(await pollWith(null, jsonResponse(404, null, false))).toEqual({ status: 'failed', error: 'task cgt-abc123 not found' })
  })

  it('polls the task endpoint with the bearer key', async () => {
    await pollWith({ status: 'running' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${base}/api/v3/contents/generations/tasks/cgt-abc123`)
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`)
    expect(init.body).toBeUndefined()
  })
})

describe('seedance adapter probe', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('accepts a 2xx model list and names the probed model', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: 'doubao-seedance-1-0-pro-250528' }, { id: 'doubao-seedance-1-5-pro-251215' }] }))
    const result = await adapter().probe(t2v())
    expect(result).toEqual({ ok: true, status: 200, message: 'probe ok for doubao-seedance-1-0-pro-250528' })
    expect(fetchMock.mock.calls[0][0]).toBe(`${base}/api/v3/models`)
  })

  it('probes the credential once across every t2v capability', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }))
    const prober = adapter()
    const results = await Promise.all([
      prober.probe(t2v()),
      prober.probe(capability({ modality: 't2v', model: 'doubao-seedance-1-5-pro-251215' })),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(results.map(result => result.ok)).toEqual([true, true])
    expect(results[1].message).toContain('doubao-seedance-1-5-pro-251215')
  })

  it('denies without fetch for a modality with no seedance endpoint', async () => {
    const result = await adapter().probe(capability({ modality: 'r2v' }))
    expect(result).toEqual({ ok: false, status: 0, message: 'no seedance endpoint for modality "r2v"' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports the provider rejection and an unreachable endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'AuthenticationError', message: 'invalid key' } }, false))
    const denied = await adapter().probe(t2v())
    expect(denied).toEqual({ ok: false, status: 401, message: 'AuthenticationError | invalid key' })

    fetchMock.mockRejectedValue(new Error('fetch failed'))
    expect(await adapter('other-key').probe(t2v())).toEqual({ ok: false, status: 0, message: 'fetch failed' })
  })

  it('denies a 2xx whose envelope carries no model list', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}))
    const result = await adapter().probe(t2v())
    expect(result).toEqual({ ok: false, status: 200, message: 'seedance probe: 2xx without a "data" model list' })
  })
})
