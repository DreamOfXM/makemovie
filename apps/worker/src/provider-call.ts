import { setTimeout as sleep } from 'node:timers/promises'
import type { ModelCapability as CapabilityRow } from '@studio/db'
import type { ModelModality } from '@studio/domain'
import type { ModelCapability, PollResult, ProviderAdapter } from '@studio/providers'

const POLL_INTERVAL_MS = 250

export interface PollOptions {
  intervalMs?: number
  timeoutMs: number
}

/**
 * Generation and the visual audit both hand a provider a task and then wait for
 * it to settle. A single poll is never enough — the mock adapter answers
 * `running` on its first poll by design — so the wait has to live in one place.
 */
export async function pollToSettled(
  adapter: ProviderAdapter,
  capability: ModelCapability,
  providerTaskId: string,
  options: PollOptions,
): Promise<PollResult> {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await adapter.poll(capability, providerTaskId)
    if (result.status !== 'running') return result
    if (Date.now() + intervalMs > deadline) {
      return { status: 'failed', error: `provider task ${providerTaskId} did not settle within ${timeoutMs}ms` }
    }
    await sleep(intervalMs)
  }
}

/** The schema stores modality as a free string; the adapters speak the domain union. */
export function toCapability(provider: string, row: CapabilityRow): ModelCapability {
  return {
    provider,
    model: row.model,
    modality: row.modality as ModelModality,
    acceptsFirstFrame: row.acceptsFirstFrame,
    acceptsReferenceImages: row.acceptsReferenceImages,
    maxReferenceImages: row.maxReferenceImages,
    entitlementVerifiedAt: row.entitlementVerifiedAt,
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
