'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ClapperboardIcon, ImageIcon, LoaderCircleIcon, Maximize2Icon, MicIcon, RotateCcwIcon } from 'lucide-react'
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

/** 审计合格线，与 worker 的 QC_THRESHOLD 同值——被否红标、计费提示共用这一档。 */
const QC_PASS_LINE = 0.7

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
  /** 重抽进行时要亮出「第几抽」——烧第几次用户看得见（2026-09-29 用户：重抽不用展示吗）。 */
  const attemptWord = (stage: RegenStage): string | null => {
    const running = shot.inflightAttempts.find(item => item.stage === stage)
    return running && running.attempt > 1 ? t('workbench.reworking', { attempt: running.attempt }) : null
  }

  /** S3（r05 拍板）：正看的产物上大预览；展开态独立成集合——可一件不展、可全展
   *  （用户实测「全部收起收不全」与「行头无选中态」一并修正）。 */
  type ProductKey = 'frame' | 'video' | 'audio'
  const [activeProduct, setActiveProduct] = useState<ProductKey>('video')
  const [openSections, setOpenSections] = useState<Set<ProductKey>>(() => new Set(['video']))
  const [activeVersion, setActiveVersion] = useState<number | null>(null)
  const [choosing, setChoosing] = useState(false)
  useEffect(() => {
    setActiveProduct('video')
    setActiveVersion(null)
    setOpenSections(new Set(['video']))
  }, [shot.id])

  const videoCands = [...shot.videoCandidates].sort((a, b) => a.version - b.version)
  const frameCands = [...shot.frameCandidates].sort((a, b) => a.version - b.version)
  const voiceCands = [...shot.voiceCandidates].sort((a, b) => a.version - b.version)
  const activeCandidate = videoCands.find(candidate => candidate.version === (activeProduct === 'video' ? activeVersion ?? shot.video?.version : shot.video?.version)) ?? videoCands[videoCands.length - 1] ?? null
  /** 大预览跟随正看的产物；版本点击换大预览。首帧/配音的生效版=钦定优先（API 已同口径）。 */
  const playerArtifact =
    activeProduct === 'frame'
      ? (frameCands.find(c => c.version === activeVersion) ? candidateToArtifact(frameCands.find(c => c.version === activeVersion)!) : shot.firstFrame)
      : activeProduct === 'audio'
        ? (voiceCands.find(c => c.version === activeVersion) ? candidateToArtifact(voiceCands.find(c => c.version === activeVersion)!) : shot.voice)
        : (activeCandidate ? candidateToArtifact(activeCandidate) : shot.video)
  const isPlayerVideo = activeProduct === 'video'

  /** 三件产物共用一套钦定端点；清空即回自动取最新。 */
  async function chooseArtifact(kind: 'video' | 'frame' | 'voice', artifactId: string | null) {
    setChoosing(true)
    try {
      const route = kind === 'video' ? 'video-selection' : kind === 'frame' ? 'frame-selection' : 'voice-selection'
      await api(`/storyboards/${shot.id}/${route}`, { method: 'POST', body: JSON.stringify({ artifactId }) })
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
        {/* 大预览（S3·紧凑 2026-09-29 用户拍板：不需要这么高）：默认 h-32 胶片窗，
            视频点击整面进灯箱审大图；省出的高度还给下方产物区。 */}
        <button
          type="button"
          className="group bg-muted/30 relative block h-32 w-full overflow-hidden rounded-lg border"
          onClick={() => {
            if (activeProduct === 'video' && (shot.video || shot.videoCandidates.length > 0)) setReview({ version: null })
          }}
        >
          {isPlayerVideo && playerArtifact ? (
            <ArtifactMedia artifact={playerArtifact} label={`#${shot.number} ${shot.title} v${playerArtifact.version}`} className="h-full max-h-none w-full" />
          ) : !isPlayerVideo && playerArtifact ? (
            activeProduct === 'frame' ? (
              <ArtifactMedia artifact={playerArtifact} label={`${t('storyboards.firstFrame')} v${playerArtifact.version}`} className="h-full max-h-none w-full cursor-zoom-in object-cover" />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6">
                <p className="text-muted-foreground line-clamp-2 text-center text-xs">{shot.dialogue}</p>
                <ArtifactMedia artifact={playerArtifact} label={`${t('generations.stage.AUDIO')} v${playerArtifact.version}`} className="w-full max-w-xs" />
              </div>
            )
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
        </button>

        {/* S3 产物区（r05 拍板）：去框清单——一次只展开正看的那件；全部展开可破例。
            展开钮=文字+方向箭头（用户：只有文字识别不到）。调整要求全局一次，随动词提交。 */}
        {canTrigger && (
          <div className="space-y-2">
            <input
              type="text"
              value={note}
              onChange={event => setNote(event.target.value)}
              placeholder={t('workbench.notePlaceholder')}
              aria-label={t('workbench.noteLabel')}
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-2.5 py-1.5 text-xs"
            />
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-[11px] font-medium">
                {t('workbench.viewing', { name: activeProduct === 'frame' ? t('storyboards.firstFrame') : activeProduct === 'audio' ? t('generations.stage.AUDIO') : t('storyboards.video') })}
              </p>
              <button
                type="button"
                onClick={() => setOpenSections(prev => (prev.size === 3 ? new Set() : new Set(['frame', 'video', 'audio'])))}
                className="text-primary inline-flex items-center gap-0.5 text-[11px] font-medium"
              >
                <ChevronDownIcon className="size-3 transition-transform" />
                {openSections.size === 3 ? t('workbench.collapseAll') : t('workbench.expandAll')}
              </button>
            </div>

            {([
              {
                key: 'frame' as const,
                label: t('storyboards.firstFrame'),
                candidates: frameCands,
                pinnedId: shot.selectedFrameArtifactId,
                busy: stageBusy('FIRST_FRAME'),
                hasOutput: Boolean(shot.firstFrame),
                errorText: shot.firstFrameError ? t('workbench.lastFailed') : t('workbench.notGenerated'),
                pickLabel: t('workbench.pickFrame'),
                pinnedLabel: t('workbench.framePinned'),
                rerunLabel: shot.firstFrame ? t('workbench.rerunStage', { stage: t('storyboards.firstFrame') }) : t('workbench.generateStage', { stage: t('storyboards.firstFrame') }),
                onRerun: () => onRegenerate('FIRST_FRAME', note, Boolean(shot.firstFrame)),
                kind: 'image' as const,
              },
              {
                key: 'video' as const,
                label: t('storyboards.video'),
                candidates: videoCands,
                pinnedId: shot.selectedVideoArtifactId,
                busy: stageBusy('VIDEO'),
                hasOutput: Boolean(shot.video),
                errorText: shot.videoError ? t('workbench.lastFailed') : t('workbench.notGenerated'),
                pickLabel: t('workbench.pickVideo'),
                pinnedLabel: t('shotboard.candidateChosen'),
                rerunLabel: shot.video ? t('workbench.rerunStage', { stage: t('storyboards.video') }) : t('workbench.generateStage', { stage: t('storyboards.video') }),
                onRerun: () => {
                  if (!shot.firstFrame) {
                    setVideoGate(true)
                    return
                  }
                  onRegenerate('VIDEO', note, Boolean(shot.video))
                },
                kind: 'image' as const,
              },
              {
                key: 'audio' as const,
                label: t('generations.stage.AUDIO'),
                candidates: voiceCands,
                pinnedId: shot.selectedVoiceArtifactId,
                busy: stageBusy('AUDIO'),
                hasOutput: Boolean(voiceTrack),
                errorText: t('workbench.notGenerated'),
                pickLabel: t('workbench.pickVoice'),
                pinnedLabel: t('workbench.voicePinned'),
                rerunLabel: voiceTrack ? t('workbench.rerunStage', { stage: t('generations.stage.AUDIO') }) : t('workbench.generateStage', { stage: t('generations.stage.AUDIO') }),
                onRerun: () => onRegenerate('AUDIO', note, Boolean(voiceTrack)),
                kind: 'audio' as const,
              },
            ]).filter(section => section.key !== 'audio' || owesVoice).map(section => {
              // 展开态归 openSections 管（可全收起——用户实测「全部收起收不全」：
              // 旧实现 activeProduct 恒展开）。activeProduct 只管大预览跟谁走+行头选中态。
              const expanded = openSections.has(section.key)
              const isActive = activeProduct === section.key
              const count = section.candidates.length + (section.busy ? 1 : 0)
              return (
                <div key={section.key} className={cn('space-y-1 rounded-lg p-1.5', isActive ? 'bg-primary/10' : 'bg-muted/25')}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenSections(prev => {
                        const next = new Set(prev)
                        if (next.has(section.key)) next.delete(section.key)
                        else next.add(section.key)
                        return next
                      })
                      setActiveProduct(section.key)
                      setActiveVersion(null)
                    }}
                    aria-expanded={expanded}
                    aria-current={isActive ? 'true' : undefined}
                    className="hover:bg-accent/50 flex w-full items-center gap-2.5 rounded-md px-1.5 py-2 text-left transition-colors"
                  >
                    <span className={cn('grid size-9 shrink-0 place-items-center', isActive ? 'text-primary' : 'text-muted-foreground')}>
                      {section.key === 'frame' ? <ImageIcon className="size-4" /> : section.key === 'video' ? <ClapperboardIcon className="size-4" /> : <MicIcon className="size-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-xs font-semibold', isActive && 'text-primary')}>{section.label}</span>
                      <span className="text-subtle-foreground block truncate text-[11px]">
                        {section.hasOutput ? (section.candidates.find(c => c.artifactId === section.pinnedId) ? `✓ ${section.pinnedLabel}` : t('workbench.autoPinned')) : section.errorText}
                      </span>
                    </span>
                    {count > 0 && (
                      <span className={cn('inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium', isActive ? 'text-primary' : 'text-muted-foreground')}>
                        {t('workbench.versions', { count })}
                        <ChevronDownIcon className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
                      </span>
                    )}
                  </button>
                  {expanded && (
                    <div className="mt-2.5">
                      {section.candidates.length === 0 && !section.busy ? (
                        <p className="text-subtle-foreground px-1 text-[11px]">{section.hasOutput ? '' : section.errorText}</p>
                      ) : section.kind === 'audio' ? (
                        <div className="space-y-1">
                          {section.candidates.map(candidate => (
                            <div key={candidate.artifactId} className={cn('flex items-center gap-2 rounded-md px-1 py-1.5', candidate.version === (activeProduct === 'audio' ? activeVersion : null) && 'bg-accent')}>
                              <button type="button" onClick={() => { setActiveProduct('audio'); setActiveVersion(candidate.version) }} className="text-primary size-5 shrink-0" aria-label={`v${candidate.version}`}>▶</button>
                              <span className="min-w-0 flex-1 truncate text-[11px] tabular-nums">
                                v{candidate.version}
                                {candidate.durationMs !== null && ` · ${formatDuration(candidate.durationMs)}`}
                                {` · ${formatDateTime(candidate.createdAt, locale)}`}
                              </span>
                              {candidate.artifactId === section.pinnedId
                                ? <span className="text-success-ink shrink-0 text-[11px]">✓ {section.pinnedLabel}</span>
                                : can('storyboard:write') && (
                                  <Button variant="default" size="sm" className="h-6 shrink-0 px-2 text-[11px]" disabled={choosing} onClick={() => void chooseArtifact('voice', candidate.artifactId)}>
                                    {section.pickLabel}
                                  </Button>
                                )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-2">
                          {section.candidates.map(candidate => (
                            <button
                              key={candidate.artifactId}
                              type="button"
                              onClick={() => { setActiveProduct(section.key); setActiveVersion(candidate.version) }}
                              aria-pressed={activeProduct === section.key && candidate.version === activeVersion}
                              className={cn(
                                'relative overflow-hidden rounded-md',
                                activeProduct === section.key && candidate.version === activeVersion ? 'outline-primary outline-2 outline-offset-[-2px]' : '',
                                candidate.artifactId === section.pinnedId ? 'border-primary border-b-2' : '',
                              )}
                            >
                              <ArtifactMedia artifact={candidateToArtifact(candidate)} label={`${section.label} v${candidate.version}`} interactive={false} className="aspect-video h-auto w-full" />
                              {(() => {
                                // 被审计否决的尝试亮红并给原因——自动重抽花的是用户的钱，
                                // 失败理由不许埋库（2026-09-29 用户：不合格是黑盒）。
                                const rejected = candidate.qc?.score != null && candidate.qc.score < QC_PASS_LINE
                                const reasons = (candidate.qc?.reasons ?? []).join('\n')
                                return rejected ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="bg-destructive/85 text-destructive-foreground absolute inset-x-0 bottom-0 flex cursor-help items-center justify-between gap-1 px-1 py-0.5 text-[10px] font-medium">
                                        v{candidate.version} · {Math.round(candidate.qc!.score! * 100)}
                                        <span className="truncate">{t('workbench.rejected')}</span>
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-72 whitespace-pre-line text-left text-[11px] leading-relaxed">{reasons || t('workbench.noReasons')}</TooltipContent>
                                  </Tooltip>
                                ) : (
                                  <span className="bg-background/75 absolute inset-x-0 bottom-0 flex items-center justify-between px-1 py-0.5 text-[10px] font-medium backdrop-blur-sm">
                                    v{candidate.version}
                                    {candidate.qc?.score != null && <span className="text-subtle-foreground">{Math.round(candidate.qc.score * 100)}</span>}
                                    {candidate.artifactId === section.pinnedId && <span className="text-success-ink">✓ {section.pinnedLabel}</span>}
                                  </span>
                                )
                              })()}
                            </button>
                          ))}
                          {section.busy && (
                            <span className="border-primary/40 text-primary grid aspect-video place-items-center rounded-md border border-dashed px-1 text-center text-[10px]">
                              <span className="flex items-center gap-1"><LoaderCircleIcon className="size-3 animate-spin" />{attemptWord(section.key === 'frame' ? 'FIRST_FRAME' : section.key === 'video' ? 'VIDEO' : 'AUDIO') ?? t('generations.cellGenerating')}</span>
                            </span>
                          )}
                        </div>
                      )}
                      {section.candidates.filter(c => c.qc?.score != null && c.qc.score < QC_PASS_LINE).length > 0 && (
                        <p className="text-faint-foreground mt-2 px-0.5 text-[11px]">
                          {t('workbench.reworkCost', { count: section.candidates.filter(c => c.qc?.score != null && c.qc.score < QC_PASS_LINE).length })}
                        </p>
                      )}
                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        {(() => {
                          // 正看的那一版还没钦定时，「选这版」就是裁决动作本尊（S3：动词分产物——
                          // 视频=入片、首帧=定视频起点）。配音的选这版在版本行内（要试听后选）。
                          const active = activeProduct === section.key && activeVersion !== null
                            ? section.candidates.find(candidate => candidate.version === activeVersion)
                            : undefined
                          const pickable = section.kind === 'image' && can('storyboard:write') && active && active.artifactId !== section.pinnedId
                          return pickable ? (
                            <Button variant="default" size="sm" className="h-7 text-[11px]" disabled={choosing} onClick={() => void chooseArtifact(section.key === 'frame' ? 'frame' : 'video', active.artifactId)}>
                              {section.pickLabel}
                            </Button>
                          ) : null
                        })()}
                        <Button variant="outline" size="sm" className="h-7 text-[11px]" disabled={section.busy} onClick={section.onRerun}>
                          <RotateCcwIcon className="size-3" />
                          {section.rerunLabel}
                        </Button>
                        {section.key === 'video' && (shot.video || shot.videoCandidates.length > 0) && (
                          <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => setReview({ version: null })}>
                            <Maximize2Icon className="size-3" />
                            {t('workbench.zoom')}
                          </Button>
                        )}
                        {section.key !== 'audio' && can('storyboard:write') && (section.candidates.find(c => c.artifactId === section.pinnedId) || null) && (
                          <Button variant="ghost" size="sm" className="h-7 px-1.5 text-[11px]" disabled={choosing} onClick={() => void chooseArtifact(section.key === 'frame' ? 'frame' : 'video', null)}>
                            {t('shotboard.autoLatest')}
                          </Button>
                        )}
                      </div>
                      {/* 声音来源（声道）跟着配音区走——曾沉在右栏底沿折叠线下被当成
                          「被去掉了」（2026-09-29 用户实测），挪进它服务的产物展开区。 */}
                      {section.key === 'audio' && <AudioSourceRow shot={shot} onChanged={onChanged} />}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {!canTrigger && <AudioSourceRow shot={shot} onChanged={onChanged} />}

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
