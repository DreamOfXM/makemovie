'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { apiErrorMessage } from '@/lib/api-error'
import {
  BookCheckIcon,
  BookTextIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FileUpIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  ScissorsIcon,
  SplitIcon,
  Trash2Icon,
} from 'lucide-react'
import {
  ApiError,
  applyProjectSource,
  autoSplitSource,
  deleteProjectSourceSegment,
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
import { SCRIPT_CHARS_PER_MINUTE } from '@studio/domain'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { HelpHint } from '@/components/ui/help-hint'
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
  /** Bumped by the page when episodes change outside this panel (created or
   *  deleted in the episodes module) — the matrix re-reads so its episode
   *  dropdown and allocation rows stay in sync. */
  refreshToken?: number
  /** Apply and "new episode" both change what the page's episode table shows. */
  onEpisodesChanged?: () => void
}

/**
 * 整本拆集: the project-level whole-book intake. Two modes — browse (click a
 * chapter to read/edit it) and 拆集 (multi-select chapters, then merge them
 * into a new episode or an existing one from the action bar). Episodes emerge
 * from grouping; the per-row dropdown is gone.
 */
export function BookSplitPanel({ projectId, refreshToken, onEpisodesChanged }: BookSplitPanelProps) {
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
  // Identifies the mutation in flight: 'apply', `alloc-…`, `preset-…`.
  const [busy, setBusy] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<{ items: ApplyProjectSourceResultItem[]; pendingSegments: number } | null>(null)
  const [actionError, setActionError] = useState<{ message: string; retry?(): void } | null>(null)
  // 章节弹窗:整章原文的审阅与编辑。几千字的章节塞不进表格行,也不该塞。
  const [chapterTarget, setChapterTarget] = useState<ProjectSourceSegment | null>(null)
  // 拆集两态:浏览态点章节=看详情;拆集态点行=勾选,底部浮层成组。
  const [splitMode, setSplitMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastClickedIndex = useRef<number | null>(null)
  // 「合并为新的一集」命名弹窗(集号+集名,与创建剧集弹窗同构)。
  const [newEpOpen, setNewEpOpen] = useState(false)
  const [newEpNumber, setNewEpNumber] = useState('')
  const [newEpName, setNewEpName] = useState('')
  const [newEpError, setNewEpError] = useState<string | null>(null)
  // 批量删除章节 / 重置分组的确认层。
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)

  const loadMatrix = useCallback(
    () => getProjectSource(api, projectId),
    // organizationId scopes the token behind `api`; projectId is the route input.
    [api, projectId, organizationId],
  )
  const matrix = useAsync<ProjectSourceResponse>(loadMatrix, EMPTY_MATRIX)
  // 页面侧的建集/删集经 refreshToken 通知到这里——首渲染不算，之后的每次
  // 变化都重读矩阵（分组行和集列表都依赖它）。
  const seenToken = useRef(refreshToken)
  useEffect(() => {
    if (refreshToken === undefined || seenToken.current === refreshToken) return
    seenToken.current = refreshToken
    matrix.reload()
  }, [refreshToken, matrix.reload])

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
  const defaultMinutes = Math.round(matrix.data.defaults.targetDurationMs / 60_000)
  const canAllocate = can('episode:write')

  const episodeById = useMemo(() => new Map(matrix.data.episodes.map(episode => [episode.id, episode])), [matrix.data.episodes])
  const unassignedCount = matrix.data.segments.filter(segment => segment.episodeId === null).length
  const nextNumber = useMemo(
    () => matrix.data.episodes.reduce((highest, episode) => Math.max(highest, episode.number), 0) + 1,
    [matrix.data.episodes],
  )
  const selectedChars = useMemo(
    () => matrix.data.segments.reduce((total, segment) => (selected.has(segment.id) ? total + segment.charCount : total), 0),
    [matrix.data.segments, selected],
  )
  const minutesOf = useCallback((chars: number) => Math.round(chars / SCRIPT_CHARS_PER_MINUTE), [])
  // 极短章估时四舍五入会得 0 分钟——「≈0」是废话，「＜1」才是话。()
  const estMinutes = useCallback(
    (chars: number) => {
      const minutes = minutesOf(chars)
      return minutes < 1 ? t('bookSplit.minutesUnder1') : String(minutes)
    },
    [minutesOf, t],
  )

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
    return apiErrorMessage(error, t)
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

  /* ---------------- 拆集态:选择与批量分组 ---------------- */

  function toggleSelect(segment: ProjectSourceSegment, shift: boolean, index: number) {
    setSelected(current => {
      const next = new Set(current)
      if (shift && lastClickedIndex.current !== null) {
        const [from, to] = [Math.min(lastClickedIndex.current, index), Math.max(lastClickedIndex.current, index)]
        for (let i = from; i <= to; i += 1) next.add(matrix.data.segments[i].id)
      } else if (next.has(segment.id)) {
        next.delete(segment.id)
      } else {
        next.add(segment.id)
      }
      return next
    })
    lastClickedIndex.current = index
  }

  function clearSelection() {
    setSelected(new Set())
    lastClickedIndex.current = null
  }

  function exitSplitMode() {
    setSplitMode(false)
    clearSelection()
  }

  /** Batch write of one allocation change for every selected chapter. */
  async function assignSelected(episodeId: string | null) {
    if (selected.size === 0) return
    setBusy('assign')
    setActionError(null)
    try {
      await updateSourceAllocations(
        api,
        projectId,
        [...selected].map(segmentId => ({ segmentId, episodeId })),
      )
      clearSelection()
      matrix.reload()
    } catch (error) {
      setActionError({ message: friendlyError(error), retry: () => void assignSelected(episodeId) })
    } finally {
      setBusy(null)
    }
  }

  async function preset(mode: 'budget' | 'per_chapter') {
    setBusy(`preset-${mode}`)
    setActionError(null)
    try {
      const result = await autoSplitSource(api, projectId, mode)
      toast.success(
        mode === 'per_chapter'
          ? t('bookSplit.presetPerChapterDone', { episodes: result.episodesCreated })
          : t('bookSplit.presetBudgetDone', { episodes: result.episodesCreated }),
      )
      setApplyResult(null)
      matrix.reload()
      onEpisodesChanged?.()
    } catch (error) {
      setActionError({ message: friendlyError(error), retry: () => void preset(mode) })
    } finally {
      setBusy(null)
    }
  }

  function openNewEpisodeDialog() {
    setNewEpNumber(String(nextNumber))
    setNewEpName('')
    setNewEpError(null)
    setNewEpOpen(true)
  }

  async function createGroupedEpisode() {
    const number = Number(newEpNumber)
    if (!Number.isInteger(number) || number < 1) {
      setNewEpError(t('bookSplit.newEpNumberInvalid'))
      return
    }
    setBusy('new-episode')
    setNewEpError(null)
    try {
      // 与「创建剧集」弹窗同构:集号 + 集名;留空的集名落默认「第 N 集」。
      await api(`/projects/${projectId}/episodes`, {
        method: 'POST',
        body: JSON.stringify({ number, title: newEpName.trim() || `第 ${number} 集` }),
      })
      const reloaded = await getProjectSource(api, projectId)
      const episode = reloaded.episodes.find(item => item.number === number)
      if (!episode) throw new Error('episode vanished after creation')
      await updateSourceAllocations(
        api,
        projectId,
        [...selected].map(segmentId => ({ segmentId, episodeId: episode.id })),
      )
      toast.success(t('bookSplit.newEpDone', { number, count: selected.size }))
      setNewEpOpen(false)
      clearSelection()
      setApplyResult(null)
      matrix.reload()
      onEpisodesChanged?.()
    } catch (error) {
      if (error instanceof ApiError && error.message.includes('already exists')) {
        setNewEpError(t('bookSplit.newEpNumberTaken', { number }))
      } else {
        setNewEpError(friendlyError(error))
      }
    } finally {
      setBusy(null)
    }
  }

  async function deleteSelected() {
    setBusy('delete-chapters')
    try {
      await Promise.all([...selected].map(segmentId => deleteProjectSourceSegment(api, projectId, segmentId)))
      toast.success(t('bookSplit.chaptersDeleted', { count: selected.size }))
      setDeleteOpen(false)
      clearSelection()
      setApplyResult(null)
      matrix.reload()
    } catch (error) {
      toast.error(friendlyError(error))
    } finally {
      setBusy(null)
    }
  }

  async function resetGroups() {
    setBusy('reset')
    setActionError(null)
    try {
      await updateSourceAllocations(
        api,
        projectId,
        matrix.data.segments.map(segment => ({ segmentId: segment.id, episodeId: null })),
      )
      toast.success(t('bookSplit.resetDone'))
      setResetOpen(false)
      setApplyResult(null)
      matrix.reload()
    } catch (error) {
      setActionError({ message: friendlyError(error), retry: () => void resetGroups() })
    } finally {
      setBusy(null)
    }
  }

  /* ---------------- 生成分集原文 ---------------- */

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

  // 分组行渲染序:章节按书序;每段连续同集的开头插一条集头(整组合计)。
  const rows = useMemo(() => {
    const out: Array<{ kind: 'head'; episodeId: string } | { kind: 'chapter'; segment: ProjectSourceSegment; index: number }> = []
    let previousEpisode: string | null | undefined
    matrix.data.segments.forEach((segment, index) => {
      const current = segment.episodeId
      if (current !== null && current !== previousEpisode) out.push({ kind: 'head', episodeId: current })
      out.push({ kind: 'chapter', segment, index })
      previousEpisode = current
    })
    return out
  }, [matrix.data.segments])
  const groupSizes = useMemo(() => {
    const counts = new Map<string, { chapters: number; chars: number }>()
    for (const segment of matrix.data.segments) {
      if (!segment.episodeId) continue
      const agg = counts.get(segment.episodeId) ?? { chapters: 0, chars: 0 }
      agg.chapters += 1
      agg.chars += segment.charCount
      counts.set(segment.episodeId, agg)
    }
    return counts
  }, [matrix.data.segments])

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

          {/* 拆集工具行:浏览/拆集两态 + 两个预分组模式;电影形态一集到底,不给分组入口。 */}
          {!isFilm && (
            <div className="flex flex-wrap items-center gap-1.5">
              {canAllocate && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => (splitMode ? exitSplitMode() : setSplitMode(true))}
                >
                  {splitMode ? <CheckIcon /> : <ScissorsIcon />}
                  {splitMode ? t('bookSplit.splitExit') : t('bookSplit.splitEnter')}
                </Button>
              )}
              {/* 预分组是浏览态的批量动作:拆集态的语境是"我正在手选",
                  并排出现只会让人以为要先勾选才能预分组。 */}
              {!splitMode && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <GuardedButton action="episode:write" variant="outline" size="sm" disabled={busy !== null || unassignedCount === 0}>
                    {busy === 'preset-budget' || busy === 'preset-per_chapter' ? <LoaderCircleIcon className="animate-spin" /> : <SplitIcon />}
                    {t('bookSplit.presetBtn')}
                    <ChevronDownIcon className="text-muted-foreground size-3.5" />
                  </GuardedButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-80">
                  <DropdownMenuItem className="flex-col items-start gap-0.5 py-2" onClick={() => void preset('budget')}>
                    <span className="text-sm font-medium">{t('bookSplit.presetBudget', { minutes: defaultMinutes })}</span>
                    <span className="text-muted-foreground text-xs">{t('bookSplit.presetBudgetHint', { chars: fmt(defaultMinutes * SCRIPT_CHARS_PER_MINUTE) })}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="flex-col items-start gap-0.5 py-2" onClick={() => void preset('per_chapter')}>
                    <span className="text-sm font-medium">{t('bookSplit.presetPerChapter')}</span>
                    <span className="text-muted-foreground text-xs">{t('bookSplit.presetPerChapterHint')}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              )}
              <span className="flex-1" />
              <span className="text-muted-foreground text-xs">
                {unassignedCount > 0 ? t('bookSplit.unassignedCount', { count: unassignedCount }) : t('bookSplit.allGrouped')}
              </span>
              {canAllocate && !splitMode && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={busy !== null || episodesReceivingContent === 0}
                  onClick={() => setResetOpen(true)}
                >
                  {t('bookSplit.resetBtn')}
                </Button>
              )}
            </div>
          )}

          <div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {splitMode && <TableHead className="w-8" />}
                  <TableHead>{t('bookSplit.colChapter')}</TableHead>
                  <TableHead className="w-16 text-right">{t('bookSplit.colChars')}</TableHead>
                  <TableHead className="w-36">{t('bookSplit.colGroup')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(row => {
                  if (row.kind === 'head') {
                    const episode = episodeById.get(row.episodeId)
                    if (!episode) return null
                    const agg = groupSizes.get(row.episodeId) ?? { chapters: 0, chars: 0 }
                    const minutesNum = minutesOf(agg.chars)
                    const minutes = estMinutes(agg.chars)
                    const over = minutesNum > defaultMinutes + 2
                    return (
                      <TableRow key={`head-${row.episodeId}`} className="hover:bg-transparent">
                        <TableCell colSpan={splitMode ? 4 : 3} className="bg-muted/40 py-1.5">
                          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                            <span className="text-foreground font-medium">
                              {t('bookSplit.episodePlain', { number: episode.number })}
                              {episodeDisplayTitle(episode) && <span className="text-muted-foreground"> · {episodeDisplayTitle(episode)}</span>}
                            </span>
                            <span className="tabular-nums">
                              {t('bookSplit.groupHeadMeta', { count: agg.chapters, chars: fmt(agg.chars), minutes })}
                            </span>
                            {over && <span className="text-warning font-medium">{t('bookSplit.groupOver', { minutes: minutesNum - defaultMinutes })}</span>}
                            {splitMode && canAllocate && (
                              <span className="ml-auto">
                                <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={busy !== null} onClick={() => void assignGroupOut(row.episodeId)}>
                                  {t('bookSplit.dissolve')}
                                </Button>
                              </span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  }
                  const { segment, index } = row
                  const isSelected = selected.has(segment.id)
                  const episode = segment.episodeId ? episodeById.get(segment.episodeId) : null
                  const rowBusy = busy === `alloc-${segment.id}`
                  // 已分组的章节在拆集态锁定:选择语境只针对"未分配";要动它,
                  // 先到它所在集的集头「解散」。锁定的行点标题=看详情。
                  const lockedInSplit = splitMode && segment.episodeId !== null
                  const selectable = splitMode && !lockedInSplit
                  return (
                    <TableRow
                      key={segment.id}
                      className={cn(
                        'transition-colors',
                        selectable && 'cursor-pointer',
                        selectable && isSelected && 'bg-primary/5',
                        lockedInSplit && 'opacity-55',
                      )}
                      onClick={selectable ? event => toggleSelect(segment, event.shiftKey, index) : undefined}
                    >
                      {splitMode && (
                        <TableCell>
                          {/* 已分组的锁定行是"勾选态置灰"(带勾的灰框=已有归属、
                              不可再选),不是空态置灰(空灰读作坏掉的控件)。 */}
                          <span
                            className={cn(
                              'flex size-4 items-center justify-center rounded border',
                              lockedInSplit
                                ? 'border-muted-foreground/40 bg-muted-foreground/30 text-muted-foreground'
                                : isSelected
                                  ? 'bg-primary border-primary text-primary-foreground'
                                  : 'border-input',
                            )}
                            aria-hidden
                          >
                            {(isSelected || lockedInSplit) && <CheckIcon className="size-3" />}
                          </span>
                        </TableCell>
                      )}
                      <TableCell className="max-w-0 py-2.5">
                        {/* 浏览态:整块标题+摘要可点开全文;拆集态:任何点击都是勾选,
                            详情不被选择劫持——两态分流是关键。 */}
                        <button
                          type="button"
                          className="hover:bg-muted/40 -mx-1.5 flex min-w-0 flex-col items-start gap-0.5 rounded-md px-1.5 py-1 text-left transition-colors"
                          aria-label={`${segment.title ?? t('bookSplit.unmarked')} · ${t('bookSplit.viewChapter')}`}
                          onClick={event => {
                            if (selectable) return // 放行给整行勾选
                            event.stopPropagation()
                            setChapterTarget(segment)
                          }}
                        >
                          <span className="flex min-w-0 items-center gap-1 self-stretch">
                            {!splitMode && <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />}
                            <span className="max-w-md truncate font-medium">
                              {segment.title ?? <span className="text-muted-foreground">{t('bookSplit.unmarked')}</span>}
                            </span>
                          </span>
                          {segment.preview && (
                            <span className="text-muted-foreground line-clamp-2 max-w-lg pl-4.5 text-xs font-normal">
                              {segment.preview}
                            </span>
                          )}
                        </button>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right font-mono text-xs">
                        {rowBusy ? <LoaderCircleIcon className="inline size-3.5 animate-spin" /> : fmt(segment.charCount)}
                      </TableCell>
                      <TableCell>
                        {episode ? (
                          <Badge variant="tinted" className="font-normal">
                            {t('bookSplit.episodePlain', { number: episode.number })}
                          </Badge>
                        ) : (
                          <Badge variant="muted" className="font-normal">{t('bookSplit.unassigned')}</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          {/* 拆集浮层:选中即出,带实时估算;命名建集/并入/移出/批量删除。 */}
          {splitMode && selected.size > 0 && (
            /* 固定在可视区底部:44 章的表格里,卡片内底部的浮层永远在屏幕外。 */
            <div className="bg-card fixed bottom-6 left-1/2 z-40 flex w-[min(920px,calc(100vw-2rem))] -translate-x-1/2 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-3 text-xs shadow-lg">
              <span className="tabular-nums">
                {t('bookSplit.splitSelected', {
                  count: selected.size,
                  chars: fmt(selectedChars),
                  minutes: estMinutes(selectedChars),
                })}
              </span>
              <span className="flex-1" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={busy !== null || matrix.data.episodes.length === 0}>
                    {t('bookSplit.splitInto')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {matrix.data.episodes.map(episode => {
                    const chars = (allocatedByEpisode.get(episode.id) ?? 0) + selectedChars
                    return (
                      <DropdownMenuItem key={episode.id} onClick={() => void assignSelected(episode.id)}>
                        {t('bookSplit.splitIntoItem', { number: episode.number, minutes: estMinutes(chars) })}
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
              <GuardedButton
                action="project:update"
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={busy !== null}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2Icon />
                {t('bookSplit.splitDelete')}
              </GuardedButton>
              <GuardedButton action="episode:write" size="sm" disabled={busy !== null} onClick={openNewEpisodeDialog}>
                {busy === 'new-episode' ? <LoaderCircleIcon className="animate-spin" /> : null}
                {t('bookSplit.splitMergeNew')}
              </GuardedButton>
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={clearSelection}>
                {t('bookSplit.splitClearSel')}
              </Button>
            </div>
          )}

          <p className="text-muted-foreground text-xs">
            {t('bookSplit.steps')}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
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

      {/* 合并为新的一集:集号+集名,与创建剧集弹窗同构;集名留空落默认。 */}
      <Dialog open={newEpOpen} onOpenChange={open => !open && !busy && setNewEpOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('bookSplit.newEpTitle')}</DialogTitle>
            <DialogDescription>
              {t('bookSplit.newEpSummary', { count: selected.size, chars: fmt(selectedChars), minutes: estMinutes(selectedChars) })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label={t('bookSplit.newEpNumber')} htmlFor="newEpNumber" error={newEpError ?? undefined}>
              <Input
                id="newEpNumber"
                type="number"
                min={1}
                value={newEpNumber}
                onChange={event => { setNewEpNumber(event.target.value); setNewEpError(null) }}
                disabled={busy === 'new-episode'}
                aria-invalid={newEpError !== null}
              />
            </Field>
            <Field label={t('bookSplit.newEpName')} htmlFor="newEpName" hint={t('bookSplit.newEpNameHint', { default: `第 ${newEpNumber || nextNumber} 集` })}>
              <Input
                id="newEpName"
                value={newEpName}
                placeholder={`第 ${nextNumber} 集`}
                onChange={event => setNewEpName(event.target.value)}
                disabled={busy === 'new-episode'}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy === 'new-episode'} onClick={() => setNewEpOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" disabled={busy === 'new-episode'} onClick={() => void createGroupedEpisode()}>
              {busy === 'new-episode' ? <LoaderCircleIcon className="animate-spin" /> : null}
              {busy === 'new-episode' ? t('common.saving') : t('bookSplit.newEpCreate')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={open => !open && setDeleteOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('bookSplit.splitDeleteTitle', { count: selected.size })}</AlertDialogTitle>
            <AlertDialogDescription>{t('bookSplit.splitDeleteBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === 'delete-chapters'}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy === 'delete-chapters'}
              onClick={event => {
                event.preventDefault()
                void deleteSelected()
              }}
            >
              {busy === 'delete-chapters' ? t('common.loading') : t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resetOpen} onOpenChange={open => !open && setResetOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('bookSplit.resetTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('bookSplit.resetBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === 'reset'}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === 'reset'}
              onClick={event => {
                event.preventDefault()
                void resetGroups()
              }}
            >
              {busy === 'reset' ? t('common.loading') : t('bookSplit.resetConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )

  /** 解散一组 = 该组全部章节退回未分配(批量 PATCH)。 */
  async function assignGroupOut(episodeId: string) {
    const ids = matrix.data.segments.filter(segment => segment.episodeId === episodeId).map(segment => segment.id)
    if (ids.length === 0) return
    setBusy('assign')
    setActionError(null)
    try {
      await updateSourceAllocations(api, projectId, ids.map(segmentId => ({ segmentId, episodeId: null })))
      clearSelection()
      matrix.reload()
    } catch (error) {
      setActionError({ message: friendlyError(error), retry: () => void assignGroupOut(episodeId) })
    } finally {
      setBusy(null)
    }
  }
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
  // 删除本章的确认弹层(叠在审阅弹窗之上)。
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

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
        if (!cancelled) setError(apiErrorMessage(err, t))
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
      setError(apiErrorMessage(err, t))
    } finally {
      setSaving(false)
    }
  }

  async function removeChapter() {
    if (!segment) return
    setDeleting(true)
    try {
      await deleteProjectSourceSegment(api, projectId, segment.id)
      toast.success(t('bookSplit.chapterDeleted'))
      onSaved()
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err, t))
    } finally {
      setDeleting(false)
      setDeleteOpen(false)
    }
  }

  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const editable = can('project:update')

  return (
    <Dialog open={segment !== null} onOpenChange={open => !open && !saving && onClose()}>
      {/* 阅读与编辑是一等动作,画布就要一等大:近全屏(用户五次追问后的定稿)。 */}
      <DialogContent className="flex h-[92vh] w-[95vw] max-w-none flex-col p-5 sm:max-w-none sm:p-6">
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
              className="field-sizing-fixed h-full min-h-0 w-full resize-none font-mono text-sm leading-relaxed"
            />
          )}
        </div>
        {error && (
          <p className="text-destructive text-xs">{error}</p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            disabled={!editable || saving || deleting}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2Icon className="size-3.5" />
            {t('bookSplit.deleteChapter')}
          </Button>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-xs tabular-nums">
              {t('bookSplit.chapterChars', { count: numberFormat.format(draft.length) })}
            </span>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving || deleting}>
              {t('common.cancel')}
            </Button>
            <GuardedButton
              action="project:update"
              size="sm"
              disabled={loading || saving || deleting || detail === null || !draft.trim() || draft === detail?.content}
              onClick={() => void save()}
            >
              {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
              {saving ? t('common.saving') : t('common.save')}
            </GuardedButton>
          </div>
        </div>

        <AlertDialog open={deleteOpen} onOpenChange={open => !open && setDeleteOpen(false)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('bookSplit.deleteChapterTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('bookSplit.deleteChapterBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={deleting}
                onClick={event => {
                  event.preventDefault()
                  void removeChapter()
                }}
              >
                {deleting ? t('common.loading') : t('common.delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
