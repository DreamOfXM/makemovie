'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import {
  defaultAutomationGate,
  durationOutOfRange,
  formatDefaults,
  formatDurationRange,
  type AutomationGate,
  type ContentLocale,
} from '@studio/domain'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/error-state'
import { AutomationTierSelector, automationTierLabel } from '@/components/AutomationTierSelector'
import { VoiceEngineStatus } from '@/components/settings/voice-engine-status'
import {
  CalcLine,
  GroupHeader,
  OpenLink,
  PanelNote,
  ReadonlyNote,
  RowField,
  SaveButton,
  Segmented,
  SettingsRow,
  type SegmentOption,
} from '@/components/settings/settings-shell'
import { apiErrorMessage } from '@/lib/api-error'
import { isLiveStoryboard, toProjectFormat, updateEpisode, type Binding, type Connection, type Episode, type Member, type Project } from '@/lib/api'
import { useAsync } from '@/lib/use-async'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'

/**
 * The pipeline owns these three constants; the web bundle is not allowed to
 * import @studio/pipeline, so they are restated here. If the pipeline changes a
 * tier, this table must change with it — the API's shot-duration response is the
 * source of truth for what is actually selectable.
 */
const SHOT_DURATION_TIERS_MS = [10_000, 15_000, 30_000] as const
const PRODUCT_SHOT_CAP_MS = 30_000
const FALLBACK_SHOT_MS = 5_000

/**
 * 节奏契约的起始默认，与 pipeline 的 DEFAULT_SHOT_RHYTHM 同值。web 不能引用
 * @studio/pipeline，改那边必须同步这张表；它不是实测阈值，设置页要如实标出来。
 */
const DEFAULT_RHYTHM = { avgShotMs: 4_500, longTakeMinMs: 8_000, longTakeShareMin: 0.2 } as const
const RHYTHM_BOUNDS = {
  avgSeconds: { min: 1, max: 20 },
  longTakeSeconds: { min: 2, max: 30 },
  sharePercent: { min: 0, max: 100 },
} as const

function parseRhythm(raw: string | null): { avgShotMs: number; longTakeMinMs: number; longTakeShareMin: number } {
  if (!raw) return { ...DEFAULT_RHYTHM }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_RHYTHM }
    const value = parsed as Record<string, unknown>
    const int = (input: unknown, fallback: number) => (typeof input === 'number' && Number.isInteger(input) && input > 0 ? input : fallback)
    const share = value.longTakeShareMin
    return {
      avgShotMs: int(value.avgShotMs, DEFAULT_RHYTHM.avgShotMs),
      longTakeMinMs: int(value.longTakeMinMs, DEFAULT_RHYTHM.longTakeMinMs),
      longTakeShareMin: typeof share === 'number' && share >= 0 && share <= 1 ? share : DEFAULT_RHYTHM.longTakeShareMin,
    }
  } catch {
    return { ...DEFAULT_RHYTHM }
  }
}

interface OrganizationSettings {
  id: string
  name: string
  slug: string
  defaultContentLocale: ContentLocale
}

interface ShotDurationCeiling {
  projectMs: number | null
  modelMs: number | null
  productMs: number
  effectiveMs: number
  selectableMs: number[]
}

interface ShotDurationAssessment {
  minMs: number
  maxMs: number
  ceiling: ShotDurationCeiling
}

interface StylePreset {
  id: string
  name: string
  description: string
}

interface TtsCapability {
  embedded: { installed: boolean; installing: boolean }
  voiceboxOnline: boolean
  recommendation: string
}

const RETRY_TECHNICAL = ['auto2', 'auto1', 'ask'] as const
const RETRY_CONSISTENCY = ['ask', 'auto1', 'auto2'] as const
const RETRY_CREATIVE = ['ask', 'auto1'] as const
type RetryTechnical = typeof RETRY_TECHNICAL[number]
type RetryConsistency = typeof RETRY_CONSISTENCY[number]
type RetryCreative = typeof RETRY_CREATIVE[number]

interface ProjectDraft {
  maxShotDurationMs: number | null
  targetSeconds: string
  maxRetriesPerShot: number
  retryTechnical: RetryTechnical
  retryConsistency: RetryConsistency
  retryCreative: RetryCreative
  audioMode: 'video_native' | 'voice_clone'
  automationGate: AutomationGate
  styleId: string | null
  rhythmAvgSeconds: string
  rhythmLongTakeSeconds: string
  rhythmSharePercent: string
}

const EMPTY_PROJECTS: { orgId: string | null; rows: Project[] } = { orgId: null, rows: [] }
const EMPTY_EPISODES: { projectId: string | null; rows: Episode[] } = { projectId: null, rows: [] }
const EMPTY_DURATION: { projectId: string | null; plan: ShotDurationAssessment | null } = { projectId: null, plan: null }

function fromList<T>(value: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : fallback
}

function defaultsFor(project: Project): ProjectDraft {
  const format = toProjectFormat(project.format)
  const target = project.targetDurationMs ?? formatDefaults[format]?.targetDurationMs ?? 8 * 60_000
  const rhythm = parseRhythm(project.shotRhythm)
  return {
    maxShotDurationMs: project.maxShotDurationMs,
    targetSeconds: String(Math.round(target / 1000)),
    maxRetriesPerShot: project.maxRetriesPerShot ?? 1,
    retryTechnical: fromList(project.retryTechnical, RETRY_TECHNICAL, 'auto2'),
    retryConsistency: fromList(project.retryConsistency, RETRY_CONSISTENCY, 'ask'),
    retryCreative: fromList(project.retryCreative, RETRY_CREATIVE, 'ask'),
    audioMode: project.audioMode ?? 'video_native',
    automationGate: project.automationGate ?? defaultAutomationGate,
    styleId: project.stylePresetId,
    rhythmAvgSeconds: String(rhythm.avgShotMs / 1000),
    rhythmLongTakeSeconds: String(Math.round(rhythm.longTakeMinMs / 1000)),
    rhythmSharePercent: String(Math.round(rhythm.longTakeShareMin * 100)),
  }
}

function rhythmSeconds(value: string, bounds: { min: number; max: number }): number | null {
  const parsed = Number(value)
  // 默认均长是 4.5 秒，必须容得下小数，否则一保存就把阈值悄悄改成 5 秒。
  return Number.isFinite(parsed) && parsed >= bounds.min && parsed <= bounds.max ? parsed : null
}

function rhythmSecondsText(ms: number): string {
  return ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(1)
}

function latestProbe(connection: Connection): string | null {
  const stamps = (connection.capabilities ?? []).map(item => item.lastProbedAt).filter(Boolean) as string[]
  if (stamps.length === 0) return null
  return stamps.reduce((latest, stamp) => (new Date(stamp) > new Date(latest) ? stamp : latest))
}

function connectionProbe(connection: Connection): 'verified' | 'failed' | 'unverified' {
  if (connection.lastError) return 'failed'
  const statuses = (connection.capabilities ?? []).map(item => item.probeStatus)
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('verified')) return 'verified'
  return 'unverified'
}

