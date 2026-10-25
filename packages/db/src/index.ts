import type { CapabilitySlot, MediaArtifact, PrismaClient, TaskStatus, WorkflowStatus } from '@prisma/client'
import { compareSlotFallbacks, isArtifactVetoed, servesSlot } from '@studio/domain'
import type { CapabilitySlot as DomainCapabilitySlot } from '@studio/domain'

export { PrismaClient } from '@prisma/client'
export * from '@prisma/client'

/**
 * Derives a batch's workflow status from its task counts. A batch stays RUNNING
 * while anything is still in flight; once every task settles it is COMPLETED,
 * BLOCKED (a failure needs a human), NEEDS_REVIEW (partly cancelled), or
 * CANCELLED (nothing ran).
 */
export function rollUpBatchStatus(counts: Partial<Record<TaskStatus, number>>): WorkflowStatus {
  const of = (status: TaskStatus): number => counts[status] ?? 0
  const total = (Object.values(counts) as number[]).reduce((sum, value) => sum + value, 0)
  if (total === 0) return 'DRAFT'
  if (of('QUEUED') > 0 || of('RUNNING') > 0) return 'RUNNING'
  if (of('FAILED') > 0 || of('BLOCKED') > 0) return 'BLOCKED'
  if (of('CANCELLED') > 0) return of('SUCCEEDED') > 0 ? 'NEEDS_REVIEW' : 'CANCELLED'
  return 'COMPLETED'
}

/** Recomputes and persists a batch's status; call after every task transition. */
export async function syncBatchStatus(db: PrismaClient, batchId: string): Promise<WorkflowStatus> {
  const grouped = await db.generationTask.groupBy({
    by: ['status'],
    where: { batchId },
    _count: { _all: true },
  })
  const counts = Object.fromEntries(grouped.map(group => [group.status, group._count._all])) as Partial<Record<TaskStatus, number>>
  const status = rollUpBatchStatus(counts)
  await db.generationBatch.update({ where: { id: batchId }, data: { status } })
  return status
}

/** Slots are lowercase in the domain vocabulary and an UPPERCASE enum in the schema. */

export interface ArtifactShotContext {
  storyboardId: string
  episodeId: string
  projectId: string
}

/**
 * 统一归属解析(US-003 的先行最小版):一个 VIDEO 制品属于哪一镜。
 * 两条合法来源——挂在成功任务下(生成),或是一条 SUCCEEDED ArtifactOperation 的
 * 输出(延长等制品操作,归属记在操作行快照里)。「没有任务」本身不是归属证明,
 * taskId 为空的制品必须命中成功的操作链才算数;两者都不满足返回 null,
 * 消费方(compose 选版/钦定接口/再次延长)按无归属拒绝,不许各自放宽。
 */

export type ArtifactOrigin = 'generation_task' | 'artifact_operation' | 'manual_import' | 'legacy_pointer'

export interface ArtifactOwnership {
  organizationId: string
  projectId: string
  episodeId: string
  /** 镜头级来源才有;集级(配乐)与悬空旧指针为 null。 */
  storyboardId: string | null
  origin: ArtifactOrigin
  /** 终态:任务/操作 SUCCEEDED;导入件天然终态;悬空指针 false。 */
  terminal: boolean
}

/**
 * US-003 统一素材归属解析:生成任务产物、人工导入件、制品操作产物共用一条信任
 * 路径,全部校验组织/项目/剧集(及可得时的镜头)归属与终态。悬空旧指针(任务已删
 * 的历史裸 id)回落到 objectKey 路径解析——仓库唯一的 key 构造器把 org/project/
 * episode 编进路径,兼容读取但不判终态。所有消费入口(compose/选版/延长/交付)
 * 必须经此解析取归属,禁止新增绕过校验的裸 artifactId 读取。
 */
