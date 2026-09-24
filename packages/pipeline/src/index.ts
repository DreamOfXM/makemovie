import { createHash } from 'node:crypto'
import type { PrismaClient, SlotCandidate, Stage } from '@studio/db'
import { resolveSlotCandidates, syncBatchStatus } from '@studio/db'
import type { CapabilitySlot, ContentLocale } from '@studio/domain'
import { isContentLocale, planVideoModels } from '@studio/domain'
import type { PipelinePayload, RunTaskCandidate } from '@studio/jobs'
import { buildFilmScriptPrompt, buildMusicPrompt, buildScriptPrompt, buildStoryboardPrompt, voiceLine } from './prompts.js'
import { DEFAULT_PROMPT_GUARDS, runPromptGuards, VISUAL_STYLE_DIRECTIVE, type GuardCharacterInfo, type GuardFinding } from './guards.js'
import { applyStyleToPrompt, getStyleById, type StylePreset } from './styles/index.js'

/**
 * Generation orchestration shared by the API (a human triggers a stage) and the
 * worker (a completed batch auto-advances to the next one). Keeping it here means
 * both paths gate, prompt, batch, enqueue, and audit identically — the pipeline
 * behaves the same whether a person or the worker pushed it forward.
 */

export const generationStages = ['SCRIPT', 'ASSET', 'STORYBOARD', 'IMAGE', 'VIDEO', 'AUDIO', 'MUSIC'] as const
export type GenerationStage = (typeof generationStages)[number]

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

// 风格预设系统:影响 STORYBOARD/IMAGE/VIDEO 阶段的 prompt
export {
  OFFICIAL_STYLES,
  getOfficialStyles,
  getStyleById,
  isValidStyleId,
  getStyleVisualDirective,
  getStyleToneDirective,
  registerCustomStyle,
  unregisterCustomStyle,
  getAllStyles,
} from './styles/index.js'
export type { StylePreset } from './styles/index.js'
export { applyStyleToPrompt, isStageAffectedByStyle } from './styles/index.js'

// 官方风格幂等种子
export { seedOfficialStyles } from './seed-official-styles.js'

/** The stages the pipeline advances through on its own, in order. */
export const PIPELINE_STAGES = ['SCRIPT', 'STORYBOARD', 'ASSET', 'IMAGE', 'VIDEO', 'AUDIO', 'MUSIC'] as const
export type PipelineStage = (typeof PIPELINE_STAGES)[number]

const stageSlots: Record<GenerationStage, CapabilitySlot> = {
  SCRIPT: 'script_text',
  ASSET: 'image_gen',
  STORYBOARD: 'storyboard_text',
  IMAGE: 'image_gen',
  VIDEO: 'video_t2v',
  AUDIO: 'tts_voice',
  MUSIC: 'music_gen',
}

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

