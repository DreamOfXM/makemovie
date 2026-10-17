import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'
import { apiError } from '../lib/api-error.js'

/**
 * US-015 参考版本与锁定规则。
 * PATCH /storyboards/:id/locks:人工锁定/解锁视频选版、配音选版、参考版本。
 * 锁定语义:后台返回、自动重跑、Agent 回调均不得替换锁定的选择——解锁是显式
 * 人工操作;无权限不能解锁。stateRevision 做 CAS(与 US-014 同一版本字段)。
 * 
 * 管线侧:compose 的 chosenVideoArtifact 在锁定时只认钦定 id(不回落 latest);
 * worker 的自动重跑在锁定时跳过该镜。latest 回退只在「从未有过可用结果」时
 * 允许(US-002 FR-E02 的 apply_if_empty 语义)。
 */
interface LockBody {
  lockedVideoSelection?: unknown
  lockedVoiceSelection?: unknown
  lockedReferences?: unknown
  expectedStateRevision?: unknown
}

const LOCK_FIELDS = ['lockedVideoSelection', 'lockedVoiceSelection', 'lockedReferences'] as const

export async function selectionLockRoutes(app: FastifyInstance): Promise<void> {
  app.patch<{ Params: { storyboardId: string }; Body: LockBody }>(
    '/storyboards/:storyboardId/locks',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => {
      const auth = request.auth!
      const storyboard = await app.db.storyboard.findFirst({
        where: { id: request.params.storyboardId, episode: { project: { organizationId: auth.organizationId } } },
      })
      if (!storyboard) return reply.code(404).send({ error: 'storyboard not found' })
      if (storyboard.supersededAt) return reply.code(409).send({ error: 'storyboard is superseded' })

      const expected = typeof request.body?.expectedStateRevision === 'number' ? request.body.expectedStateRevision : null
      if (expected !== null && expected !== storyboard.stateRevision) {
        const { body } = apiError('version_conflict', `镜头已被修改(当前 revision ${storyboard.stateRevision})`, { scope: [storyboard.id], nextAction: 'reload' })
        return reply.code(409).send({ ...body, stateRevision: storyboard.stateRevision })
      }

      const values: Record<string, boolean> = {}
      for (const field of LOCK_FIELDS) {
        const raw = request.body?.[field]
        if (raw === undefined) continue
        if (typeof raw !== 'boolean') return reply.code(400).send({ error: `${field} must be a boolean` })
        values[field] = raw
      }
      if (Object.keys(values).length === 0) return reply.code(400).send({ error: 'no lock fields to update' })

      const updated = await app.db.$transaction(async tx => {
        const shot = await tx.storyboard.update({
          where: { id: storyboard.id },
          data: { ...values, stateRevision: { increment: 1 } },
          select: { stateRevision: true, lockedVideoSelection: true, lockedVoiceSelection: true, lockedReferences: true },
        })
        return shot
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId, userId: auth.userId,
        action: 'storyboard.locks', entityType: 'Storyboard', entityId: storyboard.id,
        payload: { values, stateRevision: updated.stateRevision },
      })
      return { storyboardId: storyboard.id, stateRevision: updated.stateRevision, ...Object.fromEntries(LOCK_FIELDS.map(field => [field, updated[field]])) }
    },
  )
}
