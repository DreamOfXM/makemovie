'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  CaptionsIcon,
  ClapperboardIcon,
  FilmIcon,
  ImageIcon,
  MicIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SparklesIcon,
  VideoIcon,
  XCircleIcon,
} from 'lucide-react'
import {
  generationStages,
  type EpisodeComposition,
  type GenerationArtifact,
  type GenerationBatch,
  type GenerationStage,
  type GenerationTask,
  type GenerationsResponse,
  type Storyboard,
} from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn, formatDateTime } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton, TableSkeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/ui/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ErrorState } from '@/components/error-state'
import { GuardedButton } from '@/components/permission'
import { ArtifactMedia, useArtifactUrl } from '@/components/generations/artifact-media'

const POLL_INTERVAL_MS = 3000

const EMPTY: GenerationsResponse = { batches: [], composition: null }

/** The three stages that belong to one shot rather than to the whole episode. */
const SHOT_STAGES = ['IMAGE', 'VIDEO', 'AUDIO'] as const
type ShotStage = (typeof SHOT_STAGES)[number]

/** Maps the pipeline's SCREAMING_SNAKE statuses onto the workflow tones StatusBadge already renders. */
const statusTone: Record<string, string> = {
  QUEUED: 'ready',
  PENDING: 'draft',
  RUNNING: 'running',
  SUCCEEDED: 'completed',
  FAILED: 'blocked',
  BLOCKED: 'needs_review',
  CANCELLED: 'cancelled',
}

function toneFor(status: string): string {
  return statusTone[status] ?? status.toLowerCase()
}

interface GenerationsPanelProps {
  episodeId: string | null
  /** Bumped by the workspace's one-click advance so a freshly created batch shows up at once. */
  reloadToken?: number
  /** Live shots, in shot order: the media view is organised around them, not around batches. */
  storyboards: Storyboard[]
}

