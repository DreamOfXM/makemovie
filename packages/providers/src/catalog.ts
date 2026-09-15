import type { ModelModality } from '@studio/domain'
import { KLING_DEFAULT_BASE_URL } from './kling.js'
import { SEEDANCE_DEFAULT_BASE_URL } from './seedance.js'

export interface CatalogModel {
  model: string
  displayName: string
  modality: ModelModality
  acceptsFirstFrame?: boolean
  acceptsReferenceImages?: boolean
  maxReferenceImages?: number
  spec?: Record<string, unknown>
}

export interface ProviderCatalog {
  provider: string
  label: string
  defaultBaseUrl: string
  catalogVersion: string
  /** True for vendors that authenticate with an access key + secret key pair, so the connection form asks for both halves. */
  requiresAccessKey?: boolean
  models: CatalogModel[]
}

const dashscope: ProviderCatalog = {
  provider: 'dashscope',
  label: 'Alibaba Cloud Bailian (DashScope)',
  defaultBaseUrl: 'https://dashscope.aliyuncs.com',
  catalogVersion: '2026-09',
  models: [
    { model: 'qwen-max', displayName: 'Qwen Max', modality: 'text', spec: { use: 'scriptwriting, complex reasoning' } },
    { model: 'qwen-plus', displayName: 'Qwen Plus', modality: 'text', spec: { use: 'scriptwriting, storyboards' } },
    { model: 'qwen-turbo', displayName: 'Qwen Turbo', modality: 'text', spec: { use: 'fast drafts, probing' } },
    { model: 'qwen-vl-max', displayName: 'Qwen VL Max', modality: 'vlm', spec: { use: 'visual quality audits' } },
    { model: 'wanx2.1-t2i-turbo', displayName: 'Wanx 2.1 T2I Turbo', modality: 'image', spec: { resolutions: ['1024x1024', '720x1280', '1280x720'] } },
    { model: 'wanx2.1-t2i-plus', displayName: 'Wanx 2.1 T2I Plus', modality: 'image', spec: { resolutions: ['1024x1024', '720x1280', '1280x720'] } },
    { model: 'qwen-image-3.0', displayName: 'Qwen Image 3.0', modality: 'image', spec: { note: 'synchronous multimodal endpoint, n fixed at 1' } },
    { model: 'qwen-image-3.0-pro', displayName: 'Qwen Image 3.0 Pro', modality: 'image', spec: { note: 'synchronous multimodal endpoint, n fixed at 1' } },
    { model: 'wan2.2-t2v-plus', displayName: 'Wan 2.2 T2V Plus', modality: 't2v', spec: { durations: [5], resolutions: ['720P', '1080P'], note: 'text-to-video only, never for reference tasks' } },
    { model: 'wanx2.1-i2v-turbo', displayName: 'Wanx 2.1 I2V Turbo', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [5], resolutions: ['720P'] } },
    { model: 'wanx2.1-i2v-plus', displayName: 'Wanx 2.1 I2V Plus', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [5], resolutions: ['720P', '1080P'] } },
    { model: 'qwen3-tts-flash', displayName: 'Qwen3 TTS Flash', modality: 'tts', spec: { voices: ['Cherry', 'Serena', 'Ethan', 'Chelsie', 'Ryan'], note: 'synchronous multimodal endpoint; audio url expires in ~24h so it must be downloaded promptly' } },
    { model: 'fun-music-v1', displayName: 'Fun Music V1', modality: 'music', spec: { note: 'async audio endpoint; access requires an invitation from Aliyun (邀测) — a 403 is a missing grant, not a bug in this product' } },
  ],
}

const seedance: ProviderCatalog = {
  provider: 'seedance',
  label: 'Volcano Ark (Doubao Seedance)',
  defaultBaseUrl: SEEDANCE_DEFAULT_BASE_URL,
  catalogVersion: '2026-09',
  models: [
    { model: 'doubao-seedance-1-0-pro-250528', displayName: 'Seedance 1.0 Pro', modality: 't2v', spec: { durations: [5, 10], resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'], note: 'the returned video link is signed and lasts about a day, so the worker ingests it the moment the task settles' } },
    { model: 'doubao-seedance-1-5-pro-251215', displayName: 'Seedance 1.5 Pro', modality: 't2v', spec: { durations: [5, 10], resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'], note: 'image-to-video is not offered yet: Ark takes a first frame as a public URL and this product keeps its frames behind its own storage' } },
  ],
}

const kling: ProviderCatalog = {
  provider: 'kling',
  label: 'Kuaishou Kling',
  defaultBaseUrl: KLING_DEFAULT_BASE_URL,
  catalogVersion: '2026-09',
  requiresAccessKey: true,
  models: [
    { model: 'kling-v2-5-turbo', displayName: 'Kling 2.5 Turbo', modality: 't2v', spec: { durations: [5, 10], modes: ['std', 'pro'], aspectRatios: ['16:9', '9:16', '1:1'], note: 'image-to-video works at the adapter level but no production stage can bind an i2v capability yet, so it is not listed here' } },
    { model: 'kling-v1-6', displayName: 'Kling 1.6', modality: 't2v', spec: { durations: [5, 10], modes: ['std', 'pro'], aspectRatios: ['16:9', '9:16', '1:1'] } },
  ],
}

const mock: ProviderCatalog = {
  provider: 'mock',
  label: 'Mock Provider (development & CI)',
  defaultBaseUrl: 'mock://local',
  catalogVersion: '2026-09',
  models: [
    { model: 'mock-text', displayName: 'Mock Text', modality: 'text' },
    { model: 'mock-script', displayName: 'Mock Scriptwriter', modality: 'text' },
    { model: 'mock-storyboard', displayName: 'Mock Storyboard Artist', modality: 'text' },
    { model: 'mock-vlm', displayName: 'Mock Vision', modality: 'vlm' },
    { model: 'mock-image', displayName: 'Mock Image', modality: 'image' },
    { model: 'mock-t2v', displayName: 'Mock T2V', modality: 't2v' },
    { model: 'mock-i2v', displayName: 'Mock I2V', modality: 'i2v', acceptsFirstFrame: true },
    { model: 'mock-r2v', displayName: 'Mock R2V', modality: 'r2v', acceptsFirstFrame: true, acceptsReferenceImages: true, maxReferenceImages: 4 },
    { model: 'mock-tts', displayName: 'Mock TTS', modality: 'tts' },
    { model: 'mock-music', displayName: 'Mock Music', modality: 'music' },
  ],
}

const registry = new Map<string, ProviderCatalog>([
  [dashscope.provider, dashscope],
  [seedance.provider, seedance],
  [kling.provider, kling],
  [mock.provider, mock],
])

export function getCatalog(provider: string): ProviderCatalog | undefined {
  return registry.get(provider)
}

export function listCatalogs(): ProviderCatalog[] {
  return [...registry.values()]
}
