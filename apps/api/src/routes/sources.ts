import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PrismaClient, WorkflowStatus } from '@studio/db'
import { advancePipeline, cascadeScriptApproval } from '@studio/pipeline'
import { recordAudit } from '../lib/audit.js'
import { pipelineJobs } from '../lib/jobs.js'
import { requirePermission } from '../plugins/auth.js'

const maxContentLength = 200_000

// SourceDocumentVersion and ScriptVersion carry the same columns except for the
// script's lineage back to the task that wrote it, so the script DTOs extend the
// shared ones instead of restating them.
interface VersionRow {
  id: string
  version: number
  content: string
  checksum: string
  status: WorkflowStatus
}

interface ScriptVersionRow extends VersionRow {
  generationTaskId: string | null
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

interface ScriptVersionSummaryDto extends VersionSummaryDto {
  generationTaskId: string | null
}

interface ScriptVersionDto extends ScriptVersionSummaryDto {
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

function toScriptVersionSummary(version: ScriptVersionRow): ScriptVersionSummaryDto {
  return { ...toVersionSummary(version), generationTaskId: version.generationTaskId }
}

function toScriptVersionDto(version: ScriptVersionRow): ScriptVersionDto {
  return { ...toVersionDto(version), generationTaskId: version.generationTaskId }
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
  const enqueueJob = pipelineJobs(app)

  // An approval is the checkpoint the chain waits at, so opening it should let the
  // chain run on instead of waiting for a second click on **Advance pipeline**.
  // Best effort for the same reason the cascade is: the approval is already
  // persisted, so a next step that could not be started is logged, never thrown
  // back as a failed approval.
  async function advanceAfterApproval(request: FastifyRequest, organizationId: string, userId: string, episodeId: string): Promise<void> {
    try {
      await advancePipeline({ db: app.db, enqueueJob }, organizationId, userId, episodeId)
    } catch (error) {
      request.log.warn({ episodeId, error: error instanceof Error ? error.message : String(error) }, 'pipeline did not advance after approval')
    }
  }

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
      // Approving the source is what unblocks SCRIPT, so the chain starts here.
      await advanceAfterApproval(request, auth.organizationId, auth.userId, episode.id)
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
      return { versions: versions.map(toScriptVersionSummary) }
    },
  )

  app.get<{ Params: { episodeId: string; version: string } }>(
    '/episodes/:episodeId/script-versions/:version',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const version = await findScriptVersion(app.db, episode.id, request.params.version)
      if (!version) return reply.code(404).send({ error: 'Script version not found' })
      return { version: toScriptVersionDto(version) }
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
      return reply.code(201).send({ version: toScriptVersionDto(created) })
    },
  )

  app.patch<{ Params: { episodeId: string; version: string }; Body: { content?: string } }>(
    '/episodes/:episodeId/script-versions/:version',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const current = await findScriptVersion(app.db, episode.id, request.params.version)
      if (!current) return reply.code(404).send({ error: 'Script version not found' })

      const content = request.body?.content
      if (typeof content !== 'string' || !content.trim()) return reply.code(400).send({ error: 'content is required' })
      if (content.length > maxContentLength) return reply.code(400).send({ error: `content must not exceed ${maxContentLength} characters` })

      // Editing invalidates any prior approval: the changed words need re-approval
      // before downstream stages should rely on them.
      const updated = await app.db.scriptVersion.update({
        where: { id: current.id },
        data: { content, checksum: checksumOf(content), status: 'DRAFT' },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'script.edit',
        entityType: 'ScriptVersion',
        entityId: updated.id,
        payload: { episodeId: episode.id, version: updated.version, contentLength: content.length },
      })
      return { version: toScriptVersionDto(updated) }
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
      // The cascade decides from the script version the live shots currently trace,
      // so it has to run before they are re-pointed at the one being approved.
      const cascade = await cascadeScriptApproval({ db: app.db, enqueueJob }, auth.organizationId, auth.userId, episode.id, approved.id)
      // Approving a script makes it the episode's current writing, so the shots that
      // stay live are re-pointed at it and downstream stages trace one version. A
      // cascade skips that: the shots it is regenerating are about to be superseded,
      // and stamping them would make a breakdown claim it came from words it never
      // saw. The new revision carries the approved version itself, written by the
      // worker from the task's request snapshot.
      const repointed = cascade.cascaded
        ? { count: 0 }
        : await app.db.storyboard.updateMany({ where: { episodeId: episode.id, supersededAt: null }, data: { scriptVersionId: approved.id } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'script.approve',
        entityType: 'ScriptVersion',
        entityId: approved.id,
        payload: { episodeId: episode.id, version: approved.version, storyboardsUpdated: repointed.count },
      })
      if (cascade.cascaded) {
        await recordAudit(app.db, {
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: 'script.approve.cascade',
          entityType: 'ScriptVersion',
          entityId: approved.id,
          payload: { episodeId: episode.id, version: approved.version, stage: 'STORYBOARD', batchId: cascade.batchId },
        })
      } else if (cascade.error !== null) {
        // Best effort: the approval stands on its own, so a downstream re-run that
        // could not be started is logged for the operator instead of failing it.
        request.log.warn({ episodeId: episode.id, scriptVersionId: approved.id, error: cascade.error }, 'script approval did not cascade')
      } else {
        // Nothing to regenerate, so the approval simply opened the STORYBOARD gate:
        // let the chain run through it. A cascade already started the next step.
        await advanceAfterApproval(request, auth.organizationId, auth.userId, episode.id)
      }
      return { version: toScriptVersionDto(approved), storyboardsUpdated: repointed.count, cascaded: cascade.cascaded }
    },
  )
}
