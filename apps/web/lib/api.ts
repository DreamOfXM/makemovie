import type { ContentLocale, ProjectFormat, Role, WorkflowStatus } from '@studio/domain'

const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4010'
export const API_BASE = apiBase

export const TOKEN_KEY = 'studio-token'

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return
  if (token) window.localStorage.setItem(TOKEN_KEY, token)
  else window.localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Full error payload, so callers can read extra fields such as `reasons` on a 409. */
    readonly body?: Record<string, unknown> | null,
  ) {
    super(message)
  }
}

export async function request<T>(path: string, options: RequestInit & { token?: string | null } = {}): Promise<T> {
  const { token, ...init } = options
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) || {}),
  }
  // Only string bodies are JSON. A FormData body must keep its boundary, so the
  // browser has to set the multipart content type itself — never set it by hand.
  if (typeof init.body === 'string') headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${apiBase}${path}`, { ...init, headers })
  if (response.status === 204) return undefined as T
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    const message = (data?.error as string) || (data?.message as string) || `HTTP ${response.status}`
    throw new ApiError(message, response.status, data)
  }
  return data as T
}

export interface CatalogModel {
  model: string
  displayName: string
  modality: string
  acceptsFirstFrame?: boolean
  acceptsReferenceImages?: boolean
  maxReferenceImages?: number
  spec?: Record<string, unknown>
}

export interface Catalog {
  provider: string
  label: string
  /** Absent for providers that are a protocol rather than a vendor: the host is the operator's to type. */
  defaultBaseUrl?: string
  catalogVersion: string
  requiresAccessKey?: boolean
  models: CatalogModel[]
}

export interface Capability {
  id: string
  model: string
  displayName: string | null
  modality: string
  acceptsFirstFrame: boolean
  acceptsReferenceImages: boolean
  maxReferenceImages: number
  probeStatus: 'verified' | 'failed' | 'unverified' | string
  probeMessage: string | null
  entitlementVerifiedAt: string | null
  credentialVerifiedAt: string | null
  lastProbedAt: string | null
}

export interface Connection {
  id: string
  provider: string
  name: string
  baseUrl: string
  enabled: boolean
  lastError: string | null
  /** When the connection row last changed — for the banner this names the failed probe's age. */
  updatedAt: string
  apiKeySet?: boolean
  accessKeySet?: boolean
  createdAt: string
  capabilities: Capability[]
}

export interface ProbeResult {
  capabilityId: string
  model: string
  modality: string
  ok: boolean
  status: number
  message?: string
  /** The endpoint answered and denied serving this model — evidence about the row, unlike a timeout. */
  modelMissing?: boolean
}

export interface ProbeResponse {
  connectionId: string
  results: ProbeResult[]
}

export interface Binding {
  id: string
  slot: string
  projectId: string | null
  capabilityId: string
  priority: number
  enabled: boolean
  capability?: Capability & { connection?: { id: string; provider: string; name: string; enabled: boolean } }
}

export interface ResolvedCandidate {
  bindingId: string
  scope: 'project' | 'organization'
  priority: number
  capabilityId: string
  provider: string
  connectionName: string
  model: string
  displayName: string | null
  modality: string
}

export interface ResolveResponse {
  slot: string
  projectId: string | null
  candidates: ResolvedCandidate[]
}

export interface Member {
  userId: string
  email: string
  name: string | null
  role: Role
  joinedAt: string
}

/** Prisma returns the workflow enum SCREAMING_SNAKE; the domain speaks snake_case. */
export type DbWorkflowStatus = Uppercase<WorkflowStatus>

export function toWorkflowStatus(value: string): WorkflowStatus {
  return value.toLowerCase() as WorkflowStatus
}

/** Same bridge as DbWorkflowStatus, for the project format enum. */
export type DbProjectFormat = Uppercase<ProjectFormat>

export function toProjectFormat(value: string): ProjectFormat {
  return value.toLowerCase() as ProjectFormat
}

export interface ProjectEpisodeSummary {
  id: string
  number: number
  title: string
  status: DbWorkflowStatus
}

export interface Project {
  id: string
  organizationId: string
  name: string
  status: DbWorkflowStatus
  /** The project's shape (short drama / series / film); fixed at creation. */
  format: DbProjectFormat
  /** The project's own default for its episodes' length; null = the format constant. */
  targetDurationMs: number | null
  /** Language the pipeline writes this project's content in; not the console locale. */
  contentLocale: ContentLocale
  createdAt: string
  updatedAt: string
  /** Episode status summary, carried so the lifecycle bar renders without a drill-down. */
  episodes?: ProjectEpisodeSummary[]
}

export interface Episode {
  id: string
  projectId: string
  number: number
  title: string
  status: DbWorkflowStatus
  /** Per-episode duration the pipeline actually reads; seeded from the project's format. */
  targetDurationMs: number | null
  createdAt: string
  updatedAt: string
  storyboards?: Storyboard[]
}

export interface StoryboardAssetLink {
  storyboardId: string
  assetId: string
  role: string
}

export interface StoryboardAssetDto {
  id: string
  kind: string
  name: string
  status: string
  role: string
}

export interface Storyboard {
  id: string
  episodeId: string
  scriptVersionId: string | null
  /** Which breakdown of the episode this shot belongs to. A regenerate writes revision N+1. */
  revision: number
  /** Set once a newer revision replaced this shot. The row survives because its media was paid for. */
  supersededAt: string | null
  /** The generation task that wrote this shot; null means a human authored or edited it by hand. */
  generationTaskId: string | null
  number: number
  title: string
  durationMs: number
  description: string
  /** The line spoken in this shot; an empty string marks a deliberately silent shot. */
  dialogue: string
  /** Label for who speaks, nothing more: no voice is cloned from it and no model is picked by it. */
  speaker: string | null
  sourceExcerpt: string
  continuityIn: string
  continuityOut: string
  status: DbWorkflowStatus
  assets?: StoryboardAssetLink[]
  firstFrame?: GenerationArtifact | null
  video?: GenerationArtifact | null
  voice?: GenerationArtifact | null
  /** 最近一次首帧/视频生成的失败原因;null 表示没有失败记录。 */
  firstFrameError?: string | null
  videoError?: string | null
}

/** Live shots are the current breakdown; superseded ones are readable history, never a count. */
export function isLiveStoryboard(storyboard: Storyboard): boolean {
  return !storyboard.supersededAt
}

/**
 * `includeSuperseded` asks the API for the previous revisions too, so the console can show
 * a shot list's history without a second request or a hand-edited URL.
 */
export function storyboardsPath(episodeId: string, includeSuperseded: boolean): string {
  return `/episodes/${episodeId}/storyboards${includeSuperseded ? '?includeSuperseded=true' : ''}`
}

/* -------------------------------------------------------------------------- */
/* API client functions                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The session-scoped `api` call from useSession(): same signature as `request`,
 * with the bearer token injected and 401s clearing the session. Client helpers
 * below take it so they stay inside that wrapper.
 */
export type ApiClient = <T>(path: string, init?: RequestInit) => Promise<T>

export interface CreateProjectInput {
  name: string
  contentLocale: ContentLocale
  /** Absent keeps the old behaviour: the server defaults to short_drama. */
  format?: ProjectFormat
  /** Custom per-episode default inside the format's range; absent = the format constant. */
  targetDurationMs?: number
}

export function createProject(api: ApiClient, input: CreateProjectInput): Promise<Project> {
  return api<Project>('/projects', { method: 'POST', body: JSON.stringify(input) })
}

export interface ProjectPage {
  projects: Project[]
  /** Id of the last row when more follow; null on the final page. */
  nextCursor: string | null
}

/** Cursor-paginated project list; the bare array endpoint stays for callers that want everything. */
export function listProjectPage(api: ApiClient, limit: number, before?: string): Promise<ProjectPage> {
  const query = new URLSearchParams({ limit: String(limit) })
  if (before) query.set('before', before)
  return api<ProjectPage>(`/projects?${query.toString()}`)
}

export interface CreateEpisodeInput {
  number: number
  title: string
  /** Absent keeps the old behaviour: the server seeds it from the project's format. */
  targetDurationMs?: number
}

export function createEpisode(api: ApiClient, projectId: string, input: CreateEpisodeInput): Promise<Episode> {
  return api<Episode>(`/projects/${projectId}/episodes`, { method: 'POST', body: JSON.stringify(input) })
}

/* -------------------------------------------------------------------------- */
/* Whole-book source (project-level intake)                                    */
/* -------------------------------------------------------------------------- */

/** The latest whole-book upload, content-free: the matrix reads shapes, not words. */
export interface ProjectSourceVersionInfo {
  id: string
  version: number
  filename: string
  charCount: number
  checksum: string
  status: string
}

/** One mechanical chapter segment of the uploaded book, with its current allocation. */
export interface ProjectSourceSegment {
  id: string
  index: number
  /** Null for the unmarked run in front of the first chapter (or the whole book). */
  title: string | null
  marked: boolean
  charCount: number
  /** The episode this segment feeds; null = unassigned. */
  episodeId: string | null
}

/** Episodes the book can be distributed into, trimmed to what the matrix needs. */
export interface ProjectSourceEpisode {
  id: string
  number: number
  title: string
  targetDurationMs: number | null
}

/** GET /projects/:id/source — the allocation matrix in one payload. */
export interface ProjectSourceResponse {
  version: ProjectSourceVersionInfo | null
  format: DbProjectFormat
  defaults: { targetDurationMs: number; maxEpisodes: number | null }
  segments: ProjectSourceSegment[]
  episodes: ProjectSourceEpisode[]
}

export interface UploadProjectSourceResult {
  version: ProjectSourceVersionInfo
  segments: number
}

/** One episode's outcome of POST /projects/:id/source/apply. */
export interface ApplyProjectSourceResultItem {
  episodeId: string
  number: number
  /** Null only in pathological states; a skipped episode keeps its latest version. */
  version: number | null
  /** True when the episode's latest source already had this exact content (idempotent re-apply). */
  skipped: boolean
}

/** Multipart upload; `request` leaves the content type to the browser so the boundary is set. */
export function uploadProjectSource(api: ApiClient, projectId: string, file: File): Promise<UploadProjectSourceResult> {
  const body = new FormData()
  body.append('file', file)
  return api<UploadProjectSourceResult>(`/projects/${projectId}/source/upload`, { method: 'POST', body })
}

/** The paste door to the same intake — for webviews without a file picker, or text already on the clipboard. */
export function pasteProjectSource(api: ApiClient, projectId: string, content: string): Promise<UploadProjectSourceResult> {
  return api<UploadProjectSourceResult>(`/projects/${projectId}/source`, { method: 'POST', body: JSON.stringify({ content }) })
}

/** One-click mechanical split: packs chapters into new episodes sized by the target duration. */
export function autoSplitSource(api: ApiClient, projectId: string): Promise<{ episodesCreated: number; allocated: number }> {
  return api<{ episodesCreated: number; allocated: number }>(`/projects/${projectId}/source/auto-split`, { method: 'POST' })
}

export function getProjectSource(api: ApiClient, projectId: string): Promise<ProjectSourceResponse> {
  return api<ProjectSourceResponse>(`/projects/${projectId}/source`)
}

/** One row per segment (a single changed row is fine); the whole map survives a reload. */
export function updateSourceAllocations(
  api: ApiClient,
  projectId: string,
  allocations: Array<{ segmentId: string; episodeId: string | null }>,
): Promise<{ updated: number }> {
  return api<{ updated: number }>(`/projects/${projectId}/source/allocations`, {
    method: 'PATCH',
    body: JSON.stringify({ allocations }),
  })
}

/** Every episode with allocated segments receives a draft source version from its chapters. */
export function applyProjectSource(
  api: ApiClient,
  projectId: string,
): Promise<{ results: ApplyProjectSourceResultItem[]; pendingSegments: number }> {
  return api<{ results: ApplyProjectSourceResultItem[]; pendingSegments: number }>(`/projects/${projectId}/source/apply`, { method: 'POST' })
}

export interface AuditEvent {
  id: string
  action: string
  entityType: string
  entityId: string
  userEmail: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export interface AuditPage {
  events: AuditEvent[]
  nextCursor: string | null
}

export interface Membership {
  organizationId: string
  organizationName: string
  role: Role
}

/* -------------------------------------------------------------------------- */
/* Generation pipeline                                                         */
/* -------------------------------------------------------------------------- */

export const generationStages = ['SCRIPT', 'ASSET', 'STORYBOARD', 'IMAGE', 'VIDEO', 'AUDIO', 'MUSIC'] as const
export type GenerationStage = (typeof generationStages)[number]

export type GenerationTaskStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'CANCELLED'

export interface GenerationQc {
  kind: string
  /** Null when nothing judged the artifact; the console must not render that as a score. */
  score: number | null
  status: string
}

export interface GenerationArtifact {
  id: string
  mimeType: string
  objectKey: string
  width: number | null
  height: number | null
  durationMs: number | null
  downloadUrl: string
}

/** One succeeded VIDEO version of a shot: the selection gate's raw material. */
export interface ShotVideoCandidate {
  artifactId: string
  taskId: string
  version: number
  mimeType: string
  durationMs: number | null
  createdAt: string
  selected: boolean
  qc: { kind: string; status: string; score: number | null } | null
}

/** One live shot as the overview grid reads it: media, verdicts, spend and attention codes. */
export interface ShotboardShot {
  id: string
  number: number
  revision: number
  title: string
  durationMs: number
  description: string
  dialogue: string
  speaker: string | null
  sourceExcerpt: string
  continuityIn: string
  continuityOut: string
  status: string
  assets: { id: string; kind: string; name: string; status: string; role: string; hasVersions: boolean; reference: boolean }[]
  firstFrame: GenerationArtifact | null
  video: GenerationArtifact | null
  voice: GenerationArtifact | null
  firstFrameError: string | null
  videoError: string | null
  inflight: string[]
  qc: { kind: string; status: string; score: number | null }[]
  selectedVideoArtifactId: string | null
  videoCandidates: ShotVideoCandidate[]
  usage: { inputUnits: number; outputUnits: number; models: string[]; calls: number } | null
  /** 放映条与预映共用的占位裁决:钦定成片 > 成功片段 > 在产 > 仅分镜图 > 空。 */
  slot: 'chosen' | 'video' | 'running' | 'frame' | 'empty'
  attention: string[]
}

/** One row of the cast block: the asset's own dossier plus where it appears. */
export interface ShotboardCastAsset {
  id: string
  kind: string
  name: string
  status: string
  hasVersions: boolean
  /** Live shot ids this asset is bound to, in board order. */
  appearances: string[]
  referenceCount: number
  /** The approved costume photo that actually rides along into generation, if any. */
  thumbnail: GenerationArtifact | null
}

export interface ShotboardResponse {
  episodeId: string
  number: number
  title: string
  status: string
  shots: ShotboardShot[]
  assets: ShotboardCastAsset[]
  assetsPending: { id: string; kind: string; name: string; status: string }[]
}

export interface GenerationTask {
  id: string
  stage: GenerationStage
  /** The shot this task made; null for episode-level work such as SCRIPT or the score. */
  storyboardId: string | null
  status: GenerationTaskStatus
  attempts: number
  provider: string | null
  model: string | null
  error: string | null
  createdAt: string
  updatedAt: string
  artifacts: GenerationArtifact[]
  qc: GenerationQc | null
  /** Why the winning attempt had to retry: rejected candidates and reference-image
   * degradations kept on the succeeded task. Raw vendor text, never translated. */
  retryTrace: {
    attempt: number | null
    candidateErrors: string[]
    reference: { model: string; conditioned: boolean; reason?: string }[]
  } | null
}

export interface GenerationBatch {
  id: string
  stage: GenerationStage
  status: string
  plannedCount: number
  createdAt: string
  tasks: GenerationTask[]
}

/** One row of the pre-flight plan: what this stage would do to one target. */
export interface GenerationPlanItem {
  id: string
  label: string
  disposition: 'new' | 'retry' | 'skipped'
}

/** What a batch trigger would spend, read off the same gates the trigger itself applies. */
export interface GenerationPlan {
  stage: GenerationStage
  /** `provider/model`, in the order the worker would try them. */
  models: string[]
  items: GenerationPlanItem[]
  newCount: number
  retryCount: number
  skippedCount: number
  /** Physical runtime the plan would still produce, null for non-per-shot stages. */
  durationMs: number | null
  revision: number
}

export interface EpisodeComposition {
  id: string
  status: string
  artifact: GenerationArtifact | null
  /** Cue sheet for the master, null when the episode has no lines to subtitle. */
  subtitle: GenerationArtifact | null
  /** The music bed actually mixed into this master, null when it went out without one. */
  score: GenerationArtifact | null
}

export interface GenerationsResponse {
  batches: GenerationBatch[]
  composition: EpisodeComposition | null
}

/** One stage × provider × model bucket of the usage ledger. Physical units only:
 * this repository never converts characters and bytes into money. */
export interface UsageRow {
  stage: GenerationStage | null
  provider: string
  model: string
  modality: string
  taskCount: number
  entryCount: number
  retriedTaskCount: number
  inputUnits: number
  outputUnits: number
  binding: { slot: string; connectionId: string; connectionName: string; scope: 'project' | 'organization' } | null
}

export interface UsageProjectRow {
  projectId: string
  projectName: string
  taskCount: number
  entryCount: number
  inputUnits: number
  outputUnits: number
}

export interface UsageReport {
  rows: UsageRow[]
  total: { taskCount: number; entryCount: number; retriedTaskCount: number; inputUnits: number; outputUnits: number }
  /** Space-scope reports only: the totals decomposed per project. */
  byProject?: UsageProjectRow[]
  ungrouped?: { entryCount: number; inputUnits: number; outputUnits: number }
  units: { input: 'prompt_characters'; output: 'bytes' }
}

/**
 * Artifact `downloadUrl` is relative to the API origin (it streams from
 * `GET /artifacts/:id/content`); previews and download links need the absolute
 * URL built with the same base `request()` uses.
 */
export function artifactHref(downloadUrl: string): string {
  if (/^https?:\/\//i.test(downloadUrl)) return downloadUrl
  return `${apiBase}${downloadUrl.startsWith('/') ? '' : '/'}${downloadUrl}`
}

/* -------------------------------------------------------------------------- */
/* Episode assets                                                              */
/* -------------------------------------------------------------------------- */

export interface AssetVersion {
  id: string
  version: number
  description: string
  status: string
  artifact: GenerationArtifact | null
}

export interface Asset {
  id: string
  kind: string
  name: string
  description: string
  status: string
  /** Set when this episode asset is linked to the project-level library (角色中台). */
  projectAssetId: string | null
  /** The generation task that extracted this asset from the script; null means a human created it. */
  generationTaskId: string | null
  /** Live shots binding this asset — the reach of its approval (absent when listed outside an episode). */
  usageCount?: number
  versions: AssetVersion[]
}

export interface AssetsResponse {
  assets: Asset[]
}

export interface MeResponse {
  user: { id: string; email: string; name: string | null; locale: string }
  organization: { id: string; role: Role }
  memberships: Membership[]
}
