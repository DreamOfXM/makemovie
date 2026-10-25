import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'
import { apiError } from '../lib/api-error.js'
import { isValidSequenceFps, validateClipRange } from '@studio/domain'
import { editFingerprint } from '@studio/media'
import type { RationalFps } from '@studio/domain'
import type { PrismaClient } from '@studio/db'

/**
 * US-024 编辑修订保存与旧集初始化;UX-P03(新用户体验改造方案 §3.3)空初始化修复。
 * GET /episodes/:id/edit —— 读 head + 逐 clip 的素材实况(materials,只读)。edit 不存在
 *   且有 live 分镜时才建默认序列;0 分镜时返回可读空态(initialized:false + editId:null),
 *   不落库 EpisodeEdit,杜绝「页面挂载就写入永久空序列」;机器 head(author=system-initial
 *   且没人加过轨道)在本集媒体状态变化后由 GET 带 CAS 重建新修订(旧修订保留,author 仍
 *   system-initial)——R09:闸门只看「是不是机器写的」,不看「填没填全」,因为部分填充的
 *   机器 head 正是回填实测时长后最需要刷新的那一类;已有人工剪辑绝不自动重置。
 * PUT /episodes/:id/edit —— CAS 保存(expectedEditRevision),创建不可变修订。
 *   SD-101:除整数/空片段之外,还要拿素材实测帧数判上限——裁到素材尽头之外的区间
 *   一旦落库,合成按裸帧号硬裁、已付费画面静默丢掉,所以这类区间不许进修订历史(400
 *   episodeEdit:clipBeyondMedia + 逐条镜头号)。上限与读侧红框同一套解析。
 * POST /episodes/:id/edit/restore —— 以历史修订创建新 head(不篡改历史)。
 * POST /episodes/:id/edit/build-default —— 显式构建默认序列(供「开始剪辑」按钮
 *   /空态使用)。幂等:head 已是同指纹 system 序列时 no-op(rebuilt:false);
 *   存在任何人工修订时 409 拒绝(state_conflict),绝不静默覆盖人工剪辑。
 */
interface ClipDocJson {
  clipId: string
  storyboardId: string
  artifactId: string
  sourceInFrame: number
  sourceOutFrame: number
}

/** SD-099 读侧富化:时间线每一行要能看见「合成实际会用的那条素材有多长」。
 *  纯只读——不进 clips JSON、不参与指纹、不吃 CAS,所以素材更新永远不会让人工剪辑
 *  判成过期,也不会因为 GET 而推进修订。 */
interface ClipMaterial {
  clipId: string
  /** 镜头序号(界面上唯一能被用户认住的「第几镜」,不是 clip-7 这种内部 id)。 */
  shotNumber: number | null
  /** 可证明会被合成使用的成片;'' = 这一格现在没有素材。 */
  artifactId: string
  /** 实测时长(毫秒);null = 没有实测读数(回填前的旧产物)。 */
  durationMs: number | null
  /** 本序列帧率下这一条素材可用的帧数,即 sourceOutFrame 的上限;null = 无素材。 */
  maxFrame: number | null
  /** clip 带着引用但引用解析不回本镜头的成片(产物被删/跨镜头串了)——合成会失败。 */
  unresolved: boolean
}

interface EditBody {
  fps?: { fpsNum?: unknown; fpsDen?: unknown }
  clips?: unknown
  tracks?: unknown
  outputSpec?: unknown
  expectedEditRevision?: unknown
}

const SYSTEM_AUTHOR = 'system-initial'
const DEFAULT_FPS: RationalFps = { fpsNum: 25, fpsDen: 1 }

/** UX-P03:GET 空态用的临时 revision 形状——clips/tracks 是空数组而不是缺字段,
 * 现有 timeline-editor(data.revision.clips)不崩,前端按 initialized:false 展示空态。 */
function emptyEditState() {
  return {
    editId: null,
    headRevision: 0,
    initialized: false,
    reason: 'no_storyboards',
    materials: [] as ClipMaterial[],
    revision: {
      id: '',
      editId: '',
      revision: 0,
      fpsNum: DEFAULT_FPS.fpsNum,
      fpsDen: DEFAULT_FPS.fpsDen,
      clips: [] as ClipDocJson[],
      tracks: [] as unknown[],
      outputSpec: {},
      fingerprint: '',
      author: null,
      createdAt: null,
    },
  }
}

