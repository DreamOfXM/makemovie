import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AudioSource, MediaArtifact, PrismaClient } from '@studio/db'
import type { ComposeEpisodePayload } from '@studio/jobs'
import { buildObjectKey, buildSrt, probeDuration, type ShotAudioMode, type SubtitleEntry } from '@studio/media'
import { manifestStoryboardIds } from '@studio/pipeline'
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
    const subtitles: SubtitleEntry[] = []
    const selections: Record<string, { artifactId: string; source: 'manual' | 'auto' }> = {}
    const audio: Record<string, { mode: string; voiceArtifactId: string | null; ambienceArtifactId: string | null }> = {}
    let cursorMs = 0
    for (const [index, storyboardId] of manifestStoryboardIds(composition.manifest).entries()) {
      const shot = await deps.db.storyboard.findUnique({
        where: { id: storyboardId },
        select: {
          // 环境音与声音来源正交：它决定配音底下垫什么，不决定人声从哪来。
          dialogue: true, subtitleText: true, audioSource: true, importedVoiceArtifactId: true, importedAmbienceArtifactId: true, selectedVoiceArtifactId: true,
        },
      })
      const chosen = await chosenVideoArtifact(deps.db, storyboardId)
      if (!chosen) throw new Error(`storyboard ${storyboardId} has no succeeded video artifact`)
      const source = chosen.artifact
      selections[storyboardId] = { artifactId: source.id, source: chosen.source }
      const clip = path.join(workdir, `clip-${index}${path.extname(source.objectKey) || '.bin'}`)
      await writeFile(clip, await deps.storage.read(source.objectKey))
      clips.push(clip)
      // Cue timings follow the measured clip, never the planned durationMs — a
      // provider that misses its target must not slide every later subtitle.
      const durationMs = await probeDuration(clip)
      const dialogue = shot?.dialogue ?? ''
      // 烧进画面的那行字：人改过就用人的，没改过才是台词。导入的音频念的常常不是
      // 剧本里那句，而硬烧的字幕交付后改不掉——所以这一镜必须能单独说一句话。
      const subtitle = shot?.subtitleText ?? dialogue
      // 声音来源是人给的，缺省才回落到镜型默认（有台词=只用配音，无台词=只用原声）。
      // 落库的 IMPORTED 在混音层就是「用人声轨」，区别只在人声从哪来。
      const resolved = await resolveShotAudio(deps, storyboardId, workdir, index, shot)
      const ambience = await resolveShotAmbience(deps, workdir, index, shot?.importedAmbienceArtifactId ?? null)
      voices.push(resolved.voiceFile)
      audioSources.push(resolved.mode)
      ambiences.push(ambience.file)
      audio[storyboardId] = {
        mode: resolved.recordedAs, voiceArtifactId: resolved.voiceArtifactId, ambienceArtifactId: ambience.artifactId,
      }
      if (subtitle !== '') subtitles.push({ text: subtitle, fromMs: cursorMs, toMs: cursorMs + durationMs })
      cursorMs += durationMs
    }

    let bgm: string | undefined
    const music = await latestMusicArtifact(deps.db, composition.episodeId)
    if (music) {
      bgm = path.join(workdir, `bgm${path.extname(music.objectKey) || '.wav'}`)
      await writeFile(bgm, await deps.storage.read(music.objectKey))
    }
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
    const composed = await deps.composer.compose({ clips, voices, audioSources, ambiences, bgm, srt: srtPath, label }, output)
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
    compositionManifest.postProcess = processed.record
    // 选优门留痕:每镜最终入片的版本与它是人工钦定还是自动取最新。
    // 母带用了哪一版必须可回放审计,不允许"选了 A 剪出来是 B"。
    compositionManifest.selections = selections
    // 声音来源同样留痕：母带里这一镜听到的是配音、原声、叠加还是导入文件，
    // 必须能从文件反查回去——否则「双声是哪来的」只能靠重抽猜。
    compositionManifest.audio = audio
    await deps.db.composition.update({
      where: { id: composition.id },
      data: { status: 'COMPLETED', manifest: JSON.stringify(compositionManifest), artifactId: artifact.id, subtitleArtifactId, scoreArtifactId: music?.id ?? null },
    })
  } catch (error) {
    // BLOCKED (not FAILED) keeps the composition retriggerable once the missing clip lands.
    process.stderr.write(`compose ${composition.id} blocked: ${error instanceof Error ? error.message : String(error)}\n`)
    await deps.db.composition.update({ where: { id: composition.id }, data: { status: 'BLOCKED' } })
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

/**
 * The clip this shot cuts with: the human's pinned version when the shot has one,
 * otherwise the shot's own newest clip. Filtering through the batch instead would
 * hand every shot of a batch the same artifact — the mock's byte-identical clips
 * hid that, and a real provider would have composed one shot three times.
 *
 * "Newest" is decided by the owning task's creation time first: `version` counts
 * rework attempts WITHIN one task (a thrice-reworked text-to-video fluke lands at
 * version 3), so ordering by version alone would crown an abandoned fluke over a
 * fresh regeneration that starts a new task at version 1.
 *
 * A pinned id that no longer resolves to a succeeded clip of this exact shot —
 * deleted, superseded, or never this shot's — falls back to the newest rather than
 * blocking the master: the selection is an editorial preference, not a dependency.
 */
async function chosenVideoArtifact(db: PrismaClient, storyboardId: string): Promise<{ artifact: MediaArtifact; source: 'manual' | 'auto' } | null> {
  const shot = await db.storyboard.findUnique({ where: { id: storyboardId }, select: { selectedVideoArtifactId: true } })
  if (shot?.selectedVideoArtifactId) {
    const pinned = await db.mediaArtifact.findFirst({
      where: { id: shot.selectedVideoArtifactId, stage: 'VIDEO', task: { status: 'SUCCEEDED', stage: 'VIDEO', storyboardId } },
    })
    if (pinned) return { artifact: pinned, source: 'manual' }
  }
  const latest = await latestVideoArtifact(db, storyboardId)
  return latest ? { artifact: latest, source: 'auto' } : null
}

async function latestVideoArtifact(db: PrismaClient, storyboardId: string) {
  return db.mediaArtifact.findFirst({
    where: { stage: 'VIDEO', task: { status: 'SUCCEEDED', stage: 'VIDEO', storyboardId } },
    orderBy: [{ task: { createdAt: 'desc' } }, { version: 'desc' }],
  })
}

async function latestVoiceArtifact(db: PrismaClient, storyboardId: string) {
  return db.mediaArtifact.findFirst({
    where: { stage: 'AUDIO', task: { status: 'SUCCEEDED', stage: 'AUDIO', storyboardId } },
    orderBy: [{ task: { createdAt: 'desc' } }, { version: 'desc' }],
  })
}

/** What one shot contributes to the master's audio bed. */
interface ShotAudio {
  /** null = 交回混音层的镜型默认，声音来源这一档没人钦定过。 */
  mode: ShotAudioMode | null
  voiceFile: string | null
  voiceArtifactId: string | null
  /** manifest 里的说法：IMPORTED 与 VOICE 在混音层同档，区别只在人声从哪来。 */
  recordedAs: 'voice' | 'native' | 'voice_native' | 'imported' | 'default'
}

/**
 * 这一镜听到什么：把落库的声音来源翻成混音层的档位，并取回它的人声文件。
 *
 * 钦定了「导入音频」而那个文件不见了（被删、或指针从来没落对），退回镜型默认
 * 而不是把母带卡死——与悬空的成片钦定同一语义：编辑偏好不是依赖。
 */
async function resolveShotAudio(
  deps: PipelineDeps,
  storyboardId: string,
  workdir: string,
  index: number,
  shot: { dialogue: string; audioSource: AudioSource | null; importedVoiceArtifactId: string | null; selectedVoiceArtifactId: string | null } | null,
): Promise<ShotAudio> {
  const dialogue = shot?.dialogue ?? ''
  const stored = shot?.audioSource ?? null
  const needsVoice = stored === null ? dialogue !== '' : stored === 'VOICE' || stored === 'VOICE_NATIVE' || stored === 'IMPORTED'
  let voiceFile: string | null = null
  let voiceArtifactId: string | null = null
  if (needsVoice) {
    // 人声从哪来：钦定「导入音频」就只认那个文件；其余档先看配音版本的人选
    // （selectedVoiceArtifactId），没选才找本镜最新的 TTS 产物、再退到导入件——
    // 无台词镜永远不排 TTS，它的「配音」只能来自导入。
    const imported = shot?.importedVoiceArtifactId
      ? await deps.db.mediaArtifact.findFirst({ where: { id: shot.importedVoiceArtifactId, stage: 'AUDIO' } })
      : null
    const chosen = shot?.selectedVoiceArtifactId
      ? await deps.db.mediaArtifact.findFirst({ where: { id: shot.selectedVoiceArtifactId, stage: 'AUDIO', task: { status: 'SUCCEEDED', storyboardId } } })
      : null
    const artifact = stored === 'IMPORTED' ? imported : (chosen ?? (await latestVoiceArtifact(deps.db, storyboardId)) ?? imported)
    if (artifact) {
      voiceArtifactId = artifact.id
      voiceFile = path.join(workdir, `voice-${index}${path.extname(artifact.objectKey) || '.wav'}`)
      await writeFile(voiceFile, await deps.storage.read(artifact.objectKey))
    }
  }
  if (stored === 'IMPORTED' && !voiceFile) return { mode: null, voiceFile: null, voiceArtifactId: null, recordedAs: 'default' }
  switch (stored) {
    case 'NATIVE':
      return { mode: 'native', voiceFile: null, voiceArtifactId: null, recordedAs: 'native' }
    case 'VOICE_NATIVE':
      return { mode: 'voice_native', voiceFile, voiceArtifactId, recordedAs: 'voice_native' }
    case 'IMPORTED':
      return { mode: 'voice', voiceFile, voiceArtifactId, recordedAs: 'imported' }
    case 'VOICE':
      return { mode: 'voice', voiceFile, voiceArtifactId, recordedAs: 'voice' }
    default:
      return { mode: null, voiceFile, voiceArtifactId, recordedAs: dialogue === '' ? 'native' : 'voice' }
  }
}

/**
 * 这一镜导入的环境音：混音层里它占的是「氛围底」那一格，与上面那档人声来源无关。
 * 文件行不见了（被删、或指针从来没落对）就当没导入过，退回模型原声那条路——
 * 与悬空的配音同一语义：编辑偏好不是依赖。
 */
async function resolveShotAmbience(
  deps: PipelineDeps,
  workdir: string,
  index: number,
  artifactId: string | null,
): Promise<{ file: string | null; artifactId: string | null }> {
  if (!artifactId) return { file: null, artifactId: null }
  const artifact = await deps.db.mediaArtifact.findFirst({ where: { id: artifactId, stage: 'AUDIO' } })
  if (!artifact) return { file: null, artifactId: null }
  const file = path.join(workdir, `ambience-${index}${path.extname(artifact.objectKey) || '.wav'}`)
  await writeFile(file, await deps.storage.read(artifact.objectKey))
  return { file, artifactId: artifact.id }
}

async function latestMusicArtifact(db: PrismaClient, episodeId: string) {
  return db.mediaArtifact.findFirst({
    where: { stage: 'MUSIC', task: { status: 'SUCCEEDED', stage: 'MUSIC', batch: { episodeId } } },
    orderBy: [{ task: { createdAt: 'desc' } }, { version: 'desc' }],
  })
}
