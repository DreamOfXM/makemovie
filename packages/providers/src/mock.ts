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

/** Deterministic stand-ins so the script/storyboard stages have parseable content offline. */
export const MOCK_SCRIPT_TEXT = `第一集 雨夜来客

场景一：滨江老城区街道，雨夜
沈亦撑着一把黑伞走近警戒线，霓虹在湿漉漉的地面投下斑驳光影。
沈亦：（低声）又是这种天气。

场景二：案发现场
沈亦蹲下，从积水中捡起一张被撕去一半、浸湿泛黄的老照片。
沈亦：照片背面有字……`

export const MOCK_STORYBOARD_JSON = JSON.stringify([
  { number: 1, title: '雨夜现场', description: '暴雨中的滨江老城区街道，霓虹灯在湿漉漉的地面投下斑驳光影。沈亦撑着黑伞走近警戒线，神情凝重。', sourceExcerpt: '雨夜，滨江市老城区发生一起离奇失踪案。', durationMs: 5000, continuityIn: '', continuityOut: '镜头缓缓推向地面' },
  { number: 2, title: '半张照片', description: '特写：沈亦戴着手套，从积水中捡起一张被撕去一半、浸湿泛黄的老照片，背面隐约可见一行字。', sourceExcerpt: '只在地上捡到一张被雨水浸湿、撕去一半的老照片。', durationMs: 4000, continuityIn: '镜头缓缓推向地面', continuityOut: '切到照片背面特写' },
  { number: 3, title: '暗中注视', description: '街对面的暗处，记者林晚晴举着相机拍下现场，随后转身消失在雨幕中。', sourceExcerpt: '调查记者林晚晴也在暗中追查同一桩旧案。', durationMs: 5000, continuityIn: '切到照片背面特写', continuityOut: '' },
])

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
    if (capability.model === 'mock-script') return { status: 'completed', text: MOCK_SCRIPT_TEXT }
    if (capability.model === 'mock-storyboard') return { status: 'completed', text: MOCK_STORYBOARD_JSON }
    return { status: 'completed', artifactUrl: `mock://artifacts/${taskId}/${capability.modality}` }
  }
}

export function resetMockTasks(): void {
  tasks.clear()
  counter = 0
}
