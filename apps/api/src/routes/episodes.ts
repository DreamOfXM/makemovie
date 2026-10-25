import { basename, extname, join } from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { resolveVideoArtifactShot, AudioSource, Prisma, type MediaArtifact, type PrismaClient, type WorkflowStatus as DbWorkflowStatus } from '@studio/db'
import { can, canTransition, durationOutOfRange, formatDefaults, formatDurationRange, isArtifactVetoed, isWorkflowStatus, normalizeSpeaker, parseArtifactVeto, workflowStatuses, type Action, type WorkflowStatus } from '@studio/domain'
import { buildObjectKey, probeDuration, probeMediaMeta, renderTitleCard, TitleCardTooLongError, titleCardCanvas, titleCardCapability } from '@studio/media'
import { firstFrameTextDrift, inspectStoryboardGaps, normalizeShotLines, normalizeShotRole, normalizeTransition, parseGenerationReview, parseMethod, projectAspect, resolveTransition, shotProduction, usableFirstFrames, type ShotLine, type ShotProduction } from '@studio/pipeline'
import { recordAudit } from '../lib/audit.js'
import { parseQcReadings, type QcReadings } from '../lib/qc-readings.js'
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
async function storyboardMedia(db: PrismaClient, episodeId: string): Promise<{ firstFrame: Map<string, ArtifactDto>; video: Map<string, ArtifactDto>; voice: Map<string, ArtifactDto>; importedVoice: Map<string, ArtifactDto>; importedAmbience: Map<string, ArtifactDto>; videoParked: Map<string, ArtifactDto>; frameError: Map<string, string>; videoError: Map<string, string>; inflight: Map<string, Set<string>>; inflightAttempt: Map<string, Map<string, number>>; taskIds: Map<string, string[]>; landedAt: Map<string, Date>; errorAt: Map<string, Date> }> {
  const firstFrame = new Map<string, ArtifactDto>()
  const video = new Map<string, ArtifactDto>()
  // SD-168：机器判退、还压在人手上等裁决的那一版成片。生效位仍是空的（它没过线），
  // 但这一镜确实有一条花了钱、播放器放得出来的片。总览靠候选列表知道这一点，流程页
  // 过去只认 SUCCEEDED，于是同一张卡一边写「成片重抽没过线」、读数一边写「还没有成片」。
  const videoParked = new Map<string, ArtifactDto>()
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
  // 在产任务的当前抽数（RUNNING 时 task.attempts=第几抽）：界面要能显示「重抽中·第 2 抽」，
  // 用户才看得见返工在烧第几次（2026-09-29 用户：重抽不用展示吗）。
  const inflightAttempt = new Map<string, Map<string, number>>()
  const taskIds = new Map<string, string[]>()
  // 等待时钟的两个来源：最近一次落地的产物、最近一次仍然成立的失败。
  // 分镜本身没有时间字段（schema 里 Storyboard 无 createdAt/updatedAt），
  // 「等了多久」只能从这两类真事件取，宁可显示不出来也不编。
  const landedAt = new Map<string, Date>()
  const errorAt = new Map<string, Date>()
  const tasks = await db.generationTask.findMany({
    where: { batch: { episodeId }, stage: { in: ['FIRST_FRAME', 'VIDEO', 'AUDIO'] }, storyboardId: { not: null }, status: { in: ['SUCCEEDED', 'FAILED', 'BLOCKED', 'QUEUED', 'RUNNING'] } },
    // SD-172：一次任务可能留好几种版本（重抽/延长），取版要在其中挑「最新且没被否掉的」
    // 那一条，所以只取一条不够——被否的那条必须让位给同任务里上一版可用的。
    include: { mediaArtifacts: { orderBy: { version: 'desc' }, take: 8 } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  // SD-172：人工否决过的那一版不再是这一镜的生效版。事件序是旧→新，跳过赋值就等于
  // 把生效位让回上一版可用的；一条都不剩时生效位空着，界面写「未生成」而不是谎报。
  const usableArtifact = (artifacts: MediaArtifact[]) => artifacts.find(artifact => !isArtifactVetoed(artifact.metadata)) ?? null
  // 事件序(旧→新)遍历:成功写入产物并清掉同阶段的失败——重生成成功的那一刻,
  // 上一次失败描述的问题已被这次成功解决,横幅必须随之消失;新失败覆盖旧失败。
  // 排队/运行中的尝试同样清掉旧失败:只要有一次更新的尝试在途,旧错误就不再是
  // 当前状态——用户点了重新生成,不该再看着上一轮的失败提示。
  for (const task of tasks) {
    if (!task.storyboardId) continue
    const ids = taskIds.get(task.storyboardId) ?? []
    ids.push(task.id)
    taskIds.set(task.storyboardId, ids)
    // 停在「等你裁决」上的那一版：与总览的候选门同一条判据（FAILED + pending 问询 +
    // 被问的就是这一件），两边不许对同一镜给出相反结论。人否过的不算。
    if (task.status === 'FAILED' && task.stage === 'VIDEO') {
      const review = parseGenerationReview(task.reviewSnapshot)
      if (review?.state === 'pending') {
        const parked = task.mediaArtifacts.find(artifact => artifact.id === review.artifactId && !isArtifactVetoed(artifact.metadata))
        if (parked) videoParked.set(task.storyboardId, toArtifactDto(parked))
      }
    }
    if (task.status === 'SUCCEEDED') {
      const artifact = usableArtifact(task.mediaArtifacts)
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
    } else if ((task.status === 'FAILED' || task.status === 'BLOCKED') && task.errorSnapshot) {
      // BLOCKED 的理由同样是这一阶段欠结果的现状:守卫拦下的任务若不把原因带出来,
      // 界面上只剩「未生成」,「生成」又会把同一任务原样重排一次再被拦回——用户
      // 点了没反应、也看不到该先补什么(#19 台账死结 2026-10-22 实测)。
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
      const attemptsByStage = inflightAttempt.get(task.storyboardId) ?? new Map<string, number>()
      attemptsByStage.set(task.stage, task.attempts)
      inflightAttempt.set(task.storyboardId, attemptsByStage)
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
  const localVideos = await db.mediaArtifact.findMany({
    where: { stage: 'VIDEO', taskId: null, importedFor: { episodeId } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  // 本机画面（字卡渲染 / 人工导入）不属于任何生成任务，上面那场遍历拿不到它。
  // 只在镜头没有模型片段时补位：镜头若改回「视频」并成功生成过，生效的那条是
  // 模型产物，早前那张字卡是废稿，不能反过来盖住它。
  for (const artifact of localVideos) {
    const shotId = artifact.storyboardId
    if (!shotId || video.has(shotId)) continue
    // SD-172：本机画面（字卡/导入）同样能被人工否决，否掉就不再补位。
    if (isArtifactVetoed(artifact.metadata)) continue
    video.set(shotId, toArtifactDto(artifact))
    landedAt.set(shotId, artifact.createdAt)
  }
  return { firstFrame, video, voice, importedVoice, importedAmbience, videoParked, frameError, videoError, inflight, inflightAttempt, taskIds, landedAt, errorAt }
}

interface StoryboardAssetDto {
  id: string
  kind: string
  name: string
  status: string
  role: string
}

/** SD-081：质检读数在旧报文里并不存在，缺席时连键都不下发——按整对象比对的旧客户端
 *  不会被三个 undefined 字段打破。 */
interface QcReadingsDto {
  frameScores?: QcReadings['frameScores']
  structureDrift?: QcReadings['structureDrift']
  auditRepetition?: QcReadings['auditRepetition']
}

function qcReadingsDto(readings: QcReadings | null): QcReadingsDto {
  if (!readings) return {}
  return {
    ...(readings.frameScores.length > 0 ? { frameScores: readings.frameScores } : {}),
    ...(readings.structureDrift ? { structureDrift: readings.structureDrift } : {}),
    ...(readings.auditRepetition ? { auditRepetition: readings.auditRepetition } : {}),
  }
}

/** One succeeded VIDEO version of a shot, newest first — the raw material of the selection gate. */
interface VideoCandidateDto {
  artifactId: string
  /** 产生这条版本的生成任务；延长/定向编辑的输出没有任务行，为 null。 */
  taskId: string | null
  /** 来源：生成任务 / 延长操作 / 定向修改操作 / 本机画的字卡 / 人导入的画面（UX-P04，版本行如实标注）。 */
  origin: 'generation' | 'extend' | 'directed_edit' | 'local_render' | 'imported'
  /** 本机画的字卡把卡上的话回传给界面：字卡默认要还是那句话，不能退成镜号占位名。
   *  其余来源没有这句话，为 null。 */
  cardText?: string | null
  version: number
  mimeType: string
  durationMs: number | null
  createdAt: string
  selected: boolean
  qc: ({ kind: string; status: string; score: number | null; reasons: string[] } & QcReadingsDto) | null
  /** 这一版停在「等你裁决」上：任务失败但问询未决，被裁的就是这件产物。能看能播，
   *  但不能直接入片——要么重抽，要么带理由收下；收下之后它才成为可钦定的成功版本。 */
  awaitingDecision?: boolean
  /** SD-172：人被这一版否掉了（标不可用 + 理由）。生效版与合成取版都会跳过它，
   *  但版本行照旧出现——履历不许因为一刀就少一条。 */
  veto: { at: string; reason: string } | null
  /** SD-179：这一版是机器判退后人工「收下」的。收下解锁了合成，不等于想要它：
   *  版本行必须仍然给出重跑入口，所以这个事实要随数据下发，不能让界面去猜。 */
  waived: boolean
  /** 收下时写下的理由（没写就为 null）。 */
  waiveReason: string | null
}

/** 延长/定向编辑操作的状态行（UX-P04）：制作台对板数据无条件轮询，「延长中/修改中/
 *  待确认/失败」的界面反馈全部由它数据驱动，不另开操作状态轮询端点。 */
interface ShotOperationDto {
  id: string
  kind: 'video_extend' | 'video_edit'
  /** QUEUED/RUNNING/BLOCKED(待查询)/FAILED；SUCCEEDED 的结果就是候选本身，不进这张表。 */
  status: string
  error: string | null
  createdAt: string
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
  sceneNumber: number | null
  description: string
  dialogue: string
  speaker: string | null
  sourceExcerpt: string
  continuityIn: string
  continuityOut: string
  /** 镜头类型（main/insert/reaction/ambience/card）。null = 旧数据或自由拆解。 */
  shotRole: string | null
  /** 与上一镜的接法，默认 cut（硬切）。 */
  transition: string
  transitionMs: number
  /** 镜内多句台词；不足两句时为 null，单句仍看 dialogue。 */
  lines: ShotLine[] | null
  /** 这一镜的环境音床（剧本「声音」列）。 */
  ambience: string | null
  /** 这一镜的画面要不要模型产出。流程页的「生成首帧」只排视频镜，手工镜不进计费队列。 */
  production: ShotProduction
  /** 「生成方式」列的原文（人可改，SD-109）。null = 旧数据没写这一列，按视频处理。 */
  method: string | null
  status: DbWorkflowStatus
  supersededAt: string | null
  /** Which of this shot's succeeded clips the human pinned. Null means the selection gate is still open. */
  selectedVideoArtifactId: string | null
  /** 人给这一镜选的声音来源。Null = 未选，合成按镜型默认（有台词=只用配音，无台词=只用原声）。 */
  audioSource: AudioSource | null
  assets: StoryboardRow['assets']
  firstFrame: ArtifactDto | null
  video: ArtifactDto | null
  /** 机器判退、等你裁决的那一版成片：生效位空着，但这一镜确实有一条能播的片（SD-168）。 */
  videoParked: ArtifactDto | null
  voice: ArtifactDto | null
  importedVoice: ArtifactDto | null
  /** 这一镜导入的环境音（垫在配音底下的氛围底）。与 audioSource 正交。 */
  importedAmbience: ArtifactDto | null
  firstFrameError: string | null
  videoError: string | null
}

function toStoryboardDto(storyboard: StoryboardRow, media: { firstFrame: Map<string, ArtifactDto>; video: Map<string, ArtifactDto>; voice: Map<string, ArtifactDto>; importedVoice: Map<string, ArtifactDto>; importedAmbience: Map<string, ArtifactDto>; videoParked: Map<string, ArtifactDto>; frameError: Map<string, string>; videoError: Map<string, string> }): StoryboardDto {
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
    sceneNumber: storyboard.sceneNumber,
    continuityOut: storyboard.continuityOut,
    shotRole: storyboard.shotRole,
    transition: storyboard.transition,
    transitionMs: storyboard.transitionMs,
    lines: Array.isArray(storyboard.lines) ? (storyboard.lines as unknown as ShotLine[]) : null,
    ambience: storyboard.ambience,
    production: shotProduction(storyboard.method),
    method: storyboard.method,
    status: storyboard.status,
    supersededAt: storyboard.supersededAt?.toISOString() ?? null,
    selectedVideoArtifactId: storyboard.selectedVideoArtifactId,
    audioSource: storyboard.audioSource,
    assets: storyboard.assets,
    firstFrame: media.firstFrame.get(storyboard.id) ?? null,
    video: media.video.get(storyboard.id) ?? null,
    videoParked: media.videoParked.get(storyboard.id) ?? null,
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
    // V02:人工钦定是镜头状态变化——必须推进 stateRevision,否则自动采用的
    // apply_if_unchanged 只比较旧 revision 永远查不出人工改选。
    data: { [column]: artifactId, stateRevision: { increment: 1 } },
    select: { id: true, [column]: true, stateRevision: true },
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

  // The target lives on the episode because the split and the pipeline both read
  // it there. Until now it could only be set at creation, so a first episode
  // seeded from a story draft (target null) had no way to state how long it
  // should run. Editing it does not touch existing shots: the next breakdown
  // reads the new target, the current plan stays as paid for.
  app.patch<{ Params: { episodeId: string }; Body: { targetDurationMs?: number } }>(
    '/episodes/:episodeId',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({
        where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } },
        include: { project: { select: { format: true } } },
      })
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      const { targetDurationMs } = request.body ?? {}
      if (targetDurationMs === undefined) return reply.code(400).send({ error: 'targetDurationMs is required' })
      if (!Number.isInteger(targetDurationMs) || targetDurationMs <= 0) {
        return reply.code(400).send({ error: 'targetDurationMs must be a positive integer' })
      }
      const fmt = episode.project.format.toLowerCase() as 'short_drama' | 'series' | 'film'
      if (durationOutOfRange(fmt, targetDurationMs)) {
        const range = formatDurationRange[fmt]
        return reply.code(400).send({ error: `targetDurationMs must be between ${range.minMs} and ${range.maxMs} for format ${episode.project.format}` })
      }
      const updated = await app.db.episode.update({ where: { id: episode.id }, data: { targetDurationMs } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'episode.updateTarget',
        entityType: 'Episode',
        entityId: episode.id,
        payload: { from: episode.targetDurationMs, to: targetDurationMs },
      })
      return updated
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
    Body: {
      number?: number
      title?: string
      durationMs?: number
      description?: string
      dialogue?: string
      speaker?: string
      sourceExcerpt?: string
      continuityIn?: string
      continuityOut?: string
      scriptVersionId?: string
      shotRole?: string | null
      transition?: string
      transitionMs?: number
      lines?: unknown
      ambience?: string | null
      method?: string | null
    }
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
      const shotRole = body.shotRole === undefined || body.shotRole === null || body.shotRole === '' ? null : normalizeShotRole(body.shotRole)
      if (body.shotRole !== undefined && body.shotRole !== null && body.shotRole !== '' && shotRole === null) {
        return reply.code(400).send({ error: 'shotRole must be one of: main, insert, reaction, ambience, card' })
      }
      if (body.transition !== undefined && body.transition !== '' && normalizeTransition(body.transition) === null) {
        return reply.code(400).send({ error: 'transition must be one of: cut, dissolve, fade_in, fade_out, black, flash' })
      }
      const transition = resolveTransition(body.transition, body.transitionMs)
      const lines = normalizeShotLines(body.lines)
      // 「生成方式」是人可以改的：模型把它标错档时，只有重跑整份分镜能纠正就等于一镜卡死。
      const method = body.method === undefined ? null : parseMethod(body.method)
      if (method && !method.ok) return reply.code(400).send({ error: 'method must be one of: 视频, 字卡, 屏幕录制, 合成, 界面' })
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
            speaker: normalizeSpeaker(body.speaker),
            sourceExcerpt: body.sourceExcerpt ?? '',
            continuityIn: body.continuityIn ?? '',
            continuityOut: body.continuityOut ?? '',
            shotRole,
            transition: transition.transition,
            transitionMs: transition.transitionMs,
            lines: lines === null ? Prisma.DbNull : (lines as unknown as Prisma.InputJsonValue),
            ambience: body.ambience?.trim() || null,
            method: method?.ok ? method.value : null,
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
    Body: {
      title?: string
      durationMs?: number
      description?: string
      dialogue?: string
      speaker?: string | null
      sourceExcerpt?: string
      continuityIn?: string
      continuityOut?: string
      shotRole?: string | null
      transition?: string
      transitionMs?: number
      lines?: unknown
      ambience?: string | null
      method?: string | null
    }
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
      if (body.speaker !== undefined) data.speaker = normalizeSpeaker(body.speaker)
      if (body.sourceExcerpt !== undefined) data.sourceExcerpt = body.sourceExcerpt
      if (body.continuityIn !== undefined) data.continuityIn = body.continuityIn
      if (body.continuityOut !== undefined) data.continuityOut = body.continuityOut
      if (body.shotRole !== undefined) {
        const shotRole = body.shotRole === null || body.shotRole === '' ? null : normalizeShotRole(body.shotRole)
        if (body.shotRole !== null && body.shotRole !== '' && shotRole === null) {
          return reply.code(400).send({ error: 'shotRole must be one of: main, insert, reaction, ambience, card' })
        }
        data.shotRole = shotRole
      }
      if (body.transition !== undefined || body.transitionMs !== undefined) {
        if (body.transition !== undefined && body.transition !== '' && normalizeTransition(body.transition) === null) {
          return reply.code(400).send({ error: 'transition must be one of: cut, dissolve, fade_in, fade_out, black, flash' })
        }
        // 只改时长时沿用现有转场：硬切恒为 0，其余夹在 50–1000ms。
        const resolved = resolveTransition(body.transition ?? storyboard.transition, body.transitionMs ?? storyboard.transitionMs)
        data.transition = resolved.transition
        data.transitionMs = resolved.transitionMs
      }
      if (body.lines !== undefined) {
        const lines = normalizeShotLines(body.lines)
        data.lines = lines === null ? Prisma.DbNull : (lines as unknown as Prisma.InputJsonValue)
      }
      if (body.ambience !== undefined) data.ambience = body.ambience?.trim() || null
      if (body.method !== undefined) {
        const method = parseMethod(body.method)
        if (!method.ok) return reply.code(400).send({ error: 'method must be one of: 视频, 字卡, 屏幕录制, 合成, 界面' })
        data.method = method.value
      }
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

  // SD-022：整批分镜审批。逐镜状态机（draft→ready→running→needs_review→approved）
  // 要四次流转才到 approved，人工逐镜推完一整本不现实；这里直接写在活体行上，
  // 与素材/剧本/源文档的整批审批同一先例——审批是人的签收，不借道流水线状态机。
  // 被取代（supersededAt）的旧版镜头绝不触碰：它们是历史，不是当前要签收的那一批。
  // 可选 storyboardIds 把范围收窄到给定镜头（逐镜标记的出口：卡片级「通过」也走
  // 这条路，而不是为了单镜去撬状态机）。
  app.post<{ Params: { episodeId: string }; Body: { to?: string; storyboardIds?: unknown } }>(
    '/episodes/:episodeId/storyboard-status',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const auth = request.auth!
      const { to, storyboardIds } = request.body ?? {}
      if (to !== 'approved' && to !== 'draft') return reply.code(400).send({ error: "to must be 'approved' or 'draft'" })
      if (!(await guardStatusAction(auth, to, reply))) return
      const episode = await findEpisodeInOrg(app.db, request.params.episodeId, auth.organizationId)
      if (!episode) return reply.code(404).send({ error: 'Episode not found' })
      let scopedIds: string[] | null = null
      if (storyboardIds !== undefined) {
        if (!Array.isArray(storyboardIds) || storyboardIds.length === 0 || storyboardIds.some(id => typeof id !== 'string' || id.trim() === '')) {
          return reply.code(400).send({ error: 'storyboardIds must be a non-empty array of storyboard ids' })
        }
        scopedIds = storyboardIds as string[]
      }
      const nextStatus: DbWorkflowStatus = to === 'approved' ? 'APPROVED' : 'DRAFT'
      const { count } = await app.db.storyboard.updateMany({
        where: { episodeId: episode.id, supersededAt: null, ...(scopedIds ? { id: { in: scopedIds } } : {}) },
        data: { status: nextStatus },
      })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: to === 'approved' ? 'storyboard.bulkApprove' : 'storyboard.bulkReopen',
        entityType: 'Episode',
        entityId: episode.id,
        payload: { to, count, ...(scopedIds ? { storyboardIds: scopedIds } : {}) },
      })
      return { updated: count }
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
        // 钦定的信任条件:本镜成功任务的产物,或经统一归属解析器验证过操作链的
        // 延长产物——人可以重新钦定加长版,也可以从加长版换回任务产物。
        const artifact = (await resolveVideoArtifactShot(app.db, artifactId, auth.organizationId))?.storyboardId === storyboard.id
          ? await app.db.mediaArtifact.findFirst({ where: { id: artifactId, organizationId: auth.organizationId, stage: 'VIDEO' }, select: { id: true } })
          : null
        if (!artifact) {
          // 拼接段不是「这一镜的一个版本」：它只是母带的一块,单独钦定就等于把
          // 接缝交回时间线。这里不能混在「不是本镜成功视频」里拒绝——那会让人
          // 以为产物丢了,而真正要做的是去钦定整镜母带。
          const segment = await app.db.mediaArtifact.findFirst({
            where: { id: artifactId, organizationId: auth.organizationId, stage: 'VIDEO' },
            select: { metadata: true },
          })
          const role = (JSON.parse(segment?.metadata ?? '{}') as { role?: unknown }).role
          if (role === 'take-video' || role === 'take-end-frame') {
            return reply.code(400).send({ error: 'this cut is one segment of a spliced shot — select the shot master, not a single take' })
          }
          return reply.code(400).send({ error: 'artifact is not a succeeded video of this shot' })
        }
      }
      const updated = await app.db.storyboard.update({
        where: { id: storyboard.id },
        // V02:人工改选推进 stateRevision——自动采用的 CAS 依据它发现「读取之后、
        // 写入之前」的人工意图变化。
        data: { selectedVideoArtifactId: artifactId, stateRevision: { increment: 1 } },
        select: { id: true, selectedVideoArtifactId: true, stateRevision: true },
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

  // ── 手工制作镜（分镜表「生成方式≠视频」）的画面入口 ──────────────────────────
  // 这些镜头不排模型任务，平台此前唯一给它们的东西是一句「由人在剪辑里做」——于是
  // 时间线里它们是空的，「合成整集」在第一处空镜头抛错，而人明明做完了他该做的部分。
  // 字卡镜头本来就没有可拍的素材、只有一句话，所以画面由本机 ffmpeg 画；界面/录屏/
  // 合成三档由人给一段视频。两条路都不碰厂商、不进用量账本：这一镜没有买过任何东西，
  // 产物只挂在镜头自己的视频指针上，与模型版本同一条入片路径。
  const VIDEO_IMPORT_MAX_BYTES = 256 * 1024 * 1024
  const VIDEO_IMPORT_TYPES = new Map([
    ['.mp4', 'video/mp4'],
    ['.m4v', 'video/mp4'],
    ['.mov', 'video/quicktime'],
    ['.webm', 'video/webm'],
  ])

  type ShotVideoRequest = FastifyRequest<{ Params: { storyboardId: string } }>
  type TitleCardRequest = FastifyRequest<{ Params: { storyboardId: string }; Body: { text?: unknown } }>

  /** 画幅与出片同源（配方快照优先，无快照按项目形态兜底），画布跟着画幅走，
   *  否则一张 16:9 的字卡塞进竖屏时间线会被二次缩放，字糊成一团。 */
  async function shotCanvas(app: FastifyInstance, episodeId: string) {
    const episode = await app.db.episode.findUnique({
      where: { id: episodeId },
      select: { id: true, projectId: true, project: { select: { format: true, recipeSnapshot: true } } },
    })
    if (!episode) return null
    const aspect = projectAspect(episode.project?.recipeSnapshot ?? null, episode.project?.format ?? '')
    return { ...episode, ...titleCardCanvas(aspect) }
  }

  /** 本机画面与模型产物走同一条落库路径：同一个 key 构造器、同一个 stage、同一根
   *  镜头指针。差别只有一处——它不属于任何生成任务，所以用量账本里不会有它。 */
  async function storeShotVideo(app: FastifyInstance, auth: AuthContext, reply: FastifyReply, input: {
    shotId: string
    projectId: string
    episodeId: string
    bytes: Buffer
    extension: string
    mimeType: string
    width: number
    height: number
    durationMs: number
    version: number
    metadata: Record<string, unknown>
    action: string
    entityId: string
  }) {
    const stored = await app.storage.put(
      buildObjectKey({
        tenantId: auth.organizationId,
        projectId: input.projectId,
        episodeId: input.episodeId,
        stage: 'VIDEO',
        entityId: input.entityId,
        version: input.version,
        extension: input.extension,
      }),
      new Uint8Array(input.bytes),
      input.mimeType,
    )
    const artifact = await app.db.mediaArtifact.create({
      data: {
        organizationId: auth.organizationId,
        stage: 'VIDEO',
        storyboardId: input.shotId,
        objectKey: stored.key,
        checksum: stored.checksum,
        mimeType: stored.mimeType,
        version: input.version,
        width: input.width,
        height: input.height,
        durationMs: input.durationMs,
        metadata: JSON.stringify(input.metadata),
      },
    })
    // 上传即选中：这一镜只有人给的这一条画面，若还要他再去版本行点一次钦定，
    // 等于把「画面空着」换成「画面有了但你没选」。人工改选推进 stateRevision，与
    // video-selection 同一口径（自动采用的 CAS 依据它）。
    const updated = await app.db.storyboard.update({
      where: { id: input.shotId },
      data: { selectedVideoArtifactId: artifact.id, stateRevision: { increment: 1 } },
      select: { id: true, selectedVideoArtifactId: true, stateRevision: true },
    })
    await recordAudit(app.db, {
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: input.action,
      entityType: 'Storyboard',
      entityId: input.shotId,
      payload: { artifactId: artifact.id, ...input.metadata },
    })
    return reply.code(201).send({ ...updated, artifact: toArtifactDto(artifact) })
  }

  async function renderShotTitleCard(request: TitleCardRequest, reply: FastifyReply) {
    const auth = request.auth!
    const storyboard = await findStoryboardInOrg(app.db, request.params.storyboardId, auth.organizationId)
    if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })
    if (storyboard.supersededAt) return reply.code(409).send({ error: 'storyboard is superseded' })
    if (shotProduction(storyboard.method) !== 'title-card') {
      return reply.code(409).send({ error: 'this shot is not a title card shot' })
    }
    // 缺 drawtext 与缺中文字体是两件不同的事，修复动作也不同（换 ffmpeg 构建 / 装字体）。
    // 报成「生成失败」会让人去重抽一张根本不归模型画的卡。
    const capability = await titleCardCapability()
    if (!capability.canRender) {
      return reply.code(501).send({
        error: capability.blocker === 'no_cjk_font'
          ? 'no Chinese-capable font on this machine, so title cards cannot be drawn'
          : 'this ffmpeg build has no text filter, so title cards cannot be drawn',
      })
    }
    const body = request.body?.text
    if (body !== undefined && typeof body !== 'string') return reply.code(400).send({ error: 'text must be a string' })
    // 不带文案重画时沿用上一次的卡上原文。直接退回 storyboard.title 会把真文案覆盖成分镜表里的
    // 占位镜号（「镜头7」）——那是这一镜的名字，不是要给观众看的那句话。
    const earlier = await app.db.mediaArtifact.findFirst({
      where: { storyboardId: storyboard.id, stage: 'VIDEO' },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    })
    let earlierText: string | null = null
    try {
      const meta = JSON.parse(earlier?.metadata ?? '{}') as { rendered?: unknown; text?: unknown }
      if (meta.rendered === true && typeof meta.text === 'string') earlierText = meta.text
    } catch { /* 元数据读不出就按「没有上一次」处理，仍可由调用方显式给文案 */ }
    const cardText = (body ?? earlierText ?? storyboard.title).trim()
    if (cardText === '') return reply.code(400).send({ error: 'title card text is empty' })
    const canvas = await shotCanvas(app, storyboard.episodeId)
    if (!canvas) return reply.code(404).send({ error: 'Episode not found' })
    // 字卡不占额度，所以它没有「先确认再花钱」这一段；但画一次要落一次盘，
    // 用完即删——渲染中间产物留在临时目录里，攒久了就是一次制作吃掉一整块盘。
    const dir = await mkdtemp(join(tmpdir(), 'studio-title-card-'))
    const outPath = join(dir, 'title-card.mp4')
    try {
      const rendered = await renderTitleCard({
        text: cardText,
        outPath,
        durationMs: storyboard.durationMs,
        width: canvas.width,
        height: canvas.height,
      })
      const bytes = await readFile(outPath)
      const version = (await app.db.mediaArtifact.count({ where: { storyboardId: storyboard.id, stage: 'VIDEO' } })) + 1
      return await storeShotVideo(app, auth, reply, {
        shotId: storyboard.id,
        projectId: canvas.projectId,
        episodeId: canvas.id,
        bytes,
        extension: 'mp4',
        mimeType: 'video/mp4',
        width: rendered.width,
        height: rendered.height,
        durationMs: rendered.durationMs,
        version,
        metadata: { rendered: true, text: cardText, lines: rendered.lines },
        action: 'storyboard.render-title-card',
        entityId: `${storyboard.id}-local`,
      })
    } catch (error) {
      if (error instanceof TitleCardTooLongError) {
        return reply.code(400).send({ error: 'title card text does not fit on one card' })
      }
      throw error
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async function importShotVideo(request: ShotVideoRequest, reply: FastifyReply) {
    const auth = request.auth!
    const storyboard = await findStoryboardInOrg(app.db, request.params.storyboardId, auth.organizationId)
    if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })
    if (storyboard.supersededAt) return reply.code(409).send({ error: 'storyboard is superseded' })
    // 档位是「视频」的镜头同样允许导入（SD-178）：模型出不了片时，人给的这一条画面是
    // 唯一出口——落库会把 selectedVideoArtifactId 指向它，后续模型候选不会自动顶掉，
    // 所以不需要在这里按档位设卡，设卡只会让这一镜把整集永久堵死。
    const file = await request.file({ throwFileSizeLimit: false, limits: { fileSize: VIDEO_IMPORT_MAX_BYTES, files: 1 } })
    if (!file) return reply.code(400).send({ error: 'video file is required' })
    const base = basename(file.filename ?? '')
    const extension = extname(base).toLowerCase()
    const mimeType = VIDEO_IMPORT_TYPES.get(extension)
    if (!mimeType) {
      return reply.code(400).send({ error: `only ${[...VIDEO_IMPORT_TYPES.keys()].join(' ')} files are accepted` })
    }
    const bytes = await file.toBuffer()
    if (file.file.truncated || bytes.byteLength > VIDEO_IMPORT_MAX_BYTES) {
      return reply.code(413).send({ error: `file is larger than ${Math.round(VIDEO_IMPORT_MAX_BYTES / 1024 / 1024)} MB` })
    }
    if (bytes.byteLength === 0) return reply.code(400).send({ error: 'file is empty' })
    const canvas = await shotCanvas(app, storyboard.episodeId)
    if (!canvas) return reply.code(404).send({ error: 'Episode not found' })
    // 实测尺寸与时长必须读到：读不出就收下，等于让一条「不知道多长」的片段进时间线，
    // 而合成会拿分镜计划时长冒充素材实长——这是 SD-099 已经踩过一次的坑。
    const meta = await withTempFile(bytes, base, probeMediaMeta)
    if (!meta?.durationMs) return reply.code(400).send({ error: 'this video file cannot be read, export it again as mp4' })
    const version = (await app.db.mediaArtifact.count({ where: { storyboardId: storyboard.id, stage: 'VIDEO' } })) + 1
    return storeShotVideo(app, auth, reply, {
      shotId: storyboard.id,
      projectId: canvas.projectId,
      episodeId: canvas.id,
      bytes,
      extension: extension.slice(1),
      mimeType,
      width: meta.width ?? canvas.width,
      height: meta.height ?? canvas.height,
      durationMs: meta.durationMs,
      version,
      metadata: { imported: true, filename: base },
      action: 'storyboard.import-video',
      entityId: `${storyboard.id}-import`,
    })
  }

  app.post<{ Params: { storyboardId: string }; Body: { text?: unknown } }>(
    '/storyboards/:storyboardId/title-card',
    { preHandler: requirePermission('storyboard:write') },
    renderShotTitleCard,
  )

  app.post<{ Params: { storyboardId: string } }>(
    '/storyboards/:storyboardId/video-import',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => importShotVideo(request, reply),
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
    Body: { assets?: { assetId?: unknown }[] }
  }>(
    '/storyboards/:storyboardId/assets',
    { preHandler: requirePermission('storyboard:write') },
    async (request, reply) => {
      const auth = request.auth!
      const storyboard = await findStoryboardInOrg(app.db, request.params.storyboardId, auth.organizationId)
      if (!storyboard) return reply.code(404).send({ error: 'Storyboard not found' })

      const entries = request.body?.assets
      if (!Array.isArray(entries)) return reply.code(400).send({ error: 'assets must be an array of { assetId }' })
      // 集合去重且保留首次出现的顺序。role 不接受客户端传值：这一列只有一个词表，
      // 就是素材自己的 kind（SD-123——模型路径写 asset.kind、手工路径曾写 'appears'，
      // 同一列两套词，下游任何按 role 的读取都会分叉）。
      const wanted = new Set<string>()
      for (const entry of entries) {
        const assetId = entry?.assetId
        if (typeof assetId !== 'string' || !assetId.trim()) return reply.code(400).send({ error: 'each asset requires a non-empty assetId' })
        wanted.add(assetId)
      }

      const kindById = new Map<string, string>()
      if (wanted.size > 0) {
        const found = await app.db.asset.findMany({
          where: { id: { in: [...wanted] }, episodeId: storyboard.episodeId },
          select: { id: true, kind: true },
        })
        if (found.length !== wanted.size) {
          const valid = new Set(found.map(asset => asset.id))
          const invalid = [...wanted].find(id => !valid.has(id))
          return reply.code(400).send({ error: `asset ${invalid} does not belong to this episode` })
        }
        for (const asset of found) kindById.set(asset.id, asset.kind)
      }

      const rows = [...wanted].map(assetId => ({ storyboardId: storyboard.id, assetId, role: kindById.get(assetId) ?? '' }))
      await app.db.$transaction([
        app.db.storyboardAsset.deleteMany({ where: { storyboardId: storyboard.id } }),
        app.db.storyboardAsset.createMany({ data: rows }),
      ])
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'storyboard.assets',
        entityType: 'Storyboard',
        entityId: storyboard.id,
        payload: { count: rows.length, assets: rows.map(row => ({ assetId: row.assetId, role: row.role })) },
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
      // FAILED 也进这条查询:停在「等你裁决」上的那一版是真花了钱的成片,把它从版本
      // 列表里吃掉,屏上那句「决定再抽一次还是收下」就成了空话（SD-120）。哪些失败
      // 尝试真的算候选,在下面按问询状态逐条筛,不在这里放宽。
      const stageArtifacts = shotIds.length
        ? await app.db.mediaArtifact.findMany({
            where: { stage: { in: ['VIDEO', 'FIRST_FRAME', 'AUDIO'] }, task: { status: { in: ['SUCCEEDED', 'FAILED'] }, storyboardId: { in: shotIds } } },
            include: { task: { select: { id: true, storyboardId: true, status: true, reviewSnapshot: true, createdAt: true } } },
          })
        : []
      // 操作产物并入候选(UX-P04):延长/定向编辑的输出没有任务行——上面那条查询
      // inner join task,把 taskId=null 的制品整条排除,操作成功落库后版本列表仍只有
      // 原视频一条。信任路径不变:先按本组织 SUCCEEDED 操作行找出输出制品(快照
      // storyboardId 先落在本次板内只是省一次解析,不是信任判据),再逐条过统一归属
      // 解析器 resolveVideoArtifactShot——操作行终态 + 快照归属的镜头确属本组织,
      // 三重校验缺一不可;解析不过、或解析到本集之外的镜头(跨镜/跨组织伪造行)
      // 一律不并入。绝不为纳入 taskId=null 制品而放宽归属检查。
      const operationShotIds = new Set(shotIds)
      const operationOutputs: { artifactId: string; storyboardId: string; kind: 'video_extend' | 'video_edit'; createdAt: Date }[] = []
      if (shotIds.length > 0) {
        const operations = await app.db.artifactOperation.findMany({
          where: { organizationId: auth.organizationId, status: 'SUCCEEDED', kind: { in: ['video_extend', 'video_edit'] }, outputArtifactId: { not: null } },
          select: { kind: true, outputArtifactId: true, requestSnapshot: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        })
        const seenOutput = new Set<string>()
        for (const operation of operations) {
          const outputId = operation.outputArtifactId
          if (!outputId || seenOutput.has(outputId)) continue
          let storyboardId: string | null = null
          try {
            storyboardId = (JSON.parse(operation.requestSnapshot) as { storyboardId?: string }).storyboardId ?? null
          } catch {
            // 快照损坏的行解析不出归属,跳过——统一解析器同样不会信它
            continue
          }
          if (!storyboardId || !operationShotIds.has(storyboardId)) continue
          // 统一归属解析器是唯一信任入口:跨组织/跨镜的伪造操作行在这里被拒绝。
          const context = await resolveVideoArtifactShot(app.db, outputId, auth.organizationId)
          if (!context || context.storyboardId !== storyboardId) continue
          seenOutput.add(outputId)
          operationOutputs.push({ artifactId: outputId, storyboardId, kind: operation.kind as 'video_extend' | 'video_edit', createdAt: operation.createdAt })
        }
      }
      const operationArtifacts = operationOutputs.length > 0
        ? await app.db.mediaArtifact.findMany({
            where: { id: { in: operationOutputs.map(entry => entry.artifactId) }, organizationId: auth.organizationId, stage: 'VIDEO' },
          })
        : []
      const operationByArtifact = new Map(operationOutputs.map(entry => [entry.artifactId, entry]))
      // 本机画面（字卡渲染 / 人工导入）并入候选：它们没有任务行，上面那条 inner join
      // task 的查询会整条排除，于是人自己做的那条在版本列表里根本不出现——镜头明明
      // 有画面，界面却读成「自动取最新」。归属不靠快照解析：artifact 行自带
      // organizationId 与 storyboardId，storyboardId 又钉死在本次板内（板本身已过
      // 组织校验），且客户端从不指认这些 id，所以这不是裸 artifactId 读取。
      const localArtifacts = shotIds.length
        ? await app.db.mediaArtifact.findMany({
            where: { stage: 'VIDEO', taskId: null, storyboardId: { in: shotIds }, organizationId: auth.organizationId },
          })
        : []
      const stageQcRows = stageArtifacts.length + operationArtifacts.length + localArtifacts.length > 0
        ? await app.db.qualityCheck.findMany({ where: { artifactId: { in: [...stageArtifacts, ...operationArtifacts, ...localArtifacts].map(a => a.id) } }, orderBy: { id: 'asc' } })
        : []
      // reasons 一并带出：被审计否决的尝试必须把扣分原因亮给用户——自动重抽花的是
      // 用户的钱，失败理由埋在库里就是黑盒（2026-09-29 用户实测）。
      const latestQcByArtifact = new Map<string, { kind: string; status: string; score: number | null; reasons: string[] } & QcReadingsDto>()
      for (const qc of stageQcRows) {
        if (!qc.artifactId) continue
        let reasons: string[] = []
        try {
          const parsed = JSON.parse(qc.report) as { reasons?: unknown }
          if (Array.isArray(parsed.reasons)) reasons = parsed.reasons.filter((r): r is string => typeof r === 'string').slice(0, 4)
        } catch {
          // 报文不是 JSON（旧格式/人工记录）就没有 reasons，分数照样展示
        }
        latestQcByArtifact.set(qc.artifactId, { kind: qc.kind, status: qc.status, score: qc.score, reasons, ...qcReadingsDto(parseQcReadings(qc.report)) })
      }
      const artifactsById = new Map([...stageArtifacts, ...operationArtifacts, ...localArtifacts].map(artifact => [artifact.id, artifact]))
      const candidatesByStage = new Map<'VIDEO' | 'FIRST_FRAME' | 'AUDIO', Map<string, Omit<VideoCandidateDto, 'selected'>[]>>()
      /** SD-172：版本行要说「这一版被否了」，就得把否决的时刻与理由一起下发；
       *  界面自己解析 metadata 会与服务端的编解码分叉，所以事实源只在这里出一份。 */
      const vetoField = (metadata: string | null) => {
        const veto = parseArtifactVeto(metadata)
        return veto ? { at: veto.at, reason: veto.reason } : null
      }
      for (const artifact of stageArtifacts) {
        const task = artifact.task
        const shotId = task?.storyboardId
        if (!shotId || !task) continue
        if (artifact.stage !== 'VIDEO' && artifact.stage !== 'FIRST_FRAME' && artifact.stage !== 'AUDIO') continue
        // 失败任务只有「问询还压在人手上、且被问的就是这一件」才进候选。已经决定重抽的、
        // 没有问询记录的失败尝试由失败行自己说话——把它们混进版本列表会把「等你决定」
        // 和「已经过去了」弄成同一堆。解析问询只认 pipeline 的那一份严格解析器。
        const review = parseGenerationReview(task.reviewSnapshot)
        const awaitingDecision = task.status === 'FAILED' && review !== null && review.state === 'pending' && review.artifactId === artifact.id
        if (task.status === 'FAILED' && !awaitingDecision) continue
        // SD-179：机器判退、人被收下的那一版。收下≠想要：版本行仍要给出重跑入口，
        // 而这个入口只在「这一版是收下来的」时才有意义，所以把它作为数据下发。
        const waived = task.status === 'SUCCEEDED' && review !== null && review.state === 'waived' && review.artifactId === artifact.id
        const byShot = candidatesByStage.get(artifact.stage) ?? new Map<string, Omit<VideoCandidateDto, 'selected'>[]>()
        const list = byShot.get(shotId) ?? []
        list.push({
          artifactId: artifact.id,
          taskId: task.id,
          origin: 'generation',
          cardText: null,
          version: artifact.version,
          mimeType: artifact.mimeType,
          durationMs: artifact.durationMs,
          createdAt: task.createdAt.toISOString(),
          qc: latestQcByArtifact.get(artifact.id) ?? null,
          awaitingDecision,
          veto: vetoField(artifact.metadata),
          waived,
          waiveReason: waived ? review?.waiveReason ?? null : null,
        })
        byShot.set(shotId, list)
        candidatesByStage.set(artifact.stage, byShot)
      }
      // 操作产物只有 VIDEO 一档,追加进视频候选并如实标注来源;与任务产物按
      // artifactId 去重(两路来源本不相交,防御性去重保证同一制品绝不重复成两票)。
      for (const artifact of operationArtifacts) {
        const meta = operationByArtifact.get(artifact.id)
        if (!meta) continue
        const byShot = candidatesByStage.get('VIDEO') ?? new Map<string, Omit<VideoCandidateDto, 'selected'>[]>()
        const list = byShot.get(meta.storyboardId) ?? []
        if (list.some(candidate => candidate.artifactId === artifact.id)) continue
        list.push({
          artifactId: artifact.id,
          taskId: null,
          origin: meta.kind === 'video_edit' ? 'directed_edit' : 'extend',
          cardText: null,
          version: artifact.version,
          mimeType: artifact.mimeType,
          durationMs: artifact.durationMs,
          createdAt: meta.createdAt.toISOString(),
          qc: latestQcByArtifact.get(artifact.id) ?? null,
          awaitingDecision: false,
          veto: vetoField(artifact.metadata),
          waived: false,
          waiveReason: null,
        })
        byShot.set(meta.storyboardId, list)
        candidatesByStage.set('VIDEO', byShot)
      }
      // 本机画面按 artifact 自带的镜头归属并入，版本行如实标注来源：字卡是平台自己
      // 画的（local_render），其余是人在别处做完再给进来的（imported）。两者都没有
      // 任务、没有质检，也不该有——它们一分钱额度没花。
      for (const artifact of localArtifacts) {
        const shotId = artifact.storyboardId
        if (!shotId) continue
        const byShot = candidatesByStage.get('VIDEO') ?? new Map<string, Omit<VideoCandidateDto, 'selected'>[]>()
        const list = byShot.get(shotId) ?? []
        if (list.some(candidate => candidate.artifactId === artifact.id)) continue
        let rendered = false
        let cardText: string | null = null
        try {
          const meta = JSON.parse(artifact.metadata ?? '{}') as { rendered?: unknown; text?: unknown }
          rendered = meta.rendered === true
          if (typeof meta.text === 'string') cardText = meta.text
        } catch {
          // 元数据读不出就当导入件标注，不影响这一条能否入片
        }
        list.push({
          artifactId: artifact.id,
          taskId: null,
          origin: rendered ? 'local_render' : 'imported',
          cardText,
          version: artifact.version,
          mimeType: artifact.mimeType,
          durationMs: artifact.durationMs,
          createdAt: artifact.createdAt.toISOString(),
          qc: null,
          awaitingDecision: false,
          veto: vetoField(artifact.metadata),
          waived: false,
          waiveReason: null,
        })
        byShot.set(shotId, list)
        candidatesByStage.set('VIDEO', byShot)
      }
      for (const byShot of candidatesByStage.values()) {
        for (const list of byShot.values()) {
          list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.version - a.version)
        }
      }

      // 操作状态(UX-P04):延长/定向编辑是异步操作,状态就挂在板上——制作台对板数据
      // 做无条件轮询,界面的「延长中/修改中/待确认/失败」由这份列表数据驱动。归属同样
      // 只信操作行快照里的 storyboardId(与统一解析器同源),SUCCEEDED 不进这张表——
      // 它的结果就是上面并入的候选本身。
      const operationsByShot = new Map<string, ShotOperationDto[]>()
      if (shotIds.length > 0) {
        const liveOperations = await app.db.artifactOperation.findMany({
          where: { organizationId: auth.organizationId, status: { in: ['QUEUED', 'RUNNING', 'BLOCKED', 'FAILED'] } },
          select: { id: true, kind: true, status: true, errorSnapshot: true, requestSnapshot: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        })
        for (const operation of liveOperations) {
          let storyboardId: string | null = null
          try {
            storyboardId = (JSON.parse(operation.requestSnapshot) as { storyboardId?: string }).storyboardId ?? null
          } catch {
            continue
          }
          if (!storyboardId || !operationShotIds.has(storyboardId)) continue
          const list = operationsByShot.get(storyboardId) ?? []
          list.push({
            id: operation.id,
            kind: operation.kind as 'video_extend' | 'video_edit',
            status: operation.status,
            error: operation.errorSnapshot ? operation.errorSnapshot.slice(0, 400) : null,
            createdAt: operation.createdAt.toISOString(),
          })
          operationsByShot.set(storyboardId, list)
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
      const latestQc = new Map<string, { kind: string; status: string; score: number | null } & QcReadingsDto>()
      for (const qc of qcRows) {
        if (!qc.storyboardId) continue
        latestQc.set(`${qc.storyboardId}:${qc.kind}`, { kind: qc.kind, status: qc.status, score: qc.score, ...qcReadingsDto(parseQcReadings(qc.report)) })
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

      // 分镜文本的逐镜软检（只提示、不拦人，见 storyboard-gaps.ts）。整集在册镜头按
      // 出片顺序一次算完：首镜与末镜的判据依赖它在序列里的位置，逐镜单独算会误报。
      // 单镜时长地板不在这里取——它要再解析一遍模型链，而这屏每 3 秒轮询一次；
      // 那条判据归预审门（buildGenerationPlan），花钱的那一下才是它该出现的地方。
      const approvedScript = await app.db.scriptVersion.findFirst({
        where: { episodeId: episode.id, status: 'APPROVED' },
        orderBy: { version: 'desc' },
        select: { content: true },
      })
      const gapsByShot = inspectStoryboardGaps(
        // SD-123：绑定事实一起送进去——素材名与描述用词对不上（「床头钟」vs「钟体」）
        // 时，绑定链不是每次都补得上，零绑定必须在开烧前的这一屏就看见。
        storyboards.map(storyboard => ({ ...storyboard, boundAssetCount: storyboard.assets.length })),
        {
          castNames: episodeAssets.filter(asset => asset.kind === 'character').map(asset => asset.name),
          scriptContent: approvedScript?.content ?? null,
        },
      )
      // 首帧↔描述的内容依赖（SD-146）：帧既是图生视频的画面基准，也是这一镜在总览上的
      // 脸。改描述只写分镜表，旧帧一动不动，下一笔视频买回的就是「新文字 + 旧画面」。
      // 取帧用触发端同一个解析、判据用触发端同一个函数——卡片上的标记与那一下 409
      // 不许各说一套。
      const effectiveFrames = await usableFirstFrames(app.db, auth.organizationId, episode.id, storyboards.map(storyboard => storyboard.id))
      const driftedFrames = await firstFrameTextDrift(
        app.db,
        effectiveFrames,
        new Map(storyboards.map(storyboard => [storyboard.id, { description: storyboard.description, selectedFrameArtifactId: storyboard.selectedFrameArtifactId }])),
      )

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
        const production = shotProduction(storyboard.method)
        const attention: string[] = []
        if (storyboard.status === 'BLOCKED') attention.push('shot_blocked')
        if (frameError) attention.push('frame_failed')
        if (videoError) attention.push('video_failed')
        // 等你审是一等缺口：卡在这一步的是人，不是机器，队列必须算它一件。
        if (storyboard.status === 'NEEDS_REVIEW') attention.push('awaiting_review')
        // 本机镜头不消费素材，素材草稿不是它的缺口。
        if (production === 'video' && linkedAssets.some(a => a.status !== 'APPROVED' && a.hasVersions)) attention.push('asset_gate')
        // 只有真存在多版本可选却没人钦定的镜头才进待处理泳道——单版本没有抉择，
        // 逼人选一次是摩擦不是审计。停在问询上的那一版还不算「可选」：它得先被收下
        // 或被重抽，拿它凑数会把「等你裁决」报成「等你选优」。
        const selectable = candidates.filter(candidate => !candidate.awaitingDecision)
        if (selectable.length >= 2 && !selectable.some(candidate => candidate.selected)) attention.push('selection_open')
        const usage = usageByShot.get(storyboard.id)
        const qcEntries = [...latestQc.entries()].filter(([key]) => key.startsWith(`${storyboard.id}:`)).map(([, value]) => value)
        // 缩略图跟着选定版本走:卡片展示的必须是将入片的那一版，而不是"最新"。
        const selectedArtifact = candidates.find(candidate => candidate.selected)
          ? artifactsById.get(storyboard.selectedVideoArtifactId!)
          : undefined
        // 每镜占位裁决(放映条与预映共用一个事实源):这一镜现在拿得上画面的东西
        // 是钦定成片 > 最新成功片段 > 在产 > 只有分镜图 > 本机制作且还没画面 > 空。
        // 本机镜头（字卡/界面/录屏/合成）也能有画面了——钦定那条走第一档。
        const slot = storyboard.selectedVideoArtifactId
          ? 'chosen'
          : media.video.get(storyboard.id)
            ? 'video'
            : inflightStages.length > 0
              ? 'running'
              : media.firstFrame.get(storyboard.id)
                ? 'frame'
                : production !== 'video'
                  ? 'local'
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
          // 分镜表「转场」列的定格值：合成侧按它排母带时间线，界面必须能看见它，
          // 否则「这一刀是叠化还是裸切」只有查库才知道，22 刀回填没法逐镜核对。
          transition: storyboard.transition,
          transitionMs: storyboard.transitionMs,
          sceneNumber: storyboard.sceneNumber,
          /** 视频=平台生成；其余=按分镜表的生成方式由人完成，不排队也不计费。 */
          production,
          /** 分镜表「生成方式」列的原文。`production` 是它的归类结果，人是按这一栏改档的：
           *  只回枚举名，界面下拉就无法把「界面」与旧数据里的「UI」分开显示，
           *  改档也会在没有初值时被当成已选过某一档（SD-109）。 */
          method: storyboard.method,
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
          /** 剧本「声音」列写的那条氛围底（文字）。平台没有环境音生成槽位，它是给人
           *  导入时对照的出处——没有这一行，分镜表写下的「雨声」就永远进不了成片。 */
          ambience: storyboard.ambience,
          audioSource: storyboard.audioSource,
          firstFrameError: frameError,
          videoError,
          inflight: inflightStages,
          inflightAttempts: [...(media.inflightAttempt.get(storyboard.id)?.entries() ?? [])].map(([stage, attempt]) => ({ stage, attempt })),
          qc: qcEntries,
          selectedVideoArtifactId: storyboard.selectedVideoArtifactId,
          selectedFrameArtifactId: storyboard.selectedFrameArtifactId,
          selectedVoiceArtifactId: storyboard.selectedVoiceArtifactId,
          /** 镜头 CAS 依据（延长 apply_if_unchanged 需要它做 expectedShotRevision）。 */
          stateRevision: storyboard.stateRevision,
          /** 延长/定向编辑操作状态（新→旧）：QUEUED/RUNNING/BLOCKED/FAILED。 */
          operations: operationsByShot.get(storyboard.id) ?? [],
          videoCandidates: candidates,
          frameCandidates,
          voiceCandidates,
          usage: usage ? { inputUnits: usage.inputUnits, outputUnits: usage.outputUnits, models: [...usage.models], calls: usage.calls } : null,
          slot,
          attention,
          /** 分镜文本的逐镜体检结论（代码，人话在前端）。刻意不进 attention：
           *  它描述的是「写得不够清楚」，挡路的仍然是人，不该灌水「需要你处理」的计数。 */
          storyboardGaps: gapsByShot.get(storyboard.id) ?? [],
          /** 生效首帧与当前描述对不上时，那一帧的 id（SD-146）。对得上或判不出为 null。 */
          staleFirstFrameArtifactId: driftedFrames.has(storyboard.id) ? (effectiveFrames.get(storyboard.id) ?? null) : null,
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
