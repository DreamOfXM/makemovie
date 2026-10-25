'use client'

import { useState } from 'react'
import {
  ArchiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ImageIcon,
  LoaderCircleIcon,
  MicIcon,
  PencilIcon,
  VideoIcon,
  WorkflowIcon,
} from 'lucide-react'
import {
  isLiveStoryboard,
  toWorkflowStatus,
  type Asset,
  type GenerationArtifact,
  type GenerationTask,
  type Storyboard,
} from '@/lib/api'
import { translateEnum, useI18n, type TranslateFn } from '@/lib/i18n'
import { mediaFailureCopy } from '@/lib/failure-cause'
import { cn, formatDuration } from '@/lib/utils'
import type { ShotEvent } from '@/lib/shot-history'
import { audioModeWord, cloudVoiceEntersMaster, shotAudioMode, shotOwesVoice, shotVoiceTrack } from '@/lib/shot-verdict'
import { Badge } from '@/components/ui/badge'
import { HelpHint } from '@/components/ui/help-hint'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LineageBadge } from '@/components/lineage-badge'
import { ArtifactMedia } from '@/components/generations/artifact-media'
import { referenceTraceCopy } from '@/components/generations/generations-panel'
import { ShotHistory, ShotReadout } from '@/components/storyboards/shot-history'

/** The three stages that belong to one shot rather than to the whole episode. */
const SHOT_STAGES = ['IMAGE', 'VIDEO', 'AUDIO'] as const
export type ShotStage = (typeof SHOT_STAGES)[number]

const SHOT_STAGE_ICONS: Record<ShotStage, typeof ImageIcon> = {
  IMAGE: ImageIcon,
  VIDEO: VideoIcon,
  AUDIO: MicIcon,
}

interface StoryboardCardProps {
  storyboard: Storyboard
  canWrite: boolean
  episodeAssets: Asset[]
  onBindAssets(storyboardId: string, assets: { assetId: string }[]): Promise<void>
  onEdit(): void
  onChangeStatus(): void
  /** 逐镜重生成:操作发生在分镜卡上(用户看镜头的地方),结果回写同卡片。
   *  regenerate 由卡片按「这一格手上有没有产物」算出:缺产物走「生成」(只补缺),
   *  有产物走「重跑」(覆盖重来)。请求、按钮字样、说明与回执四处读同一个判据(SD-070)。 */
  onRegenerateStage?(storyboardId: string, stage: ShotStage, regenerate: boolean): void
  /** 正在重生成的镜头与阶段(`${id}:${stage}`),用于按钮转圈与禁用。 */
  regeneratingShotStage?: string | null
  /** 数据驱动的进行中键(`${id}:${stage}`):任务在排队/运行时按钮保持转圈,直到出图。 */
  generatingShotStages?: Set<string>
  /** 每镜每阶段的最新任务(`${id}:${stage}`):产物未落库时它的失败原因/状态是格子的唯一线索。 */
  shotTasks?: Map<string, GenerationTask>
  /** 这一镜的时间轴条目(按镜号聚合,跨批次跨阶段)。不传就不长这一栏。 */
  events?: ShotEvent[]
  /** 质检线:由后端随批次下发。缺省=还不知道,那就既不涂红绿也不写「线多少」。 */
  qcThreshold?: number
  /** 钦定入片版本(选优门同一端点),只有当前那一版可被钦定。 */
  onPinVideo?(artifactId: string): void
}

function artifactOf(storyboard: Storyboard, stage: ShotStage): GenerationArtifact | null | undefined {
  return stage === 'IMAGE' ? storyboard.firstFrame : stage === 'VIDEO' ? storyboard.video : shotVoiceTrack(storyboard)
}

/**
 * 卡片这一格放哪一条成片：生效版（钦定 > 最新成功 > 本机画面）优先，没有生效版时
 * 退到停在「等你裁决」上的那一版（SD-168）。那一版是真花了钱、播放器放得出来的产物，
 * 把它藏起来就会出现同一张卡上「成片重抽没过线」与「还没有成片」并排的自相矛盾。
 * 只给画面与时长读数用；状态点仍认生效版，否则未过线的版本会被涂成绿。
 */
