'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangleIcon, ArrowRightIcon, CheckCircle2Icon, ClapperboardIcon, FilmIcon, ImageIcon,
  PauseIcon, PlayIcon, RotateCcwIcon, UsersIcon, UserCheckIcon,
} from 'lucide-react'
import { type GenerationArtifact, type ShotboardCastAsset, type ShotboardResponse, type ShotboardShot, type ShotVideoCandidate } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn, formatDateTime, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/error-state'
import { Skeleton, TableSkeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GuardedButton, usePermission } from '@/components/permission'
import { ArtifactMedia, useArtifactUrl } from '@/components/generations/artifact-media'
import { ArtifactLightbox } from '@/components/artifact-lightbox'
import { ShotCard } from './shot-card'

/** 班底轨道与放映条共用的行首标签列宽——列对不齐,因果就读不出来。 */
const LABEL_COL = '172px'

interface AttentionItem {
  key: string
  label: string
  detail: string
  tone: 'danger' | 'warning'
  shotId?: string
  kind: 'shot' | 'asset'
  /** 影响面:这件事挡住/拖累多少镜头——缺口队列按它排序。 */
  impact: number
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

  // 放映条与班底轨道共用同一份列宽(=镜头规划时长),竖着对得上才看得出因果。
  const shotCols = data.shots.map(shot => `${Math.max(shot.durationMs, 500)}fr`).join(' ')
  const readyCount = data.shots.filter(shot => stripTone(shot) === 'ready').length

  const attentionLabel: Record<string, { text: string; tone: 'danger' | 'warning' }> = {
    frame_failed: { text: t('attention.frame_failed'), tone: 'danger' },
    video_failed: { text: t('attention.video_failed'), tone: 'danger' },
    asset_gate: { text: t('attention.asset_gate'), tone: 'warning' },
    shot_blocked: { text: t('attention.shot_blocked'), tone: 'warning' },
    selection_open: { text: t('attention.selection_open'), tone: 'warning' },
  }

  const appearancesByAssetId = new Map(data.assets.map(asset => [asset.id, asset.appearances]))
  const items: AttentionItem[] = []
  for (const asset of data.assetsPending) {
    const impact = appearancesByAssetId.get(asset.id)?.length ?? 0
    items.push({ key: `asset-${asset.id}`, label: t('attention.asset_gate'), detail: `${asset.name} · ${t('screening.impactShots', { count: impact })}`, tone: 'warning', kind: 'asset', impact })
  }
  for (const shot of data.shots) {
    for (const code of shot.attention) {
      const entry = attentionLabel[code]
      if (!entry) continue
      if (code === 'asset_gate') continue // already covered by the episode-level lane
      items.push({ key: `shot-${shot.id}-${code}`, label: entry.text, detail: `#${shot.number} ${shot.title}`, tone: entry.tone, shotId: shot.id, kind: 'shot', impact: 1, openDialog: code === 'selection_open' })
    }
  }
  // 先按影响面,再按严重度:一件事拖住七个镜头的,不该排在单个镜头失败后面。
  items.sort((a, b) => b.impact - a.impact || (a.tone === b.tone ? 0 : a.tone === 'danger' ? -1 : 1))

  const kindRank: Record<string, number> = { character: 0, scene: 1, prop: 2 }
  const cast = [...data.assets].sort((a, b) => (kindRank[a.kind] ?? 3) - (kindRank[b.kind] ?? 3) || b.appearances.length - a.appearances.length || a.name.localeCompare(b.name))

