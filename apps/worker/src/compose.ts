import { saveNleAudio } from './nle-media.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveShotTake, resolveVideoArtifactShot, type AudioSource, type MediaArtifact, type PrismaClient } from '@studio/db'
import { isArtifactVetoed, masterNeedsVoice, recordedAudioMode } from '@studio/domain'
import type { ComposeEpisodePayload } from '@studio/jobs'
import { buildObjectKey, buildSrt, resolveAudioRange, conformToEditMedia, planMasterCutsForClips, probeDuration, probePictureDuration, probeVideoFrames, type MasterCutPlan, type ShotAudioMode, type SubtitleEntry } from '@studio/media'
import { manifestStoryboardIds, splicedMasterTakes, type CompositionTake } from '@studio/pipeline'
import type { PipelineDeps } from './deps.js'

const COMPOSITION_VERSION = 1

/**
 * GB 45438-2025 (人工智能生成合成内容标识办法) asks the delivered file for two marks:
 * one a person can see, one a platform can read from metadata. The badge is bilingual —
 * the same master ships to Chinese feeds and to overseas ones, and an unlabeled export
 * is a legal liability for whoever downloads it, so the default always labels.
 */
const AIGC_BADGE_TEXT = 'AI生成内容 · AI-Generated Content'
const AIGC_STANDARD = 'GB 45438-2025'

/**
 * V03:一次合成的「已解析输入」——排队时由 pipeline 定格(manifest.resolved),渲染
 * 只消费。旧合成(manifest 无 resolved)在渲染时按旧口径现场解析,行为兼容但不可
 * 重现,以 stderr 留痕。
 */
interface ResolvedEntry {
  storyboardId: string
  clipId?: string
  videoArtifactId: string | null
  videoSource: 'edit' | 'manual' | 'auto'
  trimInFrame: number | null
  trimOutFrame: number | null
  dialogue: string
  subtitle: string
  audioSource: string | null
  voiceArtifactId: string | null
  ambienceArtifactId: string | null
  /** S4②:这一刀怎么进——排队时定格的分镜表转场。缺省=硬切(老快照没这两个字段)。 */
  transition?: string
  transitionMs?: number
  /** S2d:这一镜入片的段集。拼接镜是母带自带的多段,其余(含存量镜头)是单段。 */
  takes?: CompositionTake[]
}

/**
 * S2d 消费闸门：拼接镜在时间线上是一刀，刀指向拼好的母带，段本身不进编辑文档——
 * 但快照定格的段集必须与这颗母带自带的段集同源，且每段的条件帧就是上一段的末帧。
 * 两者任一不符，渲出来的就是「看着是一镜、里面是硬切」的片子；当场阻断比交付一段
 * 查不出错在哪的废片便宜。
 */
function assertSplicedTakes(shotLabel: string, takes: CompositionTake[], masterMetadata: string | null | undefined): void {
  const masterTakes = splicedMasterTakes(masterMetadata)
  if (!masterTakes) {
    throw new Error(`storyboard ${shotLabel}: the frozen snapshot splice takes ${takes.length} segments but the video artifact is not a spliced master — re-compose this episode`)
  }
  if (masterTakes.length !== takes.length || masterTakes.some((master, index) => master.videoArtifactId !== takes[index]!.videoArtifactId)) {
    throw new Error(`storyboard ${shotLabel}: the frozen take set no longer matches the master's own segments — the master was rebuilt after this composition was queued; re-compose to pick up the current cuts`)
  }
  for (let index = 1; index < takes.length; index += 1) {
    const previous = masterTakes[index - 1]!
    const current = takes[index]!
    if (!previous.endFrameArtifactId || current.firstFrameArtifactId !== previous.endFrameArtifactId) {
      throw new Error(`storyboard ${shotLabel}: take ${current.order} is not conditioned on take ${previous.order}'s end frame — the splice has a visible seam and will not render as one shot`)
    }
  }
}

interface EditTrackElement {
  elementId: string
  sourceArtifactId: string
  anchor: 'clip' | 'sequence'
  clipId?: string
  offsetFrame: number
  gain: number
  muted: boolean
  locked: boolean
  /** 轨道源范围(序列帧,可选)——有则只取源片这一段,不再整份入混音。 */
  sourceInFrame?: number
  sourceOutFrame?: number
}

/**
 * SD-182 的落点：把「这一镜请求了多少帧」与「这一镜真的交回多少帧」对齐。
 *
 * `trim=end_frame=N` 不含终，交回的是 min(N, 源片帧数) − start 帧：源片比请求少一帧时
 * ffmpeg 不报错、只交回它交得出的那些帧，于是母带比编辑文档短「帧差 × 镜头数」，而字幕
 * 是按文档排的——越往后漂得越多。交付帧数多了（快照过期、素材换版）同样是两张尺。
 *
 * 少 1~2 帧是「毫秒→帧」舍入的必然产物（编辑文档就是这么算出来的），用末帧定格补到请求
 * 的格子：40ms 的定格读不出来，母带长度却回到文档，字幕与画面同一把尺。缺口再大就是素材
 * 真的没有那些画面，冻结几秒比短几帧更糟，当场阻断让人重裁。多出来的裁到请求——剪辑意图
 * 是真相。两条都以 -frames:v 加 -t 双重封顶收尾（渲染不许跑飞，SD-119）。
 */
const FRAME_ALIGN_TOLERANCE = 2

