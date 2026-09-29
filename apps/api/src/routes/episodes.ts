import { basename, extname, join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AudioSource, Prisma, type PrismaClient, type WorkflowStatus as DbWorkflowStatus } from '@studio/db'
import { can, canTransition, durationOutOfRange, formatDefaults, formatDurationRange, isWorkflowStatus, workflowStatuses, type Action, type WorkflowStatus } from '@studio/domain'
import { buildObjectKey, probeDuration } from '@studio/media'
import { recordAudit } from '../lib/audit.js'
import { authenticate, requirePermission } from '../plugins/auth.js'
import type { AuthContext } from '../types.js'
import { toArtifactDto, type ArtifactDto } from './artifacts.js'

function toDbStatus(status: WorkflowStatus): string {
  return status.toUpperCase()
}

function fromDbStatus(status: string): WorkflowStatus {
  return status.toLowerCase() as WorkflowStatus
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
}

async function findEpisodeInOrg(db: PrismaClient, episodeId: string, organizationId: string) {
  return db.episode.findFirst({ where: { id: episodeId, project: { organizationId } } })
}

const emptyProgress = { frames: 0, videos: 0, composed: 0, delivered: 0 }

/**
 * How far each episode of a project has actually got, for the project console's
 * shot-progress column. Neither the episode row nor its shot list says it: media
 * hangs off generation tasks, one re-generated shot has several of them, and only
 * the live breakdown counts. Superseded shots are filtered through the task's own
 * `storyboard` relation so a paid-for frame sitting on a replaced shot never gets
 * tallied as progress the viewer can no longer reach.
 */
async function episodeProgress(db: PrismaClient, projectId: string) {
  const [tasks, compositions, deliveries] = await Promise.all([
    db.generationTask.findMany({
      where: {
        batch: { episode: { projectId } },
        stage: { in: ['FIRST_FRAME', 'VIDEO'] },
        status: 'SUCCEEDED',
        storyboard: { supersededAt: null },
        mediaArtifacts: { some: {} },
      },
      select: { stage: true, storyboardId: true, storyboard: { select: { episodeId: true } } },
    }),
    db.composition.findMany({ where: { episode: { project: { id: projectId } } }, select: { episodeId: true } }),
    db.delivery.findMany({ where: { episode: { project: { id: projectId } } }, select: { episodeId: true } }),
  ])

  const out = new Map<string, typeof emptyProgress>()
  const of = (episodeId: string) => {
    let row = out.get(episodeId)
    if (!row) {
      row = { ...emptyProgress }
      out.set(episodeId, row)
    }
    return row
  }

  // Sets, because the rows are tasks and the answer is shots: two successful
  // first-frame runs of the same shot are one shot with a picture.
  const frames = new Map<string, Set<string>>()
  const videos = new Map<string, Set<string>>()
  for (const task of tasks) {
    const episodeId = task.storyboard?.episodeId
    const shotId = task.storyboardId
    if (!episodeId || !shotId) continue
    const bucket = task.stage === 'FIRST_FRAME' ? frames : videos
    const set = bucket.get(episodeId) ?? new Set<string>()
    set.add(shotId)
    bucket.set(episodeId, set)
  }
  for (const [episodeId, shots] of frames) of(episodeId).frames = shots.size
  for (const [episodeId, shots] of videos) of(episodeId).videos = shots.size
  for (const row of compositions) of(row.episodeId).composed += 1
  for (const row of deliveries) of(row.episodeId).delivered += 1
  return out
}

