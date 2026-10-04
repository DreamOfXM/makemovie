import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ModelCapability, ProviderAdapter, ProviderRequest, PollResult, ProbeResult } from './types.js'

/**
 * Voicebox — the local AI voice studio (github.com/jamiepine/voicebox, 56K stars).
 *
 * MakeMovie talks to its REST API (default http://127.0.0.1:17493, verified against
 * the shipped app on 2026-10-04) for the character-voice flow:
 *   1. GET  /health                    — liveness + model/backend facts
 *   2. GET  /profiles                  — voice profiles (preset | cloned)
 *   3. POST /profiles                  — create a cloned profile
 *   4. POST /profiles/:id/samples      — upload reference audio (multipart: file + reference_text)
 *   5. POST /generate                  — start an async job {profile_id, text, engine?, language?}
 *   6. GET  /history                   — poll jobs (status: generating|loading_model|completed|failed)
 *
 * Generation is asynchronous: /generate returns immediately with a job id, the audio
 * lands in /history once the job completes (first runs download models, which can take
 * minutes for the ~1GB clone engine). Completed jobs expose audio_path, a file inside
 * Voicebox's data dir on this machine; there is no dedicated download endpoint, so the
 * bytes are read from that local path (worker and Voicebox share the host by design).
 */

export const VOICEBOX_DEFAULT_BASE_URL = 'http://127.0.0.1:17493'

const HEALTH_TIMEOUT_MS = 2000
const REQUEST_TIMEOUT_MS = 30_000

export interface VoiceboxProfile {
  id: string
  name: string
  language: string | null
  /** 'preset' ships with the app; 'cloned' is fed by uploaded samples. */
  voice_type: 'preset' | 'cloned' | string
  default_engine: string | null
  preset_engine: string | null
  preset_voice_id: string | null
  sample_count: number
  [key: string]: unknown
}

export interface VoiceboxJob {
  id: string
  status: string
  duration: number
  audio_path: string
  error: string | null
  [key: string]: unknown
}

export function voiceboxBaseUrl(baseUrl?: string): string {
  return baseUrl ?? process.env.VOICEBOX_URL ?? VOICEBOX_DEFAULT_BASE_URL
}

/**
 * Completed jobs report audio_path relative to Voicebox's data dir (verified:
 * "generations/<id>.wav"), so the absolute location is resolved here. An absolute
 * path is used as-is for forward compatibility.
 */
function resolveVoiceboxAudioPath(audioPath: string): string {
  if (audioPath.startsWith('/')) return audioPath
  return join(homedir(), 'Library', 'Application Support', 'sh.voicebox.app', audioPath)
}

