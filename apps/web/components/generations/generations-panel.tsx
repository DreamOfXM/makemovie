'use client'

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { apiErrorMessage } from '@/lib/api-error'
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
  type GenerationReview,
  type GenerationStage,
  type GenerationTask,
  type GenerationsResponse,
  type ShotDurationDecision,
  type Storyboard,
} from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { HelpHint } from '@/components/ui/help-hint'
import { Hint } from '@/components/ui/hint'
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
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'
import { ArtifactLoadError, ArtifactMedia, useArtifactUrl } from '@/components/generations/artifact-media'
import { PlanDialog } from '@/components/generations/plan-dialog'

const POLL_INTERVAL_MS = 3000

const EMPTY: GenerationsResponse = { batches: [], composition: null }

/** The three stages that belong to one shot rather than to the whole episode. */
type ShotStage = 'IMAGE' | 'VIDEO' | 'AUDIO'

/** Stages this panel owns. SCRIPT/ASSET/STORYBOARD live in their own panels' triggers. */
const MEDIA_STAGES: readonly GenerationStage[] = ['IMAGE', 'VIDEO', 'AUDIO', 'MUSIC']

/**
 * Maps the pipeline's SCREAMING_SNAKE statuses onto the workflow tones StatusBadge already renders.
 * 失败与阻塞同红：琥珀在本产品里只有一个意思——等你审（镜头卡、放映条、生命周期条同规则）。
 * 批次 rollup 的 BLOCKED 就是「有任务失败需要人」，不能与同一行末尾的红色「N 个失败」分成两色。
 */
const statusTone: Record<string, string> = {
  QUEUED: 'ready',
  PENDING: 'draft',
  RUNNING: 'running',
  SUCCEEDED: 'completed',
  FAILED: 'blocked',
  BLOCKED: 'blocked',
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
  /** The project's default style preset, shown next to the trigger so what a run will look like is visible. */
  stylePresetId?: string | null
  /** Opens the project's style settings; the muted line doubles as the entry point. */
  onStyleClick?: () => void
}

