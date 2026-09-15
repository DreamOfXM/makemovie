import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { ModelCapability } from '@studio/domain'
import {
  buildOpenAIChatRequest,
  buildOpenAIImageRequest,
  buildOpenAIProbeRequest,
  buildOpenAISpeechRequest,
  buildOpenAIVideoContentRequest,
  buildOpenAIVideoCreateRequest,
  buildOpenAIVideoPollRequest,
  extractOpenAIChatText,
  extractOpenAIImageBase64,
  extractOpenAIVideoError,
  mimeTypeForOpenAIImage,
  mimeTypeForOpenAISpeech,
  normalizeOpenAIVideoStatus,
  OPENAI_DEFAULT_BASE_URL,
  OpenAIAdapter,
  resetOpenAISyncResults,
} from '../src/openai.js'

const fetchMock = vi.fn()

const base = OPENAI_DEFAULT_BASE_URL
const API_KEY = 'sk-test-key'

function capability(partial: Partial<ModelCapability> & { modality: ModelCapability['modality'] }): ModelCapability {
  return {
    provider: 'openai',
    model: 'gpt-5.6-sol',
    acceptsFirstFrame: false,
    acceptsReferenceImages: false,
    maxReferenceImages: 0,
    ...partial,
  }
}

function request(overrides: Partial<{ model: string; input: Record<string, unknown>; parameters: Record<string, unknown> }> = {}) {
  return {
    model: overrides.model ?? 'gpt-5.6-sol',
    input: overrides.input ?? { prompt: 'a rainy night market, neon reflections' },
    parameters: overrides.parameters ?? {},
  }
}

function adapter(apiKey = API_KEY): OpenAIAdapter {
  return new OpenAIAdapter({ apiKey, baseUrl: base })
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

function bodyOrValue(req: { body?: unknown }): Record<string, unknown> {
  return req.body as Record<string, unknown>
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  resetOpenAISyncResults()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openai request building', () => {
  it('sends a plain user message for text', () => {
    const req = buildOpenAIChatRequest(base, API_KEY, capability({ modality: 'text' }), request())
    expect(req.url).toBe(`${base}/v1/chat/completions`)
    expect(req.headers).toEqual({ Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' })
    expect(req.body).toEqual({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'a rainy night market, neon reflections' }] })
  })

  it('passes a data URL straight through as an image_url part for vlm', () => {
    const dataUrl = 'data:image/jpeg;base64,/9j/4AAQ'
    const req = buildOpenAIChatRequest(base, API_KEY, capability({ modality: 'vlm', model: 'gpt-5.6-terra' }), request({ input: { prompt: 'audit this', images: [dataUrl, 42] } }))
    const messages = bodyOrValue(req).messages as Array<{ content: unknown[] }>
    expect(messages[0]!.content).toEqual([
      { type: 'image_url', image_url: { url: dataUrl } },
      { type: 'text', text: 'audit this' },
    ])
  })

  it('keeps caller-supplied messages verbatim and forwards only safe sampling keys', () => {
    const req = buildOpenAIChatRequest(base, API_KEY, capability({ modality: 'text' }), request({
      input: { prompt: 'ignored', messages: [{ role: 'user', content: 'script brief' }] },
      parameters: { temperature: 0.4, max_completion_tokens: 512, top_p: 9 },
    }))
    expect(bodyOrValue(req)).toEqual({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'script brief' }],
      temperature: 0.4,
      max_completion_tokens: 512,
    })
  })

  it('trims a trailing slash off the base url', () => {
    expect(buildOpenAIChatRequest(`${base}/`, API_KEY, capability({ modality: 'text' }), request()).url).toBe(`${base}/v1/chat/completions`)
    expect(buildOpenAIProbeRequest(`${base}/`, API_KEY).url).toBe(`${base}/v1/models`)
    expect(buildOpenAIVideoPollRequest(`${base}/`, API_KEY, 'video_1').url).toBe(`${base}/v1/videos/video_1`)
  })

  it('asks the image endpoint for base64 and carries an explicit format', () => {
    const req = buildOpenAIImageRequest(base, API_KEY, request({ model: 'gpt-image-1', parameters: { size: '1536x1024', output_format: 'webp' } }))
    expect(req.url).toBe(`${base}/v1/images/generations`)
    expect(req.body).toEqual({ model: 'gpt-image-1', prompt: 'a rainy night market, neon reflections', size: '1536x1024', output_format: 'webp' })
    expect(mimeTypeForOpenAIImage({ output_format: 'webp' })).toBe('image/webp')
    expect(mimeTypeForOpenAIImage({ output_format: 'not-a-format' })).toBe('image/png')
    expect(mimeTypeForOpenAIImage({})).toBe('image/png')
  })

  it('maps the spoken line onto input, which is what the speech endpoint is called', () => {
    const req = buildOpenAISpeechRequest(base, API_KEY, request({ model: 'gpt-4o-mini-tts', input: { prompt: '这条街不能待了。' }, parameters: { voice: 'nova', response_format: 'wav' } }))
    expect(req.url).toBe(`${base}/v1/audio/speech`)
    expect(req.body).toEqual({ model: 'gpt-4o-mini-tts', input: '这条街不能待了。', voice: 'nova', response_format: 'wav' })
    expect(mimeTypeForOpenAISpeech({ response_format: 'wav' })).toBe('audio/wav')
    expect(mimeTypeForOpenAISpeech({})).toBe('audio/mpeg')
  })

  it('defaults the voice when the caller names none', () => {
    expect(bodyOrValue(buildOpenAISpeechRequest(base, API_KEY, request()))).toMatchObject({ voice: 'alloy' })
  })

  it('creates a video from form fields and leaves the content type to FormData', () => {
    const req = buildOpenAIVideoCreateRequest(base, API_KEY, request({ model: 'sora-2', parameters: { seconds: 8, size: '1280x720', resolution: '720p', unknown: 'dropped' } }))
    expect(req.url).toBe(`${base}/v1/videos`)
    expect(req.headers).toEqual({ Authorization: `Bearer ${API_KEY}` })
    expect('Content-Type' in req.headers).toBe(false)
    const form = req.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('sora-2')
    expect(form.get('prompt')).toBe('a rainy night market, neon reflections')
    expect(form.get('seconds')).toBe('8')
    expect(form.get('size')).toBe('1280x720')
    expect(form.get('unknown')).toBeNull()
  })

  it('builds the poll and the authenticated content download against the same id', () => {
    expect(buildOpenAIVideoPollRequest(base, API_KEY, 'video_123')).toEqual({
      url: `${base}/v1/videos/video_123`,
      method: 'GET',
      headers: { Authorization: `Bearer ${API_KEY}` },
    })
    expect(buildOpenAIVideoContentRequest(base, API_KEY, 'video_123').url).toBe(`${base}/v1/videos/video_123/content`)
  })
})