export async function resolveArtifactOwnership(
  db: PrismaClient,
  artifactId: string,
  organizationId: string,
): Promise<ArtifactOwnership | null> {
  const artifact = await db.mediaArtifact.findFirst({
    where: { id: artifactId, organizationId },
    include: { task: { include: { batch: { include: { episode: { select: { id: true, projectId: true } } } } } } },
  })
  if (!artifact) return null

  // 1) 生成任务产物:任务链给出全部归属;终态=SUCCEEDED。
  if (artifact.task) {
    const episode = artifact.task.batch.episode
    return {
      organizationId, projectId: episode.projectId, episodeId: episode.id,
      storyboardId: artifact.task.storyboardId, origin: 'generation_task',
      terminal: artifact.task.status === 'SUCCEEDED',
    }
  }

  // 2) 制品操作产物:归属在操作行快照;终态=操作 SUCCEEDED。
  const operation = await db.artifactOperation.findFirst({
    where: { outputArtifactId: artifact.id, organizationId, status: 'SUCCEEDED' },
  })
  if (operation) {
    try {
      const storyboardId = (JSON.parse(operation.requestSnapshot) as { storyboardId?: string }).storyboardId
      if (storyboardId) {
        const storyboard = await db.storyboard.findUnique({
          where: { id: storyboardId },
          include: { episode: { include: { project: { select: { organizationId: true } } } } },
        })
        if (storyboard && storyboard.episode.project.organizationId === organizationId) {
          return {
            organizationId, projectId: storyboard.episode.projectId, episodeId: storyboard.episodeId,
            storyboardId, origin: 'artifact_operation', terminal: true,
          }
        }
      }
    } catch {
      // 快照损坏按无法证明归属处理,落入后续路径
    }
  }

  // 3) 人工导入件/本机渲染件:镜头指针列(配音/环境音/视频)或 artifact 自带的
  //    storyboardId 给出镜头归属;导入与本机渲染即终态(没有任务可以失败)。
  const ownedStoryboardId = artifact.storyboardId
  if (ownedStoryboardId) {
    const shot = await db.storyboard.findUnique({
      where: { id: ownedStoryboardId },
      include: { episode: { include: { project: { select: { organizationId: true } } } } },
    })
    if (shot && shot.episode.project.organizationId === organizationId) {
      return {
        organizationId, projectId: shot.episode.projectId, episodeId: shot.episodeId,
        storyboardId: shot.id, origin: 'manual_import', terminal: true,
      }
    }
  }
  const importing = await db.storyboard.findFirst({
    where: {
      OR: [
        { importedVoiceArtifactId: artifact.id },
        { importedAmbienceArtifactId: artifact.id },
        { importedVoices: { some: { id: artifact.id } } },
      ],
    },
    include: { episode: { include: { project: { select: { organizationId: true } } } } },
  })
  if (importing && importing.episode.project.organizationId === organizationId) {
    return {
      organizationId, projectId: importing.episode.projectId, episodeId: importing.episodeId,
      storyboardId: importing.id, origin: 'manual_import', terminal: true,
    }
  }

  // 4) 悬空旧指针兼容回落:objectKey 路径 = org/project/episode/stage/entity/version。
  const segments = artifact.objectKey.split('/')
  if (segments.length >= 3 && segments[0] === organizationId) {
    return {
      organizationId, projectId: segments[1]!, episodeId: segments[2]!,
      storyboardId: null, origin: 'legacy_pointer', terminal: false,
    }
  }
  return null
}

export async function resolveVideoArtifactShot(
  db: PrismaClient,
  artifactId: string,
  organizationId: string,
): Promise<ArtifactShotContext | null> {
  const ownership = await resolveArtifactOwnership(db, artifactId, organizationId)
  // 可钦定/可再延长的信任条件:镜头级归属 + 终态。失败任务产物与悬空旧指针
  // 能被「读到」(兼容),但不能被「采用」。
  if (!ownership?.storyboardId || !ownership.terminal) return null
  return { storyboardId: ownership.storyboardId, episodeId: ownership.episodeId, projectId: ownership.projectId }
}

export function toDbSlot(slot: DomainCapabilitySlot): CapabilitySlot {
  return slot.toUpperCase() as CapabilitySlot
}

/**
 * One ordered fallback for a capability slot. Carries the superset of what the
 * worker needs to open a provider (connection, capability, provider, model) and
 * what the console needs to explain the ordering to a human (scope, priority,
 * display name, modality).
 */
export interface SlotCandidate {
  bindingId: string
  scope: 'project' | 'organization'
  priority: number
  capabilityId: string
  connectionId: string
  connectionName: string
  provider: string
  model: string
  displayName: string | null
  modality: string
  /// 定妆照(纯文字出图)应优先纯文生图模型,带参考图的任务才优先编辑模型。
  acceptsReferenceImages: boolean
  /// 模型自述的能力规格(时长/分辨率等),分镜容量按它动态取值。
  spec: unknown
  /// 实测/文档核对留痕。只有 probe 能自动下调有效上限,doc/manual 只做标注。
  durationEvidence: unknown
}

