import { DEFAULT_SHOT_RHYTHM, evaluateShotRhythm, rhythmFromSpans, type ShotRhythmGate, type ShotRhythmReadings, type ShotRhythmSettings } from './content-audit.js'

/**
 * 验收三读数（S5）：节奏 / 转场 / 声音。
 *
 * 这一层只回答一个问题——**母带的台账里到底有没有这几个数**，不回答「好不好看」。
 * 判「三项齐全才能签字、缺一项只出草稿」的是前者；后者归项目设置里的节奏门槛，
 * 它摆数不拦人（与 S1 同口径：碎不等于错）。为什么把「有没有」设成硬门：本集 51 颗
 * ≤3 秒的镜头一路绿灯到母带，就是因为审片时连「每一刀是什么」「哪颗镜子里没有人声」
 * 都读不出来，没有读数就没有否决的凭据。
 *
 * 全部输入是合成的两份台账：`Composition.durationMs`（ffprobe 实测母带）与
 * `Composition.manifest`（排队定格的 `resolved.shots` + 渲染侧回写的 `cuts`/`audio`/`beds`）。
 * 老合成缺哪一份就报哪一项缺，绝不拿标称值替实测值补一个假数。
 */

/** 读不出数的具体缺项：稳定码，界面按码出文案，原始报文永不上屏。 */
export type ReviewGap = 'masterDuration' | 'shotSpans' | 'cutTable' | 'audioLedger' | 'silentDialogue'

export interface RhythmReading {
  /** 三项齐全才允许验收；present = 这一轴读得出数。 */
  present: boolean
  gaps: ReviewGap[]
  /** 母带实测片长；null = 台账里从来没探到过（旧合成，或探针没跑）。 */
  masterDurationMs: number | null
  /** 按母带里的逐镜跨度算出的节奏读数；读不出就是 null。 */
  readings: ShotRhythmReadings | null
  /** 与项目节奏设置的对照，只摆数不拦验收。readings 为 null 时它是「没量到」，界面不许当「达标」渲染。 */
  gate: ShotRhythmGate
  settings: ShotRhythmSettings
}

export interface TransitionReading {
  present: boolean
  gaps: ReviewGap[]
  /** 每一刀最终落成的形状（母带台账；index 0 恒为 cut，片头走 headFadeMs）。 */
  kinds: string[]
  /** 母带里真的发生了重叠或淡入淡出的刀数（含片头/集尾淡）。 */
  blendedSeamCount: number
  /** 分镜表点了非硬切的镜数；null = 这次快照没带转场列，判不了。与上面那个数不等就是有话没落地。 */
  requestedNonCutCount: number | null
  /** 母带走的是混合拼接还是那条逐字节不变的 stream-copy 老路。 */
  blended: boolean
  headFadeMs: number
  tailFadeMs: number
  fps: number | null
  shotCount: number
}

export interface SoundReading {
  present: boolean
  gaps: ReviewGap[]
  /** 台账里有台词的镜数。 */
  dialogueShotCount: number
  /** 有台词却在母带里听不到人声的镜（按母带顺序 1 起）——SD-181 的那一类。 */
  silentDialogueShots: number[]
  /** 声床条数（导入底 + 原声底），只报不拦：环境音没有生成通道（SD-185）。 */
  bedCount: number
  importedBedCount: number
  hasMusic: boolean
}

