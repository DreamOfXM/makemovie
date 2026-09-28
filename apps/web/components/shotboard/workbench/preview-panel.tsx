'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronLeftIcon, ChevronRightIcon, ClapperboardIcon, ImageIcon, LoaderCircleIcon, Maximize2Icon, MicIcon, RotateCcwIcon } from 'lucide-react'
import type { GenerationArtifact, ShotboardShot, ShotVideoCandidate } from '@/lib/api'
import { shotDemandText, shotOwesVoice, shotVoiceTrack } from '@/lib/shot-verdict'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { useSession } from '@/lib/session'
import { cn, formatDateTime, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GuardedButton, usePermission } from '@/components/permission'
import { ArtifactMedia } from '@/components/generations/artifact-media'
import { AudioSourceRow } from './audio-source-row'
import { VideoReviewLightbox } from './video-review-lightbox'

/** 右栏一枚产物行的重跑动词：缺产物=「生成」（只补缺），有产物=「重跑」（覆盖）。 */
type RegenStage = 'FIRST_FRAME' | 'VIDEO' | 'AUDIO'

interface PreviewPanelProps {
  shot: ShotboardShot
  /** 请求段 busy（容器在 POST 期间置位，键=stage）。 */
  requestingStage: RegenStage | null
  onRegenerate(stage: RegenStage, note?: string, regenerate?: boolean): void
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
  // 放大态：null=关；version=null 落在已钦定/最新版，数字=点开的那一版。
  const [review, setReview] = useState<{ version: number | null } | null>(null)
  // 无首帧直接生成视频的风险确认——花钱动作走 AlertDialog，不静默放行也不硬禁。
  const [videoGate, setVideoGate] = useState(false)

  const stageInflight = (stage: RegenStage) =>
    stage === 'FIRST_FRAME' ? shot.inflight.includes('FIRST_FRAME')
      : stage === 'VIDEO' ? shot.inflight.includes('VIDEO')
        : shot.inflight.includes('AUDIO')
  const stageBusy = (stage: RegenStage) => requestingStage === stage || stageInflight(stage)

  /** 版本胶片条的选中态：null=跟随当前生效版；换镜复位。 */
  const [activeVersion, setActiveVersion] = useState<number | null>(null)
  const [choosing, setChoosing] = useState(false)
  useEffect(() => { setActiveVersion(null) }, [shot.id])
  const candidates = [...shot.videoCandidates].sort((a, b) => a.version - b.version)
  const activeCandidate = candidates.find(candidate => candidate.version === (activeVersion ?? shot.video?.version)) ?? candidates[candidates.length - 1] ?? null
  const activeArtifact = activeCandidate ? candidateToArtifact(activeCandidate) : shot.video

