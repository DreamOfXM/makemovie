import { isContentLocale, type ContentLocale, type ModelCapability } from '@studio/domain'
import type { AdapterOptions, MediaReferenceType, PollResult, ProbeResult, ProviderAdapter, ProviderRequest, SubmitResult, TranscribeRequest, TranscribeResult, TranscribeSegment } from './types.js'
import { readMediaReferences, validateReferenceRequest } from './types.js'

/**
 * 把文本按段数均分(按字符码点切,不猜断句),时长同样均分——mock 的 segments
 * 只需要确定、可断言,不需要像真识别那样贴着语音边界。
 */
function splitEvenly(text: string, durationMs: number, segmentCount = durationMs >= 6000 ? 3 : 2): TranscribeSegment[] {
  const characters = Array.from(text)
  const perSegment = Math.max(1, Math.ceil(characters.length / segmentCount))
  const segmentMs = Math.max(1, Math.round(durationMs / segmentCount))
  const segments: TranscribeSegment[] = []
  for (let index = 0; index < characters.length; index += perSegment) {
    segments.push({
      startMs: segments.length * segmentMs,
      endMs: (segments.length + 1) * segmentMs,
      text: characters.slice(index, index + perSegment).join(''),
    })
  }
  return segments.length > 0 ? segments : [{ startMs: 0, endMs: durationMs, text: '' }]
}

interface MockTask {
  capability: ModelCapability
  polls: number
  contentLocale: ContentLocale
  referenceTypes: MediaReferenceType[]
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

export const MOCK_STORYBOARD_JSON = JSON.stringify({
  shots: [
    { number: 1, title: '雨夜现场', description: '暴雨中的滨江老城区街道，霓虹灯在湿漉漉的地面投下斑驳光影。沈亦撑着黑伞走近警戒线，神情凝重。', dialogue: '又是这种天气。', speaker: '沈亦', sourceExcerpt: '雨夜，滨江市老城区发生一起离奇失踪案。', durationMs: 5000, continuityIn: '新场景：滨江老城区雨夜街道，警戒线横在画面深处', continuityOut: '镜头缓缓推向地面' },
    { number: 2, title: '半张照片', description: '特写：沈亦戴着手套，从积水中捡起一张被撕去一半、浸湿泛黄的老照片，背面隐约可见一行字。', dialogue: '照片背面有字……', speaker: '沈亦', sourceExcerpt: '只在地上捡到一张被雨水浸湿、撕去一半的老照片。', durationMs: 4000, continuityIn: '镜头缓缓推向地面', continuityOut: '切到照片背面特写' },
    // The third shot has no line on purpose: the offline chain then covers a silent
    // shot too, which must not owe a voice task.
    { number: 3, title: '暗中注视', description: '街对面的暗处，记者林晚晴举着相机拍下现场，随后转身消失在雨幕中。', dialogue: '', speaker: null, sourceExcerpt: '调查记者林晚晴也在暗中追查同一桩旧案。', durationMs: 5000, continuityIn: '切到照片背面特写', continuityOut: '街对面只剩一截空雨幕，画面边缘留着相机镜头的反光' },
  ],
  assets: [
    { kind: 'character', name: '沈亦', description: '三十岁出头的刑警，短发利落，深色风衣，习惯随身带一把黑伞，眼神冷静克制。' },
    { kind: 'character', name: '林晚晴', description: '调查记者，二十五岁左右，齐肩黑发被雨水打湿，穿卡其色冲锋衣，胸前挂着单反相机。' },
    { kind: 'prop', name: '半张老照片', description: '一张被撕去右半、浸湿泛黄的黑白老照片，边角卷曲，背面有一行褪色的钢笔字。' },
    { kind: 'scene', name: '滨江老城区雨夜街道', description: '南方老城区的窄街，两侧是贴满小广告的旧居民楼，霓虹招牌在积水中倒映，暴雨如注，尽头拉着黄黑警戒线。' },
  ],
})

/**
 * The same episode in English, shot for shot and asset for asset. The mock answers
 * with the language the request asked for, otherwise an English project driving the
 * offline chain would be quietly handed Chinese content and the two halves of the
 * locale work would never be exercised together.
 */
export const MOCK_SCRIPT_TEXT_EN = `Episode 1 — The Visitor on a Rainy Night

Scene 1: A street in the old town of Binjiang, night, rain
Shen Yi walks up to the police tape under a black umbrella; the neon falls in broken shapes across the wet asphalt.
Shen Yi: (quietly) This weather again.

Scene 2: The scene
Shen Yi crouches and lifts a yellowed photograph, torn in half and soaked, out of a puddle.
Shen Yi: There's writing on the back...`

export const MOCK_STORYBOARD_JSON_EN = JSON.stringify({
  shots: [
    { number: 1, title: 'Rain Night Scene', description: 'A street in the old town of Binjiang under a downpour, neon reflected in broken shapes on the wet asphalt. Shen Yi approaches the police tape under a black umbrella, expression grim.', dialogue: 'This weather again.', speaker: 'Shen Yi', sourceExcerpt: 'On a rainy night a baffling disappearance is reported in the old town of Binjiang.', durationMs: 5000, continuityIn: 'New scene: the old-town street at night, police tape deep in frame', continuityOut: 'The camera drifts down toward the ground' },
    { number: 2, title: 'Half a Photograph', description: 'Close up: gloved, Shen Yi lifts a yellowed black-and-white photograph, torn in half and soaked, out of a puddle; a line of writing is faintly visible on the back.', dialogue: "There's writing on the back...", speaker: 'Shen Yi', sourceExcerpt: 'Only a rain-soaked photograph, torn in half, was found on the ground.', durationMs: 4000, continuityIn: 'The camera drifts down toward the ground', continuityOut: 'Cut to the back of the photograph' },
    { number: 3, title: 'Watching from the Dark', description: 'In the shadow across the street, the reporter Lin Wanqing photographs the scene with a camera, then turns and disappears into the rain.', dialogue: '', speaker: null, sourceExcerpt: 'Investigative reporter Lin Wanqing is chasing the same older case in secret.', durationMs: 5000, continuityIn: 'Cut to the back of the photograph', continuityOut: 'Empty rain across the street, the glint of a camera lens at the edge of frame' },
  ],
  assets: [
    { kind: 'character', name: 'Shen Yi', description: 'A detective in his early thirties, close-cropped hair, dark trench coat, always carrying a black umbrella, with a calm and controlled gaze.' },
    { kind: 'character', name: 'Lin Wanqing', description: 'An investigative reporter around twenty-five, shoulder-length dark hair wet from the rain, in a khaki windbreaker with a DSLR hanging on her chest.' },
    { kind: 'prop', name: 'Half a Photograph', description: 'A yellowed black-and-white photograph torn in half on the right, corners curled, a line of faded fountain-pen writing on the back.' },
    { kind: 'scene', name: 'Binjiang Old Town Street in the Rain', description: 'A narrow southern old-town street lined with ageing flats papered in small advertisements, neon signs mirrored in standing water under a hard downpour, yellow-and-black tape closing off the far end.' },
  ],
})

/**
 * The offline ASR stand-in: a fixed line the mock "hears" in every audio file. It is a
 * deterministic answer for offline tests, not a recognition result — the mock has
 * never listened to the audio it is transcribing. A test that wants a matching
 * transcript drives it through `expectedText`.
 */
export const MOCK_ASR_TEXT = '雨夜里传来一段离线转写的确定性文本。'

export class MockProviderAdapter implements ProviderAdapter {
  provider = 'mock'