export function shotClip(storyboard: Storyboard): GenerationArtifact | null | undefined {
  return storyboard.video ?? storyboard.videoParked
}

/** 落库时长优先；缺了就取播放器刚量到的那个值——但只认同一份产物，换版后旧读数立刻作废。 */
function measuredDurationMs(
  artifact: GenerationArtifact | null | undefined,
  hit: { id: string; ms: number } | null,
): number | null {
  if (!artifact) return null
  return artifact.durationMs ?? (hit && hit.id === artifact.id ? hit.ms : null)
}

/**
 * SD-104(d)：素材定妆照没参与本次生成这件事，过去只有展开批次深处才看得见
 * （实测镜头卡 `shot_card_reference_lines: []`）。逐镜评审处必须自己说一遍，
 * 否则人读完这一镜并不知道画面质感不是由已审批的定妆照撑起来的。
 * 只报「没吃进参考图」的那几条：正常条件化的一进一退是流水线的常态，不值得占屏。
 */
export function shotReferenceDegradations(
  t: TranslateFn,
  storyboardId: string,
  shotTasks?: Map<string, GenerationTask>,
) {
  return (['IMAGE', 'VIDEO'] as const).flatMap(stage => {
    const entries = shotTasks?.get(`${storyboardId}:${stage}`)?.retryTrace?.reference ?? []
    return entries.filter(entry => !entry.conditioned).map(entry => referenceTraceCopy(t, entry))
  })
}

/** 首帧/视频的失败理由分镜数据自带;配音没有独立错误字段,回落到最新一次 AUDIO 任务。 */
function errorOf(
  storyboard: Storyboard,
  stage: ShotStage,
  shotTasks?: Map<string, GenerationTask>,
): string | null {
  if (stage === 'IMAGE') return storyboard.firstFrameError ?? null
  if (stage === 'VIDEO') return storyboard.videoError ?? null
  const task = shotTasks?.get(`${storyboard.id}:AUDIO`)
  return task && task.status === 'FAILED' ? (task.error ?? null) : null
}

type DotState = 'ok' | 'run' | 'err' | 'idle'

function dotState(
  storyboard: Storyboard,
  stage: ShotStage,
  busy: boolean,
  shotTasks?: Map<string, GenerationTask>,
): DotState {
  if (busy) return 'run'
  if (stage === 'AUDIO' && !shotOwesVoice(storyboard)) return 'idle'
  // 失败先于产物:重生成失败时旧画面还在盘上,但这一镜的最新一次尝试已经失败。
  // 总览的放映条按同一顺序裁决,折叠行若反过来先认产物,两个标签页会对同一镜给出相反结论。
  if (errorOf(storyboard, stage, shotTasks)) return 'err'
  if (artifactOf(storyboard, stage)) return 'ok'
  return 'idle'
}

const DOT_CLASS: Record<DotState, string> = {
  ok: 'bg-success',
  run: 'bg-primary animate-pulse',
  err: 'bg-destructive',
  idle: 'bg-muted-foreground/30',
}

/**
 * 镜头评审板:折叠时一镜一行(编号/标题/时长/审批态 + 首帧/视频/配音三个状态点),
 * 展开后左文字右媒体——分镜脚本与它的产物在同一张卡上核对,不再去下方媒体表找第二份。
 * 被取代的镜头以同样的行呈现为只读历史,因为它载的产物是真金白银买来的。
 */