describe('openai response parsing', () => {
  it('reads a string or a list of content parts', () => {
    expect(extractOpenAIChatText({ choices: [{ message: { content: 'draft one' } }] })).toBe('draft one')
    expect(extractOpenAIChatText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'refusal' }, { type: 'text', text: 'b' }] } }] })).toBe('ab')
    expect(extractOpenAIChatText({})).toBe('')
    expect(extractOpenAIChatText(null)).toBe('')
  })

  it('reads b64_json off the first datum only', () => {
    expect(extractOpenAIImageBase64({ data: [{ b64_json: 'YWJj' }] })).toBe('YWJj')
    expect(extractOpenAIImageBase64({ data: [{ url: 'https://oaidalleappprodz.blob.core.windows.net/x.png' }] })).toBeUndefined()
    expect(extractOpenAIImageBase64({ data: [] })).toBeUndefined()
    expect(extractOpenAIImageBase64(null)).toBeUndefined()
  })

  it('normalizes the documented video statuses and keeps unknown ones alive', () => {
    expect(normalizeOpenAIVideoStatus('queued')).toBe('running')
    expect(normalizeOpenAIVideoStatus('in_progress')).toBe('running')
    expect(normalizeOpenAIVideoStatus('reviewing')).toBe('running')
    expect(normalizeOpenAIVideoStatus('completed')).toBe('completed')
    expect(normalizeOpenAIVideoStatus('failed')).toBe('failed')
    expect(normalizeOpenAIVideoStatus('revoked')).toBe('unknown')
    expect(normalizeOpenAIVideoStatus(undefined)).toBe('unknown')
  })

  it('reads a video error out of either shape', () => {
    expect(extractOpenAIVideoError({ error: 'content_policy_violation' })).toBe('content_policy_violation')
    expect(extractOpenAIVideoError({ error: { message: 'prompt refused' } })).toBe('prompt refused')
    expect(extractOpenAIVideoError({})).toBeUndefined()
  })
})