  async function choose(artifactId: string | null) {
    setChoosing(true)
    try {
      await api(`/storyboards/${shot.id}/video-selection`, { method: 'POST', body: JSON.stringify({ artifactId }) })
      toast.success(artifactId ? t('shotboard.chosenToast') : t('shotboard.autoToast'))
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setChoosing(false)
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
        {/* 常驻预览：成片优先，缺片退回首帧，全缺给这一镜该听到的那句为什么。
            有候选时播放器跟随胶片条选中的那一版（默认=当前生效版）。 */}
        <div className="bg-muted/30 relative aspect-video overflow-hidden rounded-lg border">
          {activeArtifact ? (
            <ArtifactMedia artifact={activeArtifact} label={`#${shot.number} ${shot.title} v${activeArtifact.version}`} className="h-full max-h-none w-full" />
          ) : shot.firstFrame ? (
            <>
              {/* 缺成片退回首帧时保留放大：审这一帧的构图本就要看细节。 */}
              <ArtifactMedia artifact={shot.firstFrame} label={t('storyboards.firstFrame')} className="h-full max-h-none w-full object-cover" />
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
          {/* 放大入口常驻右上角：视频本体的点击留给原生播放/暂停，看大片走这里。 */}
          {(shot.video || shot.videoCandidates.length > 0) && (
            <button
              type="button"
              onClick={() => setReview({ version: null })}
              className="bg-background/75 text-muted-foreground hover:text-foreground absolute top-2 right-2 z-10 inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium backdrop-blur-sm"
            >
              <Maximize2Icon className="size-3" />
              {t('workbench.zoom')}
            </button>
          )}
        </div>

        {/* 版本胶片条（r03·A 用户拍板）：横向常驻——一版也在，重跑中追加灰格脉冲。
            格底亮线=已钦定入片，点格换预览+元数据，裁决在条下完成。 */}
        {(candidates.length > 0 || stageBusy('VIDEO')) && (
          <div className="space-y-1.5">
            <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(candidates.length + (stageBusy('VIDEO') ? 1 : 0), 4)}, minmax(0, 1fr))` }}>
              {candidates.map(candidate => (
                <button
                  key={candidate.artifactId}
                  type="button"
                  onClick={() => setActiveVersion(candidate.version)}
                  aria-pressed={candidate.version === activeVersion}
                  title={`v${candidate.version}${candidate.qc?.score != null ? ` · ${t('workbench.qcScore', { score: candidate.qc.score })}` : ''}`}
                  className={cn(
                    'group relative overflow-hidden rounded-md border transition-colors',
                    candidate.version === activeVersion ? 'border-primary' : 'border-border/60 hover:border-control-line',
                  )}
                >
                  <ArtifactMedia
                    artifact={candidateToArtifact(candidate)}
                    label={`#${shot.number} v${candidate.version}`}
                    interactive={false}
                    className="aspect-video h-auto w-full border-0"
                  />
                  <span className="bg-background/75 absolute inset-x-0 bottom-0 flex items-center justify-between px-1 py-0.5 text-[9.5px] font-medium backdrop-blur-sm">
                    v{candidate.version}
                    {candidate.selected && <span className="text-success-ink">{t('shotboard.candidateChosen')}</span>}
                  </span>
                  {candidate.selected && <span className="bg-primary absolute inset-x-0 bottom-0 h-0.5" />}
                </button>
              ))}
              {stageBusy('VIDEO') && (
                <span className="border-primary/40 text-primary relative grid place-items-center overflow-hidden rounded-md border text-[10px]">
                  <span className="flex items-center gap-1 py-2"><LoaderCircleIcon className="size-3 animate-spin" />{t('generations.cellGenerating')}</span>
                </span>
              )}
            </div>
            {activeCandidate && (
              <div className="flex items-center gap-2">
                <p className="text-subtle-foreground min-w-0 flex-1 truncate text-[11px] tabular-nums">
                  v{activeCandidate.version}
                  {activeCandidate.qc?.score != null && ` · ${t('workbench.qcScore', { score: activeCandidate.qc.score })}`}
                  {` · ${formatDateTime(activeCandidate.createdAt, locale)}`}
                </p>
                {can('storyboard:write') && (
                  activeCandidate.selected ? (
                    <Button variant="ghost" size="sm" className="h-6 shrink-0 px-1.5 text-[11px]" onClick={() => void choose(null)}>
                      {t('shotboard.autoLatest')}
                    </Button>
                  ) : (
                    <Button variant="default" size="sm" className="h-6 shrink-0 px-2 text-[11px]" disabled={choosing} onClick={() => void choose(activeCandidate.artifactId)}>
                      {t('shotboard.choose')}
                    </Button>
                  )
                )}
              </div>
            )}
          </div>
        )}

        {/* 三个产物同级同形：首帧/视频/配音是同一镜的三件平行产物，行内动作一律
            描边（2026-09-28 用户：一个紫色两个透明"很容易让人不理解"）。实心只留给
            区级推进动作，不给平行产物行里的任何一件。调整要求一次填写，任一动词
            携带提交并计入请求快照——禁止无方向盲抽。 */}
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
              media={shot.firstFrame}
              verb={shot.firstFrame ? t('workbench.rerunStage', { stage: t('storyboards.firstFrame') }) : t('workbench.generateStage', { stage: t('storyboards.firstFrame') })}
              disabled={stageBusy('FIRST_FRAME')}
              onClick={() => onRegenerate('FIRST_FRAME', note, Boolean(shot.firstFrame))}
            />
            <ArtifactActionRow
              icon={<ClapperboardIcon className="size-3.5" />}
              label={t('storyboards.video')}
              state={stageBusy('VIDEO') ? 'busy' : shot.video ? 'done' : 'idle'}
              meta={shot.video
                ? `${t('workbench.hasOutput')}${shot.videoError ? ` · ${t('workbench.lastFailed')}` : ''}`
                : shot.videoError ? t('workbench.lastFailed') : t('workbench.notGenerated')}
              verb={shot.video ? t('workbench.rerunStage', { stage: t('storyboards.video') }) : t('workbench.generateStage', { stage: t('storyboards.video') })}
              disabled={stageBusy('VIDEO')}
              onClick={() => {
                if (!shot.firstFrame) {
                  setVideoGate(true)
                  return
                }
                onRegenerate('VIDEO', note, Boolean(shot.video))
              }}
            />
            {owesVoice && (
              <ArtifactActionRow
                icon={<MicIcon className="size-3.5" />}
                label={t('generations.stage.AUDIO')}
                state={stageBusy('AUDIO') ? 'busy' : voiceTrack ? 'done' : 'idle'}
                meta={voiceTrack ? t('workbench.hasOutput') : t('workbench.notGenerated')}
                verb={voiceTrack ? t('workbench.rerunStage', { stage: t('generations.stage.AUDIO') }) : t('workbench.generateStage', { stage: t('generations.stage.AUDIO') })}
                disabled={stageBusy('AUDIO')}
                onClick={() => onRegenerate('AUDIO', note, Boolean(voiceTrack))}
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

      {review && (
        <VideoReviewLightbox
          shot={shot}
          initialVersion={review.version}
          onClose={() => setReview(null)}
          onChanged={onChanged}
        />
      )}

      {/* 无首帧的镜头不能直接生成视频——管线在绑定图生视频时对缺帧镜头一律拒绝
          （generations:videoMissingFrames），旧版「仍然生成」按钮点了只会收到 409
          报错：出口撒谎（2026-09-28 用户实测「只有个弹框、没有任何加载」）。
          这个弹框的职责是指路：先补首帧，再用它带视频。 */}
      <AlertDialog open={videoGate} onOpenChange={setVideoGate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('workbench.videoGate.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('workbench.videoGate.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => onRegenerate('FIRST_FRAME', note)}>
              {t('workbench.videoGate.proceed')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ArtifactActionRow({
  icon,
  label,
  state,
  meta,
  verb,
  media,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  state: 'done' | 'busy' | 'idle'
  meta: string
  verb: string
  /** 产物本体（如首帧）——有就当行首缩略图，点击放大；图片产物在视频在场时
   *  没有任何展示位，曾导致「生成的首帧没法看」（2026-09-28 用户实测）。 */
  media?: GenerationArtifact | null
  disabled: boolean
  onClick(): void
}) {
  return (
    <div className="border-border/60 flex items-center gap-2.5 rounded-lg border px-2.5 py-2">
      <span className={cn(
        'relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md',
        !media && state === 'done' && 'bg-success/10 text-success-ink',
        !media && state === 'busy' && 'bg-primary/10 text-primary',
        !media && state === 'idle' && 'bg-muted/50 text-muted-foreground',
        media && state === 'done' && 'ring-1 ring-success/60',
        media && state === 'busy' && 'ring-1 ring-primary/70',
      )}>
        {state === 'busy' && !media ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : media
          ? <ArtifactMedia artifact={media} label={label} className="h-full w-full max-h-none border-0 object-cover" />
          : icon}
        {state === 'busy' && media && <LoaderCircleIcon className="text-primary absolute size-3 animate-spin" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{label}</p>
        <p className="text-subtle-foreground mt-0.5 text-[11px]">{meta}</p>
      </div>
      <GuardedButton
        action="generation:trigger"
        variant="outline"
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

/** 候选 DTO → ArtifactMedia 认的形状（内容走 /artifacts/:id/content，与旧候选行同一取数路径）。 */
function candidateToArtifact(candidate: ShotVideoCandidate): GenerationArtifact {
  return {
    id: candidate.artifactId,
    mimeType: candidate.mimeType,
    objectKey: '',
    version: candidate.version,
    width: null,
    height: null,
    durationMs: candidate.durationMs,
    downloadUrl: `/artifacts/${candidate.artifactId}/content`,
  }
}