export async function alignClipFrames(
  file: string,
  wantedFrames: number,
  fps: number,
  out: string,
  shotLabel: string,
): Promise<{ file: string; got: number | null; wanted: number }> {
  const got = await probeVideoFrames(file)
  // 探针读不出帧数就没资格裁决（一条已渲染好的素材不该因元数据缺失而失败），原样交回。
  if (got === null || got === wantedFrames) return { file, got, wanted: wantedFrames }
  if (got < wantedFrames && wantedFrames - got > FRAME_ALIGN_TOLERANCE) {
    throw new Error(`storyboard ${shotLabel}: the frozen edit asks for ${wantedFrames} frames but the clip holds ${got} (${wantedFrames - got} short) — the cut points at frames the media does not have; re-cut this shot instead of freezing ${((wantedFrames - got) / fps).toFixed(2)}s of still picture`)
  }
  const seconds = (wantedFrames / fps).toFixed(6)
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const shortBy = wantedFrames - got
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error',
      '-i', file,
      '-vf', shortBy > 0 ? `tpad=stop_mode=clone:stop=${shortBy},setpts=PTS-STARTPTS` : 'setpts=PTS-STARTPTS',
      ...(shortBy > 0 ? ['-af', 'apad'] : []),
      '-frames:v', String(wantedFrames),
      '-t', seconds,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      out,
    ], { timeout: 120_000 })
  } catch {
    throw new Error(`storyboard ${shotLabel}: failed to align the clip to the ${wantedFrames} frames the edit asks for (delivered ${got} at ${fps.toFixed(3)}fps)`)
  }
  const aligned = await probeVideoFrames(out)
  if (aligned !== null && aligned !== wantedFrames) {
    throw new Error(`storyboard ${shotLabel}: the clip still delivers ${aligned} frames after alignment instead of the ${wantedFrames} the edit asks for`)
  }
  return { file: out, got, wanted: wantedFrames }
}

