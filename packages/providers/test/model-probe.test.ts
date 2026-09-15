import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { ModelCapability } from '@studio/domain'
import { GoogleAdapter, resetGoogleSyncResults } from '../src/google.js'
import { AnthropicAdapter, ANTHROPIC_DEFAULT_BASE_URL, resetAnthropicSyncResults } from '../src/anthropic.js'
import { DashScopeAdapter, resetDashScopeSyncResults } from '../src/dashscope.js'
import { OpenAIAdapter, OPENAI_DEFAULT_BASE_URL, resetOpenAISyncResults } from '../src/openai.js'
import { OpenAICompatibleAdapter, resetOpenAICompatibleSyncResults } from '../src/openai-compatible.js'
import { MockProviderAdapter } from '../src/mock.js'

const fetchMock = vi.fn()

function capability(model: string, modality: ModelCapability['modality'], provider: string): ModelCapability {
  return { provider, model, modality, acceptsFirstFrame: false, acceptsReferenceImages: false, maxReferenceImages: 0 }
}

function jsonResponse(status: number, body: unknown, ok = status < 400) {
  return { ok, status, statusText: ok ? 'OK' : 'Error', json: async () => body, headers: new Headers() }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  resetOpenAISyncResults()
  resetOpenAICompatibleSyncResults()
  resetGoogleSyncResults()
  resetAnthropicSyncResults()
  resetDashScopeSyncResults()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('model-level verification', () => {
  it('names the model in a one-token request rather than probing the whole connection', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: 'pong' } }] }))
    await new OpenAIAdapter({ apiKey: 'sk-test', baseUrl: OPENAI_DEFAULT_BASE_URL }).verifyModel(capability('gpt-5.6-sol', 'text', 'openai'))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${OPENAI_DEFAULT_BASE_URL}/v1/chat/completions`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({ model: 'gpt-5.6-sol', max_completion_tokens: 1 })
  })

  it('addresses a vision model through the multimodal endpoint, not the text one', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { output: {} }))
    await new DashScopeAdapter({ apiKey: 'sk-test', baseUrl: 'https://dashscope.aliyuncs.com' }).verifyModel(capability('qwen-vl-max', 'vlm', 'dashscope'))
    expect(fetchMock.mock.calls[0][0]).toBe('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'qwen-vl-max' })
  })

  it('caps a probe that could otherwise write an essay', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { candidates: [] }))
    await new GoogleAdapter({ apiKey: 'key', baseUrl: 'https://generativelanguage.googleapis.com' }).verifyModel(capability('gemini-2.5-pro', 'text', 'google'))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ generationConfig: { maxOutputTokens: 1 } })

    fetchMock.mockResolvedValue(jsonResponse(200, { content: [] }))
    await new AnthropicAdapter({ apiKey: 'sk-ant-test', baseUrl: ANTHROPIC_DEFAULT_BASE_URL }).verifyModel(capability('claude-sonnet-5', 'text', 'anthropic'))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ max_tokens: 1 })
  })

  it('keeps a compatible gateway speaking the older parameter name', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: 'pong' } }] }))
    await new OpenAICompatibleAdapter({ apiKey: 'key', baseUrl: 'https://gateway.internal' }).verifyModel(capability('llama-3.3-70b', 'text', 'openai_compatible'))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ model: 'llama-3.3-70b', max_tokens: 1 })
    expect(body).not.toHaveProperty('max_completion_tokens')
  })

  it('treats 404 as a missing model rather than an unverified one', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { message: 'The model `gpt-9` does not exist' } }, false))
    const result = await new OpenAIAdapter({ apiKey: 'sk-test', baseUrl: OPENAI_DEFAULT_BASE_URL }).verifyModel(capability('gpt-9', 'text', 'openai'))
    expect(result).toMatchObject({ ok: false, status: 404, modelMissing: true, message: /is not served by this endpoint/ })
  })

  it('reads a 200 that says the model is unknown as the same verdict', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { error: { code: 'model_not_found', message: 'The model gpt-9 does not exist' } }))
    const result = await new OpenAICompatibleAdapter({ apiKey: 'key', baseUrl: 'https://gateway.internal' }).verifyModel(capability('gpt-9', 'text', 'openai_compatible'))
    expect(result).toMatchObject({ ok: false, status: 200, modelMissing: true })
  })

  it('recognises a vendor that reports a bad model id as an invalid parameter', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { code: 'InvalidParameter', message: 'Model not exist.' }, false))
    const result = await new DashScopeAdapter({ apiKey: 'sk-test', baseUrl: 'https://dashscope.aliyuncs.com' }).verifyModel(capability('qwen-none', 'text', 'dashscope'))
    expect(result).toMatchObject({ ok: false, status: 400, modelMissing: true, message: /Model not exist/ })
  })

  it('refuses a green light from a 200 that carries no answer', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { warning: 'queued' }))
    const result = await new OpenAIAdapter({ apiKey: 'sk-test', baseUrl: OPENAI_DEFAULT_BASE_URL }).verifyModel(capability('gpt-5.6-sol', 'text', 'openai'))
    expect(result).toMatchObject({ ok: false, status: 200, message: /returned no answer — not verified/ })
    expect(result.modelMissing).toBeUndefined()
  })

  it('does not call a model missing over a bad minute', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: { message: 'rate limit exceeded' } }, false))
    const result = await new OpenAIAdapter({ apiKey: 'sk-test', baseUrl: OPENAI_DEFAULT_BASE_URL }).verifyModel(capability('gpt-5.6-sol', 'text', 'openai'))
    expect(result).toMatchObject({ ok: false, status: 429 })
    expect(result.modelMissing).toBeUndefined()
  })

  it('survives a transport failure as an unverified model, not a crash', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'))
    expect(await new OpenAIAdapter({ apiKey: 'sk-test', baseUrl: OPENAI_DEFAULT_BASE_URL }).verifyModel(capability('gpt-5.6-sol', 'text', 'openai'))).toMatchObject({ ok: false, status: 0, message: /socket hang up/ })
  })

  it('keeps the offline provider honest about names it does not answer', async () => {
    const mock = new MockProviderAdapter({ apiKey: 'ok', baseUrl: 'mock://local' })
    expect(await mock.verifyModel(capability('mock-script', 'text', 'mock'))).toMatchObject({ ok: true })
    expect(await mock.verifyModel(capability('gpt-5.6-sol', 'text', 'mock'))).toMatchObject({ ok: false, modelMissing: true })
  })
})
