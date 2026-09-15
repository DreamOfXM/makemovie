import type { ModelCapability, ModelModality } from '@studio/domain'

export interface ProviderRequest {
  model: string
  input: Record<string, unknown>
  parameters: Record<string, unknown>
}

export interface ProbeResult {
  ok: boolean
  status: number
  message?: string
  /**
   * The endpoint answered and named this model as absent. That is evidence about the
   * model; a timeout, a 429 or a 500 is evidence about nothing. A caller that stores
   * what it believes about a model has to be able to tell the two apart.
   */
  modelMissing?: boolean
}

export interface SubmitResult {
  taskId: string
}

export interface PollResult {
  status: 'running' | 'completed' | 'failed'
  artifactUrl?: string
  /**
   * Media the vendor handed over in the response body or behind an authenticated
   * download, so the worker cannot fetch it on its own. Bytes always travel with the
   * type the vendor claimed for them — a URL can carry its own content type on the
   * response, an inline payload has no response left to read.
   */
  inlineArtifact?: { bytes: Uint8Array; mimeType: string }
  text?: string
  error?: string
}

export interface ProviderAdapter {
  provider: string
  probe(capability: ModelCapability): Promise<ProbeResult>
  /**
   * Proves that this one named model answers on the connection. Optional because it is
   * only available where a call exists that is both model-specific and costs nothing
   * worth mentioning — a chat endpoint will answer one token, an image or video endpoint
   * has no such thing, and pretending otherwise would put a green check on an unverified
   * row, which is the failure mode this whole feature exists to avoid.
   */
  verifyModel?(capability: ModelCapability): Promise<ProbeResult>
  submit(capability: ModelCapability, request: ProviderRequest): Promise<SubmitResult>
  poll(capability: ModelCapability, taskId: string): Promise<PollResult>
}

export interface AdapterOptions {
  apiKey: string
  /** Public half of a key pair, for providers that sign requests with an access key + secret key pair (Kling). */
  accessKey?: string
  baseUrl: string
}

export function validateReferenceRequest(capability: ModelCapability, input: Record<string, unknown>): void {
  const media = Array.isArray(input.media) ? input.media : []
  const hasReference = media.length > 0
  if (capability.modality === 't2v' && hasReference) throw new Error('T2V cannot receive reference media')
  if ((capability.modality === 'i2v' || capability.modality === 'r2v') && !hasReference) throw new Error('Reference video models require reference media')
  if (media.length > capability.maxReferenceImages) throw new Error('Reference media exceeds model capability')
}

export function sanitizeError(body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const record = body as { code?: string; message?: string; request_id?: string }
    const parts = [record.code, record.message, record.request_id ? `request_id=${record.request_id}` : null].filter(Boolean)
    if (parts.length > 0) return parts.join(' | ')
  }
  const text = String(body)
  return text.slice(0, 500)
}

/**
 * Vendors that do not take a URL for image input still agree on the payload: media type
 * and base64, as two fields. The audit hands over a data URL, so the split happens here
 * rather than in every adapter that needs it.
 */
export function parseDataUrl(value: string): { mimeType: string; base64: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value)
  if (!match) return undefined
  return { mimeType: match[1]!, base64: match[2]! }
}

/**
 * What a model probe needs from a vendor's request object. The verb is not among them:
 * naming a model takes a body, so every probe is a POST, and saying so here once keeps
 * five adapters from each having to re-narrow their own request type to prove it.
 */
export interface ModelProbeRequest {
  url: string
  headers: Record<string, string>
  body: unknown
}

/** OpenAI-compatible routers are the clearest about a bad model id; the rest are vaguer but never 2xx. */
function isModelNotFound(text: string): boolean {
  return /model[\s_-]?not[\s_-]?found|not\s+exist|unknown model|invalid model|no such model/i.test(text)
}

/**
 * Sends a one-token request for one named model and judges the answer.
 *
 * `answered` is the caller's because every vendor wraps prose differently, and a 200 that
 * is not shaped like an answer is a failure: gateways have been known to answer 200 with
 * an error body, and a green light bought from that would be worse than no light.
 */
export async function probeModel(httpRequest: ModelProbeRequest, model: string, answered: (body: Record<string, unknown>) => boolean): Promise<ProbeResult> {
  try {
    const response = await fetch(httpRequest.url, {
      method: 'POST',
      headers: httpRequest.headers,
      body: JSON.stringify(httpRequest.body),
    })
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    const detail = sanitizeError(body?.error ?? body ?? response.statusText)
    if (response.status === 404 || isModelNotFound(detail)) {
      return { ok: false, status: response.status, modelMissing: true, message: `model "${model}" is not served by this endpoint: ${detail}` }
    }
    if (!response.ok) return { ok: false, status: response.status, message: detail }
    if (!body || !answered(body)) return { ok: false, status: response.status, message: `model "${model}" returned no answer — not verified` }
    return { ok: true, status: response.status, message: `model "${model}" answered` }
  } catch (error) {
    return { ok: false, status: 0, message: sanitizeError(error instanceof Error ? error.message : error) }
  }
}

export type { ModelCapability, ModelModality }
