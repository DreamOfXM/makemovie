import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PrismaClient } from '@studio/db'
import { resolveSlotCandidates } from '@studio/db'
import { extractMultiPointFrames, extensionFor, frameSignatureDistance, measureSceneCuts, probeDuration, probeFrameSignature, probeFrameSignatureAt, toDataUrl, type Storage } from '@studio/media'
import {
  ASSET_LAYOUT_BLOCKS_BY_KIND,
  ASSET_REFERENCE_SPECS_BY_KIND,
  NEIGHBOR_DUPLICATE_DISTANCE,
  readNeighborDuplicates,
  screenTextPolicy,
  type NeighborDuplicateReading,
} from '@studio/pipeline'
import { createAdapter, type PollResult, type ProviderRequest } from '@studio/providers'
import { decryptSecret } from '@studio/security'
import { errorMessage, pollToSettled, toCapability } from './provider-call.js'
import {
  auditPlanFor,
  QC_THRESHOLD,
  type AuditFinding,
  type AuditFrameScore,
  type AuditPlan,
  type QcSubject,
  type QcVerdict,
  type QualityChecker,
  type ShotIntent,
} from './qc.js'

export interface AuditVerdict {
  score: number
  reasons: string[]
  frameScores?: AuditFrameScore[]
  findings?: AuditFinding[]
  /**
   * SD-042: 版式清单里没有被审核确认存在的区块。只有审核端向模型要过清单时才可能有值；
   * 模型没答的区块也算缺——「没证据」不等于「成立」，把它当通过就是当年那张裸半身照。
   */
  layoutGaps?: string[]
  /**
   * SD-042: 要了清单、模型却整段没答。这不是不合格，是没审——`unjudged` 那条路，
   * 不能让「审核没回答」在界面上长得像「审核看过且通过」。
   */
  layoutUnanswered?: boolean
  /**
   * SD-085③: 画面里读到的数字与剧本读数不符的原文（`剧本 7:07 / 画面 138`）。
   * 一致、画面没有可读数字、或模型没报告读数时省略——没有证据就不编一个不符出来。
   */
  readoutGap?: string
}

/** 审核端向模型逐项核对的东西；两条都从生成端的 prompt 反查，不另存一份口径。 */
export interface AuditExpectation {
  /** 该素材版式必须存在的区块（空表 = 这次审核不做版式核对）。 */
  layoutBlocks: string[]
  /** 剧本认账的数字读数；null = 这条 prompt 里没有读数。 */
  expectedReadout: string | null
  /** 这条 prompt 明令画面不许出现任何可读字符（NO_TEXT 档）。 */
  forbidsReadableText: boolean
}

/** What the auditor is shown: the artifact itself, or frames pulled out of it. */
export interface AuditImage {
  bytes: Uint8Array
  mimeType: string
}

/** One sampled frame of a clip, carrying the timestamp the prompt labels it by. */
export interface AuditFrame {
  position: number
  timestampSeconds: number
  image: AuditImage
}

/** The frame facts the prompt needs; bytes travel separately as `AuditImage`s. */
export type AuditFrameRef = Pick<AuditFrame, 'position' | 'timestampSeconds'>

/**
 * US-032 FR-Q01: a clip is audited from three sampled positions — 10%/50%/90%,
 * head/middle/tail — instead of one middle frame, so start-of-clip and
 * end-of-clip defects are actually shown to the auditor.
 */
export const AUDIT_FRAME_POSITIONS = [0.1, 0.5, 0.9] as const

/**
 * US-032 FR-Q04: visual-audit calls get their own per-task budget, independent of
 * generation attempts, so a re-audit loop cannot bill the auditor forever. One
 * `check()` is exactly one upstream call; this counts the visual-audit rows the
 * task has already recorded and refuses to start another past the limit.
 */
export const AUDIT_CALL_BUDGET_PER_TASK = 2

/** How many visual-audit rows previous checks of this task already left behind. */
export async function auditCallsUsed(db: PrismaClient, taskId: string): Promise<number> {
  return db.qualityCheck.count({ where: { kind: 'visual-audit', artifact: { taskId } } })
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
 *
 * US-032: clips go in as three sampled frames in one multi-image request, each
 * labeled with its position and timestamp; the structured findings the model
 * returns ride along on the verdict as evidence without touching the decision.
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

    // FR-Q04: the budget gate sits before anything that could spend money — no
    // binding lookup, no frame extraction, no upstream call. Over budget is an
    // audit that must not happen, which is `unjudged`, not a pass and not a fail.
    if (subject.taskId !== undefined) {
      const used = await auditCallsUsed(this.db, subject.taskId)
      if (used >= AUDIT_CALL_BUDGET_PER_TASK) {
        return unjudged(`审核预算已用尽 (audit budget exhausted): ${used} visual-audit calls already recorded for task ${subject.taskId}, budget is ${AUDIT_CALL_BUDGET_PER_TASK}`)
      }
    }

    const candidates = await resolveSlotCandidates(this.db, subject.organizationId, subject.projectId, 'visual_audit')
    const candidate = candidates[0]
    if (!candidate) return unjudged('no verified visual_audit binding')

    const connection = await this.db.providerConnection.findUnique({ where: { id: candidate.connectionId } })
    const row = await this.db.modelCapability.findUnique({ where: { id: candidate.capabilityId } })
    if (!connection || !row) return unjudged(`visual_audit capability ${candidate.capabilityId} is gone`)

    let frames: AuditFrame[] = []
    let images: AuditImage[]
    try {
      if (plan === 'image') {
        images = [{ bytes: subject.bytes, mimeType: subject.mimeType }]
      } else {
        const extracted = await multiPointFramesOf(subject)
        // FR-Q02: total extraction failure is an audit that could not happen —
        // `unjudged`, never a low score pretending the clip was judged on nothing.
        if (extracted.frames.length === 0) {
          return unjudged(`multi-point frame extraction failed at every position (${extracted.failedPositions.map(position => `${Math.round(position * 100)}%`).join(', ')}): nothing to show the auditor`)
        }
        frames = extracted.frames
        images = extracted.frames.map(frame => frame.image)
      }
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
        prompt: buildAuditPrompt(subject, plan, frames),
        images: auditImages(subject, images),
      },
      parameters: {},
    }

    let result: PollResult | { status: 'timeout'; error: string }
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
    if (result.status === 'timeout') {
      return unjudged(`${candidate.provider}/${candidate.model} did not settle in time: ${result.error}`)
    }

    // 抽帧审核不带逐项核对（见 buildAuditPrompt 的同一处说明），解析端也必须按空要求走，
    // 否则模型没答 layout 会被算成缺区块——把一条没问过的问题判成不合格。
    const expectation = frames.length > 0 ? EMPTY_EXPECTATION : auditExpectation(subject)
    const verdict = parseVerdict(result.text ?? '', frames.map(frame => frame.timestampSeconds), expectation)
    // 原文尾巴跟进错误：qwen3 系默认思考模式，下次再解析失败就能直接看到它回了什么
    // （2026-09-28 场景图任务即死在这里，response 里一个字都没留下）。
    if (!verdict) return unjudged(`${candidate.provider}/${candidate.model} returned no parseable verdict: ${(result.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}`)

    // SD-042：要了清单、模型整段没答。这是没审，不是审出不合格——报 unjudged 让人看见
    // 「这次审核没回答版式」，而不是把一个 0.95 当成通过，也不让一次格式不合规把额度
    // 烧在重抽上。
    if (verdict.layoutUnanswered) {
      return unjudged(`${candidate.provider}/${candidate.model} 未回答版式清单 (layout checklist unanswered): 要求逐项确认 ${expectation.layoutBlocks.length} 个区块，回复里没有 layout 字段`)
    }

    // US-032 evidence rides along only when there is any; the score stays a function of
    // the model's own number, and the pass/rework line is the threshold — with one
    // exception the ledger demanded twice: 版式缺区块（SD-042）与画面读数不符（SD-085③）
    // 是硬属性，模型给再高的分也不放行。分数原样留着，因为它量的是审美质感，
    // 合格与否由这两条判定；界面上两者分列。
    const gaps = hardGaps(verdict)
    const evidence = {
      ...(verdict.frameScores !== undefined && verdict.frameScores.length > 0 ? { frameScores: verdict.frameScores } : {}),
      ...(verdict.findings !== undefined && verdict.findings.length > 0 ? { findings: verdict.findings } : {}),
    }
    if (verdict.score >= QC_THRESHOLD && gaps.length === 0) return { kind: 'visual-audit', decision: 'pass', score: verdict.score, ...evidence }
    const reasons = [...gaps, ...verdict.reasons]
    return {
      kind: 'visual-audit',
      decision: 'rework',
      score: verdict.score,
      reasons: reasons.length > 0 ? reasons : [`score ${verdict.score} below threshold ${QC_THRESHOLD}`],
      ...evidence,
      ...(gaps.length > 0
        ? { findings: [...(verdict.findings ?? []), ...gaps.map(message => ({ dimension: 'content' as const, severity: 'warning' as const, message, evidenceTimeSeconds: null }))] }
        : {}),
    }
  }
}

