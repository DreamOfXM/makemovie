export type Stage = 'source_audit' | 'script' | 'asset' | 'storyboard' | 'first_frame' | 'video' | 'audio' | 'composition' | 'delivery'
export const workflowStatuses = ['draft', 'ready', 'running', 'needs_review', 'approved', 'blocked', 'completed', 'cancelled'] as const
export type WorkflowStatus = typeof workflowStatuses[number]
export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return (workflowStatuses as readonly string[]).includes(value as string)
}
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled'

export const modelModalities = ['text', 'image', 't2v', 'i2v', 'r2v', 'tts', 'music', 'sfx', 'vlm', 'asr'] as const
export type ModelModality = typeof modelModalities[number]

export function isModelModality(value: unknown): value is ModelModality {
  return (modelModalities as readonly string[]).includes(value as string)
}

/**
 * Which input-capability switches a hand-entered model row may declare. Reference
 * images are not a video-only dialect — the qwen-image editing models draw the approved
 * character sheet — so an `image` row must be able to declare them: a form narrower
 * than this strands rows whose shots then hit the pipeline's missing-reference guard.
 * A first frame stays video conditioning, so only an i2v row is offered one.
 */
export function modalityInputs(modality: string): { takesInput: boolean; firstFrame: boolean } {
  const video = modality === 'i2v' || modality === 'r2v'
  return { takesInput: video || modality === 'image', firstFrame: modality === 'i2v' }
}

/**
 * Language of the *content* the pipeline writes — script, storyboard, prompts.
 * Independent of the console's own UI locale.
 */
export const contentLocales = ['zh', 'en'] as const
export type ContentLocale = typeof contentLocales[number]

/**
 * The three shapes a project can take. One axis: series and short drama run the
 * same pipeline and differ only in per-episode target duration; film is a
 * one-episode project. The pipeline reads Episode.targetDurationMs (seeded from
 * these defaults), never the format itself.
 */
export const projectFormats = ['short_drama', 'series', 'film'] as const
export type ProjectFormat = typeof projectFormats[number]

export function isProjectFormat(value: unknown): value is ProjectFormat {
  return (projectFormats as readonly string[]).includes(value as string)
}

export const formatDefaults: Record<ProjectFormat, { targetDurationMs: number; maxEpisodes: number | null }> = {
  short_drama: { targetDurationMs: 8 * 60_000, maxEpisodes: null },
  series: { targetDurationMs: 45 * 60_000, maxEpisodes: null },
  film: { targetDurationMs: 120 * 60_000, maxEpisodes: 1 },
}

/**
 * Defaults are only seeds: real dramas run 1-3 minute episodes and films are not
 * necessarily 120 minutes, so each format carries a sane range the user can
 * fine-tune inside. Validation clamps here; the pipeline stays duration-agnostic.
 */
export const formatDurationRange: Record<ProjectFormat, { minMs: number; maxMs: number }> = {
  short_drama: { minMs: 30_000, maxMs: 30 * 60_000 },
  series: { minMs: 5 * 60_000, maxMs: 120 * 60_000 },
  film: { minMs: 10 * 60_000, maxMs: 300 * 60_000 },
}

export function durationOutOfRange(format: ProjectFormat, targetDurationMs: number): boolean {
  const range = formatDurationRange[format]
  return !Number.isInteger(targetDurationMs) || targetDurationMs < range.minMs || targetDurationMs > range.maxMs
}

/**
 * 制作档位：自动推进时停在哪里等人。只回答一个问题——中途在哪几处停下来。
 *
 * 「跑到哪一步为止」刻意不在这里。曾经设计过第二条轴（scope: lean/full，跳过素材
 * 细化），流水线却没有任何一行读它：选了「精简」跑出来的东西和完整档一模一样。
 * 一个说了不做、也不影响账单的开关比没有开关更坏，所以撤掉了。
 */
export const automationGates = ['auto', 'beforeSpend', 'everyStage'] as const
export type AutomationGate = typeof automationGates[number]

export function isAutomationGate(value: unknown): value is AutomationGate {
  return (automationGates as readonly string[]).includes(value as string)
}

