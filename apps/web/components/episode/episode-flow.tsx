'use client'

import { Children, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, LoaderCircleIcon, MoreVerticalIcon, PlayIcon, SparklesIcon } from 'lucide-react'
import { ApiError, isLiveStoryboard, toWorkflowStatus, type EpisodeComposition, type GenerationBatch, type GenerationStage, type Storyboard } from '@/lib/api'
import { translateEnum, type TranslateFn, useI18n } from '@/lib/i18n'
import { shotOwesVoice, shotVoiceTrack } from '@/lib/shot-verdict'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { HelpHint } from '@/components/ui/help-hint'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GuardedButton } from '@/components/permission'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { apiErrorMessage } from '@/lib/api-error'

const STEP_KEYS = ['source', 'script', 'assets', 'storyboards', 'media', 'composition', 'delivery'] as const
export type StepKey = (typeof STEP_KEYS)[number]
type StepStatus = 'done' | 'current' | 'todo'

export interface StageStep {
  key: StepKey
  status: StepStatus
}

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
  /** Referenced assets with no reference image at all: the block is a generation, not a review. */
  assetImagesMissing: number
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
      api<{ assets: Array<{ status: string; usageCount?: number; versions: Array<{ id: string }> }> }>(`/episodes/${episodeId}/assets`),
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
      assetImagesMissing: assets.assets.filter(asset => (asset.usageCount ?? 0) > 0 && asset.versions.length === 0).length,
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
  // 欠人声的镜头按「声音来源」裁决，不按有没有台词：钦定「只用原声」的有台词镜本来
  // 就不出人声，无台词却导入音频的镜反而要等那条音轨落地。
  const needVoice = live.filter(shotOwesVoice)
  const haveVoice = needVoice.filter(storyboard => shotVoiceTrack(storyboard)).length
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
      (needVoice.length > 0 ? haveVoice >= needVoice.length : Boolean(data && (data.musicCompleted || data.compositionCompleted))),
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
    const voiceless = needVoice.filter(storyboard => !shotVoiceTrack(storyboard))
    if (!data.sourceApproved) nextAction = { kind: 'review', anchor: 'source', labelKey: 'stepper.action.reviewSource' }
    else if (!data.scriptApproved) {
      nextAction = data.hasUnapprovedScript
        ? { kind: 'review', anchor: 'script', labelKey: 'stepper.action.reviewScript' }
        : { kind: 'generate', stage: 'SCRIPT', labelKey: 'stepper.action.generateScript' }
    } else if (live.length === 0) nextAction = { kind: 'generate', stage: 'STORYBOARD', labelKey: 'stepper.action.generateStoryboard' }
    else if (data.assetImagesMissing > 0) {
      // 缺图不是缺审批：连参考图都没有，审批无从下手，这一步的唯一出路是去素材区批量生成。
      // 仍是跳转不是发令——每张图都花计费次数，钱的动作留在那块面板上，由人按下。
      nextAction = { kind: 'review', anchor: 'assets', labelKey: 'stepper.action.generateAssetImages', count: data.assetImagesMissing }
    } else if (data.pendingReferencedAssets > 0) {
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
 * The compose gate refuses with a `composition:<what>` code. Those codes carry their own
 * copy in the apiError section of the dictionary, so an unknown one returns null and the
 * user gets the generic "nothing to do" message rather than a raw code as an explanation.
 */
function blockedMessage(error: ApiError, t: TranslateFn): string | null {
  const reasons = Array.isArray(error.body?.reasons) ? error.body.reasons : []
  for (const reason of reasons) {
    if (typeof reason !== 'string' || !reason.startsWith('composition:')) continue
    if (t(reason) !== reason) return t(reason)
  }
  return null
}

interface RunPipelineResponse {
  stage: GenerationStage | 'COMPOSITION'
  batch?: GenerationBatch
  composition?: EpisodeComposition
}

export interface StageBlock {
  /** Anchor id of the wrapper, matching STEP_ANCHOR for the steps it owns. */
  id: string
  /** Steps whose content lives in this block. */
  steps: StepKey[]
}

interface EpisodeFlowProps {
  episodeId: string
  storyboards: Storyboard[]
  /** One entry per panel rendered as a child, in the same order. */
  blocks: StageBlock[]
  /** Set by the board view when a card asks to be shown; reveals the block holding it. */
  revealTarget?: string | null
  /** Lets the workspace refresh the panels it owns once the pipeline has moved forward. */
  onAdvanced?: () => void
  children: ReactNode
}

/**
 * The production surface. One question decides the whole layout: which step is yours
 * right now. Everything before it is signed off and everything after it is not reachable,
 * so both collapse to a line and only the current step's panel stays open — the old page
 * stacked all six panels in one 3053px column and answered nothing about where you were.
 */
export function EpisodeFlow({ episodeId, storyboards, blocks, revealTarget, onAdvanced, children }: EpisodeFlowProps) {
  const { t, locale } = useI18n()
  const { api, can } = useSession()
  const { loading, steps, nextStep, nextAction, unsettled, reload } = useEpisodeProgress(episodeId, storyboards)
  const [advancing, setAdvancing] = useState(false)
  const [runningAction, setRunningAction] = useState(false)
  const [openDone, setOpenDone] = useState(false)
  const [openTodo, setOpenTodo] = useState(false)
  const [openRail, setOpenRail] = useState(false)
  const revealed = useRef<string | null>(null)

  const kids = Children.toArray(children)
  // A child/block mismatch would silently drop panels, so the page falls back to the
  // old always-open stack rather than hiding someone's work.
  const shaped = kids.length === blocks.length

  const currentBlock = useMemo(() => {
    if (!nextStep) return -1
    return blocks.findIndex(block => block.steps.includes(nextStep))
  }, [blocks, nextStep])

  // A block counts as signed off only when its own steps say so. Position relative to the
  // current step is not the same thing: an episode can have its 分镜 done while its source
  // document still waits for approval, and a "后 5 步还没到" line listing those finished
  // steps contradicts the check marks in the rail above it.
  const blockState = useMemo(() => {
    const stepDone = new Map(steps.map(step => [step.key, step.status === 'done']))
    return blocks.map((block, index) =>
      index === currentBlock ? 'current' : block.steps.every(step => stepDone.get(step)) ? 'done' : 'todo',
    ) as ('done' | 'current' | 'todo')[]
  }, [blocks, steps, currentBlock])

  /** Open the group a step lives in, then jump once the panel is in the DOM. */
  function revealStep(key: StepKey) {
    const index = blocks.findIndex(block => block.steps.includes(key))
    if (index >= 0) {
      if (blockState[index] === 'done') setOpenDone(true)
      else if (blockState[index] === 'todo') setOpenTodo(true)
    }
    const anchor = STEP_ANCHOR[key]
    // The panels mount on the next paint, so a single scroll call would target a node
    // that is not there yet.
    window.setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
  }

  // Arriving from the board view ("补素材", a shot row) or from a #hash link means the
  // target may be sitting inside a collapsed group. Expand the group that owns it and
  // leave the scrolling to the page, which polls until the node exists.
  useEffect(() => {
    if (loading) return
    const target = revealTarget || window.location.hash.slice(1)
    if (!target || revealed.current === target) return
    revealed.current = target
    const shotRow = /^shot-/.test(target)
    const index = shotRow
      ? blocks.findIndex(block => block.steps.includes('storyboards'))
      : blocks.findIndex(block => block.id === target || block.steps.some(step => STEP_ANCHOR[step] === target))
    if (index < 0) return
    if (blockState[index] === 'done') setOpenDone(true)
    else if (blockState[index] === 'todo') setOpenTodo(true)
  }, [loading, revealTarget, blockState, blocks])

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
        toast.error(apiErrorMessage(error, t))
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
      revealStep(action.anchor)
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
      toast.error(apiErrorMessage(error, t))
    } finally {
      setRunningAction(false)
    }
  }

  if (!shaped) return <div className="space-y-8">{kids}</div>

  const allIndexes = blocks.map((_, i) => i)
  const doneBlocks = currentBlock < 0 ? allIndexes : allIndexes.filter(index => blockState[index] === 'done')
  const todoBlocks = currentBlock < 0 ? [] : allIndexes.filter(index => blockState[index] === 'todo')
  // One block can own two steps (media + composition share the console table), so the
  // count in the line has to be steps, not blocks — otherwise it reads "后 4 步" above a
  // list of five names.
  const stepCount = (indexes: number[]) => indexes.reduce((sum, index) => sum + blocks[index].steps.length, 0)
  const stepNames = (indexes: number[]) =>
    indexes
      .flatMap(index => blocks[index].steps)
      .map(key => t(`stepper.step.${key}`))
      .join(' / ')

  const rail = <StageRail steps={steps} onJump={revealStep} />

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] lg:items-start">
      <div className="lg:sticky lg:top-20 lg:block">
        {/* Below lg the rail would be a 13rem column of nothing; the step list lives
            inside the turn card there instead. */}
        <div className="hidden lg:block">{rail}</div>
      </div>

      <div className="min-w-0 space-y-4">
        {loading ? (
          <Card>
            <CardContent className="py-4">
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>
        ) : (
          <TurnCard
            steps={steps}
            nextStep={nextStep}
            nextAction={nextAction}
            unsettled={unsettled}
            runningAction={runningAction}
            storyboards={storyboards}
            canTrigger={can('generation:trigger')}
            advancing={advancing}
            openRail={openRail}
            onToggleRail={() => setOpenRail(value => !value)}
            onAdvance={() => void advance()}
            onRunAction={action => void runAction(action)}
            rail={rail}
            actionLabel={actionLabel}
          />
        )}

        {doneBlocks.length > 0 && (
          <GroupLine
            tone="done"
            text={t('stepper.doneGroup', { count: stepCount(doneBlocks), names: stepNames(doneBlocks) })}
            open={openDone || currentBlock < 0}
            onToggle={() => setOpenDone(value => !value)}
          />
        )}
        {(openDone || currentBlock < 0) && doneBlocks.map(index => <div key={blocks[index].id} id={blocks[index].id} className="scroll-mt-20">{kids[index]}</div>)}
        {currentBlock >= 0 && <div id={blocks[currentBlock].id} className="scroll-mt-20">{kids[currentBlock]}</div>}
        {todoBlocks.length > 0 && (
          <GroupLine
            tone="todo"
            text={t('stepper.todoGroup', { count: stepCount(todoBlocks), names: stepNames(todoBlocks) })}
            open={openTodo}
            onToggle={() => setOpenTodo(value => !value)}
          />
        )}
        {openTodo && todoBlocks.map(index => <div key={blocks[index].id} id={blocks[index].id} className="scroll-mt-20">{kids[index]}</div>)}
      </div>
    </div>
  )
}

