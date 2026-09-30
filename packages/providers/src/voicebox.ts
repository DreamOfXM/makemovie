import type { ModelCapability, ProviderAdapter, ProviderRequest, PollResult, ProbeResult } from './types.js'

/**
 * Voicebox — the local AI voice studio (github.com/jamiepine/voicebox, 56K stars).
 *
 * MakeMovie talks to its REST API (default http://127.0.0.1:17493) for two things:
 *   1. listing voice profiles (GET /profiles) — for the asset panel's voice picker
 *   2. generating speech with a cloned voice (POST /generate) — for the AUDIO stage
 *
 * Everything runs locally on the user's machine (MLX on Apple Silicon), so this
 * provider costs nothing per call. It is the recommended TTS engine when present;
 * DashScope TTS is the cloud fallback when Voicebox is not running.
 *
 * The adapter is intentionally thin: Voicebox already handles model loading,
 * zero-shot cloning from reference audio, and multi-engine routing. We do not
 * reimplement any of that — we just speak its three-endpoint REST contract.
 */

const HEALTH_TIMEOUT_MS = 2000
const GENERATE_TIMEOUT_MS = 120_000

export interface VoiceboxProfile {
  id: string
  name: string
  /** Some engines expose more metadata; we only need id and name for the picker. */
  [key: string]: unknown
}

export interface VoiceboxGenerateResult {
  /** Path to the generated audio file on disk (Voicebox returns a file path). */
  path?: string
  /** Or raw audio bytes if the API returns them inline. */
  bytes?: Uint8Array
  mimeType: string
}

export function isVoiceboxRunning(baseUrl?: string): Promise<boolean> {
  const url = baseUrl ?? 'http://127.0.0.1:17493'
  return fetch(`${url}/profiles`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    .then(res => res.ok)
    .catch(() => false)
}

export async function listVoiceboxProfiles(baseUrl?: string): Promise<VoiceboxProfile[]> {
  const url = baseUrl ?? 'http://127.0.0.1:17493'
  const res = await fetch(`${url}/profiles`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`voicebox profiles: HTTP ${res.status}`)
  const data = await res.json() as unknown
  if (!Array.isArray(data)) return []
  return data.flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : typeof record.profile_id === 'string' ? record.profile_id : undefined
    const name = typeof record.name === 'string' ? record.name : undefined
    return id ? [{ id, name: name ?? id, ...record }] : []
  })
}

/**
 * Generates speech with a specific cloned voice. The text is the dialogue line;
 * the profile_id selects which cloned voice speaks it. Language defaults to
 * Chinese (the product's primary locale).
 */
export async function generateVoiceboxSpeech(options: {
  text: string
  profileId: string
  language?: string
  baseUrl?: string
}): Promise<VoiceboxGenerateResult> {
  const url = options.baseUrl ?? 'http://127.0.0.1:17493'
  const res = await fetch(`${url}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: options.text,
      profile_id: options.profileId,
      language: options.language ?? 'zh',
    }),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`voicebox generate: HTTP ${res.status} ${body.slice(0, 200)}`)
  }
  const contentType = res.headers.get('content-type') ?? 'audio/wav'
  if (contentType.startsWith('audio/')) {
    const buffer = await res.arrayBuffer()
    return { bytes: new Uint8Array(buffer), mimeType: contentType }
  }
  // Some versions return a JSON with a file path or a data URL.
  const data = await res.json().catch(() => ({})) as Record<string, unknown>
  const path = typeof data.path === 'string' ? data.path : typeof data.file === 'string' ? data.file : undefined
  const dataUrl = typeof data.audio === 'string' ? data.audio : typeof data.url === 'string' ? data.url : undefined
  if (path) return { path, mimeType: 'audio/wav' }
  if (dataUrl?.startsWith('data:audio/')) {
    const [header, base64] = dataUrl.split(',')
    const mime = /data:(audio\/[^;]+)/.exec(header)?.[1] ?? 'audio/wav'
    return { bytes: base64ToBytes(base64), mimeType: mime }
  }
  throw new Error('voicebox generate: unexpected response shape')
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * The provider adapter for the capability system. Voicebox is a local service
 * rather than a cloud API, so submit() hits the generate endpoint directly and
 * poll() resolves immediately — there is no async task to wait for.
 */
export function createVoiceboxAdapter(baseUrl?: string): ProviderAdapter {
  const url = baseUrl ?? 'http://127.0.0.1:17493'
  return {
    provider: 'voicebox',
    async probe(): Promise<ProbeResult> {
      const running = await isVoiceboxRunning(url)
      return running
        ? { ok: true, status: 200, message: 'Voicebox is running and answering on /profiles' }
        : { ok: false, status: 0, message: 'Voicebox is not running (expected at http://127.0.0.1:17493)' }
    },
    async submit(_capability: ModelCapability, request: ProviderRequest): Promise<{ taskId: string }> {
      const text = typeof request.input.prompt === 'string' ? request.input.prompt : String(request.input.prompt ?? '')
      const profileId = typeof request.parameters.profileId === 'string' ? request.parameters.profileId : 'default'
      const language = typeof request.parameters.language === 'string' ? request.parameters.language : 'zh'
      const result = await generateVoiceboxSpeech({ text, profileId, language, baseUrl: url })
      if (!result.bytes) throw new Error('voicebox adapter expects inline audio bytes (file-path results need worker-side reading)')
      // Inline the result as a base64 data reference in the taskId so poll() returns it
      // synchronously. Voicebox has no async task to poll — the answer is final.
      const encoded = JSON.stringify({ m: result.mimeType, b: Array.from(result.bytes).join(',') })
      return { taskId: `voicebox:${encoded}` }
    },
    async poll(_capability: ModelCapability, taskId: string): Promise<PollResult> {
      if (!taskId.startsWith('voicebox:')) throw new Error('not a voicebox task')
      const payload = JSON.parse(taskId.slice('voicebox:'.length)) as { m: string; b: string }
      const bytes = new Uint8Array(payload.b.split(',').map(Number))
      return { status: 'completed', inlineArtifact: { bytes, mimeType: payload.m } }
    },
  }
}
