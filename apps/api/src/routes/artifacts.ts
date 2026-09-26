import type { FastifyInstance } from 'fastify'
import type { MediaArtifact } from '@studio/db'
import { requirePermission } from '../plugins/auth.js'

export interface ArtifactDto {
  id: string
  mimeType: string
  objectKey: string
  /** Which attempt of this object this is. The shot history writes 「v2」, so the number
   * has to come from the row rather than from counting the list in the browser. */
  version: number
  width: number | null
  height: number | null
  durationMs: number | null
  downloadUrl: string
  /** 人工导入件的原始文件名。对象键是按租户/项目/阶段重建的路径，人对着它认不出自己
   *  传的是哪个文件；只有导入那一档带这个名字，生成产物永远是 null。 */
  filename: string | null
}

export function toArtifactDto(artifact: MediaArtifact): ArtifactDto {
  return {
    id: artifact.id,
    mimeType: artifact.mimeType,
    objectKey: artifact.objectKey,
    version: artifact.version,
    width: artifact.width,
    height: artifact.height,
    durationMs: artifact.durationMs,
    downloadUrl: `/artifacts/${artifact.id}/content`,
    filename: importedFilename(artifact.metadata),
  }
}

function importedFilename(metadata: string | null): string | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata) as { filename?: unknown }
    return typeof parsed.filename === 'string' ? parsed.filename : null
  } catch {
    return null
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
      const stored = await app.storage.open(artifact.objectKey)
      if (!stored) return reply.code(404).send({ error: 'artifact file not found' })
      reply.header('content-type', artifact.mimeType)
      reply.header('content-length', String(stored.sizeBytes))
      return reply.send(stored.body)
    },
  )
}
