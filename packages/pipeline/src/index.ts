import { OFFICIAL_RECIPES, projectAspect, recipeChecksum } from './recipes.js'
import { createHash } from 'node:crypto'
import type { Prisma, AudioSource, PrismaClient, SlotCandidate, Stage } from '@studio/db'
import { resolveSlotCandidates, resolveVideoArtifactShot, syncBatchStatus } from '@studio/db'
import type { AutomationGate, CapabilitySlot, ContentLocale, GenerationStage } from '@studio/domain'
import { defaultAutomationGate, generationStages, isAutomationGate, isContentLocale, masterNeedsVoice, needsImportedVoice, needsTtsVoice, planVideoModels, recordedAudioMode, stageSlot, capDurationSpec, readDurationEvidence, DURATION_KEY, maxDurationSeconds, minDurationSeconds, readDurationSpec } from '@studio/domain'
import { jobIdFor, type PipelinePayload, type RunTaskCandidate } from '@studio/jobs'
import { buildFilmScriptPrompt, buildMusicPrompt, buildScriptPrompt, buildStoryboardPrompt, voiceLine, type ShotDurationPlan } from './prompts.js'
import { resolveShotRhythm } from './content-audit.js'
import { DEFAULT_PROMPT_GUARDS, runPromptGuards, VISUAL_STYLE_DIRECTIVE, type GuardCharacterInfo, type GuardFinding } from './guards.js'
import { applyStyleToPrompt, getStyleById, isVisualStyleStage, type StylePreset } from './styles/index.js'
import { parseGenerationReview } from './review.js'
import { isSetLocation, isShotVisible, matchShotAssetLinks, type ShotAssetLink } from './asset-links.js'
import { inspectStoryboardGaps } from './storyboard-gaps.js'
import { needsGeneratedMedia } from './shot-method.js'
import { auditShotTakes, normalizeShotLines, planShotTakes, resolveTransition, type TakePlan } from './shot-layer.js'

export { recordAssetVersion } from './asset-version.js'

/**
 * 重抽停在「问」上的任务不是失败重试:它已经被质检判过一次,正在等人裁决。
 * 普通触发(整批补跑、重跑失败项)若把它当 FAILED 复活,就会绕过那道问询;
 * 预审也会因此承诺一次并不会发生的重抽。两条路都用这一个判定。
 */
function hasPendingReview(rawSnapshot: string | null | undefined): boolean {
  return parseGenerationReview(rawSnapshot)?.state === 'pending'
}

/**
 * 「这一阶段还欠这个目标一个结果」的任务。三种：被守卫拦下的 BLOCKED、重试过且没停在
 * 问询上的 FAILED、被人叫停的 CANCELLED。停止只作用于 QUEUED 任务（见 batches/:id/cancel
 * 与 rollUp 的「nothing ran」），所以取消的那一条必然没有产物——它和失败同属欠账，
 * 不是"已覆盖"。真触发与预审必须共用这个判定：一处认一处不认，界面就会承诺一件不会发生的事。
 */
function owesResult(task: { status: string; reviewSnapshot?: string | null }): boolean {
  if (task.status === 'BLOCKED' || task.status === 'CANCELLED') return true
  return task.status === 'FAILED' && !hasPendingReview(task.reviewSnapshot)
}

/** A committed task and its delivery intent share a transaction. Redis is only a dispatcher. */
export async function recordJobIntent(db: Prisma.TransactionClient, payload: PipelinePayload) {
  return db.jobOutbox.upsert({ where: { id: `intent-${jobIdFor(payload)}` }, create: { id: `intent-${jobIdFor(payload)}`, organizationId: payload.organizationId, payload: JSON.stringify(payload) }, update: {} })
}

/** Caller holds this transaction until newly reserved work and its outbox are committed. */
export async function reserveOrganizationCalls(tx: Prisma.TransactionClient, organizationId: string, planned: number): Promise<boolean> {
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
  const organization = await tx.organization.findUnique({ where: { id: organizationId }, select: { inFlightCallLimit: true } })
  if (organization?.inFlightCallLimit == null) return true
  const counted = await tx.$queryRaw<Array<{ count: number }>>`SELECT (SELECT COUNT(*) FROM "GenerationTask" t WHERE t."organizationId" = ${organizationId} AND (t.status IN ('QUEUED','RUNNING') OR EXISTS (SELECT 1 FROM "SubmissionAttempt" s WHERE s."taskId"=t.id AND s.status IN ('submitting','submission_unknown','accepted','running','result_ready')))) + (SELECT COUNT(*) FROM "ArtifactOperation" o WHERE o."organizationId"=${organizationId} AND (o.status IN ('QUEUED','RUNNING') OR EXISTS (SELECT 1 FROM "SubmissionAttempt" s WHERE s."operationId"=o.id AND s.status IN ('submitting','submission_unknown','accepted','running','result_ready')))) AS count`
  return Number(counted[0]?.count ?? 0) + planned <= organization.inFlightCallLimit
}

/**
 * Generation orchestration shared by the API (a human triggers a stage) and the
 * worker (a completed batch auto-advances to the next one). Keeping it here means
 * both paths gate, prompt, batch, enqueue, and audit identically — the pipeline
 * behaves the same whether a person or the worker pushed it forward.
 */

// The stage vocabulary and its slot wiring live in @studio/domain — the console's
// readiness panel reads the same table, so neither side keeps a private copy.
export { generationStages, isGenerationStage } from '@studio/domain'
export { OFFICIAL_RECIPES, projectAspect, recipeChecksum, type OfficialRecipe, type RecipeSpec } from './recipes.js'
export type { GenerationStage } from '@studio/domain'
export {
  askReasonFor,
  classifyQcFailure,
  defaultRetryPolicy,
  isRetryClass,
  isRetryPolicy,
  parseGenerationReview,
  policyAutoRetries,
  resolveRetryPolicy,
  retryCapOf,
  retryClasses,
  retryPolicies,
  type AskReason,
  type GenerationReviewSnapshot,
  type RetryClass,
  type RetryPolicy,
  type ReviewState,
} from './review.js'

/**
 * The quality floor, in one place on purpose: the worker gates on it, and the console
 * colours scores with the same number. A second copy in either side is how the UI starts
 * lying about what the pipeline did.
 */
export const QC_THRESHOLD = 0.7

// P7 prompt guards: the chain lives in guards.ts; the console and the tests meet it here.
export { DEFAULT_PROMPT_GUARDS, runPromptGuards, VISUAL_STYLE_DIRECTIVE } from './guards.js'
export type { GuardCharacterInfo, GuardContext, GuardFinding, GuardOutcome, GuardShotInfo, GuardStage, PromptGuard } from './guards.js'

// Mechanical chapter splitting for whole-book uploads; no model involved.
export { splitChapters, isChapterMarkerLine } from './chapters.js'
export type { ChapterSegment } from './chapters.js'

// Prompt builders are part of the pipeline's contract with the worker (分段分镜在
// 执行时按段重建 prompt), so they leave the package through the front door.
export { buildFilmScriptPrompt, buildMusicPrompt, buildScriptPrompt, buildStoryboardPrompt, voiceLine } from './prompts.js'

// 分段分镜(4b):切块、预算分配、合并重编号与宽容解析都是纯函数,worker 只编排。
export {
  STORYBOARD_SPLIT_CHAR_THRESHOLD,
  STORYBOARD_SPLIT_SHOT_THRESHOLD,
  mergeStoryboardReplies,
  parseStoryboardJson,
  planStoryboardSegments,
  shouldSplitStoryboard,
} from './storyboard.js'
export type { ExtractedAsset, ParsedStoryboard, StoryboardSegment } from './storyboard.js'

// 剧本自带的分镜表是一份确定性契约：prompt 用它声明逐行转录，落库前的审计用它
// 核对行数/时长/字卡。两边读同一个解析器，不允许各数各的。
export {
  contractCardText,
  normalizeContractText,
  parseContractDuration,
  parseStoryboardContract,
  shotContractText,
} from './storyboard-contract.js'
export type { StoryboardContract, StoryboardContractRow } from './storyboard-contract.js'

// 分镜表的「生成方式」列：决定这一镜要不要进图片/视频的计费队列。解析在
// storyboard-contract 里，这里只把分类规则交给 worker 落库与两条触发路径共用。
export { needsGeneratedMedia, shotProduction } from './shot-method.js'
export type { ShotProduction } from './shot-method.js'

// 镜头↔素材绑定：落库时与每次触发 IMAGE/VIDEO 前共用同一套匹配规则。
// 素材晚于分镜创建时，只在落库那一刻匹配会让后补的场景/道具永远绑不上。
export { isSetLocation, isShotVisible, matchShotAssetLinks, normalizeAssetName } from './asset-links.js'
export type { LinkableAsset, LinkableShot, ShotAssetLink } from './asset-links.js'

// 文字产物的确定性体检:剧本与分镜的结构契约,零成本、不调模型、不会 unjudged。
// worker 在落库前用它判定这一抽算不算数——不过关就换下一个候选,而不是把一份
// 分镜切不动的剧本或空描述的分镜写进库里。判据见 prompts.ts 的成文要求。
export { auditScriptText, auditStoryboardShots, describeFindings, DEFAULT_SHOT_RHYTHM, SHORT_SHOT_MS, normalizeShotRhythm, resolveShotRhythm, measureShotRhythm, rhythmFromSpans, evaluateShotRhythm } from './content-audit.js'
export type { ContentFinding, ShotRhythmSettings, ShotRhythmReadings, ShotRhythmGate } from './content-audit.js'

// 验收三读数（S5）：节奏/转场/声音都从母带自己的台账里读，缺一项就不给签字。
// 判「有没有数」，不判「好不好看」——后者归项目节奏设置，只摆数不拦人。
export { readCompositionReview, reviewGapCodes } from './review-readings.js'
export type { CompositionReviewReadings, RhythmReading, TransitionReading, SoundReading, ReviewGap, ReviewReadingInput } from './review-readings.js'

// 分镜层（plan_2026-10-24 §3–§5）：镜头类型、转场、镜内多句台词、环境音床，
// 以及超长镜拆连续段的计划与帧链校验。词表与校验都是纯函数，落库、审批前
// 预检与合成三处读同一份，不允许各写一套。
export {
  SHOT_ROLES,
  TRANSITIONS,
  TRANSITION_DEFAULT_MS,
  auditShotTakes,
  inferShotRole,
  normalizeShotLines,
  normalizeShotRole,
  normalizeTransition,
  planShotTakes,
  resolveTransition,
} from './shot-layer.js'
export type { ShotLine, ShotRole, TakeDraft, TakePlan, TakeRecord, Transition, TransitionChoice } from './shot-layer.js'

// 分镜文本的逐镜软检：落库之后、开烧之前，把「这一镜这样写，付费生成会出什么
// 问题」逐镜列出来。与上面硬检的分工是「在不在」归硬检（缺字段直接拒收），
// 「对不对」归这里（只提示、不拦人，误拦一次的代价是白烧一次生成）。
export { inspectStoryboardGaps } from './storyboard-gaps.js'
export type { StoryboardGapOptions, StoryboardGapShot } from './storyboard-gaps.js'

// 风格预设系统:影响 STORYBOARD/IMAGE/VIDEO 阶段的 prompt。自定义风格走 DB 的
// StylePreset 表,进程内没有第二条注册路(2026-10-06 撤掉零消费者的 customStyles 注册表)。
export {
  OFFICIAL_STYLES,
  getOfficialStyles,
  getStyleById,
  isValidStyleId,
  getStyleVisualDirective,
  getStyleAssetDirective,
  getStyleToneDirective,
} from './styles/index.js'
export type { StylePreset } from './styles/index.js'
export { applyStyleToPrompt, isStageAffectedByStyle, isVisualStyleStage } from './styles/index.js'

// 官方风格幂等种子
export { seedOfficialStyles } from './seed-official-styles.js'

/** The stages the pipeline advances through on its own, in order. */
export const PIPELINE_STAGES = ['SCRIPT', 'STORYBOARD', 'ASSET', 'IMAGE', 'VIDEO', 'AUDIO', 'MUSIC'] as const
export type PipelineStage = (typeof PIPELINE_STAGES)[number]

// The slot a stage plans against: the required entry for that stage in the shared
// `slotStageUsage` table (@studio/domain). IMAGE and ASSET share image_gen; VIDEO's
// optional video_i2v conditioning is not required, so it never claims the stage.
const stageSlots = Object.fromEntries(
  generationStages.map(stage => [stage, stageSlot(stage)] as const),
) as Record<GenerationStage, CapabilitySlot>

// Storyboard imagery is modelled as FIRST_FRAME in the schema; the pipeline API
// and the console both call that stage IMAGE.
export const stageDbValues: Record<GenerationStage, Stage> = {
  SCRIPT: 'SCRIPT',
  ASSET: 'ASSET',
  STORYBOARD: 'STORYBOARD',
  IMAGE: 'FIRST_FRAME',
  VIDEO: 'VIDEO',
  AUDIO: 'AUDIO',
  MUSIC: 'MUSIC',
}

const apiStageByDbStage: Partial<Record<Stage, GenerationStage>> = { FIRST_FRAME: 'IMAGE' }

export function toApiStage(stage: Stage): GenerationStage {
  return apiStageByDbStage[stage] ?? (stage as GenerationStage)
}

// A resolved candidate also carries what the console needs to explain the
// ordering; the queued job only needs enough to open a provider.
export function toRunTaskCandidate(candidate: SlotCandidate): RunTaskCandidate {
  return {
    connectionId: candidate.connectionId,
    capabilityId: candidate.capabilityId,
    provider: candidate.provider,
    model: candidate.model,
  }
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
}

/**
 * The base seed a media task is reproducible from: a hash of its idempotency key, kept
 * inside the range every video/image vendor here accepts (DashScope caps seed at 2^31-1,
 * the widest common bound). Derived rather than random because the snapshot is the audit
 * answer to "what exactly was paid for" — a fresh throw at write time would make the
 * stored request unreproducible by anyone re-reading it.
 */
export function generationSeed(idempotencyKey: string): number {
  return parseInt(createHash('sha256').update(`${idempotencyKey}:seed`).digest('hex').slice(0, 8), 16) % 2_147_483_648
}

/** A shot the pipeline still owes media to. */
export interface LiveStoryboard {
  id: string
  revision: number
  number: number
  title: string
  durationMs: number
  /** Spoken lines; the empty string marks a silent shot. */
  dialogue: string
  /** 人钦定的声音来源；null = 按镜型默认。合成门与母带新鲜度都要读它。 */
  audioSource: AudioSource | null
}

/**
 * The episode's live shot list. A regenerate supersedes the prior revision rather
 * than deleting it, so the rows and the media already paid for stay readable as
 * history — but they are not work: targeting them would spend money regenerating
 * clips for a breakdown nobody is using, and composing them would concatenate
 * shots that were replaced.
 */
export async function liveStoryboards(db: PrismaClient, episodeId: string): Promise<LiveStoryboard[]> {
  return db.storyboard.findMany({
    where: { episodeId, supersededAt: null },
    select: { id: true, revision: true, number: true, title: true, durationMs: true, dialogue: true, audioSource: true },
    orderBy: [{ revision: 'asc' }, { number: 'asc' }],
  })
}

/**
 * The shots that already have a clip, by the exact rule the compose worker applies
 * when it picks one: a succeeded VIDEO task **for that shot** that produced a VIDEO
 * artifact. Restated here so the delivery gate and the auto-compose step refuse for
 * the same episodes composition would block on. Read off the task's own storyboardId
 * rather than the batch's shot list — a batch covers every shot it was planned
 * against, so going through it would call all three shots composed the moment one
 * of them had a clip.
 */
export async function composedStoryboardIds(db: PrismaClient, episodeId: string): Promise<Set<string>> {
  const batchIds = (await db.generationBatch.findMany({ where: { episodeId }, select: { id: true } })).map(b => b.id)
  const tasks = await db.generationTask.findMany({
    where: {
      status: 'SUCCEEDED',
      stage: 'VIDEO',
      storyboardId: { not: null },
      batchId: { in: batchIds },
      mediaArtifacts: { some: { stage: 'VIDEO' } },
    },
    select: { storyboardId: true },
  })
  return new Set(tasks.map(task => task.storyboardId!).filter(Boolean))
}

/**
 * The shots whose own voice line has landed: a succeeded AUDIO task for that shot
 * with an AUDIO artifact, the same per-task lineage rule as clips. Composition
 * gates on this for shots that actually speak; a silent shot never waits for a
 * voice track.
 */
export async function voicedStoryboardIds(db: PrismaClient, episodeId: string): Promise<Set<string>> {
  const batchIds = (await db.generationBatch.findMany({ where: { episodeId }, select: { id: true } })).map(b => b.id)
  const tasks = await db.generationTask.findMany({
    where: {
      status: 'SUCCEEDED',
      stage: 'AUDIO',
      storyboardId: { not: null },
      batchId: { in: batchIds },
      mediaArtifacts: { some: { stage: 'AUDIO' } },
    },
    select: { storyboardId: true },
  })
  return new Set(tasks.map(task => task.storyboardId!).filter(Boolean))
}

/** Composition is the terminal step of the chain, not a generation stage. */
export const COMPOSITION_STEP = 'COMPOSITION' as const

export type CompositionPlan = { ready: true; storyboardIds: string[] } | { ready: false; reason: string }

/** The shots a composition was cut from, read back out of its manifest. */
export function manifestStoryboardIds(manifest: string): string[] {
  const parsed = JSON.parse(manifest) as { storyboardIds?: unknown }
  if (!Array.isArray(parsed.storyboardIds)) return []
  return parsed.storyboardIds.filter((id): id is string => typeof id === 'string')
}

/** What the composer recorded per shot: which artifact made it in and whether a human
 * chose it. Absent on every master cut before the selection gate shipped. */
export interface ManifestSelection {
  artifactId: string
  source: 'manual' | 'auto'
}

export function manifestSelections(manifest: string): Record<string, ManifestSelection> | null {
  try {
    const parsed = JSON.parse(manifest) as { selections?: unknown }
    if (!parsed.selections || typeof parsed.selections !== 'object') return null
    const out: Record<string, ManifestSelection> = {}
    for (const [shotId, entry] of Object.entries(parsed.selections as Record<string, unknown>)) {
      const value = entry as { artifactId?: unknown; source?: unknown }
      if (typeof value?.artifactId !== 'string') continue
      out[shotId] = { artifactId: value.artifactId, source: value.source === 'manual' ? 'manual' : 'auto' }
    }
    return out
  } catch {
    return null
  }
}

/**
 * Whether the episode can be composed now. Composition has no provider, no prompt
 * and no capability slot, so it is planned apart from PIPELINE_STAGES. It is not
 * once-per-episode either: re-cutting the same shot list with the same audio would
 * only spend ffmpeg time re-making a master that already exists, but three things make
 * a fresh render worth it — a regenerate supersedes shots and leaves that master cut
 * from a breakdown the episode no longer uses, a line voiced after the master was
 * planned is simply missing from it, and a human re-pinning a shot's cut changes what
 * the master should contain. Composing before every live shot has
 * a clip is skipped, since it is guaranteed to land in BLOCKED.
 */