// Tasks are walked oldest-to-newest so the latest revision overwrites any stale one in
// the map. The shot comes from the task's own `storyboardId`, not from a segment of its
// idempotency key: that key is an anti-collision token, and reading a relation out of it
// would silently detach every shot from its media the day the key format changed.
async function storyboardMedia(db: PrismaClient, episodeId: string): Promise<{ firstFrame: Map<string, ArtifactDto>; video: Map<string, ArtifactDto>; voice: Map<string, ArtifactDto>; importedVoice: Map<string, ArtifactDto>; importedAmbience: Map<string, ArtifactDto>; frameError: Map<string, string>; videoError: Map<string, string>; inflight: Map<string, Set<string>>; taskIds: Map<string, string[]>; landedAt: Map<string, Date>; errorAt: Map<string, Date> }> {
  const firstFrame = new Map<string, ArtifactDto>()
  const video = new Map<string, ArtifactDto>()
  const voice = new Map<string, ArtifactDto>()
  // 人工导入的音频不挂在任何生成任务上，上面那场遍历天然拿不到它；按镜头上的
  // 指针单独取，这样「移除导入」后指针清空、地图也就没有这一项，不会谎报。
  const importedVoice = new Map<string, ArtifactDto>()
  const importedAmbience = new Map<string, ArtifactDto>()
  // 失败原因与产物同样是一等数据:没有它,用户对着"已失败"三个字只能懵逼。
  // 但错误与产物必须同一场遍历裁决——错误曾独立查询"最新失败",结果重生成
  // 成功之后旧失败仍然是最新的失败,横幅永远挂在成功的视频头上。
  const frameError = new Map<string, string>()
  const videoError = new Map<string, string>()
  const inflight = new Map<string, Set<string>>()
  const taskIds = new Map<string, string[]>()
  // 等待时钟的两个来源：最近一次落地的产物、最近一次仍然成立的失败。
  // 分镜本身没有时间字段（schema 里 Storyboard 无 createdAt/updatedAt），
  // 「等了多久」只能从这两类真事件取，宁可显示不出来也不编。
  const landedAt = new Map<string, Date>()
  const errorAt = new Map<string, Date>()
  const tasks = await db.generationTask.findMany({
    where: { batch: { episodeId }, stage: { in: ['FIRST_FRAME', 'VIDEO', 'AUDIO'] }, storyboardId: { not: null }, status: { in: ['SUCCEEDED', 'FAILED', 'QUEUED', 'RUNNING'] } },
    include: { mediaArtifacts: { orderBy: { version: 'desc' }, take: 1 } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  // 事件序(旧→新)遍历:成功写入产物并清掉同阶段的失败——重生成成功的那一刻,
  // 上一次失败描述的问题已被这次成功解决,横幅必须随之消失;新失败覆盖旧失败。
  // 排队/运行中的尝试同样清掉旧失败:只要有一次更新的尝试在途,旧错误就不再是
  // 当前状态——用户点了重新生成,不该再看着上一轮的失败提示。
  for (const task of tasks) {
    if (!task.storyboardId) continue
    const ids = taskIds.get(task.storyboardId) ?? []
    ids.push(task.id)
    taskIds.set(task.storyboardId, ids)
    if (task.status === 'SUCCEEDED') {
      const artifact = task.mediaArtifacts[0]
      if (!artifact) continue
      if (task.stage === 'FIRST_FRAME') {
        firstFrame.set(task.storyboardId, toArtifactDto(artifact))
        frameError.delete(task.storyboardId)
        errorAt.delete(`${task.storyboardId}:FIRST_FRAME`)
      } else if (task.stage === 'VIDEO') {
        video.set(task.storyboardId, toArtifactDto(artifact))
        videoError.delete(task.storyboardId)
        errorAt.delete(`${task.storyboardId}:VIDEO`)
      } else {
        voice.set(task.storyboardId, toArtifactDto(artifact))
      }
      landedAt.set(task.storyboardId, artifact.createdAt)
    } else if (task.status === 'FAILED' && task.errorSnapshot) {
      let message = task.errorSnapshot
      try {
        const parsed: unknown = JSON.parse(task.errorSnapshot)
        message = Array.isArray(parsed) ? parsed.map(String).join(' | ') : String(parsed)
      } catch {
        // keep the raw snapshot text
      }
      if (task.stage === 'FIRST_FRAME') frameError.set(task.storyboardId, message.slice(0, 400))
      else if (task.stage === 'VIDEO') videoError.set(task.storyboardId, message.slice(0, 400))
      else continue
      errorAt.set(`${task.storyboardId}:${task.stage}`, task.updatedAt)
    } else if (task.status === 'QUEUED' || task.status === 'RUNNING') {
      const stages = inflight.get(task.storyboardId) ?? new Set<string>()
      stages.add(task.stage)
      inflight.set(task.storyboardId, stages)
      if (task.stage === 'FIRST_FRAME') {
        frameError.delete(task.storyboardId)
        errorAt.delete(`${task.storyboardId}:FIRST_FRAME`)
      } else if (task.stage === 'VIDEO') {
        videoError.delete(task.storyboardId)
        errorAt.delete(`${task.storyboardId}:VIDEO`)
      }
    }
  }
  const pointers = await db.storyboard.findMany({
    where: { episodeId, OR: [{ importedVoiceArtifactId: { not: null } }, { importedAmbienceArtifactId: { not: null } }] },
    select: { id: true, importedVoiceArtifactId: true, importedAmbienceArtifactId: true },
  })
  const pointerIds = pointers
    .flatMap(pointer => [pointer.importedVoiceArtifactId, pointer.importedAmbienceArtifactId])
    .filter((id): id is string => id !== null)
  if (pointerIds.length > 0) {
    const rows = await db.mediaArtifact.findMany({ where: { id: { in: pointerIds } } })
    const byId = new Map(rows.map(row => [row.id, toArtifactDto(row)]))
    for (const pointer of pointers) {
      const voiceArtifact = pointer.importedVoiceArtifactId ? byId.get(pointer.importedVoiceArtifactId) : undefined
      if (voiceArtifact) importedVoice.set(pointer.id, voiceArtifact)
      const ambienceArtifact = pointer.importedAmbienceArtifactId ? byId.get(pointer.importedAmbienceArtifactId) : undefined
      if (ambienceArtifact) importedAmbience.set(pointer.id, ambienceArtifact)
    }
  }
  return { firstFrame, video, voice, importedVoice, importedAmbience, frameError, videoError, inflight, taskIds, landedAt, errorAt }
}

interface StoryboardAssetDto {
  id: string
  kind: string
  name: string
  status: string
  role: string
}

/** One succeeded VIDEO version of a shot, newest first — the raw material of the selection gate. */
interface VideoCandidateDto {
  artifactId: string
  taskId: string
  version: number
  mimeType: string
  durationMs: number | null
  createdAt: string
  selected: boolean
  qc: { kind: string; status: string; score: number | null; reasons: string[] } | null
}

type StoryboardAssetLink = { role: string; asset: { id: string; kind: string; name: string; status: string } }

type StoryboardRow = Prisma.StoryboardGetPayload<{ include: { assets: true } }>

/**
 * The shot as the console reads it. `revision` and `supersededAt` are what make a
 * regenerated breakdown navigable: a superseded shot is history, still carrying the
 * media it was paid for, and `generationTaskId` traces it to the task that wrote it.
 */
interface StoryboardDto {
  id: string
  episodeId: string
  scriptVersionId: string | null
  generationTaskId: string | null
  revision: number
  number: number
  title: string
  durationMs: number
  description: string
  dialogue: string
  speaker: string | null
  sourceExcerpt: string
  continuityIn: string
  continuityOut: string
  status: DbWorkflowStatus
  supersededAt: string | null
  /** Which of this shot's succeeded clips the human pinned. Null means the selection gate is still open. */
  selectedVideoArtifactId: string | null
  /** 人给这一镜选的声音来源。Null = 未选，合成按镜型默认（有台词=只用配音，无台词=只用原声）。 */
  audioSource: AudioSource | null
  assets: StoryboardRow['assets']
  firstFrame: ArtifactDto | null
  video: ArtifactDto | null
  voice: ArtifactDto | null
  importedVoice: ArtifactDto | null
  /** 这一镜导入的环境音（垫在配音底下的氛围底）。与 audioSource 正交。 */
  importedAmbience: ArtifactDto | null
  firstFrameError: string | null
  videoError: string | null
}

function toStoryboardDto(storyboard: StoryboardRow, media: { firstFrame: Map<string, ArtifactDto>; video: Map<string, ArtifactDto>; voice: Map<string, ArtifactDto>; importedVoice: Map<string, ArtifactDto>; importedAmbience: Map<string, ArtifactDto>; frameError: Map<string, string>; videoError: Map<string, string> }): StoryboardDto {
  return {
    id: storyboard.id,
    episodeId: storyboard.episodeId,
    scriptVersionId: storyboard.scriptVersionId,
    generationTaskId: storyboard.generationTaskId,
    revision: storyboard.revision,
    number: storyboard.number,
    title: storyboard.title,
    durationMs: storyboard.durationMs,
    description: storyboard.description,
    dialogue: storyboard.dialogue,
    speaker: storyboard.speaker,
    sourceExcerpt: storyboard.sourceExcerpt,
    continuityIn: storyboard.continuityIn,
    continuityOut: storyboard.continuityOut,
    status: storyboard.status,
    supersededAt: storyboard.supersededAt?.toISOString() ?? null,
    selectedVideoArtifactId: storyboard.selectedVideoArtifactId,
    audioSource: storyboard.audioSource,
    assets: storyboard.assets,
    firstFrame: media.firstFrame.get(storyboard.id) ?? null,
    video: media.video.get(storyboard.id) ?? null,
    voice: media.voice.get(storyboard.id) ?? null,
    importedVoice: media.importedVoice.get(storyboard.id) ?? null,
    importedAmbience: media.importedAmbience.get(storyboard.id) ?? null,
    firstFrameError: media.frameError.get(storyboard.id) ?? null,
    videoError: media.videoError.get(storyboard.id) ?? null,
  }
}

function toStoryboardAssetDto(link: StoryboardAssetLink): StoryboardAssetDto {
  return { id: link.asset.id, kind: link.asset.kind, name: link.asset.name, status: link.asset.status, role: link.role }
}

async function findStoryboardInOrg(db: PrismaClient, storyboardId: string, organizationId: string) {
  return db.storyboard.findFirst({ where: { id: storyboardId, episode: { project: { organizationId } } } })
}

/** 三件产物的钦定端点共用一个身体：校验「同镜同阶段的成功任务产物」后写指针，
 *  清空即回自动规则。audit 动作名由调用方给出，账本里三种选择可分辨。 */
async function selectStageArtifact(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: { storyboardId: string }; Body: { artifactId?: string | null } }>,
  reply: FastifyReply,
  stage: 'FIRST_FRAME' | 'AUDIO',
  column: 'selectedFrameArtifactId' | 'selectedVoiceArtifactId',
  action: string,
) {
  const auth = request.auth!
  if (request.body?.artifactId === undefined) return reply.code(400).send({ error: 'artifactId is required, null clears the selection' })
  const storyboard = await findStoryboardInOrg(app.db, request.params.storyboardId, auth.organizationId)
  if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })
  if (storyboard.supersededAt) return reply.code(409).send({ error: 'storyboard is superseded' })
  const { artifactId } = request.body
  if (artifactId !== null) {
    const artifact = await app.db.mediaArtifact.findFirst({
      where: { id: artifactId, organizationId: auth.organizationId, stage, task: { status: 'SUCCEEDED', stage, storyboardId: storyboard.id } },
      select: { id: true },
    })
    if (!artifact) return reply.code(400).send({ error: `artifact is not a succeeded ${stage.toLowerCase()} artifact of this shot` })
  }
  const updated = await app.db.storyboard.update({
    where: { id: storyboard.id },
    data: { [column]: artifactId },
    select: { id: true, [column]: true },
  })
  await recordAudit(app.db, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action,
    entityType: 'Storyboard',
    entityId: storyboard.id,
    payload: { artifactId },
  })
  return updated
}


