'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRightIcon, ChevronLeftIcon, ChevronRightIcon, CoinsIcon, RefreshCwIcon } from 'lucide-react'
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
import { Hint } from '@/components/ui/hint'
import { ErrorState } from '@/components/error-state'

/** The ledger's own vocabulary: prompt characters and bytes, never money. */
function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${bytes} B`
}

/** How many ledger rows a table shows before it pages. Totals stay pinned, rows scroll by page. */
const PAGE_SIZE = 8

/**
 * The same pager the member search uses: a fixed page of rows, prev/next, and an
 * honest "x–y of n" line — a table that simply grows unbounded eventually stops
 * being a table and becomes a wall.
 */
function TablePager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage(page: number): void }) {
  const { t } = useI18n()
  const from = page * PAGE_SIZE + 1
  const to = Math.min(total, (page + 1) * PAGE_SIZE)
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
      <p className="text-muted-foreground text-xs tabular-nums">{t('common.rowsShown', { from, to, total })}</p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" className="h-7" disabled={page === 0} onClick={() => onPage(page - 1)}>
          <ChevronLeftIcon />
          {t('common.prevPage')}
        </Button>
        <Button variant="outline" size="sm" className="h-7" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
          {t('common.nextPage')}
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  )
}

interface UsagePanelProps {
  /** Which scope this panel opens on. Null on both is the whole space. */
  episodeId?: string | null
  projectId?: string | null
  /** On the usage page the URL owns the scope, so the segments navigate; embedded, they re-read in place. */
  scopeFromUrl?: boolean
  /** On the usage page the H1 already says 用量; the card must not echo it or restate its unit note. */
  showTitle?: boolean
}

type Scope = 'episode' | 'project' | 'organization'

function pathFor(scope: Scope, ids: { episodeId: string | null; projectId: string | null }): string {
  if (scope === 'episode' && ids.episodeId) return `/usage?episodeId=${ids.episodeId}`
  if (scope === 'project' && ids.projectId) return `/usage?projectId=${ids.projectId}`
  return '/usage'
}

/** The usage page's own query names, which are not the API's. */
function hrefFor(scope: Scope, ids: { episodeId: string | null; projectId: string | null }): string {
  if (scope === 'episode' && ids.episodeId) return `/usage?project=${ids.projectId ?? ''}&episode=${ids.episodeId}`
  if (scope === 'project' && ids.projectId) return `/usage?project=${ids.projectId}`
  return '/usage'
}

interface Segment {
  scope: Scope
  label: string
  active: boolean
  href?: string
  onSelect?(): void
}

/**
 * A scope is a switch, so it is drawn as one: the current segment carries a fill and a
 * border. It used to be a line of uppercase text, which read as a caption and hid the fact
 * that anything could be changed here at all.
 */
function ScopeSegments({ segments, label }: { segments: Segment[]; label: string }) {
  if (segments.length < 2) return null
  return (
    <div
      role="group"
      aria-label={label}
      className="border-border/70 bg-muted/40 inline-flex items-center gap-0.5 rounded-lg border p-0.5"
    >
      {segments.map(segment => {
        const className = cn(
          'rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors',
          segment.active
            ? 'border-border bg-background text-foreground shadow-sm'
            : 'border-transparent text-muted-foreground hover:text-foreground',
        )
        return segment.href ? (
          <Link key={segment.scope} href={segment.href} aria-current={segment.active ? 'page' : undefined} className={className}>
            {segment.label}
          </Link>
        ) : (
          <button key={segment.scope} type="button" aria-pressed={segment.active} onClick={segment.onSelect} className={className}>
            {segment.label}
          </button>
        )
      })}
    </div>
  )
}

export function UsagePanel({ episodeId = null, projectId = null, scopeFromUrl = false, showTitle = true }: UsagePanelProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const urlScope: Scope = episodeId ? 'episode' : projectId ? 'project' : 'organization'
  const [stateScope, setStateScope] = useState<Scope>(urlScope)
  const scope = scopeFromUrl ? urlScope : stateScope

  const path = pathFor(scope, { episodeId, projectId })
  const load = useCallback(() => api<UsageReport>(path), [api, path])
  const usage = useAsync<UsageReport | null>(load, null)

  const report = usage.data
  const rows: UsageRow[] = report?.rows ?? []
  const total = report?.total
  const byProject: UsageProjectRow[] = report?.byProject ?? []

  // A page is a view over one report; when the report changes (scope switch,
  // reload) the view restarts at the first page rather than dangling on an index
  // that may no longer exist.
  const [rowsPage, setRowsPage] = useState(0)
  const [projectsPage, setProjectsPage] = useState(0)
  useEffect(() => {
    setRowsPage(0)
    setProjectsPage(0)
  }, [report])
  const rowsPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const safeRowsPage = Math.min(rowsPage, rowsPages - 1)
  const pagedRows = rows.slice(safeRowsPage * PAGE_SIZE, safeRowsPage * PAGE_SIZE + PAGE_SIZE)
  const projectsPages = Math.max(1, Math.ceil(byProject.length / PAGE_SIZE))
  const safeProjectsPage = Math.min(projectsPage, projectsPages - 1)
  const pagedProjects = byProject.slice(safeProjectsPage * PAGE_SIZE, safeProjectsPage * PAGE_SIZE + PAGE_SIZE)

  const segments: Segment[] = []
  if (episodeId) {
    segments.push({
      scope: 'episode',
      label: t('usage.scopeEpisode'),
      active: scope === 'episode',
      ...(scopeFromUrl ? { href: hrefFor('episode', { episodeId, projectId }) } : { onSelect: () => setStateScope('episode') }),
    })
  }
  if (projectId) {
    segments.push({
      scope: 'project',
      label: t('usage.scopeProject'),
      active: scope === 'project',
      ...(scopeFromUrl ? { href: hrefFor('project', { episodeId, projectId }) } : { onSelect: () => setStateScope('project') }),
    })
  }
  segments.push({
    scope: 'organization',
    label: t('usage.scopeOrganization'),
    active: scope === 'organization',
    ...(scopeFromUrl ? { href: hrefFor('organization', { episodeId, projectId }) } : { onSelect: () => setStateScope('organization') }),
  })

  // A failure is only actionable inside one episode: the board's queue is where the shot
  // that broke lives. Wider scopes show the count with nowhere to jump.
  const failedHref = scope === 'episode' && episodeId && projectId ? `/projects/${projectId}/episodes/${episodeId}` : null

  return (
    <Card>
      <CardHeader>
        {showTitle && (
          <>
            <CardTitle className="flex items-center gap-2">
              <CoinsIcon className="text-muted-foreground size-4" />
              {t('usage.title')}
            </CardTitle>
            <CardDescription>{t('usage.unitsHint')}</CardDescription>
          </>
        )}
        <CardAction>
          <div className="flex items-center gap-2">
            <ScopeSegments segments={segments} label={t('usage.scopeGroupLabel')} />
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
                    {pagedProjects.map(row => (
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
                {byProject.length > PAGE_SIZE && (
                  <TablePager page={safeProjectsPage} pages={projectsPages} total={byProject.length} onPage={setProjectsPage} />
                )}
              </div>
            )}

            {rows.length === 0 ? (
              <EmptyState
                className="px-6 py-10"
                icon={<CoinsIcon />}
                title={t('usage.empty')}
                description={t('usage.emptyHint')}
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link href="/models">{t('usage.emptyConnect')}</Link>
                  </Button>
                }
              />
            ) : (
              <div className="space-y-2">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>{t('usage.stage')}</TableHead>
                      <TableHead>{t('usage.model')}</TableHead>
                      <TableHead className="text-right">{t('usage.calls')}</TableHead>
                      <TableHead className="text-right">{t('usage.retried')}</TableHead>
                      <TableHead className="text-right">{t('usage.failed')}</TableHead>
                      <TableHead className="text-right">{t('usage.inputUnits')}</TableHead>
                      <TableHead className="text-right">{t('usage.outputUnits')}</TableHead>
                      <TableHead>{t('usage.binding')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pagedRows.map(row => (
                    <TableRow key={`${row.stage ?? '-'}-${row.provider}-${row.model}`}>
                      <TableCell className="font-medium">
                        {row.stage ? translateEnum(t, 'generations.stage', row.stage) : <span className="text-muted-foreground">{t('usage.orphanStage')}</span>}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">{row.provider} · {row.model}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.taskCount}</TableCell>
                      <TableCell className={cn('text-right tabular-nums', row.retriedTaskCount > 0 && 'text-warning-ink font-medium')}>{row.retriedTaskCount}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.failedTaskCount === 0 ? (
                          <span className="text-faint-foreground">0</span>
                        ) : failedHref ? (
                          <Hint text={t('usage.failedHint')}>
                            <Link
                              href={failedHref}
                              aria-label={`${row.failedTaskCount} · ${t('usage.failedHint')}`}
                              className="text-destructive-ink font-medium underline-offset-2 hover:underline"
                            >
                              {row.failedTaskCount}
                            </Link>
                          </Hint>
                        ) : (
                          <span className="text-destructive-ink font-medium">{row.failedTaskCount}</span>
                        )}
                      </TableCell>
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
                      <TableCell className={cn('text-right tabular-nums', total.failedTaskCount > 0 && 'text-destructive-ink font-medium')}>{total.failedTaskCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{total.inputUnits.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBytes(total.outputUnits)}</TableCell>
                      <TableCell />
                    </TableRow>
                  )}
                </TableBody>
              </Table>
                {rows.length > PAGE_SIZE && (
                  <TablePager page={safeRowsPage} pages={rowsPages} total={rows.length} onPage={setRowsPage} />
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
