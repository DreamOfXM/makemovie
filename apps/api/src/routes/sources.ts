import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PrismaClient, WorkflowStatus } from '@studio/db'
import { advancePipeline, cascadeScriptApproval, evaluateShotRhythm, measureShotRhythm, resolveShotRhythm, type ShotRhythmGate, type ShotRhythmReadings, type ShotRhythmSettings } from '@studio/pipeline'
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
  archivedAt: Date | null
}

interface ScriptVersionRow extends VersionRow {
  generationTaskId: string | null
  rhythm: string | null
}

interface VersionSummaryDto {
  id: string
  version: number
  checksum: string
  status: WorkflowStatus
  contentLength: number
  archivedAt: string | null
}

interface VersionDto extends VersionSummaryDto {
  content: string
}

/**
 * 批准时的量测快照。存快照而不是每次重算：阈值以后改了，这一版当年按什么尺子
 * 量的不能跟着变；`accepted` 记录的是「门没过，人看过读数后仍然收下」这一次决定。
 */
interface StoredShotRhythm {
  settings: ShotRhythmSettings
  readings: ShotRhythmReadings | null
  gate: ShotRhythmGate
  measuredAt: string
  accepted: boolean
}

interface ShotRhythmDto extends StoredShotRhythm {
  /** live = 按当前正文与项目阈值现算；snapshot = 批准时存下的。 */
  source: 'live' | 'snapshot'
}

interface ScriptVersionSummaryDto extends VersionSummaryDto {
  generationTaskId: string | null
  rhythm: ShotRhythmDto
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

interface ScriptApproveBody {
  /** 门未通过时显式收下这份节奏：只有人看过读数并点头，才允许继续。 */
  acceptRhythm?: boolean
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
    archivedAt: version.archivedAt?.toISOString() ?? null,
  }
}

function toVersionDto(version: VersionRow): VersionDto {
  return { ...toVersionSummary(version), content: version.content }
}

function parseStoredRhythm(raw: string | null): StoredShotRhythm | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const value = parsed as Partial<StoredShotRhythm>
    const settings = resolveShotRhythm(JSON.stringify(value.settings ?? null))
    const readings = value.readings ?? null
    const gate = value.gate && typeof value.gate === 'object' && Array.isArray(value.gate.failures)
      ? { pass: value.gate.pass === true, failures: value.gate.failures }
      : evaluateShotRhythm(readings, settings)
    return { settings, readings, gate, measuredAt: typeof value.measuredAt === 'string' ? value.measuredAt : '', accepted: value.accepted === true }
  } catch {
    return null
  }
}

/**
 * 已存档快照优先，草稿按当前正文与项目阈值现算——写作者在按「批准」之前就该看见
 * 读数，而不是被门拦下才知道。没有分镜表的剧本读数为 null，门视为不适用。
 */
function shotRhythmOf(version: ScriptVersionRow, settings: ShotRhythmSettings): ShotRhythmDto {
  const stored = parseStoredRhythm(version.rhythm)
  if (stored) return { ...stored, source: 'snapshot' }
  const readings = measureShotRhythm(version.content, settings)
  return { settings, readings, gate: evaluateShotRhythm(readings, settings), measuredAt: '', accepted: false, source: 'live' }
}

function toScriptVersionSummary(version: ScriptVersionRow, settings: ShotRhythmSettings): ScriptVersionSummaryDto {
  return { ...toVersionSummary(version), generationTaskId: version.generationTaskId, rhythm: shotRhythmOf(version, settings) }
}

function toScriptVersionDto(version: ScriptVersionRow, settings: ShotRhythmSettings): ScriptVersionDto {
  return { ...toVersionDto(version), generationTaskId: version.generationTaskId, rhythm: shotRhythmOf(version, settings) }
}