export async function isVoiceboxRunning(baseUrl?: string): Promise<boolean> {
  try {
    const res = await fetch(`${voiceboxBaseUrl(baseUrl)}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    if (!res.ok) return false
    const body = await res.json() as { status?: unknown }
    return body.status === 'healthy'
  } catch {
    return false
  }
}

export async function listVoiceboxProfiles(baseUrl?: string): Promise<VoiceboxProfile[]> {
  const res = await fetch(`${voiceboxBaseUrl(baseUrl)}/profiles`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`voicebox profiles: HTTP ${res.status}`)
  const data = await res.json() as unknown
  if (!Array.isArray(data)) return []
  return data.filter((item): item is VoiceboxProfile => {
    return typeof item === 'object' && item !== null && typeof (item as VoiceboxProfile).id === 'string'
  })
}

export async function createVoiceboxProfile(options: { name: string; language?: string; baseUrl?: string }): Promise<VoiceboxProfile> {
  const res = await fetch(`${voiceboxBaseUrl(options.baseUrl)}/profiles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: options.name, ...(options.language ? { language: options.language } : {}) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`voicebox create profile: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
  return await res.json() as VoiceboxProfile
}

/** Feeds one reference clip to a cloned profile. Voicebox requires the clip's transcript. */
export async function addVoiceboxSample(options: {
  profileId: string
  bytes: Uint8Array
  filename: string
  mimeType: string
  referenceText: string
  baseUrl?: string
}): Promise<void> {
  const form = new FormData()
  form.append('file', new Blob([options.bytes as BlobPart], { type: options.mimeType }), options.filename)
  form.append('reference_text', options.referenceText)
  const res = await fetch(`${voiceboxBaseUrl(options.baseUrl)}/profiles/${options.profileId}/samples`, {
    method: 'POST',
    body: form,
    // Sample ingestion runs on the model server, which may be busy loading a model.
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`voicebox add sample: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
}

export async function startVoiceboxJob(options: {
  profileId: string
  text: string
  language?: string
  baseUrl?: string
}): Promise<VoiceboxJob> {
  const res = await fetch(`${voiceboxBaseUrl(options.baseUrl)}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profile_id: options.profileId,
      text: options.text,
      ...(options.language ? { language: options.language } : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`voicebox generate: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
  return await res.json() as VoiceboxJob
}

export async function getVoiceboxJob(options: { jobId: string; baseUrl?: string }): Promise<VoiceboxJob | null> {
  const res = await fetch(`${voiceboxBaseUrl(options.baseUrl)}/history`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`voicebox history: HTTP ${res.status}`)
  const data = await res.json() as { items?: unknown }
  const items = Array.isArray(data.items) ? data.items : []
  for (const item of items) {
    if (typeof item === 'object' && item !== null && (item as VoiceboxJob).id === options.jobId) return item as VoiceboxJob
  }
  return null
}

export interface VoiceboxSpeechResult {
  bytes: Uint8Array
  mimeType: string
  durationMs: number | null
  job: VoiceboxJob
}

/**
 * Runs a generation to completion. `onStatus` receives every status transition
 * (loading_model during the first ~1GB engine download included) so the caller can
 * surface progress instead of looking hung.
 */
export async function generateVoiceboxSpeech(options: {
  profileId: string
  text: string
  language?: string
  baseUrl?: string
  intervalMs?: number
  timeoutMs?: number
  onStatus?: (status: string, job: VoiceboxJob) => void
}): Promise<VoiceboxSpeechResult> {
  const intervalMs = options.intervalMs ?? 2000
  const deadline = Date.now() + (options.timeoutMs ?? 600_000)
  const job = await startVoiceboxJob(options)
  options.onStatus?.(job.status, job)
  let last = job.status
  for (;;) {
    if (Date.now() > deadline) throw new Error(`voicebox generate: timed out in status "${last}"`)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
    const current = await getVoiceboxJob({ jobId: job.id, baseUrl: options.baseUrl })
    if (!current) throw new Error('voicebox generate: job disappeared from history')
    if (current.status !== last) {
      last = current.status
      options.onStatus?.(current.status, current)
    }
    if (current.status === 'failed' || current.status === 'error') {
      throw new Error(`voicebox generate failed: ${String(current.error ?? 'unknown error').slice(0, 300)}`)
    }
    if (current.status === 'completed' || (current.status === 'ready' && current.audio_path)) {
      if (!current.audio_path) throw new Error('voicebox generate: completed without audio_path')
      const bytes = new Uint8Array(await readFile(resolveVoiceboxAudioPath(current.audio_path)))
      if (bytes.byteLength === 0) throw new Error('voicebox generate: audio file is empty')
      return { bytes, mimeType: 'audio/wav', durationMs: current.duration > 0 ? Math.round(current.duration * 1000) : null, job: current }
    }
  }
}

/**
 * The provider adapter, for the day Voicebox is registered as a connection. Cloned
 * generation is async in Voicebox, so submit() returns the job id and poll() maps
 * /history states onto the pipeline's poll contract.
 */
export function createVoiceboxAdapter(baseUrl?: string): ProviderAdapter {
  return {
    provider: 'voicebox',
    async probe(): Promise<ProbeResult> {
      const running = await isVoiceboxRunning(baseUrl)
      return running
        ? { ok: true, status: 200, message: 'Voicebox is running and healthy' }
        : { ok: false, status: 0, message: `Voicebox is not running (expected at ${voiceboxBaseUrl(baseUrl)})` }
    },
    async submit(_capability: ModelCapability, request: ProviderRequest): Promise<{ taskId: string }> {
      const text = typeof request.input.prompt === 'string' ? request.input.prompt : String(request.input.prompt ?? '')
      const profileId = typeof request.parameters.profileId === 'string' ? request.parameters.profileId : ''
      if (!profileId) throw new Error('voicebox adapter requires parameters.profileId (the cloned profile to speak with)')
      const job = await startVoiceboxJob({ profileId, text, baseUrl })
      return { taskId: job.id }
    },
    async poll(_capability: ModelCapability, taskId: string): Promise<PollResult> {
      const job = await getVoiceboxJob({ jobId: taskId, baseUrl })
      if (!job) return { status: 'failed', error: 'voicebox job disappeared from history' }
      if (job.status === 'failed' || job.status === 'error') return { status: 'failed', error: String(job.error ?? 'voicebox reported failure').slice(0, 300) }
      if (job.status === 'completed' || (job.status === 'ready' && job.audio_path)) {
        const bytes = new Uint8Array(await readFile(resolveVoiceboxAudioPath(job.audio_path)))
        return { status: 'completed', inlineArtifact: { bytes, mimeType: 'audio/wav' } }
      }
      return { status: 'running' }
    },
  }
}
