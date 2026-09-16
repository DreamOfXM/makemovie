import type { ModelCapability, ModelModality } from '@studio/domain'
import type { AdapterOptions, MediaReference, ModelProbeRequest, PollResult, ProbeResult, ProviderAdapter, ProviderRequest, SubmitResult } from './types.js'
import { parseDataUrl, probeModel, readMediaReferences, sanitizeError } from './types.js'

export const GOOGLE_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com'

const API_VERSION = 'v1beta'

const SUPPORTED_MODALITIES = new Set<ModelModality>(['text', 'vlm', 'image', 't2v', 'i2v'])

/** Veo answers on a long-running endpoint and takes its frames in an `instances` array, so every other modality shares one synchronous path. */
function isVideoModality(modality: ModelModality): boolean {
  return modality === 't2v' || modality === 'i2v'
}

export interface GoogleHttpRequest {
  url: string
  method: 'POST' | 'GET'
  headers: Record<string, string>
  body?: unknown
}

function baseUrlOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * Gemini authenticates with a key header, not a bearer token. Sending both is how a
 * connection ends up with a confusing 401 from a proxy rather than a clear one from Google.
 */
function authHeaders(apiKey: string): Record<string, string> {
  return { 'x-goog-api-key': apiKey }
}

function promptOf(request: ProviderRequest): string {
  return typeof request.input.prompt === 'string' ? request.input.prompt : ''
}

function assertSupported(capability: ModelCapability): void {
  if (SUPPORTED_MODALITIES.has(capability.modality)) return
  throw new Error(`google adapter does not support modality "${capability.modality}" (no endpoint implemented)`)
}

export function buildGoogleGenerateRequest(
  baseUrl: string,
  apiKey: string,
  capability: ModelCapability,
  request: ProviderRequest,
): GoogleHttpRequest {
  if (isVideoModality(capability.modality)) throw new Error('google video models use the long-running predict endpoint')
  const prompt = promptOf(request)
  const supplied = Array.isArray(request.input.messages) && request.input.messages.length > 0 ? request.input.messages : undefined
  const parts: unknown[] = []
  if (capability.modality === 'vlm') {
    // The audit hands over data URLs; Gemini inline parts want the type and the payload
    // apart, so anything that is not one is dropped rather than sent as a broken part.
    for (const image of Array.isArray(request.input.images) ? request.input.images : []) {
      if (typeof image !== 'string') continue
      const parsed = parseDataUrl(image)
      if (parsed) parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } })
    }
  }
  parts.push({ text: prompt })
  return {
    url: `${baseUrlOf(baseUrl)}/${API_VERSION}/models/${request.model}:generateContent`,
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
    body: {
      contents: supplied ? supplied.map(message => toGoogleMessage(message)) : [{ role: 'user', parts }],
      ...googleGenerationConfig(capability, request.parameters),
    },
  }
}

function toGoogleMessage(message: unknown): unknown {
  const record = typeof message === 'object' && message !== null ? message as { role?: unknown; content?: unknown } : {}
  const content = typeof record.content === 'string' ? [{ text: record.content }] : record.content
  return { role: typeof record.role === 'string' ? record.role : 'user', parts: Array.isArray(content) ? content : [] }
}

/**
 * An image model only returns a picture when it is told the answer may contain one, so
 * the modality of the bound capability decides the response shape rather than the model name.
 */
export function googleGenerationConfig(capability: ModelCapability, parameters: Record<string, unknown>): { generationConfig: Record<string, unknown> } {
  const generationConfig: Record<string, unknown> = {}
  if (capability.modality === 'image') generationConfig.responseModalities = ['TEXT', 'IMAGE']
  if (typeof parameters.aspectRatio === 'string') generationConfig.imageConfig = { aspectRatio: parameters.aspectRatio }
  if (typeof parameters.temperature === 'number' && Number.isFinite(parameters.temperature)) generationConfig.temperature = parameters.temperature
  if (typeof parameters.maxOutputTokens === 'number' && Number.isFinite(parameters.maxOutputTokens)) generationConfig.maxOutputTokens = parameters.maxOutputTokens
  return { generationConfig }
}

/** One word in, one token out: a probe that could still write an essay is not a cheap check. */
export function buildGoogleModelProbeRequest(baseUrl: string, apiKey: string, capability: ModelCapability): ModelProbeRequest {
  const { url, headers, body } = buildGoogleGenerateRequest(baseUrl, apiKey, capability, {
    model: capability.model,
    input: { prompt: 'ping' },
    parameters: { maxOutputTokens: 1 },
  })
  return { url, headers, body }
}

/** Veo wants the type and the payload in two fields; the worker hands over one data URL. */
function toVeoInline(url: string, type: string): { inlineData: { mimeType: string; data: string } } {
  const parsed = parseDataUrl(url)
  if (!parsed) throw new Error(`veo takes the "${type}" frame inline as a base64 data URL, got a value that is not one`)
  return { inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } }
}