/**
 * US-032 FR-Q01: a clip is sampled at 10%/50%/90% (one ffmpeg call per frame,
 * timestamps kept). Partial failure degrades to the frames that did extract — a
 * two-frame audit is weaker but real, and only total failure is `unjudged`.
 */
async function multiPointFramesOf(subject: QcSubject): Promise<{ frames: AuditFrame[]; failedPositions: number[] }> {
  // ffmpeg picks the demuxer from the extension, so the clip has to be written
  // back out under its real one rather than a generic temp name.
  const source = path.join(subject.workdir, `audit-source.${extensionFor(subject.mimeType)}`)
  await writeFile(source, subject.bytes)
  const extracted = await extractMultiPointFrames({
    artifactPath: source,
    positions: [...AUDIT_FRAME_POSITIONS],
    workdir: subject.workdir,
  })
  const frames: AuditFrame[] = []
  for (const frame of extracted.frames) {
    frames.push({
      position: frame.position,
      timestampSeconds: frame.timestampSeconds,
      image: { bytes: new Uint8Array(await readFile(frame.framePath)), mimeType: 'image/png' },
    })
  }
  return { frames, failedPositions: extracted.failedPositions }
}

/**
 * The artifact under audit comes first — every frame, in clip order — because
 * every sentence the prompt spends on "the image" means the thing being judged.
 * A reference (when one conditioned the shot) is appended after them, never
 * slotted in between: swapping the order would have the model compare the
 * reference against itself.
 */
export function auditImages(subject: QcSubject, images: readonly AuditImage[]): string[] {
  // Already data URLs, and already the bytes the video model saw: re-encoding here
  // would let the auditor compare a frame nobody conditioned the shot on.
  return subject.referenceDataUrl
    ? [...images.map(image => toDataUrl(image.bytes, image.mimeType)), subject.referenceDataUrl]
    : images.map(image => toDataUrl(image.bytes, image.mimeType))
}

/**
 * SD-098: the shot's own script, placed in front of every continuity rule. An auditor that
 * is shown only the first frame scores a scripted fade-out or an entering figure as the
 * scene breaking apart — and the sole remedy on offer is another paid take of a clip that
 * did exactly what it was told. The list is two-sided: what the script names is not a
 * defect, what it never mentions still is, and the state the shot owes the next one is
 * checked rather than assumed.
 */
function shotIntentBlock(intent: ShotIntent | undefined): string[] {
  if (!intent) return []
  return [
    '本镜剧本要求（画面变化的判定基准，优先于任何连贯性通则）：',
    `- 画面内容：${intent.description || '(未记录)'}`,
    `- 本镜交给下一镜的结尾状态：${intent.continuityOut || '(未记录)'}`,
    '以上点名的变化是这一镜要拍的东西，不是断裂：灯光熄灭、画面转黑、按剧情入场的人物或物体、突发光效与阴影都不扣分，也不得记成 continuity finding。',
    '反向仍然成立：剧本没点名的改变就是缺陷——人物身份与服装、场景布局、道具数量自行变化，以及上面那个结尾状态在片段末尾没有兑现。',
    '',
  ]
}

/**
 * The multi-image reply contract for sampled-clip audits (US-032). `frameScores`
 * and `findings` are evidence; `score`/`reasons` remain the decision.
 */
const MULTI_POINT_REPLY = 'Reply with JSON only and no surrounding prose: {"score": <number between 0 and 1>, "reasons": ["<short reason>", ...], "frameScores": [{"position": <the sampled position, 0..1>, "score": <number between 0 and 1>}, ...], "findings": [{"dimension": "content" | "aesthetic" | "continuity", "severity": "warning" | "info", "message": "<short message>", "timeSeconds": <seconds into the clip where the problem is visible>}]}'

const LEGACY_REPLY = 'Reply with JSON only and no surrounding prose: {"score": <number between 0 and 1>, "reasons": ["<short reason>", ...]}'

/** 逐项核对用的回复契约：默认那条一个字节都不许多——它被按字面钉在测试里。 */
function replyContract(extraFields: string): string {
  return extraFields === ''
    ? LEGACY_REPLY
    : `Reply with JSON only and no surrounding prose: {"score": <number between 0 and 1>, "reasons": ["<short reason>", ...]${extraFields}}`
}

