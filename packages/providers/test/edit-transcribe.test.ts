import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelCapability } from '@studio/domain'
import {
  buildCompatTranscriptionRequest,
  DashScopeAdapter,
  MOCK_ASR_TEXT,
  MockProviderAdapter,
  OpenAICompatibleAdapter,
} from '../src/index.js'

function capability(partial: Partial<ModelCapability> & { modality: ModelCapability['modality'] }): ModelCapability {
  return {
    provider: 'dashscope',
    model: 'test-model',
    acceptsFirstFrame: false,
    acceptsReferenceImages: false,
    maxReferenceImages: 0,
    ...partial,
  }
}

const CLIP_DATA_URL = 'data:video/mp4;base64,AAAAVGhpc0lzQUNsaXA='

/**
 * US-021 真实定向编辑/延长适配器(百炼 video-synthesis 任务端点)+ US-033 转写契约。
 * 全部对着 stub HTTP 断言协议形状;真实验收(AC12 源/结果对比、真实转写)需要用户
 * 配置 API key,本套测试不覆盖。
 */
describe('dashscope extend / editVideo (US-021)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function adapter(apiKey = 'sk-test'): DashScopeAdapter {
    return new DashScopeAdapter({ apiKey, baseUrl: 'https://dashscope.aliyuncs.com' })
  }

  const videoCap = capability({ provider: 'dashscope', modality: 'i2v', model: 'wan2.7-i2v-2026-04-25', acceptsFirstFrame: true })
  const request = (prompt: string, parameters: Record<string, unknown> = {}) => ({
    model: videoCap.model,
    input: { prompt, media: [{ type: 'first_clip' as const, url: CLIP_DATA_URL }] },
    parameters,
  })

  it('is selectable through createAdapter: the method exists on the real adapter', () => {
    const real = adapter()
    expect(typeof real.extend).toBe('function')
    expect(typeof real.editVideo).toBe('function')
  })

  it('refuses to run without a key instead of fabricating a result', async () => {
    const keyless = adapter('')
    await expect(keyless.extend(videoCap, request('x'))).rejects.toThrow(/需要配置 API key/)
    await expect(keyless.editVideo(videoCap, request('x'))).rejects.toThrow(/需要配置 API key/)
  })

  it('submits to the async video-synthesis endpoint, keeps the provider task id, and polls the artifact url out', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ output: { task_id: 'edit-task-7', task_status: 'PENDING' }, request_id: 'r-1' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ output: { task_id: 'edit-task-7', task_status: 'RUNNING' } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ output: { task_id: 'edit-task-7', task_status: 'SUCCEEDED', video_url: 'https://oss/dashscope/edited.mp4' } }) })

    const { taskId } = await adapter().editVideo(videoCap, request('把外套改成红色，其余保持不变', { mute: true }))
    expect(taskId).toBe('edit-task-7')

    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }]
    expect(url).toBe('https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis')
    expect(init.method).toBe('POST')
    expect(init.headers['X-DashScope-Async']).toBe('enable')
    expect(init.headers.Authorization).toBe('Bearer sk-test')

    // 编辑请求参数映射:指令在 prompt,源片在 input.media[first_clip] 原样内联,
    // 保留范围/mute 等参数透传,prompt_extend 仍钉死 false。
    const body = JSON.parse(init.body) as { model: string; input: { prompt: string; media: Array<{ type: string; url: string }> }; parameters: Record<string, unknown> }
    expect(body.model).toBe('wan2.7-i2v-2026-04-25')
    expect(body.input.prompt).toBe('把外套改成红色，其余保持不变')
    expect(body.input.media).toEqual([{ type: 'first_clip', url: CLIP_DATA_URL }])
    expect(body.parameters).toMatchObject({ mute: true, prompt_extend: false })

    expect(await adapter().poll(videoCap, taskId)).toEqual({ status: 'running' })
    expect(await adapter().poll(videoCap, taskId)).toEqual({ status: 'completed', artifactUrl: 'https://oss/dashscope/edited.mp4' })
  })

  it('extends a t2v-bound model with the source clip riding in the media array', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ output: { task_id: 'ext-1', task_status: 'PENDING' } }) })
    const t2v = capability({ provider: 'dashscope', modality: 't2v', model: 'wan2.7-t2v' })
    const { taskId } = await adapter().extend(t2v, {
      model: 'wan2.7-t2v',
      input: { prompt: '延长这一镜', media: [{ type: 'first_clip', url: CLIP_DATA_URL }] },
      parameters: { durationMs: 4000, sourceDurationMs: 5000 },
    })
    expect(taskId).toBe('ext-1')
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body) as { input: { media: Array<{ type: string }>; prompt: string }; parameters: Record<string, unknown> }
    // 源片不能在 t2v 分支被丢掉——丢了就是一次与源片无关的全新生成。
    expect(body.input.media).toEqual([{ type: 'first_clip', url: CLIP_DATA_URL }])
    expect(body.input.prompt).toBe('延长这一镜')
    expect(body.parameters).toMatchObject({ durationMs: 4000, sourceDurationMs: 5000, prompt_extend: false })
  })

  it('carries an optional reference image beside the clip for an edit on a reference-capable model', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ output: { task_id: 'edit-2' } }) })
    const r2v = capability({ provider: 'dashscope', modality: 'r2v', model: 'wan2.7-r2v', acceptsReferenceImages: true, maxReferenceImages: 4 })
    await adapter().editVideo(r2v, {
      model: 'wan2.7-r2v',
      input: {
        prompt: '加入一把黑伞',
        media: [
          { type: 'first_clip', url: CLIP_DATA_URL },
          { type: 'reference_image', url: 'data:image/png;base64,refImg' },
        ],
      },
      parameters: {},
    })
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body) as { input: { media: Array<{ type: string }> } }
    expect(body.input.media.map(item => item.type)).toEqual(['first_clip', 'reference_image'])
  })

  it('fails the vendor error through on submit, instead of inventing a task', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ code: 'InvalidParameter', message: 'video too long', request_id: 'r-x' }) })
    await expect(adapter().extend(videoCap, request('延长'))).rejects.toThrow(/InvalidParameter \| video too long/)
  })

  it('refuses models without the media-array dialect, non-video modalities, and requests without a source clip', async () => {
    const legacy = capability({ provider: 'dashscope', modality: 'i2v', model: 'wan2.6-i2v', acceptsFirstFrame: true })
    await expect(adapter().extend(legacy, request('x'))).rejects.toThrow(/media-array video dialect/)

    const text = capability({ provider: 'dashscope', modality: 'text', model: 'qwen3.7-plus' })
    await expect(adapter().editVideo(text, request('x'))).rejects.toThrow(/needs a video model/)

    await expect(adapter().editVideo(videoCap, { model: videoCap.model, input: { prompt: 'no clip' }, parameters: {} })).rejects.toThrow(/first_clip/)
  })
})

