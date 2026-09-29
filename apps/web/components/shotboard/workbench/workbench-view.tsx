'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ClapperboardIcon,
  FilmIcon,
  PackageIcon,
  PaletteIcon,
  PlayIcon,
} from 'lucide-react'
import type { Asset, AssetsResponse, ShotboardResponse, ShotboardShot, Storyboard } from '@/lib/api'
import { useI18n, type TranslateFn } from '@/lib/i18n'
import { shotDemandText } from '@/lib/shot-verdict'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { EmptyState } from '@/components/ui/empty-state'
import { TableSkeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'
import { ShotStrip } from './shot-strip'
import { ShotList } from './shot-list'
import { AssetList } from './asset-list'
import { AssetEditor } from './asset-editor'
import { AssetInspector } from './asset-inspector'
import { ShotEditor } from './shot-editor'
import { PreviewPanel } from './preview-panel'
import { PreScreenDialog } from './pre-screen'

interface WorkbenchViewProps {
  episodeId: string
  /** 页面已加载的素材清单（编辑器绑定与页签计数共用一份）。 */
  episodeAssets: Asset[]
  /** 流程页跳转：这一镜的上下文 / 素材区 / 批次与整集操作。 */
  onOpenShot(shotId: string): void
  onReviewAssets(): void
  onOpenFlow(): void
  /** 跳流程页分镜卡（AI 重新分镜按钮所在）。 */
  onOpenStoryboardCard(): void
  /** 页面持有的弹窗与动作。 */
  onOpenSettings(): void
  /** 项目级风格名（外化只读徽章；空=没选或加载失败，不渲染）。 */
  styleName: string | null
  onCreateShot(): void
  onChangeStatus(shot: Pick<Storyboard, 'id' | 'number' | 'title' | 'status'>): void
  onBindAssets(storyboardId: string, assets: { assetId: string; role: string }[]): Promise<void>
  onRegenerate(storyboardId: string, stage: 'FIRST_FRAME' | 'VIDEO' | 'AUDIO', note?: string, regenerate?: boolean): Promise<void>
  /** 外部变化（弹窗保存/绑定/推进）后让制作台立即重读，不等轮询。 */
  refreshToken: number
}

/**
 * 制作台：board 的三区化形态——左列清单（镜头/素材两个页签），中列放这一页签的
 * 主任务（镜头=改脚本，素材=审参考图——两者都要宽），右列是配套面板（产物预览/档案勘误）。
 * 「看清单 → 改/审 → 重跑 → 看结果 → 下一条」的循环不出屏；
 * 流程页继续承担推进与整集操作，这里只留一条快道（批次 chip）。
 */
export function WorkbenchView({
  episodeId,
  episodeAssets,
  onOpenShot,
  onReviewAssets,
  onOpenFlow,
  onOpenStoryboardCard,
  onOpenSettings,
  styleName,
  onCreateShot,
  onChangeStatus,
  onBindAssets,
  onRegenerate,
  refreshToken,
}: WorkbenchViewProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const canWrite = can('storyboard:write')

  const load = useCallback(() => api<ShotboardResponse>(`/episodes/${episodeId}/shotboard`), [api, episodeId])
  const board = useAsync<ShotboardResponse | null>(load, null)

  // 素材清单与镜头板同源同节奏：检查器的运行态/新版本靠它驱动，必须无条件轮询。
  const assetsLoad = useCallback(() => api<AssetsResponse>(`/episodes/${episodeId}/assets`), [api, episodeId])
  const assets = useAsync<AssetsResponse>(assetsLoad, { assets: [] })

  useEffect(() => {
    const timer = setInterval(() => {
      board.reload()
      assets.reload()
    }, 10_000)
    return () => clearInterval(timer)
  }, [board.reload, assets.reload])

  useEffect(() => {
    if (refreshToken > 0) {
      board.reload()
      assets.reload()
    }
    // refreshToken 是页面的“数据变了”信号，reload 身份稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken])

  const shots = board.data?.shots ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<'shots' | 'assets'>('shots')
  const [focusAssetId, setFocusAssetId] = useState<string | null>(null)
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [requestingStage, setRequestingStage] = useState<'FIRST_FRAME' | 'VIDEO' | 'AUDIO' | null>(null)
  const [preScreenOpen, setPreScreenOpen] = useState(false)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId

  // 没有选中时落在第一镜；选中镜从清单里消失（重生成分镜换版）时退回第一镜。
  const selected = shots.find(shot => shot.id === selectedId) ?? shots[0] ?? null
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id)
  }, [selected, selectedId])

  // 左列选谁，中/右列跟着说谁；从清单里被删掉的素材自然落空。
  const selectedAsset = assets.data.assets.find(asset => asset.id === selectedAssetId) ?? null
  useEffect(() => {
    if (focusAssetId) {
      setSelectedAssetId(focusAssetId)
      setFocusAssetId(null)
    }
  }, [focusAssetId])

  /** 素材档案编辑里「出现在」一行的数据：板上活绑定的镜头，按板序。 */
  const assetShotLinks = useMemo(() => {
    if (!selectedAsset) return []
    const appearances = board.data?.assets.find(item => item.id === selectedAsset.id)?.appearances ?? []
    return appearances
      .map(shotId => shots.find(shot => shot.id === shotId))
      .filter((shot): shot is ShotboardShot => Boolean(shot))
      .map(shot => ({ id: shot.id, number: shot.number, title: shot.title }))
  }, [selectedAsset, board.data, shots])

  function reloadAssets() {
    assets.reload()
    board.reload()
  }

  const index = selected ? shots.findIndex(shot => shot.id === selected.id) : -1
  const prevShot = index > 0 ? shots[index - 1] : null
  const nextShot = index >= 0 && index < shots.length - 1 ? shots[index + 1] : null

  // ←/→ 切镜：输入控件聚焦时让给文本编辑；素材页签与弹层/lightbox 打开时不抢键。
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const target = event.target
      if (target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
      if (tab !== 'shots') return
      if (document.querySelector('[role="dialog"]')) return
      const current = shots.findIndex(shot => shot.id === selectedRef.current)
      if (current < 0) return
      const next = event.key === 'ArrowLeft' ? current - 1 : current + 1
      if (next >= 0 && next < shots.length) {
        event.preventDefault()
        setSelectedId(shots[next].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shots, tab])

  /** 重跑=覆盖重来（regenerate:true，出新一版候选）；生成=只补缺。动词说重跑就
   *  必须真重跑——旧版只发补缺请求，已有产物的镜排零任务，按钮亮成功却什么都没
   *  发生（2026-09-28 用户实测「没有任何加载」的根因）。 */
  async function regenerateStage(stage: 'FIRST_FRAME' | 'VIDEO' | 'AUDIO', note?: string, regenerate = false) {
    if (!selected) return
    setRequestingStage(stage)
    try {
      await onRegenerate(selected.id, stage, note, regenerate)
    } finally {
      setRequestingStage(null)
      board.reload()
    }
  }

  /** 待办队列：影响面 → 严重度 → 等待时长，与旧总览同一裁决，只是住进了弹层。 */
  const todo = useMemo(() => buildTodo(t, board.data), [board.data, t])

  if (board.error && !board.data) return <ErrorState message={board.error} onRetry={board.reload} />

  if (board.loading && !board.data) {
    return (
      <Card>
        <CardContent className="py-4">
          <TableSkeleton rows={6} />
        </CardContent>
      </Card>
    )
  }

  if (shots.length === 0) {
    return (
      <Card>
        <CardContent className="py-10">
          <EmptyState
            icon={<ClapperboardIcon />}
            title={t('storyboards.none')}
            description={t('storyboards.noneHint')}
            action={canWrite ? (
              <Button size="sm" onClick={onCreateShot}>
                {t('storyboards.new')}
              </Button>
            ) : undefined}
          />
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* 工具行：快道入口。产物进度不在这里重复报数——正下方的放映条就是它的
          图形版且更全（绿=齐、斜纹=欠画面、红=失败、蓝脉冲=在产、底线=钦定），
          数字行与条上下紧贴被用户判为重复（2026-09-28）。 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground tabular-nums">
        <div className="ml-auto flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs">
                <AlertTriangleIcon className="size-3.5" />
                {t('workbench.todo', { count: todo.length })}
                <ChevronDownIcon className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-96 w-96 overflow-y-auto">
              <DropdownMenuLabel>{t('screening.sortByImpact')}</DropdownMenuLabel>
              {todo.length === 0 && <p className="text-muted-foreground px-2 py-2 text-xs">{t('shotboard.allQuiet')}</p>}
              {todo.map(item => (
                <DropdownMenuItem
                  key={item.key}
                  onClick={() => {
                    if (item.kind === 'asset') {
                      setTab('assets')
                      if (item.assetId) setFocusAssetId(item.assetId)
                    } else if (item.shotId) {
                      setTab('shots')
                      setSelectedId(item.shotId)
                    }
                  }}
                >
                  <Badge variant={item.tone === 'danger' ? 'destructive' : 'warning'} className="shrink-0 font-normal">
                    {item.label}
                  </Badge>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]">{item.subject}</span>
                  <span className="min-w-0 flex-1 truncate text-xs">{item.demand}</span>
                  {item.waited && <span className="text-muted-foreground shrink-0 text-[10.5px] tabular-nums">{item.waited}</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" className="h-7 text-xs text-primary" onClick={onOpenFlow}>
            {t('workbench.batches')}
            <ArrowRightIcon className="size-3" />
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setPreScreenOpen(true)}>
            <PlayIcon className="size-3.5" />
            {t('screening.preScreen')}
          </Button>
          {/* 风格入口只此一枚：弹窗里本来就只有风格设置，「电影感」状态钮与裸「配置」
              曾并排同开一个弹窗（用户：电影感可以配置风格，配置也是干这个的）。
              当前风格名本身就是入口——在哪展示就在哪可改；未设风格时也给出口。 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <GuardedButton action="project:update" variant="outline" size="sm" className="text-muted-foreground h-7 text-xs" onClick={onOpenSettings}>
                <PaletteIcon className="size-3.5" />
                {styleName ?? t('settings.style')}
              </GuardedButton>
            </TooltipTrigger>
            <TooltipContent>{t('workbench.styleChipHint')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <ShotStrip shots={shots} onOpen={shotId => { setTab('shots'); setSelectedId(shotId) }} />

      {/* 三区 */}
      <div className="border-border/60 grid min-h-0 flex-1 overflow-hidden rounded-xl border lg:grid-cols-[18.5rem_minmax(0,1fr)_23rem] lg:[height:calc(100dvh-19rem)]">
        {/* 左列 */}
        <div className="bg-sidebar/40 flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r">
          <div className="border-border/60 flex items-center gap-1 border-b px-2 py-1.5">
            <button
              type="button"
              aria-pressed={tab === 'shots'}
              onClick={() => setTab('shots')}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
                tab === 'shots' ? 'bg-accent text-foreground' : 'text-subtle-foreground hover:text-foreground',
              )}
            >
              <FilmIcon className="mr-1 inline size-3.5" />
              {t('workbench.tabShots', { count: shots.length })}
            </button>
            <button
              type="button"
              aria-pressed={tab === 'assets'}
              onClick={() => setTab('assets')}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
                tab === 'assets' ? 'bg-accent text-foreground' : 'text-subtle-foreground hover:text-foreground',
              )}
            >
              <PackageIcon className="mr-1 inline size-3.5" />
              {t('workbench.tabAssets', { count: board.data?.assets.length ?? 0 })}
            </button>
          </div>
          {tab === 'shots' ? (
            <ShotList shots={shots} selectedId={selected?.id ?? null} onSelect={setSelectedId} onCreate={onCreateShot} canWrite={canWrite} />
          ) : assets.error && assets.data.assets.length === 0 ? (
            <div className="p-3">
              <ErrorState message={assets.error} onRetry={assets.reload} />
            </div>
          ) : (
            <AssetList
              episodeId={episodeId}
              assets={assets.data.assets}
              loading={assets.loading}
              selectedId={selectedAsset?.id ?? null}
              onSelect={setSelectedAssetId}
              onAdded={reloadAssets}
            />
          )}
        </div>

        {/* 中列：这一页签的主任务——镜头=改脚本（表单要宽）；素材=审参考图（图要宽）。 */}
        <div className="flex min-h-0 flex-col">
          {tab === 'shots' ? (
            selected ? (
              <ShotEditor
                key={selected.id}
                shot={selected}
                episodeAssets={episodeAssets}
                canWrite={canWrite}
                onBindAssets={onBindAssets}
                onChangeStatus={onChangeStatus}
                onOpenShot={onOpenShot}
                onOpenStoryboardCard={onOpenStoryboardCard}
                onOpenAsset={assetId => { setTab('assets'); setFocusAssetId(assetId) }}
                onSaved={board.reload}
              />
            ) : (
              <EmptyState icon={<FilmIcon />} title={t('workbench.pickShot')} description={t('workbench.pickShotHint')} />
            )
          ) : selectedAsset ? (
            <AssetInspector key={selectedAsset.id} episodeId={episodeId} asset={selectedAsset} onChanged={reloadAssets} />
          ) : (
            <EmptyState icon={<PackageIcon />} title={t('workbench.pickAsset')} description={t('workbench.pickAssetHint')} />
          )}
        </div>

        {/* 右列：配套面板——镜头=产物预览；素材=档案勘误（低频，窄列够用）。 */}
        <div className="bg-sidebar/40 flex min-h-0 flex-col border-t lg:border-t-0 lg:border-l">
          {tab === 'shots' ? (
            selected && (
              <PreviewPanel
                shot={selected}
                requestingStage={requestingStage}
                onRegenerate={(stage, note, regenerate) => void regenerateStage(stage, note, regenerate)}
                onChanged={board.reload}
                onPrev={() => prevShot && setSelectedId(prevShot.id)}
                onNext={() => nextShot && setSelectedId(nextShot.id)}
                hasPrev={Boolean(prevShot)}
                hasNext={Boolean(nextShot)}
                prevNumber={prevShot?.number ?? null}
                nextNumber={nextShot?.number ?? null}
              />
            )
          ) : selectedAsset ? (
            <AssetEditor
              key={selectedAsset.id}
              episodeId={episodeId}
              asset={selectedAsset}
              usages={assetShotLinks}
              canWrite={can('episode:write')}
              onOpenShot={shotId => { setTab('shots'); setSelectedId(shotId) }}
              onSaved={reloadAssets}
            />
          ) : (
            <EmptyState icon={<PackageIcon />} title={t('workbench.pickAsset')} description={t('workbench.pickAssetSideHint')} />
          )}
        </div>
      </div>

      <PreScreenDialog shots={shots} open={preScreenOpen} onClose={() => setPreScreenOpen(false)} />
    </div>
  )
}

