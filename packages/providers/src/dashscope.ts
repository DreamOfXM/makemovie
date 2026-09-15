import type { ModelCapability } from '@studio/domain'
import type { AdapterOptions, ModelProbeRequest, PollResult, ProbeResult, ProviderAdapter, ProviderRequest, SubmitResult } from './types.js'
import { probeModel, readMediaReferences, sanitizeError, validateReferenceRequest } from './types.js'

const TEXT_PATH = '/api/v1/services/aigc/text-generation/generation'
const VLM_PATH = '/api/v1/services/aigc/multimodal-generation/generation'
const IMAGE_PATH = '/api/v1/services/aigc/text2image/image-synthesis'
const VIDEO_PATH = '/api/v1/services/aigc/video-generation/video-synthesis'
const MUSIC_PATH = '/api/v1/services/audio/music/generation'
const TASK_PATH = '/api/v1/tasks'

const DEFAULT_TTS_VOICE = 'Cherry'

export interface DashScopeHttpRequest {
  url: string
  method: 'POST' | 'GET'
  headers: Record<string, string>
  body?: unknown
}

export function buildSubmitRequest(
  baseUrl: string,
  apiKey: string,
  capability: ModelCapability,
  request: ProviderRequest,
): DashScopeHttpRequest {
  const base = baseUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
  const prompt = typeof request.input.prompt === 'string' ? request.input.prompt : ''

  if (capability.modality === 'text') {
    const messages = Array.isArray(request.input.messages) && request.input.messages.length > 0
      ? request.input.messages
      : [{ role: 'user', content: prompt }]
    return {
      url: `${base}${TEXT_PATH}`,
      method: 'POST',
      headers,
      body: { model: request.model, input: { messages }, parameters: request.parameters },
    }
  }

  // The multimodal endpoint and its messages input shape are proven live — the
  // Qwen-Image path below uses this same endpoint — but the VLM direction is not:
  // no qwen-vl model was available, so whether a base64 data URL is accepted where a
  // public image URL is documented, and the text-verdict extraction, remain untested.
  // The visual audit relies on it.
  if (capability.modality === 'vlm') {
    const images = Array.isArray(request.input.images)
      ? request.input.images.filter((image): image is string => typeof image === 'string')
      : []
    const messages = Array.isArray(request.input.messages) && request.input.messages.length > 0
      ? request.input.messages
      : [{ role: 'user', content: [...images.map(image => ({ image })), { text: prompt }] }]
    return {
      url: `${base}${VLM_PATH}`,
      method: 'POST',
      headers,
      body: { model: request.model, input: { messages }, parameters: request.parameters },
    }
  }

  // Qwen-Image answers synchronously on the multimodal endpoint (verified live), so it
  // must not carry the async header the wanx task models below need.
  if (capability.modality === 'image' && isQwenImage(capability.model)) {
    return {
      url: `${base}${VLM_PATH}`,
      method: 'POST',
      headers,
      body: { model: request.model, input: { messages: [{ role: 'user', content: [{ text: prompt }] }] }, parameters: request.parameters },
    }
  }

  // Also synchronous on the multimodal endpoint, but this one takes no `parameters`
  // object: the caller's voice selection is resolved to a DashScope voice name here.
  if (capability.modality === 'tts') {
    const voice = typeof request.parameters.voice === 'string' ? request.parameters.voice : DEFAULT_TTS_VOICE
    // A spoken line is too short for the model to infer its language from — a name or
    // a number reads either way — so the project's content language is passed through.
    // Absent means Chinese, which is every task written before languages were chosen.
    const languageType = request.input.contentLocale === 'en' ? 'English' : 'Chinese'
    return {
      url: `${base}${VLM_PATH}`,
      method: 'POST',
      headers,
      body: { model: request.model, input: { text: prompt, voice, language_type: languageType } },
    }
  }

  headers['X-DashScope-Async'] = 'enable'

  if (capability.modality === 'image') {
    return {
      url: `${base}${IMAGE_PATH}`,
      method: 'POST',
      headers,
      body: { model: request.model, input: { prompt }, parameters: request.parameters },
    }
  }

  if (capability.modality === 't2v') {
    validateReferenceRequest(capability, request.input)
    return {
      url: `${base}${VIDEO_PATH}`,
      method: 'POST',
      headers,
      body: { model: request.model, input: { prompt }, parameters: videoParameters(request.parameters) },
    }
  }

  if (capability.modality === 'i2v' || capability.modality === 'r2v') {
    validateReferenceRequest(capability, request.input)
    const media = readMediaReferences(request.input.media)

    // Wan 2.7 speaks the media array natively. The 2.1–2.6 generation behind it has one
    // slot for one frame, so the reference list has to collapse — and collapsing it
    // silently would drop a conditioning input the caller paid for, hence the throw.
    if (usesMediaVideoApi(capability.model)) {
      if (media.length > 2) throw new Error(`model "${capability.model}" takes at most two media items, ${media.length} were sent`)
      return {
        url: `${base}${VIDEO_PATH}`,
        method: 'POST',
        headers,
        body: { model: request.model, input: { prompt, media }, parameters: videoParameters(request.parameters) },
      }
    }
    if (capability.modality === 'r2v') {
      throw new Error(`model "${capability.model}" has no reference-to-video endpoint: only the wan2.7 generation takes a media array`)
    }
    const firstFrame = media.find(reference => reference.type === 'first_frame')
    if (!firstFrame) throw new Error(`dashscope i2v needs a first_frame reference, model "${capability.model}"`)
    if (media.length > 1) {
      throw new Error(`model "${capability.model}" has room for one frame, ${media.length} references were sent`)
    }
    return {
      url: `${base}${VIDEO_PATH}`,
      method: 'POST',
      headers,
      body: { model: request.model, input: { prompt, img_url: firstFrame.url }, parameters: videoParameters(request.parameters) },
    }
  }

  if (capability.modality === 'music') {
    return {
      url: `${base}${MUSIC_PATH}`,
      method: 'POST',
      headers,
      body: { model: request.model, input: { prompt }, parameters: request.parameters },
    }
  }

  throw new Error(`dashscope adapter does not support modality "${capability.modality}" (no public endpoint implemented)`)
}

