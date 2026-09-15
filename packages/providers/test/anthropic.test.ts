import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { ModelCapability } from '@studio/domain'
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_VERSION,
  AnthropicAdapter,
  buildAnthropicMessagesRequest,
  buildAnthropicProbeRequest,
  extractAnthropicText,
  maxTokensOf,
  resetAnthropicSyncResults,
} from '../src/anthropic.js'

const fetchMock = vi.fn()

const base = ANTHROPIC_DEFAULT_BASE_URL
const API_KEY = 'sk-ant-test-key'

function capability(partial: Partial<ModelCapability> & { modality: ModelCapability['modality'] }): ModelCapability {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    acceptsFirstFrame: false,
    acceptsReferenceImages: false,
    maxReferenceImages: 0,
    ...partial,
  }
}

function request(overrides: Partial<{ model: string; input: Record<string, unknown>; parameters: Record<string, unknown> }> = {}) {
  return {
    model: overrides.model ?? 'claude-sonnet-5',
    input: overrides.input ?? { prompt: 'write the opening scene of a heist short' },
    parameters: overrides.parameters ?? {},
  }
}

function adapter(apiKey = API_KEY): AnthropicAdapter {
  return new AnthropicAdapter({ apiKey, baseUrl: base })
}

function jsonResponse(status: number, body: unknown, ok = status < 400) {
  return { ok, status, statusText: ok ? 'OK' : 'Error', json: async () => body, headers: new Headers() }
}

function textBody(...texts: string[]) {
  return { content: texts.map(text => ({ type: 'text', text })) }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  resetAnthropicSyncResults()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('anthropic request building', () => {
  it('posts to /v1/messages with the model and a single user turn', () => {
    const req = buildAnthropicMessagesRequest(base, API_KEY, capability({ modality: 'text' }), request())
    expect(req.url).toBe(`${base}/v1/messages`)
    expect(req.method).toBe('POST')
    expect(req.body).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'write the opening scene of a heist short' }] }],
    })
  })

  it('authenticates with an api key and version header and never a bearer token', () => {
    const req = buildAnthropicMessagesRequest(base, API_KEY, capability({ modality: 'text' }), request())
    expect(req.headers).toEqual({
      'x-api-key': API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    })
    expect(req.headers.Authorization).toBeUndefined()
    expect(req.headers.authorization).toBeUndefined()
    expect(buildAnthropicProbeRequest(base, API_KEY).headers).not.toHaveProperty('Authorization')
  })

  it('sends the image as a base64 source block beside the question', () => {
    const payload = Buffer.from('frame-bytes').toString('base64')
    const req = buildAnthropicMessagesRequest(base, API_KEY, capability({ modality: 'vlm' }), request({
      input: { prompt: 'audit this frame', images: [`data:image/png;base64,${payload}`] },
    }))
    expect((req.body as { messages: Array<{ content: unknown[] }> }).messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload } },
      { type: 'text', text: 'audit this frame' },
    ])
  })

  it('drops an image it cannot describe rather than sending a broken block', () => {
    const req = buildAnthropicMessagesRequest(base, API_KEY, capability({ modality: 'vlm' }), request({ input: { prompt: 'p', images: ['https://cdn/x.jpg', 7] } }))
    expect((req.body as { messages: Array<{ content: unknown[] }> }).messages[0].content).toEqual([{ type: 'text', text: 'p' }])
  })

  it('passes through messages the caller already shaped', () => {
    const req = buildAnthropicMessagesRequest(base, API_KEY, capability({ modality: 'text' }), request({
      input: { prompt: 'ignored', messages: [{ role: 'assistant', content: 'sure' }] },
    }))
    expect((req.body as { messages: unknown }).messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'sure' }] }])
  })

  it('trims a trailing slash off the base url', () => {
    expect(buildAnthropicMessagesRequest(`${base}/`, API_KEY, capability({ modality: 'text' }), request()).url).toBe(`${base}/v1/messages`)
    expect(buildAnthropicProbeRequest(`${base}/`, API_KEY).url).toBe(`${base}/v1/models`)
  })

  it('rejects every modality but text and vlm', async () => {
    for (const modality of ['image', 't2v', 'i2v', 'r2v', 'tts', 'music'] as const) {
      expect(() => buildAnthropicMessagesRequest(base, API_KEY, capability({ modality }), request())).toThrow(/does not support modality/)
      await expect(adapter().submit(capability({ modality }), request())).rejects.toThrow(/does not support modality/)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })
})

