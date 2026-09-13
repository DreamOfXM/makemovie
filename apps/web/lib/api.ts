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
  constructor(message: string, readonly status: number) {
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
    throw new ApiError(message, response.status)
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

export interface Member {
  userId: string
  email: string
  name: string | null
  role: string
  joinedAt: string
}

export interface Project {
  id: string
  name: string
  status: string
}

export interface Episode {
  id: string
  number: number
  title: string
  status: string
}

export interface Membership {
  organizationId: string
  organizationName: string
  role: string
}

export interface MeResponse {
  user: { id: string; email: string; name: string | null; locale: string }
  organization: { id: string; role: string }
  memberships: Membership[]
}

export const capabilitySlots = [
  'script_text',
  'storyboard_text',
  'image_gen',
  'video_t2v',
  'video_i2v',
  'video_r2v',
  'tts_voice',
  'music_gen',
  'visual_audit',
] as const