describe('mock transcribe (US-033)', () => {
  const adapter = new MockProviderAdapter({ apiKey: 'test-key', baseUrl: 'mock://local' })
  const asr = capability({ provider: 'mock', modality: 'asr', model: 'mock-asr' })

  it('splits expectedText into two segments over a short clip and three over a long one', async () => {
    const short = await adapter.transcribe(asr, { audio: { dataUrl: 'data:audio/wav;base64,UklGRg==' }, expectedText: '你也被困在这里了？快跟我走。', durationMs: 4000 })
    expect(short.transcript).toBe('你也被困在这里了？快跟我走。')
    expect(short.segments).toHaveLength(2)
    expect(short.segments!.at(-1)!.endMs).toBe(4000)
    expect(short.segments!.map(segment => segment.text).join('')).toBe(short.transcript)

    const long = await adapter.transcribe(asr, { audio: { bytes: new Uint8Array(4), mimeType: 'audio/wav' }, expectedText: '一二三四五六七八九十一二三四五六七八九十', durationMs: 9000 })
    expect(long.segments).toHaveLength(3)
    expect(long.segments!.map(segment => segment.text).join('')).toBe('一二三四五六七八九十一二三四五六七八九十')
    expect(long).toMatchObject({ provider: 'mock', model: 'mock-asr' })
  })

  it('answers with the fixed line when the request carries no expected text', async () => {
    const result = await adapter.transcribe(asr, { audio: { dataUrl: 'data:audio/wav;base64,UklGRg==' }, durationMs: 2000 })
    expect(result.transcript).toBe(MOCK_ASR_TEXT)
    expect(result.segments).toHaveLength(2)
  })

  it('refuses an invalid key like every other mock path', async () => {
    const invalid = new MockProviderAdapter({ apiKey: 'invalid', baseUrl: 'mock://local' })
    await expect(invalid.transcribe(asr, { audio: { dataUrl: 'data:audio/wav;base64,UklGRg==' } })).rejects.toThrow(/invalid api key/)
  })
})

