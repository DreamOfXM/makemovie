import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelCapability } from '@studio/domain'
import {
  buildKlingCredentialProbeRequest,
  buildKlingJwt,
  buildKlingPollRequest,
  buildKlingSubmitBody,
  buildKlingSubmitRequest,
  decodeKlingJwt,
  klingResourcePath,
  parseKlingPollResult,
  parseKlingTaskId,
  KlingAdapter,
} from '../src/kling.js'

const BASE = 'https://api-beijing.klingai.com'
const ISSUED_AT_MS = Date.UTC(2026, 8, 15, 0, 0, 0)
const ISSUED_AT_S = Math.floor(ISSUED_AT_MS / 1000)

/**
 * Signed out-of-band with node's own createHmac: the token for access key "test-ak" /
 * secret "test-sk", and the signature for the same unsigned part under "other-sk". They
 * check the adapter against a real HS256 implementation rather than against itself.
 */
const REFERENCE_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ0ZXN0LWFrIiwiZXhwIjoxNzg5NDMyMjAwLCJuYmYiOjE3ODk0MzAzOTV9.-bmSbvIbwQAm6_gBG7Ck69WLdf-EfgwrPoqG8SM22xY'
const REFERENCE_SIGNATURE_FOR_OTHER_SECRET = 'jZ7n6J7GqgyG78NdhsnBhhkNtkhhXKusXrxv4lWGNzg'

function capability(partial: Partial<ModelCapability> & { modality: ModelCapability['modality'] }): ModelCapability {
  return {
    provider: 'kling',
    model: 'kling-v2-5-turbo',
    acceptsFirstFrame: false,
    acceptsReferenceImages: false,
    maxReferenceImages: 0,
    ...partial,
  }
}

const t2v = capability({ modality: 't2v' })
const i2v = capability({ modality: 'i2v', model: 'kling-v2-5-turbo', acceptsFirstFrame: true })

function adapter(options: Partial<{ apiKey: string; accessKey: string; baseUrl: string }> = {}): KlingAdapter {
  return new KlingAdapter({ apiKey: 'test-sk', accessKey: 'test-ak', baseUrl: BASE, ...options })
}

function t2vRequest(input: Record<string, unknown> = { prompt: '雨夜，镜头推近一扇亮着灯的门' }) {
  return { model: 'kling-v2-5-turbo', input, parameters: {} }
}

const firstFrame = (url: string) => [{ type: 'first_frame' as const, url }]

describe('kling jwt', () => {
  it('signs an HS256 token that matches a reference implementation', () => {
    expect(buildKlingJwt('test-ak', 'test-sk', ISSUED_AT_MS)).toBe(REFERENCE_TOKEN)
  })

  it('carries the access key as iss with a 30 minute life and a 5 second back-dated nbf', () => {
    const token = buildKlingJwt('test-ak', 'test-sk', ISSUED_AT_MS)
    const { header, payload, signature } = decodeKlingJwt(token)
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(payload).toEqual({ iss: 'test-ak', exp: ISSUED_AT_S + 1800, nbf: ISSUED_AT_S - 5 })
    expect(signature).toBe(REFERENCE_TOKEN.split('.')[2])
  })

  it('is a real signature of the unsigned part, not a hash of the keys', () => {
    const reference = buildKlingJwt('test-ak', 'test-sk', ISSUED_AT_MS)
    const otherSecret = buildKlingJwt('test-ak', 'other-sk', ISSUED_AT_MS)
    expect(reference.split('.').slice(0, 2)).toEqual(otherSecret.split('.').slice(0, 2))
    expect(reference).toBe(REFERENCE_TOKEN)
    expect(decodeKlingJwt(otherSecret).signature).toBe(REFERENCE_SIGNATURE_FOR_OTHER_SECRET)
  })

  it('rejects a token that is not three dot-separated segments', () => {
    expect(() => decodeKlingJwt('only.one')).toThrow(/three-part JWT/)
  })
})

