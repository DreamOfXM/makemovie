'use client'

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  BanIcon,
  CaptionsIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClapperboardIcon,
  FilmIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ScrollTextIcon,
  SparklesIcon,
  XCircleIcon,
} from 'lucide-react'
import {
  type EpisodeComposition,
  type GenerationArtifact,
  type GenerationBatch,
  type GenerationPlan,
  type GenerationStage,
  type GenerationTask,
  type GenerationsResponse,
  type Storyboard,
} from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { pipelineGateMessage } from '@/lib/pipeline-errors'
import { HelpHint } from '@/components/ui/help-hint'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn, formatDateTime, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton, TableSkeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/ui/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'
import { ArtifactMedia, useArtifactUrl } from '@/components/generations/artifact-media'

const POLL_INTERVAL_MS = 3000

const EMPTY: GenerationsResponse = { batches: [], composition: null }

/** The three stages that belong to one shot rather than to the whole episode. */
type ShotStage = 'IMAGE' | 'VIDEO' | 'AUDIO'

/** Stages this panel owns. SCRIPT/ASSET/STORYBOARD live in their own panels' triggers. */
const MEDIA_STAGES: readonly GenerationStage[] = ['IMAGE', 'VIDEO', 'AUDIO', 'MUSIC']

/** Maps the pipeline's SCREAMING_SNAKE statuses onto the workflow tones StatusBadge already renders. */
const statusTone: Record<string, string> = {
  QUEUED: 'ready',
  PENDING: 'draft',
  RUNNING: 'running',
  SUCCEEDED: 'completed',
  FAILED: 'blocked',
  BLOCKED: 'needs_review',
  CANCELLED: 'cancelled',
}

function toneFor(status: string): string {
  return statusTone[status] ?? status.toLowerCase()
}

interface GenerationsPanelProps {
  episodeId: string | null
  /** Bumped by the workspace's one-click advance so a freshly created batch shows up at once. */
  reloadToken?: number
  /** Live shots, in shot order: the media view is organised around them, not around batches. */
  storyboards: Storyboard[]
}

