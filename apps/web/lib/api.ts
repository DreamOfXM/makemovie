import type { AudioSource, AutomationGate, ContentLocale, FailureKind, GenerationStage, ProjectFormat, Role, WorkflowStatus } from '@studio/domain'

function resolveApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL
  if (configured) return configured
  // The API sits on the same host as the web app, one port over. Deriving it
  // from window.location keeps LAN access working — a teammate opening
  // http://192.168.x.x:3010 must not be sent to their own localhost:4010
  // ("Failed to fetch" on register). An explicit NEXT_PUBLIC_API_URL still
  // wins for custom deployments.
  if (typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)) {
    return `${window.location.protocol}//${window.location.hostname}:4010`
  }
  return 'http://localhost:4010'
}

const apiBase = resolveApiBase()
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
  /** 'custom' marks a row the org added itself; entryId keys its deletion. */
  source?: 'official' | 'custom'
  entryId?: string
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

/** What this org hid from the catalogs, so the UI can offer one-click restore. */
export interface CatalogHiddenInfo {
  providers: Array<{ provider: string; label: string }>
  models: Array<{ provider: string; model: string; displayName: string }>
}

/** 单条模型的时长实测/文档留痕。只有 probe 会下调有效上限，doc/manual 只做标注。 */
export interface DurationEvidence {
  source: 'probe' | 'doc' | 'manual'
  checkedAt: string
  verifiedSeconds?: number
  declaredSeconds?: number
  url?: string
  taskId?: string
  note?: string
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
  /** 厂商声明的能力参数（时长档位等）；手工添加的行可能为 null。 */
  spec: unknown
  durationEvidence: DurationEvidence | null
}

