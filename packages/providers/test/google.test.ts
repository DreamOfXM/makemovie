import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { ModelCapability } from '@studio/domain'
import {
  buildGoogleDownloadRequest,
  buildGoogleGenerateRequest,
  buildGoogleOperationRequest,
  buildGoogleProbeRequest,
  buildGoogleVideoSubmitRequest,
  extractGoogleInlineImage,
  extractGoogleText,
  extractGoogleVideoUri,
  googleGenerationConfig,
  GOOGLE_DEFAULT_BASE_URL,
  GoogleAdapter,
  resetGoogleSyncResults,
} from '../src/google.js'

const fetchMock = vi.fn()

const base = GOOGLE_DEFAULT_BASE_URL
const API_KEY = 'goog-test-key'

function capability(partial: Partial<ModelCapability> & { modality: ModelCapability['modality'] }): ModelCapability {
  return {
    provider: 'google',
    model: 'gemini-2.5-pro',
    acceptsFirstFrame: false,
    acceptsReferenceImages: false,
    maxReferenceImages: 0,
    ...partial,
  }
}

function request(overrides: Partial<{ model: string; input: Record<string, unknown>; parameters: Record<string, unknown> }> = {}) {
  return {
    model: overrides.model ?? 'gemini-2.5-pro',
    input: overrides.input ?? { prompt: 'rain-soaked street at night, neon reflections' },
    parameters: overrides.parameters ?? {},
  }
}

function adapter(apiKey = API_KEY): GoogleAdapter {
  return new GoogleAdapter({ apiKey, baseUrl: base })
}

function jsonResponse(status: number, body: unknown, ok = status < 400) {
  return { ok, status, statusText: ok ? 'OK' : 'Error', json: async () => body, headers: new Headers() }
}

function bytesResponse(bytes: Uint8Array, contentType: string, status = 200) {
  return {
    ok: status < 400,
    status,
    statusText: 'OK',
    json: async () => { throw new Error('not json') },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    headers: new Headers({ 'content-type': contentType }),
  }
}

function callUrl(index = 0): string {
  return fetchMock.mock.calls[index][0] as string
}

function callHeaders(index = 0): Record<string, string> {
  return fetchMock.mock.calls[index][1].headers as Record<string, string>
}

function callBody(index = 0): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[index][1].body as string)
}

