import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Asset, AssetVersion, MediaArtifact, PrismaClient, WorkflowStatus } from '@studio/db'
import { buildObjectKey, probeDuration } from '@studio/media'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'
import { toArtifactDto, type ArtifactDto } from './artifacts.js'

const maxDescriptionLength = 200_000

/** 角色声音样本的约束与镜头音频导入保持同一套（episodes.ts 的 VOICE_IMPORT_*）。 */
const VOICE_SAMPLE_MAX_BYTES = 32 * 1024 * 1024
const VOICE_SAMPLE_TYPES = new Map([
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  // 浏览器 MediaRecorder 的原生产物（录音入口）。
  ['.webm', 'audio/webm'],
])

/** ffprobe 只吃路径：样本时长探测落一次临时盘，用完即删。 */
async function probeAudioDuration(bytes: Buffer, filename: string): Promise<number | null> {
  const dir = await mkdtemp(join(tmpdir(), 'studio-voice-sample-'))
  const file = join(dir, basename(filename))
  try {
    await writeFile(file, bytes)
    return await probeDuration(file)
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

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
  /** 角色绑定的声音 artifact ID（r10 音频体系）。null = 未绑定。 */
  voiceArtifactId: string | null
  /** How many live shots bind this asset — the reach its approval (or edit) has. */
  usageCount: number
  /** 最近一次定妆照任务的实况：界面据此画"生成中/失败"，不靠点击之后的本地回声。 */
  run: AssetRunDto | null
  versions: AssetVersionDto[]
}

/** 一个素材最新一次定妆照任务的实况。SUCCEEDED 不在这里出现——它留下的证据是版本本身。 */
interface AssetRunDto {
  status: 'QUEUED' | 'RUNNING' | 'FAILED' | 'BLOCKED'
  error: string | null
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

/**
 * 定妆照任务的逐素材实况，按事件序裁决：后一次成功或重新排队会清掉前一次的失败，
 * 与镜头那套（frameError/videoError）同一规则。素材与任务是多对一关系，只能从任务侧
 * 反查——Asset 上没有反向字段。排序取 updatedAt：重排队复用同一行任务，createdAt 是旧的。
 */
async function assetRuns(db: PrismaClient, episodeId: string): Promise<Map<string, AssetRunDto>> {
  const tasks = await db.generationTask.findMany({
    where: { batch: { episodeId }, stage: 'ASSET' },
    include: { assets: { select: { id: true } } },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
  })
  const runs = new Map<string, AssetRunDto>()
  for (const task of tasks) {
    if (task.status === 'SUCCEEDED') {
      for (const asset of task.assets) runs.delete(asset.id)
      continue
    }
    if (task.status !== 'QUEUED' && task.status !== 'RUNNING' && task.status !== 'FAILED' && task.status !== 'BLOCKED') continue
    let error: string | null = null
    // BLOCKED 的 errorSnapshot 存的是守卫点名的原因，同样要能回到界面上。
    if ((task.status === 'FAILED' || task.status === 'BLOCKED') && task.errorSnapshot) {
      try {
        const parsed: unknown = JSON.parse(task.errorSnapshot)
        error = (Array.isArray(parsed) ? parsed.map(String).join(' | ') : String(parsed)).slice(0, 400)
      } catch {
        error = task.errorSnapshot.slice(0, 400)
      }
    }
    for (const asset of task.assets) {
      runs.set(asset.id, { status: task.status as AssetRunDto['status'], error })
    }
  }
  return runs
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

function toAssetDto(asset: AssetRow, usageCount = 0, run: AssetRunDto | null = null): AssetDto {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    description: asset.description,
    status: asset.status,
    generationTaskId: asset.generationTaskId,
    projectAssetId: asset.projectAssetId,
    voiceArtifactId: asset.voiceArtifactId,
    usageCount,
    run,
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
      const runs = await assetRuns(app.db, episode.id)
      return { assets: assets.map(asset => toAssetDto(asset, usage.get(asset.id) ?? 0, runs.get(asset.id) ?? null)) }
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
  // ── 声音绑定（r10 音频体系）──
  // 角色绑定的声音指向一个音频 artifact（从视频提取/用户上传/参考录音）。
  // 绑定后 AUDIO 阶段用这个声音生成台词；解绑回退到项目级默认（视频原生/云端 TTS）。
  app.post<{ Params: { episodeId: string; assetId: string }; Body: { artifactId?: string | null } }>(
    '/episodes/:episodeId/assets/:assetId/voice-bind',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const asset = await app.db.asset.findFirst({ where: { id: request.params.assetId, episodeId: episode.id } })
      if (!asset) return reply.code(404).send({ error: 'Asset not found' })

      const { artifactId } = request.body ?? {}
      if (artifactId === undefined) return reply.code(400).send({ error: 'artifactId is required, null to unbind' })
      if (artifactId !== null) {
        // 校验 artifact 确实是音频且属于本组织
        const artifact = await app.db.mediaArtifact.findFirst({
          where: { id: artifactId, organizationId: auth.organizationId },
          select: { mimeType: true },
        })
        if (!artifact) return reply.code(400).send({ error: 'artifact not found in this organization' })
        if (!artifact.mimeType.startsWith('audio/')) return reply.code(400).send({ error: 'artifact is not audio' })
      }

      const updated = await app.db.asset.update({
        where: { id: asset.id },
        data: { voiceArtifactId: artifactId },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'asset.voice-bind',
        entityType: 'Asset',
        entityId: asset.id,
        payload: { artifactId, assetName: asset.name },
      })
      return { asset: { id: updated.id, voiceArtifactId: updated.voiceArtifactId } }
    },
  )

  // ── 角色声音上传（r10 音频体系）──
  // 上传一段参考音频 + 它说了什么（transcript），落成音频 artifact 并顺手绑定。
  // transcript 是克隆引擎的校准输入：Voicebox 的 /samples 端点把它列为必填，
  // 没有它克隆质量明显劣化，所以在 API 层就要求（空串放行——引擎接受，质量自负）。
  // 文件校验/探测时长复用镜头音频导入的同一套约束（32MB、五格式、ffprobe）。
  app.post<{ Params: { episodeId: string; assetId: string } }>(
    '/episodes/:episodeId/assets/:assetId/voice-upload',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const asset = await app.db.asset.findFirst({ where: { id: request.params.assetId, episodeId: episode.id } })
      if (!asset) return reply.code(404).send({ error: 'Asset not found' })
      if (asset.kind !== 'character') return reply.code(400).send({ error: 'voice upload is only for character assets' })

      // 字段与文件可能以任意顺序到达，必须走 parts() 迭代——request.file() 会把
      // 排在文件前后的文本字段静默吞掉（fastify-multipart 的既有坑）。
      let fileBuffer: Buffer | null = null
      let fileMimeType: string | null = null
      let fileExtension = ''
      let filename = ''
      let transcript = ''
      for await (const part of request.parts({ limits: { fileSize: VOICE_SAMPLE_MAX_BYTES, files: 1 } })) {
        if (part.type === 'file') {
          const bytes = await part.toBuffer()
          if (fileBuffer !== null) continue // 多余文件消费后丢弃
          const extension = extname(part.filename ?? '').toLowerCase()
          const mimeType = VOICE_SAMPLE_TYPES.get(extension)
          if (!mimeType) return reply.code(400).send({ error: `only ${[...VOICE_SAMPLE_TYPES.keys()].join(' ')} files are accepted` })
          if (part.file.truncated || bytes.byteLength > VOICE_SAMPLE_MAX_BYTES) {
            return reply.code(413).send({ error: `file is larger than ${Math.round(VOICE_SAMPLE_MAX_BYTES / 1024 / 1024)} MB` })
          }
          if (bytes.byteLength === 0) return reply.code(400).send({ error: 'file is empty' })
          fileBuffer = bytes
          fileMimeType = mimeType
          fileExtension = extension
          filename = part.filename ?? ''
        } else if (part.fieldname === 'transcript' && typeof part.value === 'string') {
          transcript = part.value.slice(0, 2000)
        }
      }
      if (!fileBuffer || !fileMimeType) return reply.code(400).send({ error: 'audio file is required' })

      const durationMs = await probeAudioDuration(fileBuffer, filename || `sample${fileExtension}`)
      const prefix = [auth.organizationId, episode.projectId, episode.id, 'AUDIO', `assetvoice-${asset.id}`].join('/') + '/'
      const version = (await app.db.mediaArtifact.count({ where: { objectKey: { startsWith: prefix } } })) + 1
      const objectKey = buildObjectKey({
        tenantId: auth.organizationId,
        projectId: episode.projectId,
        episodeId: episode.id,
        stage: 'AUDIO',
        entityId: `assetvoice-${asset.id}`,
        version,
        extension: fileExtension.slice(1),
      })
      const stored = await app.storage.put(objectKey, new Uint8Array(fileBuffer), fileMimeType)
      const artifact = await app.db.mediaArtifact.create({
        data: {
          organizationId: auth.organizationId,
          stage: 'AUDIO',
          objectKey: stored.key,
          checksum: stored.checksum,
          mimeType: stored.mimeType,
          version,
          durationMs: durationMs || null,
          metadata: JSON.stringify({ assetVoice: asset.id, transcript, filename, imported: true }),
        },
      })
      const updated = await app.db.asset.update({
        where: { id: asset.id },
        data: { voiceArtifactId: artifact.id },
        select: { id: true, voiceArtifactId: true },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'asset.voice-upload',
        entityType: 'Asset',
        entityId: asset.id,
        payload: { artifactId: artifact.id, filename, bytes: stored.sizeBytes, transcript: transcript.slice(0, 200) },
      })
      return reply.code(201).send({ asset: updated, artifact: toArtifactDto(artifact) })
    },
  )

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
