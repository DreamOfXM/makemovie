import type { ModelCapability, ModelModality } from '@studio/domain'
import type { AdapterOptions, PollResult, ProbeResult, ProviderAdapter, ProviderRequest, SubmitResult } from './types.js'
import { parseDataUrl, sanitizeError } from './types.js'

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com'
export const ANTHROPIC_VERSION = '2023-06-01'

const MESSAGES_PATH = '/v1/messages'
const MODELS_PATH = '/v1/models'

/**
 * Claude refuses a messages call that omits a ceiling, so one is always sent. The
 * pipeline writes episode scripts and shot lists in the low thousands of tokens, well
 * inside this; a caller that needs more says so through parameters.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192

const SUPPORTED_MODALITIES = new Set<ModelModality>(['text', 'vlm'])

export interface AnthropicHttpRequest {
  url: string
  method: 'POST' | 'GET'
  headers: Record<string, string>
  body?: unknown
}

function baseUrlOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * `x-api-key` plus a version header, and deliberately no Authorization: a bearer token
 * is a different vendor's scheme and mixing them produces an error that reads like a bad
 * key rather than a wrong header.
 */
function authHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
}

function promptOf(request: ProviderRequest): string {
  return typeof request.input.prompt === 'string' ? request.input.prompt : ''
}

function assertSupported(capability: ModelCapability): void {
  if (SUPPORTED_MODALITIES.has(capability.modality)) return
  throw new Error(`anthropic adapter does not support modality "${capability.modality}" (no endpoint implemented)`)
}

export function buildAnthropicMessagesRequest(
  baseUrl: string,
  apiKey: string,
  capability: ModelCapability,
  request: ProviderRequest,
): AnthropicHttpRequest {
  assertSupported(capability)
  const prompt = promptOf(request)
  const supplied = Array.isArray(request.input.messages) && request.input.messages.length > 0 ? request.input.messages : undefined
  const parts: unknown[] = []
  if (capability.modality === 'vlm') {
    for (const image of Array.isArray(request.input.images) ? request.input.images : []) {
      if (typeof image !== 'string') continue
      const parsed = parseDataUrl(image)
      // An image the adapter cannot describe is not sent as a half-filled block.
      if (parsed) parts.push({ type: 'image', source: { type: 'base64', media_type: parsed.mimeType, data: parsed.base64 } })
    }
  }
  parts.push({ type: 'text', text: prompt })
  return {
    url: `${baseUrlOf(baseUrl)}${MESSAGES_PATH}`,
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
    body: {
      model: request.model,
      max_tokens: maxTokensOf(request.parameters),
      messages: supplied ? supplied.map(toAnthropicMessage) : [{ role: 'user', content: parts }],
    },
  }
}

function toAnthropicMessage(message: unknown): unknown {
  const record = typeof message === 'object' && message !== null ? message as { role?: unknown; content?: unknown } : {}
  const content = typeof record.content === 'string' ? [{ type: 'text', text: record.content }] : record.content
  return { role: typeof record.role === 'string' ? record.role : 'user', content: Array.isArray(content) ? content : [] }
}

export function maxTokensOf(parameters: Record<string, unknown>): number {
  const value = parameters.max_tokens
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : ANTHROPIC_DEFAULT_MAX_TOKENS
}

/** The answer is a list of blocks and only some of them are prose. */
export function extractAnthropicText(body: Record<string, unknown> | null): string {
  const content = Array.isArray(body?.content) ? body.content : []
  return content
    .map(block => (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' ? (block as { text?: unknown }).text : undefined))
    .filter((text): text is string => typeof text === 'string')
    .join('')
}

interface SyncOutcome {
  text: string
}

const syncResults = new Map<string, SyncOutcome>()
let syncCounter = 0

export class AnthropicAdapter implements ProviderAdapter {
  provider = 'anthropic'

  private credential?: Promise<ProbeResult>

  constructor(private readonly options: AdapterOptions) {}

  async probe(capability: ModelCapability): Promise<ProbeResult> {
    if (!SUPPORTED_MODALITIES.has(capability.modality)) {
      return { ok: false, status: 0, message: `no anthropic endpoint for modality "${capability.modality}"` }
    }
    this.credential ??= this.checkCredential()
    const result = await this.credential
    return result.ok ? { ...result, message: `probe ok for ${capability.model}` } : result
  }

  private async checkCredential(): Promise<ProbeResult> {
    const httpRequest = buildAnthropicProbeRequest(this.options.baseUrl, this.options.apiKey)
    try {
      const response = await fetch(httpRequest.url, { method: httpRequest.method, headers: httpRequest.headers })
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (!response.ok) return { ok: false, status: response.status, message: sanitizeError(body?.error ?? body ?? response.statusText) }
      if (!Array.isArray(body?.data)) return { ok: false, status: response.status, message: 'anthropic probe: 2xx without a "data" model list' }
      return { ok: true, status: response.status, message: 'probe ok' }
    } catch (error) {
      return { ok: false, status: 0, message: sanitizeError(error instanceof Error ? error.message : error) }
    }
  }

  async submit(capability: ModelCapability, request: ProviderRequest): Promise<SubmitResult> {
    const httpRequest = buildAnthropicMessagesRequest(this.options.baseUrl, this.options.apiKey, capability, request)
    const response = await fetch(httpRequest.url, {
      method: httpRequest.method,
      headers: httpRequest.headers,
      body: JSON.stringify(httpRequest.body),
    })
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) throw new Error(sanitizeError(body?.error ?? body ?? `HTTP ${response.status}`))
    const taskId = `an-sync-${++syncCounter}`
    syncResults.set(taskId, { text: extractAnthropicText(body) })
    return { taskId }
  }

  async poll(capability: ModelCapability, taskId: string): Promise<PollResult> {
    assertSupported(capability)
    if (!taskId.startsWith('an-sync-')) return { status: 'failed', error: `anthropic: no task lifecycle for ${taskId}; the messages endpoint answers in one call` }
    const cached = syncResults.get(taskId)
    if (!cached) return { status: 'failed', error: `anthropic: unknown sync task ${taskId}` }
    syncResults.delete(taskId)
    return { status: 'completed', ...cached }
  }
}

/** GET /models is the spend-free credential probe; entitlement for one model is not proven by it. */
export function buildAnthropicProbeRequest(baseUrl: string, apiKey: string): AnthropicHttpRequest {
  return { url: `${baseUrlOf(baseUrl)}${MODELS_PATH}`, method: 'GET', headers: authHeaders(apiKey) }
}

/** Test hook: the sync task map is module state, so a suite has to be able to clear it. */
export function resetAnthropicSyncResults(): void {
  syncResults.clear()
  syncCounter = 0
}