const LAYOUT_REPLY_FIELD = ', "layout": [{"block": "<区块名，逐字照抄核对清单>", "present": true | false}, ...]'
const READOUT_REPLY_FIELD = ', "readout": "<画面里逐字读到的数字串；画面没有任何可读数字时填空字符串>"'

/**
 * 这张图该逐项核对什么，全部从生成端写进 prompt 的那几行反查（SD-042 / SD-085③）。
 * `QcSubject` 没有 kind 字段（它在 qc.ts，不在本次改动范围），而素材的 prompt 里必然
 * 带着该 kind 的版式规格行——规格行就是 kind 的指纹，两处共用 `@studio/pipeline`
 * 同一份表，审核端不另抄一份区块名。
 */
export function auditExpectation(subject: Pick<QcSubject, 'prompt'>): AuditExpectation {
  const prompt = subject.prompt
  let layoutBlocks: string[] = []
  for (const [kind, spec] of Object.entries(ASSET_REFERENCE_SPECS_BY_KIND)) {
    if (prompt.includes(spec)) {
      layoutBlocks = ASSET_LAYOUT_BLOCKS_BY_KIND[kind] ?? []
      break
    }
  }
  const policy = screenTextPolicy(prompt)
  return {
    layoutBlocks,
    expectedReadout: policy.mode === 'whitelist' ? policy.readout : null,
    forbidsReadableText: policy.mode === 'no-text',
  }
}

/** 抽帧审核什么都不逐项核对：那份契约按字面钉在测试与既有链路里。 */
const EMPTY_EXPECTATION: AuditExpectation = { layoutBlocks: [], expectedReadout: null, forbidsReadableText: false }

/** 核对项要模型答什么，就得多要哪几个字段——一条不许多。 */
function expectationReplyFields(expectation: AuditExpectation): string {
  const fields: string[] = []
  if (expectation.layoutBlocks.length > 0) fields.push(LAYOUT_REPLY_FIELD)
  if (expectation.expectedReadout !== null || expectation.forbidsReadableText) fields.push(READOUT_REPLY_FIELD)
  return fields.join('')
}

/** 版式与读数的核对条款；只在生成端真的写了这些规则时追加。 */
function expectationBlock(expectation: AuditExpectation): string[] {
  const blocks: string[] = []
  if (expectation.layoutBlocks.length > 0) {
    blocks.push(
      `版式核对（最高优先级，逐项回答 layout）：这张图必须是一张按上述规格排布的设定图，以下区块逐项都必须存在——${expectation.layoutBlocks.map((block, index) => `${index + 1}) ${block}`).join('；')}。`,
      'layout 数组里每个区块一项（present=true 表示该区块在画面里确实存在）。任一区块缺失就是版式不成立，直接判不合格并在 reasons 里点名缺的是哪一项；画面再干净、单张肖像画得再好也不给过——缺区块不是审美问题，是这张图不是它声称的那种图。',
    )
  }
  if (expectation.expectedReadout !== null) {
    blocks.push(
      `读数核对（最高优先级）：本镜剧本认定的数字读数只有 ${expectation.expectedReadout}。把画面里逐字读到的数字填进 readout；`
      + `读到的不是 ${expectation.expectedReadout}（含钟面/屏幕/单据上任何其它数字）就是缺陷，必须在 reasons 里写明「剧本 ${expectation.expectedReadout} / 画面 <读到的>」并判不合格，画面再干净也不给过。`,
    )
  } else if (expectation.forbidsReadableText) {
    blocks.push(
      '读数核对（最高优先级）：本镜的生成指令明令画面不出现任何可读字符。把画面里逐字读到的数字填进 readout（没有可读数字就填空字符串）；'
      + '只要出现可读数字（钟面、屏幕、单据上的都算），那就是模型自己编的道具，必须在 reasons 里写明读到了什么并判不合格。',
    )
  }
  return blocks
}

/** 强制不合格的两类硬伤：版式缺区块、画面读数与剧本不符。 */
function hardGaps(verdict: AuditVerdict): string[] {
  const gaps: string[] = []
  if (verdict.layoutGaps && verdict.layoutGaps.length > 0) {
    gaps.push(`版式缺区块：${verdict.layoutGaps.join('、')}`)
  }
  if (verdict.readoutGap) gaps.push(`画面读数与剧本不符：${verdict.readoutGap}`)
  return gaps
}

/**
 * With no `frames`, the prompt is byte-identical to the single-image audit it
 * always was (still the whole story for still images, and the compat path the
 * existing chain asserts on). With `frames`, the clip is described as sampled
 * frames labeled with position and timestamp, and the reply contract grows
 * per-frame scores and findings.
 */