interface TodoItem {
  key: string
  label: string
  tone: 'danger' | 'warning'
  subject: string
  demand: string
  shotId?: string
  assetId?: string
  kind: 'shot' | 'asset'
  impact: number
  waited: string | null
}

/** danger 排在 warning 前：同影响面时，红色的事先于琥珀色。 */
function toneRank(tone: 'danger' | 'warning'): number {
  return tone === 'danger' ? 0 : 1
}

/** 等待时钟只认真时间戳。取不到就不显示。 */
function waitedText(t: TranslateFn, since: string | null): string | null {
  if (!since) return null
  const ms = Date.now() - new Date(since).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return t('shotboard.wait.justNow')
  if (minutes < 60) return t('shotboard.wait.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('shotboard.wait.hours', { count: hours })
  return t('shotboard.wait.days', { count: Math.floor(hours / 24) })
}

/**
 * 待办队列与旧总览同一套裁决：素材门禁按影响面（被几镜引用）排前，
 * 镜头条目只报卡片此刻正在说的那档失败，等了多久做第三关键字。
 */
function buildTodo(t: TranslateFn, data: ShotboardResponse | null): TodoItem[] {
  if (!data) return []
  const items: TodoItem[] = []
  for (const asset of data.assetsPending) {
    items.push({
      key: `asset-${asset.id}`,
      label: asset.hasVersions ? t('attention.asset_gate') : t('attention.asset_no_image'),
      tone: asset.hasVersions ? 'warning' : 'danger',
      subject: asset.name,
      demand: asset.hasVersions ? t('shotboard.demand.approveAsset') : t('shotboard.demand.generateAssetImage'),
      assetId: asset.id,
      kind: 'asset',
      impact: data.assets.find(cast => cast.id === asset.id)?.appearances.length ?? 0,
      waited: waitedText(t, asset.waitingSince),
    })
  }
  const attentionMeta: Record<string, { label: string; tone: 'danger' | 'warning' }> = {
    frame_failed: { label: t('attention.frame_failed'), tone: 'danger' },
    video_failed: { label: t('attention.video_failed'), tone: 'danger' },
    shot_blocked: { label: t('shotboard.stage.blocked'), tone: 'danger' },
    awaiting_review: { label: t('shotboard.stage.review'), tone: 'warning' },
    selection_open: { label: t('attention.selection_open'), tone: 'warning' },
  }
  for (const shot of data.shots) {
    for (const code of shot.attention) {
      if (code === 'asset_gate') continue
      const entry = attentionMeta[code]
      if (!entry) continue
      items.push({
        key: `shot-${shot.id}-${code}`,
        label: entry.label,
        tone: entry.tone,
        subject: `#${shot.number}`,
        demand: shotDemandTextSafe(t, shot, code),
        shotId: shot.id,
        kind: 'shot',
        impact: 1,
        waited: waitedText(t, shot.waitingSince),
      })
    }
  }
  items.sort((a, b) => b.impact - a.impact || toneRank(a.tone) - toneRank(b.tone) || (b.waited ? 1 : 0) - (a.waited ? 1 : 0))
  return items
}

function shotDemandTextSafe(t: TranslateFn, shot: ShotboardShot, code: string): string {
  try {
    return shotDemandText(t, shot, code)
  } catch {
    return code
  }
}
