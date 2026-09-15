'use client'

import { Fragment, useCallback, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { BookTextIcon, FileTextIcon, PencilIcon, RefreshCwIcon, ScrollTextIcon, UploadIcon } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { TableSkeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/ui/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'
import { LineageBadge } from '@/components/lineage-badge'

/** Summary row shared by GET source-versions and GET script-versions. */
export interface VersionSummary {
  id: string
  version: number
  checksum: string
  status: string
  contentLength: number
  /** Only scripts carry lineage: the task that wrote the version, null when a human did. */
  generationTaskId?: string | null
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

/** Version rows carry the SCREAMING workflow enum; StatusBadge speaks lowercase tones. */
function toneFor(status: string): string {
  return status.toLowerCase()
}

interface SourcesPanelProps {
  episodeId: string | null
  /** Approval is what releases the rest of the chain, so the page re-reads the panels it advanced. */
  onScriptApproved?: () => void
}

export function SourcesPanel({ episodeId, onScriptApproved }: SourcesPanelProps) {
  const { t } = useI18n()
  const { api, organizationId } = useSession()

  const [content, setContent] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  // Identifies the single row mutation in flight, e.g. `approve-source-3`.
  const [busy, setBusy] = useState<string | null>(null)

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
        ? api<{ versions: VersionSummary[] }>(`/episodes/${episodeId}/script-versions`).then(result => result.versions)
        : Promise.resolve<VersionSummary[]>(EMPTY_VERSIONS),
    [api, episodeId, organizationId],
  )

  const sourceVersions = useAsync<VersionSummary[]>(loadSourceVersions, EMPTY_VERSIONS)
  const scriptVersions = useAsync<VersionSummary[]>(loadScriptVersions, EMPTY_VERSIONS)

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
      reloadAll()
    } catch (error) {
      if (error instanceof ApiError && error.message === 'sources:duplicate') {
        setUploadError(t('sources.duplicateError'))
      } else {
        setUploadError(error instanceof Error ? error.message : t('error.generic'))
      }
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
      toast.error(friendlyError(error, t('sources.alreadyApproved'), 'sources:alreadyApproved'))
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
      toast.error(friendlyError(error, t('sources.alreadyApproved'), 'sources:alreadyApproved'))
      reloadAll()
    } finally {
      setBusy(null)
    }
  }

  function friendlyError(error: unknown, mapped: string, code: string): string {
    if (error instanceof ApiError && error.message === code) return mapped
    return error instanceof Error ? error.message : t('error.generic')
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
          <div className="space-y-3">
            <Field label={t('sources.uploadLabel')} htmlFor="sourceContent" error={uploadError ?? undefined}>
              <Textarea
                id="sourceContent"
                rows={5}
                value={content}
                onChange={event => setContent(event.target.value)}
                placeholder={t('sources.uploadPlaceholder')}
                aria-invalid={uploadError !== null}
              />
            </Field>
            <div className="flex justify-end">
              <GuardedButton
                action="episode:write"
                size="sm"
                disabled={uploading || !content.trim()}
                onClick={() => void upload()}
              >
                <UploadIcon />
                {uploading ? t('sources.uploading') : t('sources.upload')}
              </GuardedButton>
            </div>
          </div>

          <VersionTable
            title={t('sources.sourceVersions')}
            icon={<FileTextIcon className="text-muted-foreground size-4" />}
            hint={t('sources.sourceVersionsHint')}
            versions={sourceVersions.data}
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
                    variant="ghost"
                    size="sm"
                    disabled={busy === `approve-source-${version.version}`}
                    onClick={() => void approveSource(version)}
                  >
                    {busy === `approve-source-${version.version}` ? t('sources.approving') : t('sources.approve')}
                  </GuardedButton>
                )}
                {version.status === 'APPROVED' && (
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
                )}
              </>
            )}
          />

          <VersionTable
            title={t('sources.scriptVersions')}
            icon={<ScrollTextIcon className="text-muted-foreground size-4" />}
            hint={t('sources.scriptVersionsHint')}
            versions={scriptVersions.data}
            loading={scriptVersions.loading}
            emptyTitle={t('sources.noScripts')}
            emptyHint={t('sources.noScriptsHint')}
            emptyIcon={<ScrollTextIcon />}
            kind="script"
            episodeId={episodeId}
            onSaved={reloadAll}
            renderActions={version =>
              version.status !== 'APPROVED' ? (
                <GuardedButton
                  action="episode:write"
                  variant="ghost"
                  size="sm"
                  disabled={busy === `approve-script-${version.version}`}
                  onClick={() => void approveScript(version)}
                >
                  {busy === `approve-script-${version.version}` ? t('sources.approving') : t('sources.approve')}
                </GuardedButton>
              ) : null
            }
          />
        </CardContent>
      )}
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
      toast.error(error instanceof Error ? error.message : t('error.generic'))
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
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
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
                    <p className="text-muted-foreground font-mono text-xs" title={version.checksum}>
                      {t('sources.chars', { count: version.contentLength })} · {version.checksum.slice(0, 12)}
                    </p>
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
