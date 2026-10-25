'use client'

import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, LoaderCircleIcon, MoreVerticalIcon, PlayIcon, SparklesIcon } from 'lucide-react'
import { ApiError, isLiveStoryboard, toWorkflowStatus, type EpisodeComposition, type GenerationBatch, type GenerationPlan, type GenerationStage, type ShotDurationDecision, type Storyboard } from '@/lib/api'
import { translateEnum, type TranslateFn, useI18n } from '@/lib/i18n'
import { FAILURE_CAUSE_KEY } from '@/lib/failure-cause'
import { classifyFailure } from '@studio/domain'
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
import { PlanDialog } from '@/components/generations/plan-dialog'
import { apiErrorMessage } from '@/lib/api-error'

// storyboards 排在 assets 前面不是排版选择，而是门禁本身（SD-022）：
// PIPELINE_STAGES 里 STORYBOARD 先于 ASSET，分镜没被逐镜读完并整批批准之前，
// 素材阶段不该「轮到你」。firstIncomplete 按本数组顺序扫描，顺序即流程真相。
const STEP_KEYS = ['source', 'script', 'storyboards', 'assets', 'media', 'composition', 'delivery'] as const
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
  /** 最近一次 STORYBOARD 批次（端点按新→旧返回，取第一条即可）：SD-020 的失败信号
   *  就藏在这里——rollUpBatchStatus 把任何 FAILED/BLOCKED 任务归成 BLOCKED 批次。 */
  storyboardBatch: { status: string; error: string | null } | null
  unsettled: boolean
}

/** 活体镜头里还没被人工整批批准的那些（status≠APPROVED）。批准走
 *  POST /episodes/:id/storyboard-status——审批是签收，不借道逐镜状态机。 */
export function shotsAwaitingApproval(live: Storyboard[]): Storyboard[] {
  return live.filter(storyboard => toWorkflowStatus(storyboard.status) !== 'approved')
}

/**
 * SD-020：最近一次分镜批次是不是「最新一次尝试失败了」。批次由
 * rollUpBatchStatus 归位，FAILED/BLOCKED 任务都会把整批顶成 BLOCKED；
 * FAILED 一并认，防旧数据。COMPLETED / RUNNING / NEEDS_REVIEW 都不算失败——
 * 在途批次由 unsettled 说话，部分取消不是「分镜生成不出来」。
 */
export function storyboardBatchFailure(batch: { status: string; error: string | null } | null): { error: string | null } | null {
  if (!batch) return null
  if (batch.status !== 'BLOCKED' && batch.status !== 'FAILED') return null
  return { error: batch.error }
}

/** 分镜批次失败的人话（SD-020）。认得出因的按因说（复用全站 failure.cause.*），
 *  认不出退回一句通用文案——原始报文只进 Tooltip，绝不上屏当正文。 */
export function storyboardFailureCopy(t: TranslateFn, raw: string | null): string {
  const causeKey = FAILURE_CAUSE_KEY[classifyFailure(raw)]
  return causeKey ? t(causeKey) : t('stepper.storyboardBatchFailed.fallback')
}

/**
 * 下一步的可执行动作。人工闸门(审批)是跳转——决定权在人;生成类动作携带
 * 缺产物的镜头列表直接触发,已成功的镜头不在列表里,天然不会被重跑。
 */
export type NextAction =
  | { kind: 'review'; anchor: StepKey; labelKey: string; count?: number }
  | { kind: 'generate'; stage: GenerationStage; labelKey: string; count?: number; storyboardIds?: string[]; regenerate?: boolean }
  | { kind: 'compose'; labelKey: string; count?: number }

/**
 * 能排给平台的镜头：只有分镜表里标为「视频」的镜头走模型生成。字卡 / 录屏 /
 * 合成 / UI 是人在剪辑里做的，混进来会让整批 POST 被后端拒绝，计数也会虚高。
 */
