import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, WorkflowStatus } from '@studio/db'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

const maxContentLength = 200_000

// SourceDocumentVersion and ScriptVersion carry the same columns, so one pair of
// DTOs serves both.
interface VersionRow {
  id: string
  version: number
  content: string
  checksum: string
  status: WorkflowStatus
}

interface VersionSummaryDto {
  id: string
  version: number
  checksum: string
  status: WorkflowStatus
  contentLength: number
}

interface VersionDto extends VersionSummaryDto {
  content: string
}

interface SourceBody {
  content?: string
}

interface ScriptBody {
  sourceVersion?: number
}

async function findEpisodeInOrg(db: PrismaClient, episodeId: string, organizationId: string) {
  return db.episode.findFirst({ where: { id: episodeId, project: { organizationId } } })
}

function parseVersion(value: string): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null
}

function checksumOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// The list stays cheap: content is only ever returned for a single version.
function toVersionSummary(version: VersionRow): VersionSummaryDto {
  return {
    id: version.id,
    version: version.version,
    checksum: version.checksum,
    status: version.status,
    contentLength: version.content.length,
  }
}

function toVersionDto(version: VersionRow): VersionDto {
  return { ...toVersionSummary(version), content: version.content }
}

async function findSourceVersion(db: PrismaClient, episodeId: string, raw: string) {
  const version = parseVersion(raw)
  if (version === null) return null
  return db.sourceDocumentVersion.findFirst({ where: { episodeId, version } })
}

async function findScriptVersion(db: PrismaClient, episodeId: string, raw: string) {
  const version = parseVersion(raw)
  if (version === null) return null
  return db.scriptVersion.findFirst({ where: { episodeId, version } })
}

export async function sourceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/source-versions',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const versions = await app.db.sourceDocumentVersion.findMany({ where: { episodeId: episode.id }, orderBy: { version: 'desc' } })
      return { versions: versions.map(toVersionSummary) }
    },
  )

  app.get<{ Params: { episodeId: string; version: string } }>(
    '/episodes/:episodeId/source-versions/:version',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const version = await findSourceVersion(app.db, episode.id, request.params.version)
      if (!version) return reply.code(404).send({ error: 'Source version not found' })
      return { version: toVersionDto(version) }
    },
  )

  app.post<{ Params: { episodeId: string }; Body: SourceBody }>(
    '/episodes/:episodeId/source-versions',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })

      // Stored verbatim so the checksum always describes the bytes uploaded.
      const content = request.body?.content
      if (typeof content !== 'string' || !content.trim()) return reply.code(400).send({ error: 'content is required' })
      if (content.length > maxContentLength) return reply.code(400).send({ error: `content must not exceed ${maxContentLength} characters` })

      const checksum = checksumOf(content)
      const latest = await app.db.sourceDocumentVersion.findFirst({ where: { episodeId: episode.id }, orderBy: { version: 'desc' } })
      if (latest?.checksum === checksum) return reply.code(409).send({ error: 'sources:duplicate' })

      const created = await app.db.sourceDocumentVersion.create({
        data: { episodeId: episode.id, version: (latest?.version ?? 0) + 1, content, checksum, status: 'DRAFT' },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'source.upload',
        entityType: 'SourceDocumentVersion',
        entityId: created.id,
        payload: { episodeId: episode.id, version: created.version, checksum: created.checksum, contentLength: created.content.length },
      })
      return reply.code(201).send({ version: toVersionDto(created) })
    },
  )

  app.post<{ Params: { episodeId: string; version: string } }>(
    '/episodes/:episodeId/source-versions/:version/approve',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const current = await findSourceVersion(app.db, episode.id, request.params.version)
      if (!current) return reply.code(404).send({ error: 'Source version not found' })
      if (current.status === 'APPROVED') return reply.code(409).send({ error: 'sources:alreadyApproved' })

      const approved = await app.db.sourceDocumentVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'source.approve',
        entityType: 'SourceDocumentVersion',
        entityId: approved.id,
        payload: { episodeId: episode.id, version: approved.version },
      })
      return { version: toVersionDto(approved) }
    },
  )

  app.get<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/script-versions',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const versions = await app.db.scriptVersion.findMany({ where: { episodeId: episode.id }, orderBy: { version: 'desc' } })
      return { versions: versions.map(toVersionSummary) }
    },
  )

  app.post<{ Params: { episodeId: string }; Body: ScriptBody }>(
    '/episodes/:episodeId/script-versions',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })

      const requested = request.body?.sourceVersion
      const source = Number.isInteger(requested) && (requested as number) >= 1
        ? await app.db.sourceDocumentVersion.findFirst({ where: { episodeId: episode.id, version: requested as number } })
        : null
      if (!source || source.status !== 'APPROVED') return reply.code(409).send({ error: 'sources:sourceNotApproved' })

      const latest = await app.db.scriptVersion.findFirst({ where: { episodeId: episode.id }, orderBy: { version: 'desc' } })
      const created = await app.db.scriptVersion.create({
        data: { episodeId: episode.id, version: (latest?.version ?? 0) + 1, content: source.content, checksum: source.checksum, status: 'DRAFT' },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'script.derive',
        entityType: 'ScriptVersion',
        entityId: created.id,
        payload: { episodeId: episode.id, version: created.version, sourceVersion: source.version },
      })
      return reply.code(201).send({ version: toVersionDto(created) })
    },
  )

  app.post<{ Params: { episodeId: string; version: string } }>(
    '/episodes/:episodeId/script-versions/:version/approve',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const current = await findScriptVersion(app.db, episode.id, request.params.version)
      if (!current) return reply.code(404).send({ error: 'Script version not found' })
      if (current.status === 'APPROVED') return reply.code(409).send({ error: 'sources:alreadyApproved' })

      const approved = await app.db.scriptVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } })
      // Approving a script makes it the episode's current writing: every
      // storyboard is re-pointed at it so downstream stages trace one version.
      const repointed = await app.db.storyboard.updateMany({ where: { episodeId: episode.id }, data: { scriptVersionId: approved.id } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'script.approve',
        entityType: 'ScriptVersion',
        entityId: approved.id,
        payload: { episodeId: episode.id, version: approved.version, storyboardsUpdated: repointed.count },
      })
      return { version: toVersionDto(approved), storyboardsUpdated: repointed.count }
    },
  )
}
