import { classifyFailure, isTerminalFailure, type FailureKind } from '@studio/domain'
import type { GenerationArtifact, ShotAudioSource, ShotboardShot } from './api'
import { FAILURE_CAUSE_KEY } from './failure-cause'
import type { TranslateFn } from './i18n'

/**
 * 这一镜成片里听到什么。四种真相与 `apps/worker/src/compose.ts` 的 resolveShotAudio
 * 一一对应：人没选过就按镜型默认（有台词=只用配音，无台词=只用原声），
 * 默认规则翻档时两处一起改，否则界面说的和剪出来的是两回事。
 */
export type ResolvedAudioMode = 'voice' | 'native' | 'voice_native' | 'imported'

/** 镜头行的两种形状（总览的 ShotboardShot 与流程页的 Storyboard）都满足这一份。 */
export interface ShotAudioFields {
  dialogue: string
  audioSource?: ShotAudioSource | null
  /** 这一镜导入的环境音。两种镜头行形状都带它，只有「听到什么」的读数用得到。 */
  importedAmbience?: { id: string } | null
}

/**
 * 这一镜「生效」的声音来源档：人钦定过就是那一档，没钦定就按镜型默认
 * （有台词=只用配音，无台词=只用原声）。分段控件拿它决定亮哪一格，
 * 否则没人点过的镜头四格全灭，而下面那行却说在走默认——两处说的不是一件事。
 */
export function shotAudioSourceInEffect(shot: ShotAudioFields): ShotAudioSource {
  if (shot.audioSource) return shot.audioSource
  return shot.dialogue !== '' ? 'VOICE' : 'NATIVE'
}

export function shotAudioMode(shot: ShotAudioFields): ResolvedAudioMode {
  return shotAudioSourceInEffect(shot).toLowerCase() as ResolvedAudioMode
}

/** 这一档要不要等一条配音轨：只有「只用原声」不等，其余三档都等。 */
export function shotNeedsVoiceTrack(mode: ResolvedAudioMode): boolean {
  return mode !== 'native'
}

/** 这一镜是否还欠一条人声轨——与 pipeline 的 TTS 门、导入门同一口径。 */
export function shotOwesVoice(shot: ShotAudioFields): boolean {
  return shotNeedsVoiceTrack(shotAudioMode(shot))
}

/**
 * 这一镜能播的那条人声：'IMPORTED' 档只认导入件，其余档先取本镜 TTS、没有再退到导入件。
 * 与合成取的是同一份，所以界面上听见的和母带里出现的不会分家。
 */
export function shotVoiceTrack(
  shot: ShotAudioFields & { voice?: GenerationArtifact | null; importedVoice?: GenerationArtifact | null },
): GenerationArtifact | null {
  if (shotAudioMode(shot) === 'imported') return shot.importedVoice ?? null
  return shot.voice ?? shot.importedVoice ?? null
}

/**
 * 词根走字典里的枚举大写键（`shotboard.audio.VOICE`），不是混音层的小写档名——
 * 直接拼小写会渲染出 key 本身，卡片上露出「shotboard.audio.imported」这种东西。
 */
const MODE_WORD: Record<ResolvedAudioMode, string> = {
  voice: 'VOICE',
  native: 'NATIVE',
  voice_native: 'VOICE_NATIVE',
  imported: 'IMPORTED',
}

export function audioModeWord(t: TranslateFn, mode: ResolvedAudioMode): string {
  return t(`shotboard.audio.${MODE_WORD[mode]}`)
}

/**
 * 这一镜成片里真听到的声音。导入的环境音占的就是模型原声那一格（`resolveShotAudio`
 * 里 bedSource 顶掉 clip 自带音轨），所以它出现时读数里的「原声」要换成它：
 * 卡上写「配音 + 原声 + 环境音」，母带里其实根本没有原声，那就是骗人。
 */
export function heardAudioWord(t: TranslateFn, shot: ShotAudioFields): string {
  const mode = shotAudioMode(shot)
  if (!shot.importedAmbience) return audioModeWord(t, mode)
  const bed = t('shotboard.audio.dotBedWord')
  if (mode === 'native') return bed
  if (mode === 'imported') return `${audioModeWord(t, 'imported')} + ${bed}`
  return `${t('shotboard.audio.dot.VOICE')} + ${bed}`
}

/** 卡片那枚点的短词根：与分段控件同源但更短，同一件事在两处不许用两个词。 */
export function audioDotWord(t: TranslateFn, mode: ResolvedAudioMode): string {
  return t(`shotboard.audio.dot.${mode.toUpperCase()}`)
}

/**
 * The one question a shot card answers: who is holding this shot up. Failure-first, the same
 * ladder the episode board uses, so the same colour means the same thing on both screens.
 * `status` is written by the pipeline for storyboards, so it is safe to read here — unlike the
 * episode row, which nothing ever advanced.
 */
export type ShotStage = 'blocked' | 'review' | 'running' | 'approved' | 'idle'