/** PATCH /providers/capabilities/:id/duration-evidence — 实测/文档核对留痕。 */
export function patchDurationEvidence(
  api: ApiClient,
  capabilityId: string,
  evidence: DurationEvidence | null,
): Promise<{ capabilityId: string; durationEvidence: DurationEvidence | null }> {
  return api(`/providers/capabilities/${capabilityId}/duration-evidence`, {
    method: 'PATCH',
    body: JSON.stringify({ durationEvidence: evidence }),
  })
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

/** What one (provider, model) pair has actually done on this org's account. */
export interface CallEvidence {
  ok: number
  failed: number
  lastStatus: 'SUCCEEDED' | 'FAILED'
  lastAt: string
  lastKind: FailureKind
}

/** Keyed by `callEvidenceKey`, i.e. `"<provider>|<model>"`. */
export type CallEvidenceMap = Record<string, CallEvidence>

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

/** One hit of GET /members?email=…: a registered user plus their standing in
 *  this organization — role is null and member false when they are addable. */
export interface MemberSearchHit {
  userId: string
  email: string
  name: string | null
  role: Role | null
  member: boolean
  joinedAt: string | null
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
  /** The project's default style preset for generation. */
  stylePresetId: string | null
  /** 单镜时长上限（毫秒）：10000 / 15000 / 30000；null = 跟随绑定模型。 */
  maxShotDurationMs: number | null
  /** 每镜重抽上限（次数，不含首次，0-3）；null = 默认 1。 */
  maxRetriesPerShot: number | null
  /** 技术失败处置：auto2 / auto1 / ask；null = auto2。 */
  retryTechnical: string | null
  /** 一致性失败处置：ask / auto1 / auto2；null = ask。 */
  retryConsistency: string | null
  /** 创作性失败处置：ask / auto1；null = ask。 */
  retryCreative: string | null
  /** 语音模式（r10）：video_native = 视频自带声音（默认），voice_clone = 用角色绑定音色。 */
  audioMode: 'video_native' | 'voice_clone' | null
  /** 制作档位：auto / beforeSpend / everyStage；null = beforeSpend（引入档位之前的行为）。 */
  automationGate: AutomationGate | null
  /** 分镜节奏契约（JSON 字符串：avgShotMs / longTakeMinMs / longTakeShareMin）；null = 起始默认。 */
  shotRhythm: string | null
  /** 示例作品：只读展示，任何写入入口都必须关掉。 */
  isExample: boolean
  createdAt: string
  updatedAt: string
  /** Episode status summary, carried so the lifecycle bar renders without a drill-down. */
  episodes?: ProjectEpisodeSummary[]
}

/** How far an episode has actually got, tallied server-side over its generation
 *  tasks. Counts shots, not tasks: a re-run replaces a shot's frame rather than
 *  adding a second one. */
export interface EpisodeProgress {
  frames: number
  videos: number
  composed: number
  delivered: number
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
  /** Statuses of this episode's source versions, so lists can flag drafts awaiting review. */
  sourceVersions?: { status: string }[]
  /** Only the project's episode list carries this; a single-episode fetch leaves it undefined. */
  progress?: EpisodeProgress
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

/**
 * 这一镜成片里听到什么。null = 未选，按镜型默认（有台词=只用配音，无台词=只用原声）。
 * 事实源是 @studio/domain 的 AudioSource（与 packages/db 的枚举同名同集），此处只是
 * 前端别名；改名跟着 domain 走。
 */
export type ShotAudioSource = AudioSource

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
  /** 场次归属（r06·A 场景主帧）；null=旧数据。 */
  sceneNumber: number | null
  /** 这一镜的画面要不要模型产出；流程页的生成动作只排 video 镜头。 */
  production: 'video' | 'ui' | 'title-card' | 'composition' | 'screen-recording'
  status: DbWorkflowStatus
  /** Which of this shot's succeeded clips the human pinned; null means the selection gate is still open. */
  selectedVideoArtifactId?: string | null
  /** 人给这一镜选的声音来源；null = 未选，走镜型默认。 */
  audioSource?: ShotAudioSource | null
  /** 这一镜导入的配音（人工素材，不挂在任何生成任务上）。 */
  importedVoice?: GenerationArtifact | null
  /** 这一镜导入的环境音：垫在配音底下的氛围底，与声音来源那一档正交。 */
  importedAmbience?: GenerationArtifact | null
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
  /** Project style preset from birth; the API defaults to 写实风 (realistic). */
  styleId?: string
  /** 制作档位；缺省即 null = 维持现状（beforeSpend）。 */
  automationGate?: AutomationGate
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

/** Rewrites this episode's target only; existing shots keep the length they were planned at. */
export function updateEpisode(api: ApiClient, episodeId: string, input: { targetDurationMs: number }): Promise<Episode> {
  return api<Episode>(`/episodes/${episodeId}`, { method: 'PATCH', body: JSON.stringify(input) })
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
  /** Opening ~120 chars so the matrix shows what the chapter says, not just a number. */
  preview: string
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
  /** Present when more than one file built the book (a folder of chapter files). */
  files?: number
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

/** GET /projects/:id/source/segments/:segmentId — one chapter's full text. */
export interface ProjectSourceSegmentDetail {
  id: string
  index: number
  title: string | null
  marked: boolean
  charCount: number
  content: string
}

export function getProjectSourceSegment(
  api: ApiClient,
  projectId: string,
  segmentId: string,
): Promise<{ segment: ProjectSourceSegmentDetail }> {
  return api<{ segment: ProjectSourceSegmentDetail }>(`/projects/${projectId}/source/segments/${segmentId}`)
}

/** PATCH /projects/:id/source/segments/:segmentId — fix a chapter's text in place. */
export function updateProjectSourceSegment(
  api: ApiClient,
  projectId: string,
  segmentId: string,
  content: string,
): Promise<{ segment: ProjectSourceSegmentDetail }> {
  return api<{ segment: ProjectSourceSegmentDetail }>(`/projects/${projectId}/source/segments/${segmentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  })
}

/** DELETE — drop a junk chapter from the book; later applies never see it. */
export function deleteProjectSourceSegment(api: ApiClient, projectId: string, segmentId: string): Promise<void> {
  return api<void>(`/projects/${projectId}/source/segments/${segmentId}`, { method: 'DELETE' })
}

/** DELETE an episode that is still a shell (text drafts only); refused with
 *  `episodes:notDeletable` once shots, batches, compositions or deliveries exist. */
export function deleteEpisode(api: ApiClient, projectId: string, episodeId: string): Promise<void> {
  return api<void>(`/projects/${projectId}/episodes/${episodeId}`, { method: 'DELETE' })
}

/** Multipart upload; `request` leaves the content type to the browser so the boundary is set. */
/** One file keeps in-text chapter detection; several files (a dropped folder)
 *  become one chapter each, ordered by natural filename sort server-side. */
export function uploadProjectSource(api: ApiClient, projectId: string, files: File[]): Promise<UploadProjectSourceResult> {
  const body = new FormData()
  for (const file of files) body.append('file', file)
  return api<UploadProjectSourceResult>(`/projects/${projectId}/source/upload`, { method: 'POST', body })
}

/** The paste door to the same intake — for webviews without a file picker, or text already on the clipboard. */
export function pasteProjectSource(api: ApiClient, projectId: string, content: string): Promise<UploadProjectSourceResult> {
  return api<UploadProjectSourceResult>(`/projects/${projectId}/source`, { method: 'POST', body: JSON.stringify({ content }) })
}

/** One-click presets: budget packs unassigned chapters by target duration,
 *  per_chapter gives each unassigned chapter an episode of its own. Both leave
 *  hand-placed groups untouched. */
export function autoSplitSource(
  api: ApiClient,
  projectId: string,
  mode?: 'budget' | 'per_chapter',
): Promise<{ episodesCreated: number; allocated: number }> {
  return api<{ episodesCreated: number; allocated: number }>(`/projects/${projectId}/source/auto-split`, {
    method: 'POST',
    body: JSON.stringify(mode ? { mode } : {}),
  })
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

// The stage vocabulary is owned by @studio/domain (the pipeline and the console
// share one list); re-exported here so DTO sections below read like the API.
export { generationStages } from '@studio/domain'
export type { GenerationStage } from '@studio/domain'

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
  /** 这份产物是同一对象的第几版;历史栏的「v2」读它,不在前端数列表。 */
  version: number
  width: number | null
  height: number | null
  durationMs: number | null
  downloadUrl: string
  /** 人工导入音频的原始文件名；生成产物为 null。 */
  filename?: string | null
}

/** 候选来源（UX-P04）：生成任务 / 延长操作 / 定向修改操作 / 本机渲染 / 人给的一段片，
 *  版本行如实标注——后两种没有调用履历，报的是「这版是本地做出来的」而不是「第 N 次生成」。 */
export type ShotCandidateOrigin = 'generation' | 'extend' | 'directed_edit' | 'local_render' | 'imported'

/** One succeeded VIDEO version of a shot: the selection gate's raw material. */
export interface ShotVideoCandidate {
  artifactId: string
  /** 产生这条版本的生成任务；延长/定向编辑输出与本机产物都没有任务行，为 null。 */
  taskId: string | null
  origin: ShotCandidateOrigin
  /** 本机画的字卡把卡上的话带回来，供编辑器沿用；其余来源没有这句话，为 null。 */
  cardText?: string | null
  version: number
  mimeType: string
  durationMs: number | null
  createdAt: string
  selected: boolean
  qc: { kind: string; status: string; score: number | null; reasons?: string[] } | null
  /** 这一版停在「等你裁决」上：任务失败但问询还没人答，被问的就是这件产物。
   *  能看能播，但不能直接入片——先收下它（才成为可钦定的成功版本）或重抽。 */
  awaitingDecision?: boolean
}

/** 延长/定向编辑操作的状态行：制作台轮询 shotboard，「延长中/修改中/待确认/失败」由它驱动。 */
export interface ShotOperation {
  id: string
  kind: 'video_extend' | 'video_edit'
  /** QUEUED / RUNNING / BLOCKED(待查询) / FAILED；SUCCEEDED 的结果就是候选本身。 */
  status: string
  error: string | null
  createdAt: string
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
  /** 烧进画面的字幕文本；null = 沿用 dialogue。只有导入音频才会需要改它。 */
  subtitleText: string | null
  speaker: string | null
  sourceExcerpt: string
  continuityIn: string
  continuityOut: string
  /** 分镜表「转场」列：这一镜怎么进（cut/dissolve/fade_in/fade_out/black/flash）。 */
  transition: string
  /** 那一刀的过渡毫秒；硬切恒为 0。 */
  transitionMs: number
  /** 场次归属（r06·A 场景主帧）；null=旧数据。 */
  sceneNumber: number | null
  /** 这一镜怎么产出：video=平台生成，其余=按分镜表的生成方式由人完成。 */
  production: 'video' | 'ui' | 'title-card' | 'composition' | 'screen-recording'
  status: string
  assets: { id: string; kind: string; name: string; status: string; role: string; hasVersions: boolean; reference: boolean }[]
  firstFrame: GenerationArtifact | null
  video: GenerationArtifact | null
  voice: GenerationArtifact | null
  firstFrameError: string | null
  videoError: string | null
  inflight: string[]
  /** 在产任务的当前抽数（重抽中=第几抽）。 */
  inflightAttempts: { stage: string; attempt: number }[]
  qc: { kind: string; status: string; score: number | null }[]
  selectedVideoArtifactId: string | null
  /** 首帧/配音的钦定版：null = 自动取最新成功版。 */
  selectedFrameArtifactId: string | null
  selectedVoiceArtifactId: string | null
  audioSource: ShotAudioSource | null
  importedVoice: GenerationArtifact | null
  importedAmbience: GenerationArtifact | null
  /** 剧本「声音」列写的氛围底（文字，null=没写）。平台不生成环境音，它只告诉你该导哪条。 */
  ambience: string | null
  videoCandidates: ShotVideoCandidate[]
  frameCandidates: ShotVideoCandidate[]
  voiceCandidates: ShotVideoCandidate[]
  /** 镜头 CAS 依据（延长 apply_if_unchanged 需要它做 expectedShotRevision）。 */
  stateRevision: number
  /** 延长/定向编辑操作状态（新→旧）：QUEUED/RUNNING/BLOCKED/FAILED。 */
  operations: ShotOperation[]
  usage: { inputUnits: number; outputUnits: number; models: string[]; calls: number } | null
  /** 放映条与预映共用的占位裁决:钦定成片 > 成功片段 > 在产 > 仅分镜图 > 本机制作 > 空。 */
  slot: 'chosen' | 'video' | 'running' | 'frame' | 'local' | 'empty'
  attention: string[]
  /** 分镜文本的逐镜体检结论（代码，人话在 i18n）。刻意不进 attention：它说「写得不够清楚」，挡路的仍是人。 */
  storyboardGaps: string[]
  /** 这件事从什么时候开始是你的：来自产物落地/失败/人推进状态的真时间戳，无从取就为 null。 */
  waitingSince: string | null
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
  assetsPending: { id: string; kind: string; name: string; status: string; hasVersions: boolean; waitingSince: string | null }[]
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
  /** 每次尝试的质检分，最新在前。最后一次不等于最高一次，
   * 「连抽 3 次 · 最高 64 分」这句话只有这个全量列表撑得起。 */
  scores: number[]
  /** Why the winning attempt had to retry: rejected candidates and reference-image
   * degradations kept on the succeeded task. Raw vendor text, never translated. */
  retryTrace: {
    attempt: number | null
    candidateErrors: string[]
    reference: { model: string; conditioned: boolean; reason?: string }[]
  } | null
  /** 三档重抽的「先问」快照：pending = 这个任务停在这里等人决定；
   * retried / waived = 已裁决，保留原因与计数。 */
  review: GenerationReview | null
}

export type GenerationRetryClass = 'technical' | 'consistency' | 'creative'
export type GenerationRetryPolicy = 'ask' | 'auto1' | 'auto2'
/** 停下来的那条原因：策略先问 / 每镜上限用完 / 每集额度用完。 */
export type GenerationAskReason = 'policy' | 'cap' | 'budget'

export interface GenerationReview {
  state: 'pending' | 'retried' | 'waived'
  retryClass: GenerationRetryClass
  /** 触发点：质检器名、segment:N、provider-exhausted。 */
  kind: string
  reasons: string[]
  findings: { dimension: string; message: string; severity?: string; evidenceTimeSeconds?: number | null }[]
  score: number | null
  /** 停下之前本任务跑过的尝试数（含首次）。 */
  attempt: number
  /** 每镜重抽上限（次数，不含首次）。 */
  cap: number
  retriesUsed: number
  budgetLimit: number | null
  budgetUsed: number
  policy: GenerationRetryPolicy
  autoRetries: number
  askReason: GenerationAskReason
  artifactId: string | null
  error: string | null
  createdAt: string
  decidedAt?: string
  decidedBy?: string | null
  waiveReason?: string
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
  /** local = 分镜表写明由人做（字卡/屏幕录制/合成/UI），本次不排平台任务、不计费。 */
  disposition: 'new' | 'retry' | 'skipped' | 'local'
}

/** 一镜的分镜文本体检结论，与镜头卡同一套代码。 */
export interface GenerationPlanShotGap {
  shotNumber: number
  codes: string[]
}

/** 超长镜的一条出路：同镜拼接 / 拆镜（要人改分镜表）/ 换模型。 */
export interface ShotDurationOption {
  strategy: 'splice' | 'split' | 'switch_model'
  available: boolean
  /** 同镜拼接：要生成几段、每段多长。 */
  takeCount?: number
  perTakeMs?: number
  /** 换模型：能覆盖这个意图的那条候选。 */
  capabilityId?: string
  connectionName?: string
  provider?: string
  model?: string
  displayName?: string | null
  maxMs?: number
}

/** 一颗镜头打算跑多久、当前上限多少、超了多少、能怎么走。 */
export interface ShotDurationPreflight {
  storyboardId: string
  number: number
  title: string
  intentMs: number
  ceilingMs: number
  overByMs: number
  options: ShotDurationOption[]
}

/** 触发前需要人拍板的超长镜决议；strategy=split 的镜头本次不生成。 */
export interface ShotDurationDecision {
  storyboardId: string
  strategy: 'splice' | 'split' | 'switch_model'
  capabilityId?: string
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
  /** 本机制作、不花额度的镜头数。 */
  localCount: number
  /** Physical runtime the plan would still produce, null for non-per-shot stages. */
  durationMs: number | null
  /** VIDEO only: promised total, planned total, and the shortfall that needs a human's nod. */
  targetDurationMs: number | null
  plannedDurationMs: number | null
  durationGapMs: number | null
  /** 本次候选链的单镜有效上限（已按实测证据下调）；null = 没有视频候选。 */
  durationCeilingMs: number | null
  /** 分镜意图超过上限的镜头；空数组 = 本批没有要拍板的超长镜。 */
  durationPreflight: ShotDurationPreflight[]
  /** 首帧/视频：本次计划里分镜文本仍缺项的镜头。只提示、不拦路。 */
  storyboardGaps: GenerationPlanShotGap[]
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
  /** 质检线与重试上限由后端下发:界面自己写死一份,worker 一改阈值界面就开始说谎。 */
  limits?: { qcThreshold: number }
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
  /** Tasks that ended FAILED on this provider+model. The ledger never records a failure, so
   * this comes off the task table and counts only what a model is attributable to. */
  failedTaskCount: number
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
  total: { taskCount: number; entryCount: number; retriedTaskCount: number; failedTaskCount: number; inputUnits: number; outputUnits: number }
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
  /** 角色绑定的声音 artifact ID（r10 音频体系）；null = 未绑定。 */
  voiceArtifactId: string | null
  /** 绑定声音的试听信息（未绑定为 null；episode 级列表才带）。 */
  voiceArtifact?: { id: string; downloadUrl: string; mimeType: string; durationMs: number | null; version: number } | null
  /** The generation task that extracted this asset from the script; null means a human created it. */
  generationTaskId: string | null
  /** Live shots binding this asset — the reach of its approval (absent when listed outside an episode). */
  usageCount?: number
  /** 最近一次定妆照任务的实况；null 表示没有待你看的任务（成功只体现为新版本）。 */
  run?: { status: 'QUEUED' | 'RUNNING' | 'FAILED' | 'BLOCKED'; error: string | null; reviewPending?: boolean } | null
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

export interface StoryDraft {
  id: string
  title: string | null
  storyText: string
  recipeKey: string | null
  styleId: string | null
  contentLocale: string | null
  targetDurationMs: number | null
  consumedProjectId: string | null
  updatedAt: string
}

export interface RecipeInfo {
  recipeKey: string
  version: number
  notes: string
  checksum: string
  spec: { aspect: string; targetShotDurationMs: { min: number; max: number }; [key: string]: unknown }
}

export async function listRecipes(token: string | null): Promise<RecipeInfo[]> {
  const data = await request<{ recipes: RecipeInfo[] }>('/recipes', { token })
  return data.recipes
}

export async function saveStoryDraft(token: string | null, values: Partial<Pick<StoryDraft, 'title' | 'storyText' | 'recipeKey' | 'styleId' | 'contentLocale' | 'targetDurationMs'>> & { storyText: string }, draftId?: string): Promise<StoryDraft> {
  const data = draftId === undefined
    ? await request<{ draft: StoryDraft }>('/story-drafts', { token, method: 'POST', body: JSON.stringify(values) })
    : await request<{ draft: StoryDraft }>(`/story-drafts/${draftId}`, { token, method: 'PUT', body: JSON.stringify(values) })
  return data.draft
}

export async function listStoryDrafts(token: string | null): Promise<Array<Pick<StoryDraft, 'id' | 'title' | 'recipeKey' | 'consumedProjectId' | 'updatedAt'>>> {
  const data = await request<{ drafts: Array<Pick<StoryDraft, 'id' | 'title' | 'recipeKey' | 'consumedProjectId' | 'updatedAt'>> }>('/story-drafts', { token })
  return data.drafts
}

export async function createProjectFromStory(token: string | null, draftId: string, format: string): Promise<{ project: Project; idempotentReplay: boolean; firstEpisodeId: string | null }> {
  return request<{ project: Project; idempotentReplay: boolean; firstEpisodeId: string | null }>(`/story-drafts/${draftId}/create-project`, { token, method: 'POST', body: JSON.stringify({ format }) })
}

export interface CreationReadiness {
  recommendationVersion: string
  required: { ready: number; total: number }
  gaps: Array<{ slot: string; required: boolean; autoBindable: boolean }>
  autoBindPlan: { planned: Array<{ slot: string; provider: string; model: string }>; unfulfilled: string[] }
  catalogCoverage: { perSlot: Array<Record<string, unknown>>; minimumConnections: Record<string, unknown> }
  nextStep: 'connect_provider' | 'probe_models' | 'auto_bind' | 'ready'
  canConfigure: boolean
}

export async function fetchCreationReadiness(token: string | null, projectId: string): Promise<CreationReadiness> {
  return request<CreationReadiness>(`/projects/${projectId}/creation-readiness`, { token })
}

export async function autoBindProject(token: string | null, projectId: string): Promise<{ created: string[]; skipped: string[]; unfulfilled: string[] }> {
  return request<{ created: string[]; skipped: string[]; unfulfilled: string[] }>(`/projects/${projectId}/auto-bind`, { token, method: 'POST' })
}

export interface ShotControls {
  framing: string | null
  cameraAngle: string | null
  cameraMovement: string | null
  actionStart: string | null
  actionEnd: string | null
  mood: string | null
  negativePrompt: string | null
}

export interface CreativeControlsResponse {
  storyboardId: string
  stateRevision: number
  controls: ShotControls
}

export async function fetchCreativeControls(token: string | null, storyboardId: string): Promise<CreativeControlsResponse> {
  return request<CreativeControlsResponse>(`/storyboards/${storyboardId}/creative-controls`, { token })
}

export async function patchCreativeControls(token: string | null, storyboardId: string, values: Partial<ShotControls> & { expectedStateRevision: number }): Promise<CreativeControlsResponse> {
  return request<CreativeControlsResponse>(`/storyboards/${storyboardId}/creative-controls`, { token, method: 'PATCH', body: JSON.stringify(values) })
}

export interface SelectionLocks {
  storyboardId: string
  stateRevision: number
  lockedVideoSelection: boolean
  lockedVoiceSelection: boolean
  lockedReferences: boolean
}

export async function patchSelectionLocks(token: string | null, storyboardId: string, values: Partial<Pick<SelectionLocks, 'lockedVideoSelection' | 'lockedVoiceSelection' | 'lockedReferences'>> & { expectedStateRevision: number }): Promise<SelectionLocks> {
  return request<SelectionLocks>(`/storyboards/${storyboardId}/locks`, { token, method: 'PATCH', body: JSON.stringify(values) })
}

export interface EditClip {
  clipId: string
  storyboardId: string
  artifactId: string
  sourceInFrame: number
  sourceOutFrame: number
}

export interface EditTrackElement {
  elementId: string
  sourceArtifactId: string
  anchor: 'clip' | 'sequence'
  clipId?: string
  offsetFrame: number
  gain: number
  muted: boolean
  locked: boolean
}

export interface EditRevision {
  id: string
  revision: number
  fpsNum: number
  fpsDen: number
  clips: EditClip[]
  tracks: EditTrackElement[]
  outputSpec: Record<string, unknown>
  fingerprint: string
  author: string | null
  /** 空壳形状(未初始化)时为 null。 */
  createdAt?: string | null
  editId?: string
}

/** SD-099 读侧素材实况:合成会用到的那条成片及其实测长度。只读——保存时不回传,
 *  不参与指纹,所以素材更新不会让人工剪辑判成过期。 */
export interface EditClipMaterial {
  clipId: string
  /** 镜头序号(界面显示「第 N 镜」用;clip-7 这种内部 id 不上屏)。 */
  shotNumber: number | null
  /** 合成会用的成片 id;'' = 这一格现在没有素材。 */
  artifactId: string
  /** 实测时长(毫秒);null = 没有实测读数。 */
  durationMs: number | null
  /** 本序列帧率下可用帧数,即 sourceOutFrame 的上限;null = 无素材。 */
  maxFrame: number | null
  /** clip 里的引用已解析不回本镜头成片(产物被删/串了镜头)。 */
  unresolved: boolean
}

/** P03 空态契约:0 镜时后端不落库,editId=null/initialized=false(此时 revision 是
 *  空壳形状,只有 fps 默认值可读);有分镜后正常形状多一个 initialized:true。 */
export interface EpisodeEditResponse {
  editId: string | null
  headRevision: number
  initialized?: boolean
  reason?: string
  materials?: EditClipMaterial[]
  revision: EditRevision
}

export async function fetchEpisodeEdit(token: string | null, episodeId: string): Promise<EpisodeEditResponse> {
  return request<EpisodeEditResponse>(`/episodes/${episodeId}/edit`, { token })
}

/** 显式构建默认序列(0 分镜 400;已有人工剪辑 409 state_conflict;已是同指纹 no-op)。 */
export async function buildEpisodeEditDefault(token: string | null, episodeId: string, expectedEditRevision?: number): Promise<{ editId: string; headRevision: number; rebuilt: boolean }> {
  return request<{ editId: string; headRevision: number; rebuilt: boolean }>(`/episodes/${episodeId}/edit/build-default`, {
    token, method: 'POST', body: JSON.stringify(expectedEditRevision !== undefined ? { expectedEditRevision } : {}),
  })
}

export async function saveEpisodeEdit(token: string | null, episodeId: string, body: {
  expectedEditRevision: number
  fps: { fpsNum: number; fpsDen: number }
  clips: EditClip[]
  tracks: EditTrackElement[]
  outputSpec?: Record<string, unknown>
}): Promise<{ editId: string; headRevision: number }> {
  return request<{ editId: string; headRevision: number }>(`/episodes/${episodeId}/edit`, { token, method: 'PUT', body: JSON.stringify(body) })
}

export async function restoreEpisodeEdit(token: string | null, episodeId: string, revision: number): Promise<{ editId: string; headRevision: number; restoredFrom: number }> {
  return request<{ editId: string; headRevision: number; restoredFrom: number }>(`/episodes/${episodeId}/edit/restore`, { token, method: 'POST', body: JSON.stringify({ revision }) })
}
