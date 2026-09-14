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
  versions: AssetVersionDto[]
}

type AssetVersionRow = AssetVersion & { artifact: MediaArtifact | null }
type AssetRow = Asset & { versions: AssetVersionRow[] }

async function findEpisodeInOrg(db: PrismaClient, episodeId: string, organizationId: string) {
  return db.episode.findFirst({ where: { id: episodeId, project: { organizationId } } })
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

function toAssetDto(asset: AssetRow): AssetDto {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    description: asset.description,
    status: asset.status,
    versions: asset.versions.map(toVersionDto),
  }
}

export async function assetRoutes(app: FastifyInstance): Promise<void> {
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
      return { assets: assets.map(toAssetDto) }
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

      const approved = await app.db.assetVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' }, include: { artifact: true } })
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
}
