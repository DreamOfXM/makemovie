'use client'

import { CheckCircle2Icon, ClapperboardIcon, ImageIcon, LoaderCircleIcon, MicIcon } from 'lucide-react'
import type { ShotboardShot } from '@/lib/api'
import { audioDotWord, cardStage, heardAudioWord, retryWordForError, shotAudioMode, shotDemandText, shotFailureKind, shotOwesVoice, shotVerdict, shotVoiceTrack, stageWord, retryWithOutputLeft, type CardStage } from '@/lib/shot-verdict'
import { useI18n, type TranslateFn } from '@/lib/i18n'
import { cn, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ArtifactMedia } from '@/components/generations/artifact-media'

/** 键必须写全——写成 Record<string, …> 时漏一个键不会报错，只会让 Badge 落回
 *  defaultVariants（实心 primary，即「已钦定」那层皮）。 */
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

/** 顶部 3px 标带：琥珀=你、红=真没画面可用、绿=完事、无=还没轮到。手机上扫这一条就够。
 *  'retry' 不描带也不描边：红已经落在没过线的那一格上，整卡泛红会把三枚绿点说成假话。
 *  'complete' 同样不描：产物齐了但没人签过，描绿等于把「未验收」说成「已通过」。 */
const flagFill: Record<CardStage, string | null> = {
  blocked: 'bg-destructive',
  failed: 'bg-destructive',
  review: 'bg-warning',
  retry: null,
  complete: null,
  running: null,
  approved: 'bg-success',
  idle: null,
  start: null,
}

/** 三枚点的语义：绿=这一阶段**手上有可用产物**，不是「已通过验收」。
 *  最新一次重抽没过线时格子仍绿（旧产物确实在），红只落在缩略图右上角那一格。
 *  'na' = 这一镜根本不需要这一阶段（无台词就不产配音）。灰色是「还没产」，
 *  把不需要画成还没产，卡片就会同时说「已齐」和「还缺一枚」。 */
function StageDot({ label, hint, state, icon }: { label: string; hint: string; state: 'done' | 'running' | 'failed' | 'idle' | 'na'; icon: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={hint}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] tabular-nums',
            state === 'done' && 'border-success/30 bg-success/10 text-success-ink',
            state === 'running' && 'border-info/30 bg-info/10 text-info-ink',
            state === 'failed' && 'border-destructive/30 bg-destructive/10 text-destructive-ink',
            state === 'idle' && 'border-border/60 bg-muted/30 text-muted-foreground',
            state === 'na' && 'border-dashed border-border/60 text-muted-foreground/70',
          )}
        >
          {state === 'running' ? <LoaderCircleIcon className="size-3 animate-spin" /> : icon}
          {label}
        </span>
      </TooltipTrigger>
      {/* 「绿」到底指什么，只有这一句说清；挂在原生 title 上等于没有提示 */}
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

/** 占位框/画面下方那行字：阻塞的卡不用再点进去猜是谁卡住了它。 */
function reasonText(t: TranslateFn, shot: ShotboardShot): string | null {
  const first = shotVerdict(shot).reasons[0]
  return first ? shotDemandText(t, shot, first) : null
}

/** 空格只回答「这一格为什么是空的」。旧版按整镜 slot 出一句话共用给两格，于是只有首帧的
 *  镜头会在「视频片段」那格里写「首帧已出 · 点开放大」——它答的不是这一格的问题。 */
function cellCaption(t: TranslateFn, shot: ShotboardShot, cell: 'firstFrame' | 'video'): string {
  if (cell === 'video' && shot.firstFrame) return t('shotboard.ph.videoOnlyFrame')
  return shot.slot === 'running' ? t('shotboard.ph.running') : t('shotboard.ph.empty')
}

/**
 * 一格画面 + 左下角它自己的名字。分镜首帧与成片并排而不是二选一:
 * 用户要看的正是"画出来的和计划的那一镜差在哪",叠成一张图就永远比不出来。
 * `staleWord` = 这一阶段最新一抽砸了、格子上显示的仍是上一版时的那句短话：红角标必须落在
 * 它指的那一格上，而不是飘在卡片右上角变成「整镜被阻塞」；措辞跟着这一格的报文走，
 * 额度耗尽写成「没过线」就是把用户推回去改提示词。
 */
