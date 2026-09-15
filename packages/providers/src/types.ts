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

export type { ModelCapability, ModelModality }
