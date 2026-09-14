import type { ModelCapability } from '@studio/domain'
import type { AdapterOptions, PollResult, ProbeResult, ProviderAdapter, ProviderRequest, SubmitResult } from './types.js'

interface MockTask {
  capability: ModelCapability
  polls: number
}

const tasks = new Map<string, MockTask>()
let counter = 0

/**
 * A fixed pass, exported so callers can assert against it rather than restating
 * the number. It is a deterministic answer for offline tests, not a quality
 * signal — the mock has never seen the image it is judging.
 */
export const MOCK_VLM_VERDICT = JSON.stringify({ score: 0.9, reasons: ['mock-vlm: deterministic pass, not a quality signal'] })

export class MockProviderAdapter implements ProviderAdapter {
  provider = 'mock'

  constructor(private readonly options: AdapterOptions) {}

  async probe(capability: ModelCapability): Promise<ProbeResult> {
    if (this.options.apiKey === 'invalid') return { ok: false, status: 401, message: 'mock: invalid api key' }
    return { ok: true, status: 200, message: `mock probe ok for ${capability.model}` }
  }

  async submit(capability: ModelCapability, request: ProviderRequest): Promise<SubmitResult> {
    if (this.options.apiKey === 'invalid') throw new Error('mock: invalid api key')
    const taskId = `mock-task-${++counter}`
    tasks.set(taskId, { capability, polls: 0 })
    void request
    return { taskId }
  }

  async poll(capability: ModelCapability, taskId: string): Promise<PollResult> {
    const task = tasks.get(taskId)
    if (!task) return { status: 'failed', error: `mock: unknown task ${taskId}` }
    task.polls += 1
    if (task.polls < 2) return { status: 'running' }
    if (capability.modality === 'vlm') return { status: 'completed', text: MOCK_VLM_VERDICT }
    return { status: 'completed', artifactUrl: `mock://artifacts/${taskId}/${capability.modality}` }
  }
}

export function resetMockTasks(): void {
  tasks.clear()
  counter = 0
}
