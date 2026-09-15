'use client'

import { ArrowRightIcon, BoxesIcon, CheckCircle2Icon, CircleAlertIcon } from 'lucide-react'
import Link from 'next/link'
import type { CapabilitySlot } from '@studio/domain'
import type { Binding, Catalog, Connection } from '@/lib/api'
import { translateEnum, useI18n, type TranslateFn } from '@/lib/i18n'
import type { AsyncState } from '@/lib/use-async'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TableSkeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/error-state'
import {
  bestCatalogCoverage,
  gapSlots,
  readyCount,
  slotReadiness,
  unwiredSlots,
  wiredRequiredSlots,
} from '@/lib/models/readiness'
import type { SlotReadiness } from '@/lib/models/readiness'

interface ReadinessPanelProps {
  connections: AsyncState<Connection[]>
  bindings: AsyncState<Binding[]>
  catalogs: Catalog[]
  onGoto: (tab: 'connections' | 'bindings') => void
}

export function ReadinessPanel({ connections, bindings, catalogs, onGoto }: ReadinessPanelProps) {
  const { t } = useI18n()

  const error = connections.error ?? bindings.error
  if (error)
    return (
      <ErrorState
        message={error}
        onRetry={() => {
          connections.reload()
          bindings.reload()
        }}
      />
    )

  const loading =
    (connections.loading || bindings.loading) && connections.data.length === 0 && bindings.data.length === 0
  if (loading)
    return (
      <Card>
        <TableSkeleton rows={5} columns={4} />
      </Card>
    )

  const readiness = slotReadiness(connections.data, bindings.data)
  const ready = readyCount(readiness)
  const requiredTotal = wiredRequiredSlots().length
  const gaps = gapSlots(readiness)
  // The headline and the call to action answer the required half only. An unbound optional
  // slot — voice, score, conditioning, the auditor — is a row in the table below with its own
  // consequence, not a model this installation has to go and buy.
  const requiredGaps = gaps.filter(item => item.usage.required)
  const coverage = bestCatalogCoverage(catalogs)
  const unwired = unwiredSlots(readiness)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {requiredGaps.length === 0 ? (
              <CheckCircle2Icon className="text-success size-4" />
            ) : (
              <CircleAlertIcon className="text-warning size-4" />
            )}
            {t('models.readiness.title')}
          </CardTitle>
          <CardDescription>
            {requiredGaps.length === 0
              ? t('models.readiness.allReady', { total: requiredTotal })
              : t('models.readiness.gaps', { ready, total: requiredTotal })}
          </CardDescription>
          <CardAction>
            <Badge variant={requiredGaps.length === 0 ? 'success' : 'outline'}>
              {t('models.readiness.score', { ready, total: requiredTotal })}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {coverage && (
            <p className="text-muted-foreground text-sm leading-relaxed">
              {coverage.missing.length === 0
                ? t('models.readiness.coverAll', { label: coverage.label, total: requiredTotal })
                : t('models.readiness.coverSome', {
                    label: coverage.label,
                    covered: coverage.covered.length,
                    total: requiredTotal,
                    slots: coverage.missing.map(slot => translateEnum(t, 'slots', slot)).join(t('common.listJoin')),
                  })}
            </p>
          )}
          {requiredGaps.length === 0 ? (
            <Button size="sm" asChild>
              <Link href="/projects">
                <ArrowRightIcon />
                {t('models.readiness.goProjects')}
              </Link>
            </Button>
          ) : (
            <div className="flex flex-wrap gap-2">
              {requiredGaps.some(gap => gap.state === 'missing') && (
                <Button size="sm" variant="outline" onClick={() => onGoto('connections')}>
                  <BoxesIcon />
                  {t('models.readiness.goConnections')}
                </Button>
              )}
              {requiredGaps.some(gap => gap.state === 'needsBinding') && (
                <Button size="sm" onClick={() => onGoto('bindings')}>
                  {t('models.readiness.goBindings')}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('models.slot')}</TableHead>
              <TableHead>{t('models.readiness.usedBy')}</TableHead>
              <TableHead>{t('models.readiness.demand')}</TableHead>
              <TableHead>{t('models.readiness.state')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {readiness
              .filter(item => item.usage.stages.length > 0 || item.usage.qcOnly)
              .map(item => (
                <SlotRow key={item.slot} item={item} />
              ))}
          </TableBody>
        </Table>
      </Card>

      {unwired.length > 0 && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t('models.readiness.unwired', {
            slots: unwired.map(item => translateEnum(t, 'slots', item.slot)).join(t('common.listJoin')),
          })}
        </p>
      )}
    </div>
  )
}

function SlotRow({ item }: { item: SlotReadiness }) {
  const { t } = useI18n()
  const stages = item.usage.stages.map(stage => translateEnum(t, 'generations.stage', stage)).join(t('common.listJoin'))
  const usedBy = item.usage.qcOnly ? t('models.readiness.qcOnly') : stages

  return (
    <TableRow>
      <TableCell className="font-medium">{translateEnum(t, 'slots', item.slot)}</TableCell>
      <TableCell className="text-muted-foreground text-sm">{usedBy}</TableCell>
      <TableCell>
        <Badge variant={item.usage.required ? 'outline' : 'muted'}>
          {item.usage.required ? t('models.readiness.required') : t('models.readiness.optional')}
        </Badge>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={badgeVariant(item.state)}>{t(`models.readiness.state.${item.state}`)}</Badge>
          <span className="text-muted-foreground text-xs">
            {t('models.readiness.candidates', { usable: item.usableCount, bindable: item.bindableCount })}
          </span>
          {item.projectOnly && <Badge variant="muted">{t('models.readiness.projectOnly')}</Badge>}
        </div>
        {item.state !== 'ready' && (
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{consequenceCopy(t, item.slot)}</p>
        )}
      </TableCell>
    </TableRow>
  )
}

function badgeVariant(state: SlotReadiness['state']): 'success' | 'warning' | 'destructive' {
  if (state === 'ready') return 'success'
  return state === 'needsBinding' ? 'warning' : 'destructive'
}

/**
 * What the user actually loses when a slot has no usable model. The four skippable
 * slots each degrade differently; a required one blocks its stage, which the usage
 * column already names.
 */
function consequenceCopy(t: TranslateFn, slot: CapabilitySlot): string {
  switch (slot) {
    case 'tts_voice':
      return t('models.readiness.consequence.tts_voice')
    case 'music_gen':
      return t('models.readiness.consequence.music_gen')
    case 'visual_audit':
      return t('models.readiness.consequence.visual_audit')
    case 'video_i2v':
      return t('models.readiness.consequence.video_i2v')
    default:
      return t('models.readiness.consequenceRequired')
  }
}
