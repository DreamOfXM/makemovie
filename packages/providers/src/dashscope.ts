import type { ModelCapability } from '@studio/domain'
import type { AdapterOptions, ModelProbeRequest, PollResult, ProbeResult, ProviderAdapter, ProviderRequest, SubmitResult } from './types.js'
import { probeModel, readMediaReferences, sanitizeError, validateReferenceRequest } from './types.js'

// Chat lives on the OpenAI-compatible endpoint: the new generation of qwen models
// (qwen3.x-max and friends) is only served there, and the legacy native path answers
// them with a misleading `InvalidParameter | url error`. Verified live 2026-09-22.
const TEXT_PATH = '/compatible-mode/v1/chat/completions'
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
      // Compatible-mode takes OpenAI's flat body: messages and sampling knobs at
      // the top level, not nested under input/parameters.
      body: { model: request.model, messages, ...(request.parameters ?? {}) },
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
    // qwen-image-edit 需要请求里至少 1 个 image 项(纯文本会被百炼以
    // "must contain 1~3 image content items" 拒绝):定妆照参考图以 data URL
    // 走 {image: url} 项,放在指令前面。参考图解析在 worker 侧——模型行未声明
    // 接受参考图时不会带 media,届时这个校验会在发送前给出明确错误。
    validateReferenceRequest(capability, request.input)
    const references = readMediaReferences(request.input.media)
    const content: Array<{ image: string } | { text: string }> = [
      ...references.map(reference => ({ image: reference.url })),
      { text: prompt },
    ]
    return {
      url: `${base}${VLM_PATH}`,
      method: 'POST',
      headers,
      body: { model: request.model, input: { messages: [{ role: 'user', content }] }, parameters: request.parameters },
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

    // Wan 2.7 and 3.0 speak the media array natively. The 2.1–2.6 generation behind them
    // has one slot for one frame, so the reference list has to collapse — and collapsing it
    // silently would drop a conditioning input the caller paid for, hence the throw.
    if (usesMediaVideoApi(capability.model)) {
      // Two is what the 2.7 page states for this dialect. The 3.0 page documents more
      // media types without a count verified here, so the vendor arbitrates those.
      if (capability.model.startsWith('wan2.7') && media.length > 2) throw new Error(`model "${capability.model}" takes at most two media items, ${media.length} were sent`)
      return {
        url: `${base}${VIDEO_PATH}`,
        method: 'POST',
        headers,
        body: { model: request.model, input: { prompt, media }, parameters: videoParameters(request.parameters) },
      }
    }
    if (capability.modality === 'r2v') {
      throw new Error(`model "${capability.model}" has no reference-to-video endpoint: only the wan2.7 and wan3.0 generations take a media array`)
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
    body: { model: 'qwen-turbo', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
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
    body: { model: capability.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
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
  return model.startsWith('wan2.7') || model.startsWith('wan3.0')
}

/**
 * The one parameter never left to the vendor's default is `prompt_extend`: it lets the
 * service rewrite the request, which would turn the stored `requestSnapshot` into a
 * description of something that was never sent and leave a re-run unable to reproduce
 * the clip. `watermark` is deliberately NOT defaulted any more: GB 45438-2025 requires
 * AI-generated content to carry a label, so opting a paid clip out of the vendor's own
 * label has to be a decision written into the task's snapshot — not a quiet choice made
 * once inside this adapter.
 */
function videoParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  // audio: true 让 wan2.5+/wan3.0 在生成视频时同时输出原生音频（口型同步）。
  // 调用方可以显式传 audio: false 关掉（如已走独立 TTS 叠加时）。
  return { prompt_extend: false, audio: true, ...parameters }
}

/** Verified live: the sync multimodal response carries the image at output.choices[0].message.content[0].image.
 *  The compatible-mode endpoint (qwen-image-edit) answers with the same message shape, but its content
 *  items speak the OpenAI dialect — image_url objects, sometimes plain strings. Both are read here. */
function extractSyncImageUrl(container: Record<string, unknown>): string | undefined {
  const choices = container.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const message = (choices[0] as { message?: unknown } | null)?.message
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') {
    const match = /data:image\/[^\s"']+|https?:\/\/[^\s"']+/.exec(content)
    return match?.[0]
  }
  if (!Array.isArray(content)) return undefined
  for (const part of content) {
    if (typeof part === 'object' && part !== null) {
      const record = part as Record<string, unknown>
      if (typeof record.image === 'string') return record.image
      const imageUrl = record.image_url
      if (typeof imageUrl === 'string') return imageUrl
      if (typeof imageUrl === 'object' && imageUrl !== null && typeof (imageUrl as { url?: unknown }).url === 'string') {
        return (imageUrl as { url: string }).url
      }
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
      // Native endpoints wrap everything in `output`; compatible-mode answers
      // carry top-level `choices`. Both mean "the model answered".
      body => body.output !== undefined || Array.isArray(body.choices),
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
      // Compatible-mode text responses are flat (choices at the top level); the
      // native multimodal one still nests under output. extractDashScopeText
      // reads both shapes, so hand it whichever wrapper exists.
      const output = (body?.output ?? body ?? {}) as Record<string, unknown>
      const text = extractDashScopeText(output)
      const taskId = `ds-sync-${++syncCounter}`
      syncResults.set(taskId, { text })
      return { taskId }
    }

    if (capability.modality === 'image' && isQwenImage(capability.model)) {
      const output = (body?.output ?? {}) as Record<string, unknown>
      const artifactUrl = (body ? extractSyncImageUrl(body) : undefined) ?? extractSyncImageUrl(output)
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
