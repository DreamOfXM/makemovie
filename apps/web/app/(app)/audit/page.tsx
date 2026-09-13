'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDownIcon, ChevronRightIcon, EraserIcon, RefreshCwIcon, ScrollTextIcon } from 'lucide-react'
import type { AuditEvent, AuditPage } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { cn, formatDateTime, relativeTime } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorState } from '@/components/error-state'
import { GuardedButton } from '@/components/permission'

const ALL = '__all__'
const PAGE_SIZE = 25

/** Tones keep a long log scannable: removals read red, creations green. */
function actionVariant(action: string): 'destructive' | 'success' | 'outline' {
  if (action.endsWith('.delete') || action.endsWith('.remove') || action === 'auth.logout') return 'destructive'
  if (action.endsWith('.create') || action === 'auth.register') return 'success'
  return 'outline'
}

export default function AuditPage() {
  const { t, locale } = useI18n()
  const { api, organizationId } = useSession()

  const [events, setEvents] = useState<AuditEvent[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionFilter, setActionFilter] = useState(ALL)
  const [knownActions, setKnownActions] = useState<string[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pruning, setPruning] = useState(false)

  const fetchPage = useCallback(
    async (before: string | null) => {
      setLoading(true)
      setError(null)
      try {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
        if (actionFilter !== ALL) query.set('action', actionFilter)
        if (before) query.set('before', before)
        const page = await api<AuditPage>(`/audit-events?${query.toString()}`)
        setEvents(current => (before ? [...current, ...page.events] : page.events))
        setNextCursor(page.nextCursor)
        setKnownActions(current => {
          const merged = new Set([...current, ...page.events.map(event => event.action)])
          return merged.size === current.length ? current : [...merged].sort()
        })
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t('error.generic'))
      } finally {
        setLoading(false)
      }
    },
    [api, actionFilter, organizationId, t],
  )

  // Changing the filter restarts the log from the newest event.
  useEffect(() => {
    setEvents([])
    setNextCursor(null)
    setExpanded(null)
    void fetchPage(null)
  }, [fetchPage])

  async function prune() {
    setPruning(true)
    try {
      const result = await api<{ pruned: number }>('/sessions/expired', { method: 'DELETE' })
      toast.success(t('audit.pruned', { count: result.pruned }))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t('error.generic'))
    } finally {
      setPruning(false)
    }
  }

  return (
    <>
      <PageHeader
        title={t('audit.title')}
        description={t('audit.subtitle')}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => fetchPage(null)} disabled={loading}>
              <RefreshCwIcon />
              {t('common.refresh')}
            </Button>
            <GuardedButton action="audit:read" variant="secondary" size="sm" disabled={pruning} onClick={prune}>
              <EraserIcon />
              {t('audit.prune')}
            </GuardedButton>
          </>
        }
      />

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-sm">{t('audit.title')}</CardTitle>
          <CardDescription>{t('common.count', { count: events.length })}</CardDescription>
          <CardAction>
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger size="sm" className="w-56" aria-label={t('audit.filterAction')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('audit.allActions')}</SelectItem>
                {knownActions.map(action => (
                  <SelectItem key={action} value={action}>
                    {action}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardAction>
        </CardHeader>

        {error ? (
          <div className="px-6">
            <ErrorState message={error} onRetry={() => fetchPage(null)} />
          </div>
        ) : loading && events.length === 0 ? (
          <TableSkeleton rows={6} columns={5} />
        ) : events.length === 0 ? (
          <div className="px-6">
            <EmptyState
              icon={<ScrollTextIcon />}
              title={actionFilter === ALL ? t('audit.noEvents') : t('audit.noResults')}
              description={actionFilter === ALL ? t('audit.noEventsHint') : undefined}
            />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('audit.time')}</TableHead>
                  <TableHead>{t('audit.action')}</TableHead>
                  <TableHead>{t('audit.entity')}</TableHead>
                  <TableHead>{t('audit.user')}</TableHead>
                  <TableHead className="text-right">{t('audit.payload')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map(event => (
                  <Fragment key={event.id}>
                    <TableRow
                      className={cn('cursor-pointer', expanded === event.id && 'bg-muted/50')}
                      onClick={() => setExpanded(current => (current === event.id ? null : event.id))}
                    >
                      <TableCell className="whitespace-nowrap">
                        <p>{formatDateTime(event.createdAt, locale)}</p>
                        <p className="text-muted-foreground text-xs">{relativeTime(event.createdAt, locale)}</p>
                      </TableCell>
                      <TableCell>
                        <Badge variant={actionVariant(event.action)} className="font-mono">
                          {event.action}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm">{event.entityType}</p>
                        <p className="text-muted-foreground max-w-[14rem] truncate font-mono text-xs">
                          {event.entityId}
                        </p>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {event.userEmail ?? <span className="italic">{t('audit.system')}</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-expanded={expanded === event.id}
                          aria-label={expanded === event.id ? t('common.hide') : t('common.show')}
                          onClick={click => {
                            click.stopPropagation()
                            setExpanded(current => (current === event.id ? null : event.id))
                          }}
                        >
                          {expanded === event.id ? <ChevronDownIcon /> : <ChevronRightIcon />}
                        </Button>
                      </TableCell>
                    </TableRow>
                    {expanded === event.id && (
                      <TableRow className="hover:bg-muted/50">
                        <TableCell colSpan={5} className="bg-muted/30 py-4">
                          <pre className="text-foreground overflow-x-auto font-mono text-xs leading-relaxed">
                            {JSON.stringify(event.payload, null, 2)}
                          </pre>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-col items-center gap-3 px-6">
              {nextCursor ? (
                <Button variant="outline" size="sm" disabled={loading} onClick={() => fetchPage(nextCursor)}>
                  {loading ? t('common.loading') : t('common.loadMore')}
                </Button>
              ) : (
                <p className="text-muted-foreground text-xs">{t('audit.endOfLog')}</p>
              )}
            </div>
          </>
        )}
      </Card>
    </>
  )
}