export function isGenerationStage(value: unknown): value is GenerationStage {
  return (generationStages as readonly string[]).includes(value as string)
}

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
    select: { id: true, revision: true, number: true, title: true, durationMs: true, dialogue: true },
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
  if (storyboards.some(storyboard => storyboard.dialogue !== '')) {
    const episode = await db.episode.findUnique({ where: { id: episodeId }, select: { projectId: true, project: { select: { organizationId: true } } } })
    const candidates = episode
      ? await resolveSlotCandidates(db, episode.project.organizationId, episode.projectId, 'tts_voice')
      : []
    if (candidates.length > 0 && storyboards.some(storyboard => storyboard.dialogue !== '' && !voiced.has(storyboard.id))) {
      return { ready: false, reason: 'composition:missingVoice' }
    }
  }

  const storyboardIds = storyboards.map(storyboard => storyboard.id)
  const latest = await db.composition.findFirst({ where: { episodeId }, orderBy: { id: 'desc' } })
  if (latest && sameShots(manifestStoryboardIds(latest.manifest), storyboardIds)) {
    // Same cut list, so re-composing would only re-render a master that exists —
    // unless a shot got its voice after that master was planned. The composer mixes
    // in whichever voices had landed when it ran, so a line voiced since then is
    // missing from the file: the old master is a stale render, not finished work.
    // Neither model carries a usable timestamp, and cuid ids sort chronologically.
    const voicedBatchIds = (await db.generationBatch.findMany({ where: { episodeId }, select: { id: true } })).map(b => b.id)
    const voicedSince = await db.generationTask.count({
      where: { batchId: { in: voicedBatchIds }, stage: 'AUDIO', status: 'SUCCEEDED', id: { gt: latest.id }, mediaArtifacts: { some: { stage: 'AUDIO' } } },
    })
    if (voicedSince === 0 && !(await selectionChanged(db, episodeId, latest.manifest))) {
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

/** Order matters: the manifest is the cut order, not a set of ids. */
function sameShots(manifest: string[], live: string[]): boolean {
  return manifest.length === live.length && manifest.every((id, index) => id === live[index])
}

/** Writes the composition row and queues the compose job; the caller owns the audit. */
export async function createComposition(store: PipelineStore, organizationId: string, episodeId: string, storyboardIds: string[]): Promise<string> {
  const composition = await store.db.composition.create({
    data: { episodeId, status: 'RUNNING', manifest: JSON.stringify({ storyboardIds }) },
  })
  await store.enqueueJob({ kind: 'compose-episode', compositionId: composition.id, episodeId, organizationId })
  return composition.id
}

/**
 * 单镜目标时长按绑定视频模型的能力量化为两档——5 秒档（免费短模型，一镜一句）
 * 与 15 秒档（wan2.7/wan3.0 一类，一镜一段对话）。两档而非连续值：分镜节奏可预期，
 * 每档对应的拆分规则与台词预算稳定，测试也钉得住。
 * 无绑定或缺时长声明按 5 秒兜底；只出 10 秒的模型保守落 5 秒档（不冒进超时长）。
 */
export const SHOT_DURATION_TIERS = [5_000, 15_000] as const

/** 能力上限 ≥15 秒的模型落 15 秒档；只出 5/10 秒的模型保守落 5 秒档。 */
export function quantizeShotDuration(capabilityMaxMs: number): (typeof SHOT_DURATION_TIERS)[number] {
  return capabilityMaxMs >= 15_000 ? 15_000 : 5_000
}

// worker 的分段分镜在执行时按当前绑定重建每段 prompt,需要与触发时同一口径的
// 单镜档位——导出让两条路径共用一个函数,而不是各自抄一份档位规则。
export async function targetShotDurationMs(db: PrismaClient, organizationId: string, projectId: string): Promise<number> {
  const candidates = [
    ...(await resolveSlotCandidates(db, organizationId, projectId, 'video_i2v')),
    ...(await resolveSlotCandidates(db, organizationId, projectId, 'video_t2v')),
  ]
  let best = 5_000
  for (const candidate of candidates) {
    const spec = candidate.spec as { durations?: unknown } | null
    const durations = Array.isArray(spec?.durations) ? spec.durations : []
    for (const duration of durations) {
      if (typeof duration === 'number' && duration > 0) {
        best = Math.max(best, duration * 1000)
      }
    }
  }
  return quantizeShotDuration(best)
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
  return newest
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
  /** P7 拦截型守卫的落点:任务直接落 BLOCKED、不排队,绑定补齐后经重试路径复活。 */
  blockedReason?: string
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
  const [approvedSource, approvedScript, assetCount, storyboardCount, dialogueCount, batches, liveBatches] = await Promise.all([
    db.sourceDocumentVersion.findFirst({ where: { episodeId, status: 'APPROVED' }, select: { id: true } }),
    db.scriptVersion.findFirst({ where: { episodeId, status: 'APPROVED' }, select: { id: true } }),
    db.asset.count({ where: { episodeId } }),
    db.storyboard.count({ where: { episodeId, supersededAt: null } }),
    db.storyboard.count({ where: { episodeId, supersededAt: null, dialogue: { not: '' } } }),
    db.generationBatch.findMany({ where: { episodeId }, select: { stage: true, _count: { select: { storyboards: true } } } }),
    db.generationBatch.findMany({ where: { episodeId, storyboards: { some: { supersededAt: null } } }, select: { stage: true } }),
  ])
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
      : approvedScript !== null && storyboardCount > 0
    if (!ready) continue
    // 素材审批是首帧的人工闸门:首帧按素材外观生成,素材还在草稿就该停在这里让人定稿,
    // 而不是绕过去烧首帧的额度。检查的是活镜头实际绑定的素材——没被引用的素材不拦路。
    if (stage === 'IMAGE' && storyboardCount > 0) {
      const links = await db.storyboardAsset.findMany({
        where: { storyboard: { episodeId, supersededAt: null } },
        include: { asset: true },
      })
      const drafts = [...new Set(links.filter(link => link.asset.status !== 'APPROVED').map(link => `${link.asset.kind} · ${link.asset.name}`))]
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
  options: { storyboardIds?: string[]; assetIds?: string[]; promptNote?: string; regenerate?: boolean; styleId?: string } = {},
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
  // Read off the project rather than passed in, so a human triggering a stage and
  // the worker advancing into it build the same prompt for the same episode.
  const locale: ContentLocale = isContentLocale(episode.project.contentLocale) ? episode.project.contentLocale : 'zh'

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
  const selected = perStoryboard
    ? options.storyboardIds
      ? episode.storyboards.filter(storyboard => options.storyboardIds!.includes(storyboard.id))
      : episode.storyboards
    : []
  if (perStoryboard) {
    if (options.storyboardIds && selected.length !== new Set(options.storyboardIds).size) return { ok: false, code: 400, error: 'storyboardIds must belong to this episode' }
    if (selected.length === 0) return { ok: false, code: 400, error: 'episode has no storyboards to generate' }
  }
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
  // 随请求发给支持参考图的图像模型(qwen-image-edit 一类),角色长相才有真正的锚点。
  // 不支持参考图的模型照常纯文生图,worker 会记录这次降级的原因。
  const assetContexts = new Map<string, string>()
  const assetReferences = new Map<string, string[]>()
  // P7 守卫的事实底座:每镜的绑定计数与绑定角色(含画面文本没点名的角色)。
  // 上面的素材上下文只服务"被点名者";画面里有人却没点名时,外观锚点由守卫接住——
  // 两者共用同一份 links 与同一个 mentioned() 判定,口径不会分叉。
  const shotGuardInfo = new Map<string, { boundAssetCount: number; characters: GuardCharacterInfo[] }>()
  if (stage === 'IMAGE' || stage === 'VIDEO') {
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
      const drafts = [...new Set(links.filter(link => link.asset.status !== 'APPROVED').map(link => `${link.asset.kind} · ${link.asset.name}`))]
      if (drafts.length > 0) return { ok: false, code: 409, error: 'generations:assetsNotApproved', reasons: drafts }
    }
    // 参考图槽位有限,选取顺序就是一致性优先级:角色(脸)→ 场景(基调)→ 道具。
    const REFERENCE_ORDER: Record<string, number> = { character: 0, scene: 1, prop: 2 }
    for (const storyboard of selected) {
      // 文本与参考图必须同序同集:模型按"图N＝某素材"理解哪张定妆照对应谁,
      // 文本顺序和图顺序错位时,多角色镜头会出现张冠李戴的脸。
      const shotLinks = links
        .filter(link => link.storyboardId === storyboard.id)
        .sort((a, b) => (REFERENCE_ORDER[a.asset.kind] ?? 3) - (REFERENCE_ORDER[b.asset.kind] ?? 3))
      // 只送画面文本(标题+描述)真正提到的素材:台词/说话人里出现的人是画外音,
      // 送了定妆照反而诱导模型把不入场的人画进画面。场景是基调,不受此限。
      const visualText = `${storyboard.title} ${storyboard.description}`
      const mentioned = (name: string) => visualText.includes(name.replace(/（[^）]*）|\([^)]*\)/g, '').trim())
      shotGuardInfo.set(storyboard.id, {
        boundAssetCount: shotLinks.length,
        characters: shotLinks
          .filter(link => link.asset.kind === 'character' && link.asset.status === 'APPROVED')
          .map(link => ({ name: link.asset.name, description: link.asset.description, mentioned: mentioned(link.asset.name) })),
      })
      if (stage !== 'IMAGE') continue
      const referenced = shotLinks
        .filter(link => link.asset.versions[0]?.artifactId)
        .filter(link => link.asset.kind === 'scene' || mentioned(link.asset.name))
        .slice(0, 3)
      const rest = shotLinks.filter(link => !referenced.includes(link))
      const lines: string[] = []
      if (referenced.length > 0) {
        // 定妆照参考图本身是多角度排版,模型容易把排版也复刻进画面——实测出过双格/三格拼图。
        lines.push('输出要求:只生成一幅连续的单画面(电影分镜中的一帧);不要多格拼图、分屏、网格或三视图排版;参考图仅用于锁定人物与物体的外观,不要复刻参考图的排版布局。')
        lines.push('随附参考图按顺序对应以下素材,画面中人物与物体的外观必须与对应素材的外观完全一致:')
        referenced.forEach((link, index) => {
          const sheetKind = link.asset.kind === 'character' ? '角色外观参考' : '设定图'
          lines.push(`图${index + 1}＝${sheetKind}｜${link.asset.kind}·${link.asset.name}：${link.asset.description}`)
        })
      }
      for (const link of rest) {
        lines.push(`其他出场素材｜${link.asset.kind}·${link.asset.name}：${link.asset.description}`)
      }
      if (lines.length > 0) assetContexts.set(storyboard.id, lines.join('\n'))
      if (referenced.length > 0) assetReferences.set(storyboard.id, referenced.map(link => link.asset.versions[0]!.artifactId!))
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
    contentPrompt = episode.project.format === 'FILM'
      ? buildFilmScriptPrompt(locale, source.content, targetDurationMs)
      : buildScriptPrompt(locale, source.content, targetDurationMs)
  }
  if (stage === 'STORYBOARD') {
    const script = await db.scriptVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, orderBy: { version: 'desc' } })
    if (!script) return { ok: false, code: 409, error: 'generations:noApprovedScript' }
    scriptVersionId = script.id
    contentPrompt = buildStoryboardPrompt(locale, script.content, await targetShotDurationMs(db, organizationId, episode.projectId), undefined, style)
  }
  if (stage === 'IMAGE' || stage === 'VIDEO' || stage === 'AUDIO' || stage === 'MUSIC') {
    const script = await db.scriptVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, select: { id: true, content: true } })
    if (!script) return { ok: false, code: 409, error: 'generations:noApprovedScript' }
    if (stage === 'MUSIC') contentPrompt = buildMusicPrompt(locale, script.content)
  }

  const slot = stageSlots[stage]
  const candidates = await resolveSlotCandidates(db, organizationId, episode.projectId, slot)
  if (candidates.length === 0) return { ok: false, code: 409, error: `no verified candidates for slot ${slot}` }

  // Conditioning is the optional half of VIDEO: with a video_i2v bound, a shot's own
  // approved frame becomes the input to its clip, which is what carries a character's face
  // across a cut. The gate does not move — an installation that never bound the slot pays
  // for exactly what it paid for before, and its snapshots keep the shape they had.
  const conditioning = stage === 'VIDEO'
    ? await resolveSlotCandidates(db, organizationId, episode.projectId, 'video_i2v')
    : []

  // A voice task exists only to speak a line; voicing a silent shot would buy
  // audio of nothing, and composition never waits for it. AUDIO still connects
  // the shots it actually planned so a later dialogue edit re-opens the stage.
  const voiced = stage === 'AUDIO' ? selected.filter(storyboard => storyboard.dialogue !== '') : selected
  if (stage === 'AUDIO' && voiced.length === 0) return { ok: false, code: 400, error: 'episode has no shots with dialogue to voice' }

  // The media prompts are deliberately not translated per locale: an asset image, a
  // shot frame and a clip are described by the storyboard text this stage consumes,
  // so they are already in the project's language. Only the voice line needs a
  // formatter, because a speaker marker is script convention rather than content.
  // 定妆照/设定图标准（对齐 docs/skills/film-production 的角色一致性要求）：
  // 角色图是身份锚点，必须多角度、中性背景、无文字——裸描述会生成剧照而非参考图。
  // 角色设定已从"白底三视图"升级为"角色板"（Character Board,2026 行业新标准）：
  // 一张竖版海报内集成身份信息+多角度脸部特写+全身三视图+服饰细节+表情集,
  // 信息密度远高于裸三视图,视频模型能读出更稳定的身份特征。
  // 风格强制 CG 立绘感而非照片级真人——一是规避"真人图像"内容审查
  // (Seedance 2.0 等已明确拒绝真人参考图),二是风格化本身提升跨镜头一致性。
  const ASSET_REFERENCE_SPECS: Record<string, string> = {
    character:
      '角色设定板（Character Board）：单张竖版海报式排版，CG 游戏立绘风格、插画质感（严禁照片级真人质感）。内容按区块集成——①顶部角色名与身份标签；②脸部特写 4 个角度（正面/左右 45 度/侧面），眼神与表情各异；③全身三视图（正面/侧面/背面并排，头顶到脚底完整入画）；④服装与饰品细节拆解（绣纹、配饰、鞋履等圆形小图）；⑤表情参考 6 种小图（常态/喜/怒/惊/悲/思）。严格遵循描述中的年龄、性别与体型，不得幼化或美化；米白纯色背景，无水印；同一角色全板形象严格一致，一致性优先于美观。',
    scene: '场景概念图：无人物空镜，构图与光线符合描述，细节清晰，无文字无水印。',
    prop: '道具设定图：单品居中，中性背景，细节清晰，无文字无水印。',
  }
  const targets: GenerationTarget[] = perAsset
    ? selectedAssets.map(asset => ({
        entityId: asset.id,
        prompt: `${asset.kind} ${asset.name}: ${asset.description}${ASSET_REFERENCE_SPECS[asset.kind] ? `\n\n${ASSET_REFERENCE_SPECS[asset.kind]}` : ''}`,
        assetId: asset.id,
      }))
    : perStoryboard
      ? voiced.map(storyboard => ({
          entityId: storyboard.id,
          prompt: stage === 'AUDIO'
            ? voiceLine(locale, storyboard.speaker, storyboard.dialogue)
            : `${storyboard.title}: ${storyboard.description}${stage === 'IMAGE' && assetContexts.has(storyboard.id) ? `\n\n画面中出现的素材：\n${assetContexts.get(storyboard.id)}` : ''}`,
          storyboardId: storyboard.id,
          ...(stage === 'IMAGE' && assetReferences.has(storyboard.id) ? { assetReferenceArtifactIds: assetReferences.get(storyboard.id) } : {}),
        }))
      : [{ entityId: episode.id, prompt: contentPrompt ?? episode.title, ...(scriptVersionId ? { scriptVersionId } : {}) }]

  // A regeneration note is the human steering the retry — append it so the request
  // snapshot records both the base prompt and the direction this attempt was given.
  const note = options.promptNote?.trim()
  const notedTargets = note
    ? targets.map(target => ({ ...target, prompt: `${target.prompt}\n\n调整要求：${note}` }))
    : targets
  // P7 Prompt 守卫:任务排队开烧前的最后一道机器检查,只管 IMAGE/VIDEO 这两个
  // "长相全靠提示词"的阶段。修复型改写 prompt、警告型只留痕、拦截型让任务直接
  // 落 BLOCKED 不排队;所有留痕随请求快照入库——审计要能回答"这条 prompt 被动过吗、为什么"。
  // 守卫链是有序数组(DEFAULT_PROMPT_GUARDS),增减规则不碰这里。
  const shotById = new Map(selected.map(storyboard => [storyboard.id, storyboard]))
  // 风格预设先于守卫链应用:style-anchor 认得出「视觉风格」标记就不叠加
  // 默认写实基准,显式选的风格永远赢;没有预设时守卫照旧兜底。
  let promptedTargets: GenerationTarget[] = style && (stage === 'IMAGE' || stage === 'VIDEO')
    ? notedTargets.map(target => ({
        ...target,
        prompt: applyStyleToPrompt(stage, target.prompt, style),
      }))
    : notedTargets
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
    : notedTargets

  // A frame is only looked up when a model was bound that can take it: resolving one for a
  // request that would have to drop it spends a query to produce a number nobody reads.
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
    const missing = selected.filter(storyboard => !frames.get(storyboard.id)).map(storyboard => `#${storyboard.number}`)
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
  const parametersField = (key: string) => (billableStages.includes(stage) ? { parameters: { seed: generationSeed(key) } } : {})
  // One task row's fields, keyed by its idempotency key. Shared by the fresh create and
  // by the catch path below, which builds rows for targets the first run never covered.
  const guardStats = (list: GenerationTarget[]) => {
    const findings = list.reduce((sum, target) => sum + (target.guardFindings?.length ?? 0), 0)
    const blocked = list.filter(target => target.blockedReason).length
    return findings + blocked > 0 ? { guardFindings: findings, guardsBlocked: blocked } : {}
  }
  const taskRow = (target: GenerationTarget, key: string) => ({
    organizationId,
    stage: dbStage,
    idempotencyKey: key,
    // 被拦截守卫点名的任务:带着原因落 BLOCKED，界面与待处理泳道都指得回这一镜；
    // 绑定补齐后经重试路径复活，中途不烧任何额度。
    ...(target.blockedReason ? { status: 'BLOCKED' as const, errorSnapshot: target.blockedReason } : {}),
    ...(target.storyboardId ? { storyboardId: target.storyboardId } : {}),
    // ProviderRequest payload; the model and the vendor's dialect keys belong to
    // whichever candidate ends up running, so the worker fills those in. A media
    // task's snapshot already carries the base seed above, because reproducibility
    // must not depend on which model wins the slot. The locale rides
    // in `input` because every adapter picks its input keys explicitly, while
    // `parameters` is forwarded to the vendor as-is — an unknown key there
    // could be rejected by a request the Chinese project already pays for.
    // A reference is an id, not bytes: an approved 1080P frame encoded inline is
    // megabytes, and the artifact row already carries its checksum and mime type.
    // The key is written last so a task without one serialises exactly as before.
    requestSnapshot: JSON.stringify({ input: { prompt: target.prompt, ...localeField }, ...parametersField(key), ...(target.assetId ? { assetId: target.assetId } : {}), ...(target.scriptVersionId ? { scriptVersionId: target.scriptVersionId } : {}), ...(target.referenceArtifactId ? { referenceArtifacts: [{ type: 'first_frame', artifactId: target.referenceArtifactId }] } : {}), ...(target.assetReferenceArtifactIds?.length ? { referenceArtifacts: target.assetReferenceArtifactIds.map(id => ({ type: 'reference_image', artifactId: id })) } : {}), ...(target.guardFindings?.length ? { promptGuards: target.guardFindings } : {}) }),
  })
  // The candidates one task should try, in order. A shot holding its own frame tries the
  // conditioning model first and keeps text-to-video behind it; everyone else shares the
  // slot's order. Keyed by idempotency key, because the rows come back from the database
  // in the order the database chose, not the order we wrote them in.
  const candidatesForKey = (key: string): RunTaskCandidate[] => {
    // 图像阶段的按需排序:带参考图的任务(首帧)编辑模型优先;纯文字出图(定妆照)
    // 纯文生图模型优先——编辑模型裸跑文字出图,质感明显弱于文生图模型(实测)。
    if (stage === 'IMAGE' || stage === 'ASSET') {
      const hasRefs = stage === 'ASSET' ? false : (targetsByKey.get(key)?.assetReferenceArtifactIds?.length ?? 0) > 0
      const ordered = [...candidates].sort((a, b) =>
        hasRefs
          ? Number(b.acceptsReferenceImages ?? false) - Number(a.acceptsReferenceImages ?? false)
          : Number(a.acceptsReferenceImages ?? false) - Number(b.acceptsReferenceImages ?? false),
      )
      return ordered.map(toRunTaskCandidate)
    }
    if (conditioning.length === 0) return candidates.map(toRunTaskCandidate)
    const target = promptedTargets.find((_, index) => idempotencyKeys[index] === key)
    const plan = planVideoModels([...conditioning, ...candidates], target?.referenceArtifactId !== undefined)
    return plan.candidates.map(toRunTaskCandidate)
  }
  try {
    const batch = await db.generationBatch.create({
      data: {
        organizationId,
        episodeId: episode.id,
        stage: dbStage,
        plannedCount: promptedTargets.length,
        // Which shots the batch was planned against. `nextRunnableStage` reads this to
        // tell a stage that ran for the live shots from one that only covers superseded
        // ones; the clip of an individual shot comes from the task's own storyboardId.
        // For AUDIO that set is exactly the shots with dialogue — a shot that gains
        // its line later is not covered, which re-opens the stage on the next advance.
        storyboards: { connect: voiced.map(storyboard => ({ id: storyboard.id })) },
        tasks: { create: promptedTargets.map((target, index) => taskRow(target, idempotencyKeys[index])) },
      },
      include: { tasks: true },
    })
    // Queued tasks roll the batch up to RUNNING; without this the batch would
    // read DRAFT until the worker happened to pick the first task up.
    await syncBatchStatus(db, batch.id)
    for (const task of batch.tasks) {
      // 守卫拦下的任务不排队:额度一分不烧,等人补齐输入后由重试路径复活。
      if (task.status === 'BLOCKED') continue
      await store.enqueueJob({ kind: 'run-task', taskId: task.id, organizationId, attempt: 1, candidates: candidatesForKey(task.idempotencyKey ?? '') })
    }
    await audit(db, { organizationId, userId, action: options.regenerate ? 'generation.regenerate' : 'generation.trigger', entityType: 'generation-batch', entityId: batch.id, payload: { stage, plannedCount: batch.plannedCount, revision, ...guardStats(promptedTargets) } })
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
      select: { id: true, batchId: true, stage: true, idempotencyKey: true, status: true },
    })
    const existingKeys = new Set(existing.map(task => task.idempotencyKey))
    const missingTargets = promptedTargets.filter((_, index) => !existingKeys.has(idempotencyKeys[index]))
    // BLOCKED 与 FAILED 同属"这一阶段还欠这个目标一个结果":守卫拦下的任务在
    // 人补齐输入(如绑定素材)后重触发,就经这条路复活并重排。
    const retryable = existing.filter(task => task.status === 'FAILED' || task.status === 'BLOCKED')
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
    await audit(db, { organizationId, userId, action: 'generation.retry', entityType: 'generation-batch', entityId: retryable[0]?.batchId ?? existing[0]?.batchId ?? '', payload: { stage, retried: retryable.length, created: missingTargets.length, ...guardStats(promptedTargets) } })
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
  disposition: 'new' | 'retry' | 'skipped'
}

