import type { FastifyInstance } from 'fastify'
import { ProjectFormat } from '@studio/db'
import { automationGates, contentLocales, durationOutOfRange, formatDefaults, formatDurationRange, isAutomationGate, isContentLocale, isProjectFormat, projectFormats } from '@studio/domain'
import { normalizeShotRhythm, resolveShotRhythm, targetShotDurationPlan } from '@studio/pipeline'
import { recordAudit } from '../lib/audit.js'
import { cloneExampleProject, EXAMPLE_FIXTURES, installExampleProject } from '../lib/example-project.js'
import { requirePermission } from '../plugins/auth.js'

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: string; before?: string } }>('/projects', { preHandler: requirePermission('read') }, async (request, reply) => {
    const auth = request.auth!
    // The project list is a lifecycle board, not a name table: each row carries the
    // episode status summary the lifecycle bar renders from, so the list needs no
    // per-project drill-down request to draw itself.
    //
    // Without query params the response stays the bare array every existing
    // consumer reads. Passing limit opts into cursor pagination (id cursor over
    // the createdAt+id ordering) and answers { projects, nextCursor } instead —
    // a space with hundreds of projects must not ship as one endless page.
    const include = {
      episodes: {
        orderBy: { number: 'asc' as const },
        select: { id: true, number: true, title: true, status: true },
      },
    }
    if (request.query?.limit !== undefined) {
      const limit = Number(request.query.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return reply.code(400).send({ error: 'limit must be an integer between 1 and 100' })
      }
      const rows = await app.db.project.findMany({
        where: { organizationId: auth.organizationId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(request.query.before ? { cursor: { id: request.query.before }, skip: 1 } : {}),
        take: limit + 1,
        include,
      })
      const nextCursor = rows.length > limit ? rows[limit - 1].id : null
      return { projects: rows.slice(0, limit), nextCursor }
    }
    return app.db.project.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include,
    })
  })

  app.post<{ Body: { name?: string; contentLocale?: string; format?: string; targetDurationMs?: number; styleId?: string; automationGate?: string } }>('/projects', { preHandler: requirePermission('project:create') }, async (request, reply) => {
    const auth = request.auth!
    const name = request.body?.name?.trim()
    if (!name) return reply.code(400).send({ error: 'name is required' })
    // New projects carry a style from birth (default: 写实风) so generation is
    // shaped from the first click; an explicit styleId must resolve like apply-style's.
    const requestedStyleId = request.body?.styleId ?? 'realistic'
    const style = await app.db.stylePreset.findFirst({
      where: { id: requestedStyleId, OR: [{ organizationId: null }, { organizationId: auth.organizationId }] },
    })
    if (!style) return reply.code(400).send({ error: 'styleId references a non-existent or inaccessible style' })
    const requestedLocale = request.body?.contentLocale
    if (requestedLocale !== undefined && !isContentLocale(requestedLocale)) {
      return reply.code(400).send({ error: `contentLocale must be one of ${contentLocales.join(', ')}` })
    }
    // 空间默认语言只在建项这一刻读一次；之后改空间默认不动任何已有作品。
    const organization = await app.db.organization.findUnique({ where: { id: auth.organizationId }, select: { defaultContentLocale: true } })
    const contentLocale = requestedLocale ?? organization?.defaultContentLocale ?? 'zh'
    const format = request.body?.format ?? 'short_drama'
    if (!isProjectFormat(format)) {
      return reply.code(400).send({ error: `format must be one of ${projectFormats.join(', ')}` })
    }
    // A custom default is the whole point of the format ranges: dramas running
    // 90-second episodes or a 95-minute film set it here once, per-episode.
    const range = formatDurationRange[format]
    if (request.body?.targetDurationMs !== undefined && durationOutOfRange(format, request.body.targetDurationMs)) {
      return reply.code(400).send({ error: `targetDurationMs must be between ${range.minMs} and ${range.maxMs} for format ${format}` })
    }
    // 制作档位可选。缺省即 null，读侧按 beforeSpend 解释——与引入档位之前的行为一致，
    // 所以「不填」就是「维持现状」，不需要默认值兜底。
    const automationGate = request.body?.automationGate
    if (automationGate !== undefined && automationGate !== null && !isAutomationGate(automationGate)) {
      return reply.code(400).send({ error: `automationGate must be one of ${automationGates.join(', ')} (null restores the default)` })
    }
    const prismaFormat = ProjectFormat[format.toUpperCase() as keyof typeof ProjectFormat]
    const project = await app.db.$transaction(async tx => {
      const created = await tx.project.create({
        data: {
          organizationId: auth.organizationId,
          name,
          contentLocale,
          format: prismaFormat,
          stylePresetId: style.id,
          ...(request.body?.targetDurationMs === undefined ? {} : { targetDurationMs: request.body?.targetDurationMs }),
          ...(automationGate === undefined ? {} : { automationGate }),
        },
      })
      // A film is a one-episode project, so its single episode exists from the
      // start, seeded with the effective target duration.
      if (prismaFormat === 'FILM') {
        await tx.episode.create({
          data: { projectId: created.id, number: 1, title: '正片', targetDurationMs: created.targetDurationMs ?? formatDefaults.film.targetDurationMs },
        })
      }
      return created
    })
    await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'project.create', entityType: 'Project', entityId: project.id, payload: { name, contentLocale: project.contentLocale, format: project.format, targetDurationMs: project.targetDurationMs, automationGate: project.automationGate } })
    return reply.code(201).send(project)
  })

  // 单镜时长的三项读数：项目档、绑定模型能力、产品上限，以及三取最小后的
  // 有效上限和真正可选的档位。设置页在开跑前就摊开这三个数——等生成失败
  // 再解释为什么 30 秒买不到，是最贵的一种说明书。
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/shot-duration',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({
        where: { id: request.params.projectId, organizationId: auth.organizationId },
        select: { id: true },
      })
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      return targetShotDurationPlan(app.db, auth.organizationId, project.id)
    },
  )

  app.patch<{ Params: { projectId: string }; Body: { name?: string; contentLocale?: string; format?: string; targetDurationMs?: number; maxShotDurationMs?: number | null; maxRetriesPerShot?: number | null; retryTechnical?: string | null; retryConsistency?: string | null; retryCreative?: string | null; audioMode?: 'video_native' | 'voice_clone' | null; automationGate?: string | null; shotRhythm?: { avgShotMs?: number; longTakeMinMs?: number; longTakeShareMin?: number } | null } }>(
    '/projects/:projectId',
    { preHandler: requirePermission('project:update') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      // 示例项目只读:改它等于污染所有人的教材——复制一份去改。
      if (project.isExample) return reply.code(403).send({ error: 'example project is read-only — clone it to edit' })
      // The format is fixed at creation by design; silently ignoring it here made
      // third-party callers believe a rename also re-shaped the project.
      if (request.body?.format !== undefined) {
        return reply.code(400).send({ error: 'format is set at project creation and cannot be changed here' })
      }
      // 内容语言在建项那一刻锁定：剧本、台词、配音、字幕都已按它生成，改名时
      // 悄悄换语言会让同一集前后半段说两种话。要换语言就新建作品。
      if (request.body?.contentLocale !== undefined) {
        return reply.code(400).send({ error: 'contentLocale is locked at project creation and cannot be changed' })
      }
      const { name, targetDurationMs, maxShotDurationMs, maxRetriesPerShot, retryTechnical, retryConsistency, retryCreative, audioMode, automationGate, shotRhythm } = request.body ?? {}
      if (name === undefined && targetDurationMs === undefined && maxShotDurationMs === undefined && maxRetriesPerShot === undefined && retryTechnical === undefined && retryConsistency === undefined && retryCreative === undefined && audioMode === undefined && automationGate === undefined && shotRhythm === undefined) {
        return reply.code(400).send({ error: 'name, targetDurationMs, maxShotDurationMs, maxRetriesPerShot, retry policies, audioMode, automationGate or shotRhythm is required' })
      }
      // 目标总时长在这里可改，但只改变「以后新建的集」的缺省值：已经存在的集
      // 各自锁着自己的目标时长，改项目档不会回头重写它们的剧本与分镜。
      if (targetDurationMs !== undefined) {
        const format = project.format.toLowerCase()
        if (!isProjectFormat(format) || durationOutOfRange(format, targetDurationMs)) {
          const range = isProjectFormat(format) ? formatDurationRange[format] : null
          return reply.code(400).send({ error: range ? `targetDurationMs must be between ${range.minMs} and ${range.maxMs} for format ${format}` : 'targetDurationMs is invalid for this project format' })
        }
      }
      if (name !== undefined && !name.trim()) return reply.code(400).send({ error: 'name is required' })
      if (audioMode !== undefined && audioMode !== null && !['video_native', 'voice_clone'].includes(audioMode)) {
        return reply.code(400).send({ error: 'audioMode must be video_native or voice_clone' })
      }
      // 单镜时长上限：只认 10/15/30 秒三档，null = 跟随绑定模型。
      if (maxShotDurationMs !== undefined && maxShotDurationMs !== null && ![10_000, 15_000, 30_000].includes(maxShotDurationMs)) {
        return reply.code(400).send({ error: 'maxShotDurationMs must be 10000, 15000 or 30000 (null follows the bound model)' })
      }
      // 每镜重抽上限：不含首次，0-3；null = 默认 1 次（总尝试 2 次）。
      if (maxRetriesPerShot !== undefined && maxRetriesPerShot !== null && (!Number.isInteger(maxRetriesPerShot) || maxRetriesPerShot < 0 || maxRetriesPerShot > 3)) {
        return reply.code(400).send({ error: 'maxRetriesPerShot must be an integer between 0 and 3 (null uses the default 1)' })
      }
      if (retryTechnical !== undefined && retryTechnical !== null && !['auto2', 'auto1', 'ask'].includes(retryTechnical)) {
        return reply.code(400).send({ error: 'retryTechnical must be auto2, auto1 or ask (null uses auto2)' })
      }
      if (retryConsistency !== undefined && retryConsistency !== null && !['ask', 'auto1', 'auto2'].includes(retryConsistency)) {
        return reply.code(400).send({ error: 'retryConsistency must be ask, auto1 or auto2 (null uses ask)' })
      }
      if (retryCreative !== undefined && retryCreative !== null && !['ask', 'auto1'].includes(retryCreative)) {
        return reply.code(400).send({ error: 'retryCreative must be ask or auto1 (null uses ask)' })
      }
      // 制作档位：null 回到默认（beforeSpend），即引入档位之前的行为。
      if (automationGate !== undefined && automationGate !== null && !isAutomationGate(automationGate)) {
        return reply.code(400).send({ error: `automationGate must be one of ${automationGates.join(', ')} (null restores the default)` })
      }
      // 节奏契约三条阈值：只收有边界的数，越界直接拒（设置页要给得出人话的错误，
      // 静默回默认会让人以为改了）。null 整体回到起始默认。
      let nextShotRhythm: string | null | undefined
      if (shotRhythm === null) {
        nextShotRhythm = null
      } else if (shotRhythm !== undefined) {
        if (typeof shotRhythm !== 'object') return reply.code(400).send({ error: 'shotRhythm must be an object or null' })
        const { avgShotMs, longTakeMinMs, longTakeShareMin } = shotRhythm
        if (avgShotMs !== undefined && (!Number.isInteger(avgShotMs) || avgShotMs < 1_000 || avgShotMs > 20_000)) {
          return reply.code(400).send({ error: 'shotRhythm.avgShotMs must be an integer between 1000 and 20000 milliseconds' })
        }
        if (longTakeMinMs !== undefined && (!Number.isInteger(longTakeMinMs) || longTakeMinMs < 2_000 || longTakeMinMs > 30_000)) {
          return reply.code(400).send({ error: 'shotRhythm.longTakeMinMs must be an integer between 2000 and 30000 milliseconds' })
        }
        if (longTakeShareMin !== undefined && (typeof longTakeShareMin !== 'number' || !Number.isFinite(longTakeShareMin) || longTakeShareMin < 0 || longTakeShareMin > 1)) {
          return reply.code(400).send({ error: 'shotRhythm.longTakeShareMin must be a number between 0 and 1' })
        }
        // 部分更新：没提交的字段沿用当前值，避免设置页改一格把另两格打回默认。
        nextShotRhythm = JSON.stringify(normalizeShotRhythm({ ...resolveShotRhythm(project.shotRhythm), ...shotRhythm }))
      }
      const updated = await app.db.project.update({
        where: { id: project.id },
        data: {
          ...(name === undefined ? {} : { name: name.trim() }),
          ...(targetDurationMs === undefined ? {} : { targetDurationMs }),
          ...(maxShotDurationMs === undefined ? {} : { maxShotDurationMs }),
          ...(maxRetriesPerShot === undefined ? {} : { maxRetriesPerShot }),
          ...(retryTechnical === undefined ? {} : { retryTechnical }),
          ...(retryConsistency === undefined ? {} : { retryConsistency }),
          ...(retryCreative === undefined ? {} : { retryCreative }),
          ...(audioMode === undefined ? {} : { audioMode }),
          ...(automationGate === undefined ? {} : { automationGate }),
          ...(nextShotRhythm === undefined ? {} : { shotRhythm: nextShotRhythm }),
        },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'project.update',
        entityType: 'Project',
        entityId: project.id,
        payload: {
          from: { name: project.name, targetDurationMs: project.targetDurationMs, maxShotDurationMs: project.maxShotDurationMs, maxRetriesPerShot: project.maxRetriesPerShot, retryTechnical: project.retryTechnical, retryConsistency: project.retryConsistency, retryCreative: project.retryCreative, automationGate: project.automationGate, shotRhythm: project.shotRhythm },
          to: { name: updated.name, targetDurationMs: updated.targetDurationMs, maxShotDurationMs: updated.maxShotDurationMs, maxRetriesPerShot: updated.maxRetriesPerShot, retryTechnical: updated.retryTechnical, retryConsistency: updated.retryConsistency, retryCreative: updated.retryCreative, audioMode: updated.audioMode, automationGate: updated.automationGate, shotRhythm: updated.shotRhythm },
        },
      })
      return updated
    },
  )

  app.delete<{ Params: { projectId: string } }>(
    '/projects/:projectId',
    { preHandler: requirePermission('project:delete') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      if (project.isExample) return reply.code(403).send({ error: 'example project is read-only' })
      await app.db.project.delete({ where: { id: project.id } })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'project.delete', entityType: 'Project', entityId: project.id, payload: { name: project.name } })
      return reply.code(204).send()
    },
  )

  // POST /projects/:projectId/apply-style
  app.post<{ Params: { projectId: string }; Body: { styleId?: string | null } }>(
    '/projects/:projectId/apply-style',
    { preHandler: requirePermission('project:update') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })

      const styleId = request.body?.styleId ?? null
      let style = null
      if (styleId) {
        style = await app.db.stylePreset.findFirst({
          where: { id: styleId, OR: [{ organizationId: null }, { organizationId: auth.organizationId }] },
        })
        if (!style) return reply.code(400).send({ error: 'styleId references a non-existent or inaccessible style' })
      }

      const updated = await app.db.project.update({
        where: { id: project.id },
        data: { stylePresetId: styleId },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'project.applyStyle',
        entityType: 'Project',
        entityId: project.id,
        payload: { previousStyleId: project.stylePresetId, newStyleId: styleId },
      })
      return { ...updated, appliedStyle: style }
    },
  )

  // POST /projects/:projectId/apply-pipeline
  app.post<{ Params: { projectId: string }; Body: { pipelineId?: string | null } }>(
    '/projects/:projectId/apply-pipeline',
    { preHandler: requirePermission('project:update') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })

      const pipelineId = request.body?.pipelineId ?? null
      let pipeline = null
      if (pipelineId) {
        pipeline = await app.db.pipelineConfig.findFirst({
          where: { id: pipelineId },
        })
        if (!pipeline) return reply.code(400).send({ error: 'pipelineId references a non-existent pipeline' })
      }

      const updated = await app.db.project.update({
        where: { id: project.id },
        data: { pipelineConfigId: pipelineId },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'project.applyPipeline',
        entityType: 'Project',
        entityId: project.id,
        payload: { previousPipelineId: project.pipelineConfigId, newPipelineId: pipelineId },
      })
      return { ...updated, appliedPipeline: pipeline }
    },
  )
  // US-008 示例项目:安装幂等(重复调用返回已有),只读守卫在 PATCH/DELETE 侧。
  app.post<{ Body: { slug?: unknown } }>(
    '/projects/install-example',
    { preHandler: requirePermission('project:create') },
    async (request, reply) => {
      const auth = request.auth!
      const slug = typeof request.body?.slug === 'string' ? request.body.slug : EXAMPLE_FIXTURES[0]!.slug
      const fixture = EXAMPLE_FIXTURES.find(item => item.slug === slug)
      if (!fixture) return reply.code(400).send({ error: `unknown example slug ${slug}` })
      const result = await installExampleProject(app.db, app.storage, auth.organizationId, fixture)
      return reply.code(result.installed ? 201 : 200).send(result)
    },
  )

  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/clone-example',
    { preHandler: requirePermission('project:create') },
    async (request, reply) => {
      const auth = request.auth!
      try {
        const result = await cloneExampleProject(app.db, request.params.projectId, auth.organizationId, auth.userId)
        return reply.code(201).send(result)
      } catch (error) {
        return reply.code(404).send({ error: error instanceof Error ? error.message : 'clone failed' })
      }
    },
  )

}
