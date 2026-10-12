'use client'

import { InfoIcon } from 'lucide-react'
import { automationGates, defaultAutomationGate, type AutomationGate } from '@studio/domain'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { HelpHint } from '@/components/ui/help-hint'

/**
 * 制作档位就是一件事：自动推进在中途哪几处停下来等人。取值即 @studio/domain 的
 * AutomationGate，界面不额外造一层概念。
 *
 * 这里曾经是两个正交轴（做多少 × 问几次）加三个预设。撤掉「做多少」是因为流水线、
 * worker 与 API 读侧都没有任何一行读它——选了「精简」和选了「完整」，跑出来的东西
 * 和账单完全一样。一个不影响结果的开关留在界面上，比没有开关更坏：它让用户以为
 * 自己在控制花费。要恢复这条轴，得先有代码真的按它裁剪产出。
 */
export type AutomationTierValue = AutomationGate

export const defaultAutomationTier: AutomationTierValue = defaultAutomationGate

interface AutomationTierSelectorProps {
  value: AutomationTierValue
  onChange: (next: AutomationTierValue) => void
  disabled?: boolean
}

/**
 * 三张卡片各答两个问题：什么时候停、代价落在哪一边。不出现任何流水线内部名词——
 * 「首帧」「批次」属于实现，用户要判断的只有「我会不会被叫住、会不会被扣钱」。
 */
export function AutomationTierSelector({ value, onChange, disabled }: AutomationTierSelectorProps) {
  const { t } = useI18n()

  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        {t('automation.label')}
        <HelpHint text={t('automation.hint')} />
      </p>

      <div role="radiogroup" aria-label={t('automation.label')} className="grid grid-cols-1 gap-2">
        {automationGates.map(gate => {
          const selected = value === gate
          return (
            <label
              key={gate}
              className={cn(
                'flex cursor-pointer gap-2.5 rounded-lg border p-3 transition-colors',
                selected ? 'border-primary/40 bg-primary/10' : 'hover:bg-accent/40',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <input
                type="radio"
                name="automationGate"
                className="accent-primary mt-0.5 size-4"
                checked={selected}
                disabled={disabled}
                onChange={() => onChange(gate)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium">{t(`automation.gate.${gate}.name`)}</span>
                  {gate === defaultAutomationGate && (
                    <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">
                      {t('automation.recommended')}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed">
                  {t(`automation.gate.${gate}.desc`)}
                </span>
              </span>
            </label>
          )
        })}
      </div>

      {/* 这两处由结构保证，不是设置项：写出来是为了让用户敢选「跑完再叫我」。 */}
      <p className="bg-muted text-muted-foreground flex gap-2 rounded-md px-3 py-2.5 text-[11.5px] leading-relaxed">
        <span className="bg-warning-ink mt-1.5 size-1.5 shrink-0 rounded-full" />
        <span>{t('automation.invariants')}</span>
      </p>
    </div>
  )
}

/** 档位的显示名就是它自己那一档的名字——没有预设层可以落后于它。 */
export function automationTierLabel(t: (key: string) => string, value: AutomationTierValue): string {
  return t(`automation.gate.${value}.name`)
}

interface AutomationNoticeProps {
  value: AutomationTierValue
  /** 有传入才渲染入口按钮；调用方负责打开设置。 */
  onChangeClick?: () => void
}

/**
 * 运行界面的档位预告：在任何按钮被按下之前，先写清楚接下来会自动跑还是等人。
 *
 * 它不预测「当前跑到哪一步」——那是页面自己的进度条该回答的；它回答的是另一个更
 * 早的问题：这个档位下，接下来的确认会发生几次、发生在哪里。用户怕的不是等待，
 * 是不知道什么时候会被叫住、什么时候会被扣钱。
 */
export function AutomationNotice({ value, onChangeClick }: AutomationNoticeProps) {
  const { t } = useI18n()
  return (
    <div className="bg-muted flex items-start gap-3 rounded-lg px-3.5 py-3">
      <InfoIcon className="text-info-ink mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-relaxed">
          <span className="font-medium">{automationTierLabel(t, value)}</span>
          <span className="text-muted-foreground"> · {t(`automation.notice.${value}`)}</span>
        </p>
        <p className="text-muted-foreground mt-0.5 text-[11.5px] leading-relaxed">{t('automation.invariants')}</p>
      </div>
      {onChangeClick && (
        <button
          type="button"
          onClick={onChangeClick}
          className="text-primary shrink-0 text-xs hover:underline"
        >
          {t('automation.notice.change')}
        </button>
      )}
    </div>
  )
}
