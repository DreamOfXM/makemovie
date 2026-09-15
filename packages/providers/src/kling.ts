import { createHmac } from 'node:crypto'
import type { ModelCapability, ModelModality } from '@studio/domain'
import type { AdapterOptions, PollResult, ProbeResult, ProviderAdapter, ProviderRequest, SubmitResult } from './types.js'
import { sanitizeError } from './types.js'

export const KLING_DEFAULT_BASE_URL = 'https://api-beijing.klingai.com'

const VIDEO_BASE = '/v1/videos'
const T2V_RESOURCE = 'text2video'
const I2V_RESOURCE = 'image2video'

const TOKEN_TTL_SECONDS = 1800
const NOT_BEFORE_LEEWAY_SECONDS = 5
const TOKEN_TTL_MS = TOKEN_TTL_SECONDS * 1000
/** Re-sign once the cached token has less than this much life left, so a long poll loop never sends an expired one. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

const DEFAULT_MODE = 'std'
const DEFAULT_DURATION = '5'
const DEFAULT_ASPECT_RATIO = '16:9'

export interface KlingHttpRequest {
  url: string
  method: 'POST' | 'GET'
  headers: Record<string, string>
  body?: unknown
}

export interface KlingSubmitBody {
  model_name: string
  prompt: string
  negative_prompt?: string
  mode: string
  duration: string
  aspect_ratio: string
  cfg_scale?: number
  callback_url?: string
  image?: string
  image_tail?: string
}

export interface KlingJwtHeader {
  alg?: string
  typ?: string
}

export interface KlingJwtPayload {
  iss?: string
  exp?: number
  nbf?: number
}

/**
 * Kling accepts no static key: every request carries a self-signed HS256 JWT built from
 * the access key (`options.accessKey`) and signed with the secret key (`options.apiKey`).
 * The token is cached on the instance and re-signed inside the refresh margin.
 */
export class KlingAdapter implements ProviderAdapter {
  provider = 'kling'

  /** Memoised per adapter instance, which lives for exactly one probe run. */
  private credential?: Promise<ProbeResult>
  private token?: { value: string; expiresAt: number }

  constructor(private readonly options: AdapterOptions) {}

  async probe(capability: ModelCapability): Promise<ProbeResult> {
    // Credential probe: a paged list call proves the JWT is accepted. It does not prove
    // entitlement for `capability.model`, which the first real submission establishes.
    const authorization = this.authorize()
    this.credential ??= this.checkCredential(authorization)
    const result = await this.credential
    return result.ok ? { ...result, message: `probe ok for ${capability.model}` } : result
  }

  private async checkCredential(authorization: string): Promise<ProbeResult> {
    const httpRequest = buildKlingCredentialProbeRequest(this.options.baseUrl, authorization)
    try {
      const response = await fetch(httpRequest.url, { method: httpRequest.method, headers: httpRequest.headers })
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (!response.ok) return { ok: false, status: response.status, message: sanitizeError(body ?? response.statusText) }
      const code = klingCode(body)
      if (code === 0) return { ok: true, status: response.status, message: 'probe ok' }
      return { ok: false, status: response.status, message: sanitizeError(body ?? `kling probe returned code ${String(code)}`) }
    } catch (error) {
      return { ok: false, status: 0, message: sanitizeError(error instanceof Error ? error.message : error) }
    }
  }

  async submit(capability: ModelCapability, request: ProviderRequest): Promise<SubmitResult> {
    const httpRequest = buildKlingSubmitRequest(this.options.baseUrl, this.authorize(), capability, request)
    const response = await fetch(httpRequest.url, {
      method: httpRequest.method,
      headers: httpRequest.headers,
      body: JSON.stringify(httpRequest.body),
    })
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) throw new Error(sanitizeError(body ?? `HTTP ${String(response.status)}`))
    const code = klingCode(body)
    if (code !== undefined && code !== 0) throw new Error(sanitizeError(body ?? `kling rejected the request with code ${String(code)}`))

