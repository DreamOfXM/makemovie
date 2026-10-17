/**
 * US-002 冻结的共享契约:编辑时间基准、对象级 CAS、采用策略与错误封套。
 * 来源:实施交接包主方案 §10.2(时间与数据规则)、§12(状态与并发)、§14(API 与错误)。
 *
 * 本模块只放「跨 web/api/worker 三方必须一字不差」的东西:类型、常量与纯函数。
 * 不放 IO、不放 Prisma 查询——那些属于各应用的实现层;这里冻结的是实现必须服从的数学。
 */

// ── §10.2 时间与数据规则 ─────────────────────────────────────────────────────

/** 序列帧率是有理数(整数/整数)。初始开放 24/25/30;29.97 之类必须先经 editMedia 归一。 */
export interface RationalFps {
  fpsNum: number
  fpsDen: number
}

export const SEQUENCE_FPS_ALLOWED: readonly RationalFps[] = [
  { fpsNum: 24, fpsDen: 1 },
  { fpsNum: 25, fpsDen: 1 },
  { fpsNum: 30, fpsDen: 1 },
]

export function sameFps(a: RationalFps, b: RationalFps): boolean {
  return a.fpsNum === b.fpsNum && a.fpsDen === b.fpsDen
}

export function isValidSequenceFps(fps: RationalFps): boolean {
  return SEQUENCE_FPS_ALLOWED.some(allowed => sameFps(allowed, fps))
}

/**
 * 输入以秒表达时:入点向下取整、出点向上取整到序列帧(§10.2)。
 * 编辑器必须把量化后的帧显示给用户——存储、渲染与导出不再各自舍入。
 */
export function quantizeInFrame(seconds: number, fps: RationalFps): number {
  return Math.floor((seconds * fps.fpsNum) / fps.fpsDen)
}

export function quantizeOutFrame(seconds: number, fps: RationalFps): number {
  return Math.ceil((seconds * fps.fpsNum) / fps.fpsDen)
}

/** 帧索引 → 秒:range 时间为 frame * fpsDen/fpsNum。 */
export function frameToSeconds(frame: number, fps: RationalFps): number {
  return (frame * fps.fpsDen) / fps.fpsNum
}

/**
 * 剪辑范围。sourceInFrame 含起点、sourceOutFrame 不含终点;二者都是 editMedia 的
 * 帧索引(时基=序列帧率,不是原视频帧号),禁止空片段、负范围、超出实测帧数。
 */
export interface ClipRange {
  sourceInFrame: number
  sourceOutFrame: number
}

export type ClipRangeError = 'non_integer' | 'negative' | 'empty' | 'beyond_media'

export function validateClipRange(range: ClipRange, editMediaFrameCount: number): ClipRangeError | null {
  if (!Number.isInteger(range.sourceInFrame) || !Number.isInteger(range.sourceOutFrame)) return 'non_integer'
  if (range.sourceInFrame < 0 || range.sourceOutFrame < 0) return 'negative'
  if (range.sourceOutFrame <= range.sourceInFrame) return 'empty'
  if (range.sourceOutFrame > editMediaFrameCount) return 'beyond_media'
  return null
}

export function clipFrameCount(range: ClipRange): number {
  return range.sourceOutFrame - range.sourceInFrame
}

/**
 * record 起点按顺序整帧累计(§10.2):不另存矛盾的排序事实。返回每镜片段在序列上
 * 的起始帧;序列总长 = 最后一项起点 + 其帧数(或 0)。
 */
export function recordStartFrames(ranges: readonly ClipRange[]): number[] {
  const starts: number[] = []
  let cursor = 0
  for (const range of ranges) {
    starts.push(cursor)
    cursor += clipFrameCount(range)
  }
  return starts
}

export function sequenceFrameCount(ranges: readonly ClipRange[]): number {
  return ranges.reduce((sum, range) => sum + clipFrameCount(range), 0)
}

// ── §13 编辑文档的冻结形状(存储为 JSON schema 文档,此处为 TS 侧契约) ───────

/**
 * editMedia:进入精确剪辑的规范化介质身份。缓存身份 = 原素材 checksum + 序列帧率
 * + conformPolicyVersion;probe 出的 frameCount 是唯一可信的帧数来源。
 */