export interface CompositionReviewReadings {
  rhythm: RhythmReading
  transition: TransitionReading
  sound: SoundReading
  /** 三项齐全 = 可以点验收；缺任何一项，交付只停在草稿。 */
  complete: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function parseManifest(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    return asRecord(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

/** 整表校验：任一元素不是有限非负数就整份算读不出，不做「取到几个算几个」的半真读数。 */
function numberArray(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null
  return value.every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0) ? (value as number[]) : null
}

function stringArray(value: unknown, length: number): string[] | null {
  if (!Array.isArray(value) || value.length !== length) return null
  return value.every(item => typeof item === 'string') ? (value as string[]) : null
}

export interface ReviewReadingInput {
  /** `Composition.manifest` 原文。 */
  manifest: string | null | undefined
  /** `Composition.durationMs`：母带实测时长，null = 从未探测。 */
  masterDurationMs: number | null
  /** 本次合成链接到的配乐（`Composition.scoreArtifactId`）。 */
  hasMusic?: boolean
  /** 项目节奏设置（`Project.shotRhythm` 解析后）；只用于摆数对照。 */
  rhythmSettings?: ShotRhythmSettings
}

export function readCompositionReview(input: ReviewReadingInput): CompositionReviewReadings {
  const settings = input.rhythmSettings ?? DEFAULT_SHOT_RHYTHM
  const manifest = parseManifest(input.manifest)
  const cuts = asRecord(manifest?.cuts)
  const storyboardIds = Array.isArray(cuts?.storyboardIds) ? cuts!.storyboardIds.filter((id): id is string => typeof id === 'string') : []
  const shotCount = storyboardIds.length
  const clipMs = cuts ? numberArray(cuts.clipMs, shotCount) : null
  const kinds = cuts ? stringArray(cuts.kindAt, shotCount) : null
  const overlapMs = cuts ? numberArray(cuts.overlapMs, shotCount) : null
  const headFadeMs = typeof cuts?.headFadeMs === 'number' && Number.isFinite(cuts.headFadeMs) ? cuts.headFadeMs : 0
  const tailFadeMs = typeof cuts?.tailFadeMs === 'number' && Number.isFinite(cuts.tailFadeMs) ? cuts.tailFadeMs : 0
  const fps = typeof cuts?.fps === 'number' && cuts.fps > 0 ? cuts.fps : null
  const blended = cuts?.blended === true

  const masterDurationMs = typeof input.masterDurationMs === 'number' && input.masterDurationMs > 0 ? input.masterDurationMs : null
  const spansUsable = shotCount > 0 && clipMs !== null && clipMs.every(ms => ms > 0)
  const rhythmGaps: ReviewGap[] = []
  if (masterDurationMs === null) rhythmGaps.push('masterDuration')
  if (!spansUsable) rhythmGaps.push('shotSpans')
  const readings = rhythmGaps.length === 0 && masterDurationMs !== null && clipMs !== null
    ? rhythmFromSpans(clipMs, masterDurationMs, settings)
    : null
  const rhythm: RhythmReading = {
    present: rhythmGaps.length === 0,
    gaps: rhythmGaps,
    masterDurationMs,
    readings,
    gate: evaluateShotRhythm(readings, settings),
    settings,
  }

  const transitionGaps: ReviewGap[] = []
  if (shotCount === 0 || kinds === null) transitionGaps.push('cutTable')
  const resolvedRecord = asRecord(manifest?.resolved)
  const rawShots = Array.isArray(resolvedRecord?.shots) ? resolvedRecord!.shots : null
  const shotRecords = rawShots !== null && rawShots.every(entry => asRecord(entry) !== null) ? (rawShots as Record<string, unknown>[]) : null
  const requestedWords = shotRecords && shotRecords.length === shotCount ? stringArray(shotRecords.map(entry => entry.transition), shotCount) : null
  const transition: TransitionReading = {
    present: transitionGaps.length === 0,
    gaps: transitionGaps,
    kinds: kinds ?? [],
    blendedSeamCount: (overlapMs?.filter(ms => ms > 0).length ?? 0) + (headFadeMs > 0 ? 1 : 0) + (tailFadeMs > 0 ? 1 : 0),
    requestedNonCutCount: requestedWords === null ? null : requestedWords.filter(word => word !== 'cut').length,
    blended,
    headFadeMs,
    tailFadeMs,
    fps,
    shotCount,
  }

  const audio = asRecord(manifest?.audio)
  const audioRecordsUsable = audio !== null && shotCount > 0 && storyboardIds.every(id => asRecord(audio[id]) !== null)
  // 台词只有排队定格的那份快照里才有；没有它，「哪些镜该有人声」这件事根本无从判起。
  const dialogueUsable = shotRecords !== null && shotRecords.length === shotCount
  const soundGaps: ReviewGap[] = []
  if (!audioRecordsUsable || !dialogueUsable) soundGaps.push('audioLedger')
  let silentDialogueShots: number[] = []
  let dialogueShotCount = 0
  if (audioRecordsUsable && dialogueUsable && audio !== null) {
    shotRecords!.forEach((record, index) => {
      const dialogue = typeof record.dialogue === 'string' ? record.dialogue : ''
      if (dialogue === '') return
      dialogueShotCount += 1
      const entry = asRecord(audio[storyboardIds[index]!])
      const mode = typeof entry?.mode === 'string' ? entry.mode : null
      const voiceArtifactId = typeof entry?.voiceArtifactId === 'string' ? entry.voiceArtifactId : null
      // 「原声」与「原声+配音」两档的人声就在素材自带音轨里，配音件缺失只是少一层叠加；
      // 其余档位的人声只能来自配音件，件没落进母带就是这一镜在成片里静音（SD-181）。
      if (mode !== 'native' && mode !== 'voice_native' && voiceArtifactId === null) silentDialogueShots.push(index + 1)
    })
    if (silentDialogueShots.length > 0) soundGaps.push('silentDialogue')
  }
  const bedRows = manifest?.beds
  const beds = Array.isArray(bedRows) ? bedRows : []
  const sound: SoundReading = {
    present: soundGaps.length === 0,
    gaps: soundGaps,
    dialogueShotCount,
    silentDialogueShots,
    bedCount: beds.length,
    importedBedCount: beds.filter(entry => asRecord(entry)?.imported === true).length,
    hasMusic: input.hasMusic === true,
  }

  return { rhythm, transition, sound, complete: rhythm.present && transition.present && sound.present }
}

/** 拦验收的缺项，逐条出成 `轴:缺项` 稳定码（409 报文与界面文案同源，不拼人话句子）。 */
export function reviewGapCodes(readings: CompositionReviewReadings): string[] {
  return [
    ...readings.rhythm.gaps.map(gap => `rhythm:${gap}`),
    ...readings.transition.gaps.map(gap => `transition:${gap}`),
    ...readings.sound.gaps.map(gap => `sound:${gap}`),
  ]
}

/**
 * SD-184 邻镜重复读数：相邻镜头落版后画面几乎相同吗，连续几颗？
 *
 * 「选优」过去只逐镜判、不看邻镜重复度——台账实测 #44/#45/#46 与 #57/#58/#59
 * 各三颗几乎相同的画面串成 13.00 s 无切点段（production-log.md SD-184 行）。
 * 这一轴补的就是那个盲区：像素距离由 `@studio/media` 的帧指纹在 worker 侧实测
 * （每条素材一次中段解码、32×32 灰度），这里只做台账数学，输入缺项一律报
 * 「测不出」，不拿「没测」冒充「不重复」。
 */

/**
 * 「几乎相同」的成对距离阈（32×32 灰度平均差，0..1），单点定义。出处（2026-10-25 对
 * 台账本集素材实测）：同镜异抽 shot23 v1↔v2 距离 0.008；同批不同镜的最远一对也不低于
 * 0.080（shot23↔shot24）；而 SD-184 的案犯 #44-46/#57-59 本就是同一画面反复入版，距离
 * 在 0 一侧。0.03 落在实测「重复档 ≤0.008」与「异图档 ≥0.080」之间的空档里，两侧都留
 * 出 2.5 倍以上余量。
 */
export const NEIGHBOR_DUPLICATE_DISTANCE = 0.03

/**
 * 报警的连续重复镜数，单点定义。3 = 台账实测案发现场：#44/#45/#46（及 #57/#58/#59）
 * 正是 3 连重复造成 13.00 s 无切点段。2 连（一对）在本集没有实测塌陷案例——比如剧本
 * 就要正反打同景——所以 2 只摆数不报警，判级必须有实测case（SD-081 的同族纪律）。
 */
export const NEIGHBOR_DUPLICATE_RUN = 3

export interface NeighborDuplicateReading {
  /** 至少测出过一个邻对距离才算 present；全缺时 status 是 unknown，不许渲染成「无重复」。 */
  present: boolean
  /** 第 i 与 i+1 镜之间的画面距离，按母带顺序；null = 这一对没测出来。 */
  pairDistances: Array<number | null>
  /** 命中重复阈的邻对数。 */
  duplicatePairCount: number
  /** 最长「连续以近重复相邻」的镜数；单镜算 1。null 距离视为链断（没证据不判重复）。 */
  maxRunLength: number
  /** 最长链的镜序（1 起，母带顺序）。 */
  maxRunShotIndexes: number[]
  status: 'clean' | 'warning' | 'unknown'
}

export function readNeighborDuplicates(
  pairDistances: ReadonlyArray<number | null>,
  settings?: { distanceThreshold?: number; warnRun?: number },
): NeighborDuplicateReading {
  const threshold = settings?.distanceThreshold ?? NEIGHBOR_DUPLICATE_DISTANCE
  const warnRun = settings?.warnRun ?? NEIGHBOR_DUPLICATE_RUN
  const present = pairDistances.some(distance => distance !== null)
  const duplicate = pairDistances.map(distance => distance !== null && distance <= threshold)
  let maxRunLength = 0
  let maxRunEnd = -1
  let run = 0
  for (const [index, isDuplicate] of duplicate.entries()) {
    if (isDuplicate) {
      run += 1
      if (run > maxRunLength) { maxRunLength = run; maxRunEnd = index }
    } else {
      run = 0
    }
  }
  // run 以「对」计，镜数 = 对数 + 1。
  const shotRun = pairDistances.length === 0 ? 0 : maxRunLength + 1
  const maxRunShotIndexes = maxRunLength > 0
    ? Array.from({ length: maxRunLength + 1 }, (_, offset) => maxRunEnd - maxRunLength + 2 + offset)
    : []
  return {
    present,
    pairDistances: [...pairDistances],
    duplicatePairCount: duplicate.filter(Boolean).length,
    maxRunLength: pairDistances.length === 0 ? 1 : Math.max(1, shotRun),
    maxRunShotIndexes,
    // 空表 = 根本没有邻对（首镜/单镜），重复无从成立——这是 clean，不是没测出来；
    // 报警要实测链坐实；其余只要还有一对没测出来就报 unknown——「没测」永远不许
    // 冒充「无重复」（SD-081 的区分度纪律，与 probeVideoFrames 的 null 降级同理）。
    status: pairDistances.length === 0
      ? 'clean'
      : Math.max(1, shotRun) >= warnRun
        ? 'warning'
        : pairDistances.every(distance => distance !== null)
          ? 'clean'
          : 'unknown',
  }
}