export function GenerationsPanel({ episodeId, reloadToken = 0, storyboards }: GenerationsPanelProps) {
  const { t, locale } = useI18n()
  const { api, organizationId } = useSession()
  const { can } = usePermission()

  const [triggering, setTriggering] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [composing, setComposing] = useState(false)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const loadGenerations = useCallback(
    () =>
      episodeId
        ? api<GenerationsResponse>(`/episodes/${episodeId}/generations`)
        : Promise.resolve<GenerationsResponse>(EMPTY),
    // organizationId is not in the path but scopes the session token behind `api`.
    [api, episodeId, organizationId, reloadToken],
  )
  const generations = useAsync<GenerationsResponse>(loadGenerations, EMPTY)
  const { reload } = generations

  const batches = useMemo(
    () => [...generations.data.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [generations.data],
  )

  // Which shot each task made is consulted by the shot board above through its own
  // poll of the same endpoint; this panel only needs the batch timeline.
  const active = useMemo(
    () =>
      generations.data.batches.some(batch =>
        batch.tasks.some(task => task.status === 'QUEUED' || task.status === 'RUNNING'),
      ) || generations.data.composition?.status === 'RUNNING',
    [generations.data],
  )

  // Poll while anything is in flight so the console tracks the pipeline without manual refreshes.
  useEffect(() => {
    if (!episodeId || !active) return
    const timer = setInterval(reload, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [episodeId, active, reload])

  // 批量触发先过计划预审:GET 计划(与触发同一套门禁),确认框摊开新烧/重试/
  // 已覆盖与模型名单,人点头才 POST。跳过预审=整阶段盲烧,竞品调研里最被
  // 诟病的正是这一步。
  const [pendingPlan, setPendingPlan] = useState<{ stage: GenerationStage; regenerate: boolean; plan: GenerationPlan } | null>(null)

  async function requestTrigger(next: GenerationStage, isRegenerate: boolean) {
    if (!episodeId) return
    if (isRegenerate) setRegenerating(true)
    else setTriggering(true)
    try {
      const query = `stage=${next}&regenerate=${isRegenerate ? 1 : 0}`
      const { plan } = await api<{ plan: GenerationPlan }>(`/episodes/${episodeId}/generation-plan?${query}`)
      if (plan.newCount + plan.retryCount === 0) {
        toast.message(isRegenerate ? t('generations.planRegenerateEmpty') : t('generations.planNothingToDo'))
      } else {
        setPendingPlan({ stage: next, regenerate: isRegenerate, plan })
      }
    } catch (error) {
      toast.error(pipelineGateMessage(error, t, locale) ?? (error instanceof Error ? error.message : t('error.generic')))
    } finally {
      setTriggering(false)
      setRegenerating(false)
    }
  }

  async function confirmTrigger() {
    if (!episodeId || !pendingPlan) return
    const { stage, regenerate } = pendingPlan
    setPendingPlan(null)
    if (regenerate) setRegenerating(true)
    else setTriggering(true)
    try {
      await api(`/episodes/${episodeId}/generations`, { method: 'POST', body: JSON.stringify({ stage, ...(regenerate ? { regenerate: true } : {}) }) })
      toast.success(
        regenerate
          ? t('generations.regenerated', { stage: translateEnum(t, 'generations.stage', stage) })
          : t('generations.triggered', { stage: translateEnum(t, 'generations.stage', stage) }),
      )
      reload()
    } catch (error) {
      toast.error(pipelineGateMessage(error, t, locale) ?? (error instanceof Error ? error.message : t('error.generic')))
    } finally {
      setTriggering(false)
      setRegenerating(false)
    }
  }

  // 一键重试失败项:走触发端点的幂等路径——同幂等键撞库时 SUCCEEDED/QUEUED/RUNNING
  // 不动、只把 FAILED 重置排队，所以点了不会重烧已经成功的镜头。
  // busy 必须盖过「请求返回→数据刷新」的空窗，否则按钮转圈一闪界面纹丝不动。
  const [retryingStage, setRetryingStage] = useState<GenerationStage | null>(null)

  async function retryFailed(stage: GenerationStage) {
    if (!episodeId || retryingStage) return
    setRetryingStage(stage)
    try {
      await api(`/episodes/${episodeId}/generations`, { method: 'POST', body: JSON.stringify({ stage }) })
      toast.success(t('generations.retryQueued', { stage: translateEnum(t, 'generations.stage', stage) }))
      reload()
      await new Promise(resolve => setTimeout(resolve, 900))
    } catch (error) {
      toast.error(pipelineGateMessage(error, t, locale) ?? (error instanceof Error ? error.message : t('error.generic')))
    } finally {
      setRetryingStage(null)
    }
  }

  // 整集媒体重生成:首帧 → 等落定 → 视频 → 等落定 → 配音。前一层完成才触发
  // 下一层,否则会撞上"首帧在途"门禁;轮询批次状态判断落定。
  const [regenAllStage, setRegenAllStage] = useState<'IMAGE' | 'VIDEO' | 'AUDIO' | null>(null)
  const [confirmRegenAll, setConfirmRegenAll] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  async function triggerStageRegenerate(stage: ShotStage): Promise<void> {
    await api(`/episodes/${episodeId}/generations`, { method: 'POST', body: JSON.stringify({ stage, regenerate: true }) })
  }

  async function waitForStageSettled(stage: 'IMAGE' | 'VIDEO' | 'AUDIO', maxMs = 15 * 60 * 1000): Promise<boolean> {
    const dbStage = stage === 'IMAGE' ? 'FIRST_FRAME' : stage
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      await new Promise(resolve => setTimeout(resolve, 5000))
      const data = await api<{ batches: Array<{ stage: string; tasks: Array<{ status: string }> }> }>(`/episodes/${episodeId}/generations`)
      const busy = data.batches.some(
        batch => batch.stage === dbStage && batch.tasks.some(task => task.status === 'QUEUED' || task.status === 'RUNNING'),
      )
      reload()
      if (!busy) return true
    }
    return false
  }

  async function regenerateAllMedia() {
    if (!episodeId) return
    setConfirmRegenAll(false)
    const stages: Array<'IMAGE' | 'VIDEO' | 'AUDIO'> = ['IMAGE', 'VIDEO', 'AUDIO']
    try {
      for (const stage of stages) {
        setRegenAllStage(stage)
        await triggerStageRegenerate(stage)
        const settled = await waitForStageSettled(stage)
        if (!settled) throw new Error(t('generations.regenAllTimeout'))
      }
      toast.success(t('generations.regenAllDone'))
    } catch (error) {
      toast.error(pipelineGateMessage(error, t, locale) ?? (error instanceof Error ? error.message : t('error.generic')))
    } finally {
      setRegenAllStage(null)
      reload()
    }
  }

  async function compose() {
    if (!episodeId) return
    setComposing(true)
    try {
      await api(`/episodes/${episodeId}/compositions`, { method: 'POST' })
      toast.success(t('generations.composeStarted'))
      reload()
    } catch (error) {
      toast.error(pipelineGateMessage(error, t, locale) ?? (error instanceof Error ? error.message : t('error.generic')))
    } finally {
      setComposing(false)
    }
  }

  async function cancelTask(task: GenerationTask) {
    setCancellingId(task.id)
    try {
      await api(`/generations/tasks/${task.id}/cancel`, { method: 'POST' })
      toast.success(t('generations.taskCancelled'))
      reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setCancellingId(null)
    }
  }

  // 批量停止:只掐排队中的(一掐就停、零烧);执行中的等它自然结束——provider 请求
  // 已经发出,那部分次数已经花掉,硬断也只是拿不到产物。
  const [stoppingBatchId, setStoppingBatchId] = useState<string | null>(null)

  async function stopBatch(batch: GenerationBatch) {
    setStoppingBatchId(batch.id)
    try {
      const result = await api<{ cancelled: number }>(`/generations/batches/${batch.id}/cancel`, { method: 'POST' })
      toast.success(t('generations.batchStopped', { count: result.cancelled }))
      reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setStoppingBatchId(null)
    }
  }

  return (
    <>
      <Card id="step-media" className="scroll-mt-20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SparklesIcon className="text-muted-foreground size-4" />
            {t('generations.title')}
          </CardTitle>
          <CardDescription>{active ? t('generations.pollHint') : t('generations.mediaHint')}</CardDescription>
          {episodeId && (
            <CardAction>
              <div className="flex flex-wrap items-center gap-2">
                <StageMenuButton
                  actionIcon={<SparklesIcon />}
                  variant="default"
                  busy={triggering}
                  busyLabel={t('generations.triggering')}
                  idleLabel={t('generations.trigger')}
                  menuLabel={t('generations.triggerMenuLabel')}
                  onSelect={next => void requestTrigger(next, false)}
                />
                <HelpHint text={t('generations.triggerHint')} />
                <StageMenuButton
                  actionIcon={<RotateCwIcon />}
                  variant="outline"
                  busy={regenerating}
                  busyLabel={t('generations.regenerating')}
                  idleLabel={t('generations.regenerate')}
                  menuLabel={t('generations.regenerateMenuLabel')}
                  onSelect={next => void requestTrigger(next, true)}
                />
                <HelpHint text={t('generations.regenerateHint')} />
                {can('generation:trigger') && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        {regenAllStage ? <LoaderCircleIcon className="animate-spin" /> : <MoreHorizontalIcon />}
                        {regenAllStage
                          ? t(`generations.regenAllStage.${regenAllStage}`)
                          : t('generations.more')}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-80">
                      <DropdownMenuLabel>{t('generations.dangerZone')}</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        disabled={regenAllStage !== null}
                        onSelect={() => setConfirmRegenAll(true)}
                      >
                        <RotateCwIcon />
                        <span className="min-w-0">
                          {t('generations.regenAllMedia')}
                          <span className="text-muted-foreground block text-xs font-normal leading-relaxed">
                            {t('generations.regenAllMediaHint')}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Button variant="outline" size="sm" onClick={reload} disabled={generations.loading}>
                  <RefreshCwIcon className={cn(generations.loading && 'animate-spin')} />
                  {t('common.refresh')}
                </Button>
              </div>
            </CardAction>
          )}
        </CardHeader>

        {!episodeId ? (
          <CardContent>
            <EmptyState icon={<SparklesIcon />} title={t('generations.selectEpisode')} />
          </CardContent>
        ) : generations.error ? (
          <CardContent>
            <ErrorState message={generations.error} onRetry={reload} />
          </CardContent>
        ) : (
          <CardContent>
            {generations.loading && batches.length === 0 ? (
              <TableSkeleton rows={3} columns={5} />
            ) : batches.length === 0 && storyboards.length === 0 ? (
              <EmptyState
                icon={<SparklesIcon />}
                title={t('generations.noBatches')}
                description={t('generations.noBatchesHint')}
              />
            ) : (
              <div className="space-y-5">
                {/* 整集级动作只剩「更多」菜单里的整集重跑;逐镜产物与重做在上方镜头卡,这里只管批次与排障。 */}
                <p className="text-muted-foreground text-xs">{t('generations.silentByDesign')}</p>
                <div className="relative space-y-5 border-l pl-6">
                  {batches.slice(0, 1).map(batch => (
                    <div key={batch.id} className="relative">
                      <span
                        className="absolute -left-[31px] top-4 size-2.5 rounded-full border-2 border-background bg-primary"
                        aria-hidden
                      />
                      <p className="text-subtle-foreground mb-1.5 text-xs font-medium tabular-nums">
                        {formatDateTime(batch.createdAt, locale)}
                      </p>
                      <BatchCard
                        batch={batch}
                        storyboards={storyboards}
                        cancellingId={cancellingId}
                        defaultOpen
                        onCancel={cancelTask}
                        onRetry={() => void retryFailed(batch.stage)}
                        retrying={retryingStage === batch.stage}
                        onStop={() => void stopBatch(batch)}
                        stopping={stoppingBatchId === batch.id}
                      />
                    </div>
                  ))}
                  {batches.length > 1 && (() => {
                    const older = batches.slice(1)
                    const olderRunning = older.reduce(
                      (sum, batch) => sum + batch.tasks.filter(t => t.status === 'QUEUED' || t.status === 'RUNNING').length,
                      0,
                    )
                    const olderFailed = older.reduce(
                      (sum, batch) => sum + batch.tasks.filter(t => t.status === 'FAILED').length,
                      0,
                    )
                    return (
                      <div className="relative">
                        <span
                          className="absolute -left-[31px] top-3 size-2.5 rounded-full border-2 border-background bg-muted-foreground/40"
                          aria-hidden
                        />
                        <button
                          type="button"
                          aria-expanded={historyOpen}
                          onClick={() => setHistoryOpen(value => !value)}
                          className="hover:bg-accent/40 flex w-full flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors"
                        >
                          {historyOpen ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" />}
                          <span className="font-medium">
                            {historyOpen ? t('generations.historyHide') : t('generations.historyShow', { count: older.length })}
                          </span>
                          {olderRunning > 0 && (
                            <span className="text-primary flex items-center gap-1 text-xs font-medium">
                              <LoaderCircleIcon className="size-3.5 animate-spin" />
                              {t('generations.batchRunning', { count: olderRunning })}
                            </span>
                          )}
                          {olderFailed > 0 && (
                            <span className="text-destructive flex items-center gap-1 text-xs font-medium">
                              <XCircleIcon className="size-3.5" />
                              {t('generations.batchFailed', { count: olderFailed })}
                            </span>
                          )}
                        </button>
                        {historyOpen && older.map(batch => (
                          <div key={batch.id} className="relative mt-4">
                            <span
                              className="absolute -left-[31px] top-4 size-2.5 rounded-full border-2 border-background bg-muted-foreground/40"
                              aria-hidden
                            />
                            <p className="text-subtle-foreground mb-1.5 text-xs tabular-nums">
                              {formatDateTime(batch.createdAt, locale)}
                            </p>
                            <BatchCard
                              batch={batch}
                              storyboards={storyboards}
                              cancellingId={cancellingId}
                              defaultOpen={false}
                              onCancel={cancelTask}
                              onRetry={() => void retryFailed(batch.stage)}
                              retrying={retryingStage === batch.stage}
                              onStop={() => void stopBatch(batch)}
                              stopping={stoppingBatchId === batch.id}
                            />
                          </div>
                        ))}
                      </div>
                    )
                  })()}
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      <EpisodeTracksCard
        composition={generations.data.composition}
        batches={batches}
        composing={composing}
        onCompose={() => void compose()}
      />

      <AlertDialog open={confirmRegenAll} onOpenChange={setConfirmRegenAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('generations.regenAllTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('generations.regenAllConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void regenerateAllMedia()}>
              {t('generations.regenAllMedia')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PlanDialog pending={pendingPlan} onClose={() => setPendingPlan(null)} onConfirm={() => void confirmTrigger()} />
    </>
  )
}

/** 计划预审确认框:物理量(项数/时长/模型),没有任何钱相关的字段。 */
function PlanDialog({ pending, onClose, onConfirm }: {
  pending: { stage: GenerationStage; regenerate: boolean; plan: GenerationPlan } | null
  onClose(): void
  onConfirm(): void
}) {
  const { t } = useI18n()
  const plan = pending?.plan
  return (
    <Dialog open={pending !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {pending && plan && (
          <>
            <DialogHeader>
              <DialogTitle>{t('generations.planTitle', { stage: translateEnum(t, 'generations.stage', pending.stage) })}</DialogTitle>
              <DialogDescription>
                {pending.regenerate ? t('generations.planRegenerateNote') : t('generations.planNote')}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{t('generations.planNew', { count: plan.newCount })}</Badge>
              {plan.retryCount > 0 && <Badge variant="warning">{t('generations.planRetry', { count: plan.retryCount })}</Badge>}
              {plan.skippedCount > 0 && <Badge variant="muted">{t('generations.planSkipped', { count: plan.skippedCount })}</Badge>}
              {plan.durationMs !== null && <Badge variant="outline">{t('generations.planDuration', { duration: formatDuration(plan.durationMs) })}</Badge>}
            </div>
            <p className="text-muted-foreground text-xs">
              {t('generations.planModels')} <span className="text-foreground font-medium">{plan.models.join(' → ')}</span>
            </p>
            <ul className="max-h-60 space-y-1 overflow-y-auto text-xs">
              {plan.items.map(item => (
                <li key={item.id} className="flex items-center justify-between gap-2 border-b py-1 last:border-b-0">
                  <span className={cn('min-w-0 truncate', item.disposition === 'skipped' && 'text-muted-foreground/60')}>{item.label}</span>
                  <span
                    className={cn(
                      'shrink-0 font-medium',
                      item.disposition === 'new' && 'text-primary',
                      item.disposition === 'retry' && 'text-warning-ink',
                      item.disposition === 'skipped' && 'text-muted-foreground',
                    )}
                  >
                    {t(`generations.planItem.${item.disposition}`)}
                  </span>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
              <Button onClick={onConfirm}>{pending.regenerate ? t('generations.planConfirmRegenerate') : t('generations.planConfirm')}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}


/** A verb whose target stage is chosen from its own menu, so no shared dropdown decides what the button means. */
function StageMenuButton({
  actionIcon,
  variant,
  busy,
  busyLabel,
  idleLabel,
  menuLabel,
  onSelect,
}: {
  actionIcon: ReactNode
  variant: 'default' | 'outline'
  busy: boolean
  busyLabel: string
  idleLabel: string
  menuLabel: string
  onSelect(stage: GenerationStage): void
}) {
  const { t } = useI18n()
  const { can } = usePermission()

  const label = (
    <>
      {busy ? <LoaderCircleIcon className="animate-spin" /> : actionIcon}
      {busy ? busyLabel : idleLabel}
      <ChevronDownIcon className="text-muted-foreground size-3.5" />
    </>
  )
  if (!can('generation:trigger')) {
    return (
      <GuardedButton action="generation:trigger" size="sm" variant={variant}>
        {label}
      </GuardedButton>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant={variant} disabled={busy}>
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>{menuLabel}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {MEDIA_STAGES.map(item => (
          <DropdownMenuItem key={item} onSelect={() => onSelect(item)}>
            {translateEnum(t, 'generations.stage', item)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * 错误全文可读:默认两行截断,点击展开/收起。错误是用户排障的唯一线索,
 * 折叠进悬停提示等于没有。
 */
function ErrorCell({ error }: { error: string | null }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  if (!error) return <span className="text-muted-foreground text-xs">—</span>
  return (
    <button
      type="button"
      className="text-destructive hover:text-destructive/80 block max-w-72 cursor-pointer text-left text-xs"
      title={expanded ? t('generations.collapseError') : t('generations.expandError')}
      onClick={() => setExpanded(value => !value)}
    >
      <span className={expanded ? 'block break-all whitespace-pre-wrap' : 'line-clamp-2 break-all'}>
        {error}
      </span>
      {!expanded && <span className="text-destructive/60 ml-1 underline underline-offset-2">{t('generations.expand')}</span>}
    </button>
  )
}

/**
 * 为什么重抽:成功任务的 responseSnapshot 里留着被否候选的名单和参考图降级原因。
 * 文本来自供应商与质检,原文展示不翻译——那是排障时要贴进工单的证据。
 */
function RetryTrace({ trace }: { trace: NonNullable<GenerationTask['retryTrace']> }) {
  const { t } = useI18n()
  return (
    <div className="space-y-1.5 text-xs">
      <p className="text-muted-foreground font-medium">
        {t('generations.retryTraceTitle')}
      </p>
      {trace.candidateErrors.length > 0 && (
        <ul className="text-destructive-ink list-disc space-y-0.5 pl-4">
          {trace.candidateErrors.map((message, index) => (
            <li key={index} className="break-all">
              {message}
            </li>
          ))}
        </ul>
      )}
      {trace.reference.length > 0 && (
        <ul className="text-muted-foreground space-y-0.5">
          {trace.reference.map(entry => (
            <li key={`${entry.model}:${entry.conditioned}`}>
              {entry.conditioned
                ? t('generations.referenceUsed', { model: entry.model })
                : t('generations.referenceSkipped', { model: entry.model, reason: entry.reason ?? '—' })}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export interface TaskLogEntry {
  id: string
  level: string
  event: string
  message: string
  data?: unknown
  createdAt: string
}

interface BatchCardProps {
  batch: GenerationBatch
  storyboards: Storyboard[]
  cancellingId: string | null
  /** Only the newest batch starts open; older runs collapse to one line each. */
  defaultOpen: boolean
  onCancel(task: GenerationTask): Promise<void>
  /** Re-queue just this batch's FAILED tasks (idempotent trigger path). */
  onRetry(): void
  /** True while the retry POST + data refresh is in flight (request-segment spinner). */
  retrying: boolean
  /** 停止本批:把还在排队的任务一次性转为已取消。 */
  onStop(): void
  /** True while the stop POST + data refresh is in flight. */
  stopping: boolean
}

function BatchCard({ batch, storyboards, cancellingId, defaultOpen, onCancel, onRetry, retrying, onStop, stopping }: BatchCardProps) {
  const { t, locale } = useI18n()
  const { api } = useSession()
  const [open, setOpen] = useState(defaultOpen)
  const [confirmStop, setConfirmStop] = useState(false)
  const [logTask, setLogTask] = useState<GenerationTask | null>(null)
  const [logs, setLogs] = useState<TaskLogEntry[] | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)
  const [traceOpen, setTraceOpen] = useState<Record<string, boolean>>({})

  const runningTasks = batch.tasks.filter(task => task.status === 'QUEUED' || task.status === 'RUNNING').length
  const failedTasks = batch.tasks.filter(task => task.status === 'FAILED').length

  async function openLogs(task: GenerationTask) {
    setLogTask(task)
    setLogs(null)
    setLogsLoading(true)
    try {
      const result = await api<{ logs: TaskLogEntry[] }>(`/generations/tasks/${task.id}/logs`)
      setLogs(result.logs)
    } catch {
      setLogs([])
    } finally {
      setLogsLoading(false)
    }
  }

  return (
    <Card className="gap-4 py-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="hover:bg-accent/40 flex w-full flex-wrap items-center gap-2 rounded-lg px-4 py-2 text-left transition-colors"
      >
        {open ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" />}
        <Badge variant="secondary">{translateEnum(t, 'generations.stage', batch.stage)}</Badge>
        <StatusBadge status={toneFor(batch.status)} label={translateEnum(t, 'status', batch.status.toLowerCase())} />
        <span className="text-subtle-foreground text-xs">
          {t('generations.plannedCount', { count: batch.plannedCount })} · {formatDateTime(batch.createdAt, locale)}
        </span>
        {runningTasks > 0 && (
          <span className="text-primary flex items-center gap-1 text-xs font-medium">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            {t('generations.batchRunning', { count: runningTasks })}
          </span>
        )}
        {failedTasks > 0 && (
          <span className="text-destructive flex items-center gap-1 text-xs font-medium">
            <XCircleIcon className="size-3.5" />
            {t('generations.batchFailed', { count: failedTasks })}
          </span>
        )}
      </button>
      {runningTasks > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
          <p className="text-muted-foreground text-xs">{t('generations.batchRunning', { count: runningTasks })}</p>
          <GuardedButton
            action="generation:trigger"
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={stopping}
            onClick={() => setConfirmStop(true)}
          >
            {stopping ? <LoaderCircleIcon data-slot="icon" className="animate-spin" /> : <BanIcon data-slot="icon" />}
            {stopping ? t('generations.stoppingBatch') : t('generations.stopBatch')}
          </GuardedButton>
        </div>
      )}
      {failedTasks > 0 && (
        <div className="bg-destructive/5 flex items-center justify-between gap-2 rounded-md border border-destructive/20 px-3 py-2">
          <p className="text-destructive-ink text-xs">{t('generations.batchFailed', { count: failedTasks })}</p>
          <GuardedButton action="generation:trigger" variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
            {retrying ? <LoaderCircleIcon data-slot="icon" className="animate-spin" /> : <RotateCwIcon data-slot="icon" />}
            {t('generations.retryFailed')}
          </GuardedButton>
        </div>
      )}
      {open && (
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-28">{t('generations.stage')}</TableHead>
            <TableHead className="w-32">{t('common.status')}</TableHead>
            <TableHead className="w-20">{t('generations.attempts')}</TableHead>
            <TableHead>{t('generations.providerModel')}</TableHead>
            <TableHead className="w-24">{t('generations.qcScore')}</TableHead>
            <TableHead className="w-40">{t('generations.error')}</TableHead>
            <TableHead>{t('generations.artifacts')}</TableHead>
            <TableHead className="w-16 text-right">{t('generations.regenColumn')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {batch.tasks.map(task => (
            <Fragment key={task.id}>
              <TableRow>
              <TableCell className="font-medium">
                {translateEnum(t, 'generations.stage', task.stage)}
                {/* A batch row means nothing without the shot it was made for. */}
                {task.storyboardId && (
                  <span className="text-muted-foreground ml-1 font-normal" title={task.storyboardId}>
                    #{storyboardNumber(task.storyboardId, storyboards)}
                  </span>
                )}
              </TableCell>
              <TableCell>
                <StatusBadge
                  status={toneFor(task.status)}
                  label={translateEnum(t, 'generations.status', task.status)}
                />
              </TableCell>
              <TableCell>
                {task.retryTrace ? (
                  <button
                    type="button"
                    aria-expanded={Boolean(traceOpen[task.id])}
                    onClick={() => setTraceOpen(value => ({ ...value, [task.id]: !value[task.id] }))}
                    className="text-primary inline-flex items-center gap-1 whitespace-nowrap text-xs underline-offset-2 hover:underline"
                  >
                    <span className="text-muted-foreground tabular-nums">{task.attempts}</span>
                    {traceOpen[task.id] ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
                    {t('generations.whyRetried')}
                  </button>
                ) : (
                  <span className="text-muted-foreground tabular-nums">{task.attempts}</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {task.provider || task.model ? `${task.provider ?? '—'} · ${task.model ?? '—'}` : '—'}
              </TableCell>
              <TableCell>
                {task.qc?.kind === 'visual-audit' && task.qc.score !== null ? (
                  <span
                    className={cn(
                      'text-xs font-medium tabular-nums',
                      task.qc.score >= 0.7 ? 'text-success' : 'text-destructive',
                    )}
                    title={`${task.qc.kind} · ${task.qc.status}`}
                  >
                    {Math.round(task.qc.score * 100)}%
                  </span>
                ) : task.qc ? (
                  <span className="text-muted-foreground text-xs" title={`${task.qc.kind} · ${task.qc.status}`}>
                    {t('generations.qcUnaudited')}
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">—</span>
                )}
              </TableCell>
              <TableCell>
                <ErrorCell error={task.error} />
              </TableCell>
              <TableCell>
                {task.artifacts.length === 0 ? (
                  <span className="text-muted-foreground text-xs">—</span>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 py-1">
                    {task.artifacts.map(artifact => (
                      <ArtifactMedia key={artifact.id} artifact={artifact} />
                    ))}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('generations.logs')}
                    title={t('generations.logs')}
                    onClick={() => void openLogs(task)}
                  >
                    <ScrollTextIcon />
                  </Button>
                  {task.status === 'QUEUED' && (
                    <GuardedButton
                      action="generation:trigger"
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive hover:text-destructive"
                      aria-label={t('generations.cancelTask')}
                      disabled={cancellingId === task.id}
                      onClick={() => void onCancel(task)}
                    >
                      <XCircleIcon />
                    </GuardedButton>
                  )}
                </div>
              </TableCell>
            </TableRow>
              {task.retryTrace && traceOpen[task.id] && (
                <TableRow className="bg-muted/20 hover:bg-transparent">
                  <TableCell colSpan={8} className="py-2">
                    <RetryTrace trace={task.retryTrace} />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          ))}
        </TableBody>
      </Table>
      )}
      <Dialog open={logTask !== null} onOpenChange={open => { if (!open) setLogTask(null) }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('generations.logs')}</DialogTitle>
            <DialogDescription>
              {logTask ? `${translateEnum(t, 'generations.stage', logTask.stage)} · ${logTask.model ?? ''} · ${logTask.id}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[55vh] space-y-1.5 overflow-y-auto font-mono text-xs">
            {logsLoading ? (
              <p className="text-muted-foreground">{t('common.loading')}</p>
            ) : !logs || logs.length === 0 ? (
              <p className="text-muted-foreground">{t('generations.logsEmpty')}</p>
            ) : (
              logs.map(log => (
                <div key={log.id} className="flex items-start gap-2 border-b pb-1.5 last:border-b-0">
                  <span className="text-subtle-foreground tabular-nums">{formatDateTime(log.createdAt, locale)}</span>
                  <Badge
                    variant={log.level === 'error' ? 'destructive' : log.level === 'warn' ? 'secondary' : 'outline'}
                    className="shrink-0 font-normal"
                  >
                    {log.event}
                  </Badge>
                  <span className="min-w-0 flex-1 break-all">{log.message}</span>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('generations.stopBatchTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('generations.stopBatchConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={onStop}>
              {t('generations.stopBatch')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

/**
 * The episode-level output: one score for the whole episode, the cue sheet cut from the
 * lines that made it into the master, and the master itself. Deliberately kept apart from
 * the shot table — a score is one bed laid under every shot, never a per-shot track.
 */
function EpisodeTracksCard({
  composition,
  batches,
  composing,
  onCompose,
}: {
  composition: EpisodeComposition | null
  batches: GenerationBatch[]
  composing: boolean
  onCompose(): void
}) {
  const { t } = useI18n()
  // Before a compose there is no link to follow, so the newest score the episode bought
  // is what the user should be able to listen to — labelled as not yet mixed in.
  const standingScore = useMemo(() => {
    for (const batch of batches) {
      if (batch.stage !== 'MUSIC') continue
      for (const task of [...batch.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        const artifact = task.artifacts[0]
        if (artifact) return { artifact, mixed: false }
      }
    }
    return null
  }, [batches])

  const score = composition?.score ? { artifact: composition.score, mixed: true } : standingScore
  const subtitle = composition?.subtitle ?? null
  const master = composition?.artifact ?? null

  return (
    <Card id="step-composition" className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <FilmIcon className="text-muted-foreground size-4" />
          {t('generations.episodeTracks')}
          {composition && (
            <StatusBadge
              status={toneFor(composition.status)}
              label={translateEnum(t, 'status', composition.status.toLowerCase())}
            />
          )}
        </CardTitle>
        <CardDescription>{t('generations.episodeTracksHint')}</CardDescription>
        {composition === null || composition.status !== 'RUNNING' ? (
          <CardAction>
            <GuardedButton action="generation:trigger" size="sm" disabled={composing} onClick={onCompose}>
              <ClapperboardIcon />
              {composing ? t('generations.composing') : t('generations.compose')}
            </GuardedButton>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {!composition && !score ? (
          <p className="text-muted-foreground text-sm">{t('generations.compositionNone')}</p>
        ) : (
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-[7rem_minmax(0,1fr)]">
            <TrackRow label={t('generations.stage.MUSIC')}>
              {score ? (
                <>
                  <ArtifactMedia artifact={score.artifact} label={t('generations.stage.MUSIC')} className="max-w-80" />
                  {!score.mixed && <p className="text-muted-foreground mt-1 text-xs">{t('generations.scoreNotMixed')}</p>}
                </>
              ) : (
                <TrackAbsent>{t('generations.scoreNone')}</TrackAbsent>
              )}
            </TrackRow>
            <TrackRow label={t('generations.stage.SUBTITLE')}>
              {subtitle ? (
                <ArtifactMedia artifact={subtitle} label={t('generations.downloadSubtitle')} />
              ) : (
                <TrackAbsent>
                  <CaptionsIcon className="size-3.5" />
                  {t('generations.subtitleNone')}
                </TrackAbsent>
              )}
            </TrackRow>
            <TrackRow label={t('generations.composition')}>
              {master ? (
                <MasterVideo artifact={master} subtitleArtifact={subtitle} />
              ) : (
                <TrackAbsent>{t('generations.compositionNone')}</TrackAbsent>
              )}
            </TrackRow>
          </dl>
        )}
      </CardContent>
    </Card>
  )
}

function TrackRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground pt-0.5 text-xs font-medium">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

function TrackAbsent({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">{children}</span>
}

/** The master is the one artifact worth playing at full width; its blob URL also downloads. */
function MasterVideo({ artifact, subtitleArtifact }: { artifact: GenerationArtifact; subtitleArtifact: GenerationArtifact | null }) {
  const { t } = useI18n()
  const href = useArtifactUrl(artifact.downloadUrl)
  const vttUrl = useSrtAsVtt(subtitleArtifact?.downloadUrl ?? null)
  if (!href) return <Skeleton className="h-44 w-full max-w-80 rounded-lg" />
  return (
    <div className="flex flex-wrap items-start gap-3">
      <video src={href} controls preload="metadata" className="max-h-48 rounded border" crossOrigin="anonymous">
        {vttUrl && (
          <track kind="subtitles" src={vttUrl} srcLang="zh" label="中文" default />
        )}
      </video>
      <div className="space-y-2">
        <a href={href} download className="text-primary inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline">
          {t('generations.download')}
        </a>
        <p className="text-muted-foreground max-w-56 text-xs">{t('generations.subtitleOverlayHint')}</p>
      </div>
    </div>
  )
}

/** srt → vtt:浏览器 track 只认 WebVTT。转换在内存里完成,不落任何新存储。 */
function useSrtAsVtt(srtUrl: string | null): string | null {
  const { token } = useSession()
  const [vttUrl, setVttUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!srtUrl || !token) return
    let cancelled = false
    let objectUrl: string | null = null
    void (async () => {
      try {
        const response = await fetch(srtUrl.startsWith('blob:') ? srtUrl : srtUrl, { headers: { authorization: `Bearer ${token}` } })
        if (!response.ok) return
        const srt = await response.text()
        const vtt = `WEBVTT\n\n${srt
          .replace(/\r/g, '')
          .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`
        const blob = new Blob([vtt], { type: 'text/vtt' })
        objectUrl = URL.createObjectURL(blob)
        if (cancelled) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        setVttUrl(objectUrl)
      } catch {
        // 字幕叠加失败不打扰播放——软字幕轨仍在,交付包里也有 srt。
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [srtUrl, token])
  return vttUrl
}

/** Falls back to the raw id when the shot list has not arrived, so a row is never blank. */
function storyboardNumber(id: string, storyboards: Storyboard[]): string {
  return String(storyboards.find(storyboard => storyboard.id === id)?.number ?? id.slice(-4))
}
