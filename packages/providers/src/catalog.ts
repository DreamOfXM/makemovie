import type { ModelModality } from '@studio/domain'

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
  [mock.provider, mock],
])

export function getCatalog(provider: string): ProviderCatalog | undefined {
  return registry.get(provider)
}

export function listCatalogs(): ProviderCatalog[] {
  return [...registry.values()]
}
