'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  PlayIcon,
} from 'lucide-react'
import { translateEnum, useI18n, type TranslateFn } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import type { AsyncState } from '@/lib/use-async'
import type { Binding, CallEvidenceMap, Catalog, Connection } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ErrorState } from '@/components/error-state'
import { apiErrorMessage } from '@/lib/api-error'
import {
  bestCatalogCoverage,
  bindableCapabilities,
  candidatesForSlot,
  isHeldUp,
  readyCount,
  slotReadiness,
  unwiredSlots,
  wiredRequiredSlots,
  type SlotCallBlock,
  type SlotReadiness,
} from '@/lib/models/readiness'

interface ReadinessPanelProps {
  connections: AsyncState<Connection[]>
  bindings: AsyncState<Binding[]>
  catalogs: Catalog[]
  /** 真实调用履历；拉不到就是空表——「没有记录」不等于「跑不通」。 */
  callEvidence: CallEvidenceMap
  onGoto: (tab: 'connections' | 'bindings') => void
}

/** The name the one-click mock setup gives its connection; org-unique, so reuse it when present. */
const MOCK_CONNECTION_NAME = 'mock-preview'

/** The signed fetch `useSession().api` hands out, minus the React context it lives behind. */
type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>

/** Rows shown before the list folds: the one that matters plus two that do not. */
const VISIBLE_ROWS = 3