function ShotSlot({
  label,
  artifact,
  busy,
  empty,
  staleWord,
}: {
  label: string
  artifact: ShotboardShot['video']
  busy: boolean
  empty: string
  /** 这一格有上一版、但最新一抽砸了时的那句短话（按真因分档）；没有上一版时为 null。 */
  staleWord: string | null
}) {
  const { t } = useI18n()
  return (
    <div className="bg-muted/30 relative aspect-video overflow-hidden rounded">
      {artifact ? (
        <ArtifactMedia artifact={artifact} label={label} interactive={false} className="h-full max-h-none w-full object-cover" />
      ) : busy ? (
        <span className="text-primary absolute inset-0 flex items-center justify-center gap-1 text-[11px]">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          {t('generations.cellGenerating')}
        </span>
      ) : (
        <span className="text-muted-foreground absolute inset-0 flex items-center justify-center px-2 text-center text-[11px] leading-snug">
          {empty}
        </span>
      )}
      {staleWord && (
        <span className="bg-destructive text-destructive-foreground absolute top-1 right-1 rounded px-1 py-0.5 text-[10px] font-medium">
          {staleWord}
        </span>
      )}
      <span className="bg-background/75 text-muted-foreground absolute inset-x-0 bottom-0 truncate px-1.5 py-0.5 text-[10px] backdrop-blur-sm">
        {label}
      </span>
    </div>
  )
}

interface ShotCardProps {
  shot: ShotboardShot
  onSelect: (shotId: string) => void
  /** Jump to the flow view at this shot — where the actual fixing happens. */
  onOpenShot: (shotId: string) => void
  /** Jump to the flow view at the asset review section. */
  onReviewAssets: () => void
}

