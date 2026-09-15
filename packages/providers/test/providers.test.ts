import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { ModelCapability } from '@studio/domain'
import {
  buildCredentialProbeRequest,
  buildPollRequest,
  buildSubmitRequest,
  createAdapter,
  DashScopeAdapter,
  extractDashScopeText,
  getCatalog,
  isKnownProvider,
  KlingAdapter,
  listCatalogs,
  MOCK_VLM_VERDICT,
  MOCK_SCRIPT_TEXT,
  MOCK_SCRIPT_TEXT_EN,
  MOCK_STORYBOARD_JSON,
  MOCK_STORYBOARD_JSON_EN,
  MockProviderAdapter,
  OpenAICompatibleAdapter,
  resetDashScopeSyncResults,
  resetMockTasks,
  sanitizeError,
  SeedanceAdapter,
  validateReferenceRequest,
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

describe('catalog', () => {
  it('lists the domestic, overseas and mock catalogs', () => {
    const providers = listCatalogs().map(c => c.provider).sort()
    expect(providers).toEqual(['anthropic', 'dashscope', 'google', 'kling', 'mock', 'openai', 'openai_compatible', 'seedance'])
    expect(isKnownProvider('dashscope')).toBe(true)
    expect(isKnownProvider('seedance')).toBe(true)
    expect(isKnownProvider('kling')).toBe(true)
    expect(isKnownProvider('openai')).toBe(true)
    expect(isKnownProvider('google')).toBe(true)
    expect(isKnownProvider('anthropic')).toBe(true)
    expect(isKnownProvider('openai_compatible')).toBe(true)
    expect(isKnownProvider('nope')).toBe(false)
  })

  // A gateway hands us its own model names on a host only the operator knows, so
  // inventing either one here would be a guess dressed up as a recommendation.
  it('leaves the openai-compatible catalog to the operator: no host, no models', () => {
    const catalog = getCatalog('openai_compatible')
    expect(catalog).toBeDefined()
    expect(catalog!.models).toEqual([])
    expect(catalog!.defaultBaseUrl).toBeUndefined()
  })

  // The overseas adapters ship without ever having met a real account, and that is the
  // one thing a reader of the model list must not have to guess.
  it('says of every overseas model that it was never run against a live account', () => {
    for (const provider of ['openai', 'google', 'anthropic']) {
      const catalog = getCatalog(provider)
      expect(catalog, provider).toBeDefined()
      expect(catalog!.models.length, provider).toBeGreaterThan(0)
      for (const model of catalog!.models) {
        const spec = model.spec as { note?: string } | undefined
        expect(`${provider}/${model.model} ${spec?.note ?? ''}`).toMatch(/never run against a live account/)
      }
    }
  })

  it('marks only kling as needing a second credential', () => {
    for (const catalog of listCatalogs()) {
      expect(catalog.requiresAccessKey ?? false).toBe(catalog.provider === 'kling')
    }
  })

  it('kling catalog advertises only the video modalities a stage can bind', () => {
    const catalog = getCatalog('kling')
    expect(catalog).toBeDefined()
    expect(new Set(catalog!.models.map(m => m.modality))).toEqual(new Set(['t2v']))
  })

  it('seedance catalog advertises only the t2v endpoint it implements', () => {
    const catalog = getCatalog('seedance')
    expect(catalog).toBeDefined()
    expect(new Set(catalog!.models.map(m => m.modality))).toEqual(new Set(['t2v']))
    for (const model of catalog!.models) {
      expect(model.acceptsFirstFrame).toBeUndefined()
    }
  })

  it('dashscope catalog only contains modalities with public endpoints', () => {
    const catalog = getCatalog('dashscope')
    expect(catalog).toBeDefined()
    const modalities = new Set(catalog!.models.map(m => m.modality))
    expect(modalities.has('text')).toBe(true)
    expect(modalities.has('vlm')).toBe(true)
    expect(modalities.has('image')).toBe(true)
    expect(modalities.has('t2v')).toBe(true)
    expect(modalities.has('i2v')).toBe(true)
    expect(modalities.has('tts')).toBe(true)
    expect(modalities.has('music')).toBe(true)
    expect(modalities.has('r2v')).toBe(false)
  })

  it('every i2v catalog model accepts a first frame', () => {
    for (const catalog of listCatalogs()) {
      for (const model of catalog.models.filter(m => m.modality === 'i2v')) {
        expect(model.acceptsFirstFrame).toBe(true)
      }
    }
  })

  it('mock catalog covers every modality', () => {
    const modalities = new Set(getCatalog('mock')!.models.map(m => m.modality))
    expect(modalities).toEqual(new Set(['text', 'vlm', 'image', 't2v', 'i2v', 'r2v', 'tts', 'music']))
  })
})

describe('createAdapter', () => {
  it('creates known adapters and rejects unknown providers', () => {
    expect(createAdapter('mock', { apiKey: 'k', baseUrl: 'mock://local' })).toBeInstanceOf(MockProviderAdapter)
    expect(createAdapter('dashscope', { apiKey: 'k', baseUrl: 'https://dashscope.aliyuncs.com' }).provider).toBe('dashscope')
    expect(createAdapter('seedance', { apiKey: 'k', baseUrl: 'https://ark.cn-beijing.volces.com' })).toBeInstanceOf(SeedanceAdapter)
    expect(createAdapter('kling', { apiKey: 'secret', accessKey: 'public', baseUrl: 'https://api-beijing.klingai.com' })).toBeInstanceOf(KlingAdapter)
    expect(createAdapter('openai_compatible', { apiKey: 'k', baseUrl: 'http://127.0.0.1:8000/v1' })).toBeInstanceOf(OpenAICompatibleAdapter)
    expect(() => createAdapter('unknown', { apiKey: 'k', baseUrl: '' })).toThrow(/unknown provider/)
  })
})

describe('mock adapter lifecycle', () => {
  beforeEach(() => resetMockTasks())

  it('probes ok with a valid key and 401 with "invalid"', async () => {
    const ok = new MockProviderAdapter({ apiKey: 'key', baseUrl: 'mock://local' })
    const bad = new MockProviderAdapter({ apiKey: 'invalid', baseUrl: 'mock://local' })
    const cap = capability({ modality: 't2v' })
    expect((await ok.probe(cap)).ok).toBe(true)
    const failed = await bad.probe(cap)
    expect(failed.ok).toBe(false)
    expect(failed.status).toBe(401)
  })

  it('submit then poll: running first, completed second', async () => {
    const adapter = new MockProviderAdapter({ apiKey: 'key', baseUrl: 'mock://local' })
    const cap = capability({ provider: 'mock', model: 'mock-i2v', modality: 'i2v', acceptsFirstFrame: true })
    const { taskId } = await adapter.submit(cap, {
      model: 'mock-i2v',
      input: { media: [{ type: 'first_frame', url: 'data:image/jpeg;base64,/9j/4AAQ' }] },
      parameters: {},
    })
    expect((await adapter.poll(cap, taskId)).status).toBe('running')
    const done = await adapter.poll(cap, taskId)
    expect(done.status).toBe('completed')
    expect(done.artifactUrl).toBe(`mock://artifacts/${taskId}/i2v?refs=first_frame`)
  })

  // The offline chain is where "did the frame actually reach the model?" gets answered, so
  // the mock has to be as strict about a reference request as the vendor is — and has to
  // say nothing at all in the URL when nothing was sent.
  it('refuses a reference request it cannot honour, and echoes nothing for a plain shot', async () => {
    const adapter = new MockProviderAdapter({ apiKey: 'key', baseUrl: 'mock://local' })
    const i2v = capability({ provider: 'mock', model: 'mock-i2v', modality: 'i2v', acceptsFirstFrame: true })
    await expect(adapter.submit(i2v, { model: 'mock-i2v', input: {}, parameters: {} })).rejects.toThrow(/requires a first_frame reference/)

    const t2v = capability({ provider: 'mock', model: 'mock-t2v', modality: 't2v' })
    await expect(adapter.submit(t2v, { model: 'mock-t2v', input: { media: [{ type: 'first_frame', url: 'u' }] }, parameters: {} })).rejects.toThrow(/cannot receive reference media/)
    const { taskId } = await adapter.submit(t2v, { model: 'mock-t2v', input: { prompt: 'p' }, parameters: {} })
    await adapter.poll(t2v, taskId)
    expect((await adapter.poll(t2v, taskId)).artifactUrl).toBe(`mock://artifacts/${taskId}/t2v`)
  })

  it('answers a vlm poll with a verdict instead of an artifact', async () => {
    const adapter = new MockProviderAdapter({ apiKey: 'key', baseUrl: 'mock://local' })
    const cap = capability({ provider: 'mock', model: 'mock-vlm', modality: 'vlm' })
    const { taskId } = await adapter.submit(cap, { model: 'mock-vlm', input: { prompt: 'judge this frame' }, parameters: {} })
    expect((await adapter.poll(cap, taskId)).status).toBe('running')
    const done = await adapter.poll(cap, taskId)
    expect(done).toEqual({ status: 'completed', text: MOCK_VLM_VERDICT })
    expect(JSON.parse(done.text!)).toMatchObject({ score: 0.9 })
  })

  it('poll of unknown task fails', async () => {
    const adapter = new MockProviderAdapter({ apiKey: 'key', baseUrl: 'mock://local' })
    const result = await adapter.poll(capability({ modality: 'text' }), 'missing')
    expect(result.status).toBe('failed')
  })

  it('answers a script poll with prose a human can approve, not JSON', async () => {
    const adapter = new MockProviderAdapter({ apiKey: 'key', baseUrl: 'mock://local' })
    const script = capability({ provider: 'mock', model: 'mock-script', modality: 'text' })
    const { taskId } = await adapter.submit(script, { model: 'mock-script', input: {}, parameters: {} })
    expect((await adapter.poll(script, taskId)).status).toBe('running')
    const done = await adapter.poll(script, taskId)
    expect(done).toEqual({ status: 'completed', text: MOCK_SCRIPT_TEXT })
    expect(done.text!.trim().length).toBeGreaterThan(0)
    expect(() => JSON.parse(done.text!)).toThrow()
  })

  it('answers a storyboard poll with shots plus the assets they need', async () => {
    const adapter = new MockProviderAdapter({ apiKey: 'key', baseUrl: 'mock://local' })
    const board = capability({ provider: 'mock', model: 'mock-storyboard', modality: 'text' })
    const { taskId } = await adapter.submit(board, { model: 'mock-storyboard', input: {}, parameters: {} })
    await adapter.poll(board, taskId)
    const done = await adapter.poll(board, taskId)
    expect(done.status).toBe('completed')
    expect(done.text).toBe(MOCK_STORYBOARD_JSON)

    const parsed = JSON.parse(done.text!) as {
      shots: Array<Record<string, unknown>>
      assets: Array<{ kind: string; name: string; description: string }>
    }
    expect(Array.isArray(parsed.shots)).toBe(true)
    expect(parsed.shots.length).toBeGreaterThan(0)
    expect(parsed.shots[0]).toHaveProperty('title')
    expect(parsed.shots[0]).toHaveProperty('description')

    expect(Array.isArray(parsed.assets)).toBe(true)
    expect(parsed.assets.length).toBeGreaterThan(0)
    for (const asset of parsed.assets) {
      expect(['character', 'prop', 'scene']).toContain(asset.kind)
      expect(asset.name.length).toBeGreaterThan(0)
      expect(asset.description.length).toBeGreaterThan(0)
    }
    expect(new Set(parsed.assets.map(asset => asset.kind))).toEqual(new Set(['character', 'prop', 'scene']))
  })

  // The offline chain has to run in English too, and the mock is what it runs on.
  // Both fixtures are asserted against the same shape so a locale that quietly loses
  // a shot or an asset kind is caught here rather than in a zero-asset episode.
  it('answers an English request with the same episode in English', async () => {
    const adapter = new MockProviderAdapter({ apiKey: 'key', baseUrl: 'mock://local' })
    const script = capability({ provider: 'mock', model: 'mock-script', modality: 'text' })
    const board = capability({ provider: 'mock', model: 'mock-storyboard', modality: 'text' })
    const { taskId: scriptTaskId } = await adapter.submit(script, { model: 'mock-script', input: { contentLocale: 'en' }, parameters: {} })
    const { taskId: boardTaskId } = await adapter.submit(board, { model: 'mock-storyboard', input: { contentLocale: 'en' }, parameters: {} })
    await adapter.poll(script, scriptTaskId)
    await adapter.poll(board, boardTaskId)

    const scriptDone = await adapter.poll(script, scriptTaskId)
    expect(scriptDone.text).toBe(MOCK_SCRIPT_TEXT_EN)
    expect(scriptDone.text).not.toBe(MOCK_SCRIPT_TEXT)

    const boardDone = await adapter.poll(board, boardTaskId)
    expect(boardDone.text).toBe(MOCK_STORYBOARD_JSON_EN)
    const parsed = JSON.parse(boardDone.text!) as {
      shots: Array<{ title: string; dialogue: string; speaker: string | null; durationMs: number }>
      assets: Array<{ kind: string; name: string; description: string }>
    }
    expect(parsed.shots.map(shot => shot.durationMs)).toEqual([5000, 4000, 5000])
    expect(parsed.shots.at(-1)).toMatchObject({ dialogue: '', speaker: null })
    expect(new Set(parsed.assets.map(asset => asset.kind))).toEqual(new Set(['character', 'prop', 'scene']))
    expect(parsed.assets.every(asset => /^[A-Za-z]/.test(asset.name))).toBe(true)
  })
})

describe('validateReferenceRequest', () => {
  it('rejects reference media on t2v', () => {
    expect(() => validateReferenceRequest(capability({ modality: 't2v' }), { media: [{ type: 'first_frame', url: 'https://cdn/f.png' }] }))
      .toThrow(/cannot receive reference media/)
  })

  it('requires a first frame on i2v and a reference image on r2v', () => {
    expect(() => validateReferenceRequest(capability({ modality: 'i2v' }), {})).toThrow(/requires a first_frame reference/)
    expect(() => validateReferenceRequest(capability({ modality: 'i2v' }), { media: [{ type: 'last_frame', url: 'u' }] })).toThrow(/requires a first_frame reference/)
    expect(() => validateReferenceRequest(capability({ modality: 'r2v' }), { media: [] })).toThrow(/requires at least one reference_image/)
  })

  // A reference list survives as JSON in a task snapshot, so the shape a caller rebuilds
  // it into is checked here rather than trusted.
  it('refuses a media entry that is not a {type, url} object', () => {
    expect(() => validateReferenceRequest(capability({ modality: 'i2v' }), { media: ['https://cdn/f.png'] })).toThrow(/\{type, url\}/)
    expect(() => validateReferenceRequest(capability({ modality: 'i2v' }), { media: [{ type: 'thumbnail', url: 'u' }] })).toThrow(/unsupported reference type/)
    expect(() => validateReferenceRequest(capability({ modality: 'i2v' }), { media: [{ type: 'first_frame' }] })).toThrow(/has no url/)
  })

  // Frames fill a video model's image slots; maxReferenceImages is the ceiling that goes
  // with acceptsReferenceImages, and single-frame models in the catalog leave it at 0.
  it('counts reference images, not frames, against maxReferenceImages', () => {
    const frameOnly = capability({ modality: 'i2v', acceptsFirstFrame: true })
    expect(() => validateReferenceRequest(frameOnly, { media: [{ type: 'first_frame', url: 'u' }] })).not.toThrow()

    const r2v = capability({ modality: 'r2v', acceptsReferenceImages: true, maxReferenceImages: 2 })
    expect(() => validateReferenceRequest(r2v, { media: [{ type: 'reference_image', url: 'a' }, { type: 'reference_image', url: 'b' }, { type: 'reference_image', url: 'c' }] }))
      .toThrow(/exceeds model "test-model" capability of 2/)
    expect(() => validateReferenceRequest(r2v, { media: [{ type: 'reference_image', url: 'a' }, { type: 'reference_image', url: 'b' }] })).not.toThrow()
    expect(() => validateReferenceRequest(capability({ modality: 'i2v', acceptsFirstFrame: true }), { media: [{ type: 'first_frame', url: 'u' }, { type: 'reference_image', url: 'u' }] }))
      .toThrow(/not declared as accepting reference images/)
  })
})

describe('dashscope request building', () => {
  const base = 'https://dashscope.aliyuncs.com'

  it('builds a synchronous text request', () => {
    const req = buildSubmitRequest(base, 'sk-test', capability({ modality: 'text', model: 'qwen-max' }), {
      model: 'qwen-max',
      input: { messages: [{ role: 'user', content: 'hello' }] },
      parameters: { result_format: 'message' },
    })
    expect(req.url).toBe(`${base}/api/v1/services/aigc/text-generation/generation`)
    expect(req.headers.Authorization).toBe('Bearer sk-test')
    expect(req.headers['X-DashScope-Async']).toBeUndefined()
    expect(req.body).toMatchObject({ model: 'qwen-max', input: { messages: [{ role: 'user', content: 'hello' }] } })
  })

  it('falls back to prompt-as-user-message for text', () => {
    const req = buildSubmitRequest(base, 'sk-test', capability({ modality: 'text' }), {
      model: 'qwen-plus',
      input: { prompt: 'write episode 1' },
      parameters: {},
    })
    const body = req.body as { input: { messages: Array<{ role: string; content: string }> } }
    expect(body.input.messages).toEqual([{ role: 'user', content: 'write episode 1' }])
  })

  it('builds a synchronous multimodal request for vlm', () => {
    const req = buildSubmitRequest(base, 'sk-test', capability({ modality: 'vlm', model: 'qwen-vl-max' }), {
      model: 'qwen-vl-max',
      input: { prompt: 'score this frame', images: ['data:image/jpeg;base64,/9j/4AAQ'] },
      parameters: {},
    })
    expect(req.url).toBe(`${base}/api/v1/services/aigc/multimodal-generation/generation`)
    expect(req.headers['X-DashScope-Async']).toBeUndefined()
    const body = req.body as { input: { messages: Array<{ role: string; content: unknown }> } }
    expect(body.input.messages).toEqual([
      { role: 'user', content: [{ image: 'data:image/jpeg;base64,/9j/4AAQ' }, { text: 'score this frame' }] },
    ])
  })

  it('passes caller-built vlm messages through untouched', () => {
    const messages = [{ role: 'user', content: [{ text: 'custom audit prompt' }] }]
    const req = buildSubmitRequest(base, 'sk-test', capability({ modality: 'vlm' }), {
      model: 'qwen-vl-max',
      input: { prompt: 'ignored', messages },
      parameters: {},
    })
    expect((req.body as { input: { messages: unknown } }).input.messages).toEqual(messages)
  })

  it('builds an async image request', () => {
    const req = buildSubmitRequest(base, 'sk-test', capability({ modality: 'image', model: 'wanx2.1-t2i-turbo' }), {
      model: 'wanx2.1-t2i-turbo',
      input: { prompt: 'a rainy street' },
      parameters: { size: '1024*1024', n: 1 },
    })
    expect(req.url).toBe(`${base}/api/v1/services/aigc/text2image/image-synthesis`)
    expect(req.headers['X-DashScope-Async']).toBe('enable')
    expect(req.body).toMatchObject({ input: { prompt: 'a rainy street' }, parameters: { size: '1024*1024' } })
  })

  it('builds a synchronous qwen-image request on the multimodal endpoint', () => {
    const req = buildSubmitRequest(base, 'sk-test', capability({ modality: 'image', model: 'qwen-image-3.0' }), {
      model: 'qwen-image-3.0',
      input: { prompt: 'a red apple' },
      parameters: { size: '1328*1328' },
    })
    expect(req.url).toBe(`${base}/api/v1/services/aigc/multimodal-generation/generation`)
    expect(req.headers['X-DashScope-Async']).toBeUndefined()
    const body = req.body as { input: { messages: Array<{ role: string; content: unknown }> } }
    expect(body.input.messages).toEqual([{ role: 'user', content: [{ text: 'a red apple' }] }])
  })

  it('reduces a first_frame reference to img_url and refuses anything it would have to drop', () => {
    const cap = capability({ modality: 'i2v', model: 'wanx2.1-i2v-turbo', acceptsFirstFrame: true })
    const req = buildSubmitRequest(base, 'sk-test', cap, {
      model: 'wanx2.1-i2v-turbo',
      input: { prompt: 'camera pans left', media: [{ type: 'first_frame', url: 'https://cdn/first.png' }] },
      parameters: {},
    })
    expect(req.url).toBe(`${base}/api/v1/services/aigc/video-generation/video-synthesis`)
    expect(req.body).toMatchObject({ input: { img_url: 'https://cdn/first.png' } })

    // A frame the storage has no public address for still has to condition the shot.
    const inline = buildSubmitRequest(base, 'sk-test', cap, {
      model: 'wanx2.1-i2v-turbo',
      input: { prompt: 'p', media: [{ type: 'first_frame', url: 'data:image/jpeg;base64,/9j/4AAQ' }] },
      parameters: {},
    })
    expect(inline.body).toMatchObject({ input: { img_url: 'data:image/jpeg;base64,/9j/4AAQ' } })

    expect(() => buildSubmitRequest(base, 'sk-test', cap, { model: 'wanx2.1-i2v-turbo', input: { prompt: 'x' }, parameters: {} }))
      .toThrow(/requires a first_frame reference/)
    expect(() => buildSubmitRequest(base, 'sk-test', cap, {
      model: 'wanx2.1-i2v-turbo',
      input: { prompt: 'x', media: [{ type: 'first_frame', url: 'a' }, { type: 'last_frame', url: 'b' }] },
      parameters: {},
    })).toThrow(/room for one frame/)
  })

  // prompt_extend is the one parameter that must never be left to the vendor's default:
  // if the endpoint rewrites the prompt, the snapshot we stored for this task is not the
  // prompt that produced the video, and every later "why does this shot look like that"
  // answer built from it is wrong.
  it('pins watermark and prompt_extend off on every video request', () => {
    const req = buildSubmitRequest(base, 'sk-test', capability({ modality: 't2v', model: 'wan2.2-t2v-plus' }), {
      model: 'wan2.2-t2v-plus',
      input: { prompt: 'a rainy street' },
      parameters: { resolution: '1080P' },
    })
    expect(req.body).toMatchObject({ parameters: { watermark: false, prompt_extend: false, resolution: '1080P' } })

    const overridden = buildSubmitRequest(base, 'sk-test', capability({ modality: 't2v', model: 'wan2.2-t2v-plus' }), {
      model: 'wan2.2-t2v-plus',
      input: { prompt: 'a rainy street' },
      parameters: { watermark: true },
    })
    expect(overridden.body).toMatchObject({ parameters: { watermark: true, prompt_extend: false } })
  })

  // The newest Wan generation takes the media array as it stands, so the neutral contract
  // reaches the vendor untouched.
  it('passes the media array through untouched on the wan2.7 dialect', () => {
    const cap = capability({ modality: 'i2v', model: 'wan2.7-i2v', acceptsFirstFrame: true })
    const media = [{ type: 'first_frame', url: 'data:image/png;base64,aaa' }, { type: 'last_frame', url: 'https://cdn/tail.png' }]
    const req = buildSubmitRequest(base, 'sk-test', cap, { model: 'wan2.7-i2v', input: { prompt: 'a to b', media }, parameters: {} })
    expect(req.body).toMatchObject({ input: { media } })
    expect((req.body as { input: Record<string, unknown> }).input.img_url).toBeUndefined()

    const referenced = buildSubmitRequest(base, 'sk-test', capability({ modality: 'r2v', model: 'wan2.7-r2v', acceptsReferenceImages: true, maxReferenceImages: 5 }), {
      model: 'wan2.7-r2v',
      input: { prompt: '图1 walks in', media: [{ type: 'reference_image', url: 'data:image/jpeg;base64,/9j/4AAQ' }] },
      parameters: {},
    })
    expect(referenced.body).toMatchObject({ input: { media: [{ type: 'reference_image', url: 'data:image/jpeg;base64,/9j/4AAQ' }] } })

    expect(() => buildSubmitRequest(base, 'sk-test', capability({ modality: 'r2v', model: 'wanx2.1-i2v-plus', acceptsReferenceImages: true, maxReferenceImages: 5 }), {
      model: 'wanx2.1-i2v-plus',
      input: { prompt: 'x', media: [{ type: 'reference_image', url: 'u' }] },
      parameters: {},
    })).toThrow(/has no reference-to-video endpoint/)
  })

  it('builds a synchronous tts request on the multimodal endpoint', () => {
    const req = buildSubmitRequest(base, 'sk-test', capability({ modality: 'tts', model: 'qwen3-tts-flash' }), {
      model: 'qwen3-tts-flash',
      input: { prompt: '沈亦：照片背面有字……' },
      parameters: {},
    })
    expect(req.url).toBe(`${base}/api/v1/services/aigc/multimodal-generation/generation`)
    expect(req.headers['X-DashScope-Async']).toBeUndefined()
    expect(req.body).toEqual({
      model: 'qwen3-tts-flash',
      input: { text: '沈亦：照片背面有字……', voice: 'Cherry', language_type: 'Chinese' },
    })
  })

  // The line a voice model reads can be a name or a number, which tells it nothing
  // about language, so the project's content locale is what selects the reading.
  it('asks for an English reading when the task carries an English content locale', () => {
    const req = buildSubmitRequest(base, 'sk-test', capability({ modality: 'tts', model: 'qwen3-tts-flash' }), {
      model: 'qwen3-tts-flash',
      input: { prompt: 'Shen Yi: There is writing on the back.', contentLocale: 'en' },
      parameters: {},
    })
    expect(req.body).toEqual({
      model: 'qwen3-tts-flash',
      input: { text: 'Shen Yi: There is writing on the back.', voice: 'Cherry', language_type: 'English' },
    })
  })

  it('lets a caller-supplied voice win on a tts request', () => {
    const req = buildSubmitRequest(base, 'sk-test', capability({ modality: 'tts', model: 'qwen3-tts-flash' }), {
      model: 'qwen3-tts-flash',
      input: { prompt: 'hello' },
      parameters: { voice: 'Ethan' },
    })
    expect((req.body as { input: { voice: string } }).input.voice).toBe('Ethan')
  })

  it('builds an async music request on the music-generation endpoint', () => {
    const req = buildSubmitRequest(base, 'sk-test', capability({ modality: 'music', model: 'fun-music-v1' }), {
      model: 'fun-music-v1',
      input: { prompt: 'a tense noir chase' },
      parameters: {},
    })
    expect(req.url).toBe(`${base}/api/v1/services/audio/music/generation`)
    expect(req.headers['X-DashScope-Async']).toBe('enable')
    expect(req.body).toMatchObject({ model: 'fun-music-v1', input: { prompt: 'a tense noir chase' } })
  })

  it('builds a poll request against the task endpoint', () => {
    const req = buildPollRequest(`${base}/`, 'sk-test', 'task-123')
    expect(req.url).toBe(`${base}/api/v1/tasks/task-123`)
    expect(req.method).toBe('GET')
    expect(req.headers.Authorization).toBe('Bearer sk-test')
  })

  it('builds a credential probe against the text endpoint for any capability', () => {
    const req = buildCredentialProbeRequest(`${base}/`, 'sk-test')
    expect(req.url).toBe(`${base}/api/v1/services/aigc/text-generation/generation`)
    expect(req.body).toMatchObject({ model: 'qwen-turbo', parameters: { max_tokens: 1 } })
    expect(req.headers['X-DashScope-Async']).toBeUndefined()
  })
})

describe('dashscope adapter probe', () => {
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

  /** The catalog the way a connection materialises it: every model, defaults filled in. */
  function catalogCapabilities(): ModelCapability[] {
    const catalog = getCatalog('dashscope')!
    return catalog.models.map(model => ({
      provider: catalog.provider,
      model: model.model,
      modality: model.modality,
      acceptsFirstFrame: model.acceptsFirstFrame ?? false,
      acceptsReferenceImages: model.acceptsReferenceImages ?? false,
      maxReferenceImages: model.maxReferenceImages ?? 0,
    }))
  }

  it('probes every catalog model, including ones with no dashscope endpoint', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    const capabilities = catalogCapabilities()
    const results = await Promise.all(capabilities.map(item => adapter().probe(item)))
    expect(results.every(result => result.ok)).toBe(true)
    expect(results[0].message).toContain(capabilities[0].model)
  })

  it('verifies the shared credential once, not once per capability', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    const prober = adapter()
    await Promise.all(catalogCapabilities().map(item => prober.probe(item)))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('/text-generation/generation')
  })

  it('reports the provider error for every capability when the key is rejected', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ code: 'InvalidApiKey', message: 'bad key', request_id: 'r-1' }),
    })
    const results = await Promise.all(catalogCapabilities().map(item => adapter().probe(item)))
    expect(results.every(result => !result.ok && result.status === 401)).toBe(true)
    expect(results[0].message).toBe('InvalidApiKey | bad key | request_id=r-1')
  })

  it('survives an unreachable endpoint', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'))
    const result = await adapter().probe(capability({ modality: 'i2v', acceptsFirstFrame: true }))
    expect(result).toEqual({ ok: false, status: 0, message: 'fetch failed' })
  })
})

