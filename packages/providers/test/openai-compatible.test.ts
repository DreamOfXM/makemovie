import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { ModelCapability } from '@studio/domain'
import {
  OpenAICompatibleAdapter,
  buildCompatChatRequest,
  buildCompatProbeRequest,
  mergeCompatChatParameters,
  resetOpenAICompatibleSyncResults,
} from '../src/openai-compatible.js'

const fetchMock = vi.fn()

const GATEWAY = 'https://gateway.internal'
const API_KEY = 'key-for-gateway'

function capability(partial: Partial<ModelCapability> & { modality: ModelCapability['modality'] }): ModelCapability {
  return {
    provider: 'openai_compatible',
    model: 'llama-3.3-70b',
    acceptsFirstFrame: false,
    acceptsReferenceImages: false,
    maxReferenceImages: 0,
    ...partial,
  }
}

function request(overrides: Partial<{ model: string; input: Record<string, unknown>; parameters: Record<string, unknown> }> = {}) {
  return {
    model: overrides.model ?? 'llama-3.3-70b',
    input: overrides.input ?? { prompt: 'write the opening scene' },
    parameters: overrides.parameters ?? {},
  }
}

function adapter(apiKey = API_KEY): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({ apiKey, baseUrl: GATEWAY })
}

function jsonResponse(status: number, body: unknown, ok = status < 400) {
  return { ok, status, statusText: ok ? 'OK' : 'Error', json: async () => body, headers: new Headers() }
}

function bytesResponse(status: number, bytes: Uint8Array, mimeType: string) {
  return { ok: status < 400, status, statusText: 'OK', arrayBuffer: async () => bytes.buffer, headers: new Headers({ 'content-type': mimeType }) }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  resetOpenAICompatibleSyncResults()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openai-compatible request building', () => {
  it('posts a chat turn to the gateway with a bearer key', () => {
    const req = buildCompatChatRequest(GATEWAY, API_KEY, capability({ modality: 'text' }), request())
    expect(req).toEqual({
      url: `${GATEWAY}/v1/chat/completions`,
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: { model: 'llama-3.3-70b', messages: [{ role: 'user', content: 'write the opening scene' }] },
    })
  })

  it('sends images as image_url parts on a vision capability', () => {
    const req = buildCompatChatRequest(GATEWAY, API_KEY, capability({ modality: 'vlm' }), request({ input: { prompt: 'audit this frame', images: ['data:image/png;base64,AAA='] } }))
    expect((req.body as { messages: Array<{ content: unknown[] }> }).messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } },
      { type: 'text', text: 'audit this frame' },
    ])
  })

  it('passes through messages the caller already shaped', () => {
    const req = buildCompatChatRequest(GATEWAY, API_KEY, capability({ modality: 'text' }), request({ input: { prompt: 'ignored', messages: [{ role: 'system', content: 'be brief' }] } }))
    expect(req.body).toMatchObject({ messages: [{ role: 'system', content: 'be brief' }] })
  })

  it('forwards only sampling keys that cannot change the contract', () => {
    expect(mergeCompatChatParameters({ temperature: 0.4, max_tokens: 900, stream: true, response_format: { type: 'json_object' } })).toEqual({ temperature: 0.4, max_tokens: 900 })
    expect(mergeCompatChatParameters({ temperature: Number.NaN, max_tokens: '900' })).toEqual({})
  })

  it('trims a trailing slash off the gateway address', () => {
    expect(buildCompatChatRequest(`${GATEWAY}/`, API_KEY, capability({ modality: 'text' }), request()).url).toBe(`${GATEWAY}/v1/chat/completions`)
    expect(buildCompatProbeRequest(`${GATEWAY}/`, API_KEY).url).toBe(`${GATEWAY}/v1/models`)
  })

  it('refuses the modalities a chat-shaped gateway has no endpoint for', async () => {
    for (const modality of ['t2v', 'i2v', 'r2v', 'music'] as const) {
      await expect(adapter().submit(capability({ modality }), request())).rejects.toThrow(/does not support modality/)
      expect(await adapter().probe(capability({ modality }))).toMatchObject({ ok: false, message: /no openai-compatible endpoint/ })
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })
})

describe('openai-compatible adapter submit and poll', () => {
  it('resolves a chat answer through a synthetic task', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { choices: [{ message: { content: 'FADE IN.' } }] }))
    const submitted = await adapter().submit(capability({ modality: 'text' }), request())
    expect(submitted.taskId).toMatch(/^oac-sync-/)
    expect(await adapter().poll(capability({ modality: 'text' }), submitted.taskId)).toEqual({ status: 'completed', text: 'FADE IN.' })
  })

  it('carries an inline image as bytes with the type it asked for', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [{ b64_json: Buffer.from('png-bytes').toString('base64') }], }))
    const submitted = await adapter().submit(capability({ modality: 'image', model: 'flux-schnell' }), request({ model: 'flux-schnell', parameters: { output_format: 'webp' } }))
    const result = await adapter().poll(capability({ modality: 'image', model: 'flux-schnell' }), submitted.taskId)
    expect(Buffer.from(result.inlineArtifact!.bytes).toString()).toBe('png-bytes')
    expect(result.inlineArtifact!.mimeType).toBe('image/webp')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'flux-schnell', output_format: 'webp' })
  })

  it('keeps the audio type the gateway claimed', async () => {
    fetchMock.mockResolvedValueOnce(bytesResponse(200, new Uint8Array([1, 2, 3]), 'audio/wav; charset=utf-8'))
    const submitted = await adapter().submit(capability({ modality: 'tts', model: 'tts-1' }), request({ model: 'tts-1' }))
    const result = await adapter().poll(capability({ modality: 'tts', model: 'tts-1' }), submitted.taskId)
    expect(result.inlineArtifact).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' })
  })

  it('says so when handed a task id it never issued', async () => {
    const result = await adapter().poll(capability({ modality: 'text' }), 'chatcmpl-9f3a')
    expect(result).toMatchObject({ status: 'failed', error: /answer in one call|never polled/ })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('turns a gateway error body into a failed submission, not an empty artifact', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(502, { error: { message: 'upstream unavailable' } }, false))
    await expect(adapter().submit(capability({ modality: 'text' }), request())).rejects.toThrow(/upstream unavailable/)
  })
})

describe('openai-compatible adapter probe', () => {
  it('asks the model list once and reuses the verdict across capabilities', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: 'llama-3.3-70b' }] }))
    const a = adapter()
    expect(await a.probe(capability({ modality: 'text' }))).toMatchObject({ ok: true, message: 'probe ok for llama-3.3-70b' })
    await a.probe(capability({ modality: 'image' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`${GATEWAY}/v1/models`)
  })

  it('refuses to certify a 2xx that is not a model list', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { models: ['llama-3.3-70b'] }))
    expect(await adapter().probe(capability({ modality: 'text' }))).toMatchObject({ ok: false, message: /without a "data" model list/ })
  })

  it('reports an unreachable gateway instead of throwing at the console', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await adapter().probe(capability({ modality: 'text' }))).toMatchObject({ ok: false, status: 0, message: /ECONNREFUSED/ })
  })
})