// 导入音频的上限按音频本身定，不跟整本书那条 4 MB 文字天花板走：一段一分钟的
// 配音 WAV 就超了，而全局 multipart 上限一动等于放宽每一个上传端点。
const VOICE_IMPORT_MAX_BYTES = 32 * 1024 * 1024
const VOICE_IMPORT_TYPES = new Map([
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
])

/** 本镜导入的音频有两种角色：顶替配音的，和垫在配音底下的氛围底。 */
type ImportedAudioRole = 'voice' | 'ambience'
type ShotAudioRequest = FastifyRequest<{ Params: { storyboardId: string } }>

/** ffprobe 只吃路径，所以探测时长要落一次临时盘；用完即删，不留孤儿文件。 */
async function withTempFile<T>(bytes: Buffer, filename: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'studio-voice-'))
  const file = join(dir, basename(filename))
  try {
    await writeFile(file, bytes)
    return await fn(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function statusAction(target: WorkflowStatus): Action {
  return target === 'approved' || target === 'blocked' ? 'review:decide' : 'storyboard:write'
}

async function guardStatusAction(auth: AuthContext, target: WorkflowStatus, reply: FastifyReply): Promise<boolean> {
  const action = statusAction(target)
  if (!can(auth.role, action)) {
    await reply.code(403).send({ error: `Role ${auth.role} is not allowed to perform "${action}"` })
    return false
  }
  return true
}

export async function episodeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: { number?: number; title?: string; targetDurationMs?: number } }>(
    '/projects/:projectId/episodes',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const { number, title, targetDurationMs } = request.body ?? {}
      if (!Number.isInteger(number) || (number as number) < 1) return reply.code(400).send({ error: 'number must be a positive integer' })
      if (!title?.trim()) return reply.code(400).send({ error: 'title is required' })
      if (targetDurationMs !== undefined && (!Number.isInteger(targetDurationMs) || targetDurationMs <= 0)) {
        return reply.code(400).send({ error: 'targetDurationMs must be a positive integer' })
      }
      const fmt = project.format.toLowerCase() as 'short_drama' | 'series' | 'film'
      if (targetDurationMs !== undefined && durationOutOfRange(fmt, targetDurationMs)) {
        const range = formatDurationRange[fmt]
        return reply.code(400).send({ error: `targetDurationMs must be between ${range.minMs} and ${range.maxMs} for format ${project.format}` })
      }
      // A film locked to its single episode at project creation: nothing to add.
      if (project.format === 'FILM') {
        const existing = await app.db.episode.findFirst({ where: { projectId: project.id } })
        if (existing) return reply.code(409).send({ error: 'episodes:filmLockedToOne' })
      }
      // Duration defaults cascade: the project's own default wins over the format
      // constant; the pipeline reads the episode value, never the format itself.
      const defaults = formatDefaults[fmt]
      try {
        const episode = await app.db.episode.create({
          data: {
            projectId: project.id,
            number: number as number,
            title: title.trim(),
            targetDurationMs: targetDurationMs ?? project.targetDurationMs ?? defaults.targetDurationMs,
          },
        })
        await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'episode.create', entityType: 'Episode', entityId: episode.id, payload: { number: episode.number, title: episode.title, targetDurationMs: episode.targetDurationMs } })
        return reply.code(201).send(episode)
      } catch (error) {
        if (isPrismaUniqueViolation(error)) return reply.code(409).send({ error: `Episode number ${number} already exists in this project` })
        throw error
      }
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/episodes',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const [episodes, progress] = await Promise.all([
        app.db.episode.findMany({
          where: { projectId: project.id },
          // Superseded shots are history, so an episode's shot list — and the count the
          // console shows next to it — describes the breakdown in use. Source statuses
          // ride along so the project page can flag "draft source awaiting review"
          // without a per-episode round trip.
          include: {
            storyboards: { where: { supersededAt: null }, orderBy: [{ revision: 'asc' }, { number: 'asc' }] },
            sourceVersions: { select: { status: true } },
          },
          orderBy: { number: 'asc' },
        }),
        episodeProgress(app.db, project.id),
      ])
      return episodes.map(episode => ({ ...episode, progress: progress.get(episode.id) ?? emptyProgress }))
    },
  )

  // An episode is deletable while it is still a shell: text drafts (source,
  // script) cascade away, but anything generated, composed or delivered — work
  // that was paid for — refuses the delete instead of silently dying with it.
  app.delete<{ Params: { projectId: string; episodeId: string } }>(
    '/projects/:projectId/episodes/:episodeId',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const project = await app.db.project.findFirst({ where: { id: request.params.projectId, organizationId: auth.organizationId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, projectId: project.id } })
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })

      const [storyboards, batches, compositions, deliveries] = await Promise.all([
        app.db.storyboard.count({ where: { episodeId: episode.id } }),
        app.db.generationBatch.count({ where: { episodeId: episode.id } }),
        app.db.composition.count({ where: { episodeId: episode.id } }),
        app.db.delivery.count({ where: { episodeId: episode.id } }),
      ])
      if (storyboards > 0 || batches > 0 || compositions > 0 || deliveries > 0) {
        return reply.code(409).send({ error: 'episodes:notDeletable' })
      }

      // Chapter allocations pointing here cascade away — those segments fall
      // back to "unassigned" in the split matrix.
      await app.db.episode.delete({ where: { id: episode.id } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'episode.delete',
        entityType: 'Episode',
        entityId: episode.id,
        payload: { projectId: project.id, number: episode.number, title: episode.title },
      })
      return reply.code(204).send()
    },
  )

  app.post<{
    Params: { episodeId: string }
    Body: { number?: number; title?: string; durationMs?: number; description?: string; dialogue?: string; speaker?: string; sourceExcerpt?: string; continuityIn?: string; continuityOut?: string; scriptVersionId?: string }
  }>(
    '/episodes/:episodeId/storyboards',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const body = request.body ?? {}
      if (!Number.isInteger(body.number) || (body.number as number) < 1) return reply.code(400).send({ error: 'number must be a positive integer' })
      if (!body.title?.trim()) return reply.code(400).send({ error: 'title is required' })
      if (!Number.isInteger(body.durationMs) || (body.durationMs as number) <= 0) return reply.code(400).send({ error: 'durationMs must be a positive integer' })
      if (!body.description?.trim()) return reply.code(400).send({ error: 'description is required' })
      if (body.scriptVersionId) {
        const script = await app.db.scriptVersion.findFirst({ where: { id: body.scriptVersionId, episodeId: episode.id } })
        if (!script) return reply.code(400).send({ error: 'scriptVersionId does not belong to this episode' })
      }
      try {
        // A shot a human adds belongs to the breakdown currently in use, not to
        // revision 1 — once the shot list has been regenerated, revision 1 is
        // superseded and a new shot filed there would sit outside the live list.
        const live = await app.db.storyboard.aggregate({
          where: { episodeId: episode.id, supersededAt: null },
          _max: { revision: true },
        })
        const revision = live._max.revision ?? 1
        const storyboard = await app.db.storyboard.create({
          data: {
            episodeId: episode.id,
            scriptVersionId: body.scriptVersionId || null,
            revision,
            number: body.number as number,
            title: body.title.trim(),
            durationMs: body.durationMs as number,
            description: body.description.trim(),
            // An empty line is a silent shot, not an unfilled one: AUDIO looks at this
            // field to decide which shots are worth buying voice for.
            dialogue: body.dialogue?.trim() ?? '',
            speaker: body.speaker?.trim() || null,
            sourceExcerpt: body.sourceExcerpt ?? '',
            continuityIn: body.continuityIn ?? '',
            continuityOut: body.continuityOut ?? '',
          },
        })
        await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'storyboard.create', entityType: 'Storyboard', entityId: storyboard.id, payload: { revision: storyboard.revision, number: storyboard.number, title: storyboard.title } })
        return reply.code(201).send(storyboard)
      } catch (error) {
        if (isPrismaUniqueViolation(error)) return reply.code(409).send({ error: `Storyboard number ${body.number} already exists in this revision` })
        throw error
      }
    },
  )

  // The live shot list by default. `includeSuperseded=true` adds the revisions a
  // regenerate replaced: superseding instead of deleting is only useful if the
  // previous breakdown and the media it was paid for stay readable.
  app.get<{ Params: { episodeId: string }; Querystring: { includeSuperseded?: string } }>(
    '/episodes/:episodeId/storyboards',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const includeSuperseded = request.query?.includeSuperseded === 'true' || request.query?.includeSuperseded === '1'
      const storyboards = await app.db.storyboard.findMany({
        where: { episodeId: episode.id, ...(includeSuperseded ? {} : { supersededAt: null }) },
        include: { assets: true },
        orderBy: [{ revision: 'asc' }, { number: 'asc' }],
      })
      const media = await storyboardMedia(app.db, episode.id)
      return storyboards.map(storyboard => toStoryboardDto(storyboard, media))
    },
  )

  app.patch<{
    Params: { storyboardId: string }
    Body: { title?: string; durationMs?: number; description?: string; dialogue?: string; speaker?: string | null; sourceExcerpt?: string; continuityIn?: string; continuityOut?: string }
  }>(
    '/storyboards/:storyboardId',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => {
      const auth = request.auth!
      const storyboard = await app.db.storyboard.findFirst({ where: { id: request.params.storyboardId, episode: { project: { organizationId: auth.organizationId } } } })
      if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })
      const body = request.body ?? {}
      const data: Record<string, unknown> = {}
      if (body.title !== undefined) {
        if (!body.title.trim()) return reply.code(400).send({ error: 'title must not be empty' })
        data.title = body.title.trim()
      }
      if (body.durationMs !== undefined) {
        if (!Number.isInteger(body.durationMs) || body.durationMs <= 0) return reply.code(400).send({ error: 'durationMs must be a positive integer' })
        data.durationMs = body.durationMs
      }
      if (body.description !== undefined) data.description = body.description
      if (body.dialogue !== undefined) data.dialogue = body.dialogue.trim()
      if (body.speaker !== undefined) data.speaker = body.speaker?.trim() || null
      if (body.sourceExcerpt !== undefined) data.sourceExcerpt = body.sourceExcerpt
      if (body.continuityIn !== undefined) data.continuityIn = body.continuityIn
      if (body.continuityOut !== undefined) data.continuityOut = body.continuityOut
      const updated = await app.db.storyboard.update({ where: { id: storyboard.id }, data })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'storyboard.update', entityType: 'Storyboard', entityId: storyboard.id, payload: { fields: Object.keys(data) } })
      return updated
    },
  )

  app.patch<{ Params: { storyboardId: string }; Body: { to?: string; reason?: string } }>(
    '/storyboards/:storyboardId/status',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const auth = request.auth!
      const { to, reason } = request.body ?? {}
      if (!isWorkflowStatus(to)) return reply.code(400).send({ error: `to must be one of: ${workflowStatuses.join(', ')}` })
      if (!(await guardStatusAction(auth, to, reply))) return

      const storyboard = await app.db.storyboard.findFirst({ where: { id: request.params.storyboardId, episode: { project: { organizationId: auth.organizationId } } } })
      if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })

      const from = fromDbStatus(storyboard.status)
      if (!canTransition(from, to)) {
        return reply.code(409).send({ error: `Illegal transition ${from} → ${to}` })
      }
      const updated = await app.db.storyboard.update({ where: { id: storyboard.id }, data: { status: toDbStatus(to) as typeof storyboard.status } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'storyboard.status',
        entityType: 'Storyboard',
        entityId: storyboard.id,
        payload: { from, to, reason: reason ?? null },
      })
      return updated
    },
  )

  // 选优门:一镜多版时由人钦定入片版本,而不是让 compose 猜"最新"。
  // 与素材版本审批同一语义——同镜同时只有一条选定;清空即回到自动取最新。
  app.post<{ Params: { storyboardId: string }; Body: { artifactId?: string | null } }>(
    '/storyboards/:storyboardId/video-selection',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => {
      const auth = request.auth!
      if (request.body?.artifactId === undefined) return reply.code(400).send({ error: 'artifactId is required, null clears the selection' })
      const storyboard = await findStoryboardInOrg(app.db, request.params.storyboardId, auth.organizationId)
      if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })
      if (storyboard.supersededAt) return reply.code(409).send({ error: 'storyboard is superseded' })
      const { artifactId } = request.body
      if (artifactId !== null) {
        const artifact = await app.db.mediaArtifact.findFirst({
          where: { id: artifactId, organizationId: auth.organizationId, stage: 'VIDEO', task: { status: 'SUCCEEDED', stage: 'VIDEO', storyboardId: storyboard.id } },
          select: { id: true },
        })
        if (!artifact) return reply.code(400).send({ error: 'artifact is not a succeeded video of this shot' })
      }
      const updated = await app.db.storyboard.update({
        where: { id: storyboard.id },
        data: { selectedVideoArtifactId: artifactId },
        select: { id: true, selectedVideoArtifactId: true },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'storyboard.select-video',
        entityType: 'Storyboard',
        entityId: storyboard.id,
        payload: { artifactId },
      })
      return updated
    },
  )

  // 首帧/配音钦定：与视频选优同一语义族。首帧指针=视频生成的条件帧，配音指针=合成
  // 音轨；清空即回到自动取最新成功版。校验口径与 video-selection 一致（同镜同阶段
  // 的成功任务产物才可钦定）。
  app.post<{ Params: { storyboardId: string }; Body: { artifactId?: string | null } }>(
    '/storyboards/:storyboardId/frame-selection',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => selectStageArtifact(app, request, reply, 'FIRST_FRAME', 'selectedFrameArtifactId', 'storyboard.select-frame'),
  )

  app.post<{ Params: { storyboardId: string }; Body: { artifactId?: string | null } }>(
    '/storyboards/:storyboardId/voice-selection',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => selectStageArtifact(app, request, reply, 'AUDIO', 'selectedVoiceArtifactId', 'storyboard.select-voice'),
  )

  // 每镜声音来源：配音 / 原声 / 两者叠加 / 导入。清空即回到镜型默认（有台词=只用
  // 配音，无台词=只用原声）——默认规则留在代码里，翻默认不必回填历史行。
  app.post<{ Params: { storyboardId: string }; Body: { audioSource?: AudioSource | null } }>(
    '/storyboards/:storyboardId/audio-source',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => {
      const auth = request.auth!
      if (request.body?.audioSource === undefined) return reply.code(400).send({ error: 'audioSource is required, null restores the shot-type default' })
      const storyboard = await findStoryboardInOrg(app.db, request.params.storyboardId, auth.organizationId)
      if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })
      if (storyboard.supersededAt) return reply.code(409).send({ error: 'storyboard is superseded' })
      const { audioSource } = request.body
      if (audioSource !== null && !(Object.values(AudioSource) as string[]).includes(audioSource)) {
        return reply.code(400).send({ error: 'unknown audioSource' })
      }
      // 「配音」这一路必须有声音可放：本镜写的台词，或人导入的那条音频。两者都没有时
      // 这一档是空选择，拒掉而不是让成片静音。
      if ((audioSource === 'VOICE' || audioSource === 'VOICE_NATIVE') && storyboard.dialogue === '' && !storyboard.importedVoiceArtifactId) {
        return reply.code(409).send({ error: 'this shot has no dialogue and no imported audio to play' })
      }
      if (audioSource === 'IMPORTED' && !storyboard.importedVoiceArtifactId) {
        return reply.code(409).send({ error: 'import an audio file for this shot first' })
      }
      const updated = await app.db.storyboard.update({
        where: { id: storyboard.id },
        data: { audioSource },
        select: { id: true, audioSource: true },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'storyboard.set-audio-source',
        entityType: 'Storyboard',
        entityId: storyboard.id,
        payload: { audioSource },
      })
      return updated
    },
  )

  // 每镜字幕文本。字幕是硬烧进画面的，交付后改不掉，所以改文本这件事必须在合成前
  // 就能做，且要留痕。清空 = 回到「沿用台词」，也就是合成原本的取值路径。
  // 长度不设自造的天花板：台词本身没有上限，两条路径该有同样的边界。
  app.post<{ Params: { storyboardId: string }; Body: { subtitleText?: string | null } }>(
    '/storyboards/:storyboardId/subtitle',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => {
      const auth = request.auth!
      if (request.body?.subtitleText === undefined) {
        return reply.code(400).send({ error: 'subtitleText is required, null restores the dialogue' })
      }
      const storyboard = await findStoryboardInOrg(app.db, request.params.storyboardId, auth.organizationId)
      if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })
      if (storyboard.supersededAt) return reply.code(409).send({ error: 'storyboard is superseded' })
      const { subtitleText } = request.body
      if (subtitleText !== null && typeof subtitleText !== 'string') {
        return reply.code(400).send({ error: 'subtitleText must be a string or null' })
      }
      const next = subtitleText?.trim() ?? ''
      const updated = await app.db.storyboard.update({
        where: { id: storyboard.id },
        data: { subtitleText: next === '' ? null : next },
        select: { id: true, subtitleText: true },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'storyboard.set-subtitle',
        entityType: 'Storyboard',
        entityId: storyboard.id,
        payload: { subtitleText: updated.subtitleText },
      })
      return updated
    },
  )

  // 导入 / 更换本镜音频。两条轨走同一段流程，区别只在落哪根指针：
  // voice = 这一镜的人声（上传即选中，顺手把声音来源落到「导入音频」）；
  // ambience = 垫在配音下面的环境音（不碰声音来源那一档，选的是氛围底）。
  // 文件不属于任何生成任务，所以它靠 storyboardId 被认回来，版本号按这一镜已导入
  // 过几条累计（objectKey + version 是全库唯一约束）。
  async function importShotAudio(request: ShotAudioRequest, reply: FastifyReply, role: ImportedAudioRole) {
    const auth = request.auth!
    const storyboard = await findStoryboardInOrg(app.db, request.params.storyboardId, auth.organizationId)
    if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })
    if (storyboard.supersededAt) return reply.code(409).send({ error: 'storyboard is superseded' })
    // 整本书那条 4 MB 上限是按字符数算的，音频必须自带天花板，否则先缓冲进内存。
    // 自己判长度而不是让插件抛错：抛错会变成 500，人看到的只是一句「服务器错误」。
    const file = await request.file({ throwFileSizeLimit: false, limits: { fileSize: VOICE_IMPORT_MAX_BYTES, files: 1 } })
    if (!file) return reply.code(400).send({ error: 'audio file is required' })
    const base = basename(file.filename ?? '')
    const extension = extname(base).toLowerCase()
    const mimeType = VOICE_IMPORT_TYPES.get(extension)
    if (!mimeType) {
      return reply.code(400).send({ error: `only ${[...VOICE_IMPORT_TYPES.keys()].join(' ')} files are accepted` })
    }
    const bytes = await file.toBuffer()
    // 到了上限 busboy 不报错，只是丢弃剩余字节并把 truncated 置真——只比长度
    // 等于没比：一条 40MB 的配音会被当成合法的 32MB 文件存下来，尾巴静音且无人知情。
    if (file.file.truncated || bytes.byteLength > VOICE_IMPORT_MAX_BYTES) {
      return reply.code(413).send({ error: `file is larger than ${Math.round(VOICE_IMPORT_MAX_BYTES / 1024 / 1024)} MB` })
    }
    if (bytes.byteLength === 0) return reply.code(400).send({ error: 'file is empty' })
    const episode = await app.db.episode.findUnique({ where: { id: storyboard.episodeId }, select: { id: true, projectId: true } })
    if (!episode) return reply.code(404).send({ error: 'Episode not found' })
    const durationMs = await withTempFile(bytes, base, probeDuration)
    const version = (await app.db.mediaArtifact.count({ where: { storyboardId: storyboard.id, stage: 'AUDIO' } })) + 1
    const objectKey = buildObjectKey({
      tenantId: auth.organizationId,
      projectId: episode.projectId,
      episodeId: episode.id,
      stage: 'AUDIO',
      entityId: `${storyboard.id}-${role}`,
      version,
      extension: extension.slice(1),
    })
    const stored = await app.storage.put(objectKey, new Uint8Array(bytes), mimeType)
    const artifact = await app.db.mediaArtifact.create({
      data: {
        organizationId: auth.organizationId,
        stage: 'AUDIO',
        storyboardId: storyboard.id,
        objectKey: stored.key,
        checksum: stored.checksum,
        mimeType: stored.mimeType,
        version,
        durationMs: durationMs || null,
        metadata: JSON.stringify({ imported: true, role, filename: base }),
      },
    })
    // 只有配音会改声音来源。环境音是叠加层，改它不该把人已经钦定的那一档顶掉。
    const updated = await app.db.storyboard.update({
      where: { id: storyboard.id },
      data: role === 'voice'
        ? { importedVoiceArtifactId: artifact.id, audioSource: 'IMPORTED' }
        : { importedAmbienceArtifactId: artifact.id },
      select: { id: true, audioSource: true, importedVoiceArtifactId: true, importedAmbienceArtifactId: true },
    })
    await recordAudit(app.db, {
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: `storyboard.import-${role}`,
      entityType: 'Storyboard',
      entityId: storyboard.id,
      payload: { artifactId: artifact.id, filename: base, bytes: stored.sizeBytes },
    })
    return reply.code(201).send({ ...updated, artifact: toArtifactDto(artifact) })
  }

  // 移除本镜导入的音频：回到镜型默认。文件行留着——它是人提供的素材，删掉一次
  // 选择理由不该连素材一起销毁。
  async function removeShotAudio(request: ShotAudioRequest, reply: FastifyReply, role: ImportedAudioRole) {
    const auth = request.auth!
    const storyboard = await findStoryboardInOrg(app.db, request.params.storyboardId, auth.organizationId)
    if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })
    const pointer = role === 'voice' ? storyboard.importedVoiceArtifactId : storyboard.importedAmbienceArtifactId
    if (!pointer) return reply.code(409).send({ error: `this shot has no imported ${role} audio` })
    const updated = await app.db.storyboard.update({
      where: { id: storyboard.id },
      data: role === 'voice'
        ? { importedVoiceArtifactId: null, ...(storyboard.audioSource === 'IMPORTED' ? { audioSource: null } : {}) }
        : { importedAmbienceArtifactId: null },
      select: { id: true, audioSource: true, importedVoiceArtifactId: true, importedAmbienceArtifactId: true },
    })
    await recordAudit(app.db, {
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: `storyboard.remove-${role}-import`,
      entityType: 'Storyboard',
      entityId: storyboard.id,
      payload: { artifactId: pointer },
    })
    return updated
  }

  app.post<{ Params: { storyboardId: string } }>(
    '/storyboards/:storyboardId/voice-import',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => importShotAudio(request, reply, 'voice'),
  )

  app.delete<{ Params: { storyboardId: string } }>(
    '/storyboards/:storyboardId/voice-import',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => removeShotAudio(request, reply, 'voice'),
  )

  app.post<{ Params: { storyboardId: string } }>(
    '/storyboards/:storyboardId/ambience-import',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => importShotAudio(request, reply, 'ambience'),
  )

  app.delete<{ Params: { storyboardId: string } }>(
    '/storyboards/:storyboardId/ambience-import',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => removeShotAudio(request, reply, 'ambience'),
  )

  app.get<{ Params: { storyboardId: string } }>(
    '/storyboards/:storyboardId/assets',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const storyboard = await findStoryboardInOrg(app.db, request.params.storyboardId, auth.organizationId)
      if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })
      const links = await app.db.storyboardAsset.findMany({
        where: { storyboardId: storyboard.id },
        include: { asset: { select: { id: true, kind: true, name: true, status: true } } },
        orderBy: { assetId: 'asc' },
      })
      return { assets: links.map(toStoryboardAssetDto) }
    },
  )

  app.put<{
    Params: { storyboardId: string }
    Body: { assets?: { assetId?: unknown; role?: unknown }[] }
  }>(
    '/storyboards/:storyboardId/assets',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => {
      const auth = request.auth!
      const storyboard = await findStoryboardInOrg(app.db, request.params.storyboardId, auth.organizationId)
      if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })

      const entries = request.body?.assets
      if (!Array.isArray(entries)) return reply.code(400).send({ error: 'assets must be an array of { assetId, role }' })
      // A Map deduplicates repeated assetIds; the last occurrence wins.
      const wanted = new Map<string, string>()
      for (const entry of entries) {
        const assetId = entry?.assetId
        if (typeof assetId !== 'string' || !assetId.trim()) return reply.code(400).send({ error: 'each asset requires a non-empty assetId' })
        if (entry.role !== undefined && typeof entry.role !== 'string') return reply.code(400).send({ error: 'role must be a string' })
        wanted.set(assetId, (entry.role as string | undefined) ?? '')
      }

      if (wanted.size > 0) {
        const found = await app.db.asset.findMany({
          where: { id: { in: [...wanted.keys()] }, episodeId: storyboard.episodeId },
          select: { id: true },
        })
        if (found.length !== wanted.size) {
          const valid = new Set(found.map(asset => asset.id))
          const invalid = [...wanted.keys()].find(id => !valid.has(id))
          return reply.code(400).send({ error: `asset ${invalid} does not belong to this episode` })
        }
      }

      await app.db.$transaction([
        app.db.storyboardAsset.deleteMany({ where: { storyboardId: storyboard.id } }),
        app.db.storyboardAsset.createMany({
          data: [...wanted.entries()].map(([assetId, role]) => ({ storyboardId: storyboard.id, assetId, role })),
        }),
      ])
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'storyboard.assets',
        entityType: 'Storyboard',
        entityId: storyboard.id,
        payload: { count: wanted.size, assets: [...wanted.entries()].map(([assetId, role]) => ({ assetId, role })) },
      })

      const links = await app.db.storyboardAsset.findMany({
        where: { storyboardId: storyboard.id },
        include: { asset: { select: { id: true, kind: true, name: true, status: true } } },
        orderBy: { assetId: 'asc' },
      })
      return { assets: links.map(toStoryboardAssetDto) }
    },
  )

  // The shotboard: everything the new overview grid needs in one read, and nothing the
  // engine owns. It aggregates the live breakdown with media, QC verdicts and spend per
  // shot so the console can rank shots by "needs a human" instead of by pipeline stage.
  // Read-only by design — every action on a card still goes through the existing
  // stage routes, so this endpoint can never become a second writer.
  app.get<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/shotboard',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })

      const storyboards = await app.db.storyboard.findMany({
        where: { episodeId: episode.id, supersededAt: null },
        include: {
          assets: {
            include: {
              asset: {
                select: {
                  id: true, kind: true, name: true, status: true,
                  _count: { select: { versions: true } },
                  versions: { where: { status: 'APPROVED', artifactId: { not: null } }, orderBy: { version: 'desc' }, take: 1, select: { id: true } },
                },
              },
            },
            orderBy: { assetId: 'asc' },
          },
        },
        orderBy: [{ revision: 'asc' }, { number: 'asc' }],
      })
      const media = await storyboardMedia(app.db, episode.id)
      const shotIds = storyboards.map(s => s.id)

      // 选优门数据:每一镜全部成功版本(新→旧)与各自的质检结论——三件产物同一口径。
      // 「最新」只是机器的猜测,人要在多个版本之间挑,就得先看见全部候选。
      const stageArtifacts = shotIds.length
        ? await app.db.mediaArtifact.findMany({
            where: { stage: { in: ['VIDEO', 'FIRST_FRAME', 'AUDIO'] }, task: { status: 'SUCCEEDED', storyboardId: { in: shotIds } } },
            include: { task: { select: { id: true, storyboardId: true, createdAt: true } } },
          })
        : []
      const videoArtifacts = stageArtifacts.filter(artifact => artifact.stage === 'VIDEO')
      const stageQcRows = stageArtifacts.length
        ? await app.db.qualityCheck.findMany({ where: { artifactId: { in: stageArtifacts.map(a => a.id) } }, orderBy: { id: 'asc' } })
        : []
      // reasons 一并带出：被审计否决的尝试必须把扣分原因亮给用户——自动重抽花的是
      // 用户的钱，失败理由埋在库里就是黑盒（2026-09-29 用户实测）。
      const latestQcByArtifact = new Map<string, { kind: string; status: string; score: number | null; reasons: string[] }>()
      for (const qc of stageQcRows) {
        if (!qc.artifactId) continue
        let reasons: string[] = []
        try {
          const parsed = JSON.parse(qc.report) as { reasons?: unknown }
          if (Array.isArray(parsed.reasons)) reasons = parsed.reasons.filter((r): r is string => typeof r === 'string').slice(0, 4)
        } catch {
          // 报文不是 JSON（旧格式/人工记录）就没有 reasons，分数照样展示
        }
        latestQcByArtifact.set(qc.artifactId, { kind: qc.kind, status: qc.status, score: qc.score, reasons })
      }
      const artifactsById = new Map(stageArtifacts.map(artifact => [artifact.id, artifact]))
      const candidatesByStage = new Map<'VIDEO' | 'FIRST_FRAME' | 'AUDIO', Map<string, Omit<VideoCandidateDto, 'selected'>[]>>()
      for (const artifact of stageArtifacts) {
        const shotId = artifact.task?.storyboardId
        if (!shotId || !artifact.task) continue
        if (artifact.stage !== 'VIDEO' && artifact.stage !== 'FIRST_FRAME' && artifact.stage !== 'AUDIO') continue
        const byShot = candidatesByStage.get(artifact.stage) ?? new Map<string, Omit<VideoCandidateDto, 'selected'>[]>()
        const list = byShot.get(shotId) ?? []
        list.push({
          artifactId: artifact.id,
          taskId: artifact.task.id,
          version: artifact.version,
          mimeType: artifact.mimeType,
          durationMs: artifact.durationMs,
          createdAt: artifact.task.createdAt.toISOString(),
          qc: latestQcByArtifact.get(artifact.id) ?? null,
        })
        byShot.set(shotId, list)
        candidatesByStage.set(artifact.stage, byShot)
      }
      for (const byShot of candidatesByStage.values()) {
        for (const list of byShot.values()) {
          list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.version - a.version)
        }
      }

      const [qcRows, assetsPending, episodeAssets, statusEvents] = await Promise.all([
        shotIds.length
          ? app.db.qualityCheck.findMany({ where: { storyboardId: { in: shotIds } }, orderBy: { id: 'asc' } })
          : Promise.resolve([]),
        app.db.asset.findMany({
          // 一张参考图都没有的素材同样在等人，只不过等的是「去生成」而不是「去审批」——
          // 从前用 versions:{some:{}} 把它们整条藏掉，泳道因此永远看不见真正的阻塞。
          where: { episodeId: episode.id, status: { not: 'APPROVED' } },
          select: {
            id: true, kind: true, name: true, status: true,
            _count: { select: { versions: true } },
            // 待验收的素材等的是最新那一版，那一版落地即是计时起点。
            versions: { where: { artifactId: { not: null } }, orderBy: { version: 'desc' }, take: 1, select: { artifact: { select: { createdAt: true } } } },
          },
          orderBy: { name: 'asc' },
        }),
        // 班底块:素材自己的档案(长相在最新已审批版本上),出演映射从活体分镜反推。
        app.db.asset.findMany({
          where: { episodeId: episode.id },
          include: {
            _count: { select: { versions: true } },
            versions: { where: { status: 'APPROVED', artifactId: { not: null } }, orderBy: { version: 'desc' }, take: 1, include: { artifact: true } },
          },
          orderBy: { name: 'asc' },
        }),
        // 队列的「等了多久」对阻塞/等审两件事没有别的来源：WorkflowState 不存时间戳，
        // 人推进状态时才有一条 storyboard.status 审计。没有审计就干脆不显示时钟。
        shotIds.length
          ? app.db.auditEvent.findMany({
              where: { organizationId: auth.organizationId, entityType: 'Storyboard', entityId: { in: shotIds }, action: 'storyboard.status' },
              select: { entityId: true, payload: true, createdAt: true },
              orderBy: { createdAt: 'desc' },
            })
          : Promise.resolve([]),
      ])
      const statusAtByShot = new Map<string, Date>()
      for (const event of statusEvents) {
        let to: string | null = null
        try {
          const parsed: unknown = JSON.parse(event.payload)
          if (parsed && typeof parsed === 'object' && 'to' in parsed && typeof (parsed as { to: unknown }).to === 'string') {
            to = (parsed as { to: string }).to
          }
        } catch {
          continue
        }
        if (to !== 'needs_review' && to !== 'blocked') continue
        // 新→旧遍历，每个镜头只认第一次命中的那条：最近一次让它变成你的事。
        if (!statusAtByShot.has(event.entityId)) statusAtByShot.set(event.entityId, event.createdAt)
      }
      // ids are cuids, so ascending id is ascending time here: last write per (shot, kind) wins.
      const latestQc = new Map<string, { kind: string; status: string; score: number | null }>()
      for (const qc of qcRows) {
        if (!qc.storyboardId) continue
        latestQc.set(`${qc.storyboardId}:${qc.kind}`, { kind: qc.kind, status: qc.status, score: qc.score })
      }

      const allTaskIds = [...media.taskIds.values()].flat()
      const shotByTaskId = new Map<string, string>()
      for (const [shotId, ids] of media.taskIds) for (const id of ids) shotByTaskId.set(id, shotId)
      const ledgerRows = allTaskIds.length
        ? await app.db.usageLedger.findMany({ where: { taskId: { in: allTaskIds } }, select: { taskId: true, provider: true, model: true, modality: true, inputUnits: true, outputUnits: true } })
        : []
      const usageByShot = new Map<string, { inputUnits: number; outputUnits: number; models: Set<string>; calls: number }>()
      for (const row of ledgerRows) {
        if (!row.taskId) continue
        const shotId = shotByTaskId.get(row.taskId)
        if (!shotId) continue
        const agg = usageByShot.get(shotId) ?? { inputUnits: 0, outputUnits: 0, models: new Set<string>(), calls: 0 }
        agg.inputUnits += row.inputUnits
        agg.outputUnits += row.outputUnits
        agg.models.add(`${row.provider}/${row.model}`)
        agg.calls += 1
        usageByShot.set(shotId, agg)
      }

      const appearancesByAsset = new Map<string, string[]>()
      const referenceCountByAsset = new Map<string, number>()
      const shots = storyboards.map(storyboard => {
        const inflightStages = [...(media.inflight.get(storyboard.id) ?? [])]
        const linkedAssets = storyboard.assets.map(link => ({
          id: link.asset.id,
          kind: link.asset.kind,
          name: link.asset.name,
          status: link.asset.status,
          role: link.role,
          hasVersions: link.asset._count.versions > 0,
          // 与 triggerStage 的参考图选择同源:有已审批带实体的版本，且（场景不受限，
          // 其余仅当画面文本——标题+描述——真正提到名字）。否则链接了也不定妆。
          reference:
            link.asset.versions.length > 0 &&
            (link.asset.kind === 'scene' ||
              `${storyboard.title} ${storyboard.description}`.includes(link.asset.name.replace(/（[^）]*）|\([^)]*\)/g, '').trim())),
        }))
        for (const asset of linkedAssets) {
          appearancesByAsset.set(asset.id, [...(appearancesByAsset.get(asset.id) ?? []), storyboard.id])
          if (asset.reference) referenceCountByAsset.set(asset.id, (referenceCountByAsset.get(asset.id) ?? 0) + 1)
        }
        const frameError = media.frameError.get(storyboard.id) ?? null
        const videoError = media.videoError.get(storyboard.id) ?? null
        const withSelected = (stage: 'VIDEO' | 'FIRST_FRAME' | 'AUDIO', pointer: string | null): VideoCandidateDto[] =>
          (candidatesByStage.get(stage)?.get(storyboard.id) ?? []).map(candidate => ({
            ...candidate,
            selected: candidate.artifactId === pointer,
          }))
        const candidates = withSelected('VIDEO', storyboard.selectedVideoArtifactId)
        const frameCandidates = withSelected('FIRST_FRAME', storyboard.selectedFrameArtifactId)
        const voiceCandidates = withSelected('AUDIO', storyboard.selectedVoiceArtifactId)
        const attention: string[] = []
        if (storyboard.status === 'BLOCKED') attention.push('shot_blocked')
        if (frameError) attention.push('frame_failed')
        if (videoError) attention.push('video_failed')
        // 等你审是一等缺口：卡在这一步的是人，不是机器，队列必须算它一件。
        if (storyboard.status === 'NEEDS_REVIEW') attention.push('awaiting_review')
        if (linkedAssets.some(a => a.status !== 'APPROVED' && a.hasVersions)) attention.push('asset_gate')
        // 只有真存在多版本可选却没人钦定的镜头才进待处理泳道——单版本没有抉择，
        // 逼人选一次是摩擦不是审计。
        if (candidates.length >= 2 && !candidates.some(c => c.selected)) attention.push('selection_open')
        const usage = usageByShot.get(storyboard.id)
        const qcEntries = [...latestQc.entries()].filter(([key]) => key.startsWith(`${storyboard.id}:`)).map(([, value]) => value)
        // 缩略图跟着选定版本走:卡片展示的必须是将入片的那一版，而不是"最新"。
        const selectedArtifact = candidates.find(candidate => candidate.selected)
          ? artifactsById.get(storyboard.selectedVideoArtifactId!)
          : undefined
        // 每镜占位裁决(放映条与预映共用一个事实源):这一镜现在拿得上画面的东西
        // 是钦定成片 > 最新成功片段 > 在产 > 只有分镜图 > 空。
        const slot = storyboard.selectedVideoArtifactId
          ? 'chosen'
          : media.video.get(storyboard.id)
            ? 'video'
            : inflightStages.length > 0
              ? 'running'
              : media.firstFrame.get(storyboard.id)
                ? 'frame'
                : 'empty'
        // 等待时钟按「哪件事现在压着你」同源取值：失败优先，其次待钦定的最新一版，
        // 再次人推进到等审/阻塞的那一刻，最后才退到最近落地的产物。全都没有就是 null，
        // 前端那一栏索性不显示——没有来源的时间不许上屏。
        const waitingSince =
          (frameError ? media.errorAt.get(`${storyboard.id}:FIRST_FRAME`) : undefined) ??
          (videoError ? media.errorAt.get(`${storyboard.id}:VIDEO`) : undefined) ??
          (attention.includes('selection_open') && candidates[0] ? new Date(candidates[0].createdAt) : undefined) ??
          statusAtByShot.get(storyboard.id) ??
          media.landedAt.get(storyboard.id) ??
          null
        return {
          id: storyboard.id,
          number: storyboard.number,
          revision: storyboard.revision,
          title: storyboard.title,
          durationMs: storyboard.durationMs,
          description: storyboard.description,
          dialogue: storyboard.dialogue,
          subtitleText: storyboard.subtitleText,
          speaker: storyboard.speaker,
          sourceExcerpt: storyboard.sourceExcerpt,
          continuityIn: storyboard.continuityIn,
          continuityOut: storyboard.continuityOut,
          status: storyboard.status,
          assets: linkedAssets,
          // 首帧/配音的生效版与视频同规则：钦定优先，无钦定取最新成功——界面上
          // 听见/看见的必须和下游（条件帧、合成音轨）取的是同一份。
          firstFrame: storyboard.selectedFrameArtifactId && artifactsById.has(storyboard.selectedFrameArtifactId)
            ? toArtifactDto(artifactsById.get(storyboard.selectedFrameArtifactId)!)
            : media.firstFrame.get(storyboard.id) ?? null,
          video: selectedArtifact ? toArtifactDto(selectedArtifact) : media.video.get(storyboard.id) ?? null,
          voice: storyboard.selectedVoiceArtifactId && artifactsById.has(storyboard.selectedVoiceArtifactId)
            ? toArtifactDto(artifactsById.get(storyboard.selectedVoiceArtifactId)!)
            : media.voice.get(storyboard.id) ?? null,
          importedVoice: media.importedVoice.get(storyboard.id) ?? null,
          importedAmbience: media.importedAmbience.get(storyboard.id) ?? null,
          audioSource: storyboard.audioSource,
          firstFrameError: frameError,
          videoError,
          inflight: inflightStages,
          qc: qcEntries,
          selectedVideoArtifactId: storyboard.selectedVideoArtifactId,
          selectedFrameArtifactId: storyboard.selectedFrameArtifactId,
          selectedVoiceArtifactId: storyboard.selectedVoiceArtifactId,
          videoCandidates: candidates,
          frameCandidates,
          voiceCandidates,
          usage: usage ? { inputUnits: usage.inputUnits, outputUnits: usage.outputUnits, models: [...usage.models], calls: usage.calls } : null,
          slot,
          attention,
          waitingSince: waitingSince ? waitingSince.toISOString() : null,
        }
      })

      return {
        episodeId: episode.id,
        number: episode.number,
        title: episode.title,
        status: episode.status,
        shots,
        assets: episodeAssets.map(asset => ({
          id: asset.id,
          kind: asset.kind,
          name: asset.name,
          status: asset.status,
          hasVersions: asset._count.versions > 0,
          appearances: appearancesByAsset.get(asset.id) ?? [],
          referenceCount: referenceCountByAsset.get(asset.id) ?? 0,
          thumbnail: asset.versions[0]?.artifact ? toArtifactDto(asset.versions[0].artifact) : null,
        })),
        assetsPending: assetsPending
          // 泳道只收真的挡路的东西：一张图都没有、又没被任何活体镜头链接的素材缺的是下一集
          // 的图，不是这一集的坑，占一行只会把「需要你处理」的计数灌水。
          .filter(asset => asset._count.versions > 0 || (appearancesByAsset.get(asset.id)?.length ?? 0) > 0)
          .map(asset => ({
            id: asset.id,
            kind: asset.kind,
            name: asset.name,
            status: asset.status,
            // 缺图（要花钱生成）与待审批（只要点一下）是两种活，界面必须分得开。
            hasVersions: asset._count.versions > 0,
            waitingSince: asset.versions[0]?.artifact?.createdAt.toISOString() ?? null,
          })),
      }
    },
  )
}