export function StoryboardCard({
  storyboard,
  canWrite,
  episodeAssets,
  onBindAssets,
  onEdit,
  onChangeStatus,
  onRegenerateStage,
  regeneratingShotStage,
  generatingShotStages,
  shotTasks,
  events,
  qcThreshold,
  onPinVideo,
}: StoryboardCardProps) {
  const { t } = useI18n()
  const status = toWorkflowStatus(storyboard.status)
  const [open, setOpen] = useState(false)
  // 剧本文本是第二层折叠:卡片折叠管「这一镜要不要看」,这层管「文本要不要占屏」。
  const [scriptOpen, setScriptOpen] = useState(false)
  const [savingAsset, setSavingAsset] = useState<string | null>(null)
  // 产物落库时几乎没带时长（全库 98 条产物里 94 条 durationMs 为空），但播放器一定量得到：
  // 成片时长这一格不能因为数据库空着就说「还没有成片」。量到的值按产物 id 存，换版即失效。
  const [measured, setMeasured] = useState<{ clip: { id: string; ms: number } | null; voice: { id: string; ms: number } | null }>({
    clip: null,
    voice: null,
  })

  const superseded = !isLiveStoryboard(storyboard)
  const editable = canWrite && !superseded
  const links = storyboard.assets ?? []
  const boundIds = new Set(links.map(link => link.assetId))
  const silent = storyboard.dialogue.trim() === ''
  // 声音来源决定这一镜欠不欠一条人声轨，以及那一格里播的是哪个文件（TTS 或导入件）。
  const owesVoice = shotOwesVoice(storyboard)
  const voiceTrack = shotVoiceTrack(storyboard)
  // SD-189：导入档下云端配音不进母带，重跑它就是白烧一次付费调用——入口跟着判据收口。
  const voiceLive = cloudVoiceEntersMaster(storyboard)
  const kindById = new Map(episodeAssets.map(asset => [asset.id, asset.kind]))
  const characters = [...boundIds].filter(id => kindById.get(id) === 'character').length
  const clip = shotClip(storyboard)
  const clipMs = measuredDurationMs(clip, measured.clip)
  const voiceMs = measuredDurationMs(voiceTrack, measured.voice)

  const busyKey = (stage: ShotStage) => `${storyboard.id}:${stage}`
  // busy 覆盖两段:请求时长(POST)+ 任务排队/运行期(数据驱动)。
  // 只转请求那一圈,用户根本来不及看见,后面的排队期就是"点了没反应"。
  const stageBusy = (stage: ShotStage) =>
    regeneratingShotStage === busyKey(stage) || Boolean(generatingShotStages?.has(busyKey(stage)))
  const anyBusy = Boolean(regeneratingShotStage) || Boolean(generatingShotStages?.size)
  const shotBusy = SHOT_STAGES.some(stage => stageBusy(stage))
  const referenceDegradations = shotReferenceDegradations(t, storyboard.id, shotTasks)

  // 读数里的质检分与右栏产物同源:都取自这一阶段最新那条任务,而不是"历史里最高那次"。
  const taskQc = (stage: ShotStage) => shotTasks?.get(`${storyboard.id}:${stage}`)?.qc?.score ?? null

  async function toggleAsset(assetId: string) {
    const next = boundIds.has(assetId)
      ? links.filter(link => link.assetId !== assetId)
      : [...links, { storyboardId: storyboard.id, assetId, role: 'appears' }]
    setSavingAsset(assetId)
    try {
      await onBindAssets(storyboard.id, next.map(link => ({ assetId: link.assetId })))
    } finally {
      setSavingAsset(null)
    }
  }

  return (
    <Card className={cn('gap-0 overflow-hidden p-0 py-0', superseded && 'border-dashed bg-muted/30 shadow-none')}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}
          className="hover:bg-accent/60 flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left"
        >
          {open ? (
            <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" />
          ) : (
            <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
          )}
          <Badge variant="secondary" className="shrink-0 font-mono">
            #{storyboard.number}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{storyboard.title}</span>
          <span className="text-muted-foreground hidden shrink-0 text-xs tabular-nums sm:inline">
            {formatDuration(storyboard.durationMs)}
          </span>
          <StatusBadge status={status} label={t(`status.${status}`)} className="h-5 shrink-0 px-1.5 text-[11px]" />
          {superseded && <SupersededBadge revision={storyboard.revision ?? 1} />}
          <span className="flex shrink-0 items-center gap-1.5 pl-1">
            {SHOT_STAGES.map(stage => {
              const state = dotState(storyboard, stage, stageBusy(stage), shotTasks)
              const label =
                stage === 'AUDIO' && !owesVoice
                  ? t('shotboard.audio.dotHint', { mode: audioModeWord(t, shotAudioMode(storyboard)) })
                  : `${translateEnum(t, 'generations.stage', stage)} · ${dotLabel(state, t)}`
              return (
                <Tooltip key={stage}>
                  <TooltipTrigger asChild>
                    <span className={cn('size-2.5 rounded-full', DOT_CLASS[state])} aria-label={label} />
                  </TooltipTrigger>
                  <TooltipContent>{label}</TooltipContent>
                </Tooltip>
              )
            })}
          </span>
        </button>
        {!superseded && (
          <div className="flex shrink-0 items-center gap-1 pr-2">
            <Button variant="outline" size="icon-sm" aria-label={t('storyboards.editTitle')} disabled={!canWrite} onClick={onEdit}>
              <PencilIcon />
            </Button>
            <Button variant="outline" size="icon-sm" aria-label={t('storyboards.changeStatus')} onClick={onChangeStatus}>
              <WorkflowIcon />
            </Button>
          </div>
        )}
      </div>

      {open && (
        <>
          <div className="grid gap-5 border-t px-4 py-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
            {/* 左栏:这一镜的"剧本"——绑定、描述、台词、原文、衔接。 */}
            <div className="min-w-0 space-y-4">
              <div>
                <p className="text-muted-foreground mb-1 text-xs font-medium">{t('storyboards.assets')}</p>
                {!editable ? (
                  boundIds.size === 0 ? (
                    <p className="text-muted-foreground text-xs">{t('storyboards.noAssets')}</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {links.map(link => {
                        const asset = episodeAssets.find(item => item.id === link.assetId)
                        const latest = asset?.versions?.slice().sort((a, b) => b.version - a.version)[0]
                        return (
                          <div key={link.assetId} className="flex items-center gap-1.5 rounded-md border px-1.5 py-1">
                            {latest?.artifact && (
                              <ArtifactMedia artifact={latest.artifact} label={asset?.name ?? undefined} className="h-9 w-9" />
                            )}
                            <span className="text-xs">
                              {asset ? `${translateEnum(t, 'assets.kind', asset.kind)} · ${asset.name}` : link.assetId}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )
                ) : episodeAssets.length === 0 ? (
                  <p className="text-muted-foreground text-xs">{t('storyboards.noEpisodeAssets')}</p>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {episodeAssets.map(asset => {
                      const bound = boundIds.has(asset.id)
                      return (
                        <button
                          key={asset.id}
                          type="button"
                          aria-pressed={bound}
                          aria-label={`${translateEnum(t, 'assets.kind', asset.kind)} ${asset.name}`}
                          disabled={savingAsset !== null}
                          onClick={() => void toggleAsset(asset.id)}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors',
                            bound
                              ? 'border-transparent bg-primary text-primary-foreground'
                              : 'border-dashed text-muted-foreground hover:bg-accent hover:text-foreground',
                            savingAsset === asset.id && 'opacity-60',
                          )}
                        >
                          {savingAsset === asset.id
                            ? t('common.loading')
                            : `${translateEnum(t, 'assets.kind', asset.kind)} · ${asset.name}`}
                        </button>
                      )
                    })}
                    <HelpHint text={t('storyboards.assetsHint')} />
                  </div>
                )}
              </div>

              {/* 剧本文本折一层:日常评审要看的是产物和差异,文本是回溯用的。素材绑定不折——
                  绑错主体是每次都要核的事,藏在折叠里只会没人点。 */}
              <div className="rounded-md border">
                <button
                  type="button"
                  aria-expanded={scriptOpen}
                  onClick={() => setScriptOpen(value => !value)}
                  className="hover:bg-accent/60 flex w-full items-center gap-2 px-3 py-2 text-left"
                >
                  {scriptOpen ? (
                    <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" />
                  ) : (
                    <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
                  )}
                  <span className="text-muted-foreground shrink-0 text-xs font-medium">{t('storyboards.scriptDetail')}</span>
                  {!scriptOpen && (
                    <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{storyboard.description}</span>
                  )}
                </button>
                {scriptOpen && (
                  <div className="space-y-4 border-t px-3 py-3">
                    <div>
                      <p className="text-muted-foreground mb-1 text-xs font-medium">{t('storyboards.description')}</p>
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{storyboard.description}</p>
                    </div>

                    {!silent && (
                      <div>
                        <p className="text-muted-foreground mb-1 text-xs font-medium">{t('storyboards.dialogue')}</p>
                        <p className="text-sm leading-relaxed whitespace-pre-wrap">
                          {storyboard.speaker && <span className="text-muted-foreground mr-1.5 font-medium">[{storyboard.speaker}]</span>}
                          {storyboard.dialogue}
                        </p>
                      </div>
                    )}

                    {storyboard.sourceExcerpt.trim() !== '' && (
                      <div>
                        <p className="text-muted-foreground mb-1 text-xs font-medium">{t('storyboards.sourceExcerpt')}</p>
                        <blockquote className="border-muted-foreground/30 text-muted-foreground border-l-2 pl-3 text-sm italic">
                          {storyboard.sourceExcerpt}
                        </blockquote>
                      </div>
                    )}

                    <div className="flex justify-end">
                      <Button variant="ghost" size="sm" onClick={() => setScriptOpen(false)}>
                        {t('storyboards.scriptCollapse')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {(storyboard.continuityIn.trim() !== '' || storyboard.continuityOut.trim() !== '') && (
                <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {storyboard.continuityIn.trim() !== '' && (
                    <span>
                      {t('storyboards.continuityIn')}: {storyboard.continuityIn}
                    </span>
                  )}
                  {storyboard.continuityOut.trim() !== '' && (
                    <span>
                      {t('storyboards.continuityOut')}: {storyboard.continuityOut}
                    </span>
                  )}
                </div>
              )}

              <LineageBadge taskId={storyboard.generationTaskId} />
            </div>

            {/* 右栏:这一镜的全部产物。重做按钮贴着产物,异步三段反馈原样保留。 */}
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                {(['IMAGE', 'VIDEO'] as const).map(stage => (
                  <ShotMediaCell
                    key={stage}
                    storyboard={storyboard}
                    stage={stage}
                    artifact={stage === 'IMAGE' ? storyboard.firstFrame : clip}
                    parked={stage === 'VIDEO' && !storyboard.video && Boolean(storyboard.videoParked)}
                    busy={stageBusy(stage)}
                    error={errorOf(storyboard, stage, shotTasks)}
                    editable={editable && Boolean(onRegenerateStage)}
                    blockedBy={anyBusy}
                    onRegenerate={regenerate => onRegenerateStage?.(storyboard.id, stage, regenerate)}
                    onClipDuration={ms => {
                      const id = clip?.id
                      if (id) setMeasured(value => ({ ...value, clip: { id, ms } }))
                    }}
                  />
                ))}
              </div>
              {referenceDegradations.length > 0 && (
                // muted 而非红/琥珀：这是「这次没吃什么」的事实，不是故障也不是等你。
                <ul className="text-muted-foreground space-y-0.5">
                  {referenceDegradations.map((copy, index) => (
                    <li key={`${copy.text}:${index}`}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <p className="cursor-help text-xs">{copy.text}</p>
                        </TooltipTrigger>
                        {copy.raw && <TooltipContent className="max-w-md break-all">{copy.raw}</TooltipContent>}
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              )}
              <div>
                <p className="text-muted-foreground mb-1 flex items-center gap-1 text-xs font-medium">
                  <MicIcon className="size-3.5" />
                  {translateEnum(t, 'generations.stage', 'AUDIO')}
                </p>
                {!owesVoice ? (
                  <p className="text-muted-foreground text-xs">{t('shotboard.audio.nativeOnlyNote')}</p>
                ) : (
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      {voiceTrack ? (
                        <ArtifactMedia
                          artifact={voiceTrack}
                          label={`${storyboard.title} · ${t('generations.stage.AUDIO')}`}
                          className={cn('w-full', stageBusy('AUDIO') && 'blur-sm')}
                          onDurationMs={ms => {
                            const id = voiceTrack.id
                            if (id) setMeasured(value => ({ ...value, voice: { id, ms } }))
                          }}
                        />
                      ) : (
                        <p className="text-muted-foreground text-xs">
                          {stageBusy('AUDIO') ? t('generations.cellGenerating') : t('generations.notGenerated')}
                        </p>
                      )}
                      {!stageBusy('AUDIO') && errorOf(storyboard, 'AUDIO', shotTasks) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <p className="text-destructive mt-1 line-clamp-2 text-xs">
                              {mediaFailureCopy(t, 'audio', errorOf(storyboard, 'AUDIO', shotTasks))}
                            </p>
                          </TooltipTrigger>
                          <TooltipContent className="break-all">
                            {errorOf(storyboard, 'AUDIO', shotTasks)}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {!voiceLive && (
                        <p className="text-muted-foreground mt-1 text-xs">{t('shotboard.audio.importedNoRerun')}</p>
                      )}
                    </div>
                    {editable && onRegenerateStage && voiceLive && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon-sm"
                            disabled={!canWrite || anyBusy}
                            onClick={() => onRegenerateStage(storyboard.id, 'AUDIO', Boolean(voiceTrack))}
                          >
                            {stageBusy('AUDIO') ? <LoaderCircleIcon className="animate-spin" /> : <MicIcon />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {stageBusy('AUDIO')
                            ? t('generations.cellGenerating')
                            : t(voiceTrack ? 'storyboards.regenVoiceHint' : 'storyboards.genVoiceHint')}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
          {events && (
            <>
              <ShotReadout
                plannedMs={storyboard.durationMs}
                clipMs={clipMs}
                voiceMs={voiceMs}
                frameScore={taskQc('IMAGE')}
                clipScore={taskQc('VIDEO')}
                qcThreshold={qcThreshold}
                hasClip={Boolean(clip)}
                characters={characters}
              />
              <ShotHistory
                events={events}
                live={!superseded}
                canRetry={Boolean(onRegenerateStage)}
                canPin={canWrite}
                qcThreshold={qcThreshold}
                voiceLive={voiceLive}
                busy={shotBusy}
                onRetry={stage =>
                  // 履历里能出现重试入口的行必然是失败行：那一步真跑过、欠一次重做，
                  // 所以它恒走覆盖重跑，不看这一格现在有没有产物（产物缺失时「只补缺」
                  // 会撞回同一条在途提交，等于把这一步的出口又锁一次）。
                  onRegenerateStage?.(storyboard.id, stage, true)
                }
                onPin={artifactId => onPinVideo?.(artifactId)}
              />
            </>
          )}
        </>
      )}
    </Card>
  )
}

function dotLabel(state: DotState, t: TranslateFn): string {
  if (state === 'ok') return t('status.completed')
  if (state === 'run') return t('generations.cellGenerating')
  if (state === 'err') return t('generations.status.FAILED')
  return t('generations.notGenerated')
}

interface ShotMediaCellProps {
  storyboard: Storyboard
  stage: 'IMAGE' | 'VIDEO'
  /** 这一格要放的产物：成片那一档由父层按「生效版 > 等你裁决的那一版」裁决后给进来。 */
  artifact: GenerationArtifact | null | undefined
  /** 只有停在「等你裁决」上的那一版时为中：格子里有画面，但它没过线、还没入片。 */
  parked: boolean
  busy: boolean
  error: string | null
  editable: boolean
  blockedBy: boolean
  onRegenerate(regenerate: boolean): void
  /** 片段真实时长，来自播放器；只有 VIDEO 会有。 */
  onClipDuration?(ms: number): void
}

function ShotMediaCell({ storyboard, stage, artifact, parked, busy, error, editable, blockedBy, onRegenerate, onClipDuration }: ShotMediaCellProps) {
  const { t } = useI18n()
  const Icon = SHOT_STAGE_ICONS[stage]
  const stageLabel = translateEnum(t, 'generations.stage', stage)
  // 这一格有没有产物，决定动词、请求与回执三处（SD-070）：「重生成首帧」这类第三种句式
  // 全站只剩「生成「首帧」/重跑「首帧」」两个，且首生那一格不许说「重」。
  const rerun = Boolean(artifact)
  const busyWords = t('generations.cellGenerating')
  // SD-167：红条说人话，报文进 Tooltip。「有可播的东西」与「停在等你裁决」必须分开说——
  // 对着一条放得出来的成片写「这一镜还没有画面」，整张卡就都不能信了。
  const failureCopy = mediaFailureCopy(t, stage === 'IMAGE' ? 'frame' : 'video', error, {
    playable: Boolean(artifact),
    parked,
  })
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground mb-1 flex items-center gap-1 text-xs font-medium">
        <Icon className="size-3.5" />
        {stageLabel}
        {parked && (
          // muted：它是「这一版等你放行」的事实，不是状态徽章的第三种颜色，也不是按钮。
          <Badge variant="muted" className="ml-1 h-4 px-1.5 text-[10px] font-normal">
            {t('workbench.awaitingDecision')}
          </Badge>
        )}
      </p>
      <div className="relative min-h-24 overflow-hidden rounded-lg border">
        {artifact ? (
          <>
            <ArtifactMedia
              artifact={artifact}
              label={`${storyboard.title} · ${stageLabel}`}
              className={cn('max-h-44 w-full object-contain', busy && 'blur-sm')}
              onDurationMs={stage === 'VIDEO' ? onClipDuration : undefined}
            />
            {/* 重生成期间旧图毛玻璃化:产物区自己承载"生成中",而不是让人以为点了没反应。 */}
            {busy && (
              <div className="bg-background/50 absolute inset-0 flex items-center justify-center backdrop-blur-sm">
                <span className="text-primary inline-flex items-center gap-1.5 text-xs font-medium">
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                  {busyWords}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="text-muted-foreground flex h-24 flex-col items-center justify-center gap-1 text-xs">
            {busy ? (
              <span className="text-primary inline-flex items-center gap-1.5">
                <LoaderCircleIcon className="size-3.5 animate-spin" />
                {busyWords}
              </span>
            ) : error ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-destructive line-clamp-2 px-2 text-center">{failureCopy}</span>
                </TooltipTrigger>
                <TooltipContent className="break-all">{error}</TooltipContent>
              </Tooltip>
            ) : (
              t('generations.notGenerated')
            )}
          </div>
        )}
      </div>
      {artifact && !busy && error && (
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="text-destructive mt-1 line-clamp-2 text-xs">{failureCopy}</p>
          </TooltipTrigger>
          <TooltipContent className="break-all">{error}</TooltipContent>
        </Tooltip>
      )}
      {editable && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 w-full"
              disabled={blockedBy}
              onClick={() => onRegenerate(rerun)}
            >
              {busy ? <LoaderCircleIcon className="animate-spin" /> : <Icon />}
              {busy
                ? busyWords
                : t(rerun ? 'workbench.rerunStage' : 'workbench.generateStage', { stage: stageLabel })}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {stage === 'IMAGE'
              ? t(rerun ? 'storyboards.regenFrameHint' : 'storyboards.genFrameHint')
              : t(rerun ? 'storyboards.regenClipHint' : 'storyboards.genClipHint')}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

function SupersededBadge({ revision }: { revision: number }) {
  const { t } = useI18n()

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0" tabIndex={0}>
          <Badge variant="outline" className="text-muted-foreground gap-1 font-normal">
            <ArchiveIcon />
            {t('storyboards.revision', { revision })}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent>{t('storyboards.supersededHint')}</TooltipContent>
    </Tooltip>
  )
}