/**
 * 字段为 null 时的解释。它必须与引入档位之前的行为逐阶段一致——改造不改变任何
 * 既有项目的运行结果，新增的只是此前够不着的能力（auto 与 everyStage）。
 *
 * `auto` 不是无护栏的：素材定稿是 nextRunnableStage 里的硬闸门（素材未 APPROVED
 * 就不放行 IMAGE），交付验收也不在这条自动链上，所以「角色的脸」和「交付」这两处
 * 永远由人确认，与档位无关。
 */
export const defaultAutomationGate: AutomationGate = 'beforeSpend'

/** Whole-book uploads get their own ceiling; the 200k per-version limit stays episode-level. */
export const PROJECT_SOURCE_CHAR_LIMIT = 1_000_000

/**
 * Spoken-Chinese script pacing, the same rate the script prompt budgets with.
 * Auto-split packs chapters into episodes sized by this many characters a minute.
 */
export const SCRIPT_CHARS_PER_MINUTE = 350

export function isContentLocale(value: unknown): value is ContentLocale {
  return (contentLocales as readonly string[]).includes(value as string)
}

export const capabilitySlots = [
  'script_text',
  'storyboard_text',
  'image_gen',
  'video_t2v',
  'video_i2v',
  'video_r2v',
  'tts_voice',
  'music_gen',
  'visual_audit',
  'sfx',
  'audio_transcribe',
] as const

export type CapabilitySlot = typeof capabilitySlots[number]

export function isCapabilitySlot(value: unknown): value is CapabilitySlot {
  return (capabilitySlots as readonly string[]).includes(value as string)
}

export const slotModality: Record<CapabilitySlot, ModelModality> = {
  script_text: 'text',
  storyboard_text: 'text',
  image_gen: 'image',
  video_t2v: 't2v',
  video_i2v: 'i2v',
  video_r2v: 'r2v',
  tts_voice: 'tts',
  music_gen: 'music',
  visual_audit: 'vlm',
  sfx: 'sfx',
  audio_transcribe: 'asr',
}

/**
 * The seven stages a generation runs through, in planning order — the API/console
 * vocabulary. The DB stores first frames as FIRST_FRAME; the pipeline's
 * `stageDbValues` does that mapping, this list never spells it that way.
 */
export const generationStages = ['SCRIPT', 'ASSET', 'STORYBOARD', 'IMAGE', 'VIDEO', 'AUDIO', 'MUSIC'] as const
export type GenerationStage = (typeof generationStages)[number]

export function isGenerationStage(value: unknown): value is GenerationStage {
  return (generationStages as readonly string[]).includes(value as string)
}

export interface SlotStageUsage {
  /**
   * The stages that actually resolve this slot. An empty list means no code path
   * reads the slot, so nothing is waiting on it.
   */
  stages: readonly GenerationStage[]
  /** The slot only ever serves the worker quality gate, which is off unless `STUDIO_QC_MODE=model`. */
  qcOnly: boolean
  /** Without a usable binding the chain cannot finish, rather than finishing with less. */
  required: boolean
}

/**
 * 槽位↔阶段接线表，单一事实源：pipeline 按它为每个阶段选槽排任务（`stageSlot`），
 * 控制台按它算九个槽的就绪度与缺口。加槽、改接线只改这一张表。
 */