export async function planComposition(db: PrismaClient, episodeId: string): Promise<CompositionPlan> {
  const storyboards = await liveStoryboards(db, episodeId)
  if (storyboards.length === 0) return { ready: false, reason: 'composition:noStoryboards' }
  const composed = await composedStoryboardIds(db, episodeId)
  if (storyboards.some(storyboard => !composed.has(storyboard.id))) return { ready: false, reason: 'composition:missingVideo' }
  // A shot with dialogue but no voice line would compose into a master where that
  // line is silently missing; a silent shot never blocks. BGM is opportunistic —
  // composition mixes it in when it landed and stays quiet when it did not.
  // With no TTS bound at all nobody could ever produce the voice, so the gate is
  // only raised when the episode's org/project can resolve candidates — otherwise
  // a dialogue script would deadlock composition on installations that never
  // signed up for audio.
  const voiced = await voicedStoryboardIds(db, episodeId)
  // 只有真需要 TTS 人声的镜头才受这道门管：钦定「只用原声」的镜头本来就不出人声，
  // 钦定「导入音频」的镜头由下面那道门单独验（导入件不来自任何生成任务）。
  const ttsNeeded = storyboards.filter(storyboard => needsTtsVoice(storyboard.dialogue, storyboard.audioSource))
  if (ttsNeeded.length > 0) {
    const episode = await db.episode.findUnique({ where: { id: episodeId }, select: { projectId: true, project: { select: { organizationId: true } } } })
    const candidates = episode
      ? await resolveSlotCandidates(db, episode.project.organizationId, episode.projectId, 'tts_voice')
      : []
    if (candidates.length > 0 && ttsNeeded.some(storyboard => !voiced.has(storyboard.id))) {
      return { ready: false, reason: 'composition:missingVoice' }
    }
  }
  const importedNeeded = storyboards.filter(storyboard => needsImportedVoice(storyboard.dialogue, storyboard.audioSource))
  if (importedNeeded.length > 0) {
    const landed = await importedVoiceStoryboardIds(db, importedNeeded.map(storyboard => storyboard.id))
    if (importedNeeded.some(storyboard => !landed.has(storyboard.id))) {
      return { ready: false, reason: 'composition:missingImportedVoice' }
    }
  }

  const storyboardIds = storyboards.map(storyboard => storyboard.id)
  const latest = await db.composition.findFirst({ where: { episodeId }, orderBy: { id: 'desc' } })
  if (latest && sameShots(manifestStoryboardIds(latest.manifest), storyboardIds)) {
    // Q03:编辑变了(指纹不同)就不是"已规划过同一份活"——排队时的快照代表旧编辑,
    // 必须允许重新排队消费新修订。
    const editHead = await db.episodeEdit.findUnique({ where: { episodeId }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } })
    const currentFingerprint = editHead?.revisions[0]?.fingerprint ?? null
    const plannedFingerprint = (JSON.parse(latest.manifest) as { editSnapshot?: { fingerprint?: string } }).editSnapshot?.fingerprint ?? null
    if (currentFingerprint !== plannedFingerprint) {
      return { ready: true, storyboardIds }
    }
    // Same cut list, so re-composing would only re-render a master that exists —
    // unless a shot got its voice after that master was planned. The composer mixes
    // in whichever voices had landed when it ran, so a line voiced since then is
    // missing from the file: the old master is a stale render, not finished work.
    // Neither model carries a usable timestamp, and cuid ids sort chronologically.
    const voicedBatchIds = (await db.generationBatch.findMany({ where: { episodeId }, select: { id: true } })).map(b => b.id)
    const voicedSince = await db.generationTask.count({
      where: { batchId: { in: voicedBatchIds }, stage: 'AUDIO', status: 'SUCCEEDED', id: { gt: latest.id }, mediaArtifacts: { some: { stage: 'AUDIO' } } },
    })
    if (voicedSince === 0 && !(await selectionChanged(db, episodeId, latest.manifest)) && !(await audioChanged(db, episodeId, latest.manifest)) && !(await compositionCutChanged(db, episodeId, latest.manifest))) {
      return { ready: false, reason: 'composition:alreadyPlanned' }
    }
  }
  return { ready: true, storyboardIds }
}

/**
 * A master is stale when a human has since pinned a cut other than the one it was
 * made from. Shots nobody selected keep the old semantics: a fresh clip alone never
 * re-triggers a re-render, or the auto-advance relay would loop on every regenerate.
 */
async function selectionChanged(db: PrismaClient, episodeId: string, manifest: string): Promise<boolean> {
  const chosen = await db.storyboard.findMany({
    where: { episodeId, supersededAt: null, selectedVideoArtifactId: { not: null } },
    select: { id: true, selectedVideoArtifactId: true },
  })
  if (chosen.length === 0) return false
  const recorded = manifestSelections(manifest)
  return chosen.some(shot => recorded?.[shot.id]?.artifactId !== shot.selectedVideoArtifactId)
}

/**
 * 段集/转场是否变了：重跑拼接镜的任意一段都会产一颗新母带，改一镜的转场则会让同一批
 * 画面按另一套接法粘起来——两者都使旧母带不再代表当前分镜表。判据与选版/声音同一层：
 * 按现在的输入重解析一遍，跟快照里定格的两个指纹分别比。
 *
 * 两轴分开返回：段集过期要说的是「入片画面是旧的」，转场过期要说的是「接法是旧的」，
 * 界面读数与人要做的返修动作不同。
 *
 * 老合成（S2d/S4② 之前排队）的快照里没有对应那个数：不能凭空判它过期，否则存量集会被
 * 自动接力反复重合成，那是白烧 ffmpeg 与磁盘。
 */
export async function compositionInputDrift(
  db: PrismaClient,
  episodeId: string,
  manifest: string,
): Promise<{ takes: boolean; transitions: boolean }> {
  const frozenTakes = manifestTakeSignature(manifest)
  const frozenTransitions = manifestTransitionSignature(manifest)
  if (!frozenTakes && !frozenTransitions) return { takes: false, transitions: false }
  const episode = await db.episode.findUnique({ where: { id: episodeId }, select: { project: { select: { organizationId: true } } } })
  if (!episode) return { takes: false, transitions: false }
  let snapshot: EditSnapshotForResolve | undefined
  const head = (await db.episodeEdit.findUnique({ where: { episodeId }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } }))?.revisions[0]
  if (head) {
    try {
      snapshot = { clips: JSON.parse(head.clips) as EditSnapshotForResolve['clips'] }
    } catch {
      // 修订 JSON 坏了：无法重算当前段集，按未变处理，让别的门说话。
      return { takes: false, transitions: false }
    }
  }
  const now = await resolveCompositionInputs(db, episode.project.organizationId, episodeId, snapshot, manifestStoryboardIds(manifest))
  return {
    takes: frozenTakes !== null && compositionTakeSignature(now.shots) !== frozenTakes,
    transitions: frozenTransitions !== null && compositionTransitionSignature(now.shots) !== frozenTransitions,
  }
}

/** 一刀表（段集或转场）是否与当前输入不符。布尔口径保留给「能不能重合成」这类门。 */
export async function compositionCutChanged(db: PrismaClient, episodeId: string, manifest: string): Promise<boolean> {
  const drift = await compositionInputDrift(db, episodeId, manifest)
  return drift.takes || drift.transitions
}

/**
 * 这一镜是否还欠一条 TTS 人声 / 只能来自导入件：判定在 @studio/domain
 * （needsTtsVoice / needsImportedVoice），compose 的合成门与这里同一口径。
 */

/** 导入音频已落地的镜头。导入件不挂任何生成任务，所以 `voicedStoryboardIds` 那条
 * 按任务算的路永远看不见它——只能顺着镜头上的指针查文件行还在不在。
 */
export async function importedVoiceStoryboardIds(db: PrismaClient, storyboardIds: string[]): Promise<Set<string>> {
  if (storyboardIds.length === 0) return new Set()
  const shots = await db.storyboard.findMany({
    where: { id: { in: storyboardIds }, importedVoiceArtifactId: { not: null } },
    select: { id: true, importedVoiceArtifactId: true },
  })
  const artifactIds = shots.map(shot => shot.importedVoiceArtifactId).filter((id): id is string => Boolean(id))
  if (artifactIds.length === 0) return new Set()
  const present = new Set(
    (await db.mediaArtifact.findMany({ where: { id: { in: artifactIds }, stage: 'AUDIO' }, select: { id: true } })).map(artifact => artifact.id),
  )
  return new Set(shots.filter(shot => shot.importedVoiceArtifactId && present.has(shot.importedVoiceArtifactId)).map(shot => shot.id))
}

/** What the composer recorded per shot for audio: which source fed the master. */
export function manifestAudio(manifest: string): Record<string, { mode: string; ambienceArtifactId: string | null }> | null {
  try {
    const parsed = JSON.parse(manifest) as { audio?: unknown }
    if (!parsed.audio || typeof parsed.audio !== 'object') return null
    const out: Record<string, { mode: string; ambienceArtifactId: string | null }> = {}
    for (const [shotId, entry] of Object.entries(parsed.audio as Record<string, unknown>)) {
      const value = entry as { mode?: unknown; ambienceArtifactId?: unknown }
      if (typeof value?.mode === 'string') {
        out[shotId] = { mode: value.mode, ambienceArtifactId: typeof value.ambienceArtifactId === 'string' ? value.ambienceArtifactId : null }
      }
    }
    return out
  } catch {
    return null
  }
}

/**
 * 人改了声音来源或换了本镜环境音，母带里的音轨就是旧的——与成片钦定同一套语义：
 * 改主意必须能重出片。老母带没有 audio 段，只有真有人钦定过才算变。
 */
async function audioChanged(db: PrismaClient, episodeId: string, manifest: string): Promise<boolean> {
  const shots = await db.storyboard.findMany({
    where: { episodeId, supersededAt: null },
    select: { id: true, dialogue: true, audioSource: true, importedAmbienceArtifactId: true },
  })
  const recorded = manifestAudio(manifest)
  if (!recorded) return shots.some(shot => shot.audioSource !== null || shot.importedAmbienceArtifactId !== null)
  return shots.some(shot => recorded[shot.id]?.mode !== recordedAudioMode(shot.dialogue, shot.audioSource)
    || (recorded[shot.id]?.ambienceArtifactId ?? null) !== shot.importedAmbienceArtifactId)
}

/** Order matters: the manifest is the cut order, not a set of ids. */
function sameShots(manifest: string[], live: string[]): boolean {
  return manifest.length === live.length && manifest.every((id, index) => id === live[index])
}

/**
 * V03 排队时解析并冻结的合成输入:worker 只消费这份快照。编辑 JSON 只是其中
 * 「剪辑结构」那一层;声音/字幕/配音/环境音/配乐/选版都是可变状态,必须在排队
 * 那一刻定格——否则「排队后改字幕,新字幕混进旧任务」的污染无法杜绝。
 */

/**
 * 一颗镜头入片的那一段（或那几段）。S2c 把超长镜拆成同镜连续段后，母带不再等于
 * 「一次调用的产物」：一段重跑就会产一颗新母带，段集也换了。消费链若只记母带号，
 * 旧母带与新母带在快照里就长得一样，旧渲染能冒充当前。
 */
export interface CompositionTake {
  order: number
  /** 这一段计划买多长；单段/存量镜头没有拼接计划时如实为 null，不编一个数顶上。 */
  plannedMs: number | null
  videoArtifactId: string
  firstFrameArtifactId: string | null
  endFrameArtifactId: string | null
}

/**
 * 母带自带的段集：worker 拼接时把 `role:'spliced-master'` 与逐段产物写进 artifact
 * metadata。这是唯一「与母带同生」的段集来源——ShotTake 行反映库里此刻的状态，
 * 人工钦定一颗旧母带时它会指向更新的段，用它定格就等于把新段集塞进旧母带的快照。
 * 少于两段不算拼接：单段镜头就是一刀，不需要段集。
 */
export function splicedMasterTakes(metadata: string | null | undefined): CompositionTake[] | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata) as { role?: unknown; takes?: unknown }
    if (parsed.role !== 'spliced-master' || !Array.isArray(parsed.takes) || parsed.takes.length < 2) return null
    const takes: CompositionTake[] = []
    for (const [index, item] of (parsed.takes as unknown[]).entries()) {
      const take = item as { order?: unknown; plannedMs?: unknown; videoArtifactId?: unknown; firstFrameArtifactId?: unknown; endFrameArtifactId?: unknown }
      if (typeof take?.videoArtifactId !== 'string') return null
      takes.push({
        order: typeof take.order === 'number' ? take.order : index + 1,
        plannedMs: typeof take.plannedMs === 'number' ? take.plannedMs : null,
        videoArtifactId: take.videoArtifactId,
        firstFrameArtifactId: typeof take.firstFrameArtifactId === 'string' ? take.firstFrameArtifactId : null,
        endFrameArtifactId: typeof take.endFrameArtifactId === 'string' ? take.endFrameArtifactId : null,
      })
    }
    return takes
  } catch {
    return null
  }
}

/**
 * 整集段集指纹：逐镜按剪辑顺序拼出「这镜的母带由哪几段、各段接在哪一帧上」。
 * 任一镜换母带、任一段换产物或换帧链落点都会让它变。
 */
export function compositionTakeSignature(shots: Array<{ storyboardId: string; videoArtifactId: string | null; takes: CompositionTake[] }>): string {
  const perShot = shots.map(shot => {
    const takes = shot.takes
      .map(take => `${take.order}:${take.videoArtifactId}:${take.firstFrameArtifactId ?? '-'}:${take.endFrameArtifactId ?? '-'}`)
      .join(',')
    return `${shot.storyboardId}=${shot.videoArtifactId ?? '-'}[${takes}]`
  })
  return createHash('sha256').update(perShot.join('|')).digest('hex')
}

/** 本次合成冻结的段集指纹；S2d 之前排队的合成没有这个数，返回 null 表示无从判起。 */
export function manifestTakeSignature(manifest: string): string | null {
  try {
    const parsed = JSON.parse(manifest) as { resolved?: { takeSignature?: unknown } }
    return typeof parsed.resolved?.takeSignature === 'string' ? parsed.resolved.takeSignature : null
  } catch {
    return null
  }
}

/**
 * 整集转场指纹（S4②）：逐镜按剪辑顺序定格「这一刀怎么进」——类型 + 毫秒。
 * 与段集指纹分两轴：段集变了是「入片的画面换了」，转场变了是「同一批画面之间的
 * 接法换了」，返修时人要看的读数不同，合成失效时也要能各说各的。
 */
export function compositionTransitionSignature(shots: Array<{ storyboardId: string; transition: string; transitionMs: number }>): string {
  return createHash('sha256').update(shots.map(shot => `${shot.storyboardId}:${shot.transition}:${shot.transitionMs}`).join('|')).digest('hex')
}

/** 本次合成冻结的转场指纹；S4② 之前排队的合成没有这个数，返回 null 表示无从判起。 */
export function manifestTransitionSignature(manifest: string): string | null {
  try {
    const parsed = JSON.parse(manifest) as { resolved?: { transitionSignature?: unknown } }
    return typeof parsed.resolved?.transitionSignature === 'string' ? parsed.resolved.transitionSignature : null
  } catch {
    return null
  }
}

export interface ResolvedCompositionInputs {
  /** 每个可见片段:视频制品、声音输入、字幕文本,全部按排队时现状定格。 */
  shots: Array<{
    storyboardId: string
    clipId?: string
    /** 排队时解析出的视频制品(null=当时就没有,渲染时按缺素材阻断)。 */
    videoArtifactId: string | null
    videoSource: 'edit' | 'manual' | 'auto'
    trimInFrame: number | null
    trimOutFrame: number | null
    dialogue: string
    /** 烧画面的字幕文本(人改过用人的,没改过=台词)——排队时定格。 */
    subtitle: string
    /** 排队时的声音来源档位(null=镜型默认)。 */
    audioSource: string | null
    /** 排队时解析出的人声制品(需要人声且当时可得;null=无人声)。 */
    voiceArtifactId: string | null
    /** 排队时的环境音指针。 */
    ambienceArtifactId: string | null
    /**
     * 这一刀怎么进（S4②）：类型 + 毫秒，排队时定格。分镜表上写的转场是编辑意图，
     * 意图在渲染期可变就意味着同一修订能渲染出两种接法——那修订就不止一个成片。
     */
    transition: string
    transitionMs: number
    /** 这一镜的入片段集：拼接镜是母带自带的多段，其余是单段（含存量镜头）。 */
    takes: CompositionTake[]
    /** 同组固化总长：只有多段才有；段计划长度不全时如实为 null。 */
    spliceMs: number | null
  }>
  /** 排队时最新的配乐制品;null=当时没有配乐。 */
  musicArtifactId: string | null
  /**
   * 连续段进时间线的口径（S2d 拍板）：`master-clip` = 一镜一刀，刀指向拼好的
   * 母带，段本身不进编辑文档。选它而不是「一段一刀」：段与段之间本就不该有转场，
   * 让它们各自成刀就等于把接缝交给时间线，帧链的意义当场作废。
   */
  takeCut: 'master-clip'
  /** 整集段集指纹，见 compositionTakeSignature。 */
  takeSignature: string
  /** 整集转场指纹，见 compositionTransitionSignature。 */
  transitionSignature: string
}

interface EditSnapshotForResolve {
  clips: Array<{ clipId: string; storyboardId: string; artifactId: string; sourceInFrame: number; sourceOutFrame: number }>
}

/**
 * 解析合成输入(排队侧):视频按「编辑显式 → 人工钦定(归属有效) → 最新成功」
 * 定格;人声按 resolveShotAudio 同一口径定格;配乐取当时最新。这里不做阻断裁决
 * (归属/锁定校验留给渲染侧,针对定格值查不变事实),只把可变状态变成常量。
 */
async function resolveCompositionInputs(
  db: PrismaClient,
  organizationId: string,
  episodeId: string,
  editSnapshot: EditSnapshotForResolve | undefined,
  storyboardIds: string[],
): Promise<ResolvedCompositionInputs> {
  const visible = editSnapshot
    ? editSnapshot.clips.filter(clip => !clip.clipId.startsWith('__hidden__'))
    : storyboardIds.map(id => ({ clipId: '', storyboardId: id, artifactId: '', sourceInFrame: 0, sourceOutFrame: 0 }))
  const shotRows = await db.storyboard.findMany({
    where: { id: { in: visible.map(clip => clip.storyboardId) } },
    select: {
      id: true, durationMs: true, dialogue: true, subtitleText: true, audioSource: true,
      importedVoiceArtifactId: true, importedAmbienceArtifactId: true, selectedVoiceArtifactId: true,
      selectedVideoArtifactId: true, lockedVideoSelection: true, transition: true, transitionMs: true,
    },
  })
  const shotById = new Map(shotRows.map(row => [row.id, row]))

  const shots: ResolvedCompositionInputs['shots'] = []
  for (const clip of visible) {
    const shot = shotById.get(clip.storyboardId) ?? null
    // 视频:编辑显式指定优先;否则人工钦定(归属解析过才算);否则当时最新成功。
    let videoArtifactId: string | null = null
    let videoSource: 'edit' | 'manual' | 'auto' = 'auto'
    if (editSnapshot && clip.artifactId !== '') {
      videoArtifactId = clip.artifactId
      videoSource = 'edit'
    } else if (shot?.selectedVideoArtifactId) {
      const owned = (await resolveVideoArtifactShot(db, shot.selectedVideoArtifactId, organizationId))?.storyboardId === shot.id
      if (owned) {
        videoArtifactId = shot.selectedVideoArtifactId
        videoSource = 'manual'
      }
    }
    if (videoArtifactId === null && !shot?.lockedVideoSelection) {
      const latest = await db.mediaArtifact.findFirst({
        where: { stage: 'VIDEO', organizationId, task: { status: 'SUCCEEDED', stage: 'VIDEO', storyboardId: clip.storyboardId } },
        orderBy: [{ task: { createdAt: 'desc' } }, { version: 'desc' }],
        select: { id: true },
      })
      videoArtifactId = latest?.id ?? null
    }
    // 连续段定格：母带自带段集就是这一镜入片的那几段；带不出的（单段、存量镜头、
    // 导入件）包成 order=1 的唯一 take——方案里「存量迁移」要的就是这个形态，
    // 编辑文档因此一行都不用重写。
    let takes: CompositionTake[] = []
    if (videoArtifactId) {
      const master = await db.mediaArtifact.findUnique({
        where: { id: videoArtifactId },
        select: { metadata: true, durationMs: true },
      })
      takes = splicedMasterTakes(master?.metadata) ?? [{
        order: 1,
        plannedMs: master?.durationMs ?? shot?.durationMs ?? null,
        videoArtifactId,
        firstFrameArtifactId: null,
        endFrameArtifactId: null,
      }]
    }
    // 人声:与 worker resolveShotAudio 同一选择序,但只定格 id,不读字节。
    const dialogue = shot?.dialogue ?? ''
    const audioSource = shot?.audioSource ?? null
    let voiceArtifactId: string | null = null
    if (masterNeedsVoice(dialogue, audioSource)) {
      if (audioSource === 'IMPORTED') {
        voiceArtifactId = shot?.importedVoiceArtifactId ?? null
      } else {
        const chosen = shot?.selectedVoiceArtifactId
          ? await db.mediaArtifact.findFirst({
              where: { id: shot.selectedVoiceArtifactId, stage: 'AUDIO', task: { status: 'SUCCEEDED', storyboardId: clip.storyboardId } },
              select: { id: true },
            })
          : null
        const latest = chosen ?? await db.mediaArtifact.findFirst({
          where: { stage: 'AUDIO', organizationId, task: { status: 'SUCCEEDED', stage: 'AUDIO', storyboardId: clip.storyboardId } },
          orderBy: [{ task: { createdAt: 'desc' } }, { version: 'desc' }],
          select: { id: true },
        })
        voiceArtifactId = latest?.id ?? shot?.importedVoiceArtifactId ?? null
      }
    }
    shots.push({
      storyboardId: clip.storyboardId,
      ...(editSnapshot && clip.clipId !== '' ? { clipId: clip.clipId } : {}),
      videoArtifactId,
      videoSource,
      trimInFrame: editSnapshot && clip.sourceInFrame > 0 ? clip.sourceInFrame : null,
      trimOutFrame: editSnapshot && clip.sourceOutFrame > 0 ? clip.sourceOutFrame : null,
      dialogue,
      subtitle: shot?.subtitleText ?? dialogue,
      audioSource,
      voiceArtifactId,
      ambienceArtifactId: shot?.importedAmbienceArtifactId ?? null,
      ...resolveTransition(shot?.transition, shot?.transitionMs),
      takes,
      spliceMs: takes.length > 1 && takes.every(take => take.plannedMs !== null)
        ? takes.reduce((sum, take) => sum + (take.plannedMs ?? 0), 0)
        : null,
    })
  }

  const music = await db.mediaArtifact.findFirst({
    where: { organizationId, stage: 'MUSIC', task: { status: 'SUCCEEDED', stage: 'MUSIC', batch: { episodeId } } },
    orderBy: [{ task: { createdAt: 'desc' } }, { version: 'desc' }],
    select: { id: true },
  })
  return {
    shots,
    musicArtifactId: music?.id ?? null,
    takeCut: 'master-clip' as const,
    takeSignature: compositionTakeSignature(shots),
    transitionSignature: compositionTransitionSignature(shots),
  }
}