describe('kling submit body', () => {
  it('builds the documented t2v defaults and no frame fields', () => {
    expect(buildKlingSubmitBody(t2v, t2vRequest())).toEqual({
      model_name: 'kling-v2-5-turbo',
      prompt: '雨夜，镜头推近一扇亮着灯的门',
      mode: 'std',
      duration: '5',
      aspect_ratio: '16:9',
    })
  })

  it('sends duration as a string even when the caller passes a number', () => {
    const body = buildKlingSubmitBody(t2v, {
      model: 'kling-v2-5-turbo',
      input: { prompt: 'a lantern swaying' },
      parameters: { mode: 'pro', duration: 10, aspectRatio: '9:16', negativePrompt: 'blurry, watermark', cfgScale: 0.5, callbackUrl: 'https://hook.example/kling' },
    })
    expect(body.duration).toBe('10')
    expect(typeof body.duration).toBe('string')
    expect(body).toMatchObject({
      mode: 'pro',
      aspect_ratio: '9:16',
      negative_prompt: 'blurry, watermark',
      cfg_scale: 0.5,
      callback_url: 'https://hook.example/kling',
    })
  })

  it('maps a named first and tail frame onto their own slots', () => {
    const body = buildKlingSubmitBody(i2v, {
      model: 'kling-v2-5-turbo',
      input: {
        prompt: 'she turns around',
        media: [{ type: 'first_frame', url: 'https://cdn/first.png' }, { type: 'last_frame', url: 'https://cdn/tail.png' }],
      },
      parameters: {},
    })
    expect(body.image).toBe('https://cdn/first.png')
    expect(body.image_tail).toBe('https://cdn/tail.png')
  })

  it('strips the data-url prefix and keeps bare base64', () => {
    const body = buildKlingSubmitBody(i2v, {
      model: 'kling-v2-5-turbo',
      input: {
        prompt: 'she turns around',
        media: [{ type: 'first_frame', url: 'data:image/png;base64,iVBORw0KGgo=' }, { type: 'last_frame', url: 'data:image/jpeg;base64,/9j/4AAQ' }],
      },
      parameters: {},
    })
    expect(body.image).toBe('iVBORw0KGgo=')
    expect(body.image_tail).toBe('/9j/4AAQ')
  })

  it('sends no tail when only a first frame exists', () => {
    const body = buildKlingSubmitBody(i2v, {
      model: 'kling-v2-5-turbo',
      input: { prompt: 'x', media: [{ type: 'first_frame', url: 'https://cdn/a.png' }] },
      parameters: {},
    })
    expect(body).toMatchObject({ image: 'https://cdn/a.png' })
    expect(body.image_tail).toBeUndefined()
  })

  // Position in an array is not a contract: a tail frame that arrives on its own has no
  // slot, and guessing that the caller meant it as the opening frame would condition the
  // shot on the wrong image entirely.
  it('refuses an i2v call with no first frame', () => {
    expect(() => buildKlingSubmitBody(i2v, { model: 'kling-v2-5-turbo', input: { prompt: 'x' }, parameters: {} })).toThrow(/requires a first_frame reference/)
    expect(() => buildKlingSubmitBody(i2v, { model: 'kling-v2-5-turbo', input: { prompt: 'x', media: [{ type: 'last_frame', url: 'u' }] }, parameters: {} }))
      .toThrow(/requires a first_frame reference/)
    expect(() => buildKlingSubmitBody(i2v, { model: 'kling-v2-5-turbo', input: { prompt: 'x', firstFrameUrl: 'https://cdn/a.png' }, parameters: {} }))
      .toThrow(/requires a first_frame reference/)
  })

  it('refuses a reference type kling has no slot for', () => {
    expect(() => buildKlingSubmitBody(i2v, {
      model: 'kling-v2-5-turbo',
      input: { prompt: 'x', media: [{ type: 'first_frame', url: 'a' }, { type: 'driving_audio', url: 'b' }] },
      parameters: {},
    })).toThrow(/slots for a first and a tail frame only/)
  })

  it('refuses a frame on a text-to-video model instead of dropping it', () => {
    expect(() => buildKlingSubmitBody(t2v, { model: 'kling-v2-5-turbo', input: { prompt: 'x', media: firstFrame('https://cdn/a.png') }, parameters: {} }))
      .toThrow(/cannot receive reference media/)
  })

  it('refuses modalities with no kling endpoint', async () => {
    const message = /kling does not support modality "r2v"/
    expect(() => buildKlingSubmitBody(capability({ modality: 'r2v' }), t2vRequest())).toThrow(message)
    expect(() => klingResourcePath('music')).toThrow(/kling does not support modality "music"/)
    await expect(adapter().submit(capability({ modality: 'r2v' }), t2vRequest())).rejects.toThrow(message)
  })
})