const PROBE_BADGE: Record<'verified' | 'failed' | 'unverified', 'success' | 'destructive' | 'warning'> = {
  verified: 'success',
  failed: 'destructive',
  unverified: 'warning',
}

export function SettingsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-8 w-52" />
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const { t, locale } = useI18n()
  const { api, organizationId, can } = useSession()
  const { theme } = useTheme()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [mounted, setMounted] = useState(false)
  const [skin, setSkin] = useState('default')

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    const read = () =>
      setSkin(document.documentElement.dataset.skin || window.localStorage.getItem('studio.skin') || 'default')
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin'] })
    return () => observer.disconnect()
  }, [])

  // ----- data -----------------------------------------------------------------

  const loadProjects = useCallback(async () => {
    const rows = await api<Project[]>('/projects')
    return { orgId: organizationId, rows }
  }, [api, organizationId])
  const projectsState = useAsync<{ orgId: string | null; rows: Project[] }>(loadProjects, EMPTY_PROJECTS)

  const organizationState = useAsync<OrganizationSettings | null>(
    useCallback(() => api<OrganizationSettings>('/organization'), [api]),
    null,
  )
  const membersState = useAsync<Member[]>(useCallback(() => api<Member[]>('/members'), [api]), [])
  const connectionsState = useAsync<Connection[]>(
    useCallback(() => api<Connection[]>('/providers/connections'), [api]),
    [],
  )
  const bindingsState = useAsync<Binding[]>(useCallback(() => api<Binding[]>('/bindings'), [api]), [])
  const stylesState = useAsync<StylePreset[]>(
    useCallback(async () => (await api<{ styles: StylePreset[] }>('/styles?limit=200')).styles, [api]),
    [],
  )
  const limitsState = useAsync<{ qcThreshold: number } | null>(
    useCallback(() => api<{ qcThreshold: number }>('/system/limits'), [api]),
    null,
  )
  const ttsState = useAsync<TtsCapability | null>(
    useCallback(() => api<TtsCapability>('/system/tts-capability'), [api]),
    null,
  )

  const projects = projectsState.data.orgId === organizationId ? projectsState.data.rows : []
  const requestedProjectId = searchParams.get('project')
  const project = projects.find(row => row.id === requestedProjectId) ?? projects[0] ?? null
  const projectId = project?.id ?? null

  const loadEpisodes = useCallback(async () => {
    if (!projectId) return { projectId, rows: [] as Episode[] }
    return { projectId, rows: await api<Episode[]>(`/projects/${projectId}/episodes`) }
  }, [api, projectId])
  const episodesState = useAsync<{ projectId: string | null; rows: Episode[] }>(
    projectId ? loadEpisodes : null,
    EMPTY_EPISODES,
  )

  const loadShotDuration = useCallback(async () => {
    if (!projectId) return { projectId, plan: null }
    return { projectId, plan: await api<ShotDurationAssessment>(`/projects/${projectId}/shot-duration`) }
  }, [api, projectId])
  const durationState = useAsync<{ projectId: string | null; plan: ShotDurationAssessment | null }>(
    projectId ? loadShotDuration : null,
    EMPTY_DURATION,
  )

  const episodes = episodesState.data.projectId === projectId ? episodesState.data.rows : []
  const requestedEpisodeId = searchParams.get('episode')
  const episode = [episodes.find(row => row.id === requestedEpisodeId), episodes[0]].find(Boolean) ?? null
  const plan = durationState.data.projectId === projectId ? durationState.data.plan : null
  const liveShots = useMemo(
    () => (episode?.storyboards ?? []).filter(isLiveStoryboard),
    [episode],
  )

  // ----- selection ------------------------------------------------------------

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString())
    let changed = false
    if (project && params.get('project') !== project.id) {
      params.set('project', project.id)
      changed = true
    }
    if (episode && params.get('episode') !== episode.id) {
      params.set('episode', episode.id)
      changed = true
    }
    if (changed) router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }, [episode, pathname, project, router, searchParams])

  function selectProject(nextId: string) {
    router.replace(`${pathname}?project=${nextId}`, { scroll: false })
  }

  function selectEpisode(nextId: string) {
    if (!project) return
    router.replace(`${pathname}?project=${project.id}&episode=${nextId}`, { scroll: false })
  }

  // ----- drafts ---------------------------------------------------------------

  const [draftState, setDraftState] = useState<{ projectId: string; values: ProjectDraft } | null>(null)
  const [episodeTargetState, setEpisodeTargetState] = useState<{ episodeId: string; value: string } | null>(null)
  const previousProject = useRef<string | null>(null)
  useEffect(() => {
    if (previousProject.current !== projectId) {
      previousProject.current = projectId
      setDraftState(null)
    }
  }, [projectId])

  const saved = project ? defaultsFor(project) : null
  const draft = project ? (draftState?.projectId === project.id ? draftState.values : saved!) : null

  function updateDraft(patch: Partial<ProjectDraft>) {
    if (!project || !draft) return
    setDraftState({ projectId: project.id, values: { ...draft, ...patch } })
  }

  const [orgLocaleState, setOrgLocaleState] = useState<{ orgId: string; value: ContentLocale } | null>(null)
  const organization = organizationState.data
  const savedOrgLocale = organization?.defaultContentLocale ?? 'zh'
  const orgLocale = organization && orgLocaleState?.orgId === organization.id ? orgLocaleState.value : savedOrgLocale

  const [savingRow, setSavingRow] = useState<string | null>(null)

  const canUpdateProject = can('project:update') && !project?.isExample
  const canUpdateEpisode = can('episode:write') && !project?.isExample
  const canUpdateOrg = can('org:update')
  const canReadAudit = can('audit:read')

  function applyProjectUpdate(updated: Project) {
    projectsState.mutate(state => ({
      ...state,
      rows: state.rows.map(row => (row.id === updated.id ? { ...row, ...updated } : row)),
    }))
  }

  async function saveProjectRow(row: string, body: Record<string, unknown>, reloadDuration = false) {
    if (!project) return
    setSavingRow(row)
    try {
      const updated = await api<Project>(`/projects/${project.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      applyProjectUpdate(updated)
      toast.success(t('settings.saved'))
      if (reloadDuration) durationState.reload()
    } catch (error) {
      toast.error(t('settingsPage.saveFailed'), { description: apiErrorMessage(error, t) })
    } finally {
      setSavingRow(null)
    }
  }

  async function saveEpisodeTarget() {
    if (!episode || !project) return
    setSavingRow('episode-target')
    try {
      const updated = await updateEpisode(api, episode.id, { targetDurationMs: episodeTargetNumber * 1000 })
      episodesState.mutate(state => ({
        ...state,
        rows: state.rows.map(row => (row.id === updated.id ? { ...row, ...updated } : row)),
      }))
      setEpisodeTargetState(null)
      toast.success(t('settings.saved'))
    } catch (error) {
      toast.error(t('settingsPage.saveFailed'), { description: apiErrorMessage(error, t) })
    } finally {
      setSavingRow(null)
    }
  }

  async function saveStyle() {
    if (!project || !draft) return
    setSavingRow('style')
    try {
      const updated = await api<Project>(`/projects/${project.id}/apply-style`, {
        method: 'POST',
        body: JSON.stringify({ styleId: draft.styleId }),
      })
      applyProjectUpdate(updated)
      toast.success(t('settings.saved'))
    } catch (error) {
      toast.error(t('settingsPage.style.failed'), { description: apiErrorMessage(error, t) })
    } finally {
      setSavingRow(null)
    }
  }

  async function saveOrgLocale() {
    if (!organization) return
    setSavingRow('locale')
    try {
      const updated = await api<OrganizationSettings>('/organization', {
        method: 'PATCH',
        body: JSON.stringify({ defaultContentLocale: orgLocale }),
      })
      organizationState.mutate(current => (current ? { ...current, ...updated } : updated))
      toast.success(t('settings.saved'))
    } catch (error) {
      toast.error(t('settingsPage.saveFailed'), { description: apiErrorMessage(error, t) })
    } finally {
      setSavingRow(null)
    }
  }

  // ----- helpers --------------------------------------------------------------

  const seconds = useCallback(
    (ms: number) => t('settingsPage.span.seconds', { count: Math.round(ms / 1000) }),
    [t],
  )

  const relative = useCallback(
    (iso: string | null) => {
      if (!iso) return t('settingsPage.relative.never')
      const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
      if (minutes < 1) return t('settingsPage.relative.justNow')
      if (minutes < 60) return t('settingsPage.relative.minutes', { count: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('settingsPage.relative.hours', { count: hours })
      return t('settingsPage.relative.days', { count: Math.floor(hours / 24) })
    },
    [t],
  )

  const format = project ? toProjectFormat(project.format) : 'short_drama'
  const targetRange = formatDurationRange[format] ?? formatDurationRange.short_drama
  const savedTargetMs = project
    ? project.targetDurationMs ?? formatDefaults[format]?.targetDurationMs ?? 8 * 60_000
    : 0
  const episodeTargetMs = episode?.targetDurationMs ?? savedTargetMs
  const plannedMs = liveShots.reduce((total, shot) => total + shot.durationMs, 0)
  const ceiling = plan?.ceiling ?? null
  const effectiveCeilingMs =
    ceiling?.effectiveMs ?? (project?.maxShotDurationMs ?? FALLBACK_SHOT_MS)

  const draftProjectMs = draft?.maxShotDurationMs ?? null
  const draftModelMs = ceiling?.modelMs ?? null
  const draftEffectiveMs =
    draftModelMs === null
      ? FALLBACK_SHOT_MS
      : Math.min(draftProjectMs ?? draftModelMs, draftModelMs, PRODUCT_SHOT_CAP_MS)
  const thirtyUnavailable =
    draftProjectMs === 30_000 && draftModelMs !== null && !(ceiling?.selectableMs ?? []).includes(30_000)

  const savedStyle = stylesState.data.find(style => style.id === project?.stylePresetId)?.name
  const voiceEngineReady = Boolean(ttsState.data?.embedded.installed || ttsState.data?.voiceboxOnline)

  const settingsHref = `/settings${searchParams.toString() ? `?${searchParams.toString()}` : ''}`
  const returnTo = encodeURIComponent(settingsHref)
  const connectionCount = connectionsState.data.length
  const admins = membersState.data.filter(member => member.role === 'ADMIN' || member.role === 'OWNER').length
  const workspaceBindings = project
    ? bindingsState.data.filter(binding => binding.projectId === null || binding.projectId === project.id)
    : []
  const bindingSlots = new Set(workspaceBindings.map(binding => binding.slot)).size
  const bindingOverrides = new Set(
    bindingsState.data.filter(binding => binding.projectId === project?.id).map(binding => binding.slot),
  ).size

  const [activeGroup, setActiveGroup] = useState<'space' | 'project' | 'episode'>('space')
  const groupIds = useRef<Record<'space' | 'project' | 'episode', string>>({
    space: 'g-workspace',
    project: 'g-project',
    episode: 'g-episode',
  })

  useEffect(() => {
    function onScroll() {
      let current: 'space' | 'project' | 'episode' = 'space'
      for (const key of ['space', 'project', 'episode'] as const) {
        const element = document.getElementById(groupIds.current[key])
        if (element && element.getBoundingClientRect().top <= 160) current = key
      }
      setActiveGroup(current)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  function jumpTo(group: 'space' | 'project' | 'episode') {
    setActiveGroup(group)
    document.getElementById(groupIds.current[group])?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ----- early states ---------------------------------------------------------

  if (projectsState.loading && projects.length === 0) return <SettingsSkeleton />

  if (projectsState.error) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('settingsPage.title')} description={t('settingsPage.subtitle')} />
        <ErrorState message={t('settingsPage.loadError')} onRetry={projectsState.reload} />
      </div>
    )
  }

  const themeLabel = !mounted ? '—' : t(`theme.${theme ?? 'system'}`)
  const skinLabel = mounted ? t(`skin.${skin}`) : '—'
  const languageLabel = t(`locale.${locale}`)

  const targetNumber = draft ? Number(draft.targetSeconds) : NaN
  const targetValid =
    Boolean(draft) &&
    draft!.targetSeconds.trim() !== '' &&
    Number.isInteger(targetNumber) &&
    !durationOutOfRange(format, targetNumber * 1000)
  const targetDirty = Boolean(draft && targetValid && targetNumber * 1000 !== savedTargetMs)

  const episodeTargetDraft =
    episode && episodeTargetState !== null && episodeTargetState.episodeId === episode.id
      ? episodeTargetState.value
      : String(Math.round(episodeTargetMs / 1000))
  const episodeTargetNumber = Number(episodeTargetDraft)
  const episodeTargetValid =
    Boolean(episode) &&
    episodeTargetDraft.trim() !== '' &&
    Number.isInteger(episodeTargetNumber) &&
    !durationOutOfRange(format, episodeTargetNumber * 1000)
  const episodeTargetDirty = Boolean(
    episode && episodeTargetValid && episodeTargetNumber * 1000 !== episodeTargetMs,
  )

  const retryDirty = Boolean(
    draft &&
      saved &&
      (draft.maxRetriesPerShot !== saved.maxRetriesPerShot ||
        draft.retryTechnical !== saved.retryTechnical ||
        draft.retryConsistency !== saved.retryConsistency ||
        draft.retryCreative !== saved.retryCreative),
  )

  const rhythmAvg = draft ? rhythmSeconds(draft.rhythmAvgSeconds, RHYTHM_BOUNDS.avgSeconds) : null
  const rhythmLongTake = draft ? rhythmSeconds(draft.rhythmLongTakeSeconds, RHYTHM_BOUNDS.longTakeSeconds) : null
  const rhythmShare = draft ? rhythmSeconds(draft.rhythmSharePercent, RHYTHM_BOUNDS.sharePercent) : null
  const rhythmValid = rhythmAvg !== null && rhythmLongTake !== null && rhythmShare !== null
  const rhythmDirty = Boolean(
    draft &&
      saved &&
      (draft.rhythmAvgSeconds !== saved.rhythmAvgSeconds ||
        draft.rhythmLongTakeSeconds !== saved.rhythmLongTakeSeconds ||
        draft.rhythmSharePercent !== saved.rhythmSharePercent),
  )

  const durationOptions: SegmentOption<number | null>[] = [
    { value: null, label: t('settingsPage.shotDuration.follow') },
    ...SHOT_DURATION_TIERS_MS.map(tier => ({
      value: tier as number,
      label: seconds(tier),
      disabled: !canvasTierSelectable(tier),
    })),
  ]

  function canvasTierSelectable(tier: number): boolean {
    if (!plan) return false
    if (draft?.maxShotDurationMs === tier) return true
    return (plan.ceiling.selectableMs ?? []).includes(tier)
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('settingsPage.title')} description={t('settingsPage.subtitle')} />

      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <p className="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide uppercase">
            {t('settingsPage.subnav.label')}
          </p>
          <div className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {([
              ['space', 'settingsPage.group.space', 6],
              ['project', 'settingsPage.group.project', 10],
              ['episode', 'settingsPage.group.episode', 3],
            ] as const).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => jumpTo(key)}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-medium whitespace-nowrap transition-colors lg:w-full',
                  activeGroup === key
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent/50',
                )}
              >
                <span className="flex-1">{t(label)}</span>
                <span className="tabular-nums opacity-70">{count}</span>
              </button>
            ))}
          </div>
          <p className="text-muted-foreground mt-3 hidden text-xs leading-relaxed lg:block">
            {t('settingsPage.subnav.tip')}
          </p>
        </aside>

        <div className="min-w-0 space-y-8">
          {/* ===== Workspace defaults ===== */}
          <section className="space-y-2">
            <GroupHeader
              id={groupIds.current.space}
              title={t('settingsPage.group.space')}
              hint={`${t('settingsPage.group.spaceHint')} · ${t('settingsPage.group.count', { count: 6 })}`}
            />

            <SettingsRow
              id="connections"
              title={t('settingsPage.connections.title')}
              description={t('settingsPage.connections.desc')}
              scope="space"
              status={
                connectionCount > 0 ? (
                  <Badge variant={PROBE_BADGE[connectionsState.data.some(item => connectionProbe(item) === 'failed') ? 'failed' : connectionsState.data.some(item => connectionProbe(item) === 'verified') ? 'verified' : 'unverified']}>
                    {t(
                      `settingsPage.connections.probe.${
                        connectionsState.data.some(item => connectionProbe(item) === 'failed')
                          ? 'failed'
                          : connectionsState.data.some(item => connectionProbe(item) === 'verified')
                            ? 'verified'
                            : 'unverified'
                      }`,
                    )}
                  </Badge>
                ) : undefined
              }
              summary={t('settingsPage.connections.summary', { count: connectionCount })}
            >
              {connectionCount === 0 ? (
                <PanelNote>{t('settingsPage.connections.empty')}</PanelNote>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[420px] text-xs">
                    <thead className="bg-muted/50 text-muted-foreground">
                      <tr>
                        <th className="px-3 py-1.5 text-left font-medium">{t('settingsPage.connections.title')}</th>
                        <th className="px-3 py-1.5 text-left font-medium">{t('settingsPage.connections.provider')}</th>
                        <th className="px-3 py-1.5 text-right font-medium">{t('settingsPage.connections.models')}</th>
                        <th className="px-3 py-1.5 text-right font-medium">{t('settingsPage.connections.lastProbe')}</th>
                        <th className="px-3 py-1.5 text-right font-medium">{t('settingsPage.connections.status')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {connectionsState.data.slice(0, 3).map(connection => {
                        const probe = connectionProbe(connection)
                        return (
                          <tr key={connection.id}>
                            <td className="px-3 py-2 font-medium">{connection.name}</td>
                            <td className="text-muted-foreground px-3 py-2">{connection.provider}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{connection.capabilities?.length ?? 0}</td>
                            <td className="text-muted-foreground px-3 py-2 text-right tabular-nums">
                              {relative(latestProbe(connection))}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <Badge variant={PROBE_BADGE[probe]}>{t(`settingsPage.connections.probe.${probe}`)}</Badge>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {connectionCount > 3 ? (
                <PanelNote>{t('settingsPage.connections.more', { count: connectionCount - 3 })}</PanelNote>
              ) : null}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <OpenLink href={`/models?tab=connections&returnTo=${returnTo}`}>
                  {t('settingsPage.connections.open')}
                </OpenLink>
                <a className="text-primary text-xs hover:underline" href="#bindings">
                  {t('settingsPage.connections.xref')}
                </a>
              </div>
            </SettingsRow>

            <SettingsRow
              id="members"
              title={t('settingsPage.members.title')}
              description={t('settingsPage.members.desc')}
              scope="space"
              summary={t('settingsPage.members.summary', { count: membersState.data.length, admins })}
            >
              <OpenLink href="/members">{t('settingsPage.members.open')}</OpenLink>
            </SettingsRow>

            <SettingsRow
              id="usage"
              title={t('settingsPage.usage.title')}
              description={t('settingsPage.usage.desc')}
              scope="space"
              summary={t('settingsPage.usage.summary')}
            >
              <ReadonlyNote>{t('settingsPage.usage.desc')}</ReadonlyNote>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <OpenLink href="/usage">{t('settingsPage.usage.open')}</OpenLink>
              </div>
            </SettingsRow>

            <SettingsRow
              id="audit"
              title={t('settingsPage.audit.title')}
              description={t('settingsPage.audit.desc')}
              scope="space"
              summary={canReadAudit ? t('settingsPage.audit.open') : t('settingsPage.audit.summary')}
            >
              {canReadAudit ? (
                <OpenLink href="/audit">{t('settingsPage.audit.open')}</OpenLink>
              ) : (
                <ReadonlyNote>{t('settingsPage.audit.restricted')}</ReadonlyNote>
              )}
            </SettingsRow>

            <SettingsRow
              id="locale"
              title={t('settingsPage.locale.title')}
              description={t('settingsPage.locale.desc')}
              scope="space"
              summary={t('settingsPage.locale.summary', {
                language: t(`projects.contentLocale.${savedOrgLocale}`),
              })}
            >
              <RowField label={t('settingsPage.locale.title')}>
                <Segmented<ContentLocale>
                  value={orgLocale}
                  onChange={value => organization && setOrgLocaleState({ orgId: organization.id, value })}
                  disabled={!canUpdateOrg || !organization}
                  label={t('settingsPage.locale.title')}
                  options={[
                    { value: 'zh', label: t('projects.contentLocale.zh') },
                    { value: 'en', label: t('projects.contentLocale.en') },
                  ]}
                />
              </RowField>
              <PanelNote>{t('settingsPage.locale.note')}</PanelNote>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <SaveButton
                  onClick={() => void saveOrgLocale()}
                  dirty={Boolean(organization) && orgLocale !== savedOrgLocale}
                  saving={savingRow === 'locale'}
                  disabled={!canUpdateOrg}
                />
                <a className="text-primary text-xs hover:underline" href="#content-locale">
                  {t('settingsPage.locale.xref')}
                </a>
              </div>
            </SettingsRow>

            <SettingsRow
              id="appearance"
              title={t('settingsPage.appearance.titleFull')}
              description={t('settingsPage.appearance.desc')}
              scope="local"
              status={<Badge variant="muted">{t('settingsPage.badge.readonly')}</Badge>}
              summary={t('settingsPage.appearance.summary', { theme: themeLabel, language: languageLabel })}
            >
              <ReadonlyNote>{t('settingsPage.appearance.readonly')}</ReadonlyNote>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <p className="text-muted-foreground text-[11px]">{t('settingsPage.appearance.theme')}</p>
                  <p className="mt-1 text-sm">{themeLabel}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-[11px]">{t('settingsPage.appearance.skin')}</p>
                  <p className="mt-1 text-sm">{skinLabel}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-[11px]">{t('settingsPage.appearance.language')}</p>
                  <p className="mt-1 text-sm">{languageLabel}</p>
                </div>
              </div>
              <PanelNote>{t('settingsPage.appearance.note')}</PanelNote>
              <a className="text-primary text-xs hover:underline" href="#locale">
                {t('settingsPage.appearance.xref')}
              </a>
            </SettingsRow>
          </section>

          {/* ===== Project overrides ===== */}
          <section className="space-y-2">
            <GroupHeader
              id={groupIds.current.project}
              title={t('settingsPage.group.project')}
              hint={`${project ? t('settingsPage.group.projectHintNamed', { project: project.name }) : t('settingsPage.group.projectHint')} · ${t('settingsPage.group.count', { count: 11 })}`}
              action={
                projects.length > 0 ? (
                  <Select value={project?.id} onValueChange={selectProject}>
                    <SelectTrigger size="sm" className="w-[180px]" aria-label={t('settingsPage.project.label')}>
                      <SelectValue placeholder={t('settingsPage.project.label')} />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map(row => (
                        <SelectItem key={row.id} value={row.id}>
                          {row.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : undefined
              }
            />

            {!project || !draft || !saved ? (
              <div className="rounded-xl border bg-card px-4 py-6 text-center">
                <PanelNote>{t('settingsPage.noProjects')}</PanelNote>
                <div className="mt-3 flex justify-center">
                  <OpenLink href="/projects/new">{t('settingsPage.createProject')}</OpenLink>
                </div>
              </div>
            ) : (
              <>
                {project.isExample ? (
                  <ReadonlyNote>
                    <span className="text-warning-ink">{t('settingsPage.exampleBanner')}</span>
                  </ReadonlyNote>
                ) : !canUpdateProject ? (
                  <ReadonlyNote>{t('settingsPage.roleReadonly')}</ReadonlyNote>
                ) : null}

                <SettingsRow
                  id="shot-duration"
                  title={t('settingsPage.shotDuration.title')}
                  description={t('settingsPage.shotDuration.desc')}
                  scope="project"
                  summary={t('settingsPage.shotDuration.summary', {
                    duration: seconds(plan?.ceiling.effectiveMs ?? project.maxShotDurationMs ?? FALLBACK_SHOT_MS),
                  })}
                >
                  <RowField label={t('settingsPage.shotDuration.title')}>
                    <Segmented<number | null>
                      value={draft.maxShotDurationMs}
                      onChange={value => updateDraft({ maxShotDurationMs: value })}
                      disabled={!canUpdateProject}
                      label={t('settingsPage.shotDuration.title')}
                      options={durationOptions}
                    />
                  </RowField>
                  <CalcLine>
                    {t('settingsPage.shotDuration.calc', {
                      project:
                        draftProjectMs === null
                          ? t('settingsPage.shotDuration.followValue')
                          : seconds(draftProjectMs),
                      model: draftModelMs === null ? t('settingsPage.shotDuration.notDeclared') : seconds(draftModelMs),
                      product: seconds(PRODUCT_SHOT_CAP_MS),
                      effective: seconds(draftEffectiveMs),
                    })}
                  </CalcLine>
                  {thirtyUnavailable ? (
                    <div className="border-warning/40 bg-warning/10 rounded-md border px-3 py-2 text-xs leading-relaxed">
                      <p className="text-warning-ink font-medium">{t('settingsPage.shotDuration.warning')}</p>
                      <ul className="text-muted-foreground mt-1 list-disc space-y-0.5 pl-5">
                        <li>
                          <a className="text-primary hover:underline" href="#bindings">
                            {t('settingsPage.shotDuration.warningBind')}
                          </a>
                        </li>
                        <li>{t('settingsPage.shotDuration.warningSplit')}</li>
                      </ul>
                    </div>
                  ) : null}
                  <PanelNote>{t('settingsPage.shotDuration.desc')}</PanelNote>
                  <SaveButton
                    onClick={() =>
                      void saveProjectRow('shot-duration', { maxShotDurationMs: draft.maxShotDurationMs }, true)
                    }
                    dirty={draft.maxShotDurationMs !== project.maxShotDurationMs}
                    saving={savingRow === 'shot-duration'}
                    disabled={!canUpdateProject}
                  />
                </SettingsRow>

                <SettingsRow
                  id="target"
                  title={t('settingsPage.target.title')}
                  description={t('settingsPage.target.desc')}
                  scope="project"
                  summary={t('settingsPage.target.summary', { duration: seconds(savedTargetMs) })}
                >
                  <RowField label={t('settingsPage.target.seconds')}>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={Math.round(targetRange.minMs / 1000)}
                        max={Math.round(targetRange.maxMs / 1000)}
                        value={draft.targetSeconds}
                        disabled={!canUpdateProject}
                        onChange={event => updateDraft({ targetSeconds: event.target.value })}
                        className="h-9 w-28 tabular-nums"
                        aria-label={t('settingsPage.target.seconds')}
                      />
                      <span className="text-muted-foreground text-xs">{t('settingsPage.target.seconds')}</span>
                    </div>
                  </RowField>
                  <PanelNote>
                    {t('settingsPage.target.range', {
                      min: seconds(targetRange.minMs),
                      max: seconds(targetRange.maxMs),
                    })}
                  </PanelNote>
                  {!targetValid ? <PanelNote>{t('settingsPage.target.invalid')}</PanelNote> : null}
                  {targetValid && plan ? (
                    <CalcLine>
                      {t('settingsPage.target.calc', {
                        ceiling: seconds(plan.ceiling.effectiveMs),
                        shots: Math.max(1, Math.ceil((targetNumber * 1000) / plan.ceiling.effectiveMs)),
                      })}
                    </CalcLine>
                  ) : null}
                  <PanelNote>{t('settingsPage.target.note')}</PanelNote>
                  <SaveButton
                    onClick={() => void saveProjectRow('target', { targetDurationMs: targetNumber * 1000 })}
                    dirty={targetDirty}
                    saving={savingRow === 'target'}
                    disabled={!canUpdateProject || !targetValid}
                  />
                </SettingsRow>

                <SettingsRow
                  id="shot-rhythm"
                  title={t('settingsPage.rhythm.title')}
                  description={t('settingsPage.rhythm.desc')}
                  scope="project"
                  summary={t('settingsPage.rhythm.summary', {
                    avg: t('settingsPage.span.seconds', { count: rhythmSecondsText((rhythmAvg ?? DEFAULT_RHYTHM.avgShotMs / 1000) * 1000) }),
                    long: t('settingsPage.span.seconds', { count: rhythmSecondsText((rhythmLongTake ?? DEFAULT_RHYTHM.longTakeMinMs / 1000) * 1000) }),
                    share: rhythmShare ?? Math.round(DEFAULT_RHYTHM.longTakeShareMin * 100),
                  })}
                >
                  <RowField label={t('settingsPage.rhythm.avg')} hint={t('settingsPage.rhythm.avgHint')}>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        inputMode="decimal"
                        step={0.5}
                        min={RHYTHM_BOUNDS.avgSeconds.min}
                        max={RHYTHM_BOUNDS.avgSeconds.max}
                        value={draft.rhythmAvgSeconds}
                        disabled={!canUpdateProject}
                        onChange={event => updateDraft({ rhythmAvgSeconds: event.target.value })}
                        className="h-9 w-24 tabular-nums"
                        aria-label={t('settingsPage.rhythm.avg')}
                        aria-invalid={rhythmAvg === null}
                      />
                      <span className="text-muted-foreground text-xs">{t('settingsPage.rhythm.secondsUnit')}</span>
                    </div>
                  </RowField>
                  <RowField label={t('settingsPage.rhythm.longTake')} hint={t('settingsPage.rhythm.longTakeHint')}>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={RHYTHM_BOUNDS.longTakeSeconds.min}
                        max={RHYTHM_BOUNDS.longTakeSeconds.max}
                        value={draft.rhythmLongTakeSeconds}
                        disabled={!canUpdateProject}
                        onChange={event => updateDraft({ rhythmLongTakeSeconds: event.target.value })}
                        className="h-9 w-24 tabular-nums"
                        aria-label={t('settingsPage.rhythm.longTake')}
                        aria-invalid={rhythmLongTake === null}
                      />
                      <span className="text-muted-foreground text-xs">{t('settingsPage.rhythm.secondsUnit')}</span>
                    </div>
                  </RowField>
                  <RowField label={t('settingsPage.rhythm.share')} hint={t('settingsPage.rhythm.shareHint')}>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={RHYTHM_BOUNDS.sharePercent.min}
                        max={RHYTHM_BOUNDS.sharePercent.max}
                        value={draft.rhythmSharePercent}
                        disabled={!canUpdateProject}
                        onChange={event => updateDraft({ rhythmSharePercent: event.target.value })}
                        className="h-9 w-24 tabular-nums"
                        aria-label={t('settingsPage.rhythm.share')}
                        aria-invalid={rhythmShare === null}
                      />
                      <span className="text-muted-foreground text-xs">{t('settingsPage.rhythm.shareUnit')}</span>
                    </div>
                  </RowField>
                  {!rhythmValid ? <PanelNote>{t('settingsPage.rhythm.invalid')}</PanelNote> : null}
                  <PanelNote>{t('settingsPage.rhythm.note')}</PanelNote>
                  <SaveButton
                    onClick={() =>
                      void saveProjectRow('shot-rhythm', {
                        shotRhythm: {
                          avgShotMs: Math.round((rhythmAvg ?? 0) * 1000),
                          longTakeMinMs: Math.round((rhythmLongTake ?? 0) * 1000),
                          longTakeShareMin: (rhythmShare ?? 0) / 100,
                        },
                      })
                    }
                    dirty={rhythmDirty}
                    saving={savingRow === 'shot-rhythm'}
                    disabled={!canUpdateProject || !rhythmValid}
                  />
                </SettingsRow>

                <SettingsRow
                  id="retries"
                  title={t('settingsPage.retries.title')}
                  description={t('settingsPage.retries.desc')}
                  scope="project"
                  hideScope
                  status={<Badge variant="warning">{t('settingsPage.badge.spends')}</Badge>}
                  summary={
                    liveShots.length > 0
                      ? t('settingsPage.retries.summaryEpisode', {
                          count: liveShots.length,
                          cap: draft.maxRetriesPerShot,
                          quota: liveShots.length * draft.maxRetriesPerShot,
                        })
                      : t('settingsPage.retries.summary', { count: draft.maxRetriesPerShot })
                  }
                >
                  <ReadonlyNote>{t('settingsPage.retries.scopeNote')}</ReadonlyNote>

                  <RowField label={t('settingsPage.retries.technical')} hint={t('settingsPage.retries.technicalHint')}>
                    <Segmented<RetryTechnical>
                      value={draft.retryTechnical}
                      onChange={value => updateDraft({ retryTechnical: value })}
                      disabled={!canUpdateProject}
                      label={t('settingsPage.retries.technical')}
                      options={[
                        { value: 'auto2', label: t('settingsPage.retries.opt.auto2') },
                        { value: 'auto1', label: t('settingsPage.retries.opt.auto1') },
                        { value: 'ask', label: t('settingsPage.retries.opt.ask') },
                      ]}
                    />
                  </RowField>

                  <RowField label={t('settingsPage.retries.consistency')} hint={t('settingsPage.retries.consistencyHint')}>
                    <Segmented<RetryConsistency>
                      value={draft.retryConsistency}
                      onChange={value => updateDraft({ retryConsistency: value })}
                      disabled={!canUpdateProject}
                      label={t('settingsPage.retries.consistency')}
                      options={[
                        { value: 'ask', label: t('settingsPage.retries.opt.ask') },
                        { value: 'auto1', label: t('settingsPage.retries.opt.auto1ask') },
                        { value: 'auto2', label: t('settingsPage.retries.opt.auto2ask') },
                      ]}
                    />
                  </RowField>

                  <RowField label={t('settingsPage.retries.creative')} hint={t('settingsPage.retries.creativeHint')}>
                    <Segmented<RetryCreative>
                      value={draft.retryCreative}
                      onChange={value => updateDraft({ retryCreative: value })}
                      disabled={!canUpdateProject}
                      label={t('settingsPage.retries.creative')}
                      options={[
                        { value: 'ask', label: t('settingsPage.retries.opt.ask') },
                        { value: 'auto1', label: t('settingsPage.retries.opt.auto1ask') },
                      ]}
                    />
                  </RowField>

                  <RowField label={t('settingsPage.retries.cap')} hint={t('settingsPage.retries.capHint')}>
                    <Segmented<number>
                      value={draft.maxRetriesPerShot}
                      onChange={value => updateDraft({ maxRetriesPerShot: value })}
                      disabled={!canUpdateProject}
                      label={t('settingsPage.retries.cap')}
                      options={[0, 1, 2, 3].map(count => ({
                        value: count,
                        label: t('settingsPage.retries.capOption', { count }),
                      }))}
                    />
                  </RowField>

                  {liveShots.length > 0 ? (
                    <CalcLine>
                      {t('settingsPage.retries.calc', {
                        shots: liveShots.length,
                        count: draft.maxRetriesPerShot,
                        quota: liveShots.length * draft.maxRetriesPerShot,
                      })}
                    </CalcLine>
                  ) : (
                    <PanelNote>{t('settingsPage.retries.noShots')}</PanelNote>
                  )}
                  <PanelNote>{t('settingsPage.retries.note')}</PanelNote>

                  <div className="flex flex-wrap items-center gap-3">
                    <SaveButton
                      onClick={() =>
                        void saveProjectRow('retries', {
                          maxRetriesPerShot: draft.maxRetriesPerShot,
                          retryTechnical: draft.retryTechnical,
                          retryConsistency: draft.retryConsistency,
                          retryCreative: draft.retryCreative,
                        })
                      }
                      dirty={retryDirty}
                      saving={savingRow === 'retries'}
                      disabled={!canUpdateProject}
                    />
                    {episode ? (
                      <a
                        className="text-primary text-xs hover:underline"
                        href={`/projects/${project.id}/episodes/${episode.id}?view=flow#step-media`}
                      >
                        {t('settingsPage.retries.openLog')}
                      </a>
                    ) : null}
                  </div>
                </SettingsRow>

                <SettingsRow
                  id="style"
                  title={t('settingsPage.style.title')}
                  description={t('settingsPage.style.desc')}
                  scope="project"
                  summary={t('settingsPage.style.summary', {
                    style: savedStyle ?? t('settingsPage.style.none'),
                  })}
                >
                  <RowField label={t('settingsPage.style.title')}>
                    <Select
                      value={draft.styleId ?? '__none__'}
                      onValueChange={value => updateDraft({ styleId: value === '__none__' ? null : value })}
                      disabled={!canUpdateProject}
                    >
                      <SelectTrigger className="w-full max-w-sm" aria-label={t('settingsPage.style.title')}>
                        <SelectValue placeholder={t('settingsPage.style.none')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">{t('settingsPage.style.none')}</SelectItem>
                        {stylesState.data.map(style => (
                          <SelectItem key={style.id} value={style.id}>
                            {style.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </RowField>
                  <PanelNote>{t('settingsPage.style.note')}</PanelNote>
                  <SaveButton
                    onClick={() => void saveStyle()}
                    dirty={draft.styleId !== project.stylePresetId}
                    saving={savingRow === 'style'}
                    disabled={!canUpdateProject}
                  />
                </SettingsRow>

                <SettingsRow
                  id="automation"
                  title={t('settingsPage.automation.title')}
                  description={t('settingsPage.automation.desc')}
                  scope="project"
                  summary={t('settingsPage.automation.summary', {
                    gate: automationTierLabel(t, project.automationGate ?? defaultAutomationGate),
                  })}
                >
                  <AutomationTierSelector
                    value={draft.automationGate}
                    onChange={value => updateDraft({ automationGate: value })}
                    disabled={!canUpdateProject}
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <SaveButton
                      onClick={() => void saveProjectRow('automation', { automationGate: draft.automationGate })}
                      dirty={draft.automationGate !== (project.automationGate ?? defaultAutomationGate)}
                      saving={savingRow === 'automation'}
                      disabled={!canUpdateProject}
                    />
                    <a className="text-primary text-xs hover:underline" href="#retries">
                      {t('settingsPage.automation.xref')}
                    </a>
                  </div>
                </SettingsRow>

                <SettingsRow
                  id="audio"
                  title={t('settingsPage.audio.title')}
                  description={t('settingsPage.audio.desc')}
                  scope="project"
                  status={
                    ttsState.data ? (
                      <Badge variant={voiceEngineReady ? 'success' : 'warning'}>
                        {t(voiceEngineReady ? 'settingsPage.audio.engineReady' : 'settingsPage.audio.engineMissing')}
                      </Badge>
                    ) : undefined
                  }
                  summary={t('settingsPage.audio.summary', {
                    mode: t(
                      draft.audioMode === 'voice_clone'
                        ? 'settingsPage.audio.voiceClone'
                        : 'settingsPage.audio.videoNative',
                    ),
                  })}
                >
                  <RowField label={t('settingsPage.audio.title')}>
                    <Segmented<'video_native' | 'voice_clone'>
                      value={draft.audioMode}
                      onChange={value => updateDraft({ audioMode: value })}
                      disabled={!canUpdateProject}
                      label={t('settingsPage.audio.title')}
                      options={[
                        { value: 'video_native', label: t('settingsPage.audio.videoNative') },
                        { value: 'voice_clone', label: t('settingsPage.audio.voiceClone') },
                      ]}
                    />
                  </RowField>
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-[11px]">{t('settingsPage.audio.engine')}</p>
                    <VoiceEngineStatus compact />
                    <PanelNote>{t('settingsPage.audio.engineNote')}</PanelNote>
                  </div>
                  <SaveButton
                    onClick={() => void saveProjectRow('audio', { audioMode: draft.audioMode })}
                    dirty={draft.audioMode !== (project.audioMode ?? 'video_native')}
                    saving={savingRow === 'audio'}
                    disabled={!canUpdateProject}
                  />
                </SettingsRow>

                <SettingsRow
                  id="bindings"
                  title={t('settingsPage.bindings.title')}
                  description={t('settingsPage.bindings.desc')}
                  scope="project"
                  summary={
                    bindingsState.data.length > 0
                      ? t('settingsPage.bindings.summary', { slots: bindingSlots, overrides: bindingOverrides })
                      : '—'
                  }
                >
                  {bindingsState.data.length === 0 ? (
                    <PanelNote>{t('settingsPage.bindings.empty')}</PanelNote>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-3">
                    <OpenLink href={`/models?tab=bindings&project=${project.id}&returnTo=${returnTo}`}>
                      {t('settingsPage.bindings.open')}
                    </OpenLink>
                    <a className="text-primary text-xs hover:underline" href="#connections">
                      {t('settingsPage.bindings.xref')}
                    </a>
                  </div>
                </SettingsRow>

                <SettingsRow
                  id="project-usage"
                  title={t('settingsPage.projectUsage.title')}
                  description={t('settingsPage.projectUsage.desc')}
                  scope="project"
                  summary={t('settingsPage.projectUsage.summary')}
                >
                  <ReadonlyNote>{t('settingsPage.projectUsage.desc')}</ReadonlyNote>
                  <div className="pt-1">
                    <OpenLink href={`/usage?project=${project.id}`}>{t('settingsPage.projectUsage.open')}</OpenLink>
                  </div>
                </SettingsRow>

                <SettingsRow
                  id="content-locale"
                  title={t('settingsPage.contentLocale.title')}
                  description={t('settingsPage.contentLocale.desc')}
                  scope="project"
                  hideScope
                  status={<Badge variant="warning">{t('settingsPage.badge.locked')}</Badge>}
                  summary={t('settingsPage.contentLocale.summary', {
                    language: t(`projects.contentLocale.${project.contentLocale}`),
                  })}
                >
                  <ReadonlyNote>{t('settingsPage.contentLocale.desc')}</ReadonlyNote>
                  <PanelNote>{t('settingsPage.contentLocale.note')}</PanelNote>
                  <a className="text-primary text-xs hover:underline" href="#locale">
                    {t('settingsPage.contentLocale.xref')}
                  </a>
                </SettingsRow>

                <SettingsRow
                  id="qc"
                  title={t('settingsPage.qc.title')}
                  description={t('settingsPage.qc.desc')}
                  scope="project"
                  status={<Badge variant="muted">{t('settingsPage.badge.readonly')}</Badge>}
                  summary={t('settingsPage.qc.summary', {
                    points: limitsState.data ? Math.round(limitsState.data.qcThreshold * 100) : '—',
                  })}
                >
                  <ReadonlyNote>{t('settingsPage.qc.note')}</ReadonlyNote>
                </SettingsRow>
              </>
            )}
          </section>

          {/* ===== This episode ===== */}
          <section className="space-y-2">
            <GroupHeader
              id={groupIds.current.episode}
              title={t('settingsPage.group.episode')}
              hint={`${
                episode
                  ? t('settingsPage.group.episodeHintNamed', {
                      episode: `${t('bookSplit.episodePlain', { number: episode.number })} · ${episode.title}`,
                    })
                  : t('settingsPage.group.episodeHint')
              } · ${t('settingsPage.group.count', { count: 3 })}`}
              action={
                episodes.length > 0 ? (
                  <Select value={episode?.id} onValueChange={selectEpisode}>
                    <SelectTrigger size="sm" className="w-[200px]" aria-label={t('settingsPage.episode.label')}>
                      <SelectValue placeholder={t('settingsPage.episode.label')} />
                    </SelectTrigger>
                    <SelectContent>
                      {episodes.map(row => (
                        <SelectItem key={row.id} value={row.id}>
                          {`${t('bookSplit.episodePlain', { number: row.number })} · ${row.title}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : undefined
              }
            />

            {!project ? (
              <div className="rounded-xl border bg-card px-4 py-6 text-center">
                <PanelNote>{t('settingsPage.noProjects')}</PanelNote>
              </div>
            ) : !episode ? (
              <div className="rounded-xl border bg-card px-4 py-6 text-center">
                <PanelNote>{t('settingsPage.noEpisode')}</PanelNote>
              </div>
            ) : (
              <>
                <SettingsRow
                  id="episode-target"
                  title={t('settingsPage.episodeTarget.title')}
                  description={t('settingsPage.episodeTarget.desc')}
                  scope="episode"
                  summary={t('settingsPage.episodeTarget.summary', { duration: seconds(episodeTargetMs) })}
                >
                  <RowField label={t('settingsPage.episodeTarget.seconds')}>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={Math.round(targetRange.minMs / 1000)}
                        max={Math.round(targetRange.maxMs / 1000)}
                        value={episodeTargetDraft}
                        disabled={!canUpdateEpisode}
                        onChange={event =>
                          setEpisodeTargetState({ episodeId: episode.id, value: event.target.value })
                        }
                        className="h-9 w-28 tabular-nums"
                        aria-label={t('settingsPage.episodeTarget.seconds')}
                      />
                      <span className="text-muted-foreground text-xs">
                        {t('settingsPage.episodeTarget.seconds')}
                      </span>
                    </div>
                  </RowField>
                  <PanelNote>
                    {t('settingsPage.episodeTarget.range', {
                      min: seconds(targetRange.minMs),
                      max: seconds(targetRange.maxMs),
                    })}
                  </PanelNote>
                  {!episodeTargetValid ? (
                    <PanelNote>{t('settingsPage.episodeTarget.invalid')}</PanelNote>
                  ) : null}
                  <PanelNote>{t('settingsPage.episodeTarget.note')}</PanelNote>
                  <SaveButton
                    onClick={() => void saveEpisodeTarget()}
                    dirty={episodeTargetDirty}
                    saving={savingRow === 'episode-target'}
                    disabled={!canUpdateEpisode || !episodeTargetValid}
                  />
                </SettingsRow>

                <SettingsRow
                  id="episode-plan"
                  title={t('settingsPage.episodePlan.title')}
                  description={t('settingsPage.episodePlan.desc')}
                  scope="episode"
                  summary={t('settingsPage.episodePlan.summary', {
                    shots: liveShots.length,
                    duration: seconds(plannedMs),
                  })}
                >
                  {liveShots.length === 0 ? (
                    <PanelNote>{t('settingsPage.episodePlan.empty')}</PanelNote>
                  ) : (
                    <>
                      <CalcLine>
                        {t('settingsPage.episodePlan.calc', {
                          planned: seconds(plannedMs),
                          target: seconds(episodeTargetMs),
                          gap: seconds(Math.max(0, episodeTargetMs - plannedMs)),
                          ceiling: seconds(effectiveCeilingMs),
                        })}
                      </CalcLine>
                      <PanelNote>
                        {episodeTargetMs > plannedMs
                          ? t('settingsPage.episodePlan.gap', {
                              gap: seconds(episodeTargetMs - plannedMs),
                            })
                          : t('settingsPage.episodePlan.noGap')}
                      </PanelNote>
                    </>
                  )}
                  <div className="pt-1">
                    <OpenLink href={`/projects/${project.id}/episodes/${episode.id}?view=flow#step-storyboards`}>
                      {t('settingsPage.episodePlan.open')}
                    </OpenLink>
                  </div>
                </SettingsRow>

                <SettingsRow
                  id="episode-voice"
                  title={t('settingsPage.episodeVoice.title')}
                  description={t('settingsPage.episodeVoice.desc')}
                  scope="episode"
                  summary={t('settingsPage.episodeVoice.summary', {
                    total: liveShots.length,
                    dialogue: liveShots.filter(shot => shot.dialogue.trim().length > 0).length,
                  })}
                >
                  <PanelNote>{t('settingsPage.episodeVoice.note')}</PanelNote>
                  <div className="pt-1">
                    <OpenLink href={`/projects/${project.id}/episodes/${episode.id}`}>
                      {t('settingsPage.episodeVoice.open')}
                    </OpenLink>
                  </div>
                </SettingsRow>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
