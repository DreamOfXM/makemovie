import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PrismaClient } from '@studio/db'
import { resolveSlotCandidates } from '@studio/db'
import { extractMultiPointFrames, extensionFor, toDataUrl } from '@studio/media'
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

    const verdict = parseVerdict(result.text ?? '', frames.map(frame => frame.timestampSeconds))
    // 原文尾巴跟进错误：qwen3 系默认思考模式，下次再解析失败就能直接看到它回了什么
    // （2026-09-28 场景图任务即死在这里，response 里一个字都没留下）。
    if (!verdict) return unjudged(`${candidate.provider}/${candidate.model} returned no parseable verdict: ${(result.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}`)

    // US-032 evidence rides along only when there is any; the decision below
    // stays a function of score and threshold exactly as before.
    const evidence = {
      ...(verdict.frameScores !== undefined && verdict.frameScores.length > 0 ? { frameScores: verdict.frameScores } : {}),
      ...(verdict.findings !== undefined && verdict.findings.length > 0 ? { findings: verdict.findings } : {}),
    }
    if (verdict.score >= QC_THRESHOLD) return { kind: 'visual-audit', decision: 'pass', score: verdict.score, ...evidence }
    return {
      kind: 'visual-audit',
      decision: 'rework',
      score: verdict.score,
      reasons: verdict.reasons.length > 0 ? verdict.reasons : [`score ${verdict.score} below threshold ${QC_THRESHOLD}`],
      ...evidence,
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
  const reply = sampled ? MULTI_POINT_REPLY : LEGACY_REPLY
  const floor = `A score of ${QC_THRESHOLD} or above means the artifact is usable.`
  // SD-098: the script only speaks about the clip it wrote, so the allowed-changes list is
  // only meaningful next to sampled frames. A still-image audit keeps its byte-identical prompt.
  const intent = sampled ? shotIntentBlock(subject.shotIntent) : []
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
export function parseVerdict(text: string, frameTimestamps: readonly number[] = []): AuditVerdict | null {
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
    return verdict
  }
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
