'use client'

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArchiveIcon, BookTextIcon, ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, CircleHelpIcon, FileTextIcon, KeyboardIcon, LoaderCircleIcon, PencilIcon, RefreshCwIcon, ScrollTextIcon, SparklesIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { Hint } from '@/components/ui/hint'
import { TableSkeleton } from '@/components/ui/skeleton'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { StatusBadge } from '@/components/ui/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'
import { LineageBadge } from '@/components/lineage-badge'
import { apiErrorMessage } from '@/lib/api-error'

/** Summary row shared by GET source-versions and GET script-versions. */
export interface VersionSummary {
  id: string
  version: number
  checksum: string
  status: string
  contentLength: number
  /** Set when the user archived the version — hidden from the active list, restorable. */
  archivedAt?: string | null
  /** Only scripts carry lineage: the task that wrote the version, null when a human did. */
  generationTaskId?: string | null
}

/** The latest failed AI derivation for this episode, surfaced so silence never reads as success. */
export interface ScriptAiError {
  model: string | null
  error: string
  at: string
}

interface ScriptVersionsResponse {
  versions: VersionSummary[]
  lastAiError: ScriptAiError | null
}

/** Single-version endpoints include the text the list summaries omit. */
type VersionDetail = VersionSummary & { content: string }

interface ScriptApproveResponse {
  version: VersionDetail
  storyboardsUpdated: number
  /** True when the approval started a regeneration of the breakdown instead of re-pointing shots. */
  cascaded: boolean
}

const EMPTY_VERSIONS: VersionSummary[] = []

/** A small question mark that explains jargon on hover — terms users can't be expected to know. */
function HelpHint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="text-muted-foreground inline-flex cursor-help">
          <CircleHelpIcon className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  )
}

/** Version rows carry the SCREAMING workflow enum; StatusBadge speaks lowercase tones. */
function toneFor(status: string): string {
  return status.toLowerCase()
}

interface SourcesPanelProps {
  episodeId: string | null
  /** The project page hosts the whole-book split; the empty state points back to it. */
  projectId?: string
  /** Approval is what releases the rest of the chain, so the page re-reads the panels it advanced. */
  onScriptApproved?: () => void
}

