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
import type { AdapterOptions, ModelProbeRequest, PollResult, ProbeResult, ProviderAdapter, ProviderRequest, SubmitResult, TranscribeRequest, TranscribeResult, TranscribeSegment } from './types.js'
import { parseDataUrl, probeModel, sanitizeError } from './types.js'

const CHAT_PATH = '/v1/chat/completions'
const MODELS_PATH = '/v1/models'
const TRANSCRIPTIONS_PATH = '/v1/audio/transcriptions'

const SUPPORTED_MODALITIES = new Set<ModelModality>(['text', 'vlm', 'image', 'tts'])

/**
 * US-033: asr rows ride the same gateway as the rest — the credential probe (/v1/models)
 * proves the key for a transcription model just as well as for a chat one, and a real
 * per-model verification would cost an actual transcription. Keeping asr probeable is
 * what lets a hand-added asr capability survive the connection probe and bind to
 * audio_transcribe; submit/poll still refuse the modality (SUPPORTED_MODALITIES), since
 * transcribe bypasses the task queue entirely.
 */
const PROBE_MODALITIES = new Set<ModelModality>([...SUPPORTED_MODALITIES, 'asr'])

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

/** US-033: the audio half of the transcription request, whichever side of the contract it arrived on. */
function resolveAudio(request: TranscribeRequest): { bytes: Uint8Array; mimeType: string } {
  if (typeof request.audio.dataUrl === 'string') {
    const parsed = parseDataUrl(request.audio.dataUrl)
    if (!parsed) throw new Error('transcribe: audio.dataUrl is not a base64 data URL')
    return { bytes: new Uint8Array(Buffer.from(parsed.base64, 'base64')), mimeType: parsed.mimeType }
  }
  if (request.audio.bytes instanceof Uint8Array) {
    const mimeType = request.audio.mimeType ?? 'audio/wav'
    return { bytes: request.audio.bytes, mimeType }
  }
  throw new Error('transcribe: audio needs a dataUrl or bytes+mimeType')
}

function extensionForAudio(mimeType: string): string {
  if (mimeType.includes('mpeg')) return 'mp3'
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a'
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('flac')) return 'flac'
  return 'wav'
}

/**
 * US-033 真实转写:OpenAI 兼容网关的 /v1/audio/transcriptions,multipart 表单
 * (file + model + 可选 language),response_format 请求 verbose_json 以拿 segments;
 * 响应标准形态 { text, segments?: [{start, end, text}] }(start/end 为秒,数字或
 * 数字串都收)。协议按 OpenAI API 参考「Create transcription」2026-10——本仓库只对
 * stub 契约测试,真实转写验收由用户配 key 完成。expectedText 是 mock 元数据,这里
 * 必须忽略。
 */
export function buildCompatTranscriptionRequest(
  baseUrl: string,
  apiKey: string,
  capability: { model: string },
  request: TranscribeRequest,
): { url: string; headers: Record<string, string>; form: FormData } {
  const audio = resolveAudio(request)
  // Re-house the bytes in a fresh ArrayBuffer-backed view: a Uint8Array that arrived as
  // a Buffer or a slice view is Uint8Array<ArrayBufferLike>, which Blob rejects.
  const bytes = new Uint8Array(audio.bytes.byteLength)
  bytes.set(audio.bytes)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: audio.mimeType }), `audio.${extensionForAudio(audio.mimeType)}`)
  form.append('model', capability.model)
  form.append('response_format', 'verbose_json')
  if (typeof request.language === 'string' && request.language !== '') form.append('language', request.language)
  return { url: `${baseUrlOf(baseUrl)}${TRANSCRIPTIONS_PATH}`, headers: authHeaders(apiKey), form }
}

/** seconds (number or numeric string — both appear across gateways) → whole milliseconds. */
function toMs(value: unknown): number | undefined {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined
}

function mapTranscriptionSegments(value: unknown): TranscribeSegment[] {
  if (!Array.isArray(value)) return []
  const segments: TranscribeSegment[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { start?: unknown; end?: unknown; text?: unknown }
    const startMs = toMs(record.start)
    const text = typeof record.text === 'string' ? record.text : ''
    if (startMs === undefined) continue
    segments.push({ startMs, endMs: toMs(record.end) ?? startMs, text })
  }
  return segments
}

const syncResults = new Map<string, SyncOutcome>()
let syncCounter = 0

export class OpenAICompatibleAdapter implements ProviderAdapter {
  provider = 'openai_compatible'

  private credential?: Promise<ProbeResult>

  constructor(private readonly options: AdapterOptions) {}

  async probe(capability: ModelCapability): Promise<ProbeResult> {
    if (!PROBE_MODALITIES.has(capability.modality)) {
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

  /**
   * Synchronous by contract: /audio/transcriptions answers in one call, so the
   * adapter has no polling to digest. An empty key never gets a fabricated answer —
   * the call refuses before any bytes leave.
   */
  async transcribe(capability: ModelCapability, request: TranscribeRequest): Promise<TranscribeResult> {
    if (!this.options.apiKey) {
      throw new Error('openai-compatible transcription 需要配置 API key — connection carries no secret; refusing to fabricate a transcript')
    }
    const httpRequest = buildCompatTranscriptionRequest(this.options.baseUrl, this.options.apiKey, capability, request)
    const response = await fetch(httpRequest.url, { method: 'POST', headers: httpRequest.headers, body: httpRequest.form })
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) throw new Error(sanitizeError(body?.error ?? body ?? `HTTP ${response.status}`))
    const text = typeof body?.text === 'string' ? body.text : ''
    const segments = mapTranscriptionSegments(body?.segments)
    // A 2xx with neither half is not a transcript; returning it as one would feed the
    // diff an "empty audio" verdict the vendor never gave.
    if (text === '' && segments.length === 0) throw new Error(`transcription response carries neither text nor segments: ${sanitizeError(body ?? 'empty body')}`)
    return {
      transcript: text !== '' ? text : segments.map(segment => segment.text).join(''),
      ...(segments.length > 0 ? { segments } : {}),
      provider: 'openai_compatible',
      model: capability.model,
    }
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