/**
 * Where each neutral reference type lands in a Veo instance.
 *
 * `reference_image` is absent on purpose: the vendor caps those at three and names them a
 * Veo 3.1 feature, but no stage of this pipeline decides which character a shot belongs to,
 * so a row that accepted them would be a promise nothing upstream can keep.
 */
function applyVeoReferences(instance: Record<string, unknown>, media: MediaReference[]): void {
  for (const reference of media) {
    if (reference.type === 'first_frame') {
      if (instance.image) throw new Error('veo takes one first frame, two were sent')
      instance.image = toVeoInline(reference.url, reference.type)
      continue
    }
    if (reference.type === 'last_frame') {
      // The vendor documents it as a transition target for the same clip, not as a second
      // starting frame, so a last frame with nothing to start from is a malformed request.
      if (!instance.image) throw new Error('veo takes a last frame only alongside a first frame')
      instance.lastFrame = toVeoInline(reference.url, reference.type)
      continue
    }
    throw new Error(`veo has no field for a "${reference.type}" reference`)
  }
}

/** Veo takes the prompt inside an `instances` array and answers with an operation, not a clip. */
export function buildGoogleVideoSubmitRequest(baseUrl: string, apiKey: string, request: ProviderRequest): GoogleHttpRequest {
  const parameters: Record<string, unknown> = {}
  if (typeof request.parameters.aspectRatio === 'string') parameters.aspectRatio = request.parameters.aspectRatio
  if (typeof request.parameters.durationSeconds === 'number' && Number.isFinite(request.parameters.durationSeconds)) parameters.durationSeconds = request.parameters.durationSeconds
  const instance: Record<string, unknown> = { prompt: promptOf(request) }
  applyVeoReferences(instance, readMediaReferences(request.input.media))
  return {
    url: `${baseUrlOf(baseUrl)}/${API_VERSION}/models/${request.model}:predictLongRunning`,
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
    body: { instances: [instance], parameters },
  }
}

/**
 * The operation name (`models/veo-…/operations/…`) is the task id. Unlike a synthetic id
 * it survives a worker restart, because the vendor keeps the operation, not this process.
 */
export function buildGoogleOperationRequest(baseUrl: string, apiKey: string, operationName: string): GoogleHttpRequest {
  return { url: `${baseUrlOf(baseUrl)}/${API_VERSION}/${operationName.replace(/^\/+/, '')}`, method: 'GET', headers: authHeaders(apiKey) }
}

/**
 * The operation's video URI is served by the same API and is not public. The key rides in
 * the header rather than the query string, because a URL lands in access logs and a header
 * does not.
 */
export function buildGoogleDownloadRequest(baseUrl: string, apiKey: string, fileUri: string): GoogleHttpRequest {
  return { url: fileUri, method: 'GET', headers: authHeaders(apiKey) }
}

/** GET /models costs nothing and proves the key; it proves nothing about one model's entitlement. */
export function buildGoogleProbeRequest(baseUrl: string, apiKey: string): GoogleHttpRequest {
  return { url: `${baseUrlOf(baseUrl)}/${API_VERSION}/models`, method: 'GET', headers: authHeaders(apiKey) }
}

export function extractGoogleText(body: Record<string, unknown> | null): string {
  const candidates = Array.isArray(body?.candidates) ? body.candidates : []
  const parts = candidates
    .map(candidate => (typeof candidate === 'object' && candidate !== null ? (candidate as { content?: { parts?: unknown } }).content?.parts : undefined))
    .filter((list): list is unknown[] => Array.isArray(list))
    .flat()
  return parts.map(part => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('')
}

export interface GoogleInlinePart {
  bytes: Uint8Array
  mimeType: string
}

export function extractGoogleInlineImage(body: Record<string, unknown> | null): GoogleInlinePart | undefined {
  const candidates = Array.isArray(body?.candidates) ? body.candidates : []
  for (const candidate of candidates) {
    const parts = typeof candidate === 'object' && candidate !== null ? (candidate as { content?: { parts?: unknown } }).content?.parts : undefined
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      const inline = typeof part === 'object' && part !== null ? (part as { inlineData?: { mimeType?: unknown; data?: unknown } }).inlineData : undefined
      if (!inline || typeof inline.data !== 'string' || inline.data.length === 0) continue
      return { bytes: new Uint8Array(Buffer.from(inline.data, 'base64')), mimeType: typeof inline.mimeType === 'string' ? inline.mimeType : 'image/png' }
    }
  }
  return undefined
}

export function extractGoogleVideoUri(body: Record<string, unknown> | null): string | undefined {
  const response = body?.response
  if (typeof response !== 'object' || response === null) return undefined
  const videoResponse = (response as { generateVideoResponse?: unknown }).generateVideoResponse
  if (typeof videoResponse !== 'object' || videoResponse === null) return undefined
  const samples = (videoResponse as { generatedSamples?: unknown }).generatedSamples
  if (!Array.isArray(samples)) return undefined
  for (const sample of samples) {
    const video = typeof sample === 'object' && sample !== null ? (sample as { video?: { uri?: unknown } }).video : undefined
    if (video && typeof video.uri === 'string' && video.uri.length > 0) return video.uri
  }
  return undefined
}

