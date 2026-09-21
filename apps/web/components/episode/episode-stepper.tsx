'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowRightIcon, CheckIcon, LoaderCircleIcon, PlayIcon, SparklesIcon } from 'lucide-react'
import { ApiError, isLiveStoryboard, type EpisodeComposition, type GenerationBatch, type GenerationStage, type Storyboard } from '@/lib/api'
import { translateEnum, type TranslateFn, useI18n } from '@/lib/i18n'
import { pipelineGateMessage } from '@/lib/pipeline-errors'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { HelpHint } from '@/components/ui/help-hint'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { GuardedButton } from '@/components/permission'

const STEP_KEYS = ['source', 'script', 'assets', 'storyboards', 'media', 'composition', 'delivery'] as const
type StepKey = (typeof STEP_KEYS)[number]
type StepStatus = 'done' | 'current' | 'todo'

// Where each step's content lives on the page, so clicking a step scrolls to it.
// Source and script share the sources panel. Picture, video and voice are one media
// step because the console shows them in one table — three steps that all jumped to the
// same anchor were a click that did nothing.
const STEP_ANCHOR: Record<StepKey, string> = {
  source: 'step-source',
  script: 'step-source',
  assets: 'step-assets',
  storyboards: 'step-storyboards',
  media: 'step-media',
  composition: 'step-composition',
  delivery: 'step-delivery',
}

interface ProgressData {
  sourceApproved: boolean
  scriptApproved: boolean
  /** Any script draft exists but none is approved: the gate is a human read, not a generation. */
  hasUnapprovedScript: boolean
  /** Referenced assets still in draft — the gate the first-frame stage refuses to run behind. */
  pendingReferencedAssets: number
  hasGeneratedMedia: boolean
  musicCompleted: boolean
  /** A MUSIC batch exists (even failed): a re-run needs `regenerate`, a plain trigger would no-op. */
  musicAttempted: boolean
  compositionCompleted: boolean
  /** 交付是人工签收动作：只有 status=APPROVED 的交付才算过，草稿行只证明生成过一份清单。 */
  deliveryAccepted: boolean
  unsettled: boolean
}

/**
 * 下一步的可执行动作。人工闸门(审批)是跳转——决定权在人;生成类动作携带
 * 缺产物的镜头列表直接触发,已成功的镜头不在列表里,天然不会被重跑。
 */
export type NextAction =
  | { kind: 'review'; anchor: StepKey; labelKey: string; count?: number }
  | { kind: 'generate'; stage: GenerationStage; labelKey: string; count?: number; storyboardIds?: string[]; regenerate?: boolean }
  | { kind: 'compose'; labelKey: string; count?: number }

