import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { OFFICIAL_RECIPES, recipeChecksum } from '@studio/pipeline'
import { contentLocales, isContentLocale, isProjectFormat, projectFormats, formatDurationRange, durationOutOfRange } from '@studio/domain'
import { ProjectFormat as PrismaProjectFormat } from '@studio/db'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

/**
 * US-006 故事建项与草稿服务。三个动作:
 *  1. PUT /story-drafts/:id  —— 草稿即时保存(不调用任何模型,刷新/断网不丢);
 *  2. GET /story-drafts(/:id) —— 读回草稿,继续创作;
 *  3. POST /projects/from-story —— 消费草稿建项+首集,幂等键重发不重复建,
 *     配方实例化=快照进项目(US-005 路径),首集源文档落 SourceDocumentVersion。
 * 已有 POST /projects 原样保留——两条入口并存,旧界面不动。
 */

interface DraftBody {
  title?: unknown
  storyText?: unknown
  recipeKey?: unknown
  styleId?: unknown
  contentLocale?: unknown
  targetDurationMs?: unknown
}

function parseDraft(body: DraftBody | undefined): { ok: true; values: {
  title: string | null; storyText: string; recipeKey: string | null; styleId: string | null
  contentLocale: string | null; targetDurationMs: number | null
} } | { ok: false; error: string } {
  const storyText = typeof body?.storyText === 'string' ? body.storyText.trim() : ''
  if (storyText === '') return { ok: false, error: 'storyText is required' }
  if (storyText.length > 500_000) return { ok: false, error: 'storyText is too large (500k chars max)' }
  const recipeKey = typeof body?.recipeKey === 'string' && body.recipeKey !== '' ? body.recipeKey : null
  if (recipeKey !== null && !OFFICIAL_RECIPES.some(recipe => recipe.recipeKey === recipeKey)) {
    return { ok: false, error: `unknown recipeKey ${recipeKey}` }
  }
  const contentLocale = typeof body?.contentLocale === 'string' && body.contentLocale !== '' ? body.contentLocale : null
  if (contentLocale !== null && !isContentLocale(contentLocale)) {
    return { ok: false, error: `contentLocale must be one of ${contentLocales.join(', ')}` }
  }
  const targetDurationMs = typeof body?.targetDurationMs === 'number' && Number.isFinite(body.targetDurationMs) ? Math.round(body.targetDurationMs) : null
  return {
    ok: true,
    values: {
      title: typeof body?.title === 'string' && body.title.trim() !== '' ? body.title.trim().slice(0, 200) : null,
      storyText,
      recipeKey,
      styleId: typeof body?.styleId === 'string' && body.styleId !== '' ? body.styleId : null,
      contentLocale,
      targetDurationMs,
    },
  }
}

async function draftInOrg(db: FastifyInstance['db'], id: string, organizationId: string) {
  return db.storyDraft.findFirst({ where: { id, organizationId } })
}

