'use client'

import { CheckCircle2Icon, ClapperboardIcon, ImageIcon, LoaderCircleIcon, MicIcon } from 'lucide-react'
import type { ShotboardShot } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { cn, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { ArtifactMedia } from '@/components/generations/artifact-media'

const attentionStyles: Record<string, { tone: string; key: string }> = {
  frame_failed: { tone: 'danger', key: 'attention.frame_failed' },
  video_failed: { tone: 'danger', key: 'attention.video_failed' },
  asset_gate: { tone: 'warning', key: 'attention.asset_gate' },
  shot_blocked: { tone: 'warning', key: 'attention.shot_blocked' },
  selection_open: { tone: 'warning', key: 'attention.selection_open' },
}

function StageDot({ label, state, icon }: { label: string; state: 'done' | 'running' | 'failed' | 'idle'; icon: React.ReactNode }) {
  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] tabular-nums',
        state === 'done' && 'border-success/30 bg-success/10 text-success-ink',
        state === 'running' && 'border-info/30 bg-info/10 text-info-ink',
        state === 'failed' && 'border-destructive/30 bg-destructive/10 text-destructive-ink',
        state === 'idle' && 'border-border/60 bg-muted/30 text-muted-foreground',
      )}
    >
      {state === 'running' ? <LoaderCircleIcon className="size-3 animate-spin" /> : icon}
      {label}
    </span>
  )
}

interface ShotCardProps {
  shot: ShotboardShot
  onSelect: (shotId: string) => void
}

export function ShotCard({ shot, onSelect }: ShotCardProps) {
  const { t } = useI18n()

  const stageState = (done: boolean, inflightStage: boolean, failed: boolean): 'done' | 'running' | 'failed' | 'idle' =>
    done ? 'done' : inflightStage ? 'running' : failed ? 'failed' : 'idle'

  const frameInflight = shot.inflight.includes('FIRST_FRAME')
  const videoInflight = shot.inflight.includes('VIDEO')
  const voiceInflight = shot.inflight.includes('AUDIO')

  return (
    <button
      type="button"
      onClick={() => onSelect(shot.id)}
      className={cn(
        'group flex w-full flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        shot.attention.length > 0 && 'border-destructive/40',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-muted-foreground font-mono text-xs">#{shot.number}</p>
          <p className="truncate text-sm font-medium">{shot.title}</p>
        </div>
        <p className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatDuration(shot.durationMs)}</p>
      </div>

      <div className="bg-muted/30 flex aspect-video items-center justify-center overflow-hidden rounded">
        {shot.video ? (
          <ArtifactMedia artifact={shot.video} label={shot.title} interactive={false} className="h-full max-h-none w-full object-cover" />
        ) : shot.firstFrame ? (
          <ArtifactMedia artifact={shot.firstFrame} label={shot.title} interactive={false} className="h-full max-h-none w-full object-cover" />
        ) : (
          <ClapperboardIcon className="text-muted-foreground/40 size-6" />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <StageDot label={t('storyboards.firstFrame')} state={stageState(Boolean(shot.firstFrame), frameInflight, Boolean(shot.firstFrameError))} icon={<ImageIcon className="size-3" />} />
        <StageDot label={t('storyboards.video')} state={stageState(Boolean(shot.video), videoInflight, Boolean(shot.videoError))} icon={<ClapperboardIcon className="size-3" />} />
        <StageDot label={t('generations.stage.AUDIO')} state={stageState(Boolean(shot.voice), voiceInflight, false)} icon={<MicIcon className="size-3" />} />
      </div>

      {shot.attention.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {shot.attention.map(code => {
            const item = attentionStyles[code]
            if (!item) return null
            return (
              <Badge key={code} variant={item.tone === 'danger' ? 'destructive' : 'warning'} className="font-normal">
                {t(item.key)}
              </Badge>
            )
          })}
        </div>
      )}

      {shot.usage && (
        <p className="text-muted-foreground mt-auto text-[11px] tabular-nums">
          {t('shotboard.usageCalls', { calls: shot.usage.calls })} · {shot.usage.models.length} {t('shotboard.models')}
        </p>
      )}

      {/* 选优门状态:钦定过就报绿,让人知道卡片上这版就是会入片的那版。 */}
      {shot.videoCandidates.some(candidate => candidate.selected) && (
        <p className="text-success-ink mt-auto flex items-center gap-1 text-[11px]">
          <CheckCircle2Icon className="size-3" />
          {t('shotboard.versionChosen')}
        </p>
      )}
    </button>
  )
}
