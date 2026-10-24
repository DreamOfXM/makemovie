'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ClapperboardIcon, ImageIcon, LoaderCircleIcon, MicIcon, PlusIcon } from 'lucide-react'
import type { ShotboardShot } from '@/lib/api'
import { audioModeWord, cardStage, heardAudioWord, productionWord, shotAudioMode, shotFailureKind, shotOwesVoice, shotVerdict, shotVoiceTrack, stageWord, type CardStage } from '@/lib/shot-verdict'
import { toWorkflowStatus } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { cn, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GuardedButton } from '@/components/permission'

const stageBadge: Record<CardStage, 'destructive' | 'warning' | 'info' | 'outline' | 'muted'> = {
  blocked: 'destructive',
  retry: 'destructive',
  failed: 'destructive',
  review: 'warning',
  running: 'info',
  approved: 'outline',
  idle: 'muted',
  start: 'muted',
  complete: 'muted',
  local: 'muted',
}

type DotState = 'ok' | 'run' | 'err' | 'idle' | 'na'

const DOT_CLASS: Record<DotState, string> = {
  ok: 'bg-success',
  run: 'bg-primary animate-pulse',
  err: 'bg-destructive',
  idle: 'bg-muted-foreground/30',
  na: 'bg-muted-foreground/15 border border-dashed border-muted-foreground/40',
}

type ShotFilter = 'all' | 'review' | 'failed' | 'running' | 'pick' | 'gaps'

/**
 * 制作台左列 · 镜头页签：一行一镜。行内保留编号/标题/时长/阶段徽章/三枚产物状态点，
 * 与折叠评审板同一裁决（失败先于产物、无台词镜配音点恒灰）。
 */
