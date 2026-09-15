import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PrismaClient } from '@studio/db'
import { resolveSlotCandidates } from '@studio/db'
import { extractFrame, extensionFor, toDataUrl } from '@studio/media'
import { createAdapter, type PollResult, type ProviderRequest } from '@studio/providers'
import { decryptSecret } from '@studio/security'
import { errorMessage, pollToSettled, toCapability } from './provider-call.js'
import { auditPlanFor, QC_THRESHOLD, type AuditPlan, type QcSubject, type QcVerdict, type QualityChecker } from './qc.js'

export interface AuditVerdict {
  score: number
  reasons: string[]
}

/** What the auditor is shown: the artifact itself, or one frame pulled out of it. */
export interface AuditImage {
  bytes: Uint8Array
  mimeType: string
}

export interface ModelCheckerOptions {
  db: PrismaClient
  masterKey: string
  pollIntervalMs?: number
  pollTimeoutMs: number
}

/**
 * Asks a bound `visual_audit` model to judge the artifact. Every way this can go
 * wrong — no binding, no ffmpeg, a provider error, an answer that is not a
 * verdict — returns `unjudged` rather than a score, so a broken audit can never
 * look like a passed one.
 */
export class ModelQualityChecker implements QualityChecker {
  private readonly db: PrismaClient
  private readonly masterKey: string
  private readonly pollIntervalMs?: number
  private readonly pollTimeoutMs: number

  constructor(options: ModelCheckerOptions) {
    this.db = options.db
    this.masterKey = options.masterKey
    this.pollIntervalMs = options.pollIntervalMs
    this.pollTimeoutMs = options.pollTimeoutMs
  }

  async check(subject: QcSubject): Promise<QcVerdict> {
    const plan = auditPlanFor(subject.modality)
    // Text and audio have no visual surface to show a model. That is not a broken
    // audit, it is nothing to audit, so they pass rather than coming back
    // "unjudged" (which would fail the task and block the content pipeline).
    if (plan === 'none') return { kind: 'fake-qc', decision: 'pass', score: 1 }

    const candidates = await resolveSlotCandidates(this.db, subject.organizationId, subject.projectId, 'visual_audit')
    const candidate = candidates[0]
    if (!candidate) return unjudged('no verified visual_audit binding')

    const connection = await this.db.providerConnection.findUnique({ where: { id: candidate.connectionId } })
    const row = await this.db.modelCapability.findUnique({ where: { id: candidate.capabilityId } })
    if (!connection || !row) return unjudged(`visual_audit capability ${candidate.capabilityId} is gone`)

    let image: AuditImage
    try {
      image = plan === 'image'
        ? { bytes: subject.bytes, mimeType: subject.mimeType }
        : await frameOf(subject)
    } catch (error) {
      return unjudged(`frame extraction failed: ${errorMessage(error)}`)
    }

    const capability = toCapability(connection.provider, row)
    const adapter = createAdapter(connection.provider, {
      apiKey: decryptSecret(connection.encryptedSecret, this.masterKey),
      accessKey: connection.accessKeyEncrypted ? decryptSecret(connection.accessKeyEncrypted, this.masterKey) : undefined,
      baseUrl: connection.baseUrl,
    })
    const request: ProviderRequest = {
      model: candidate.model,
      input: {
        prompt: buildAuditPrompt(subject, plan),
        images: auditImages(subject, image),
      },
      parameters: {},
    }

    let result: PollResult
    try {
      const submitted = await adapter.submit(capability, request)
      result = await pollToSettled(adapter, capability, submitted.taskId, {
        intervalMs: this.pollIntervalMs,
        timeoutMs: this.pollTimeoutMs,
      })
    } catch (error) {
      return unjudged(`${candidate.provider}/${candidate.model} call failed: ${errorMessage(error)}`)
    }
    if (result.status === 'failed') {
      return unjudged(`${candidate.provider}/${candidate.model} reported failure: ${result.error ?? 'unknown'}`)
    }

    const verdict = parseVerdict(result.text ?? '')
    if (!verdict) return unjudged(`${candidate.provider}/${candidate.model} returned no parseable verdict`)

    if (verdict.score >= QC_THRESHOLD) return { kind: 'visual-audit', decision: 'pass', score: verdict.score }
    return {
      kind: 'visual-audit',
      decision: 'rework',
      score: verdict.score,
      reasons: verdict.reasons.length > 0 ? verdict.reasons : [`score ${verdict.score} below threshold ${QC_THRESHOLD}`],
    }
  }
}