describe('kling requests', () => {
  it('posts t2v and i2v to their own endpoints with the bearer jwt', () => {
    const submit = buildKlingSubmitRequest(`${BASE}/`, 'Bearer tok', t2v, t2vRequest())
    expect(submit.url).toBe(`${BASE}/v1/videos/text2video`)
    expect(submit.method).toBe('POST')
    expect(submit.headers.Authorization).toBe('Bearer tok')
    expect(submit.headers['Content-Type']).toBe('application/json')
    expect(buildKlingSubmitRequest(BASE, 'Bearer tok', i2v, { model: 'kling-v2-5-turbo', input: { prompt: 'x', media: firstFrame('https://cdn/a.png') }, parameters: {} }).url).toBe(`${BASE}/v1/videos/image2video`)
  })

  it('polls the task under the endpoint the modality was submitted to', () => {
    expect(buildKlingPollRequest(BASE, 'Bearer tok', t2v, 'task-9').url).toBe(`${BASE}/v1/videos/text2video/task-9`)
    expect(buildKlingPollRequest(BASE, 'Bearer tok', i2v, 'task-9').url).toBe(`${BASE}/v1/videos/image2video/task-9`)
    expect(buildKlingPollRequest(BASE, 'Bearer tok', i2v, 'task-9').method).toBe('GET')
  })

  it('probes credentials with the cheapest possible list call', () => {
    const probe = buildKlingCredentialProbeRequest(`${BASE}/`, 'Bearer tok')
    expect(probe.url).toBe(`${BASE}/v1/videos/text2video?pageNum=1&pageSize=1`)
    expect(probe.method).toBe('GET')
    expect(probe.body).toBeUndefined()
  })
})

describe('parseKlingTaskId', () => {
  it('reads data.task_id', () => {
    expect(parseKlingTaskId({ code: 0, data: { task_id: '8834abc' } })).toBe('8834abc')
  })

  it('yields nothing for shapes without a usable id', () => {
    expect(parseKlingTaskId(null)).toBeUndefined()
    expect(parseKlingTaskId({ code: 0 })).toBeUndefined()
    expect(parseKlingTaskId({ data: { task_id: 991 } })).toBeUndefined()
    expect(parseKlingTaskId({ data: { task_id: '' } })).toBeUndefined()
    expect(parseKlingTaskId({ task_id: 'top-level is not the documented shape' })).toBeUndefined()
  })
})

describe('parseKlingPollResult', () => {
  it('treats submitted and processing as still running', () => {
    for (const taskStatus of ['submitted', 'processing']) {
      expect(parseKlingPollResult({ code: 0, data: { task_status: taskStatus } })).toEqual({ status: 'running' })
    }
    expect(parseKlingPollResult({ code: 0, data: { task_status: 'queued' } })).toEqual({ status: 'running' })
  })

  it('reads the artifact from task_result.videos[0].url on succeed', () => {
    const result = parseKlingPollResult({
      code: 0,
      data: { task_status: 'succeed', task_result: { videos: [{ id: 'v-1', url: 'https://cdn.kling/first.mp4' }, { id: 'v-2', url: 'https://cdn.kling/second.mp4' }] } },
    })
    expect(result).toEqual({ status: 'completed', artifactUrl: 'https://cdn.kling/first.mp4' })
  })

  it('fails a succeed task that carries no video url', () => {
    expect(parseKlingPollResult({ code: 0, data: { task_status: 'succeed', task_result: { videos: [] } } })).toEqual({
      status: 'failed',
      error: 'kling: task succeed but no video url in data.task_result.videos',
    })
  })

  it('maps failed with the task message, falling back to the top-level one', () => {
    expect(parseKlingPollResult({ code: 0, message: 'outer', data: { task_status: 'failed', task_status_msg: 'prompt violated policy' } })).toEqual({
      status: 'failed',
      error: 'prompt violated policy',
    })
    expect(parseKlingPollResult({ code: 0, message: 'service unavailable', data: { task_status: 'failed' } })).toEqual({
      status: 'failed',
      error: 'service unavailable',
    })
  })
})