function textCandidate(...texts: string[]) {
  return { candidates: [{ content: { parts: texts.map(text => ({ text })) } }] }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  resetGoogleSyncResults()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('google request building', () => {
  it('builds a generateContent call whose prompt is the only text part', () => {
    const req = buildGoogleGenerateRequest(base, API_KEY, capability({ modality: 'text' }), request())
    expect(req.url).toBe(`${base}/v1beta/models/gemini-2.5-pro:generateContent`)
    expect(req.method).toBe('POST')
    expect(req.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'rain-soaked street at night, neon reflections' }] }],
      generationConfig: {},
    })
  })

  it('authenticates with a key header and never a bearer token', () => {
    const req = buildGoogleGenerateRequest(base, API_KEY, capability({ modality: 'text' }), request())
    expect(req.headers['x-goog-api-key']).toBe(API_KEY)
    expect(req.headers.Authorization).toBeUndefined()
    expect(buildGoogleProbeRequest(base, API_KEY).headers).toEqual({ 'x-goog-api-key': API_KEY })
  })

  it('splits the audit data urls into typed inline parts ahead of the question', () => {
    const req = buildGoogleGenerateRequest(base, API_KEY, capability({ modality: 'vlm' }), request({
      model: 'gemini-3.5-flash',
      input: { prompt: 'is this frame usable?', images: ['data:image/jpeg;base64,' + Buffer.from('frame').toString('base64')] },
    }))
    const contents = (req.body as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents
    expect(contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: Buffer.from('frame').toString('base64') } })
    expect(contents[0].parts[1]).toEqual({ text: 'is this frame usable?' })
    expect(req.url).toBe(`${base}/v1beta/models/gemini-3.5-flash:generateContent`)
  })

  it('drops an image it cannot describe rather than sending a broken part', () => {
    const req = buildGoogleGenerateRequest(base, API_KEY, capability({ modality: 'vlm' }), request({ input: { prompt: 'p', images: ['https://cdn/x.jpg', 7] } }))
    expect((req.body as { contents: Array<{ parts: unknown[] }> }).contents[0].parts).toEqual([{ text: 'p' }])
  })

  it('passes through messages the caller already shaped', () => {
    const req = buildGoogleGenerateRequest(base, API_KEY, capability({ modality: 'text' }), request({
      input: { prompt: 'ignored', messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }] },
    }))
    expect((req.body as { contents: unknown }).contents).toEqual([
      { role: 'system', parts: [{ text: 'be terse' }] },
      { role: 'user', parts: [{ text: 'hi' }] },
    ])
  })

  it('asks for an image response only of an image capability', () => {
    expect(googleGenerationConfig(capability({ modality: 'image' }), {})).toEqual({ generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } })
    expect(googleGenerationConfig(capability({ modality: 'text' }), {})).toEqual({ generationConfig: {} })
    expect(googleGenerationConfig(capability({ modality: 'image' }), { aspectRatio: '16:9', temperature: 0.4 })).toEqual({
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' }, temperature: 0.4 },
    })
    expect(googleGenerationConfig(capability({ modality: 'text' }), { temperature: Number.NaN, aspectRatio: 3 })).toEqual({ generationConfig: {} })
  })

  it('routes video to the long-running predict endpoint', () => {
    expect(() => buildGoogleGenerateRequest(base, API_KEY, capability({ modality: 't2v' }), request())).toThrow(/long-running predict endpoint/)
    const req = buildGoogleVideoSubmitRequest(base, API_KEY, request({ model: 'veo-3.1-generate-preview' }))
    expect(req.url).toBe(`${base}/v1beta/models/veo-3.1-generate-preview:predictLongRunning`)
    expect(req.body).toEqual({ instances: [{ prompt: 'rain-soaked street at night, neon reflections' }], parameters: {} })
  })

  it('keeps only the video parameters it knows', () => {
    const req = buildGoogleVideoSubmitRequest(base, API_KEY, request({ parameters: { aspectRatio: '9:16', durationSeconds: 8, seed: 3 } }))
    expect((req.body as { parameters: unknown }).parameters).toEqual({ aspectRatio: '9:16', durationSeconds: 8 })
  })

  it('trims a trailing slash off the base url', () => {
    expect(buildGoogleGenerateRequest(`${base}/`, API_KEY, capability({ modality: 'text' }), request()).url).toBe(`${base}/v1beta/models/gemini-2.5-pro:generateContent`)
    expect(buildGoogleOperationRequest(`${base}/`, API_KEY, 'models/v/operations/o').url).toBe(`${base}/v1beta/models/v/operations/o`)
    expect(buildGoogleProbeRequest(`${base}/`, API_KEY).url).toBe(`${base}/v1beta/models`)
  })

  it('polls the operation by the name the vendor returned', () => {
    const req = buildGoogleOperationRequest(base, API_KEY, 'models/veo-3.1-generate-preview/operations/abc123')
    expect(req).toEqual({
      url: `${base}/v1beta/models/veo-3.1-generate-preview/operations/abc123`,
      method: 'GET',
      headers: { 'x-goog-api-key': API_KEY },
    })
  })

  it('downloads the generated file with the key in a header, not the url', () => {
    const req = buildGoogleDownloadRequest(base, API_KEY, `${base}/v1beta/files/xyz:download`)
    expect(req.url).toBe(`${base}/v1beta/files/xyz:download`)
    expect(req.url).not.toContain(API_KEY)
    expect(req.headers).toEqual({ 'x-goog-api-key': API_KEY })
  })
})

describe('google response parsing', () => {
  it('joins the text parts across candidates', () => {
    expect(extractGoogleText({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }, { content: { parts: [{ text: 'c' }] } }] })).toBe('abc')
    expect(extractGoogleText({ candidates: [{ content: { parts: [{ inlineData: {} }] } }] })).toBe('')
    expect(extractGoogleText({})).toBe('')
    expect(extractGoogleText(null)).toBe('')
  })

  it('reads an inline image and falls back to png for a missing type', () => {
    const payload = Buffer.from('fake-png').toString('base64')
    const found = extractGoogleInlineImage({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/webp', data: payload } }] } }] })
    expect(found?.mimeType).toBe('image/webp')
    expect(Buffer.from(found!.bytes).toString()).toBe('fake-png')
    const fallback = extractGoogleInlineImage({ candidates: [{ content: { parts: [{ inlineData: { data: payload } }] } }] })
    expect(fallback?.mimeType).toBe('image/png')
    expect(extractGoogleInlineImage({ candidates: [{ content: { parts: [{ text: 'no picture' }] } }] })).toBeUndefined()
  })

  it('reads the video uri out of the deep sample path', () => {
    const body = { response: { generateVideoResponse: { generatedSamples: [{ video: { uri: '' } }, { video: { uri: 'https://gt/clip.mp4' } }] } } }
    expect(extractGoogleVideoUri(body)).toBe('https://gt/clip.mp4')
    expect(extractGoogleVideoUri({ response: {} })).toBeUndefined()
    expect(extractGoogleVideoUri({})).toBeUndefined()
    expect(extractGoogleVideoUri(null)).toBeUndefined()
  })
})

