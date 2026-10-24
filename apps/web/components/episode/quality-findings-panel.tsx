'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { apiErrorMessage } from '@/lib/api-error'
import {
  CheckIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  InfoIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  MapPinIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { ApiError } from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import {
  decideFinding,
  findingActionable,
  listQualityFindings,
  runQualityReview,
  sortFindingsBySeverity,
  type FindingDecisionAction,
  type QualityFinding,
  type QualitySnapshot,
} from '@/lib/quality-findings'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import type { BadgeVariant } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'

const SEVERITY_TONE: Record<string, { variant: BadgeVariant; icon: typeof CircleXIcon }> = {
  blocking: { variant: 'destructive', icon: CircleXIcon },
  warning: { variant: 'warning', icon: TriangleAlertIcon },
  info: { variant: 'muted', icon: InfoIcon },
}

const STATUS_TONE: Record<string, BadgeVariant> = {
  open: 'secondary',
  accepted: 'success',
  resolved: 'success',
  stale: 'muted',
}

interface QualityFindingsPanelProps {
  episodeId: string
  /** 行点击定位镜头：页面把它接到流程页已有的 shot-<id> 锚点滚动上。 */
  onLocateShot(storyboardId: string): void
}

/**
 * US-034 质量问题队列：技术检查的 findings 逐条列出，人工接受（带理由）或标记
 * 已修复；stale 行（母带已变、结论失效）淡显且不可再裁决。检查始终跑在最新
 * 合成母带上，「重新检查」重跑并整表刷新。
 */
export function QualityFindingsPanel({ episodeId, onLocateShot }: QualityFindingsPanelProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const canDecide = can('episode:write')

  const [rechecking, setRechecking] = useState(false)
  const [decisionTarget, setDecisionTarget] = useState<{ finding: QualityFinding; action: FindingDecisionAction } | null>(null)

  const load = useCallback(() => listQualityFindings(api, episodeId), [api, episodeId])
  const snapshot = useAsync<QualitySnapshot | null>(load, null)
  const { reload } = snapshot

  async function recheck() {
    setRechecking(true)
    try {
      const next = await runQualityReview(api, episodeId)
      // POST 返回的是本次检查的原始 findings（manifest 快照），队列的真实状态
      // （同快照保留的裁决、自动结案的行、stale 标记）在 GET 那一侧——重读而不是
      // 拿 POST 响应直接铺，否则刚保留下来的裁决会被「全部 open」盖掉。
      reload()
      toast.success(t('quality.recheckDone', { count: next.findings.length }))
    } catch (error) {
      // 409 = 没有可检查的母带：这是流程位置问题，不是故障，用提示不用报错。
      if (error instanceof ApiError && error.status === 409) toast.message(t('quality.recheckNoMaster'))
      else toast.error(apiErrorMessage(error, t))
    } finally {
      setRechecking(false)
    }
  }

  const findings = snapshot.data ? sortFindingsBySeverity(snapshot.data.findings) : []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <ListChecksIcon className="text-muted-foreground size-4" />
          {t('quality.title')}
          {snapshot.data && <VerdictBadge passed={snapshot.data.passed} count={snapshot.data.findings.length} />}
        </CardTitle>
        <CardDescription>{t('quality.subtitle')}</CardDescription>
        <CardAction>
          <GuardedButton
            action="episode:write"
            size="sm"
            variant="outline"
            disabled={rechecking}
            onClick={() => void recheck()}
          >
            <RefreshCwIcon className={cn(rechecking && 'animate-spin')} />
            {rechecking ? t('quality.rechecking') : t('quality.recheck')}
          </GuardedButton>
        </CardAction>
      </CardHeader>

      {snapshot.error ? (
        <CardContent>
          <ErrorState message={snapshot.error} onRetry={reload} />
        </CardContent>
      ) : snapshot.loading && snapshot.data === null ? (
        <CardContent>
          <TableSkeleton rows={2} columns={4} />
        </CardContent>
      ) : snapshot.data === null ? (
        <CardContent>
          <EmptyState icon={<ListChecksIcon />} title={t('quality.emptyTitle')} description={t('quality.emptyHint')} />
        </CardContent>
      ) : findings.length === 0 ? (
        <CardContent>
          <EmptyState icon={<CircleCheckIcon />} title={t('quality.passedTitle')} description={t('quality.passedHint')} />
        </CardContent>
      ) : (
        <CardContent className="space-y-3">
          {!canDecide && <p className="text-muted-foreground text-xs">{t('workbench.readonlyNotice')}</p>}
          <QualityFindingsTable
            findings={findings}
            canDecide={canDecide}
            onAccept={finding => setDecisionTarget({ finding, action: 'accept' })}
            onResolve={finding => setDecisionTarget({ finding, action: 'resolve' })}
            onLocateShot={onLocateShot}
          />
        </CardContent>
      )}

      <DecisionDialog
        target={decisionTarget}
        onOpenChange={open => !open && setDecisionTarget(null)}
        onDecided={() => {
          setDecisionTarget(null)
          reload()
        }}
      />
    </Card>
  )
}