describe('kling adapter submit and poll', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('accepts a submission whose code is 0 and returns its task id', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0, message: 'SUCCEED', request_id: 'r-1', data: { task_id: 'task-77' } }) })
    const submitted = await adapter().submit(i2v, { model: 'kling-v2-5-turbo', input: { prompt: 'x', media: firstFrame('https://cdn/a.png') }, parameters: {} })
    expect(submitted).toEqual({ taskId: 'task-77' })
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/v1/videos/image2video`)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(buildKlingSubmitBody(i2v, { model: 'kling-v2-5-turbo', input: { prompt: 'x', media: firstFrame('https://cdn/a.png') }, parameters: {} }))
  })

  it('throws the provider error when the api rejects the request', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 1102, message: 'insufficient balance', request_id: 'r-2' }),
    })
    await expect(adapter().submit(t2v, t2vRequest())).rejects.toThrow('1102 | insufficient balance | request_id=r-2')
  })

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error', json: async () => null })
    await expect(adapter().submit(t2v, t2vRequest())).rejects.toThrow('HTTP 500')
  })

  it('keeps a transient poll failure running and reports a missing task as failed', async () => {
    const poller = adapter()
    fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable', json: async () => ({ code: 1, message: 'upstream busy' }) })
    expect(await poller.poll(t2v, 'task-1')).toEqual({ status: 'running', error: '1 | upstream busy' })

    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ code: 1101, message: 'task not found' }) })
    expect(await poller.poll(t2v, 'task-1')).toEqual({ status: 'failed', error: '1101 | task not found' })
  })

  it('caches the signed token and re-signs only inside the refresh margin', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(ISSUED_AT_MS))
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0, data: { task_id: 'task-1' } }) })
    const prober = adapter()

    await prober.submit(t2v, t2vRequest())
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${REFERENCE_TOKEN}`)

    vi.advanceTimersByTime(1_499_000)
    await prober.submit(t2v, t2vRequest())
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${REFERENCE_TOKEN}`)

    vi.advanceTimersByTime(2_000)
    await prober.submit(t2v, t2vRequest())
    const refreshed = fetchMock.mock.calls[2][1].headers.Authorization as string
    expect(refreshed).not.toBe(`Bearer ${REFERENCE_TOKEN}`)
    expect(decodeKlingJwt(refreshed.replace('Bearer ', '')).payload.exp).toBe(ISSUED_AT_S + 1800 + 1501)
  })

  it('never puts the secret key on the wire', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0, data: { task_id: 'task-1' } }) })
    await adapter().submit(i2v, { model: 'kling-v2-5-turbo', input: { prompt: 'x', media: firstFrame('data:image/png;base64,iVBOR') }, parameters: {} })
    const sent = JSON.stringify(fetchMock.mock.calls[0])
    expect(sent).not.toContain('test-sk')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toMatch(/^Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\./)
  })

  it('requires both halves of the key pair before it touches the network', async () => {
    const missingAccess = adapter({ accessKey: undefined })
    await expect(missingAccess.submit(t2v, t2vRequest())).rejects.toThrow(/AdapterOptions\.accessKey holds the access key/)
    await expect(missingAccess.probe(t2v)).rejects.toThrow(/AdapterOptions\.accessKey holds the access key/)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(adapter({ apiKey: '' }).submit(t2v, t2vRequest())).rejects.toThrow(/key pair/)
  })
})

describe('kling adapter probe', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports ok when the api accepts the jwt, and asks once for the whole catalog', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0, message: 'SUCCEED', data: { page_num: 1, page_size: 1, total: 0 } }) })
    const prober = adapter()
    const results = await Promise.all([prober.probe(t2v), prober.probe(i2v)])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/v1/videos/text2video?pageNum=1&pageSize=1`)
    expect(results[0]).toEqual({ ok: true, status: 200, message: 'probe ok for kling-v2-5-turbo' })
    expect(results[1].ok).toBe(true)
  })

  it('reports a rejected jwt as a failed probe, not an exception', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ code: 1000, message: 'invalid token', request_id: 'r-3' }) })
    expect(await adapter().probe(t2v)).toEqual({ ok: false, status: 401, message: '1000 | invalid token | request_id=r-3' })
  })

  it('reports an auth code carried on an otherwise successful response', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 1004, message: 'token expired' }) })
    const result = await adapter().probe(t2v)
    expect(result.ok).toBe(false)
    expect(result.message).toBe('1004 | token expired')
  })

  it('survives an unreachable endpoint', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'))
    expect(await adapter().probe(t2v)).toEqual({ ok: false, status: 0, message: 'fetch failed' })
  })
})