function parseClips(raw: unknown): ClipDocJson[] | { error: string } {
  if (!Array.isArray(raw)) return { error: 'clips must be an array' }
  const clips: ClipDocJson[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { error: 'each clip must be an object' }
    const clip = item as Record<string, unknown>
    if (typeof clip.clipId !== 'string' || typeof clip.storyboardId !== 'string' || typeof clip.artifactId !== 'string') {
      return { error: 'clipId, storyboardId, artifactId are required strings' }
    }
    if (typeof clip.sourceInFrame !== 'number' || typeof clip.sourceOutFrame !== 'number' || !Number.isInteger(clip.sourceInFrame) || !Number.isInteger(clip.sourceOutFrame)) {
      return { error: 'sourceInFrame and sourceOutFrame must be integers (editMedia frame indices)' }
    }
    if (clip.sourceInFrame < 0 || clip.sourceOutFrame < 0) return { error: `clip ${clip.clipId}: frame indices must be >= 0` }
    if (clip.sourceOutFrame <= clip.sourceInFrame) return { error: `clip ${clip.clipId}: sourceOutFrame must be > sourceInFrame` }
    clips.push({ clipId: clip.clipId, storyboardId: clip.storyboardId, artifactId: clip.artifactId, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame })
  }
  return clips
}

/** UX-P03 legacy 空 head 判定:author=system-initial 且 clips/tracks 都为空数组。 */
function isEmptySystemHead(head: { author: string | null; clips: string; tracks: string }): boolean {
  if (head.author !== SYSTEM_AUTHOR) return false
  try {
    const clips = JSON.parse(head.clips) as unknown
    const tracks = JSON.parse(head.tracks) as unknown
    return Array.isArray(clips) && clips.length === 0 && Array.isArray(tracks) && tracks.length === 0
  } catch {
    return false
  }
}

/** R02 占位 head 判定:system head 里每条 clip 都没有真实制品引用(artifactId 空)——
 * 生成/采用视频后这类 head 若不重建,时间线会永远停在 0.04s 一帧占位。用户没动过的
 * 占位不是剪辑意图,补齐实际媒体不构成覆盖人工工作。 */
function isPlaceholderOnlySystemHead(head: { author: string | null; clips: string; tracks: string }): boolean {
  if (head.author !== SYSTEM_AUTHOR) return false
  try {
    const clips = JSON.parse(head.clips) as Array<{ artifactId?: unknown }>
    const tracks = JSON.parse(head.tracks) as unknown
    if (!Array.isArray(clips) || clips.length === 0 || !Array.isArray(tracks) || tracks.length > 0) return false
    return clips.every(clip => typeof clip?.artifactId !== 'string' || clip.artifactId === '')
  } catch {
    return false
  }
}

/** R09 可自动重建的机器 head:author=system-initial 且没人加过声音轨道。
 * 旧口径额外要求「每条 clip 都没素材」,于是生成侧补齐实测时长后,那条已经填了一半的
 * 机器 head 永远刷不动——时间线停在 50 帧(素材实测 101 帧)的旧裁切上,合成照这个区间
 * 把已付费画面裁掉。判据回到唯一的真相:字节是不是机器写的(人工痕迹另由
 * hasHumanRevision 按全部修订把守),轨道非空即算人工工作。 */
function isMachineSystemHead(head: { author: string | null; tracks: string }): boolean {
  if (head.author !== SYSTEM_AUTHOR) return false
  try {
    const tracks = JSON.parse(head.tracks) as unknown
    return Array.isArray(tracks) && tracks.length === 0
  } catch {
    return false
  }
}

/** UX-P03 人工痕迹判定:任何修订的 author 不是 system-initial(含 null——来源不明
 * 时按人工处理)即视为已有人工剪辑,自动重建一律放弃。 */
function hasHumanRevision(authors: Array<{ author: string | null }>): boolean {
  return authors.some(row => row.author !== SYSTEM_AUTHOR)
}

/** 实测毫秒 → 本序列帧率下的帧数(§10.2 的 sourceOutFrame 不含终,帧数即上限)。
 * 建序列与读侧富化必须共用这条换算,否则刚重建好的 clip 会被界面判成「超出素材」。 */
function framesForDurationMs(durationMs: number, fps: RationalFps): number {
  return Math.max(1, Math.round((durationMs / 1000) * fps.fpsNum / fps.fpsDen))
}