export interface ShotVerdict {
  stage: ShotStage
  /** Attention codes, worst first — the card writes the first one it recognises. */
  reasons: string[]
  /** Stages that already produced media over the stages this shot needs. */
  done: number
  total: number
}

/** 徽章那枚的全部取值。卡片与放映条共用同一张表，谁都不许自己再造一套口吻。 */
export type CardStage = ShotStage | 'start' | 'complete' | 'retry' | 'failed'

const FAILED = ['frame_failed', 'video_failed']

export function shotVerdict(shot: ShotboardShot): ShotVerdict {
  const reasons: string[] = []
  for (const code of FAILED) if (shot.attention.includes(code)) reasons.push(code)
  if (shot.status === 'BLOCKED' || shot.attention.includes('shot_blocked')) reasons.push('shot_blocked')
  for (const code of ['asset_gate']) if (shot.attention.includes(code)) reasons.push(code)
  if (shot.attention.includes('selection_open')) reasons.push('selection_open')

  // 「这一镜还欠几件」按声音来源裁决，而不是按有没有台词：钦定「只用原声」的有台词镜
  // 本来就不欠配音，无台词却导入音频的镜反而欠一条音轨。否则卡片会一边写「已齐 2/2」
  // 一边在第三枚点上亮灰。
  const needsTrack = shotOwesVoice(shot)
  const total = needsTrack ? 3 : 2
  const done = [shot.firstFrame, shot.video, needsTrack ? shotVoiceTrack(shot) : null].filter(Boolean).length

  let stage: ShotStage = 'idle'
  if (reasons.some(reason => FAILED.includes(reason) || reason === 'shot_blocked' || reason === 'asset_gate')) stage = 'blocked'
  else if (shot.status === 'NEEDS_REVIEW' || reasons.includes('selection_open')) stage = 'review'
  else if (shot.inflight.length > 0) stage = 'running'
  else if (shot.status === 'APPROVED' || shot.status === 'COMPLETED') stage = 'approved'

  return { stage, reasons, done, total }
}

/**
 * 卡片右上角与放映条格子共用的那一档。裁决放在这里是因为两处必须同源：
 * 上一版卡片按产物判、放映条按最新一抽判，于是同一镜一边写「未验收」一边整格报死。
 */
export function cardStage(shot: ShotboardShot, verdict: ShotVerdict): CardStage {
  if (verdict.stage === 'blocked') {
    if (retryWithOutputLeft(shot)) return 'retry'
    return verdict.reasons.some(code => code === 'frame_failed' || code === 'video_failed') ? 'failed' : 'blocked'
  }
  if (verdict.stage === 'idle' && verdict.done === verdict.total) return 'complete'
  if (verdict.stage === 'idle' && verdict.done > 0) return 'start'
  return verdict.stage
}

/**
 * 卡片那枚徽章此刻说的是哪一档失败。队列里同一镜可能并列好几行（首帧失败 + 等你审），
 * 只有这一行才许借用卡片的话；其余行说自己那一档，否则徽章与它下面的诉求会各说一件事。
 */
export function cardFailureCode(verdict: ShotVerdict): 'frame_failed' | 'video_failed' | null {
  if (verdict.stage !== 'blocked') return null
  return verdict.reasons.find(reason => reason === 'frame_failed' || reason === 'video_failed') ?? null
}

/**
 * 「最新一抽砸了、手上还有上一版」那句短话，按这一抽的真因分档。
 * 角标与徽章共用它，否则格子的角标会不分原因地写「没过线」——额度耗尽时那句话
 * 又把用户推回去改提示词。内容审查同理：报文都没换，重抽只会再被拦一次。
 */
export function retryWord(t: TranslateFn, failureKind: FailureKind, compact = false): string {
  if (isTerminalFailure(failureKind)) return compact ? t('shotboard.slot.noRetry') : t('shotboard.stage.noRetry')
  if (failureKind === 'moderation') return compact ? t('shotboard.slot.rephrase') : t('shotboard.stage.rephrase')
  if (failureKind === 'network') return compact ? t('shotboard.slot.retryDropped') : t('shotboard.stage.retryDropped')
  return compact ? t('shotboard.slot.retry') : t('shotboard.stage.retry')
}

/** 那一格角标：吃的是这一格自己的报文，不是整镜的第一条失败。 */
export function retryWordForError(t: TranslateFn, raw: string | null | undefined): string {
  return retryWord(t, classifyFailure(raw), true)
}

/**
 * 那一档写出来的话。compact 给放映条的窄格用，只许缩短、不许换词根——
 * 同一件事在两处用两个词，读的人就会认为是两件事。
 */