export function GenerationsPanel({ episodeId, reloadToken = 0, storyboards }: GenerationsPanelProps) {
  const { t } = useI18n()
  const { api, organizationId } = useSession()

  const [stage, setStage] = useState<GenerationStage>('SCRIPT')
  const [triggering, setTriggering] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [composing, setComposing] = useState(false)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [regeneratingShot, setRegeneratingShot] = useState<string | null>(null)

  const loadGenerations = useCallback(
    () =>
      episodeId
        ? api<GenerationsResponse>(`/episodes/${episodeId}/generations`)
        : Promise.resolve<GenerationsResponse>(EMPTY),
    // organizationId is not in the path but scopes the session token behind `api`.
    [api, episodeId, organizationId, reloadToken],
  )
  const generations = useAsync<GenerationsResponse>(loadGenerations, EMPTY)
  const { reload } = generations

  const batches = useMemo(
    () => [...generations.data.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [generations.data],
  )

  // Which shot each task made, keeping the newest attempt per shot and stage. Batches are
  // walked newest first, so a tie stays with the newer batch.
  const shotTasks = useMemo(() => {
    const index = new Map<string, GenerationTask>()
    for (const batch of batches) {
      for (const task of batch.tasks) {
        if (!task.storyboardId || !(SHOT_STAGES as readonly string[]).includes(task.stage)) continue
        const key = `${task.storyboardId}:${task.stage}`
        const current = index.get(key)
        if (!current || task.createdAt > current.createdAt) index.set(key, task)
      }
    }
    return index
  }, [batches])

  const active = useMemo(
    () =>
      generations.data.batches.some(batch =>
        batch.tasks.some(task => task.status === 'QUEUED' || task.status === 'RUNNING'),
      ) || generations.data.composition?.status === 'RUNNING',
    [generations.data],
  )

  // Poll while anything is in flight so the console tracks the pipeline without manual refreshes.
  useEffect(() => {
    if (!episodeId || !active) return
    const timer = setInterval(reload, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [episodeId, active, reload])

  async function trigger() {
    if (!episodeId) return
    setTriggering(true)
    try {
      await api(`/episodes/${episodeId}/generations`, { method: 'POST', body: JSON.stringify({ stage }) })
      toast.success(t('generations.triggered', { stage: translateEnum(t, 'generations.stage', stage) }))
      reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setTriggering(false)
    }
  }

  // Re-runs the selected stage as a new revision after its upstream was edited;
  // the prior batch stays for traceability and the newest one wins on display.
  async function regenerate() {
    if (!episodeId) return
    setRegenerating(true)
    try {
      await api(`/episodes/${episodeId}/generations`, { method: 'POST', body: JSON.stringify({ stage, regenerate: true }) })
      toast.success(t('generations.regenerated', { stage: translateEnum(t, 'generations.stage', stage) }))
      reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setRegenerating(false)
    }
  }

  // One shot, one stage: the cheapest way to redo a bad take without paying for the
  // other shots in the episode again.
  async function regenerateShot(storyboardId: string, shotStage: ShotStage) {
    if (!episodeId) return
    setRegeneratingShot(`${storyboardId}:${shotStage}`)
    try {
      await api(`/episodes/${episodeId}/generations`, {
        method: 'POST',
        body: JSON.stringify({ stage: shotStage, storyboardIds: [storyboardId], regenerate: true }),
      })
      toast.success(t('generations.shotRegenerated', { stage: translateEnum(t, 'generations.stage', shotStage) }))
      reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setRegeneratingShot(null)
    }
  }

  async function compose() {
    if (!episodeId) return
    setComposing(true)
    try {
      await api(`/episodes/${episodeId}/compositions`, { method: 'POST' })
      toast.success(t('generations.composeStarted'))
      reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setComposing(false)
    }
  }

  async function cancelTask(task: GenerationTask) {
    setCancellingId(task.id)
    try {
      await api(`/generations/tasks/${task.id}/cancel`, { method: 'POST' })
      toast.success(t('generations.taskCancelled'))
      reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setCancellingId(null)
    }
  }

  return (
    <>
      <Card id="step-media" className="scroll-mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SparklesIcon className="text-muted-foreground size-4" />
            {t('generations.title')}
          </CardTitle>
          <CardDescription>{active ? t('generations.pollHint') : t('generations.mediaHint')}</CardDescription>
          {episodeId && (
            <CardAction>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={stage} onValueChange={value => setStage(value as GenerationStage)}>
                  <SelectTrigger size="sm" className="w-36" aria-label={t('generations.stage')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {generationStages.map(item => (
                      <SelectItem key={item} value={item}>
                        {translateEnum(t, 'generations.stage', item)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <GuardedButton
                  action="generation:trigger"
                  size="sm"
                  disabled={triggering}
                  onClick={() => void trigger()}
                >
                  <SparklesIcon />
                  {triggering ? t('generations.triggering') : t('generations.trigger')}
                </GuardedButton>
                <GuardedButton
                  action="generation:trigger"
                  size="sm"
                  variant="outline"
                  disabled={regenerating}
                  onClick={() => void regenerate()}
                  title={t('generations.regenerateHint')}
                >
                  <RotateCwIcon />
                  {regenerating ? t('generations.regenerating') : t('generations.regenerate')}
                </GuardedButton>
                <Button variant="outline" size="sm" onClick={reload} disabled={generations.loading}>
                  <RefreshCwIcon className={cn(generations.loading && 'animate-spin')} />
                  {t('common.refresh')}
                </Button>
              </div>
            </CardAction>
          )}
        </CardHeader>

        {!episodeId ? (
          <CardContent>
            <EmptyState icon={<SparklesIcon />} title={t('generations.selectEpisode')} />
          </CardContent>
        ) : generations.error ? (
          <CardContent>
            <ErrorState message={generations.error} onRetry={reload} />
          </CardContent>
        ) : (
          <CardContent>
            {generations.loading && batches.length === 0 ? (
              <TableSkeleton rows={3} columns={5} />
            ) : batches.length === 0 && storyboards.length === 0 ? (
              <EmptyState
                icon={<SparklesIcon />}
                title={t('generations.noBatches')}
                description={t('generations.noBatchesHint')}
              />
            ) : (
              <Tabs defaultValue="clips">
                <TabsList>
                  <TabsTrigger value="clips">{t('generations.tab.clips')}</TabsTrigger>
                  <TabsTrigger value="batches">
                    {t('generations.tab.batches')}
                    <Badge variant="outline" className="text-muted-foreground font-normal">
                      {batches.length}
                    </Badge>
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="clips">
                  <ClipTable
                    storyboards={storyboards}
                    shotTasks={shotTasks}
                    regeneratingShot={regeneratingShot}
                    onRegenerate={shotStage => void regenerateShot(shotStage.storyboardId, shotStage.stage)}
                  />
                </TabsContent>
                <TabsContent value="batches" className="space-y-4">
                  {batches.map(batch => (
                    <BatchCard
                      key={batch.id}
                      batch={batch}
                      storyboards={storyboards}
                      cancellingId={cancellingId}
                      onCancel={cancelTask}
                    />
                  ))}
                </TabsContent>
              </Tabs>
            )}
          </CardContent>
        )}
      </Card>

      <EpisodeTracksCard
        composition={generations.data.composition}
        batches={batches}
        composing={composing}
        onCompose={() => void compose()}
      />
    </>
  )
}

interface ClipTableProps {
  storyboards: Storyboard[]
  shotTasks: Map<string, GenerationTask>
  regeneratingShot: string | null
  onRegenerate(storyboardStage: { storyboardId: string; stage: ShotStage }): void
}

/**
 * One row per live shot. The artifacts a shot won come from the shot itself, which is
 * the only place that knows a superseded take lost; the task behind each cell comes from
 * the batches, which is the only place that knows a take is still running or why it failed.
 */
function ClipTable({ storyboards, shotTasks, regeneratingShot, onRegenerate }: ClipTableProps) {
  const { t } = useI18n()

  if (storyboards.length === 0) {
    return <EmptyState icon={<ClapperboardIcon />} title={t('storyboards.none')} description={t('storyboards.noneHint')} />
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-44">{t('generations.clip')}</TableHead>
          <TableHead>{t('storyboards.firstFrame')}</TableHead>
          <TableHead>{t('storyboards.video')}</TableHead>
          <TableHead>{t('generations.stage.AUDIO')}</TableHead>
          <TableHead className="w-14 text-right">{t('common.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {storyboards.map(storyboard => {
          const silent = storyboard.dialogue.trim() === ''
          return (
            <TableRow key={storyboard.id}>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted-foreground tabular-nums">#{storyboard.number}</span>
                  <span className="font-medium">{storyboard.title}</span>
                  {silent && <Badge variant="outline" className="text-muted-foreground font-normal">{t('generations.silentShot')}</Badge>}
                </div>
                {storyboard.dialogue.trim() !== '' && (
                  <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                    {storyboard.speaker && <span className="font-medium">[{storyboard.speaker}] </span>}
                    {storyboard.dialogue}
                  </p>
                )}
              </TableCell>
              {SHOT_STAGES.map(shotStage => (
                <TableCell key={shotStage}>
                  <ClipCell
                    storyboard={storyboard}
                    shotStage={shotStage}
                    task={shotTasks.get(`${storyboard.id}:${shotStage}`)}
                    silent={silent}
                  />
                </TableCell>
              ))}
              <TableCell className="text-right align-top">
                <div className="flex items-center justify-end gap-1">
                  {SHOT_STAGES.map(shotStage =>
                    shotStage === 'AUDIO' && silent ? null : (
                      <ShotRegenerate
                        key={shotStage}
                        shotStage={shotStage}
                        busy={regeneratingShot === `${storyboard.id}:${shotStage}`}
                        onClick={() => onRegenerate({ storyboardId: storyboard.id, stage: shotStage })}
                      />
                    ),
                  )}
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

interface ClipCellProps {
  storyboard: Storyboard
  shotStage: ShotStage
  task?: GenerationTask
  silent: boolean
}

function ClipCell({ storyboard, shotStage, task, silent }: ClipCellProps) {
  const { t } = useI18n()

  if (shotStage === 'AUDIO' && silent) {
    return <span className="text-muted-foreground text-xs">{t('generations.noLine')}</span>
  }
  const won: GenerationArtifact | null | undefined =
    shotStage === 'IMAGE' ? storyboard.firstFrame : shotStage === 'VIDEO' ? storyboard.video : storyboard.voice
  if (won) return <ArtifactMedia artifact={won} label={`${storyboard.title} · ${t(`generations.stage.${shotStage}`)}`} className="max-h-20" />
  if (!task) return <span className="text-muted-foreground text-xs">{t('generations.notGenerated')}</span>
  if (task.status === 'QUEUED' || task.status === 'RUNNING') {
    return (
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Skeleton className="size-3 rounded-full" />
        {translateEnum(t, 'generations.status', task.status)}
      </span>
    )
  }
  if (task.error) {
    return (
      <span className="text-destructive max-w-36 truncate text-xs" title={task.error}>
        {translateEnum(t, 'generations.status', task.status)}
      </span>
    )
  }
  return (
    <span className="text-muted-foreground text-xs" title={task.id}>
      {translateEnum(t, 'generations.status', task.status)}
    </span>
  )
}

const SHOT_STAGE_ICONS: Record<ShotStage, typeof ImageIcon> = {
  IMAGE: ImageIcon,
  VIDEO: VideoIcon,
  AUDIO: MicIcon,
}

function ShotRegenerate({ shotStage, busy, onClick }: { shotStage: ShotStage; busy: boolean; onClick(): void }) {
  const { t } = useI18n()
  const Icon = SHOT_STAGE_ICONS[shotStage]
  const label = `${t('generations.regenerateShot')} · ${translateEnum(t, 'generations.stage', shotStage)}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <GuardedButton
          action="generation:trigger"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={busy}
          onClick={onClick}
        >
          <Icon className={cn(busy && 'animate-pulse')} />
        </GuardedButton>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

interface BatchCardProps {
  batch: GenerationBatch
  storyboards: Storyboard[]
  cancellingId: string | null
  onCancel(task: GenerationTask): Promise<void>
}

function BatchCard({ batch, storyboards, cancellingId, onCancel }: BatchCardProps) {
  const { t, locale } = useI18n()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary">{translateEnum(t, 'generations.stage', batch.stage)}</Badge>
          <StatusBadge status={toneFor(batch.status)} label={translateEnum(t, 'status', batch.status.toLowerCase())} />
        </CardTitle>
        <CardDescription>
          {t('generations.plannedCount', { count: batch.plannedCount })} · {formatDateTime(batch.createdAt, locale)}
        </CardDescription>
      </CardHeader>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-28">{t('generations.stage')}</TableHead>
            <TableHead className="w-32">{t('common.status')}</TableHead>
            <TableHead className="w-20">{t('generations.attempts')}</TableHead>
            <TableHead>{t('generations.providerModel')}</TableHead>
            <TableHead className="w-24">{t('generations.qcScore')}</TableHead>
            <TableHead className="w-40">{t('generations.error')}</TableHead>
            <TableHead>{t('generations.artifacts')}</TableHead>
            <TableHead className="w-14 text-right">{t('common.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {batch.tasks.map(task => (
            <TableRow key={task.id}>
              <TableCell className="font-medium">
                {translateEnum(t, 'generations.stage', task.stage)}
                {/* A batch row means nothing without the shot it was made for. */}
                {task.storyboardId && (
                  <span className="text-muted-foreground ml-1 font-normal" title={task.storyboardId}>
                    #{storyboardNumber(task.storyboardId, storyboards)}
                  </span>
                )}
              </TableCell>
              <TableCell>
                <StatusBadge
                  status={toneFor(task.status)}
                  label={translateEnum(t, 'generations.status', task.status)}
                />
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">{task.attempts}</TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {task.provider || task.model ? `${task.provider ?? '—'} · ${task.model ?? '—'}` : '—'}
              </TableCell>
              <TableCell>
                {task.qc?.kind === 'visual-audit' && task.qc.score !== null ? (
                  <span
                    className={cn(
                      'text-xs font-medium tabular-nums',
                      task.qc.score >= 0.7 ? 'text-success' : 'text-destructive',
                    )}
                    title={`${task.qc.kind} · ${task.qc.status}`}
                  >
                    {Math.round(task.qc.score * 100)}%
                  </span>
                ) : task.qc ? (
                  <span className="text-muted-foreground text-xs" title={`${task.qc.kind} · ${task.qc.status}`}>
                    {t('generations.qcUnaudited')}
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">—</span>
                )}
              </TableCell>
              <TableCell>
                {task.error ? (
                  <span className="text-destructive block max-w-40 truncate text-xs" title={task.error}>
                    {task.error}
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">—</span>
                )}
              </TableCell>
              <TableCell>
                {task.artifacts.length === 0 ? (
                  <span className="text-muted-foreground text-xs">—</span>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 py-1">
                    {task.artifacts.map(artifact => (
                      <ArtifactMedia key={artifact.id} artifact={artifact} />
                    ))}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-right">
                {task.status === 'QUEUED' && (
                  <GuardedButton
                    action="generation:trigger"
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:text-destructive"
                    aria-label={t('generations.cancelTask')}
                    disabled={cancellingId === task.id}
                    onClick={() => void onCancel(task)}
                  >
                    <XCircleIcon />
                  </GuardedButton>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

/**
 * The episode-level output: one score for the whole episode, the cue sheet cut from the
 * lines that made it into the master, and the master itself. Deliberately kept apart from
 * the shot table — a score is one bed laid under every shot, never a per-shot track.
 */
function EpisodeTracksCard({
  composition,
  batches,
  composing,
  onCompose,
}: {
  composition: EpisodeComposition | null
  batches: GenerationBatch[]
  composing: boolean
  onCompose(): void
}) {
  const { t } = useI18n()
  // Before a compose there is no link to follow, so the newest score the episode bought
  // is what the user should be able to listen to — labelled as not yet mixed in.
  const standingScore = useMemo(() => {
    for (const batch of batches) {
      if (batch.stage !== 'MUSIC') continue
      for (const task of [...batch.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        const artifact = task.artifacts[0]
        if (artifact) return { artifact, mixed: false }
      }
    }
    return null
  }, [batches])

  const score = composition?.score ? { artifact: composition.score, mixed: true } : standingScore
  const subtitle = composition?.subtitle ?? null
  const master = composition?.artifact ?? null

  return (
    <Card id="step-composition" className="scroll-mt-4">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <FilmIcon className="text-muted-foreground size-4" />
          {t('generations.episodeTracks')}
          {composition && (
            <StatusBadge
              status={toneFor(composition.status)}
              label={translateEnum(t, 'status', composition.status.toLowerCase())}
            />
          )}
        </CardTitle>
        <CardDescription>{t('generations.episodeTracksHint')}</CardDescription>
        {composition === null || composition.status !== 'RUNNING' ? (
          <CardAction>
            <GuardedButton action="generation:trigger" size="sm" disabled={composing} onClick={onCompose}>
              <ClapperboardIcon />
              {composing ? t('generations.composing') : t('generations.compose')}
            </GuardedButton>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {!composition && !score ? (
          <p className="text-muted-foreground text-sm">{t('generations.compositionNone')}</p>
        ) : (
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-[7rem_minmax(0,1fr)]">
            <TrackRow label={t('generations.stage.MUSIC')}>
              {score ? (
                <>
                  <ArtifactMedia artifact={score.artifact} label={t('generations.stage.MUSIC')} className="max-w-80" />
                  {!score.mixed && <p className="text-muted-foreground mt-1 text-xs">{t('generations.scoreNotMixed')}</p>}
                </>
              ) : (
                <TrackAbsent>{t('generations.scoreNone')}</TrackAbsent>
              )}
            </TrackRow>
            <TrackRow label={t('generations.stage.SUBTITLE')}>
              {subtitle ? (
                <ArtifactMedia artifact={subtitle} label={t('generations.downloadSubtitle')} />
              ) : (
                <TrackAbsent>
                  <CaptionsIcon className="size-3.5" />
                  {t('generations.subtitleNone')}
                </TrackAbsent>
              )}
            </TrackRow>
            <TrackRow label={t('generations.composition')}>
              {master ? (
                <MasterVideo artifact={master} />
              ) : (
                <TrackAbsent>{t('generations.compositionNone')}</TrackAbsent>
              )}
            </TrackRow>
          </dl>
        )}
      </CardContent>
    </Card>
  )
}

function TrackRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground pt-0.5 text-xs font-medium">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

function TrackAbsent({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">{children}</span>
}

/** The master is the one artifact worth playing at full width; its blob URL also downloads. */
function MasterVideo({ artifact }: { artifact: GenerationArtifact }) {
  const { t } = useI18n()
  const href = useArtifactUrl(artifact.downloadUrl)
  if (!href) return <Skeleton className="h-44 w-full max-w-80 rounded-lg" />
  return (
    <div className="flex flex-wrap items-start gap-3">
      <video src={href} controls preload="metadata" className="max-h-48 rounded border" />
      <a href={href} download className="text-primary inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline">
        {t('generations.download')}
      </a>
    </div>
  )
}

/** Falls back to the raw id when the shot list has not arrived, so a row is never blank. */
function storyboardNumber(id: string, storyboards: Storyboard[]): string {
  return String(storyboards.find(storyboard => storyboard.id === id)?.number ?? id.slice(-4))
}
