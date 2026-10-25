import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@studio/db'
import { probeDuration } from '@studio/media'
import { ASSET_LAYOUT_BLOCKS_BY_KIND, ASSET_REFERENCE_SPECS_BY_KIND } from '@studio/pipeline'
import { MOCK_VLM_VERDICT, resetDashScopeSyncResults } from '@studio/providers'
import { encryptSecret } from '@studio/security'
import { loadWorkerConfig } from '../src/config.js'
import { HashQualityChecker, QC_THRESHOLD, auditPlanFor, type AuditFinding, type AuditFrameScore, type QcSubject, type QualityChecker } from '../src/qc.js'
import { AUDIT_CALL_BUDGET_PER_TASK, AUDIT_FRAME_POSITIONS, ModelQualityChecker, auditExpectation, auditImages, buildAuditPrompt, parseVerdict } from '../src/visual-audit.js'
import { MASTER_KEY } from './env.js'

const run = promisify(execFile)

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

硬属性核对(最高优先级):先从生成指令中提取每个出场主体的硬属性——性别、年龄段(如"十六岁少女"不是男孩)、大致人数、关键道具,再逐项与画面比对。
生成指令中"图N＝角色定妆照｜..."的对应关系同样必须成立:画面人物必须与指令声称的定妆照主体一致。
任何一项硬属性不符(性别画错、年龄明显偏差、多了或少了人物、关键道具缺失或张冠李戴)都直接判不合格,在 reasons 里写明是哪一项不符,即使画面本身很干净。

在此之上再判断通用缺陷:是否呈现了生成指令描述的场景,有无明显瑕疵(模糊、肢体扭曲、乱码文字、主体缺失或重复、压缩噪点)。
Reply with JSON only and no surrounding prose: {"score": <number between 0 and 1>, "reasons": ["<short reason>", ...]}
A score of ${QC_THRESHOLD} or above means the artifact is usable.`

const UNCONDITIONED_FRAME_PROMPT = `You are auditing one artifact produced by an automated film & video production pipeline.
Stage: VIDEO
Generation prompt: a rainy night market, neon reflections
The image is a single frame taken from the middle of the generated clip. You cannot judge motion, continuity between shots, or audio.

硬属性核对(最高优先级):先从生成指令中提取每个出场主体的硬属性——性别、年龄段(如"十六岁少女"不是男孩)、大致人数、关键道具,再逐项与画面比对。
生成指令中"图N＝角色定妆照｜..."的对应关系同样必须成立:画面人物必须与指令声称的定妆照主体一致。
任何一项硬属性不符(性别画错、年龄明显偏差、多了或少了人物、关键道具缺失或张冠李戴)都直接判不合格,在 reasons 里写明是哪一项不符,即使画面本身很干净。