/** 按 live 分镜 + 当前选版(或最新成功 VIDEO)建默认连续剪辑(GET 初始化、legacy
 * 迁移与 build-default 共用同一套镜头→制品解析,不另造时间数学)。 */
async function buildDefaultClips(
  db: Pick<PrismaClient, 'mediaArtifact'>,
  organizationId: string,
  storyboards: Array<{ id: string; durationMs: number | null; selectedVideoArtifactId: string | null }>,
): Promise<ClipDocJson[]> {
  const artifactRefs = await Promise.all(storyboards.map(async shot => {
    // R06: 选版优先;选版行必须仍是本组织的 VIDEO 制品,失效(被删/跨组织)回落 latest。
    if (shot.selectedVideoArtifactId) {
      const selected = await db.mediaArtifact.findFirst({
        where: { id: shot.selectedVideoArtifactId, organizationId, stage: 'VIDEO' },
        select: { id: true, durationMs: true },
      })
      if (selected) return selected
    }
    const latest = await db.mediaArtifact.findFirst({
      where: { stage: 'VIDEO', organizationId, task: { status: 'SUCCEEDED', stage: 'VIDEO', storyboardId: shot.id } },
      orderBy: [{ task: { createdAt: 'desc' } }, { version: 'desc' }],
      select: { id: true, durationMs: true },
    })
    return latest ?? null
  }))
  return storyboards.map((shot, index) => {
    const artifact = artifactRefs[index]
    // 有素材:源范围=实测时长换算的帧数(5s@25fps=125 帧),不用分镜计划时长
    // 冒充素材长度;无素材:显式占位——空 artifactId、一帧范围,渲染层按缺素材处理。
    return {
      clipId: `clip-${index + 1}`,
      storyboardId: shot.id,
      artifactId: artifact?.id ?? '',
      sourceInFrame: 0,
      sourceOutFrame: artifact != null
        ? framesForDurationMs(artifact.durationMs ?? shot.durationMs ?? 5000, DEFAULT_FPS)
        : 1,
    }
  })
}

/** SD-099 读侧富化:逐 clip 解析「合成会用的那条素材 + 它的实测长度」。
 * 口径与 worker 合成逐字一致(显式引用 > 人工钦定 > 最新成功成片),否则界面报的长度和
 * 真正裁出来的画面是两回事。显式引用解析不回本镜头成片时标 unresolved——这类格过去会
 * 静默裁出一段并不存在的画面,必须让人看见。 */
async function describeClipMaterials(
  db: PrismaClient,
  organizationId: string,
  clips: ClipDocJson[],
  fps: RationalFps,
): Promise<ClipMaterial[]> {
  if (clips.length === 0) return []
  const shotIds = [...new Set(clips.map(clip => clip.storyboardId))]
  const shots = await db.storyboard.findMany({ where: { id: { in: shotIds } }, select: { id: true, number: true, selectedVideoArtifactId: true } })
  const shotById = new Map(shots.map(shot => [shot.id, shot]))

  const wantedIds = new Set<string>()
  for (const clip of clips) if (clip.artifactId !== '') wantedIds.add(clip.artifactId)
  for (const shot of shots) if (shot.selectedVideoArtifactId) wantedIds.add(shot.selectedVideoArtifactId)
  const referenced = wantedIds.size > 0
    ? await db.mediaArtifact.findMany({
        where: { id: { in: [...wantedIds] }, organizationId, stage: 'VIDEO' },
        select: { id: true, durationMs: true, storyboardId: true, task: { select: { storyboardId: true, status: true } } },
      })
    : []
  const byId = new Map(referenced.map(row => [row.id, row]))
  // 归属判定:生成件认 task 的镜头,导入件认 artifact 自己的指针;非终态不算可用素材。
  const usableFor = (artifactId: string, storyboardId: string) => {
    const row = byId.get(artifactId)
    if (!row || row.task?.status !== 'SUCCEEDED') return null
    if ((row.task?.storyboardId ?? row.storyboardId) !== storyboardId) return null
    return row
  }

  const missingShotIds = [...new Set(clips.filter(clip => usableFor(clip.artifactId, clip.storyboardId) === null).map(clip => clip.storyboardId))]
  const fallbackRows = missingShotIds.length > 0
    ? await db.mediaArtifact.findMany({
        where: { stage: 'VIDEO', organizationId, task: { status: 'SUCCEEDED', storyboardId: { in: missingShotIds } } },
        orderBy: [{ task: { createdAt: 'desc' } }, { version: 'desc' }],
        select: { id: true, durationMs: true, task: { select: { storyboardId: true } } },
      })
    : []
  const latestByShot = new Map<string, { id: string; durationMs: number | null }>()
  for (const row of fallbackRows) {
    const shotId = row.task?.storyboardId
    if (shotId && !latestByShot.has(shotId)) latestByShot.set(shotId, { id: row.id, durationMs: row.durationMs })
  }

  return clips.map(clip => {
    const shot = shotById.get(clip.storyboardId) ?? null
    const direct = usableFor(clip.artifactId, clip.storyboardId)
    const manual = direct === null ? usableFor(shot?.selectedVideoArtifactId ?? '', clip.storyboardId) : null
    const auto = direct === null && manual === null ? latestByShot.get(clip.storyboardId) ?? null : null
    const durationMs = direct?.durationMs ?? manual?.durationMs ?? auto?.durationMs ?? null
    return {
      clipId: clip.clipId,
      shotNumber: shot?.number ?? null,
      artifactId: direct?.id ?? manual?.id ?? auto?.id ?? '',
      durationMs,
      maxFrame: durationMs === null ? null : framesForDurationMs(durationMs, fps),
      unresolved: clip.artifactId !== '' && direct === null,
    }
  })
}