interface SyncOutcome {
  text?: string
  inlineArtifact?: GoogleInlinePart
}

const syncResults = new Map<string, SyncOutcome>()
let syncCounter = 0

export class GoogleAdapter implements ProviderAdapter {
  provider = 'google'

  private credential?: Promise<ProbeResult>

  constructor(private readonly options: AdapterOptions) {}

  async probe(capability: ModelCapability): Promise<ProbeResult> {
    if (!SUPPORTED_MODALITIES.has(capability.modality)) {
      return { ok: false, status: 0, message: `no google endpoint for modality "${capability.modality}"` }
    }
    this.credential ??= this.checkCredential()
    const result = await this.credential
    return result.ok ? { ...result, message: `probe ok for ${capability.model}` } : result
  }

  private async checkCredential(): Promise<ProbeResult> {
    const httpRequest = buildGoogleProbeRequest(this.options.baseUrl, this.options.apiKey)
    try {
      const response = await fetch(httpRequest.url, { method: httpRequest.method, headers: httpRequest.headers })
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (!response.ok) return { ok: false, status: response.status, message: sanitizeError(body?.error ?? body ?? response.statusText) }
      if (!Array.isArray(body?.models)) return { ok: false, status: response.status, message: 'google probe: 2xx without a "models" list' }
      return { ok: true, status: response.status, message: 'probe ok' }
    } catch (error) {
      return { ok: false, status: 0, message: sanitizeError(error instanceof Error ? error.message : error) }
    }
  }

  async verifyModel(capability: ModelCapability): Promise<ProbeResult> {
    return probeModel(
      buildGoogleModelProbeRequest(this.options.baseUrl, this.options.apiKey, capability),
      capability.model,
      body => Array.isArray(body.candidates),
    )
  }

  async submit(capability: ModelCapability, request: ProviderRequest): Promise<SubmitResult> {
    assertSupported(capability)
    if (isVideoModality(capability.modality)) {
      const httpRequest = buildGoogleVideoSubmitRequest(this.options.baseUrl, this.options.apiKey, request)
      const body = await this.json(httpRequest)
      const name = body?.name
      // The operation name is the id, so a poll after a restart still finds the generation
      // that was already paid for.
      if (typeof name !== 'string' || name.length === 0) throw new Error(`google video response missing operation name: ${sanitizeError(body ?? 'empty body')}`)
      return { taskId: name }
    }

    const outcome = await this.generateOnce(capability, request)
    const taskId = `go-sync-${++syncCounter}`
    syncResults.set(taskId, outcome)
    return { taskId }
  }

  /** Text and picture share one endpoint; only the part the caller wants differs. */
  private async generateOnce(capability: ModelCapability, request: ProviderRequest): Promise<SyncOutcome> {
    const httpRequest = buildGoogleGenerateRequest(this.options.baseUrl, this.options.apiKey, capability, request)
    const body = await this.json(httpRequest)
    if (capability.modality !== 'image') return { text: extractGoogleText(body) }
    const inline = extractGoogleInlineImage(body)
    if (!inline) throw new Error(`google image response carried no inlineData part: ${sanitizeError(body ?? 'empty body')}`)
    return { inlineArtifact: inline }
  }

  private async json(httpRequest: GoogleHttpRequest): Promise<Record<string, unknown> | null> {
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
    if (taskId.startsWith('go-sync-')) {
      const cached = syncResults.get(taskId)
      if (!cached) return { status: 'failed', error: `google: unknown sync task ${taskId}` }
      syncResults.delete(taskId)
      return { status: 'completed', ...cached }
    }

    const httpRequest = buildGoogleOperationRequest(this.options.baseUrl, this.options.apiKey, taskId)
    const response = await fetch(httpRequest.url, { method: httpRequest.method, headers: httpRequest.headers })
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) {
      if (response.status === 404) return { status: 'failed', error: sanitizeError(body?.error ?? body ?? `operation ${taskId} not found`) }
      return { status: 'running', error: sanitizeError(body?.error ?? body ?? `HTTP ${response.status}`) }
    }
    if (body?.done !== true) return { status: 'running' }

    const error = body.error
    if (error !== undefined && error !== null) {
      return { status: 'failed', error: sanitizeError(error) }
    }
    const uri = extractGoogleVideoUri(body)
    if (!uri) return { status: 'failed', error: 'google: video operation finished but no generatedSamples video uri was returned' }

    const download = buildGoogleDownloadRequest(this.options.baseUrl, this.options.apiKey, uri)
    const file = await fetch(download.url, { method: download.method, headers: download.headers })
    if (!file.ok) return { status: 'failed', error: `google: video uri download failed with HTTP ${file.status}` }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.byteLength === 0) return { status: 'failed', error: 'google: video uri returned an empty body' }
    return { status: 'completed', inlineArtifact: { bytes, mimeType: file.headers.get('content-type')?.split(';')[0]?.trim() || 'video/mp4' } }
  }
}

/** Test hook: the sync task map is module state, so a suite has to be able to clear it. */
export function resetGoogleSyncResults(): void {
  syncResults.clear()
  syncCounter = 0
}
