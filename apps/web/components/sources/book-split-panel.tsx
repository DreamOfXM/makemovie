'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  BookCheckIcon,
  BookTextIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FileUpIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SplitIcon,
} from 'lucide-react'
import {
  ApiError,
  applyProjectSource,
  autoSplitSource,
  getProjectSource,
  getProjectSourceSegment,
  pasteProjectSource,
  toProjectFormat,
  updateSourceAllocations,
  updateProjectSourceSegment,
  uploadProjectSource,
  type ApplyProjectSourceResultItem,
  type ProjectSourceResponse,
  type ProjectSourceSegment,
  type ProjectSourceSegmentDetail,
} from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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

/** Auto-split names episodes 「第 N 集」; repeating that after a number label adds nothing. */
const AUTO_EPISODE_TITLE = /^第\s*\d+\s*集$/

function episodeDisplayTitle(episode: { number: number; title: string }): string {
  return AUTO_EPISODE_TITLE.test(episode.title.trim()) ? '' : episode.title
}

const TEXT_FILE = /\.(txt|md|zip)$/i

function isChapterFile(file: File): boolean {
  return TEXT_FILE.test(file.name) && !file.name.startsWith('.')
}

/**
 * A dropped folder arrives as directory entries, not as dataTransfer.files —
 * walk it into a flat list of chapter files. The entry list must be captured
 * synchronously (it dies with the event); the walk itself is async.
 */
function collectDroppedFiles(data: DataTransfer): Promise<File[]> {
  const entries = Array.from(data.items ?? [])
    .map(item => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null)
  const fromFiles = Array.from(data.files ?? []).filter(isChapterFile)
  if (entries.length === 0) return Promise.resolve(fromFiles)
  const out: File[] = []
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      await new Promise<void>(resolve => {
        ;(entry as FileSystemFileEntry).file(
          file => {
            if (isChapterFile(file)) out.push(file)
            resolve()
          },
          () => resolve(),
        )
      })
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      const readBatch = () => new Promise<FileSystemEntry[]>(resolve => reader.readEntries(resolve, () => resolve([])))
      let batch = await readBatch()
      while (batch.length > 0) {
        for (const child of batch) await walk(child)
        batch = await readBatch()
      }
    }
  }
  return (async () => {
    for (const entry of entries) await walk(entry)
    return out.length > 0 ? out : fromFiles
  })()
}

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
  // Paste door: the secondary intake. The empty state's primary action is the
  // file upload (the common path); pasting is one outline click away for
  // environments whose file picker cannot open.
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasting, setPasting] = useState(false)
  // Drop-target highlight: the dashed box must not merely look droppable.
  const [dropping, setDropping] = useState(false)
  // Identifies the mutation in flight: 'apply', 'new-episode', `alloc-<segmentId>`.
  const [busy, setBusy] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<{ items: ApplyProjectSourceResultItem[]; pendingSegments: number } | null>(null)
  const [actionError, setActionError] = useState<{ message: string; retry?(): void } | null>(null)
  // 章节弹窗:整章原文的审阅与编辑。几千字的章节塞不进表格行,也不该塞。
  const [chapterTarget, setChapterTarget] = useState<ProjectSourceSegment | null>(null)

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
        case 'projectSources:badZip':
          return t('bookSplit.errorBadZip')
        case 'projectSources:tooManyFiles':
          return t('bookSplit.errorTooManyFiles')
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

  async function upload(files: File[]) {
    const valid = files.filter(isChapterFile)
    if (valid.length === 0) {
      setUploadError(t('bookSplit.errorNoTextFiles'))
      return
    }
    setUploading(true)
    setUploadError(null)
    setActionError(null)
    try {
      const result = await uploadProjectSource(api, projectId, valid)
      toast.success(
        result.files && result.files > 1
          ? t('bookSplit.uploadedToastFiles', { files: result.files, segments: result.segments })
          : t('bookSplit.uploadedToast', { version: result.version.version, segments: result.segments }),
      )
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


  async function autoSplit() {
    setBusy('auto-split')
    setActionError(null)
    try {
      const result = await autoSplitSource(api, projectId)
      toast.success(t('bookSplit.autoSplitDone', { episodes: result.episodesCreated, chapters: result.allocated }))
      setApplyResult(null)
      matrix.reload()
      onEpisodesChanged?.()
    } catch (error) {
      setActionError({ message: friendlyError(error), retry: () => void autoSplit() })
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
      {/* Hidden file input, mounted unconditionally: it was previously rendered
          only in the has-version branch, which made the empty state's upload
          button call a null ref and do nothing in EVERY browser. */}
      <input
        ref={fileInput}
        type="file"
        accept=".txt,.md,.zip"
        multiple
        className="hidden"
        onChange={event => {
          const picked = Array.from(event.target.files ?? [])
          // Reset so picking the same file again re-fires change.
          event.target.value = ''
          if (picked.length > 0) void upload(picked)
        }}
      />
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
        <CardContent
          className={cn('transition-colors', dropping && 'bg-primary/5 ring-primary/40 -mx-1 rounded-xl ring-2')}
          onDragOver={event => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault()
              setDropping(true)
            }
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={event => {
            event.preventDefault()
            setDropping(false)
            // 文件夹以目录条目抵达,不是 files 列表;条目必须同步取走,遍历可以异步。
            void collectDroppedFiles(event.dataTransfer).then(files => void upload(files))
          }}
        >
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
              uploading ? (
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
          <p className="text-muted-foreground mt-2 text-center text-xs">{t('bookSplit.dropHint')}</p>
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
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-muted-foreground text-xs">
                  {t('bookSplit.pasteCount', { count: pasteText.length, limit: 1_000_000 })}
                </span>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="ghost" disabled={pasting} onClick={() => { setPasteOpen(false); setUploadError(null) }}>
                    {t('bookSplit.pasteCancel')}
                  </Button>
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
                        {/* 点章节名开整章弹窗。向右的箭头=「里面还有内容」,内容在弹窗里展开——
                            之前收起态用向下箭头、展开态转向上,方向和内容出现的位置对不上。 */}
                        <button
                          type="button"
                          className="hover:text-primary flex min-w-0 items-center gap-1 text-left transition-colors"
                          aria-label={`${segment.title ?? t('bookSplit.unmarked')} · ${t('bookSplit.viewChapter')}`}
                          onClick={() => setChapterTarget(segment)}
                        >
                          <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
                          <span className="truncate font-medium">
                            {segment.title ?? <span className="text-muted-foreground">{t('bookSplit.unmarked')}</span>}
                          </span>
                        </button>
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
                                  {episodeDisplayTitle(episode)
                                    ? t('bookSplit.episodeOption', { number: episode.number, title: episodeDisplayTitle(episode) })
                                    : t('bookSplit.episodePlain', { number: episode.number })}
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
                      {episodeDisplayTitle(episode) && <span className="text-muted-foreground"> · {episodeDisplayTitle(episode)}</span>}
                    </Badge>
                  )
                })}
              </div>
            )}
          </div>

          {/* The map's three questions answered in one strip: what happened,
              what now, and that nothing below gets overwritten. */}
          <p className="text-muted-foreground text-xs">
            {t('bookSplit.steps')}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {/* Episode creation moved to the episodes module below: this panel
                creates episodes through auto-split, and a manual "new episode"
                button here only competed with it for attention. */}
            <GuardedButton
              action="episode:write"
              variant="outline"
              size="sm"
              disabled={busy !== null || matrix.data.segments.every(segment => segment.episodeId !== null)}
              onClick={() => void autoSplit()}
            >
              {busy === 'auto-split' ? <LoaderCircleIcon className="animate-spin" /> : <SplitIcon />}
              {t('bookSplit.autoSplit')}
            </GuardedButton>
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
          <p className="text-muted-foreground text-right text-xs">{t('bookSplit.applySafety')}</p>

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
              <p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
                {applyResult.items.map(item => (
                  <span key={item.episodeId} className="inline-flex items-center gap-1">
                    <Link
                      href={`/projects/${projectId}/episodes/${item.episodeId}`}
                      className="text-primary hover:underline"
                    >
                      {t('bookSplit.applyResultItem', { number: item.number, version: item.version ?? '—' })}
                    </Link>
                    {item.skipped && <span className="text-muted-foreground text-xs">{t('bookSplit.applyResultSkipped')}</span>}
                  </span>
                ))}
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
      <ChapterDialog
        projectId={projectId}
        segment={chapterTarget}
        onClose={() => setChapterTarget(null)}
        onSaved={() => matrix.reload()}
      />
    </Card>
  )
}

