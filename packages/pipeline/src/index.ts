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

interface GenerationTarget {
  entityId: string
  prompt: string
  assetId?: string
  scriptVersionId?: string
}

/** Everything a trigger needs: a database and a way to enqueue pipeline jobs. */
export interface PipelineStore {
  db: PrismaClient
  enqueueJob(payload: PipelinePayload): Promise<void>
}

export type TriggerResult = { ok: true; batchId: string; created: boolean } | { ok: false; code: number; error: string }

export type AdvanceResult =
  | { ok: true; stage: PipelineStage; batchId: string; created: boolean }
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
 * name. Prerequisites mirror the trigger gates: SCRIPT needs an approved source,
 * STORYBOARD/IMAGE/VIDEO an approved script, ASSET at least one authored asset,
 * and IMAGE/VIDEO at least one storyboard.
 */
export async function nextRunnableStage(db: PrismaClient, episodeId: string): Promise<PipelineStage | null> {
  const [approvedSource, approvedScript, assetCount, storyboardCount, batches] = await Promise.all([
    db.sourceDocumentVersion.findFirst({ where: { episodeId, status: 'APPROVED' }, select: { id: true } }),
    db.scriptVersion.findFirst({ where: { episodeId, status: 'APPROVED' }, select: { id: true } }),
    db.asset.count({ where: { episodeId } }),
    db.storyboard.count({ where: { episodeId } }),
    db.generationBatch.findMany({ where: { episodeId }, select: { stage: true } }),
  ])
  const run = new Set<Stage>(batches.map(batch => batch.stage))

  for (const stage of PIPELINE_STAGES) {
    if (run.has(stageDbValues[stage])) continue
    const ready =
      stage === 'SCRIPT' ? approvedSource !== null
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
 */
export async function triggerStage(
  store: PipelineStore,
  organizationId: string,
  userId: string | null,
  episodeId: string,
  stage: GenerationStage,
  options: { storyboardIds?: string[] } = {},
): Promise<TriggerResult> {
  const { db } = store
  const episode = await db.episode.findFirst({
    where: { id: episodeId, project: { organizationId } },
    include: { storyboards: { orderBy: { number: 'asc' } }, assets: { orderBy: { id: 'asc' } } },
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
    contentPrompt = `把以下剧本拆分成连续的分镜镜头，输出一个 JSON 数组，每个元素包含 number、title、description、sourceExcerpt、durationMs（毫秒）、continuityIn、continuityOut。只输出 JSON，不要其它说明。\n\n剧本：\n${script.content}`
  }
  if (stage === 'IMAGE' || stage === 'VIDEO' || stage === 'AUDIO') {
    const script = await db.scriptVersion.findFirst({ where: { episodeId: episode.id, status: 'APPROVED' }, select: { id: true } })
    if (!script) return { ok: false, code: 409, error: 'generations:noApprovedScript' }
  }

  const targets: GenerationTarget[] = perAsset
    ? episode.assets.map(asset => ({ entityId: asset.id, prompt: `${asset.kind} ${asset.name}: ${asset.description}`, assetId: asset.id }))
    : perStoryboard
      ? selected.map(storyboard => ({ entityId: storyboard.id, prompt: `${storyboard.title}: ${storyboard.description}` }))
      : [{ entityId: episode.id, prompt: contentPrompt ?? episode.title, ...(scriptVersionId ? { scriptVersionId } : {}) }]

  const slot = stageSlots[stage]
  const candidates = await resolveSlotCandidates(db, organizationId, episode.projectId, slot)
  if (candidates.length === 0) return { ok: false, code: 409, error: `no verified candidates for slot ${slot}` }

  const dbStage = stageDbValues[stage]
  const idempotencyKeys = targets.map(target => `${episode.id}:${stage}:${target.entityId}`)
  try {
    const batch = await db.generationBatch.create({
      data: {
        organizationId,
        episodeId: episode.id,
        stage: dbStage,
        plannedCount: targets.length,
        // The composition worker walks batch → storyboards to find each clip.
        storyboards: { connect: selected.map(storyboard => ({ id: storyboard.id })) },
        tasks: {
          create: targets.map((target, index) => ({
            organizationId,
            stage: dbStage,
            idempotencyKey: idempotencyKeys[index],
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
    await audit(db, { organizationId, userId, action: 'generation.trigger', entityType: 'generation-batch', entityId: batch.id, payload: { stage, plannedCount: batch.plannedCount } })
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
 * met and which has not run yet. `auto` marks the audit so a worker-initiated
 * relay is distinguishable from a human clicking "advance". Returns
 * `pipeline:nothingRunnable` when every stage is run or paused on an approval.
 */
export async function advancePipeline(
  store: PipelineStore,
  organizationId: string,
  userId: string | null,
  episodeId: string,
  options: { auto?: boolean } = {},
): Promise<AdvanceResult> {
  const stage = await nextRunnableStage(store.db, episodeId)
  if (!stage) return { ok: false, code: 409, error: 'pipeline:nothingRunnable' }
  const result = await triggerStage(store, organizationId, userId, episodeId, stage)
  if (!result.ok) return result
  await audit(store.db, {
    organizationId,
    userId,
    action: options.auto ? 'pipeline.autoAdvance' : 'pipeline.advance',
    entityType: 'episode',
    entityId: episodeId,
    payload: { stage, batchId: result.batchId },
  })
  return { ok: true, stage, batchId: result.batchId, created: result.created }
}
