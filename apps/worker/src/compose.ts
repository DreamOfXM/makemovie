import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { PrismaClient } from '@studio/db'
import type { ComposeEpisodePayload } from '@studio/jobs'
import { buildObjectKey, buildSrt, probeDuration, type SubtitleEntry } from '@studio/media'
import { manifestStoryboardIds } from '@studio/pipeline'
import type { PipelineDeps } from './deps.js'

const COMPOSITION_VERSION = 1

export async function composeEpisode(payload: ComposeEpisodePayload, deps: PipelineDeps): Promise<void> {
  const composition = await deps.db.composition.findUnique({ where: { id: payload.compositionId }, include: { episode: true } })
  if (!composition) throw new Error(`composition ${payload.compositionId} not found`)

  const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-episode-'))
  try {
    const clips: string[] = []
    const voices: (string | null)[] = []
    const subtitles: SubtitleEntry[] = []
    let cursorMs = 0
    for (const [index, storyboardId] of manifestStoryboardIds(composition.manifest).entries()) {
      const shot = await deps.db.storyboard.findUnique({ where: { id: storyboardId }, select: { dialogue: true } })
      const source = await latestVideoArtifact(deps.db, storyboardId)
      if (!source) throw new Error(`storyboard ${storyboardId} has no succeeded video artifact`)
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
    const composed = await deps.composer.compose({ clips, voices, bgm, srt: srtPath }, output)
    const objectKey = buildObjectKey({
      tenantId: payload.organizationId,
      projectId: composition.episode.projectId,
      episodeId: composition.episodeId,
      stage: 'COMPOSITION',
      entityId: composition.id,
      version: COMPOSITION_VERSION,
      extension: 'mp4',
    })
    const stored = await deps.storage.put(objectKey, new Uint8Array(await readFile(output)), 'video/mp4')
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
      await deps.db.mediaArtifact.create({
        data: {
          organizationId: payload.organizationId,
          stage: 'SUBTITLE',
          objectKey: storedSrt.key,
          checksum: storedSrt.checksum,
          mimeType: storedSrt.mimeType,
          version: COMPOSITION_VERSION,
        },
      })
    }
    await deps.db.composition.update({ where: { id: composition.id }, data: { status: 'COMPLETED', artifactId: artifact.id } })
  } catch (error) {
    // BLOCKED (not FAILED) keeps the composition retriggerable once the missing clip lands.
    process.stderr.write(`compose ${composition.id} blocked: ${error instanceof Error ? error.message : String(error)}\n`)
    await deps.db.composition.update({ where: { id: composition.id }, data: { status: 'BLOCKED' } })
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

/**
 * The shot's own newest clip. Filtering through the batch instead would hand every
 * shot of a batch the same artifact — the mock's byte-identical clips hid that, and
 * a real provider would have composed one shot three times.
 */
async function latestVideoArtifact(db: PrismaClient, storyboardId: string) {
  return db.mediaArtifact.findFirst({
    where: { stage: 'VIDEO', task: { status: 'SUCCEEDED', stage: 'VIDEO', storyboardId } },
    orderBy: { version: 'desc' },
  })
}

async function latestVoiceArtifact(db: PrismaClient, storyboardId: string) {
  return db.mediaArtifact.findFirst({
    where: { stage: 'AUDIO', task: { status: 'SUCCEEDED', stage: 'AUDIO', storyboardId } },
    orderBy: { version: 'desc' },
  })
}

async function latestMusicArtifact(db: PrismaClient, episodeId: string) {
  return db.mediaArtifact.findFirst({
    where: { stage: 'MUSIC', task: { status: 'SUCCEEDED', stage: 'MUSIC', batch: { episodeId } } },
    orderBy: { version: 'desc' },
  })
}