/** Writes the composition row and queues the compose job; the caller owns the audit. */
export async function createComposition(store: PipelineStore, organizationId: string, episodeId: string, storyboardIds: string[]): Promise<string> {
  // Q03:排队时冻结编辑快照——resolved clips/tracks/outputSpec/fps 与修订指纹整体
  // 进 manifest,worker 只消费这份快照;排队后改编辑/改选版不再影响本次合成。
  const edit = await store.db.episodeEdit.findUnique({
    where: { episodeId },
    include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } },
  })
  const head = edit?.revisions[0]
  const editSnapshot = head
    ? {
        revisionId: head.id,
        revision: head.revision,
        fpsNum: head.fpsNum,
        fpsDen: head.fpsDen,
        fingerprint: head.fingerprint,
        clips: JSON.parse(head.clips),
        tracks: JSON.parse(head.tracks),
        outputSpec: (() => { try { return JSON.parse(head.outputSpec) } catch { return {} } })(),
      }
    : undefined
  // V03:声音/字幕/配音/环境音/配乐/选版全部在排队时解析定格——编辑快照只定格
  // 剪辑结构,这些可变输入若仍读执行时现状,同一修订不可重现。
  const resolved = await resolveCompositionInputs(store.db, organizationId, episodeId, editSnapshot, storyboardIds)
  const composition = await store.db.$transaction(async tx => {
    const row = await tx.composition.create({ data: { episodeId, status: 'RUNNING', manifest: JSON.stringify({ storyboardIds, ...(editSnapshot ? { editSnapshot } : {}), resolved }) } })
    await recordJobIntent(tx, { kind: 'compose-episode', compositionId: row.id, episodeId, organizationId })
    return row
  })
  await store.enqueueJob({ kind: 'compose-episode', compositionId: composition.id, episodeId, organizationId })
  return composition.id
}

/**
 * 产品层的单镜时长上限。真正的上限取「项目档位 / 绑定模型单次能力 / 产品上限」
 * 三者最小（见 resolveShotDurationCeiling）——模型再长也只到这里，30 秒以上
 * 的连续内容应在分镜层拆镜，而不是让一个镜头独自撑满。
 *
 * 具体时长由内容决定：短反应可以短到模型允许的下限，完整台词或连续动作才用
 * 更长。这里给出的是范围，不是每镜必须买满的固定值。
 */
export const MAX_SHOT_DURATION_MS = 30_000
/** 设置页与预审共同使用的可选档位；模型没声明的档不会出现在这里。 */
export const SHOT_DURATION_TIERS_MS = [10_000, 15_000, 30_000] as const
/** 模型没有声明时长时的保守值：能生成，但任何档位都不向用户开放。 */
export const FALLBACK_SHOT_DURATION_MS = 5_000

export interface ShotDurationCeiling {
  /** 项目设置里的单镜上限；null = 跟随绑定。 */
  projectMs: number | null
  /** 当前绑定链里声明的单次最长；null = 没有任何候选声明。 */
  modelMs: number | null
  productMs: number
  /** 三取最小的结果，也是每镜真正能买到的上限。 */
  effectiveMs: number
  /** 设置页可选的档位；模型声明没有覆盖到的档不出现。 */
  selectableMs: number[]
}

/**
 * 三取最小。退化声明（没有 min 或没有 max）不参与推能力——把一句「5 或 10」
 * 读成「10 以内任意值」正是旧实现被实测打回的那一类猜测。
 */
export function resolveShotDurationCeiling(
  projectMs: number | null,
  declared: { minMs: number; maxMs: number }[],
  productMs = MAX_SHOT_DURATION_MS,
): ShotDurationCeiling {
  const modelMs = declared.length === 0 ? null : Math.max(...declared.map(spec => spec.maxMs))
  const effectiveMs = modelMs === null ? FALLBACK_SHOT_DURATION_MS : Math.min(projectMs ?? modelMs, modelMs, productMs)
  // 可选档位问的是「买了这个模型还能选到哪一档」，上限是模型与产品，不是当前有效值：
  // 按有效值过滤会让项目一旦选了 10s 就再也选不到 15/30s，设置页失去上调入口。
  const selectableMs = modelMs === null
    ? []
    : SHOT_DURATION_TIERS_MS.filter(tier => tier <= Math.min(modelMs, productMs) && declared.some(spec => spec.minMs <= tier && tier <= spec.maxMs))
  return { projectMs, modelMs, productMs, effectiveMs, selectableMs }
}

export interface ShotDurationAssessment {
  /** 能覆盖有效上限的候选里最保守的声明下限。 */
  minMs: number
  /** 有效上限：项目档、模型能力、产品上限三者最小。 */
  maxMs: number
  ceiling: ShotDurationCeiling
  /** 每条候选在这个槽位里真正能买到的区间（已吃过实测证据）。 */
  offers: ShotDurationOffer[]
}

/** 一条候选的可用时长区间，给人看的字段与给调度用的 capabilityId 同源。 */
export interface ShotDurationOffer {
  capabilityId: string
  connectionName: string
  provider: string
  model: string
  displayName: string | null
  minMs: number
  maxMs: number
  /** probe 把声明压下来的事实；doc/manual 只作标注，不改区间。 */
  evidence: { source: string; checkedAt: string; verifiedSeconds?: number; declaredSeconds?: number } | null
}

/**
 * 当前绑定链与项目档位共同决定的单镜时长。设置页读数、分镜提示词、视频触发
 * 共用这一份口径——三处各算一次必然分叉。
 */
export async function targetShotDurationPlan(db: PrismaClient, organizationId: string, projectId: string): Promise<ShotDurationAssessment> {
  const [conditioning, textToVideo, project] = await Promise.all([
    resolveSlotCandidates(db, organizationId, projectId, 'video_i2v'),
    resolveSlotCandidates(db, organizationId, projectId, 'video_t2v'),
    db.project.findFirst({ where: { id: projectId, organizationId }, select: { maxShotDurationMs: true } }),
  ])
  const offers: ShotDurationOffer[] = []
  const seen = new Set<string>()
  for (const candidate of [...conditioning, ...textToVideo]) {
    if (seen.has(candidate.capabilityId)) continue
    seen.add(candidate.capabilityId)
    // 只有 probe 能压低有效上限：声明是厂商文档，实测是这条连接真正产出过的长度。
    const evidence = readDurationEvidence(candidate.durationEvidence)
    const spec = capDurationSpec(readDurationSpec(candidate.spec), evidence)
    const min = minDurationSeconds(spec)
    const max = maxDurationSeconds(spec)
    if (min === undefined || max === undefined) continue
    offers.push({
      capabilityId: candidate.capabilityId,
      connectionName: candidate.connectionName,
      provider: candidate.provider,
      model: candidate.model,
      displayName: candidate.displayName,
      minMs: min * 1000,
      maxMs: max * 1000,
      evidence: evidence
        ? { source: evidence.source, checkedAt: evidence.checkedAt, ...(evidence.verifiedSeconds === undefined ? {} : { verifiedSeconds: evidence.verifiedSeconds }), ...(evidence.declaredSeconds === undefined ? {} : { declaredSeconds: evidence.declaredSeconds }) }
        : null,
    })
  }
  const declared = offers.map(offer => ({ minMs: offer.minMs, maxMs: offer.maxMs }))
  const ceiling = resolveShotDurationCeiling(project?.maxShotDurationMs ?? null, declared)
  // 回退候选也可能接手这一镜,所以下限取「能覆盖本档上限的候选」里最大声明的
  // 最小值——最保守的那一个能接住,整条链就都能接住。没有声明时退回固定档。
  const capable = declared.filter(spec => spec.maxMs >= ceiling.effectiveMs)
  const minMs = capable.length === 0 ? ceiling.effectiveMs : Math.min(Math.max(...capable.map(spec => spec.minMs)), ceiling.effectiveMs)
  return { minMs, maxMs: ceiling.effectiveMs, ceiling, offers }
}

export interface ShotDurationGap {
  targetMs: number
  plannedMs: number
  gapMs: number
}

/**
 * 目标总时长与逐镜计划时长之和的缺口。分镜写短了，成片就会短于交付承诺；
 * 这个数只有在人确认后才能继续花钱。
 */
export function shotDurationGap(targetMs: number | null, storyboards: { durationMs: number }[]): ShotDurationGap | null {
  if (targetMs === null) return null
  const plannedMs = storyboards.reduce((sum, shot) => sum + shot.durationMs, 0)
  return { targetMs, plannedMs, gapMs: Math.max(0, targetMs - plannedMs) }
}

/** 超长镜的三条出口。同镜拼接与拆成两镜都不加钱，换模型可能更贵。 */
export type ShotDurationStrategy = 'splice' | 'split' | 'switch_model'

export interface ShotDurationDecision {
  storyboardId: string
  strategy: ShotDurationStrategy
  /** strategy=switch_model 时点名覆盖意图的那条候选；缺省取候选链里第一条覆盖它的。 */
  capabilityId?: string
}

export interface ShotDurationOption {
  strategy: ShotDurationStrategy
  available: boolean
  /** splice：这一镜要接几段。 */
  takeCount?: number
  /** splice：每段买到多长（有效上限）。 */
  perTakeMs?: number
  /** switch_model：覆盖意图的那条候选。 */
  capabilityId?: string
  connectionName?: string
  provider?: string
  model?: string
  displayName?: string | null
  maxMs?: number
}

export interface ShotDurationPreflight {
  storyboardId: string
  number: number
  title: string
  /** 分镜写的意图时长。 */
  intentMs: number
  /** 当前候选链真正能买到的单次上限。 */
  ceilingMs: number
  overByMs: number
  options: ShotDurationOption[]
}

/**
 * 批准前的超长镜预检。分镜写 40 s、模型只卖 10 s 时，静默把 40 s 变成 10 s
 * 是本项目最贵的一类错误：钱花了，戏没了。这里把每一镜超出的部分摆出来，
 * 三条出口各自可用与否都按事实算：
 *
 * - 同镜拼接：一段接一段，片长凑够；段数 = ceil(意图/上限)，帧链由生成侧保证。
 * - 拆成两镜：分镜层改写，平台不替人编剧情；选它意味着先去改镜头表。
 * - 换模型：候选链里真有一条覆盖意图（且不超过产品 30 s 上限）才可用。
 */
export function preflightShotDurations(
  shots: { id: string; number: number; title: string; durationMs: number }[],
  assessment: ShotDurationAssessment,
  productMs = MAX_SHOT_DURATION_MS,
): ShotDurationPreflight[] {
  // 整条候选链都没声明时长时，5 秒只是排期用的保守值，不是能力证据。拿它当硬上限
  // 会把每一颗正常镜头都判成超长，再让人在「拼接/拆镜/换模型」里三选一——这是拿
  // 编出来的数倒逼创作决定。此时只剩产品 30 秒这条真约束。
  const ceilingMs = assessment.ceiling.modelMs === null ? productMs : assessment.maxMs
  return shots.flatMap(shot => {
    if (shot.durationMs <= ceilingMs) return []
    const takeCount = Math.ceil(shot.durationMs / ceilingMs)
    const covering = assessment.offers.filter(offer => offer.minMs <= shot.durationMs && offer.maxMs >= shot.durationMs)
    const chosen = shot.durationMs <= productMs ? covering[0] : undefined
    return [{
      storyboardId: shot.id,
      number: shot.number,
      title: shot.title,
      intentMs: shot.durationMs,
      ceilingMs,
      overByMs: shot.durationMs - ceilingMs,
      options: [
        { strategy: 'splice', available: takeCount >= 2, takeCount, perTakeMs: Math.ceil(shot.durationMs / Math.max(takeCount, 1)) },
        { strategy: 'split', available: true },
        {
          strategy: 'switch_model',
          available: chosen !== undefined,
          ...(chosen
            ? { capabilityId: chosen.capabilityId, connectionName: chosen.connectionName, provider: chosen.provider, model: chosen.model, displayName: chosen.displayName, maxMs: chosen.maxMs }
            : {}),
        },
      ],
    }]
  })
}

/**
 * The frame each shot may condition its own clip with: the newest FIRST_FRAME artifact of
 * a task that succeeded **for that shot**, minus any artifact a quality check sent back for
 * review. A frame an auditor or a human rejected is exactly the defect the review exists to
 * catch, and conditioning a paid clip on it would propagate it into the finished film; a
 * frame nobody judged at all is still usable, because the audit is optional and its absence
 * is not a verdict. A shot with neither contributes no reference — and when a conditioning
 * model is bound, `triggerStage` refuses the whole VIDEO stage over such shots rather than
 * letting them fall back to text-to-video silently: an unconditioned clip does not carry the
 * character's face across a cut.
 */
export async function usableFirstFrames(
  db: PrismaClient,
  organizationId: string,
  episodeId: string,
  storyboardIds: string[],
): Promise<Map<string, string>> {
  if (storyboardIds.length === 0) return new Map()
  const batchIds = (await db.generationBatch.findMany({ where: { episodeId }, select: { id: true } })).map(b => b.id)
  const artifacts = await db.mediaArtifact.findMany({
    where: {
      organizationId,
      stage: 'FIRST_FRAME',
      qualityChecks: { none: { status: 'NEEDS_REVIEW' } },
      task: {
        status: 'SUCCEEDED',
        storyboardId: { in: storyboardIds },
        batchId: { in: batchIds },
      },
    },
    select: { id: true, task: { select: { storyboardId: true } } },
    orderBy: [{ createdAt: 'desc' }, { version: 'desc' }],
  })
  const newest = new Map<string, string>()
  for (const artifact of artifacts) {
    const shotId = artifact.task?.storyboardId
    if (shotId && !newest.has(shotId)) newest.set(shotId, artifact.id)
  }
  // 钦定优先：人挑过的那一帧是"这一镜的画面基准"，胜过机器猜的"最新"。指针悬空
  // （版本被删/跨镜/未过审回炉）即回退最新成功版——选择不是死锁。
  const chosen = await db.storyboard.findMany({
    where: { id: { in: storyboardIds }, selectedFrameArtifactId: { not: null } },
    select: { id: true, selectedFrameArtifactId: true },
  })
  for (const shot of chosen) {
    const artifactId = shot.selectedFrameArtifactId!
    if (artifacts.some(artifact => artifact.id === artifactId)) newest.set(shot.id, artifactId)
  }
  return newest
}

/** 参与绑定对账的镜头字段。分镜落库时匹配过一次，之后素材新增/改名不会再触发。 */
export interface ReconcileShot {
  id: string
  title: string
  description: string
  dialogue: string
  speaker: string | null
  location: string | null
  lockedReferences: boolean
}

/**
 * 触发前补绑的差集：「按同一套匹配规则本该绑定、库里还没有」的镜头↔素材。
 * 跳过 lockedReferences——那是人手动指定过参考图的镜头，自动匹配不许覆盖人的选择。
 */
export async function missingShotAssetLinks(
  db: PrismaClient,
  shots: ReconcileShot[],
  assets: { id: string; name: string; kind: string }[],
): Promise<ShotAssetLink[]> {
  const unlocked = shots.filter(shot => !shot.lockedReferences)
  if (unlocked.length === 0 || assets.length === 0) return []
  const existing = await db.storyboardAsset.findMany({
    where: { storyboardId: { in: unlocked.map(shot => shot.id) } },
    select: { storyboardId: true, assetId: true },
  })
  const bound = new Set(existing.map(link => `${link.storyboardId}:${link.assetId}`))
  return matchShotAssetLinks(unlocked, assets).filter(link => !bound.has(`${link.storyboardId}:${link.assetId}`))
}

/**
 * 素材审批门要点名的素材：已绑定里未定稿的，加上待补绑定里素材本身未定稿的。
 * 待补绑定的存在不是「未审批」——触发端会先 reconcile 自动补上，预审/自动推进
 * 若把链接缺失也算成草稿，门就永远打不开，哪怕素材早已定稿。
 */
function draftAssetNames(
  links: { asset: { name: string; status: string } }[],
  pending: ShotAssetLink[],
  assets: { id: string; name: string; status: string }[],
): string[] {
  const pendingIds = new Set(pending.map(link => link.assetId))
  return [...new Set([
    ...links.filter(link => link.asset.status !== 'APPROVED').map(link => link.asset.name),
    ...assets.filter(asset => pendingIds.has(asset.id) && asset.status !== 'APPROVED').map(asset => asset.name),
  ])]
}

/**
 * 绑定只在分镜落库那一刻跑过一次：后补的场景/道具、后来才改到能对上的素材名，
 * 之后再也没有机会挂上——首帧提示词里既没有外观文字，也没有参考图。每次触发
 * 图像/视频前做一次只增不删的对账，让「素材晚建」不再是一条死路。
 */
export async function reconcileShotAssetLinks(
  db: PrismaClient,
  shots: ReconcileShot[],
  assets: { id: string; name: string; kind: string }[],
): Promise<number> {
  const missing = await missingShotAssetLinks(db, shots, assets)
  if (missing.length === 0) return 0
  await db.storyboardAsset.createMany({ data: missing, skipDuplicates: true })
  return missing.length
}

/**
 * 场景主帧的分组键：一个场次可以跨六个地点（卧室→浴室→厨房→电梯…），"场"
 * 回答不了"这一镜在哪个景"。有地点列时按地点分组；字卡/黑屏/播放器这类没有
 * 实景的镜头不参与——它们不该被别的镜头等成主帧。旧数据没有地点时回退场次号。
 */
export function sceneMasterGroupKey(shot: { location: string | null; sceneNumber: number | null }): { key: string; label: string } | null {
  const location = shot.location?.trim() ?? ''
  if (location !== '') {
    if (!isSetLocation(location)) return null
    return { key: `place:${location.toLowerCase().replace(/\s+/g, '')}`, label: location }
  }
  return shot.sceneNumber === null ? null : { key: `scene:${shot.sceneNumber}`, label: `场景 ${shot.sceneNumber}` }
}