export function useEpisodeProgress(episodeId: string | null, storyboards: Storyboard[]) {
  const { api } = useSession()

  const load = useCallback(async (): Promise<ProgressData | null> => {
    if (!episodeId) return null
    const [sources, scripts, assets, generations, deliveries] = await Promise.all([
      api<{ versions: Array<{ status: string }> }>(`/episodes/${episodeId}/source-versions`),
      api<{ versions: Array<{ status: string }> }>(`/episodes/${episodeId}/script-versions`),
      api<{ assets: Array<{ status: string; usageCount?: number }> }>(`/episodes/${episodeId}/assets`),
      api<{ batches: Array<{ stage: string; tasks: Array<{ status: string }> }>; composition: { status: string } | null }>(
        `/episodes/${episodeId}/generations`,
      ),
      api<{ deliveries: Array<{ status: string }> }>(`/episodes/${episodeId}/deliveries`),
    ])
    return {
      sourceApproved: sources.versions.some(version => version.status === 'APPROVED'),
      scriptApproved: scripts.versions.some(version => version.status === 'APPROVED'),
      hasUnapprovedScript: scripts.versions.length > 0 && !scripts.versions.some(version => version.status === 'APPROVED'),
      pendingReferencedAssets: assets.assets.filter(asset => (asset.usageCount ?? 0) > 0 && asset.status !== 'APPROVED').length,
      hasGeneratedMedia: generations.batches.some(
        batch => (batch.stage === 'IMAGE' || batch.stage === 'VIDEO') && batch.tasks.some(task => task.status === 'SUCCEEDED'),
      ),
      musicCompleted: generations.batches.some(
        batch => batch.stage === 'MUSIC' && batch.tasks.length > 0 && batch.tasks.every(task => task.status === 'SUCCEEDED'),
      ),
      musicAttempted: generations.batches.some(batch => batch.stage === 'MUSIC'),
      compositionCompleted: generations.composition?.status === 'COMPLETED',
      deliveryAccepted: deliveries.deliveries.some(delivery => delivery.status === 'APPROVED'),
      // Anything still in flight: the worker relays from a finished batch straight
      // into planning the next one, so a task that is queued or running — or a
      // composition being built — means the progress below is not the final word yet.
      unsettled:
        generations.batches.some(batch => batch.tasks.some(task => task.status === 'QUEUED' || task.status === 'RUNNING')) ||
        generations.composition?.status === 'RUNNING',
    }
  }, [api, episodeId])

  const { data, loading, reload } = useAsync<ProgressData | null>(episodeId ? load : null, null)

  // The chain runs unattended, so a stepper that read once would sit on the state it
  // caught at page load while the worker is already two stages ahead. It refreshes on
  // the same cadence as the panels below it and stops when nothing is in flight —
  // including one last read at that moment, which is what catches the next batch the
  // worker plans milliseconds after the previous task landed.
  useEffect(() => {
    if (!episodeId || !data?.unsettled) return
    const timer = setInterval(reload, 3000)
    return () => {
      clearInterval(timer)
      reload()
    }
  }, [episodeId, data?.unsettled, reload])

  const live = storyboards.filter(isLiveStoryboard)
  const speakingShots = live.filter(storyboard => storyboard.dialogue !== '').length
  const voicedShots = live.filter(storyboard => storyboard.dialogue !== '' && storyboard.voice).length
  // 后端按事件序裁决过错误：一次成功会清掉同阶段的旧失败，所以这里非空就等于「最新一次尝试失败」。
  // 首帧失败的镜头不再单独算视频失败——一次只报最靠前的那个数，与总览缺口队列同一优先级。
  const frameFailed = live.filter(storyboard => Boolean(storyboard.firstFrameError))
  const clipFailed = live.filter(storyboard => !storyboard.firstFrameError && Boolean(storyboard.videoError))

  const done: Record<StepKey, boolean> = {
    source: data?.sourceApproved ?? false,
    script: data?.scriptApproved ?? false,
    // 与首帧阶段的素材门禁同一语义:被镜头引用的素材全部定稿,这一步才算过。
    assets: (data?.pendingReferencedAssets ?? 0) === 0,
    storyboards: live.length > 0,
    // A shot is not finished until both its picture and its voice exist, so the two
    // stages the media table shows are settled together. A shot list with no lines
    // owes no voice and only becomes handled once the score ran or a master exists,
    // because a composed silent episode is the chain declining sound on purpose.
    media:
      Boolean(data?.hasGeneratedMedia) &&
      frameFailed.length === 0 &&
      clipFailed.length === 0 &&
      (speakingShots > 0 ? voicedShots >= speakingShots : Boolean(data && (data.musicCompleted || data.compositionCompleted))),
    composition: data?.compositionCompleted ?? false,
    delivery: data?.deliveryAccepted ?? false,
  }
  const firstIncomplete = STEP_KEYS.find(key => !done[key]) ?? null
  const steps = STEP_KEYS.map(key => ({
    key,
    status: (done[key] ? 'done' : key === firstIncomplete ? 'current' : 'todo') as StepStatus,
  }))

  // 下一步的具体动作:与 done 的判定同源,但精确到"这一个动作"——
  // media 一步内部再按 帧→片→音→乐 的顺序拆,卡在哪就给哪个动作。
  let nextAction: NextAction | null = null
  if (data) {
    const frameless = live.filter(storyboard => !storyboard.firstFrame)
    const clipless = live.filter(storyboard => storyboard.firstFrame && !storyboard.video)
    const voiceless = live.filter(storyboard => storyboard.dialogue !== '' && !storyboard.voice)
    if (!data.sourceApproved) nextAction = { kind: 'review', anchor: 'source', labelKey: 'stepper.action.reviewSource' }
    else if (!data.scriptApproved) {
      nextAction = data.hasUnapprovedScript
        ? { kind: 'review', anchor: 'script', labelKey: 'stepper.action.reviewScript' }
        : { kind: 'generate', stage: 'SCRIPT', labelKey: 'stepper.action.generateScript' }
    } else if (live.length === 0) nextAction = { kind: 'generate', stage: 'STORYBOARD', labelKey: 'stepper.action.generateStoryboard' }
    else if (data.pendingReferencedAssets > 0) {
      nextAction = { kind: 'review', anchor: 'assets', labelKey: 'stepper.action.reviewAssets', count: data.pendingReferencedAssets }
    } else if (frameFailed.length > 0) {
      // 坏掉的排在缺的前面：有画面但最新一次重生成失败的镜头，缺帧列表看不见它。
      // 这是跳转不是发令——重试要花钱，钱的动作留在镜头自己的重跑按钮上，由人决定。
      nextAction = { kind: 'review', anchor: 'media', labelKey: 'stepper.action.retryFrames', count: frameFailed.length }
    } else if (clipFailed.length > 0) {
      nextAction = { kind: 'review', anchor: 'media', labelKey: 'stepper.action.retryClips', count: clipFailed.length }
    } else if (frameless.length > 0) {
      nextAction = { kind: 'generate', stage: 'IMAGE', labelKey: 'stepper.action.generateFrames', count: frameless.length, storyboardIds: frameless.map(storyboard => storyboard.id) }
    } else if (clipless.length > 0) {
      // 只带"有帧缺片"的镜头:缺帧的镜头先回上一步补帧,而不是让整个视频阶段被门禁拦死。
      nextAction = { kind: 'generate', stage: 'VIDEO', labelKey: 'stepper.action.generateClips', count: clipless.length, storyboardIds: clipless.map(storyboard => storyboard.id) }
    } else if (voiceless.length > 0) {
      nextAction = { kind: 'generate', stage: 'AUDIO', labelKey: 'stepper.action.generateVoices', count: voiceless.length, storyboardIds: voiceless.map(storyboard => storyboard.id) }
    } else if (!data.musicCompleted) {
      nextAction = { kind: 'generate', stage: 'MUSIC', labelKey: 'stepper.action.generateMusic', regenerate: data.musicAttempted }
    } else if (!data.compositionCompleted) {
      nextAction = { kind: 'compose', labelKey: 'stepper.action.compose' }
    }
  }

  return { loading, steps, nextStep: firstIncomplete, nextAction, unsettled: data?.unsettled ?? false, reload }
}

