'use client'

import { useEffect, useState } from 'react'
import type { ApiClient, ShotCandidateOrigin } from '@/lib/api'
import { toast } from 'sonner'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ClapperboardIcon, ImageIcon, LoaderCircleIcon, Maximize2Icon, MicIcon, RotateCcwIcon } from 'lucide-react'
import type { GenerationArtifact, ShotboardShot, ShotVideoCandidate } from '@/lib/api'
import { isUnknownSubmission, shotDemandText, shotOwesVoice, shotVoiceTrack } from '@/lib/shot-verdict'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { useSession } from '@/lib/session'
import { cn, formatDateTime, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GuardedButton, usePermission } from '@/components/permission'
import { ArtifactMedia } from '@/components/generations/artifact-media'
import { AcceptTakeDialog } from './accept-take-dialog'
import { AudioSourceRow } from './audio-source-row'
import { LocalVideoRow } from './local-video-row'
import { VideoReviewLightbox } from './video-review-lightbox'

/** 延长/定向编辑端点的采用策略；candidate_only 是默认——操作成功只是产出候选，
 *  「生成成功」不冒充「已替换入片」，入片永远走显式选版（UX-P04）。 */
export type ArtifactApplyPolicy = 'candidate_only' | 'apply_if_empty' | 'apply_if_unchanged'

/** 延长端点支持 expectedShotRevision（镜头 CAS）；edit-video 端点不支持——
 *  不假装支持：编辑只提供 candidate_only / apply_if_empty 两档。 */
export const EXTEND_POLICIES: ArtifactApplyPolicy[] = ['candidate_only', 'apply_if_empty', 'apply_if_unchanged']
export const EDIT_POLICIES: ArtifactApplyPolicy[] = ['candidate_only', 'apply_if_empty']

/**
 * 延长/定向编辑的提交层（UX-P04）：入口按钮与表单共用这一条路径，保证载荷与端点
 * 契约一致——extend 带 durationMs（apply_if_unchanged 才带 expectedShotRevision），
 * edit-video 只带 instruction 与它真正支持的采用策略。
 */
export async function requestArtifactOperation(
  api: ApiClient,
  artifactId: string,
  kind: 'extend' | 'edit',
  input: {
    durationMs?: number
    instruction?: string
    applyPolicy: ArtifactApplyPolicy
    expectedShotRevision?: number
  },
): Promise<void> {
  const body: Record<string, unknown> = { applyPolicy: input.applyPolicy }
  if (kind === 'extend') {
    if (input.durationMs !== undefined) body.durationMs = input.durationMs
    if (input.applyPolicy === 'apply_if_unchanged' && input.expectedShotRevision !== undefined) {
      body.expectedShotRevision = input.expectedShotRevision
    }
  } else if (input.instruction !== undefined) {
    body.instruction = input.instruction
  }
  await api(`/artifacts/${artifactId}/${kind === 'extend' ? 'extend' : 'edit-video'}`, { method: 'POST', body: JSON.stringify(body) })
}

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

