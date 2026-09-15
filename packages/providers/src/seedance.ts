import type { ModelCapability, ModelModality } from '@studio/domain'
import type { AdapterOptions, MediaReferenceType, PollResult, ProbeResult, ProviderAdapter, ProviderRequest, SubmitResult } from './types.js'
import { readMediaReferences, sanitizeError, validateReferenceRequest } from './types.js'

export const SEEDANCE_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com'

const TASKS_PATH = '/api/v3/contents/generations/tasks'
const MODELS_PATH = '/api/v3/models'

const SUPPORTED_MODALITIES = new Set<ModelModality>(['t2v', 'i2v'])

/**
 * Ark asks for images inside the same `content` array as the prompt and says what each
 * one is for with a `role`. The three roles below are the image ones; a reference video
 * or audio clip has its own roles, which no stage of this pipeline produces yet, so the
 * adapter refuses them by name instead of sending a content item the vendor would reject.
 */
const IMAGE_ROLES = new Set<MediaReferenceType>(['first_frame', 'last_frame', 'reference_image'])

/** Only these keys are valid at the top level of the submit body; Ark rejects unknown ones, so anything else the caller passed is dropped. */
const PARAMETERS = {
  duration: 'number',
  resolution: 'string',
  ratio: 'string',
  watermark: 'boolean',
  seed: 'number',
} as const satisfies Record<string, 'number' | 'string' | 'boolean'>

export interface SeedanceHttpRequest {
  url: string
  method: 'POST' | 'GET'
  headers: Record<string, string>
  body?: unknown
}

function assertSupported(capability: ModelCapability): void {
  if (SUPPORTED_MODALITIES.has(capability.modality)) return
  throw new Error(`seedance adapter does not support modality "${capability.modality}" (no endpoint implemented)`)
}

export function buildSeedanceSubmitRequest(
  baseUrl: string,
  apiKey: string,
  capability: ModelCapability,
  request: ProviderRequest,
): SeedanceHttpRequest {
  assertSupported(capability)
  validateReferenceRequest(capability, request.input)
  const prompt = typeof request.input.prompt === 'string' ? request.input.prompt : ''
  const body: Record<string, unknown> = {
    model: request.model,
    content: seedanceContent(prompt, readMediaReferences(request.input.media)),
    ...mergeSeedanceParameters(request.parameters),
  }
  return {
    url: `${baseUrl.replace(/\/+$/, '')}${TASKS_PATH}`,
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body,
  }
}

/** Ark takes the frame as a `data:` URL, so no public object store is needed to condition a shot. */
export function seedanceContent(prompt: string, media: readonly { type: MediaReferenceType; url: string }[]): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }]
  for (const reference of media) {
    if (!IMAGE_ROLES.has(reference.type)) {
      throw new Error(`seedance has no content role for reference type "${reference.type}"`)
    }
    content.push({ type: 'image_url', image_url: { url: reference.url }, role: reference.type })
  }
  return content
}

export function buildSeedancePollRequest(baseUrl: string, apiKey: string, taskId: string): SeedanceHttpRequest {
  return {
    url: `${baseUrl.replace(/\/+$/, '')}${TASKS_PATH}/${taskId}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  }
}

/**
 * GET /models is the spend-free probe: it proves the key is valid and the tenant is
 * reachable. It says nothing about entitlement for `capability.model`, which the first
 * real submission establishes.
 */
export function buildSeedanceProbeRequest(baseUrl: string, apiKey: string): SeedanceHttpRequest {
  return {
    url: `${baseUrl.replace(/\/+$/, '')}${MODELS_PATH}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  }
}

export function mergeSeedanceParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const [key, kind] of Object.entries(PARAMETERS)) {
    const value = parameters[key]
    if (typeof value !== kind) continue
    if (kind === 'number' && !Number.isFinite(value as number)) continue
    merged[key] = value
  }
  return merged
}

/**
 * Ark's task vocabulary. Unrecognised statuses come back as 'unknown' rather than
 * 'failed', so poll can keep the task alive — one unexpected intermediate state should
 * delay a poll, not kill a paid generation.
 */