export const slotStageUsage: Record<CapabilitySlot, SlotStageUsage> = {
  script_text: { stages: ['SCRIPT'], qcOnly: false, required: true },
  storyboard_text: { stages: ['STORYBOARD'], qcOnly: false, required: true },
  image_gen: { stages: ['ASSET', 'IMAGE'], qcOnly: false, required: true },
  video_t2v: { stages: ['VIDEO'], qcOnly: false, required: true },
  // The optional half of VIDEO: when a model is bound here, each shot's own newest first
  // frame — the one no review sent back — conditions its clip. With nothing bound the stage
  // runs on `video_t2v` alone, exactly as it did before conditioning existed.
  video_i2v: { stages: ['VIDEO'], qcOnly: false, required: false },
  // VIDEO's identity half: a shot's bound, approved asset sheets travel to the model as
  // reference images, so a character's face follows its character board across cuts. The
  // old blocker (pipeline attributed no asset to a shot) is gone — breakdown regeneration
  // auto-binds StoryboardAsset rows and a human can route them by hand. Shots without
  // bound sheets simply never pick an r2v model; planVideoModels drops it.
  video_r2v: { stages: ['VIDEO'], qcOnly: false, required: false },
  tts_voice: { stages: ['AUDIO'], qcOnly: false, required: false },
  // The silent half of AUDIO: shots with no dialogue still owe the cut a sound bed
  // (rain, footsteps, doors). Optional like tts_voice — an installation that never
  // binds it keeps masters at voice+music, exactly as before. Artifacts land as
  // AUDIO-stage rows for silent shots only, so voice resolution for voiced shots
  // never sees them; the cut takes an sfx through the shot's ambience pin.
  sfx: { stages: ['AUDIO'], qcOnly: false, required: false },
  // US-033 ASR:独立转写能力,不进生成链(它检查已有音频,不产出新素材)。
  audio_transcribe: { stages: [], qcOnly: true, required: false },
  music_gen: { stages: ['MUSIC'], qcOnly: false, required: false },
  visual_audit: { stages: [], qcOnly: true, required: false },
}

/**
 * The one slot a stage plans its fallback chain against. Required-ness is about
 * whether a missing binding blocks the chain, not about whether the stage queries
 * the slot — so the rule is: the required slot when the stage has one (VIDEO's
 * optional i2v conditioning never claims the stage), otherwise the sole wired slot
 * (AUDIO plans against tts_voice even though audio is optional).
 */
export function stageSlot(stage: GenerationStage): CapabilitySlot {
  const wired = (Object.keys(slotStageUsage) as CapabilitySlot[]).filter(
    candidate => slotStageUsage[candidate].stages.includes(stage),
  )
  const primary = wired.find(candidate => slotStageUsage[candidate].required) ?? wired[0]
  if (!primary) throw new Error(`no slot wired for stage ${stage}`)
  return primary
}

export interface ModelCapability {
  provider: string
  model: string
  modality: ModelModality
  acceptsFirstFrame: boolean
  acceptsReferenceImages: boolean
  maxReferenceImages: number
  entitlementVerifiedAt?: Date | null
}

export interface BindCheck {
  ok: boolean
  reason?: string
}

export function canBind(slot: CapabilitySlot, capability: ModelCapability): BindCheck {
  const required = slotModality[slot]
  if (capability.modality !== required) {
    return { ok: false, reason: `slot "${slot}" requires modality "${required}", model "${capability.model}" is "${capability.modality}"` }
  }
  if (slot === 'video_i2v' && !capability.acceptsFirstFrame) {
    return { ok: false, reason: `slot "video_i2v" requires a model that accepts a first frame` }
  }
  if (slot === 'video_r2v' && !capability.acceptsReferenceImages) {
    return { ok: false, reason: `slot "video_r2v" requires a model that accepts reference images` }
  }
  return { ok: true }
}

/**
 * What the usability rule reads off a binding. Deliberately structural: the Prisma
 * row in `resolveSlotCandidates` (slot lower-cased first — the enum is uppercase)
 * and the console's Binding DTO both satisfy it without mapping, so the rule
 * cannot drift between server and client.
 */
export interface SlotResolvableBinding {
  /** Lowercase domain vocabulary ('video_t2v'), not the uppercase DB enum. */
  slot: string
  enabled: boolean
  capability?: {
    entitlementVerifiedAt?: Date | string | null
    credentialVerifiedAt?: Date | string | null
    connection?: { enabled: boolean } | null
  } | null
}

/**
 * A binding serves a slot's fallback chain only while it is enabled, its capability
 * was verified against the vendor (entitlement, or at least the key), and its
 * connection is still enabled. The one rule `resolveSlotCandidates` filters by and
 * the console's readiness panel counts by.
 */
export function servesSlot(binding: SlotResolvableBinding, slot: CapabilitySlot): boolean {
  if (binding.slot !== slot || !binding.enabled) return false
  const capability = binding.capability
  if (!capability) return false
  if (!capability.entitlementVerifiedAt && !capability.credentialVerifiedAt) return false
  return !!capability.connection?.enabled
}

export type FallbackScope = 'project' | 'organization'

export interface SlotFallbackOrder {
  scope: FallbackScope
  priority: number
}