function VerdictBadge({ passed, count }: { passed: boolean | null; count: number }) {
  const { t } = useI18n()
  if (passed === true) {
    return (
      <Badge variant="success" className="font-normal">
        <CircleCheckIcon />
        {t('quality.verdictPassed')}
      </Badge>
    )
  }
  if (passed === false) {
    return (
      <Badge variant="destructive" className="font-normal">
        <CircleXIcon />
        {t('quality.verdictFailed')}
      </Badge>
    )
  }
  return (
    <Badge variant="muted" className="font-normal">
      <CircleDashedIcon />
      {t('quality.verdictUnknown')}
    </Badge>
  )
}

interface QualityFindingsTableProps {
  findings: QualityFinding[]
  /** 无裁决权限时按钮全部禁用（只读角色看得见队列、按不动）。 */
  canDecide: boolean
  onAccept(finding: QualityFinding): void
  onResolve(finding: QualityFinding): void
  onLocateShot(storyboardId: string): void
}

/** 纯展示列表：不碰 session/api，测试可以直接渲染断言。 */
export function QualityFindingsTable({ findings, canDecide, onAccept, onResolve, onLocateShot }: QualityFindingsTableProps) {
  const { t } = useI18n()
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-24">{t('quality.severity')}</TableHead>
          <TableHead className="w-28">{t('quality.dimension')}</TableHead>
          <TableHead>{t('quality.message')}</TableHead>
          <TableHead className="w-20">{t('quality.evidenceAt')}</TableHead>
          <TableHead className="w-24">{t('common.status')}</TableHead>
          <TableHead className="w-56 text-right">{t('common.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {findings.map(finding => (
          <QualityFindingRow
            key={finding.id}
            finding={finding}
            canDecide={canDecide}
            onAccept={onAccept}
            onResolve={onResolve}
            onLocateShot={onLocateShot}
          />
        ))}
      </TableBody>
    </Table>
  )
}

interface QualityFindingRowProps {
  finding: QualityFinding
  canDecide: boolean
  onAccept(finding: QualityFinding): void
  onResolve(finding: QualityFinding): void
  onLocateShot(storyboardId: string): void
}