describe('dashscope adapter submit and poll', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    resetDashScopeSyncResults()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads a vlm verdict out of output.choices on the multimodal endpoint', async () => {
    const verdict = '{"score":0.42,"reasons":["subject is out of focus"]}'
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ text: verdict }] } }] },
        request_id: 'r-9',
      }),
    })
    const adapter = new DashScopeAdapter({ apiKey: 'sk-test', baseUrl: 'https://dashscope.aliyuncs.com' })
    const cap = capability({ modality: 'vlm', model: 'qwen-vl-max' })
    const { taskId } = await adapter.submit(cap, {
      model: 'qwen-vl-max',
      input: { prompt: 'score this frame', images: ['data:image/jpeg;base64,/9j/4AAQ'] },
      parameters: {},
    })
    expect(fetchMock.mock.calls[0][0]).toContain('/multimodal-generation/generation')
    expect(await adapter.poll(cap, taskId)).toEqual({ status: 'completed', text: verdict })
  })

  it('reads a qwen-image artifact url out of the sync multimodal response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: 'https://oss/qwen.png', type: 'image' }] } }] },
        request_id: 'r-qi',
      }),
    })
    const adapter = new DashScopeAdapter({ apiKey: 'sk-test', baseUrl: 'https://dashscope.aliyuncs.com' })
    const cap = capability({ modality: 'image', model: 'qwen-image-3.0' })
    const { taskId } = await adapter.submit(cap, { model: 'qwen-image-3.0', input: { prompt: 'a red apple' }, parameters: {} })
    expect(fetchMock.mock.calls[0][0]).toContain('/multimodal-generation/generation')
    expect(await adapter.poll(cap, taskId)).toEqual({ status: 'completed', artifactUrl: 'https://oss/qwen.png' })
  })

  it('voices a tts line from output.audio.url on the sync endpoint', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ output: { audio: { url: 'https://oss/dashscope/voice-1.mp3', expires_in: 86400 } }, request_id: 'r-tts' }),
    })
    const adapter = new DashScopeAdapter({ apiKey: 'sk-test', baseUrl: 'https://dashscope.aliyuncs.com' })
    const cap = capability({ modality: 'tts', model: 'qwen3-tts-flash' })
    const { taskId } = await adapter.submit(cap, { model: 'qwen3-tts-flash', input: { prompt: '沈亦：又是这种天气。' }, parameters: {} })
    expect(fetchMock.mock.calls[0][0]).toContain('/multimodal-generation/generation')
    expect(taskId).toMatch(/^ds-sync-/)
    expect(await adapter.poll(cap, taskId)).toEqual({ status: 'completed', artifactUrl: 'https://oss/dashscope/voice-1.mp3' })
  })

  it('fails a tts submit when the audio url is missing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ output: {}, request_id: 'r-tts-empty' }),
    })
    const adapter = new DashScopeAdapter({ apiKey: 'sk-test', baseUrl: 'https://dashscope.aliyuncs.com' })
    const cap = capability({ modality: 'tts', model: 'qwen3-tts-flash' })
    await expect(adapter.submit(cap, { model: 'qwen3-tts-flash', input: { prompt: 'hello' }, parameters: {} })).rejects.toThrow()
  })

  it('runs a music task through the async submit / status-poll lifecycle', async () => {
    const adapter = new DashScopeAdapter({ apiKey: 'sk-test', baseUrl: 'https://dashscope.aliyuncs.com' })
    const cap = capability({ modality: 'music', model: 'fun-music-v1' })
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ output: { task_id: 'music-task-1', task_status: 'PENDING' }, request_id: 'r-m' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ output: { task_id: 'music-task-1', task_status: 'RUNNING' } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ output: { task_id: 'music-task-1', task_status: 'SUCCEEDED', results: [{ url: 'https://oss/dashscope/bgm.mp3' }] } }) })
    const { taskId } = await adapter.submit(cap, { model: 'fun-music-v1', input: { prompt: 'a tense noir chase' }, parameters: {} })
    expect(taskId).toBe('music-task-1')
    expect(fetchMock.mock.calls[0][0]).toContain('/audio/music/generation')
    expect(await adapter.poll(cap, taskId)).toEqual({ status: 'running' })
    expect(await adapter.poll(cap, taskId)).toEqual({ status: 'completed', artifactUrl: 'https://oss/dashscope/bgm.mp3' })
  })
})