/**
 * 候选链排序规则，单一事实源：项目作用域无条件压过组织作用域，同作用域内
 * priority 降序。`resolveSlotCandidates` 排服务端链、模型中心的「槽位:全部」
 * 总览排客户端链，都用这一个比较器——改规则只改这里。
 */
export function compareSlotFallbacks<T extends SlotFallbackOrder>(a: T, b: T): number {
  if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1
  return b.priority - a.priority
}

/**
 * The minimum a video-plan decision reads.
 *
 * Modality stays a plain string rather than `ModelModality` because a candidate resolved
 * from a binding reads it out of a string column — claiming otherwise here would let the
 * type say something the database does not enforce. Entitlement is deliberately absent:
 * `resolveSlotCandidates` already dropped unverified capabilities, and re-checking a field
 * the caller was never told to supply would silently return an empty plan.
 */
export interface VideoModelCandidate {
  model: string
  modality: string
}

export interface GenerationPlan<T extends VideoModelCandidate = VideoModelCandidate> {
  hasReferenceInput: boolean
  candidates: T[]
}

/**
 * Which models may run a shot, in fallback order.
 *
 * A shot with no frame cannot be served by a model that requires one: it would reach the
 * vendor, be refused, and cost the attempt. A shot with a frame prefers the models that can
 * use it and keeps text-to-video behind them, so a conditioning model that is down still
 * yields a picture — a lesser one, but the shot is not lost over a quality gain.
 */
export function planVideoModels<T extends VideoModelCandidate>(candidates: T[], hasReferenceInput: boolean, hasAssetReferences = false): GenerationPlan<T> {
  // i2v 花的是这一镜的首帧，r2v 花的是绑定素材的定妆照：缺各自输入的模态不进计划
  // ——到供应商那儿也是被拒，白烧一次尝试。两个输入都在时 r2v 排前：多张定妆照锁
  // 的主体一致性比单帧构图更强（可灵主体库/O1 同路），t2v 永远垫底兜底。
  const conditioningRank = (candidate: T): number =>
    candidate.modality === 'r2v' && hasAssetReferences ? 2 : candidate.modality === 'i2v' && hasReferenceInput ? 1 : 0
  const allowed = (candidate: T): boolean => {
    if (candidate.modality === 'i2v') return hasReferenceInput
    if (candidate.modality === 'r2v') return hasAssetReferences
    return true
  }
  const ordered = [...candidates].sort((a, b) => conditioningRank(b) - conditioningRank(a))
  const seen = new Set<string>()
  const picked = ordered.filter(candidate => {
    if (!allowed(candidate) || seen.has(candidate.model)) return false
    seen.add(candidate.model)
    return true
  })
  return { hasReferenceInput, candidates: picked }
}

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  const transitions: Record<WorkflowStatus, WorkflowStatus[]> = {
    draft: ['ready', 'cancelled'],
    ready: ['running', 'cancelled'],
    running: ['needs_review', 'blocked', 'completed', 'cancelled'],
    needs_review: ['approved', 'blocked', 'cancelled'],
    approved: ['running', 'completed', 'cancelled'],
    blocked: ['ready', 'cancelled'],
    completed: [],
    cancelled: [],
  }
  return transitions[from].includes(to)
}

export const roles = ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'VIEWER'] as const
export type Role = typeof roles[number]

const roleRank: Record<Role, number> = { OWNER: 50, ADMIN: 40, EDITOR: 30, REVIEWER: 20, VIEWER: 10 }

export const actions = [
  'read',
  'review:decide',
  'project:create',
  'project:update',
  'project:delete',
  'episode:write',
  'storyboard:write',
  'generation:trigger',
  'org:update',
  'members:manage',
  'providers:manage',
  'bindings:manage',
  'audit:read',
] as const
export type Action = typeof actions[number]

const actionMinRole: Record<Action, Role> = {
  read: 'VIEWER',
  'review:decide': 'REVIEWER',
  'project:create': 'EDITOR',
  'project:update': 'EDITOR',
  'project:delete': 'ADMIN',
  'episode:write': 'EDITOR',
  'storyboard:write': 'EDITOR',
  'generation:trigger': 'EDITOR',
  'org:update': 'ADMIN',
  'members:manage': 'ADMIN',
  'providers:manage': 'ADMIN',
  'bindings:manage': 'ADMIN',
  'audit:read': 'ADMIN',
}