export async function composeEpisode(payload: ComposeEpisodePayload, deps: PipelineDeps): Promise<void> {
  const composition = await deps.db.composition.findUnique({ where: { id: payload.compositionId }, include: { episode: true } })
  if (!composition) throw new Error(`composition ${payload.compositionId} not found`)
  const organization = await deps.db.organization.findUnique({ where: { id: payload.organizationId }, select: { name: true } })

  const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-episode-'))
  try {
    const clips: string[] = []
    const voices: (string | null)[] = []
    const audioSources: (ShotAudioMode | null)[] = []
    const ambiences: (string | null)[] = []
    // S4①:同一条导入底只落一份文件。混音层按「同一个文件」认出这是一条声床跨了几镜,
    // 逐镜各存一份就会把同一场戏的底按刀重放。
    const bedFiles = new Map<string, string>()
    const subtitles: SubtitleEntry[] = []
    // S4②:字幕按哪一镜落的,后面就要按那一镜重算后的落位改回去——数组下标不是镜号。
    const subtitleShotIndexes: number[] = []
    const selections: Record<string, { artifactId: string; source: 'manual' | 'auto' | 'edit' }> = {}
    const audio: Record<string, { mode: string; voiceArtifactId: string | null; ambienceArtifactId: string | null }> = {}
    // US-027/Q03/V03:渲染只消费排队时冻结的快照——编辑结构(editSnapshot)与全量
    // 已解析输入(resolved:选版/声音/字幕/配音/环境音/配乐)。旧合成(无 resolved)
    // 回退现场解析并留痕;那条路不可重现,只作兼容。
    const manifestRaw = JSON.parse(composition.manifest) as {
      storyboardIds?: string[]
      editSnapshot?: {
        revisionId: string; revision: number; fpsNum: number; fpsDen: number; fingerprint: string
        clips: Array<{ clipId: string; storyboardId: string; artifactId: string; sourceInFrame: number; sourceOutFrame: number }>
        tracks: EditTrackElement[]
        outputSpec: unknown
      }
      resolved?: { shots: ResolvedEntry[]; musicArtifactId: string | null }
    }
    let editTracks: EditTrackElement[] | null = null
    let editFpsNum: number | null = null
    let editFpsDen = 1
    let consumedRevisionId: string | null = null
    let consumedFingerprint: string | null = null
    let outputSpecAspect: '9:16' | '16:9' | undefined
    let entries: ResolvedEntry[]
    let frozenMusicArtifactId: string | null | undefined = undefined
    const snapshot = manifestRaw.editSnapshot
    if (snapshot) {
      editTracks = snapshot.tracks
      editFpsNum = snapshot.fpsNum
      editFpsDen = snapshot.fpsDen || 1
      consumedRevisionId = snapshot.revisionId
      consumedFingerprint = snapshot.fingerprint
      try {
        const parsedSpec = snapshot.outputSpec as { aspect?: '9:16' | '16:9' }
        if (parsedSpec?.aspect === '9:16' || parsedSpec?.aspect === '16:9') outputSpecAspect = parsedSpec.aspect
      } catch { /* outputSpec 非法按未设 */ }
    }

    if (manifestRaw.resolved) {
      // V03:全量输入以排队定格为准——快照里的编辑可见片段决定顺序,隐藏片段已剔除。
      entries = manifestRaw.resolved.shots
      frozenMusicArtifactId = manifestRaw.resolved.musicArtifactId
      if (!snapshot) process.stderr.write(`compose ${composition.id}: resolved inputs without editSnapshot — rendering queue-time state (no edit)\n`)
    } else {
      // 旧合成兼容:快照机制上线前排队的 composition 现场解析(等价于排队时刻=渲染
      // 时刻)。这条路的输入漂移无法杜绝,只对存量数据负责。
      process.stderr.write(`compose ${composition.id}: no resolved inputs in manifest — resolving live at render time (legacy)\n`)
      const resolvedNow = await resolveLiveEntries(deps, payload.organizationId, composition.episodeId, composition.manifest)
      entries = resolvedNow.entries
      editTracks = resolvedNow.editTracks ?? editTracks
      if (resolvedNow.fpsNum !== null && editFpsNum === null) {
        editFpsNum = resolvedNow.fpsNum
        editFpsDen = resolvedNow.fpsDen
        consumedRevisionId = resolvedNow.revisionId
        consumedFingerprint = resolvedNow.fingerprint
        try {
          const parsedSpec = JSON.parse(resolvedNow.outputSpecRaw) as { aspect?: '9:16' | '16:9' }
          if (parsedSpec?.aspect === '9:16' || parsedSpec?.aspect === '16:9') outputSpecAspect = parsedSpec.aspect
        } catch { /* 旧修订 outputSpec 非法按未设 */ }
      }
    }

    // R04:每个可见片段在成片时间线上的起始毫秒——clip 锚定音轨的定位基准。
    const clipStartMs = new Map<string, number>()
    const editFps = editFpsNum !== null ? editFpsNum / editFpsDen : null

    const entryStartMs: number[] = []
    let cursorMs = 0
    for (const [index, entry] of entries.entries()) {
      entryStartMs.push(cursorMs)
      const storyboardId = entry.storyboardId
      if (entry.clipId) clipStartMs.set(entry.clipId, cursorMs)
      // Q03 边界:镜头必须属于本集——同组织另一集的镜头/制品不得混入本集成片。
      const shotEpisode = await deps.db.storyboard.findUnique({ where: { id: storyboardId }, select: { episodeId: true } })
      if (!shotEpisode || shotEpisode.episodeId !== composition.episodeId) {
        throw new Error(`storyboard ${storyboardId} does not belong to episode ${composition.episodeId}`)
      }
      let source: MediaArtifact
      if (entry.videoArtifactId) {
        // V03:视频身份=排队定格的制品。归属校验仍查 DB(不可变事实):显式编辑引用
        // 解析失败=数据事故,阻断;人工/自动定格值失效(制品被删)同样阻断——回落
        // live latest 会把「排队时那一版」偷换成「现在最新一版」。
        const artifact = await deps.db.mediaArtifact.findFirst({
          where: { id: entry.videoArtifactId, organizationId: payload.organizationId, stage: 'VIDEO' },
        })
        const owned = artifact ? (await resolveVideoArtifactShot(deps.db, artifact.id, payload.organizationId))?.storyboardId === storyboardId : false
        if (!artifact || (!owned && entry.videoSource === 'edit')) {
          throw new Error(`edit clip ${entry.clipId ?? '(no id)'} references artifact ${entry.videoArtifactId} that is not a video of this shot — fix the edit before composing`)
        }
        if (!artifact) {
          throw new Error(`storyboard ${storyboardId}: frozen video artifact ${entry.videoArtifactId} no longer resolves — re-compose this episode`)
        }
        source = artifact
        selections[storyboardId] = { artifactId: source.id, source: entry.videoSource }
        if (entry.takes && entry.takes.length > 1) assertSplicedTakes(storyboardId, entry.takes, source.metadata)
      } else {
        throw new Error(`storyboard ${storyboardId} has no succeeded video artifact (resolved at queue time)`)
      }
      // US-015 / FR-E02:自动选版的镜头在首次合成时显式固化——此后新候选不能
      // 靠 latest 回退隐式替换。只有人工清空选版才回到自动。
      if (entry.videoSource === 'auto') {
        await deps.db.storyboard.updateMany({
          where: { id: storyboardId, selectedVideoArtifactId: null, lockedVideoSelection: false },
          data: { selectedVideoArtifactId: source.id, stateRevision: { increment: 1 } },
        }).catch(() => undefined)
      }
      const rawClip = path.join(workdir, `raw-${index}${path.extname(source.objectKey) || '.bin'}`)
      await writeFile(rawClip, await deps.storage.read(source.objectKey))
      // V05:有编辑时间线时,先把源片规范化成序列帧率的全尺寸 CFR editMedia,再按
      // editMedia 帧号裁切——直接裁 raw 会在混合帧率下把 1 个序列帧裁成 0.033s 的
      // 30fps 帧(25fps 序列应为 0.04s),音画时间基准从此分叉。无编辑(legacy/无
      // 序列)保持原片直拼:没有序列帧率就没有 conform 目标。
      let clip = rawClip
      const startFrame = entry.trimInFrame ?? 0
      const endFrame = entry.trimOutFrame ?? -1
      if (editFps !== null) {
        const conformDir = await mkdtemp(path.join(workdir, 'conform-'))
        const conformed = await conformToEditMedia(rawClip, editFpsNum!, editFpsDen, conformDir)
          .catch(() => null)
        if (!conformed) {
          throw new Error(`failed to conform clip for storyboard ${storyboardId} to ${editFpsNum}/${editFpsDen} CFR before trimming — raw source is not editable media`)
        }
        clip = conformed.outputPath
        if (entry.trimInFrame !== null || entry.trimOutFrame !== null) {
          const trimmed = path.join(workdir, `clip-${index}.mp4`)
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const execFileAsync = promisify(execFile)
          // conform 之后画面是序列帧率 CFR:start_frame/end_frame 即序列帧号;音频与
          // 画面同一时间基准(秒=帧/序列fps),R03 的音画同步在 CFR 上成立。
          const startSec = (startFrame / editFps).toFixed(6)
          const endSec = endFrame > 0 ? (endFrame / editFps).toFixed(6) : undefined
          try {
            await execFileAsync('ffmpeg', [
              '-y', '-v', 'error',
              '-i', clip,
              '-vf', `trim=start_frame=${startFrame}${endFrame > 0 ? `:end_frame=${endFrame}` : ''},setpts=PTS-STARTPTS`,
              '-af', `atrim=start=${startSec}${endSec !== undefined ? `:end=${endSec}` : ''},asetpts=PTS-STARTPTS`,
              '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
              '-c:a', 'aac', '-b:a', '192k',
              trimmed,
            ], { timeout: 120_000 })
            clip = trimmed
          } catch {
            // 裁切失败阻断——退全片会让编辑意图静默丢失(F08 的静默回退在方案里明确禁止)。
            throw new Error(`failed to trim clip for storyboard ${storyboardId} [${startFrame},${endFrame}) at ${editFps?.toFixed(3)}fps`)
          }
        }
      } else if (entry.trimInFrame !== null || entry.trimOutFrame !== null) {
        // 旧合成无序列帧率:按秒裁(Q06 的兼容路径,新任务不再走到这里)。
        const fps = 25
        const trimmed = path.join(workdir, `clip-${index}.mp4`)
        const startSec = startFrame / fps
        const endSec = endFrame > 0 ? endFrame / fps : undefined
        const { execFile } = await import('node:child_process')
        const { promisify } = await import('node:util')
        const execFileAsync = promisify(execFile)
        try {
          await execFileAsync('ffmpeg', [
            '-y', '-v', 'error',
            '-i', rawClip,
            '-vf', `trim=start=${startSec}${endSec !== undefined ? `:end=${endSec}` : ''},setpts=PTS-STARTPTS`,
            '-af', `atrim=start=${startSec}${endSec !== undefined ? `:end=${endSec}` : ''},asetpts=PTS-STARTPTS`,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
            '-c:a', 'aac', '-b:a', '192k',
            trimmed,
          ], { timeout: 120_000 })
          clip = trimmed
        } catch {
          throw new Error(`failed to trim clip for storyboard ${storyboardId} [${startFrame},${endFrame}) (legacy seconds timebase)`)
        }
      }
      // SD-182: 裁完必须数帧。编辑文档按帧号要 N 帧，`trim` 只能交回源片有的那些帧，
      // 差一帧就少一帧——62 刀累计就是母带比文档短、字幕逐镜往后漂的那 2.5 秒。
      // 无裁切请求（整片入镜）没有「该交多少帧」这根弦，交回什么算什么。
      const wantedFrames = endFrame > startFrame ? endFrame - startFrame : 0
      if (wantedFrames > 0) {
        clip = (await alignClipFrames(clip, wantedFrames, editFps ?? 25, path.join(workdir, `aligned-${index}.mp4`), storyboardId)).file
      }
      clips.push(clip)
      // Cue timings follow the measured clip, never the planned durationMs — a
      // provider that misses its target must not slide every later subtitle.
      // 量的必须是画面帧数换算的时长：容器时长带音轨尾巴，字幕会按那点尾巴逐镜往后排。
      const durationMs = await probePictureDuration(clip)
      // V03:字幕文本用排队定格值——排队后改字幕不进本次合成。
      const subtitle = entry.subtitle
      // V03:人声/环境音制品 id 均为排队定格,渲染只解析字节。
      const voiceArtifact = entry.voiceArtifactId
        ? await deps.db.mediaArtifact.findFirst({ where: { id: entry.voiceArtifactId, stage: 'AUDIO', organizationId: payload.organizationId }, select: { id: true, objectKey: true } })
        : null
      const voiceFile = voiceArtifact ? path.join(workdir, `voice-${index}${path.extname(voiceArtifact.objectKey) || '.wav'}`) : null
      if (voiceArtifact && voiceFile) await writeFile(voiceFile, await deps.storage.read(voiceArtifact.objectKey))
      const storedAudioSource = (entry.audioSource ?? null) as AudioSource | null
      const resolved = frozenShotAudio(entry.dialogue, storedAudioSource, voiceFile, entry.voiceArtifactId)
      const ambience = await resolveShotAmbience(deps, payload.organizationId, workdir, bedFiles, entry.ambienceArtifactId)
      voices.push(resolved.voiceFile)
      audioSources.push(resolved.mode)
      ambiences.push(ambience.file)
      audio[storyboardId] = {
        // 记「这一条人声真的被读进本次渲染」的那件，而不是排队快照里的 id：件后来被
        // 删掉时快照仍有 id，验收读声音轴就会把一句静音判成人声到位。
        mode: resolved.recordedAs, voiceArtifactId: voiceArtifact?.id ?? null, ambienceArtifactId: ambience.artifactId,
      }
      if (subtitle !== '') {
        subtitles.push({ text: subtitle, fromMs: cursorMs, toMs: cursorMs + durationMs })
        subtitleShotIndexes.push(index)
      }
      cursorMs += durationMs
    }

    // S4②:转场从排队定格的快照取,整条母带时间线按重叠后的落位重算一次。字幕、
    // 编辑音轨锚点、配音落位、质检证据时刻全部改读这一份——按标称时长排就是拿一张
    // 已经不成立的表去对音(叠化那一刀,画面已经提前 400ms 起来,声音还排在旧格子上)。
    // 一刀不使的整集计划与旧口径逐毫秒相同,重算不改变任何行为。
    const cuts: MasterCutPlan = await planMasterCutsForClips(
      clips,
      entries.map(entry => ({ transition: entry.transition ?? 'cut', transitionMs: entry.transitionMs ?? 0 })),
    )
    for (const [index, startMs] of cuts.shotStartMs.entries()) {
      entryStartMs[index] = startMs
      const clipId = entries[index]?.clipId
      if (clipId) clipStartMs.set(clipId, startMs)
    }
    for (const [order, subtitle] of subtitles.entries()) {
      const shotIndex = subtitleShotIndexes[order]!
      subtitle.fromMs = cuts.shotStartMs[shotIndex]!
      subtitle.toMs = cuts.shotStartMs[shotIndex]! + cuts.clipMs[shotIndex]!
    }
    cursorMs = cuts.totalMs

    // V03:配乐同样取排队定格 id;旧合成回退「当时最新」。
    let bgm: string | undefined
    const musicArtifactId = frozenMusicArtifactId !== undefined
      ? frozenMusicArtifactId
      : (await latestMusicArtifact(deps.db, composition.episodeId, payload.organizationId))?.id ?? null
    let music: { id: string; objectKey: string } | null = null
    if (musicArtifactId) {
      music = await deps.db.mediaArtifact.findFirst({ where: { id: musicArtifactId, organizationId: payload.organizationId }, select: { id: true, objectKey: true } })
    }
    if (music) {
      bgm = path.join(workdir, `bgm${path.extname(music.objectKey) || '.wav'}`)
      await writeFile(bgm, await deps.storage.read(music.objectKey))
    }

    // R04/V03+:编辑时间线的独立音轨真正进混音——每轨按锚定算序列起始毫秒、应用
    // gain/muted、消费源范围(sourceInFrame/sourceOutFrame),负偏移裁掉序列前的
    // 源片头部而不是钳到 0。锚定隐藏/不存在片段、源制品缺失都是编辑不一致,
    // 阻断合成(BLOCKED)而不是静默跳过——静默丢轨等于编辑意图在成片里蒸发。
    const extras: Array<{ file: string; startMs: number; gain: number; muted: boolean }> = []
    if (editTracks) {
      const trackFps = editFps ?? 25
      for (const element of editTracks) {
        const hiddenClips = new Set((snapshot?.clips ?? []).filter(c => c.clipId.startsWith('__hidden__')).flatMap(c => [c.clipId, c.clipId.replace(/^__hidden__/, '')]))
        if (element.anchor === 'clip' && element.clipId && hiddenClips.has(element.clipId)) continue
        if (element.anchor === 'clip' && (!element.clipId || !clipStartMs.has(element.clipId))) {
          throw new Error(`edit track ${element.elementId} anchors a hidden or unknown clip — fix the edit before composing`)
        }
        const artifact = await deps.db.mediaArtifact.findFirst({
          where: { id: element.sourceArtifactId, organizationId: payload.organizationId },
          select: { id: true, objectKey: true },
        })
        if (!artifact) {
          throw new Error(`edit track ${element.elementId} source artifact ${element.sourceArtifactId} not found — fix the edit before composing`)
        }
        const anchorMs = element.anchor === 'sequence' ? 0 : clipStartMs.get(element.clipId!) ?? 0
        const range = resolveAudioRange(element, Math.round(anchorMs / 1000 * trackFps), Math.round(cursorMs / 1000 * trackFps))
        if (!range) continue
        const startMs = range.recordStartFrame / trackFps * 1000
        const srcInMs = range.sourceInFrame / trackFps * 1000
        const srcOutMs = range.sourceOutFrame === undefined ? undefined : range.sourceOutFrame / trackFps * 1000
        let file = path.join(workdir, `extra-${element.elementId}${path.extname(artifact.objectKey) || '.bin'}`)
        await writeFile(file, await deps.storage.read(artifact.objectKey))
        if (srcInMs > 0 || srcOutMs !== undefined) {
          const trimmed = path.join(workdir, `extra-trim-${element.elementId}.wav`)
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const execFileAsync = promisify(execFile)
          await execFileAsync('ffmpeg', [
            '-y', '-v', 'error', '-i', file,
            '-af', `atrim=start=${(srcInMs / 1000).toFixed(6)}${srcOutMs !== undefined ? `:end=${(srcOutMs / 1000).toFixed(6)}` : ''},asetpts=PTS-STARTPTS`,
            '-c:a', 'pcm_s16le', trimmed,
          ], { timeout: 120_000 })
          file = trimmed
        }
        extras.push({
          file,
          startMs,
          gain: Number.isFinite(element.gain) ? element.gain : 1,
          muted: element.muted === true,
        })
      }
    }
    // R04:outputSpec 的画幅进渲染——编辑改画幅,重合成必须真的变画幅,而不是只进指纹。
    // V03:画幅同样取自排队快照(快照解析段已提取 outputSpecAspect)。
    const outputSpec: { aspect?: '9:16' | '16:9' } | undefined = outputSpecAspect ? { aspect: outputSpecAspect } : undefined
    const srt = subtitles.length > 0 ? buildSrt(subtitles) : undefined
    const srtPath = srt ? path.join(workdir, 'subtitles.srt') : undefined
    if (srt && srtPath) await writeFile(srtPath, srt)

    const output = path.join(workdir, 'composition.mp4')
    // 双标识随每次合成强制附加:母带是唯一会被下载/转发的文件,标识不能等运营手动开。
    const label = {
      badgeText: AIGC_BADGE_TEXT,
      metadata: {
        // 字段名跟随办法的附件口径:Label=1 表示"全部由人工智能生成"。
        Label: '1',
        Standard: AIGC_STANDARD,
        ContentProducer: organization?.name ?? payload.organizationId,
        ContentPropagator: organization?.name ?? payload.organizationId,
        ProduceId: composition.id,
        EpisodeId: composition.episodeId,
      },
    }
    const composed = await deps.composer.compose({ clips, voices, audioSources, ambiences, cuts, bgm, srt: srtPath, label, ...(extras.length > 0 ? { extras } : {}), ...(outputSpec ? { outputSpec } : {}) }, output)
    // 质量地板:母带必过一遍响度下限处理(loudnorm),超分/补帧/调色为挂点。
    // 任一环节失败回退原母带并记录原因——地板不允许把交付变得比不做更差,
    // 也不允许无声:处理前后的实测 LUFS 会随记录进交付清单。
    const processed = await deps.composer.postProcess(output, workdir, { label })
    const objectKey = buildObjectKey({
      tenantId: payload.organizationId,
      projectId: composition.episode.projectId,
      episodeId: composition.episodeId,
      stage: 'COMPOSITION',
      entityId: composition.id,
      version: COMPOSITION_VERSION,
      extension: 'mp4',
    })
    const stored = await deps.storage.put(objectKey, new Uint8Array(await readFile(processed.file)), 'video/mp4')
    const artifact = await deps.db.mediaArtifact.create({
      data: {
        organizationId: payload.organizationId,
        stage: 'COMPOSITION',
        objectKey: stored.key,
        checksum: stored.checksum,
        mimeType: stored.mimeType,
        version: COMPOSITION_VERSION,
        durationMs: composed.durationMs,
      },
    })
    // A separate artifact rather than a metadata blob: it downloads like any other
    // stage output and a human can open and check it.
    let subtitleArtifactId: string | null = null
    if (srt) {
      const subtitleKey = buildObjectKey({
        tenantId: payload.organizationId,
        projectId: composition.episode.projectId,
        episodeId: composition.episodeId,
        stage: 'SUBTITLE',
        entityId: composition.id,
        version: COMPOSITION_VERSION,
        extension: 'srt',
      })
      const storedSrt = await deps.storage.put(subtitleKey, new TextEncoder().encode(srt), 'application/x-subrip')
      const subtitle = await deps.db.mediaArtifact.create({
        data: {
          organizationId: payload.organizationId,
          stage: 'SUBTITLE',
          objectKey: storedSrt.key,
          checksum: storedSrt.checksum,
          mimeType: storedSrt.mimeType,
          version: COMPOSITION_VERSION,
        },
      })
      subtitleArtifactId = subtitle.id
    }
    // 标识结果落库:角标被降级(缺 drawtext/字体)时,这条记录是合规自查和
    // 交付清单里唯一能看到"没烧上"的地方——不允许只消失在 ffmpeg 的输出里。
    const compositionManifest = JSON.parse(composition.manifest) as Record<string, unknown>
    compositionManifest.labeling = {
      standard: AIGC_STANDARD,
      badgeText: AIGC_BADGE_TEXT,
      explicit: composed.labeling?.explicit ?? 'unrecorded',
      implicit: composed.labeling?.implicit ?? 'unrecorded',
      ...(composed.labeling?.reason ? { reason: composed.labeling.reason } : {}),
    }
    const stems: Array<{ name: string; file: string; startMs: number; gain: number; durationMs?: number }> = []
    let voiceCursorMs = 0
    for (const [index, entry] of entries.entries()) {
      if (voices[index] && audioSources[index] !== 'native') {
        const startMs = Math.max(entryStartMs[index], voiceCursorMs)
        stems.push({ name: `Voice ${entry.clipId ?? index}`, file: voices[index]!, startMs, gain: 1 })
        voiceCursorMs = startMs + Math.max(100, await probeDuration(voices[index]!))
      }
    }
    // S4①:底按混音层的实际落位记账，一条声床一行。逐镜各记一行会把「一条底铺了整场」
    // 写成「每镜一条底」，交给剪辑软件时越界的那半秒电平与长度都对不上母带。
    for (const bed of composed.beds ?? []) {
      const lead = entries[bed.shotIndexes[0]!]!
      stems.push({ name: `${bed.imported ? 'Ambience' : 'Native'} ${lead.clipId ?? bed.shotIndexes.join('+')}`, file: bed.file, startMs: bed.startMs, gain: 0.6 })
    }
    extras.forEach((extra, index) => stems.push({ name: `Edit audio ${index}`, file: extra.file, startMs: extra.startMs, gain: extra.gain }))
    if (bgm) stems.push({ name: 'Music source', file: bgm, startMs: 0, gain: 1 })
    compositionManifest.nleAudio = await saveNleAudio(deps, { organizationId: payload.organizationId, compositionId: composition.id }, workdir, processed.file, stems)
    compositionManifest.postProcess = processed.record
    // 选优门留痕:每镜最终入片的版本与它是人工钦定还是自动取最新。
    // 母带用了哪一版必须可回放审计,不允许"选了 A 剪出来是 B"。
    compositionManifest.selections = selections
    // 声音来源同样留痕：母带里这一镜听到的是配音、原声、叠加还是导入文件，
    // 必须能从文件反查回去——否则「双声是哪来的」只能靠重抽猜。
    compositionManifest.audio = audio
    // S4① 声床留痕：导入底在母带里从哪一秒响到哪一秒、两侧各越过剪点多少。听得出接缝
    // 却查不到底的落位，返修只能重猜；这一串数也能核对「同一条底铺了哪几镜」。
    compositionManifest.beds = (composed.beds ?? []).map(bed => ({
      imported: bed.imported,
      startMs: bed.startMs,
      durationMs: bed.durationMs,
      fadeInMs: bed.fadeInMs,
      fadeOutMs: bed.fadeOutMs,
      storyboardIds: bed.shotIndexes.map(index => entries[index]!.storyboardId),
      ...(bed.imported ? { ambienceArtifactId: audio[entries[bed.shotIndexes[0]!]!.storyboardId]?.ambienceArtifactId ?? null } : {}),
    }))
    // S4② 一刀表留痕：剧本点的转场到底有没有落进母带。`composed.cuts` 只在真的
    // 发生过重叠/淡入淡出时存在——记输入那份计划等于记一个可能没发生的数，这里落的
    // 是渲染侧实际吃下的那份（素材实测长度会把重叠毫秒夹小）。
    // 一刀不使的整集也记全表：验收三读数（S5）量节奏要用逐镜实际跨度，
    // 「没有转场」不等于「没有台账」。
    const cutLedger = composed.cuts ?? cuts
    compositionManifest.cuts = {
      // 判的是「渲染侧有没有回来这份表」，不是「传进去的计划是不是 null」：
      // 不混合时 composed.cuts 是缺字段（undefined），写成 !== null 就恒真，
      // stream-copy 的母带会被记成「混合拼接」。
      blended: composed.cuts !== undefined,
      fps: cutLedger.fps,
      kindAt: cutLedger.kindAt,
      overlapMs: cutLedger.overlapMs,
      clipMs: cutLedger.clipMs,
      shotStartMs: cutLedger.shotStartMs,
      headFadeMs: cutLedger.headFadeMs,
      tailFadeMs: cutLedger.tailFadeMs,
      totalMs: cutLedger.totalMs,
      storyboardIds: entries.map(entry => entry.storyboardId),
    }
    // US-027-029/Q03:链接本次合成实际消费的编辑修订与指纹——快照优先,旧回退 head。
    const editRevisionId = consumedRevisionId
    const inputFingerprint = consumedFingerprint
    const sourceFindings = await deps.db.qualityFinding.findMany({ where: { organizationId: payload.organizationId, compositionId: { startsWith: 'artifact:' }, artifactId: { in: entries.map(entry => entry.videoArtifactId).filter((id): id is string => id !== null) } } })
    for (const [index, entry] of entries.entries()) {
      const from = (entry.trimInFrame ?? 0) / (editFps ?? 25)
      const to = entry.trimOutFrame === null ? Infinity : entry.trimOutFrame / (editFps ?? 25)
      for (const finding of sourceFindings.filter(row => row.artifactId === entry.videoArtifactId)) {
        if (finding.evidenceTimeSeconds !== null && (finding.evidenceTimeSeconds < from || finding.evidenceTimeSeconds >= to)) continue
        const findingKey = `${entry.clipId ?? index}:${finding.artifactId}:${finding.findingKey}`
        await deps.db.qualityFinding.upsert({
          where: { compositionId_findingKey: { compositionId: composition.id, findingKey } },
          create: { organizationId: payload.organizationId, episodeId: composition.episodeId, compositionId: composition.id, fingerprint: inputFingerprint ?? composition.id, findingKey, dimension: finding.dimension, severity: finding.severity, message: finding.message, evidenceTimeSeconds: finding.evidenceTimeSeconds === null ? null : entryStartMs[index] / 1000 + finding.evidenceTimeSeconds - from, artifactId: finding.artifactId, storyboardId: finding.storyboardId },
          update: {},
        })
      }
    }
    // S5：母带实测时长落 Composition 行。交付面板的节奏读数原本只能拿逐镜跨度求和
    // 或拿分镜表的标称值顶，两者都不是「这条文件有多长」；探到多少写多少，探不到留
    // null（0 = 探针没给出数），不拿计划值补一个假实测。
    // SD-182: 这把尺量画面（帧数 × 帧率），不量容器——容器多出的那点音轨尾巴会让
    // 「母带长度」与编辑文档、与字幕表三个数各说各话。
    const masterDurationMs = await probePictureDuration(processed.file)
    await deps.db.composition.update({
      where: { id: composition.id },
      data: { status: 'COMPLETED', errorSnapshot: null, durationMs: masterDurationMs > 0 ? masterDurationMs : null, manifest: JSON.stringify(compositionManifest), artifactId: artifact.id, subtitleArtifactId, scoreArtifactId: music?.id ?? null, editRevisionId, inputFingerprint },
    })
  } catch (error) {
    // BLOCKED (not FAILED) keeps the composition retriggerable once the missing clip lands.
    // 原因写进行里（SD-177）：这一轮为什么没出片必须能从记录本身读出来，界面才给得出
    // 「已阻塞在哪」，而不是只留一个没有解释的状态。stderr 继续留一份给运维。
    const reason = error instanceof Error ? error.message : String(error)
    process.stderr.write(`compose ${composition.id} blocked: ${reason}\n`)
    await deps.db.composition.update({ where: { id: composition.id }, data: { status: 'BLOCKED', errorSnapshot: reason } })
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

/**
 * V03 兼容层:旧合成(manifest 无 resolved)在渲染时按旧口径现场解析——等价于
 * 「排队时刻=渲染时刻」。包含无快照合成对 live 编辑 head 的旧回退,行为与
 * 快照机制上线前一致。
 */
async function resolveLiveEntries(
  deps: PipelineDeps,
  organizationId: string,
  episodeId: string,
  manifestRaw: string,
): Promise<{
  entries: ResolvedEntry[]
  editTracks: EditTrackElement[] | null
  fpsNum: number | null
  fpsDen: number
  revisionId: string | null
  fingerprint: string | null
  outputSpecRaw: string
}> {
  const parsed = JSON.parse(manifestRaw) as {
    storyboardIds?: string[]
    editSnapshot?: { clips: Array<{ clipId: string; storyboardId: string; artifactId: string; sourceInFrame: number; sourceOutFrame: number }>; fpsNum: number; fpsDen: number; revisionId: string; fingerprint: string; outputSpec?: unknown }
  }
  const fromSnapshot = parsed.editSnapshot?.clips.filter(clip => !clip.clipId.startsWith('__hidden__')) ?? null
  let clips = fromSnapshot
  let outputSpecRaw = '{}'
  if (parsed.editSnapshot) outputSpecRaw = JSON.stringify(parsed.editSnapshot.outputSpec ?? {})
  let revisionId: string | null = parsed.editSnapshot?.revisionId ?? null
  let fingerprint: string | null = parsed.editSnapshot?.fingerprint ?? null
  let fpsNum: number | null = parsed.editSnapshot?.fpsNum ?? null
  let fpsDen = parsed.editSnapshot?.fpsDen ?? 1
  let tracks: EditTrackElement[] | null = null
  if (!clips) {
    const editHead = await deps.db.episodeEdit.findUnique({
      where: { episodeId },
      include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } },
    })
    if (editHead?.revisions[0]) {
      const rev = editHead.revisions[0]
      fpsNum = rev.fpsNum
      fpsDen = rev.fpsDen
      tracks = JSON.parse(rev.tracks)
      revisionId = rev.id
      fingerprint = rev.fingerprint
      outputSpecRaw = rev.outputSpec
      clips = (JSON.parse(rev.clips) as Array<{ clipId: string; storyboardId: string; artifactId: string; sourceInFrame: number; sourceOutFrame: number }>)
        .filter(clip => !clip.clipId.startsWith('__hidden__'))
    }
  }
  const plans = clips ?? (manifestStoryboardIds(manifestRaw).map(id => ({ clipId: '', storyboardId: id, artifactId: '', sourceInFrame: 0, sourceOutFrame: 0 })))
  const shotRows = await deps.db.storyboard.findMany({
    where: { id: { in: plans.map(plan => plan.storyboardId) } },
    select: {
      id: true, dialogue: true, subtitleText: true, audioSource: true,
      importedVoiceArtifactId: true, importedAmbienceArtifactId: true, selectedVoiceArtifactId: true,
      selectedVideoArtifactId: true, lockedVideoSelection: true,
    },
  })
  const shotById = new Map(shotRows.map(row => [row.id, row]))
  const entries: ResolvedEntry[] = []
  for (const plan of plans) {
    const shot = shotById.get(plan.storyboardId) ?? null
    // 视频按旧 chosenVideoArtifact 口径:显式编辑引用/人工钦定/最新成功。
    let videoArtifactId: string | null = null
    let videoSource: 'edit' | 'manual' | 'auto' = 'auto'
    if (plan.artifactId !== '') {
      videoArtifactId = plan.artifactId
      videoSource = 'edit'
    } else if (shot?.selectedVideoArtifactId) {
      const owned = (await resolveVideoArtifactShot(deps.db, shot.selectedVideoArtifactId, organizationId))?.storyboardId === shot.id
      const pinned = owned
        ? await deps.db.mediaArtifact.findFirst({ where: { id: shot.selectedVideoArtifactId, stage: 'VIDEO', organizationId } })
        : null
      // SD-172：钦定之后又被人工否决的那一版不再入片（否决入口同时会清掉指针，
      // 这里兜住旧数据）。落回「自动取最新」，那一档同样跳过被否的版本。
      if (pinned && !isArtifactVetoed(pinned.metadata)) {
        videoArtifactId = pinned.id
        videoSource = 'manual'
      } else if (shot.lockedVideoSelection) {
        throw new Error(`storyboard's locked video selection ${shot.selectedVideoArtifactId} no longer resolves — fix the selection before composing`)
      }
    } else if (shot?.lockedVideoSelection) {
      // US-015 锁定但没钦定:锁定意味着「用现在的」,null + locked = 数据矛盾,报错。
      throw new Error('storyboard has lockedVideoSelection but no selectedVideoArtifactId — lock means "keep this", so a selection must exist')
    }
    if (videoArtifactId === null) {
      const latest = await latestVideoArtifact(deps.db, plan.storyboardId, organizationId)
      if (!latest) throw new Error(`storyboard ${plan.storyboardId} has no succeeded video artifact`)
      videoArtifactId = latest.id
    }
    // 人声按旧 resolveShotAudio 口径:「导入音频」只认人给的那个文件,晚到的 TTS
    // 不许插队;指针悬空宁可不响,也不拿任务产物冒充。
    const dialogue = shot?.dialogue ?? ''
    const stored = shot?.audioSource ?? null
    let voiceArtifactId: string | null = null
    if (masterNeedsVoice(dialogue, stored)) {
      const imported = shot?.importedVoiceArtifactId
        ? await deps.db.mediaArtifact.findFirst({ where: { id: shot.importedVoiceArtifactId, stage: 'AUDIO', organizationId }, select: { id: true } })
        : null
      if (stored === 'IMPORTED') {
        voiceArtifactId = imported?.id ?? null
      } else {
        const chosen = shot?.selectedVoiceArtifactId
          ? await deps.db.mediaArtifact.findFirst({ where: { id: shot.selectedVoiceArtifactId, stage: 'AUDIO', task: { status: 'SUCCEEDED', storyboardId: plan.storyboardId } } })
          : null
        const latest = (chosen && !isArtifactVetoed(chosen.metadata) ? chosen : null) ?? (await latestVoiceArtifact(deps.db, plan.storyboardId, organizationId)) ?? imported
        voiceArtifactId = latest?.id ?? null
      }
    }
    entries.push({
      storyboardId: plan.storyboardId,
      ...(plan.clipId !== '' ? { clipId: plan.clipId } : {}),
      videoArtifactId,
      videoSource,
      trimInFrame: plan.sourceInFrame > 0 ? plan.sourceInFrame : null,
      trimOutFrame: plan.sourceOutFrame > 0 ? plan.sourceOutFrame : null,
      dialogue,
      subtitle: shot?.subtitleText ?? dialogue,
      audioSource: stored,
      voiceArtifactId,
      ambienceArtifactId: shot?.importedAmbienceArtifactId ?? null,
    })
  }
  return { entries, editTracks: tracks, fpsNum, fpsDen, revisionId, fingerprint, outputSpecRaw }
}