/**
 * Resolves the ordered fallbacks for `slot`. A project-scoped binding beats an
 * organization-scoped one regardless of priority, priority descends within a
 * scope, and only verified capabilities on enabled connections survive. Passing
 * `projectId: null` asks for organization scope only.
 *
 * Deduplication is by capability, not by binding: the same model bound at both
 * scopes is one fallback, because retrying it after it failed at the narrower
 * scope would just fail again.
 */
export async function resolveSlotCandidates(
  db: PrismaClient,
  organizationId: string,
  projectId: string | null,
  slot: DomainCapabilitySlot,
): Promise<SlotCandidate[]> {
  const bindings = await db.capabilityBinding.findMany({
    where: { organizationId, slot: toDbSlot(slot), enabled: true },
    orderBy: { priority: 'desc' },
    include: { capability: { include: { connection: true } } },
  })
  const projectScoped = bindings.filter(binding => binding.projectId === projectId)
  const orgScoped = bindings.filter(binding => binding.projectId === null)
  const seen = new Set<string>()
  const candidates: SlotCandidate[] = []
  for (const binding of [...projectScoped, ...orgScoped]) {
    if (seen.has(binding.capabilityId)) continue
    // The usability rule lives in @studio/domain (servesSlot) and is shared with the
    // console's readiness panel, so neither side can drift. The slot itself was
    // already filtered in the query's where clause, so the row field is not re-read.
    if (!servesSlot({ slot, enabled: binding.enabled, capability: binding.capability }, slot)) continue
    seen.add(binding.capabilityId)
    candidates.push({
      bindingId: binding.id,
      scope: binding.projectId ? 'project' : 'organization',
      priority: binding.priority,
      capabilityId: binding.capability.id,
      connectionId: binding.capability.connectionId,
      connectionName: binding.capability.connection.name,
      provider: binding.capability.connection.provider,
      model: binding.capability.model,
      displayName: binding.capability.displayName,
      modality: binding.capability.modality,
      acceptsReferenceImages: binding.capability.acceptsReferenceImages,
      spec: binding.capability.spec,
      durationEvidence: binding.capability.durationEvidence,
    })
  }
  return candidates.sort(compareSlotFallbacks)
}

/** 一镜的三类产物（首帧/成片/配音）——否决只作用于这三档。 */
export type ShotMediaStage = 'VIDEO' | 'FIRST_FRAME' | 'AUDIO'

/** 取版时一次最多看几条：一条任务最多留几版，20 条覆盖得住任何重抽次数，
 *  同时把最坏情况的读取钉成一个常数。 */
const TAKE_SCAN_LIMIT = 20

/**
 * SD-172｜这一镜的「生效版」到底取哪一件。
 *
 * 口径只有两条，且界面给人看的版必须与母带取走的版同源：
 * 1. 人钦定过（selectedVideoArtifactId 一类指针）就用那一版——除非它被人工否决；
 * 2. 没钦定时取「最新一条成功的」，但被否决的版本跳过。
 *
 * 这一条判定以前在 apps/worker/src/compose.ts 里各写一份（latestVideoArtifact /
 * latestVoiceArtifact 与配音指针三处），API 侧读生效版又是一份；四处口径一旦分叉，
 * 就会出现「界面上这条已被人否掉、母带照旧把它排进时间轴」。所以现在只留这一份，
 * 合成、界面读数与任何新的读版方都走它。只读，不写。
 */
export async function resolveShotTake(
  db: PrismaClient,
  options: {
    organizationId: string
    storyboardId: string
    stage: ShotMediaStage
    /** 人钦定的那一版；null/undefined = 没钦定，走「自动取最新（跳过被否的）」。 */
    pinnedArtifactId?: string | null
  },
): Promise<MediaArtifact | null> {
  if (options.pinnedArtifactId) {
    const pinned = await db.mediaArtifact.findFirst({
      where: { id: options.pinnedArtifactId, organizationId: options.organizationId, stage: options.stage },
    })
    // 钦定的那一版被否了就不再算钦定：指针由否决入口清掉，这里兜住旧数据与
    // 绕过界面直接写指针的情况，落回「自动取最新」。
    if (pinned && !isArtifactVetoed(pinned.metadata)) return pinned
  }
  const rows = await db.mediaArtifact.findMany({
    where: {
      stage: options.stage,
      organizationId: options.organizationId,
      task: { status: 'SUCCEEDED', stage: options.stage, storyboardId: options.storyboardId },
    },
    orderBy: [{ task: { createdAt: 'desc' } }, { version: 'desc' }],
    take: TAKE_SCAN_LIMIT,
  })
  return rows.find(artifact => !isArtifactVetoed(artifact.metadata)) ?? null
}