export function ReadinessPanel({ connections, bindings, catalogs, callEvidence, onGoto }: ReadinessPanelProps) {
  const { t } = useI18n()
  const { api, can } = useSession()
  const [expanded, setExpanded] = useState(false)
  const [whyOpen, setWhyOpen] = useState(false)
  const [mockBusy, setMockBusy] = useState(false)
  const [mockNote, setMockNote] = useState<string | null>(null)

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
        <CardContent className="space-y-3">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    )

  const readiness = slotReadiness(connections.data, bindings.data, callEvidence)
  // A slot resolved by no stage is not a step anyone is waiting on.
  const rows = readiness.filter(item => item.usage.stages.length > 0 || item.usage.qcOnly)
  // Pipeline order makes exactly one gap load-bearing: the earliest required step with nothing
  // usable. Whatever sits behind it cannot be reached whether it is bound or not.
  const head = rows.find(isHeldUp) ?? null
  const ranked = [...rows].sort((left, right) => rowRank(left, head) - rowRank(right, head))
  const hiddenCount = Math.max(ranked.length - VISIBLE_ROWS, 0)
  const ready = readyCount(readiness)
  const requiredTotal = wiredRequiredSlots().length
  const coverage = bestCatalogCoverage(catalogs)
  const unwired = unwiredSlots(readiness)
  const canWireMock = can('providers:manage') && can('bindings:manage')

  async function wireMock() {
    setMockBusy(true)
    setMockNote(null)
    try {
      const bound = await wireMockVendor(api)
      connections.reload()
      bindings.reload()
      setMockNote(t(bound > 0 ? 'models.readiness.mockDone' : 'models.readiness.mockNothing', { bound }))
    } catch (cause) {
      setMockNote(apiErrorMessage(cause, t))
    } finally {
      setMockBusy(false)
    }
  }

  const mockControl = canWireMock && (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground shrink-0"
          onClick={wireMock}
          disabled={mockBusy}
        >
          <PlayIcon />
          {mockBusy ? t('models.readiness.mockWorking') : t('models.readiness.mock')}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-sm">
        {t('models.readiness.mockHint')}
      </TooltipContent>
    </Tooltip>
  )

  const list = (
    <ul className="space-y-2">
      {(expanded ? ranked : ranked.slice(0, VISIBLE_ROWS)).map(item => (
        <SlotRow
          key={item.slot}
          item={item}
          isHead={item === head}
          gateSlot={head?.slot ?? null}
          rest={rows.length - 1}
          whyOpen={whyOpen}
          onWhy={() => setWhyOpen(value => !value)}
          onGoto={onGoto}
          t={t}
        />
      ))}
    </ul>
  )

  const foldButton = hiddenCount > 0 && (
    <Button
      size="sm"
      variant="ghost"
      className="text-muted-foreground w-full justify-center"
      onClick={() => setExpanded(value => !value)}
    >
      {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
      {t(expanded ? 'models.readiness.collapse' : 'models.readiness.expand', { count: hiddenCount })}
    </Button>
  )

  if (!head) {
    // Nothing required is missing: the panel confirms that instead of reporting on it.
    return (
      <div className="space-y-4">
        <div className="bg-card text-card-foreground flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-5 py-4 shadow-card">
          <CheckCircle2Icon className="text-success size-4 shrink-0" />
          <Button size="sm" asChild>
            <Link href="/projects">
              <ArrowRightIcon />
              {t('models.readiness.goProjects')}
            </Link>
          </Button>
          <p className="text-muted-foreground text-sm">{t('models.readiness.allReady', { total: requiredTotal })}</p>
          {mockControl}
          <Badge variant="success" className="ml-auto">
            {t('models.readiness.score', { ready, total: requiredTotal })}
          </Badge>
        </div>
        {mockNote && (
          <p className="text-muted-foreground text-xs" role="status">
            {mockNote}
          </p>
        )}
        {list}
        {foldButton}
        <Footnotes coverage={coverage} coverageTotal={requiredTotal} unwired={unwired} t={t} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CircleAlertIcon className="text-destructive-ink size-4" />
            {t('models.readiness.conclusion', { total: rows.length, blockers: 1 })}
          </CardTitle>
          <CardDescription>{t('models.readiness.sortHint')}</CardDescription>
          <CardAction>{mockControl}</CardAction>
        </CardHeader>
        <CardContent className="space-y-2">
          {mockNote && (
            <p className="text-muted-foreground text-xs" role="status">
              {mockNote}
            </p>
          )}
          {list}
          {foldButton}
        </CardContent>
      </Card>
      <Footnotes coverage={coverage} coverageTotal={requiredTotal} unwired={unwired} t={t} />
    </div>
  )
}

function rowRank(item: SlotReadiness, head: SlotReadiness | null): number {
  if (item === head) return 0
  return isHeldUp(item) ? 1 : 2
}

function SlotRow({
  item,
  isHead,
  gateSlot,
  rest,
  whyOpen,
  onWhy,
  onGoto,
  t,
}: {
  item: SlotReadiness
  isHead: boolean
  gateSlot: string | null
  rest: number
  whyOpen: boolean
  onWhy: () => void
  onGoto: (tab: 'connections' | 'bindings') => void
  t: TranslateFn
}) {
  const stages = item.usage.stages.map(stage => translateEnum(t, 'generations.stage', stage)).join(t('common.listJoin'))
  const usedBy = item.usage.qcOnly ? t('models.readiness.qcOnly') : stages
  const isReady = item.state === 'ready'
  const block = item.callBlocked

  return (
    <li
      className={
        isHead ? 'border-destructive/60 bg-destructive/[0.04] rounded-xl border p-4' : 'border-border/60 rounded-xl border p-4'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{translateEnum(t, 'slots', item.slot)}</span>
            {isHead ? (
              <Badge variant="destructive">{t('models.readiness.blocking')}</Badge>
            ) : block ? (
              <Badge variant="warning">{t('models.readiness.state.callBlocked')}</Badge>
            ) : (
              <Badge variant="muted">
                {isReady ? t('models.readiness.state.ready') : t('models.readiness.waitingTurn')}
              </Badge>
            )}
            {item.projectOnly && <Badge variant="muted">{t('models.readiness.projectOnly')}</Badge>}
          </div>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {block ? callBlockedNote(t, block) : rowNote(item, isHead, gateSlot, rest, t)}
          </p>
          <p className="text-faint-foreground text-xs tabular-nums">
            {usedBy} · {t('models.readiness.candidates', { usable: item.usableCount, bindable: item.bindableCount })}
            {!isReady && ` · ${t(`models.readiness.state.${item.state}`)}`}
          </p>
          {isHead && (
            <div className="pt-1">
              <button
                type="button"
                onClick={onWhy}
                aria-expanded={whyOpen}
                className="text-muted-foreground inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
              >
                {whyOpen ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
                {t('models.readiness.whyFirst')}
              </button>
              {whyOpen && (
                <p className="text-muted-foreground mt-1 max-w-prose text-xs leading-relaxed">
                  {t('models.readiness.whyFirstBody')}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="shrink-0">
          <Button
            size="sm"
            variant={isHead ? 'default' : 'outline'}
            onClick={() => onGoto(item.state === 'missing' ? 'connections' : 'bindings')}
          >
            {isHead
              ? t(isReady ? 'models.readiness.changeModel' : 'models.readiness.goSlot')
              : isReady
                ? t('models.readiness.viewBinding')
                : t('models.readiness.goModel')}
          </Button>
        </div>
      </div>
    </li>
  )
}

/** 只有这三类因是终局的：充值、开权限、改参数之前，重跑不会改变结果。 */
function callBlockedNote(t: TranslateFn, block: SlotCallBlock): string {
  return t('models.readiness.callBlockedNote', {
    models: block.models.join(t('common.listJoin')),
    day: block.at.slice(0, 10),
    reason: t(`shotboard.failure.${block.kind}`),
  })
}

/**
 * The row's own sentence: what the blocking step would give you, what the steps behind it are
 * waiting for, and what an optional step costs when it stays unbound.
 */
function rowNote(item: SlotReadiness, isHead: boolean, gateSlot: string | null, rest: number, t: TranslateFn): string {
  if (isHead) return promiseCopy(t, item.slot, rest)
  if (item.state === 'ready') return t('models.readiness.running')
  if (!item.usage.required) return `${t('models.readiness.skippable')} · ${consequenceCopy(t, item.slot)}`
  return gateSlot
    ? t('models.readiness.behind', { slot: translateEnum(t, 'slots', gateSlot) })
    : consequenceCopy(t, item.slot)
}

/** What connecting this step buys you. Only the four required slots can lead, so only they speak. */
function promiseCopy(t: TranslateFn, slot: SlotReadiness['slot'], rest: number): string {
  const key = `models.readiness.promise.${slot}`
  const line = t(key, { rest })
  return line === key ? t('models.readiness.promiseDefault', { rest }) : line
}

/** What the user actually loses when a slot has no usable model. */
function consequenceCopy(t: TranslateFn, slot: SlotReadiness['slot']): string {
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

function Footnotes({
  coverage,
  coverageTotal,
  unwired,
  t,
}: {
  coverage: ReturnType<typeof bestCatalogCoverage>
  coverageTotal: number
  unwired: SlotReadiness[]
  t: TranslateFn
}) {
  return (
    <>
      {coverage && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          {coverage.missing.length === 0
            ? t('models.readiness.coverAll', { label: coverage.label, total: coverageTotal })
            : t('models.readiness.coverSome', {
                label: coverage.label,
                covered: coverage.covered.length,
                total: coverageTotal,
                slots: coverage.missing.map(slot => translateEnum(t, 'slots', slot)).join(t('common.listJoin')),
              })}
        </p>
      )}
      {unwired.length > 0 && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t('models.readiness.unwired', {
            slots: unwired.map(item => translateEnum(t, 'slots', item.slot)).join(t('common.listJoin')),
          })}
        </p>
      )}
    </>
  )
}

/**
 * The exit in front of a blocked user: create the keyless mock connection if the org has none,
 * probe it so its models count as verified, then point every step that still has nothing at the
 * first model the binding rules accept. Additive — a step a real vendor already covers is left
 * alone, and everything written here stays editable on the other tabs.
 */
async function wireMockVendor(api: ApiFetch): Promise<number> {
  const list = await api<Connection[]>('/providers/connections')
  let mock = list.find(connection => connection.provider === 'mock')
  if (!mock) {
    const created = await api<Connection>('/providers/connections', {
      method: 'POST',
      body: JSON.stringify({ provider: 'mock', name: MOCK_CONNECTION_NAME, apiKey: 'mock-offline' }),
    })
    await api(`/providers/connections/${created.id}/probe`, { method: 'POST' })
    mock = (await api<Connection[]>('/providers/connections')).find(connection => connection.id === created.id) ?? created
  }
  if (!mock.enabled) return 0

  const freshConnections = await api<Connection[]>('/providers/connections')
  const freshBindings = await api<Binding[]>('/bindings')
  const pool = bindableCapabilities(freshConnections)
  const gaps = slotReadiness(freshConnections, freshBindings).filter(
    item => (item.usage.stages.length > 0 || item.usage.qcOnly) && item.state !== 'ready',
  )
  let bound = 0
  for (const gap of gaps) {
    const [candidate] = candidatesForSlot(pool, gap.slot)
    if (!candidate) continue
    await api('/bindings', {
      method: 'POST',
      body: JSON.stringify({ slot: gap.slot, capabilityId: candidate.capabilityId }),
    })
    bound += 1
  }
  return bound
}
