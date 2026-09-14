import type { ModelCapability } from '@studio/domain'
import type { AdapterOptions, PollResult, ProbeResult, ProviderAdapter, ProviderRequest, SubmitResult } from './types.js'
import { sanitizeError } from './types.js'

const TEXT_PATH = '/api/v1/services/aigc/text-generation/generation'
const VLM_PATH = '/api/v1/services/aigc/multimodal-generation/generation'
const IMAGE_PATH = '/api/v1/services/aigc/text2image/image-synthesis'
const VIDEO_PATH = '/api/v1/services/aigc/video-generation/video-synthesis'
const TASK_PATH = '/api/v1/tasks'

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

  // UNVERIFIED: no credentials. The multimodal endpoint takes message content as
  // an array of typed parts rather than a bare string, and answers under
  // output.choices. Whether a base64 data URL is accepted where a public image
  // URL is documented is also untested — the visual audit relies on it.
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
    return {
      url: `${base}${VIDEO_PATH}`,
      method: 'POST',
      headers,
      body: { model: request.model, input: { prompt }, parameters: request.parameters },
    }
  }

  if (capability.modality === 'i2v') {
    const imgUrl = typeof request.input.firstFrameUrl === 'string' ? request.input.firstFrameUrl : undefined
    if (!imgUrl) throw new Error('dashscope i2v requires input.firstFrameUrl')
    return {
      url: `${base}${VIDEO_PATH}`,
      method: 'POST',
      headers,
      body: { model: request.model, input: { prompt, img_url: imgUrl }, parameters: request.parameters },
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

interface SyncTextResult {
  text: string
}

const syncResults = new Map<string, SyncTextResult>()
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

    const output = (body?.output ?? {}) as Record<string, unknown>
    const taskId = output.task_id
    if (typeof taskId !== 'string') throw new Error(sanitizeError(body ?? 'dashscope response missing output.task_id'))
    return { taskId }
  }

  async poll(capability: ModelCapability, taskId: string): Promise<PollResult> {
    if (taskId.startsWith('ds-sync-')) {
      const cached = syncResults.get(taskId)
      if (!cached) return { status: 'failed', error: `dashscope: unknown sync task ${taskId}` }
      return { status: 'completed', text: cached.text }
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