/** 默认序列指纹。R04/R11:指纹从第一版起就带 outputSpec(空对象也显式参与)——
 * PUT 与初始化两侧口径一致,改画幅才会变指纹。 */
function defaultSequenceFingerprint(clips: ClipDocJson[]): string {
  return editFingerprint({
    fpsNum: DEFAULT_FPS.fpsNum,
    fpsDen: DEFAULT_FPS.fpsDen,
    clips: clips.map(clip => ({ clipId: clip.clipId, artifactId: clip.artifactId, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame })),
    tracks: [],
    outputSpec: {},
  })
}

/** 创建 edit + revision 1(与 GET 初始化、build-default 共用)。 */
async function createInitialEdit(db: PrismaClient, episodeId: string, organizationId: string, clips: ClipDocJson[]) {
  return db.episodeEdit.create({
    data: {
      episodeId,
      organizationId,
      headRevision: 1,
      revisions: {
        create: { revision: 1, fpsNum: DEFAULT_FPS.fpsNum, fpsDen: DEFAULT_FPS.fpsDen, clips: JSON.stringify(clips), tracks: '[]', fingerprint: defaultSequenceFingerprint(clips), author: SYSTEM_AUTHOR },
      },
    },
    include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } },
  })
}

export async function episodeEditRoutes(app: FastifyInstance): Promise<void> {
  // GET:读 head;edit 不存在且有 live 分镜时才初始化默认序列(UX-P03:
  // 0 分镜返回可读空态、不落库;legacy 空 head 在有分镜后带 CAS 迁移)。
  app.get<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/edit',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } } })
      if (!episode) return reply.code(404).send({ error: 'episode not found' })

      const [edit, storyboards] = await Promise.all([
        app.db.episodeEdit.findUnique({ where: { episodeId: episode.id }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } }),
        // live 分镜:初始化、空态判定与 legacy 迁移都要用。
        app.db.storyboard.findMany({ where: { episodeId: episode.id, supersededAt: null }, orderBy: { number: 'asc' } }),
      ])

      // 初始化(收紧:edit 不存在「且有 live 分镜」才建,0 分镜不再写永久空序列)。
      if (edit === null) {
        if (storyboards.length === 0) return reply.send(emptyEditState())
        const clips = await buildDefaultClips(app.db, auth.organizationId, storyboards)
        const created = await createInitialEdit(app.db, episode.id, auth.organizationId, clips)
        const head = created.revisions[0]!
        return {
          editId: created.id,
          headRevision: created.headRevision,
          initialized: true,
          materials: await describeClipMaterials(app.db, auth.organizationId, clips, DEFAULT_FPS),
          revision: { ...head, clips, tracks: [] as unknown[], outputSpec: {} },
        }
      }

      let head = edit.revisions[0] ?? null
      let headRevision = edit.headRevision

      // UX-P03/R02/R09 自动补齐:旧代码会落 clips=[] 永久空序列,或分镜就绪但尚无视频时
      // 落全占位序列,或在素材还没出齐时建好序列、之后实测时长回填了却刷不动。只要 head
      // 是机器写的(author=system-initial、没人加过轨道)、全部修订无人工痕迹、且按当前
      // 选版与实测长度重建出的指纹与 head 不同,就以 CAS 生成新修订;旧修订保留,author
      // 仍 system-initial;人工剪辑绝不走到这里。
      if (head !== null && storyboards.length > 0 && isMachineSystemHead(head)) {
        const authors = await app.db.episodeEditRevision.findMany({ where: { editId: edit.id }, select: { author: true } })
        if (!hasHumanRevision(authors)) {
          const clips = await buildDefaultClips(app.db, auth.organizationId, storyboards)
          const fingerprint = defaultSequenceFingerprint(clips)
          if (fingerprint !== head.fingerprint) {
            const reason = isEmptySystemHead(head) ? 'legacy-empty-head' : isPlaceholderOnlySystemHead(head) ? 'placeholder-media-refresh' : 'machine-head-refresh'
            // CAS:事务内复核 head 仍是当初那个可重建机器 head——并发保存推进了
            // 修订就放弃迁移,GET 永不因迁移失败而报错。
            const migrated = await app.db.$transaction(async tx => {
              const fresh = await tx.episodeEdit.findUnique({ where: { id: edit.id }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } })
              const freshHead = fresh?.revisions[0] ?? null
              if (!fresh || !freshHead || freshHead.revision !== head!.revision || !isMachineSystemHead(freshHead)) return null
              const revision = await tx.episodeEditRevision.create({
                data: { editId: fresh.id, revision: fresh.headRevision + 1, fpsNum: DEFAULT_FPS.fpsNum, fpsDen: DEFAULT_FPS.fpsDen, clips: JSON.stringify(clips), tracks: '[]', fingerprint, author: SYSTEM_AUTHOR },
              })
              const updated = await tx.episodeEdit.update({ where: { id: fresh.id }, data: { headRevision: fresh.headRevision + 1 } })
              return { revision, headRevision: updated.headRevision }
            })
            if (migrated) {
              head = migrated.revision
              headRevision = migrated.headRevision
              await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'edit.auto-rebuild', entityType: 'EpisodeEdit', entityId: edit.id, payload: { revision: migrated.headRevision, replacedEmptyRevision: edit.headRevision, reason } })
            }
          }
        }
      }

      if (!head) return reply.code(500).send({ error: 'edit has no revisions' })
      const clips = JSON.parse(head.clips) as ClipDocJson[]
      return {
        editId: edit.id,
        headRevision,
        initialized: true,
        materials: await describeClipMaterials(app.db, auth.organizationId, clips, { fpsNum: head.fpsNum, fpsDen: head.fpsDen }),
        revision: { ...head, clips, tracks: JSON.parse(head.tracks), outputSpec: JSON.parse(head.outputSpec) },
      }
    },
  )

  // PUT:CAS 保存新修订。
  app.put<{ Params: { episodeId: string }; Body: EditBody }>(
    '/episodes/:episodeId/edit',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } } })
      if (!episode) return reply.code(404).send({ error: 'episode not found' })
      const edit = await app.db.episodeEdit.findUnique({ where: { episodeId: episode.id } })
      if (!edit) return reply.code(404).send({ error: 'edit not initialized — GET first' })

      const expected = typeof request.body?.expectedEditRevision === 'number' ? request.body.expectedEditRevision : null
      if (expected === null) return reply.code(400).send({ error: 'expectedEditRevision is required for CAS' })
      if (expected !== edit.headRevision) {
        const { body } = apiError('version_conflict', `编辑已被修改(当前 revision ${edit.headRevision},你预期 ${expected})`, { nextAction: 'reload' })
        return reply.code(409).send({ ...body, currentRevision: edit.headRevision })
      }

      const fpsNum = typeof request.body?.fps?.fpsNum === 'number' ? request.body.fps.fpsNum : 25
      const fpsDen = typeof request.body?.fps?.fpsDen === 'number' ? request.body.fps.fpsDen : 1
      if (!isValidSequenceFps({ fpsNum, fpsDen })) {
        return reply.code(400).send({ error: 'fps must be 24, 25, or 30 (as fpsNum/fpsDen)' })
      }
      const clipsResult = parseClips(request.body?.clips)
      if ('error' in clipsResult) return reply.code(400).send({ error: clipsResult.error })
      const clips = clipsResult

      // V03 附加:保存契约的归属校验——剪辑引用的镜头必须属于本集,制品必须解析
      // 回同一镜头的本组织 VIDEO(空 artifactId=缺素材占位,放行);轨道源制品必须
      // 本组织可读,clip 锚定的 clipId 必须真实存在。校验不过的编辑保存 400,
      // 不能等合成时才 BLOCKED(那是把脏数据放进了修订历史)。
      const shotRows = await app.db.storyboard.findMany({ where: { episodeId: episode.id }, select: { id: true } })
      const episodeShotIds = new Set(shotRows.map(row => row.id))
      const badShots = clips.filter(clip => !episodeShotIds.has(clip.storyboardId))
      if (badShots.length > 0) {
        return reply.code(400).send({ error: `clips reference storyboards outside this episode: ${badShots.map(clip => clip.clipId).join(', ')}` })
      }
      const { resolveVideoArtifactShot } = await import('@studio/db')
      for (const clip of clips) {
        if (clip.artifactId === '') continue
        const context = await resolveVideoArtifactShot(app.db, clip.artifactId, auth.organizationId)
        if (context?.storyboardId !== clip.storyboardId) {
          return reply.code(400).send({ error: `clip ${clip.clipId} references artifact ${clip.artifactId} that is not a video of this shot` })
        }
      }
      // SD-101 写路径闸门:界面把「裁到素材之外」画成红色缺陷态,保存就必须拒绝——
      // 越界区间一旦进了修订历史,合成端按裸帧号硬裁(compose.ts 的 trimOutFrame),
      // 超出部分的已付费画面静默丢掉。上限来自 describeClipMaterials,与读侧红框、
      // 合成端选片同一套解析,所以「界面报的素材长度」和「真正裁出来的画面」是同一个数;
      // 实测时长未回填(maxFrame=null)的素材判不出上限,不拦。
      const caps = await describeClipMaterials(app.db, auth.organizationId, clips, { fpsNum, fpsDen })
      const capByClip = new Map(caps.map(item => [item.clipId, item]))
      const beyond = clips
        .filter(clip => {
          const cap = capByClip.get(clip.clipId)?.maxFrame
          return cap != null && validateClipRange({ sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame }, cap) === 'beyond_media'
        })
        .map(clip => `#${capByClip.get(clip.clipId)?.shotNumber ?? clip.clipId}`)
      if (beyond.length > 0) return reply.code(400).send({ error: 'episodeEdit:clipBeyondMedia', reasons: beyond })

      const rawTracks = Array.isArray(request.body?.tracks) ? request.body.tracks : []
      const clipIds = new Set(clips.map(clip => clip.clipId))
      for (const item of rawTracks) {
        if (typeof item !== 'object' || item === null) return reply.code(400).send({ error: 'each track must be an object' })
        const track = item as Record<string, unknown>
        if (typeof track.elementId !== 'string' || typeof track.sourceArtifactId !== 'string') {
          return reply.code(400).send({ error: 'track elementId and sourceArtifactId are required strings' })
        }
        if (track.anchor !== 'clip' && track.anchor !== 'sequence') return reply.code(400).send({ error: `track ${track.elementId}: anchor must be 'clip' or 'sequence'` })
        if (track.anchor === 'clip' && (typeof track.clipId !== 'string' || !clipIds.has(track.clipId))) {
          return reply.code(400).send({ error: `track ${track.elementId} anchors clip ${String(track.clipId)} that is not in this edit` })
        }
        const sourceArtifact = await app.db.mediaArtifact.findFirst({
          where: { id: track.sourceArtifactId, organizationId: auth.organizationId },
          select: { id: true },
        })
        if (!sourceArtifact) return reply.code(400).send({ error: `track ${track.elementId} source artifact ${track.sourceArtifactId} not found in this organization` })
      }
      const tracks = JSON.stringify(rawTracks)
      const outputSpecJson = typeof request.body?.outputSpec === 'object' && request.body.outputSpec !== null ? JSON.stringify(request.body.outputSpec) : '{}'
      // R04/R11:outputSpec 参与指纹——画幅变化必须让旧合成判 stale,而不是只改数据库。
      const fingerprint = editFingerprint({ fpsNum, fpsDen, clips: clips.map(clip => ({ clipId: clip.clipId, artifactId: clip.artifactId, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame })), tracks: JSON.parse(tracks), outputSpec: JSON.parse(outputSpecJson) })

      const updated = await app.db.$transaction(async tx => {
        const revision = await tx.episodeEditRevision.create({
          data: { editId: edit.id, revision: edit.headRevision + 1, fpsNum, fpsDen, clips: JSON.stringify(clips), tracks, outputSpec: outputSpecJson, fingerprint, author: auth.userId ?? 'agent' },
        })
        const head = await tx.episodeEdit.update({ where: { id: edit.id }, data: { headRevision: edit.headRevision + 1 } })
        return { revision, head }
      })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'edit.save', entityType: 'EpisodeEdit', entityId: edit.id, payload: { revision: updated.head.headRevision, fingerprint } })
      return { editId: edit.id, headRevision: updated.head.headRevision, revision: { ...updated.revision, clips, tracks: JSON.parse(tracks), outputSpec: JSON.parse(outputSpecJson) } }
    },
  )

  // POST restore:以历史修订创建新 head。
  app.post<{ Params: { episodeId: string }; Body: { revision?: unknown } }>(
    '/episodes/:episodeId/edit/restore',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } } })
      if (!episode) return reply.code(404).send({ error: 'episode not found' })
      const edit = await app.db.episodeEdit.findUnique({ where: { episodeId: episode.id } })
      if (!edit) return reply.code(404).send({ error: 'edit not initialized' })
      const revision = typeof request.body?.revision === 'number' ? request.body.revision : null
      if (revision === null) return reply.code(400).send({ error: 'revision is required' })
      const source = await app.db.episodeEditRevision.findUnique({ where: { editId_revision: { editId: edit.id, revision } } })
      if (!source) return reply.code(404).send({ error: `revision ${revision} not found` })

      // 恢复 = 创建新修订(内容来自源),不修改历史字节。
      const restored = await app.db.$transaction(async tx => {
        const newRevision = await tx.episodeEditRevision.create({
          data: { editId: edit.id, revision: edit.headRevision + 1, fpsNum: source.fpsNum, fpsDen: source.fpsDen, clips: source.clips, tracks: source.tracks, outputSpec: source.outputSpec, fingerprint: source.fingerprint, author: auth.userId ?? 'agent' },
        })
        const head = await tx.episodeEdit.update({ where: { id: edit.id }, data: { headRevision: edit.headRevision + 1 } })
        return { revision: newRevision, head }
      })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'edit.restore', entityType: 'EpisodeEdit', entityId: edit.id, payload: { from: revision, to: restored.head.headRevision } })
      return { editId: edit.id, headRevision: restored.head.headRevision, restoredFrom: revision }
    },
  )

  // POST build-default(UX-P03):显式构建默认连续序列,供「开始剪辑」按钮/空态使用。
  // 语义:0 分镜 → 400(不许再建空序列);无编辑 → 建rev1;无人工痕迹 → 幂等重建
  // (head 已是同指纹 system 序列则 no-op,否则新修订、旧修订保留);存在任何人工
  // 修订 → 409 state_conflict 拒绝(选显式拒绝而非静默 no-op:调用方必须知道默认
  // 序列没有也不该覆盖人工剪辑,新增镜头由差异列表/手动操作加入,属 P09)。
  // CAS:可选 expectedEditRevision,提供时必须等于当前 headRevision,事务内复核。
  app.post<{ Params: { episodeId: string }; Body: { expectedEditRevision?: unknown } }>(
    '/episodes/:episodeId/edit/build-default',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } } })
      if (!episode) return reply.code(404).send({ error: 'episode not found' })

      const storyboards = await app.db.storyboard.findMany({ where: { episodeId: episode.id, supersededAt: null }, orderBy: { number: 'asc' } })
      if (storyboards.length === 0) {
        const { statusCode, body } = apiError('invalid_argument', 'episode has no storyboards to build a default sequence from', { nextAction: 'create_storyboards' })
        return reply.code(statusCode).send(body)
      }

      const edit = await app.db.episodeEdit.findUnique({ where: { episodeId: episode.id }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } })
      const expected = typeof request.body?.expectedEditRevision === 'number' ? request.body.expectedEditRevision : null

      // 无编辑:与 GET 初始化同一逻辑建 rev1。
      if (edit === null) {
        const clips = await buildDefaultClips(app.db, auth.organizationId, storyboards)
        const created = await createInitialEdit(app.db, episode.id, auth.organizationId, clips)
        const head = created.revisions[0]!
        await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'edit.build-default', entityType: 'EpisodeEdit', entityId: created.id, payload: { revision: created.headRevision, rebuilt: true, initialized: true } })
        return { editId: created.id, headRevision: created.headRevision, rebuilt: true, revision: { ...head, clips, tracks: [] as unknown[], outputSpec: {} } }
      }

      const head = edit.revisions[0]
      if (!head) return reply.code(500).send({ error: 'edit has no revisions' })

      // 人工剪辑保护:历史上任何非 system-initial 修订(含 null 来源不明)都拒绝。
      const authors = await app.db.episodeEditRevision.findMany({ where: { editId: edit.id }, select: { author: true } })
      if (hasHumanRevision(authors)) {
        const { statusCode, body } = apiError('state_conflict', 'manual edits exist — default sequence rebuild refused; add new shots in the timeline editor', { nextAction: 'manual_merge' })
        return reply.code(statusCode).send({ ...body, currentRevision: edit.headRevision })
      }

      // CAS(可选):调用方持有 revision 时按其校验。
      if (expected !== null && expected !== edit.headRevision) {
        const { statusCode, body } = apiError('version_conflict', `编辑已被修改(当前 revision ${edit.headRevision},你预期 ${expected})`, { nextAction: 'reload' })
        return reply.code(statusCode).send({ ...body, currentRevision: edit.headRevision })
      }

      const clips = await buildDefaultClips(app.db, auth.organizationId, storyboards)
      const fingerprint = defaultSequenceFingerprint(clips)

      // 幂等:head 已是该默认序列(同指纹 + system 作者)→ no-op,不产生新修订。
      if (head.author === SYSTEM_AUTHOR && head.fingerprint === fingerprint) {
        return { editId: edit.id, headRevision: edit.headRevision, rebuilt: false, revision: { ...head, clips: JSON.parse(head.clips), tracks: JSON.parse(head.tracks), outputSpec: JSON.parse(head.outputSpec) } }
      }

      // 重建:新修订(旧修订保留),author 仍 system-initial。事务内复核无人工
      // 痕迹与 CAS,并发人工保存插入时放弃并回 409,不覆盖任何人工数据。
      const rebuilt = await app.db.$transaction(async tx => {
        const fresh = await tx.episodeEdit.findUnique({ where: { id: edit.id }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } })
        const freshHead = fresh?.revisions[0] ?? null
        if (!fresh || !freshHead) return null
        const freshAuthors = await tx.episodeEditRevision.findMany({ where: { editId: fresh.id }, select: { author: true } })
        if (hasHumanRevision(freshAuthors)) return null
        if (expected !== null && expected !== fresh.headRevision) return null
        // 无 expected 时以读取到的 head 为 CAS 基准:head 被并发推进即放弃。
        if (expected === null && freshHead.id !== head.id) return null
        const revision = await tx.episodeEditRevision.create({
          data: { editId: fresh.id, revision: fresh.headRevision + 1, fpsNum: DEFAULT_FPS.fpsNum, fpsDen: DEFAULT_FPS.fpsDen, clips: JSON.stringify(clips), tracks: '[]', fingerprint, author: SYSTEM_AUTHOR },
        })
        const updated = await tx.episodeEdit.update({ where: { id: fresh.id }, data: { headRevision: fresh.headRevision + 1 } })
        return { revision, headRevision: updated.headRevision }
      })
      if (!rebuilt) {
        const current = await app.db.episodeEdit.findUnique({ where: { episodeId: episode.id }, select: { headRevision: true } })
        const { statusCode, body } = apiError('version_conflict', `编辑已被修改(当前 revision ${current?.headRevision ?? edit.headRevision}),默认序列未重建`, { nextAction: 'reload' })
        return reply.code(statusCode).send({ ...body, currentRevision: current?.headRevision ?? edit.headRevision })
      }
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'edit.build-default', entityType: 'EpisodeEdit', entityId: edit.id, payload: { revision: rebuilt.headRevision, rebuilt: true, replacedRevision: head.revision } })
      return { editId: edit.id, headRevision: rebuilt.headRevision, rebuilt: true, revision: { ...rebuilt.revision, clips, tracks: [] as unknown[], outputSpec: {} } }
    },
  )
}
