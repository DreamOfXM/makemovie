import type { Stage } from '@studio/db'
import type { ModelModality } from '@studio/domain'
import { sha256 } from '@studio/media'
import type { QcMode } from './config.js'

export const QC_THRESHOLD = 0.7

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
}

/**
 * `unjudged` is not a soft pass and not a soft fail: the audit could not happen,
 * so the score stays null and the caller must not regenerate the artifact.
 */
export type QcVerdict =
  | { kind: QcKind; decision: 'pass'; score: number }
  | { kind: QcKind; decision: 'rework'; score: number; reasons: string[] }
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