export function ShotList({
  shots,
  selectedId,
  onSelect,
  onCreate,
  canWrite,
}: {
  shots: ShotboardShot[]
  selectedId: string | null
  onSelect(shotId: string): void
  onCreate(): void
  canWrite: boolean
}) {
  const { t } = useI18n()
  const [filter, setFilter] = useState<ShotFilter>('all')
  const scrollerRef = useRef<HTMLDivElement>(null)

  const dot = (shot: ShotboardShot, stage: 'frame' | 'video' | 'audio'): DotState => {
    if (stage === 'audio' && !shotOwesVoice(shot)) return 'na'
    // 本机镜头不欠首帧：灰点写「未到」会把 25 个手工镜读成 25 笔首帧欠账，
    // 和无台词镜的配音枚是同一类错误（不需要 ≠ 还没产）。
    if (stage === 'frame' && shot.production !== 'video') return 'na'
    const inflight = stage === 'frame' ? shot.inflight.includes('FIRST_FRAME') : stage === 'video' ? shot.inflight.includes('VIDEO') : shot.inflight.includes('AUDIO')
    if (inflight) return 'run'
    if (stage === 'frame') return shot.firstFrameError ? 'err' : shot.firstFrame ? 'ok' : 'idle'
    if (stage === 'video') return shot.videoError ? 'err' : shot.video ? 'ok' : 'idle'
    return shotVoiceTrack(shot) ? 'ok' : 'idle'
  }

  const counts = useMemo(() => ({
    all: shots.length,
    review: shots.filter(shot => shot.attention.includes('awaiting_review')).length,
    failed: shots.filter(shot => shot.attention.some(code => code === 'frame_failed' || code === 'video_failed' || code === 'shot_blocked')).length,
    running: shots.filter(shot => shot.inflight.length > 0).length,
    pick: shots.filter(shot => shot.attention.includes('selection_open')).length,
    // 分镜待修刻意不进「等你审」三项：它描述的是文字写得不够清楚，挡路的仍是人。
    gaps: shots.filter(shot => shot.storyboardGaps.length > 0).length,
  }), [shots])

  const filters: { id: ShotFilter; label: string }[] = [
    { id: 'all', label: t('workbench.filter.all', { count: counts.all }) },
    { id: 'review', label: t('workbench.filter.review', { count: counts.review }) },
    { id: 'failed', label: t('workbench.filter.failed', { count: counts.failed }) },
    { id: 'running', label: t('workbench.filter.running', { count: counts.running }) },
    { id: 'pick', label: t('workbench.filter.pick', { count: counts.pick }) },
    { id: 'gaps', label: t('workbench.filter.gaps', { count: counts.gaps }) },
  ]
  const visible = shots.filter(shot => {
    if (filter === 'review') return shot.attention.includes('awaiting_review')
    if (filter === 'failed') return shot.attention.some(code => code === 'frame_failed' || code === 'video_failed' || code === 'shot_blocked')
    if (filter === 'running') return shot.inflight.length > 0
    if (filter === 'pick') return shot.attention.includes('selection_open')
    if (filter === 'gaps') return shot.storyboardGaps.length > 0
    return true
  })

  /**
   * 选中镜可能在清单可视区之外——点放映条第 23 格时，右列换了内容，左列却还停在
   * 第 1 行，看起来像「没选中」。这里把选中行滚进可视区；容器从隐藏变可见时
   * （浮层轨道打开、窗口跨断点）也补一次。
   */
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !selectedId) return
    const reveal = () => {
      const row = scroller.querySelector<HTMLElement>(`[data-shot-id="${selectedId}"]`)
      if (!row || scroller.clientHeight === 0) return
      const view = scroller.getBoundingClientRect()
      const rect = row.getBoundingClientRect()
      if (rect.top >= view.top && rect.bottom <= view.bottom) return
      scroller.scrollTop += rect.top - view.top - 8
    }
    reveal()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(reveal)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [selectedId, filter, visible.length])

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2 pt-1 pb-1.5">
        {filters.filter(item => item.id === 'all' || counts[item.id] > 0).map(item => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
            className={cn(
              'rounded-full px-2.5 py-1 text-[11.5px] font-medium whitespace-nowrap transition-colors',
              filter === item.id ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {visible.map(shot => {
          const verdict = shotVerdict(shot)
          const stage = cardStage(shot, verdict)
          const audioMode = shotAudioMode(shot)
          const dots: { key: 'frame' | 'video' | 'audio'; icon: React.ReactNode; label: string }[] = [
            {
              key: 'frame',
              icon: <ImageIcon className="size-2.5" />,
              label: dot(shot, 'frame') === 'na'
                ? t('shotboard.frame.dotNotShot', { kind: productionWord(t, shot.production) })
                : `${t('storyboards.firstFrame')} · ${t(`workbench.dot.${dot(shot, 'frame')}`)}`,
            },
            { key: 'video', icon: <ClapperboardIcon className="size-2.5" />, label: `${t('storyboards.video')} · ${t(`workbench.dot.${dot(shot, 'video')}`)}` },
            {
              key: 'audio',
              icon: <MicIcon className="size-2.5" />,
              label: dot(shot, 'audio') === 'na'
                ? t('shotboard.audio.dotHint', { mode: audioModeWord(t, audioMode) })
                : `${t('generations.stage.AUDIO')} · ${t(`workbench.dot.${dot(shot, 'audio')}`)} · ${heardAudioWord(t, shot)}`,
            },
          ]
          return (
            <button
              key={shot.id}
              type="button"
              data-shot-id={shot.id}
              onClick={() => onSelect(shot.id)}
              aria-current={shot.id === selectedId ? 'true' : undefined}
              className={cn(
                'mb-0.5 block w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
                shot.id === selectedId
                  ? 'border-primary/45 bg-primary/10 shadow-[inset_2px_0_0_0_var(--color-primary)]'
                  : 'border-transparent hover:bg-accent',
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn('font-mono text-[11px] tabular-nums', shot.id === selectedId ? 'text-primary' : 'text-muted-foreground')}>
                  {String(shot.number).padStart(2, '0')}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{shot.title}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {dots.map(item => (
                    <Tooltip key={item.key}>
                      <TooltipTrigger asChild>
                        <span aria-label={item.label} className={cn('size-2.5 rounded-full', DOT_CLASS[dot(shot, item.key)])} />
                      </TooltipTrigger>
                      <TooltipContent>{item.label}</TooltipContent>
                    </Tooltip>
                  ))}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 pl-7">
                <span className="text-subtle-foreground text-[11px] tabular-nums">{formatDuration(shot.durationMs)}</span>
                {stage === 'local' ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant={stageBadge[stage]} className="h-4 cursor-help gap-1 px-1.5 text-[10.5px] font-normal">
                        {t('shotboard.stage.local')}
                        <span className="text-subtle-foreground">·</span>
                        {productionWord(t, shot.production)}
                        {shot.firstFrame || shot.video ? (
                          <>
                            <span className="text-subtle-foreground">·</span>
                            {t('shotboard.candidateChosen')}
                          </>
                        ) : null}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>{t('shotboard.stage.localHint', { kind: productionWord(t, shot.production) })}</TooltipContent>
                  </Tooltip>
                ) : (
                  <Badge variant={stageBadge[stage]} className="h-4 px-1.5 text-[10.5px] font-normal">
                    {stageWord(t, verdict, stage, false, shotFailureKind(shot))}
                  </Badge>
                )}
                {shot.inflight.length > 0 && (
                  <LoaderCircleIcon className="text-primary size-3 animate-spin" aria-label={t('workbench.running')} />
                )}
                {shot.storyboardGaps.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="muted" className="h-4 cursor-help px-1.5 text-[10.5px] font-normal">
                        {t('storyboardGap.chip', { count: shot.storyboardGaps.length })}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64">
                      <p className="mb-1">{t('storyboardGap.chipHint')}</p>
                      <ul className="list-disc space-y-0.5 pl-3">
                        {shot.storyboardGaps.map(code => (
                          <li key={code}>{t(`storyboardGap.${code}`)}</li>
                        ))}
                      </ul>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </button>
          )
        })}
        {visible.length === 0 && (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t('common.empty')}</p>
        )}
      </div>

      {canWrite && (
        <div className="border-border/60 shrink-0 border-t px-2 py-2">
          <GuardedButton action="storyboard:write" variant="outline" size="sm" className="w-full" onClick={onCreate}>
            <PlusIcon />
            {t('storyboards.new')}
          </GuardedButton>
        </div>
      )}
    </div>
  )
}
