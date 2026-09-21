import type { FastifyInstance } from 'fastify'
import type { Asset, AssetVersion, MediaArtifact, PrismaClient, WorkflowStatus } from '@studio/db'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'
import { toArtifactDto, type ArtifactDto } from './artifacts.js'

const maxDescriptionLength = 200_000

interface AssetBody {
  kind?: string
  name?: string
  description?: string
}

interface AssetVersionDto {
  id: string
  version: number
  description: string
  status: WorkflowStatus
  artifact: ArtifactDto | null
}

interface AssetDto {
  id: string
  kind: string
  name: string
  description: string
  status: WorkflowStatus
  generationTaskId: string | null
  projectAssetId: string | null
  /** How many live shots bind this asset — the reach its approval (or edit) has. */
  usageCount: number
  versions: AssetVersionDto[]
}

type AssetVersionRow = AssetVersion & { artifact: MediaArtifact | null }
type AssetRow = Asset & { versions: AssetVersionRow[] }

async function findEpisodeInOrg(db: PrismaClient, episodeId: string, organizationId: string) {
  return db.episode.findFirst({ where: { id: episodeId, project: { organizationId } } })
}

/** Live-shot bindings per asset, so the console can show what an approval unlocks. */
async function assetUsage(db: PrismaClient, episodeId: string): Promise<Map<string, number>> {
  const grouped = await db.storyboardAsset.groupBy({
    by: ['assetId'],
    where: { storyboard: { episodeId, supersededAt: null } },
    _count: { _all: true },
  })
  return new Map(grouped.map(entry => [entry.assetId, entry._count._all]))
}

function parseVersion(value: string): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
}

function toVersionDto(version: AssetVersionRow): AssetVersionDto {
  return {
    id: version.id,
    version: version.version,
    description: version.description,
    status: version.status,
    artifact: version.artifact ? toArtifactDto(version.artifact) : null,
  }
}

function toAssetDto(asset: AssetRow, usageCount = 0): AssetDto {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    description: asset.description,
    status: asset.status,
    generationTaskId: asset.generationTaskId,
    projectAssetId: asset.projectAssetId,
    usageCount,
    versions: asset.versions.map(toVersionDto),
  }
}

