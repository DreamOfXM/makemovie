import type { ModelModality } from '@studio/domain'
import { ANTHROPIC_DEFAULT_BASE_URL } from './anthropic.js'
import { GOOGLE_DEFAULT_BASE_URL } from './google.js'
import { KLING_DEFAULT_BASE_URL } from './kling.js'
import { OPENAI_DEFAULT_BASE_URL } from './openai.js'
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
  /** Absent for vendors whose host is whatever the operator runs, so the connection form must demand one. */
  defaultBaseUrl?: string
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
    { model: 'wanx2.1-i2v-turbo', displayName: 'Wanx 2.1 I2V Turbo', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [5], resolutions: ['720P'], referenceMaxBytes: 10_485_760 } },
    { model: 'wanx2.1-i2v-plus', displayName: 'Wanx 2.1 I2V Plus', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [5], resolutions: ['720P'], referenceMaxBytes: 10_485_760, note: 'the vendor offers 720P only for this model' } },
    { model: 'wan2.2-i2v-plus', displayName: 'Wan 2.2 I2V Plus', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [5], resolutions: ['480P', '1080P'], referenceMaxBytes: 10_485_760, note: 'five seconds, fixed' } },
    { model: 'wan2.6-i2v', displayName: 'Wan 2.6 I2V', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [2, 15], resolutions: ['720P', '1080P'], referenceMaxBytes: 20_971_520 } },
    { model: 'wan2.7-i2v-2026-04-25', displayName: 'Wan 2.7 I2V', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [2, 15], resolutions: ['720P', '1080P'], referenceMaxBytes: 20_971_520, note: 'newer request dialect: the frame travels in a media array instead of img_url' } },
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
    { model: 'doubao-seedance-1-5-pro-251215', displayName: 'Seedance 1.5 Pro', modality: 't2v', spec: { durations: [5, 10], resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'], note: 'image-to-video is not offered yet: this adapter implements the text-to-video endpoint only' } },
  ],
}

const kling: ProviderCatalog = {
  provider: 'kling',
  label: 'Kuaishou Kling',
  defaultBaseUrl: KLING_DEFAULT_BASE_URL,
  catalogVersion: '2026-09',
  requiresAccessKey: true,
  models: [
    { model: 'kling-v2-5-turbo', displayName: 'Kling 2.5 Turbo', modality: 't2v', spec: { durations: [5, 10], modes: ['std', 'pro'], aspectRatios: ['16:9', '9:16', '1:1'], note: 'image-to-video is built in the adapter but gets no catalog row until the vendor model name is verified' } },
    { model: 'kling-v1-6', displayName: 'Kling 1.6', modality: 't2v', spec: { durations: [5, 10], modes: ['std', 'pro'], aspectRatios: ['16:9', '9:16', '1:1'] } },
  ],
}

/**
 * Every model below was wired from the vendor's published API reference and exercised
 * only against stubbed HTTP in this repo's tests — no request was ever sent to a real
 * account from this codebase. The modality a row is filed under is what a production
 * stage binds it to, not a limit of the model: each of the chat models here also reads
 * images, and each of the vision rows could write a script.
 */
const NOT_LIVE_VERIFIED = 'wired from vendor docs and covered by stub contract tests only — never run against a live account'

const openai: ProviderCatalog = {
  provider: 'openai',
  label: 'OpenAI',
  defaultBaseUrl: OPENAI_DEFAULT_BASE_URL,
  catalogVersion: '2026-09',
  models: [
    { model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', modality: 'text', spec: { use: 'scriptwriting, storyboards', note: NOT_LIVE_VERIFIED } },
    { model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', modality: 'vlm', spec: { use: 'visual quality audits', note: NOT_LIVE_VERIFIED } },
    { model: 'gpt-image-1', displayName: 'GPT Image 1', modality: 'image', spec: { note: `answers with base64 inline, so the artifact never travels as a public link; ${NOT_LIVE_VERIFIED}` } },
    { model: 'gpt-4o-mini-tts', displayName: 'GPT-4o Mini TTS', modality: 'tts', spec: { voices: ['alloy'], note: `takes the line as \`input\` and returns raw audio bytes; the voice list here is not the vendor's full set; ${NOT_LIVE_VERIFIED}` } },
    { model: 'sora-2', displayName: 'Sora 2', modality: 't2v', spec: { note: `created from multipart form fields and downloaded from an authenticated content endpoint, so the clip cannot be relayed by URL; ${NOT_LIVE_VERIFIED}` } },
  ],
}

const google: ProviderCatalog = {
  provider: 'google',
  label: 'Google Gemini (AI Studio)',
  defaultBaseUrl: GOOGLE_DEFAULT_BASE_URL,
  catalogVersion: '2026-09',
  models: [
    { model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', modality: 'text', spec: { use: 'scriptwriting, storyboards', note: NOT_LIVE_VERIFIED } },
    { model: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', modality: 'vlm', spec: { use: 'visual quality audits', note: NOT_LIVE_VERIFIED } },
    { model: 'gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image', modality: 'image', spec: { note: `needs responseModalities to include IMAGE or it answers in prose; ${NOT_LIVE_VERIFIED}` } },
    { model: 'veo-3.1-generate-preview', displayName: 'Veo 3.1', modality: 't2v', spec: { note: `long-running operation: the returned operation name is the task id, so a restart does not lose a paid generation; ${NOT_LIVE_VERIFIED}` } },
    { model: 'veo-3.1-fast-generate-preview', displayName: 'Veo 3.1 Fast', modality: 't2v', spec: { note: NOT_LIVE_VERIFIED } },
  ],
}

const anthropic: ProviderCatalog = {
  provider: 'anthropic',
  label: 'Anthropic Claude',
  defaultBaseUrl: ANTHROPIC_DEFAULT_BASE_URL,
  catalogVersion: '2026-09',
  models: [
    { model: 'claude-opus-5', displayName: 'Claude Opus 5', modality: 'text', spec: { use: 'scriptwriting', note: NOT_LIVE_VERIFIED } },
    { model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', modality: 'text', spec: { use: 'storyboards', note: NOT_LIVE_VERIFIED } },
    { model: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', modality: 'vlm', spec: { use: 'visual quality audits', note: `messages calls require an explicit max_tokens, which the adapter defaults; ${NOT_LIVE_VERIFIED}` } },
  ],
}

/**
 * Not a vendor but a protocol. These gateways (vLLM, LM Studio, OpenRouter, a company
 * proxy) expose OpenAI's chat, image and speech shapes on a host only the operator
 * knows, and the model names are theirs, so this catalog carries neither a default URL
 * nor a single model — both are typed in on the connection.
 */
const openaiCompatible: ProviderCatalog = {
  provider: 'openai_compatible',
  label: 'OpenAI-compatible gateway',
  catalogVersion: '2026-09',
  models: [],
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
  [openai.provider, openai],
  [google.provider, google],
  [anthropic.provider, anthropic],
  [openaiCompatible.provider, openaiCompatible],
  [mock.provider, mock],
])

export function getCatalog(provider: string): ProviderCatalog | undefined {
  return registry.get(provider)
}

export function listCatalogs(): ProviderCatalog[] {
  return [...registry.values()]
}
