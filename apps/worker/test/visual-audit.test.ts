import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@studio/db'
import { MOCK_VLM_VERDICT, resetDashScopeSyncResults } from '@studio/providers'
import { encryptSecret } from '@studio/security'
import { loadWorkerConfig } from '../src/config.js'
import { HashQualityChecker, QC_THRESHOLD, auditPlanFor, type QcSubject, type QualityChecker } from '../src/qc.js'
import { ModelQualityChecker, auditImages, buildAuditPrompt, parseVerdict } from '../src/visual-audit.js'
import { MASTER_KEY } from './env.js'

// The mock auditor's fixed answer, read rather than restated so a change to it moves
// these assertions instead of silently invalidating them.
const MOCK_VLM_SCORE = (JSON.parse(MOCK_VLM_VERDICT) as { score: number }).score

// The reference a conditioned shot is audited against, and the artifact's own bytes
// as the data URL the auditor should have received them in.
const REFERENCE_DATA_URL = 'data:image/jpeg;base64,cmVmZXJlbmNlLWZpcnN0LWZyYW1l'
const ARTIFACT_DATA_URL = `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`

/**
 * Every byte an unconditioned audit used to send. Transcribed rather than rebuilt from
 * the pieces, because "the default path was not disturbed" is only provable against a
 * copy of what the path said before a reference existed to change it.
 */
const UNCONDITIONED_IMAGE_PROMPT = `You are auditing one artifact produced by an automated film & video production pipeline.
Stage: FIRST_FRAME
Generation prompt: a rainy night market, neon reflections
The image is the generated artifact itself.

Judge only what is visible: does it depict the generation prompt, and is it free of obvious defects
(blur, warped anatomy, garbled text, missing or duplicated subjects, compression artefacts)?
Reply with JSON only and no surrounding prose: {"score": <number between 0 and 1>, "reasons": ["<short reason>", ...]}
A score of ${QC_THRESHOLD} or above means the artifact is usable.`

const UNCONDITIONED_FRAME_PROMPT = `You are auditing one artifact produced by an automated film & video production pipeline.
Stage: VIDEO
Generation prompt: a rainy night market, neon reflections
The image is a single frame taken from the middle of the generated clip. You cannot judge motion, continuity between shots, or audio.

Judge only what is visible: does it depict the generation prompt, and is it free of obvious defects
(blur, warped anatomy, garbled text, missing or duplicated subjects, compression artefacts)?
Reply with JSON only and no surrounding prose: {"score": <number between 0 and 1>, "reasons": ["<short reason>", ...]}
A score of ${QC_THRESHOLD} or above means the artifact is usable.`

function subject(overrides: Partial<QcSubject> = {}): QcSubject {
  return {
    organizationId: 'org-1',
    projectId: 'proj-1',
    stage: 'FIRST_FRAME',
    modality: 'image',
    mimeType: 'image/png',
    bytes: new Uint8Array([1, 2, 3]),
    prompt: 'a rainy night market, neon reflections',
    workdir: '/tmp/unused',
    ...overrides,
  }
}

const fetchMock = vi.fn()

/**
 * The three reads an audit makes to find its auditor, with no database behind them:
 * what these tests judge is the request that reaches the vendor.
 */
function boundAuditorDb(): PrismaClient {
  const capability = {
    id: 'cap-vlm',
    model: 'qwen3-vl-plus',
    modality: 'vlm',
    displayName: null,
    acceptsFirstFrame: false,
    acceptsReferenceImages: false,
    maxReferenceImages: 0,
    entitlementVerifiedAt: new Date(),
    connectionId: 'conn-vlm',
  }
  const connection = {
    id: 'conn-vlm',
    provider: 'dashscope',
    name: 'auditor',
    baseUrl: 'https://dashscope.example',
    enabled: true,
    encryptedSecret: encryptSecret('sk-auditor', MASTER_KEY),
    accessKeyEncrypted: null,
  }
  return {
    capabilityBinding: {
      findMany: async () => [{
        id: 'binding-vlm',
        organizationId: 'org-1',
        projectId: 'proj-1',
        slot: 'VISUAL_AUDIT',
        priority: 10,
        enabled: true,
        capabilityId: capability.id,
        capability: { ...capability, connection },
      }],
    },
    providerConnection: { findUnique: async () => connection },
    modelCapability: { findUnique: async () => capability },
  } as unknown as PrismaClient
}

function unboundAuditorDb(): PrismaClient {
  return { capabilityBinding: { findMany: async () => [] } } as unknown as PrismaClient
}

function auditor(db: PrismaClient = boundAuditorDb()): ModelQualityChecker {
  return new ModelQualityChecker({ db, masterKey: MASTER_KEY, pollIntervalMs: 1, pollTimeoutMs: 5_000 })
}