describe('google adapter submit and poll', () => {
  it('resolves a text generation through a synthetic sync task', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, textCandidate('INT. SET — DAWN')))
    const submitted = await adapter().submit(capability({ modality: 'text' }), request())
    expect(submitted.taskId).toMatch(/^go-sync-/)
    const result = await adapter().poll(capability({ modality: 'text' }), submitted.taskId)
    expect(result).toEqual({ status: 'completed', text: 'INT. SET — DAWN' })
  })

  it('hands back an inline artifact for an image generation', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('pixels').toString('base64') } }] } }],
    }))
    const submitted = await adapter().submit(capability({ modality: 'image', model: 'gemini-3.1-flash-image' }), request())
    const result = await adapter().poll(capability({ modality: 'image' }), submitted.taskId)
    expect(result.status).toBe('completed')
    expect(result.inlineArtifact?.mimeType).toBe('image/png')
    expect(Buffer.from(result.inlineArtifact!.bytes).toString()).toBe('pixels')
    expect(result.artifactUrl).toBeUndefined()
  })

  it('consumes a sync task once', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, textCandidate('once')))
    const submitted = await adapter().submit(capability({ modality: 'text' }), request())
    expect((await adapter().poll(capability({ modality: 'text' }), submitted.taskId)).status).toBe('completed')
    expect((await adapter().poll(capability({ modality: 'text' }), submitted.taskId)).status).toBe('failed')
  })

  it('returns the vendor operation name as the task id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: 'models/veo-3.1-generate-preview/operations/op-9' }))
    const submitted = await adapter().submit(capability({ modality: 't2v', model: 'veo-3.1-generate-preview' }), request())
    expect(submitted.taskId).toBe('models/veo-3.1-generate-preview/operations/op-9')
  })

  it('fails the submit rather than inventing an id when the operation name is missing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    await expect(adapter().submit(capability({ modality: 't2v', model: 'veo-3.1-generate-preview' }), request())).rejects.toThrow(/missing operation name/)
  })

  it('reports a running operation without downloading anything', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { done: false }))
    const result = await adapter().poll(capability({ modality: 't2v' }), 'models/v/operations/op-1')
    expect(result).toEqual({ status: 'running' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('downloads a completed clip into bytes the worker cannot fetch itself', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${base}/v1beta/files/f1:download` } }] } } }))
      .mockResolvedValueOnce(bytesResponse(new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112]), 'video/mp4; codecs="avc1"'))
    const result = await adapter().poll(capability({ modality: 't2v' }), 'models/v/operations/op-2')
    expect(result.status).toBe('completed')
    expect(result.inlineArtifact?.mimeType).toBe('video/mp4')
    expect(callUrl(1)).toBe(`${base}/v1beta/files/f1:download`)
    expect(callHeaders(1)).toEqual({ 'x-goog-api-key': API_KEY })
  })

  it('fails a done operation that produced no uri', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { done: true, response: {} }))
    const result = await adapter().poll(capability({ modality: 't2v' }), 'models/v/operations/op-3')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/no generatedSamples video uri/)
  })

  it('treats a 404 operation as gone and any other error as still running', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: { message: 'not found' } }, false))
    const gone = await adapter().poll(capability({ modality: 't2v' }), 'models/v/operations/old')
    expect(gone.status).toBe('failed')
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: { message: 'resource exhausted' } }, false))
    const throttled = await adapter().poll(capability({ modality: 't2v' }), 'models/v/operations/op-4')
    expect(throttled.status).toBe('running')
  })

  it('keeps a failed download from looking like a completion', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${base}/files/f2:download` } }] } } }))
      .mockResolvedValueOnce(jsonResponse(403, { error: { message: 'denied' } }, false))
    const result = await adapter().poll(capability({ modality: 't2v' }), 'models/v/operations/op-5')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/download failed with HTTP 403/)
  })

  it('rejects the modalities google has no endpoint for before spending a call', async () => {
    for (const modality of ['i2v', 'r2v', 'tts', 'music'] as const) {
      const cap = capability({ modality })
      await expect(adapter().submit(cap, request())).rejects.toThrow(/does not support modality/)
      await expect(adapter().poll(cap, 'go-sync-1')).rejects.toThrow(/does not support modality/)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it('throws on a provider error instead of storing a task for a failed call', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { code: 400, message: 'API key not valid' } }, false))
    await expect(adapter().submit(capability({ modality: 'text' }), request())).rejects.toThrow(/API key not valid/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('google adapter probe', () => {
  it('probes the model list once and reuses the verdict', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { models: [{ name: 'models/gemini-2.5-pro' }] }))
    const a = adapter()
    expect(await a.probe(capability({ modality: 'text' }))).toEqual({ ok: true, status: 200, message: 'probe ok for gemini-2.5-pro' })
    await a.probe(capability({ modality: 'image' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(callUrl(0)).toBe(`${base}/v1beta/models`)
    expect(callHeaders(0)).toEqual({ 'x-goog-api-key': API_KEY })
  })

  it('refuses a 2xx that is not a model list', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }))
    expect(await adapter().probe(capability({ modality: 'text' }))).toMatchObject({ ok: false, message: /without a "models" list/ })
  })

  it('reports a rejected key and refuses to spend on an unsupported modality', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: 'invalid key' } }, false))
    expect(await adapter().probe(capability({ modality: 'text' }))).toMatchObject({ ok: false, status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const tts = await adapter().probe(capability({ modality: 'tts' }))
    expect(tts).toMatchObject({ ok: false, message: /no google endpoint for modality "tts"/ })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
