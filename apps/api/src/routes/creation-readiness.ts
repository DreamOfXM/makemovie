import type { FastifyInstance } from 'fastify'
import { wiredRequiredSlots, type CapabilitySlot } from '@studio/domain'
import { listCatalogs } from '@studio/providers'
import { gapSlots, planAutoBind, readyCount, requiredSlotCoverage, slotReadiness, minimumConnections } from '@studio/domain'
import { loadOrgModelPool, createBinding } from '../lib/bindings.js'
import { recommendedForPredicate } from './bindings.js'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

/**
 * US-009 创作就绪度(§14 GET /projects/:id/creation-readiness):把「模型配没配」
 * 回答成一个可执行的动作清单——每档给缺口、推荐候选(来自已连厂商的目录推荐,
 * 不按名字猜行为)、以及下一步;凭据永远不返回。推荐配置的版本=目录版本,可追溯。
 */
export async function creationReadinessRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/creation-readiness',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'project not found' })
      const { connections, bindings } = await loadOrgModelPool(app.db, auth.organizationId)
      const readiness = slotReadiness(connections, bindings, {})
      const catalogs = listCatalogs()
      const required = wiredRequiredSlots()
      const autoPlan = planAutoBind(connections, bindings, required, recommendedForPredicate())

      const gaps = gapSlots(readiness).map(item => ({
        slot: item.slot as CapabilitySlot,
        required: item.usage.required,
        /** 一键补齐能不能覆盖这个槽:来自已连厂商的已验证候选。 */
        autoBindable: autoPlan.planned.some(choice => choice.slot === item.slot),
      }))

      // 下一步建议按最短路径给:没连接→去连厂商;有连接没探测→探测;探测了没绑→一键补齐;全齐→开做。
      const verifiedConnections = connections.filter(connection =>
        connection.capabilities.some(capability =>
          capability.entitlementVerifiedAt !== null || capability.credentialVerifiedAt !== null))
      const nextStep: 'connect_provider' | 'probe_models' | 'auto_bind' | 'ready' | 'needs_optional'
        = connections.length === 0 ? 'connect_provider'
        : verifiedConnections.length === 0 ? 'probe_models'
        : gaps.some(gap => gap.required) && autoPlan.planned.length > 0 ? 'auto_bind'
        : gaps.some(gap => gap.required) ? 'connect_provider'
        : 'ready'

      reply.send({
        recommendationVersion: catalogs[0]?.catalogVersion ?? 'unknown',
        required: { ready: readyCount(readiness), total: required.length },
        gaps,
        autoBindPlan: { planned: autoPlan.planned.map(choice => ({ slot: choice.slot, provider: choice.provider, model: choice.model })), unfulfilled: autoPlan.unfulfilled },
        catalogCoverage: { perSlot: requiredSlotCoverage(catalogs).perSlot, minimumConnections: minimumConnections(catalogs) },
        nextStep,
        /** 编辑者能否自己完成配置;普通编辑者缺组织配置时前端显示"请管理员连接模型"。 */
        /** 编辑者及以上可自行完成配置;普通编辑者缺组织配置时前端显示「请管理员连接模型」。 */
        canConfigure: canManageBindings(auth.role),
      })
    },
  )

  // 一键补齐的项目内入口(与组织级 /bindings/auto 同一写路径,便于引导页直接调)。
  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/auto-bind',
    { preHandler: requirePermission('bindings:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'project not found' })
      const { connections, bindings } = await loadOrgModelPool(app.db, auth.organizationId)
      const plan = planAutoBind(connections, bindings, wiredRequiredSlots(), recommendedForPredicate())
      if (plan.planned.length === 0) {
        return reply.code(409).send({ error: 'nothing to bind', unfulfilled: plan.unfulfilled })
      }
      const created: string[] = []
      const skipped: string[] = []
      for (const choice of plan.planned) {
        const result = await createBinding(app.db, auth, { slot: choice.slot, capabilityId: choice.capabilityId, projectId: project.id })
        if (result.ok) created.push(`${choice.slot} → ${choice.provider}/${choice.model}`)
        else skipped.push(`${choice.slot}: ${result.error}`)
      }
      if (created.length > 0) {
        await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'binding.autoProject', entityType: 'Project', entityId: project.id, payload: { created, skipped } })
      }
      return reply.code(201).send({ created, skipped, unfulfilled: plan.unfulfilled })
    },
  )
}

function canManageBindings(role: string): boolean {
  const rank: Record<string, number> = { OWNER: 50, ADMIN: 40, EDITOR: 30, REVIEWER: 20, VIEWER: 10 }
  return (rank[role] ?? 0) >= 30
}