export function can(role: Role, action: Action): boolean {
  return roleRank[role] >= roleRank[actionMinRole[action]]
}

/** Lowest role that may perform `action` — lets clients explain a denial. */
export function minRoleFor(action: Action): Role {
  return actionMinRole[action]
}

export function isRole(value: string): value is Role {
  return (roles as readonly string[]).includes(value)
}

/**
 * 一次生成失败的「因」。分类决定界面怎么说、以及重抽有没有意义：
 * 视觉审计没过线该重抽，额度用尽抽一百次也不会变——两者都写成「没过线」，
 * 用户就会去改提示词，而真原因在账单上（2026-09-26 全站验收 B1）。
 */
export const failureKinds = ['moderation', 'quota', 'access', 'param', 'network', 'audit', 'unknown'] as const
export type FailureKind = (typeof failureKinds)[number]

/** 模式只收本机库里真出现过的报文（dashscope 错误码 + worker 自写文案），扩族要带样本。 */
const FAILURE_PATTERNS: readonly [FailureKind, RegExp][] = [
  ['audit', /threshold not met|visual-audit:/i],
  ['moderation', /DataInspectionFailed|Green net check rejected|inappropriate content/i],
  ['quota', /AllocationQuota|FreeTierOnly|free quota exhausted|insufficient balance|arrearage|insufficient_user_quota|预扣费额度失败/i],
  ['access', /AccessDenied|NoPermission|Forbidden|Unauthorized|InvalidApiKey/i],
  ['param', /InvalidParameter|BadRequest|url error/i],
  ['network', /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i],
]

/**
 * `errorSnapshot` 是文本列：任务级是一条 JSON 数组（候选链逐个错因），
 * 审计级是 `visual-audit: threshold not met …` 裸句。两种都吃。
 */
export function classifyFailure(raw: string | null | undefined): FailureKind {
  if (!raw) return 'unknown'
  let text = raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) text = parsed.map(String).join(' | ')
  } catch {
    // 裸句，按原样分类
  }
  return FAILURE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'unknown'
}

/** 充值、开通权限或改参数之前，再抽一次也不会改变的因。 */
export function isTerminalFailure(kind: FailureKind): boolean {
  return kind === 'quota' || kind === 'access' || kind === 'param'
}

/**
 * 合成整集停在「已阻塞」时的因（SD-177）。worker 抛的是英文诊断句，里面是
 * storyboard/artifact 的裸 id——直接上屏就是内部文本泄漏，全说「合成失败」又等于
 * 没说。这里把已知的每一句收成一个稳定码，界面按码给人话，原文留给排查。
 * 扩族必须带 worker 侧的真实抛句，认不出的进 composeBlock.unknown，不许原样上屏。
 */
export const composeBlockKinds = [
  'missing_video',
  'selection_stale',
  'snapshot_drift',
  'seam_unconditioned',
  'edit_clip_unknown',
  'edit_source_missing',
  'clip_not_editable',
  'trim_failed',
  'wrong_episode',
  'unknown',
] as const
export type ComposeBlockKind = (typeof composeBlockKinds)[number]