/**
 * The compose gate refuses with a `composition:<what>` code. Only a code we wrote copy
 * for becomes a sentence; an unknown one returns null, so the user gets the generic
 * "nothing to do" message rather than a raw code presented as an explanation.
 */
function blockedMessage(error: ApiError, t: TranslateFn): string | null {
  const reasons = Array.isArray(error.body?.reasons) ? error.body.reasons : []
  for (const reason of reasons) {
    if (typeof reason !== 'string' || !reason.startsWith('composition:')) continue
    const key = `stepper.blocked.${reason.slice('composition:'.length)}`
    if (t(key) !== key) return t(key)
  }
  return null
}

interface RunPipelineResponse {
  stage: GenerationStage | 'COMPOSITION'
  batch?: GenerationBatch
  composition?: EpisodeComposition
}

interface EpisodeStepperProps {
  episodeId: string
  /** Live shots with their media, so the next action can name exactly what is missing. */
  storyboards: Storyboard[]
  /** Lets the workspace refresh the panels it owns once the pipeline has moved forward. */
  onAdvanced?(): void
}

export function EpisodeStepper({ episodeId, storyboards, onAdvanced }: EpisodeStepperProps) {
  const { t, locale } = useI18n()
  const { api } = useSession()
  const { loading, steps, nextStep, nextAction, unsettled, reload } = useEpisodeProgress(episodeId, storyboards)
  const [advancing, setAdvancing] = useState(false)
  const [runningAction, setRunningAction] = useState(false)

  async function advance() {
    setAdvancing(true)
    try {
      const result = await api<RunPipelineResponse>(`/episodes/${episodeId}/run-pipeline`, { method: 'POST' })
      toast.success(t('stepper.advanced', { stage: translateEnum(t, 'generations.stage', result.stage) }))
      reload()
      onAdvanced?.()
    } catch (error) {
      // Nothing runnable is a normal state, but the gate also says when the real reason
      // is a shot still missing its clip or its voice — that is not "up to date".
      if (error instanceof ApiError && error.message === 'pipeline:nothingRunnable') {
        toast.message(blockedMessage(error, t) ?? t('stepper.advanceUpToDate'))
      } else {
        toast.error(pipelineGateMessage(error, t, locale) ?? (error instanceof Error ? error.message : t('error.generic')))
      }
    } finally {
      setAdvancing(false)
    }
  }

  function actionLabel(action: NextAction): string {
    return t(action.labelKey, action.count !== undefined ? { count: action.count } : undefined)
  }

  // 下一步的执行体:审批类只做页面跳转(决定权在人),生成/合成类直接调后端。
  async function runAction(action: NextAction) {
    if (action.kind === 'review') {
      document.getElementById(STEP_ANCHOR[action.anchor])?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    setRunningAction(true)
    try {
      if (action.kind === 'compose') {
        await api<RunPipelineResponse>(`/episodes/${episodeId}/run-pipeline`, { method: 'POST' })
        toast.success(t('stepper.composed'))
      } else {
        await api(`/episodes/${episodeId}/generations`, {
          method: 'POST',
          body: JSON.stringify({
            stage: action.stage,
            ...(action.storyboardIds ? { storyboardIds: action.storyboardIds } : {}),
            ...(action.regenerate ? { regenerate: true } : {}),
          }),
        })
        toast.success(t('stepper.actionQueued'))
      }
      reload()
      onAdvanced?.()
    } catch (error) {
      toast.error(pipelineGateMessage(error, t, locale) ?? (error instanceof Error ? error.message : t('error.generic')))
    } finally {
      setRunningAction(false)
    }
  }

  function scrollTo(key: StepKey) {
    document.getElementById(STEP_ANCHOR[key])?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <Card>
      <CardContent className="py-4 2xl:py-3">
        <div className="flex flex-wrap items-start justify-between gap-4 2xl:block">
          <div className="min-w-0 flex-1">
            {loading ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <>
                <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2 2xl:flex-col 2xl:items-stretch 2xl:gap-0">
                  {steps.map((step, index) => (
                    <li key={step.key} className="flex items-center gap-x-1.5 2xl:block">
                      {index > 0 && <ArrowRightIcon className="text-muted-foreground/40 size-3.5 shrink-0 2xl:hidden" />}
                      <button
                        type="button"
                        onClick={() => scrollTo(step.key)}
                        className={cn(
                          'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors 2xl:w-full 2xl:justify-start',
                          step.status === 'done' && 'border-transparent bg-primary/10 text-primary',
                          step.status === 'current' && 'border-primary/40 bg-primary/5 font-medium',
                          step.status === 'todo' && 'text-muted-foreground border-transparent',
                        )}
                      >
                        {step.status === 'done' ? (
                          <CheckIcon className="size-3.5" />
                        ) : step.status === 'current' ? (
                          <span className="bg-primary size-1.5 rounded-full" />
                        ) : (
                          <span className="bg-muted-foreground/40 size-1.5 rounded-full" />
                        )}
                        {t(`stepper.step.${step.key}`)}
                      </button>
                      {index < steps.length - 1 && <span aria-hidden className="bg-border ml-[17px] hidden h-2.5 w-px 2xl:block" />}
                    </li>
                  ))}
                </ol>
                <div className="mt-3 flex flex-wrap items-center gap-2 2xl:border-border 2xl:border-t 2xl:pt-3">
                  {nextStep && (
                    <p className="text-muted-foreground text-sm">
                      {t('stepper.nextLabel')}
                      <span className="text-foreground font-medium">{t(`stepper.next.${nextStep}`)}</span>
                    </p>
                  )}
                  {nextAction && (
                    nextAction.kind === 'review' ? (
                      <Button variant="outline" size="sm" onClick={() => void runAction(nextAction)}>
                        {actionLabel(nextAction)}
                        <ArrowRightIcon />
                      </Button>
                    ) : (
                      <GuardedButton
                        action="generation:trigger"
                        variant="outline"
                        size="sm"
                        disabled={runningAction || unsettled}
                        title={unsettled ? t('stepper.busyTitle') : undefined}
                        onClick={() => void runAction(nextAction)}
                      >
                        {runningAction ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
                        {runningAction ? t('stepper.actionRunning') : actionLabel(nextAction)}
                      </GuardedButton>
                    )
                  )}
                  {unsettled && (
                    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                      <LoaderCircleIcon className="size-3.5 animate-spin" />
                      {t('stepper.unsettled')}
                    </span>
                  )}
                  <HelpHint text={t('stepper.advanceHint')} />
                </div>
              </>
            )}
          </div>
          <GuardedButton
            action="generation:trigger"
            className="2xl:mt-3 2xl:w-full"
            disabled={advancing}
            onClick={() => void advance()}
          >
            {advancing ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />}
            {advancing ? t('stepper.advancing') : t('stepper.advance')}
          </GuardedButton>
        </div>
      </CardContent>
    </Card>
  )
}
