import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PrismaClient } from '@studio/db'
import { resolveSlotCandidates } from '@studio/db'
import { extractFrame, extensionFor } from '@studio/media'
import { createAdapter, type PollResult, type ProviderRequest } from '@studio/providers'
import { decryptSecret } from '@studio/security'
import { errorMessage, pollToSettled, toCapability } from './provider-call.js'
import { auditPlanFor, QC_THRESHOLD, type AuditPlan, type QcSubject, type QcVerdict, type QualityChecker } from './qc.js'

export interface AuditVerdict {
  score: number
  reasons: string[]
}

export interface ModelCheckerOptions {
  db: PrismaClient
  masterKey: string
  pollIntervalMs?: number
  pollTimeoutMs?: number
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
  private readonly pollTimeoutMs?: number

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

    let image: { bytes: Uint8Array; mimeType: string }
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
      baseUrl: connection.baseUrl,
    })
    const request: ProviderRequest = {
      model: candidate.model,
      input: {
        prompt: buildAuditPrompt(subject, plan),
        images: [`data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`],
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

async function frameOf(subject: QcSubject): Promise<{ bytes: Uint8Array; mimeType: string }> {
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
