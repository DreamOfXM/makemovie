import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

/**
 * US-014 镜头结构化控制:GET/PATCH /storyboards/:id/creative-controls。
 * 景别/机位/运动三档用枚举白名单(其余自由文本);全部字段可 null(= 自动);
 * PATCH 带 expectedStateRevision 做 CAS——冲突 409 并返回当前 revision,
 * 旧客户端不带 revision 的行为不变(不 CAS,直写)。
 * 旧自由描述(description)不被解析回填到结构化字段;两者独立并存,最终
 * prompt 由描述+控制+风格+参考+调整要求组合——组合逻辑在 pipeline 侧(US-016)。
 */
const ENUM_FIELDS: Record<string, readonly string[]> = {
  framing: ['close_up', 'medium', 'wide', 'extreme_close_up'],
  cameraAngle: ['eye_level', 'low', 'high', 'dutch', 'over_shoulder'],
  cameraMovement: ['static', 'pan', 'tilt', 'dolly', 'handheld'],
}
const TEXT_FIELDS = ['actionStart', 'actionEnd', 'mood', 'negativePrompt'] as const
const ALL_FIELDS = [...Object.keys(ENUM_FIELDS), ...TEXT_FIELDS] as const

type ControlBody = Partial<Record<typeof ALL_FIELDS[number] | 'expectedStateRevision', unknown>>

export async function creativeControlsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { storyboardId: string } }>(
    '/storyboards/:storyboardId/creative-controls',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const storyboard = await app.db.storyboard.findFirst({
        where: { id: request.params.storyboardId, episode: { project: { organizationId: auth.organizationId } } },
        include: { shotControl: true },
      })
      if (!storyboard) return reply.code(404).send({ error: 'storyboard not found' })
      return {
        storyboardId: storyboard.id,
        stateRevision: storyboard.stateRevision,
        controls: storyboard.shotControl === null
          ? Object.fromEntries(ALL_FIELDS.map(field => [field, null]))
          : Object.fromEntries(ALL_FIELDS.map(field => [field, (storyboard.shotControl as unknown as Record<string, string | null>)[field] ?? null])),
      }
    },
  )

  app.patch<{ Params: { storyboardId: string }; Body: ControlBody }>(
    '/storyboards/:storyboardId/creative-controls',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => {
      const auth = request.auth!
      const storyboard = await app.db.storyboard.findFirst({
        where: { id: request.params.storyboardId, episode: { project: { organizationId: auth.organizationId } } },
        include: { shotControl: true },
      })
      if (!storyboard) return reply.code(404).send({ error: 'storyboard not found' })
      if (storyboard.supersededAt) return reply.code(409).send({ error: 'storyboard is superseded' })

      const expected = typeof request.body?.expectedStateRevision === 'number' ? request.body.expectedStateRevision : null
      if (expected !== null && expected !== storyboard.stateRevision) {
        return reply.code(409).send({
          code: 'version_conflict',
          message: `镜头已被他人修改(当前 revision ${storyboard.stateRevision},你预期 ${expected})`,
          scope: [storyboard.id],
          nextAction: 'reload',
          retryable: false,
          billingRisk: 'none',
          stateRevision: storyboard.stateRevision,
        })
      }

      // 枚举白名单校验 + 文本字段透传(null=自动)。
      const values: Record<string, string | null> = {}
      for (const field of ALL_FIELDS) {
        const raw = request.body?.[field]
        if (raw === undefined) continue
        if (raw === null) { values[field] = null; continue }
        if (typeof raw !== 'string') return reply.code(400).send({ error: `${field} must be a string or null` })
        if (field in ENUM_FIELDS) {
          const allowed = ENUM_FIELDS[field]!
          if (!allowed.includes(raw)) return reply.code(400).send({ error: `${field} must be one of ${allowed.join(', ')} or null` })
        }
        values[field] = raw.trim() === '' ? null : raw.trim()
      }
      if (Object.keys(values).length === 0) return reply.code(400).send({ error: 'no control fields to update' })

      const updated = await app.db.$transaction(async tx => {
        const control = storyboard.shotControl === null
          ? await tx.shotControl.create({ data: { storyboardId: storyboard.id, ...values } })
          : await tx.shotControl.update({ where: { storyboardId: storyboard.id }, data: values })
        const shot = await tx.storyboard.update({
          where: { id: storyboard.id },
          data: { stateRevision: { increment: 1 } },
          select: { stateRevision: true },
        })
        return { control, stateRevision: shot.stateRevision }
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId, userId: auth.userId,
        action: 'storyboard.creativeControls', entityType: 'Storyboard', entityId: storyboard.id,
        payload: { values, stateRevision: updated.stateRevision },
      })
      return { storyboardId: storyboard.id, stateRevision: updated.stateRevision, controls: updated.control }
    },
  )
}
