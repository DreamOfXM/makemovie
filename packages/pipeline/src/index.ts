import type { PrismaClient, SlotCandidate, Stage } from '@studio/db'
import { resolveSlotCandidates, syncBatchStatus } from '@studio/db'
import type { CapabilitySlot } from '@studio/domain'
import type { PipelinePayload, RunTaskCandidate } from '@studio/jobs'

/**
 * Generation orchestration shared by the API (a human triggers a stage) and the
 * worker (a completed batch auto-advances to the next one). Keeping it here means
 * both paths gate, prompt, batch, enqueue, and audit identically — the pipeline
 * behaves the same whether a person or the worker pushed it forward.
 */

export const generationStages = ['SCRIPT', 'ASSET', 'STORYBOARD', 'IMAGE', 'VIDEO', 'AUDIO'] as const
export type GenerationStage = (typeof generationStages)[number]

/** The stages the pipeline advances through on its own, in order. */
export const PIPELINE_STAGES = ['SCRIPT', 'STORYBOARD', 'ASSET', 'IMAGE', 'VIDEO'] as const
export type PipelineStage = (typeof PIPELINE_STAGES)[number]

const stageSlots: Record<GenerationStage, CapabilitySlot> = {
  SCRIPT: 'script_text',
  ASSET: 'image_gen',
  STORYBOARD: 'storyboard_text',
  IMAGE: 'image_gen',
  VIDEO: 'video_t2v',
  AUDIO: 'tts_voice',
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

/** A shot the pipeline still owes media to. */
export interface LiveStoryboard {
  id: string
  revision: number
  number: number
  title: string
  durationMs: number
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
    select: { id: true, revision: true, number: true, title: true, durationMs: true },
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
  const tasks = await db.generationTask.findMany({
    where: {
      status: 'SUCCEEDED',
      stage: 'VIDEO',
      storyboardId: { not: null },
      batch: { episodeId },
      artifacts: { some: { stage: 'VIDEO' } },
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

/**
 * Whether the episode can be composed now. Composition has no provider, no prompt
 * and no capability slot, so it is planned apart from PIPELINE_STAGES. It is not
 * once-per-episode either: re-cutting the same shot list would only spend ffmpeg
 * time re-making a master that already exists, but a regenerate supersedes shots
 * and leaves that master cut from a breakdown the episode no longer uses, so a
 * changed shot list is worth composing again. Composing before every live shot has
 * a clip is skipped, since it is guaranteed to land in BLOCKED.
 */
export async function planComposition(db: PrismaClient, episodeId: string): Promise<CompositionPlan> {
  const storyboards = await liveStoryboards(db, episodeId)
  if (storyboards.length === 0) return { ready: false, reason: 'composition:noStoryboards' }
  const composed = await composedStoryboardIds(db, episodeId)
  if (storyboards.some(storyboard => !composed.has(storyboard.id))) return { ready: false, reason: 'composition:missingVideo' }

  const storyboardIds = storyboards.map(storyboard => storyboard.id)
  const latest = await db.composition.findFirst({ where: { episodeId }, orderBy: { id: 'desc' } })
  if (latest && sameShots(manifestStoryboardIds(latest.manifest), storyboardIds)) {
    return { ready: false, reason: 'composition:alreadyPlanned' }
  }
  return { ready: true, storyboardIds }
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

interface GenerationTarget {
  entityId: string
  prompt: string
  assetId?: string
  scriptVersionId?: string
  /** Set for the shot-scoped stages: the shot this task's artifact depicts. */
  storyboardId?: string
}

/** Everything a trigger needs: a database and a way to enqueue pipeline jobs. */
export interface PipelineStore {
  db: PrismaClient
  enqueueJob(payload: PipelinePayload): Promise<void>
}

export type TriggerResult = { ok: true; batchId: string; created: boolean } | { ok: false; code: number; error: string }

export type AdvanceResult =
  | { ok: true; step: 'stage'; stage: PipelineStage; batchId: string; created: boolean }
  | { ok: true; step: 'composition'; compositionId: string }
  | { ok: false; code: number; error: string }

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
export async function nextRunnableStage(db: PrismaClient, episodeId: string): Promise<PipelineStage | null> {
  const [approvedSource, approvedScript, assetCount, storyboardCount, batches, liveBatches] = await Promise.all([
    db.sourceDocumentVersion.findFirst({ where: { episodeId, status: 'APPROVED' }, select: { id: true } }),
    db.scriptVersion.findFirst({ where: { episodeId, status: 'APPROVED' }, select: { id: true } }),
    db.asset.count({ where: { episodeId } }),
    db.storyboard.count({ where: { episodeId, supersededAt: null } }),
    db.generationBatch.findMany({ where: { episodeId }, select: { stage: true, _count: { select: { storyboards: true } } } }),
    db.generationBatch.findMany({ where: { episodeId, storyboards: { some: { supersededAt: null } } }, select: { stage: true } }),
  ])
  const coveringLiveShots = new Set<Stage>(liveBatches.map(batch => batch.stage))
  const run = new Set<Stage>(batches.filter(batch => batch._count.storyboards === 0 || coveringLiveShots.has(batch.stage)).map(batch => batch.stage))

  for (const stage of PIPELINE_STAGES) {
    if (run.has(stageDbValues[stage])) continue
    // An approved script is what SCRIPT exists to produce, so a human who derived or
    // wrote the script themselves has already produced it: planning the stage anyway
    // would buy a generation nobody asked for and leave a second draft behind.
    const ready =
      stage === 'SCRIPT' ? approvedSource !== null && approvedScript === null
      : stage === 'STORYBOARD' ? approvedScript !== null
      : stage === 'ASSET' ? assetCount > 0
      : approvedScript !== null && storyboardCount > 0
    if (ready) return stage
  }
  return null
}

/**
 * Plans and enqueues one stage for an episode: resolves the gate, builds each
 * target's prompt (content stages inject the approved upstream text), creates the
 * batch and its tasks, and queues a run-task job per task. Idempotent on
 * `${episodeId}:${stage}:${entityId}` — re-triggering a stage that already ran
 * returns the existing batch instead of duplicating work.
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
  options: { storyboardIds?: string[]; regenerate?: boolean } = {},
): Promise<TriggerResult> {
  const { db } = store
  const episode = await db.episode.findFirst({
    where: { id: episodeId, project: { organizationId } },
    // Superseded shots are history: generating media for them would pay for clips
    // belonging to a breakdown the episode no longer uses, and connecting them to
    // the batch would make the composition walk shots that were replaced.
    include: { storyboards: { where: { supersededAt: null }, orderBy: [{ revision: 'asc' }, { number: 'asc' }] }, assets: { orderBy: { id: 'asc' } } },
  })
  if (!episode) return { ok: false, code: 404, error: 'Episode not found' }

  const perStoryboard = stage === 'IMAGE' || stage === 'VIDEO'
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

  // Content and media stages are gated on the upstream version a human approved:
  // a script is written from an approved source, storyboards are broken out of an
  // approved script, and no image/video/audio is generated until that script is
  // approved — otherwise money is spent on visuals nobody signed off on.
  let scriptVersionId: string | undefined
  let contentPrompt: string | undefined
  if (stage === 'SCRIPT') {
    const source = await db.sourceDocumentVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, orderBy: { version: 'desc' } })
    if (!source) return { ok: false, code: 409, error: 'generations:noApprovedSource' }
    contentPrompt = `根据以下源文档，写出这一集的完整拍摄剧本：\n\n${source.content}`
  }
  if (stage === 'STORYBOARD') {
    const script = await db.scriptVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, orderBy: { version: 'desc' } })
    if (!script) return { ok: false, code: 409, error: 'generations:noApprovedScript' }
    scriptVersionId = script.id
    contentPrompt = [
      '把以下剧本拆分成连续的分镜镜头，并从中提取这一集要用到的角色、道具和场景。',
      '只输出一个 JSON 对象，不要任何其它说明，结构如下：',
      '{"shots":[{"title":"镜头标题","description":"画面与动作","sourceExcerpt":"对应的剧本原文","durationMs":5000,"continuityIn":"承接上一镜","continuityOut":"留给下一镜"}],',
      '"assets":[{"kind":"character","name":"唯一名称","description":"外形与气质，用于生成参考图"}]}',
      'shots 按剧情先后排列，镜头编号由顺序决定，不要自己写；durationMs 是该镜头的毫秒时长。',
      'assets 的 kind 只能是 character、prop、scene 三者之一，同一个人物或物件只写一次。',
      '',
      '剧本：',
      script.content,
    ].join('\n')
  }
  if (stage === 'IMAGE' || stage === 'VIDEO' || stage === 'AUDIO') {
    const script = await db.scriptVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, select: { id: true } })
    if (!script) return { ok: false, code: 409, error: 'generations:noApprovedScript' }
  }

  const targets: GenerationTarget[] = perAsset
    ? episode.assets.map(asset => ({ entityId: asset.id, prompt: `${asset.kind} ${asset.name}: ${asset.description}`, assetId: asset.id }))
    : perStoryboard
      ? selected.map(storyboard => ({ entityId: storyboard.id, prompt: `${storyboard.title}: ${storyboard.description}`, storyboardId: storyboard.id }))
      : [{ entityId: episode.id, prompt: contentPrompt ?? episode.title, ...(scriptVersionId ? { scriptVersionId } : {}) }]

  const slot = stageSlots[stage]
  const candidates = await resolveSlotCandidates(db, organizationId, episode.projectId, slot)
  if (candidates.length === 0) return { ok: false, code: 409, error: `no verified candidates for slot ${slot}` }

  const dbStage = stageDbValues[stage]
  // A regenerate re-runs a stage that already has a batch, so it needs keys that do
  // not collide with the prior run. The revision is appended as a fourth segment,
  // leaving the first three (episode, stage, entity) readable.
  const revision = options.regenerate
    ? await db.generationBatch.count({ where: { episodeId: episode.id, stage: dbStage } })
    : 0
  const suffix = revision > 0 ? `:r${revision}` : ''
  const idempotencyKeys = targets.map(target => `${episode.id}:${stage}:${target.entityId}${suffix}`)
  try {
    const batch = await db.generationBatch.create({
      data: {
        organizationId,
        episodeId: episode.id,
        stage: dbStage,
        plannedCount: targets.length,
        // Which shots the batch was planned against. `nextRunnableStage` reads this to
        // tell a stage that ran for the live shots from one that only covers superseded
        // ones; the clip of an individual shot comes from the task's own storyboardId.
        storyboards: { connect: selected.map(storyboard => ({ id: storyboard.id })) },
        tasks: {
          create: targets.map((target, index) => ({
            organizationId,
            stage: dbStage,
            idempotencyKey: idempotencyKeys[index],
            ...(target.storyboardId ? { storyboardId: target.storyboardId } : {}),
            // ProviderRequest payload; model and parameters belong to whichever
            // candidate ends up running, so the worker fills them in.
            requestSnapshot: JSON.stringify({ input: { prompt: target.prompt }, ...(target.assetId ? { assetId: target.assetId } : {}), ...(target.scriptVersionId ? { scriptVersionId: target.scriptVersionId } : {}) }),
          })),
        },
      },
      include: { tasks: true },
    })
    // Queued tasks roll the batch up to RUNNING; without this the batch would
    // read DRAFT until the worker happened to pick the first task up.
    await syncBatchStatus(db, batch.id)
    for (const task of batch.tasks) {
      await store.enqueueJob({ kind: 'run-task', taskId: task.id, organizationId, attempt: 1, candidates: candidates.map(toRunTaskCandidate) })
    }
    await audit(db, { organizationId, userId, action: options.regenerate ? 'generation.regenerate' : 'generation.trigger', entityType: 'generation-batch', entityId: batch.id, payload: { stage, plannedCount: batch.plannedCount, revision } })
    return { ok: true, batchId: batch.id, created: true }
  } catch (error) {
    if (!isPrismaUniqueViolation(error)) throw error
    const existing = await db.generationTask.findFirst({ where: { organizationId, idempotencyKey: { in: idempotencyKeys } } })
    if (!existing) throw error
    return { ok: true, batchId: existing.batchId, created: false }
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
 * `pipeline:nothingRunnable` when nothing can be started and nothing can be composed.
 */
export async function advancePipeline(
  store: PipelineStore,
  organizationId: string,
  userId: string | null,
  episodeId: string,
  options: { auto?: boolean } = {},
): Promise<AdvanceResult> {
  const action = options.auto ? 'pipeline.autoAdvance' : 'pipeline.advance'
  const stage = await nextRunnableStage(store.db, episodeId)
  if (stage) {
    const result = await triggerStage(store, organizationId, userId, episodeId, stage)
    if (!result.ok) return result
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

  const plan = await planComposition(store.db, episodeId)
  if (!plan.ready) return { ok: false, code: 409, error: 'pipeline:nothingRunnable' }
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