export interface EditMediaRef {
  originalArtifactId: string
  normalizedArtifactId: string
  conformPolicyVersion: number
  fps: RationalFps
  frameCount: number
}

/** clipId 是稳定身份,storyboardId 只是来源;重复使用同一镜头素材 = 新 clipId。 */
export interface ClipDoc {
  clipId: string
  storyboardId: string
  artifactId: string
  editMediaId: string
  range: ClipRange
}

/**
 * 声音/字幕元素锚定(§10.2a):clip_linked 元素随片段调序移动、随隐藏静默;
 * sequence 元素钉在序列时间上。offsetFrame 对 clip 锚 = 相对片段 record 起点。
 */
export interface TrackElementDoc {
  elementId: string
  sourceArtifactId: string
  anchor: 'clip' | 'sequence'
  /** anchor=clip 时必填:跟随哪个片段。 */
  clipId?: string
  /** 源媒体上的显式范围(帧,源时基);无则整条。 */
  sourceInFrame?: number
  sourceOutFrame?: number
  offsetFrame: number
  /** 线性增益 0–2(0 静音,1 原样);不存 dB,展示层换算。 */
  gain: number
  muted: boolean
  locked: boolean
}

/** 编辑修订:不可变 JSON 文档,唯一 (editId, revision);fingerprint 字段稳定序列化。 */
export interface EpisodeEditRevisionDoc {
  editId: string
  revision: number
  fps: RationalFps
  outputSpec: Record<string, unknown>
  clips: ClipDoc[]
  tracks: TrackElementDoc[]
  fingerprint: string
  author: string
}

// ── §12.4 对象级 CAS ─────────────────────────────────────────────────────────

/**
 * expectedRevision 是资源版本字段的别名,不是「一个含义不明的数字」。计划与跨镜
 * 操作携带命名明确的 revision 向量(见 RevisionVector);接口签名一律用这两个类型。
 */
export type RevisionKind = 'shot-state' | 'episode-production' | 'edit-head'

export interface ExpectedRevision {
  kind: RevisionKind
  value: number
}

export interface RevisionVector {
  episodeProductionRevision: number
  shotStateRevisions: Readonly<Record<string, number>>
  referenceChecksums?: Readonly<Record<string, string>>
}

// ── §9 采用策略(FR-E02/E03) ─────────────────────────────────────────────────

/**
 * 生成/操作结果默认进入候选,不覆盖当前采用版。apply_if_empty 仅当目标从未有可用
 * 结果;apply_if_unchanged 仅当用户选择未变。回调采用必须校验计划里的 revision、
 * 当前选择和锁——并发变更时只保留候选(applyStatus=skipped)。
 */
export type ApplyPolicy = 'candidate_only' | 'apply_if_empty' | 'apply_if_unchanged'

export type ApplyStatus = 'applied' | 'skipped' | 'pending'

export interface ApplyOutcome {
  status: ApplyStatus
  /** skipped/pending 的原因,进审计;没有原因的 skipped 不许存在。 */
  reason?: string
}

// ── §14 错误封套与稳定错误码 ─────────────────────────────────────────────────

/** 付费调用风险四档。unknown 不填 none——那是对用户说谎。 */
export type BillingRisk = 'none' | 'possible' | 'confirmed' | 'unknown'

export interface ApiErrorBody {
  /** 稳定机器码,见 apiErrorCodes;前端按 code 分支,不 parse message。 */
  code: string
  message: string
  /** 受影响的资源/范围(镜头号、编辑修订号等),供界面定位。 */
  scope?: string[]
  nextAction?: string
  retryable: boolean
  billingRisk: BillingRisk
}

export const apiErrorCodes = {
  invalidArgument: 'invalid_argument',
  unauthenticated: 'unauthenticated',
  forbidden: 'forbidden',
  notFound: 'not_found',
  /** 409 家族按对象分家,前端才能给出正确的「重载/比较」动作。 */
  versionConflict: 'version_conflict',
  stateConflict: 'state_conflict',
  capabilityConflict: 'capability_conflict',
  /** §12.3:提交后失联,不得当普通失败自动重复计费。 */
  submissionUnknown: 'submission_unknown',
} as const

export type ApiErrorCode = (typeof apiErrorCodes)[keyof typeof apiErrorCodes]
