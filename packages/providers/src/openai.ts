import type { ModelCapability, ModelModality } from '@studio/domain'
import type { AdapterOptions, PollResult, ProbeResult, ProviderAdapter, ProviderRequest, SubmitResult } from './types.js'
import { sanitizeError } from './types.js'

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com'

const CHAT_PATH = '/v1/chat/completions'
const IMAGES_PATH = '/v1/images/generations'
const SPEECH_PATH = '/v1/audio/speech'
const VIDEOS_PATH = '/v1/videos'
const MODELS_PATH = '/v1/models'

const SUPPORTED_MODALITIES = new Set<ModelModality>(['text', 'vlm', 'image', 'tts', 't2v'])

/**
 * Both media endpoints name the format they return, and the worker stores the type it is
 * told, so the pair has to stay in step rather than defaulting to one of them.
 */
const IMAGE_FORMATS: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }
const AUDIO_FORMATS: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', opus: 'audio/opus', pcm: 'audio/pcm' }

/** Only these ride along in the video create form; the vendor rejects unknown fields. */
const VIDEO_FIELDS = ['seconds', 'size', 'resolution'] as const

export interface OpenAIHttpRequest {
  url: string
  method: 'POST' | 'GET'
  headers: Record<string, string>
  /** The JSON payload; the video endpoint is the exception and declares its FormData body itself. */
  body?: Record<string, unknown>
}

/** Sora's create call is the one request in this adapter that is multipart rather than JSON. */
export interface OpenAIVideoCreateRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: FormData
}

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
  throw new Error(`openai adapter does not support modality "${capability.modality}" (no endpoint implemented)`)
}

export function buildOpenAIChatRequest(
  baseUrl: string,
  apiKey: string,
  capability: ModelCapability,
  request: ProviderRequest,
): OpenAIHttpRequest {
  if (capability.modality !== 'text' && capability.modality !== 'vlm') {
    throw new Error(`openai chat endpoint does not serve modality "${capability.modality}"`)
  }
  const prompt = promptOf(request)
  const supplied = Array.isArray(request.input.messages) && request.input.messages.length > 0 ? request.input.messages : undefined
  // The audit passes a data URL per image, which chat completions accept in place of a
  // public URL — the one place our storage model and OpenAI's input model agree.
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
      ...mergeOpenAIChatParameters(request.parameters),
    },
  }
}

/** Chat accepts a long tail of sampling keys; we forward only the ones that cannot change the contract. */
export function mergeOpenAIChatParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  if (typeof parameters.temperature === 'number' && Number.isFinite(parameters.temperature)) merged.temperature = parameters.temperature
  if (typeof parameters.max_completion_tokens === 'number' && Number.isFinite(parameters.max_completion_tokens)) merged.max_completion_tokens = parameters.max_completion_tokens
  return merged
}

export function buildOpenAIImageRequest(baseUrl: string, apiKey: string, request: ProviderRequest): OpenAIHttpRequest {
  const size = stringParameter(request.parameters, 'size')
  return {
    url: `${baseUrlOf(baseUrl)}${IMAGES_PATH}`,
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
    body: {
      model: request.model,
      prompt: promptOf(request),
      // gpt-image-1 answers with base64 only, which is why the artifact is carried as bytes.
      ...(size ? { size } : {}),
      ...openAIImageFormat(request.parameters),
    },
  }
}

export function openAIImageFormat(parameters: Record<string, unknown>): { output_format: string } | Record<string, never> {
  const format = typeof parameters.output_format === 'string' ? parameters.output_format.toLowerCase() : ''
  return format in IMAGE_FORMATS ? { output_format: format } : {}
}

export function mimeTypeForOpenAIImage(parameters: Record<string, unknown>): string {
  const format = typeof parameters.output_format === 'string' ? parameters.output_format.toLowerCase() : ''
  return IMAGE_FORMATS[format] ?? 'image/png'
}

export function buildOpenAISpeechRequest(baseUrl: string, apiKey: string, request: ProviderRequest): OpenAIHttpRequest {
  return {
    url: `${baseUrlOf(baseUrl)}${SPEECH_PATH}`,
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
    body: {
      model: request.model,
      // Speech takes the text as `input`, not `prompt` — the pipeline never sees this
      // difference, the adapter owns it.
      input: promptOf(request),
      voice: typeof request.parameters.voice === 'string' ? request.parameters.voice : 'alloy',
      ...openAISpeechFormat(request.parameters),
    },
  }
}

export function openAISpeechFormat(parameters: Record<string, unknown>): { response_format: string } | Record<string, never> {
  const format = typeof parameters.response_format === 'string' ? parameters.response_format.toLowerCase() : ''
  return format in AUDIO_FORMATS ? { response_format: format } : {}
}