export function buildAuditPrompt(subject: QcSubject, plan: Exclude<AuditPlan, 'none'>, frames?: readonly AuditFrameRef[]): string {
  // 带首帧参考的审核(图生视频)与无条件审核(纯文生)的基准不同:
  // 前者的画面基准是首帧本身——指令里文学化的中途状态描述不构成核对项;
  // 后者没有画面基准,才需要拿指令全文做硬属性核对。
  const sampled = frames !== undefined && frames.length > 0
  const intro = sampled
    ? [
        'The clip is shown to you as sampled frames, listed in clip order. You cannot judge audio, and motion only between the sampled positions.',
        ...frames.map((frame, index) => `- Image ${index + 1}: ${Math.round(frame.position * 100)}% into the clip (${frame.timestampSeconds.toFixed(2)}s)`),
      ]
    : [
        plan === 'frame'
          ? 'The image is a single frame taken from the middle of the generated clip. You cannot judge motion, continuity between shots, or audio.'
          : 'The image is the generated artifact itself.',
      ]
  const header = [
    'You are auditing one artifact produced by an automated film & video production pipeline.',
    `Stage: ${subject.stage}`,
    `Generation prompt: ${subject.prompt || '(none recorded)'}`,
    ...intro,
    '',
  ]
  // 整图审核才做逐项核对：版式区块与剧本读数都是「这一张图该长什么样」的问题。
  const expectation = sampled ? EMPTY_EXPECTATION : auditExpectation(subject)
  const reply = sampled ? MULTI_POINT_REPLY : replyContract(expectationReplyFields(expectation))
  const floor = `A score of ${QC_THRESHOLD} or above means the artifact is usable.`
  // SD-098: the script only speaks about the clip it wrote, so the allowed-changes list is
  // only meaningful next to sampled frames. A still-image audit keeps its byte-identical prompt.
  const intent = sampled ? shotIntentBlock(subject.shotIntent) : []
  // SD-042 / SD-085③：版式清单与剧本读数只加在整图审核这条路上——它俩核的都是一张静态图
  // 该长什么样。抽帧那条路的契约一个字节都不许多（它按字面钉在测试里），且稀疏抽帧本来
  // 也证明不了「画面里没有别的数字」。
  const expectations = expectationBlock(expectation)
  const scripted = sampled && subject.shotIntent !== undefined
  const multiPoint = sampled
    ? [
        scripted
          ? '多时点核对:frameScores 按每帧标注的 position 逐帧给出 0..1 分;帧与帧之间的出场主体、服装与场景不得在「本镜剧本要求」之外改变——剧本点名的变化不扣分,只有剧本没点名的跨时点不一致才记 dimension="continuity" 的 finding。'
          : '多时点核对:frameScores 按每帧标注的 position 逐帧给出 0..1 分;帧与帧之间出场主体、服装与场景不得无声改变——跨时点不一致记 dimension="continuity" 的 finding。',
        '每个 finding 的 timeSeconds 填问题所在帧的标注时间戳(取最接近的一个);整体性、无明确时间点的问题省略 timeSeconds。稀疏抽帧证明不了的部分不要臆断。',
      ]
    : []
  if (subject.referenceDataUrl) {
    if (!sampled) {
      return [
        ...header,
        '这是图生视频:第二张图(首帧)是这段视频的画面基准。',
        '硬属性核对以首帧为基准:出场人物的身份、性别、人数、服装与场景必须和首帧一致——任何与首帧不符的主体替换、凭空增减人物都是缺陷,在 reasons 里写明。',
        '生成指令中的文学化状态描述(如剧情中途的异变"皮肤青灰""手透明"、特殊光照、姿态)如果与首帧已呈现的画面不同,以首帧为准,不算缺陷;指令只用于确认延续的动作方向是否合理。',
        '图生视频是从首帧出发的延续:片段只需延续首帧中的场景与动作。指令可能描述了超出本片段时长的后续剧情——五秒的延续没有覆盖那些后续情节不是缺陷。',
        '',
        '在此之上再判断通用缺陷(模糊、肢体扭曲、乱码文字、压缩噪点)。',
        '',
        'A second image is attached, and it comes after the one described above: the approved first frame this clip was generated from, the exact image the video model was conditioned on.',
        'Judge the artifact against that reference. It must depict the same character, the same prop, the same scene subject: the same face, the same build, the same clothing and the same object, allowing only for the angle, framing and lighting the clip changes.',
        'A plausible but different person, or an object quietly redesigned between the frame and the clip, is a defect worth flagging. Name it in reasons and score it below the threshold: a cut the audience reads as two different characters is not usable however clean the clip looks.',
        ...expectations,
        reply,
        floor,
      ].join('\n')
    }
    return [
      ...header,
      ...intent,
      '这是图生视频:最后一张图(首帧)是这段视频的画面基准。',
      '硬属性核对以首帧为基准:出场人物的身份、性别、人数、服装与场景必须和首帧一致——任何与首帧不符的主体替换、凭空增减人物都是缺陷,在 reasons 里写明。',
      '生成指令中的文学化状态描述(如剧情中途的异变"皮肤青灰""手透明"、特殊光照、姿态)如果与首帧已呈现的画面不同,以首帧为准,不算缺陷;指令只用于确认延续的动作方向是否合理。',
      '图生视频是从首帧出发的延续:片段只需延续首帧中的场景与动作。指令可能描述了超出本片段时长的后续剧情——五秒的延续没有覆盖那些后续情节不是缺陷。',
      '',
      '在此之上再判断通用缺陷(模糊、肢体扭曲、乱码文字、压缩噪点)。',
      '',
      ...multiPoint,
      'After the sampled frames one further image is attached: the approved first frame this clip was generated from, the exact image the video model was conditioned on.',
      'Judge every sampled frame against that reference. Each must depict the same character, the same prop, the same scene subject: the same face, the same build, the same clothing and the same object, allowing only for the angle, framing and lighting the clip changes.',
      'A plausible but different person, or an object quietly redesigned between the frame and the clip, is a defect worth flagging. Name it in reasons and score it below the threshold: a cut the audience reads as two different characters is not usable however clean the clip looks.',
      reply,
      floor,
    ].join('\n')
  }
  return [
    ...header,
    ...intent,
    '硬属性核对(最高优先级):先从生成指令中提取每个出场主体的硬属性——性别、年龄段(如"十六岁少女"不是男孩)、大致人数、关键道具,再逐项与画面比对。',
    '生成指令中"图N＝角色定妆照｜..."的对应关系同样必须成立:画面人物必须与指令声称的定妆照主体一致。',
    '任何一项硬属性不符(性别画错、年龄明显偏差、多了或少了人物、关键道具缺失或张冠李戴)都直接判不合格,在 reasons 里写明是哪一项不符,即使画面本身很干净。',
    '',
    '在此之上再判断通用缺陷:是否呈现了生成指令描述的场景,有无明显瑕疵(模糊、肢体扭曲、乱码文字、主体缺失或重复、压缩噪点)。',
    ...expectations,
    ...multiPoint,
    reply,
    floor,
  ].join('\n')
}

/**
 * A bare JSON.parse is not a parser for model output: answers arrive wrapped in
 * prose or a code fence often enough to matter. A score outside 0..1 is rejected
 * rather than clamped, because a clamped guess would still look like a judgment.
 *
 * `frameTimestamps` are the timestamps of the frames the model was actually
 * shown; a finding's claimed time is snapped onto them so evidence always points
 * at a frame that exists. Without them (a still-image audit) times stay null.
 */
export function parseVerdict(text: string, frameTimestamps: readonly number[] = [], expectation: AuditExpectation = EMPTY_EXPECTATION): AuditVerdict | null {
  for (const candidate of jsonCandidates(stripThinking(text))) {
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
    const verdict: AuditVerdict = { score, reasons }
    const frameScores = parseFrameScores((parsed as { frameScores?: unknown }).frameScores)
    if (frameScores.length > 0) verdict.frameScores = frameScores
    const findings = parseFindings((parsed as { findings?: unknown }).findings, frameTimestamps)
    if (findings.length > 0) verdict.findings = findings
    const layout = parseLayout((parsed as { layout?: unknown }).layout, expectation.layoutBlocks)
    if (layout.gaps.length > 0) verdict.layoutGaps = layout.gaps
    if (expectation.layoutBlocks.length > 0 && !layout.answered) verdict.layoutUnanswered = true
    const readoutGap = parseReadout((parsed as { readout?: unknown }).readout, expectation)
    if (readoutGap) verdict.readoutGap = readoutGap
    return verdict
  }
  return null
}

/**
 * SD-042: 版式清单的逐项答复。没被 `present: true` 确认存在的区块都算缺（模型漏答某一项
 * 也算缺：清单是逐项要的，漏答就是没证据）。整段没答另走 `layoutUnanswered`——那是没审，
 * 不是审出不合格。实测裸半身照与五区块板同分同空 findings，就是因为过去没有任何地方
 * 要求审核逐项回答。
 */