interface GenerationTarget {
  entityId: string
  prompt: string
  assetId?: string
  scriptVersionId?: string
  /** Set for the shot-scoped stages: the shot this task's artifact depicts. */
  storyboardId?: string
  /** Set when this shot's own frame may condition its clip: the artifact to send. */
  referenceArtifactId?: string
  /** 首帧阶段的参考图:该镜头绑定素材已定稿的定妆照/设定图,按 角色→场景→道具 截到 3 张。 */
  assetReferenceArtifactIds?: string[]
  /** P7 守卫的改写/提醒留痕,随请求快照入库:"这条 prompt 被动过什么、为什么"的审计答案。 */
  guardFindings?: GuardFinding[]
  /** AUDIO 阶段的音效半边:无台词镜的声床任务,候选取 sfx 槽而不是 tts_voice。 */
  sfx?: boolean
  /**
   * VIDEO 阶段:这一镜计划的成片秒数,取自分镜行那个可编辑的时长。快照里存的是**请求值**,
   * 实际发出去的秒数由 worker 按当选模型的声明钉死——计划与账单必须是两个数,否则回看时
   * 分不清"我们想要 15 秒"和"我们买了 12 秒"。
   */
  durationSeconds?: number
  /**
   * S2b 批准决议：这一镜的意图超过单次上限时，人选的出口。splice 由生成侧接段，
   * switch_model 把点名候选排到这一镜链首。split 不进生成——它要求先改分镜。
   */
  durationPlan?: {
    strategy: 'splice' | 'switch_model'
    intentMs: number
    ceilingMs: number
    takeCount?: number
    perTakeMs?: number
    capabilityId?: string
    model?: string
    decidedAt: string
    /** splice 的逐段执行计划：段序、买多久、这一段写什么。worker 按它逐段提交。 */
    takes?: { order: number; plannedMs: number; promptDelta: string }[]
  }
  /** P7 拦截型守卫的落点:任务直接落 BLOCKED、不排队,绑定补齐后经重试路径复活。 */
  blockedReason?: string
}

/**
 * 把超长镜的批准决议写回分镜行。它既是审计留痕，也是下一次预检的上下文：
 * 同一条 16 s 意图在已经选过同镜拼接后，不该再问一遍。
 */
async function persistShotDurationPlans(db: PrismaClient, targets: GenerationTarget[]): Promise<void> {
  for (const target of targets) {
    if (!target.storyboardId || !target.durationPlan) continue
    await db.storyboard.update({
      where: { id: target.storyboardId },
      data: { durationPlan: target.durationPlan as unknown as Prisma.InputJsonValue },
    })
  }
}

/** 分镜行上留存的超长镜决议。读法只有一处，落库与消费不会各解一遍 JSON。 */
export interface ShotDurationPlanRecord {
  strategy: 'splice' | 'switch_model'
  intentMs: number
  ceilingMs: number
  takeCount?: number
  perTakeMs?: number
  capabilityId?: string
  model?: string
  decidedAt: string
}

export function readShotDurationPlan(value: unknown): ShotDurationPlanRecord | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const strategy = record.strategy
  if (strategy !== 'splice' && strategy !== 'switch_model') return null
  if (typeof record.intentMs !== 'number' || typeof record.ceilingMs !== 'number') return null
  return {
    strategy,
    intentMs: record.intentMs,
    ceilingMs: record.ceilingMs,
    ...(typeof record.takeCount === 'number' ? { takeCount: record.takeCount } : {}),
    ...(typeof record.perTakeMs === 'number' ? { perTakeMs: record.perTakeMs } : {}),
    ...(typeof record.capabilityId === 'string' ? { capabilityId: record.capabilityId } : {}),
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
    decidedAt: typeof record.decidedAt === 'string' ? record.decidedAt : '',
  }
}

/** 一镜的连续段计划。拆点、段长与每段契约都在这里一次算清。 */
export function planShotTakeSegments(
  shot: { durationMs: number; description: string; lines: unknown; continuityIn: string; continuityOut: string; ambience: string | null },
  decision: { ceilingMs: number },
): TakePlan {
  return planShotTakes({
    durationMs: shot.durationMs,
    maxTakeMs: decision.ceilingMs,
    lines: normalizeShotLines(shot.lines),
    description: shot.description,
    continuityIn: shot.continuityIn,
    continuityOut: shot.continuityOut,
    ambience: shot.ambience,
  })
}

export interface ShotTakePlanEntry {
  storyboardId: string
  plan: TakePlan
}

/**
 * 把连续段计划写进 ShotTake 表。计划与库里已有的段完全一致时保留原行——已经付过
 * 钱出好的段不因为一次重触发被清零；形状变了才替换整套。`reset` 用于重生成：
 * 计划不变，但已出的片与帧链作废，等 worker 重拍。
 */
export async function persistShotTakes(
  db: Prisma.TransactionClient,
  entries: readonly ShotTakePlanEntry[],
  options: { reset?: boolean } = {},
): Promise<number> {
  let written = 0
  for (const { storyboardId, plan } of entries) {
    const existing = await db.shotTake.findMany({ where: { storyboardId }, orderBy: { order: 'asc' } })
    const sameShape = existing.length === plan.takes.length && existing.every((row, index) => {
      const take = plan.takes[index]!
      return row.order === take.order && row.plannedMs === take.plannedMs && row.promptDelta === take.promptDelta
    })
    if (sameShape) {
      if (options.reset) {
        await db.shotTake.updateMany({
          where: { storyboardId },
          data: { firstFrameArtifactId: null, endFrameArtifactId: null, videoArtifactId: null, status: 'DRAFT', selected: false },
        })
        written += existing.length
      }
      continue
    }
    await db.shotTake.deleteMany({ where: { storyboardId } })
    await db.shotTake.createMany({
      data: plan.takes.map(take => ({ storyboardId, order: take.order, plannedMs: take.plannedMs, promptDelta: take.promptDelta })),
    })
    written += plan.takes.length
  }
  return written
}

/** Everything a trigger needs: a database and a way to enqueue pipeline jobs. */
export interface PipelineStore {
  db: PrismaClient
  enqueueJob(payload: PipelinePayload): Promise<void>
}

export type TriggerResult = { ok: true; batchId: string; created: boolean } | { ok: false; code: number; error: string; reasons?: string[] }

export type AdvanceResult =
  | { ok: true; step: 'stage'; stage: PipelineStage; batchId: string; created: boolean }
  | { ok: true; step: 'composition'; compositionId: string }
  | { ok: false; code: number; error: string; reasons?: string[] }

async function audit(db: PrismaClient, entry: { organizationId: string; userId: string | null; action: string; entityType: string; entityId: string; payload?: unknown }): Promise<void> {
  await db.auditEvent.create({
    data: {
      organizationId: entry.organizationId,
      userId: entry.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      payload: JSON.stringify(entry.payload ?? {}),
    },
  })
}

/**
 * The next generation stage whose prerequisites are satisfied and which has not
 * yet run for this episode, or null when nothing is currently runnable. A stage
 * counts as run when a batch exists for its database stage value — IMAGE runs as
 * FIRST_FRAME, so the comparison goes through `stageDbValues` rather than the API
 * name. Prerequisites mirror the trigger gates: SCRIPT needs an approved source and
 * no approved script yet, STORYBOARD/IMAGE/VIDEO an approved script, ASSET at least
 * one authored asset, and IMAGE/VIDEO at least one live storyboard.
 *
 * A shot-scoped batch whose shots have all been superseded no longer counts as
 * run: the media it made belongs to a previous breakdown, so the stage has to run
 * again for the shots the episode actually uses. That is what carries the chain
 * downstream after a regenerate instead of stalling it on stages that "already
 * ran". A batch that targeted no shots at all has nothing to go stale on.
 */
/**
 * What the chain should do next: run a stage, stop on a human gate that is not
 * satisfied yet, or nothing (null). A block is not a skip — an unmet gate means a
 * human decision is missing, and advancing past it would either burn money on the
 * wrong inputs or stall later with a confusing error. Only an unbound model (no
 * verified candidates) is allowed to skip, and that skip lives in advancePipeline.
 */
export type NextStageResult =
  | { stage: PipelineStage }
  | { blocked: PipelineStage; error: string; reasons?: string[] }

export async function nextRunnableStage(
  db: PrismaClient,
  episodeId: string,
  options: { skip?: ReadonlySet<PipelineStage> } = {},
): Promise<NextStageResult | null> {
  const [approvedSource, approvedScript, assetCount, liveShots, dialogueCount, batches, liveBatches] = await Promise.all([
    db.sourceDocumentVersion.findFirst({ where: { episodeId, status: 'APPROVED' }, select: { id: true } }),
    db.scriptVersion.findFirst({ where: { episodeId, status: 'APPROVED' }, select: { id: true } }),
    db.asset.count({ where: { episodeId } }),
    // 镜头生成方式要参与就绪判定：整集都是字卡/合成/UI 时，IMAGE/VIDEO 没有可排的镜头，
    // 不该被当成"还没跑"卡住整条自动推进。
    db.storyboard.findMany({
      where: { episodeId, supersededAt: null },
      select: { id: true, title: true, description: true, dialogue: true, speaker: true, location: true, lockedReferences: true, method: true },
    }),
    db.storyboard.count({ where: { episodeId, supersededAt: null, dialogue: { not: '' } } }),
    db.generationBatch.findMany({ where: { episodeId }, select: { stage: true, _count: { select: { storyboards: true } } } }),
    db.generationBatch.findMany({ where: { episodeId, storyboards: { some: { supersededAt: null } } }, select: { stage: true } }),
  ])
  const storyboardCount = liveShots.length
  const generatedShotCount = liveShots.filter(shot => needsGeneratedMedia(shot.method)).length
  const coveringLiveShots = new Set<Stage>(liveBatches.map(batch => batch.stage))
  const run = new Set<Stage>(batches.filter(batch => batch._count.storyboards === 0 || coveringLiveShots.has(batch.stage)).map(batch => batch.stage))

  for (const stage of PIPELINE_STAGES) {
    if (options.skip?.has(stage)) continue
    if (run.has(stageDbValues[stage])) continue
    // An approved script is what SCRIPT exists to produce, so a human who derived or
    // wrote the script themselves has already produced it: planning the stage anyway
    // would buy a generation nobody asked for and leave a second draft behind.
    // AUDIO only voices shots that speak, so a shotless or dialogue-free episode
    // never owes it; MUSIC follows the visuals in chain order but needs no more
    // than an approved script and a live breakdown.
    const ready =
      stage === 'SCRIPT' ? approvedSource !== null && approvedScript === null
      : stage === 'STORYBOARD' ? approvedScript !== null
      : stage === 'ASSET' ? assetCount > 0
      : stage === 'AUDIO' ? approvedScript !== null && dialogueCount > 0
      : stage === 'IMAGE' || stage === 'VIDEO' ? approvedScript !== null && generatedShotCount > 0
      : approvedScript !== null && storyboardCount > 0
    if (!ready) continue
    // 素材审批是首帧的人工闸门:首帧按素材外观生成,素材还在草稿就该停在这里让人定稿,
    // 而不是绕过去烧首帧的额度。检查的是活镜头实际绑定的素材——没被引用的素材不拦路。
    // 本机镜头不消费素材，它们的绑定也不该把首帧阶段拦在门外。
    if (stage === 'IMAGE' && generatedShotCount > 0) {
      const generatedShots = liveShots.filter(shot => needsGeneratedMedia(shot.method))
      const generatedIds = new Set(generatedShots.map(shot => shot.id))
      const [links, assets] = await Promise.all([
        db.storyboardAsset.findMany({ where: { storyboardId: { in: [...generatedIds] } }, include: { asset: true } }),
        db.asset.findMany({ where: { episodeId }, select: { id: true, name: true, kind: true, status: true } }),
      ])
      // 触发时会把缺的绑定补上（只增不删），这里的门必须与触发同一口径，
      // 否则自动推进会一头撞进触发端的 409。
      const pending = await missingShotAssetLinks(db, generatedShots, assets)
      const drafts = draftAssetNames(links, pending, assets)
      if (drafts.length > 0) return { blocked: stage, error: 'generations:assetsNotApproved', reasons: drafts }
    }
    return { stage }
  }
  return null
}

/**
 * Plans and enqueues one stage for an episode: resolves the gate, builds each
 * target's prompt (content stages inject the approved upstream text), creates the
 * batch and its tasks, and queues a run-task job per task. Idempotent on
 * `${episodeId}:${stage}:${entityId}` — re-triggering a stage that already ran
 * creates nothing for its succeeded targets, but re-queues the ones that FAILED
 * (with the slot's current candidates), so pressing "generate the missing" after
 * a quota burnout retries exactly what is missing instead of doing nothing.
 * Targets the earlier run never covered get a fresh batch of their own.
 *
 * `regenerate` re-runs a stage that already produced a batch (after a human edits
 * the upstream it was generated from). It appends a revision suffix so the new run
 * gets fresh keys instead of colliding with the prior batch, which stays intact for
 * traceability. Regenerating a stage that never ran is just its first run.
 */