export function stageWord(t: TranslateFn, verdict: ShotVerdict, stage: CardStage, compact = false, failureKind: FailureKind = 'unknown'): string {
  switch (stage) {
    case 'running':
      return compact ? t('shotboard.strip.running') : t('shotboard.stage.running', { done: verdict.done, total: verdict.total })
    case 'complete':
      return compact
        ? t('shotboard.strip.complete', { done: verdict.done, total: verdict.total })
        : t('shotboard.stage.complete', { done: verdict.done, total: verdict.total })
    case 'retry':
      // 「重抽没过线」只在质量审计拒收时成立：额度/权限/参数这类终因下再抽一百次也不会变，
      // 网络中断则是这一抽压根没送到模型。三种原因三种说法，否则用户会去改提示词。
      return retryWord(t, failureKind, compact)
    case 'failed':
      return cardFailureCode(verdict) === 'video_failed' ? t('attention.video_failed') : t('attention.frame_failed')
    default:
      return t(`shotboard.stage.${stage}`)
  }
}

/** 放映条格子的底色：绿=手上有可用画面、红=要你决定、琥珀=等你审、蓝=在产、灰=还没产。 */
export function stageTone(stage: CardStage): 'ready' | 'danger' | 'warning' | 'running' | 'idle' {
  if (stage === 'complete' || stage === 'approved') return 'ready'
  if (stage === 'retry' || stage === 'failed' || stage === 'blocked') return 'danger'
  if (stage === 'review') return 'warning'
  if (stage === 'running') return 'running'
  return 'idle'
}

/** Assets this shot is waiting on: linked, has versions, but nobody approved them yet. */export function unapprovedAssetNames(shot: ShotboardShot): string[] {
  return shot.assets.filter(asset => asset.status !== 'APPROVED' && asset.hasVersions).map(asset => asset.name)
}

/**
 * 「重抽没过线」和「这一镜卡住了」是两件事，界面必须分开说。
 * 最新一次尝试失败、但上一版画面还在镜头上：要决定的是「再抽一次还是收下这一版」，
 * 不是去解一个并不存在的阻塞——把它写成「被阻塞」，同一张卡就会同时出现红徽章和绿点。
 */
export function retryWithOutputLeft(shot: ShotboardShot): boolean {
  if (shot.attention.includes('shot_blocked')) return false
  const frameFailed = shot.attention.includes('frame_failed')
  const videoFailed = shot.attention.includes('video_failed')
  if (!frameFailed && !videoFailed) return false
  return (!frameFailed || Boolean(shot.firstFrame)) && (!videoFailed || Boolean(shot.video))
}

/**
 * 这一镜当前那条失败到底因什么。卡片徽章、占位框与顶部队列共用这一个裁决，
 * 三处各算一遍就会出现「徽章说重抽无效、下面那句让你再抽一次」。
 */
export function shotFailureKind(shot: ShotboardShot): FailureKind {
  if (shot.attention.includes('frame_failed')) return classifyFailure(shot.firstFrameError)
  if (shot.attention.includes('video_failed')) return classifyFailure(shot.videoError)
  return 'unknown'
}

/**
 * 一件「等你处理」具体是什么：卡片占位框与顶部队列用同一句话，两处不许各说一套。
 * worker 的英文原文不上扫描面——它落在弹窗里，那里才是读证据的地方。
 * 等审那句按这一镜真有的东西说——没有画面时不能写「首帧已出」。
 */
export function shotDemandText(t: TranslateFn, shot: ShotboardShot, code: string): string {
  switch (code) {
    case 'frame_failed':
      return failureDemand(t, shot, 'frame')
    case 'video_failed':
      return failureDemand(t, shot, 'video')
    case 'asset_gate': {
      const names = unapprovedAssetNames(shot)
      return names.length > 0 ? t('shotboard.reason.assetGate', { names: names.join('、') }) : t('attention.asset_gate')
    }
    case 'shot_blocked':
      return t('shotboard.reason.blocked')
    case 'selection_open':
      return t('shotboard.reason.selectionOpen', { count: shot.videoCandidates.length })
    case 'awaiting_review':
      return shot.video ? t('shotboard.reason.reviewClip') : shot.firstFrame ? t('shotboard.reason.reviewFrame') : t('shotboard.reason.reviewShot')
    default:
      return ''
  }
}

/**
 * 失败那句先报真因，再报这一镜手上还剩什么。
 * 审计没过线（或认不出原因）才走原来的两句——那时「再抽一次」确实是正确建议；
 * 额度/权限/参数这类终因下写「决定再抽一次还是收下」，是把用户往墙上推。
 */
function failureDemand(t: TranslateFn, shot: ShotboardShot, stage: 'frame' | 'video'): string {
  const raw = stage === 'frame' ? shot.firstFrameError : shot.videoError
  const hasOutput = stage === 'frame' ? Boolean(shot.firstFrame) : Boolean(shot.video)
  const causeKey = FAILURE_CAUSE_KEY[classifyFailure(raw)]
  if (!causeKey) return hasOutput ? t(`shotboard.reason.${stage}Retry`) : t(`shotboard.reason.${stage}Failed`)
  const keptKey = `shotboard.failure.${stage}${hasOutput ? 'Kept' : 'None'}`
  return `${t(keptKey)} · ${t(causeKey)}`
}