export function normalizeSeedanceStatus(status: unknown): 'running' | 'completed' | 'failed' | 'unknown' {
  if (typeof status !== 'string') return 'unknown'
  switch (status) {
    case 'queued':
    case 'running':
      return 'running'
    case 'succeeded':
      return 'completed'
    case 'failed':
    case 'cancelled':
      return 'failed'
    default:
      return 'unknown'
  }
}

/**
 * The link is signed and short-lived (~24h), so the caller is expected to download the
 * artifact as soon as the task completes rather than store the URL. Each poll returns
 * whatever link that response carried.
 */
export function extractSeedanceVideoUrl(body: Record<string, unknown> | null): string | undefined {
  const content = body?.content
  if (typeof content === 'object' && content !== null && typeof (content as { video_url?: unknown }).video_url === 'string') {
    return (content as { video_url: string }).video_url
  }
  return undefined
}

export class SeedanceAdapter implements ProviderAdapter {
  provider = 'seedance'

  /** Memoised per adapter instance, which lives for exactly one probe run. */
  private credential?: Promise<ProbeResult>

  constructor(private readonly options: AdapterOptions) {}

  async probe(capability: ModelCapability): Promise<ProbeResult> {
    if (!SUPPORTED_MODALITIES.has(capability.modality)) {
      return { ok: false, status: 0, message: `no seedance endpoint for modality "${capability.modality}"` }
    }
    this.credential ??= this.checkCredential()
    const result = await this.credential
    return result.ok ? { ...result, message: `probe ok for ${capability.model}` } : result
  }

  private async checkCredential(): Promise<ProbeResult> {
    const httpRequest = buildSeedanceProbeRequest(this.options.baseUrl, this.options.apiKey)
    try {
      const response = await fetch(httpRequest.url, { method: httpRequest.method, headers: httpRequest.headers })
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (!response.ok) return { ok: false, status: response.status, message: sanitizeError(body?.error ?? body ?? response.statusText) }
      // A 2xx with no model list is a misconfigured base url or an HTML-returning proxy,
      // not a working Ark connection — deny it rather than green-light the connection.
      if (!Array.isArray(body?.data)) return { ok: false, status: response.status, message: 'seedance probe: 2xx without a "data" model list' }
      return { ok: true, status: response.status, message: 'probe ok' }
    } catch (error) {
      return { ok: false, status: 0, message: sanitizeError(error instanceof Error ? error.message : error) }
    }
  }

  async submit(capability: ModelCapability, request: ProviderRequest): Promise<SubmitResult> {
    const httpRequest = buildSeedanceSubmitRequest(this.options.baseUrl, this.options.apiKey, capability, request)
    const response = await fetch(httpRequest.url, {
      method: httpRequest.method,
      headers: httpRequest.headers,
      body: JSON.stringify(httpRequest.body),
    })
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) throw new Error(sanitizeError(body?.error ?? body ?? `HTTP ${response.status}`))

    // The task id is a TOP-LEVEL `id`, not nested under `output` like DashScope.
    const taskId = body?.id
    if (typeof taskId !== 'string' || taskId.length === 0) throw new Error(`seedance response missing top-level id: ${sanitizeError(body ?? response.statusText)}`)
    return { taskId }
  }

  async poll(capability: ModelCapability, taskId: string): Promise<PollResult> {
    assertSupported(capability)
    const httpRequest = buildSeedancePollRequest(this.options.baseUrl, this.options.apiKey, taskId)
    const response = await fetch(httpRequest.url, { method: httpRequest.method, headers: httpRequest.headers })
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) {
      if (response.status === 404) return { status: 'failed', error: sanitizeError(body?.error ?? body ?? `task ${taskId} not found`) }
      return { status: 'running', error: sanitizeError(body?.error ?? body ?? `HTTP ${response.status}`) }
    }

    const status = normalizeSeedanceStatus(body?.status)
    if (status === 'completed') {
      const artifactUrl = extractSeedanceVideoUrl(body)
      if (!artifactUrl) return { status: 'failed', error: 'seedance: task succeeded but no content.video_url in response' }
      return { status: 'completed', artifactUrl }
    }
    if (status === 'failed') {
      return { status: 'failed', error: sanitizeError(body?.error ?? `seedance task ${String(body?.status ?? 'failed')}`) }
    }
    if (status === 'unknown') {
      return { status: 'running', error: `seedance: unrecognised task status "${String(body?.status ?? '')}"` }
    }
    return { status: 'running' }
  }
}
