'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  BookCheckIcon,
  BookTextIcon,
  CircleAlertIcon,
  FileUpIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
} from 'lucide-react'
import {
  ApiError,
  applyProjectSource,
  createEpisode,
  getProjectSource,
  pasteProjectSource,
  toProjectFormat,
  updateSourceAllocations,
  uploadProjectSource,
  type ApplyProjectSourceResultItem,
  type ProjectSourceResponse,
  type ProjectSourceSegment,
} from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { HelpHint } from '@/components/ui/help-hint'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'

/** Radix Select forbids an empty-string item value, so unassigned gets a sentinel. */
const UNASSIGNED = '__unassigned__'

const EMPTY_MATRIX: ProjectSourceResponse = {
  version: null,
  format: 'SHORT_DRAMA',
  defaults: { targetDurationMs: 8 * 60_000, maxEpisodes: null },
  segments: [],
  episodes: [],
}

interface BookSplitPanelProps {
  projectId: string
  /** Apply and "new episode" both change what the page's episode table shows. */
  onEpisodesChanged?: () => void
}

/**
 * 整本拆集: the project-level whole-book intake. Upload the novel once, the
 * mechanical splitter carves chapters, and each row's dropdown decides which
 * episode that chapter feeds — the allocation is data, this panel is its view.
 */