export async function triggerStage(
  store: PipelineStore,
  organizationId: string,
  userId: string | null,
  episodeId: string,
  stage: GenerationStage,
  options: { storyboardIds?: string[]; assetIds?: string[]; promptNote?: string; regenerate?: boolean; styleId?: string; acceptDurationGap?: boolean; durationDecisions?: ShotDurationDecision[]; runClaim?: { requestKey: string; token: string } } = {},
): Promise<TriggerResult> {
  const { db } = store
  const episode = await db.episode.findFirst({
    where: { id: episodeId, project: { organizationId } },
    // Superseded shots are history: generating media for them would pay for clips
    // belonging to a breakdown the episode no longer uses, and connecting them to
    // the batch would make the composition walk shots that were replaced.
    include: {
      project: {
        include: { stylePreset: true },
      },
      storyboards: { where: { supersededAt: null }, orderBy: [{ revision: 'asc' }, { number: 'asc' }] },
      assets: { orderBy: { id: 'asc' } },
    },
  })
  if (!episode) return { ok: false, code: 404, error: 'Episode not found' }
  // 目标总时长与逐镜计划时长之和的缺口：分镜写短了，成片就短于交付承诺。
  // 只有 VIDEO 参与——其他阶段买的是文字、图或声音，不是成片时长。
  const durationGap = stage === 'VIDEO'
    ? shotDurationGap(episode.targetDurationMs ?? episode.project.targetDurationMs ?? null, episode.storyboards)
    : null
  // 审计共用：确认过的缺口也要留下「目标多少、计划多少、差多少」三个数。
  const gapAudit = durationGap
    ? { durationTargetMs: durationGap.targetMs, durationPlannedMs: durationGap.plannedMs, durationGapMs: durationGap.gapMs }
    : {}
  // Read off the project rather than passed in, so a human triggering a stage and
  // the worker advancing into it build the same prompt for the same episode.
  const locale: ContentLocale = isContentLocale(episode.project.contentLocale) ? episode.project.contentLocale : 'zh'
  // 首帧必须落在交付画幅里：qwen-image 不指定 size 时会按提示词自选分辨率，
  // 同一条提示两次能出两种画幅；合成端只补黑边不裁切，宽高比错了就是成片里的黑框。
  const imageAspect = stage === 'IMAGE' ? projectAspect(episode.project.recipeSnapshot, episode.project.format) : null

  // 风格预设解析:显式传入优先,其次回落项目默认风格,都找不到则报错
  let style: StylePreset | undefined
  if (options.styleId) {
    // 1. 代码内置
    style = getStyleById(options.styleId)
    // 2. DB(官方+本组织)
    if (!style) {
      const dbStyle = await db.stylePreset.findFirst({
        where: {
          id: options.styleId,
          OR: [{ isOfficial: true }, { organizationId }],
        },
      })
      if (dbStyle) {
        style = {
          id: dbStyle.id,
          name: dbStyle.name,
          description: dbStyle.description,
          isOfficial: dbStyle.isOfficial,
          visualStyle: dbStyle.visualStyle ?? '',
          tone: dbStyle.tone ?? '',
          colorPalette: dbStyle.colorPalette ?? undefined,
          cameraStyle: dbStyle.cameraStyle ?? undefined,
          extraPrompt: dbStyle.extraPrompt ?? undefined,
        }
      }
    }
    // 3. 显式传入但解析不到 → 报错
    if (!style) return { ok: false, code: 400, error: 'styles:notFound' }
  } else if (episode.project.stylePresetId) {
    // 回落:使用项目默认风格
    if (episode.project.stylePreset) {
      const sp = episode.project.stylePreset
      style = {
        id: sp.id,
        name: sp.name,
        description: sp.description,
        isOfficial: sp.isOfficial,
        visualStyle: sp.visualStyle ?? '',
        tone: sp.tone ?? '',
        colorPalette: sp.colorPalette ?? undefined,
        cameraStyle: sp.cameraStyle ?? undefined,
        extraPrompt: sp.extraPrompt ?? undefined,
      }
    } else {
      style = getStyleById(episode.project.stylePresetId)
    }
  }

  const perStoryboard = stage === 'IMAGE' || stage === 'VIDEO' || stage === 'AUDIO'
  const perAsset = stage === 'ASSET'
  const requestedShots = perStoryboard
    ? options.storyboardIds
      ? episode.storyboards.filter(storyboard => options.storyboardIds!.includes(storyboard.id))
      : episode.storyboards
    : []
  if (perStoryboard) {
    if (options.storyboardIds && requestedShots.length !== new Set(options.storyboardIds).size) return { ok: false, code: 400, error: 'storyboardIds must belong to this episode' }
    if (requestedShots.length === 0) return { ok: false, code: 400, error: 'episode has no storyboards to generate' }
  }
  // 分镜表的「生成方式」列：字卡/屏幕录制/合成/UI 由人在剪辑里做，平台替它们
  // 排队只会买回一堆没人用的图。显式点名这类镜头时报错并点号，整批触发时静默跳过；
  // AUDIO 不看这一列——本机镜头也可能有台词，那句配音照样要平台出。
  const mediaStage = stage === 'IMAGE' || stage === 'VIDEO'
  const selected = mediaStage ? requestedShots.filter(storyboard => needsGeneratedMedia(storyboard.method)) : requestedShots
  if (mediaStage && options.storyboardIds) {
    const local = requestedShots.filter(storyboard => !needsGeneratedMedia(storyboard.method)).map(storyboard => `#${storyboard.number}`)
    if (local.length > 0) return { ok: false, code: 400, error: 'generations:shotNotGenerated', reasons: local }
  }
  if (mediaStage && selected.length === 0) return { ok: false, code: 400, error: 'generations:nothingToGenerate' }
  // 超长镜决议在排队前定下来：这一镜的意图超过有效上限时，选同镜拼接还是换模型，
  // 不能再由「请求时长被静默夹到 10 s」替人决定。拆成两镜不在这里执行——它要求
  // 先改分镜，所以只记录选择并在下面的门里退回。
  const durationAssessment = stage === 'VIDEO' ? await targetShotDurationPlan(db, organizationId, episode.projectId) : null
  const durationPreflight = durationAssessment ? preflightShotDurations(selected, durationAssessment) : []
  const durationDecisions = new Map<string, ShotDurationDecision>()
  for (const decision of options.durationDecisions ?? []) {
    if (!durationPreflight.some(item => item.storyboardId === decision.storyboardId)) {
      return { ok: false, code: 400, error: 'generations:unexpectedDurationDecision', reasons: [decision.storyboardId] }
    }
    if (durationDecisions.has(decision.storyboardId)) {
      return { ok: false, code: 400, error: 'generations:duplicateDurationDecision', reasons: [`#${durationPreflight.find(item => item.storyboardId === decision.storyboardId)!.number}`] }
    }
    durationDecisions.set(decision.storyboardId, decision)
  }
  const durationPlanByShot = new Map<string, NonNullable<GenerationTarget['durationPlan']>>()
  const splitDecided = new Set<string>()
  for (const item of durationPreflight) {
    const decision = durationDecisions.get(item.storyboardId)
    if (decision?.strategy === 'split') {
      splitDecided.add(item.storyboardId)
      continue
    }
    if (!decision) continue
    const decidedAt = new Date().toISOString()
    if (decision.strategy === 'splice') {
      const splice = item.options.find(option => option.strategy === 'splice')
      if (!splice?.available || !splice.takeCount) return { ok: false, code: 400, error: 'generations:shotDurationSpliceUnavailable', reasons: [`#${item.number}`] }
      durationPlanByShot.set(item.storyboardId, {
        strategy: 'splice',
        intentMs: item.intentMs,
        ceilingMs: item.ceilingMs,
        takeCount: splice.takeCount,
        perTakeMs: splice.perTakeMs ?? item.ceilingMs,
        decidedAt,
      })
      continue
    }
    const offer = item.options.find(option => option.strategy === 'switch_model')
    if (!offer?.available || !offer.capabilityId) return { ok: false, code: 400, error: 'generations:shotDurationModelMissing', reasons: [`#${item.number}`] }
    if (decision.capabilityId && decision.capabilityId !== offer.capabilityId) {
      return { ok: false, code: 400, error: 'generations:shotDurationModelMissing', reasons: [`#${item.number}`] }
    }
    durationPlanByShot.set(item.storyboardId, {
      strategy: 'switch_model',
      intentMs: item.intentMs,
      ceilingMs: item.ceilingMs,
      capabilityId: offer.capabilityId,
      model: offer.model,
      decidedAt,
    })
  }
  // 已经批准过的决议不再每轮重问一遍：分镜行留着的「同一意图」决议直接沿用。
  // 意图时长被人改过就不再沿用——那是新问题，要重新做一次取舍。
  for (const item of durationPreflight) {
    if (durationPlanByShot.has(item.storyboardId) || splitDecided.has(item.storyboardId)) continue
    const shot = selected.find(storyboard => storyboard.id === item.storyboardId)
    const stored = readShotDurationPlan(shot?.durationPlan)
    if (!stored || stored.intentMs !== item.intentMs) continue
    if (stored.strategy === 'splice') {
      const splice = item.options.find(option => option.strategy === 'splice')
      if (!splice?.available || !splice.takeCount) continue
      durationPlanByShot.set(item.storyboardId, {
        ...stored,
        ceilingMs: item.ceilingMs,
        takeCount: splice.takeCount,
        perTakeMs: splice.perTakeMs ?? item.ceilingMs,
      })
    } else {
      const offer = item.options.find(option => option.strategy === 'switch_model')
      if (!offer?.available || !offer.capabilityId) continue
      durationPlanByShot.set(item.storyboardId, { ...stored, ceilingMs: item.ceilingMs, capabilityId: offer.capabilityId, model: offer.model })
    }
  }
  // 同镜拼接的执行计划：拆点、段长、每段契约一次算清，落库并与请求快照同源。
  // 计划本身不合规时在花任何钱之前退回——接不上的段，买回来也只是废片。
  const takePlansByShot = new Map<string, TakePlan>()
  const takeEntries: ShotTakePlanEntry[] = []
  for (const [storyboardId, plan] of durationPlanByShot) {
    if (plan.strategy !== 'splice') continue
    const shot = selected.find(storyboard => storyboard.id === storyboardId)
    if (!shot) continue
    const takes = planShotTakeSegments(shot, { ceilingMs: plan.ceilingMs })
    const findings = auditShotTakes({ durationMs: shot.durationMs, maxTakeMs: plan.ceilingMs, takes: takes.takes })
    if (findings.length > 0) {
      return { ok: false, code: 409, error: 'generations:shotTakesInvalid', reasons: findings.map(finding => `#${shot.number} ${finding.detail}`) }
    }
    plan.takeCount = takes.takes.length
    plan.takes = takes.takes.map(take => ({ order: take.order, plannedMs: take.plannedMs, promptDelta: take.promptDelta }))
    takePlansByShot.set(storyboardId, takes)
    takeEntries.push({ storyboardId, plan: takes })
  }
  const durationAudit = durationPlanByShot.size > 0
    ? { durationDecisions: [...durationPlanByShot.entries()].map(([storyboardId, plan]) => ({ storyboardId, strategy: plan.strategy, takeCount: plan.takeCount, model: plan.model })) }
    : {}
  const takesAudit = takePlansByShot.size > 0
    ? { takesPlanned: [...takePlansByShot.entries()].map(([storyboardId, plan]) => ({ storyboardId, takeCount: plan.takes.length, splitAt: plan.splitAt })) }
    : {}
  if (perAsset && episode.assets.length === 0) return { ok: false, code: 400, error: 'episode has no assets to generate' }
  // A single-asset regeneration passes assetIds; without it the stage targets every
  // asset the episode has.
  const selectedAssets = perAsset
    ? options.assetIds
      ? episode.assets.filter(asset => options.assetIds!.includes(asset.id))
      : episode.assets
    : []
  if (perAsset && options.assetIds && selectedAssets.length !== new Set(options.assetIds).size) {
    return { ok: false, code: 400, error: 'assetIds must belong to this episode' }
  }
  if (perAsset && selectedAssets.length === 0) return { ok: false, code: 400, error: 'episode has no assets to generate' }
  // IMAGE 首帧的一致性来自这里:把分镜绑定的素材外观描述注入提示词。没有这一步,
  // 每个镜头的角色长相全靠文字碰运气,跨镜头必然崩。
  // 文字之外再带上定稿的定妆照本体:绑定素材的 APPROVED 版本 artifact 会作为参考图
  // 随请求发给声明接受参考图的图像模型(qwen-image-3.0 / 2.0-pro 一代),角色长相才有真正的锚点。
  // 整条链上没有一个模型收参考图时,这一镜在计划层就落 BLOCKED——不许降级成纯文生图出片。
  const assetContexts = new Map<string, string>()
  const assetReferences = new Map<string, string[]>()
  // P7 守卫的事实底座:每镜的绑定计数与绑定角色(含画面文本没点名的角色)。
  // 上面的素材上下文只服务"画面里出现的";画面里有人却没点名时,外观锚点由守卫接住——
  // 两者共用同一份 links 与同一个可见性判定,口径不会分叉。
  const shotGuardInfo = new Map<string, { boundAssetCount: number; characters: GuardCharacterInfo[] }>()
  // 场景主帧的事实底座：按地点聚合每处首镜（编号最小），首镜的可用钦定帧=该景主帧。
  // usableFirstFrames 已是「钦定优先，悬空回退最新」——主帧跟人的选择走。
  const sceneFirstByShot = new Map<string, { id: string; number: number; label: string }>()
  const sceneMasterFrames = new Map<string, string>()
  const blockedByMaster = new Map<string, string>()
  if (stage === 'IMAGE') {
    const sceneShots = await db.storyboard.findMany({
      where: { episodeId: episode.id, supersededAt: null },
      select: { id: true, location: true, sceneNumber: true, number: true, method: true },
    })
    const firstByGroup = new Map<string, { id: string; number: number; label: string }>()
    const groupByShot = new Map<string, { key: string; label: string }>()
    for (const shot of sceneShots) {
      // 本机镜头不会产出首帧：它当了某景首镜，同景的生成镜头就会永远等一张
      // 不会到来的主帧。
      if (!needsGeneratedMedia(shot.method)) continue
      const group = sceneMasterGroupKey(shot)
      // 字卡/黑屏/播放器这类镜头没有实景，不参与主帧分组，也不把别人的等待引到它身上。
      if (!group) continue
      const current = firstByGroup.get(group.key)
      if (!current || shot.number < current.number) firstByGroup.set(group.key, { id: shot.id, number: shot.number, label: group.label })
      groupByShot.set(shot.id, group)
    }
    // 每镜指向「它所在景的首镜」——不是它自己（首镜映射写反曾让闸门永不触发）。
    for (const [shotId, group] of groupByShot) {
      sceneFirstByShot.set(shotId, firstByGroup.get(group.key)!)
    }
    const nonFirstSelected = selected.filter(storyboard => {
      const first = sceneFirstByShot.get(storyboard.id)
      return first != null && first.id !== storyboard.id
    })
    const firstIds = [...new Set(nonFirstSelected.map(storyboard => sceneFirstByShot.get(storyboard.id)!.id))]
    if (firstIds.length > 0) {
      const masters = await usableFirstFrames(db, organizationId, episode.id, firstIds)
      for (const id of firstIds) {
        const artifactId = masters.get(id)
        if (artifactId) sceneMasterFrames.set(id, artifactId)
      }
    }
  }
  if (stage === 'IMAGE' || stage === 'VIDEO') {
    // 落库时匹配过一次，素材晚建/晚改名就漏了。触发前补齐（只增不删，人锁过的镜头不动），
    // 之后这次查询读到的就是补齐后的全部绑定。
    await reconcileShotAssetLinks(db, selected, episode.assets)
    const links = await db.storyboardAsset.findMany({
      where: { storyboardId: { in: selected.map(storyboard => storyboard.id) } },
      include: {
        asset: {
          include: {
            versions: {
              where: { status: 'APPROVED', artifactId: { not: null } },
              orderBy: { version: 'desc' },
              take: 1,
              select: { artifactId: true },
            },
          },
        },
      },
    })
    if (stage === 'IMAGE') {
      // 素材审批是首帧阶段的真门禁:首帧按素材的外观生成,带着草稿素材跑,
      // 用户随后改了定妆描述,首帧就白烧了。拦下并点名素材,让人先定稿;
      // 一镜也没有绑定素材时无事可拦,直接放行。
      const drafts = [...new Set(links.filter(link => link.asset.status !== 'APPROVED').map(link => link.asset.name))]
      if (drafts.length > 0) return { ok: false, code: 409, error: 'generations:assetsNotApproved', reasons: drafts }
    }
    // 参考图槽位有限,选取顺序就是一致性优先级:角色(脸)→ 场景(基调)→ 道具。
    const REFERENCE_ORDER: Record<string, number> = { character: 0, scene: 1, prop: 2 }
    // 单角色剧目里「他/她」只能指那唯一一个角色：画面文本出现代词时把它的定妆照
    // 当锚点；素材多于一个时不猜——猜错就是把别人的脸画进画面。
    const characterAssets = episode.assets.filter(asset => asset.kind === 'character')
    const soleCharacterId = characterAssets.length === 1 ? characterAssets[0]!.id : null
    for (const storyboard of selected) {
      // 文本与参考图必须同序同集:模型按"图N＝某素材"理解哪张定妆照对应谁,
      // 文本顺序和图顺序错位时,多角色镜头会出现张冠李戴的脸。
      const shotLinks = links
        .filter(link => link.storyboardId === storyboard.id)
        .sort((a, b) => (REFERENCE_ORDER[a.asset.kind] ?? 3) - (REFERENCE_ORDER[b.asset.kind] ?? 3))
      // 只送画面文本(标题+描述)真正提到的素材:台词/说话人里出现的人是画外音,
      // 送了定妆照反而诱导模型把不入场的人画进画面。场景是基调,不受此限。
      const visualText = `${storyboard.title} ${storyboard.description}`
      // 画面里会出现的素材：角色/道具按名字点名；单角色剧目允许「他/她」回退；
      // 场景是基调恒可见。只在台词/说话人里出现的角色是画外音，不算出场。
      const visible = (link: { asset: { id: string; kind: string; name: string } }) =>
        isShotVisible(link.asset, visualText, soleCharacterId)
      shotGuardInfo.set(storyboard.id, {
        boundAssetCount: shotLinks.length,
        characters: shotLinks
          .filter(link => link.asset.kind === 'character' && link.asset.status === 'APPROVED')
          .map(link => ({ name: link.asset.name, description: link.asset.description, mentioned: visible(link) })),
      })
      if (stage !== 'IMAGE') {
        // VIDEO(r2v)的参考图与首帧阶段同一过滤口径:只送画面里出现的角色+场景
        // (台词里说话的是画外音,送定妆照反而把不入场的人画进画面),顺序
        // 角色→场景→道具,上限 3——与 IMAGE 的 referenced 同一条规则。
        const referenced = shotLinks
          .filter(link => link.asset.versions[0]?.artifactId)
          .filter(visible)
          .slice(0, 3)
        if (referenced.length > 0) assetReferences.set(storyboard.id, referenced.map(link => link.asset.versions[0]!.artifactId!))
        continue
      }
      let referenced = shotLinks
        .filter(link => link.asset.versions[0]?.artifactId)
        .filter(visible)
        .slice(0, 3)
      // r06·A 场景主帧（用户拍板，首镜升格=零额外成本）：景内非首镜挂该景主帧为
      // 第 1 参考图——桌椅位置/光线方向/人物相对方位只有画面能钉死，文字锚点不够。
      // 主帧未就绪（首镜还没跑完）时该镜落 BLOCKED 等待，重试路径自动复活。
      let masterLine: string | null = null
      const sceneFirst = sceneFirstByShot.get(storyboard.id)
      if (sceneFirst && sceneFirst.id !== storyboard.id) {
        const masterArtifactId = sceneMasterFrames.get(sceneFirst.id)
        if (!masterArtifactId) {
          blockedByMaster.set(storyboard.id, `等待「${sceneFirst.label}」主帧：先生成并钦定该景首镜（#${sceneFirst.number}）的首帧，再重试这一镜`)
        } else {
          masterLine = `图1＝场景主帧｜同一场景、换机位基准：环境布局、桌椅位置、光线方向与主帧一致；人物按下方空间连续与外观参考执行，不复刻主帧的景别与构图`
          referenced = referenced.slice(0, 2)
          assetReferences.set(storyboard.id, [masterArtifactId, ...referenced.map(link => link.asset.versions[0]!.artifactId!)])
        }
      }
      // 只写画面里真会出现的素材；画外音角色连文字描述都不进提示词，否则模型会把人画进来。
      const rest = shotLinks.filter(link => !referenced.includes(link) && visible(link))
      const lines: string[] = []
      if (referenced.length > 0 || masterLine) {
        // 定妆照参考图本身是多角度排版,模型容易把排版也复刻进画面——实测出过双格/三格拼图。
        lines.push('输出要求:只生成一幅连续的单画面(电影分镜中的一帧);不要多格拼图、分屏、网格或三视图排版;参考图仅用于锁定人物与物体的外观,不要复刻参考图的排版布局。')
        lines.push('随附参考图按顺序对应以下素材。每一张参考图约束且仅约束它对应的那个人物/物体——画面中出现几个人,就必须严格执行几套外观:')
        lines.push('- 第 N 张参考图上的人 = 提示词里「图N＝」标注的那个人,不是其他人:长相、年龄感、发型、体型、穿着都以该张参考图为准;')
        lines.push('- 多个人物时,不同参考图之间的年龄差、发型差、体态差必须如实体现在画面里——两套参考图差 30 岁,画出来也必须差 30 岁,不许平均化;')
        lines.push('- 外观一致是逐人逐物独立成立的:两个人像就照两张参考图画,像不像彼此由参考图本身决定(双胞胎的参考图本来就一样),不由模型自行调和。')
        if (masterLine) lines.push(masterLine)
        referenced.forEach((link, index) => {
          const sheetKind = link.asset.kind === 'character' ? '角色外观参考' : '设定图'
          lines.push(`图${index + 2}＝${sheetKind}｜${link.asset.kind}·${link.asset.name}：${link.asset.description}`)
        })
      }
      for (const link of rest) {
        lines.push(`其他出场素材｜${link.asset.kind}·${link.asset.name}：${link.asset.description}`)
      }
      if (lines.length > 0) assetContexts.set(storyboard.id, lines.join('\n'))
      if (referenced.length > 0 && !assetReferences.has(storyboard.id)) assetReferences.set(storyboard.id, referenced.map(link => link.asset.versions[0]!.artifactId!))
    }
  }

  // Content and media stages are gated on the upstream version a human approved:
  // a script is written from an approved source, storyboards are broken out of an
  // approved script, and no image/video/audio is generated until that script is
  // approved — otherwise money is spent on visuals nobody signed off on.
  let scriptVersionId: string | undefined
  let contentPrompt: string | undefined
  if (stage === 'SCRIPT') {
    const source = await db.sourceDocumentVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, orderBy: { version: 'desc' } })
    if (!source) return { ok: false, code: 409, error: 'generations:noApprovedSource' }
    // 形态只在这里分叉一次:电影把整本书(该集的源版本)提炼成一部电影的剧本,
    // 其余形态照旧逐集改写。下游阶段对形态无感——它们只消费集上的时长真值。
    const targetDurationMs = episode.targetDurationMs ?? undefined
    // 节奏契约只挂在带时长的剧本上：没有时长的集连篇幅预算都没有，谈平均镜长无意义。
    const rhythm = targetDurationMs === undefined ? undefined : resolveShotRhythm(episode.project.shotRhythm)
    contentPrompt = episode.project.format === 'FILM'
      ? buildFilmScriptPrompt(locale, source.content, targetDurationMs, rhythm)
      : buildScriptPrompt(locale, source.content, targetDurationMs, rhythm)
  }
  if (stage === 'STORYBOARD') {
    const script = await db.scriptVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, orderBy: { version: 'desc' } })
    if (!script) return { ok: false, code: 409, error: 'generations:noApprovedScript' }
    scriptVersionId = script.id
    contentPrompt = buildStoryboardPrompt(locale, script.content, { ...(await targetShotDurationPlan(db, organizationId, episode.projectId)), totalMs: episode.targetDurationMs ?? undefined }, undefined, style)
  }
  if (stage === 'IMAGE' || stage === 'VIDEO' || stage === 'AUDIO' || stage === 'MUSIC') {
    const script = await db.scriptVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, select: { id: true, content: true } })
    if (!script) return { ok: false, code: 409, error: 'generations:noApprovedScript' }
    if (stage === 'MUSIC') contentPrompt = buildMusicPrompt(locale, script.content)
  }

  const slot = stageSlots[stage]
  const candidates = await resolveSlotCandidates(db, organizationId, episode.projectId, slot)
  if (candidates.length === 0) return { ok: false, code: 409, error: `no verified candidates for slot ${slot}` }

  // 首帧的外观锚点只有接受参考图的出图模型能兑现。整条候选链里一个都没有时，
  // 带素材绑定的镜头照样能排队——worker 会把它静默降级成纯文生图，用户以为定妆照
  // 生效了，实际买回一张陌生的脸（2026-10-21 SD-066 实测）。这里按场景主帧同一条
  // BLOCKED 路径拦下：不预留调用、不入队，把参考图模型绑到首帧槽位后重试自动复活。
  const refCapableCandidates = stage === 'IMAGE' ? candidates.filter(candidate => candidate.acceptsReferenceImages) : []
  const referenceBlockedReason = (storyboardId: string): string | null => {
    if (stage !== 'IMAGE' || !assetReferences.has(storyboardId)) return null
    if (refCapableCandidates.length > 0) return null
    return `参考图模型缺失：这一镜绑定了定妆照，但首帧槽位里的候选（${candidates.map(candidate => candidate.model).join('、')}）都不接受参考图。到「模型中心 → 绑定」把一个支持参考图的出图模型绑到首帧，再重试这一镜`
  }

  // Conditioning is the optional half of VIDEO: with a video_i2v bound, a shot's own
  // approved frame becomes the input to its clip, which is what carries a character's face
  // across a cut. The gate does not move — an installation that never bound the slot pays
  // for exactly what it paid for before, and its snapshots keep the shape they had.
  const conditioning = stage === 'VIDEO'
    ? await resolveSlotCandidates(db, organizationId, episode.projectId, 'video_i2v')
    : []
  // VIDEO's identity half: with a video_r2v bound, a shot's approved asset sheets travel
  // to the model as reference images — the character-board anchor the IMAGE stage already
  // uses, now spent on the clip itself. Unbound installations never see it.
  const referenceModeling = stage === 'VIDEO'
    ? await resolveSlotCandidates(db, organizationId, episode.projectId, 'video_r2v')
    : []

  // A voice task exists only to speak a line; voicing a silent shot would buy
  // audio of nothing, and composition never waits for it. AUDIO still connects
  // the shots it actually planned so a later dialogue edit re-opens the stage.
  const voiced = stage === 'AUDIO' ? selected.filter(storyboard => storyboard.dialogue !== '') : selected
  // The silent half of AUDIO: a shot with no dialogue still owes the cut a sound bed
  // (rain, footsteps, doors). Only planned when an sfx model is bound — unbound
  // installations keep exactly the voice+music masters they had.
  const sfxCandidates = stage === 'AUDIO'
    ? await resolveSlotCandidates(db, organizationId, episode.projectId, 'sfx')
    : []
  const silent = stage === 'AUDIO' ? selected.filter(storyboard => storyboard.dialogue === '') : []
  const sfxShots = sfxCandidates.length > 0 ? silent : []
  if (stage === 'AUDIO' && voiced.length === 0 && sfxShots.length === 0) {
    return { ok: false, code: 400, error: 'episode has no shots with dialogue to voice' }
  }

  // The media prompts are deliberately not translated per locale: an asset image, a
  // shot frame and a clip are described by the storyboard text this stage consumes,
  // so they are already in the project's language. Only the voice line needs a
  // formatter, because a speaker marker is script convention rather than content.
  // 定妆照/设定图标准（对齐 docs/skills/film-production 的角色一致性要求）：
  // 角色图是身份锚点，必须多角度、中性背景、无文字——裸描述会生成剧照而非参考图。
  // 角色设定已从"白底三视图"升级为"角色板"（Character Board,2026 行业新标准）：
  // 一张竖版海报内集成身份信息+多角度脸部特写+全身三视图+服饰细节+表情集,
  // 信息密度远高于裸三视图,视频模型能读出更稳定的身份特征。
  // 规格只管版式与一致性，质感交给风格预设：参考图与首帧必须同一画风，
  // 否则逐镜都在跟定妆照打架。没选预设时才由下面这句兜住插画质感。
  // 文书条款只追加给真正需要文字的道具：它曾固定挂在所有道具规格里，
  // 床头钟因此被诱导在钟面印上「请参阅说明书」（2026-10-21 实测，0.65）。
  const TEXTUAL_PROP = /文书|书刊|证书|招牌|文件|告示|报纸|招贴|信件|合同|协议|书页/
  const ASSET_REFERENCE_SPECS: Record<string, string> = {
    character:
      '角色设定板（Character Board）：单张竖版海报式排版。内容按区块集成——①顶部角色名与身份标签；②脸部特写 4 个角度（正面/左右 45 度/侧面），眼神与表情各异；③全身三视图（正面/侧面/背面并排，头顶到脚底完整入画）；④服装与饰品细节拆解（绣纹、配饰、鞋履等圆形小图）；⑤表情参考 6 种小图（常态/喜/怒/惊/悲/思）。严格遵循描述中的年龄、性别与体型，不得幼化或美化；米白纯色背景，无水印；同一角色全板形象严格一致，一致性优先于美观。',
    scene: '场景概念图：无人物空镜，构图与光线符合描述，细节清晰；画面保持简洁，不添加描述之外的道具或装饰，不出现文字；无水印。',
    prop: '道具设定图：单品居中，中性背景，细节清晰，无水印。',
  }
  // 无预设时的质感基准沿用旧行为：规避"真人图像"内容审查（Seedance 2.0 等已明确拒绝
  // 照片级真人参考图），风格化本身也提升跨镜头一致性。选了预设，这句必须让位。
  const CHARACTER_MEDIUM_WITHOUT_STYLE = '渲染质感：CG 游戏立绘风格、插画质感（严禁照片级真人质感）'
  const assetKindById = new Map(selectedAssets.map(asset => [asset.id, asset.kind]))
  // 文字用途只看素材自身的名字与描述：合成后的 prompt 里包含道具规格，
  // 而规格本身就有「证书/招牌」这类词，拿整段去测会把每件道具都判成文书类。
  const assetTextById = new Map(selectedAssets.map(asset => [asset.id, `${asset.name} ${asset.description}`]))
  const targets: GenerationTarget[] = perAsset
    ? selectedAssets.map(asset => ({
        entityId: asset.id,
        prompt: [
          // 内部枚举与素材名不能拼成「标题：」交给模型——床头钟那次（2026-10-21 实测）
          // 被原样画成画面底部的道具标签，视觉审核判文字违规。角色板例外：
          // 它的版式本身就要求顶部角色名，名字必须进提示词。
          asset.kind === 'character'
            ? `角色设定板：${asset.name}。${asset.description}`
            : asset.description,
          ASSET_REFERENCE_SPECS[asset.kind],
          asset.kind === 'prop' && TEXTUAL_PROP.test(`${asset.name} ${asset.description}`)
            ? '文书/书刊类道具：标题按描述用简体中文呈现，正文文字一律虚化模糊（不可辨认具体字符），版式与材质贴近真实观感。'
            : undefined,
          asset.kind === 'character' && !style ? CHARACTER_MEDIUM_WITHOUT_STYLE : undefined,
        ].filter(Boolean).join('\n\n'),
        assetId: asset.id,
      }))
    : perStoryboard
      ? [...voiced.map(storyboard => ({
          entityId: storyboard.id,
          prompt: stage === 'AUDIO'
            ? voiceLine(locale, storyboard.speaker, storyboard.dialogue)
            : [
                `${storyboard.title}: ${storyboard.description}`,
                // 空间连续（2026-09-29 用户实测镜2）：首帧/视频独立生成，没有这段就不
                // 知道上一镜确立了"谁在哪"——切镜换机位不换空间事实。
                stage === 'IMAGE' || stage === 'VIDEO' ? (storyboard.continuityIn.trim() ? `空间连续（上一镜已确立，不得与之矛盾）：${storyboard.continuityIn.trim()}` : null) : null,
                stage === 'IMAGE' && assetContexts.has(storyboard.id) ? `画面中出现的素材：\n${assetContexts.get(storyboard.id)}` : null,
              ].filter(Boolean).join('\n\n'),
          storyboardId: storyboard.id,
          // 只有视频任务携带时长:图像阶段的 parameters 会被某些适配器原样铺进厂商体,
          // 一个多出来的时长键在那边是 400,不是特性。
          // 同镜拼接时这一次买的是单段长度；整镜意图写在 durationPlan 里，账单与计划分开。
          ...(stage === 'VIDEO'
            ? {
                ...(durationPlanByShot.has(storyboard.id) ? { durationPlan: durationPlanByShot.get(storyboard.id)! } : {}),
                durationSeconds: durationPlanByShot.get(storyboard.id)?.strategy === 'splice'
                  ? Math.max(1, Math.round((durationPlanByShot.get(storyboard.id)!.perTakeMs ?? storyboard.durationMs) / 1000))
                  : Math.max(1, Math.round(storyboard.durationMs / 1000)),
              }
            : {}),
          ...((stage === 'IMAGE' || stage === 'VIDEO') && assetReferences.has(storyboard.id) ? { assetReferenceArtifactIds: assetReferences.get(storyboard.id) } : {}),
          // 场景主帧未就绪的镜不排队不烧钱，重试路径在首镜落位后复活它。
          // 参考图模型缺失走同一出口：先按主帧等待，其次按参考图能力拦。
          ...(blockedByMaster.has(storyboard.id)
            ? { blockedReason: blockedByMaster.get(storyboard.id)! }
            : referenceBlockedReason(storyboard.id)
              ? { blockedReason: referenceBlockedReason(storyboard.id)! }
              : {}),
        })), ...sfxShots.map(storyboard => ({
          // 音效只服务无台词镜：台词镜的人声来自 TTS，画面动作与环境声落在氛围底
          // 那一格——提示词只描述「能听到什么」，不写画面、不写人声。
          entityId: storyboard.id,
          prompt: [`为这一镜生成环境/动作音效，无人声、无配乐：${storyboard.title}。${storyboard.description}`].filter(Boolean).join('\n\n'),
          storyboardId: storyboard.id,
          sfx: true,
        }))]
      : [{ entityId: episode.id, prompt: contentPrompt ?? episode.title, ...(scriptVersionId ? { scriptVersionId } : {}) }]

  // 画面文字语言规则与调整要求都在风格层之后再拼（见下）：提示词尾部权重最高，
  // 英文风格词收尾时，模型会把画面里的文字也渲染成英文（2026-09-28 实测：中文项目
  // 的房屋转让协议被画成 "AGREEMENT HOUSE TRANSFER"）。
  // 画面里允许出现文字的只有视觉阶段；文案阶段（剧本/分镜）不掺这条。
  const TEXT_LANGUAGE_RULE = locale === 'zh'
    ? '画面文字规则（最高优先级）：标题、标签、招牌等短文字一律使用简体中文，清晰可读；禁止出现可辨认的英文单词或字母；长文书类（协议/证书/书页）的正文文字可作虚化模糊处理，不必逐字可读，但不得出现可读的英文。'
    : 'Text rendered inside the image (titles, labels, signage) must be in English; long-form document body text may be rendered blurred, but no other language may appear.'
  // 禁令不逐项点名：把「招牌/证书/海报」写进提示词等于给模型递素材，2026-10-21
  // 第三次卧室重跑里这些词在 prompt 出现四遍，墙上就多出三只证书框和一张海报。
  // 改成正向约束「保持简洁、不添加描述之外的东西」，同一条规则不点名也在生效。
  const NO_TEXT_RULE = locale === 'zh'
    ? '画面文字规则（最高优先级）：画面中不出现任何文字或可读字符；画面保持简洁，不添加描述之外的道具与装饰。'
    : 'Text rule (highest priority): no text or readable characters anywhere in the image; keep the frame free of props and decorations not named in the description.'
  // 数字读数道具（床头钟 7:07）：NO_TEXT_RULE 会连描述里写明的读数一起禁掉。
  // 只对 prop 白名单放行描述原文里的读数，其余字符仍一律禁止——不让模型自行编数。
  const NUMERIC_DISPLAY = /\d{1,2}[:：]\d{2}/
  const numericDisplayRule = (prompt: string): string | null => {
    const readout = prompt.match(NUMERIC_DISPLAY)?.[0]
    if (!readout) return null
    return locale === 'zh'
      ? `画面文字规则（最高优先级）：画面中唯一允许出现的可读字符是数字读数 ${readout}，必须与描述逐字一致，不得改写、增加或减少字符；除此之外不出现任何文字；画面保持简洁，不添加描述之外的道具与装饰。`
      : `Text rule (highest priority): the only readable characters allowed are the numeric readout "${readout}", rendered exactly as written; no other text may appear; keep the frame free of props and decorations not named in the description.`
  }
  const assetTextRule = (kind: string | undefined, prompt: string) => {
    const numeric = kind === 'prop' ? numericDisplayRule(prompt) : null
    if (numeric) return numeric
    return kind === 'scene' || (kind === 'prop' && !TEXTUAL_PROP.test(prompt)) ? NO_TEXT_RULE : TEXT_LANGUAGE_RULE
  }
  const isVisualKind = stage === 'ASSET' || stage === 'IMAGE' || stage === 'VIDEO'
  // 运动忠实条款只进 VIDEO：视频模型一定会让画面动起来，不钉死就会自己发明动作
  // （2026-09-28 实测：「坐在长桌边一动不动，笔尖按在签字栏」被 wanx2.1-i2v-plus
  // 演成了 0.5 秒起笔、持续五秒的书写）。条款用白名单语义而不是动作黑名单——
  // 黑名单只拦得住这一集出过的事，下一集发明的会是别的动作；通用能力只能说
  // 「动作只能来自描述」，让描述本身说了算。
  const MOTION_RULE = stage === 'VIDEO'
    ? '运动规则（与画面文字规则同级）：画面中人物的一切动作与镜头运动只能来自上文描述明确写出的内容——描述没有写的动作不得出现。描述未提及任何动作时，只保持呼吸起伏、眨眼与光线的缓慢变化，机位固定、不推不拉。'
    : null
  // US-016 结构化控制确定性注入:景别/机位/运动/动作/情绪/负面约束——与自由描述、
  // 风格、参考、调整要求按固定顺序组合。null(=自动)不注入文本,不是写「自动」。
  const CONTROL_LABELS: Record<string, string> = {
    framing: '景别', cameraAngle: '机位', cameraMovement: '镜头运动',
    actionStart: '动作起', actionEnd: '动作止', mood: '情绪与节奏', negativePrompt: '禁止出现',
  }
  const FRAMING_LABELS: Record<string, string> = { close_up: '特写', medium: '中景', wide: '远全景', extreme_close_up: '大特写' }
  const ANGLE_LABELS: Record<string, string> = { eye_level: '平视', low: '低角度仰拍', high: '高角度俯拍', dutch: '倾斜机位', over_shoulder: '过肩' }
  const MOVEMENT_LABELS: Record<string, string> = { static: '固定机位', pan: '横摇', tilt: '纵摇', dolly: '推拉', handheld: '手持' }
  const controlsByShot = new Map<string, string | null>()
  if (isVisualKind && perStoryboard) {
    const shotIds = voiced.map(storyboard => storyboard.id)
    if (shotIds.length > 0) {
      const controls = await db.shotControl.findMany({ where: { storyboardId: { in: shotIds } } })
      for (const control of controls) {
        const parts: string[] = []
        if (control.framing) parts.push(`${CONTROL_LABELS.framing}: ${FRAMING_LABELS[control.framing] ?? control.framing}`)
        if (control.cameraAngle) parts.push(`${CONTROL_LABELS.cameraAngle}: ${ANGLE_LABELS[control.cameraAngle] ?? control.cameraAngle}`)
        if (control.cameraMovement) parts.push(`${CONTROL_LABELS.cameraMovement}: ${MOVEMENT_LABELS[control.cameraMovement] ?? control.cameraMovement}`)
        if (control.actionStart) parts.push(`${CONTROL_LABELS.actionStart}: ${control.actionStart}`)
        if (control.actionEnd) parts.push(`${CONTROL_LABELS.actionEnd}: ${control.actionEnd}`)
        if (control.mood) parts.push(`${CONTROL_LABELS.mood}: ${control.mood}`)
        if (control.negativePrompt) parts.push(`${CONTROL_LABELS.negativePrompt}: ${control.negativePrompt}`)
        controlsByShot.set(control.storyboardId, parts.length > 0 ? parts.join('; ') : null)
      }
    }
  }

  const tailTargets = isVisualKind
    ? targets.map(target => {
        const controlLine = target.storyboardId ? controlsByShot.get(target.storyboardId) : undefined
        const textRule = target.assetId
          ? assetTextRule(assetKindById.get(target.assetId), assetTextById.get(target.assetId) ?? '')
          : TEXT_LANGUAGE_RULE
        return {
          ...target,
          prompt: [target.prompt, controlLine, textRule, MOTION_RULE].filter(Boolean).join('\n\n'),
        }
      })
    : targets
  // 调整要求是人在这次重试里给的方向——必须真正压轴：拼在风格层之后。
  // 此前实现先拼 note 再叠风格，英文风格尾巴排到了最后，把人的方向压下去
  // （2026-09-29 用户重跑快照实测发现：调整要求后面还跟着 40 词的电影感尾巴）。
  const note = options.promptNote?.trim()
  // P7 Prompt 守卫:任务排队开烧前的最后一道机器检查,只管 IMAGE/VIDEO 这两个
  // "长相全靠提示词"的阶段。修复型改写 prompt、警告型只留痕、拦截型让任务直接
  // 落 BLOCKED 不排队;所有留痕随请求快照入库——审计要能回答"这条 prompt 被动过吗、为什么"。
  // 守卫链是有序数组(DEFAULT_PROMPT_GUARDS),增减规则不碰这里。
  const shotById = new Map(selected.map(storyboard => [storyboard.id, storyboard]))
  // 风格预设先于守卫链应用:style-anchor 认得出「视觉风格」标记就不叠加
  // 默认写实基准,显式选的风格永远赢;没有预设时守卫照旧兜底。
  // ASSET 也在内:定妆照是逐镜首帧的参考输入,它不吃风格的话全片画风从第一步就分叉。
  let promptedTargets: GenerationTarget[] = style && isVisualStyleStage(stage)
    ? tailTargets.map(target => ({
        ...target,
        prompt: applyStyleToPrompt(stage, target.prompt, style),
      }))
    : tailTargets
  if (note) {
    promptedTargets = promptedTargets.map(target => ({ ...target, prompt: `${target.prompt}\n\n调整要求：${note}` }))
  }
  promptedTargets = stage === 'IMAGE' || stage === 'VIDEO'
    ? promptedTargets.map(target => {
        const info = target.storyboardId ? shotGuardInfo.get(target.storyboardId) : undefined
        const shot = target.storyboardId ? shotById.get(target.storyboardId) : undefined
        const result = runPromptGuards(DEFAULT_PROMPT_GUARDS, target.prompt, {
          stage,
          ...(shot ? { shot: { number: shot.number, title: shot.title, description: shot.description } } : {}),
          ...(info ? { boundAssetCount: info.boundAssetCount, characters: info.characters } : {}),
        })
        return {
          ...target,
          prompt: result.prompt,
          ...(result.findings.length > 0 ? { guardFindings: result.findings } : {}),
          ...(result.blockedReason ? { blockedReason: result.blockedReason } : {}),
        }
      })
    // 没有守卫的阶段必须保留上一步的结果：回到 notedTargets 等于把风格又擦掉。
    : promptedTargets

  // A frame is only looked up when a model was bound that can take it: resolving one for a
  // request that would have to drop it spends a query to produce a number nobody reads.
  // r2v 不吃首帧(能力行不向 worker 携带 acceptsFirstFrame),帧只为 i2v 解析——
  // r2v 的主体锚是定妆照,与首帧同源(首帧本就是按定妆照生成的)。
  const frames = conditioning.length > 0
    ? await usableFirstFrames(db, organizationId, episode.id, promptedTargets.flatMap(target => target.storyboardId ? [target.storyboardId] : []))
    : new Map<string, string>()
  for (const target of promptedTargets) {
    const artifactId = target.storyboardId ? frames.get(target.storyboardId) : undefined
    if (artifactId) target.referenceArtifactId = artifactId
  }

  // 绑定了图生视频（video_i2v）时，首帧是角色一致性的载体：缺帧的镜头静默退回文生视频，
  // 会把额度烧在一段角色长相不锁定的片段上，还会混进成片——对短剧生产这不是容错，是事故。
  // 所以这里直接拦下并点名镜头，让人先补帧；只有从未绑定 video_i2v 的安装才保留纯文生视频路径。
  // 逐镜触发时 selected 只含那一镜，检查也就只针对它。
  if (stage === 'VIDEO' && conditioning.length > 0) {
    // 缺帧镜头若绑定 r2v 且带定妆照参考,不因缺帧拦下——定妆照就是它的主体锚,
    // 拦了等于逼人先补帧再走一条不需要帧的路。其余缺帧照旧拦,理由不变:
    // 静默退回文生视频会把额度烧在角色长相不锁定的片段上。
    const missing = selected
      .filter(storyboard => !frames.get(storyboard.id))
      .filter(storyboard => !(referenceModeling.length > 0 && (assetReferences.get(storyboard.id)?.length ?? 0) > 0))
      .map(storyboard => `#${storyboard.number}`)
    if (missing.length > 0) return { ok: false, code: 409, error: 'generations:videoMissingFrames', reasons: missing }
    // 首帧正在重新生成的镜头同样拦下:此刻放行,视频会按旧画面(或无画面)生成,
    // 新首帧落位后图文不符——又是一次白烧的额度。
    const inflight = await db.storyboard.findMany({
      where: {
        id: { in: selected.map(storyboard => storyboard.id) },
        generationTasks: { some: { stage: 'FIRST_FRAME', status: { in: ['QUEUED', 'RUNNING'] } } },
      },
      select: { number: true },
      orderBy: { number: 'asc' },
    })
    if (inflight.length > 0) {
      return { ok: false, code: 409, error: 'generations:frameInFlight', reasons: inflight.map(storyboard => `#${storyboard.number}`) }
    }
  }

  // 超长镜：逐镜触发也走这道门。以前「重跑单镜」正是绕过时长预检的那个口子，
  // 40 s 的意图会在这里被静默买成 10 s。缺决议时点名每一镜，缺帧这类硬错优先报。
  if (durationPreflight.length > 0) {
    const undecided = durationPreflight.filter(item => !durationPlanByShot.has(item.storyboardId) && !splitDecided.has(item.storyboardId))
    if (undecided.length > 0) {
      return { ok: false, code: 409, error: 'generations:shotDurationOverflow', reasons: undecided.map(item => `#${item.number} ${Math.round(item.intentMs / 1000)}s>${Math.round(item.ceilingMs / 1000)}s`) }
    }
    const split = durationPreflight.filter(item => splitDecided.has(item.storyboardId))
    if (split.length > 0) {
      return { ok: false, code: 409, error: 'generations:shotNeedsSplit', reasons: split.map(item => `#${item.number}`) }
    }
  }

  // 整集视频是一次批量购买：缺口必须先被人看见并确认。逐镜/流程触发的镜头集
  // 由调用方明确指定，属于修复单点，不在这道门内。放在所有既有门禁之后——
  // 没有已审批剧本、缺首帧这类「根本跑不起来」的错必须优先报出，缺口只是最后一道确认。
  if (durationGap && durationGap.gapMs > 0 && !options.storyboardIds && options.acceptDurationGap !== true) {
    return { ok: false, code: 409, error: 'generations:durationGap', reasons: [`${Math.ceil(durationGap.gapMs / 1000)}s`] }
  }

  const dbStage = stageDbValues[stage]
  // Carried only when it says something the provider would not otherwise know: a
  // Chinese task's snapshot keeps the exact shape it had before content languages
  // existed, so the default path is unchanged all the way to the vendor request.
  const localeField = locale === 'zh' ? {} : { contentLocale: locale }
  // A regenerate re-runs a stage that already has a batch, so it needs keys that do
  // not collide with the prior run. The revision is appended as a fourth segment,
  // leaving the first three (episode, stage, entity) readable.
  const revision = options.regenerate
    ? await db.generationBatch.count({ where: { episodeId: episode.id, stage: dbStage } })
    : 0
  const suffix = revision > 0 ? `:r${revision}` : ''
  const idempotencyKeys = promptedTargets.map(target => `${episode.id}:${stage}:${target.entityId}${suffix}`)
  // 快照重排与候选排序都按幂等键找目标:键 → 生成目标的索引,一次建立处处使用。
  const targetsByKey = new Map<string, GenerationTarget>()
  promptedTargets.forEach((target, index) => targetsByKey.set(idempotencyKeys[index], target))
  // A media task's reproducibility anchor: a seed derived from the idempotency key, so
  // the same task always promises the same take and a regenerate (a different key) draws
  // a fresh one. The worker rotates it per attempt — a rework that re-billed the exact
  // same bytes would be paying for a copy — so the snapshot records the base, not the
  // final number. Text stages carry no seed: the vendor rejects what it does not speak,
  // and only image and video models promise reproducibility this product relies on.
  const billableStages: readonly GenerationStage[] = ['ASSET', 'IMAGE', 'VIDEO']
  const parametersField = (target: GenerationTarget, key: string) => {
    if (!billableStages.includes(stage)) return {}
    const parameters: Record<string, unknown> = { seed: generationSeed(key) }
    // 平台自有的比例名，由适配器翻成厂商的 size；快照里不写厂商方言，
    // 否则换一个候选模型就得重写快照。
    if (stage === 'IMAGE' && imageAspect) parameters.aspectRatio = imageAspect
    // Written under the platform's own name, never a vendor's: this snapshot may be run by
    // any candidate in the slot, and spelling the length in one vendor's dialect would pin
    // the request to whichever adapter somebody imagined at trigger time.
    if (target.durationSeconds !== undefined) parameters[DURATION_KEY] = target.durationSeconds
    return { parameters }
  }
  // One task row's fields, keyed by its idempotency key. Shared by the fresh create and
  // by the catch path below, which builds rows for targets the first run never covered.
  const guardStats = (list: GenerationTarget[]) => {
    const findings = list.reduce((sum, target) => sum + (target.guardFindings?.length ?? 0), 0)
    const blocked = list.filter(target => target.blockedReason).length
    return findings + blocked > 0 ? { guardFindings: findings, guardsBlocked: blocked } : {}
  }
  // A reference is an id, not bytes: an approved 1080P frame encoded inline is
  // megabytes, and the artifact row already carries its checksum and mime type.
  // 首帧与定妆照是同一数组里的两种类型,必须合并而不是各自展开——两个分支都写
  // referenceArtifacts 键,后写的会把先写的整个覆盖掉(带帧又带参考图的任务会丢帧)。
  const referenceField = (target: GenerationTarget) => {
    const references = [
      ...(target.referenceArtifactId ? [{ type: 'first_frame', artifactId: target.referenceArtifactId }] : []),
      ...(target.assetReferenceArtifactIds ?? []).map(artifactId => ({ type: 'reference_image', artifactId })),
    ]
    return references.length > 0 ? { referenceArtifacts: references } : {}
  }
  const taskRow = (target: GenerationTarget, key: string) => ({
    organizationId,
    stage: dbStage,
    idempotencyKey: key,
    // 被拦截守卫点名的任务:带着原因落 BLOCKED，界面与待处理泳道都指得回这一镜；
    // 绑定补齐后经重试路径复活，中途不烧任何额度。
    ...(target.blockedReason ? { status: 'BLOCKED' as const, errorSnapshot: target.blockedReason } : {}),
    ...(target.storyboardId ? { storyboardId: target.storyboardId } : {}),
    // 定妆照任务把它服务的素材连上多对多:素材面板要按行显示"生成中/失败",
    // 而 requestSnapshot 里的 assetId 是给供应商看的,不能当查询面。
    ...(target.assetId ? { assets: { connect: [{ id: target.assetId }] } } : {}),
    // ProviderRequest payload; the model and the vendor's dialect keys belong to
    // whichever candidate ends up running, so the worker fills those in. A media
    // task's snapshot already carries the base seed above, because reproducibility
    // must not depend on which model wins the slot. The locale rides
    // in `input` because every adapter picks its input keys explicitly. `parameters`
    // holds only platform-owned names: an adapter translates each one into the
    // vendor's dialect at submit time, and a length it cannot map is refused by name
    // rather than sent along as a guess.
    // A reference is an id, not bytes: an approved 1080P frame encoded inline is
    // megabytes, and the artifact row already carries its checksum and mime type.
    // The key is written last so a task without one serialises exactly as before.
    requestSnapshot: JSON.stringify({ input: { prompt: target.prompt, ...localeField }, ...parametersField(target, key), ...(target.assetId ? { assetId: target.assetId } : {}), ...(target.scriptVersionId ? { scriptVersionId: target.scriptVersionId } : {}), ...referenceField(target), ...(target.durationPlan ? { durationPlan: target.durationPlan } : {}), ...(target.guardFindings?.length ? { promptGuards: target.guardFindings } : {}) }),
  })
  // The candidates one task should try, in order. A shot holding its own frame tries the
  // conditioning model first and keeps text-to-video behind it; everyone else shares the
  // slot's order. Keyed by idempotency key, because the rows come back from the database
  // in the order the database chose, not the order we wrote them in.
  const candidatesForKey = (key: string): RunTaskCandidate[] => {
    // 图像阶段的按需排序:带参考图的任务(首帧)编辑模型优先;纯文字出图(定妆照)
    // 纯文生图模型优先——编辑模型裸跑文字出图,质感明显弱于文生图模型(实测)。
    // 音效任务的花费走 sfx 槽:与 tts_voice 是两笔钱、两家候选,不能混排。
    if (stage === 'AUDIO' && targetsByKey.get(key)?.sfx) return sfxCandidates.map(toRunTaskCandidate)
    if (stage === 'IMAGE' || stage === 'ASSET') {
      const hasRefs = stage === 'ASSET' ? false : (targetsByKey.get(key)?.assetReferenceArtifactIds?.length ?? 0) > 0
      const ordered = [...candidates].sort((a, b) =>
        hasRefs
          ? Number(b.acceptsReferenceImages ?? false) - Number(a.acceptsReferenceImages ?? false)
          : Number(a.acceptsReferenceImages ?? false) - Number(b.acceptsReferenceImages ?? false),
      )
      return ordered.map(toRunTaskCandidate)
    }
    if (conditioning.length === 0 && referenceModeling.length === 0) return candidates.map(toRunTaskCandidate)
    const target = promptedTargets.find((_, index) => idempotencyKeys[index] === key)
    const plan = planVideoModels(
      [...conditioning, ...referenceModeling, ...candidates],
      target?.referenceArtifactId !== undefined,
      (target?.assetReferenceArtifactIds?.length ?? 0) > 0,
    )
    // 换模型决议：被点名的那条候选排到本镜链首，其余候选仍按原序兜底——
    // 一条付费模型失败后，回退链不能因为这次点名而消失。
    const preferred = target?.durationPlan?.capabilityId
    const ordered = preferred
      ? [...plan.candidates].sort((a, b) => Number(b.capabilityId === preferred) - Number(a.capabilityId === preferred))
      : plan.candidates
    return ordered.map(toRunTaskCandidate)
  }

  try {
    const batch = await db.$transaction(async tx => {
      // Serialize reservations for the organization, counting queued reservations too.
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
      if (options.runClaim) {
        const owned = await tx.creationRun.updateMany({ where: { requestKey: options.runClaim.requestKey, claimToken: options.runClaim.token, batchId: null }, data: { leaseUntil: new Date(Date.now() + 120_000) } })
        if (owned.count !== 1) throw new Error('creation run lease lost')
      }
      if (!await reserveOrganizationCalls(tx, organizationId, promptedTargets.filter(target => !target.blockedReason).length)) return null
      const created = await tx.generationBatch.create({
      data: {
        organizationId,
        episodeId: episode.id,
        stage: dbStage,
        plannedCount: promptedTargets.length,
        // Which shots the batch was planned against. `nextRunnableStage` reads this to
        // tell a stage that ran for the live shots from one that only covers superseded
        // ones; the clip of an individual shot comes from the task's own storyboardId.
        // For AUDIO that set is the voiced shots plus whatever silent shots got an sfx
        // task — a shot that gains its line later (or an sfx slot bound later) is not
        // covered, which re-opens the stage on the next advance.
        storyboards: { connect: [...new Set([...voiced, ...sfxShots])].map(storyboard => ({ id: storyboard.id })) },
        tasks: { create: promptedTargets.map((target, index) => taskRow(target, idempotencyKeys[index])) },
      },
      include: { tasks: true },
      })
      for (const task of created.tasks) {
        if (task.status !== 'BLOCKED') await recordJobIntent(tx, { kind: 'run-task', taskId: task.id, organizationId, attempt: 1, candidates: candidatesForKey(task.idempotencyKey ?? '') })
      }
      if (takeEntries.length > 0) await persistShotTakes(tx, takeEntries, { reset: Boolean(options.regenerate) })
      if (options.runClaim) await tx.creationRun.update({ where: { requestKey: options.runClaim.requestKey }, data: { batchId: created.id, claimToken: null, leaseUntil: null } })
      return created
    }, { timeout: 30_000 })
    if (!batch) return { ok: false, code: 429, error: 'pipeline:inFlightBudget', reasons: ['organization call reservations exhausted'] }
    // Queued tasks roll the batch up to RUNNING; without this the batch would
    // read DRAFT until the worker happened to pick the first task up.
    await syncBatchStatus(db, batch.id)
    for (const task of batch.tasks) {
      // 守卫拦下的任务不排队:额度一分不烧,等人补齐输入后由重试路径复活。
      if (task.status === 'BLOCKED') continue
      await store.enqueueJob({ kind: 'run-task', taskId: task.id, organizationId, attempt: 1, candidates: candidatesForKey(task.idempotencyKey ?? '') })
    }
    await persistShotDurationPlans(db, promptedTargets)
    await audit(db, { organizationId, userId, action: options.regenerate ? 'generation.regenerate' : 'generation.trigger', entityType: 'generation-batch', entityId: batch.id, payload: { stage, plannedCount: batch.plannedCount, revision, ...gapAudit, ...durationAudit, ...takesAudit, ...guardStats(promptedTargets) } })
    return { ok: true, batchId: batch.id, created: true }
  } catch (error) {
    if (!isPrismaUniqueViolation(error)) throw error
    // Key collision = this stage already ran for (some of) these targets. A plain
    // re-trigger never re-runs success — QUEUED/RUNNING/SUCCEEDED tasks stay exactly
    // as they are — but a FAILED task is the stage owing its target a result, so it
    // is reset and re-queued with the slot's current candidates. Without this,
    // pressing "generate the missing" after a quota burnout would silently do
    // nothing, because the dead tasks still hold their plain idempotency keys.
    // The create above rolled back, so targets the first run never covered (a shot
    // added afterwards) get a batch of their own here.
    const existing = await db.generationTask.findMany({
      where: { organizationId, idempotencyKey: { in: idempotencyKeys } },
      select: { id: true, batchId: true, stage: true, idempotencyKey: true, status: true, reviewSnapshot: true },
    })
    const existingKeys = new Set(existing.map(task => task.idempotencyKey))
    const missingTargets = promptedTargets.filter((_, index) => !existingKeys.has(idempotencyKeys[index]))
    // BLOCKED 与 FAILED 同属"这一阶段还欠这个目标一个结果":守卫拦下的任务在
    // 人补齐输入(如绑定素材)后重触发,就经这条路复活并重排;被人叫停的 CANCELLED
    // 也一样——它一条都没跑过,不复活就永远缺这批产物,而「触发生成」会静默造出 0 个任务。
    // 停在问询上的 FAILED 不算:它欠的不是一次自动重抽,而是人先回答抽不抽。
    const retryable = existing.filter(owesResult)
    if (missingTargets.length === 0 && retryable.length === 0) {
      const anchor = existing[0]
      if (!anchor) throw error
      return { ok: true, batchId: anchor.batchId, created: false }
    }
    if (missingTargets.length > 0) {
      const missingKeys = idempotencyKeys.filter(key => !existingKeys.has(key))
      const batch = await db.generationBatch.create({
        data: {
          organizationId,
          episodeId: episode.id,
          stage: dbStage,
          plannedCount: missingTargets.length,
          storyboards: { connect: [...new Set(missingTargets.map(target => target.storyboardId).filter((id): id is string => Boolean(id)))].map(id => ({ id })) },
          tasks: { create: missingTargets.map((target, index) => taskRow(target, missingKeys[index])) },
        },
        include: { tasks: true },
      })
      for (const task of batch.tasks) {
        if (task.status === 'BLOCKED') continue
        await store.enqueueJob({ kind: 'run-task', taskId: task.id, organizationId, attempt: 1, candidates: candidatesForKey(task.idempotencyKey ?? '') })
      }
      await syncBatchStatus(db, batch.id)
    }
    for (const task of retryable) {
      const target = targetsByKey.get(task.idempotencyKey ?? '')
      // 守卫仍在拦：快照照刷（让人看到此刻还缺什么），但任务复活回 BLOCKED 而不是
      // QUEUED——不排队，不烧额度。
      const stillBlocked = target?.blockedReason
      await db.generationTask.update({
        where: { id: task.id },
        data: {
          status: stillBlocked ? 'BLOCKED' : 'QUEUED',
          attempts: 0,
          provider: null,
          model: null,
          errorSnapshot: stillBlocked ?? null,
          ...(target ? { requestSnapshot: taskRow(target, task.idempotencyKey ?? '').requestSnapshot } : {}),
        },
      })
      if (!stillBlocked) await store.enqueueJob({ kind: 'run-task', taskId: task.id, organizationId, attempt: 1, candidates: candidatesForKey(task.idempotencyKey ?? '') })
    }
    if (retryable.length > 0) await syncBatchStatus(db, retryable[0].batchId)
    await persistShotDurationPlans(db, promptedTargets)
    if (takeEntries.length > 0) await persistShotTakes(db, takeEntries, { reset: Boolean(options.regenerate) })
    await audit(db, { organizationId, userId, action: 'generation.retry', entityType: 'generation-batch', entityId: retryable[0]?.batchId ?? existing[0]?.batchId ?? '', payload: { stage, retried: retryable.length, created: missingTargets.length, ...gapAudit, ...durationAudit, ...takesAudit, ...guardStats(promptedTargets) } })
    return { ok: true, batchId: retryable[0]?.batchId ?? existing[0]!.batchId, created: false }
  }
}

