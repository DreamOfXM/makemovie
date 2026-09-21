'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { toast } from 'sonner'
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
  type GenerationBatch,
  type GenerationTask,
  type Storyboard,
} from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { pipelineGateMessage } from '@/lib/pipeline-errors'
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
import { SourcesPanel } from '@/components/sources/sources-panel'
import { AssetsPanel } from '@/components/assets/assets-panel'
import { DeliveryPanel } from '@/components/deliveries/delivery-panel'
import { StoryboardCard } from '@/components/storyboards/storyboard-card'
import { StoryboardHistory } from '@/components/storyboards/storyboard-history'
import { EpisodeStepper } from '@/components/episode/episode-stepper'
import { ShotboardView } from '@/components/shotboard/shotboard-view'
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
 * The production surface for one episode. Everything on it is scoped to this episode, and
 * the tab strip in the content area — not the sidebar — is what switches reading view.
 */
export default function EpisodePage() {
  const { t, locale } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const params = useParams<{ projectId: string; episodeId: string }>()
  const { projectId, episodeId } = params

  const [view, setView] = useState<EpisodeTab>('board')
  const [flowScrollTarget, setFlowScrollTarget] = useState<string | null>(null)
  const [storyboardDialog, setStoryboardDialog] = useState<StoryboardDialogState>(null)
  const [statusTarget, setStatusTarget] = useState<Storyboard | null>(null)

  const loadEpisodes = useCallback(() => api<Episode[]>(`/projects/${projectId}/episodes`), [api, projectId])
  const episodes = useAsync<Episode[]>(loadEpisodes, [])
  const episode = episodes.data.find(item => item.id === episodeId) ?? null

  useEffect(() => {
    setView('board')
    setFlowScrollTarget(null)
  }, [episodeId])

  useEffect(() => {
    if (view !== 'flow' || !flowScrollTarget) return
    // The flow view's panels fetch after mounting, so the shot row can appear a second
    // late; poll briefly instead of giving up on the first miss.
    const deadline = Date.now() + 4000
    const timer = setInterval(() => {
      const el = document.getElementById(flowScrollTarget)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        setFlowScrollTarget(null)
      } else if (Date.now() > deadline) {
        setFlowScrollTarget(null)
      }
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

  const loadStoryboardBatches = useCallback(
    () => api<{ batches: GenerationBatch[] }>(`/episodes/${episodeId}/generations`).then(result => result.batches),
    [api, episodeId],
  )
  const storyboardBatches = useAsync<GenerationBatch[]>(loadStoryboardBatches, [])
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
    const latest = [...storyboardBatches.data]
      .filter(batch => batch.stage === 'STORYBOARD')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    return Boolean(latest && ['QUEUED', 'READY', 'RUNNING'].includes(latest.status))
  }, [storyboardBatches.data])
  // 哪些镜头的媒体任务在跑(`${shotId}:${stage}`):分镜卡的重生成按钮由它保持
  // 转圈/禁用直到出图,而不是只在点击请求的几百毫秒里转一下。
  const generatingShotStages = useMemo(() => {
    const keys = new Set<string>()
    for (const batch of storyboardBatches.data) {
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
    const batches = [...storyboardBatches.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
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
  const storyboardRevision = useMemo(
    () => storyboards.reduce((highest, storyboard) => Math.max(highest, storyboard.revision ?? 1), 0),
    [storyboards],
  )
  // 镜头区标题下的产物进度:一眼看出还差多少,不必逐卡展开。
  // 分子与镜头行圆点同规则（本阶段最新一次尝试失败就不算产出）;失败数与流程条同规则
  // （一镜只报最靠前的那个问题,不重复计）,否则三个标签页会对同一镜给出相反结论。
  const mediaProgress = useMemo(() => {
    const speaking = storyboards.filter(storyboard => storyboard.dialogue.trim() !== '')
    return {
      frames: storyboards.filter(storyboard => storyboard.firstFrame && !storyboard.firstFrameError).length,
      clips: storyboards.filter(storyboard => storyboard.video && !storyboard.videoError).length,
      voices: speaking.filter(storyboard => storyboard.voice).length,
      frameFailed: storyboards.filter(storyboard => storyboard.firstFrameError).length,
      clipFailed: storyboards.filter(storyboard => !storyboard.firstFrameError && storyboard.videoError).length,
      speaking: speaking.length,
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
  // 逐镜重生成:操作发生在分镜卡片上(用户看镜头的地方),结果回写同卡片。
  // 三个阶段同源同入口——首帧/视频/配音都在镜头卡里重做,不再分处两处。
  const [regeneratingShot, setRegeneratingShot] = useState<string | null>(null)
  async function regenerateShotMedia(storyboardId: string, stage: 'IMAGE' | 'VIDEO' | 'AUDIO') {
    setRegeneratingShot(`${storyboardId}:${stage}`)
    try {
      await api(`/episodes/${episodeId}/generations`, {
        method: 'POST',
        body: JSON.stringify({ stage, storyboardIds: [storyboardId], regenerate: true }),
      })
      toast.success(t('generations.shotRegenerated', { stage: translateEnum(t, 'generations.stage', stage) }))
      setGenerationsToken(token => token + 1)
      storyboardsMedia.reload()
      // 立即刷新批次数据:分镜卡"生成中"的判定源就是它,不等 3s 轮询。
      storyboardBatches.reload()
    } catch (error) {
      toast.error(pipelineGateMessage(error, t, locale) ?? (error instanceof Error ? error.message : 'error.generic'))
    } finally {
      setRegeneratingShot(null)
    }
  }
  const refreshAfterAdvance = useCallback(() => {
    episodes.reload()
    storyboardsMedia.reload()
    episodeAssets.reload()
    setGenerationsToken(token => token + 1)
  }, [episodes.reload, storyboardsMedia.reload, episodeAssets.reload])

  async function bindStoryboardAssets(storyboardId: string, assets: { assetId: string; role: string }[]) {
    try {
      await api(`/storyboards/${storyboardId}/assets`, { method: 'PUT', body: JSON.stringify({ assets }) })
      toast.success(t('storyboards.assetsUpdated'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      episodes.reload()
      storyboardsMedia.reload()
      episodeAssets.reload()
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
        <ShotboardView
          episodeId={episodeId}
          onOpenShot={shotId => {
            setView('flow')
            setFlowScrollTarget(`shot-${shotId}`)
          }}
          onReviewAssets={() => {
            setView('flow')
            setFlowScrollTarget('step-assets')
          }}
        />
      ) : view === 'usage' ? (
        <UsagePanel episodeId={episodeId} projectId={projectId} allowEpisodeSwitch />
      ) : (
        <div className="grid gap-8 2xl:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] 2xl:items-start">
          <div className="2xl:sticky 2xl:top-20">
            <EpisodeStepper episodeId={episodeId} storyboards={storyboards} onAdvanced={refreshAfterAdvance} />
          </div>
          <div className="min-w-0 space-y-8">
            <div id="step-source" className="scroll-mt-20">
              <SourcesPanel episodeId={episodeId} onScriptApproved={refreshAfterAdvance} />
            </div>
            <div id="step-assets" className="scroll-mt-20">
              <AssetsPanel episodeId={episodeId} projectId={projectId} />
            </div>
            <div id="step-storyboards" className="scroll-mt-20">
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
                            onRegenerateStage={can('generation:trigger') ? regenerateShotMedia : undefined}
                            regeneratingShotStage={regeneratingShot}
                            generatingShotStages={generatingShotStages}
                            shotTasks={shotTaskIndex}
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
            </div>

            <GenerationsPanel episodeId={episodeId} reloadToken={generationsToken} storyboards={storyboards} />
            <div id="step-delivery" className="scroll-mt-20">
              <DeliveryPanel episodeId={episodeId} />
            </div>
          </div>
        </div>
      )}

      <StoryboardDialog
        state={storyboardDialog}
        episodeId={episodeId}
        onOpenChange={open => !open && setStoryboardDialog(null)}
        onDone={(mode, number) => {
          setStoryboardDialog(null)
          episodes.reload()
          storyboardsMedia.reload()
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
          toast.success(t('storyboards.statusChanged', { status: t(`status.${next}`) }))
        }}
      />
    </>
  )
}
