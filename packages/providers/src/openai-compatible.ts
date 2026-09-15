import type { ModelCapability, ModelModality } from '@studio/domain'
import {
  buildOpenAIImageRequest,
  buildOpenAISpeechRequest,
  extractOpenAIChatText,
  extractOpenAIImageBase64,
  mimeTypeForOpenAIImage,
  mimeTypeForOpenAISpeech,
  type OpenAIHttpRequest,
} from './openai.js'
import type { AdapterOptions, ModelProbeRequest, PollResult, ProbeResult, ProviderAdapter, ProviderRequest, SubmitResult } from './types.js'
import { probeModel, sanitizeError } from './types.js'

const CHAT_PATH = '/v1/chat/completions'
const MODELS_PATH = '/v1/models'

const SUPPORTED_MODALITIES = new Set<ModelModality>(['text', 'vlm', 'image', 'tts'])

function baseUrlOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` }
}

function promptOf(request: ProviderRequest): string {
  return typeof request.input.prompt === 'string' ? request.input.prompt : ''
}

function imagesOf(request: ProviderRequest): string[] {
  if (!Array.isArray(request.input.images)) return []
  return request.input.images.filter((image): image is string => typeof image === 'string')
}

function assertSupported(capability: ModelCapability): void {
  if (SUPPORTED_MODALITIES.has(capability.modality)) return
  throw new Error(`openai-compatible adapter does not support modality "${capability.modality}" (no endpoint implemented)`)
}

/**
 * Chat is the one call this vendor family does not share byte-for-byte with OpenAI.
 * The hosted API renamed `max_tokens` to `max_completion_tokens`; a gateway that has
 * not followed the rename rejects the new key, so the compatible adapter speaks the
 * older one, which the current OpenAI implementation still accepts.
 */
export function buildCompatChatRequest(
  baseUrl: string,
  apiKey: string,
  capability: ModelCapability,
  request: ProviderRequest,
): OpenAIHttpRequest {
  if (capability.modality !== 'text' && capability.modality !== 'vlm') {
    throw new Error(`openai-compatible chat endpoint does not serve modality "${capability.modality}"`)
  }
  const prompt = promptOf(request)
  const supplied = Array.isArray(request.input.messages) && request.input.messages.length > 0 ? request.input.messages : undefined
  const content: unknown = capability.modality === 'vlm'
    ? [...imagesOf(request).map(url => ({ type: 'image_url', image_url: { url } })), { type: 'text', text: prompt }]
    : prompt
  return {
    url: `${baseUrlOf(baseUrl)}${CHAT_PATH}`,
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
    body: {
      model: request.model,
      messages: supplied ?? [{ role: 'user', content }],
      ...mergeCompatChatParameters(request.parameters),
    },
  }
}

/** Same restraint as the OpenAI adapter: only sampling keys that cannot change the contract. */
export function mergeCompatChatParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  if (typeof parameters.temperature === 'number' && Number.isFinite(parameters.temperature)) merged.temperature = parameters.temperature
  if (typeof parameters.max_tokens === 'number' && Number.isFinite(parameters.max_tokens)) merged.max_tokens = parameters.max_tokens
  return merged
}

/** One word in, one token out: the cheapest call that can still name a model. */
export function buildCompatModelProbeRequest(baseUrl: string, apiKey: string, capability: ModelCapability): ModelProbeRequest {
  const { url, headers, body } = buildCompatChatRequest(baseUrl, apiKey, capability, {
    model: capability.model,
    input: { prompt: 'ping' },
    parameters: { max_tokens: 1 },
  })
  return { url, headers, body }
}

/**
 * `/v1/models` is near-universal across these routers and costs nothing. A gateway
 * without it reports an unusable connection rather than a green light, which is the
 * right trade: the alternative is a probe that proves nothing.
 */
export function buildCompatProbeRequest(baseUrl: string, apiKey: string): OpenAIHttpRequest {
  return { url: `${baseUrlOf(baseUrl)}${MODELS_PATH}`, method: 'GET', headers: authHeaders(apiKey) }
}

interface SyncOutcome {
  text?: string
  inlineArtifact?: { bytes: Uint8Array; mimeType: string }
}

const syncResults = new Map<string, SyncOutcome>()
let syncCounter = 0

export class OpenAICompatibleAdapter implements ProviderAdapter {
  provider = 'openai_compatible'

  private credential?: Promise<ProbeResult>

  constructor(private readonly options: AdapterOptions) {}

  async probe(capability: ModelCapability): Promise<ProbeResult> {
    if (!SUPPORTED_MODALITIES.has(capability.modality)) {
      return { ok: false, status: 0, message: `no openai-compatible endpoint for modality "${capability.modality}"` }
    }
    this.credential ??= this.checkCredential()
    const result = await this.credential
    return result.ok ? { ...result, message: `probe ok for ${capability.model}` } : result
  }

  private async checkCredential(): Promise<ProbeResult> {
    const httpRequest = buildCompatProbeRequest(this.options.baseUrl, this.options.apiKey)
    try {
      const response = await fetch(httpRequest.url, { method: httpRequest.method, headers: httpRequest.headers })
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (!response.ok) return { ok: false, status: response.status, message: sanitizeError(body?.error ?? body ?? response.statusText) }
      if (!Array.isArray(body?.data)) return { ok: false, status: response.status, message: 'openai-compatible probe: 2xx without a "data" model list' }
      return { ok: true, status: response.status, message: 'probe ok' }
    } catch (error) {
      return { ok: false, status: 0, message: sanitizeError(error instanceof Error ? error.message : error) }
    }
  }

  async verifyModel(capability: ModelCapability): Promise<ProbeResult> {
    return probeModel(
      buildCompatModelProbeRequest(this.options.baseUrl, this.options.apiKey, capability),
      capability.model,
      body => Array.isArray(body.choices) && body.choices.length > 0,
    )
  }

  async submit(capability: ModelCapability, request: ProviderRequest): Promise<SubmitResult> {
    assertSupported(capability)
    // Every endpoint in this family answers in one call, so the task enters the queue
    // already finished and resolves on the first poll.
    const outcome = capability.modality === 'image'
      ? await this.generateImage(request)
      : capability.modality === 'tts'
        ? await this.generateSpeech(request)
        : await this.generateText(capability, request)
    const taskId = `oac-sync-${++syncCounter}`
    syncResults.set(taskId, outcome)
    return { taskId }
  }

  private async generateText(capability: ModelCapability, request: ProviderRequest): Promise<SyncOutcome> {
    const httpRequest = buildCompatChatRequest(this.options.baseUrl, this.options.apiKey, capability, request)
    const body = await this.json(httpRequest)
    return { text: extractOpenAIChatText(body) }
  }

  private async generateImage(request: ProviderRequest): Promise<SyncOutcome> {
    const httpRequest = buildOpenAIImageRequest(this.options.baseUrl, this.options.apiKey, request)
    const body = await this.json(httpRequest)
    const encoded = extractOpenAIImageBase64(body)
    if (!encoded) throw new Error(`openai-compatible image response carries no b64_json: ${sanitizeError(body ?? 'empty body')}`)
    return { inlineArtifact: { bytes: new Uint8Array(Buffer.from(encoded, 'base64')), mimeType: mimeTypeForOpenAIImage(request.parameters) } }
  }

  private async generateSpeech(request: ProviderRequest): Promise<SyncOutcome> {
    const httpRequest = buildOpenAISpeechRequest(this.options.baseUrl, this.options.apiKey, request)
    const response = await fetch(httpRequest.url, { method: httpRequest.method, headers: httpRequest.headers, body: JSON.stringify(httpRequest.body) })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
      throw new Error(sanitizeError(body?.error ?? body ?? `HTTP ${response.status}`))
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0) throw new Error('openai-compatible speech response was empty')
    return { inlineArtifact: { bytes, mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || mimeTypeForOpenAISpeech(request.parameters) } }
  }

  private async json(httpRequest: OpenAIHttpRequest): Promise<Record<string, unknown> | null> {
    const response = await fetch(httpRequest.url, {
      method: httpRequest.method,
      headers: httpRequest.headers,
      body: httpRequest.body === undefined ? undefined : JSON.stringify(httpRequest.body),
    })
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) throw new Error(sanitizeError(body?.error ?? body ?? `HTTP ${response.status}`))
    return body
  }

  async poll(capability: ModelCapability, taskId: string): Promise<PollResult> {
    assertSupported(capability)
    const cached = syncResults.get(taskId)
    if (!cached) return { status: 'failed', error: `openai-compatible: unknown task ${taskId} — these endpoints answer in one call, so a task id is never polled` }
    syncResults.delete(taskId)
    return { status: 'completed', ...cached }
  }
}

/** Test hook: the sync task map is module state, so a suite has to be able to clear it. */
export function resetOpenAICompatibleSyncResults(): void {
  syncResults.clear()
  syncCounter = 0
}