/**
 * 计划预审:一次批量触发烧什么,在按下按钮之前先摊开——哪些镜头是新烧、哪些是
 * 失败重试、哪些已被覆盖,跑哪串模型,产出多少秒。只读,不落任何行。
 * 目标选择、上游门禁、幂等键判定都与 triggerStage 同源:预审若承诺了一个真触发
 * 会拒的计划,它就不是预审,是误导。
 */
export interface GenerationPlanItem {
  id: string
  label: string
  /** local = 分镜表写明由人做（字卡/屏幕录制/合成/UI），本次不排平台任务。 */
  disposition: 'new' | 'retry' | 'skipped' | 'local'
}

/** 一镜的分镜文本体检结论。代码的人话解释在前端，与 shotboard 的 attention 同一形态。 */
export interface GenerationPlanShotGap {
  shotNumber: number
  codes: string[]
}

export interface GenerationPlan {
  stage: GenerationStage
  /** `provider/model`, in the order the worker would try them. */
  models: string[]
  items: GenerationPlanItem[]
  newCount: number
  retryCount: number
  skippedCount: number
  /** 本机镜头数：列在 items 里让人看见「这些不花额度」，不计入时长。 */
  localCount: number
  /** Physical runtime of the shots the plan would still run; per-shot stages only. */
  durationMs: number | null
  /** VIDEO only: the episode's promised total, the live shots' planned total, and
   * the shortfall a human must acknowledge before the batch may run. Null when the
   * stage is not VIDEO or the episode has no target. */
  targetDurationMs: number | null
  plannedDurationMs: number | null
  durationGapMs: number | null
  /** VIDEO only: effective single-call ceiling (project × model × product). */
  durationCeilingMs: number | null
  /** VIDEO only: shots whose planned length exceeds that ceiling, with their three exits. */
  durationPreflight: ShotDurationPreflight[]
  /** 首帧/视频：本次计划里分镜文本仍缺项的镜头。只提示、不拦路——拦人是落库硬检的活。 */
  storyboardGaps: GenerationPlanShotGap[]
  /** Batches this stage already ran; a regenerate appends a fresh revision of its own. */
  revision: number
}

