import type { Stage } from '@studio/db'
import type { ModelModality } from '@studio/domain'
import { sha256 } from '@studio/media'
import { QC_THRESHOLD } from '@studio/pipeline'
import type { QcMode } from './config.js'

// The floor is a pipeline rule, not a worker rule: the console reads the same number off
// the generations endpoint. Re-exported so `./qc.js` stays the one place worker code imports it from.
export { QC_THRESHOLD }

/**
 * `fake-qc` is the placeholder: a score nobody should read as a quality signal.
 * `visual-audit` means a model actually looked at the artifact.
 */
export type QcKind = 'fake-qc' | 'visual-audit'

/** Captured after the artifact is stored, so a checker never has to re-download it. */
export interface QcSubject {
  organizationId: string
  projectId: string
  stage: Stage
  modality: ModelModality
  mimeType: string
  bytes: Uint8Array
  prompt: string
  workdir: string
  durationMs?: number
  /**
   * US-032 FR-Q04: the task the artifact belongs to. When present, the model
   * checker enforces the per-task audit-call budget before dialing the provider
   * (the count is one query over the qualityCheck rows this task already wrote).
   * Older callers that omit it are simply not budget-gated.
   */
  taskId?: string
  /**
   * The shot's own frame, as the inline image this task actually sent to the video model.
   * Present only when conditioning happened, and shared rather than re-encoded: an auditor
   * that judges the clip against a different image than the model did is judging nothing.
   */
  referenceDataUrl?: string
  /**
   * SD-098: what the script asked this shot to show. The auditor otherwise compares the
   * sampled frames against the first frame alone, so a fade-to-black or a character the
   * shot itself introduces reads as a continuity break — and the fix costs another paid
   * roll for doing exactly what was written. Absent for artifacts with no shot behind
   * them (assets, storyboards) and for older callers.
   */
  shotIntent?: ShotIntent
}

/**
 * The two shot fields that decide whether a change of picture is a defect: what the
 * shot asked to happen, and the state its last frame owes the next shot.
 */
export interface ShotIntent {
  description: string
  continuityOut: string
}

/** US-032: one structured problem the auditor saw, pinned to a frame when it can be. */
export interface AuditFinding {
  dimension: 'content' | 'aesthetic' | 'continuity'
  severity: 'warning' | 'info'
  message: string
  /**
   * The timestamp of the sampled frame the problem is visible at. `null` = the
   * model named no time point (or the artifact is a still image): evidence stays
   * unpinned rather than pinned to a guess.
   */
  evidenceTimeSeconds: number | null
}

/** US-032: the per-frame 0..1 score the multi-point audit asks the model for. */
export interface AuditFrameScore {
  /** Relative position inside the clip (0..1), matching the prompt's frame labels. */
  position: number
  score: number
}

/**
 * `unjudged` is not a soft pass and not a soft fail: the audit could not happen,
 * so the score stays null and the caller must not regenerate the artifact.
 *
 * `findings`/`frameScores` are US-032 evidence only: they ride along on scored
 * verdicts and never influence the pass/rework decision, which stays a function
 * of `score` and `QC_THRESHOLD` alone.
 */
export type QcVerdict =
  | { kind: QcKind; decision: 'pass'; score: number; findings?: AuditFinding[]; frameScores?: AuditFrameScore[] }
  | { kind: QcKind; decision: 'rework'; score: number; reasons: string[]; findings?: AuditFinding[]; frameScores?: AuditFrameScore[] }
  | { kind: QcKind; decision: 'unjudged'; reasons: string[] }

export interface QualityChecker {
  check(subject: QcSubject): Promise<QcVerdict>
}

export type AuditPlan = 'image' | 'frame' | 'none'

/**
 * What a model can actually be shown. A still image is sent as-is; a clip is
 * reduced to one representative frame, which cannot reveal stutter or drift; and
 * text, audio and a vlm's own answer have no visual surface to judge at all.
 */
export function auditPlanFor(modality: ModelModality): AuditPlan {
  if (modality === 'image') return 'image'
  if (modality === 't2v' || modality === 'i2v' || modality === 'r2v') return 'frame'
  return 'none'
}

/**
 * The default audit. Its score is a hash of the task id and attempt number, so it
 * is deterministic, free and needs no bound model — which is exactly why it stays
 * the default, exactly why the row it writes says `fake-qc`, and exactly why it
 * declines to score anything with no visual surface to stand in for.
 */
export class HashQualityChecker implements QualityChecker {
  private readonly taskId: string
  private readonly attempt: number
  private readonly mode: QcMode

  constructor(taskId: string, attempt: number, mode: QcMode) {
    // Without this, mode=model with no checker supplied would fall through to the
    // hash and the pipeline would look audited when it was not.
    if (mode === 'model') {
      throw new Error('HashQualityChecker cannot serve STUDIO_QC_MODE=model: supply a ModelQualityChecker')
    }
    this.taskId = taskId
    this.attempt = attempt
    this.mode = mode
  }

  async check(subject: QcSubject): Promise<QcVerdict> {
    // The hash stands in for a visual audit, so it only gets to judge artifacts
    // that have a visual surface. Scoring a script or a soundtrack with it would
    // reject content on a number that is not a quality signal for it.
    if (auditPlanFor(subject.modality) === 'none') return { kind: 'fake-qc', decision: 'pass', score: 1 }

    const score = qcScore(this.taskId, this.attempt, this.mode)
    if (score >= QC_THRESHOLD) return { kind: 'fake-qc', decision: 'pass', score }
    return {
      kind: 'fake-qc',
      decision: 'rework',
      score,
      reasons: [`hash score ${score.toFixed(3)} below threshold ${QC_THRESHOLD}`],
    }
  }
}

function qcScore(taskId: string, attempt: number, mode: QcMode): number {
  if (mode === 'pass') return 1
  if (mode === 'fail') return 0.1
  const digest = sha256(new TextEncoder().encode(`${taskId}:${attempt}`))
  return Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff
}