export async function assetRoutes(app: FastifyInstance): Promise<void> {
  // The project-level library (角色中台): every episode asset links back to one of
  // these rows, so a character's identity and reference images are defined once.
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/project-assets',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({
        where: { id: request.params.projectId, organizationId: auth.organizationId },
      })
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const assets = await app.db.projectAsset.findMany({
        where: { projectId: project.id },
        orderBy: [{ kind: 'asc' }, { name: 'asc' }],
        include: {
          versions: {
            orderBy: { version: 'desc' },
            include: { artifact: true },
          },
        },
      })
      return {
        assets: assets.map(asset => ({
          id: asset.id,
          kind: asset.kind,
          name: asset.name,
          description: asset.description,
          status: asset.status,
          archivedAt: asset.archivedAt,
          versions: asset.versions.map(version => ({
            id: version.id,
            version: version.version,
            description: version.description,
            status: version.status,
            artifact: version.artifact ? toArtifactDto(version.artifact) : null,
          })),
        })),
      }
    },
  )

  app.get<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/assets',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      // Asset has no timestamp columns; cuid ids sort chronologically.
      const assets = await app.db.asset.findMany({
        where: { episodeId: episode.id },
        include: { versions: { include: { artifact: true }, orderBy: { version: 'desc' } } },
        orderBy: { id: 'desc' },
      })
      const usage = await assetUsage(app.db, episode.id)
      return { assets: assets.map(asset => toAssetDto(asset, usage.get(asset.id) ?? 0)) }
    },
  )

  app.post<{ Params: { episodeId: string }; Body: AssetBody }>(
    '/episodes/:episodeId/assets',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })

      const kind = request.body?.kind
      const name = request.body?.name
      const description = request.body?.description
      if (typeof kind !== 'string' || !kind.trim()) return reply.code(400).send({ error: 'kind is required' })
      if (typeof name !== 'string' || !name.trim()) return reply.code(400).send({ error: 'name is required' })
      if (typeof description !== 'string' || !description.trim()) return reply.code(400).send({ error: 'description is required' })
      if (description.length > maxDescriptionLength) return reply.code(400).send({ error: `description must not exceed ${maxDescriptionLength} characters` })

      try {
        const created = await app.db.asset.create({
          data: { episodeId: episode.id, kind, name, description, status: 'DRAFT' },
          include: { versions: { include: { artifact: true }, orderBy: { version: 'desc' } } },
        })
        await recordAudit(app.db, {
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: 'asset.create',
          entityType: 'Asset',
          entityId: created.id,
          payload: { episodeId: episode.id, kind, name },
        })
        return reply.code(201).send({ asset: toAssetDto(created) })
      } catch (error) {
        if (!isPrismaUniqueViolation(error)) throw error
        return reply.code(409).send({ error: 'assets:duplicate' })
      }
    },
  )

  app.patch<{ Params: { episodeId: string; assetId: string }; Body: AssetBody }>(
    '/episodes/:episodeId/assets/:assetId',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const asset = await app.db.asset.findFirst({ where: { id: request.params.assetId, episodeId: episode.id } })
      if (!asset) return reply.code(404).send({ error: 'Asset not found' })

      // 只有描述可改:名字与种类是身份与唯一键,改动等于换一个素材。
      // AI 提取的描述会出错(性别、年龄写反过),描述是用户纠正档案的入口。
      const description = request.body?.description
      if (typeof description !== 'string' || !description.trim()) return reply.code(400).send({ error: 'description is required' })
      if (description.length > maxDescriptionLength) return reply.code(400).send({ error: `description must not exceed ${maxDescriptionLength} characters` })

      const updated = await app.db.asset.update({
        where: { id: asset.id },
        data: { description: description.trim() },
        include: { versions: { include: { artifact: true }, orderBy: { version: 'desc' } } },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'asset.update',
        entityType: 'Asset',
        entityId: asset.id,
        payload: { episodeId: episode.id, descriptionLength: description.length },
      })
      return { asset: toAssetDto(updated) }
    },
  )

  app.post<{ Params: { episodeId: string; assetId: string; version: string } }>(
    '/episodes/:episodeId/assets/:assetId/versions/:version/approve',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const asset = await app.db.asset.findFirst({ where: { id: request.params.assetId, episodeId: episode.id } })
      if (!asset) return reply.code(404).send({ error: 'Asset not found' })
      const version = parseVersion(request.params.version)
      const current = version === null
        ? null
        : await app.db.assetVersion.findFirst({ where: { assetId: asset.id, version } })
      if (!current) return reply.code(404).send({ error: 'Asset version not found' })
      if (current.status === 'APPROVED') return reply.code(409).send({ error: 'assets:alreadyApproved' })

      // 与剧本/源文档同一治理语义:同一素材同时只有一个已通过版本,审批新版
      // 自动把旧的已通过版本降级为草稿——否则新旧两行都挂着"已通过",用户
      // 无法知道生成时到底用哪张(实景教训:男孩定妆照 v2 与女孩 v3 并存)。
      const approved = await app.db.$transaction(async tx => {
        await tx.assetVersion.updateMany({
          where: { assetId: asset.id, status: 'APPROVED', version: { not: current.version } },
          data: { status: 'DRAFT' },
        })
        return tx.assetVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' }, include: { artifact: true } })
      })
      const approvedAsset = await app.db.asset.update({
        where: { id: asset.id },
        data: { status: 'APPROVED' },
        include: { versions: { include: { artifact: true }, orderBy: { version: 'desc' } } },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'asset.approve',
        entityType: 'AssetVersion',
        entityId: approved.id,
        payload: { episodeId: episode.id, assetId: asset.id, version: approved.version },
      })
      return { version: toVersionDto(approved), asset: toAssetDto(approvedAsset) }
    },
  )

  // 废弃:把当前已通过版本退回草稿——它曾经通过,但用户明确宣布不再使用。
  // 退回后参考图解析不会再选中它(只取已通过版本),卡片上也会失去"使用中"标记;
  // 草稿可删,历史不丢。
  app.post<{ Params: { episodeId: string; assetId: string; version: string } }>(
    '/episodes/:episodeId/assets/:assetId/versions/:version/deprecate',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const asset = await app.db.asset.findFirst({ where: { id: request.params.assetId, episodeId: episode.id } })
      if (!asset) return reply.code(404).send({ error: 'Asset not found' })
      const version = parseVersion(request.params.version)
      const current = version === null
        ? null
        : await app.db.assetVersion.findFirst({ where: { assetId: asset.id, version } })
      if (!current) return reply.code(404).send({ error: 'Asset version not found' })
      if (current.status !== 'APPROVED') return reply.code(409).send({ error: 'assets:notApproved' })

      const deprecated = await app.db.assetVersion.update({ where: { id: current.id }, data: { status: 'DRAFT' }, include: { artifact: true } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'asset.deprecate',
        entityType: 'AssetVersion',
        entityId: deprecated.id,
        payload: { episodeId: episode.id, assetId: asset.id, version: deprecated.version },
      })
      return { version: toVersionDto(deprecated) }
    },
  )

  // 版本删除:与剧本版本同一治理语义——草稿可删(前端二次确认),已通过不可删;
  // 全局库中的镜像版本一并清理,保持两层历史一致。
  app.delete<{ Params: { episodeId: string; assetId: string; version: string } }>(
    '/episodes/:episodeId/assets/:assetId/versions/:version',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const asset = await app.db.asset.findFirst({ where: { id: request.params.assetId, episodeId: episode.id } })
      if (!asset) return reply.code(404).send({ error: 'Asset not found' })
      const version = parseVersion(request.params.version)
      const current = version === null
        ? null
        : await app.db.assetVersion.findFirst({ where: { assetId: asset.id, version } })
      if (!current) return reply.code(404).send({ error: 'Asset version not found' })
      if (current.status === 'APPROVED') return reply.code(409).send({ error: 'assets:versionApproved' })
      const versionCount = await app.db.assetVersion.count({ where: { assetId: asset.id } })
      if (versionCount <= 1) return reply.code(409).send({ error: 'assets:lastVersion' })

      await app.db.assetVersion.delete({ where: { id: current.id } })
      if (asset.projectAssetId) {
        // Mirror the deletion into the project library by prompt snapshot match.
        await app.db.projectAssetVersion.deleteMany({
          where: { projectAssetId: asset.projectAssetId, promptSnapshot: current.promptSnapshot ?? undefined, artifactId: current.artifactId ?? undefined },
        })
      }
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'asset.version.delete',
        entityType: 'AssetVersion',
        entityId: current.id,
        payload: { episodeId: episode.id, assetId: asset.id, version: current.version },
      })
      return reply.code(204).send()
    },
  )

  // 素材整体删除:连同其全部版本;已通过审批的素材不可删(先不审批或走归档语义)。
  app.delete<{ Params: { episodeId: string; assetId: string } }>(
    '/episodes/:episodeId/assets/:assetId',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const asset = await app.db.asset.findFirst({ where: { id: request.params.assetId, episodeId: episode.id } })
      if (!asset) return reply.code(404).send({ error: 'Asset not found' })
      if (asset.status === 'APPROVED') return reply.code(409).send({ error: 'assets:assetApproved' })

      await app.db.asset.delete({ where: { id: asset.id } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'asset.delete',
        entityType: 'Asset',
        entityId: asset.id,
        payload: { episodeId: episode.id, assetId: asset.id, kind: asset.kind, name: asset.name },
      })
      return reply.code(204).send()
    },
  )
}
