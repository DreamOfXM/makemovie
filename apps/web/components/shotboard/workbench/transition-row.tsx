'use client'

import { shotTransitionDefaultMs, shotTransitions, type ShotTransition } from '@studio/domain'
import { useI18n } from '@/lib/i18n'
import { cn, formatDuration } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { HelpHint } from '@/components/ui/help-hint'
import { Input } from '@/components/ui/input'

/**
 * 分镜表「转场」列：这一镜从上一镜怎么进。六格就是母带上那一刀的六种形状，词表与
 * 缺省毫秒都读 @studio/domain 那份事实源——分镜契约写的词、这里能点的词、合成吃的值
 * 必须是同一套，否则「叠化」在格子里亮着、在母带上却是裸切。
 */
export function TransitionRow({
  transition,
  transitionMs,
  disabled,
  onChange,
}: {
  transition: string
  transitionMs: number
  disabled: boolean
  onChange(next: { transition: ShotTransition; transitionMs: number }): void
}) {
  const { t } = useI18n()
  // 库里可能存着这份词表之外的写法（旧数据、模型自造的词）：那既不是「没选」也不是
  // 某一格亮着，界面要照实说它会被当什么渲染，而不是把真值盖成硬切。
  const known = (shotTransitions as readonly string[]).includes(transition)
  const effective = (known ? transition : 'cut') as ShotTransition
  const ms = effective === 'cut' ? 0 : Math.min(1000, Math.max(50, Math.round(transitionMs || shotTransitionDefaultMs[effective])))

  return (
    <div className="border-border/60 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          {t('storyboards.transition.title')}
          <HelpHint text={t('storyboards.transition.hint')} />
        </p>
        <div role="group" aria-label={t('storyboards.transition.title')} className="border-border/70 bg-muted/40 ml-auto inline-flex flex-wrap items-center gap-0.5 rounded-lg border p-0.5">
          {shotTransitions.map(item => (
            <Button
              key={item}
              variant="ghost"
              size="sm"
              aria-pressed={known && effective === item}
              disabled={disabled}
              // 换档就把毫秒落到该档的缺省值：留着 0 会被合成判成「过渡不足 50ms，按硬切」,
              // 用户点了叠化、母带里还是裸切——那是控件在骗人。
              onClick={() => onChange({ transition: item, transitionMs: shotTransitionDefaultMs[item] })}
              className={cn(
                'h-7 rounded-md border px-2.5 text-xs font-medium whitespace-nowrap transition-colors',
                known && effective === item && 'border-primary/70 bg-primary/15 text-foreground',
                !(known && effective === item) && 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`storyboards.transition.${item}`)}
            </Button>
          ))}
        </div>
        {effective !== 'cut' && (
          <label className="flex items-center gap-1.5">
            <span className="text-muted-foreground text-xs">{t('storyboards.transition.ms')}</span>
            <Input
              type="number"
              min={0.05}
              max={1}
              step={0.05}
              className="h-7 w-20 text-xs tabular-nums"
              disabled={disabled}
              value={ms / 1000}
              aria-label={t('storyboards.transition.ms')}
              onChange={event => onChange({ transition: effective, transitionMs: Math.round(Number(event.target.value) * 1000) })}
            />
          </label>
        )}
      </div>
      <p className="text-faint-foreground mt-1.5 text-[11px] leading-relaxed">
        {known
          ? t(`storyboards.transition.eff.${effective}`, { ms: formatDuration(ms) })
          : t('storyboards.transition.unknownWord', { word: transition })}
      </p>
    </div>
  )
}