function parseLayout(raw: unknown, required: readonly string[]): { answered: boolean; gaps: string[] } {
  if (required.length === 0) return { answered: false, gaps: [] }
  if (!Array.isArray(raw)) return { answered: false, gaps: [] }
  const confirmed = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const { block, present } = entry as { block?: unknown; present?: unknown }
    // 只认真值：`present` 写成 "true" / 1 都不算确认存在，与 score 一样拒绝被改写。
    if (present === true && typeof block === 'string') confirmed.add(layoutBlockKey(block))
  }
  return { answered: true, gaps: required.filter(block => !confirmed.has(layoutBlockKey(block))) }
}

/** 区块名的比对键：编号、空白、全角括号里的注解都不参与——模型会重排它们。 */
function layoutBlockKey(block: string): string {
  return block.replace(/[①②③④⑤⑥⑦⑧⑨]/g, '').replace(/[\s（）()【】]/g, '')
}

/**
 * SD-085③: 画面上读到的数字 vs 剧本认账的读数。
 * - 白名单档：读数不一致就是缺陷（镜头 #4 的床头钟显示「138」，2026-10-21 实测通过审核）。
 * - 禁字档：画面里出现任何可读数字都是模型自己编的道具。
 * 模型没答（字段缺失/空串/无数字）时不编造不符——没有证据就不假装读出过什么。
 */
function parseReadout(raw: unknown, expectation: AuditExpectation): string | null {
  if (typeof raw !== 'string') return null
  const seen = raw.replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 0xff10)).replace(/\s/g, '').replace(/：/g, ':')
  if (seen.length === 0) return null
  if (expectation.expectedReadout !== null) {
    const expected = expectation.expectedReadout.replace(/\s/g, '').replace(/：/g, ':')
    return seen === expected ? null : `画面「${seen}」/ 剧本「${expected}」`
  }
  if (expectation.forbidsReadableText && /\d/.test(seen)) return `画面「${seen}」/ 剧本无读数（本镜禁一切可读字符）`
  return null
}

/** Per-frame scores the model actually numbered; anything unusable is dropped, not repaired. */
function parseFrameScores(raw: unknown): AuditFrameScore[] {
  if (!Array.isArray(raw)) return []
  const scores: AuditFrameScore[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const { position, score } = entry as { position?: unknown; score?: unknown }
    if (typeof position !== 'number' || !Number.isFinite(position) || position < 0 || position > 1) continue
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) continue
    scores.push({ position, score })
  }
  return scores
}

/**
 * Structured findings, kept only when every field is one of the values the
 * contract allows — a wrong dimension or severity drops the entry rather than
 * being coerced into a shape the model never chose (the same discipline that
 * rejects rather than clamps a bad score).
 */
function parseFindings(raw: unknown, frameTimestamps: readonly number[]): AuditFinding[] {
  if (!Array.isArray(raw)) return []
  const findings: AuditFinding[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const { dimension, severity, message, timeSeconds } = entry as Record<string, unknown>
    if (dimension !== 'content' && dimension !== 'aesthetic' && dimension !== 'continuity') continue
    if (severity !== 'warning' && severity !== 'info') continue
    if (typeof message !== 'string' || message.trim().length === 0) continue
    findings.push({ dimension, severity, message, evidenceTimeSeconds: evidenceTime(timeSeconds, frameTimestamps) })
  }
  return findings
}

/**
 * The model names seconds; evidence lives on frames. A claimed time is snapped
 * to the nearest sampled timestamp, so a finding always points at a frame that
 * was actually shown. No usable time — or nothing to snap onto — keeps null:
 * an unpinned finding is honest, a guessed pin is not.
 */
function evidenceTime(timeSeconds: unknown, frameTimestamps: readonly number[]): number | null {
  if (typeof timeSeconds !== 'number' || !Number.isFinite(timeSeconds)) return null
  if (frameTimestamps.length === 0) return null
  let nearest = frameTimestamps[0]!
  for (const timestamp of frameTimestamps) {
    if (Math.abs(timestamp - timeSeconds) < Math.abs(nearest - timeSeconds)) nearest = timestamp
  }
  return nearest
}

/** qwen3 系默认开思考模式：答案前面常带一段 <think>…</think> 推理。思考段里的花括号
 *  会让「最外层花括号对」跨进垃圾区，整段 JSON 就解析不出来（2026-09-28 实测：场景图
 *  审计全部 unjudged 即此）。先剥思考段再找 JSON；未闭合的思考尾巴无药可救，原样交给
 *  上层报「解析不出」并带上原文。 */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '')
}

/** The whole answer first, then the outermost brace pair — whichever parses wins. */
function jsonCandidates(text: string): string[] {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  return start !== -1 && end > start ? [trimmed, trimmed.slice(start, end + 1)] : [trimmed]
}