function QualityFindingRow({ finding, canDecide, onAccept, onResolve, onLocateShot }: QualityFindingRowProps) {
  const { t } = useI18n()
  const actionable = canDecide && findingActionable(finding)
  const decided = finding.status === 'accepted' || finding.status === 'resolved'

  return (
    <TableRow
      // stale = 这条结论指向旧母带，整行淡显；accepted/resolved 保持正常读态。
      className={cn(finding.status === 'stale' && 'opacity-60', finding.storyboardId && 'cursor-pointer')}
      onClick={() => finding.storyboardId && onLocateShot(finding.storyboardId)}
    >
      <TableCell>
        <SeverityBadge severity={finding.severity} />
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {finding.dimension ? translateEnum(t, 'quality.dimension', finding.dimension) : '—'}
      </TableCell>
      <TableCell>
        <p className="text-sm">{finding.message}</p>
        {/* 可读摘要：谁在何时以什么理由裁决了这条，列表本身就能复盘。 */}
        {decided && (finding.decidedBy || finding.reason) && (
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t('quality.decidedLine', { who: finding.decidedBy ?? '—', reason: finding.reason ?? '—' })}
          </p>
        )}
        {finding.status === 'stale' && (
          <p className="text-muted-foreground mt-0.5 text-xs">{t('quality.staleNote')}</p>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs tabular-nums">
        {finding.evidenceTimeSeconds !== null ? formatDuration(finding.evidenceTimeSeconds * 1000) : '—'}
      </TableCell>
      <TableCell>
        <Badge variant={STATUS_TONE[finding.status] ?? 'secondary'} className="font-normal">
          {translateEnum(t, 'quality.status', finding.status)}
        </Badge>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {finding.storyboardId && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('quality.locateShot')}
              onClick={event => {
                event.stopPropagation()
                onLocateShot(finding.storyboardId!)
              }}
            >
              <MapPinIcon />
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={!actionable} onClick={event => { event.stopPropagation(); onAccept(finding) }}>
            <CheckIcon />
            {t('quality.accept')}
          </Button>
          <Button variant="outline" size="sm" disabled={!actionable} onClick={event => { event.stopPropagation(); onResolve(finding) }}>
            <CircleCheckIcon />
            {t('quality.resolve')}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

function SeverityBadge({ severity }: { severity: string }) {
  const { t } = useI18n()
  const tone = SEVERITY_TONE[severity] ?? SEVERITY_TONE.info
  const Icon = tone.icon
  return (
    <Badge variant={tone.variant} className="font-normal">
      <Icon />
      {translateEnum(t, 'quality.severity', severity)}
    </Badge>
  )
}

interface DecisionTarget {
  finding: QualityFinding
  action: FindingDecisionAction
}

interface DecisionDialogProps {
  target: DecisionTarget | null
  onOpenChange(open: boolean): void
  onDecided(): void
}

/**
 * 接受/标记修复共用的理由弹窗：两种动作后端都要求理由（400 拒空）。
 * 冲突（409：已被裁决或已 stale）不弹错——关窗、刷新、一句话说明。
 */
function DecisionDialog({ target, onOpenChange, onDecided }: DecisionDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!target) return
    setReason('')
    setError('')
  }, [target])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!target) return
    setBusy(true)
    setError('')
    try {
      const result = await decideFinding(api, target.finding.id, target.action, reason)
      if (result.ok) {
        toast.success(t(target.action === 'accept' ? 'quality.acceptedToast' : 'quality.resolvedToast'))
        onDecided()
      } else if (result.kind === 'reasonRequired') {
        setError(t('quality.reasonRequired'))
      } else {
        toast.error(t('quality.decideConflict'))
        onDecided()
      }
    } catch (err) {
      setError(apiErrorMessage(err, t))
    } finally {
      setBusy(false)
    }
  }

  const finding = target?.finding ?? null
  return (
    <Dialog open={target !== null} onOpenChange={open => !busy && onOpenChange(open)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(target?.action === 'resolve' ? 'quality.resolveTitle' : 'quality.acceptTitle')}</DialogTitle>
          <DialogDescription>{t('quality.decideHint')}</DialogDescription>
        </DialogHeader>
        {finding && (
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={finding.severity} />
                <span className="text-muted-foreground text-xs">{translateEnum(t, 'quality.dimension', finding.dimension)}</span>
                {finding.evidenceTimeSeconds !== null && (
                  <span className="text-muted-foreground text-xs tabular-nums">{formatDuration(finding.evidenceTimeSeconds * 1000)}</span>
                )}
              </p>
              <p className="mt-1">{finding.message}</p>
            </div>
            <form onSubmit={submit} className="space-y-4">
              <Field label={t('storyboards.reason')} htmlFor="findingReason" required error={error || undefined}>
                <Textarea
                  id="findingReason"
                  rows={3}
                  value={reason}
                  onChange={event => setReason(event.target.value)}
                  placeholder={t('quality.reasonPlaceholder')}
                  required
                  autoFocus
                  aria-invalid={error !== ''}
                />
              </Field>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" disabled={busy || !reason.trim()}>
                  {busy ? <LoaderCircleIcon className="animate-spin" /> : null}
                  {busy ? t('common.saving') : t(target?.action === 'resolve' ? 'quality.resolve' : 'quality.accept')}
                </Button>
              </DialogFooter>
            </form>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