/** Vertical stage list. No arrows: the same seven steps read as a queue on a phone and
 *  as noise in a column, and the column is the only place this renders. */
function StageRail({ steps, onJump }: { steps: StageStep[]; onJump: (key: StepKey) => void }) {
  const { t } = useI18n()
  return (
    <div>
      <p className="text-faint-foreground mb-1.5 px-2 text-[11px]">{t('stepper.railTitle', { count: steps.length })}</p>
      <ol className="space-y-0.5">
        {steps.map((step, index) => (
          <li key={step.key}>
            <button
              type="button"
              onClick={() => onJump(step.key)}
              aria-current={step.status === 'current' ? 'step' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                step.status === 'current' && 'bg-primary/10 text-primary font-medium',
                step.status === 'done' && 'text-muted-foreground hover:bg-accent/60',
                step.status === 'todo' && 'text-faint-foreground hover:bg-accent/60',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px] tabular-nums',
                  step.status === 'current' ? 'border-primary bg-primary text-primary-foreground' : 'border-border/70',
                )}
              >
                {step.status === 'done' ? <CheckIcon className="size-3" /> : index + 1}
              </span>
              <span className="truncate">{t(`stepper.step.${step.key}`)}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

interface TurnCardProps {
  steps: StageStep[]
  nextStep: StepKey | null
  nextAction: NextAction | null
  unsettled: boolean
  runningAction: boolean
  advancing: boolean
  canTrigger: boolean
  storyboards: Storyboard[]
  openRail: boolean
  onToggleRail: () => void
  onAdvance: () => void
  onRunAction: (action: NextAction) => void
  rail: ReactNode
  actionLabel: (action: NextAction) => string
}

/**
 * The one card that answers "what do I press". It holds the page's only solid primary
 * button, so the six same-colour calls the old column scattered down 3000px collapse
 * into this one — the rest move into the ⋯.
 */
function TurnCard({
  steps,
  nextStep,
  nextAction,
  unsettled,
  runningAction,
  advancing,
  canTrigger,
  storyboards,
  openRail,
  onToggleRail,
  onAdvance,
  onRunAction,
  rail,
  actionLabel,
}: TurnCardProps) {
  const { t } = useI18n()
  const live = storyboards.filter(isLiveStoryboard)
  const statuses = live.map(shot => toWorkflowStatus(shot.status))
  const review = statuses.filter(status => status === 'needs_review').length
  const blocked = statuses.filter(status => status === 'blocked').length

  const parts: string[] = []
  if (live.length > 0) parts.push(t('stepper.countShots', { count: live.length }))
  if (blocked > 0) parts.push(t('stepper.countBlocked', { count: blocked }))
  if (review > 0) parts.push(t('stepper.countReview', { count: review }))
  if (unsettled) parts.push(t('stepper.countRunning'))
  const stepIndex = nextStep ? steps.findIndex(step => step.key === nextStep) + 1 : 0

  return (
    <Card className="border-primary/25">
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-faint-foreground text-[11px]">{t('stepper.turnForYou')}</p>
            <h2 className="mt-0.5 truncate text-base font-semibold">
              {nextStep ? t('stepper.stepOf', { index: stepIndex, step: t(`stepper.step.${nextStep}`) }) : t('stepper.allDone')}
            </h2>
            {nextStep && <p className="text-muted-foreground mt-1 text-sm">{t(`stepper.next.${nextStep}`)}</p>}
            {parts.length > 0 && <p className="text-faint-foreground mt-1 text-xs tabular-nums">{parts.join(' · ')}</p>}
          </div>
          {canTrigger && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t('projects.moreActions')}>
                  <MoreVerticalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={advancing} onClick={onAdvance}>
                  {advancing ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />}
                  {advancing ? t('stepper.advancing') : t('stepper.advance')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {nextAction && (
            nextAction.kind === 'review' ? (
              <Tooltip>
                {/* 实心 = 会推进/会花钱，跳转两样都不是。把它降成描边，否则整张卡唯一
                    一颗实心钮点了却不产出任何东西，用户会以为流水线已经动了。 */}
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" onClick={() => onRunAction(nextAction)}>
                    {actionLabel(nextAction)}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('stepper.jumpHint')}</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                {/* 按钮禁用时自身不响应 hover，提示要挂在外面这层 span 上才弹得出来；
                    挂在原生 title 上等于没说——用户只看到一个按不动的按钮。 */}
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <GuardedButton
                      action="generation:trigger"
                      size="sm"
                      disabled={runningAction || unsettled}
                      onClick={() => onRunAction(nextAction)}
                    >
                      {runningAction ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
                      {runningAction ? t('stepper.actionRunning') : actionLabel(nextAction)}
                    </GuardedButton>
                  </span>
                </TooltipTrigger>
                {unsettled && <TooltipContent>{t('stepper.busyTitle')}</TooltipContent>}
              </Tooltip>
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

        {/* Below lg there is no rail column, so the seven steps fold into a disclosure
            here — a horizontal step bar folded into a sawtooth at 390px. */}
        <div className="lg:hidden">
          <button
            type="button"
            onClick={onToggleRail}
            aria-expanded={openRail}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
          >
            {t('stepper.allSteps', { count: steps.length })}
            {openRail ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
          </button>
          {openRail && <div className="mt-2">{rail}</div>}
        </div>
      </CardContent>
    </Card>
  )
}

/** One line for the steps you are past or not at yet, expandable so nothing is lost. */
function GroupLine({ tone, text, open, onToggle }: { tone: 'done' | 'todo'; text: string; open: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        'flex w-full items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2 text-left text-xs transition-colors',
        tone === 'done' ? 'border-border/60 text-muted-foreground hover:border-success/40' : 'border-border/60 text-faint-foreground hover:border-border',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <span className="text-foreground inline-flex shrink-0 items-center gap-1 font-medium">
        {open ? t('stepper.collapse') : t('stepper.expand')}
        {open ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
      </span>
    </button>
  )
}