  return (
    <div className="space-y-6">
      {items.length > 0 && (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangleIcon className="text-warning-ink size-4" />
              {t('screening.gapsTitle')}
              <Badge variant="warning">{items.length}</Badge>
            </CardTitle>
            <CardDescription>{t('screening.gapsHint')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {items.map(item => (
              <button
                key={item.key}
                type="button"
                onClick={() => (item.kind === 'asset' ? onReviewAssets() : item.openDialog && item.shotId ? setSelectedId(item.shotId) : item.shotId && onOpenShot(item.shotId))}
                className="hover:bg-accent/60 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
              >
                {item.tone === 'danger' ? <AlertTriangleIcon className="text-destructive-ink size-3.5" /> : <UserCheckIcon className="text-warning-ink size-3.5" />}
                <span className="font-medium">{item.label}</span>
                <span className="text-muted-foreground">{item.detail}</span>
                {item.impact > 1 && (
                  <Badge variant="muted" className="font-normal tabular-nums">
                    {t('screening.impactBadge', { count: item.impact })}
                  </Badge>
                )}
                <ArrowRightIcon className="text-muted-foreground size-3" />
              </button>
            ))}
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
            <div className="space-y-4">
              <div>
                <div className="bg-muted/40 flex items-center gap-2">
                  <div className="bg-muted/60 h-1 min-w-24 flex-1 overflow-hidden rounded-full">
                    <div className="bg-success h-full rounded-full transition-[width] duration-500" style={{ width: `${(readyCount / data.shots.length) * 100}%` }} />
                  </div>
                  <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                    {t('screening.progress', { ready: readyCount, total: data.shots.length })}
                  </span>
                </div>
                <ShotStrip shots={data.shots} onOpen={shotId => setSelectedId(shotId)} />
                <p className="text-muted-foreground mt-1.5 text-[11px]">{t('shotboard.stripHint')}</p>
              </div>
              <CastTrack
                episodeId={episodeId}
                shots={data.shots}
                cast={cast}
                shotCols={shotCols}
                onReload={() => void board.reload()}
              />
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {data.shots.map(shot => (
                  <div key={shot.id} id={`shot-card-${shot.id}`} className="scroll-mt-24 rounded-lg">
                    <ShotCard shot={shot} onSelect={setSelectedId} />
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

/**
 * 一镜在放映条上的底色档位。格色和"已有画面 n/N"的分子必须走这一个裁决：
 * 最新一次重生成失败的镜头仍留着旧画面，只按 slot 判会一边报 8/8、一边把同一格画红。
 */
function stripTone(shot: ShotboardShot): 'failed' | 'blocked' | 'ready' | 'pending' {
  if (shot.attention.includes('frame_failed') || shot.attention.includes('video_failed')) return 'failed'
  if (shot.attention.includes('shot_blocked') || shot.attention.includes('asset_gate')) return 'blocked'
  if (shot.slot === 'chosen' || shot.slot === 'video') return 'ready'
  return 'pending'
}

/**
 * 整集放映条:每镜一格、格宽=规划时长、格色=占位裁决。它是这一集的缩略时间轴,
 * 点击一格=放大那一镜的详情。不是时间线编辑器——剪辑仍是交付之后的事。
 */
function ShotStrip({ shots, onOpen }: { shots: ShotboardShot[]; onOpen(shotId: string): void }) {
  const { t } = useI18n()

  function stateOf(shot: ShotboardShot): { className: string; label: string } {
    const tone = stripTone(shot)
    if (tone === 'failed') return { className: 'bg-destructive', label: t('shotboard.strip.failed') }
    if (tone === 'blocked') return { className: 'bg-warning', label: t('shotboard.strip.blocked') }
    if (shot.slot === 'chosen') return { className: 'bg-success', label: t('shotboard.strip.chosen') }
    if (shot.slot === 'video') return { className: 'bg-success/50', label: t('shotboard.strip.hasclip') }
    if (shot.slot === 'running') return { className: 'bg-info animate-pulse', label: t('shotboard.strip.running') }
    if (shot.slot === 'frame') return { className: 'bg-muted-foreground/40', label: t('shotboard.strip.frameOnly') }
    return { className: 'bg-muted-foreground/25', label: t('shotboard.strip.missing') }
  }

  return (
    <div
      role="group"
      aria-label={t('shotboard.stripLabel')}
      className="mt-3 grid h-6 gap-px"
      style={{ gridTemplateColumns: `${LABEL_COL} ${shots.map(shot => `${Math.max(shot.durationMs, 500)}fr`).join(' ')}` }}
    >
      <span className="text-faint-foreground flex items-center pl-1 text-[10px] uppercase tracking-wide">{t('screening.stripAxis')}</span>
      {shots.map(shot => {
        const state = stateOf(shot)
        const label = `#${shot.number} ${shot.title} · ${formatDuration(shot.durationMs)} · ${state.label}`
        return (
          <Tooltip key={shot.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={label}
                onClick={() => onOpen(shot.id)}
                className={cn('cursor-zoom-in rounded-sm transition-opacity hover:opacity-70', state.className)}
              />
            </TooltipTrigger>
            <TooltipContent side="bottom">{label}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

/**
 * 班底轨道 A:一行一素材,行首是定妆照(点击放大),出演色块落在放映条
 * 同一列的正下方——哪一列琥珀密,哪一列的灰块就有了解释。
 */
function CastTrack({ episodeId, shots, cast, shotCols, onReload }: { episodeId: string; shots: ShotboardShot[]; cast: ShotboardCastAsset[]; shotCols: string; onReload(): void }) {
  const { t } = useI18n()
  const { api } = useSession()
  const [expanded, setExpanded] = useState(false)
  const [busyAsset, setBusyAsset] = useState<string | null>(null)

  if (cast.length === 0) return null
  const COLLAPSED = 6
  const visible = expanded ? cast : cast.slice(0, COLLAPSED)

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
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setBusyAsset(null)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <UsersIcon className="size-3.5" />
          {t('screening.castTitle')}
        </p>
        <p className="text-faint-foreground text-[11px]">{t('screening.castHint')}</p>
      </div>
      {visible.map(asset => {
        const approved = asset.status === 'APPROVED'
        const appearances = new Set(asset.appearances)
        return (
          <div key={asset.id} className="grid items-center gap-px" style={{ gridTemplateColumns: `${LABEL_COL} ${shotCols}` }}>
            <div className="flex min-w-0 items-center gap-2 py-0.5 pr-2">
              <CastThumb asset={asset} />
              <div className="min-w-0">
                <p className="truncate text-[11.5px] font-medium">{asset.name}</p>
                <p className={cn('truncate text-[10.5px]', approved ? 'text-faint-foreground' : 'text-warning-ink')}>
                  {t('screening.castShots', { count: asset.appearances.length })} · {approved ? t('screening.approved') : t('screening.pending')}
                  {!asset.hasVersions && (
                    <GuardedButton
                      action="episode:write"
                      variant="link"
                      className="text-primary ml-1.5 h-auto p-0 text-[10.5px] font-normal"
                      disabled={busyAsset === asset.id}
                      onClick={() => void generateCostume(asset)}
                    >
                      {t('screening.generateCostume')}
                    </GuardedButton>
                  )}
                </p>
              </div>
            </div>
            {shots.map(shot => {
              const cellClass = cn('h-3.5 self-center rounded-sm', appearances.has(shot.id) && (approved ? 'bg-success/70' : 'bg-warning/80'))
              return appearances.has(shot.id) ? (
                <Tooltip key={shot.id}>
                  <TooltipTrigger asChild>
                    <span className={cellClass} />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{`${asset.name} → #${shot.number} ${shot.title}`}</TooltipContent>
                </Tooltip>
              ) : (
                <span key={shot.id} className={cellClass} />
              )
            })}
          </div>
        )
      })}
      {cast.length > COLLAPSED && (
        <Button variant="ghost" size="sm" className="text-subtle-foreground h-6 text-[11px]" onClick={() => setExpanded(next => !next)}>
          {expanded ? t('screening.castCollapse') : t('screening.castShowMore', { count: cast.length - COLLAPSED })}
        </Button>
      )}
    </div>
  )
}

function CastThumb({ asset }: { asset: ShotboardCastAsset }) {
  const { t } = useI18n()
  const url = useArtifactUrl(asset.thumbnail ? asset.thumbnail.downloadUrl : null)
  const [zoomed, setZoomed] = useState(false)

  if (!asset.thumbnail) {
    // 虚线占位不是装饰:它说「这个素材连定妆照都没有」,入口就排在下一行。
    return (
      <span title={t('screening.noPhoto')} className="text-faint-foreground flex size-[34px] shrink-0 items-center justify-center rounded-[7px] border border-dashed border-white/15 text-[9px]">
        {t('screening.noPhoto')}
      </span>
    )
  }
  if (!url) return <Skeleton className="size-[34px] shrink-0 rounded-[7px]" />
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={asset.name}
        loading="lazy"
        onClick={() => setZoomed(true)}
        className="size-[34px] shrink-0 cursor-zoom-in rounded-[7px] border object-cover"
      />
      {zoomed && <ArtifactLightbox src={url} alt={asset.name} onClose={() => setZoomed(false)} />}
    </>
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
      toast.error(error instanceof Error ? error.message : t('error.generic'))
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

            <div className="grid gap-3">
              {shot.video && (
                <div>
                  <p className="text-muted-foreground mb-1 text-xs">{t('storyboards.video')}</p>
                  <ArtifactMedia artifact={shot.video} label={shot.title} className="max-h-72 w-full" />
                </div>
              )}
              {shot.firstFrame && (
                <div>
                  <p className="text-muted-foreground mb-1 text-xs">{t('storyboards.firstFrame')}</p>
                  <ArtifactMedia artifact={shot.firstFrame} label={shot.title} className="max-h-48" />
                </div>
              )}
            </div>

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
              <div className="border-destructive/30 bg-destructive/5 rounded-md border px-3 py-2 text-xs text-destructive-ink">
                {shot.firstFrameError && <p>{t('attention.frame_failed')}: {shot.firstFrameError}</p>}
                {shot.videoError && <p className="mt-1">{t('attention.video_failed')}: {shot.videoError}</p>}
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
            <button
              key={s.id}
              type="button"
              onClick={() => { setIndex(i); setPlaying(false) }}
              title={`#${s.number} ${s.title} · ${slotLabel(s)}`}
              style={{ flexGrow: Math.max(s.durationMs, 500), flexBasis: 0, minWidth: 10 }}
              className={cn(
                'h-2 cursor-pointer rounded-sm',
                i === index ? 'bg-primary' : s.slot === 'chosen' || s.slot === 'video' ? 'bg-success/50' : s.slot === 'running' ? 'bg-info/60' : 'bg-muted-foreground/25',
              )}
            />
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
  const url = useArtifactUrl(playable && shot.video ? shot.video.downloadUrl : null)
  const frameUrl = useArtifactUrl(!playable && shot.slot === 'frame' && shot.firstFrame ? shot.firstFrame.downloadUrl : null)

  // autoPlay 只在挂载时生效；暂停/恢复必须有人按下播放键这件事真正落到元素上。
  useEffect(() => {
    if (playing && playable && url) void videoRef.current?.play().catch(() => undefined)
    if (!playing) videoRef.current?.pause()
  }, [playing, playable, url])

  return (
    <div className="bg-black relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-md">
      {playable && url ? (
        <video ref={videoRef} src={url} playsInline onEnded={onEnded} className="h-full w-full object-contain" />
      ) : playable ? (
        <p className="text-muted-foreground text-xs">{t('screening.loading')}</p>
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