export function PreviewPanel({ shot, requestingStage, onRegenerate, onChanged, onPrev, onNext, hasPrev, hasNext, prevNumber, nextNumber }: PreviewPanelProps) {
  const { t, locale } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const canTrigger = can('generation:trigger')
  const [note, setNote] = useState('')
  // 放大态：null=关；version=null 落在已钦定/最新版，数字=点开的那一版。
  const [review, setReview] = useState<{ artifactId: string | null } | null>(null)
  // 无首帧直接生成视频的风险确认——花钱动作走 AlertDialog，不静默放行也不硬禁。
  const [videoGate, setVideoGate] = useState(false)
  const [resubmitGate, setResubmitGate] = useState(false)
  // 「收下这版」的落点（SD-120）：停在「等你裁决」上的那一版必须能在这里被裁决掉，
  // 否则屏上那句「决定再抽一次还是收下」只有前半句有入口。
  const [accept, setAccept] = useState<{ taskId: string; label: string } | null>(null)

  const stageInflight = (stage: RegenStage) => (stage === 'FIRST_FRAME' ? shot.inflight.includes('FIRST_FRAME') : stage === 'VIDEO' ? shot.inflight.includes('VIDEO') : shot.inflight.includes('AUDIO'))
  // 延长/定向编辑是异步操作（202 立即返回），排队/运行段的反馈不走 requestingStage，
  // 由 shot.operations 数据驱动——制作台对板数据无条件轮询 + 提交成功立即 onChanged()，
  // 两段覆盖三段反馈的真空期（UI 规范：派生 busy 的数据源必须无条件刷新且动作回调手动刷）。
  const runningOperations = shot.operations.filter((operation) => operation.status === 'QUEUED' || operation.status === 'RUNNING' || operation.status === 'BLOCKED')
  const failedOperation = shot.operations.find((operation) => operation.status === 'FAILED') ?? null
  const operationBusy = runningOperations.length > 0
  const stageBusy = (stage: RegenStage) => requestingStage === stage || stageInflight(stage) || (stage === 'VIDEO' && operationBusy)
  /** 重抽进行时要亮出「第几抽」——烧第几次用户看得见（2026-09-29 用户：重抽不用展示吗）。 */
  const attemptWord = (stage: RegenStage): string | null => {
    const running = shot.inflightAttempts.find((item) => item.stage === stage)
    return running && running.attempt > 1 ? t('workbench.reworking', { attempt: running.attempt }) : null
  }
  /** 操作在途的事实词：延长中/修改中/待确认——与生成任务的「生成中」同位展示。 */
  const operationWord = (): string | null => {
    const operation = runningOperations[0]
    if (!operation) return null
    if (operation.status === 'BLOCKED') return t('preview.opPending')
    return operation.kind === 'video_edit' ? t('preview.opEditRunning') : t('preview.opExtendRunning')
  }
  const busyText = (stage: RegenStage): string | null => (stage === 'VIDEO' && operationBusy ? operationWord() : attemptWord(stage))

  /** S3（r05 拍板）：正看的产物上大预览；展开态独立成集合——可一件不展、可全展
   *  （用户实测「全部收起收不全」与「行头无选中态」一并修正）。 */
  type ProductKey = 'frame' | 'video' | 'audio'
  const [activeProduct, setActiveProduct] = useState<ProductKey>('video')
  const [openSections, setOpenSections] = useState<Set<ProductKey>>(() => new Set(['video']))
  // 版本选择按 artifactId 寻址（不按 version 号）：延长/定向修改输出与生成产物
  // 各自记版本号，两条来源会出现同号不同片，按号寻址会点错片。
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  useEffect(() => {
    setActiveProduct('video')
    setActiveArtifactId(null)
    setOpenSections(new Set(['video']))
    // 调整要求会随下一次点击原样发给厂商并计入请求快照（要花钱），所以它不许跨过
    // 镜头存活：上一镜的方向串进这一镜的付费请求，用户看到的就是「我明明没说这句」。
    setNote('')
  }, [shot.id])

  // 候选顺序：视频沿用 API 的新→旧（操作产物与生成产物混排）；首帧/配音是任务
  // 产物，版本号单调，仍按版本升序展示。
  const videoCands = shot.videoCandidates
  const frameCands = [...shot.frameCandidates].sort((a, b) => a.version - b.version)
  const voiceCands = [...shot.voiceCandidates].sort((a, b) => a.version - b.version)
  /** 这一镜的视频是否已经烧出过一版——含没过线、停在等你裁决的那一版。已经烧过的
   *  那一版幂等键还在，「只补缺」会撞回它、后端如实返回 created:false；只看生效版
   *  (shot.video) 就把重跑发成补缺，按钮写着覆盖重来、亮着成功，却一笔任务也不排
   *  （2026-10-22 镜头 #9 实测：唯一一版停在等你裁决，重跑点了没反应）。
   *  动词和请求由这同一个判据决定，两处不许再分叉。 */
  const videoAttempted = Boolean(shot.video) || videoCands.length > 0
  const activeCandidate = (activeProduct === 'video' && activeArtifactId ? videoCands.find((candidate) => candidate.artifactId === activeArtifactId) : undefined) ?? videoCands.find((candidate) => candidate.artifactId === shot.video?.id) ?? videoCands[0] ?? null
  /** 大预览跟随正看的产物；版本点击换大预览。首帧/配音的生效版=钦定优先（API 已同口径）。 */
  const playerArtifact = activeProduct === 'frame' ? (frameCands.find((c) => c.artifactId === activeArtifactId) ? candidateToArtifact(frameCands.find((c) => c.artifactId === activeArtifactId)!) : shot.firstFrame) : activeProduct === 'audio' ? (voiceCands.find((c) => c.artifactId === activeArtifactId) ? candidateToArtifact(voiceCands.find((c) => c.artifactId === activeArtifactId)!) : shot.voice) : activeCandidate ? candidateToArtifact(activeCandidate) : shot.video
  const isPlayerVideo = activeProduct === 'video'

  /** 三件产物共用一套钦定端点；清空即回自动取最新。 */
  async function chooseArtifact(kind: 'video' | 'frame' | 'voice', artifactId: string | null) {
    setChoosing(true)
    try {
      const route = kind === 'video' ? 'video-selection' : kind === 'frame' ? 'frame-selection' : 'voice-selection'
      await api(`/storyboards/${shot.id}/${route}`, {
        method: 'POST',
        body: JSON.stringify({ artifactId }),
      })
      toast.success(artifactId ? t('shotboard.chosenToast') : t('shotboard.autoToast'))
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setChoosing(false)
    }
  }

  /** 收下弹窗里点名收的是哪一版——号、产物、版本、来路、实测时长，全是屏上已有读数，
   *  不另造一套编号口径。 */
  const takeLabel = (product: string, candidate: ShotVideoCandidate) =>
    `#${shot.number} ${product} v${candidate.version} · ${originWord(t, candidate.origin)}${candidate.durationMs !== null ? ` · ${formatDuration(candidate.durationMs)}` : ''}`

  const owesVoice = shotOwesVoice(shot)
  const voiceTrack = shotVoiceTrack(shot)
  /** 手工镜头（字卡/界面/录屏/合成）不给模型动词：它没有可重跑、可延长、可定向改的
   *  模型片段，画面只有本机渲染与导入两条来路（SD-108）。 */
  const handmade = shot.production !== 'video'

  // US-020+022: 延长与定向编辑（UX-P04 接上真实入口）。延长/修改作用在正看的那一版
  // （大预览跟随的版本），提交后不冒充成功入片——202 只是已受理，产物以候选身份原地
  // 出现，入片仍走「选这版」。
  const [operationForm, setOperationForm] = useState<'extend' | 'edit' | null>(null)
  const [extendDurationMs, setExtendDurationMs] = useState(5000)
  const [extendPolicy, setExtendPolicy] = useState<ArtifactApplyPolicy>('candidate_only')
  const [editInstruction, setEditInstruction] = useState('')
  const [editPolicy, setEditPolicy] = useState<ArtifactApplyPolicy>('candidate_only')
  const [submittingOperation, setSubmittingOperation] = useState<'extend' | 'edit' | null>(null)

  async function submitExtend() {
    if (!activeCandidate || submittingOperation !== null) return
    setSubmittingOperation('extend')
    try {
      await requestArtifactOperation(api, activeCandidate.artifactId, 'extend', {
        durationMs: extendDurationMs,
        applyPolicy: extendPolicy,
        expectedShotRevision: shot.stateRevision,
      })
      toast.success(t('preview.extendSuccess'))
      setOperationForm(null)
      // 提交即手动刷一次：操作行立刻进板，数据驱动的「延长中」不用等下一轮轮询。
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setSubmittingOperation(null)
    }
  }

  async function submitDirectedEdit() {
    if (!activeCandidate || editInstruction.trim() === '' || submittingOperation !== null) return
    setSubmittingOperation('edit')
    try {
      await requestArtifactOperation(api, activeCandidate.artifactId, 'edit', {
        instruction: editInstruction.trim(),
        applyPolicy: editPolicy,
      })
      toast.success(t('preview.editQueued'))
      // 指令草稿保留：失败重试与「我当时让它改什么」的回看都靠它，不因提交而清空。
      setOperationForm(null)
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setSubmittingOperation(null)
    }
  }

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
        {/* 大预览（2026-09-30 定稿 h-40=160px）：h-16/h-28 依次被用户打回压扁，
            160px 是控件+画面+人不高的折中。
            视频点击整面进灯箱审大图；省出的高度还给下方产物区。 */}
        <div className="relative">
          <button
            type="button"
            className="group bg-muted/30 relative block h-40 w-full overflow-hidden rounded-lg border"
            onClick={() => {
              if (activeProduct === 'video' && (shot.video || shot.videoCandidates.length > 0)) setReview({ artifactId: null })
            }}
          >
            {/* 生成中蒙版（2026-09-30 用户）：点生成/重跑时大预览立即切到该产物的生成中态，
              而非继续展示旧版本——旧版和新版混在同一个框里，用户分不清哪个在跑。 */}
            {stageBusy(activeProduct === 'frame' ? 'FIRST_FRAME' : activeProduct === 'audio' ? 'AUDIO' : 'VIDEO') ? (
              <span className="text-primary absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/80 backdrop-blur-sm">
                <LoaderCircleIcon className="size-5 animate-spin" />
                <span className="text-xs font-medium">{busyText(activeProduct === 'frame' ? 'FIRST_FRAME' : activeProduct === 'audio' ? 'AUDIO' : 'VIDEO') ?? t('generations.cellGenerating')}</span>
              </span>
            ) : isPlayerVideo && playerArtifact ? (
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
                {/* 这句话只说「成片还没有」，可它挂在所有回退分支上：正看切到配音而这一镜
                  还没配音时也会亮，于是镜下明明写着「视频片段 v1 · 4.0s」，上面却说还没抽成片
                  （2026-10-23 制作台实测 #14／#18）。成片真的没有才许说。 */}
                {!shot.video && shot.videoCandidates.length === 0 && (
                  <span className="bg-background/75 text-muted-foreground absolute inset-x-0 bottom-0 truncate px-1.5 py-0.5 text-[10px] backdrop-blur-sm">{t('shotboard.ph.videoOnlyFrame')}</span>
                )}
              </>
            ) : stageBusy('FIRST_FRAME') || stageBusy('VIDEO') ? (
              <span className="text-primary absolute inset-0 flex items-center justify-center gap-1.5 text-xs">
                <LoaderCircleIcon className="size-4 animate-spin" />
                {t('generations.cellGenerating')}
              </span>
            ) : (
              <span className="text-muted-foreground absolute inset-0 flex items-center justify-center px-4 text-center text-xs leading-snug">{shot.firstFrameError ? shotDemandText(t, shot, 'frame_failed') : shot.videoError ? shotDemandText(t, shot, 'video_failed') : t('generations.notGenerated')}</span>
            )}
            {shot.video && shot.videoError && <span className="bg-destructive text-destructive-foreground absolute top-1 right-1 rounded px-1 py-0.5 text-[10px] font-medium">{t('workbench.staleRetry')}</span>}
            {/* 放大入口常驻右上角：视频本体的点击留给原生播放/暂停，看大片走这里。 */}
          </button>
          {/* 这枚必须是大预览按钮的兄弟节点：button 套 button 是非法 HTML，React 会报
            hydration 错误并把整棵工作台退回客户端渲染（2026-10-22 镜头 #7 实拍）。 */}
          {(shot.video || shot.videoCandidates.length > 0) && (
            <button type="button" onClick={() => setReview({ artifactId: null })} className="bg-background/75 text-muted-foreground hover:text-foreground absolute top-2 right-2 z-10 inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium backdrop-blur-sm">
              <Maximize2Icon className="size-3" />
              {t('workbench.zoom')}
            </button>
          )}
        </div>

        {/* S3 产物区（r05 拍板）：去框清单——一次只展开正看的那件；全部展开可破例。
            展开钮=文字+方向箭头（用户：只有文字识别不到）。调整要求全局一次，随动词提交。 */}
        {canTrigger && (
          <div className="space-y-2">
            <input type="text" value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('workbench.notePlaceholder')} aria-label={t('workbench.noteLabel')} className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-2.5 py-1.5 text-xs" />
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-[11px] font-medium">
                {t('workbench.viewing', {
                  name: activeProduct === 'frame' ? t('storyboards.firstFrame') : activeProduct === 'audio' ? t('generations.stage.AUDIO') : t('storyboards.video'),
                })}
              </p>
              <button type="button" onClick={() => setOpenSections((prev) => (prev.size === 3 ? new Set() : new Set(['frame', 'video', 'audio'])))} className="text-primary inline-flex items-center gap-0.5 text-[11px] font-medium">
                <ChevronDownIcon className={cn('size-3 transition-transform', openSections.size === 3 ? '' : '-rotate-90')} />
                {openSections.size === 3 ? t('workbench.collapseAll') : t('workbench.expandAll')}
              </button>
            </div>

            {[
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
                rerunLabel: shot.firstFrame
                  ? t('workbench.rerunStage', {
                      stage: t('storyboards.firstFrame'),
                    })
                  : t('workbench.generateStage', {
                      stage: t('storyboards.firstFrame'),
                    }),
                onRerun: () => {
                  // 上一笔提交状态未知时，复用旧任务只会再撞台账保护（永远提交不出去），
                  // 且「只补缺」这条路对已有 BLOCKED 任务的镜返回 created:false——按钮亮
                  // 成功却什么都没发生。唯一出口是人工核对后新建一版，先明确再计费一次。
                  if (!shot.firstFrame && isUnknownSubmission(shot.firstFrameError)) {
                    setResubmitGate(true)
                    return
                  }
                  onRegenerate('FIRST_FRAME', note, Boolean(shot.firstFrame))
                },
                kind: 'image' as const,
              },
              {
                key: 'video' as const,
                label: t('storyboards.video'),
                candidates: videoCands,
                pinnedId: shot.selectedVideoArtifactId,
                busy: stageBusy('VIDEO'),
                hasOutput: Boolean(shot.video),
                errorText: handmade ? t('localVideo.empty') : shot.videoError ? t('workbench.lastFailed') : t('workbench.notGenerated'),
                pickLabel: t('workbench.pickVideo'),
                pinnedLabel: t('shotboard.candidateChosen'),
                rerunLabel: videoAttempted
                  ? t('workbench.rerunStage', { stage: t('storyboards.video') })
                  : t('workbench.generateStage', {
                      stage: t('storyboards.video'),
                    }),
                onRerun: () => {
                  if (!shot.firstFrame) {
                    setVideoGate(true)
                    return
                  }
                  onRegenerate('VIDEO', note, videoAttempted)
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
                rerunLabel: voiceTrack
                  ? t('workbench.rerunStage', {
                      stage: t('generations.stage.AUDIO'),
                    })
                  : t('workbench.generateStage', {
                      stage: t('generations.stage.AUDIO'),
                    }),
                onRerun: () => onRegenerate('AUDIO', note, Boolean(voiceTrack)),
                kind: 'audio' as const,
              },
              // 手工镜头不排首帧（SD-035 起 IMAGE 阶段就跳过它）：给它留一行「生成首帧」
              // 等于挂一枚点了什么也不会发生的按钮。
            ]
              .filter((section) => !(handmade && section.key === 'frame'))
              .map((section) => {
                // 展开态归 openSections 管（可全收起——用户实测「全部收起收不全」：
                // 旧实现 activeProduct 恒展开）。activeProduct 只管大预览跟谁走+行头选中态。
                const expanded = openSections.has(section.key)
                const isActive = activeProduct === section.key
                const count = section.candidates.length + (section.busy ? 1 : 0)
                // 「N 抽没过线被自动重抽」只数真被自动重抽过的：停在问询上的那一版没人
                // 重抽过它，算进去等于计费摘要说出与版本行相反的话；人已经收下的那一版
                // 也不再算——它没被重抽，只是带着低分入了片（红标只认审计未通过）。
                const reRolled = section.candidates.filter((candidate) => candidate.awaitingDecision !== true && candidate.qc?.status === 'NEEDS_REVIEW').length
                return (
                  <div key={section.key} className={cn('space-y-1 rounded-lg p-1.5', isActive ? 'bg-primary/10' : 'bg-muted/25')}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenSections((prev) => {
                          const next = new Set(prev)
                          if (next.has(section.key)) next.delete(section.key)
                          else next.add(section.key)
                          return next
                        })
                        setActiveProduct(section.key)
                        setActiveArtifactId(null)
                      }}
                      aria-expanded={expanded}
                      aria-current={isActive ? 'true' : undefined}
                      className="hover:bg-accent/50 flex w-full items-center gap-2.5 rounded-md px-1.5 py-2 text-left transition-colors"
                    >
                      <span className={cn('grid size-9 shrink-0 place-items-center', isActive ? 'text-primary' : 'text-muted-foreground')}>{section.key === 'frame' ? <ImageIcon className="size-4" /> : section.key === 'video' ? <ClapperboardIcon className="size-4" /> : <MicIcon className="size-4" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className={cn('block text-xs font-semibold', isActive && 'text-primary')}>{section.label}</span>
                        <span className="text-subtle-foreground block truncate text-[11px]">{section.hasOutput ? (section.candidates.find((c) => c.artifactId === section.pinnedId) ? `✓ ${section.pinnedLabel}` : t('workbench.autoPinned')) : section.errorText}</span>
                      </span>
                      {count > 0 && (
                        <span className={cn('inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium', isActive ? 'text-primary' : 'text-muted-foreground')}>
                          {t('workbench.versions', { count })}
                          <ChevronDownIcon className={cn('size-3.5 transition-transform', expanded ? '' : '-rotate-90')} />
                        </span>
                      )}
                    </button>
                    {expanded && (
                      <div className="mt-2.5">
                        {section.key === 'audio' && !owesVoice && section.candidates.length === 0 ? (
                          <p className="text-subtle-foreground px-1 py-1 text-[11px]">{t('workbench.audioNativePlaceholder')}</p>
                        ) : section.candidates.length === 0 && !section.busy ? (
                          <div>
                            <p className="text-subtle-foreground px-1 text-[11px]">{section.hasOutput ? '' : section.errorText}</p>
                            {/* 零版本时也要给动词入口——否则配音/首帧的「生成」按钮被锁在
                              展开区里永远够不着（2026-09-30 用户：哪有生成声音的地方）。
                              手工镜头例外：它的入口是下面的渲染/导入行，不是模型动词。 */}
                            {section.key === 'video' && handmade ? null : (
                              <Button variant="outline" size="sm" className="mt-1.5 h-7 text-[11px]" onClick={section.onRerun}>
                                <RotateCcwIcon className="size-3" />
                                {section.rerunLabel}
                              </Button>
                            )}
                          </div>
                        ) : section.kind === 'audio' ? (
                          <div className="space-y-1">
                            {section.candidates.map((candidate) => {
                              const isPlaying = candidate.artifactId === (activeProduct === 'audio' ? activeArtifactId : null)
                              return (
                                <div key={candidate.artifactId} className="flex items-center">
                                  <button
                                    type="button"
                                    aria-pressed={isPlaying}
                                    onClick={() => {
                                      setActiveProduct('audio')
                                      setActiveArtifactId(candidate.artifactId)
                                    }}
                                    className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors', isPlaying ? 'bg-accent' : 'hover:bg-accent/50')}
                                  >
                                    <span className={cn('shrink-0 text-[10px]', isPlaying ? 'text-primary' : 'text-muted-foreground')}>{isPlaying ? '▶' : '▷'}</span>
                                    <span className="min-w-0 flex-1 truncate text-[11px] tabular-nums">
                                      <span className={cn('font-medium', isPlaying && 'text-primary')}>v{candidate.version}</span>
                                      {candidate.origin !== 'generation' && <span className="text-muted-foreground">{` · ${originWord(t, candidate.origin)}`}</span>}
                                      {candidate.durationMs !== null && ` · ${formatDuration(candidate.durationMs)}`}
                                      {` · ${formatDateTime(candidate.createdAt, locale)}`}
                                    </span>
                                    {candidate.artifactId === section.pinnedId ? <span className="text-success-ink shrink-0 text-[11px]">✓ {section.pinnedLabel}</span> : null}
                                  </button>
                                  {can('storyboard:write') && isPlaying && candidate.artifactId !== section.pinnedId && candidate.awaitingDecision !== true && (
                                    <Button variant="default" size="sm" className="h-6 shrink-0 px-2 text-[11px]" disabled={choosing} onClick={() => void chooseArtifact('voice', candidate.artifactId)}>
                                      {section.pickLabel}
                                    </Button>
                                  )}
                                  {/* 停在问询上的那一版不能直接入成片（后端会拒），给它的是「收下」。 */}
                                  {canTrigger && isPlaying && candidate.awaitingDecision === true && candidate.taskId && (
                                    <Button variant="default" size="sm" className="h-6 shrink-0 px-2 text-[11px]" onClick={() => setAccept({ taskId: candidate.taskId!, label: takeLabel(section.label, candidate) })}>
                                      {t('generations.review.waive')}
                                    </Button>
                                  )}
                                  {candidate.awaitingDecision === true && !isPlaying && <span className="text-warning-ink shrink-0 text-[11px]">{t('workbench.awaitingDecision')}</span>}
                                </div>
                              )
                            })}
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-2">
                            {section.candidates.map((candidate) => (
                              <button
                                key={candidate.artifactId}
                                type="button"
                                onClick={() => {
                                  setActiveProduct(section.key)
                                  setActiveArtifactId(candidate.artifactId)
                                }}
                                aria-pressed={activeProduct === section.key && candidate.artifactId === activeArtifactId}
                                className={cn('relative overflow-hidden rounded-md', activeProduct === section.key && candidate.artifactId === activeArtifactId ? 'outline-primary outline-2 outline-offset-[-2px]' : '', candidate.artifactId === section.pinnedId ? 'border-primary border-b-2' : '')}
                              >
                                <ArtifactMedia artifact={candidateToArtifact(candidate)} label={`${section.label} v${candidate.version}`} interactive={false} className="aspect-video h-auto w-full" />
                                {(() => {
                                  // 被审计否决的尝试亮红并给原因——自动重抽花的是用户的钱，
                                  // 失败理由不许埋库（2026-09-29 用户：不合格是黑盒）。
                                  // 「等你裁决」的那一版不占用红色：红＝已被否，黄＝等人否——
                                  // 两色混用会让人把还没裁决的付费成片当成又一次失败。
                                  // 红标只认审计结论，不认分数：人收下的低分版 QC 已转 APPROVED，
                                  // 再按分数染红就会把「接受」显示成「被否」（2026-10-22 用户实拍）。
                                  const parked = candidate.awaitingDecision === true
                                  const rejected = candidate.qc?.status === 'NEEDS_REVIEW'
                                  const reasons = (candidate.qc?.reasons ?? []).join('\n')
                                  if (parked) {
                                    return (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span className="bg-warning/90 text-warning-foreground absolute inset-x-0 bottom-0 flex cursor-help items-center justify-between gap-1 px-1 py-0.5 text-[10px] font-medium">
                                            <span>v{candidate.version}</span>
                                            <span className="truncate">{t('workbench.awaitingDecision')}</span>
                                          </span>
                                        </TooltipTrigger>
                                        <TooltipContent className="max-w-72 whitespace-pre-line text-left text-[11px] leading-relaxed">
                                          {t('workbench.awaitingDecisionHint')}
                                          {reasons && `\n\n${reasons}`}
                                        </TooltipContent>
                                      </Tooltip>
                                    )
                                  }
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
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className="bg-background/75 absolute inset-x-0 bottom-0 flex cursor-default items-center justify-between gap-1 px-1 py-0.5 text-[10px] font-medium backdrop-blur-sm">
                                          <span className="truncate">
                                            v{candidate.version}
                                            <span className="text-subtle-foreground">{` · ${originWord(t, candidate.origin)}`}</span>
                                            {candidate.durationMs !== null && <span className="text-subtle-foreground">{` · ${formatDuration(candidate.durationMs)}`}</span>}
                                          </span>
                                          <span className="flex shrink-0 items-center gap-1">
                                            {candidate.qc?.score != null && <span className="text-subtle-foreground">{Math.round(candidate.qc.score * 100)}</span>}
                                            {candidate.artifactId === section.pinnedId && <span className="text-success-ink">✓ {section.pinnedLabel}</span>}
                                          </span>
                                        </span>
                                      </TooltipTrigger>
                                      {/* 版本行的完整档案：两条来源会出现同号不同片，生成时间是分清它们的凭据。 */}
                                      <TooltipContent className="text-[11px]">
                                        <p className="tabular-nums">{`v${candidate.version} · ${originWord(t, candidate.origin)}${candidate.durationMs !== null ? ` · ${formatDuration(candidate.durationMs)}` : ''}`}</p>
                                        <p className="text-muted-foreground tabular-nums">{formatDateTime(candidate.createdAt, locale)}</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  )
                                })()}
                              </button>
                            ))}
                            {section.busy && (
                              <span className="border-primary/40 text-primary grid aspect-video place-items-center rounded-md border border-dashed px-1 text-center text-[10px]">
                                <span className="flex items-center gap-1">
                                  <LoaderCircleIcon className="size-3 animate-spin" />
                                  {busyText(section.key === 'frame' ? 'FIRST_FRAME' : section.key === 'video' ? 'VIDEO' : 'AUDIO') ?? t('generations.cellGenerating')}
                                </span>
                              </span>
                            )}
                          </div>
                        )}
                        {/* 手工镜头的画面来路（SD-108）：字卡走本机渲染，其余三档收人给的片段。
                          key 绑镜头 id——左右键换镜时这一行的文字框必须跟着换，不能留上一镜的字。 */}
                        {section.key === 'video' && handmade && <LocalVideoRow key={shot.id} shot={shot} onChanged={onChanged} />}
                        {/* 延长/定向编辑操作状态：失败就地亮出（重试=菜单里再发起一次），
                          在途状态由候选格的虚线占位与按钮态承载。 */}
                        {section.key === 'video' && failedOperation && (
                          <div className="border-destructive/30 bg-destructive/5 mt-2 rounded-md border px-2 py-1.5 text-[11px]">
                            <p className="text-destructive-ink font-medium">
                              {failedOperation.kind === 'video_edit' ? t('preview.directedEdit') : t('preview.extend')} · {t('preview.opFailed')}
                            </p>
                            {/* 英文报文不上扫描面（SD-121）：这一行的职责是让人知道发生了什么，
                              报错原文是给排障的人取的证据，收进 Tooltip。 */}
                            {failedOperation.error && (
                              <p className="mt-0.5">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="text-subtle-foreground cursor-help rounded border px-1.5 py-0.5 text-[10.5px]">{t('workbench.rawErrorTrigger')}</span>
                                  </TooltipTrigger>
                                  <TooltipContent className="max-w-96 break-words text-left text-[11px] leading-relaxed">{failedOperation.error}</TooltipContent>
                                </Tooltip>
                              </p>
                            )}
                          </div>
                        )}
                        {section.key === 'video' && operationForm !== null && activeCandidate && (
                          <div className="border-border/60 mt-2 space-y-2.5 rounded-md border p-2.5">
                            <div className="flex items-center justify-between">
                              <p className="text-xs font-semibold">{operationForm === 'extend' ? t('preview.extend') : t('preview.directedEdit')}</p>
                              {/* 源片=正看的那一版：操作作用对象明示，不藏在别处。 */}
                              <p className="text-muted-foreground text-[11px]">
                                {t('preview.sourceVersion')}: v{activeCandidate.version}
                              </p>
                            </div>
                            {operationForm === 'extend' ? (
                              <>
                                <p className="text-muted-foreground text-[11px]">{t('preview.extendDesc')}</p>
                                <div className="flex flex-wrap items-center gap-2">
                                  <label className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                                    {t('preview.extendDuration')}
                                    <select value={extendDurationMs} onChange={(event) => setExtendDurationMs(Number(event.target.value))} className="bg-background border-input rounded border px-1.5 py-1 text-[11px]">
                                      {[2000, 5000, 10000].map((ms) => (
                                        <option key={ms} value={ms}>
                                          +{ms / 1000}s
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <label className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                                    {t('preview.policyLabel')}
                                    <select value={extendPolicy} onChange={(event) => setExtendPolicy(event.target.value as ArtifactApplyPolicy)} className="bg-background border-input rounded border px-1.5 py-1 text-[11px]">
                                      {EXTEND_POLICIES.map((policy) => (
                                        <option key={policy} value={policy}>
                                          {policyWord(t, policy)}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                </div>
                              </>
                            ) : (
                              <>
                                <p className="text-muted-foreground text-[11px]">{t('preview.editDesc')}</p>
                                <textarea rows={2} value={editInstruction} onChange={(event) => setEditInstruction(event.target.value)} placeholder={t('preview.editPrompt')} aria-label={t('preview.editPrompt')} className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-2 py-1.5 text-xs" />
                                <label className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                                  {t('preview.policyLabel')}
                                  <select value={editPolicy} onChange={(event) => setEditPolicy(event.target.value as ArtifactApplyPolicy)} className="bg-background border-input rounded border px-1.5 py-1 text-[11px]">
                                    {EDIT_POLICIES.map((policy) => (
                                      <option key={policy} value={policy}>
                                        {policyWord(t, policy)}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </>
                            )}
                            <div className="flex items-center justify-end gap-2">
                              <Button variant="outline" size="sm" className="h-7 text-[11px]" disabled={submittingOperation !== null} onClick={() => setOperationForm(null)}>
                                {t('common.cancel')}
                              </Button>
                              <Button variant="default" size="sm" className="h-7 text-[11px]" disabled={submittingOperation !== null || (operationForm === 'edit' && editInstruction.trim() === '')} onClick={() => void (operationForm === 'extend' ? submitExtend() : submitDirectedEdit())}>
                                {submittingOperation === operationForm ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
                                {operationForm === 'extend' ? t('preview.extendSubmit') : t('preview.editSubmit')}
                              </Button>
                            </div>
                          </div>
                        )}
                        {reRolled > 0 && (
                          <p className="text-faint-foreground mt-2 px-0.5 text-[11px]">
                            {t('workbench.reworkCost', { count: reRolled })}
                          </p>
                        )}
                        <div className="mt-2.5 flex flex-wrap items-center gap-2">
                          {(() => {
                            // 正看的那一版还没钦定时，「选这版」就是裁决动作本尊（S3：动词分产物——
                            // 视频=入片、首帧=定视频起点）。配音的选这版在版本行内（要试听后选）。
                            const active = activeProduct === section.key && activeArtifactId !== null ? section.candidates.find((candidate) => candidate.artifactId === activeArtifactId) : undefined
                            // 停在「等你裁决」上的那一版还不成片，后端按非终态拒钦定：这一格给的
                            // 动词换成「收下这版」，位置与形状都跟「选这版」同档（SD-120）。
                            if (active?.awaitingDecision === true) {
                              return active.taskId && canTrigger ? (
                                <Button variant="default" size="sm" className="h-7 text-[11px]" onClick={() => setAccept({ taskId: active.taskId!, label: takeLabel(section.label, active) })}>
                                  {t('generations.review.waive')}
                                </Button>
                              ) : null
                            }
                            const pickable = section.kind === 'image' && can('storyboard:write') && active && active.artifactId !== section.pinnedId
                            return pickable ? (
                              <Button variant="default" size="sm" className="h-7 text-[11px]" disabled={choosing} onClick={() => void chooseArtifact(section.key === 'frame' ? 'frame' : 'video', active.artifactId)}>
                                {section.pickLabel}
                              </Button>
                            ) : null
                          })()}
                          {section.key === 'video' && handmade ? null : section.key === 'video' && videoCands.length > 0 && can('episode:write') ? (
                            // 有视频时主动作是「调整这一镜」（UX §5.2）：重跑/延长/定向修改收进
                            // 一个动词菜单——同区块可见按钮不因新增两个动作而膨胀（做减法=收敛入口）。
                            // 手工镜头整条不画：那三个动词都需要一条模型片段，给它等于挂一个必失败的按钮。
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <GuardedButton action="episode:write" variant="outline" size="sm" className="h-7 text-[11px]">
                                  {t('preview.adjustShot')}
                                  <ChevronDownIcon className="size-3" />
                                </GuardedButton>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start">
                                <DropdownMenuItem disabled={section.busy} onClick={section.onRerun}>
                                  <RotateCcwIcon className="size-3.5" />
                                  {t('workbench.rerunStage', {
                                    stage: t('storyboards.video'),
                                  })}
                                </DropdownMenuItem>
                                <DropdownMenuItem disabled={!activeCandidate || operationBusy || submittingOperation !== null} onClick={() => setOperationForm((form) => (form === 'extend' ? null : 'extend'))}>
                                  {t('preview.extend')}
                                </DropdownMenuItem>
                                <DropdownMenuItem disabled={!activeCandidate || operationBusy || submittingOperation !== null} onClick={() => setOperationForm((form) => (form === 'edit' ? null : 'edit'))}>
                                  {t('preview.directedEdit')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : section.candidates.length > 0 && (section.key !== 'audio' || owesVoice) ? (
                            // 零版本时动词入口在空态那一处（上方）；这里只服务已有版本的重跑，
                            // 否则同一个「生成「视频片段」」会在区块里出现两枚。
                            <Button variant="outline" size="sm" className="h-7 text-[11px]" disabled={section.busy} onClick={section.onRerun}>
                              <RotateCcwIcon className="size-3" />
                              {section.rerunLabel}
                            </Button>
                          ) : null}
                          {section.key === 'video' && (shot.video || shot.videoCandidates.length > 0) && (
                            <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => setReview({ artifactId: null })}>
                              <Maximize2Icon className="size-3" />
                              {t('workbench.zoom')}
                            </Button>
                          )}
                          {section.key !== 'audio' && can('storyboard:write') && (section.candidates.find((c) => c.artifactId === section.pinnedId) || null) && (
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

        {/* 没有触发生成权限的人也要能推进手工镜头：这两行不依赖模型，跟着镜头走。 */}
        {!canTrigger && (
          <>
            {handmade && <LocalVideoRow key={shot.id} shot={shot} onChanged={onChanged} />}
            <AudioSourceRow shot={shot} onChanged={onChanged} />
          </>
        )}

        {(shot.firstFrameError || shot.videoError) && (
          <div className="border-destructive/30 bg-destructive/5 rounded-md border px-3 py-2 text-xs">
            {shot.firstFrameError && <p className="text-destructive-ink">{shotDemandText(t, shot, 'frame_failed')}</p>}
            {shot.videoError && <p className={cn('text-destructive-ink', shot.firstFrameError && 'mt-1')}>{shotDemandText(t, shot, 'video_failed')}</p>}
            {/* 同上（SD-121）：人话那句留在屏上，worker 的英文原文收进 Tooltip 供排障取用。 */}
            {(shot.firstFrameError || shot.videoError) && (
              <p className="mt-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-subtle-foreground cursor-help rounded border px-1.5 py-0.5 text-[10.5px]">{t('workbench.rawErrorTrigger')}</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-96 break-words text-left text-[11px] leading-relaxed">
                    {[shot.firstFrameError, shot.videoError].filter(Boolean).join('\n')}
                  </TooltipContent>
                </Tooltip>
              </p>
            )}
          </div>
        )}

        {shot.qc.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {shot.qc.map((verdict) => (
              <Badge key={verdict.kind} variant={verdict.status === 'APPROVED' ? 'success' : verdict.status === 'NEEDS_REVIEW' ? 'warning' : 'muted'} className="font-normal tabular-nums">
                QC {verdict.kind} {verdict.score !== null ? Math.round(verdict.score * 100) : '—'}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="border-border/60 flex items-center justify-between gap-2 border-t px-3 py-2">
        <Button variant="outline" size="sm" disabled={!hasPrev} onClick={onPrev}>
          <ChevronLeftIcon />
          {prevNumber !== null ? t('workbench.prevShot', { number: prevNumber }) : t('workbench.prevShotEmpty')}
        </Button>
        <Button variant="outline" size="sm" disabled={!hasNext} onClick={onNext}>
          {nextNumber !== null ? t('workbench.nextShot', { number: nextNumber }) : t('workbench.nextShotEmpty')}
          <ChevronRightIcon />
        </Button>
        {/* 键盘提示只在右列有 23rem 的宽度时出现；更窄时它会挤成竖排。 */}
        <span className="text-muted-foreground ml-auto hidden items-center gap-1 whitespace-nowrap text-[11px] min-[1440px]:flex">
          <kbd className="border-border/70 rounded border px-1 font-sans">←</kbd>
          <kbd className="border-border/70 rounded border px-1 font-sans">→</kbd>
          {t('workbench.kbdHint')}
        </span>
      </div>

      {review && <VideoReviewLightbox shot={shot} initialArtifactId={review.artifactId} onClose={() => setReview(null)} onChanged={onChanged} />}
      {accept && <AcceptTakeDialog taskId={accept.taskId} label={accept.label} onClose={() => setAccept(null)} onChanged={onChanged} />}

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
            <AlertDialogAction onClick={() => onRegenerate('FIRST_FRAME', note)}>{t('workbench.videoGate.proceed')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resubmitGate} onOpenChange={setResubmitGate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('workbench.resubmitGate.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('workbench.resubmitGate.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => onRegenerate('FIRST_FRAME', note, true)}>{t('workbench.resubmitGate.proceed')}</AlertDialogAction>
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
      <span className={cn('relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md', !media && state === 'done' && 'bg-success/10 text-success-ink', !media && state === 'busy' && 'bg-primary/10 text-primary', !media && state === 'idle' && 'bg-muted/50 text-muted-foreground', media && state === 'done' && 'ring-1 ring-success/60', media && state === 'busy' && 'ring-1 ring-primary/70')}>
        {state === 'busy' && !media ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : media ? <ArtifactMedia artifact={media} label={label} className="h-full w-full max-h-none border-0 object-cover" /> : icon}
        {state === 'busy' && media && <LoaderCircleIcon className="text-primary absolute size-3 animate-spin" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{label}</p>
        <p className="text-subtle-foreground mt-0.5 text-[11px]">{meta}</p>
      </div>
      <GuardedButton action="generation:trigger" variant="outline" size="sm" className="h-7 text-[11px]" disabled={disabled} onClick={onClick}>
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

/** 候选来源词（UX-P04）：版本行如实标注这一版是怎么来的——生成/延长/定向修改，
 *  以及本机画的字卡与人交进来的一段片（后两种没有调用履历，不写「第 N 次生成」）。 */
function originWord(t: (key: string) => string, origin: ShotCandidateOrigin): string {
  if (origin === 'local_render' || origin === 'imported') return t(`candidate.origin.${origin}`)
  return t(origin === 'extend' ? 'candidate.origin.extend' : origin === 'directed_edit' ? 'candidate.origin.directed_edit' : 'candidate.origin.generation')
}

/** 采用策略词：延长/定向修改表单里的选项，与端点真正支持的策略一一对应。 */
function policyWord(t: (key: string) => string, policy: ArtifactApplyPolicy): string {
  return t(`preview.policy.${policy}`)
}