/** V03:定格字段 → 混音层档位,纯函数(与旧 resolveShotAudio 的档位映射同口径)。 */
function frozenShotAudio(
  dialogue: string,
  stored: AudioSource | null,
  voiceFile: string | null,
  voiceArtifactId: string | null,
): { mode: ShotAudioMode | null; voiceFile: string | null; recordedAs: string } {
  if (stored === 'IMPORTED' && !voiceFile) return { mode: null, voiceFile: null, recordedAs: 'default' }
  switch (stored) {
    case 'NATIVE':
      return { mode: 'native', voiceFile: null, recordedAs: 'native' }
    case 'VOICE_NATIVE':
      return { mode: 'voice_native', voiceFile, recordedAs: 'voice_native' }
    case 'IMPORTED':
      return { mode: 'voice', voiceFile, recordedAs: 'imported' }
    case 'VOICE':
      return { mode: 'voice', voiceFile, recordedAs: 'voice' }
    default:
      return { mode: null, voiceFile, recordedAs: recordedAudioMode(dialogue, null) }
  }
}

/**
 * 这一镜导入的环境音：混音层里它占的是「氛围底」那一格，与上面那档人声来源无关。
 * 文件行不见了（被删、或指针从来没落对）就当没导入过，退回模型原声那条路——
 * 与悬空的配音同一语义：编辑偏好不是依赖。
 * 同一场戏几镜共用一条街声时，它们必须落到同一路径，混音层才认得出这是一条连续声床
 * 而不是每一刀重放一遍。判据是文件内容（checksum），不是制品 id：导入是一镜一上传，
 * 同一个 wav 传两次就是两条 MediaArtifact，按 id 分组等于要求用户“只给一镜导入、
 * 其余镜凭空共享”，界面里没有这个入口。
 */
