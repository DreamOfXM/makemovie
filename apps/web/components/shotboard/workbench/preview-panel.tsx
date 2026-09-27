'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2Icon, ChevronLeftIcon, ChevronRightIcon, ClapperboardIcon, ImageIcon, LoaderCircleIcon, MicIcon, RotateCcwIcon } from 'lucide-react'
import type { GenerationArtifact, ShotboardShot, ShotVideoCandidate } from '@/lib/api'
import { shotDemandText, shotOwesVoice, shotVoiceTrack } from '@/lib/shot-verdict'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { useSession } from '@/lib/session'
import { cn, formatDateTime, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GuardedButton, usePermission } from '@/components/permission'
import { ArtifactMedia } from '@/components/generations/artifact-media'
import { AudioSourceRow } from './audio-source-row'

/** 右栏一枚产物行的重跑动词：缺产物=「生成」（只补缺），有产物=「重跑」（覆盖）。 */
type RegenStage = 'FIRST_FRAME' | 'VIDEO' | 'AUDIO'

interface PreviewPanelProps {
  shot: ShotboardShot
  /** 请求段 busy（容器在 POST 期间置位，键=stage）。 */
  requestingStage: RegenStage | null
  onRegenerate(stage: RegenStage, note?: string): void
  onChanged(): void
  onPrev(): void
  onNext(): void
  hasPrev: boolean
  hasNext: boolean
  prevNumber: number | null
  nextNumber: number | null
}