describe('openai adapter submit and poll', () => {
  it('resolves a text generation on the first poll and forgets it after', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: 'INT. MARKET - NIGHT' } }] }))
    const submitted = await adapter().submit(capability({ modality: 'text' }), request())
    expect(submitted.taskId).toMatch(/^oa-sync-/)
    await expect(adapter().poll(capability({ modality: 'text' }), submitted.taskId)).resolves.toEqual({ status: 'completed', text: 'INT. MARKET - NIGHT' })
    await expect(adapter().poll(capability({ modality: 'text' }), submitted.taskId)).resolves.toMatchObject({ status: 'failed' })
  })

  it('lands an image as inline bytes with the type it asked for', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ b64_json: Buffer.from('png-bytes').toString('base64') }] }))
    const submitted = await adapter().submit(capability({ modality: 'image', model: 'gpt-image-1' }), request({ parameters: { output_format: 'jpeg' } }))
    const result = await adapter().poll(capability({ modality: 'image' }), submitted.taskId)
    expect(result.status).toBe('completed')
    expect(result.inlineArtifact?.mimeType).toBe('image/jpeg')
    expect(Buffer.from(result.inlineArtifact!.bytes).toString()).toBe('png-bytes')
    expect(result.artifactUrl).toBeUndefined()
  })

  it('fails rather than storing a picture that is not there', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }))
    await expect(adapter().submit(capability({ modality: 'image' }), request())).rejects.toThrow(/no b64_json/)
  })

  it('keeps the audio content type the vendor answered with', async () => {
    fetchMock.mockResolvedValue(bytesResponse(new Uint8Array([1, 2, 3]), 'audio/wav; codecs=1'))
    const submitted = await adapter().submit(capability({ modality: 'tts', model: 'gpt-4o-mini-tts' }), request())
    const result = await adapter().poll(capability({ modality: 'tts' }), submitted.taskId)
    expect(result.inlineArtifact).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' })
  })

  it('drives a video through create, poll, then an authenticated content download', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { id: 'video_9', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'video_9', status: 'in_progress' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'video_9', status: 'completed' }))
      .mockResolvedValueOnce(bytesResponse(new Uint8Array([9, 9]), 'video/mp4'))

    const submitted = await adapter().submit(capability({ modality: 't2v', model: 'sora-2' }), request())
    expect(submitted.taskId).toBe('video_9')
    const running = await adapter().poll(capability({ modality: 't2v' }), 'video_9')
    expect(running).toEqual({ status: 'running' })

    const completed = await adapter().poll(capability({ modality: 't2v' }), 'video_9')
    expect(completed.status).toBe('completed')
    expect(completed.inlineArtifact?.mimeType).toBe('video/mp4')
    expect(fetchMock).toHaveBeenLastCalledWith(`${base}/v1/videos/video_9/content`, expect.objectContaining({ headers: { Authorization: `Bearer ${API_KEY}` } }))
  })

  it('reports a failed video without trying to download it', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'video_9', status: 'failed', error: { message: 'prompt violates policy' } }))
    const result = await adapter().poll(capability({ modality: 't2v' }), 'video_9')
    expect(result).toEqual({ status: 'failed', error: 'prompt violates policy' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps polling on an unrecognised status instead of killing a paid job', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'video_9', status: 'something_new' }))
    await expect(adapter().poll(capability({ modality: 't2v' }), 'video_9')).resolves.toMatchObject({ status: 'running' })
  })

  it('surfaces a rejected create with the vendor message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: { message: 'rate limit reached', code: 'rate_limit_exceeded' } }, false))
    await expect(adapter().submit(capability({ modality: 't2v' }), request())).rejects.toThrow('rate_limit_exceeded | rate limit reached')
  })

  it('refuses the modalities with no endpoint behind them', async () => {
    for (const modality of ['music', 'i2v', 'r2v'] as const) {
      await expect(adapter().submit(capability({ modality }), request())).rejects.toThrow(/does not support modality/)
    }
  })
})

describe('openai adapter probe', () => {
  it('accepts a model list and calls it a credential check', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: 'gpt-5.6-sol' }] }))
    const result = await adapter().probe(capability({ modality: 'text' }))
    expect(result).toEqual({ ok: true, status: 200, message: 'probe ok for gpt-5.6-sol' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a 2xx that is not a model list', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { html: '<html>' }))
    const result = await adapter().probe(capability({ modality: 'text' }))
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/without a "data" model list/)
  })

  it('reports a bad key without inventing a status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: 'Invalid API key' } }, false))
    expect(await adapter().probe(capability({ modality: 'text' }))).toMatchObject({ ok: false, status: 401 })
  })

  it('does not spend a request on a modality it cannot serve', async () => {
    const result = await adapter().probe(capability({ modality: 'music' }))
    expect(result).toMatchObject({ ok: false, status: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