export function mimeTypeForOpenAISpeech(parameters: Record<string, unknown>): string {
  const format = typeof parameters.response_format === 'string' ? parameters.response_format.toLowerCase() : ''
  return AUDIO_FORMATS[format] ?? 'audio/mpeg'
}

/**
 * Sora is created from form fields, and the returned id is polled rather than awaited,
 * so this is the one OpenAI modality that goes through the real task lifecycle.
 */
export function buildOpenAIVideoCreateRequest(baseUrl: string, apiKey: string, request: ProviderRequest): OpenAIVideoCreateRequest {
  const form = new FormData()
  form.set('model', request.model)
  form.set('prompt', promptOf(request))
  for (const field of VIDEO_FIELDS) {
    const value = request.parameters[field]
    if (typeof value === 'string' || typeof value === 'number') form.set(field, String(value))
  }
  return {
    url: `${baseUrlOf(baseUrl)}${VIDEOS_PATH}`,
    method: 'POST',
    // No Content-Type: FormData owns the multipart boundary.
    headers: authHeaders(apiKey),
    body: form,
  }
}

export function buildOpenAIVideoPollRequest(baseUrl: string, apiKey: string, taskId: string): OpenAIHttpRequest {
  return { url: `${baseUrlOf(baseUrl)}${VIDEOS_PATH}/${taskId}`, method: 'GET', headers: authHeaders(apiKey) }
}

/**
 * The finished clip sits behind an authenticated GET — the id is not a public link, so
 * handing a URL to the worker would only buy a 401. The adapter downloads it while it
 * still holds the key.
 */
export function buildOpenAIVideoContentRequest(baseUrl: string, apiKey: string, taskId: string): OpenAIHttpRequest {
  return { url: `${baseUrlOf(baseUrl)}${VIDEOS_PATH}/${taskId}/content`, method: 'GET', headers: authHeaders(apiKey) }
}

/** GET /models is the spend-free credential probe; it says nothing about entitlement for one model. */
export function buildOpenAIProbeRequest(baseUrl: string, apiKey: string): OpenAIHttpRequest {
  return { url: `${baseUrlOf(baseUrl)}${MODELS_PATH}`, method: 'GET', headers: authHeaders(apiKey) }
}

export function normalizeOpenAIVideoStatus(status: unknown): 'running' | 'completed' | 'failed' | 'unknown' {
  if (typeof status !== 'string') return 'unknown'
  switch (status) {
    case 'queued':
    case 'in_progress':
    case 'reviewing':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    default:
      return 'unknown'
  }
}

/** `content` is a string on the models we bind and an array of parts on the reasoning ones. */
export function extractOpenAIChatText(body: Record<string, unknown> | null): string {
  const choices = Array.isArray(body?.choices) ? body.choices : []
  const first = choices[0]
  const message = typeof first === 'object' && first !== null ? (first as { message?: unknown }).message : undefined
  const content = typeof message === 'object' && message !== null ? (message as { content?: unknown }).content : undefined
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('')
  }
  return ''
}