    const taskId = parseKlingTaskId(body)
    if (!taskId) throw new Error(sanitizeError(body ?? 'kling response missing data.task_id'))
    return { taskId }
  }

  async poll(capability: ModelCapability, taskId: string): Promise<PollResult> {
    const httpRequest = buildKlingPollRequest(this.options.baseUrl, this.authorize(), capability, taskId)
    const response = await fetch(httpRequest.url, { method: httpRequest.method, headers: httpRequest.headers })
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) {
      if (response.status === 404) return { status: 'failed', error: sanitizeError(body ?? `task ${taskId} not found`) }
      return { status: 'running', error: sanitizeError(body ?? `HTTP ${String(response.status)}`) }
    }
    return parseKlingPollResult(body)
  }

  private authorize(): string {
    const now = Date.now()
    if (!this.token || this.token.expiresAt - now < TOKEN_REFRESH_MARGIN_MS) {
      const { accessKey, secretKey } = this.keyPair()
      this.token = { value: buildKlingJwt(accessKey, secretKey, now), expiresAt: now + TOKEN_TTL_MS }
    }
    return `Bearer ${this.token.value}`
  }

  private keyPair(): { accessKey: string; secretKey: string } {
    const { accessKey, apiKey: secretKey } = this.options
    if (!accessKey || !secretKey) {
      throw new Error('kling needs both halves of its key pair: AdapterOptions.accessKey holds the access key, AdapterOptions.apiKey the secret key')
    }
    return { accessKey, secretKey }
  }
}

export function buildKlingSubmitRequest(
  baseUrl: string,
  authorization: string,
  capability: ModelCapability,
  request: ProviderRequest,
): KlingHttpRequest {
  const base = baseUrl.replace(/\/+$/, '')
  return {
    url: `${base}${klingResourcePath(capability.modality)}`,
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: buildKlingSubmitBody(capability, request),
  }
}

export function buildKlingPollRequest(
  baseUrl: string,
  authorization: string,
  capability: ModelCapability,
  taskId: string,
): KlingHttpRequest {
  const base = baseUrl.replace(/\/+$/, '')
  return {
    url: `${base}${klingResourcePath(capability.modality)}/${taskId}`,
    method: 'GET',
    headers: { Authorization: authorization },
  }
}

/** Always the text-to-video list, whatever capability is being probed: it proves the JWT, cheaply and without billing. */
export function buildKlingCredentialProbeRequest(baseUrl: string, authorization: string): KlingHttpRequest {
  const base = baseUrl.replace(/\/+$/, '')
  return {
    url: `${base}${klingResourcePath('t2v')}?pageNum=1&pageSize=1`,
    method: 'GET',
    headers: { Authorization: authorization },
  }
}

/** t2v and i2v are separate Kling endpoints, so the modality — not the model string — picks the resource. */
export function klingResource(modality: ModelModality): 'text2video' | 'image2video' {
  if (modality === 't2v') return T2V_RESOURCE
  if (modality === 'i2v') return I2V_RESOURCE
  throw new Error(`kling does not support modality "${modality}"`)
}

export function klingResourcePath(modality: ModelModality): string {
  return `${VIDEO_BASE}/${klingResource(modality)}`
}

export function buildKlingSubmitBody(capability: ModelCapability, request: ProviderRequest): KlingSubmitBody {
  const resource = klingResource(capability.modality)
  const { input, parameters } = request
  const body: KlingSubmitBody = {
    model_name: request.model,
    prompt: readString(input, 'prompt') ?? '',
    mode: readString(parameters, 'mode') ?? DEFAULT_MODE,
    // Kling validates duration as a string, so a numeric 10 has to be coerced rather than passed through.
    duration: String(parameters.duration ?? DEFAULT_DURATION),
    aspect_ratio: readString(parameters, 'aspectRatio') ?? DEFAULT_ASPECT_RATIO,
  }

  const negativePrompt = readString(parameters, 'negativePrompt')
  if (negativePrompt !== undefined) body.negative_prompt = negativePrompt
  const cfgScale = readNumber(parameters, 'cfgScale')
  if (cfgScale !== undefined) body.cfg_scale = cfgScale
  const callbackUrl = readString(parameters, 'callbackUrl')
  if (callbackUrl !== undefined) body.callback_url = callbackUrl

  if (resource === I2V_RESOURCE) {
    const media = Array.isArray(input.media)
      ? input.media.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
    const firstFrame = media[0] ?? readString(input, 'firstFrameUrl')
    if (!firstFrame) throw new Error('kling i2v requires a first frame (input.media[0] or input.firstFrameUrl)')
    body.image = toKlingImage(firstFrame)
    if (media[1] !== undefined) body.image_tail = toKlingImage(media[1])
  }

  return body
}