function answeredWith(text: string) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({ output: { text } }), headers: new Headers() }
}

function refusedWith(status: number, code: string, message: string) {
  return { ok: false, status, statusText: 'Bad Request', json: async () => ({ code, message }), headers: new Headers() }
}

/** The multimodal body the auditor put on the wire, back into a prompt and ordered images. */
function sentRequest(call = 0): { prompt: string; images: string[] } {
  const [, init] = fetchMock.mock.calls[call]
  const body = JSON.parse(init.body) as { input: { messages: Array<{ content: Array<{ image?: string; text?: string }> }> } }
  const content = body.input.messages[0].content
  return {
    prompt: content.map(part => part.text).filter((text): text is string => text !== undefined).join('\n'),
    images: content.map(part => part.image).filter((image): image is string => image !== undefined),
  }
}

describe('auditPlanFor', () => {
  it('sends a still image as-is', () => {
    expect(auditPlanFor('image')).toBe('image')
  })

  it('reduces every video modality to one frame', () => {
    expect(auditPlanFor('t2v')).toBe('frame')
    expect(auditPlanFor('i2v')).toBe('frame')
    expect(auditPlanFor('r2v')).toBe('frame')
  })

  it('has nothing to look at for text, audio, or a vlm answer', () => {
    expect(auditPlanFor('text')).toBe('none')
    expect(auditPlanFor('tts')).toBe('none')
    expect(auditPlanFor('music')).toBe('none')
    expect(auditPlanFor('vlm')).toBe('none')
  })
})

describe('parseVerdict', () => {
  it('reads a bare JSON answer', () => {
    expect(parseVerdict('{"score":0.82,"reasons":["composition holds"]}')).toEqual({ score: 0.82, reasons: ['composition holds'] })
  })

  it('reads JSON wrapped in prose or a code fence', () => {
    expect(parseVerdict('Sure! {"score":0.4,"reasons":["blurry"]} Hope that helps.')).toEqual({ score: 0.4, reasons: ['blurry'] })
    expect(parseVerdict('```json\n{"score":0.9,"reasons":[]}\n```')).toEqual({ score: 0.9, reasons: [] })
  })

  it('treats missing or mixed reasons as the strings that are there', () => {
    expect(parseVerdict('{"score":0.5}')).toEqual({ score: 0.5, reasons: [] })
    expect(parseVerdict('{"score":0.5,"reasons":["kept",42,null]}')).toEqual({ score: 0.5, reasons: ['kept'] })
  })

  it('rejects a score that is not a usable number rather than clamping it', () => {
    expect(parseVerdict('{"score":1.5,"reasons":[]}')).toBeNull()
    expect(parseVerdict('{"score":-0.1,"reasons":[]}')).toBeNull()
    expect(parseVerdict('{"score":"0.8","reasons":[]}')).toBeNull()
    expect(parseVerdict('{"reasons":["no score at all"]}')).toBeNull()
  })

  it('rejects answers that contain no verdict object', () => {
    expect(parseVerdict('')).toBeNull()
    expect(parseVerdict('the image looks fine')).toBeNull()
    expect(parseVerdict('[1,2,3]')).toBeNull()
    expect(parseVerdict('42')).toBeNull()
    expect(parseVerdict('"fine"')).toBeNull()
    expect(parseVerdict('null')).toBeNull()
  })

  it('accepts the exact ends of the range', () => {
    expect(parseVerdict('{"score":0}')).toEqual({ score: 0, reasons: [] })
    expect(parseVerdict('{"score":1}')).toEqual({ score: 1, reasons: [] })
  })
})