export function PreviewPanel({
  shot,
  requestingStage,
  onRegenerate,
  onChanged,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  prevNumber,
  nextNumber,
}: PreviewPanelProps) {
  const { t, locale } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const canTrigger = can('generation:trigger')
  const [note, setNote] = useState('')

  const stageInflight = (stage: RegenStage) =>
    stage === 'FIRST_FRAME' ? shot.inflight.includes('FIRST_FRAME')
      : stage === 'VIDEO' ? shot.inflight.includes('VIDEO')
        : shot.inflight.includes('AUDIO')
  const stageBusy = (stage: RegenStage) => requestingStage === stage || stageInflight(stage)

  async function choose(artifactId: string | null) {
    try {
      await api(`/storyboards/${shot.id}/video-selection`, { method: 'POST', body: JSON.stringify({ artifactId }) })
      toast.success(artifactId ? t('shotboard.chosenToast') : t('shotboard.autoToast'))
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    }
  }

  const owesVoice = shotOwesVoice(shot)
  const voiceTrack = shotVoiceTrack(shot)

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <p className="text-muted-foreground text-xs font-medium">
          <span className="font-mono">#{shot.number}</span> · {t('workbench.preview')}
        </p>
        <span className="text-subtle-foreground ml-auto text-[11px] tabular-nums">
          {shot.video?.durationMs ? formatDuration(shot.video.durationMs) : formatDuration(shot.durationMs)}
          {shot.usage ? ` · ${t('shotboard.usageCalls', { calls: shot.usage.calls })}` : ''}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        {/* 常驻预览：成片优先，缺片退回首帧，全缺给这一镜该听到的那句为什么。 */}
        <div className="bg-muted/30 relative aspect-video overflow-hidden rounded-lg border">
          {shot.video ? (
            <ArtifactMedia artifact={shot.video} label={`#${shot.number} ${shot.title}`} className="h-full max-h-none w-full" />
          ) : shot.firstFrame ? (
            <>
              <ArtifactMedia artifact={shot.firstFrame} label={t('storyboards.firstFrame')} interactive={false} className="h-full max-h-none w-full object-cover" />
              <span className="bg-background/75 text-muted-foreground absolute inset-x-0 bottom-0 truncate px-1.5 py-0.5 text-[10px] backdrop-blur-sm">
                {t('shotboard.ph.videoOnlyFrame')}
              </span>
            </>
          ) : stageBusy('FIRST_FRAME') || stageBusy('VIDEO') ? (
            <span className="text-primary absolute inset-0 flex items-center justify-center gap-1.5 text-xs">
              <LoaderCircleIcon className="size-4 animate-spin" />
              {t('generations.cellGenerating')}
            </span>
          ) : (
            <span className="text-muted-foreground absolute inset-0 flex items-center justify-center px-4 text-center text-xs leading-snug">
              {shot.firstFrameError
                ? shotDemandText(t, shot, 'frame_failed')
                : shot.videoError
                  ? shotDemandText(t, shot, 'video_failed')
                  : t('generations.notGenerated')}
            </span>
          )}
          {shot.video && shot.videoError && (
            <span className="bg-destructive text-destructive-foreground absolute top-1 right-1 rounded px-1 py-0.5 text-[10px] font-medium">
              {t('workbench.staleRetry')}
            </span>
          )}
        </div>

        {/* 候选与钦定：≥2 版才出现，同一镜的裁决只有一处。 */}
        {shot.videoCandidates.length >= 2 && (
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-xs">{t('shotboard.candidates', { count: shot.videoCandidates.length })}</p>
            {shot.videoCandidates.map(candidate => (
              <VideoCandidateRow
                key={candidate.artifactId}
                candidate={candidate}
                shotNumber={shot.number}
                onChoose={() => void choose(candidate.artifactId)}
              />
            ))}
            {shot.selectedVideoArtifactId && can('storyboard:write') && (
              <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => void choose(null)}>
                {t('shotboard.autoLatest')}
              </Button>
            )}
          </div>
        )}

        {/* 三个产物各带自己的动作；实心主钮全屏只此一枚：重跑「视频」。
            调整要求一次填写，任一动词携带提交并计入请求快照——禁止无方向盲抽。 */}
        {canTrigger && (
          <div className="space-y-1.5">
            <div>
              <input
                type="text"
                value={note}
                onChange={event => setNote(event.target.value)}
                placeholder={t('workbench.notePlaceholder')}
                aria-label={t('workbench.noteLabel')}
                className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-2.5 py-1.5 text-xs"
              />
            </div>
            <ArtifactActionRow
              icon={<ImageIcon className="size-3.5" />}
              label={t('storyboards.firstFrame')}
              state={stageBusy('FIRST_FRAME') ? 'busy' : shot.firstFrame ? 'done' : 'idle'}
              meta={shot.firstFrame ? t('workbench.hasOutput') : shot.firstFrameError ? t('workbench.lastFailed') : t('workbench.notGenerated')}
              solid={false}
              verb={shot.firstFrame ? t('workbench.rerunStage', { stage: t('storyboards.firstFrame') }) : t('workbench.generateStage', { stage: t('storyboards.firstFrame') })}
              disabled={stageBusy('FIRST_FRAME')}
              onClick={() => onRegenerate('FIRST_FRAME', note)}
            />
            <ArtifactActionRow
              icon={<ClapperboardIcon className="size-3.5" />}
              label={t('storyboards.video')}
              state={stageBusy('VIDEO') ? 'busy' : shot.video ? 'done' : 'idle'}
              meta={shot.video
                ? `${t('workbench.hasOutput')}${shot.videoError ? ` · ${t('workbench.lastFailed')}` : ''}`
                : shot.videoError ? t('workbench.lastFailed') : t('workbench.notGenerated')}
              solid
              verb={shot.video ? t('workbench.rerunStage', { stage: t('storyboards.video') }) : t('workbench.generateStage', { stage: t('storyboards.video') })}
              disabled={stageBusy('VIDEO')}
              onClick={() => onRegenerate('VIDEO', note)}
            />
            {owesVoice && (
              <ArtifactActionRow
                icon={<MicIcon className="size-3.5" />}
                label={t('generations.stage.AUDIO')}
                state={stageBusy('AUDIO') ? 'busy' : voiceTrack ? 'done' : 'idle'}
                meta={voiceTrack ? t('workbench.hasOutput') : t('workbench.notGenerated')}
                solid={false}
                verb={voiceTrack ? t('workbench.rerunStage', { stage: t('generations.stage.AUDIO') }) : t('workbench.generateStage', { stage: t('generations.stage.AUDIO') })}
                disabled={stageBusy('AUDIO')}
                onClick={() => onRegenerate('AUDIO', note)}
              />
            )}
          </div>
        )}

        <AudioSourceRow shot={shot} onChanged={onChanged} />

        {(shot.firstFrameError || shot.videoError) && (
          <div className="border-destructive/30 bg-destructive/5 rounded-md border px-3 py-2 text-xs">
            {shot.firstFrameError && <p className="text-destructive-ink">{shotDemandText(t, shot, 'frame_failed')}</p>}
            {shot.videoError && <p className={cn('text-destructive-ink', shot.firstFrameError && 'mt-1')}>{shotDemandText(t, shot, 'video_failed')}</p>}
            <p className="text-faint-foreground mt-1.5 break-words">
              {t('shotboard.rawError')}: {[shot.firstFrameError, shot.videoError].filter(Boolean).join(' ｜ ')}
            </p>
          </div>
        )}

        {shot.qc.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {shot.qc.map(verdict => (
              <Badge key={verdict.kind} variant={verdict.status === 'APPROVED' ? 'success' : verdict.status === 'NEEDS_REVIEW' ? 'warning' : 'muted'} className="font-normal tabular-nums">
                QC {verdict.kind} {verdict.score !== null ? Math.round(verdict.score * 100) : '—'}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="border-border/60 flex items-center gap-2 border-t px-3 py-2">
        <Button variant="outline" size="sm" disabled={!hasPrev} onClick={onPrev}>
          <ChevronLeftIcon />
          {prevNumber !== null ? t('workbench.prevShot', { number: prevNumber }) : t('workbench.prevShotEmpty')}
        </Button>
        <Button variant="outline" size="sm" disabled={!hasNext} onClick={onNext}>
          {nextNumber !== null ? t('workbench.nextShot', { number: nextNumber }) : t('workbench.nextShotEmpty')}
          <ChevronRightIcon />
        </Button>
        <span className="text-muted-foreground ml-auto hidden items-center gap-1 text-[11px] sm:flex">
          <kbd className="border-border/70 rounded border px-1 font-sans">←</kbd>
          <kbd className="border-border/70 rounded border px-1 font-sans">→</kbd>
          {t('workbench.kbdHint')}
        </span>
      </div>
    </div>
  )
}

function ArtifactActionRow({
  icon,
  label,
  state,
  meta,
  verb,
  solid,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  state: 'done' | 'busy' | 'idle'
  meta: string
  verb: string
  solid?: boolean
  disabled: boolean
  onClick(): void
}) {
  return (
    <div className={cn('border-border/60 flex items-center gap-2.5 rounded-lg border px-2.5 py-2', solid && 'border-primary/35')}>
      <span className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md',
        state === 'done' && 'bg-success/10 text-success-ink',
        state === 'busy' && 'bg-primary/10 text-primary',
        state === 'idle' && 'bg-muted/50 text-muted-foreground',
      )}>
        {state === 'busy' ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{label}</p>
        <p className="text-subtle-foreground mt-0.5 text-[11px]">{meta}</p>
      </div>
      <GuardedButton
        action="generation:trigger"
        variant={solid ? 'default' : 'outline'}
        size="sm"
        className="h-7 text-[11px]"
        disabled={disabled}
        onClick={onClick}
      >
        {state === 'busy' ? <LoaderCircleIcon className="size-3 animate-spin" /> : <RotateCcwIcon className="size-3" />}
        {verb}
      </GuardedButton>
    </div>
  )
}

function VideoCandidateRow({ candidate, shotNumber, onChoose }: { candidate: ShotVideoCandidate; shotNumber: number; onChoose(): void }) {
  const { t, locale } = useI18n()
  const artifact: GenerationArtifact = {
    id: candidate.artifactId,
    mimeType: candidate.mimeType,
    objectKey: '',
    version: candidate.version,
    width: null,
    height: null,
    durationMs: candidate.durationMs,
    downloadUrl: `/artifacts/${candidate.artifactId}/content`,
  }
  return (
    <div className={cn('flex items-center gap-2.5 rounded-md border p-1.5', candidate.selected && 'border-success/40 bg-success/5')}>
      <ArtifactMedia artifact={artifact} label={`#${shotNumber} v${candidate.version}`} interactive={false} className="h-12 w-20 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          v{candidate.version}
          {candidate.selected && (
            <Badge variant="success" className="h-4 px-1.5 text-[10px] font-normal">
              <CheckCircle2Icon className="size-3" />
              {t('shotboard.chosen')}
            </Badge>
          )}
        </p>
        <p className="text-subtle-foreground text-[11px] tabular-nums">
          {formatDateTime(candidate.createdAt, locale)}
          {candidate.durationMs !== null && ` · ${formatDuration(candidate.durationMs)}`}
        </p>
        {candidate.qc && (
          <p className="text-subtle-foreground text-[11px] tabular-nums">
            QC {candidate.qc.kind} {candidate.qc.score !== null ? Math.round(candidate.qc.score * 100) : '—'}
          </p>
        )}
      </div>
      {!candidate.selected && (
        <GuardedButton action="storyboard:write" variant="outline" size="sm" className="h-6 shrink-0 text-[11px]" onClick={onChoose}>
          {t('shotboard.choose')}
        </GuardedButton>
      )}
    </div>
  )
}