  constructor(private readonly options: AdapterOptions) {}

  async probe(capability: ModelCapability): Promise<ProbeResult> {
    if (this.options.apiKey === 'invalid') return { ok: false, status: 401, message: 'mock: invalid api key' }
    return { ok: true, status: 200, message: `mock probe ok for ${capability.model}` }
  }

  /**
   * US-033 确定性转写:segments 按音频时长均分 2–3 段;text 优先取请求里的
   * expectedText(差异测试驱动「应念的文本」),否则回固定句。真实适配器必须
   * 忽略 expectedText——回显期望等于伪造通过。
   */
  async transcribe(capability: ModelCapability, request: TranscribeRequest): Promise<TranscribeResult> {
    if (this.options.apiKey === 'invalid') throw new Error('mock: invalid api key')
    const durationMs = typeof request.durationMs === 'number' && request.durationMs > 0 ? request.durationMs : 3000
    const text = typeof request.expectedText === 'string' && request.expectedText.trim() !== '' ? request.expectedText.trim() : MOCK_ASR_TEXT
    return { transcript: text, segments: splitEvenly(text, durationMs), provider: 'mock', model: capability.model }
  }

  /**
   * The offline stand-in knows its own model names and no others. Agreeing to any
   * name a caller invents would suppress exactly the mistake this check exists to
   * catch, so an unknown model fails here just as it does on a live endpoint.
   */
  async verifyModel(capability: ModelCapability): Promise<ProbeResult> {
    if (this.options.apiKey === 'invalid') return { ok: false, status: 401, message: 'mock: invalid api key' }
    if (!capability.model.startsWith('mock-')) {
      return { ok: false, status: 404, modelMissing: true, message: `model "${capability.model}" is not served by this endpoint: mock answers mock-* names only` }
    }
    return { ok: true, status: 200, message: `model "${capability.model}" answered` }
  }