describe('buildAuditPrompt', () => {
  it('names the stage, the prompt and the threshold, and demands JSON alone', () => {
    const prompt = buildAuditPrompt(subject(), 'image')
    expect(prompt).toContain('Stage: FIRST_FRAME')
    expect(prompt).toContain('a rainy night market, neon reflections')
    expect(prompt).toContain(`A score of ${QC_THRESHOLD} or above`)
    expect(prompt).toContain('Reply with JSON only')
    expect(prompt).toContain('{"score": <number between 0 and 1>, "reasons": ["<short reason>", ...]}')
  })

  it('says plainly that a frame cannot show motion', () => {
    const frame = buildAuditPrompt(subject({ modality: 't2v', stage: 'VIDEO' }), 'frame')
    expect(frame).toContain('single frame taken from the middle')
    expect(frame).toContain('cannot judge motion')
    expect(buildAuditPrompt(subject(), 'image')).toContain('the generated artifact itself')
  })

  it('records a missing prompt instead of inventing one', () => {
    expect(buildAuditPrompt(subject({ prompt: '' }), 'image')).toContain('(none recorded)')
  })

  it('sends an unconditioned audit the very prompt it has always sent', () => {
    expect(buildAuditPrompt(subject(), 'image')).toBe(UNCONDITIONED_IMAGE_PROMPT)
    expect(buildAuditPrompt(subject({ stage: 'VIDEO', modality: 't2v' }), 'frame')).toBe(UNCONDITIONED_FRAME_PROMPT)
  })

  it('asks whether the artifact shows the same subject only when a frame conditioned it', () => {
    const conditioned = buildAuditPrompt(subject({ referenceDataUrl: REFERENCE_DATA_URL }), 'image')
    expect(conditioned).toContain('A second image is attached')
    expect(conditioned).toContain('the same character, the same prop, the same scene subject')
    expect(conditioned).toContain('score it below the threshold')
    // The added clause sits beside the existing judgment; it never replaces it, and it
    // never moves what "the image" refers to.
    expect(conditioned).toContain('The image is the generated artifact itself.')
    expect(conditioned).toContain('is it free of obvious defects')

    const clip = buildAuditPrompt(subject({ stage: 'VIDEO', modality: 'i2v', referenceDataUrl: REFERENCE_DATA_URL }), 'frame')
    expect(clip).toContain('A second image is attached')
    expect(clip).toContain('The image is a single frame taken from the middle')
  })
})

describe('auditImages', () => {
  it('sends one image when nothing conditioned the shot', () => {
    const artifact = subject()
    expect(auditImages(artifact, { bytes: artifact.bytes, mimeType: artifact.mimeType })).toEqual([ARTIFACT_DATA_URL])
  })

  it('appends the reference instead of putting it where the artifact belongs', () => {
    const artifact = subject({ referenceDataUrl: REFERENCE_DATA_URL })
    expect(auditImages(artifact, { bytes: artifact.bytes, mimeType: artifact.mimeType })).toEqual([ARTIFACT_DATA_URL, REFERENCE_DATA_URL])
  })
})

describe('HashQualityChecker', () => {
  it('passes in pass mode and reworks in fail mode, both as fake-qc', async () => {
    const passing: QualityChecker = new HashQualityChecker('task-1', 1, 'pass')
    const passed = await passing.check(subject())
    expect(passed).toEqual({ kind: 'fake-qc', decision: 'pass', score: 1 })

    const rejecting: QualityChecker = new HashQualityChecker('task-1', 1, 'fail')
    const reworked = await rejecting.check(subject())
    expect(reworked).toMatchObject({ kind: 'fake-qc', decision: 'rework', score: 0.1 })
    expect((reworked as { reasons: string[] }).reasons[0]).toContain(`${QC_THRESHOLD}`)
  })

  it('is deterministic for the same task and attempt in random mode', async () => {
    const checker: QualityChecker = new HashQualityChecker('task-9', 2, 'random')
    const first = await checker.check(subject())
    const second = await checker.check(subject())
    expect(first).toEqual(second)
    expect(first.decision === 'unjudged').toBe(false)
    if (first.decision !== 'unjudged') {
      expect(first.score).toBeGreaterThanOrEqual(0)
      expect(first.score).toBeLessThan(1)
    }
  })

  it('refuses to stand in for model mode', () => {
    expect(() => new HashQualityChecker('task-1', 1, 'model'))
      .toThrow(/cannot serve STUDIO_QC_MODE=model/)
  })

  // task-1 attempt 1 hashes to 0.532, so the same checker rejects an image here:
  // a script passing next to it shows the modality is what decided, not the score.
  it('passes text and audio outright because there is no visual surface to score', async () => {
    for (const mode of ['random', 'fail'] as const) {
      const checker: QualityChecker = new HashQualityChecker('task-1', 1, mode)
      expect((await checker.check(subject())).decision).toBe('rework')

      const script = await checker.check(subject({ stage: 'SCRIPT', modality: 'text', mimeType: 'text/plain' }))
      expect(script).toEqual({ kind: 'fake-qc', decision: 'pass', score: 1 })

      const voice = await checker.check(subject({ stage: 'AUDIO', modality: 'tts', mimeType: 'audio/mpeg' }))
      expect(voice).toEqual({ kind: 'fake-qc', decision: 'pass', score: 1 })
    }
  })
})