export function mediaQueue(storyboards: Storyboard[]) {
  const generatable = storyboards.filter(storyboard => storyboard.production === 'video')
  return {
    frameless: generatable.filter(storyboard => !storyboard.firstFrame),
    clipless: generatable.filter(storyboard => storyboard.firstFrame && !storyboard.video),
  }
}

export function useEpisodeProgress(episodeId: string | null, storyboards: Storyboard[]) {
  const { api } = useSession()

  const load = useCallback(async (): Promise<ProgressData | null> => {
    if (!episodeId) return null
    const [sources, scripts, assets, generations, deliveries] = await Promise.all([
      api<{ versions: Array<{ status: string }> }>(`/episodes/${episodeId}/source-versions`),
      api<{ versions: Array<{ status: string }> }>(`/episodes/${episodeId}/script-versions`),
      api<{ assets: Array<{ status: string; usageCount?: number; versions: Array<{ id: string }> }> }>(`/episodes/${episodeId}/assets`),
      api<{
        batches: Array<{ stage: string; status: string; tasks: Array<{ status: string; error: string | null }> }>
        composition: { status: string } | null
      }>(`/episodes/${episodeId}/generations`),
      api<{ deliveries: Array<{ status: string }> }>(`/episodes/${episodeId}/deliveries`),
    ])
    // 端点按 id 降序返回全部批次（cuid 即时间序），第一条 STORYBOARD 就是最近一次分镜尝试。
    // 失败原因取批次内第一条 FAILED/BLOCKED 任务的 error——批次状态已把这一步
    // 定性为「等人」，这里只负责把「等人来修什么」的那句话带出来。
    const [storyboardBatch] = generations.batches.filter(batch => batch.stage === 'STORYBOARD')
    const failedTask = storyboardBatch?.tasks.find(task => task.status === 'FAILED' || task.status === 'BLOCKED')
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
      storyboardBatch: storyboardBatch ? { status: storyboardBatch.status, error: failedTask?.error ?? null } : null,
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
  // SD-022：分镜这一步的「完成」不是「有行」，是「每一行都被读过并整批批准」。
  // 63 行全 DRAFT 却直通素材阶段，等于流水线替人签了字。
  const pendingApproval = shotsAwaitingApproval(live)
  // SD-020：最近一次分镜批次失败——旧版镜头还在那儿，但新剧本的分镜没生成出来，
  // 这一步不能安静地读成「已完成」。
  const batchFailure = storyboardBatchFailure(data?.storyboardBatch ?? null)

  const done: Record<StepKey, boolean> = {
    source: data?.sourceApproved ?? false,
    script: data?.scriptApproved ?? false,
    // 与首帧阶段的素材门禁同一语义:被镜头引用的素材全部定稿,这一步才算过。
    assets: (data?.pendingReferencedAssets ?? 0) === 0,
    storyboards: live.length > 0 && pendingApproval.length === 0 && batchFailure === null,
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
    const { frameless, clipless } = mediaQueue(live)
    const voiceless = needVoice.filter(storyboard => !shotVoiceTrack(storyboard))
    if (!data.sourceApproved) nextAction = { kind: 'review', anchor: 'source', labelKey: 'stepper.action.reviewSource' }
    else if (!data.scriptApproved) {
      nextAction = data.hasUnapprovedScript
        ? { kind: 'review', anchor: 'script', labelKey: 'stepper.action.reviewScript' }
        : { kind: 'generate', stage: 'SCRIPT', labelKey: 'stepper.action.generateScript' }
    } else if (live.length === 0) nextAction = { kind: 'generate', stage: 'STORYBOARD', labelKey: 'stepper.action.generateStoryboard' }
    else if (pendingApproval.length > 0) {
      // 整批批准是人工签收：跳转去分镜卡区的「全部通过」，不是发令——批准不花钱，
      // 但决定权必须在读完镜头的人手里（SD-022）。
      nextAction = { kind: 'review', anchor: 'storyboards', labelKey: 'stepper.action.reviewStoryboards', count: pendingApproval.length }
    } else if (batchFailure !== null) {
      // 失败重试要花钱（重出一版整集分镜），所以这里也只是跳转，把那一下按下留给
      // 分镜卡上「重新分镜」的确认弹窗（SD-020）。
      nextAction = { kind: 'review', anchor: 'storyboards', labelKey: 'stepper.action.retryStoryboard' }
    } else if (data.assetImagesMissing > 0) {
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

  return {
    loading,
    steps,
    nextStep: firstIncomplete,
    nextAction,
    unsettled: data?.unsettled ?? false,
    pendingApproval: pendingApproval.length,
    batchFailure,
    reload,
  }
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
  /** Steps whose content lives in this block. Empty means the block is a fixed
   *  slot in the flow (the quality queue) that the folding math must not govern. */
  steps: StepKey[]
}

/**
 * The block id a panel declared on its own wrapper element:
 * `<div data-flow-step="step-source"><SourcesPanel/></div>`. Reading it off the
 * React element works for host wrappers regardless of what the panel inside does
 * with its own props — the attribute only needs to reach EpisodeFlow, not the DOM.
 */
function declaredFlowStep(child: ReactNode): { id: string; element: ReactElement } | null {
  if (!isValidElement(child)) return null
  const id = (child.props as Record<string, unknown>)['data-flow-step']
  return typeof id === 'string' && id.length > 0 ? { id, element: child } : null
}

interface EpisodeFlowProps {
  episodeId: string
  storyboards: Storyboard[]
  /** The step blocks of the flow. Each block's panel is the child that declares
   *  `data-flow-step="<block.id>"` on its wrapper; children without the attribute
   *  are non-step panels rendered below the flow, outside the folding math. */
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
  const { loading, steps, nextStep, nextAction, unsettled, pendingApproval, batchFailure, reload } = useEpisodeProgress(episodeId, storyboards)
  const [advancing, setAdvancing] = useState(false)
  const [runningAction, setRunningAction] = useState(false)
  const [openDone, setOpenDone] = useState(false)
  const [openTodo, setOpenTodo] = useState(false)
  const [openRail, setOpenRail] = useState(false)
  const revealed = useRef<string | null>(null)

  const kids = Children.toArray(children)
  // Blocks and panels associate by the declared id, never by array position. The
  // old `kids.length === blocks.length` check meant adding one non-step panel (the
  // timeline editor) flipped the whole flow back to the always-open stack — the
  // stepper, the next action and the folding all vanished (UX-05). Now: a child
  // whose id matches a block mounts into that block; a child without an id is a
  // non-step panel rendered below the flow; a block with no panel shows a readable
  // placeholder instead of silently disappearing. Mismatches warn in dev.
  const declared = new Map<string, ReactElement>()
  const nonStep: ReactNode[] = []
  const blockIds = new Set(blocks.map(block => block.id))
  for (const child of kids) {
    const step = declaredFlowStep(child)
    if (step === null) {
      nonStep.push(child)
      continue
    }
    const { id, element } = step
    if (!blockIds.has(id)) {
      console.warn(`[episode-flow] data-flow-step="${id}" matches no block; that panel renders below the flow instead.`)
      nonStep.push(child)
      continue
    }
    if (declared.has(id)) {
      console.warn(`[episode-flow] duplicate data-flow-step="${id}"; keeping the first panel, the extra renders below the flow.`)
      nonStep.push(child)
      continue
    }
    declared.set(id, element)
  }
  const missingPanels = blocks.filter(block => !declared.has(block.id))
  if (missingPanels.length > 0) {
    console.warn(`[episode-flow] no panel declared data-flow-step for: ${missingPanels.map(block => block.id).join(', ')}.`)
  }

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
    // A block with no steps is always rendered — there is nothing to expand for it.
    if (index >= 0 && blocks[index].steps.length > 0) {
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
    // Step-less blocks render unconditionally, so a reveal target inside one is
    // already visible — expanding the done group for it would be noise.
    if (blocks[index].steps.length === 0) return
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

  // 下一步执行体的门面前置:生成类动作先取计划、弹预审,确认才 POST。
  // 计划端点与触发端点是同一套门禁,所以确认框里承诺的数目与实际发生的不会分叉。
  const [pendingPlan, setPendingPlan] = useState<{ action: Extract<NextAction, { kind: 'generate' }>; plan: GenerationPlan } | null>(null)

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
        const query = new URLSearchParams({ stage: action.stage, regenerate: action.regenerate ? '1' : '0' })
        if (action.storyboardIds) query.set('storyboardIds', action.storyboardIds.join(','))
        const { plan } = await api<{ plan: GenerationPlan }>(`/episodes/${episodeId}/generation-plan?${query.toString()}`)
        if (plan.newCount + plan.retryCount === 0 && plan.localCount === 0) {
          toast.message(t('generations.planNothingToDo'))
        } else {
          setPendingPlan({ action, plan })
        }
      }
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setRunningAction(false)
    }
  }

  async function confirmPlan(acceptDurationGap: boolean, durationDecisions: ShotDurationDecision[]) {
    if (!pendingPlan) return
    const { action } = pendingPlan
    setPendingPlan(null)
    setRunningAction(true)
    try {
      await api(`/episodes/${episodeId}/generations`, {
        method: 'POST',
        body: JSON.stringify({
          stage: action.stage,
          ...(action.storyboardIds ? { storyboardIds: action.storyboardIds } : {}),
          ...(action.regenerate ? { regenerate: true } : {}),
          ...(acceptDurationGap ? { acceptDurationGap: true } : {}),
          ...(durationDecisions.length > 0 ? { durationDecisions } : {}),
        }),
      })
      toast.success(t('stepper.actionQueued'))
      reload()
      onAdvanced?.()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setRunningAction(false)
    }
  }

  const allIndexes = blocks.map((_, i) => i)
  const doneBlocks = currentBlock < 0 ? allIndexes : allIndexes.filter(index => blockState[index] === 'done')
  const todoBlocks = currentBlock < 0 ? [] : allIndexes.filter(index => blockState[index] === 'todo')
  // A block that owns no steps (the quality queue) is outside the folding math.
  // blockState calls it done because `[].every()` is vacuously true, but counting it
  // would print a "已完成 0 步" line over nothing, and folding a review queue behind
  // a collapse would hide live findings. It renders in place, always — after the
  // current block and before the not-yet group, which is its slot in block order.
  const unsteppedBlocks = currentBlock < 0 ? [] : doneBlocks.filter(index => blocks[index].steps.length === 0)
  const doneStepBlocks = doneBlocks.filter(index => blocks[index].steps.length > 0)
  // One block can own two steps (media + composition share the console table), so the
  // count in the line has to be steps, not blocks — otherwise it reads "后 4 步" above a
  // list of five names.
  const stepCount = (indexes: number[]) => indexes.reduce((sum, index) => sum + blocks[index].steps.length, 0)
  const stepNames = (indexes: number[]) =>
    indexes
      .flatMap(index => blocks[index].steps)
      .map(key => t(`stepper.step.${key}`))
      .join(' / ')

  /** One block wrapper: the panel that declared this id, or a readable placeholder. */
  function renderBlock(index: number) {
    const block = blocks[index]
    return (
      <div key={block.id} id={block.id} className="scroll-mt-20">
        {declared.get(block.id) ?? <MissingPanel blockId={block.id} />}
      </div>
    )
  }

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
            pendingApproval={pendingApproval}
            batchFailure={batchFailure}
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

        {doneStepBlocks.length > 0 && (
          <GroupLine
            tone="done"
            text={t('stepper.doneGroup', { count: stepCount(doneStepBlocks), names: stepNames(doneStepBlocks) })}
            open={openDone || currentBlock < 0}
            onToggle={() => setOpenDone(value => !value)}
          />
        )}
        {(openDone || currentBlock < 0) && doneStepBlocks.map(renderBlock)}
        {currentBlock >= 0 && renderBlock(currentBlock)}
        {unsteppedBlocks.map(renderBlock)}
        {todoBlocks.length > 0 && (
          <GroupLine
            tone="todo"
            text={t('stepper.todoGroup', { count: stepCount(todoBlocks), names: stepNames(todoBlocks) })}
            open={openTodo}
            onToggle={() => setOpenTodo(value => !value)}
          />
        )}
        {openTodo && todoBlocks.map(renderBlock)}

        {nonStep.length > 0 && (
          // Panels that are no step's content (the timeline editor) live below the
          // flow with their own label — always visible, never folded, so an
          // unsaved-edit signal on them cannot be swallowed by a collapse.
          <section data-flow-nonstep className="space-y-4 pt-2">
            <p className="text-faint-foreground text-[11px]">{t('stepper.nonStepTitle')}</p>
            {nonStep}
          </section>
        )}

        <PlanDialog
          pending={pendingPlan && { stage: pendingPlan.action.stage, regenerate: pendingPlan.action.regenerate === true, plan: pendingPlan.plan }}
          onClose={() => setPendingPlan(null)}
          onConfirm={(acceptDurationGap, durationDecisions) => void confirmPlan(acceptDurationGap, durationDecisions)}
        />
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
  /** 活体镜头里没被整批批准的条数（SD-022）：当前步是分镜时，下一步那句话按它说。 */
  pendingApproval: number
  /** 最近一次 STORYBOARD 批次的失败信号（SD-020）：null = 没有失败要说。 */
  batchFailure: { error: string | null } | null
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
  pendingApproval,
  batchFailure,
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
            {nextStep && (
              <p className="text-muted-foreground mt-1 text-sm">
                {/* SD-022：分镜在册但没人批准时，这一步等的是一次签收，不是一次生成——
                    那句「把剧集拆成分镜」会把读完了的人绕回去重拆。 */}
                {nextStep === 'storyboards' && pendingApproval > 0
                  ? t('stepper.next.storyboardsAwaitingApproval', { count: pendingApproval })
                  : t(`stepper.next.${nextStep}`)}
              </p>
            )}
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

        {batchFailure && (
          // SD-020：失败的批次过去在流程页永远不出现——红条挂在这张从不折叠的卡上，
          // 人话原因进正文、原始报文只进 Tooltip，重试入口是跳回分镜卡的「重新分镜」，
          // 不是在这里替人按下那一下要花钱的按钮。
          <div className="border-destructive/40 bg-destructive/5 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
            <div className="min-w-0 flex-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <p className="text-destructive cursor-help text-xs font-medium">{t('stepper.storyboardBatchFailed.title')}</p>
                </TooltipTrigger>
                {batchFailure.error && <TooltipContent className="max-w-md break-all">{batchFailure.error}</TooltipContent>}
              </Tooltip>
              <p className="text-muted-foreground mt-0.5 text-xs">{storyboardFailureCopy(t, batchFailure.error)}</p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" onClick={() => onRunAction({ kind: 'review', anchor: 'storyboards', labelKey: 'stepper.action.retryStoryboard' })}>
                  {t('stepper.action.retryStoryboard')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('stepper.jumpHint')}</TooltipContent>
            </Tooltip>
          </div>
        )}

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

/** A block whose panel never mounted. Loud on purpose — the spec's rule for UX-05 is
 *  that an anomaly keeps the current action and shows a readable fault state, so the
 *  step guide above keeps working and the gap names itself instead of vanishing. */
function MissingPanel({ blockId }: { blockId: string }) {
  const { t } = useI18n()
  return (
    <div
      data-flow-missing={blockId}
      className="text-muted-foreground rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs"
    >
      {t('stepper.blockMissing', { id: blockId })}
    </div>
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