export function GenerationsPanel({ episodeId, reloadToken = 0, storyboards, stylePresetId = null, onStyleClick }: GenerationsPanelProps) {
  const { t, locale } = useI18n()
  const { api, organizationId } = useSession()
  const { can } = usePermission()

  const [triggering, setTriggering] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [composing, setComposing] = useState(false)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  /** null = unresolved/lookup failed, '' = resolved to nothing; only a non-empty string names the style. */
  const [styleName, setStyleName] = useState('')

  useEffect(() => {
    if (!stylePresetId) {
      setStyleName('')
      return
    }
    let cancelled = false
    api<{ styles: Array<{ id: string; name: string; nameEn?: string | null }> }>('/styles')
      .then(data => {
        if (cancelled) return
        const found = data.styles.find(style => style.id === stylePresetId)
        setStyleName(found ? (locale === 'zh' || !found.nameEn ? found.name : found.nameEn) : '')
      })
      .catch(() => {
        if (!cancelled) setStyleName('')
      })
    return () => {
      cancelled = true
    }
  }, [api, locale, stylePresetId])

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
      if (plan.newCount + plan.retryCount === 0 && plan.localCount === 0) {
        toast.message(isRegenerate ? t('generations.planRegenerateEmpty') : t('generations.planNothingToDo'))
      } else {
        setPendingPlan({ stage: next, regenerate: isRegenerate, plan })
      }
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setTriggering(false)
      setRegenerating(false)
    }
  }

  async function confirmTrigger(acceptDurationGap: boolean, durationDecisions: ShotDurationDecision[]) {
    if (!episodeId || !pendingPlan) return
    const { stage, regenerate } = pendingPlan
    setPendingPlan(null)
    if (regenerate) setRegenerating(true)
    else setTriggering(true)
    try {
      await api(`/episodes/${episodeId}/generations`, {
        method: 'POST',
        body: JSON.stringify({
          stage,
          ...(regenerate ? { regenerate: true } : {}),
          ...(acceptDurationGap ? { acceptDurationGap: true } : {}),
          ...(durationDecisions.length > 0 ? { durationDecisions } : {}),
        }),
      })
      toast.success(
        regenerate
          ? t('generations.regenerated', { stage: translateEnum(t, 'generations.stage', stage) })
          : t('generations.triggered', { stage: translateEnum(t, 'generations.stage', stage) }),
      )
      reload()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setTriggering(false)
      setRegenerating(false)
    }
  }

  // 一键重试失败项也走预审:触发端点的幂等路径会重置 FAILED、不动已成功的镜头,
  // 但视频批次同样可能带时长缺口——确认框必须先把缺口摊开,不能从侧门绕过去。
  const [retryingStage, setRetryingStage] = useState<GenerationStage | null>(null)

  async function retryFailed(stage: GenerationStage) {
    if (!episodeId || retryingStage) return
    setRetryingStage(stage)
    try {
      const { plan } = await api<{ plan: GenerationPlan }>(`/episodes/${episodeId}/generation-plan?stage=${stage}&regenerate=0`)
      if (plan.newCount + plan.retryCount === 0) {
        toast.message(t('generations.planNothingToDo'))
        return
      }
      setPendingPlan({ stage, regenerate: false, plan })
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setRetryingStage(null)
    }
  }

  // 整集媒体重生成:首帧 → 等落定 → 视频 → 等落定 → 配音。前一层完成才触发
  // 下一层,否则会撞上"首帧在途"门禁;轮询批次状态判断落定。
  const [regenAllStage, setRegenAllStage] = useState<'IMAGE' | 'VIDEO' | 'AUDIO' | null>(null)
  const [confirmRegenAll, setConfirmRegenAll] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  // 整集重跑也含一道视频批,缺口同样要在开跑前摊开;确认框打开时先读一次视频预审。
  const [regenAllPlan, setRegenAllPlan] = useState<GenerationPlan | null>(null)
  const [regenAllPlanError, setRegenAllPlanError] = useState<string | null>(null)
  const [regenAllPlanLoading, setRegenAllPlanLoading] = useState(false)
  const [regenAllGapAccepted, setRegenAllGapAccepted] = useState(false)

  async function requestRegenAll() {
    if (!episodeId || regenAllPlanLoading) return
    setConfirmRegenAll(true)
    setRegenAllPlan(null)
    setRegenAllPlanError(null)
    setRegenAllGapAccepted(false)
    setRegenAllPlanLoading(true)
    try {
      const { plan } = await api<{ plan: GenerationPlan }>(`/episodes/${episodeId}/generation-plan?stage=VIDEO&regenerate=1`)
      setRegenAllPlan(plan)
    } catch (error) {
      setRegenAllPlanError(apiErrorMessage(error, t))
    } finally {
      setRegenAllPlanLoading(false)
    }
  }

  async function triggerStageRegenerate(stage: ShotStage, acceptDurationGap = false): Promise<void> {
    await api(`/episodes/${episodeId}/generations`, {
      method: 'POST',
      body: JSON.stringify({ stage, regenerate: true, ...(acceptDurationGap ? { acceptDurationGap: true } : {}) }),
    })
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

  async function regenerateAllMedia(acceptDurationGap: boolean) {
    if (!episodeId) return
    setConfirmRegenAll(false)
    const stages: Array<'IMAGE' | 'VIDEO' | 'AUDIO'> = ['IMAGE', 'VIDEO', 'AUDIO']
    try {
      for (const stage of stages) {
        setRegenAllStage(stage)
        await triggerStageRegenerate(stage, stage === 'VIDEO' && acceptDurationGap)
        const settled = await waitForStageSettled(stage)
        if (!settled) throw new Error(t('generations.regenAllTimeout'))
      }
      toast.success(t('generations.regenAllDone'))
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
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
      toast.error(apiErrorMessage(error, t))
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
      toast.error(apiErrorMessage(error, t))
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
      toast.error(apiErrorMessage(error, t))
    } finally {
      setStoppingBatchId(null)
    }
  }

  // 缺权限时这一枚与旁边两枚走同一套表达（禁用 + 说明），不是凭空消失：
  // 面板那句说明指向「更多」，入口不见了就等于让读者去找一个不存在的按钮。
  const moreLabel = (
    <>
      {regenAllStage ? <LoaderCircleIcon className="animate-spin" /> : <MoreHorizontalIcon />}
      {regenAllStage ? t(`generations.regenAllStage.${regenAllStage}`) : t('generations.more')}
    </>
  )

  const regenAllGapMs = regenAllPlan?.durationGapMs ?? null
  const regenAllGap = regenAllGapMs !== null && regenAllGapMs > 0 ? regenAllGapMs : null
  // 整集重跑不替人逐颗决定超长镜的出路：拼接/换模型/拆镜必须在那批视频的预审门里选。
  const regenAllOverflow = regenAllPlan?.durationPreflight ?? []
  const regenAllBlocked =
    regenAllPlanLoading
    || regenAllPlanError !== null
    || !regenAllPlan
    || regenAllOverflow.length > 0
    || (regenAllGap !== null && !regenAllGapAccepted)

  return (
    <>
      <Card id="step-media" className="scroll-mt-20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SparklesIcon className="text-muted-foreground size-4" />
            {t('generations.title')}
          </CardTitle>
          <CardDescription className="flex items-center gap-1.5">
            {active ? t('generations.pollHint') : t('generations.mediaShort')}
            <HelpHint text={t('generations.mediaHint')} />
          </CardDescription>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {onStyleClick ? (
              <button
                type="button"
                onClick={onStyleClick}
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                {stylePresetId
                  ? styleName
                    ? t('generations.currentStyle', { name: styleName })
                    : t('generations.currentStyleSet')
                  : t('generations.currentStyleNone')}
              </button>
            ) : (
              <span>
                {stylePresetId
                  ? styleName
                    ? t('generations.currentStyle', { name: styleName })
                    : t('generations.currentStyleSet')
                  : t('generations.currentStyleNone')}
              </span>
            )}
            <HelpHint text={t('generations.currentStyleHint')} />
          </div>
          {episodeId && (
            <CardAction>
              <div className="flex flex-wrap items-center gap-2">
                <StageMenuButton
                  actionIcon={<SparklesIcon />}
                  variant="outline"
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
                {can('generation:trigger') ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        {moreLabel}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-80">
                      <DropdownMenuLabel>{t('generations.dangerZone')}</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        disabled={regenAllStage !== null}
                        onSelect={() => void requestRegenAll()}
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
                ) : (
                  <GuardedButton action="generation:trigger" variant="outline" size="sm">
                    {moreLabel}
                  </GuardedButton>
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
                <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                  {t('generations.silentShort')}
                  <HelpHint text={t('generations.silentByDesign')} />
                </span>
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
                        qcThreshold={generations.data.limits?.qcThreshold}
                        onCancel={cancelTask}
                        onRetry={() => void retryFailed(batch.stage)}
                        retrying={retryingStage === batch.stage}
                        onReviewed={reload}
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
                              qcThreshold={generations.data.limits?.qcThreshold}
                              onCancel={cancelTask}
                              onRetry={() => void retryFailed(batch.stage)}
                              retrying={retryingStage === batch.stage}
                              onReviewed={reload}
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
          {regenAllPlanLoading ? (
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
              <LoaderCircleIcon className="size-3.5 animate-spin" />
              {t('generations.regenAllPlanLoading')}
            </p>
          ) : regenAllPlanError ? (
            <p className="text-destructive text-xs">{regenAllPlanError}</p>
          ) : regenAllPlan?.targetDurationMs != null && regenAllPlan.plannedDurationMs != null ? (
            <div className="rounded-lg border px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-muted-foreground">
                  {t('generations.planRuntimeTarget')} <span className="text-foreground font-medium tabular-nums">{formatDuration(regenAllPlan.targetDurationMs)}</span>
                </span>
                <span className="text-muted-foreground">
                  {t('generations.planRuntimePlanned')} <span className="text-foreground font-medium tabular-nums">{formatDuration(regenAllPlan.plannedDurationMs)}</span>
                </span>
                {regenAllGap !== null && (
                  <span className="text-warning-ink font-medium tabular-nums">
                    {t('generations.planRuntimeGap', { duration: formatDuration(regenAllGap) })}
                  </span>
                )}
              </div>
              {regenAllGap !== null && (
                <p className="text-muted-foreground mt-1 leading-relaxed">
                  {t('generations.planGapExplain', {
                    target: formatDuration(regenAllPlan.targetDurationMs),
                    planned: formatDuration(regenAllPlan.plannedDurationMs),
                    gap: formatDuration(regenAllGap),
                  })}
                </p>
              )}
            </div>
          ) : null}
          {regenAllOverflow.length > 0 && (
            <p className="text-warning-ink text-xs leading-relaxed">
              {t('generations.regenAllOverflow', {
                count: regenAllOverflow.length,
                shots: regenAllOverflow.map(item => `#${item.number}`).join('、'),
              })}
            </p>
          )}
          {regenAllGap !== null && (
            <label className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed">
              <input
                type="checkbox"
                checked={regenAllGapAccepted}
                onChange={event => setRegenAllGapAccepted(event.target.checked)}
                className="accent-primary mt-0.5 size-4 shrink-0"
              />
              <span>{t('generations.planGapAccept')}</span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={regenAllBlocked} onClick={() => void regenerateAllMedia(regenAllGapAccepted)}>
              {t('generations.regenAllMedia')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PlanDialog pending={pendingPlan} onClose={() => setPendingPlan(null)} onConfirm={(acceptDurationGap, durationDecisions) => void confirmTrigger(acceptDurationGap, durationDecisions)} />
    </>
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
    <Hint text={expanded ? t('generations.collapseError') : t('generations.expandError')}>
      <button
        type="button"
        className="text-destructive hover:text-destructive/80 block max-w-72 cursor-pointer text-left text-xs"
        onClick={() => setExpanded(value => !value)}
      >
        <span className={expanded ? 'block break-all whitespace-pre-wrap' : 'line-clamp-2 break-all'}>
          {error}
        </span>
        {!expanded && <span className="text-destructive/60 ml-1 underline underline-offset-2">{t('generations.expand')}</span>}
      </button>
    </Hint>
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

const reviewDimensions: Record<string, string> = {
  content: 'generations.review.dimension.content',
  aesthetic: 'generations.review.dimension.aesthetic',
  continuity: 'generations.review.dimension.continuity',
}

/**
 * 停在问询上的任务:自动重抽已经走完它能走的路(策略/上限/额度),现在该人回答。
 * 这里只放两个出口——重抽一次、或带理由豁免;两个都是描边,与全站"重复行不得用实心"一致。
 */
function ReviewAskCard({ task, review, storyboards, qcThreshold, onReviewed }: {
  task: GenerationTask
  review: GenerationReview
  storyboards: Storyboard[]
  qcThreshold?: number
  onReviewed(): void
}) {
  const { t } = useI18n()
  const { api } = useSession()
  const [busy, setBusy] = useState<'retry' | 'waive' | null>(null)
  const [waiveOpen, setWaiveOpen] = useState(false)
  const [waiveReason, setWaiveReason] = useState('')

  const headline =
    review.kind === 'provider-exhausted'
      ? t('generations.review.kind.providerExhausted')
      : review.kind === 'content-rejected'
        ? t('generations.review.kind.contentRejected')
        : t('generations.review.kind.qc')
  const stopReason =
    review.askReason === 'policy'
      ? review.policy === 'ask'
        ? t('generations.review.ask.policyAsk')
        : t('generations.review.ask.policyAuto', { auto: review.autoRetries, used: review.retriesUsed })
      : review.askReason === 'cap'
        ? t('generations.review.ask.cap', { cap: review.cap })
        : t('generations.review.ask.budget', { used: review.budgetUsed, limit: review.budgetLimit ?? 0 })

  async function decide(action: 'retry' | 'waive', reason?: string) {
    setBusy(action)
    try {
      await api(`/generations/tasks/${task.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action, ...(reason ? { reason } : {}) }),
      })
      toast.success(action === 'retry' ? t('generations.review.retried') : t('generations.review.waived'))
      setWaiveOpen(false)
      setWaiveReason('')
      onReviewed()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="border-warning/40 bg-warning/10 space-y-2 rounded-lg border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="font-normal">
          {t(`generations.review.class.${review.retryClass}`)}
        </Badge>
        <span className="text-warning-ink text-xs font-medium">{headline}</span>
        <span className="text-muted-foreground text-xs">
          {task.storyboardId ? `#${storyboardNumber(task.storyboardId, storyboards)} · ` : ''}
          {t('generations.review.meta', { attempt: review.attempt, used: review.retriesUsed, cap: review.cap })}
          {review.budgetLimit !== null
            ? ` · ${t('generations.review.budget', { used: review.budgetUsed, limit: review.budgetLimit })}`
            : ''}
          {review.score !== null
            ? ` · ${t('generations.review.score', { score: Math.round(review.score * 100) })}${
                qcThreshold === undefined ? '' : ` (${t('generations.qcLine', { line: Math.round(qcThreshold * 100) })})`
              }`
            : ''}
        </span>
      </div>
      {review.findings.length > 0 ? (
        <ul className="max-h-28 space-y-1 overflow-y-auto text-xs leading-relaxed">
          {review.findings.map((finding, index) => (
            <li key={`${finding.dimension}:${index}`} className="break-words">
              <span className="text-muted-foreground">
                {reviewDimensions[finding.dimension] ? t(reviewDimensions[finding.dimension]) : finding.dimension}
              </span>
              {' · '}
              {finding.message}
              {finding.evidenceTimeSeconds != null && (
                <span className="text-subtle-foreground tabular-nums"> · {formatDuration(finding.evidenceTimeSeconds * 1000)}</span>
              )}
            </li>
          ))}
        </ul>
      ) : review.reasons.length > 0 ? (
        <ul className="max-h-28 space-y-1 overflow-y-auto text-xs leading-relaxed">
          {review.reasons.map((reason, index) => (
            <li key={index} className="text-muted-foreground break-all">
              {reason}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-muted-foreground text-xs leading-relaxed">{stopReason}</p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <GuardedButton
          action="generation:trigger"
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void decide('retry')}
        >
          {busy === 'retry' ? <LoaderCircleIcon data-slot="icon" className="animate-spin" /> : <RotateCwIcon data-slot="icon" />}
          {t('generations.review.retry')}
        </GuardedButton>
        {review.artifactId === null ? (
          <Hint text={t('generations.review.waiveNoArtifact')}>
            <GuardedButton action="generation:trigger" variant="outline" size="sm" disabled>
              {t('generations.review.waive')}
            </GuardedButton>
          </Hint>
        ) : (
          <GuardedButton
            action="generation:trigger"
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => setWaiveOpen(true)}
          >
            {t('generations.review.waive')}
          </GuardedButton>
        )}
      </div>
      <Dialog open={waiveOpen} onOpenChange={open => { setWaiveOpen(open); if (!open) setWaiveReason('') }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('generations.review.waiveTitle')}</DialogTitle>
            <DialogDescription>{t('generations.review.waiveHint')}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={waiveReason}
            onChange={event => setWaiveReason(event.target.value)}
            placeholder={t('generations.review.waivePlaceholder')}
            rows={4}
            maxLength={500}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" disabled={busy !== null} onClick={() => setWaiveOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => void decide('waive', waiveReason.trim())}
            >
              {busy === 'waive' && <LoaderCircleIcon data-slot="icon" className="animate-spin" />}
              {t('generations.review.waiveConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface BatchCardProps {
  batch: GenerationBatch
  storyboards: Storyboard[]
  cancellingId: string | null
  /** Only the newest batch starts open; older runs collapse to one line each. */
  defaultOpen: boolean
  /** 质检线由后端随批次下发；缺省=还不知道，那就不涂红绿。 */
  qcThreshold?: number
  onCancel(task: GenerationTask): Promise<void>
  /** Re-queue just this batch's FAILED tasks (idempotent trigger path). */
  onRetry(): void
  /** True while the retry POST + data refresh is in flight (request-segment spinner). */
  retrying: boolean
  /** Reload after a pending review is decided, so the task's new status reaches the table. */
  onReviewed(): void
  /** 停止本批:把还在排队的任务一次性转为已取消。 */
  onStop(): void
  /** True while the stop POST + data refresh is in flight. */
  stopping: boolean
}

function BatchCard({ batch, storyboards, cancellingId, defaultOpen, qcThreshold, onCancel, onRetry, retrying, onReviewed, onStop, stopping }: BatchCardProps) {
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
  // 停在问询上的 FAILED 不算"失败待重试":它要的是裁决,不是一键重抽。
  const reviewTasks = batch.tasks.filter(
    (task): task is GenerationTask & { review: GenerationReview } => task.review?.state === 'pending',
  )
  const retryableFailed = batch.tasks.filter(task => task.status === 'FAILED' && task.review?.state !== 'pending').length

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
      {retryableFailed > 0 && (
        <div className="bg-destructive/5 flex items-center justify-between gap-2 rounded-md border border-destructive/20 px-3 py-2">
          <p className="text-destructive-ink text-xs">{t('generations.batchFailed', { count: retryableFailed })}</p>
          <GuardedButton action="generation:trigger" variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
            {retrying ? <LoaderCircleIcon data-slot="icon" className="animate-spin" /> : <RotateCwIcon data-slot="icon" />}
            {t('generations.retryFailed')}
          </GuardedButton>
        </div>
      )}
      {reviewTasks.map(task => (
        <ReviewAskCard
          key={task.id}
          task={task}
          review={task.review}
          storyboards={storyboards}
          qcThreshold={qcThreshold}
          onReviewed={onReviewed}
        />
      ))}
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
                  <Hint text={task.storyboardId}>
                    <span className="text-muted-foreground ml-1 font-normal">
                      #{storyboardNumber(task.storyboardId, storyboards)}
                    </span>
                  </Hint>
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
                  <Hint
                    text={
                      qcThreshold === undefined
                        ? `${task.qc.kind} · ${task.qc.status}`
                        : `${task.qc.kind} · ${task.qc.status} · ${t('generations.qcLine', { line: Math.round(qcThreshold * 100) })}`
                    }
                  >
                    <span
                      className={cn(
                        'text-xs font-medium tabular-nums',
                        qcThreshold === undefined
                          ? 'text-foreground'
                          : task.qc.score >= qcThreshold
                            ? 'text-success'
                            : 'text-destructive',
                      )}
                    >
                      {Math.round(task.qc.score * 100)}%
                    </span>
                  </Hint>
                ) : task.qc ? (
                  <Hint text={`${task.qc.kind} · ${task.qc.status}`}>
                    <span className="text-muted-foreground text-xs">{t('generations.qcUnaudited')}</span>
                  </Hint>
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
                  <Hint text={t('generations.logs')}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('generations.logs')}
                      onClick={() => void openLogs(task)}
                    >
                      <ScrollTextIcon />
                    </Button>
                  </Hint>
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
        <CardDescription className="flex items-center gap-1.5">
          {t('generations.episodeTracksShort')}
          <HelpHint text={t('generations.episodeTracksHint')} />
        </CardDescription>
        {composition === null || composition.status !== 'RUNNING' ? (
          <CardAction>
            <GuardedButton action="generation:trigger" variant="outline" size="sm" disabled={composing} onClick={onCompose}>
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
  const { url: href, failed, reload } = useArtifactUrl(artifact.downloadUrl)
  const vttUrl = useSrtAsVtt(subtitleArtifact?.downloadUrl ?? null)
  if (failed) return <ArtifactLoadError className="max-w-80" onRetry={reload} />
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
        <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
          {t('generations.subtitleOverlayShort')}
          <HelpHint text={t('generations.subtitleOverlayHint')} />
        </span>
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
