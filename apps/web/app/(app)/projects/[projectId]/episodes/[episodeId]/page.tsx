'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { apiErrorMessage } from '@/lib/api-error'
import {
  ClapperboardIcon,
  LoaderCircleIcon,
  PlusIcon,
} from 'lucide-react'
import {
  isLiveStoryboard,
  storyboardsPath,
  toWorkflowStatus,
  type AssetsResponse,
  type Episode,
  type GenerationTask,
  type GenerationsResponse,
  type Project,
  type Storyboard,
} from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { buildShotEvents } from '@/lib/shot-history'
import { shotOwesVoice, shotVoiceTrack } from '@/lib/shot-verdict'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { StatusBadge } from '@/components/ui/status-badge'
import { TableSkeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'
import { GenerationsPanel } from '@/components/generations/generations-panel'
import { ProjectSettingsDialog } from '@/components/ProjectSettingsDialog'
import { SourcesPanel } from '@/components/sources/sources-panel'
import { AssetsPanel } from '@/components/assets/assets-panel'
import { DeliveryPanel } from '@/components/deliveries/delivery-panel'
import { StoryboardCard } from '@/components/storyboards/storyboard-card'
import { StoryboardHistory } from '@/components/storyboards/storyboard-history'
import { EpisodeFlow } from '@/components/episode/episode-flow'
import { WorkbenchView } from '@/components/shotboard/workbench/workbench-view'
import { UsagePanel } from '@/components/shotboard/usage-panel'
import {
  EpisodeTabs,
  type EpisodeTab,
} from '@/components/episode/episode-tabs'
import {
  StatusDialog,
  StoryboardDialog,
  type StoryboardDialogState,
} from '@/components/episode/production-dialogs'

/**
 * 深链进来的锚点只有流程页渲染得出来（step-* 是流程区块，shot-* 是流程里的镜头行），
 * 而默认标签跟着剧集阶段走、有分镜时落在总览——从项目页点「交付」等于换了一张不挂载
 * 目标的页。所以先问 URL 要落在哪，再决定落在哪个标签。
 */
function flowAnchorFromHash(): string | null {
  const id = window.location.hash.slice(1)
  return /^(step|shot|block)-/.test(id) ? id : null
}

/**
 * 三个视图是对同一集的不同读法，不是同一页的不同状态：刷新、分享、从项目页回来
 * 都该停在原来那一张。只放在 useState 里等于每进一次就重新猜一遍默认值。
 */
const VIEW_PARAM = 'view'

function readViewParam(value: string | null): EpisodeTab | null {
  return value === 'board' || value === 'flow' || value === 'usage' ? value : null
}

/**
 * The production surface for one episode. Everything on it is scoped to this episode, and
 * the tab strip in the content area — not the sidebar — is what switches reading view.
 */
export default function EpisodePage() {
  return (
    <Suspense fallback={<TableSkeleton rows={4} columns={2} />}>
      <EpisodeWorkspace />
    </Suspense>
  )
}

function EpisodeWorkspace() {
  const { t, locale } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const params = useParams<{ projectId: string; episodeId: string }>()
  const { projectId, episodeId } = params
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // 标签的默认值跟着剧集所处阶段走：还没有分镜时，总览页没有可看的东西，
  // 要办的事（审批原文、生成剧本）都在流程页——整本书拆分后第一次进集必须
  // 直接落在那里，否则「生成分集原文」的产物等于被藏了两层。
  const [flowScrollTarget, setFlowScrollTarget] = useState<string | null>(null)
  const [storyboardDialog, setStoryboardDialog] = useState<StoryboardDialogState>(null)
  const [statusTarget, setStatusTarget] = useState<Storyboard | null>(null)

  const loadEpisodes = useCallback(() => api<Episode[]>(`/projects/${projectId}/episodes`), [api, projectId])
  const episodes = useAsync<Episode[]>(loadEpisodes, [])
  const episode = episodes.data.find(item => item.id === episodeId) ?? null

  // The project's style is set on the project page; the media panel shows it so
  // what a run will look like is visible where the run is triggered.
  const [stylePresetId, setStylePresetId] = useState<string | null>(null)
  const [styleSettingsOpen, setStyleSettingsOpen] = useState(false)
  const loadProjectStyle = useCallback(() => {
    api<Project[]>('/projects')
      .then(list => setStylePresetId(list.find(item => item.id === projectId)?.stylePresetId ?? null))
      .catch(() => setStylePresetId(null))
  }, [api, projectId])
  useEffect(() => {
    loadProjectStyle()
  }, [loadProjectStyle])

  const view: EpisodeTab =
    readViewParam(searchParams.get(VIEW_PARAM)) ??
    (episode && (episode.storyboards?.length ?? 0) === 0 ? 'flow' : 'board')

  const setView = useCallback(
    (next: EpisodeTab) => {
      const query = new URLSearchParams(searchParams.toString())
      query.set(VIEW_PARAM, next)
      // 带上 hash：深链进来的 #step-delivery 若被这次写 view 的 replace 抹掉，
      // 锚点就等于没进来过，落地的是一张收起全部区块的流程页。
      router.replace(`${pathname}?${query.toString()}${window.location.hash}`, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  // 锚点只在进入这一集时消费一次：写 URL 会让 searchParams 换身份，若每次身份变化
  // 都重跑本 effect，就会对同一个 href 无限 replace。
  const anchoredEpisode = useRef<string | null>(null)
  useEffect(() => {
    // 深链进来的锚点只有流程页渲染得出来，所以先认锚点：停在总览等于换了一张
    // 不挂载目标的页。
    if (anchoredEpisode.current === episodeId) return
    anchoredEpisode.current = episodeId
    const target = flowAnchorFromHash()
    setFlowScrollTarget(target)
    if (target && view !== 'flow') setView('flow')
  }, [episodeId, setView, view])

  useEffect(() => {
    if (view !== 'flow' || !flowScrollTarget) return
    // The flow view's panels fetch after mounting, so the shot row can appear a second
    // late; poll briefly instead of giving up on the first miss.
    const deadline = Date.now() + 4000
    const timer = setInterval(() => {
      const el = document.getElementById(flowScrollTarget)
      if (!el) {
        if (Date.now() > deadline) setFlowScrollTarget(null)
        return
      }
      // 上面那些区块是各自拉数据的，第一次对准后它们还在把目标往下推。落在
      // sticky header 让位后的那一带才算到位；到位、页已经滚到底（交付区块是最后一个，
      // 再滚也没有了）、或超时，都停手，不许一直抢滚动。
      const top = el.getBoundingClientRect().top
      const bottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
      const settled = (top > 60 && top < 120) || bottom
      if (!settled) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      if (settled || Date.now() > deadline) setFlowScrollTarget(null)
    }, 250)
    return () => clearInterval(timer)
  }, [view, flowScrollTarget])

  // The enriched endpoint carries each storyboard's generated first frame / video, which
  // the episode embed does not. Refresh it while an episode is open so media shows up
  // as generations complete. Superseded revisions ride along so history is one click
  // away instead of a hand-edited URL.
  const loadStoryboards = useCallback(() => api<Storyboard[]>(storyboardsPath(episodeId, true)), [api, episodeId])
  const storyboardsMedia = useAsync<Storyboard[]>(loadStoryboards, [])
  useEffect(() => {
    const timer = setInterval(storyboardsMedia.reload, 3000)
    return () => clearInterval(timer)
  }, [episodeId, storyboardsMedia.reload])

  // 同一个端点还下发质检线与重试上限:界面自己写死一份,worker 一改阈值就开始说谎。
  const loadStoryboardBatches = useCallback(
    () => api<GenerationsResponse>(`/episodes/${episodeId}/generations`),
    [api, episodeId],
  )
  const storyboardBatches = useAsync<GenerationsResponse>(loadStoryboardBatches, { batches: [], composition: null })
  // 批次数据无条件 3s 轮询:派生自它的"生成中"指示(分镜卡按钮、分镜进度)必须
  // 始终拿到新鲜的任务状态。曾经把轮询条件挂在派生结果非空上——点击重生成后
  // 没有任何东西先刷新数据,派生集永远为空,轮询永远不启动,指示也就永远不亮。
  useEffect(() => {
    storyboardBatches.reload()
    const timer = setInterval(storyboardBatches.reload, 3000)
    return () => clearInterval(timer)
  }, [episodeId, storyboardBatches.reload])

  // One list for the count, the empty state, and the cards. The episode embed is only
  // reloaded on an explicit refresh, so consulting it alone would hide shots the worker
  // wrote after an advance — the polled endpoint wins as soon as it has anything.
  const allStoryboards = useMemo(
    () => (storyboardsMedia.data.length > 0 ? storyboardsMedia.data : (episode?.storyboards ?? [])),
    [storyboardsMedia.data, episode],
  )
  // The same list split by revision: a regenerate supersedes the previous breakdown instead
  // of appending to it, so only live shots may feed the count, the badge, and the stepper.
  const storyboards = useMemo(() => allStoryboards.filter(isLiveStoryboard), [allStoryboards])
  const supersededStoryboards = useMemo(
    () => allStoryboards.filter(storyboard => !isLiveStoryboard(storyboard)),
    [allStoryboards],
  )
  const breakdownGenerating = useMemo(() => {
    const latest = [...storyboardBatches.data.batches]
      .filter(batch => batch.stage === 'STORYBOARD')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    return Boolean(latest && ['QUEUED', 'READY', 'RUNNING'].includes(latest.status))
  }, [storyboardBatches.data])
  // 哪些镜头的媒体任务在跑(`${shotId}:${stage}`):分镜卡的重生成按钮由它保持
  // 转圈/禁用直到出图,而不是只在点击请求的几百毫秒里转一下。
  const generatingShotStages = useMemo(() => {
    const keys = new Set<string>()
    for (const batch of storyboardBatches.data.batches) {
      for (const task of batch.tasks) {
        if (!task.storyboardId) continue
        if (task.status === 'QUEUED' || task.status === 'RUNNING') keys.add(`${task.storyboardId}:${task.stage}`)
      }
    }
    return keys
  }, [storyboardBatches.data])
  // 每镜每阶段的最新一次任务(`${id}:${stage}`):镜头卡的状态点与配音失败原因由它供数,
  // 与媒体面板旧 ClipTable 同源——批次是"产物之外唯一知道任务为什么失败"的地方。
  const shotTaskIndex = useMemo(() => {
    const index = new Map<string, GenerationTask>()
    const batches = [...storyboardBatches.data.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    for (const batch of batches) {
      for (const task of batch.tasks) {
        if (!task.storyboardId) continue
        if (task.stage !== 'IMAGE' && task.stage !== 'VIDEO' && task.stage !== 'AUDIO') continue
        const key = `${task.storyboardId}:${task.stage}`
        const current = index.get(key)
        if (!current || task.createdAt > current.createdAt) index.set(key, task)
      }
    }
    return index
  }, [storyboardBatches.data])
  // 同一批任务按镜号重新聚合:批次那层回答"22:24 那批怎么样了",镜头卡要回答"#3 这一镜怎么样了"。
  const shotEvents = useMemo(
    () => buildShotEvents(storyboardBatches.data.batches, allStoryboards),
    [storyboardBatches.data, allStoryboards],
  )
  const storyboardRevision = useMemo(
    () => storyboards.reduce((highest, storyboard) => Math.max(highest, storyboard.revision ?? 1), 0),
    [storyboards],
  )
  // 镜头区标题下的产物进度:一眼看出还差多少,不必逐卡展开。
  // 分子与镜头行圆点同规则（本阶段最新一次尝试失败就不算产出）;失败数与流程条同规则
  // （一镜只报最靠前的那个问题,不重复计）,否则三个标签页会对同一镜给出相反结论。
  const mediaProgress = useMemo(() => {
    // 配音的分母是「欠人声的镜」，不是「有台词的镜」：有人钦定只用原声，这一镜就不该
    // 再被计入缺件——与流程条、镜头卡同一口径，否则三个标签页会对同一镜给出相反结论。
    const owingVoice = storyboards.filter(shotOwesVoice)
    return {
      frames: storyboards.filter(storyboard => storyboard.firstFrame && !storyboard.firstFrameError).length,
      clips: storyboards.filter(storyboard => storyboard.video && !storyboard.videoError).length,
      voices: owingVoice.filter(storyboard => shotVoiceTrack(storyboard)).length,
      frameFailed: storyboards.filter(storyboard => storyboard.firstFrameError).length,
      clipFailed: storyboards.filter(storyboard => !storyboard.firstFrameError && storyboard.videoError).length,
      speaking: owingVoice.length,
      total: storyboards.length,
    }
  }, [storyboards])
  // Shot numbers are unique per revision, so a hand-added shot continues after every number
  // the episode has ever used rather than colliding with a superseded one.
  const nextStoryboardNumber = useMemo(
    () => allStoryboards.reduce((highest, storyboard) => Math.max(highest, storyboard.number), 0) + 1,
    [allStoryboards],
  )

  const loadEpisodeAssets = useCallback(
    () => api<AssetsResponse>(`/episodes/${episodeId}/assets`),
    [api, episodeId],
  )
  const episodeAssets = useAsync<AssetsResponse>(loadEpisodeAssets, { assets: [] })

  // GenerationsPanel owns its own fetch, so a token bump is the page's handle on it.
  const [generationsToken, setGenerationsToken] = useState(0)
  // 制作台自持轮询，但页面持有的弹窗（新建/编辑/流转/绑定）落库后要让它立刻重读。
  const [boardToken, setBoardToken] = useState(0)
  const bumpBoard = useCallback(() => setBoardToken(value => value + 1), [])
  // 逐镜重生成:操作发生在制作台右栏(用户看产物的地方),结果回写同一屏。
  // 三个阶段同源同入口——首帧/视频/配音都在右栏重做;缺产物走「生成」(只补缺),
  // 有产物走「重跑」(覆盖);调整要求随请求入快照。
  const [regeneratingShot, setRegeneratingShot] = useState<string | null>(null)
  async function regenerateShotMedia(
    storyboardId: string,
    stage: 'IMAGE' | 'FIRST_FRAME' | 'VIDEO' | 'AUDIO',
    note?: string,
    regenerate = false,
  ) {
    const apiStage = stage === 'FIRST_FRAME' ? 'IMAGE' : stage
    setRegeneratingShot(`${storyboardId}:${stage}`)
    try {
      await api(`/episodes/${episodeId}/generations`, {
        method: 'POST',
        body: JSON.stringify({
          stage: apiStage,
          storyboardIds: [storyboardId],
          ...(regenerate ? { regenerate: true } : {}),
          promptNote: note?.trim() || undefined,
        }),
      })
      toast.success(t('generations.shotRegenerated', { stage: translateEnum(t, 'generations.stage', apiStage) }))
      setGenerationsToken(token => token + 1)
      storyboardsMedia.reload()
      // 立即刷新批次数据:分镜卡"生成中"的判定源就是它,不等 3s 轮询。
      storyboardBatches.reload()
      bumpBoard()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setRegeneratingShot(null)
    }
  }
  // 钦定入片版本:与镜头总览的选优门同一个端点,两处裁决必须同一个结果。
  async function pinShotVideo(storyboardId: string, artifactId: string) {
    try {
      await api(`/storyboards/${storyboardId}/video-selection`, { method: 'POST', body: JSON.stringify({ artifactId }) })
      toast.success(t('shotboard.chosenToast'))
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      storyboardsMedia.reload()
      storyboardBatches.reload()
    }
  }
  const refreshAfterAdvance = useCallback(() => {
    episodes.reload()
    storyboardsMedia.reload()
    episodeAssets.reload()
    setGenerationsToken(token => token + 1)
    bumpBoard()
  }, [episodes.reload, storyboardsMedia.reload, episodeAssets.reload, bumpBoard])

  async function bindStoryboardAssets(storyboardId: string, assets: { assetId: string; role: string }[]) {
    try {
      await api(`/storyboards/${storyboardId}/assets`, { method: 'PUT', body: JSON.stringify({ assets }) })
      toast.success(t('storyboards.assetsUpdated'))
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      episodes.reload()
      storyboardsMedia.reload()
      episodeAssets.reload()
      bumpBoard()
    }
  }

  const status = episode ? toWorkflowStatus(episode.status) : null

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold leading-tight tracking-tight">
            {episode ? `${t('projects.episode')} ${episode.number} · ${episode.title}` : t('common.loading')}
          </h1>
          {episode && status && (
            <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <StatusBadge status={status} label={t(`status.${status}`)} className="h-5 px-1.5 text-[11px]" />
              <span>{t('projects.storyboardCount', { count: storyboards.length })}</span>
            </p>
          )}
        </div>
        <EpisodeTabs value={view} onChange={setView} />
      </div>

      {episodes.error && <ErrorState message={episodes.error} onRetry={episodes.reload} />}

      {view === 'board' ? (
        <WorkbenchView
          episodeId={episodeId}
          episodeAssets={episodeAssets.data.assets}
          onOpenShot={shotId => {
            setView('flow')
            setFlowScrollTarget(`shot-${shotId}`)
          }}
          onReviewAssets={() => {
            setView('flow')
            setFlowScrollTarget('step-assets')
          }}
          onOpenFlow={() => setView('flow')}
          onOpenSettings={() => setStyleSettingsOpen(true)}
          onCreateShot={() => setStoryboardDialog({ mode: 'create', nextNumber: nextStoryboardNumber })}
          onChangeStatus={shot => {
            // StatusDialog 只读 id/status/number/title 四个字段，映射即可，不必回表拉全量。
            setStatusTarget(shot as unknown as Storyboard)
          }}
          onBindAssets={bindStoryboardAssets}
          onRegenerate={regenerateShotMedia}
          refreshToken={boardToken}
        />
      ) : view === 'usage' ? (
        <UsagePanel episodeId={episodeId} projectId={projectId} />
      ) : (
        <>
          <EpisodeFlow
            episodeId={episodeId}
            storyboards={storyboards}
            blocks={[
              { id: 'step-source', steps: ['source', 'script'] },
              { id: 'step-assets', steps: ['assets'] },
              { id: 'step-storyboards', steps: ['storyboards'] },
              { id: 'block-media', steps: ['media', 'composition'] },
              { id: 'step-delivery', steps: ['delivery'] },
            ]}
            revealTarget={flowScrollTarget}
            onAdvanced={refreshAfterAdvance}
          >
            <SourcesPanel episodeId={episodeId} projectId={projectId} onScriptApproved={refreshAfterAdvance} />
            <AssetsPanel episodeId={episodeId} projectId={projectId} />
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <ClapperboardIcon className="text-muted-foreground size-4" />
                  {t('storyboards.title')}
                  {storyboards.length > 0 && (
                    <Badge variant="tinted" className="font-normal">
                      {t('storyboards.revision', { revision: storyboardRevision })}
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription>
                  {episode
                    ? `${t('projects.episode')} ${episode.number} · ${episode.title} · ${t('projects.storyboardCount', { count: storyboards.length })}`
                    : t('projects.detailHint')}
                </CardDescription>
                {storyboards.length > 0 && (
                  <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums">
                    <span className={mediaProgress.frameFailed > 0 ? 'text-destructive font-medium' : undefined}>
                      {t('storyboards.firstFrame')} {mediaProgress.frames}/{mediaProgress.total}
                      {mediaProgress.frameFailed > 0 && ` · ${t('generations.status.FAILED')} ${mediaProgress.frameFailed}`}
                    </span>
                    <span className={mediaProgress.clipFailed > 0 ? 'text-destructive font-medium' : undefined}>
                      {t('storyboards.video')} {mediaProgress.clips}/{mediaProgress.total}
                      {mediaProgress.clipFailed > 0 && ` · ${t('generations.status.FAILED')} ${mediaProgress.clipFailed}`}
                    </span>
                    <span>{t('generations.stage.AUDIO')} {mediaProgress.voices}/{mediaProgress.speaking}</span>
                    <span className="text-foreground font-medium">{t('storyboards.boardHint')}</span>
                  </div>
                )}
                <CardAction>
                  <GuardedButton
                    action="storyboard:write"
                    size="sm"
                    variant="outline"
                    onClick={() => setStoryboardDialog({ mode: 'create', nextNumber: nextStoryboardNumber })}
                  >
                    <PlusIcon />
                    {t('storyboards.new')}
                  </GuardedButton>
                </CardAction>
              </CardHeader>

              {episodes.loading && allStoryboards.length === 0 ? (
                <TableSkeleton rows={3} columns={2} />
              ) : allStoryboards.length === 0 ? (
                <CardContent>
                  {breakdownGenerating ? (
                    <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3">
                      <LoaderCircleIcon className="text-primary size-4 shrink-0 animate-spin" />
                      <div>
                        <p className="text-sm font-medium">{t('storyboards.generating')}</p>
                        <p className="text-muted-foreground text-xs">{t('storyboards.generatingHint')}</p>
                      </div>
                    </div>
                  ) : (
                    <EmptyState
                      icon={<ClapperboardIcon />}
                      title={t('storyboards.none')}
                      description={t('storyboards.noneHint')}
                      action={
                        can('storyboard:write') ? (
                          <Button size="sm" onClick={() => setStoryboardDialog({ mode: 'create', nextNumber: 1 })}>
                            <PlusIcon />
                            {t('storyboards.new')}
                          </Button>
                        ) : undefined
                      }
                    />
                  )}
                </CardContent>
              ) : (
                <CardContent className="space-y-4">
                  {storyboards.length === 0 ? (
                    <p className="text-muted-foreground text-sm">{t('storyboards.noLiveShots')}</p>
                  ) : (
                    storyboards.map(storyboard => (
                      <div key={storyboard.id} id={`shot-${storyboard.id}`} className="scroll-mt-20">
                        <StoryboardCard
                          storyboard={storyboard}
                          canWrite={can('storyboard:write')}
                          episodeAssets={episodeAssets.data.assets}
                          onBindAssets={bindStoryboardAssets}
                          onEdit={() => setStoryboardDialog({ mode: 'edit', storyboard })}
                          onChangeStatus={() => setStatusTarget(storyboard)}
                          onRegenerateStage={can('generation:trigger') ? (id, stage) => void regenerateShotMedia(id, stage, undefined, true) : undefined}
                          regeneratingShotStage={regeneratingShot}
                          generatingShotStages={generatingShotStages}
                          shotTasks={shotTaskIndex}
                          events={shotEvents.get(storyboard.number) ?? []}
                          qcThreshold={storyboardBatches.data.limits?.qcThreshold}
                          onPinVideo={artifactId => void pinShotVideo(storyboard.id, artifactId)}
                        />
                      </div>
                    ))
                  )}
                  <StoryboardHistory
                    shots={supersededStoryboards}
                    canWrite={can('storyboard:write')}
                    episodeAssets={episodeAssets.data.assets}
                    onBindAssets={bindStoryboardAssets}
                    shotTasks={shotTaskIndex}
                    onEdit={storyboard => setStoryboardDialog({ mode: 'edit', storyboard })}
                    onChangeStatus={storyboard => setStatusTarget(storyboard)}
                  />
                </CardContent>
              )}
            </Card>
            <GenerationsPanel
              episodeId={episodeId}
              reloadToken={generationsToken}
              storyboards={storyboards}
              stylePresetId={stylePresetId}
              onStyleClick={() => setStyleSettingsOpen(true)}
            />
            <DeliveryPanel episodeId={episodeId} />
          </EpisodeFlow>
        </>
      )}

      <ProjectSettingsDialog
        open={styleSettingsOpen}
        projectId={projectId}
        currentStyleId={stylePresetId}
        onOpenChange={setStyleSettingsOpen}
        onStyleChanged={loadProjectStyle}
      />

      <StoryboardDialog
        state={storyboardDialog}
        episodeId={episodeId}
        onOpenChange={open => !open && setStoryboardDialog(null)}
        onDone={(mode, number) => {
          setStoryboardDialog(null)
          episodes.reload()
          storyboardsMedia.reload()
          bumpBoard()
          toast.success(mode === 'edit' ? t('storyboards.updated') : t('storyboards.created', { number }))
        }}
      />

      <StatusDialog
        storyboard={statusTarget}
        onOpenChange={open => !open && setStatusTarget(null)}
        onDone={next => {
          setStatusTarget(null)
          episodes.reload()
          storyboardsMedia.reload()
          bumpBoard()
          toast.success(t('storyboards.statusChanged', { status: t(`status.${next}`) }))
        }}
      />
    </>
  )
}
