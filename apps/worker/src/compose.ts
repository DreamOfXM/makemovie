import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { MediaArtifact, PrismaClient } from '@studio/db'
import type { ComposeEpisodePayload } from '@studio/jobs'
import { buildObjectKey, buildSrt, probeDuration, type SubtitleEntry } from '@studio/media'
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
    const subtitles: SubtitleEntry[] = []
    const selections: Record<string, { artifactId: string; source: 'manual' | 'auto' }> = {}
    let cursorMs = 0
    for (const [index, storyboardId] of manifestStoryboardIds(composition.manifest).entries()) {
      const shot = await deps.db.storyboard.findUnique({ where: { id: storyboardId }, select: { dialogue: true } })
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
      if (dialogue !== '') {
        const voice = await latestVoiceArtifact(deps.db, storyboardId)
        if (voice) {
          const voiceFile = path.join(workdir, `voice-${index}${path.extname(voice.objectKey) || '.wav'}`)
          await writeFile(voiceFile, await deps.storage.read(voice.objectKey))
          voices.push(voiceFile)
        } else {
          voices.push(null)
        }
        subtitles.push({ text: dialogue, fromMs: cursorMs, toMs: cursorMs + durationMs })
      } else {
        voices.push(null)
      }
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
    const composed = await deps.composer.compose({ clips, voices, bgm, srt: srtPath, label }, output)
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

async function latestMusicArtifact(db: PrismaClient, episodeId: string) {
  return db.mediaArtifact.findFirst({
    where: { stage: 'MUSIC', task: { status: 'SUCCEEDED', stage: 'MUSIC', batch: { episodeId } } },
    orderBy: [{ task: { createdAt: 'desc' } }, { version: 'desc' }],
  })
}
