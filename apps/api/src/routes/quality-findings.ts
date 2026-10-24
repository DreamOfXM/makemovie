import type { FastifyInstance } from 'fastify'
import { runTechnicalCheck, type TechnicalFinding } from '@studio/media'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'
import { apiError } from '../lib/api-error.js'
import { saveTechnicalReview } from '../lib/quality-findings.js'

/**
 * US-034 质量问题队列与人工裁决。
 * POST /episodes/:id/reviews —— 对最新合成母带跑技术质量检查,findings 落 manifest
 * 的同时 upsert 成 QualityFinding 行(manifest 是快照,行是可裁决队列)。
 * GET /episodes/:id/quality-findings —— 读最新合成快照的 findings 行;合成指纹追不上
 * 当前编辑 head 时惰性把该合成上的裁决整体标 stale(落库,审计可查)。
 * PATCH /quality-findings/:id —— 人工裁决(accept=带理由接受 / resolve=已修复)。
 */

/** 裁决有效性边界:composition 的 inputFingerprint,无编辑链接时以 composition 身份兜底。 */
function snapshotFingerprint(composition: { id: string; inputFingerprint: string | null }): string {
  return composition.inputFingerprint ?? composition.id
}

function toFindingDto(row: {
  id: string; findingKey: string; dimension: string; severity: string; message: string
  evidenceTimeSeconds: number | null; artifactId: string | null; storyboardId: string | null
  status: string; decidedBy: string | null; reason: string | null; createdAt: Date; updatedAt: Date
}) {
  return {
    id: row.id,
    findingKey: row.findingKey,
    dimension: row.dimension,
    severity: row.severity,
    message: row.message,
    evidenceTimeSeconds: row.evidenceTimeSeconds,
    artifactId: row.artifactId,
    storyboardId: row.storyboardId,
    status: row.status,
    decidedBy: row.decidedBy,
    reason: row.reason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function qualityFindingRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/reviews',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } } })
      if (!episode) return reply.code(404).send({ error: 'episode not found' })

      const composition = await app.db.composition.findFirst({
        where: { episodeId: episode.id, status: 'COMPLETED', artifactId: { not: null } },
        orderBy: { id: 'desc' },
      })
      if (!composition?.artifactId) return reply.code(409).send({ error: 'no completed composition to review' })
      const artifact = await app.db.mediaArtifact.findUnique({ where: { id: composition.artifactId } })
      if (!artifact) return reply.code(409).send({ error: 'composition artifact missing' })

      // 读文件跑技术检查——存储读出临时文件。
      const bytes = await app.storage.read(artifact.objectKey)
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const os = (await import('node:os')).default
      const path = (await import('node:path')).default
      const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-review-'))
      try {
        const filePath = path.join(workdir, 'master.mp4')
        await writeFile(filePath, bytes)
        const result = await runTechnicalCheck(filePath, { expectedDurationMs: artifact.durationMs ?? undefined })
        await saveTechnicalReview(app.db, composition, artifact, result)
        const fingerprint = snapshotFingerprint(composition)

        await recordAudit(app.db, {
          organizationId: auth.organizationId, userId: auth.userId,
          action: 'review_completed', entityType: 'Composition', entityId: composition.id,
          payload: { findings: result.findings.length, passed: result.passed, fingerprint },
        })
        return { compositionId: composition.id, passed: result.passed, findings: result.findings }
      } finally {
        await rm(workdir, { recursive: true, force: true })
      }
    },
  )

  app.get<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/quality-findings',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } } })
      if (!episode) return reply.code(404).send({ error: 'episode not found' })
      const composition = await app.db.composition.findFirst({
        where: { episodeId: episode.id, status: 'COMPLETED' },
        orderBy: { id: 'desc' },
      })
      if (!composition) return reply.code(404).send({ error: 'no composition' })

      // 惰性过期(§11.1):合成绑定的编辑指纹追不上当前 head 时,该合成上的一切裁决
      // 作废——重渲染后的母带不是裁决时看到的母带。落库为 stale,审计可查。
      const edit = await app.db.episodeEdit.findUnique({ where: { episodeId: episode.id } })
      const headRevision = edit && edit.headRevision > 0
        ? await app.db.episodeEditRevision.findUnique({ where: { editId_revision: { editId: edit.id, revision: edit.headRevision } } })
        : null
      const headFingerprint = headRevision?.fingerprint ?? null
      const stale = composition.inputFingerprint !== null && headFingerprint !== null && composition.inputFingerprint !== headFingerprint
      if (stale) {
        await app.db.qualityFinding.updateMany({
          where: { compositionId: composition.id, status: { in: ['open', 'accepted', 'resolved'] } },
          data: { status: 'stale' },
        })
      }

      const rows = await app.db.qualityFinding.findMany({ where: { compositionId: composition.id }, orderBy: { findingKey: 'asc' } })
      const manifest = JSON.parse(composition.manifest) as { qualityCheckPassed?: boolean; qualityFindings?: TechnicalFinding[] }
      return {
        compositionId: composition.id,
        passed: manifest.qualityCheckPassed ?? null,
        fingerprint: composition.inputFingerprint,
        currentFingerprint: headFingerprint,
        stale,
        findings: rows.map(toFindingDto),
      }
    },
  )

  app.patch<{ Params: { id: string }; Body: { action?: unknown; reason?: unknown } }>(
    '/quality-findings/:id',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const action = request.body?.action
      const reason = request.body?.reason
      if (action !== 'accept' && action !== 'resolve') {
        const { body } = apiError('invalid_argument', "action must be 'accept' or 'resolve'")
        return reply.code(400).send(body)
      }
      if (typeof reason !== 'string' || !reason.trim()) {
        const { body } = apiError('invalid_argument', 'reason is required and must be a non-empty string')
        return reply.code(400).send(body)
      }
      const trimmed = reason.trim()

      const finding = await app.db.qualityFinding.findUnique({ where: { id: request.params.id } })
      if (!finding) return reply.code(404).send({ error: 'quality finding not found' })
      // 组织归属:行不带关系,经 episode→project 校验;跨组织视同不存在。
      const episode = await app.db.episode.findFirst({ where: { id: finding.episodeId, project: { organizationId: auth.organizationId } } })
      if (!episode || finding.organizationId !== auth.organizationId) {
        return reply.code(404).send({ error: 'quality finding not found' })
      }

      // stale(已被标记,或事实上绑定旧指纹而尚未被惰性标记):证据属于旧渲染快照,
      // 不能沿用裁决,必须对当前母带重新检查出具新证据。
      const composition = await app.db.composition.findUnique({ where: { id: finding.compositionId } })
      const outdated = finding.status === 'stale'
        || (composition !== null && composition.inputFingerprint !== null && finding.fingerprint !== composition.inputFingerprint)
      if (outdated) {
        const { body } = apiError('version_conflict', '该质量问题绑定的是旧渲染快照,证据已过期——请对当前母带重新执行技术检查后再裁决', { nextAction: 'review' })
        return reply.code(409).send(body)
      }
      if (action === 'accept' && finding.status === 'accepted') {
        const { body } = apiError('state_conflict', '该问题已被接受,不能重复接受')
        return reply.code(409).send(body)
      }

      const updated = await app.db.qualityFinding.update({
        where: { id: finding.id },
        data: { status: action === 'accept' ? 'accepted' : 'resolved', decidedBy: auth.userId, reason: trimmed },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId, userId: auth.userId,
        action: action === 'accept' ? 'quality-finding.accept' : 'quality-finding.resolve',
        entityType: 'QualityFinding', entityId: finding.id,
        payload: { findingKey: finding.findingKey, fingerprint: finding.fingerprint, reason: trimmed },
      })
      return { finding: toFindingDto(updated) }
    },
  )
}