describe('anthropic max_tokens and text extraction', () => {
  it('always sends a ceiling because the endpoint requires one', () => {
    expect(maxTokensOf({})).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS)
    expect(maxTokensOf({ max_tokens: 2048 })).toBe(2048)
    expect(maxTokensOf({ max_tokens: 2048.7 })).toBe(2048)
    expect(maxTokensOf({ max_tokens: 0 })).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS)
    expect(maxTokensOf({ max_tokens: -5 })).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS)
    expect(maxTokensOf({ max_tokens: '4096' })).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS)
    expect(maxTokensOf({ max_tokens: Number.NaN })).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS)
  })

  it('joins only the text blocks of the answer', () => {
    expect(extractAnthropicText({ content: [{ type: 'text', text: 'INT. BANK' }, { type: 'thinking', text: 'nope' }, { type: 'text', text: ' — DAWN' }] })).toBe('INT. BANK — DAWN')
    expect(extractAnthropicText({ content: [] })).toBe('')
    expect(extractAnthropicText({})).toBe('')
    expect(extractAnthropicText(null)).toBe('')
  })
})

describe('anthropic adapter submit and poll', () => {
  it('answers in one call and replays it through a synthetic task', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, textBody('FADE IN.', '  INT. SET')))
    const submitted = await adapter().submit(capability({ modality: 'text' }), request())
    expect(submitted.taskId).toMatch(/^an-sync-/)
    const result = await adapter().poll(capability({ modality: 'text' }), submitted.taskId)
    expect(result).toEqual({ status: 'completed', text: 'FADE IN.  INT. SET' })
  })

  it('consumes a sync task once', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, textBody('once')))
    const submitted = await adapter().submit(capability({ modality: 'text' }), request())
    expect((await adapter().poll(capability({ modality: 'text' }), submitted.taskId)).status).toBe('completed')
    expect((await adapter().poll(capability({ modality: 'text' }), submitted.taskId)).status).toBe('failed')
  })

  it('says so when handed a task id it never issued', async () => {
    const result = await adapter().poll(capability({ modality: 'text' }), 'cgt-20260915001')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/answers in one call/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('turns a rejected call into an error rather than a task', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is required' } }, false))
    await expect(adapter().submit(capability({ modality: 'text' }), request())).rejects.toThrow(/max_tokens is required/)
  })
})

describe('anthropic adapter probe', () => {
  it('probes the model list once and reuses the verdict', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: 'claude-sonnet-5' }] }))
    const a = adapter()
    expect(await a.probe(capability({ modality: 'text' }))).toEqual({ ok: true, status: 200, message: 'probe ok for claude-sonnet-5' })
    await a.probe(capability({ modality: 'vlm' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`${base}/v1/models`)
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'x-api-key': API_KEY, 'anthropic-version': ANTHROPIC_VERSION })
  })

  it('refuses a 2xx that is not a model list', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { models: [] }))
    expect(await adapter().probe(capability({ modality: 'text' }))).toMatchObject({ ok: false, message: /without a "data" model list/ })
  })

  it('reports a rejected key and refuses to probe an unsupported modality', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: 'invalid x-api-key' } }, false))
    expect(await adapter().probe(capability({ modality: 'text' }))).toMatchObject({ ok: false, status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const image = await adapter().probe(capability({ modality: 'image' }))
    expect(image).toMatchObject({ ok: false, message: /no anthropic endpoint for modality "image"/ })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
