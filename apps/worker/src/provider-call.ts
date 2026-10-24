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
 * V01:本地等待超时不是供应商失败——上游任务还在跑,失败只是「我们没等到」。
 * 独立的 `timeout` 状态让调用方把超时当「已受理待查询」处理(阻断+可续查),
 * 而不是当作 failed 烧下一个候选(供应商从未确认第一次调用失败)。
 */
export type SettledResult = PollResult | { status: 'timeout'; error: string }

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
): Promise<SettledResult> {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await adapter.poll(capability, providerTaskId)
    if (result.status !== 'running') return result
    if (Date.now() + intervalMs > deadline) {
      return { status: 'timeout', error: `provider task ${providerTaskId} did not settle within ${timeoutMs}ms` }
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