export function extractOpenAIImageBase64(body: Record<string, unknown> | null): string | undefined {
  const data = Array.isArray(body?.data) ? body.data : []
  const first = data[0]
  if (typeof first !== 'object' || first === null) return undefined
  const value = (first as { b64_json?: unknown }).b64_json
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function extractOpenAIVideoError(body: Record<string, unknown> | null): string | undefined {
  const error = body?.error
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return undefined
}

function stringParameter(parameters: Record<string, unknown>, key: string): string | undefined {
  const value = parameters[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

interface SyncOutcome {
  text?: string
  inlineArtifact?: { bytes: Uint8Array; mimeType: string }
}

const syncResults = new Map<string, SyncOutcome>()
let syncCounter = 0

export class OpenAIAdapter implements ProviderAdapter {
  provider = 'openai'

  private credential?: Promise<ProbeResult>

  constructor(private readonly options: AdapterOptions) {}

  async probe(capability: ModelCapability): Promise<ProbeResult> {
    if (!SUPPORTED_MODALITIES.has(capability.modality)) {
      return { ok: false, status: 0, message: `no openai endpoint for modality "${capability.modality}"` }
    }
    this.credential ??= this.checkCredential()
    const result = await this.credential
    return result.ok ? { ...result, message: `probe ok for ${capability.model}` } : result
  }

  private async checkCredential(): Promise<ProbeResult> {
    const httpRequest = buildOpenAIProbeRequest(this.options.baseUrl, this.options.apiKey)
    try {
      const response = await fetch(httpRequest.url, { method: httpRequest.method, headers: httpRequest.headers })
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (!response.ok) return { ok: false, status: response.status, message: sanitizeError(body?.error ?? body ?? response.statusText) }
      if (!Array.isArray(body?.data)) return { ok: false, status: response.status, message: 'openai probe: 2xx without a "data" model list' }
      return { ok: true, status: response.status, message: 'probe ok' }
    } catch (error) {
      return { ok: false, status: 0, message: sanitizeError(error instanceof Error ? error.message : error) }
    }
  }

  async submit(capability: ModelCapability, request: ProviderRequest): Promise<SubmitResult> {
    assertSupported(capability)
    if (capability.modality === 't2v') {
      const httpRequest = buildOpenAIVideoCreateRequest(this.options.baseUrl, this.options.apiKey, request)
      const response = await fetch(httpRequest.url, { method: httpRequest.method, headers: httpRequest.headers, body: httpRequest.body })
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (!response.ok) throw new Error(sanitizeError(body?.error ?? body ?? `HTTP ${response.status}`))
      const taskId = body?.id
      if (typeof taskId !== 'string' || taskId.length === 0) throw new Error(`openai video response missing id: ${sanitizeError(body ?? response.statusText)}`)
      return { taskId }
    }

    // Everything else on this vendor is a single request whose answer is already final,
    // so it enters the queue as a task that resolves on the first poll.
    const outcome = capability.modality === 'image'
      ? await this.generateImage(request)
      : capability.modality === 'tts'
        ? await this.generateSpeech(request)
        : await this.generateText(capability, request)
    const taskId = `oa-sync-${++syncCounter}`
    syncResults.set(taskId, outcome)
    return { taskId }
  }

  private async generateText(capability: ModelCapability, request: ProviderRequest): Promise<SyncOutcome> {
    const httpRequest = buildOpenAIChatRequest(this.options.baseUrl, this.options.apiKey, capability, request)
    const body = await this.json(httpRequest)
    return { text: extractOpenAIChatText(body) }
  }

  private async generateImage(request: ProviderRequest): Promise<SyncOutcome> {
    const httpRequest = buildOpenAIImageRequest(this.options.baseUrl, this.options.apiKey, request)
    const body = await this.json(httpRequest)
    const encoded = extractOpenAIImageBase64(body)
    if (!encoded) throw new Error(`openai image response carries no b64_json: ${sanitizeError(body ?? 'empty body')}`)
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
    if (bytes.byteLength === 0) throw new Error('openai speech response was empty')
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
    if (taskId.startsWith('oa-sync-')) {
      const cached = syncResults.get(taskId)
      if (!cached) return { status: 'failed', error: `openai: unknown sync task ${taskId}` }
      syncResults.delete(taskId)
      return { status: 'completed', ...cached }
    }

    const pollRequest = buildOpenAIVideoPollRequest(this.options.baseUrl, this.options.apiKey, taskId)
    const response = await fetch(pollRequest.url, { method: pollRequest.method, headers: pollRequest.headers })
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) {
      if (response.status === 404) return { status: 'failed', error: sanitizeError(body?.error ?? body ?? `video ${taskId} not found`) }
      return { status: 'running', error: sanitizeError(body?.error ?? body ?? `HTTP ${response.status}`) }
    }

    const status = normalizeOpenAIVideoStatus(body?.status)
    if (status === 'failed') return { status: 'failed', error: extractOpenAIVideoError(body) ?? `openai video ${taskId} failed` }
    if (status !== 'completed') return status === 'unknown' ? { status: 'running', error: `openai: unrecognised video status "${String(body?.status ?? '')}"` } : { status: 'running' }

    const contentRequest = buildOpenAIVideoContentRequest(this.options.baseUrl, this.options.apiKey, taskId)
    const content = await fetch(contentRequest.url, { method: contentRequest.method, headers: contentRequest.headers })
    if (!content.ok) return { status: 'failed', error: `openai: video ${taskId} completed but content download failed with HTTP ${content.status}` }
    const bytes = new Uint8Array(await content.arrayBuffer())
    if (bytes.byteLength === 0) return { status: 'failed', error: `openai: video ${taskId} content was empty` }
    return { status: 'completed', inlineArtifact: { bytes, mimeType: content.headers.get('content-type')?.split(';')[0]?.trim() || 'video/mp4' } }
  }
}

/** Test hook: the sync task map is module state, so a suite has to be able to clear it. */
export function resetOpenAISyncResults(): void {
  syncResults.clear()
  syncCounter = 0
}