describe('extractDashScopeText', () => {
  it('reads all three response shapes', () => {
    expect(extractDashScopeText({ text: 'plain answer' })).toBe('plain answer')
    expect(extractDashScopeText({ choices: [{ message: { content: 'a string' } }] })).toBe('a string')
    expect(extractDashScopeText({ choices: [{ message: { content: [{ text: 'two' }, { text: ' parts' }] } }] })).toBe('two parts')
  })

  it('keeps text parts and drops the rest', () => {
    expect(extractDashScopeText({ choices: [{ message: { content: [{ image: 'x' }, { text: 'kept' }] } }] })).toBe('kept')
  })

  it('yields an empty string for shapes it does not recognise', () => {
    expect(extractDashScopeText({})).toBe('')
    expect(extractDashScopeText({ choices: [] })).toBe('')
    expect(extractDashScopeText({ choices: [{}] })).toBe('')
    expect(extractDashScopeText({ choices: [{ message: null }] })).toBe('')
    expect(extractDashScopeText({ choices: [{ message: { content: 42 } }] })).toBe('')
    expect(extractDashScopeText({ choices: [{ message: { content: 'x' } }, { message: { content: 'ignored' } }] })).toBe('x')
  })
})

describe('sanitizeError', () => {
  it('formats dashscope error bodies', () => {
    expect(sanitizeError({ code: 'InvalidApiKey', message: 'bad key', request_id: 'r-1' }))
      .toBe('InvalidApiKey | bad key | request_id=r-1')
  })

  it('truncates unknown payloads', () => {
    expect(sanitizeError('x'.repeat(600))).toHaveLength(500)
  })
})
