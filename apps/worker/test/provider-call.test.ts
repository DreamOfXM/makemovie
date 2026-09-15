import { describe, expect, it } from 'vitest'
import type { ModelCapability, PollResult, ProviderAdapter } from '@studio/providers'
import { pollToSettled } from '../src/provider-call.js'

const capability: ModelCapability = {
  provider: 'fake',
  model: 'fake-t2v',
  modality: 't2v',
  acceptsFirstFrame: false,
  acceptsReferenceImages: false,
  maxReferenceImages: 0,
  entitlementVerifiedAt: new Date(0),
}

/** Answers the scripted polls in order, then repeats the last one forever. */
function fakeAdapter(results: PollResult[]): ProviderAdapter {
  let polls = 0
  return {
    provider: 'fake',
    async probe() {
      return { ok: true, status: 200 }
    },
    async submit() {
      return { taskId: 'task-1' }
    },
    async poll() {
      return results[Math.min(polls++, results.length - 1)]!
    },
  }
}

describe('pollToSettled', () => {
  it('stops as soon as the provider settles', async () => {
    const adapter = fakeAdapter([{ status: 'running' }, { status: 'completed', text: 'ok' }])
    expect(await pollToSettled(adapter, capability, 'task-1', { intervalMs: 5, timeoutMs: 5_000 })).toEqual({
      status: 'completed',
      text: 'ok',
    })
  })

  // The deadline is the injected one, so the wait is bounded by STUDIO_POLL_TIMEOUT_MS
  // rather than by the ceiling a real video vendor would always blow past.
  it('fails the task once the injected deadline runs out', async () => {
    const startedAt = Date.now()
    const result = await pollToSettled(fakeAdapter([{ status: 'running' }]), capability, 'task-1', { intervalMs: 5, timeoutMs: 50 })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('did not settle within 50ms')
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })
})