/**
 * The artifact under audit is image 1 whether or not a reference follows it, because
 * every sentence the prompt spends on "the image" means the thing being judged —
 * swapping the order would have the model compare the reference against itself.
 */
export function auditImages(subject: QcSubject, image: AuditImage): string[] {
  // Already a data URL, and already the bytes the video model saw: re-encoding here
  // would let the auditor compare a frame nobody conditioned the shot on.
  return subject.referenceDataUrl
    ? [toDataUrl(image.bytes, image.mimeType), subject.referenceDataUrl]
    : [toDataUrl(image.bytes, image.mimeType)]
}

export function buildAuditPrompt(subject: QcSubject, plan: Exclude<AuditPlan, 'none'>): string {
  return [
    'You are auditing one artifact produced by an automated film & video production pipeline.',
    `Stage: ${subject.stage}`,
    `Generation prompt: ${subject.prompt || '(none recorded)'}`,
    plan === 'frame'
      ? 'The image is a single frame taken from the middle of the generated clip. You cannot judge motion, continuity between shots, or audio.'
      : 'The image is the generated artifact itself.',
    '',
    'Judge only what is visible: does it depict the generation prompt, and is it free of obvious defects',
    '(blur, warped anatomy, garbled text, missing or duplicated subjects, compression artefacts)?',
    // Nothing to have drifted from until a shot is actually generated from a frame, so
    // an unconditioned audit gets this clause absent rather than weakened.
    ...(subject.referenceDataUrl
      ? [
          'A second image is attached, and it comes after the one described above: the approved first frame this clip was generated from, the exact image the video model was conditioned on.',
          'Judge the artifact against that reference as well. It must depict the same character, the same prop, the same scene subject: the same face, the same build, the same clothing and the same object, allowing only for the angle, framing and lighting the clip changes.',
          'A plausible but different person, or an object quietly redesigned between the frame and the clip, is a defect worth flagging. Name it in reasons and score it below the threshold: a cut the audience reads as two different characters is not usable however clean the single frame looks.',
          '',
        ]
      : []),
    'Reply with JSON only and no surrounding prose: {"score": <number between 0 and 1>, "reasons": ["<short reason>", ...]}',
    `A score of ${QC_THRESHOLD} or above means the artifact is usable.`,
  ].join('\n')
}

/**
 * A bare JSON.parse is not a parser for model output: answers arrive wrapped in
 * prose or a code fence often enough to matter. A score outside 0..1 is rejected
 * rather than clamped, because a clamped guess would still look like a judgment.
 */
export function parseVerdict(text: string): AuditVerdict | null {
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const score = (parsed as { score?: unknown }).score
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) continue
    const raw = (parsed as { reasons?: unknown }).reasons
    const reasons = Array.isArray(raw) ? raw.filter((reason): reason is string => typeof reason === 'string') : []
    return { score, reasons }
  }
  return null
}

/** The whole answer first, then the outermost brace pair — whichever parses wins. */
function jsonCandidates(text: string): string[] {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  return start !== -1 && end > start ? [trimmed, trimmed.slice(start, end + 1)] : [trimmed]
}

async function frameOf(subject: QcSubject): Promise<AuditImage> {
  // ffmpeg picks the demuxer from the extension, so the clip has to be written
  // back out under its real one rather than a generic temp name.
  const source = path.join(subject.workdir, `audit-source.${extensionFor(subject.mimeType)}`)
  await writeFile(source, subject.bytes)
  const frame = path.join(subject.workdir, 'audit-frame.jpg')
  await extractFrame(source, frame, subject.durationMs)
  return { bytes: new Uint8Array(await readFile(frame)), mimeType: 'image/jpeg' }
}

function unjudged(reason: string): QcVerdict {
  return { kind: 'visual-audit', decision: 'unjudged', reasons: [reason] }
}
