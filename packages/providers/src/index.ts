import type { ModelCapability } from '@studio/domain'

export interface ProviderRequest {
  model: string
  input: Record<string, unknown>
  parameters: Record<string, unknown>
}

export interface ProviderAdapter {
  provider: string
  probe(capability: ModelCapability): Promise<{ ok: boolean; status: number; message?: string }>
  submit(capability: ModelCapability, request: ProviderRequest): Promise<{ taskId: string }>
  poll(capability: ModelCapability, taskId: string): Promise<{ status: 'running' | 'completed' | 'failed'; artifactUrl?: string; error?: string }>
}

export function validateReferenceRequest(capability: ModelCapability, input: Record<string, unknown>): void {
  const media = Array.isArray(input.media) ? input.media : []
  const hasReference = media.length > 0
  if (capability.modality === 't2v' && hasReference) throw new Error('T2V cannot receive reference media')
  if ((capability.modality === 'i2v' || capability.modality === 'r2v') && !hasReference) throw new Error('Reference video models require reference media')
  if (media.length > capability.maxReferenceImages) throw new Error('Reference media exceeds model capability')
}
