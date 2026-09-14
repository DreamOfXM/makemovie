import { describe, expect, it } from 'vitest'
import { loadWorkerConfig } from '../src/config.js'
import { HashQualityChecker, QC_THRESHOLD, auditPlanFor, type QcSubject, type QualityChecker } from '../src/qc.js'
import { buildAuditPrompt, parseVerdict } from '../src/visual-audit.js'

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