export function parseKlingTaskId(body: Record<string, unknown> | null): string | undefined {
  const data = asRecord(body?.data)
  const taskId = data?.task_id
  return typeof taskId === 'string' && taskId.length > 0 ? taskId : undefined
}

export function parseKlingPollResult(body: Record<string, unknown> | null): PollResult {
  const data = asRecord(body?.data) ?? {}
  const taskStatus = typeof data.task_status === 'string' ? data.task_status : ''

  // Kling spells its success state "succeed", not "succeeded" — an equality test written
  // against the dashscope vocabulary silently leaves the task running forever.
  if (taskStatus === 'succeed') {
    const artifactUrl = extractKlingVideoUrl(data)
    if (!artifactUrl) return { status: 'failed', error: 'kling: task succeed but no video url in data.task_result.videos' }
    return { status: 'completed', artifactUrl }
  }
  if (taskStatus === 'failed') {
    return { status: 'failed', error: sanitizeError(data.task_status_msg ?? body?.message ?? taskStatus) }
  }
  return { status: 'running' }
}

function extractKlingVideoUrl(data: Record<string, unknown>): string | undefined {
  const videos = asRecord(data.task_result)?.videos
  if (!Array.isArray(videos)) return undefined
  for (const video of videos) {
    const url = asRecord(video)?.url
    if (typeof url === 'string' && url.length > 0) return url
  }
  return undefined
}

export function buildKlingJwt(accessKey: string, secretKey: string, now: number = Date.now()): string {
  const issuedAt = Math.floor(now / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url')
  const payload = Buffer.from(JSON.stringify({ iss: accessKey, exp: issuedAt + TOKEN_TTL_SECONDS, nbf: issuedAt - NOT_BEFORE_LEEWAY_SECONDS }), 'utf8').toString('base64url')
  const unsigned = `${header}.${payload}`
  return `${unsigned}.${createHmac('sha256', secretKey).update(unsigned).digest('base64url')}`
}

export function decodeKlingJwt(token: string): { header: KlingJwtHeader; payload: KlingJwtPayload; signature: string } {
  const [header, payload, signature] = token.split('.')
  if (!header || !payload || !signature) throw new Error('kling: not a three-part JWT')
  const rawHeader = fromJsonSegment(header)
  const rawPayload = fromJsonSegment(payload)
  return {
    header: { alg: readString(rawHeader, 'alg'), typ: readString(rawHeader, 'typ') },
    payload: { iss: readString(rawPayload, 'iss'), exp: readNumber(rawPayload, 'exp'), nbf: readNumber(rawPayload, 'nbf') },
    signature,
  }
}

function fromJsonSegment(segment: string): Record<string, unknown> {
  return asRecord(JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown) ?? {}
}

/** Kling takes a first/tail frame as a bare base64 body or a public URL; the `data:image/...;base64,` prefix our own image pipeline produces has to go. */
function toKlingImage(value: string): string {
  return value.replace(/^data:[^,]*;base64,/i, '')
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** Kling answers with a numeric `code`, but some gateways stringify it. */
function klingCode(body: Record<string, unknown> | null): number | undefined {
  const code = body?.code
  if (typeof code === 'number' && Number.isFinite(code)) return code
  if (typeof code === 'string' && code.trim().length > 0 && Number.isFinite(Number(code))) return Number(code)
  return undefined
}
