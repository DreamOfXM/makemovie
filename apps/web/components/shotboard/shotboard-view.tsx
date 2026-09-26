'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiErrorMessage } from '@/lib/api-error'
import {
  AlertTriangleIcon, ArrowRightIcon, CheckCircle2Icon, ClapperboardIcon, FilmIcon, ImageIcon,
  PauseIcon, PlayIcon, RotateCcwIcon, UploadIcon, UsersIcon, UserCheckIcon,
} from 'lucide-react'
import { type GenerationArtifact, type ShotAudioSource, type ShotboardCastAsset, type ShotboardResponse, type ShotboardShot, type ShotVideoCandidate } from '@/lib/api'
import { useI18n, type TranslateFn } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { audioModeWord, cardFailureCode, cardStage, shotAudioMode, shotAudioSourceInEffect, shotDemandText, shotFailureKind, shotOwesVoice, shotVerdict, shotVoiceTrack, stageTone, stageWord } from '@/lib/shot-verdict'
import { cn, formatDateTime, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/error-state'
import { HelpHint } from '@/components/ui/help-hint'
import { Skeleton, TableSkeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GuardedButton, usePermission } from '@/components/permission'
import { ArtifactLoadError, ArtifactMedia, useArtifactUrl } from '@/components/generations/artifact-media'
import { ArtifactLightbox } from '@/components/artifact-lightbox'
import { AudioWaveform } from './audio-waveform'
import { ShotCard } from './shot-card'

/** 队列封顶几行：超过就收进「还有 N 件」，别让坏消息把镜头卡推出首屏。 */
const QUEUE_ROWS = 3

/** 声音来源的四档，按「这一档往成片里加多少东西」排，不按枚举字母序：
 *  字母序会把「什么都没选」和「选了第一档」摆成同一个样子。 */
const AUDIO_MODES: ShotAudioSource[] = ['VOICE_NATIVE', 'VOICE', 'NATIVE', 'IMPORTED']

interface AttentionItem {
  key: string
  /** 徽章字样与镜头卡同一套口吻：同一屏不许两件事各说各话。 */
  label: string
  tone: 'danger' | 'warning'
  /** 这件事落在哪一镜/哪一份素材上。 */
  subject: string
  /** 现在要你做什么，或是什么挡住了它。 */
  demand: string
  shotId?: string
  kind: 'shot' | 'asset'
  /** 影响面:这件事挡住/拖累多少镜头——队列按它排序，数字也写进条目里，口径可查。 */
  impact: number
  /** 等了多久。没有真时间来源就是 null，那一栏干脆不显示。 */
  waitedMs: number | null
  /** selection_open resolves inside the board (the candidate picker lives in the dialog). */
  openDialog?: boolean
}

interface ShotboardViewProps {
  episodeId: string
  /** Jump to the flow view with the given shot selected. */
  onOpenShot: (shotId: string) => void
  /** Jump to the flow view at the asset review section. */
  onReviewAssets: () => void
}

export function ShotboardView({ episodeId, onOpenShot, onReviewAssets }: ShotboardViewProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preScreenOpen, setPreScreenOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)

  const load = useCallback(() => api<ShotboardResponse>(`/episodes/${episodeId}/shotboard`), [api, episodeId])
  const board = useAsync<ShotboardResponse | null>(load, null)

  useEffect(() => {
    const timer = setInterval(board.reload, 10_000)
    return () => clearInterval(timer)
  }, [board.reload])

  if (board.loading && !board.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('shotboard.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <TableSkeleton rows={4} />
        </CardContent>
      </Card>
    )
  }
  if (board.error) return <ErrorState message={board.error} onRetry={board.reload} />

  const data = board.data
  if (!data) return null
  const selected = data.shots.find(shot => shot.id === selectedId) ?? null

  // 计数行、放映条、镜头卡必须走同一个裁决。上一版计数按「最新一抽过没过线」判 ready，
  // 于是留着旧画面的镜头被算成「没有画面」，同一屏上计数说 4/8、卡片说 8 张全有图。
  const tones = data.shots.map(shot => stageTone(cardStage(shot, shotVerdict(shot))))
  const pictureCount = data.shots.filter(shot => Boolean(shot.firstFrame) || Boolean(shot.video)).length
  const decideCount = tones.filter(tone => tone === 'danger').length
  const openCount = data.shots.filter(shot => shot.attention.includes('selection_open')).length
  const chosenCount = data.shots.filter(shot => shot.slot === 'chosen').length
  const plannedTotal = data.shots.reduce((sum, shot) => sum + shot.durationMs, 0)

  const attentionMeta: Record<string, { label: string; tone: 'danger' | 'warning' }> = {
    frame_failed: { label: t('attention.frame_failed'), tone: 'danger' },
    video_failed: { label: t('attention.video_failed'), tone: 'danger' },
    shot_blocked: { label: t('shotboard.stage.blocked'), tone: 'danger' },
    awaiting_review: { label: t('shotboard.stage.review'), tone: 'warning' },
    selection_open: { label: t('attention.selection_open'), tone: 'warning' },
  }

  const appearancesByAssetId = new Map(data.assets.map(asset => [asset.id, asset.appearances]))
  const items: AttentionItem[] = []
  for (const asset of data.assetsPending) {
    const impact = appearancesByAssetId.get(asset.id)?.length ?? 0
    items.push({
      key: `asset-${asset.id}`,
      label: t('attention.asset_gate'),
      tone: 'danger',
      subject: asset.name,
      demand: t('shotboard.demand.approveAsset'),
      kind: 'asset',
      impact,
      waitedMs: waitedMs(asset.waitingSince),
    })
  }
  for (const shot of data.shots) {
    const verdict = shotVerdict(shot)
    const stage = cardStage(shot, verdict)
    for (const code of shot.attention) {
      const entry = attentionMeta[code]
      if (!entry) continue
      if (code === 'asset_gate') continue // already covered by the episode-level lane
      // 队列徽章必须走卡片那套裁决：写死「重抽没过线」会让额度失败的卡在卡片上写
      // 「重抽解决不了」、在队列里写「重抽没过线」——同一屏两套归因，用户照队列那句去改提示词。
      // 只有卡片此刻正在说的那一档失败才许借它的话：同一镜并列的「等你审」行得说自己那句，
      // 否则徽章报额度、诉求报放行，一行里两个意思。
      const label =
        code === cardFailureCode(verdict) ? stageWord(t, verdict, stage, false, shotFailureKind(shot)) : entry.label
      items.push({
        key: `shot-${shot.id}-${code}`,
        label,
        tone: entry.tone,
        subject: `#${shot.number}`,
        demand: shotDemandText(t, shot, code),
        shotId: shot.id,
        kind: 'shot',
        impact: 1,
        waitedMs: waitedMs(shot.waitingSince),
        openDialog: code === 'selection_open',
      })
    }
  }
  // 先按影响面，再按严重度，最后按等了多久：一件事拖住七个镜头、又放了一小时的，
  // 不该排在刚出现的单镜失败后面。
  items.sort((a, b) => b.impact - a.impact || toneRank(a.tone) - toneRank(b.tone) || (b.waitedMs ?? -1) - (a.waitedMs ?? -1))
  // 队列只报坏消息，负空间得另算：在产的是机器在跑，无事的是这一镜还轮不到你。
  const busyCount = data.shots.filter(shot => shot.inflight.length > 0).length
  const quietCount = data.shots.filter(shot => shot.attention.length === 0 && shot.inflight.length === 0).length
  const rest = queueOpen ? [] : items.slice(QUEUE_ROWS)
  const shownItems = queueOpen ? items : items.slice(0, QUEUE_ROWS)

  const kindRank: Record<string, number> = { character: 0, scene: 1, prop: 2 }
  const cast = [...data.assets].sort((a, b) => (kindRank[a.kind] ?? 3) - (kindRank[b.kind] ?? 3) || b.appearances.length - a.appearances.length || a.name.localeCompare(b.name))

  return (
    <div className="space-y-6">
      {items.length > 0 && (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle className="text-warning-ink flex items-center gap-2">
              <AlertTriangleIcon className="size-4" />
              {t('screening.todoTitle', { count: items.length })}
            </CardTitle>
            <CardAction className="text-faint-foreground text-[11px]">{t('screening.sortByImpact')}</CardAction>
          </CardHeader>
          <CardContent className="px-0">
            <ul className="border-border/60 divide-border/60 divide-y border-y">
              {shownItems.map(item => {
                const waited = waitedText(t, item.waitedMs)
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      onClick={() => (item.kind === 'asset' ? onReviewAssets() : item.openDialog && item.shotId ? setSelectedId(item.shotId) : item.shotId && onOpenShot(item.shotId))}
                      className="hover:bg-accent/60 group flex w-full items-center gap-2 px-6 py-2 text-left text-xs"
                    >
                      <Badge variant={item.tone === 'danger' ? 'destructive' : 'warning'} className="shrink-0 font-normal">
                        {item.label}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate">
                        <span className="text-muted-foreground font-mono">{item.subject}</span>
                        {' '}
                        <span>{item.demand}</span>
                        {' '}
                        <span className="text-faint-foreground">· {t('screening.impactShots', { count: item.impact })}</span>
                      </span>
                      {waited && <span className="text-muted-foreground shrink-0 tabular-nums">{waited}</span>}
                      <ArrowRightIcon className="text-muted-foreground size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                  </li>
                )
              })}
            </ul>
            {(rest.length > 0 || queueOpen) && items.length > QUEUE_ROWS && (
              <div className="text-faint-foreground flex items-center gap-2 px-6 pt-1.5 text-[11px]">
                {rest.length > 0 && (
                  <span className="min-w-0 flex-1 truncate">
                    {t('screening.queueMore', { count: rest.length, list: rest.slice(0, 2).map(item => `${item.subject} ${item.label}`).join(' · ') })}
                  </span>
                )}
                <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[11px]" onClick={() => setQueueOpen(next => !next)}>
                  {queueOpen ? t('common.collapse') : t('common.expand')}
                </Button>
              </div>
            )}
            {busyCount > 0 || quietCount > 0 ? (
              <p className="text-faint-foreground px-6 pt-2 text-[11px]">
                {busyCount > 0 ? t('shotboard.queue.running', { count: busyCount }) : t('shotboard.queue.quiet', { count: quietCount })}
              </p>
            ) : null}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <FilmIcon className="text-muted-foreground size-4" />
            {t('shotboard.title')}
            {data.shots.length > 0 && (
              <Badge variant="secondary">
                {t('shotboard.shotCount', { count: data.shots.length })}
              </Badge>
            )}
            {data.shots.length > 0 && (
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => setPreScreenOpen(true)}>
                <PlayIcon />
                {t('screening.preScreen')}
              </Button>
            )}
          </CardTitle>
          <CardDescription>{items.length === 0 && data.shots.length > 0 ? t('shotboard.allQuiet') : t('shotboard.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.shots.length === 0 ? (
            <EmptyState icon={<ClapperboardIcon />} title={t('storyboards.none')} description={t('storyboards.noneHint')} />
          ) : (
            <div className="space-y-3">
              <div>
                <p className="text-muted-foreground text-[11.5px] tabular-nums">
                  {t('screening.readout', { picture: pictureCount, total: data.shots.length, decided: decideCount, open: openCount, chosen: chosenCount })}
                  <span className="text-faint-foreground"> · {t('screening.planned', { duration: formatDuration(plannedTotal) })}</span>
                </p>
                <ShotStrip shots={data.shots} onOpen={shotId => setSelectedId(shotId)} />
                <p className="text-faint-foreground mt-1.5 text-[11px]">{t('shotboard.stripHint')}</p>
              </div>
              <CastRow
                episodeId={episodeId}
                shots={data.shots}
                cast={cast}
                onReviewAssets={onReviewAssets}
                onReload={() => void board.reload()}
              />
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {data.shots.map(shot => (
                  <div key={shot.id} id={`shot-card-${shot.id}`} className="scroll-mt-24 rounded-lg">
                    <ShotCard shot={shot} onSelect={setSelectedId} onOpenShot={onOpenShot} onReviewAssets={onReviewAssets} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ShotDetailDialog
        shot={selected}
        onClose={() => setSelectedId(null)}
        onOpenShot={onOpenShot}
        onChosen={() => void board.reload()}
      />

      <PreScreenDialog shots={data.shots} open={preScreenOpen} onClose={() => setPreScreenOpen(false)} />
    </div>
  )
}

/** danger 排在 warning 前：同影响面时，红色的事先于琥珀色。 */
function toneRank(tone: 'danger' | 'warning'): number {
  return tone === 'danger' ? 0 : 1
}

/** 等待时钟只认真时间戳：产物落地、失败落定、人把镜头推到等审/阻塞。取不到就不显示。 */
function waitedMs(since: string | null): number | null {
  if (!since) return null
  const ms = Date.now() - new Date(since).getTime()
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

function waitedText(t: TranslateFn, ms: number | null): string | null {
  if (ms == null) return null
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return t('shotboard.wait.justNow')
  if (minutes < 60) return t('shotboard.wait.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('shotboard.wait.hours', { count: hours })
  return t('shotboard.wait.days', { count: Math.floor(hours / 24) })
}

/**
 * 整集放映条:每镜一格、格宽=规划时长。它是这一集的缩略时间轴,
 * 点击一格=放大那一镜的详情。不是时间线编辑器——剪辑仍是交付之后的事。
 *
 * 一格三个通道，各说一件事，谁也不抢谁：
 *   底色 = 这一镜现在能不能直接用上（绿/红/琥珀/蓝/灰，与卡片徽章同一裁决）
 *   底部亮线 = 人签过没有（slot=chosen，钦定成片）
 *   格内文字 = 与卡片同一个词，且只在格子真放不下时才省略
 * 上一版三件事挤在同一个文字槽里，谁先命中谁占格，于是钦定过的镜头会被整格报成废镜。
 */
function ShotStrip({ shots, onOpen }: { shots: ShotboardShot[]; onOpen(shotId: string): void }) {
  const { t } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)

  const cells = shots.map(shot => {
    const verdict = shotVerdict(shot)
    const stage = cardStage(shot, verdict)
    return {
      shot,
      tone: stageTone(stage),
      chosen: shot.slot === 'chosen',
      word: stageWord(t, verdict, stage, true, shotFailureKind(shot)),
      empty: stage === 'idle' && !shot.firstFrame && !shot.video,
    }
  })

  /**
   * 词放不放下得量实际渲染宽度：CSS 那道固定 44px 闸门不知道词有多长，
   * 于是短词过得去的窄格被整格抹成空白，长词照样溢出。
   */
  function fitWords() {
    const root = rootRef.current
    if (!root) return
    for (const cell of root.querySelectorAll<HTMLElement>('.strip-cell')) {
      const word = cell.querySelector<HTMLElement>('.strip-word')
      if (!word) continue
      if (word.scrollWidth > word.clientWidth) cell.dataset.clip = '1'
      else delete cell.dataset.clip
    }
  }

  useLayoutEffect(fitWords, [cells])
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fitWords)
    observer.observe(root)
    return () => observer.disconnect()
  })

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={t('shotboard.stripLabel')}
      className="mt-2.5 grid h-6 gap-px"
      style={{ gridTemplateColumns: shots.map(shot => `${Math.max(shot.durationMs, 500)}fr`).join(' ') }}
    >
      {cells.map(({ shot, tone, chosen, word, empty }) => {
        const label = `#${shot.number} ${shot.title} · ${formatDuration(shot.durationMs)} · ${word}${chosen ? ` · ${t('shotboard.strip.chosen')}` : ''}`
        return (
          <Tooltip key={shot.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={label}
                onClick={() => onOpen(shot.id)}
                data-empty={empty ? '1' : undefined}
                data-chosen={chosen ? '1' : undefined}
                className={cn(
                  'strip-cell flex items-center justify-center overflow-hidden rounded-sm transition-opacity hover:opacity-70',
                  tone === 'ready' && 'bg-success/45 text-success-ink',
                  tone === 'danger' && 'bg-destructive text-destructive-foreground',
                  tone === 'warning' && 'bg-warning text-warning-ink',
                  tone === 'running' && 'bg-info text-info-foreground animate-pulse',
                  tone === 'idle' && 'text-muted-foreground',
                )}
              >
                <span className="strip-word block max-w-full truncate px-0.5 text-center text-[9.5px] leading-none font-medium">{word}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{label}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

/**
 * 本集班底:一行 chips，每枚说「这个素材出现在几镜、定没定稿」，点击跳到流程页的资产区。
 * 0 镜素材不再占行——它不回答这一集的任何问题，收在「+N 未出演」里，要看再展开。
 */
function CastRow({ episodeId, shots, cast, onReviewAssets, onReload }: { episodeId: string; shots: ShotboardShot[]; cast: ShotboardCastAsset[]; onReviewAssets(): void; onReload(): void }) {
  const { t } = useI18n()
  const { api } = useSession()
  const [showAbsent, setShowAbsent] = useState(false)
  const [busyAsset, setBusyAsset] = useState<string | null>(null)

  if (cast.length === 0) return null
  const numberById = new Map(shots.map(shot => [shot.id, shot.number]))
  const appearing = cast.filter(asset => asset.appearances.length > 0)
  const absent = cast.filter(asset => asset.appearances.length === 0)

  async function generateCostume(asset: ShotboardCastAsset) {
    setBusyAsset(asset.id)
    try {
      await api(`/episodes/${episodeId}/generations`, {
        method: 'POST',
        body: JSON.stringify({ stage: 'ASSET', regenerate: true, assetIds: [asset.id] }),
      })
      toast.success(t('screening.costumeQueued', { name: asset.name }))
      onReload()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusyAsset(null)
    }
  }

  // 写成普通函数而不是嵌套组件：每次渲染都换类型的组件会让 React 卸掉整枚 chip，
  // 十秒一次的自动刷新就会看见定妆照闪回骨架屏。
  function chip(asset: ShotboardCastAsset) {
    const approved = asset.status === 'APPROVED'
    const numbers = asset.appearances
      .map(id => numberById.get(id))
      .filter((n): n is number => n !== undefined)
      .sort((a, b) => a - b)
    const chipInner = (
      <span className="border-border/70 bg-muted/30 inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2 pl-1 text-[11px]">
        <CastThumb asset={asset} />
        <button type="button" onClick={onReviewAssets} className="hover:text-foreground min-w-0 max-w-32 truncate font-medium">
          {asset.name}
        </button>
        <span className={cn('text-faint-foreground tabular-nums', !approved && 'text-warning-ink')}>
          {t('screening.castShots', { count: asset.appearances.length })}
          {' · '}
          {approved ? t('screening.approved') : t('screening.pending')}
        </span>
        {!asset.hasVersions && (
          <GuardedButton
            action="episode:write"
            variant="link"
            className="text-primary h-auto p-0 text-[10.5px] font-normal"
            disabled={busyAsset === asset.id}
            onClick={() => void generateCostume(asset)}
          >
            {t('screening.generateCostume')}
          </GuardedButton>
        )}
      </span>
    )
    if (numbers.length === 0) return <span key={asset.id}>{chipInner}</span>
    return (
      <Tooltip key={asset.id}>
        <TooltipTrigger asChild>{chipInner}</TooltipTrigger>
        <TooltipContent side="bottom">{`${asset.name} → #${numbers.join(' #')}`}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
        <UsersIcon className="size-3.5" />
        {t('screening.castTitle')}
      </span>
      {appearing.map(chip)}
      {showAbsent && absent.map(chip)}
      {absent.length > 0 && (
        <Button variant="ghost" size="sm" className="text-faint-foreground h-5 px-1.5 text-[11px]" onClick={() => setShowAbsent(next => !next)}>
          {showAbsent ? t('common.collapse') : t('screening.castAbsent', { count: absent.length })}
        </Button>
      )}
    </div>
  )
}

function CastThumb({ asset }: { asset: ShotboardCastAsset }) {
  const { t } = useI18n()
  const { url, failed, reload } = useArtifactUrl(asset.thumbnail ? asset.thumbnail.downloadUrl : null)
  const [zoomed, setZoomed] = useState(false)

  if (!asset.thumbnail) {
    // 虚线占位不是装饰:它说「这个素材连定妆照都没有」,入口就排在下一行。
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="border-border flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border border-dashed">
            <ImageIcon className="text-faint-foreground size-2.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('screening.noPhoto')}</TooltipContent>
      </Tooltip>
    )
  }
  // 18px 的缩略图放不下一个带按钮的错误块，但它也不能继续转圈：红边 + 重试点击，
  // 让「读不出来」和「还没读到」在同一个位置上区分开。
  if (failed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('generations.loadFailed')}
            onClick={reload}
            className="flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-destructive/40 bg-destructive/10"
          >
            <AlertTriangleIcon className="text-destructive-ink size-2.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('generations.loadFailed')}</TooltipContent>
      </Tooltip>
    )
  }
  if (!url) return <Skeleton className="size-[18px] shrink-0 rounded-[4px]" />
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={asset.name}
        loading="lazy"
        onClick={() => setZoomed(true)}
        className="size-[18px] shrink-0 cursor-zoom-in rounded-[4px] border object-cover"
      />
      {zoomed && <ArtifactLightbox src={url} alt={asset.name} onClose={() => setZoomed(false)} />}
    </>
  )
}

/**
 * 这一镜的声音来源。四档就是四种真相：选哪档，母带里就听到什么。
 *
 * 控件落在这一屏而不是卡片上：整张镜头卡是一个 `<button>`，往里塞一组按钮不是合法
 * HTML（嵌套交互元素会被浏览器拆开），所以卡上只留那枚只读的状态点。
 */
function AudioSourceRow({ shot, onChanged }: { shot: ShotboardShot; onChanged: () => void }) {
  const { t } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const [busy, setBusy] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const ambienceRef = useRef<HTMLInputElement>(null)
  const editable = can('storyboard:write')

  const mode = shotAudioMode(shot)
  // 亮哪一格看「生效值」，不看「有人点过没有」：没人钦定时镜型默认那一格也是在生效的，
  // 四格全灭等于让控件否认下面那行说的话。
  const effectiveSource = shotAudioSourceInEffect(shot)
  const imported = shot.importedVoice
  // 「配音」这一路必须有声音可放：本镜写的台词，或人导入的那条音频。两者都没有时
  // 含配音的三档都是空选择——后端同样拒，界面先把它按住。
  const canVoice = Boolean(shot.dialogue) || Boolean(imported)
  const track = shotVoiceTrack(shot)
  // 画面的长度优先用实测的成片时长；还没有片段可探时才退回分镜里写的计划时长，
  // 那种情况下读数要标成「约」，不能拿计划值冒充量出来的数。
  const pictureMs = shot.video?.durationMs ?? shot.durationMs
  const pictureLabel = shot.video?.durationMs
    ? formatDuration(pictureMs)
    : t('shotboard.audio.approx', { value: formatDuration(pictureMs) })
  const audioMs = imported?.durationMs ?? null
  const lengthNote = audioMs && Math.abs(audioMs - pictureMs) > 200
    ? t(audioMs < pictureMs ? 'shotboard.audio.shorter' : 'shotboard.audio.longer', {
      audio: formatDuration(audioMs),
      picture: pictureLabel,
      gap: formatDuration(Math.abs(audioMs - pictureMs)),
    })
    : null
  const ambience = shot.importedAmbience ?? null
  const ambienceMs = ambience?.durationMs ?? null
  // 环境音在混音时被切到这一镜的画面长度（apad + atrim），不会像配音那样压到下一镜，
  // 所以这两条话与上面那两条不同：短了是尾巴空，长了是末尾被切掉。
  const ambienceNote = ambienceMs && Math.abs(ambienceMs - pictureMs) > 200
    ? t(ambienceMs < pictureMs ? 'shotboard.audio.ambienceShorter' : 'shotboard.audio.ambienceLonger', {
      audio: formatDuration(ambienceMs),
      picture: pictureLabel,
      gap: formatDuration(Math.abs(ambienceMs - pictureMs)),
    })
    : null
  // 这一档本来要放模型原声，但导进来的环境音占的就是那一格——原声已经不播了，
  // 界面必须说出来，否则「配音 + 原声」那枚药丸在骗人。
  const ambienceReplacesNative = Boolean(ambience) && (mode === 'native' || mode === 'voice_native')
  const customSubtitle = shot.subtitleText !== null
  const subtitleNote = mode !== 'imported' || customSubtitle
    ? null
    : shot.dialogue === ''
      ? t('shotboard.audio.subtitleNone')
      : t('shotboard.audio.subtitleUnverified')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  async function pick(next: ShotAudioSource | null) {
    setBusy(next ?? 'clear')
    try {
      await api(`/storyboards/${shot.id}/audio-source`, { method: 'POST', body: JSON.stringify({ audioSource: next }) })
      toast.success(t('shotboard.audio.setToast'))
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  async function upload(file: File, role: 'voice' | 'ambience') {
    setBusy(role === 'voice' ? 'import' : 'import-ambience')
    const body = new FormData()
    body.append('file', file)
    try {
      await api(`/storyboards/${shot.id}/${role}-import`, { method: 'POST', body })
      toast.success(t(role === 'voice' ? 'shotboard.audio.importToast' : 'shotboard.audio.ambienceToast'))
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  async function removeImport(role: 'voice' | 'ambience') {
    setBusy(`remove-${role}`)
    try {
      await api(`/storyboards/${shot.id}/${role}-import`, { method: 'DELETE' })
      toast.success(t(role === 'voice' ? 'shotboard.audio.removeToast' : 'shotboard.audio.ambienceRemoveToast'))
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  // 字幕文本只有合成前改才有效：字幕是硬烧的，成片一旦交付那行字就焊死在画面里。
  async function saveSubtitle(text: string | null) {
    setBusy('subtitle')
    try {
      await api(`/storyboards/${shot.id}/subtitle`, { method: 'POST', body: JSON.stringify({ subtitleText: text }) })
      toast.success(t('shotboard.audio.subtitleSaved'))
      setEditing(false)
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="border-border/60 rounded-md border px-3 py-2">
      <div className="mb-2 flex items-center gap-1.5">
        <p className="text-muted-foreground text-xs">{t('shotboard.audio.title')}</p>
        <HelpHint text={t('shotboard.audio.hint')} />
        {editable && shot.audioSource !== null && (
          <Button variant="ghost" size="sm" className="ml-auto h-6 text-xs" disabled={busy !== null} onClick={() => void pick(null)}>
            {t('shotboard.audio.restoreDefault')}
          </Button>
        )}
      </div>

      {/* 一格一形状：整排是一条分段控件（muted 轨道 + 生效格实心），不是四个各说各话的按钮。
          「导入音频」在还没有文件时是动作而不是档位，所以它不带描边——之前它比选中态还抢眼。 */}
      <div
        role="group"
        aria-label={t('shotboard.audio.title')}
        className="border-border/70 bg-muted/40 inline-flex flex-wrap items-center gap-0.5 rounded-lg border p-0.5"
      >
        {AUDIO_MODES.map(item => {
          const picked = shot.audioSource === item
          const byDefault = shot.audioSource === null && effectiveSource === item
          const blocked = (item === 'VOICE' || item === 'VOICE_NATIVE') && !canVoice
          // 还没导入文件时，这一档不是「选它」而是「去选文件」——点击直接开选择框，
          // 传完自动落到这一档，不再逼人补点一次。
          if (item === 'IMPORTED' && !imported) {
            return (
              <Tooltip key={item}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 rounded-md px-2.5 text-xs font-normal text-muted-foreground whitespace-nowrap hover:text-foreground"
                    disabled={!editable || busy !== null}
                    onClick={() => fileRef.current?.click()}
                  >
                    <UploadIcon className="size-3.5" />
                    {t(`shotboard.audio.${item}`)}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('shotboard.audio.pickHint')}</TooltipContent>
              </Tooltip>
            )
          }
          const modeButton = (
            <Button
              key={item}
              variant="ghost"
              size="sm"
              aria-pressed={picked || byDefault}
              className={cn(
                'h-7 rounded-md border px-2.5 text-xs font-medium whitespace-nowrap transition-colors',
                picked && 'border-primary/70 bg-primary/15 text-foreground',
                byDefault && 'border-dashed border-primary/55 text-foreground/85',
                !picked && !byDefault && 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              disabled={!editable || busy !== null || blocked}
              onClick={() => void pick(item)}
            >
              {t(`shotboard.audio.${item}`)}
            </Button>
          )
          const blockHint = editable && blocked ? t('shotboard.audio.noDialogueHint') : null
          if (!blockHint) return modeButton
          return (
            <Tooltip key={item}>
              {/* 禁用按钮自身不触发 hover，提示必须挂在它外面这层 span 上才弹得出来 */}
              <TooltipTrigger asChild>
                <span className="inline-flex">{modeButton}</span>
              </TooltipTrigger>
              <TooltipContent>{blockHint}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void upload(file, 'voice')
        }}
      />
      <input
        ref={ambienceRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void upload(file, 'ambience')
        }}
      />

      {shot.audioSource === null && (
        <p className="text-faint-foreground mt-2 text-[11px]">{t('shotboard.audio.defaultLine', { mode: audioModeWord(t, mode) })}</p>
      )}

      {imported && (
        <div className="border-border/60 mt-2 rounded-md border px-3 py-2">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
              {t('shotboard.audio.file')}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-foreground ml-1.5 font-mono">
                    {imported.filename ?? imported.objectKey.split('/').pop()}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="break-all">{imported.filename ?? imported.objectKey}</TooltipContent>
              </Tooltip>
            </span>
            {editable && (
              <span className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" className="h-6 text-xs" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
                  {t('shotboard.audio.replace')}
                </Button>
                <Button variant="ghost" size="sm" className="h-6 text-xs" disabled={busy !== null} onClick={() => void removeImport('voice')}>
                  {t('shotboard.audio.remove')}
                </Button>
              </span>
            )}
          </div>
          <AudioWaveform artifact={imported} pictureMs={pictureMs} />

          {mode === 'imported' && lengthNote && (
            <p className="border-warning/40 bg-warning/10 text-warning-ink mt-2 rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed">
              {lengthNote}
            </p>
          )}
          {mode === 'imported' && subtitleNote && (
            <p className="border-warning/40 bg-warning/10 text-warning-ink mt-1.5 rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed">
              {subtitleNote}
            </p>
          )}
        </div>
      )}

      {/* 环境音与声音来源正交：来源决定人声从哪来，这一条决定配音底下垫什么。
          它给的是「配音 + 环境音」这条路——不必赌模型原声里有没有它自己念的词。 */}
      <div className="mt-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="text-muted-foreground text-xs">{t('shotboard.audio.ambience')}</p>
          <HelpHint text={t('shotboard.audio.ambienceHint')} />
          {editable && !ambience && (
            <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" disabled={busy !== null} onClick={() => ambienceRef.current?.click()}>
              {t('shotboard.audio.ambienceImport')}
            </Button>
          )}
        </div>
        {ambience ? (
          <div className="border-border/60 mt-1.5 rounded-md border px-3 py-2">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-foreground font-mono">
                      {ambience.filename ?? ambience.objectKey.split('/').pop()}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="break-all">{ambience.filename ?? ambience.objectKey}</TooltipContent>
                </Tooltip>
              </span>
              {editable && (
                <span className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" className="h-6 text-xs" disabled={busy !== null} onClick={() => ambienceRef.current?.click()}>
                    {t('shotboard.audio.replace')}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-6 text-xs" disabled={busy !== null} onClick={() => void removeImport('ambience')}>
                    {t('shotboard.audio.remove')}
                  </Button>
                </span>
              )}
            </div>
            <AudioWaveform artifact={ambience} pictureMs={pictureMs} />

            {ambienceNote && (
              <p className="border-warning/40 bg-warning/10 text-warning-ink mt-2 rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed">
                {ambienceNote}
              </p>
            )}
            {ambienceReplacesNative && (
              <p className="text-faint-foreground mt-1.5 text-[11px] leading-relaxed">
                {t('shotboard.audio.ambienceReplacesNative', { mode: audioModeWord(t, mode) })}
              </p>
            )}
          </div>
        ) : (
          <p className="text-faint-foreground mt-1 text-[11px] leading-relaxed">{t('shotboard.audio.ambienceEmpty', { mode: audioModeWord(t, mode) })}</p>
        )}
      </div>

      {(imported || shot.subtitleText !== null) && (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-muted-foreground text-xs">{t('shotboard.audio.subtitle')}</p>
            <HelpHint text={t('shotboard.audio.subtitleHint')} />
            <div role="group" aria-label={t('shotboard.audio.subtitle')} className="ml-auto flex items-center gap-1">
              <Button
                variant={customSubtitle ? 'ghost' : 'secondary'}
                size="sm"
                aria-pressed={!customSubtitle}
                className={cn('h-7 text-xs', !customSubtitle && 'text-foreground font-medium')}
                disabled={!editable || busy !== null}
                // 已经是「沿用台词」时再点一次不该发请求，也不该因此把选中的那枚
                // 灰成 disabled 的样子——灰了以后它比右边可点的「改为本镜」更弱，
                // 选中态反而看不出来。
                onClick={() => {
                  if (customSubtitle) void saveSubtitle(null)
                }}
              >
                {t('shotboard.audio.subtitleDialogue')}
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={customSubtitle ? 'secondary' : 'ghost'}
                    size="sm"
                    aria-pressed={customSubtitle}
                    className={cn('h-7 text-xs', customSubtitle && 'text-foreground font-medium')}
                    disabled={!editable || busy !== null}
                    onClick={() => {
                      setDraft(shot.subtitleText ?? shot.dialogue)
                      setEditing(true)
                    }}
                  >
                    {t('shotboard.audio.subtitleCustom')}
                  </Button>
                </TooltipTrigger>
                {/* 没改之前这一格实际吃的是台词，只有提示能说明白；原生 title 看不见 */}
                {!customSubtitle && <TooltipContent>{t('shotboard.audio.subtitleFromDialogue')}</TooltipContent>}
              </Tooltip>
            </div>
          </div>

          {(editing || customSubtitle) && (
            <div className="mt-1.5 space-y-1.5">
              <textarea
                value={draft}
                rows={2}
                disabled={!editable || busy !== null}
                placeholder={t('shotboard.audio.subtitlePlaceholder')}
                aria-label={t('shotboard.audio.subtitle')}
                onChange={event => setDraft(event.target.value)}
                className="border-input bg-background focus-visible:ring-ring w-full resize-y rounded-md border px-2 py-1.5 text-sm"
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!editable || busy !== null || draft.trim() === (shot.subtitleText ?? '').trim()}
                  onClick={() => void saveSubtitle(draft)}
                >
                  {t('shotboard.audio.subtitleSave')}
                </Button>
                {editing && !customSubtitle && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={busy !== null} onClick={() => setEditing(false)}>
                    {t('common.cancel')}
                  </Button>
                )}
                <span className="text-faint-foreground text-[11px]">{t('shotboard.audio.subtitleNeedsCompose')}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {shotOwesVoice(shot) && !track && <p className="text-warning-ink mt-2 text-[11px]">{t('shotboard.audio.waitingVoice')}</p>}

      {track && track.id !== imported?.id && (
        <div className="mt-2">
          <p className="text-muted-foreground mb-1 text-xs">{t('shotboard.voiceRow')}</p>
          <AudioWaveform artifact={track} pictureMs={pictureMs} />
        </div>
      )}
    </div>
  )
}

function ShotDetailDialog({ shot, onClose, onOpenShot, onChosen }: { shot: ShotboardShot | null; onClose: () => void; onOpenShot: (shotId: string) => void; onChosen: () => void }) {
  const { t, locale } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const [choosing, setChoosing] = useState<string | null>(null)

  async function choose(shotId: string, artifactId: string | null) {
    setChoosing(artifactId ?? 'clear')
    try {
      await api(`/storyboards/${shotId}/video-selection`, { method: 'POST', body: JSON.stringify({ artifactId }) })
      toast.success(artifactId ? t('shotboard.chosenToast') : t('shotboard.autoToast'))
      onChosen()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setChoosing(null)
    }
  }

  return (
    <Dialog open={Boolean(shot)} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {shot && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="text-muted-foreground font-mono">#{shot.number}</span>
                {shot.title}
                <span className="text-muted-foreground text-sm font-normal tabular-nums">{formatDuration(shot.durationMs)}</span>
              </DialogTitle>
              <DialogDescription>{shot.description}</DialogDescription>
            </DialogHeader>

            {/* 等宽两格并排:分镜画的那一帧和抽出来的成片要能同屏对比，
                一大一小、一上一下就没法回答"到底差在哪"。 */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(['firstFrame', 'video'] as const).map(stage => (
                <div key={stage} className="min-w-0">
                  <p className="text-muted-foreground mb-1 text-xs">
                    {stage === 'firstFrame' ? t('storyboards.firstFrame') : t('storyboards.video')}
                  </p>
                  {shot[stage] ? (
                    <ArtifactMedia artifact={shot[stage]!} label={shot.title} className="max-h-72 w-full" />
                  ) : (
                    <p className="text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-xs">
                      {t('generations.notGenerated')}
                    </p>
                  )}
                </div>
              ))}
            </div>

            {/* 声音来源：以前这里只是一行「音轨：已生成」的灯，既改不了也听不到。
                现在四档可选、导入件可换，并且真的能播。 */}
            <AudioSourceRow shot={shot} onChanged={onChosen} />

            {shot.videoCandidates.length >= 2 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-muted-foreground text-xs">{t('shotboard.candidates', { count: shot.videoCandidates.length })}</p>
                  {shot.selectedVideoArtifactId && can('storyboard:write') && (
                    <Button variant="ghost" size="sm" className="h-6 text-xs" disabled={choosing !== null} onClick={() => void choose(shot.id, null)}>
                      {t('shotboard.autoLatest')}
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  {shot.videoCandidates.map(candidate => (
                    <VideoCandidateRow
                      key={candidate.artifactId}
                      candidate={candidate}
                      shotNumber={shot.number}
                      busy={choosing !== null}
                      onChoose={() => void choose(shot.id, candidate.artifactId)}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="grid gap-1.5 text-sm">
              {shot.dialogue && (
                <ShotField label={t('storyboards.dialogue')} value={`${shot.speaker ? `${shot.speaker}：` : ''}${shot.dialogue}`} />
              )}
              {shot.sourceExcerpt && <ShotField label={t('storyboards.sourceExcerpt')} value={shot.sourceExcerpt} />}
              {shot.continuityIn && <ShotField label={t('storyboards.continuityIn')} value={shot.continuityIn} />}
              {shot.continuityOut && <ShotField label={t('storyboards.continuityOut')} value={shot.continuityOut} />}
            </div>

            {(shot.firstFrameError || shot.videoError) && (
              <div className="border-destructive/30 bg-destructive/5 rounded-md border px-3 py-2 text-xs">
                {shot.firstFrameError && <p className="text-destructive-ink">{shotDemandText(t, shot, 'frame_failed')}</p>}
                {shot.videoError && (
                  <p className={cn('text-destructive-ink', shot.firstFrameError && 'mt-1')}>{shotDemandText(t, shot, 'video_failed')}</p>
                )}
                {/* 原始报错只留在这屏：卡片与队列是扫的，这里才是读证据的地方。 */}
                <p className="text-faint-foreground mt-1.5 break-words">
                  {t('shotboard.rawError')}: {[shot.firstFrameError, shot.videoError].filter(Boolean).join(' ｜ ')}
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 text-xs">
              {shot.assets.map(asset => {
                const badge = (
                  <Badge
                    variant={asset.status === 'APPROVED' ? 'success' : 'warning'}
                    className="font-normal"
                  >
                    {asset.status === 'APPROVED' ? <CheckCircle2Icon className="size-3" /> : <UserCheckIcon className="size-3" />}
                    {asset.name}
                    {asset.reference && <ImageIcon className="size-3" />}
                  </Badge>
                )
                // 原生 title 触屏/悬停不可靠，参考图含义走 Tooltip 组件。
                return asset.reference ? (
                  <Tooltip key={asset.id}>
                    <TooltipTrigger asChild>{badge}</TooltipTrigger>
                    <TooltipContent>{t('shotboard.referenceAttached')}</TooltipContent>
                  </Tooltip>
                ) : (
                  <span key={asset.id}>{badge}</span>
                )
              })}
              {shot.qc.map(verdict => (
                <Badge key={verdict.kind} variant={verdict.status === 'APPROVED' ? 'success' : verdict.status === 'NEEDS_REVIEW' ? 'warning' : 'muted'} className="font-normal tabular-nums">
                  QC {verdict.kind} {verdict.score !== null ? Math.round(verdict.score * 100) : '—'}
                </Badge>
              ))}
              {shot.usage && <span className="text-muted-foreground">{t('shotboard.usageCalls', { calls: shot.usage.calls })}</span>}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                {t('common.close')}
              </Button>
              <Button onClick={() => onOpenShot(shot.id)}>
                {t('shotboard.openInFlow')}
                <ArrowRightIcon />
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ShotField({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/30 rounded-md border px-3 py-2">
      <p className="text-muted-foreground text-[11px]">{label}</p>
      <p className="mt-0.5 text-sm leading-snug">{value}</p>
    </div>
  )
}

function VideoCandidateRow({ candidate, shotNumber, busy, onChoose }: { candidate: ShotVideoCandidate; shotNumber: number; busy: boolean; onChoose: () => void }) {
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
    <div className={cn('flex items-center gap-3 rounded-md border p-2', candidate.selected && 'border-success/40 bg-success/5')}>
      <ArtifactMedia artifact={artifact} label={`#${shotNumber} v${candidate.version}`} interactive={false} className="h-16 w-28 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex items-center gap-2 text-xs font-medium">
          v{candidate.version}
          {candidate.selected && (
            <Badge variant="success" className="font-normal">
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
        <GuardedButton action="storyboard:write" variant="outline" size="sm" className="shrink-0 text-xs" disabled={busy} onClick={onChoose}>
          {t('shotboard.choose')}
        </GuardedButton>
      )}
    </div>
  )
}

/** 预映:拿现有素材按镜头顺序粗排。只读——不触发任何图片/视频模型调用。 */
function PreScreenDialog({ shots, open, onClose }: { shots: ShotboardShot[]; open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    if (open) {
      setIndex(0)
      setPlaying(false)
    }
  }, [open])

  const shot = shots[index] ?? null
  const finished = playing === false && index >= shots.length - 1 && shots.length > 0

  useEffect(() => {
    if (!playing || !shot || open === false) return
    // 有可放片段时由 onEnded 推进;占位帧按规划时长走。
    if (shot.slot === 'chosen' || shot.slot === 'video') return
    const timer = setTimeout(() => advance(), Math.max(shot.durationMs ?? 2000, 1200))
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, index, open])

  function advance() {
    if (index + 1 < shots.length) {
      setIndex(index + 1)
    } else {
      setPlaying(false)
    }
  }

  function slotLabel(s: ShotboardShot): string {
    if (s.slot === 'chosen') return t('shotboard.strip.chosen')
    if (s.slot === 'video') return t('shotboard.strip.hasclip')
    if (s.slot === 'running') return t('shotboard.strip.running')
    if (s.slot === 'frame') return t('shotboard.strip.frameOnly')
    return t('shotboard.strip.missing')
  }

  return (
    <Dialog open={open} onOpenChange={next => !next && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('screening.preScreen')}</DialogTitle>
          <DialogDescription>{t('screening.preScreenHint')}</DialogDescription>
        </DialogHeader>

        {shot && <PreScreenStage key={shot.id} shot={shot} playing={playing} onEnded={advance} />}

        {shot && (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                <span className="text-muted-foreground font-mono">#{shot.number}</span> {shot.title}
              </p>
              <p className="text-subtle-foreground text-[11px] tabular-nums">
                {slotLabel(shot)} · {formatDuration(shot.durationMs)} · {index + 1}/{shots.length}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {playing ? (
                <Button variant="outline" size="sm" onClick={() => setPlaying(false)}>
                  <PauseIcon />
                  {t('screening.pause')}
                </Button>
              ) : (
                <Button size="sm" onClick={() => { if (finished) setIndex(0); setPlaying(true) }}>
                  {finished ? <RotateCcwIcon /> : <PlayIcon />}
                  {finished ? t('screening.replay') : t('screening.play')}
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="bg-muted/20 flex gap-px overflow-x-auto rounded-md border p-1">
          {shots.map((s, i) => (
            <Tooltip key={s.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`#${s.number} ${s.title} · ${slotLabel(s)}`}
                  onClick={() => { setIndex(i); setPlaying(false) }}
                  style={{ flexGrow: Math.max(s.durationMs, 500), flexBasis: 0, minWidth: 10 }}
                  className={cn(
                    'h-2 cursor-pointer rounded-sm',
                    i === index ? 'bg-primary' : s.slot === 'chosen' || s.slot === 'video' ? 'bg-success/50' : s.slot === 'running' ? 'bg-info/60' : 'bg-muted-foreground/25',
                  )}
                />
              </TooltipTrigger>
              {/* 8px 高的色条说不出自己是第几镜，这句是它唯一的名字 */}
              <TooltipContent>{`#${s.number} ${s.title} · ${slotLabel(s)}`}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PreScreenStage({ shot, playing, onEnded }: { shot: ShotboardShot; playing: boolean; onEnded(): void }) {
  const { t } = useI18n()
  const videoRef = useRef<HTMLVideoElement>(null)
  const playable = (shot.slot === 'chosen' || shot.slot === 'video') && shot.video !== null
  const { url, failed: videoFailed, reload: reloadVideo } = useArtifactUrl(playable && shot.video ? shot.video.downloadUrl : null)
  const wantsFrame = !playable && shot.slot === 'frame' && shot.firstFrame !== null
  const { url: frameUrl, failed: frameFailed, reload: reloadFrame } = useArtifactUrl(wantsFrame && shot.firstFrame ? shot.firstFrame.downloadUrl : null)

  // autoPlay 只在挂载时生效；暂停/恢复必须有人按下播放键这件事真正落到元素上。
  useEffect(() => {
    if (playing && playable && url) void videoRef.current?.play().catch(() => undefined)
    if (!playing) videoRef.current?.pause()
  }, [playing, playable, url])

  return (
    <div className="bg-black relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-md">
      {playable && videoFailed ? (
        // 「这一镜的成片读不出来」以前和「还在读」是同一行字：舞台会永远停在
        // 「加载中」。黑色舞台用 destructive 本身而不是浅底 ink 色。
        <ArtifactLoadError className="text-destructive mx-4 max-w-72 bg-destructive/15" onRetry={reloadVideo} />
      ) : playable && url ? (
        <video ref={videoRef} src={url} playsInline onEnded={onEnded} className="h-full w-full object-contain" />
      ) : playable ? (
        <p className="text-muted-foreground text-xs">{t('screening.loading')}</p>
      ) : frameFailed ? (
        <ArtifactLoadError className="text-destructive mx-4 max-w-72 bg-destructive/15" onRetry={reloadFrame} />
      ) : shot.slot === 'frame' && frameUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={frameUrl} alt={`#${shot.number} ${shot.title}`} className="h-full w-full object-contain" />
      ) : shot.slot === 'running' ? (
        <p className="text-muted-foreground animate-pulse text-sm">{t('shotboard.strip.running')}</p>
      ) : (
        <div className="text-center">
          <p className="text-muted-foreground font-mono text-sm">#{shot.number}</p>
          <p className="text-faint-foreground text-xs">{t('shotboard.strip.missing')}</p>
        </div>
      )}
      {shot.slot === 'frame' && !playable && (
        <span className="text-faint-foreground absolute bottom-2 right-3 text-[10px]">{t('screening.placeholderBadge')}</span>
      )}
    </div>
  )
}
