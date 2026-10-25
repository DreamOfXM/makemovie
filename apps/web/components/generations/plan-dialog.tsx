'use client'

import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { HelpHint } from '@/components/ui/help-hint'
import type { GenerationPlan, GenerationStage, ShotDurationPreflight, ShotDurationDecision } from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { cn, formatDuration } from '@/lib/utils'

/**
 * 计划预审门：批量触发前把账摊开——新烧/重试/已覆盖各几何、跑哪串模型。
 * 与 POST 同一套门禁，所以确认框里承诺的与实际会发生的不会分叉；纯物理量，没有任何钱 shaped 字段。
 * 媒体面板与素材面板共用这一份，两个入口不许长出两套账目口径。
 *
 * 视频阶段还要摊两笔账：本集目标/分镜合计/缺口秒数，以及「分镜想跑多长 vs 模型上限」。
 * 缺口 > 0 时确认按钮锁在一枚显式勾选后面；超长镜必须逐颗选一条出路——
 * 拼接/换模型可以开跑，拆镜要人先改分镜表，本批不放行。
 */
export function PlanDialog({ pending, onClose, onConfirm }: {
  pending: { stage: GenerationStage; regenerate: boolean; assetIds?: string[]; plan: GenerationPlan } | null
  onClose(): void
  onConfirm(acceptDurationGap: boolean, durationDecisions: ShotDurationDecision[]): void
}) {
  const { t } = useI18n()
  const plan = pending?.plan
  const [gapAccepted, setGapAccepted] = useState(false)
  // storyboardId → 人选的出路；未选时取默认（可拼接就拼接，否则换模型，再否则拆镜）。
  const [choices, setChoices] = useState<Record<string, ShotDurationDecision['strategy']>>({})

  // 每份新计划都从「未确认」开始：上一批点过的勾与选项不许替下一批说过话。
  useEffect(() => {
    setGapAccepted(false)
    setChoices({})
  }, [pending])

  const gapMs = plan?.durationGapMs ?? null
  const targetMs = plan?.targetDurationMs ?? null
  const plannedMs = plan?.plannedDurationMs ?? null
  const hasRuntime = targetMs !== null && plannedMs !== null
  const needsAcceptance = gapMs !== null && gapMs > 0
  // 本机镜头列在账上但不排队：新烧+重试才是这一批真会跑的任务。
  const runnable = plan ? plan.newCount + plan.retryCount : 0
  const overflow = plan?.durationPreflight ?? []
  const chosenStrategy = (item: ShotDurationPreflight): ShotDurationDecision['strategy'] =>
    choices[item.storyboardId]
      ?? (item.options.find(option => option.available && option.strategy === 'splice')?.strategy
        ?? item.options.find(option => option.available)?.strategy
        ?? 'split')
  const splitBlocked = overflow.filter(item => chosenStrategy(item) === 'split')
  const decisions: ShotDurationDecision[] = overflow.map(item => {
    const strategy = chosenStrategy(item)
    const option = item.options.find(entry => entry.strategy === strategy)
    return { storyboardId: item.storyboardId, strategy, ...(strategy === 'switch_model' && option?.capabilityId ? { capabilityId: option.capabilityId } : {}) }
  })
  const canRun = runnable > 0 && splitBlocked.length === 0 && (!needsAcceptance || gapAccepted)

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
              {plan.localCount > 0 && <Badge variant="outline">{t('generations.planLocal', { count: plan.localCount })}</Badge>}
              {plan.durationMs !== null && <Badge variant="outline">{t('generations.planDuration', { duration: formatDuration(plan.durationMs) })}</Badge>}
            </div>
            {hasRuntime && (
              <div className="rounded-lg border px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="text-muted-foreground">
                    {t('generations.planRuntimeTarget')} <span className="text-foreground font-medium tabular-nums">{formatDuration(targetMs)}</span>
                  </span>
                  <span className="text-muted-foreground">
                    {t('generations.planRuntimePlanned')} <span className="text-foreground font-medium tabular-nums">{formatDuration(plannedMs)}</span>
                  </span>
                  {needsAcceptance && (
                    <span className="text-warning-ink font-medium tabular-nums">
                      {t('generations.planRuntimeGap', { duration: formatDuration(gapMs) })}
                    </span>
                  )}
                </div>
                {needsAcceptance && (
                  <p className="text-muted-foreground mt-1 leading-relaxed">
                    {t('generations.planGapExplain', { target: formatDuration(targetMs), planned: formatDuration(plannedMs), gap: formatDuration(gapMs) })}
                  </p>
                )}
              </div>
            )}
            {/* 超长镜：分镜想跑的长度超过当前模型的单镜上限。三选一，不能默认吞掉意图。 */}
            {overflow.length > 0 && (
              <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium">{t('generations.overflowTitle', { count: overflow.length })}</span>
                  <HelpHint text={t('generations.overflowHint')} />
                  {plan.durationCeilingMs !== null && (
                    <span className="text-muted-foreground tabular-nums">
                      {t('generations.overflowCeiling', { duration: formatDuration(plan.durationCeilingMs) })}
                    </span>
                  )}
                </div>
                {overflow.map(item => {
                  const strategy = chosenStrategy(item)
                  const splice = item.options.find(option => option.strategy === 'splice')
                  const split = item.options.find(option => option.strategy === 'split')
                  const swap = item.options.find(option => option.strategy === 'switch_model')
                  return (
                    <div key={item.storyboardId} className="rounded-md border bg-background/60 px-2.5 py-2">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-foreground font-medium tabular-nums">#{item.number}</span>
                        <span className="text-foreground min-w-0 truncate">{item.title}</span>
                        <span className="text-muted-foreground tabular-nums">
                          {t('generations.overflowIntent', {
                            intent: formatDuration(item.intentMs),
                            ceiling: formatDuration(item.ceilingMs),
                            over: formatDuration(item.overByMs),
                          })}
                        </span>
                      </p>
                      <div className="mt-1.5 grid gap-1.5">
                        {splice?.available && (
                          <button
                            type="button"
                            onClick={() => setChoices(current => ({ ...current, [item.storyboardId]: 'splice' }))}
                            aria-pressed={strategy === 'splice'}
                            className={cn(
                              'rounded-md border px-2 py-1.5 text-left transition-colors',
                              strategy === 'splice' ? 'border-primary bg-primary/10' : 'hover:bg-muted/60',
                            )}
                          >
                            <span className="flex items-center gap-1.5">
                              <span className="font-medium">{t('generations.overflowSplice')}</span>
                              <Badge variant="secondary">{t('generations.overflowRecommended')}</Badge>
                            </span>
                            <span className="text-muted-foreground block">
                              {t('generations.overflowSpliceDetail', {
                                count: splice.takeCount ?? 0,
                                duration: formatDuration(splice.perTakeMs ?? 0),
                              })}
                            </span>
                          </button>
                        )}
                        {swap && (
                          <button
                            type="button"
                            disabled={!swap.available}
                            onClick={() => setChoices(current => ({ ...current, [item.storyboardId]: 'switch_model' }))}
                            aria-pressed={strategy === 'switch_model'}
                            className={cn(
                              'rounded-md border px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                              strategy === 'switch_model' ? 'border-primary bg-primary/10' : 'hover:bg-muted/60',
                            )}
                          >
                            <span className="font-medium">{t('generations.overflowSwitch')}</span>
                            <span className="text-muted-foreground block">
                              {swap.available
                                ? t('generations.overflowSwitchDetail', {
                                    model: swap.displayName || swap.model || '',
                                    max: formatDuration(swap.maxMs ?? 0),
                                  })
                                : t('generations.overflowSwitchUnavailable')}
                            </span>
                          </button>
                        )}
                        {split && (
                          <button
                            type="button"
                            onClick={() => setChoices(current => ({ ...current, [item.storyboardId]: 'split' }))}
                            aria-pressed={strategy === 'split'}
                            className={cn(
                              'rounded-md border px-2 py-1.5 text-left transition-colors',
                              strategy === 'split' ? 'border-warning bg-warning/15' : 'hover:bg-muted/60',
                            )}
                          >
                            <span className="font-medium">{t('generations.overflowSplit')}</span>
                            <span className="text-muted-foreground block">{t('generations.overflowSplitDetail')}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
                {splitBlocked.length > 0 && (
                  <p className="text-warning-ink leading-relaxed">
                    {t('generations.overflowSplitBlocked', { shots: splitBlocked.map(item => `#${item.number}`).join('、') })}
                  </p>
                )}
              </div>
            )}
            <p className="text-muted-foreground text-xs">
              {t('generations.planModels')} <span className="text-foreground font-medium">{plan.models.join(' → ')}</span>
            </p>
            {/* 分镜文本体检（服务端算，见 storyboard-gaps.ts）：只提示，不锁确认按钮——
                拦人的是落库硬检，这里报的是「这一批里哪些镜买了大概率要重抽」。 */}
            {plan.storyboardGaps.length > 0 && (
              <div className="rounded-lg border px-3 py-2 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground font-medium">
                    {t('storyboardGap.planTitle', { count: plan.storyboardGaps.length })}
                  </span>
                  <HelpHint text={t('storyboardGap.planHint')} />
                </div>
                <ul className="text-muted-foreground mt-1 max-h-28 space-y-0.5 overflow-y-auto leading-relaxed">
                  {plan.storyboardGaps.map(gap => (
                    <li key={gap.shotNumber}>
                      <span className="text-foreground font-medium tabular-nums">#{gap.shotNumber}</span>{' '}
                      {gap.codes.map(code => t(`storyboardGap.${code}`)).join(' · ')}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {/* 本轮真正派出的镜与等场景主帧的镜分开报：主帧未落位的镜真触发只会落
                BLOCKED、不入队、不烧钱，不能算进这一批的派出数。 */}
            {plan.deferred.length > 0 && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed">
                <span className="text-foreground font-medium tabular-nums">{t('generations.planDispatched', { count: plan.dispatchCount })}</span>
                <span className="text-muted-foreground"> · </span>
                <span className="text-warning-ink font-medium tabular-nums">
                  {t('generations.planWaitingMaster', { count: plan.deferredCount, shots: plan.deferred.map(entry => `#${entry.shotNumber}`).join('、') })}
                </span>
              </div>
            )}
            <ul className="max-h-60 space-y-1 overflow-y-auto text-xs">
              {plan.items.map(item => {
                const idle = item.disposition === 'skipped' || item.disposition === 'local'
                return (
                  <li key={item.id} className="border-b py-1 last:border-b-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn('min-w-0 truncate', idle && 'text-muted-foreground/60')}>{item.label}</span>
                      <span
                        className={cn(
                          'shrink-0 font-medium',
                          item.disposition === 'new' && 'text-primary',
                          item.disposition === 'retry' && 'text-warning-ink',
                          idle && 'text-muted-foreground',
                        )}
                      >
                        {t(`generations.planItem.${item.disposition}`)}
                      </span>
                    </div>
                    {item.model && <p className="text-muted-foreground mt-0.5 truncate text-[11px]">{item.model}</p>}
                  </li>
                )
              })}
            </ul>
            {runnable === 0 && plan.localCount > 0 && (
              <p className="text-muted-foreground text-xs leading-relaxed">{t('generations.planAllLocal')}</p>
            )}
            {needsAcceptance && (
              <label className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed">
                <input
                  type="checkbox"
                  checked={gapAccepted}
                  onChange={event => setGapAccepted(event.target.checked)}
                  className="accent-primary mt-0.5 size-4 shrink-0"
                />
                <span>{t('generations.planGapAccept')}</span>
              </label>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
              <Button onClick={() => onConfirm(gapAccepted, decisions)} disabled={!canRun}>
                {pending.regenerate ? t('generations.planConfirmRegenerate') : t('generations.planConfirm')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