const COMPOSE_BLOCK_PATTERNS: readonly [ComposeBlockKind, RegExp][] = [
  ['seam_unconditioned', /is not conditioned on take .*end frame/i],
  ['snapshot_drift', /no longer matches the master's own segments|not a spliced master/i],
  ['selection_stale', /locked video selection|lockedVideoSelection but no selectedVideoArtifactId|frozen video artifact .* no longer resolves/i],
  ['edit_clip_unknown', /references artifact .* that is not a video of this shot|anchors a hidden or unknown clip/i],
  ['edit_source_missing', /source artifact .* not found/i],
  ['clip_not_editable', /raw source is not editable media/i],
  ['trim_failed', /failed to (conform clip|trim clip)/i],
  ['wrong_episode', /does not belong to episode/i],
  ['missing_video', /has no succeeded video artifact/i],
]

export function classifyComposeBlock(raw: string | null | undefined): ComposeBlockKind {
  if (!raw) return 'unknown'
  return COMPOSE_BLOCK_PATTERNS.find(([, pattern]) => pattern.test(raw))?.[0] ?? 'unknown'
}

/** 一个（provider, model）迄今的真实调用履历。 */
export interface CallEvidence {
  ok: number
  failed: number
  lastStatus: 'SUCCEEDED' | 'FAILED'
  lastAt: Date
  lastKind: FailureKind
}

/** `GenerationTask` 里够算履历的那几列；探测时间戳证明不了这个。 */
export interface CallEvidenceRow {
  provider: string | null
  model: string | null
  status: string
  errorSnapshot: string | null
  updatedAt: Date
}

export function callEvidenceKey(provider: string | null | undefined, model: string): string {
  return `${provider ?? '?'}|${model.trim()}`
}

/**
 * 每个（provider, model）最近一次真调用是什么结果。失败任务把整条候选链写进 model
 * （"a → b"），链上每个模型都真的试过并失败了，所以拆开逐个记账。
 */
export function reduceCallEvidence(rows: Iterable<CallEvidenceRow>): Map<string, CallEvidence> {
  const byModel = new Map<string, CallEvidence>()
  for (const row of rows) {
    if (!row.model) continue
    for (const name of row.model.split(' → ')) {
      const key = callEvidenceKey(row.provider, name)
      const entry: CallEvidence = byModel.get(key) ?? {
        ok: 0,
        failed: 0,
        lastStatus: 'FAILED',
        lastAt: new Date(0),
        lastKind: 'unknown',
      }
      if (row.status === 'SUCCEEDED') entry.ok += 1
      else {
        entry.failed += 1
        entry.lastKind = classifyFailure(row.errorSnapshot)
      }
      if (row.updatedAt >= entry.lastAt) {
        entry.lastAt = row.updatedAt
        entry.lastStatus = row.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED'
      }
      byModel.set(key, entry)
    }
  }
  return byModel
}

/**
 * 分镜表「转场」列的词表。落库值（Storyboard.transition）、写入校验
 * （pipeline 的 normalizeTransition）、合成侧那一刀的形状（media 的 cutKindOf）
 * 与界面选择器都读这一份——本处是事实源，另几处只是别名；改名要一起改。
 * 界面若自己另抄六个词，就会出现「叠化」在格子里、硬切在母带上的假值。
 */
export const shotTransitions = ['cut', 'dissolve', 'fade_in', 'fade_out', 'black', 'flash'] as const
export type ShotTransition = (typeof shotTransitions)[number]

/** 每档的缺省毫秒：人只换档没填数时，母带上那一刀吃这个值。硬切没有重叠，恒 0。 */
export const shotTransitionDefaultMs: Record<ShotTransition, number> = {
  cut: 0,
  dissolve: 400,
  fade_in: 400,
  fade_out: 400,
  black: 500,
  flash: 60,
}

/**
 * 一镜的人声来源档。与 DB 的 AudioSource 枚举、web 的 ShotAudioSource 同名同集
 * ——本处是事实源，另两处只是别名；改名要一起改。
 */
export type AudioSource = 'VOICE' | 'NATIVE' | 'VOICE_NATIVE' | 'IMPORTED'

/** 混音层与界面词根共用的小写档名。 */
export type RecordedAudioMode = 'voice' | 'native' | 'voice_native' | 'imported'

/** 镜型默认：有台词只用配音，无台词只用原声。规则只有这一份。 */
export function defaultAudioSource(dialogue: string): AudioSource {
  return dialogue !== '' ? 'VOICE' : 'NATIVE'
}

/** 这一镜「生效」的声音来源档：人钦定过就是那一档，否则按镜型默认。 */
export function audioSourceInEffect(dialogue: string, audioSource: AudioSource | null | undefined): AudioSource {
  return audioSource ?? defaultAudioSource(dialogue)
}

/**
 * 母带里这一镜的声音是怎么来的——生效档的小写形态。compose 写 manifest、
 * pipeline 判母带是否过时、界面读档亮格，都用这一口径。
 */
export function recordedAudioMode(dialogue: string, audioSource: AudioSource | null | undefined): RecordedAudioMode {
  return audioSourceInEffect(dialogue, audioSource).toLowerCase() as RecordedAudioMode
}

/**
 * 这一镜是否还欠一条 TTS 人声：没人钦定、或钦定的是含配音的档位才算欠。
 * 「只用原声」的镜头本来就不出人声，「导入音频」由导入门单独验。
 */
export function needsTtsVoice(dialogue: string, audioSource: AudioSource | null | undefined): boolean {
  if (dialogue === '') return false
  return audioSource == null || audioSource === 'VOICE' || audioSource === 'VOICE_NATIVE'
}

/**
 * 这一镜的人声只能来自导入件：要么明选了「导入音频」，要么档里含配音却没有台词
 * ——无台词镜不排 TTS，它的「配音」只有导入这一条路。
 */
export function needsImportedVoice(dialogue: string, audioSource: AudioSource | null | undefined): boolean {
  if (audioSource === 'IMPORTED') return true
  return dialogue === '' && (audioSource === 'VOICE' || audioSource === 'VOICE_NATIVE')
}

/** 母带要不要等一条人声轨：除「只用原声」外都等（含钦定导入）。 */
export function masterNeedsVoice(dialogue: string, audioSource: AudioSource | null | undefined): boolean {
  return audioSource == null ? dialogue !== '' : audioSource !== 'NATIVE'
}

/**
 * 剧本「声音」列里表示「这一镜不垫氛围底」的写法。分镜 prompt 明确允许作者写「无」
 * （packages/pipeline prompts.ts 的节奏契约与转录规则），英文项目按输出语言指令会写
 * none；「—」是同一张分镜表既有的「这列没填」记号。库里存作者原话，消费侧统一按这一份
 * 判「作者说不要」——否则「声床：无（跨接缝不停）」这种自相矛盾的话会进付费请求。
 */
const SOUND_BED_NONE = ['无', 'none', 'no', 'n/a', '-', '—']

/** 分镜「声音」列的原文 → 这一镜真正欠的声床；没写或写「不要」都是 null。 */
export function normalizeSoundBed(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return null
  return SOUND_BED_NONE.includes(trimmed.toLowerCase()) ? null : trimmed
}

/**
 * 非角色声源。分镜表的「台词/VO」列里，VO 是画外音标记而不是说话人的名字：
 * 配音解析不能拿它去匹配角色素材，界面也不能把它裸显示成一个名字。
 * 系统音 / 创作者同样是来源标记，三者与角色名共用 speaker 一列。
 */
export const VOICE_OVER_SPEAKER = 'VO'
export const SYSTEM_SPEAKER = '系统音'
export const CREATOR_SPEAKER = '创作者'

const SPEAKER_ALIASES: Record<string, string> = {
  vo: VOICE_OVER_SPEAKER,
  'v.o.': VOICE_OVER_SPEAKER,
  'v.o': VOICE_OVER_SPEAKER,
  'voice-over': VOICE_OVER_SPEAKER,
  voiceover: VOICE_OVER_SPEAKER,
  画外音: VOICE_OVER_SPEAKER,
  旁白: VOICE_OVER_SPEAKER,
  内心独白: VOICE_OVER_SPEAKER,
  系统: SYSTEM_SPEAKER,
}

/**
 * speaker 的唯一规范化入口：写库（API/worker）、读界面、配音解析都过这里。
 * 只做来源别名归并与尾部冒号剥离，不猜测剧本里没写的角色名。
 */
export function normalizeSpeaker(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/[：:]+$/, '')
  if (!trimmed) return null
  return SPEAKER_ALIASES[trimmed.toLowerCase()] ?? trimmed
}

export function isVoiceOverSpeaker(value: string | null | undefined): boolean {
  return normalizeSpeaker(value) === VOICE_OVER_SPEAKER
}


// Readiness rules (slot states, catalog coverage, auto-bind planning). readiness.ts
// imports this file back for `slotStageUsage` and the bind rules, so this is a cycle —
// and it stays safe only because readiness.ts touches those bindings inside functions.
// ESM evaluates a module's dependencies before its own body, so a module-scope read in
// readiness.ts would see them uninitialised no matter where this line sits.
export * from './readiness.js'

export * from './contracts.js'

export * from './duration.js'

export * from './artifact-veto.js'