describe('ModelQualityChecker against a bound auditor', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    resetDashScopeSyncResults()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the reference next to the artifact and asks whether they are the same subject', async () => {
    fetchMock.mockResolvedValue(answeredWith(MOCK_VLM_VERDICT))
    const verdict = await auditor().check(subject({ referenceDataUrl: REFERENCE_DATA_URL }))

    // The mock's fixed answer names no consistency judgment, and a conditioned audit
    // under it still has to land as a verdict rather than an error.
    expect(verdict).toEqual({ kind: 'visual-audit', decision: 'pass', score: MOCK_VLM_SCORE })

    const sent = sentRequest()
    expect(sent.images).toEqual([ARTIFACT_DATA_URL, REFERENCE_DATA_URL])
    expect(sent.prompt).toContain('A second image is attached')
    expect(sent.prompt).toContain('the same character, the same prop, the same scene subject')
    expect(sent.prompt).toContain('a defect worth flagging')
  })

  it('sends one image and the prompt it has always sent when nothing conditioned the shot', async () => {
    fetchMock.mockResolvedValue(answeredWith(MOCK_VLM_VERDICT))
    await auditor().check(subject())

    const sent = sentRequest()
    expect(sent.images).toEqual([ARTIFACT_DATA_URL])
    expect(sent.prompt).toBe(UNCONDITIONED_IMAGE_PROMPT)
  })

  it('carries a flagged mismatch into a rework instead of approving the artifact', async () => {
    const mismatch = JSON.stringify({ score: 0.31, reasons: ['the lead is a different person than the first frame'] })
    fetchMock.mockResolvedValue(answeredWith(mismatch))
    const verdict = await auditor().check(subject({ referenceDataUrl: REFERENCE_DATA_URL }))

    expect(verdict).toEqual({
      kind: 'visual-audit',
      decision: 'rework',
      score: 0.31,
      reasons: ['the lead is a different person than the first frame'],
    })
  })

  it('stays unjudged for a conditioned subject however the call goes wrong', async () => {
    const conditioned = subject({ referenceDataUrl: REFERENCE_DATA_URL })

    fetchMock.mockRejectedValue(new Error('socket hang up'))
    expect(await auditor().check(conditioned)).toEqual({
      kind: 'visual-audit',
      decision: 'unjudged',
      reasons: ['dashscope/qwen3-vl-plus call failed: socket hang up'],
    })

    fetchMock.mockResolvedValue(refusedWith(400, 'InvalidParameter', 'upstream said no'))
    expect(await auditor().check(conditioned)).toEqual({
      kind: 'visual-audit',
      decision: 'unjudged',
      reasons: ['dashscope/qwen3-vl-plus call failed: InvalidParameter | upstream said no'],
    })

    fetchMock.mockResolvedValue(answeredWith('the two images clearly show the same person'))
    expect(await auditor().check(conditioned)).toEqual({
      kind: 'visual-audit',
      decision: 'unjudged',
      reasons: ['dashscope/qwen3-vl-plus returned no parseable verdict'],
    })

    // An unusable score is still not a pass, however confident the prose around it reads.
    fetchMock.mockResolvedValue(answeredWith('{"score": 4, "reasons": ["the subject drifted"]}'))
    expect(await auditor().check(conditioned)).toEqual({
      kind: 'visual-audit',
      decision: 'unjudged',
      reasons: ['dashscope/qwen3-vl-plus returned no parseable verdict'],
    })
  })

  it('has nothing to judge without a bound auditor, reference or not', async () => {
    const verdict = await auditor(unboundAuditorDb()).check(subject({ referenceDataUrl: REFERENCE_DATA_URL }))
    expect(verdict).toEqual({ kind: 'visual-audit', decision: 'unjudged', reasons: ['no verified visual_audit binding'] })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('worker qc mode', () => {
  const env = { DATABASE_URL: 'postgresql://studio:studio@127.0.0.1:5432/studio' }

  it('accepts model alongside the deterministic modes', () => {
    expect(loadWorkerConfig({ ...env, STUDIO_QC_MODE: 'model' }).qcMode).toBe('model')
    expect(loadWorkerConfig({ ...env, STUDIO_QC_MODE: 'pass' }).qcMode).toBe('pass')
  })

  it('defaults to pass when unset or empty, so the placeholder never rejects on its own', () => {
    expect(loadWorkerConfig(env).qcMode).toBe('pass')
    expect(loadWorkerConfig({ ...env, STUDIO_QC_MODE: '' }).qcMode).toBe('pass')
    expect(loadWorkerConfig({ ...env, STUDIO_QC_MODE: 'random' }).qcMode).toBe('random')
  })

  it('rejects anything else and lists every valid value', () => {
    expect(() => loadWorkerConfig({ ...env, STUDIO_QC_MODE: 'vibes' }))
      .toThrow(/STUDIO_QC_MODE must be one of random\|pass\|fail\|model, got "vibes"/)
  })
})
