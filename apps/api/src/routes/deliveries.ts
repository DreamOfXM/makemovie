import type { FastifyInstance } from 'fastify'
import type { Delivery, GenerationTask, MediaArtifact, PrismaClient, Stage, WorkflowStatus } from '@studio/db'
import { composedStoryboardIds, liveStoryboards } from '@studio/pipeline'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

// Same threshold the worker judges a generated artifact against, restated in the
// manifest so a reader knows which bar the counts were measured on.
const QUALITY_THRESHOLD = 0.7

interface VersionRef {
  version: number
  checksum: string
  status: WorkflowStatus
}

interface ManifestArtifact {
  stage: Stage | null
  objectKey: string
  checksum: string
  mimeType: string
  version: number
  width: number | null
  height: number | null
  durationMs: number | null
}

interface ManifestStoryboard {
  number: number
  title: string
  durationMs: number
  artifacts: ManifestArtifact[]
}

interface ManifestAcceptance {
  acceptedAt?: string
  rejectedAt?: string
  reason: string | null
}

interface DeliveryManifest {
  schemaVersion: number
  packagedAt: string
  episode: { id: string; number: number; title: string }
  source: VersionRef | null
  script: VersionRef | null
  storyboards: ManifestStoryboard[]
  composition: { objectKey: string; checksum: string; mimeType: string; durationMs: number | null }
  quality: { checks: number; approved: number; rejected: number; threshold: number }
  acceptance?: ManifestAcceptance
}

interface DeliveryDto {
  id: string
  status: WorkflowStatus
  manifest: DeliveryManifest
}

type RejectBody = { reason?: string }

// Newest task first so a manifest reads as "what we would ship today" downwards.
type SucceededTask = GenerationTask & { artifacts: MediaArtifact[] }

async function findEpisodeInOrg(db: PrismaClient, episodeId: string, organizationId: string) {
  return db.episode.findFirst({ where: { id: episodeId, project: { organizationId } } })
}

async function findDeliveryInOrg(db: PrismaClient, deliveryId: string, organizationId: string) {
  return db.delivery.findFirst({ where: { id: deliveryId, episode: { project: { organizationId } } } })
}

function toManifestArtifact(artifact: MediaArtifact): ManifestArtifact {
  return {
    stage: artifact.stage,
    objectKey: artifact.objectKey,
    checksum: artifact.checksum,
    mimeType: artifact.mimeType,
    version: artifact.version,
    width: artifact.width,
    height: artifact.height,
    durationMs: artifact.durationMs,
  }
}

function parseManifest(raw: string): DeliveryManifest {
  return JSON.parse(raw) as DeliveryManifest
}

function toDeliveryDto(delivery: Delivery): DeliveryDto {
  return { id: delivery.id, status: delivery.status, manifest: parseManifest(delivery.manifest) }
}