export type PlanResult = { ok: true; plan: GenerationPlan } | { ok: false; code: number; error: string; reasons?: string[] }

export async function buildGenerationPlan(
  db: PrismaClient,
  organizationId: string,
  episodeId: string,
  stage: GenerationStage,
  // The plan is a readiness/cost preview — it never renders prompts, so there is
  // nothing for a style to affect; carrying a styleId here would be a silent no-op.
  options: { storyboardIds?: string[]; assetIds?: string[]; regenerate?: boolean } = {},
): Promise<PlanResult> {
  const episode = await db.episode.findFirst({
    where: { id: episodeId, project: { organizationId } },
    include: {
      project: { select: { targetDurationMs: true } },
      storyboards: {
        where: { supersededAt: null },
        orderBy: [{ revision: 'asc' }, { number: 'asc' }],
        select: { id: true, number: true, title: true, description: true, durationMs: true, dialogue: true, speaker: true, continuityIn: true, continuityOut: true, location: true, lockedReferences: true, method: true },
      },
      assets: { orderBy: { id: 'asc' }, select: { id: true, kind: true, name: true, status: true } },
    },
  })
  if (!episode) return { ok: false, code: 404, error: 'Episode not found' }
  // 与 triggerStage 同一口径：整集视频的缺口按全部在册镜头算，不按这次选中的子集。
  const durationGap = stage === 'VIDEO'
    ? shotDurationGap(episode.targetDurationMs ?? episode.project.targetDurationMs ?? null, episode.storyboards)
    : null

  const perStoryboard = stage === 'IMAGE' || stage === 'VIDEO' || stage === 'AUDIO'
  const perAsset = stage === 'ASSET'
  let selected = perStoryboard ? episode.storyboards : []
  if (perStoryboard && options.storyboardIds) {
    selected = selected.filter(storyboard => options.storyboardIds!.includes(storyboard.id))
    if (selected.length !== new Set(options.storyboardIds).size) return { ok: false, code: 400, error: 'storyboardIds must belong to this episode' }
  }
  if (perStoryboard && selected.length === 0) return { ok: false, code: 400, error: 'episode has no storyboards to generate' }
  // 生成方式与 triggerStage 同一口径：显式点名本机镜头直接拒，整批时把它们列成
  // local——预审门要让人看见「这 30 镜不花额度」，而不是只报一个更小的数字。
  const mediaStage = stage === 'IMAGE' || stage === 'VIDEO'
  const localShots = mediaStage ? selected.filter(storyboard => !needsGeneratedMedia(storyboard.method)) : []
  if (mediaStage && options.storyboardIds && localShots.length > 0) {
    return { ok: false, code: 400, error: 'generations:shotNotGenerated', reasons: localShots.map(storyboard => `#${storyboard.number}`) }
  }
  const generatedShots = mediaStage ? selected.filter(storyboard => needsGeneratedMedia(storyboard.method)) : selected
  if (mediaStage && generatedShots.length === 0) return { ok: false, code: 400, error: 'generations:nothingToGenerate' }
  let selectedAssets = perAsset ? episode.assets : []
  if (perAsset && options.assetIds) {
    selectedAssets = selectedAssets.filter(asset => options.assetIds!.includes(asset.id))
    if (selectedAssets.length !== new Set(options.assetIds).size) return { ok: false, code: 400, error: 'assetIds must belong to this episode' }
  }
  if (perAsset && selectedAssets.length === 0) return { ok: false, code: 400, error: 'episode has no assets to generate' }
  const voiced = stage === 'AUDIO' ? selected.filter(storyboard => storyboard.dialogue !== '') : generatedShots
  if (stage === 'AUDIO' && voiced.length === 0) return { ok: false, code: 400, error: 'episode has no shots with dialogue to voice' }
  // 与 triggerStage 同一份口径：预审门要报的超长镜，就是真触发会拦的那几镜。
  const durationAssessment = stage === 'VIDEO' ? await targetShotDurationPlan(db, organizationId, episode.projectId) : null
  const durationPreflight = durationAssessment ? preflightShotDurations(voiced, durationAssessment) : []

  if (stage === 'SCRIPT') {
    const source = await db.sourceDocumentVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, select: { id: true } })
    if (!source) return { ok: false, code: 409, error: 'generations:noApprovedSource' }
  }
  let approvedScriptContent: string | null = null
  if (stage !== 'SCRIPT' && stage !== 'ASSET') {
    const script = await db.scriptVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, select: { id: true, content: true } })
    if (!script) return { ok: false, code: 409, error: 'generations:noApprovedScript' }
    approvedScriptContent = script.content
  }
  if (stage === 'IMAGE') {
    const links = await db.storyboardAsset.findMany({
      where: { storyboardId: { in: voiced.map(storyboard => storyboard.id) } },
      include: { asset: { select: { kind: true, name: true, status: true } } },
    })
    // 触发端会把缺的绑定补上（只增不删），预审门必须与触发同一口径：现在不拦的
    // 草稿素材，点下去就会被触发端拦——两处各算一次必然分叉。
    const pending = await missingShotAssetLinks(db, voiced, episode.assets)
    const drafts = draftAssetNames(links, pending, episode.assets)
    if (drafts.length > 0) return { ok: false, code: 409, error: 'generations:assetsNotApproved', reasons: drafts }
  }

  const slot = stageSlots[stage]
  const candidates = await resolveSlotCandidates(db, organizationId, episode.projectId, slot)
  if (candidates.length === 0) return { ok: false, code: 409, error: `no verified candidates for slot ${slot}` }
  // VIDEO 的两个可选半区：i2v 花的是这一镜的首帧，r2v 花的是绑定素材的定妆照。真触发
  // 时 triggerStage 把它们排在必填槽前面（planVideoModels），预审门必须报同一条链。
  const conditioning = stage === 'VIDEO' ? await resolveSlotCandidates(db, organizationId, episode.projectId, 'video_i2v') : []
  const referenceModeling = stage === 'VIDEO' ? await resolveSlotCandidates(db, organizationId, episode.projectId, 'video_r2v') : []
  // 只报必填槽会把付费的 i2v 模型漏成兜底的 t2v 模型：实测同一批视频，界面上的
  // 「将使用的模型」写的是百炼文生视频，派发日志的第一候选是已付费的 seedance。
  const chain = stage === 'VIDEO' ? planVideoModels([...conditioning, ...referenceModeling, ...candidates], true, true).candidates : candidates

  if (stage === 'VIDEO' && conditioning.length > 0) {
    const frames = await usableFirstFrames(db, organizationId, episode.id, voiced.map(storyboard => storyboard.id))
    const missing = voiced.filter(storyboard => !frames.get(storyboard.id)).map(storyboard => `#${storyboard.number}`)
    if (missing.length > 0) return { ok: false, code: 409, error: 'generations:videoMissingFrames', reasons: missing }
    const inflight = await db.storyboard.findMany({
      where: {
        id: { in: voiced.map(storyboard => storyboard.id) },
        generationTasks: { some: { stage: 'FIRST_FRAME', status: { in: ['QUEUED', 'RUNNING'] } } },
      },
      select: { number: true },
      orderBy: { number: 'asc' },
    })
    if (inflight.length > 0) return { ok: false, code: 409, error: 'generations:frameInFlight', reasons: inflight.map(storyboard => `#${storyboard.number}`) }
  }

  // The plain key collides with a run that already happened, which is exactly what
  // distinguishes retry from skipped below; a regenerate carries the same fresh
  // revision suffix triggerStage would write, so everything it covers reads as new.
  const revision = options.regenerate
    ? await db.generationBatch.count({ where: { episodeId: episode.id, stage: stageDbValues[stage] } })
    : 0
  const suffix = revision > 0 ? `:r${revision}` : ''
  const targets = perAsset
    ? selectedAssets.map(asset => ({ id: asset.id, label: asset.name, durationMs: null as number | null }))
    : perStoryboard
      ? voiced.map(storyboard => ({ id: storyboard.id, label: `#${storyboard.number} ${storyboard.title}`, durationMs: storyboard.durationMs as number | null }))
      : [{ id: episode.id, label: episode.title, durationMs: null as number | null }]
  const keys = targets.map(target => `${episode.id}:${stage}:${target.id}${suffix}`)
  const existing = await db.generationTask.findMany({
    where: { organizationId, idempotencyKey: { in: keys } },
    select: { idempotencyKey: true, status: true, reviewSnapshot: true },
  })
  const taskByKey = new Map(existing.map(task => [task.idempotencyKey, task]))
  const dispositionOf = (id: string): GenerationPlanItem['disposition'] => {
    const task = taskByKey.get(`${episode.id}:${stage}:${id}${suffix}`)
    // FAILED/BLOCKED/CANCELLED 都是"还欠一个结果":前两者重试过或会被真触发复活,取消的
    // 那一条从没跑过,真触发同样会复活它——预审按 retry 报账才不骗人。
    // 停在问询上的 FAILED 除外:真触发不会动它,预审报 retry 就等于承诺一次不会发生的重抽。
    return task === undefined ? 'new' : owesResult(task) ? 'retry' : 'skipped'
  }
  // IMAGE/VIDEO 的条目按镜头顺序混排生成镜与本机镜，本机镜以 local 明示不花额度。
  const planShots = perStoryboard ? (stage === 'AUDIO' ? voiced : selected) : []
  const localIds = new Set(localShots.map(storyboard => storyboard.id))
  const items: GenerationPlanItem[] = perStoryboard
    ? planShots.map(storyboard => {
        const label = `#${storyboard.number} ${storyboard.title}`
        return { id: storyboard.id, label, disposition: localIds.has(storyboard.id) ? 'local' : dispositionOf(storyboard.id) }
      })
    : targets.map(target => ({ id: target.id, label: target.label, disposition: dispositionOf(target.id) }))
  const billable = new Set(items.filter(item => item.disposition === 'new' || item.disposition === 'retry').map(item => item.id))
  const durationById = new Map(planShots.map(storyboard => [storyboard.id, storyboard.durationMs]))
  // 开烧前的逐镜分镜体检。整集在册镜头一起送进判据（首镜与末镜的结论依赖它在序列
  // 里的位置），再筛回本次计划真正会跑的那几镜。AUDIO 不算：镜头语言与末帧是画面的
  // 事，报在配音预审门上只会让人以为是配音出了问题。时长地板只有 VIDEO 吃得到。
  let storyboardGaps: GenerationPlanShotGap[] = []
  if (mediaStage) {
    const gaps = inspectStoryboardGaps(episode.storyboards, {
      castNames: episode.assets.filter(asset => asset.kind === 'character').map(asset => asset.name),
      scriptContent: approvedScriptContent,
      minDurationMs: stage === 'VIDEO' ? (durationAssessment?.minMs ?? null) : null,
    })
    const planned = new Set(planShots.map(storyboard => storyboard.id))
    storyboardGaps = episode.storyboards.flatMap(storyboard => {
      const codes = gaps.get(storyboard.id)
      return codes && codes.length > 0 && planned.has(storyboard.id) ? [{ shotNumber: storyboard.number, codes }] : []
    })
  }
  return {
    ok: true,
    plan: {
      stage,
      models: chain.map(candidate => `${candidate.connectionName} · ${candidate.provider}/${candidate.model}`),
      items,
      newCount: items.filter(item => item.disposition === 'new').length,
      retryCount: items.filter(item => item.disposition === 'retry').length,
      skippedCount: items.filter(item => item.disposition === 'skipped').length,
      localCount: items.filter(item => item.disposition === 'local').length,
      durationMs: perStoryboard ? items.filter(item => billable.has(item.id)).reduce((sum, item) => sum + (durationById.get(item.id) ?? 0), 0) : null,
      targetDurationMs: durationGap?.targetMs ?? null,
      plannedDurationMs: durationGap?.plannedMs ?? null,
      durationGapMs: durationGap?.gapMs ?? null,
      durationCeilingMs: durationAssessment?.maxMs ?? null,
      durationPreflight,
      storyboardGaps,
      revision,
    },
  }
}

