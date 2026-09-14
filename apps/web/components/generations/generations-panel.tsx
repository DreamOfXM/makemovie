'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ClapperboardIcon, DownloadIcon, FilmIcon, RefreshCwIcon, SparklesIcon, XCircleIcon } from 'lucide-react'
import {
  artifactHref,
  generationStages,
  type EpisodeComposition,
  type GenerationArtifact,
  type GenerationBatch,
  type GenerationStage,
  type GenerationTask,
  type GenerationsResponse,
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
import { TableSkeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/ui/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorState } from '@/components/error-state'
import { GuardedButton } from '@/components/permission'
import { ArtifactLightbox } from '@/components/artifact-lightbox'

const POLL_INTERVAL_MS = 3000

const EMPTY: GenerationsResponse = { batches: [], composition: null }

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
}

export function GenerationsPanel({ episodeId }: GenerationsPanelProps) {
  const { t } = useI18n()
  const { api, organizationId } = useSession()

  const [stage, setStage] = useState<GenerationStage>('SCRIPT')
  const [triggering, setTriggering] = useState(false)
  const [composing, setComposing] = useState(false)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const loadGenerations = useCallback(
    () =>
      episodeId
        ? api<GenerationsResponse>(`/episodes/${episodeId}/generations`)
        : Promise.resolve<GenerationsResponse>(EMPTY),
    // organizationId is not in the path but scopes the session token behind `api`.
    [api, episodeId, organizationId],
  )
  const generations = useAsync<GenerationsResponse>(loadGenerations, EMPTY)
  const { reload } = generations

  const batches = useMemo(
    () => [...generations.data.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [generations.data],
  )

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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SparklesIcon className="text-muted-foreground size-4" />
          {t('generations.title')}
        </CardTitle>
        <CardDescription>{active ? t('generations.pollHint') : t('generations.subtitle')}</CardDescription>
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
                disabled={composing}
                onClick={() => void compose()}
              >
                <ClapperboardIcon />
                {composing ? t('generations.composing') : t('generations.compose')}
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
        <CardContent className="space-y-4">
          {generations.loading && batches.length === 0 && !generations.data.composition ? (
            <TableSkeleton rows={3} columns={5} />
          ) : batches.length === 0 ? (
            <EmptyState
              icon={<SparklesIcon />}
              title={t('generations.noBatches')}
              description={t('generations.noBatchesHint')}
            />
          ) : (
            batches.map(batch => (
              <BatchCard key={batch.id} batch={batch} cancellingId={cancellingId} onCancel={cancelTask} />
            ))
          )}
          <CompositionCard composition={generations.data.composition} />
        </CardContent>
      )}
    </Card>
  )
}

interface BatchCardProps {
  batch: GenerationBatch
  cancellingId: string | null
  onCancel(task: GenerationTask): Promise<void>
}

function BatchCard({ batch, cancellingId, onCancel }: BatchCardProps) {
  const { t, locale } = useI18n()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary">{translateEnum(t, 'generations.stage', batch.stage)}</Badge>
          <StatusBadge
            status={toneFor(batch.status)}
            label={translateEnum(t, 'generations.status', batch.status)}
          />
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
              <TableCell className="font-medium">{translateEnum(t, 'generations.stage', task.stage)}</TableCell>
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
                {task.qc ? (
                  <span
                    className={cn(
                      'text-xs font-medium tabular-nums',
                      task.qc.score >= 0.7 ? 'text-success' : 'text-destructive',
                    )}
                    title={`${task.qc.kind} · ${task.qc.status}`}
                  >
                    {Math.round(task.qc.score * 100)}%
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
                      <ArtifactPreview key={artifact.id} artifact={artifact} />
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
 * Media elements cannot send the bearer token, so artifacts are fetched with the
 * session header and exposed as revocable blob URLs.
 */
export function useArtifactUrl(downloadUrl: string | null): string | null {
  const { token } = useSession()
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!downloadUrl || !token) return
    let cancelled = false
    let objectUrl: string | null = null
    void (async () => {
      try {
        const response = await fetch(artifactHref(downloadUrl), { headers: { authorization: `Bearer ${token}` } })
        if (!response.ok) return
        const next = URL.createObjectURL(await response.blob())
        if (cancelled) {
          URL.revokeObjectURL(next)
          return
        }
        objectUrl = next
        setUrl(next)
      } catch {
        // A missing preview is not worth interrupting the console over.
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [downloadUrl, token])

  return url
}

export function ArtifactPreview({ artifact }: { artifact: GenerationArtifact }) {
  const { t } = useI18n()
  const href = useArtifactUrl(artifact.downloadUrl)
  const [zoomed, setZoomed] = useState(false)

  if (!href) return <span className="text-muted-foreground text-xs">{t('common.loading')}</span>
  if (artifact.mimeType.startsWith('image/')) {
    return (
      <>
        {/* Previews are blob URLs fetched from the API origin, so next/image cannot optimize them. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={href}
          alt={artifact.id}
          loading="lazy"
          onClick={() => setZoomed(true)}
          className="max-h-24 cursor-zoom-in rounded border"
        />
        {zoomed && <ArtifactLightbox src={href} alt={artifact.id} onClose={() => setZoomed(false)} />}
      </>
    )
  }
  if (artifact.mimeType.startsWith('video/')) {
    return <video src={href} controls preload="metadata" className="max-h-24 rounded border" />
  }
  if (artifact.mimeType.startsWith('audio/')) {
    return <audio src={href} controls preload="metadata" className="h-10 max-w-56" />
  }
  return (
    <a
      href={href}
      download
      className="text-primary inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
    >
      <DownloadIcon className="size-3.5" />
      {t('generations.download')}
    </a>
  )
}

function CompositionCard({ composition }: { composition: EpisodeComposition | null }) {
  const { t } = useI18n()
  const artifact = composition?.artifact ?? null
  const href = useArtifactUrl(artifact?.downloadUrl ?? null)

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <FilmIcon className="text-muted-foreground size-4" />
          {t('generations.composition')}
          {composition && (
            <StatusBadge
              status={toneFor(composition.status)}
              label={translateEnum(t, 'generations.status', composition.status)}
            />
          )}
        </CardTitle>
        {!composition && <CardDescription>{t('generations.compositionNone')}</CardDescription>}
      </CardHeader>
      {artifact && (
        <CardContent className="px-4">
          {href ? (
            <div className="flex flex-wrap items-center gap-3">
              <video src={href} controls preload="metadata" className="max-h-48 rounded border" />
              <a
                href={href}
                download
                className="text-primary inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
              >
                <DownloadIcon className="size-3.5" />
                {t('generations.download')}
              </a>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">{t('common.loading')}</p>
          )}
        </CardContent>
      )}
    </Card>
  )
}
