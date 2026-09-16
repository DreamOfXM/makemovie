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
    { model: 'qwen3.8-max', displayName: 'Qwen3.8 Max', modality: 'text', spec: { use: 'scriptwriting, complex reasoning' } },
    { model: 'qwen3.7-plus', displayName: 'Qwen3.7 Plus', modality: 'text', spec: { use: 'scriptwriting, storyboards' } },
    { model: 'qwen3.8-flash', displayName: 'Qwen3.8 Flash', modality: 'text', spec: { use: 'fast drafts, probing' } },
    { model: 'qwen3-vl-plus', displayName: 'Qwen3 VL Plus', modality: 'vlm', spec: { use: 'visual quality audits' } },
    { model: 'qwen3-vl-flash', displayName: 'Qwen3 VL Flash', modality: 'vlm', spec: { use: 'audits at volume, where latency dominates' } },
    { model: 'wan2.6-t2i', displayName: 'Wan 2.6 T2I', modality: 'image', spec: { note: 'the vendor recommends this tier and lets it be called synchronously, which the older ones are not; sizes are free-form but its total pixel count must sit between 1280×1280 and 1440×1440, so the small square presets other models accept are out of range here' } },
    { model: 'wan2.2-t2i-flash', displayName: 'Wan 2.2 T2I Flash', modality: 'image', spec: { note: 'the fast tier, async only; width and height each between 512 and 1440 pixels' } },
    { model: 'qwen-image-3.0', displayName: 'Qwen Image 3.0', modality: 'image', spec: { note: 'synchronous multimodal endpoint, n fixed at 1' } },
    { model: 'qwen-image-3.0-pro', displayName: 'Qwen Image 3.0 Pro', modality: 'image', spec: { note: 'synchronous multimodal endpoint, n fixed at 1' } },
    { model: 'wan3.0-video', displayName: 'Wan 3.0 Video', modality: 't2v', spec: { durations: [2, 30], resolutions: ['480P', '720P', '1080P'], ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'], note: 'the vendor defaults this model to 1080P and to an adaptive aspect ratio, and this product sends neither, so those are the values a shot is billed at' } },
    { model: 'wan2.7-t2v', displayName: 'Wan 2.7 T2V', modality: 't2v', spec: { durations: [2, 15], resolutions: ['720P', '1080P'], note: 'the dated snapshot wan2.7-t2v-2026-06-12 is this model pinned to one version' } },
    { model: 'wan3.0-video', displayName: 'Wan 3.0 Video', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [2, 30], resolutions: ['480P', '720P', '1080P'], referenceMaxBytes: 20_971_520, note: 'same media array as wan2.7; the vendor also fuses reference images and video through this id, which this product does not offer yet' } },
    { model: 'wan2.7-i2v-2026-04-25', displayName: 'Wan 2.7 I2V', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [2, 15], resolutions: ['720P', '1080P'], referenceMaxBytes: 20_971_520, note: 'newer request dialect: the frame travels in a media array instead of img_url, and only the wan2.7 and wan3.0 generations speak it' } },
    { model: 'wan2.6-i2v', displayName: 'Wan 2.6 I2V', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [2, 15], resolutions: ['720P', '1080P'], referenceMaxBytes: 20_971_520 } },
    { model: 'wan2.2-i2v-plus', displayName: 'Wan 2.2 I2V Plus', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [5], resolutions: ['480P', '1080P'], referenceMaxBytes: 10_485_760, note: 'five seconds, fixed' } },
    { model: 'wanx2.1-i2v-plus', displayName: 'Wanx 2.1 I2V Plus', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [5], resolutions: ['720P'], referenceMaxBytes: 10_485_760, note: 'the vendor offers 720P only for this model' } },
    { model: 'wanx2.1-i2v-turbo', displayName: 'Wanx 2.1 I2V Turbo', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [5], resolutions: ['720P'], referenceMaxBytes: 10_485_760 } },
    { model: 'qwen3-tts-flash', displayName: 'Qwen3 TTS Flash', modality: 'tts', spec: { voices: ['Cherry', 'Serena', 'Ethan', 'Chelsie', 'Ryan'], note: 'synchronous multimodal endpoint; audio url expires in ~24h so it must be downloaded promptly' } },
    { model: 'fun-music-v1', displayName: 'Fun Music V1', modality: 'music', spec: { note: 'async audio endpoint; access requires an invitation from Aliyun (邀测) and the service runs only in the China (Beijing) region — either way the failure is a missing grant, not a bug in this product' } },
  ],
}

