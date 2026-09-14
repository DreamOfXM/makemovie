import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { PrismaClient } from '@studio/db'
import type { ComposeEpisodePayload } from '@studio/jobs'
import { buildObjectKey } from '@studio/media'
import { manifestStoryboardIds } from '@studio/pipeline'
import type { PipelineDeps } from './deps.js'

const COMPOSITION_VERSION = 1

export async function composeEpisode(payload: ComposeEpisodePayload, deps: PipelineDeps): Promise<void> {
  const composition = await deps.db.composition.findUnique({ where: { id: payload.compositionId }, include: { episode: true } })
  if (!composition) throw new Error(`composition ${payload.compositionId} not found`)

  const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-episode-'))
  try {
    const clips: string[] = []
    for (const [index, storyboardId] of manifestStoryboardIds(composition.manifest).entries()) {
      const source = await latestVideoArtifact(deps.db, storyboardId)
      if (!source) throw new Error(`storyboard ${storyboardId} has no succeeded video artifact`)
      const clip = path.join(workdir, `clip-${index}${path.extname(source.objectKey) || '.bin'}`)
      await writeFile(clip, await deps.storage.read(source.objectKey))
      clips.push(clip)
    }

    const output = path.join(workdir, 'composition.mp4')
    const composed = await deps.composer.compose(clips, output)
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