export function buildPollRequest(baseUrl: string, apiKey: string, taskId: string): DashScopeHttpRequest {
  const base = baseUrl.replace(/\/+$/, '')
  return {
    url: `${base}${TASK_PATH}/${taskId}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  }
}

/**
 * Always the text endpoint, whatever capability is being probed: the call proves
 * the connection's API key, not entitlement for a specific model. Routing it
 * through buildSubmitRequest instead would throw for i2v and for the modalities
 * this adapter has no endpoint for.
 */
export function buildCredentialProbeRequest(baseUrl: string, apiKey: string): DashScopeHttpRequest {
  const base = baseUrl.replace(/\/+$/, '')
  return {
    url: `${base}${TEXT_PATH}`,
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: { model: 'qwen-turbo', input: { messages: [{ role: 'user', content: 'ping' }] }, parameters: { max_tokens: 1 } },
  }
}

/**
 * The same ping, addressed to the model being verified. Which endpoint it goes to
 * follows the modality: a qwen-vl model is served by the multimodal path and not the
 * text one, so probing every model through one URL would fail the vision rows for the
 * wrong reason. The vision call carries no `parameters`, because that endpoint's
 * accepted keys are not something to guess at for a check that is only about identity.
 */
export function buildModelProbeRequest(baseUrl: string, apiKey: string, capability: ModelCapability): ModelProbeRequest {
  const base = baseUrl.replace(/\/+$/, '')
  if (capability.modality === 'vlm') {
    return {
      url: `${base}${VLM_PATH}`,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: { model: capability.model, input: { messages: [{ role: 'user', content: [{ text: 'ping' }] }] } },
    }
  }
  return {
    url: `${base}${TEXT_PATH}`,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: { model: capability.model, input: { messages: [{ role: 'user', content: 'ping' }] }, parameters: { max_tokens: 1 } },
  }
}

function extractArtifactUrl(output: Record<string, unknown>): string | undefined {
  if (typeof output.video_url === 'string') return output.video_url
  const results = output.results
  if (Array.isArray(results)) {
    for (const item of results) {
      if (typeof item === 'object' && item !== null && typeof (item as { url?: unknown }).url === 'string') {
        return (item as { url: string }).url
      }
    }
  }
  return undefined
}

/** Qwen-Image models generate synchronously on the multimodal endpoint, unlike the async wanx task models. */
export function isQwenImage(model: string): boolean {
  return model.startsWith('qwen-image')
}

/**
 * Which dialect a wan video model speaks. Both generations post to the same path, so
 * only the name says whether the frame goes in `input.img_url` or in `input.media` —
 * and sending the wrong one is a vendor-side 400 on a request already billed.
 */
export function usesMediaVideoApi(model: string): boolean {
  return model.startsWith('wan2.7')
}

/**
 * A delivered master must not carry a vendor watermark, and it must not be the answer to
 * a prompt nobody wrote: `prompt_extend` lets the service rewrite the request, which would
 * turn the stored `requestSnapshot` into a description of something that was never sent and
 * leave a re-run unable to reproduce the clip. Both are defaults a caller can still undo.
 */
function videoParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  return { watermark: false, prompt_extend: false, ...parameters }
}

/** Verified live: the sync multimodal response carries the image at output.choices[0].message.content[0].image. */
function extractSyncImageUrl(output: Record<string, unknown>): string | undefined {
  const choices = output.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const message = (choices[0] as { message?: unknown } | null)?.message
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  for (const part of content) {
    if (typeof part === 'object' && part !== null && typeof (part as { image?: unknown }).image === 'string') {
      return (part as { image: string }).image
    }
  }
  return undefined
}

/** The sync TTS response carries the clip at output.audio.url. */
function extractSyncAudioUrl(output: Record<string, unknown>): string | undefined {
  const audio = output.audio
  if (typeof audio === 'object' && audio !== null && typeof (audio as { url?: unknown }).url === 'string') {
    return (audio as { url: string }).url
  }
  return undefined
}

/**
 * DashScope answers in three shapes: `output.text` on the text endpoint's default
 * result format, `output.choices[0].message.content` as a bare string when
 * `result_format: 'message'`, and that same content as an array of `{text}` parts
 * on the multimodal endpoint. Unrecognised shapes yield an empty string — deciding
 * what a missing answer means is the caller's job, not this one's.
 */
export function extractDashScopeText(output: Record<string, unknown>): string {
  if (typeof output.text === 'string') return output.text
  const choices = output.choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const first = choices[0] as { message?: unknown } | null
  if (typeof first?.message !== 'object' || first.message === null) return ''
  const content = (first.message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (typeof part === 'object' && part !== null ? (part as { text?: unknown }).text : undefined))
    .filter((text): text is string => typeof text === 'string')
    .join('')
}

interface SyncResult {
  text?: string
  artifactUrl?: string
}

const syncResults = new Map<string, SyncResult>()
let syncCounter = 0

export class DashScopeAdapter implements ProviderAdapter {
  provider = 'dashscope'

  /** Memoised per adapter instance, which lives for exactly one probe run. */
  private credential?: Promise<ProbeResult>

  constructor(private readonly options: AdapterOptions) {}

  async probe(capability: ModelCapability): Promise<ProbeResult> {
    // Credential probe: a minimal text call verifies the API key. It does not
    // prove entitlement for `capability.model`; per-model entitlement is
    // established by the first real submission and recorded separately.
    this.credential ??= this.checkCredential()
    const result = await this.credential
    return result.ok ? { ...result, message: `probe ok for ${capability.model}` } : result
  }

  private async checkCredential(): Promise<ProbeResult> {
    const httpRequest = buildCredentialProbeRequest(this.options.baseUrl, this.options.apiKey)
    try {
      const response = await fetch(httpRequest.url, {
        method: httpRequest.method,
        headers: httpRequest.headers,
        body: JSON.stringify(httpRequest.body),
      })
      if (response.ok) return { ok: true, status: response.status, message: 'probe ok' }
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
      return { ok: false, status: response.status, message: sanitizeError(body ?? response.statusText) }
    } catch (error) {
      return { ok: false, status: 0, message: sanitizeError(error instanceof Error ? error.message : error) }
    }
  }

  async verifyModel(capability: ModelCapability): Promise<ProbeResult> {
    return probeModel(
      buildModelProbeRequest(this.options.baseUrl, this.options.apiKey, capability),
      capability.model,
      body => body.output !== undefined,
    )
  }

  async submit(capability: ModelCapability, request: ProviderRequest): Promise<SubmitResult> {
    const httpRequest = buildSubmitRequest(this.options.baseUrl, this.options.apiKey, capability, request)
    const response = await fetch(httpRequest.url, {
      method: httpRequest.method,
      headers: httpRequest.headers,
      body: httpRequest.body === undefined ? undefined : JSON.stringify(httpRequest.body),
    })
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) throw new Error(sanitizeError(body ?? `HTTP ${response.status}`))

    if (capability.modality === 'text' || capability.modality === 'vlm') {
      const output = (body?.output ?? {}) as Record<string, unknown>
      const text = extractDashScopeText(output)
      const taskId = `ds-sync-${++syncCounter}`
      syncResults.set(taskId, { text })
      return { taskId }
    }

    if (capability.modality === 'image' && isQwenImage(capability.model)) {
      const output = (body?.output ?? {}) as Record<string, unknown>
      const artifactUrl = extractSyncImageUrl(output)
      if (!artifactUrl) throw new Error(sanitizeError(body ?? 'dashscope qwen-image response missing an image url'))
      const taskId = `ds-sync-${++syncCounter}`
      syncResults.set(taskId, { artifactUrl })
      return { taskId }
    }

    if (capability.modality === 'tts') {
      const output = (body?.output ?? {}) as Record<string, unknown>
      const artifactUrl = extractSyncAudioUrl(output)
      if (!artifactUrl) throw new Error(sanitizeError(body ?? 'dashscope tts response missing output.audio.url'))
      const taskId = `ds-sync-${++syncCounter}`
      syncResults.set(taskId, { artifactUrl })
      return { taskId }
    }

    const output = (body?.output ?? {}) as Record<string, unknown>
    const taskId = output.task_id
    if (typeof taskId !== 'string') throw new Error(sanitizeError(body ?? 'dashscope response missing output.task_id'))
    return { taskId }
  }

  async poll(capability: ModelCapability, taskId: string): Promise<PollResult> {
    if (taskId.startsWith('ds-sync-')) {
      const cached = syncResults.get(taskId)
      if (!cached) return { status: 'failed', error: `dashscope: unknown sync task ${taskId}` }
      return cached.artifactUrl !== undefined
        ? { status: 'completed', artifactUrl: cached.artifactUrl }
        : { status: 'completed', text: cached.text }
    }

    const httpRequest = buildPollRequest(this.options.baseUrl, this.options.apiKey, taskId)
    const response = await fetch(httpRequest.url, { method: httpRequest.method, headers: httpRequest.headers })
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) {
      if (response.status === 404) return { status: 'failed', error: sanitizeError(body ?? `task ${taskId} not found`) }
      return { status: 'running', error: sanitizeError(body ?? `HTTP ${response.status}`) }
    }

    const output = (body?.output ?? {}) as Record<string, unknown>
    const taskStatus = typeof output.task_status === 'string' ? output.task_status : ''
    if (taskStatus === 'SUCCEEDED') {
      const artifactUrl = extractArtifactUrl(output)
      if (!artifactUrl) return { status: 'failed', error: 'dashscope: task succeeded but no artifact url in output' }
      return { status: 'completed', artifactUrl }
    }
    if (taskStatus === 'FAILED' || taskStatus === 'CANCELED' || taskStatus === 'UNKNOWN') {
      return { status: 'failed', error: sanitizeError(output.code ?? output.message ?? body ?? taskStatus) }
    }
    return { status: 'running' }
  }
}

export function resetDashScopeSyncResults(): void {
  syncResults.clear()
  syncCounter = 0
}