  async extend(capability: ModelCapability, request: ProviderRequest): Promise<SubmitResult> {
    // 延长契约:返回保留原段的完整加长片——源片时长 + 追加时长,不是只返回追加部分。
    const parameters = (request.parameters ?? {}) as { durationMs?: number; sourceDurationMs?: number }
    const extendMs = typeof parameters.durationMs === 'number' ? parameters.durationMs : 5000
    // R02:源片时长优先用调用方实测的 sourceDurationMs(worker 用 ffprobe 探出后传入)。
    // 字节估算只作无参数时的兜底——压缩码率下按大小推时长不可靠(同分辨率不同
    // 码率差数倍),曾把 5 秒源片估成 1 秒,输出"5 秒加长片"冒充"9 秒"。
    let sourceMs = 5000
    const media = readMediaReferences(request.input.media)
    if (typeof parameters.sourceDurationMs === 'number' && parameters.sourceDurationMs > 0) {
      sourceMs = parameters.sourceDurationMs
    } else {
      const firstClip = media.find(ref => ref.type === 'first_clip')
      if (firstClip && firstClip.url.startsWith('data:')) {
        const base64Len = firstClip.url.split(',')[1]?.length ?? 0
        const rawBytes = base64Len * 0.75
        sourceMs = Math.max(1000, Math.round((rawBytes / 150_000) * 1000))
      }
    }
    const totalMs = sourceMs + extendMs
    const taskId = `mock-task-${++counter}`
    const firstClipUrl = media.find(ref => ref.type === 'first_clip')?.url
    tasks.set(taskId, {
      capability,
      polls: 0,
      contentLocale: 'zh',
      referenceTypes: media.map(reference => reference.type),
    })
    // Q05:延长契约=保留源前段的完整加长片。把源片 data URL 与追加时长一并交给
    // 轮询产物(materialize 据此拼接源+追加,而不是重新生成 testsrc 全片)。
    const record = tasks.get(taskId) as unknown as { extendDurationMs?: number; extendAppendMs?: number; extendSourceUrl?: string }
    record.extendDurationMs = totalMs
    record.extendAppendMs = extendMs
    if (firstClipUrl?.startsWith('data:')) record.extendSourceUrl = firstClipUrl
    return { taskId }
  }

  async editVideo(capability: ModelCapability, request: ProviderRequest): Promise<SubmitResult> {
    // US-021 定向编辑:mock 同构——真适配器需核对厂商 API 的修改指令/保留范围/参考图约束。
    return this.submit(capability, request)
  }

  async submit(capability: ModelCapability, request: ProviderRequest): Promise<SubmitResult> {
    if (this.options.apiKey === 'invalid') throw new Error('mock: invalid api key')
    validateReferenceRequest(capability, request.input)
    const taskId = `mock-task-${++counter}`
    const requested = request.input.contentLocale
    tasks.set(taskId, {
      capability,
      polls: 0,
      contentLocale: isContentLocale(requested) ? requested : 'zh',
      referenceTypes: readMediaReferences(request.input.media).map(reference => reference.type),
    })
    return { taskId }
  }

  async poll(capability: ModelCapability, taskId: string): Promise<PollResult> {
    const task = tasks.get(taskId)
    if (!task) return { status: 'failed', error: `mock: unknown task ${taskId}` }
    task.polls += 1
    if (task.polls < 2) return { status: 'running' }
    if (capability.modality === 'vlm') return { status: 'completed', text: MOCK_VLM_VERDICT }
    const english = task.contentLocale === 'en'
    if (capability.model === 'mock-script') return { status: 'completed', text: english ? MOCK_SCRIPT_TEXT_EN : MOCK_SCRIPT_TEXT }
    if (capability.model === 'mock-storyboard') return { status: 'completed', text: english ? MOCK_STORYBOARD_JSON_EN : MOCK_STORYBOARD_JSON }
    // The worker persists the poll result on both the artifact and the task, so what the
    // mock "saw" is auditable after the fact — the only way an offline run can tell a
    // conditioned shot from an unconditioned one.
    const refs = task.referenceTypes.length > 0 ? `?refs=${task.referenceTypes.join(',')}` : ''
    const extend = (task as unknown as { extendAppendMs?: number; extendSourceUrl?: string })
    if (extend.extendSourceUrl !== undefined && extend.extendAppendMs !== undefined) {
      // 源片随产物下发:durationMs=追加段时长,source=源 data URL——materialize 拼接。
      return { status: 'completed', artifactUrl: `mock://artifacts/${taskId}/${capability.modality}${refs}&durationMs=${extend.extendAppendMs}&source=${encodeURIComponent(extend.extendSourceUrl)}` }
    }
    const extendMs = (task as unknown as { extendDurationMs?: number }).extendDurationMs
    const durParam = extendMs !== undefined ? `&durationMs=${extendMs}` : ''
    return { status: 'completed', artifactUrl: `mock://artifacts/${taskId}/${capability.modality}${refs}${durParam}` }
  }
}

export function resetMockTasks(): void {
  tasks.clear()
  counter = 0
}
