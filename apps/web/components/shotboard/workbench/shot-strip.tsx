'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ShotboardShot } from '@/lib/api'
import { cardStage, shotFailureKind, shotVerdict, stageTone, stageWord, stripIsEmpty } from '@/lib/shot-verdict'
import { useI18n } from '@/lib/i18n'
import { cn, formatDuration } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * 整集放映条:每镜一格、格宽=规划时长。它是这一集的缩略时间轴,
 * 点击一格=选中那一镜。不是时间线编辑器——剪辑仍是交付之后的事。
 * 一格三个通道，各说一件事：底色=能不能直接用上、底部亮线=钦定与否、格内文字=与镜头行同一个词。
 */
export function ShotStrip({ shots, onOpen }: { shots: ShotboardShot[]; onOpen(shotId: string): void }) {
  const { t } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)

  const cells = shots.map(shot => {
    const verdict = shotVerdict(shot)
    const stage = cardStage(shot, verdict)
    return {
      shot,
      tone: stageTone(stage),
      chosen: shot.slot === 'chosen',
      word: stageWord(t, verdict, stage, true, shotFailureKind(shot)),
      empty: stripIsEmpty(shot, stage),
    }
  })

  /**
   * 词放不放下得量实际渲染宽度：CSS 那道固定 44px 闸门不知道词有多长，
   * 于是短词过得去的窄格被整格抹成空白，长词照样溢出。
   */
  function fitWords() {
    const root = rootRef.current
    if (!root) return
    for (const cell of root.querySelectorAll<HTMLElement>('.strip-cell')) {
      const word = cell.querySelector<HTMLElement>('.strip-word')
      if (!word) continue
      if (word.scrollWidth > word.clientWidth) cell.dataset.clip = '1'
      else delete cell.dataset.clip
    }
  }

  useLayoutEffect(fitWords, [cells])
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fitWords)
    observer.observe(root)
    return () => observer.disconnect()
  })

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={t('shotboard.stripLabel')}
      className="grid h-6 gap-px"
      style={{ gridTemplateColumns: shots.map(shot => `${Math.max(shot.durationMs, 500)}fr`).join(' ') }}
    >
      {cells.map(({ shot, tone, chosen, word, empty }) => {
        const label = `#${shot.number} ${shot.title} · ${formatDuration(shot.durationMs)} · ${word}${chosen ? ` · ${t('shotboard.strip.chosen')}` : ''}`
        return (
          <Tooltip key={shot.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={label}
                onClick={() => onOpen(shot.id)}
                data-empty={empty ? '1' : undefined}
                data-chosen={chosen ? '1' : undefined}
                className={cn(
                  'strip-cell flex items-center justify-center overflow-hidden rounded-sm transition-opacity hover:opacity-70',
                  tone === 'ready' && 'bg-success/45 text-success-ink',
                  tone === 'danger' && 'bg-destructive text-destructive-foreground',
                  tone === 'warning' && 'bg-warning text-warning-ink',
                  tone === 'running' && 'bg-info text-info-foreground animate-pulse',
                  tone === 'idle' && 'bg-muted/40 text-muted-foreground',
                )}
              >
                <span className="strip-word block max-w-full truncate px-0.5 text-center text-[9.5px] leading-none font-medium">{word}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{label}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
