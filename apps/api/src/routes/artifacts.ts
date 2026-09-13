import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import type { MediaArtifact } from '@studio/db'
import { DiskStorage } from '@studio/media'
import { requirePermission } from '../plugins/auth.js'

export interface ArtifactDto {
  id: string
  mimeType: string
  objectKey: string
  width: number | null
  height: number | null
  durationMs: number | null
  downloadUrl: string
}

export function toArtifactDto(artifact: MediaArtifact): ArtifactDto {
  return {
    id: artifact.id,
    mimeType: artifact.mimeType,
    objectKey: artifact.objectKey,
    width: artifact.width,
    height: artifact.height,
    durationMs: artifact.durationMs,
    downloadUrl: `/artifacts/${artifact.id}/content`,
  }
}

export async function artifactRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { artifactId: string } }>(
    '/artifacts/:artifactId/content',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const artifact = await app.db.mediaArtifact.findFirst({ where: { id: request.params.artifactId, organizationId: auth.organizationId } })
      if (!artifact) return reply.code(404).send({ error: 'artifact not found' })
      const storage = new DiskStorage(app.config.artifactsDir)
      if (!(await storage.exists(artifact.objectKey))) return reply.code(404).send({ error: 'artifact file not found' })
      const file = storage.localPath(artifact.objectKey)
      const stats = await stat(file)
      reply.header('content-type', artifact.mimeType)
      reply.header('content-length', String(stats.size))
      return reply.send(createReadStream(file))
    },
  )
}