/**
 * 自动推进时，这个阶段该直接跑（true）还是停下来等人（false）。
 *
 * - `everyStage`：一律停，每一步由人按。
 * - `beforeSpend`：只放行文字阶段（SCRIPT / STORYBOARD，一次文本调用的量级）。首帧、
 *   视频、配音、配乐是花钱大户，必须由人按下按钮。这是引入档位之前的行为，也是默认
 *   值——旧版那行硬编码的 `stage !== 'SCRIPT' && stage !== 'STORYBOARD'` 就是这一条，
 *   改造后逐阶段等价，回归靠这条不变式守住。
 * - `auto`：除「素材定稿」与「交付验收」外全放行。那两处不在本表里，也管不着本表：
 *   素材定稿是 nextRunnableStage 的 IMAGE 闸门（素材未 APPROVED 就 blocked），交付
 *   验收根本不在自动推进链上。它们由结构保证，所以这里全放行是安全的。
 */
export function stageProceedsUnder(gate: AutomationGate, stage: PipelineStage): boolean {
  if (gate === 'everyStage') return false
  if (gate === 'auto') return true
  return stage === 'SCRIPT' || stage === 'STORYBOARD'
}

/**
 * 项目级制作档位。字段可空，null 按 beforeSpend 解释——那是引入档位之前的行为。
 * 未知取值同样走保守分支：多问一次只是多一句打扰，少问一次可能悄悄花掉用户的钱。
 */
async function resolveAutomationGate(db: PrismaClient, episodeId: string, organizationId: string): Promise<AutomationGate> {
  const episode = await db.episode.findFirst({
    where: { id: episodeId, project: { organizationId } },
    select: { project: { select: { automationGate: true } } },
  })
  const raw = episode?.project.automationGate
  return isAutomationGate(raw) ? raw : defaultAutomationGate
}

/**
 * Advances the pipeline one step: triggers the next stage whose prerequisites are
 * met and which has not run yet, and once every stage has run, takes the terminal
 * step of composing the episode. Composition is not a generation stage — no slot,
 * no prompt, no provider — so it is planned separately and skipped unless every
 * live shot already has the clip the compose worker needs; creating it early would
 * only park it in BLOCKED. `auto` marks the audit so a worker-initiated relay is
 * distinguishable from a human clicking "advance". Returns
 * `pipeline:nothingRunnable` when nothing can be started and nothing can be composed,
 * with the composition gate's own reason alongside it — the generic error says the
 * chain has no next step, `reasons` says what is still missing.
 */
export async function advancePipeline(
  store: PipelineStore,
  organizationId: string,
  userId: string | null,
  episodeId: string,
  options: { auto?: boolean } = {},
): Promise<AdvanceResult> {
  const action = options.auto ? 'pipeline.autoAdvance' : 'pipeline.advance'
  // 档位是项目级属性，一次 advance 内不变，所以循环外读一次而不是每阶段往返。
  // 人工推进（options.auto 为假）不查档位：人按下的按钮就是要它跑的那一步。
  const gate = options.auto ? await resolveAutomationGate(store.db, episodeId, organizationId) : null
  // A stage whose slot has no verified candidates cannot run here at all — the
  // chain must walk past it, not stall on a capability the installation never
  // bound. The skip set lives only inside this call: every advance re-derives it,
  // so binding a TTS later resumes voicing with nothing to unstick.
  const skip = new Set<PipelineStage>()
  for (;;) {
    const next = await nextRunnableStage(store.db, episodeId, { skip })
    // A block is a human gate (asset approval, for one) standing in front of the
    // chain: stopping here with its reason is the whole point — skipping past it
    // would run later stages on inputs nobody signed off on.
    if (!next) break
    if ('blocked' in next) return { ok: false, code: 409, error: next.error, ...(next.reasons ? { reasons: next.reasons } : {}) }
    const stage = next.stage
    // 自动推进的边界交给项目的制作档位，判定见 stageProceedsUnder。默认档（beforeSpend）
    // 与引入档位之前逐阶段一致：只接力文字阶段，花钱的节奏归人——用户实测「只点了
    // 重新分镜，13 个首帧自己排上队」（2026-09-29），与重抽上限同一条原则。
    if (gate !== null && !stageProceedsUnder(gate, stage)) {
      return { ok: false, code: 409, error: 'pipeline:autoAdvanceStopped', reasons: [stage] }
    }
    const result = await triggerStage(store, organizationId, userId, episodeId, stage)
    if (result.ok) {
      await audit(store.db, {
        organizationId,
        userId,
        action,
        entityType: 'episode',
        entityId: episodeId,
        payload: { stage, batchId: result.batchId },
      })
      return { ok: true, step: 'stage', stage, batchId: result.batchId, created: result.created }
    }
    if (!result.error.includes('no verified candidates')) return result
    skip.add(stage)
  }

  const plan = await planComposition(store.db, episodeId)
  if (!plan.ready) return { ok: false, code: 409, error: 'pipeline:nothingRunnable', reasons: [plan.reason] }
  const compositionId = await createComposition(store, organizationId, episodeId, plan.storyboardIds)
  await audit(store.db, {
    organizationId,
    userId,
    action,
    entityType: 'episode',
    entityId: episodeId,
    payload: { step: COMPOSITION_STEP, compositionId, storyboards: plan.storyboardIds.length },
  })
  return { ok: true, step: 'composition', compositionId }
}

export type ScriptCascadeResult = { cascaded: true; batchId: string } | { cascaded: false; error: string | null }

/**
 * The downstream half of "a human edited the script": approval is the checkpoint, so
 * approving re-runs the breakdown when the live shots were generated from an older
 * script version. The regenerate supersedes the prior revision instead of deleting
 * it, and auto-advance carries the chain down from there — assets, first frames,
 * video, composition — without a human clicking each stage.
 *
 * Only a human approval cascades. The worker never approves a script, so the
 * automatic relay it drives cannot arrive back here and loop.
 *
 * `error: null` means there was nothing to cascade: no live shots, or every one of
 * them already traces the version being approved, so re-running would pay for the
 * same breakdown again. Any other error is reported, never thrown: the approval is
 * already persisted by the time this runs, and a downstream re-run that could not
 * be enqueued must not roll it back.
 */
export async function cascadeScriptApproval(
  store: PipelineStore,
  organizationId: string,
  userId: string | null,
  episodeId: string,
  scriptVersionId: string,
): Promise<ScriptCascadeResult> {
  const live = await store.db.storyboard.findMany({
    where: { episodeId, supersededAt: null },
    select: { scriptVersionId: true },
  })
  if (live.length === 0 || live.every(shot => shot.scriptVersionId === scriptVersionId)) return { cascaded: false, error: null }
  try {
    const result = await triggerStage(store, organizationId, userId, episodeId, 'STORYBOARD', { regenerate: true })
    return result.ok ? { cascaded: true, batchId: result.batchId } : { cascaded: false, error: result.error }
  } catch (error) {
    return { cascaded: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface CreationPlanInput {
  episodeId: string
  stage: GenerationStage
  storyboardIds?: string[]
  promptNote?: string
  regenerate?: boolean
  styleId?: string
}

export interface CreationPlan {
  planId: string
  fingerprint: string
  stage: GenerationStage
  episodeId: string
  /** 任务量预估:目标镜头数(素材/剧本类阶段为 1)。 */
  estimatedTasks: number
  inputs: CreationPlanInput
}

/**
 * V08 计划指纹绑定的「实际输入」:请求字段省略 storyboardIds 时,计划面对的是
 * 当时全集——目标集、每镜 revision 向量与当前剧本修订都必须进指纹,否则
 * 「先 1 镜计划、加到 2 镜后同指纹」的漂移查不出来,计划任务量与实际支出对不上。
 */
export interface ResolvedPlanInputs {
  /** 解析后的目标镜头集(显式给定或当时全集),按分镜号排序。 */
  storyboardIds: string[]
  /** 与 storyboardIds 同序的镜头 revision 向量——重拆批次后旧计划失效。 */
  shotRevisions: number[]
  /** 当前剧本修订 id;文字类阶段消费剧本,下游阶段的输入也由它派生。 */
  scriptVersionId: string | null
}

/** 排队/提交两侧共用同一解析:计划时与提交时各自调用,指纹口径天然一致。 */
export async function resolvePlanInputs(db: PrismaClient, episodeId: string, input: CreationPlanInput): Promise<ResolvedPlanInputs> {
  const perShot = input.stage === 'IMAGE' || input.stage === 'VIDEO' || input.stage === 'AUDIO'
  const explicit = input.storyboardIds ?? undefined
  const shots = explicit
    ? await db.storyboard.findMany({ where: { id: { in: explicit }, supersededAt: null }, orderBy: { number: 'asc' }, select: { id: true, revision: true } })
    : perShot
      ? await db.storyboard.findMany({ where: { episodeId, supersededAt: null }, orderBy: { number: 'asc' }, select: { id: true, revision: true } })
      : []
  const script = await db.scriptVersion.findFirst({ where: { episodeId }, orderBy: { version: 'desc' }, select: { id: true } })
  return { storyboardIds: shots.map(shot => shot.id), shotRevisions: shots.map(shot => shot.revision), scriptVersionId: script?.id ?? null }
}

function planCanonical(organizationId: string, input: CreationPlanInput, resolved: ResolvedPlanInputs): string {
  return JSON.stringify({
    organizationId,
    episodeId: input.episodeId,
    stage: input.stage,
    storyboardIds: resolved.storyboardIds,
    shotRevisions: resolved.shotRevisions,
    scriptVersionId: resolved.scriptVersionId,
    promptNote: input.promptNote ?? null,
    regenerate: input.regenerate ?? false,
    styleId: input.styleId ?? null,
  })
}

/**
 * US-011 制作计划:把一次生成的输入固定成指纹化的计划。plan 不落库、不花钱——
 * 它是提交前的确认凭据;run 提交时重算指纹,漂移(镜头清单/上游文本变了)返回
 * 409,用户重新计划。V08:指纹绑定 resolvePlanInputs 解析出的实际输入集合与
 * revision 向量,不再只看请求字段。任务量按 stage 的目标粒度估。
 */
export function buildCreationPlan(organizationId: string, input: CreationPlanInput, resolved: ResolvedPlanInputs, targetCount: number): CreationPlan {
  const fingerprint = createHash('sha256').update(planCanonical(organizationId, input, resolved)).digest('hex')
  return { planId: `plan:${fingerprint.slice(0, 16)}`, fingerprint, stage: input.stage, episodeId: input.episodeId, estimatedTasks: targetCount, inputs: input }
}

/** 重算并比对:提交侧用。输入一致才算同一份计划。 */
export function planFingerprint(organizationId: string, input: CreationPlanInput, resolved: ResolvedPlanInputs): string {
  return createHash('sha256').update(planCanonical(organizationId, input, resolved)).digest('hex')
}