export function SourcesPanel({ episodeId, projectId, onScriptApproved }: SourcesPanelProps) {
  const { t } = useI18n()
  const { api, organizationId } = useSession()
  const { can } = usePermission()

  const [content, setContent] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  // Identifies the single row mutation in flight, e.g. `approve-source-3`.
  const [busy, setBusy] = useState<string | null>(null)
  // The at-timestamp of the AI failure the user dismissed, so a retry that fails again re-shows it.
  const [aiErrorDismissedAt, setAiErrorDismissedAt] = useState<string | null>(null)
  // Deletes are destructive and always confirmed; archive/unarchive is reversible and never confirmed.
  const [deleteConfirm, setDeleteConfirm] = useState<{ kind: 'script' | 'source'; version: VersionSummary } | null>(null)
  const [showArchivedScripts, setShowArchivedScripts] = useState(false)
  const [showArchivedSources, setShowArchivedSources] = useState(false)
  // 手工录入是次路径:整本书拆分生成的原文直接落在版本表里,粘贴框只在
  // 本集一条原文都没有时常驻,否则收成按钮,把版面让给审批这件事。
  const [manualOpen, setManualOpen] = useState(false)

  const loadSourceVersions = useCallback(
    () =>
      episodeId
        ? api<{ versions: VersionSummary[] }>(`/episodes/${episodeId}/source-versions`).then(result => result.versions)
        : Promise.resolve<VersionSummary[]>(EMPTY_VERSIONS),
    // organizationId is not in the path but scopes the session token behind `api`.
    [api, episodeId, organizationId],
  )
  const loadScriptVersions = useCallback(
    () =>
      episodeId
        ? api<ScriptVersionsResponse>(`/episodes/${episodeId}/script-versions`)
        : Promise.resolve<ScriptVersionsResponse>({ versions: EMPTY_VERSIONS, lastAiError: null }),
    [api, episodeId, organizationId],
  )

  const sourceVersions = useAsync<VersionSummary[]>(loadSourceVersions, EMPTY_VERSIONS)
  const scriptVersions = useAsync<ScriptVersionsResponse>(
    loadScriptVersions,
    { versions: EMPTY_VERSIONS, lastAiError: null },
  )
  // 剧本生成进行中:SCRIPT 任务从排队到写完要 10~30s,只靠按钮的请求态转圈
  // 用户根本看不见。派生自批次的任务状态,有任务在飞时 3s 轮询到任务结束。
  const loadBatches = useCallback(
    () =>
      episodeId
        ? api<{ batches: Array<{ stage: string; tasks: Array<{ status: string }> }> }>(`/episodes/${episodeId}/generations`).then(result => result.batches)
        : Promise.resolve<Array<{ stage: string; tasks: Array<{ status: string }> }>>([]),
    [api, episodeId, organizationId],
  )
  const batches = useAsync<Array<{ stage: string; tasks: Array<{ status: string }> }>>(loadBatches, [])
  const scriptGenerating = useMemo(
    () =>
      batches.data.some(
        batch => batch.stage === 'SCRIPT' && batch.tasks.some(task => task.status === 'QUEUED' || task.status === 'RUNNING'),
      ),
    [batches.data],
  )
  useEffect(() => {
    if (!scriptGenerating) return
    const timer = setInterval(() => {
      batches.reload()
      scriptVersions.reload()
    }, 3000)
    return () => {
      clearInterval(timer)
      // 收尾的最后一次刷新:任务刚落地的版本/错误不靠用户手动刷新才出现。
      batches.reload()
      scriptVersions.reload()
    }
  }, [scriptGenerating, batches.reload, scriptVersions.reload])
  const scriptArchived = useMemo(
    () => scriptVersions.data.versions.filter(version => version.archivedAt),
    [scriptVersions.data],
  )
  const sourceArchived = useMemo(
    () => sourceVersions.data.filter(version => version.archivedAt),
    [sourceVersions.data],
  )
  // 未归档的原文版本:决定手工录入框是常驻(一条都没有)还是收成按钮。
  const activeSources = useMemo(
    () => sourceVersions.data.filter(version => !version.archivedAt),
    [sourceVersions.data],
  )

  const reloadSources = sourceVersions.reload
  const reloadScripts = scriptVersions.reload
  const reloadAll = useCallback(() => {
    reloadSources()
    reloadScripts()
  }, [reloadSources, reloadScripts])

  async function upload() {
    if (!episodeId) return
    setUploading(true)
    setUploadError(null)
    try {
      const created = await api<{ version: VersionSummary }>(`/episodes/${episodeId}/source-versions`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      })
      toast.success(t('sources.uploaded', { version: created.version.version }))
      setContent('')
      setManualOpen(false)
      reloadAll()
    } catch (error) {
      setUploadError(apiErrorMessage(error, t))
    } finally {
      setUploading(false)
    }
  }

  async function approveSource(version: VersionSummary) {
    if (!episodeId) return
    setBusy(`approve-source-${version.version}`)
    try {
      await api(`/episodes/${episodeId}/source-versions/${version.version}/approve`, { method: 'POST' })
      toast.success(t('sources.approved', { version: version.version }))
      reloadAll()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
      reloadAll()
    } finally {
      setBusy(null)
    }
  }

  async function deriveScript(source: VersionSummary) {
    if (!episodeId) return
    setBusy(`derive-${source.version}`)
    try {
      const created = await api<{ version: VersionSummary }>(`/episodes/${episodeId}/script-versions`, {
        method: 'POST',
        body: JSON.stringify({ sourceVersion: source.version }),
      })
      toast.success(t('sources.derived', { version: created.version.version, source: source.version }))
      reloadAll()
    } catch (error) {
      toast.error(friendlyError(error, t('sources.sourceNotApproved'), 'sources:sourceNotApproved'))
      reloadAll()
    } finally {
      setBusy(null)
    }
  }

  async function approveScript(version: VersionSummary) {
    if (!episodeId) return
    setBusy(`approve-script-${version.version}`)
    try {
      const result = await api<ScriptApproveResponse>(`/episodes/${episodeId}/script-versions/${version.version}/approve`, {
        method: 'POST',
      })
      toast.success(
        result.cascaded
          ? t('sources.scriptApprovedRegenerating', { version: version.version })
          : t('sources.scriptApproved', { version: version.version, count: result.storyboardsUpdated }),
      )
      reloadAll()
      onScriptApproved?.()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
      reloadAll()
    } finally {
      setBusy(null)
    }
  }

  /** One function for both entry points: the AI-generate button and the failure banner's retry. */
  async function aiGenerateScript() {
    if (!episodeId) return
    setBusy('ai-script')
    try {
      await api(`/episodes/${episodeId}/generations`, {
        method: 'POST',
        body: JSON.stringify({ stage: 'SCRIPT', regenerate: true }),
      })
      toast.success(t('sources.aiRetryStarted'))
      setAiErrorDismissedAt(null)
      reloadAll()
      // 立即刷批次,让 scriptGenerating 接棒请求态——按钮的"生成中"要一直
      // 亮到任务落定,而不是只在请求的几百毫秒里转一下。
      batches.reload()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  async function setArchived(kind: 'script' | 'source', version: VersionSummary, archived: boolean) {
    if (!episodeId) return
    setBusy(`archive-${kind}-${version.version}`)
    try {
      const path = kind === 'script' ? 'script-versions' : 'source-versions'
      await api(`/episodes/${episodeId}/${path}/${version.version}/archive`, {
        method: 'POST',
        body: JSON.stringify({ archived }),
      })
      toast.success(archived ? t('sources.archivedToast') : t('sources.unarchivedToast'))
      reloadAll()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  async function removeVersion(kind: 'script' | 'source', version: VersionSummary) {
    if (!episodeId) return
    setBusy(`delete-${kind}-${version.version}`)
    try {
      const path = kind === 'script' ? 'script-versions' : 'source-versions'
      await api(`/episodes/${episodeId}/${path}/${version.version}`, { method: 'DELETE' })
      toast.success(t('sources.deleted'))
      reloadAll()
    } catch (error) {
      if (error instanceof ApiError && error.message === 'sources:deleteApproved') {
        toast.error(t('sources.deleteApprovedError'))
      } else if (error instanceof ApiError && error.message === 'sources:scriptInUse') {
        toast.error(t('sources.scriptInUseError'))
      } else {
        toast.error(apiErrorMessage(error, t))
      }
    } finally {
      setBusy(null)
      setDeleteConfirm(null)
    }
  }

  function friendlyError(error: unknown, mapped: string, code: string): string {
    if (error instanceof ApiError && error.message === code) return mapped
    return apiErrorMessage(error, t)
  }

  const loading = sourceVersions.loading || scriptVersions.loading
  const error = sourceVersions.error ?? scriptVersions.error

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookTextIcon className="text-muted-foreground size-4" />
          {t('sources.title')}
        </CardTitle>
        <CardDescription>{t('sources.subtitle')}</CardDescription>
        {episodeId && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={reloadAll} disabled={loading}>
              <RefreshCwIcon className={cn(loading && 'animate-spin')} />
              {t('common.refresh')}
            </Button>
          </CardAction>
        )}
      </CardHeader>

      {!episodeId ? (
        <CardContent>
          <EmptyState icon={<BookTextIcon />} title={t('sources.selectEpisode')} />
        </CardContent>
      ) : error ? (
        <CardContent>
          <ErrorState message={error} onRetry={reloadAll} />
        </CardContent>
      ) : (
        <CardContent className="space-y-4">
          {activeSources.length > 0 && !manualOpen ? (
            <div className="flex justify-end gap-1.5">
              <GuardedButton action="episode:write" variant="outline" size="sm" onClick={() => setManualOpen(true)}>
                <KeyboardIcon />
                {t('sources.manualAdd')}
              </GuardedButton>
              <HelpHint text={t('sources.manualAddHint')} />
            </div>
          ) : (
            <div className="space-y-3">
              {activeSources.length > 0 && (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-muted-foreground text-xs">{t('sources.manualAddHint')}</p>
                  <Button variant="ghost" size="sm" disabled={uploading} onClick={() => { setManualOpen(false); setUploadError(null) }}>
                    {t('common.collapse')}
                  </Button>
                </div>
              )}
              {activeSources.length === 0 && projectId && (
                <p className="text-muted-foreground text-xs">
                  {t('sources.noSourcesGuidance')}{' '}
                  <Link href={`/projects/${projectId}`} className="text-primary hover:underline">
                    {t('sources.goBookSplit')}
                  </Link>
                </p>
              )}
              <Field label={t('sources.uploadLabel')} htmlFor="sourceContent" error={uploadError ?? undefined}>
                <Textarea
                  id="sourceContent"
                  rows={5}
                  value={content}
                  onChange={event => setContent(event.target.value)}
                  placeholder={t('sources.uploadPlaceholder')}
                  aria-invalid={uploadError !== null}
                />
                {/* The ceiling exists only server-side; a live counter keeps it
                    from being discovered by hitting the rejection. */}
                <p className="text-muted-foreground text-xs">{t('sources.charCount', { count: content.length, limit: 200_000 })}</p>
                <p className="text-muted-foreground text-xs">{t('sources.uploadDisabledHint')}</p>
              </Field>
              <div className="flex justify-end">
                <GuardedButton
                  action="episode:write"
                  size="sm"
                  variant="outline"
                  disabled={uploading || !content.trim()}
                  onClick={() => void upload()}
                >
                  <UploadIcon />
                  {uploading ? t('sources.uploading') : t('sources.upload')}
                </GuardedButton>
              </div>
            </div>
          )}

          <VersionTable
            title={t('sources.sourceVersions')}
            icon={<FileTextIcon className="text-muted-foreground size-4" />}
            hint={t('sources.sourceVersionsHint')}
            versions={sourceVersions.data.filter(version => !version.archivedAt)}
            loading={sourceVersions.loading}
            emptyTitle={t('sources.noSources')}
            emptyHint={t('sources.noSourcesHint')}
            emptyIcon={<FileTextIcon />}
            kind="source"
            episodeId={episodeId}
            onSaved={reloadAll}
            renderActions={version => (
              <>
                {version.status !== 'APPROVED' && (
                  <GuardedButton
                    action="episode:write"
                    variant="outline"
                    size="sm"
                    disabled={busy === `approve-source-${version.version}`}
                    onClick={() => void approveSource(version)}
                  >
                    {busy === `approve-source-${version.version}` ? t('sources.approving') : t('sources.approve')}
                  </GuardedButton>
                )}
                {version.status === 'APPROVED' && !version.archivedAt && (
                  <>
                    <GuardedButton
                      action="episode:write"
                      variant="outline"
                      size="sm"
                      disabled={busy === `derive-${version.version}`}
                      onClick={() => void deriveScript(version)}
                    >
                      <ScrollTextIcon />
                      {busy === `derive-${version.version}` ? t('sources.deriving') : t('sources.derive')}
                    </GuardedButton>
                    <HelpHint text={t('sources.deriveHint')} />
                    <Hint text={t('sources.archive')}>
                      <Button variant="ghost" size="sm" aria-label={t('sources.archive')} onClick={() => void setArchived('source', version, true)}>
                        <ArchiveIcon />
                      </Button>
                    </Hint>
                  </>
                )}
                {version.archivedAt && (
                  <Button variant="ghost" size="sm" onClick={() => void setArchived('source', version, false)}>
                    {t('sources.unarchive')}
                  </Button>
                )}
                {version.status === 'DRAFT' && (
                  <Hint text={t('sources.delete')}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      aria-label={t('sources.delete')}
                      onClick={() => setDeleteConfirm({ kind: 'source', version })}
                      >
                        <Trash2Icon />
                      </Button>
                  </Hint>
                )}
              </>
            )}
          />

          {sourceArchived.length > 0 && (
            <div className="space-y-2">
              <button
                type="button"
                className="text-muted-foreground flex items-center gap-1 text-xs"
                onClick={() => setShowArchivedSources(value => !value)}
              >
                {showArchivedSources ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
                {t('sources.archivedSection', { count: sourceArchived.length })}
              </button>
              {showArchivedSources && sourceArchived.map(version => (
                <div key={version.id} className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2">
                  <span className="text-sm font-medium">v{version.version}</span>
                  <Badge variant="muted">{t('sources.archivedBadge')}</Badge>
                  <span className="text-muted-foreground font-mono text-xs">{t('sources.chars', { count: version.contentLength })}</span>
                  <span className="ml-auto flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => void setArchived('source', version, false)}>
                      {t('sources.unarchive')}
                    </Button>
                    <Hint text={t('sources.delete')}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        aria-label={t('sources.delete')}
                        onClick={() => setDeleteConfirm({ kind: 'source', version })}
                        >
                          <Trash2Icon />
                        </Button>
                    </Hint>
                  </span>
                </div>
              ))}
            </div>
          )}

          {scriptVersions.data.lastAiError && aiErrorDismissedAt !== scriptVersions.data.lastAiError.at && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>{t('sources.aiFailed')}</AlertTitle>
              <AlertDescription className="justify-items-start">
                <p className="font-mono text-xs break-all">
                  {scriptVersions.data.lastAiError.model ? `[${scriptVersions.data.lastAiError.model}] ` : ''}
                  {scriptVersions.data.lastAiError.error}
                </p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="outline" disabled={busy === 'ai-script'} onClick={() => void aiGenerateScript()}>
                    {busy === 'ai-script' ? t('common.loading') : t('sources.aiRetry')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAiErrorDismissedAt(scriptVersions.data.lastAiError!.at)}>
                    {t('sources.aiDismiss')}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          <div className="flex items-center justify-end gap-1.5">
            <GuardedButton
              action="episode:write"
              size="sm"
              variant="outline"
              disabled={busy === 'ai-script' || scriptGenerating}
              onClick={() => void aiGenerateScript()}
            >
              {busy === 'ai-script' || scriptGenerating ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />}
              {busy === 'ai-script' || scriptGenerating ? t('sources.aiGenerating') : t('sources.aiGenerate')}
            </GuardedButton>
            <HelpHint text={t('sources.aiGenerateHint')} />
          </div>

          <VersionTable
            title={t('sources.scriptVersions')}
            icon={<ScrollTextIcon className="text-muted-foreground size-4" />}
            hint={t('sources.scriptVersionsHint')}
            versions={scriptVersions.data.versions.filter(version => !version.archivedAt)}
            loading={scriptVersions.loading}
            emptyTitle={t('sources.noScripts')}
            emptyHint={t('sources.noScriptsHint')}
            emptyIcon={<ScrollTextIcon />}
            kind="script"
            episodeId={episodeId}
            onSaved={reloadAll}
            renderActions={version => (
              <>
                {version.status !== 'APPROVED' && (
                  <GuardedButton
                    action="episode:write"
                    variant="outline"
                    size="sm"
                    disabled={busy === `approve-script-${version.version}`}
                    onClick={() => void approveScript(version)}
                  >
                    {busy === `approve-script-${version.version}` ? t('sources.approving') : t('sources.approve')}
                  </GuardedButton>
                )}
                {version.status === 'APPROVED' && !version.archivedAt && (
                  <Hint text={t('sources.archive')}>
                    <Button variant="ghost" size="sm" aria-label={t('sources.archive')} onClick={() => void setArchived('script', version, true)}>
                      <ArchiveIcon />
                    </Button>
                  </Hint>
                )}
                {version.archivedAt && (
                  <Button variant="ghost" size="sm" onClick={() => void setArchived('script', version, false)}>
                    {t('sources.unarchive')}
                  </Button>
                )}
                {version.status === 'DRAFT' && (
                  <Hint text={t('sources.delete')}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      aria-label={t('sources.delete')}
                      onClick={() => setDeleteConfirm({ kind: 'script', version })}
                      >
                        <Trash2Icon />
                      </Button>
                  </Hint>
                )}
              </>
            )}
          />

          {scriptArchived.length > 0 && (
            <div className="space-y-2">
              <button
                type="button"
                className="text-muted-foreground flex items-center gap-1 text-xs"
                onClick={() => setShowArchivedScripts(value => !value)}
              >
                {showArchivedScripts ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
                {t('sources.archivedSection', { count: scriptArchived.length })}
              </button>
              {showArchivedScripts && scriptArchived.map(version => (
                <div key={version.id} className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2">
                  <span className="text-sm font-medium">v{version.version}</span>
                  <Badge variant="muted">{t('sources.archivedBadge')}</Badge>
                  <LineageBadge taskId={version.generationTaskId ?? null} />
                  <span className="text-muted-foreground font-mono text-xs">{t('sources.chars', { count: version.contentLength })}</span>
                  <span className="ml-auto flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => void setArchived('script', version, false)}>
                      {t('sources.unarchive')}
                    </Button>
                    <Hint text={t('sources.delete')}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        aria-label={t('sources.delete')}
                        onClick={() => setDeleteConfirm({ kind: 'script', version })}
                        >
                          <Trash2Icon />
                        </Button>
                    </Hint>
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}

      <AlertDialog open={deleteConfirm !== null} onOpenChange={open => !open && setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sources.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('sources.deleteConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={event => {
                event.preventDefault()
                if (deleteConfirm) void removeVersion(deleteConfirm.kind, deleteConfirm.version)
              }}
            >
              {busy === `delete-${deleteConfirm?.kind}-${deleteConfirm?.version.version}` ? t('common.loading') : t('sources.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

interface VersionTableProps {
  title: string
  icon: ReactNode
  hint?: string
  versions: VersionSummary[]
  loading: boolean
  emptyTitle: string
  emptyHint: string
  emptyIcon: ReactNode
  /** Selects the endpoint family the full text is read from and written back to. */
  kind: 'source' | 'script'
  episodeId: string
  renderActions(version: VersionSummary): ReactNode
  /** Called after an in-place edit lands so the parent list picks up the new status. */
  onSaved(): void
}

function VersionTable({
  title,
  icon,
  hint,
  versions,
  loading,
  emptyTitle,
  emptyHint,
  emptyIcon,
  kind,
  episodeId,
  renderActions,
  onSaved,
}: VersionTableProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()

  // The list is deliberately content-free, so the text is fetched when a row is
  // expanded rather than up front — a source document can be 200k characters.
  const [openVersion, setOpenVersion] = useState<number | null>(null)
  const [detail, setDetail] = useState<VersionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  // Non-null only while editing; the pristine text stays in `detail` for cancel.
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const path = kind === 'source' ? 'source-versions' : 'script-versions'
  const editable = kind === 'script' && can('episode:write')
  // A source version is always uploaded by a person, so an origin column there would only repeat itself.
  const showLineage = kind === 'script'

  async function toggleView(version: VersionSummary) {
    setDraft(null)
    if (openVersion === version.version) {
      setOpenVersion(null)
      setDetail(null)
      return
    }
    setOpenVersion(version.version)
    setDetail(null)
    setDetailLoading(true)
    try {
      const result = await api<{ version: VersionDetail }>(`/episodes/${episodeId}/${path}/${version.version}`)
      setDetail(result.version)
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
      setOpenVersion(null)
    } finally {
      setDetailLoading(false)
    }
  }

  async function saveEdit() {
    if (draft === null || detail === null) return
    setSaving(true)
    try {
      const result = await api<{ version: VersionDetail }>(`/episodes/${episodeId}/${path}/${detail.version}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: draft }),
      })
      toast.success(t('sources.saved', { version: result.version.version }))
      setDetail(result.version)
      setDraft(null)
      onSaved()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
        {hint && <CardDescription>{hint}</CardDescription>}
      </CardHeader>
      {loading && versions.length === 0 ? (
        <TableSkeleton rows={2} columns={3} />
      ) : versions.length === 0 ? (
        <CardContent className="px-4">
          <EmptyState icon={emptyIcon} title={emptyTitle} description={emptyHint} />
        </CardContent>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('sources.version')}</TableHead>
              <TableHead className="w-32">{t('common.status')}</TableHead>
              {showLineage && <TableHead className="w-32">{t('lineage.source')}</TableHead>}
              <TableHead className="text-right">{t('common.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map(version => (
              <Fragment key={version.id}>
                <TableRow>
                  <TableCell>
                    <p className="font-medium">v{version.version}</p>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <p className="text-muted-foreground font-mono text-xs">
                          {t('sources.chars', { count: version.contentLength })} · {version.checksum.slice(0, 12)}
                        </p>
                      </TooltipTrigger>
                      <TooltipContent className="break-all">{`${t('sources.checksum')} ${version.checksum}`}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={toneFor(version.status)} label={t(`status.${toneFor(version.status)}`)} />
                  </TableCell>
                  {showLineage && (
                    <TableCell>
                      <LineageBadge taskId={version.generationTaskId} />
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => void toggleView(version)} disabled={detailLoading && openVersion === version.version}>
                        <ChevronDownIcon className={cn('size-3.5 transition-transform', openVersion === version.version && 'rotate-180')} />
                        {openVersion === version.version ? t('sources.hide') : t('sources.view')}
                      </Button>
                      {renderActions(version)}
                    </div>
                  </TableCell>
                </TableRow>
                {openVersion === version.version && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={showLineage ? 4 : 3} className="bg-muted/40 py-3">
                      {detailLoading ? (
                        <p className="text-muted-foreground text-xs">{t('common.loading')}</p>
                      ) : detail === null ? null : draft === null ? (
                        <div className="space-y-2">
                          {editable && (
                            <div className="flex justify-end">
                              <Button variant="outline" size="sm" onClick={() => setDraft(detail.content)}>
                                <PencilIcon />
                                {t('sources.edit')}
                              </Button>
                            </div>
                          )}
                          <pre className="bg-background max-h-96 overflow-auto rounded-md border p-3 text-xs whitespace-pre-wrap">
                            {detail.content}
                          </pre>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <Textarea rows={14} value={draft} onChange={event => setDraft(event.target.value)} />
                          <p className="text-muted-foreground text-xs">{t('sources.editHint')}</p>
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(null)}>
                              {t('common.cancel')}
                            </Button>
                            <Button size="sm" disabled={saving || !draft.trim()} onClick={() => void saveEdit()}>
                              {saving ? t('sources.saving') : t('common.save')}
                            </Button>
                          </div>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  )
}
