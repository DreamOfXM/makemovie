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
import { cn, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LineageBadge } from '@/components/lineage-badge'
import { ArtifactMedia } from '@/components/generations/artifact-media'

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
  onBindAssets(storyboardId: string, assets: { assetId: string; role: string }[]): Promise<void>
  onEdit(): void
  onChangeStatus(): void
  /** 逐镜重生成:操作发生在分镜卡上(用户看镜头的地方),结果回写同卡片。 */
  onRegenerateStage?(storyboardId: string, stage: ShotStage): void
  /** 正在重生成的镜头与阶段(`${id}:${stage}`),用于按钮转圈与禁用。 */
  regeneratingShotStage?: string | null
  /** 数据驱动的进行中键(`${id}:${stage}`):任务在排队/运行时按钮保持转圈,直到出图。 */
  generatingShotStages?: Set<string>
  /** 每镜每阶段的最新任务(`${id}:${stage}`):产物未落库时它的失败原因/状态是格子的唯一线索。 */
  shotTasks?: Map<string, GenerationTask>
}

function artifactOf(storyboard: Storyboard, stage: ShotStage): GenerationArtifact | null | undefined {
  return stage === 'IMAGE' ? storyboard.firstFrame : stage === 'VIDEO' ? storyboard.video : storyboard.voice
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
  if (stage === 'AUDIO' && storyboard.dialogue.trim() === '') return 'idle'
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
}: StoryboardCardProps) {
  const { t } = useI18n()
  const status = toWorkflowStatus(storyboard.status)
  const [open, setOpen] = useState(false)
  const [savingAsset, setSavingAsset] = useState<string | null>(null)

  const superseded = !isLiveStoryboard(storyboard)
  const editable = canWrite && !superseded
  const links = storyboard.assets ?? []
  const boundIds = new Set(links.map(link => link.assetId))
  const silent = storyboard.dialogue.trim() === ''

  const busyKey = (stage: ShotStage) => `${storyboard.id}:${stage}`
  // busy 覆盖两段:请求时长(POST)+ 任务排队/运行期(数据驱动)。
  // 只转请求那一圈,用户根本来不及看见,后面的排队期就是"点了没反应"。
  const stageBusy = (stage: ShotStage) =>
    regeneratingShotStage === busyKey(stage) || Boolean(generatingShotStages?.has(busyKey(stage)))
  const anyBusy = Boolean(regeneratingShotStage) || Boolean(generatingShotStages?.size)

  async function toggleAsset(assetId: string) {
    const next = boundIds.has(assetId)
      ? links.filter(link => link.assetId !== assetId)
      : [...links, { storyboardId: storyboard.id, assetId, role: 'appears' }]
    setSavingAsset(assetId)
    try {
      await onBindAssets(storyboard.id, next.map(link => ({ assetId: link.assetId, role: link.role })))
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
                stage === 'AUDIO' && silent
                  ? t('generations.silentShot')
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
            <Button variant="ghost" size="icon-sm" aria-label={t('storyboards.editTitle')} disabled={!canWrite} onClick={onEdit}>
              <PencilIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={t('storyboards.changeStatus')} onClick={onChangeStatus}>
              <WorkflowIcon />
            </Button>
          </div>
        )}
      </div>

      {open && (
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
                  <span className="text-muted-foreground text-xs">{t('storyboards.assetsHint')}</span>
                </div>
              )}
            </div>

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
                  busy={stageBusy(stage)}
                  error={errorOf(storyboard, stage, shotTasks)}
                  editable={editable && Boolean(onRegenerateStage)}
                  blockedBy={anyBusy}
                  onRegenerate={() => onRegenerateStage?.(storyboard.id, stage)}
                />
              ))}
            </div>
            <div>
              <p className="text-muted-foreground mb-1 flex items-center gap-1 text-xs font-medium">
                <MicIcon className="size-3.5" />
                {translateEnum(t, 'generations.stage', 'AUDIO')}
              </p>
              {silent ? (
                <p className="text-muted-foreground text-xs">{t('generations.noLine')}</p>
              ) : (
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    {storyboard.voice ? (
                      <ArtifactMedia
                        artifact={storyboard.voice}
                        label={`${storyboard.title} · ${t('generations.stage.AUDIO')}`}
                        className={cn('w-full', stageBusy('AUDIO') && 'blur-sm')}
                      />
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        {stageBusy('AUDIO') ? t('generations.cellGenerating') : t('generations.notGenerated')}
                      </p>
                    )}
                    {!stageBusy('AUDIO') && errorOf(storyboard, 'AUDIO', shotTasks) && (
                      <p className="text-destructive mt-1 line-clamp-2 text-xs" title={errorOf(storyboard, 'AUDIO', shotTasks) ?? undefined}>
                        {t('storyboards.voiceFailed')}:{errorOf(storyboard, 'AUDIO', shotTasks)}
                      </p>
                    )}
                  </div>
                  {editable && onRegenerateStage && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          disabled={!canWrite || anyBusy}
                          onClick={() => onRegenerateStage(storyboard.id, 'AUDIO')}
                        >
                          {stageBusy('AUDIO') ? <LoaderCircleIcon className="animate-spin" /> : <MicIcon />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {stageBusy('AUDIO') ? t('generations.cellGenerating') : t('storyboards.regenVoiceHint')}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
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
  busy: boolean
  error: string | null
  editable: boolean
  blockedBy: boolean
  onRegenerate(): void
}

function ShotMediaCell({ storyboard, stage, busy, error, editable, blockedBy, onRegenerate }: ShotMediaCellProps) {
  const { t } = useI18n()
  const artifact = artifactOf(storyboard, stage)
  const Icon = SHOT_STAGE_ICONS[stage]
  const stageLabel = translateEnum(t, 'generations.stage', stage)
  const busyLabel = stage === 'IMAGE' ? t('storyboards.regenningFrame') : t('storyboards.regenningClip')
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground mb-1 flex items-center gap-1 text-xs font-medium">
        <Icon className="size-3.5" />
        {stageLabel}
      </p>
      <div className="relative min-h-24 overflow-hidden rounded-lg border">
        {artifact ? (
          <>
            <ArtifactMedia
              artifact={artifact}
              label={`${storyboard.title} · ${stageLabel}`}
              className={cn('max-h-44 w-full object-contain', busy && 'blur-sm')}
            />
            {/* 重生成期间旧图毛玻璃化:产物区自己承载"生成中",而不是让人以为点了没反应。 */}
            {busy && (
              <div className="bg-background/50 absolute inset-0 flex items-center justify-center backdrop-blur-sm">
                <span className="text-primary inline-flex items-center gap-1.5 text-xs font-medium">
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                  {busyLabel}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="text-muted-foreground flex h-24 flex-col items-center justify-center gap-1 text-xs">
            {busy ? (
              <span className="text-primary inline-flex items-center gap-1.5">
                <LoaderCircleIcon className="size-3.5 animate-spin" />
                {busyLabel}
              </span>
            ) : error ? (
              <span className="text-destructive line-clamp-2 px-2 text-center" title={error}>
                {stage === 'IMAGE' ? t('storyboards.frameFailed') : t('storyboards.clipFailed')}:{error}
              </span>
            ) : (
              t('generations.notGenerated')
            )}
          </div>
        )}
      </div>
      {artifact && !busy && error && (
        <p className="text-destructive mt-1 line-clamp-2 text-xs" title={error}>
          {stage === 'IMAGE' ? t('storyboards.frameFailed') : t('storyboards.clipFailed')}:{error}
        </p>
      )}
      {editable && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 w-full"
              disabled={blockedBy}
              onClick={onRegenerate}
            >
              {busy ? <LoaderCircleIcon className="animate-spin" /> : <Icon />}
              {busy ? busyLabel : stage === 'IMAGE' ? t('storyboards.regenFrame') : t('storyboards.regenClip')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {stage === 'IMAGE' ? t('storyboards.regenFrameHint') : t('storyboards.regenClipHint')}
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
