import type { Role, WorkflowStatus } from '@studio/domain'

const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4010'

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
  if (init.body !== undefined && init.body !== null) headers['content-type'] = 'application/json'
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
  defaultBaseUrl: string
  catalogVersion: string
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
  lastProbedAt: string | null
}

export interface Connection {
  id: string
  provider: string
  name: string
  baseUrl: string
  enabled: boolean
  lastError: string | null
  apiKeySet?: boolean
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

export interface Project {
  id: string
  organizationId: string
  name: string
  status: DbWorkflowStatus
  createdAt: string
  updatedAt: string
}

export interface Episode {
  id: string
  projectId: string
  number: number
  title: string
  status: DbWorkflowStatus
  createdAt: string
  updatedAt: string
  storyboards?: Storyboard[]
}

export interface Storyboard {
  id: string
  episodeId: string
  scriptVersionId: string | null
  number: number
  title: string
  durationMs: number
  description: string
  sourceExcerpt: string
  continuityIn: string
  continuityOut: string
  status: DbWorkflowStatus
  firstFrame?: GenerationArtifact | null
  video?: GenerationArtifact | null
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

export const generationStages = ['SCRIPT', 'ASSET', 'STORYBOARD', 'IMAGE', 'VIDEO', 'AUDIO'] as const
export type GenerationStage = (typeof generationStages)[number]

export type GenerationTaskStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'CANCELLED'

export interface GenerationQc {
  kind: string
  score: number
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

export interface GenerationTask {
  id: string
  stage: GenerationStage
  status: GenerationTaskStatus
  attempts: number
  provider: string | null
  model: string | null
  error: string | null
  createdAt: string
  updatedAt: string
  artifacts: GenerationArtifact[]
  qc: GenerationQc | null
}

export interface GenerationBatch {
  id: string
  stage: GenerationStage
  status: string
  plannedCount: number
  createdAt: string
  tasks: GenerationTask[]
}

export interface EpisodeComposition {
  id: string
  status: string
  artifact: GenerationArtifact | null
}

export interface GenerationsResponse {
  batches: GenerationBatch[]
  composition: EpisodeComposition | null
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