export interface GenerationPlan {
  stage: GenerationStage
  /** `provider/model`, in the order the worker would try them. */
  models: string[]
  items: GenerationPlanItem[]
  newCount: number
  retryCount: number
  skippedCount: number
  /** Physical runtime of the shots the plan would still run; per-shot stages only. */
  durationMs: number | null
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
      storyboards: {
        where: { supersededAt: null },
        orderBy: [{ revision: 'asc' }, { number: 'asc' }],
        select: { id: true, number: true, title: true, durationMs: true, dialogue: true },
      },
      assets: { orderBy: { id: 'asc' }, select: { id: true, kind: true, name: true } },
    },
  })
  if (!episode) return { ok: false, code: 404, error: 'Episode not found' }

  const perStoryboard = stage === 'IMAGE' || stage === 'VIDEO' || stage === 'AUDIO'
  const perAsset = stage === 'ASSET'
  let selected = perStoryboard ? episode.storyboards : []
  if (perStoryboard && options.storyboardIds) {
    selected = selected.filter(storyboard => options.storyboardIds!.includes(storyboard.id))
    if (selected.length !== new Set(options.storyboardIds).size) return { ok: false, code: 400, error: 'storyboardIds must belong to this episode' }
  }
  if (perStoryboard && selected.length === 0) return { ok: false, code: 400, error: 'episode has no storyboards to generate' }
  let selectedAssets = perAsset ? episode.assets : []
  if (perAsset && options.assetIds) {
    selectedAssets = selectedAssets.filter(asset => options.assetIds!.includes(asset.id))
    if (selectedAssets.length !== new Set(options.assetIds).size) return { ok: false, code: 400, error: 'assetIds must belong to this episode' }
  }
  if (perAsset && selectedAssets.length === 0) return { ok: false, code: 400, error: 'episode has no assets to generate' }
  const voiced = stage === 'AUDIO' ? selected.filter(storyboard => storyboard.dialogue !== '') : selected
  if (stage === 'AUDIO' && voiced.length === 0) return { ok: false, code: 400, error: 'episode has no shots with dialogue to voice' }

  if (stage === 'SCRIPT') {
    const source = await db.sourceDocumentVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, select: { id: true } })
    if (!source) return { ok: false, code: 409, error: 'generations:noApprovedSource' }
  }
  if (stage !== 'SCRIPT' && stage !== 'ASSET') {
    const script = await db.scriptVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, select: { id: true } })
    if (!script) return { ok: false, code: 409, error: 'generations:noApprovedScript' }
  }
  if (stage === 'IMAGE') {
    const links = await db.storyboardAsset.findMany({
      where: { storyboardId: { in: voiced.map(storyboard => storyboard.id) } },
      include: { asset: { select: { kind: true, name: true, status: true } } },
    })
    const drafts = [...new Set(links.filter(link => link.asset.status !== 'APPROVED').map(link => `${link.asset.kind} · ${link.asset.name}`))]
    if (drafts.length > 0) return { ok: false, code: 409, error: 'generations:assetsNotApproved', reasons: drafts }
  }

  const slot = stageSlots[stage]
  const candidates = await resolveSlotCandidates(db, organizationId, episode.projectId, slot)
  if (candidates.length === 0) return { ok: false, code: 409, error: `no verified candidates for slot ${slot}` }

  if (stage === 'VIDEO') {
    const conditioning = await resolveSlotCandidates(db, organizationId, episode.projectId, 'video_i2v')
    if (conditioning.length > 0) {
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
  }

  // The plain key collides with a run that already happened, which is exactly what
  // distinguishes retry from skipped below; a regenerate carries the same fresh
  // revision suffix triggerStage would write, so everything it covers reads as new.
  const revision = options.regenerate
    ? await db.generationBatch.count({ where: { episodeId: episode.id, stage: stageDbValues[stage] } })
    : 0
  const suffix = revision > 0 ? `:r${revision}` : ''
  const targets = perAsset
    ? selectedAssets.map(asset => ({ id: asset.id, label: `${asset.kind} · ${asset.name}`, durationMs: null as number | null }))
    : perStoryboard
      ? voiced.map(storyboard => ({ id: storyboard.id, label: `#${storyboard.number} ${storyboard.title}`, durationMs: storyboard.durationMs as number | null }))
      : [{ id: episode.id, label: episode.title, durationMs: null as number | null }]
  const keys = targets.map(target => `${episode.id}:${stage}:${target.id}${suffix}`)
  const existing = await db.generationTask.findMany({
    where: { organizationId, idempotencyKey: { in: keys } },
    select: { idempotencyKey: true, status: true },
  })
  const statusByKey = new Map(existing.map(task => [task.idempotencyKey, task.status]))
  const items: GenerationPlanItem[] = targets.map((target, index) => {
    const status = statusByKey.get(keys[index])
    return {
      id: target.id,
      label: target.label,
      // FAILED/BLOCKED 都是"还欠一个结果":前者重试过、后者会被真触发复活,预审按 retry 报账才不骗人。
      disposition: status === undefined ? 'new' : status === 'FAILED' || status === 'BLOCKED' ? 'retry' : 'skipped',
    }
  })
  const billable = new Set(items.filter(item => item.disposition !== 'skipped').map(item => item.id))
  return {
    ok: true,
    plan: {
      stage,
      models: candidates.map(candidate => `${candidate.provider}/${candidate.model}`),
      items,
      newCount: items.filter(item => item.disposition === 'new').length,
      retryCount: items.filter(item => item.disposition === 'retry').length,
      skippedCount: items.filter(item => item.disposition === 'skipped').length,
      durationMs: perStoryboard ? targets.filter(target => billable.has(target.id)).reduce((sum, target) => sum + (target.durationMs ?? 0), 0) : null,
      revision,
    },
  }
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