const seedance: ProviderCatalog = {
  provider: 'seedance',
  label: 'Volcano Ark (Doubao Seedance)',
  defaultBaseUrl: SEEDANCE_DEFAULT_BASE_URL,
  catalogVersion: '2026-09',
  models: [
    { model: 'doubao-seedance-2-5-260628', displayName: 'Seedance 2.5', modality: 't2v', spec: { durations: [4, 30], resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'], note: 'the newest generation; 1080p output is 10-bit and the vendor ships mp4 and mov; the returned video link is signed and lasts about a day, so the worker ingests it the moment the task settles' } },
    { model: 'doubao-seedance-2-5-260628', displayName: 'Seedance 2.5', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [4, 30], resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'], note: 'Ark picks the dialect by whether the content array carries an image, not by the model id' } },
    { model: 'doubao-seedance-2-0-260128', displayName: 'Seedance 2.0', modality: 't2v', spec: { durations: [4, 15], resolutions: ['480p', '720p', '1080p', '4k'], ratios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive'], note: 'open API access since 2026-02-24; 4k exists on this generation only, not on 2.5' } },
    { model: 'doubao-seedance-2-0-260128', displayName: 'Seedance 2.0', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [4, 15], resolutions: ['480p', '720p', '1080p', '4k'], ratios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive'] } },
    { model: 'doubao-seedance-2-0-fast-260128', displayName: 'Seedance 2.0 Fast', modality: 't2v', spec: { durations: [4, 15], resolutions: ['480p', '720p'], ratios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive'], note: 'what the vendor points the old 1.0-lite image-to-video id at' } },
    { model: 'doubao-seedance-2-0-fast-260128', displayName: 'Seedance 2.0 Fast', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [4, 15], resolutions: ['480p', '720p'], ratios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive'] } },
    { model: 'doubao-seedance-1-0-pro-250528', displayName: 'Seedance 1.0 Pro', modality: 't2v', spec: { durations: [2, 12], resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'], note: 'the oldest generation still on the vendor list; this series takes no adaptive ratio' } },
    { model: 'doubao-seedance-1-0-pro-250528', displayName: 'Seedance 1.0 Pro', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [2, 12], resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] } },
  ],
}

const kling: ProviderCatalog = {
  provider: 'kling',
  label: 'Kuaishou Kling',
  defaultBaseUrl: KLING_DEFAULT_BASE_URL,
  catalogVersion: '2026-09',
  requiresAccessKey: true,
  models: [
    { model: 'kling-v2-5-turbo', displayName: 'Kling 2.5 Turbo', modality: 't2v', spec: { durations: [5, 10], modes: ['std', 'pro'], aspectRatios: ['16:9', '9:16', '1:1'], note: 'the vendor ships newer generations and has sunset the one that used to sit below this row; their model_name literals are unverified from the legacy key/secret endpoint this adapter drives, so they stay off the catalog rather than as rows a probe cannot explain' } },
    { model: 'kling-v2-5-turbo', displayName: 'Kling 2.5 Turbo', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [5, 10], modes: ['std', 'pro'], aspectRatios: ['16:9', '9:16', '1:1'], note: 'same model_name as the text-to-video row, sent to the image2video resource instead; the adapter strips a data URL down to bare base64 because Kling takes the image inline' } },
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
  // No video row: the vendor has scheduled the Videos API and every sora-2 id — base, pro, and
  // the dated snapshots — for shutdown on 2026-09-24, and its own deprecation table leaves the
  // replacement column empty. The adapter's video branch stays in place — a hand-typed model id
  // still reaches it, and the endpoint answers until that date — but a catalog row would be
  // telling a user to buy access to something the vendor is switching off in days.
  models: [
    { model: 'gpt-6-astra', displayName: 'GPT-6 Astra', modality: 'text', spec: { use: 'scriptwriting, complex reasoning', note: `the newest tier that still answers on the chat-completions endpoint this adapter drives; ${NOT_LIVE_VERIFIED}` } },
    { model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', modality: 'text', spec: { use: 'scriptwriting, storyboards', note: NOT_LIVE_VERIFIED } },
    { model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', modality: 'vlm', spec: { use: 'visual quality audits', note: NOT_LIVE_VERIFIED } },
    { model: 'gpt-image-2.5-flare', displayName: 'GPT Image 2.5 Flare', modality: 'image', spec: { resolutions: ['1024x1024', '1536x1024', '1024x1536'], note: `the fast tier; answers with base64 inline, so the artifact never travels as a public link; ${NOT_LIVE_VERIFIED}` } },
    { model: 'gpt-image-2.5-sunburst', displayName: 'GPT Image 2.5 Sunburst', modality: 'image', spec: { resolutions: ['1024x1024', '1536x1024', '1024x1536'], note: `the editing-precision tier, which is what a re-take on a frame someone already approved needs; ${NOT_LIVE_VERIFIED}` } },
    { model: 'gpt-4o-mini-tts', displayName: 'GPT-4o Mini TTS', modality: 'tts', spec: { voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'], note: `takes the line as \`input\` and returns raw audio bytes; the vendor points new work at marin and cedar; ${NOT_LIVE_VERIFIED}` } },
  ],
}

const google: ProviderCatalog = {
  provider: 'google',
  label: 'Google Gemini (AI Studio)',
  defaultBaseUrl: GOOGLE_DEFAULT_BASE_URL,
  catalogVersion: '2026-09',
  models: [
    { model: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', modality: 'text', spec: { use: 'scriptwriting, storyboards', note: `the newest stable model in this series; the vendor names no generation above it, and the pro-class row below is still a preview; ${NOT_LIVE_VERIFIED}` } },
    { model: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', modality: 'vlm', spec: { use: 'visual quality audits', note: NOT_LIVE_VERIFIED } },
    { model: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview', modality: 'text', spec: { use: 'the pro tier, on a preview id', note: `the only id the vendor publishes for this generation, and the two image rows below were both reached through a \`-preview\` suffix until the vendor dropped it on a published date — so this string can move the same way, and re-running an already approved scene after it does is not guaranteed to reproduce; ${NOT_LIVE_VERIFIED}` } },
    { model: 'gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image', modality: 'image', spec: { note: `needs responseModalities to include IMAGE or it answers in prose; ${NOT_LIVE_VERIFIED}` } },
    { model: 'gemini-3-pro-image', displayName: 'Gemini 3 Pro Image', modality: 'image', spec: { note: `a separate id from the flash image row, but the same request shape, so this product drives both without special-casing either; ${NOT_LIVE_VERIFIED}` } },
    { model: 'veo-3.1-generate-preview', displayName: 'Veo 3.1', modality: 't2v', spec: { durations: [4, 6, 8], resolutions: ['720p', '1080p', '4k'], note: `long-running operation: the returned operation name is the task id, so a restart does not lose a paid generation; the vendor holds this id at preview status and has announced no shutdown date; it also states English is the only prompt language it evaluated, and this product's shot descriptions arrive in whichever language the episode was written in; ${NOT_LIVE_VERIFIED}` } },
    { model: 'veo-3.1-generate-preview', displayName: 'Veo 3.1', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [4, 6, 8], resolutions: ['720p', '1080p', '4k'], note: `the frame travels inside the instance as inline bytes beside the prompt; 1080p and 4k cost the full 8 seconds; the vendor permits adult subjects only on this image-conditioned path, so a shot whose approved frame is a child is the one case this row cannot serve; ${NOT_LIVE_VERIFIED}` } },
    { model: 'veo-3.1-fast-generate-preview', displayName: 'Veo 3.1 Fast', modality: 't2v', spec: { durations: [4, 6, 8], resolutions: ['720p', '1080p', '4k'], note: NOT_LIVE_VERIFIED } },
    { model: 'veo-3.1-fast-generate-preview', displayName: 'Veo 3.1 Fast', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [4, 6, 8], resolutions: ['720p', '1080p', '4k'], note: NOT_LIVE_VERIFIED } },
    { model: 'veo-3.1-lite-generate-preview', displayName: 'Veo 3.1 Lite', modality: 't2v', spec: { durations: [4, 6, 8], resolutions: ['720p', '1080p'], note: `the vendor's low-cost tier of the same family, and the one that gives up the most: no 4k, no reference images, and no video-extension input, which the two tiers above do take; ${NOT_LIVE_VERIFIED}` } },
    { model: 'veo-3.1-lite-generate-preview', displayName: 'Veo 3.1 Lite', modality: 'i2v', acceptsFirstFrame: true, spec: { durations: [4, 6, 8], resolutions: ['720p', '1080p'], note: `1080p is available here but costs the full 8 seconds; ${NOT_LIVE_VERIFIED}` } },
  ],
}

const anthropic: ProviderCatalog = {
  provider: 'anthropic',
  label: 'Anthropic Claude',
  defaultBaseUrl: ANTHROPIC_DEFAULT_BASE_URL,
  catalogVersion: '2026-09',
  models: [
    { model: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', modality: 'text', spec: { use: 'scriptwriting, complex reasoning', note: `the vendor's newest tier; ${NOT_LIVE_VERIFIED}` } },
    { model: 'claude-opus-5', displayName: 'Claude Opus 5', modality: 'text', spec: { use: 'scriptwriting', note: NOT_LIVE_VERIFIED } },
    { model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', modality: 'text', spec: { use: 'storyboards', note: NOT_LIVE_VERIFIED } },
    { model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', modality: 'vlm', spec: { use: 'visual quality audits', note: `every Claude row reads images, this one included; ${NOT_LIVE_VERIFIED}` } },
    { model: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', modality: 'vlm', spec: { use: 'audits at volume, where latency dominates', note: `the vendor retires this id no sooner than 2026-10-15, so bind it expecting to re-point it; messages calls require an explicit max_tokens, which the adapter defaults; ${NOT_LIVE_VERIFIED}` } },
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
