'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { GenerationPlan, GenerationStage } from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { cn, formatDuration } from '@/lib/utils'

/**
 * 计划预审门：批量触发前把账摊开——新烧/重试/已覆盖各几何、跑哪串模型。
 * 与 POST 同一套门禁，所以确认框里承诺的与实际会发生的不会分叉；纯物理量，没有任何钱 shaped 字段。
 * 媒体面板与素材面板共用这一份，两个入口不许长出两套账目口径。
 */
export function PlanDialog({ pending, onClose, onConfirm }: {
  pending: { stage: GenerationStage; regenerate: boolean; assetIds?: string[]; plan: GenerationPlan } | null
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
