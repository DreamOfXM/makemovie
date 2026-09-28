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
    // 原文尾巴跟进错误：qwen3 系默认思考模式，下次再解析失败就能直接看到它回了什么
    // （2026-09-28 场景图任务即死在这里，response 里一个字都没留下）。
    if (!verdict) return unjudged(`${candidate.provider}/${candidate.model} returned no parseable verdict: ${(result.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}`)

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
  // 带首帧参考的审核(图生视频)与无条件审核(纯文生)的基准不同:
  // 前者的画面基准是首帧本身——指令里文学化的中途状态描述不构成核对项;
  // 后者没有画面基准,才需要拿指令全文做硬属性核对。
  const header = [
    'You are auditing one artifact produced by an automated film & video production pipeline.',
    `Stage: ${subject.stage}`,
    `Generation prompt: ${subject.prompt || '(none recorded)'}`,
    plan === 'frame'
      ? 'The image is a single frame taken from the middle of the generated clip. You cannot judge motion, continuity between shots, or audio.'
      : 'The image is the generated artifact itself.',
    '',
  ]
  if (subject.referenceDataUrl) {
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
      'Reply with JSON only and no surrounding prose: {"score": <number between 0 and 1>, "reasons": ["<short reason>", ...]}',
      `A score of ${QC_THRESHOLD} or above means the artifact is usable.`,
    ].join('\n')
  }
  return [
    ...header,
    '硬属性核对(最高优先级):先从生成指令中提取每个出场主体的硬属性——性别、年龄段(如"十六岁少女"不是男孩)、大致人数、关键道具,再逐项与画面比对。',
    '生成指令中"图N＝角色定妆照｜..."的对应关系同样必须成立:画面人物必须与指令声称的定妆照主体一致。',
    '任何一项硬属性不符(性别画错、年龄明显偏差、多了或少了人物、关键道具缺失或张冠李戴)都直接判不合格,在 reasons 里写明是哪一项不符,即使画面本身很干净。',
    '',
    '在此之上再判断通用缺陷:是否呈现了生成指令描述的场景,有无明显瑕疵(模糊、肢体扭曲、乱码文字、主体缺失或重复、压缩噪点)。',
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
    return { score, reasons }
  }
  return null
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
