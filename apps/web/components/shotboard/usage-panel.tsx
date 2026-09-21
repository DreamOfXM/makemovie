'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { ArrowRightIcon, CoinsIcon, RefreshCwIcon } from 'lucide-react'
import type { UsageProjectRow, UsageReport, UsageRow } from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TableSkeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/error-state'

/** The ledger's own vocabulary: prompt characters and bytes, never money. */
function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${bytes} B`
}

interface UsagePanelProps {
  /** Which scope this panel opens on. Null on both is the whole space. */
  episodeId?: string | null
  projectId?: string | null
  /** Inside an episode the reader can widen to the project; on a scoped page there is nothing to widen to. */
  allowEpisodeSwitch?: boolean
  /** On the usage page the H1 already says 用量账本; the card must not echo it. */
  showTitle?: boolean
}

function pathFor(scope: { episodeId: string | null; projectId: string | null }): string {
  if (scope.episodeId) return `/usage?episodeId=${scope.episodeId}`
  if (scope.projectId) return `/usage?projectId=${scope.projectId}`
  return '/usage'
}

export function UsagePanel({ episodeId = null, projectId = null, allowEpisodeSwitch = false, showTitle = true }: UsagePanelProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [scope, setScope] = useState<{ episodeId: string | null; projectId: string | null }>({ episodeId, projectId })

  const path = pathFor(scope)
  const load = useCallback(() => api<UsageReport>(path), [api, path])
  const usage = useAsync<UsageReport | null>(load, null)

  const report = usage.data
  const rows: UsageRow[] = report?.rows ?? []
  const total = report?.total
  const byProject: UsageProjectRow[] = report?.byProject ?? []

  // A project name is also the way out of the space ledger: each row drills into its own scope.
  const scopeLabel = scope.episodeId
    ? t('usage.scopeEpisode')
    : scope.projectId
      ? t('usage.scopeProject')
      : t('usage.scopeOrganization')

  return (
    <Card>
      <CardHeader>
        {showTitle && (
          <CardTitle className="flex items-center gap-2">
            <CoinsIcon className="text-muted-foreground size-4" />
            {t('usage.title')}
          </CardTitle>
        )}
        <CardDescription>{t('usage.unitsHint')}</CardDescription>
        <CardAction>
          <div className="flex items-center gap-1">
            {allowEpisodeSwitch && episodeId && (
              <>
                <Button
                  size="sm"
                  variant={scope.episodeId ? 'secondary' : 'ghost'}
                  className="h-7 text-xs"
                  onClick={() => setScope({ episodeId, projectId })}
                >
                  {t('usage.scopeEpisode')}
                </Button>
                <Button
                  size="sm"
                  variant={scope.episodeId ? 'ghost' : 'secondary'}
                  className="h-7 text-xs"
                  disabled={!projectId}
                  onClick={() => setScope({ episodeId: null, projectId })}
                >
                  {t('usage.scopeProject')}
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" className="h-7" onClick={usage.reload} disabled={usage.loading} aria-label={t('common.refresh')}>
              <RefreshCwIcon className={cn(usage.loading && 'animate-spin')} />
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-6">
        {usage.loading && !report ? (
          <TableSkeleton rows={3} columns={6} />
        ) : usage.error ? (
          <ErrorState message={usage.error} onRetry={usage.reload} />
        ) : (
          <>
            <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{scopeLabel}</p>

            {byProject.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">{t('usage.byProjectTitle')}</p>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>{t('projects.title')}</TableHead>
                      <TableHead className="text-right">{t('usage.calls')}</TableHead>
                      <TableHead className="text-right">{t('usage.inputUnits')}</TableHead>
                      <TableHead className="text-right">{t('usage.outputUnits')}</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {byProject.map(row => (
                      <TableRow key={row.projectId}>
                        <TableCell className="font-medium">{row.projectName}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.taskCount}</TableCell>
                        <TableCell className="text-muted-foreground text-right text-xs tabular-nums">{row.inputUnits.toLocaleString()}</TableCell>
                        <TableCell className="text-muted-foreground text-right text-xs tabular-nums">{formatBytes(row.outputUnits)}</TableCell>
                        <TableCell className="text-right">
                          <Button asChild variant="ghost" size="sm" className="text-muted-foreground">
                            <Link href={`/usage?project=${row.projectId}`}>
                              <span className="sr-only">{t('usage.openProjectLedger')}</span>
                              <ArrowRightIcon className="size-4" />
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {report?.ungrouped && (
                      <TableRow className="text-muted-foreground">
                        <TableCell className="text-xs">{t('usage.ungrouped')}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">—</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{report.ungrouped.inputUnits.toLocaleString()}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{formatBytes(report.ungrouped.outputUnits)}</TableCell>
                        <TableCell />
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            )}

            {rows.length === 0 ? (
              <EmptyState
                className="px-6 py-10"
                icon={<CoinsIcon />}
                title={t('usage.empty')}
                description={t('usage.emptyHint')}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t('usage.stage')}</TableHead>
                    <TableHead>{t('usage.model')}</TableHead>
                    <TableHead className="text-right">{t('usage.calls')}</TableHead>
                    <TableHead className="text-right">{t('usage.retried')}</TableHead>
                    <TableHead className="text-right">{t('usage.inputUnits')}</TableHead>
                    <TableHead className="text-right">{t('usage.outputUnits')}</TableHead>
                    <TableHead>{t('usage.binding')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(row => (
                    <TableRow key={`${row.stage ?? '-'}-${row.provider}-${row.model}`}>
                      <TableCell className="font-medium">
                        {row.stage ? translateEnum(t, 'generations.stage', row.stage) : <span className="text-muted-foreground">{t('usage.orphanStage')}</span>}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">{row.provider} · {row.model}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.taskCount}</TableCell>
                      <TableCell className={cn('text-right tabular-nums', row.retriedTaskCount > 0 && 'text-warning-ink font-medium')}>{row.retriedTaskCount}</TableCell>
                      <TableCell className="text-muted-foreground text-right text-xs tabular-nums">{row.inputUnits.toLocaleString()}</TableCell>
                      <TableCell className="text-muted-foreground text-right text-xs tabular-nums">{formatBytes(row.outputUnits)}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{row.binding?.connectionName ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                  {total && (
                    <TableRow className="border-t-2 font-medium">
                      <TableCell colSpan={2}>{t('usage.total')}</TableCell>
                      <TableCell className="text-right tabular-nums">{total.taskCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{total.retriedTaskCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{total.inputUnits.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBytes(total.outputUnits)}</TableCell>
                      <TableCell />
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