describe('openai-compatible transcribe (US-033)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function adapter(apiKey = 'sk-gw'): OpenAICompatibleAdapter {
    return new OpenAICompatibleAdapter({ apiKey, baseUrl: 'https://gw.example.com' })
  }

  const asr = capability({ provider: 'openai_compatible', modality: 'asr', model: 'whisper-large-v3' })

  it('refuses to transcribe without a key instead of fabricating a transcript', async () => {
    await expect(adapter('').transcribe(asr, { audio: { dataUrl: 'data:audio/wav;base64,UklGRg==' } })).rejects.toThrow(/需要配置 API key/)
  })

  it('builds the multipart form the transcriptions endpoint takes', () => {
    const { url, headers, form } = buildCompatTranscriptionRequest('https://gw.example.com/', 'sk-gw', { model: 'whisper-large-v3' }, {
      audio: { dataUrl: 'data:audio/mpeg;base64,SUQzBAAAAA' },
      language: 'zh',
    })
    expect(url).toBe('https://gw.example.com/v1/audio/transcriptions')
    expect(headers.Authorization).toBe('Bearer sk-gw')
    expect(form.get('model')).toBe('whisper-large-v3')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('language')).toBe('zh')
    const file = form.get('file') as Blob
    expect(file.type).toBe('audio/mpeg')
    expect(file.size).toBe(7)
  })

  it('sends the language hint only when the request carries one', () => {
    const { form } = buildCompatTranscriptionRequest('https://gw.example.com', 'sk-gw', { model: 'whisper-1' }, {
      audio: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
    })
    expect(form.get('language')).toBeNull()
  })

  it('maps text plus second-based segments into the millisecond contract in one synchronous call', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        text: '又是这种天气。照片背面有字',
        segments: [
          { start: 0, end: 1.5, text: '又是这种天气。' },
          { start: '1.5', end: '2.75', text: '照片背面有字' },
        ],
      }),
    })
    const result = await adapter().transcribe(asr, { audio: { dataUrl: 'data:audio/wav;base64,UklGRg==' }, language: 'zh' })
    expect(result.transcript).toBe('又是这种天气。照片背面有字')
    expect(result.segments).toEqual([
      { startMs: 0, endMs: 1500, text: '又是这种天气。' },
      { startMs: 1500, endMs: 2750, text: '照片背面有字' },
    ])
    expect(result).toMatchObject({ provider: 'openai_compatible', model: 'whisper-large-v3' })

    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: FormData }]
    expect(url).toBe('https://gw.example.com/v1/audio/transcriptions')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer sk-gw')
    expect(init.body).toBeInstanceOf(FormData)
  })

  it('accepts a text-only answer and rejects a 2xx that carries neither half', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ text: 'plain line' }) })
    const textOnly = await adapter().transcribe(asr, { audio: { dataUrl: 'data:audio/wav;base64,UklGRg==' } })
    expect(textOnly.transcript).toBe('plain line')
    expect(textOnly.segments).toBeUndefined()

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ task: 'nope' }) })
    await expect(adapter().transcribe(asr, { audio: { dataUrl: 'data:audio/wav;base64,UklGRg==' } })).rejects.toThrow(/neither text nor segments/)
  })

  it('fails the vendor error through on a rejected request', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: { message: 'bad key' } }) })
    await expect(adapter().transcribe(asr, { audio: { dataUrl: 'data:audio/wav;base64,UklGRg==' } })).rejects.toThrow(/bad key/)
  })

  it('refuses a request that carries no audio at all', () => {
    expect(() => buildCompatTranscriptionRequest('https://gw.example.com', 'sk-gw', { model: 'whisper-1' }, { audio: {} })).toThrow(/dataUrl or bytes/)
  })

  it('lets an asr row pass the credential probe while submit keeps refusing the modality', async () => {
    // A hand-added asr capability must survive the connection probe to bind audio_transcribe.
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [{ id: 'whisper-large-v3' }] }) })
    const result = await adapter().probe(asr)
    expect(result.ok).toBe(true)
    await expect(adapter().submit(asr, { model: 'whisper-large-v3', input: { prompt: 'x' }, parameters: {} })).rejects.toThrow(/does not support modality "asr"/)
  })
})