export function BookSplitPanel({ projectId, onEpisodesChanged }: BookSplitPanelProps) {
  const { t, locale } = useI18n()
  const { api, organizationId } = useSession()
  const { can } = usePermission()
  const fileInput = useRef<HTMLInputElement | null>(null)

  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  // Paste door: file pickers do not exist in every embedding (webviews), and
  // text already on the clipboard should not require a round-trip through a file.
  // Open by default — the file button being dead in those webviews must never
  // hide the working door behind a second click.
  const [pasteOpen, setPasteOpen] = useState(true)
  const [pasteText, setPasteText] = useState('')
  const [pasting, setPasting] = useState(false)
  // Identifies the mutation in flight: 'apply', 'new-episode', `alloc-<segmentId>`.
  const [busy, setBusy] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<{ items: ApplyProjectSourceResultItem[]; pendingSegments: number } | null>(null)
  const [actionError, setActionError] = useState<{ message: string; retry?(): void } | null>(null)

  const loadMatrix = useCallback(
    () => getProjectSource(api, projectId),
    // organizationId scopes the token behind `api`; projectId is the route input.
    [api, projectId, organizationId],
  )
  const matrix = useAsync<ProjectSourceResponse>(loadMatrix, EMPTY_MATRIX)

  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const fmt = useCallback((value: number) => numberFormat.format(value), [numberFormat])

  const format = toProjectFormat(matrix.data.format)
  const isFilm = format === 'film'
  const marked = matrix.data.segments.filter(segment => segment.marked).length
  const unmarkedChars = matrix.data.segments
    .filter(segment => segment.episodeId === null)
    .reduce((total, segment) => total + segment.charCount, 0)
  const allocatedByEpisode = useMemo(() => {
    const counts = new Map<string, number>()
    for (const segment of matrix.data.segments) {
      if (!segment.episodeId) continue
      counts.set(segment.episodeId, (counts.get(segment.episodeId) ?? 0) + segment.charCount)
    }
    return counts
  }, [matrix.data.segments])
  const episodesReceivingContent = allocatedByEpisode.size
  const maxChars = matrix.data.segments.reduce((highest, segment) => Math.max(highest, segment.charCount), 0)
  const nextEpisodeNumber =
    matrix.data.episodes.reduce((highest, episode) => Math.max(highest, episode.number), 0) + 1
  const defaultMinutes = Math.round(matrix.data.defaults.targetDurationMs / 60_000)
  const canAllocate = can('episode:write')

  function friendlyError(error: unknown): string {
    if (error instanceof ApiError) {
      switch (error.message) {
        case 'projectSources:duplicate':
          return t('bookSplit.errorDuplicate')
        case 'projectSources:filmSingleEpisode':
          return t('bookSplit.errorFilmSingle')
        case 'projectSources:episodeNotInProject':
          matrix.reload()
          onEpisodesChanged?.()
          return t('bookSplit.errorEpisodeNotInProject')
        case 'projectSources:segmentNotInLatestVersion':
          matrix.reload()
          return t('bookSplit.errorSegmentStale')
        case 'projectSources:nothingAllocated':
          return t('bookSplit.errorNothingAllocated')
        case 'projectSources:tooLarge':
          return t('bookSplit.errorTooLarge')
        case 'projectSources:empty':
          return t('bookSplit.errorEmpty')
        case 'projectSources:badEncoding':
          return t('bookSplit.errorBadEncoding')
        case 'projectSources:duplicateSegment':
          return t('bookSplit.errorDuplicateSegment')
        case 'episodes:filmLockedToOne':
          return t('bookSplit.errorFilmLocked')
      }
      // Transport-level rejections never carry a projectSources code: the 413 a
      // multipart file hits (4 MB wire cap) would otherwise show as raw English.
      if (error.status === 413) return t('bookSplit.errorTransportTooLarge')
    }
    return error instanceof Error ? error.message : t('error.generic')
  }

  function pickFile() {
    setUploadError(null)
    fileInput.current?.click()
  }

  async function upload(file: File) {
    setUploading(true)
    setUploadError(null)
    setActionError(null)
    try {
      const result = await uploadProjectSource(api, projectId, file)
      toast.success(t('bookSplit.uploadedToast', { version: result.version.version, segments: result.segments }))
      setApplyResult(null)
      matrix.reload()
    } catch (error) {
      setUploadError(friendlyError(error))
    } finally {
      setUploading(false)
    }
  }

  async function uploadPasted() {
    if (!pasteText.trim()) return
    setPasting(true)
    setUploadError(null)
    setActionError(null)
    try {
      const result = await pasteProjectSource(api, projectId, pasteText)
      toast.success(t('bookSplit.uploadedToast', { version: result.version.version, segments: result.segments }))
      setPasteOpen(false)
      setPasteText('')
      setApplyResult(null)
      matrix.reload()
    } catch (error) {
      setUploadError(friendlyError(error))
    } finally {
      setPasting(false)
    }
  }

  async function allocate(segment: ProjectSourceSegment, episodeId: string | null) {
    setBusy(`alloc-${segment.id}`)
    setActionError(null)
    // 当场改一格: the dropdown reflects the pick immediately (optimistic), and
    // the reload below — success or failure — reconciles with server truth.
    matrix.mutate(current => ({
      ...current,
      segments: current.segments.map(item => (item.id === segment.id ? { ...item, episodeId } : item)),
    }))
    try {
      await updateSourceAllocations(api, projectId, [{ segmentId: segment.id, episodeId }])
      // The allocation changed, so the previous apply result no longer describes this map.
      setApplyResult(null)
      matrix.reload()
    } catch (error) {
      // The PATCH failed: reload restores the server's allocation, and the red
      // bar below explains why the dropdown snapped back.
      matrix.reload()
      setActionError({ message: friendlyError(error), retry: () => void allocate(segment, episodeId) })
    } finally {
      setBusy(null)
    }
  }

  async function addEpisode() {
    setBusy('new-episode')
    setActionError(null)
    try {
      const created = await createEpisode(api, projectId, {
        number: nextEpisodeNumber,
        title: t('bookSplit.newEpisodeAutoTitle', { number: nextEpisodeNumber }),
      })
      toast.success(t('projects.episodeCreated', { number: created.number }))
      matrix.reload()
      onEpisodesChanged?.()
    } catch (error) {
      setActionError({ message: friendlyError(error), retry: () => void addEpisode() })
    } finally {
      setBusy(null)
    }
  }

  async function apply() {
    setBusy('apply')
    setActionError(null)
    try {
      const { results, pendingSegments } = await applyProjectSource(api, projectId)
      setApplyResult({ items: results, pendingSegments })
      toast.success(
        t('bookSplit.applyDoneTitle', {
          created: results.filter(item => !item.skipped).length,
          skipped: results.filter(item => item.skipped).length,
        }),
      )
      matrix.reload()
      onEpisodesChanged?.()
    } catch (error) {
      setActionError({ message: friendlyError(error), retry: () => void apply() })
    } finally {
      setBusy(null)
    }
  }

  const loading = matrix.loading && matrix.data.version === null

  return (
    <Card>
      <CardHeader className="border-b [.border-b]:pb-4">
        <CardTitle className="flex items-center gap-2">
          <BookTextIcon className="text-muted-foreground size-4" />
          {t('bookSplit.title')}
        </CardTitle>
        <CardDescription>{t('bookSplit.subtitle')}</CardDescription>
        {matrix.data.version && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={matrix.reload} disabled={matrix.loading}>
              <RefreshCwIcon className={cn(matrix.loading && 'animate-spin')} />
              {t('common.refresh')}
            </Button>
          </CardAction>
        )}
      </CardHeader>

      {matrix.error ? (
        <CardContent>
          <ErrorState message={matrix.error} onRetry={matrix.reload} />
        </CardContent>
      ) : loading ? (
        <CardContent className="px-0">
          <TableSkeleton rows={4} columns={4} />
        </CardContent>
      ) : matrix.data.version === null ? (
        <CardContent>
          <EmptyState
            icon={<BookTextIcon />}
            title={t('bookSplit.emptyTitle')}
            description={
              <span className="inline-flex flex-wrap items-center justify-center gap-1">
                {t('bookSplit.emptyHint')}
                <HelpHint text={t('bookSplit.mechanicalHint')} />
              </span>
            }
            action={
              pasteOpen ? (
                <Button size="sm" variant="outline" disabled={pasting} onClick={() => { setPasteOpen(false); setUploadError(null) }}>
                  {t('bookSplit.pasteCancel')}
                </Button>
              ) : uploading ? (
                <Button size="sm" disabled>
                  <LoaderCircleIcon className="animate-spin" />
                  {t('bookSplit.uploading')}
                </Button>
              ) : (
                <GuardedButton action="project:update" size="sm" onClick={pickFile}>
                  <FileUpIcon />
                  {t('bookSplit.upload')}
                </GuardedButton>
              )
            }
          />
          {!pasteOpen && (
            <div className="mt-2 flex flex-col items-center gap-1">
              <Button size="sm" variant="outline" disabled={uploading} onClick={() => { setPasteOpen(true); setUploadError(null) }}>
                {t('bookSplit.pasteOpen')}
              </Button>
              {/* Embedded webviews cannot open a native file picker at all — the
                  button above "does nothing" there. Naming that on screen saves
                  the user from thinking the product is broken. */}
              <p className="text-muted-foreground max-w-md text-center text-xs">
                {t('bookSplit.pickerHint')}
              </p>
            </div>
          )}
          {pasteOpen && (
            <div className="mt-3 space-y-2">
              <Textarea
                aria-label={t('bookSplit.pasteLabel')}
                placeholder={t('bookSplit.pastePlaceholder')}
                value={pasteText}
                onChange={event => setPasteText(event.target.value)}
                disabled={pasting}
                rows={8}
                className="font-mono text-xs"
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground text-xs">
                  {t('bookSplit.pasteCount', { count: pasteText.length, limit: 1_000_000 })}
                </span>
                {pasting ? (
                  <Button size="sm" disabled>
                    <LoaderCircleIcon className="animate-spin" />
                    {t('bookSplit.uploading')}
                  </Button>
                ) : (
                  <Button size="sm" disabled={!pasteText.trim()} onClick={() => void uploadPasted()}>
                    {t('bookSplit.pasteSubmit')}
                  </Button>
                )}
              </div>
            </div>
          )}
          {uploadError && (
            <Alert variant="destructive" className="mt-3">
              <CircleAlertIcon />
              <AlertDescription className="justify-items-start">
                <p>{uploadError}</p>
                <Button size="sm" variant="outline" disabled={uploading || pasting} onClick={() => (pasteOpen ? setPasteOpen(true) : pickFile())}>
                  {t('common.retry')}
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      ) : (
        <CardContent className="space-y-4">
          {/* Hidden input shared by the empty state and the re-upload button. */}
          <input
            ref={fileInput}
            type="file"
            accept=".txt,.md"
            className="hidden"
            onChange={event => {
              const file = event.target.files?.[0]
              // Reset so picking the same file again re-fires change.
              event.target.value = ''
              if (file) void upload(file)
            }}
          />

          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 text-sm">
            <span>
              <span className="text-muted-foreground">{t('bookSplit.statChars')} </span>
              <span className="font-mono font-semibold">{fmt(matrix.data.version.charCount)}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="text-muted-foreground">
                {t('bookSplit.statSegments')} {fmt(matrix.data.segments.length)}
              </span>
              <span className="text-muted-foreground text-xs">
                {t('bookSplit.statSegmentsDetail', { marked, unmarked: matrix.data.segments.length - marked })}
              </span>
              <HelpHint text={t('bookSplit.mechanicalHint')} />
            </span>
            <span>
              <span className="text-muted-foreground">{t('bookSplit.statPlanned')} </span>
              <span className="font-mono font-semibold">{fmt(episodesReceivingContent)}</span>
            </span>
            <span className="text-muted-foreground">{t('bookSplit.defaultDuration', { minutes: defaultMinutes })}</span>
            <span className="text-muted-foreground ml-auto flex min-w-0 items-center gap-2 text-xs">
              <span className="min-w-0 truncate">
                v{matrix.data.version.version} · {matrix.data.version.filename}
              </span>
              {uploading ? (
                <Button variant="outline" size="sm" disabled>
                  <LoaderCircleIcon className="animate-spin" />
                  {t('bookSplit.uploading')}
                </Button>
              ) : (
                <GuardedButton action="project:update" variant="outline" size="sm" onClick={pickFile}>
                  <FileUpIcon />
                  {t('bookSplit.reupload')}
                </GuardedButton>
              )}
            </span>
          </div>

          {uploadError && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertDescription className="justify-items-start">
                <p>{uploadError}</p>
                <Button size="sm" variant="outline" disabled={uploading} onClick={pickFile}>
                  {t('common.retry')}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('bookSplit.colChapter')}</TableHead>
                  <TableHead className="w-20 text-right">{t('bookSplit.colChars')}</TableHead>
                  <TableHead className="w-24">{t('bookSplit.colShare')}</TableHead>
                  <TableHead className="w-44">{t('bookSplit.colEpisode')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matrix.data.segments.map(segment => {
                  const rowBusy = busy === `alloc-${segment.id}`
                  return (
                    <TableRow key={segment.id}>
                      <TableCell className="max-w-0">
                        <p className="truncate font-medium">
                          {segment.title ?? (
                            <span className="text-muted-foreground">{t('bookSplit.unmarked')}</span>
                          )}
                        </p>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right font-mono text-xs">
                        {fmt(segment.charCount)}
                      </TableCell>
                      <TableCell>
                        <div className="bg-muted h-1.5 w-full max-w-20 overflow-hidden rounded-full">
                          <div
                            className="bg-primary/60 h-full rounded-full"
                            style={{ width: `${maxChars > 0 ? Math.max(2, (segment.charCount / maxChars) * 100) : 0}%` }}
                          />
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          {rowBusy && <LoaderCircleIcon className="text-muted-foreground size-3.5 shrink-0 animate-spin" />}
                          <Select
                            value={segment.episodeId ?? UNASSIGNED}
                            onValueChange={value => void allocate(segment, value === UNASSIGNED ? null : value)}
                            disabled={!canAllocate || busy !== null}
                          >
                            <SelectTrigger size="sm" aria-label={t('bookSplit.colEpisode')}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNASSIGNED}>{t('bookSplit.unassigned')}</SelectItem>
                              {matrix.data.episodes.map(episode => (
                                <SelectItem key={episode.id} value={episode.id}>
                                  {t('bookSplit.episodeOption', { number: episode.number, title: episode.title })}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-2">
            <p className="text-muted-foreground text-xs font-medium">
              {t('bookSplit.footerTitle')} · {t('bookSplit.unassignedTotal', { chars: fmt(unmarkedChars) })}
            </p>
            {matrix.data.episodes.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t('bookSplit.footerEmpty')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {matrix.data.episodes.map(episode => {
                  const chars = allocatedByEpisode.get(episode.id) ?? 0
                  return (
                    <Badge key={episode.id} variant={chars > 0 ? 'tinted' : 'muted'} className="font-normal">
                      {t('bookSplit.footerChip', { number: episode.number, chars: fmt(chars) })}
                      {episode.title && <span className="text-muted-foreground"> · {episode.title}</span>}
                    </Badge>
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {!isFilm && (
              <GuardedButton
                action="episode:write"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void addEpisode()}
              >
                {busy === 'new-episode' ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}
                {busy === 'new-episode' ? t('common.loading') : t('projects.newEpisode')}
              </GuardedButton>
            )}
            <GuardedButton
              action="episode:write"
              size="sm"
              disabled={busy !== null || episodesReceivingContent === 0}
              onClick={() => void apply()}
            >
              {busy === 'apply' ? <LoaderCircleIcon className="animate-spin" /> : <BookCheckIcon />}
              {busy === 'apply' ? t('bookSplit.applying') : t('bookSplit.apply')}
            </GuardedButton>
            <HelpHint text={t('bookSplit.applyHint')} />
          </div>
          {episodesReceivingContent === 0 && (
            <p className="text-muted-foreground text-right text-xs">{t('bookSplit.applyNeedOne')}</p>
          )}

          {actionError && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertDescription className="justify-items-start">
                <p>{actionError.message}</p>
                {actionError.retry && (
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={actionError.retry}>
                    {t('common.retry')}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          {applyResult && (
            <div className="space-y-1 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm">
              <p className="font-medium">
                {t('bookSplit.applyDoneTitle', {
                  created: applyResult.items.filter(item => !item.skipped).length,
                  skipped: applyResult.items.filter(item => item.skipped).length,
                })}
              </p>
              <p className="text-muted-foreground">
                {applyResult.items
                  .map(item =>
                    t('bookSplit.applyResultItem', { number: item.number, version: item.version ?? '—' }) +
                    (item.skipped ? t('bookSplit.applyResultSkipped') : ''),
                  )
                  .join(' · ')}
              </p>
              {applyResult.pendingSegments > 0 && (
                <p className="text-warning">
                  {t('bookSplit.applyPending', { count: applyResult.pendingSegments })}
                </p>
              )}
              <p className="text-muted-foreground">{t('bookSplit.applyNext')}</p>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}