在此之上再判断通用缺陷:是否呈现了生成指令描述的场景,有无明显瑕疵(模糊、肢体扭曲、乱码文字、主体缺失或重复、压缩噪点)。
Reply with JSON only and no surrounding prose: {"score": <number between 0 and 1>, "reasons": ["<short reason>", ...]}
A score of ${QC_THRESHOLD} or above means the artifact is usable.`

/** 一份真实的角色板生成 prompt：规格行就是审核端反查 kind 的指纹（SD-042）。 */
const CHARACTER_SHEET_PROMPT = `角色设定板：陈默。沉默的搬尸工\n\n${ASSET_REFERENCE_SPECS_BY_KIND.character}`

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
    // qwen3 思考模式：答案前带 <think> 推理段（2026-09-28 场景图审计全灭即此）
    expect(parseVerdict('<think>画面整体清晰，{score 大概 0.8} 但我需要再核对一下人物……</think>\n{"score":0.85,"reasons":[]}')).toEqual({ score: 0.85, reasons: [] })
    expect(parseVerdict('<think>先看构图再看肤色</think>{"score":0.6,"reasons":["肢体扭曲"]}')).toEqual({ score: 0.6, reasons: ['肢体扭曲'] })
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

/**
 * SD-042：素材板审核必须逐项回答版式清单。2026-10-21 实测里，一张裸半身照与五区块
 * 齐全的角色板拿到同分同空 findings（0.95 / 0.95）——清单不存在时，「版式不成立」
 * 没有任何地方能说出来。这一组钉住：清单从生成端的规格行反查（不另抄一份）、
 * 只认 present:true、漏答区块就是缺、整段没答是没审。
 */
describe('素材板版式核对（SD-042）', () => {
  const blocks = ASSET_LAYOUT_BLOCKS_BY_KIND.character!
  const expectation = { layoutBlocks: blocks, expectedReadout: null, forbidsReadableText: false }

  it('从生成端写进 prompt 的规格行反查该 kind 的清单，不另抄一份', () => {
    expect(auditExpectation({ prompt: CHARACTER_SHEET_PROMPT })).toEqual(expectation)
    expect(auditExpectation({ prompt: ASSET_REFERENCE_SPECS_BY_KIND.scene! }).layoutBlocks).toEqual(ASSET_LAYOUT_BLOCKS_BY_KIND.scene)
    expect(auditExpectation({ prompt: 'a rainy night market' }).layoutBlocks).toEqual([])
  })

  it('只认 present:true 的确认，漏答的区块就是缺', () => {
    const layout = blocks.map((block, index) => ({ block, present: index !== 4 }))
    const verdict = parseVerdict(JSON.stringify({ score: 0.95, reasons: [], layout }), [], expectation)
    expect(verdict?.layoutGaps).toEqual([blocks[4]])
    expect(verdict?.layoutUnanswered).toBeUndefined()
  })

  it('区块名的编号与空格重排不影响比对', () => {
    const layout = blocks.map(block => ({ block: block.replace(/^[①②③④⑤]/, '').replace(/ /g, ''), present: true })).reverse()
    const verdict = parseVerdict(JSON.stringify({ score: 0.95, reasons: [], layout }), [], expectation)
    expect(verdict?.layoutGaps).toBeUndefined()
    expect(verdict?.layoutUnanswered).toBeUndefined()
  })

  it('整段没答清单是没审，不是缺区块', () => {
    const verdict = parseVerdict('{"score":0.95,"reasons":[]}', [], expectation)
    expect(verdict).toMatchObject({ score: 0.95, layoutUnanswered: true })
    expect(verdict?.layoutGaps).toBeUndefined()
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

  it('asks whether the artifact shows the same subject only when a frame conditioned it, and scopes the clip to the frame', () => {
    const conditioned = buildAuditPrompt(subject({ referenceDataUrl: REFERENCE_DATA_URL }), 'image')
    expect(conditioned).toContain('A second image is attached')
    expect(conditioned).toContain('the same character, the same prop, the same scene subject')
    expect(conditioned).toContain('score it below the threshold')
    // 图生视频是从首帧延续:后续剧情超出片段时长不算缺陷,与首帧一致才是硬标准。
    expect(conditioned).toContain('图生视频是从首帧出发的延续')
    expect(buildAuditPrompt(subject(), 'image')).not.toContain('图生视频是从首帧出发的延续')
    // The added clause sits beside the existing judgment; it never replaces it, and it
    // never moves what "the image" refers to.
    expect(conditioned).toContain('The image is the generated artifact itself.')
    expect(conditioned).toContain('在此之上再判断通用缺陷')

    const clip = buildAuditPrompt(subject({ stage: 'VIDEO', modality: 'i2v', referenceDataUrl: REFERENCE_DATA_URL }), 'frame')
    expect(clip).toContain('A second image is attached')
    expect(clip).toContain('The image is a single frame taken from the middle')
  })

  // SD-098: only a sampled-clip audit can call a scripted change a break, so only that
  // audit is told what the script asked this shot to show.
  const SAMPLED_FRAMES = [
    { position: 0.1, timestampSeconds: 0.3 },
    { position: 0.5, timestampSeconds: 1.5 },
    { position: 0.9, timestampSeconds: 2.7 },
  ]

  it('judges a scripted fade-out against the shot script, not against the first frame alone', () => {
    const shot = { description: '灯逐盏熄灭，一个弯腰的黑影拾起电缆', continuityOut: '林栖独自站在黑暗里' }
    const prompt = buildAuditPrompt(subject({ stage: 'VIDEO', modality: 't2v', shotIntent: shot }), 'frame', SAMPLED_FRAMES)
    expect(prompt).toContain(`- 画面内容：${shot.description}`)
    expect(prompt).toContain(`- 本镜交给下一镜的结尾状态：${shot.continuityOut}`)
    expect(prompt).toContain('以上点名的变化是这一镜要拍的东西，不是断裂')
    expect(prompt).toContain('不得在「本镜剧本要求」之外改变')
    expect(prompt).not.toContain('不得无声改变')
    // 剧本要求是后续所有连贯性判句的基准，必须排在它们之前。
    expect(prompt.indexOf('本镜剧本要求')).toBeLessThan(prompt.indexOf('多时点核对'))
    // The two-sided rule: the state this shot owes the next one is itself checked.
    expect(prompt).toContain('上面那个结尾状态在片段末尾没有兑现')
  })

  it('records an unscripted hand-off as unrecorded instead of inventing one', () => {
    const prompt = buildAuditPrompt(subject({ stage: 'VIDEO', modality: 't2v', shotIntent: { description: '喜忽然抬头', continuityOut: '' } }), 'frame', SAMPLED_FRAMES)
    expect(prompt).toContain('- 画面内容：喜忽然抬头')
    expect(prompt).toContain('- 本镜交给下一镜的结尾状态：(未记录)')
  })

  it('keeps the absolute continuity rule verbatim when no shot script is available', () => {
    const prompt = buildAuditPrompt(subject({ stage: 'VIDEO', modality: 't2v' }), 'frame', SAMPLED_FRAMES)
    expect(prompt).toContain('多时点核对:frameScores 按每帧标注的 position 逐帧给出 0..1 分;帧与帧之间出场主体、服装与场景不得无声改变——跨时点不一致记 dimension="continuity" 的 finding。')
    expect(prompt).not.toContain('本镜剧本要求')
  })

  it('leaves the still-image and single-frame audits byte-identical even with a shot script', () => {
    const shot = { description: '灯逐盏熄灭', continuityOut: '黑暗中的林栖' }
    expect(buildAuditPrompt(subject({ shotIntent: shot }), 'image')).toBe(UNCONDITIONED_IMAGE_PROMPT)
    expect(buildAuditPrompt(subject({ stage: 'VIDEO', modality: 't2v', shotIntent: shot }), 'frame')).toBe(UNCONDITIONED_FRAME_PROMPT)
  })

  it('puts the shot script beside the first-frame basis for an i2v clip', () => {
    const prompt = buildAuditPrompt(subject({ stage: 'VIDEO', modality: 'i2v', referenceDataUrl: REFERENCE_DATA_URL, shotIntent: { description: '灯逐盏熄灭', continuityOut: '黑影离场' } }), 'frame', SAMPLED_FRAMES)
    expect(prompt).toContain('这是图生视频:最后一张图(首帧)是这段视频的画面基准。')
    expect(prompt).toContain('- 画面内容：灯逐盏熄灭')
    expect(prompt).toContain('- 本镜交给下一镜的结尾状态：黑影离场')
  })
})

describe('auditImages', () => {
  it('sends one image when nothing conditioned the shot', () => {
    const artifact = subject()
    expect(auditImages(artifact, [{ bytes: artifact.bytes, mimeType: artifact.mimeType }])).toEqual([ARTIFACT_DATA_URL])
  })

  it('appends the reference instead of putting it where the artifact belongs', () => {
    const artifact = subject({ referenceDataUrl: REFERENCE_DATA_URL })
    expect(auditImages(artifact, [{ bytes: artifact.bytes, mimeType: artifact.mimeType }])).toEqual([ARTIFACT_DATA_URL, REFERENCE_DATA_URL])
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

  // 2026-09-28 事故集：qwen3 思考模式端到端——真实事故里审计回了 <think>…</think>+JSON，
  // 解析失败→任务被拦。现在全链路（含 checker 层）必须把它当正常裁决读出来。
  it('reads a qwen3 thinking-mode verdict end-to-end instead of going unjudged', async () => {
    fetchMock.mockResolvedValue(answeredWith(
      '<think>先核对人物身份与人数，再看服装细节。画面与指令一致，质量尚可。</think>\n{"score":0.86,"reasons":[]}',
    ))
    const verdict = await auditor().check(subject({}))
    expect(verdict).toEqual({ kind: 'visual-audit', decision: 'pass', score: 0.86 })
  })

  it('reads a thinking-mode rework verdict with reasons', async () => {
    fetchMock.mockResolvedValue(answeredWith(
      '<think>文书正文出现了可辨认的英文单词，按最高优先级规则要扣分。{score 应该 0.55}</think>{"score":0.55,"reasons":["正文出现可读英文"]}',
    ))
    const verdict = await auditor().check(subject({}))
    expect(verdict).toEqual({ kind: 'visual-audit', decision: 'rework', score: 0.55, reasons: ['正文出现可读英文'] })
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
      reasons: ['dashscope/qwen3-vl-plus returned no parseable verdict: the two images clearly show the same person'],
    })

    // An unusable score is still not a pass, however confident the prose around it reads.
    fetchMock.mockResolvedValue(answeredWith('{"score": 4, "reasons": ["the subject drifted"]}'))
    expect(await auditor().check(conditioned)).toEqual({
      kind: 'visual-audit',
      decision: 'unjudged',
      reasons: ['dashscope/qwen3-vl-plus returned no parseable verdict: {"score": 4, "reasons": ["the subject drifted"]}'],
    })
  })

  it('has nothing to judge without a bound auditor, reference or not', async () => {
    const verdict = await auditor(unboundAuditorDb()).check(subject({ referenceDataUrl: REFERENCE_DATA_URL }))
    expect(verdict).toEqual({ kind: 'visual-audit', decision: 'unjudged', reasons: ['no verified visual_audit binding'] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // SD-042：审美分再高也不能替版式作保。这张回答五官与质感都给了满分，
  // 但第五区块（表情集）缺席——裸半身照正是这样骗过旧审核的。
  it('rejects a sheet missing a required block however clean the score says it looks', async () => {
    const blocks = ASSET_LAYOUT_BLOCKS_BY_KIND.character!
    fetchMock.mockResolvedValue(answeredWith(JSON.stringify({
      score: 0.95,
      reasons: [],
      layout: blocks.map((block, index) => ({ block, present: index !== 4 })),
    })))
    const verdict = await auditor().check(subject({ prompt: CHARACTER_SHEET_PROMPT }))

    const gap = `版式缺区块：${blocks[4]}`
    expect(verdict).toEqual({
      kind: 'visual-audit',
      decision: 'rework',
      score: 0.95,
      reasons: [gap],
      findings: [{ dimension: 'content', severity: 'warning', message: gap, evidenceTimeSeconds: null }],
    })
    // 清单是发出去问过的，不是只在解析端存在。
    const sent = sentRequest().prompt
    expect(sent).toContain('版式核对（最高优先级，逐项回答 layout）')
    expect(sent).toContain('"layout": [{"block"')
    expect(sent).toContain(blocks[4])
  })

  it('reports an unanswered layout as unjudged instead of passing the high score through', async () => {
    fetchMock.mockResolvedValue(answeredWith('{"score":0.95,"reasons":[]}'))
    const verdict = await auditor().check(subject({ prompt: CHARACTER_SHEET_PROMPT }))
    expect(verdict.kind).toBe('visual-audit')
    expect(verdict.decision).toBe('unjudged')
    expect((verdict as { reasons: string[] }).reasons[0]).toContain('未回答版式清单')
    expect((verdict as { reasons: string[] }).reasons[0]).toContain('要求逐项确认 5 个区块')
  })

  it('passes the sheet once every block is confirmed and the score clears the floor', async () => {
    const blocks = ASSET_LAYOUT_BLOCKS_BY_KIND.character!
    fetchMock.mockResolvedValue(answeredWith(JSON.stringify({
      score: 0.9,
      reasons: [],
      layout: blocks.map(block => ({ block, present: true })),
    })))
    expect(await auditor().check(subject({ prompt: CHARACTER_SHEET_PROMPT })))
      .toEqual({ kind: 'visual-audit', decision: 'pass', score: 0.9 })
  })
})

// US-032 FR-Q01/Q02: a clip is audited from sampled positions in one multi-image
// request, and every way the sampling or the answer breaks lands as `unjudged`
// with a reason — never as a score nobody earned.
describe('multi-point video audit (US-032)', () => {
  let workdir: string

  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    resetDashScopeSyncResults()
    workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-visual-audit-'))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(workdir, { recursive: true, force: true })
  })

  /** A real 3-second clip, plus the timestamps 10%/50%/90% sampling must produce. */
  async function testsrcClip(): Promise<{ bytes: Uint8Array; timestamps: number[] }> {
    const clip = path.join(workdir, 'clip.mp4')
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25', '-pix_fmt', 'yuv420p', clip])
    const durationSeconds = (await probeDuration(clip)) / 1000
    expect(durationSeconds).toBeGreaterThan(0)
    return {
      bytes: new Uint8Array(await readFile(clip)),
      timestamps: AUDIT_FRAME_POSITIONS.map(position => position * durationSeconds),
    }
  }

  function videoSubject(bytes: Uint8Array, overrides: Partial<QcSubject> = {}): QcSubject {
    return subject({ stage: 'VIDEO', modality: 't2v', mimeType: 'video/mp4', bytes, workdir, durationMs: 3_000, ...overrides })
  }

  it('sends every sampled position in one request, each labeled with its timestamp', async () => {
    const clip = await testsrcClip()
    fetchMock.mockResolvedValue(answeredWith(MOCK_VLM_VERDICT))
    const verdict = await auditor().check(videoSubject(clip.bytes))

    // The plain mock verdict still parses through the multi-image request, which
    // is the same guarantee the pipeline chain relies on.
    expect(verdict).toEqual({ kind: 'visual-audit', decision: 'pass', score: MOCK_VLM_SCORE })

    const sent = sentRequest()
    expect(sent.images).toHaveLength(3)
    for (const image of sent.images) expect(image.startsWith('data:image/')).toBe(true)
    // AC17: each frame is labeled with its position and its real timestamp, and
    // the reply contract asks for per-frame scores and timestamped findings.
    const labels = [...sent.prompt.matchAll(/- Image (\d+): (\d+)% into the clip \(([\d.]+)s\)/g)]
    expect(labels.map(label => label[1])).toEqual(['1', '2', '3'])
    expect(labels.map(label => label[2])).toEqual(['10', '50', '90'])
    for (const [index, label] of labels.entries()) {
      expect(Math.abs(Number(label[3]) - clip.timestamps[index]!)).toBeLessThan(0.01)
    }
    expect(sent.prompt).toContain('frameScores')
    expect(sent.prompt).toContain('findings')
  })

  it('stays unjudged with a reason when the model answers nothing parseable', async () => {
    const clip = await testsrcClip()
    fetchMock.mockResolvedValue(answeredWith('the frames look fine to me'))
    const verdict = await auditor().check(videoSubject(clip.bytes))
    expect(verdict).toEqual({
      kind: 'visual-audit',
      decision: 'unjudged',
      reasons: ['dashscope/qwen3-vl-plus returned no parseable verdict: the frames look fine to me'],
    })
  })

  it('stays unjudged when every sampled position fails to extract, and never dials the provider', async () => {
    const garbage = new TextEncoder().encode('this is not a video at all')
    fetchMock.mockResolvedValue(answeredWith(MOCK_VLM_VERDICT))
    const verdict = await auditor().check(videoSubject(garbage))

    expect(verdict).toMatchObject({ kind: 'visual-audit', decision: 'unjudged' })
    expect((verdict as { reasons: string[] }).reasons[0]).toContain('frame extraction failed at every position')
    expect((verdict as { reasons: string[] }).reasons[0]).toContain('10%, 50%, 90%')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('carries structured findings back, with times snapped onto the sampled timestamps', async () => {
    const clip = await testsrcClip()
    const withFindings = JSON.stringify({
      score: 0.4,
      reasons: ['subject drifts across the clip'],
      frameScores: AUDIT_FRAME_POSITIONS.map((position, index) => ({ position, score: 0.8 - index * 0.3 })),
      findings: [
        { dimension: 'continuity', severity: 'warning', message: 'jacket turns red mid-clip', timeSeconds: clip.timestamps[1]! + 0.11 },
        { dimension: 'aesthetic', severity: 'info', message: 'mild compression noise throughout' },
      ],
    })
    fetchMock.mockResolvedValue(answeredWith(withFindings))
    const verdict = await auditor().check(videoSubject(clip.bytes))

    expect(verdict).toMatchObject({ kind: 'visual-audit', decision: 'rework', score: 0.4, reasons: ['subject drifts across the clip'] })
    const detailed = verdict as { findings?: AuditFinding[]; frameScores?: AuditFrameScore[] }

    // 时间点归位:模型说的 1.61s 落到最近一个被抽帧的时间戳上,不原样透传。
    const snapped = detailed.findings![0]!.evidenceTimeSeconds
    expect(snapped).not.toBeNull()
    expect(clip.timestamps.some(timestamp => Math.abs(timestamp - snapped!) < 0.01)).toBe(true)
    expect(Math.abs(snapped! - clip.timestamps[1]!)).toBeLessThan(0.01)
    expect(detailed.findings![0]).toMatchObject({ dimension: 'continuity', severity: 'warning', message: 'jacket turns red mid-clip' })
    // 模型没给时间点 → null,不猜一个位置。
    expect(detailed.findings![1]).toMatchObject({ dimension: 'aesthetic', severity: 'info', message: 'mild compression noise throughout' })
    expect(detailed.findings![1]!.evidenceTimeSeconds).toBeNull()
    expect(detailed.frameScores).toHaveLength(3)
  })

  it('drops findings whose dimension or severity the contract never allowed', () => {
    const answer = JSON.stringify({
      score: 0.9,
      reasons: [],
      findings: [
        { dimension: 'plot', severity: 'warning', message: 'unknown dimension' },
        { dimension: 'content', severity: 'blocking', message: 'unknown severity' },
        { dimension: 'content', severity: 'info', message: '' },
        { dimension: 'continuity', severity: 'warning', message: 'kept: subject swap at the tail' },
      ],
    })
    expect(parseVerdict(answer, [0.3, 1.5, 2.7])).toEqual({
      score: 0.9,
      reasons: [],
      findings: [{ dimension: 'continuity', severity: 'warning', message: 'kept: subject swap at the tail', evidenceTimeSeconds: null }],
    })
  })

  it('keeps a finding unpinned when the audit is a still image with no timestamps', () => {
    const answer = JSON.stringify({ score: 0.5, reasons: [], findings: [{ dimension: 'aesthetic', severity: 'info', message: 'soft focus', timeSeconds: 3 }] })
    expect(parseVerdict(answer)).toEqual({
      score: 0.5,
      reasons: [],
      findings: [{ dimension: 'aesthetic', severity: 'info', message: 'soft focus', evidenceTimeSeconds: null }],
    })
  })
})

// US-032 FR-Q04: visual-audit calls have their own per-task budget, so a re-audit
// loop cannot bill the auditor forever. Spending the budget is an audit that must
// not happen — `unjudged`, before any frame extraction or upstream call.
describe('audit call budget (FR-Q04)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    resetDashScopeSyncResults()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function budgetDb(used: number): { db: PrismaClient; count: ReturnType<typeof vi.fn> } {
    const count = vi.fn(async () => used)
    const db = { ...boundAuditorDb(), qualityCheck: { count } } as unknown as PrismaClient
    return { db, count }
  }

  it('refuses to dial the provider once the per-task budget is spent', async () => {
    const { db, count } = budgetDb(AUDIT_CALL_BUDGET_PER_TASK)
    fetchMock.mockResolvedValue(answeredWith(MOCK_VLM_VERDICT))

    const verdict = await auditor(db).check(subject({ taskId: 'task-budget' }))

    expect(verdict).toMatchObject({ kind: 'visual-audit', decision: 'unjudged' })
    const reasons = (verdict as { reasons: string[] }).reasons
    expect(reasons[0]).toContain('审核预算已用尽')
    expect(reasons[0]).toContain('task-budget')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(count).toHaveBeenCalledWith({ where: { kind: 'visual-audit', artifact: { taskId: 'task-budget' } } })
  })

  it('still audits while the budget has room, and counts only the task it is checking', async () => {
    const { db, count } = budgetDb(AUDIT_CALL_BUDGET_PER_TASK - 1)
    fetchMock.mockResolvedValue(answeredWith(MOCK_VLM_VERDICT))

    const verdict = await auditor(db).check(subject({ taskId: 'task-budget' }))

    expect(verdict).toEqual({ kind: 'visual-audit', decision: 'pass', score: MOCK_VLM_SCORE })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(count).toHaveBeenCalledWith({ where: { kind: 'visual-audit', artifact: { taskId: 'task-budget' } } })
  })

  it('does not consult the budget at all for a subject that carries no task id', async () => {
    const db = boundAuditorDb() // no qualityCheck delegate on this mock
    fetchMock.mockResolvedValue(answeredWith(MOCK_VLM_VERDICT))

    const verdict = await auditor(db).check(subject())
    expect(verdict).toEqual({ kind: 'visual-audit', decision: 'pass', score: MOCK_VLM_SCORE })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('worker qc mode', () => {
  const env = { DATABASE_URL: 'postgresql://studio:studio@127.0.0.1:5432/studio' }

  it('accepts model alongside the deterministic modes', () => {
    expect(loadWorkerConfig({ ...env, STUDIO_QC_MODE: 'model' }).qcMode).toBe('model')
    expect(loadWorkerConfig({ ...env, STUDIO_QC_MODE: 'pass' }).qcMode).toBe('pass')
  })

  it('defaults to model when unset or empty: the cheap auditor is the gatekeeper by default', () => {
    expect(loadWorkerConfig(env).qcMode).toBe('model')
    expect(loadWorkerConfig({ ...env, STUDIO_QC_MODE: '' }).qcMode).toBe('model')
    // 显式 pass 仍然可选:无人值守大批量、自担质检缺位时使用。
    expect(loadWorkerConfig({ ...env, STUDIO_QC_MODE: 'pass' }).qcMode).toBe('pass')
    expect(loadWorkerConfig({ ...env, STUDIO_QC_MODE: 'random' }).qcMode).toBe('random')
  })

  it('rejects anything else and lists every valid value', () => {
    expect(() => loadWorkerConfig({ ...env, STUDIO_QC_MODE: 'vibes' }))
      .toThrow(/STUDIO_QC_MODE must be one of random\|pass\|fail\|model, got "vibes"/)
  })
})