interface ChapterDialogProps {
  projectId: string
  segment: ProjectSourceSegment | null
  onClose(): void
  /** A saved edit changes charCount, so the matrix re-reads. */
  onSaved(): void
}

/**
 * 整章原文的审阅与编辑。表格行塞不下几千字,行内小窗也看不全——按规范走
 * max-h-[92vh] 弹层:中部滚动、底部操作常驻可达。
 */
function ChapterDialog({ projectId, segment, onClose, onSaved }: ChapterDialogProps) {
  const { t, locale } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const [detail, setDetail] = useState<ProjectSourceSegmentDetail | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!segment) return
    let cancelled = false
    setLoading(true)
    setDetail(null)
    setError(null)
    getProjectSourceSegment(api, projectId, segment.id)
      .then(result => {
        if (cancelled) return
        setDetail(result.segment)
        setDraft(result.segment.content)
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('error.generic'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, projectId, segment, t])

  async function save() {
    if (!segment) return
    setSaving(true)
    setError(null)
    try {
      await updateProjectSourceSegment(api, projectId, segment.id, draft)
      toast.success(t('bookSplit.chapterSaved'))
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    } finally {
      setSaving(false)
    }
  }

  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const editable = can('project:update')

  return (
    <Dialog open={segment !== null} onOpenChange={open => !open && !saving && onClose()}>
      <DialogContent className="flex max-h-[92vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">
            {segment?.title ?? t('bookSplit.unmarked')}
          </DialogTitle>
          <DialogDescription>{t('bookSplit.chapterDialogHint')}</DialogDescription>
        </DialogHeader>
        {/* 中部吃满剩余高度且自身可滚:textarea h-full 内部滚动,底部的
            保存/取消永远在视口内——min-h 会把这块撑破 92vh,按钮被顶出屏幕。 */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {loading ? (
            <p className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
              <LoaderCircleIcon className="size-4 animate-spin" />
              {t('common.loading')}
            </p>
          ) : (
            <Textarea
              aria-label={segment?.title ?? t('bookSplit.viewChapter')}
              value={draft}
              onChange={event => setDraft(event.target.value)}
              disabled={!editable || saving}
              className="field-sizing-fixed h-full min-h-0 w-full resize-none font-mono text-xs"
            />
          )}
        </div>
        {error && (
          <p className="text-destructive text-xs">{error}</p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {t('bookSplit.chapterChars', { count: numberFormat.format(draft.length) })}
          </span>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <GuardedButton
              action="project:update"
              size="sm"
              disabled={loading || saving || detail === null || !draft.trim() || draft === detail?.content}
              onClick={() => void save()}
            >
              {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
              {saving ? t('common.saving') : t('common.save')}
            </GuardedButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