export function ShotCard({ shot, onSelect, onOpenShot, onReviewAssets }: ShotCardProps) {
  const { t } = useI18n()

  const stageState = (done: boolean, inflightStage: boolean, failed: boolean): 'done' | 'running' | 'failed' | 'idle' =>
    done ? 'done' : inflightStage ? 'running' : failed ? 'failed' : 'idle'

  const frameInflight = shot.inflight.includes('FIRST_FRAME')
  const videoInflight = shot.inflight.includes('VIDEO')
  const voiceInflight = shot.inflight.includes('AUDIO')

  const verdict = shotVerdict(shot)
  const reason = reasonText(t, shot)
  const retry = verdict.stage === 'blocked' && retryWithOutputLeft(shot)
  // 「被阻塞」只留给真的被标住/被素材卡住的镜。首帧从没成功过不是阻塞，是这一阶段失败：
  // 徽章必须和顶部队列、放映条用同一个词，否则三处对同一镜各说一套。
  const stage = cardStage(shot, verdict)
  const flag = flagFill[stage]
  const hasMedia = Boolean(shot.video || shot.firstFrame)
  // 第三枚点报的是这一镜成片里真听到的声音来源，不再是「有没有配音产物」。
  // 「只用原声」的镜永远不排 AUDIO，所以它是「不需要产」而不是「还没产」——画成灰色
  // 就等于在写着「已齐 2/2」的卡上留一枚缺件。
  const audioMode = shotAudioMode(shot)
  const audioTrack = shotVoiceTrack(shot)
  const audioNA = !shotOwesVoice(shot)
  // 导进来的环境音占的是原声那一格，所以「只用配音」+ 一条底，成片里听到的其实是两样。
  // 卡片这枚点的悬停读数必须跟着说，否则卡上说配音、点开弹窗却多一条底。
  const heardWord = heardAudioWord(t, shot)

  // 每格只念自己那一阶段的失败：首帧没过线写进成片那格，就等于又造一处对不上的话。
  // 只有整镜级别的等待（素材未验收、被标阻塞）才两格共用。
  const shotWait = verdict.reasons.includes('asset_gate') || verdict.reasons.includes('shot_blocked') ? reason : null
  const cellEmpty = (code: 'frame_failed' | 'video_failed', failed: boolean) =>
    failed ? shotDemandText(t, shot, code) : shotWait ?? cellCaption(t, shot, code === 'frame_failed' ? 'firstFrame' : 'video')

  // 一张卡只给一枚该按的按钮，紫色实心留给「等你处理」的两种卡。
  const primary =
    verdict.stage === 'review'
      ? { label: t('shotboard.action.review'), run: () => onOpenShot(shot.id) }
      : verdict.stage === 'blocked'
        ? shot.attention.includes('asset_gate')
          ? { label: t('shotboard.action.assets'), run: onReviewAssets }
          : { label: t('shotboard.action.fix'), run: () => onOpenShot(shot.id) }
        : null
  // 副按钮永远指向详情，不复读主按钮的动作；没有主按钮时才轮到「去生成」。
  const detail = {
    label: shot.video ? t('shotboard.action.watch') : verdict.stage === 'blocked' ? t('shotboard.action.why') : t('shotboard.action.detail'),
    run: () => onSelect(shot.id),
  }
  const ghost = primary || hasMedia || verdict.stage === 'running' ? detail : { label: t('shotboard.action.start'), run: () => onOpenShot(shot.id) }

  return (
    <article
      className={cn(
        'relative flex h-full w-full flex-col overflow-hidden rounded-lg border bg-card transition-colors',
        verdict.stage === 'blocked' && !retry && 'border-destructive/40',
        verdict.stage === 'review' && 'border-warning/40',
        // 已通过不用再管它：整卡降饱和，按钮也跟着降成描边。
        verdict.stage === 'approved' && 'opacity-70',
      )}
    >
      {flag && <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[3px]', flag)} />}
      <button
        type="button"
        onClick={() => onSelect(shot.id)}
        className="group flex w-full flex-1 flex-col gap-2 p-3 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-muted-foreground font-mono text-xs">
              #{shot.number} · {formatDuration(shot.durationMs)}
            </p>
            <p className="truncate text-sm font-medium">{shot.title}</p>
          </div>
          <Badge variant={stageBadge[stage]} className="shrink-0 font-normal">
            {stageWord(t, verdict, stage, false, shotFailureKind(shot))}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-1">
          <ShotSlot
            label={t('storyboards.firstFrame')}
            artifact={shot.firstFrame}
            busy={frameInflight}
            empty={cellEmpty('frame_failed', Boolean(shot.firstFrameError))}
            staleWord={shot.firstFrame && shot.firstFrameError ? retryWordForError(t, shot.firstFrameError) : null}
          />
          <ShotSlot
            label={t('storyboards.video')}
            artifact={shot.video}
            busy={videoInflight}
            empty={cellEmpty('video_failed', Boolean(shot.videoError))}
            staleWord={shot.video && shot.videoError ? retryWordForError(t, shot.videoError) : null}
          />
        </div>

        {reason && hasMedia && (
          <p className="text-destructive-ink line-clamp-2 text-[11px] leading-snug">{reason}</p>
        )}

        <div className="flex flex-wrap items-center gap-1">
          <StageDot
            label={t('storyboards.firstFrame')}
            hint={t('shotboard.chip.hasOutput')}
            state={stageState(Boolean(shot.firstFrame), frameInflight, Boolean(shot.firstFrameError))}
            icon={<ImageIcon className="size-3" />}
          />
          <StageDot
            label={t('storyboards.video')}
            hint={t('shotboard.chip.hasOutput')}
            state={stageState(Boolean(shot.video), videoInflight, Boolean(shot.videoError))}
            icon={<ClapperboardIcon className="size-3" />}
          />
          <StageDot
            label={audioDotWord(t, audioMode)}
            hint={t(audioTrack ? 'shotboard.audio.dotPlayable' : 'shotboard.audio.dotHint', { mode: heardWord })}
            state={audioNA ? 'na' : stageState(Boolean(audioTrack), voiceInflight, false)}
            icon={<MicIcon className="size-3" />}
          />
        </div>

        {shot.usage && (
          <p className="text-muted-foreground text-[11px] tabular-nums">
            {t('shotboard.usageCalls', { calls: shot.usage.calls })} · {shot.usage.models.length} {t('shotboard.models')}
          </p>
        )}

        {/* 选优门状态:钦定过就报绿,让人知道卡片上这版就是会入片的那版。 */}
        {shot.videoCandidates.some(candidate => candidate.selected) && (
          <p className="text-success-ink flex items-center gap-1 text-[11px]">
            <CheckCircle2Icon className="size-3" />
            {t('shotboard.versionChosen')}
          </p>
        )}
      </button>

      <div className="flex items-center gap-1.5 px-3 pb-3">
        {primary && (
          <Button size="sm" onClick={primary.run}>
            {primary.label}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={ghost.run}>
          {ghost.label}
        </Button>
      </div>
    </article>
  )
}