function unjudged(reason: string): QcVerdict {
  return { kind: 'visual-audit', decision: 'unjudged', reasons: [reason] }
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SD-183 镜内闪变读数 + SD-184 邻镜重复读数。
 *
 * 台账的指控（SD-183/SD-184/SD-081 同族）是「生成了视频却没测这两个坏法，也没有
 * 区分度」，所以这一节只做两件事：把数读出来（一次 ffmpeg 单程，测不出就是 null），
 * 以及把数接进既有判定通道——rework 走 `hardGaps` 同一条「模型给再高分也不放行」的
 * 路（applyIntraShotFlicker），warn 走 findings 的 `severity: 'warning'`，测不出就是
 * unknown 不进判定。四态之外不发明新状态；读数本体随 qualityCheck.report 落库。
 */

/**
 * 镜内闪变判级阈（单点定义，全 repo 只这里写数值）：
 * - 检测阈 0.2 = 台账读数同一口径（SD-183 行：#5 即 `select='gt(scene,0.2)'` 数出的
 *   7 次跳变、最高分 1.00，mm24_scenes.txt）。
 * - rework 档 7 = #5 实测缺陷案发现场：一条 4.04 s 素材 7 次亚秒级跳，观感像故障。
 * - warn 档 2 = 2026-10-25 对本集 10 条已接受素材同口径实测，最多 1 次（剧本内的
 *   单次画面变化）；≥2 超出实测「被接受」上限，但没有独立的实测缺陷档，只报不拦。
 */
export const FLICKER_DETECT_SCENE_SCORE_MIN = 0.2
export const FLICKER_REWORK_CUT_COUNT = 7
export const FLICKER_WARNING_CUT_COUNT = 2

export interface IntraShotFlickerReading {
  /** false = 没测出来（ffmpeg 缺失/文件坏），它和 sceneCutCount:0 是两个世界。 */
  measured: boolean
  sceneCutCount: number | null
  maxSceneScore: number | null
}

/** 对已落盘的素材文件做一次场景分计数；读不出返回「未测」，绝不抛。 */
export async function measureIntraShotFlicker(videoFile: string): Promise<IntraShotFlickerReading> {
  const measured = await measureSceneCuts(videoFile, FLICKER_DETECT_SCENE_SCORE_MIN)
  if (!measured) return { measured: false, sceneCutCount: null, maxSceneScore: null }
  return { measured: true, sceneCutCount: measured.cutCount, maxSceneScore: measured.maxScore }
}

export type FlickerStatus = 'clean' | 'warning' | 'rework' | 'unknown'

export function flickerStatusOf(reading: IntraShotFlickerReading): FlickerStatus {
  if (!reading.measured || reading.sceneCutCount === null) return 'unknown'
  if (reading.sceneCutCount >= FLICKER_REWORK_CUT_COUNT) return 'rework'
  if (reading.sceneCutCount >= FLICKER_WARNING_CUT_COUNT) return 'warning'
  return 'clean'
}

/**
 * 把闪变读数接进审核结论。`pass` + rework 档 → `rework`（与版式缺区块同一条硬属性
 * 纪律：分数原样留着，合格与否由读数判）；`warning` 档只追加 continuity finding，
 * 不改判定；`unjudged` 不动（审核本来就没发生，读数解释不了为什么）；测不出原样
 * 交回——调用方把 `measured:false` 落进 report，界面上「没测」不等于「干净」。
 */
export function applyIntraShotFlicker(verdict: QcVerdict, reading: IntraShotFlickerReading): QcVerdict {
  const status = flickerStatusOf(reading)
  if (status === 'clean' || status === 'unknown') return verdict
  if (verdict.decision === 'unjudged') return verdict
  const message = `镜内闪变（SD-183）：一条素材内 ${reading.sceneCutCount} 次场景跳变（检测阈 ${FLICKER_DETECT_SCENE_SCORE_MIN}，最高分 ${reading.maxSceneScore?.toFixed(2) ?? '未读出'}）`
    + (status === 'rework' ? `，达台账实测缺陷档 ${FLICKER_REWORK_CUT_COUNT}（#5：4.04 s 内 7 次）` : `，超出本集已接受素材实测上限 1 次（warn 档 ${FLICKER_WARNING_CUT_COUNT}，不拦判定）`)
  const finding: AuditFinding = { dimension: 'continuity', severity: 'warning', message, evidenceTimeSeconds: null }
  if (status === 'warning') {
    return { ...verdict, findings: [...(verdict.findings ?? []), finding] } as QcVerdict
  }
  if (verdict.decision === 'pass') {
    return {
      kind: verdict.kind,
      decision: 'rework',
      score: verdict.score,
      reasons: [message],
      findings: [finding],
      ...(verdict.frameScores !== undefined ? { frameScores: verdict.frameScores } : {}),
    }
  }
  return { ...verdict, reasons: [...verdict.reasons, message], findings: [...(verdict.findings ?? []), finding] }
}

/** 回看窗口只扫当前镜往前这么多镜（含当前镜）：实测案犯是 3 连，4 已经给出扩判余量。 */
const NEIGHBOR_DUPLICATE_SCAN_BACK = 4

export type ShotNeighborDuplicateReading = NeighborDuplicateReading & {
  /** pairDistances/索引所对应的窗口镜头号（台账顺序，1 起，升序）。 */
  windowShotNumbers: number[]
}

export interface ShotNeighborDuplicateArgs {
  db: PrismaClient
  storage: Storage
  workdir: string
  organizationId: string
  /** 本镜刚落版的视频文件（take/母带），已在盘上。 */
  videoFile: string
  storyboardId: string
}

/**
 * SD-184：这一镜落版后，往前数有几镜画面几乎相同。每镜一次中段 32×32 灰帧解码，
 * 链一断（距离超阈或某镜取不到）就停——重复链只会紧挨着当前镜。任何一步失败都
 * 降级为「测不出」（status unknown），绝不抛穿任务链，也绝不把「没测」摆成「无重复」。
 */
export async function measureShotNeighborDuplicates(args: ShotNeighborDuplicateArgs): Promise<ShotNeighborDuplicateReading> {
  const empty: ShotNeighborDuplicateReading = { ...readNeighborDuplicates([]), windowShotNumbers: [] }
  try {
    const current = await args.db.storyboard.findUnique({ where: { id: args.storyboardId }, select: { episodeId: true, number: true } })
    if (!current) return { ...readNeighborDuplicates([null]), windowShotNumbers: [] }
    const neighbors = await args.db.storyboard.findMany({
      where: { episodeId: current.episodeId, supersededAt: null, number: { lt: current.number } },
      orderBy: { number: 'desc' },
      take: NEIGHBOR_DUPLICATE_SCAN_BACK - 1,
    })
    if (neighbors.length === 0) return empty
    let prevSig = await probeFrameSignature(args.videoFile, args.workdir)
    const distances: Array<number | null> = []
    const numbers: number[] = [current.number]
    for (const neighbor of neighbors) {
      const sig = prevSig === null ? null : await signatureOfShotVideo(args, neighbor.id)
      const distance = sig !== null && prevSig !== null ? frameSignatureDistance(prevSig, sig) : null
      distances.push(distance)
      numbers.unshift(neighbor.number)
      if (distance === null || distance > NEIGHBOR_DUPLICATE_DISTANCE) break
      prevSig = sig
    }
    // distances 按「当前镜→更早」走出，反转后与 numbers（unshift 后已按镜号升序）
    // 同向：pairDistances[i] 就是 numbers[i] 与 numbers[i+1] 之间的距离。
    return { ...readNeighborDuplicates(distances.reverse()), windowShotNumbers: numbers }
  } catch {
    // 台账取数失败同样只降级为 unknown：这条读数是新增的监视项，没资格失败一个已付费的任务。
    return { ...readNeighborDuplicates([null]), windowShotNumbers: [] }
  }
}

/** 这一镜对外的画面：人工钦定优先，否则最近一条成功生成任务落的 VIDEO 产物。 */
async function signatureOfShotVideo(args: ShotNeighborDuplicateArgs, storyboardId: string): Promise<Uint8Array | null> {
  const shot = await args.db.storyboard.findUnique({ where: { id: storyboardId }, select: { selectedVideoArtifactId: true } })
  const selected = shot?.selectedVideoArtifactId
    ? await args.db.mediaArtifact.findFirst({ where: { id: shot.selectedVideoArtifactId, organizationId: args.organizationId, stage: 'VIDEO' } })
    : null
  const artifact = selected ?? await args.db.mediaArtifact.findFirst({
    where: {
      organizationId: args.organizationId,
      stage: 'VIDEO',
      OR: [
        { storyboardId },
        { task: { storyboardId, status: 'SUCCEEDED' } },
      ],
    },
    orderBy: { id: 'desc' },
  })
  if (!artifact) return null
  const bytes = await args.storage.read(artifact.objectKey)
  const file = path.join(args.workdir, `neighbor-${artifact.id}.${extensionFor(artifact.mimeType)}`)
  await writeFile(file, bytes)
  return probeFrameSignature(file, args.workdir)
}

/** 邻镜重复报警的稳定文案；run 长度与镜号都来自读数，不拼主观句。 */
export function neighborDuplicateMessage(reading: ShotNeighborDuplicateReading): string | null {
  if (reading.status !== 'warning') return null
  const runIndexes = reading.maxRunShotIndexes.map(index => reading.windowShotNumbers[index - 1]).filter((n): n is number => n !== undefined)
  return `邻镜重复（SD-184）：第 ${runIndexes.join('/')} 镜连续 ${reading.maxRunLength} 镜画面几乎相同（32×32 灰度距离 ≤ ${NEIGHBOR_DUPLICATE_DISTANCE}）；台账实测案档：#44-46/#57-59 三连重复串成 13.00 s 无切点段`
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SD-087/SD-088 结构漂移这条轴：2026-10-25 实测**量不到**，所以只摆数不判级。
 *
 * 台账的指控是「镜头中途服装塌陷 / 门上长出第二套五金件，QC 仍给 pass 0.92」。按 SD-184
 * 的规矩先用生产同一把尺（32×32 area 灰格 + 平均灰度差）对 `evidence/` 19 条成片量了
 * 早 15% ↔ 晚 85% 的距离，并另测了 4×4 分块最大块距离、±4 px 平移补偿距离、光照归一
 * （1−NCC）与平移+光照双补偿四条候选轴：
 *   缺陷档  SD-087 shot04 v1 0.1585（分块 0.2629 / 平移 0.1272 / 双补偿 0.5423）
 *           SD-088 shot04 v2 0.1260（0.2510 / 0.1126 / 0.5140）
 *   人工留档 shot02 0.1612（0.3665 / 0.1206 / 0.7006）← 合法推镜（中景推到眼部特写），
 *           主体与服装全程稳定，四条轴上全部**高于**两条已坐实的缺陷片
 *           shot03 v2 0.1032、shot03 v1 0.0745、shot27 0.0292、shot34 0.0223、shot24 0.0072
 *   人工不收 shot47（横向撕裂带）0.0123、shot23 v1 0.0058 ← 明显缺陷却低于被接受的推镜
 * ⇒ 这条轴排的是位移量，不是结构增减；任何能拦住 0.126 的阈值都会先拦掉 0.1612 那条好片。
 * 所以这里不设 rework/warn 阈（没有实测缺陷档与实测正常档的空档可站），只把逐镜不同的
 * 距离落库让屏上的数至少来自内容（SD-081）。要拦住这一族缺陷得换传感器：把钦定首帧作为
 * 参照、对肩部/领口/门五金这类**可数结构件**做带位置的增减判定（区域级目标检测或
 * 首帧↔后段帧的 VLM 比对），而不是整幅像素距离——判据缺口已记在 SD-087/SD-088 的修复方向里。
 */

/** 一条素材内取哪几个相对时刻：首帧（i2v 的条件帧）+ 审核抽帧覆盖到的 15%/50%/85%。 */
export const STRUCTURE_DRIFT_SAMPLE_FRACTIONS = [0, 0.15, 0.5, 0.85] as const

export interface StructureDriftReading {
  /** false = 一帧都没量出来（ffmpeg 缺失/文件坏），它与「量到 0」是两个世界。 */
  measured: boolean
  /** 早 15% ↔ 晚 85%：SD-087/088 的缺陷形状就落在这一个数上。 */
  earlyLateDistance: number | null
  /** 首帧 ↔ 中段：与 SD-184 的邻镜距离同轴，两个数可以横着比。 */
  firstMidDistance: number | null
  /** 相邻取样点里最大的一步：突变（跳切）与缓变（服装下滑）在数上分开。 */
  maxStepDistance: number | null
  /** 取样时刻（秒），落库后能被复算，不让人对着无源的数猜。 */
  sampleSeconds: number[]
}

/** 同一条素材内几个时刻的画面距离；任何一步失败都降级「未测」，绝不抛进已付费的任务链。 */
export async function measureClipStructureDrift(args: { videoFile: string; workdir: string }): Promise<StructureDriftReading> {
  const empty: StructureDriftReading = { measured: false, earlyLateDistance: null, firstMidDistance: null, maxStepDistance: null, sampleSeconds: [] }
  try {
    const durationMs = await probeDuration(args.videoFile)
    if (durationMs <= 0) return empty
    const seconds = STRUCTURE_DRIFT_SAMPLE_FRACTIONS.map(fraction => Math.round(durationMs * fraction) / 1000)
    const signatures: Array<Uint8Array | null> = []
    for (const second of seconds) signatures.push(await probeFrameSignatureAt(args.videoFile, args.workdir, second))
    const at = (index: number): Uint8Array | null => signatures[index] ?? null
    const between = (left: number, right: number): number | null => {
      const a = at(left)
      const b = at(right)
      return a && b ? frameSignatureDistance(a, b) : null
    }
    const steps = STRUCTURE_DRIFT_SAMPLE_FRACTIONS.slice(1).map((_, index) => between(index, index + 1))
    const earlyLate = between(1, 3)
    const firstMid = between(0, 2)
    const measuredSteps = steps.filter((step): step is number => step !== null)
    const maxStep = measuredSteps.length > 0 ? Math.max(...measuredSteps) : null
    if (earlyLate === null && firstMid === null && maxStep === null) return { ...empty, sampleSeconds: seconds }
    return { measured: true, earlyLateDistance: earlyLate, firstMidDistance: firstMid, maxStepDistance: maxStep, sampleSeconds: seconds }
  } catch {
    return empty
  }
}

/**
 * SD-081 的区分度纪律：同一把尺量出不同画面，却给出逐字相同（总分 + 逐帧分 + 发现三项全等）
 * 的回答，那次审核就没有判断过任何东西。台账的三条片子（#2、#3 v1、#3 v2）正是这个形状。
 * 这一条不猜阈值、不看像素：它只问「这份答案是不是上一份的复印件」。
 */
const AUDIT_REPETITION_LOOKBACK = 5

export interface AuditRepetitionReading {
  /** 与本条逐字相同的那条已存结论所属产物；null = 没有逐字相同的可比对象。 */
  matchedArtifactId: string | null
  /** 两条片子中段 32×32 灰帧距离（与 SD-184 同一把尺、同一个实测阈）；null = 没量出来。 */
  pictureDistance: number | null
  /**
   * `repeated` = 逐字相同且画面确有不同；`distinct` = 有可比对象且不是复印件（含「同一画面
   * 得到同一答案」这种合法情形）；`unknown` = 逐字相同但画面距离量不出，或取数本身失败；
   * `no-baseline` = 无从对照（本次没有逐帧答案，或本集还没有第二条视频结论）。
   */
  status: 'no-baseline' | 'distinct' | 'repeated' | 'unknown'
}

export interface AuditRepetitionArgs {
  db: PrismaClient
  storage: Storage
  workdir: string
  organizationId: string
  episodeId: string
  /** 本条结论所属产物（对照的是同集**其它**产物的已存结论）。 */
  artifactId: string
  /** 本条成片，已在盘上。 */
  videoFile: string
  verdict: QcVerdict
}

/** 被当成「判断」的就是这三样；逐字比的是它们，别的（时间戳、产物 id）都不算内容。 */
export function auditAnswerFingerprint(answer: { score?: number | null; frameScores?: readonly AuditFrameScore[]; findings?: readonly AuditFinding[] }): string {
  return JSON.stringify({
    score: answer.score ?? null,
    frameScores: (answer.frameScores ?? []).map(frame => [frame.position, frame.score]),
    findings: (answer.findings ?? []).map(finding => [finding.dimension, finding.severity, finding.message, finding.evidenceTimeSeconds ?? null]),
  })
}

export async function measureAuditRepetition(args: AuditRepetitionArgs): Promise<AuditRepetitionReading> {
  const noBaseline: AuditRepetitionReading = { matchedArtifactId: null, pictureDistance: null, status: 'no-baseline' }
  // 只有模型真的按帧答过的 pass 才有可比性：fake-qc/hash 那条路一个 frameScores 都没有，
  // 拿它去判「复印件」等于把没发生过的事当成发生过。人工留版的重放（priorCheck）也不进来。
  if (args.verdict.decision !== 'pass' || !args.verdict.frameScores?.length) return noBaseline
  try {
    const priors = await args.db.qualityCheck.findMany({
      where: {
        kind: 'visual-audit',
        score: { not: null },
        artifact: {
          organizationId: args.organizationId,
          stage: 'VIDEO',
          id: { not: args.artifactId },
          OR: [
            { task: { batch: { episodeId: args.episodeId } } },
            { importedFor: { episodeId: args.episodeId } },
          ],
        },
      },
      orderBy: { id: 'desc' },
      take: AUDIT_REPETITION_LOOKBACK,
      select: { report: true, score: true, artifactId: true, artifact: { select: { objectKey: true, mimeType: true } } },
    })
    const answer = auditAnswerFingerprint(args.verdict)
    let compared = false
    for (const prior of priors) {
      const priorArtifact = prior.artifact
      if (!prior.artifactId || !priorArtifact) continue
      let priorAnswer: string | null = null
      try {
        const report = JSON.parse(prior.report) as { frameScores?: AuditFrameScore[]; findings?: AuditFinding[] }
        if (report.frameScores?.length) priorAnswer = auditAnswerFingerprint({ score: prior.score, frameScores: report.frameScores, findings: report.findings })
      } catch {
        priorAnswer = null
      }
      if (priorAnswer === null) continue
      compared = true
      if (priorAnswer !== answer) continue
      // 逐字相同本身还不是指控：两条片子若本来就是同一画面（≤ 实测「同图」阈 0.03），
      // 同一答案是合法的；只有「画面不同而答案相同」才不是判断过的证据。
      const distance = await pictureDistanceBetweenClips(args, priorArtifact.objectKey, priorArtifact.mimeType, prior.artifactId)
      if (distance === null) return { matchedArtifactId: prior.artifactId, pictureDistance: null, status: 'unknown' }
      return { matchedArtifactId: prior.artifactId, pictureDistance: distance, status: distance > NEIGHBOR_DUPLICATE_DISTANCE ? 'repeated' : 'distinct' }
    }
    return compared ? { matchedArtifactId: null, pictureDistance: null, status: 'distinct' } : noBaseline
  } catch {
    // 这条读数是新增的监视项，没资格失败一个已付费的任务；但「没查成」也不许摆成「没有重复」。
    return { matchedArtifactId: null, pictureDistance: null, status: 'unknown' }
  }
}

/** 本条与上一条的中段画面距离：上一条的字节从 storage 取，取不到就是 null（不猜）。 */
async function pictureDistanceBetweenClips(args: AuditRepetitionArgs, priorObjectKey: string, priorMimeType: string, priorArtifactId: string): Promise<number | null> {
  const current = await probeFrameSignature(args.videoFile, args.workdir)
  if (!current) return null
  const bytes = await args.storage.read(priorObjectKey)
  const file = path.join(args.workdir, `prior-audit-${priorArtifactId}.${extensionFor(priorMimeType)}`)
  await writeFile(file, bytes)
  const prior = await probeFrameSignature(file, args.workdir)
  return prior ? frameSignatureDistance(current, prior) : null
}

/**
 * `pass` + repeated → `unjudged`，不是 `rework`：重抽治不了「审核没看图」，那条路还要再花
 * 一次付费生成，而未判定才是这件事的真名（与 applyIntraShotFlicker 的「未判定 ≠ 通过」同
 * 一口径）。其余三态与非 pass 判定一律原样交回。
 */
export function applyAuditRepetition(verdict: QcVerdict, reading: AuditRepetitionReading): QcVerdict {
  if (reading.status !== 'repeated' || verdict.decision !== 'pass') return verdict
  return { kind: verdict.kind, decision: 'unjudged', reasons: [auditRepetitionMessage(verdict, reading)] }
}

/** 未判定的理由要能被人复算：比的是哪一条、画面差多少、阈是多少，全部来自读数。 */
export function auditRepetitionMessage(verdict: Extract<QcVerdict, { decision: 'pass' }>, reading: AuditRepetitionReading): string {
  return `视频审核未判定（SD-081）：本条与产物 ${reading.matchedArtifactId} 的结论逐字相同（总分 ${verdict.score}、${verdict.frameScores?.length ?? 0} 个逐帧分、${verdict.findings?.length ?? 0} 条发现全等），`
    + `而两条片子的中段画面距离 ${reading.pictureDistance?.toFixed(3) ?? '未量出'} 已超出实测「同图」阈 ${NEIGHBOR_DUPLICATE_DISTANCE}——不同画面得到逐字相同的回答，这不是判断过的证据（未判定 ≠ 通过）`
}