async function resolveShotAmbience(
  deps: PipelineDeps,
  organizationId: string,
  workdir: string,
  cache: Map<string, string>,
  artifactId: string | null,
): Promise<{ file: string | null; artifactId: string | null }> {
  if (!artifactId) return { file: null, artifactId: null }
  const artifact = await deps.db.mediaArtifact.findFirst({ where: { id: artifactId, stage: 'AUDIO', organizationId } })
  if (!artifact) return { file: null, artifactId: null }
  const cached = cache.get(artifact.checksum)
  if (cached) return { file: cached, artifactId: artifact.id }
  const file = path.join(workdir, `ambience-${artifact.checksum.slice(0, 16)}${path.extname(artifact.objectKey) || '.wav'}`)
  await writeFile(file, await deps.storage.read(artifact.objectKey))
  cache.set(artifact.checksum, file)
  return { file, artifactId: artifact.id }
}

async function latestVideoArtifact(db: PrismaClient, storyboardId: string, organizationId: string) {
  // SD-172：取版与界面读数共用同一份解析器。人工否决过的那一版不再冒充「最新成功版」
  // 排进母带——过去这条链只按 createdAt/version 取最新，人说了「不要」没人听得见。
  return resolveShotTake(db, { organizationId, storyboardId, stage: 'VIDEO' })
}

async function latestVoiceArtifact(db: PrismaClient, storyboardId: string, organizationId: string) {
  return resolveShotTake(db, { organizationId, storyboardId, stage: 'AUDIO' })
}

async function latestMusicArtifact(db: PrismaClient, episodeId: string, organizationId: string) {
  return db.mediaArtifact.findFirst({
    where: { organizationId, stage: 'MUSIC', task: { status: 'SUCCEEDED', stage: 'MUSIC', batch: { episodeId } } },
    orderBy: [{ task: { createdAt: 'desc' } }, { version: 'desc' }],
  })
}