export async function deliveryRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/deliveries',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })

      // A delivery describes the episode as it ships, so it lists the live shots:
      // demanding a clip for a superseded one would refuse every delivery of an
      // episode whose breakdown was regenerated.
      const storyboards = await liveStoryboards(app.db, episode.id)
      // Shot-scoped tasks only: an episode-level task (a script, a breakdown, an asset
      // reference) belongs to no single shot, and a batch covers every shot it was
      // planned against, so resolving through the batch would list all of a batch's
      // artifacts under each of its shots.
      const succeededTasks: SucceededTask[] = await app.db.generationTask.findMany({
        where: { status: 'SUCCEEDED', storyboardId: { not: null }, batch: { episodeId: episode.id } },
        include: { artifacts: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      const tasksOf = (storyboardId: string): SucceededTask[] =>
        succeededTasks.filter(task => task.storyboardId === storyboardId)
      const composed = await composedStoryboardIds(app.db, episode.id)

      // Composition has no timestamp columns; cuid ids sort chronologically.
      const compositions = await app.db.composition.findMany({ where: { episodeId: episode.id }, orderBy: { id: 'desc' } })
      const finished = compositions.find(composition => composition.status === 'COMPLETED' && composition.artifactId !== null)
      const master = finished?.artifactId ? await app.db.mediaArtifact.findUnique({ where: { id: finished.artifactId } }) : null

      const reasons: string[] = []
      if (!finished) {
        reasons.push(compositions.length === 0
          ? 'the episode has no composition yet'
          : `the latest composition is ${compositions[0]!.status} and has no master artifact`)
      } else if (!master) {
        reasons.push(`composition ${finished.id} points at a master artifact that no longer exists`)
      }
      for (const storyboard of storyboards) {
        // The compose worker picks a clip by exactly this rule, so an episode that
        // cannot be composed cannot be delivered either.
        if (!composed.has(storyboard.id)) reasons.push(`storyboard ${storyboard.number} has no succeeded video artifact`)
      }
      if (reasons.length > 0 || !finished || !master) return reply.code(409).send({ error: 'delivery:notReady', reasons })

      const [source, script] = await Promise.all([
        app.db.sourceDocumentVersion.findFirst({ where: { episodeId: episode.id }, orderBy: { version: 'desc' }, select: { version: true, checksum: true, status: true } }),
        app.db.scriptVersion.findFirst({ where: { episodeId: episode.id }, orderBy: { version: 'desc' }, select: { version: true, checksum: true, status: true } }),
      ])
      // A check reaches the episode through whichever entity it judged.
      const grouped = await app.db.qualityCheck.groupBy({
        by: ['status'],
        where: {
          OR: [
            { storyboard: { episodeId: episode.id } },
            { batch: { episodeId: episode.id } },
            { sourceDocumentVersion: { episodeId: episode.id } },
            { artifact: { task: { batch: { episodeId: episode.id } } } },
          ],
        },
        _count: { _all: true },
      })
      const counts = Object.fromEntries(grouped.map(group => [group.status, group._count._all])) as Partial<Record<WorkflowStatus, number>>

      const manifest: DeliveryManifest = {
        schemaVersion: 1,
        packagedAt: new Date().toISOString(),
        episode: { id: episode.id, number: episode.number, title: episode.title },
        source: source ?? null,
        script: script ?? null,
        storyboards: storyboards.map(storyboard => ({
          number: storyboard.number,
          title: storyboard.title,
          durationMs: storyboard.durationMs,
          artifacts: tasksOf(storyboard.id).flatMap(task => task.artifacts.map(toManifestArtifact)),
        })),
        composition: { objectKey: master.objectKey, checksum: master.checksum, mimeType: master.mimeType, durationMs: master.durationMs },
        quality: {
          checks: grouped.reduce((sum, group) => sum + group._count._all, 0),
          approved: counts.APPROVED ?? 0,
          rejected: counts.NEEDS_REVIEW ?? 0,
          threshold: QUALITY_THRESHOLD,
        },
      }

      const delivery = await app.db.delivery.create({
        data: { episodeId: episode.id, status: 'DRAFT', manifest: JSON.stringify(manifest), artifactId: finished.artifactId },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'delivery.create',
        entityType: 'delivery',
        entityId: delivery.id,
        payload: { episodeId: episode.id, storyboards: manifest.storyboards.length, quality: manifest.quality },
      })
      return reply.code(201).send({ delivery: toDeliveryDto(delivery) })
    },
  )

  app.get<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/deliveries',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const deliveries = await app.db.delivery.findMany({ where: { episodeId: episode.id }, orderBy: { id: 'desc' } })
      return { deliveries: deliveries.map(toDeliveryDto) }
    },
  )

  app.get<{ Params: { id: string } }>(
    '/deliveries/:id/manifest',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const delivery = await findDeliveryInOrg(app.db, request.params.id, auth.organizationId)
      if (!delivery) return reply.code(404).send({ error: 'Delivery not found' })
      return parseManifest(delivery.manifest)
    },
  )

  app.post<{ Params: { id: string } }>(
    '/deliveries/:id/accept',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const delivery = await findDeliveryInOrg(app.db, request.params.id, auth.organizationId)
      if (!delivery) return reply.code(404).send({ error: 'Delivery not found' })
      if (delivery.status === 'APPROVED') return reply.code(409).send({ error: 'delivery:alreadyAccepted' })

      const manifest = parseManifest(delivery.manifest)
      manifest.acceptance = { acceptedAt: new Date().toISOString(), reason: null }
      const accepted = await app.db.delivery.update({
        where: { id: delivery.id },
        data: { status: 'APPROVED', manifest: JSON.stringify(manifest) },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'delivery.accept',
        entityType: 'delivery',
        entityId: accepted.id,
        payload: { episodeId: accepted.episodeId, acceptedAt: manifest.acceptance.acceptedAt },
      })
      return { delivery: toDeliveryDto(accepted) }
    },
  )

  app.post<{ Params: { id: string }; Body: RejectBody }>(
    '/deliveries/:id/reject',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const reason = request.body?.reason
      if (typeof reason !== 'string' || !reason.trim()) return reply.code(400).send({ error: 'reason is required' })

      const delivery = await findDeliveryInOrg(app.db, request.params.id, auth.organizationId)
      if (!delivery) return reply.code(404).send({ error: 'Delivery not found' })
      if (delivery.status === 'APPROVED') return reply.code(409).send({ error: 'delivery:alreadyAccepted' })

      const manifest = parseManifest(delivery.manifest)
      manifest.acceptance = { rejectedAt: new Date().toISOString(), reason: reason.trim() }
      const rejected = await app.db.delivery.update({
        where: { id: delivery.id },
        data: { status: 'NEEDS_REVIEW', manifest: JSON.stringify(manifest) },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'delivery.reject',
        entityType: 'delivery',
        entityId: rejected.id,
        payload: { episodeId: rejected.episodeId, reason: reason.trim() },
      })
      return { delivery: toDeliveryDto(rejected) }
    },
  )
}
