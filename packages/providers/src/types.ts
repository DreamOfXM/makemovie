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

/**
 * The reference material a video model can be conditioned on. The vocabulary is
 * Wan 2.7's because it is the widest one any vendor we support accepts; every other
 * vendor reduces from it, so a caller never has to know which dialect it will hit.
 */
export const mediaReferenceTypes = ['first_frame', 'last_frame', 'driving_audio', 'first_clip', 'reference_image'] as const
export type MediaReferenceType = typeof mediaReferenceTypes[number]

export interface MediaReference {
  type: MediaReferenceType
  /** A public URL or a `data:` URL — both vendors that take either accept both. */
  url: string
}

export function isMediaReferenceType(value: unknown): value is MediaReferenceType {
  return typeof value === 'string' && (mediaReferenceTypes as readonly string[]).includes(value)
}

/**
 * Reads `input.media` into typed references, or throws saying why it is not media.
 *
 * The array arrives untyped because a request is rebuilt from a stored JSON snapshot
 * before every call. Deciding its shape once here is what keeps four adapters from each
 * inventing a slightly more permissive reader that then sends a malformed vendor body.
 */
export function readMediaReferences(value: unknown): MediaReference[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('input.media must be an array of {type, url} references')
  return value.map(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('each input.media entry must be a {type, url} object')
    }
    const { type, url } = item as { type?: unknown; url?: unknown }
    if (!isMediaReferenceType(type)) {
      throw new Error(`input.media has unsupported reference type "${String(type)}" (expected one of: ${mediaReferenceTypes.join(', ')})`)
    }
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(`input.media reference "${type}" has no url`)
    }
    return { type, url }
  })
}

/**
 * Guards the contract between the pipeline and the vendor bill.
 *
 * Sending references to a text-to-video model is not merely wrong — several vendors
 * answer 200 and ignore them, so the shot costs full price and comes back with no
 * conditioning at all, which reads as "the model cannot keep a character consistent".
 */
export function validateReferenceRequest(capability: ModelCapability, input: Record<string, unknown>): void {
  const media = readMediaReferences(input.media)
  if (capability.modality === 't2v' && media.length > 0) {
    throw new Error(`t2v model "${capability.model}" cannot receive reference media`)
  }
  if (capability.modality === 'i2v' && !media.some(reference => reference.type === 'first_frame')) {
    throw new Error(`i2v model "${capability.model}" requires a first_frame reference`)
  }
  if (capability.modality === 'r2v' && !media.some(reference => reference.type === 'reference_image')) {
    throw new Error(`r2v model "${capability.model}" requires at least one reference_image reference`)
  }
  // maxReferenceImages counts reference images, not frames: it is the ceiling that goes
  // with acceptsReferenceImages, and every single-frame model in the catalog leaves it at
  // 0 — comparing frames to it would reject the conditioning input this milestone exists
  // to send.
  const referenceImages = media.filter(reference => reference.type === 'reference_image')
  if (referenceImages.length > 0 && !capability.acceptsReferenceImages) {
    throw new Error(`model "${capability.model}" is not declared as accepting reference images`)
  }
  if (referenceImages.length > capability.maxReferenceImages) {
    throw new Error(`reference image count ${referenceImages.length} exceeds model "${capability.model}" capability of ${capability.maxReferenceImages}`)
  }
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