export async function storyDraftRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: DraftBody }>(
    '/story-drafts',
    { preHandler: requirePermission('project:create') },
    async (request, reply) => {
      const auth = request.auth!
      const parsed = parseDraft(request.body)
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
      const draft = await app.db.storyDraft.create({ data: { organizationId: auth.organizationId, userId: auth.userId, ...parsed.values } })
      return reply.code(201).send({ draft })
    },
  )

  app.get('/story-drafts', { preHandler: requirePermission('project:create') }, async request => {
    const auth = request.auth!
    const drafts = await app.db.storyDraft.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      select: { id: true, title: true, recipeKey: true, consumedProjectId: true, updatedAt: true },
    })
    return { drafts }
  })

  app.get<{ Params: { id: string } }>('/story-drafts/:id', { preHandler: requirePermission('project:create') }, async (request, reply) => {
    const auth = request.auth!
    const draft = await draftInOrg(app.db, request.params.id, auth.organizationId)
    if (!draft) return reply.code(404).send({ error: 'draft not found' })
    return { draft }
  })

  app.put<{ Params: { id: string }; Body: DraftBody }>(
    '/story-drafts/:id',
    { preHandler: requirePermission('project:create') },
    async (request, reply) => {
      const auth = request.auth!
      const draft = await draftInOrg(app.db, request.params.id, auth.organizationId)
      if (!draft) return reply.code(404).send({ error: 'draft not found' })
      if (draft.consumedProjectId) return reply.code(409).send({ error: 'draft already consumed by a project — start a new draft to edit' })
      const parsed = parseDraft(request.body)
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
      const updated = await app.db.storyDraft.update({ where: { id: draft.id }, data: parsed.values })
      return { draft: updated }
    },
  )

  app.post<{ Params: { id: string }; Body: { format?: unknown } }>(
    '/story-drafts/:id/create-project',
    { preHandler: requirePermission('project:create') },
    async (request, reply) => {
      const auth = request.auth!
      const draft = await draftInOrg(app.db, request.params.id, auth.organizationId)
      if (!draft) return reply.code(404).send({ error: 'draft not found' })
      if (draft.consumedProjectId) {
        // 幂等重发:双击/断网重试返回已建项目,不重复建。
        const existing = await app.db.project.findFirst({ where: { id: draft.consumedProjectId, organizationId: auth.organizationId } })
        if (existing) return reply.code(200).send({ project: existing, idempotentReplay: true })
        return reply.code(409).send({ error: 'draft was consumed but its project is gone' })
      }

      const format = typeof request.body?.format === 'string' ? request.body.format : 'short_drama'
      if (!isProjectFormat(format)) return reply.code(400).send({ error: `format must be one of ${projectFormats.join(', ')}` }
      )
      const prismaFormat = PrismaProjectFormat[format.toUpperCase() as keyof typeof PrismaProjectFormat]
      if (draft.targetDurationMs !== null && durationOutOfRange(format, draft.targetDurationMs)) {
        const range = formatDurationRange[format]
        return reply.code(400).send({ error: `targetDurationMs must be between ${range.minMs} and ${range.maxMs} for format ${format}` })
      }

      // 配方实例化(US-005 路径):快照进项目,升级不漂移;草稿没选配方就按画幅挑默认。
      const recipe = draft.recipeKey !== null
        ? OFFICIAL_RECIPES.find(item => item.recipeKey === draft.recipeKey)!
        : OFFICIAL_RECIPES.find(item => item.spec.aspect === (prismaFormat === 'FILM' ? '16:9' : '9:16'))!

      // 保存草稿不建项目时不动项目表;建项目这一步不调用任何模型——第一集源文档
      // 直接落 SourceDocumentVersion(草稿正文),生成链留给用户在项目里显式触发。
      const title = draft.title ?? draft.storyText.slice(0, 40)
      const project = await app.db.$transaction(async tx => {
        const created = await tx.project.create({
          data: {
            organizationId: auth.organizationId,
            name: title,
            contentLocale: draft.contentLocale ?? undefined,
            format: prismaFormat,
            ...(draft.styleId !== null ? { stylePresetId: draft.styleId } : {}),
            ...(draft.targetDurationMs !== null ? { targetDurationMs: draft.targetDurationMs } : {}),
            recipeKey: recipe.recipeKey,
            recipeVersion: recipe.version,
            recipeSnapshot: JSON.stringify(recipe.spec),
          },
        })
        const episode = await tx.episode.create({
          data: { projectId: created.id, number: 1, title: '第 1 集', ...(draft.targetDurationMs !== null ? { targetDurationMs: draft.targetDurationMs } : {}) },
        })
        const checksum = createHash('sha256').update(draft.storyText, 'utf8').digest('hex')
        await tx.sourceDocumentVersion.create({
          data: { episodeId: episode.id, version: 1, content: draft.storyText, checksum, status: 'DRAFT' },
        })
        await tx.storyDraft.update({ where: { id: draft.id }, data: { consumedProjectId: created.id } })
        return created
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId, userId: auth.userId,
        action: 'project.createFromStory', entityType: 'Project', entityId: project.id,
        payload: { draftId: draft.id, recipeKey: recipe.recipeKey, recipeVersion: recipe.version, format: prismaFormat },
      })
      return reply.code(201).send({ project, idempotentReplay: false })
    },
  )
}
