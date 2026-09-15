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

export type { ModelCapability, ModelModality }
