import type { FastifyInstance } from 'fastify'
import { OFFICIAL_RECIPES, recipeChecksum } from '@studio/pipeline'
import { requirePermission } from '../plugins/auth.js'
import { recordAudit } from '../lib/audit.js'

/**
 * US-005 配方读取与实例化。GET /recipes 无密钥、无登录门槛(配方是公开的产品
 * 事实,不含任何组织数据);实例化=建项时把 spec 快照进 Project.recipeSnapshot,
 * 此后生成只读快照——配方表升级,旧作品不漂移。
 */
export async function recipeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/recipes', async () => {
    return {
      recipes: OFFICIAL_RECIPES.map(recipe => ({
        recipeKey: recipe.recipeKey,
        version: recipe.version,
        notes: recipe.notes,
        checksum: recipeChecksum(recipe),
        spec: recipe.spec,
      })),
    }
  })

  // 把官方配方登记进库(幂等:同 key+version 已存在则校验 checksum 一致后跳过)。
  // 这是配方的「发布」动作:登记后 API/agent 都从库里读,升级走 version+1。
  app.post<{ Body: { recipeKey?: unknown; version?: unknown } }>(
    '/recipes/publish',
    { preHandler: requirePermission('providers:manage') },
    async (request, reply) => {
      const key = typeof request.body?.recipeKey === 'string' ? request.body.recipeKey : null
      const version = typeof request.body?.version === 'number' ? request.body.version : null
      const recipe = OFFICIAL_RECIPES.find(item => item.recipeKey === key && item.version === version)
      if (!recipe) {
        return reply.code(400).send({ error: `unknown official recipe ${key ?? '?'}@${version ?? '?'}` })
      }
      const checksum = recipeChecksum(recipe)
      const spec = JSON.stringify(recipe.spec)
      const existing = await app.db.recipeVersion.findUnique({
        where: { recipeKey_version: { recipeKey: recipe.recipeKey, version: recipe.version } },
      })
      if (existing) {
        // 不可变纪律:同版本号内容必须一致,不一致=发布事故,拒绝且点名。
        if (existing.checksum !== checksum) {
          return reply.code(409).send({ error: `recipe ${recipe.recipeKey}@${recipe.version} already published with different content — bump the version` })
        }
        return { published: false, alreadyPresent: true, recipeKey: recipe.recipeKey, version: recipe.version }
      }
      const row = await app.db.recipeVersion.create({
        data: { recipeKey: recipe.recipeKey, version: recipe.version, spec, checksum, notes: recipe.notes },
      })
      await recordAudit(app.db, {
        organizationId: request.auth!.organizationId,
        userId: request.auth!.userId,
        action: 'recipe.publish',
        entityType: 'RecipeVersion',
        entityId: row.id,
        payload: { recipeKey: recipe.recipeKey, version: recipe.version, checksum },
      })
      return reply.code(201).send({ published: true, recipeKey: row.recipeKey, version: row.version })
    },
  )

  // 实例化测试口径:给定配方与项目,写入快照并返回——US-006 建项服务将复用此逻辑。
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/recipe',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const project = await app.db.project.findFirst({
        where: { id: request.params.projectId, organizationId: request.auth!.organizationId },
        select: { recipeKey: true, recipeVersion: true, recipeSnapshot: true },
      })
      if (!project) return reply.code(404).send({ error: 'project not found' })
      if (!project.recipeSnapshot) return reply.code(404).send({ error: 'project has no recipe snapshot (pre-recipe project)' })
      return { recipeKey: project.recipeKey, recipeVersion: project.recipeVersion, snapshot: JSON.parse(project.recipeSnapshot) }
    },
  )
}