async function shotRhythmSettingsFor(db: PrismaClient, projectId: string): Promise<ShotRhythmSettings> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { shotRhythm: true } })
  return resolveShotRhythm(project?.shotRhythm)
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
  async function advanceAfterApproval(request: FastifyRequest, organizationId: string, userId: string | null, episodeId: string): Promise<void> {
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
      // One approved source per episode: approving this version retires the previous
      // approval, so "已通过" always names the single active story the pipeline reads.
      await app.db.sourceDocumentVersion.updateMany({
        where: { episodeId: episode.id, status: 'APPROVED', NOT: { id: approved.id } },
        data: { status: 'DRAFT' },
      })
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
      const settings = await shotRhythmSettingsFor(app.db, episode.projectId)
      // A failed AI derivation must surface where the writer is looking. The copy-draft in
      // this list reads as success, so the error rides along instead of living only in the
      // generation panel's batch rows.
      const lastScriptBatch = await app.db.generationBatch.findFirst({
        where: { episodeId: episode.id, stage: 'SCRIPT' },
        orderBy: { id: 'desc' },
      })
      let lastAiError: { model: string | null; error: string; at: string } | null = null
      if (lastScriptBatch) {
        const failed = await app.db.generationTask.findFirst({
          where: { batchId: lastScriptBatch.id, stage: 'SCRIPT', status: 'FAILED' },
          orderBy: { id: 'desc' },
        })
        if (failed?.errorSnapshot) {
          let message = 'script generation failed'
          try {
            const parsed: unknown = JSON.parse(failed.errorSnapshot)
            message = Array.isArray(parsed) ? parsed.map(String).join(' | ') : String(parsed)
          } catch {
            message = failed.errorSnapshot
          }
          lastAiError = { model: failed.model, error: message.slice(0, 400), at: failed.updatedAt.toISOString() }
        }
      }
      return { versions: versions.map(version => toScriptVersionSummary(version, settings)), lastAiError }
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
      return { version: toScriptVersionDto(version, await shotRhythmSettingsFor(app.db, episode.projectId)) }
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
      const settings = await shotRhythmSettingsFor(app.db, episode.projectId)
      return reply.code(201).send({ version: toScriptVersionDto(created, settings) })
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
      // before downstream stages should rely on them. The rhythm snapshot goes with
      // it — it measured the old words, and a stale reading would clear the gate.
      const updated = await app.db.scriptVersion.update({
        where: { id: current.id },
        data: { content, checksum: checksumOf(content), status: 'DRAFT', rhythm: null },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'script.edit',
        entityType: 'ScriptVersion',
        entityId: updated.id,
        payload: { episodeId: episode.id, version: updated.version, contentLength: content.length },
      })
      return { version: toScriptVersionDto(updated, await shotRhythmSettingsFor(app.db, episode.projectId)) }
    },
  )

  app.post<{ Params: { episodeId: string; version: string }; Body: ScriptApproveBody }>(
    '/episodes/:episodeId/script-versions/:version/approve',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const current = await findScriptVersion(app.db, episode.id, request.params.version)
      if (!current) return reply.code(404).send({ error: 'Script version not found' })
      if (current.status === 'APPROVED') return reply.code(409).send({ error: 'sources:alreadyApproved' })

      // 节奏门只在「剧本自带分镜表」时生效（没有表就读数为 null，门视为不适用）。
      // 它不判好坏，只把读数摆在批准人面前；不显式收下就拦，避免碎镜在无人知情时
      // 流进分镜阶段，最后变成整集的硬切。
      const settings = await shotRhythmSettingsFor(app.db, episode.projectId)
      const readings = measureShotRhythm(current.content, settings)
      const gate = evaluateShotRhythm(readings, settings)
      if (!gate.pass && request.body?.acceptRhythm !== true) {
        return reply.code(409).send({ error: 'script:rhythmGate', rhythm: { settings, readings, gate } })
      }
      const snapshot: StoredShotRhythm = {
        settings,
        readings,
        gate,
        measuredAt: new Date().toISOString(),
        accepted: !gate.pass,
      }

      const approved = await app.db.scriptVersion.update({ where: { id: current.id }, data: { status: 'APPROVED', rhythm: JSON.stringify(snapshot) } })
      // One approved script per episode: this approval retires the previous one, so
      // "已通过" always names the version the pipeline treats as current writing.
      await app.db.scriptVersion.updateMany({
        where: { episodeId: episode.id, status: 'APPROVED', NOT: { id: approved.id } },
        data: { status: 'DRAFT' },
      })
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
        payload: { episodeId: episode.id, version: approved.version, storyboardsUpdated: repointed.count, rhythm: readings },
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
      return { version: toScriptVersionDto(approved, settings), storyboardsUpdated: repointed.count, cascaded: cascade.cascaded }
    },
  )

  // Archive/unarchive: an approved version leaves the active list without losing its
  // lineage. Fully reversible — unarchive restores whatever status it had.
  app.post<{ Params: { episodeId: string; version: string }; Body: { archived?: boolean } }>(
    '/episodes/:episodeId/script-versions/:version/archive',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const current = await findScriptVersion(app.db, episode.id, request.params.version)
      if (!current) return reply.code(404).send({ error: 'Script version not found' })
      const archived = request.body?.archived !== false
      const updated = await app.db.scriptVersion.update({ where: { id: current.id }, data: { archivedAt: archived ? new Date() : null } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'script.archive',
        entityType: 'ScriptVersion',
        entityId: updated.id,
        payload: { episodeId: episode.id, version: updated.version, archived },
      })
      return { version: toScriptVersionDto(updated, await shotRhythmSettingsFor(app.db, episode.projectId)) }
    },
  )

  // Delete is for drafts only: approved versions are retired via archive, and versions
  // that storyboards trace can never go away without breaking their lineage.
  app.delete<{ Params: { episodeId: string; version: string } }>(
    '/episodes/:episodeId/script-versions/:version',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const current = await findScriptVersion(app.db, episode.id, request.params.version)
      if (!current) return reply.code(404).send({ error: 'Script version not found' })
      if (current.status === 'APPROVED') return reply.code(409).send({ error: 'sources:deleteApproved' })
      const referenced = await app.db.storyboard.findFirst({ where: { scriptVersionId: current.id } })
      if (referenced) return reply.code(409).send({ error: 'sources:scriptInUse' })
      await app.db.scriptVersion.delete({ where: { id: current.id } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'script.delete',
        entityType: 'ScriptVersion',
        entityId: current.id,
        payload: { episodeId: episode.id, version: current.version },
      })
      return reply.code(204).send()
    },
  )

  app.post<{ Params: { episodeId: string; version: string }; Body: { archived?: boolean } }>(
    '/episodes/:episodeId/source-versions/:version/archive',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const current = await findSourceVersion(app.db, episode.id, request.params.version)
      if (!current) return reply.code(404).send({ error: 'Source version not found' })
      const archived = request.body?.archived !== false
      const updated = await app.db.sourceDocumentVersion.update({ where: { id: current.id }, data: { archivedAt: archived ? new Date() : null } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'source.archive',
        entityType: 'SourceDocumentVersion',
        entityId: updated.id,
        payload: { episodeId: episode.id, version: updated.version, archived },
      })
      return { version: toVersionDto(updated) }
    },
  )

  app.delete<{ Params: { episodeId: string; version: string } }>(
    '/episodes/:episodeId/source-versions/:version',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const current = await findSourceVersion(app.db, episode.id, request.params.version)
      if (!current) return reply.code(404).send({ error: 'Source version not found' })
      if (current.status === 'APPROVED') return reply.code(409).send({ error: 'sources:deleteApproved' })
      await app.db.sourceDocumentVersion.delete({ where: { id: current.id } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'source.delete',
        entityType: 'SourceDocumentVersion',
        entityId: current.id,
        payload: { episodeId: episode.id, version: current.version },
      })
      return reply.code(204).send()
    },
  )
}
