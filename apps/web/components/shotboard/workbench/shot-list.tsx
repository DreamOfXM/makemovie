'use client'

import { useMemo, useState } from 'react'
import { ClapperboardIcon, ImageIcon, LoaderCircleIcon, MicIcon, PlusIcon } from 'lucide-react'
import type { ShotboardShot } from '@/lib/api'
import { audioModeWord, cardStage, heardAudioWord, shotAudioMode, shotFailureKind, shotOwesVoice, shotVerdict, shotVoiceTrack, stageWord, type CardStage } from '@/lib/shot-verdict'
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
}

type DotState = 'ok' | 'run' | 'err' | 'idle' | 'na'

const DOT_CLASS: Record<DotState, string> = {
  ok: 'bg-success',
  run: 'bg-primary animate-pulse',
  err: 'bg-destructive',
  idle: 'bg-muted-foreground/30',
  na: 'bg-muted-foreground/15 border border-dashed border-muted-foreground/40',
}

type ShotFilter = 'all' | 'review' | 'failed' | 'running' | 'pick'

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

  const dot = (shot: ShotboardShot, stage: 'frame' | 'video' | 'audio'): DotState => {
    if (stage === 'audio' && !shotOwesVoice(shot)) return 'na'
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
  }), [shots])

  const filters: { id: ShotFilter; label: string }[] = [
    { id: 'all', label: t('workbench.filter.all', { count: counts.all }) },
    { id: 'review', label: t('workbench.filter.review', { count: counts.review }) },
    { id: 'failed', label: t('workbench.filter.failed', { count: counts.failed }) },
    { id: 'running', label: t('workbench.filter.running', { count: counts.running }) },
    { id: 'pick', label: t('workbench.filter.pick', { count: counts.pick }) },
  ]
  const visible = shots.filter(shot => {
    if (filter === 'review') return shot.attention.includes('awaiting_review')
    if (filter === 'failed') return shot.attention.some(code => code === 'frame_failed' || code === 'video_failed' || code === 'shot_blocked')
    if (filter === 'running') return shot.inflight.length > 0
    if (filter === 'pick') return shot.attention.includes('selection_open')
    return true
  })

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
              filter === item.id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {visible.map(shot => {
          const verdict = shotVerdict(shot)
          const stage = cardStage(shot, verdict)
          const audioMode = shotAudioMode(shot)
          const dots: { key: 'frame' | 'video' | 'audio'; icon: React.ReactNode; label: string }[] = [
            { key: 'frame', icon: <ImageIcon className="size-2.5" />, label: `${t('storyboards.firstFrame')} · ${t(`workbench.dot.${dot(shot, 'frame')}`)}` },
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
              onClick={() => onSelect(shot.id)}
              aria-current={shot.id === selectedId ? 'true' : undefined}
              className={cn(
                'mb-0.5 block w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
                shot.id === selectedId
                  ? 'border-primary/45 bg-primary/10'
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
                <Badge variant={stageBadge[stage]} className="h-4 px-1.5 text-[10.5px] font-normal">
                  {stageWord(t, verdict, stage, false, shotFailureKind(shot))}
                </Badge>
                {shot.inflight.length > 0 && (
                  <LoaderCircleIcon className="text-primary size-3 animate-spin" aria-label={t('workbench.running')} />
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
