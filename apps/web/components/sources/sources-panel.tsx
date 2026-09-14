'use client'

import { useCallback, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { BookTextIcon, FileTextIcon, RefreshCwIcon, ScrollTextIcon, UploadIcon } from 'lucide-react'
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
import { GuardedButton } from '@/components/permission'

/** Summary row shared by GET source-versions and GET script-versions. */
export interface VersionSummary {
  id: string
  version: number
  checksum: string
  status: string
  contentLength: number
}

interface ScriptApproveResponse {
  version: VersionSummary & { content: string }
  storyboardsUpdated: number
}

const EMPTY_VERSIONS: VersionSummary[] = []

/** Version rows carry the SCREAMING workflow enum; StatusBadge speaks lowercase tones. */
function toneFor(status: string): string {
  return status.toLowerCase()
}

interface SourcesPanelProps {
  episodeId: string | null
}

export function SourcesPanel({ episodeId }: SourcesPanelProps) {
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
        t('sources.scriptApproved', { version: version.version, count: result.storyboardsUpdated }),
      )
      reloadAll()
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
            versions={sourceVersions.data}
            loading={sourceVersions.loading}
            emptyTitle={t('sources.noSources')}
            emptyHint={t('sources.noSourcesHint')}
            emptyIcon={<FileTextIcon />}
            renderActions={version => (
              <div className="flex justify-end gap-1">
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
              </div>
            )}
          />

          <VersionTable
            title={t('sources.scriptVersions')}
            icon={<ScrollTextIcon className="text-muted-foreground size-4" />}
            versions={scriptVersions.data}
            loading={scriptVersions.loading}
            emptyTitle={t('sources.noScripts')}
            emptyHint={t('sources.noScriptsHint')}
            emptyIcon={<ScrollTextIcon />}
            renderActions={version =>
              version.status !== 'APPROVED' ? (
                <div className="flex justify-end">
                  <GuardedButton
                    action="episode:write"
                    variant="ghost"
                    size="sm"
                    disabled={busy === `approve-script-${version.version}`}
                    onClick={() => void approveScript(version)}
                  >
                    {busy === `approve-script-${version.version}` ? t('sources.approving') : t('sources.approve')}
                  </GuardedButton>
                </div>
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
  versions: VersionSummary[]
  loading: boolean
  emptyTitle: string
  emptyHint: string
  emptyIcon: ReactNode
  renderActions(version: VersionSummary): ReactNode
}

function VersionTable({
  title,
  icon,
  versions,
  loading,
  emptyTitle,
  emptyHint,
  emptyIcon,
  renderActions,
}: VersionTableProps) {
  const { t } = useI18n()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      {loading && versions.length === 0 ? (
        <TableSkeleton rows={2} columns={5} />
      ) : versions.length === 0 ? (
        <CardContent className="px-4">
          <EmptyState icon={emptyIcon} title={emptyTitle} description={emptyHint} />
        </CardContent>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-20">{t('sources.version')}</TableHead>
              <TableHead className="w-32">{t('common.status')}</TableHead>
              <TableHead className="w-36">{t('sources.checksum')}</TableHead>
              <TableHead className="w-24">{t('sources.length')}</TableHead>
              <TableHead className="text-right">{t('common.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map(version => (
              <TableRow key={version.id}>
                <TableCell className="font-medium">v{version.version}</TableCell>
                <TableCell>
                  <StatusBadge status={toneFor(version.status)} label={t(`status.${toneFor(version.status)}`)} />
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs" title={version.checksum}>
                  {version.checksum.slice(0, 12)}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs tabular-nums">
                  {t('sources.chars', { count: version.contentLength })}
                </TableCell>
                <TableCell className="text-right">{renderActions(version)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  )
}
