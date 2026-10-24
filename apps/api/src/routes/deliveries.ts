import { saveTechnicalReview } from '../lib/quality-findings.js'
import type { FastifyInstance } from 'fastify'
import type { Delivery, GenerationTask, MediaArtifact, PrismaClient, Stage, WorkflowStatus } from '@studio/db'
import { buildEdl, conformToEditMedia, resolveAudioRange, run, buildFcpxml, buildOtio, buildXmeml, runTechnicalCheck, type EditClip, type TechnicalFinding } from '@studio/media'
import { strToU8, zipSync } from 'fflate'
import { liveStoryboards, manifestStoryboardIds, readCompositionReview, resolveShotRhythm, reviewGapCodes, type CompositionReviewReadings } from '@studio/pipeline'
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
  /** 制品 id：清单自足的钥匙——拿着它能直接拼出 /artifacts/:id/content，字幕轨尤其依赖它。 */
  id: string
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

/** What the compose worker actually applied to the master, read off its own record. */
interface ManifestLabeling {
  standard: string
  badgeText: string
  explicit: 'burned' | 'skipped' | 'unrecorded'
  implicit: 'written' | 'unrecorded'
  reason?: string
}

/** 质量地板处理记录:loudnorm 实测证据 + 失败回退原因,由 compose worker 落库。 */
interface ManifestPostProcess {
  status: 'applied' | 'fallback'
  steps: Array<{ step: 'loudnorm' | 'upscale' | 'interpolate' | 'grade'; outcome: 'applied' | 'skipped'; reason?: string }>
  loudness?: { before: { i: number; tp: number }; after?: { i: number; tp: number } }
  target?: { i: number; tp: number }
  reason?: string
}

interface DeliveryManifest {
  schemaVersion: number
  packagedAt: string
  episode: { id: string; number: number; title: string }
  source: VersionRef | null
  script: VersionRef | null
  /** GB 45438-2025 dual-labeling record for the master; null = composed before labeling shipped. */
  labeling: ManifestLabeling | null
  /** 质量地板记录;null = 母带早于地板链上线时合成。 */
  postProcess: ManifestPostProcess | null
  storyboards: ManifestStoryboard[]
  composition: {
    objectKey: string
    checksum: string
    mimeType: string
    durationMs: number | null
    tracks: ManifestArtifact[]
  }
  quality: { checks: number; approved: number; rejected: number; threshold: number }
  /**
   * 验收三读数（S5）：打包时从这份母带自己的台账里读出的节奏/转场/声音。
   * 缺这一行 = 清单早于三读数上线，界面按「未记录」读，不补一个假数。
   */
  review?: CompositionReviewReadings
  acceptance?: ManifestAcceptance
}

interface DeliveryDto {
  id: string
  status: WorkflowStatus
  /** The composed master clip this delivery ships — what "download" should hand over. */
  artifactId: string | null
  manifest: DeliveryManifest
}

type RejectBody = { reason?: string }

// Newest task first so a manifest reads as "what we would ship today" downwards.
type SucceededTask = GenerationTask & { mediaArtifacts: MediaArtifact[] }

async function findEpisodeInOrg(db: PrismaClient, episodeId: string, organizationId: string) {
  // 三读数（S5）的节奏对照吃项目设置，交付面每条路由都要它，一次带上免得每条再查一遍。
  return db.episode.findFirst({ where: { id: episodeId, project: { organizationId } }, include: { project: { select: { shotRhythm: true } } } })
}

async function findDeliveryInOrg(db: PrismaClient, deliveryId: string, organizationId: string) {
  return db.delivery.findFirst({ where: { id: deliveryId, episode: { project: { organizationId } } } })
}

function toManifestArtifact(artifact: MediaArtifact): ManifestArtifact {
  return {
    id: artifact.id,
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
  return { id: delivery.id, status: delivery.status, artifactId: delivery.artifactId, manifest: parseManifest(delivery.manifest) }
}

/**
 * V07/US-034 正式交付门禁(§11.1 决策表):
 * - blocking 技术硬阻塞(损坏/缺流/越界)——manifest 的 qualityCheckPassed=false
 *   直接拒,不存在人工豁免通道(preview 走独立路径,不经这里)。
 * - warning 级 QualityFinding 行——每条都必须清空 open 状态(accepted/resolve
 *   且指纹与当前合成一致)才能打包;重渲染换过指纹的旧裁决视为未决。
 * - 未执行/unjudged(manifest 无 qualityCheckPassed)——打包时在这里补查一次并把
 *   结论写回 composition manifest:「没查过」不是豁免理由,补查通过即放行。
 */
async function qualityGate(
  app: import('fastify').FastifyInstance,
  composition: { id: string; episodeId: string; manifest: string; inputFingerprint: string | null },
  master: MediaArtifact,
): Promise<{ ok: true } | { ok: false; reasons: string[]; pendingCount?: number; nextAction?: 'adjudicate' }> {
  const parsed = JSON.parse(composition.manifest) as { qualityCheckPassed?: boolean; qualityFindings?: TechnicalFinding[] }
  let passed = parsed.qualityCheckPassed
  let findings = parsed.qualityFindings
  if (typeof passed !== 'boolean') {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const os = (await import('node:os')).default
    const path = (await import('node:path')).default
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-delivery-gate-'))
    try {
      const bytes = await app.storage.read(master.objectKey)
      const filePath = path.join(workdir, 'master.mp4')
      await writeFile(filePath, bytes)
      const result = await runTechnicalCheck(filePath, { expectedDurationMs: master.durationMs ?? undefined })
      passed = result.passed
      findings = result.findings
      await saveTechnicalReview(app.db, composition, master, result)
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }

  }
  if (Array.isArray(findings)) await saveTechnicalReview(app.db, composition, master, { artifactPath: master.objectKey, passed: passed === true, findings }, false)
  if (passed === false) {
    const blocking = (findings ?? []).filter(finding => finding.severity === 'blocking')
    return { ok: false, reasons: blocking.length > 0 ? blocking.map(finding => `${finding.dimension}: ${finding.message}`) : ['technical check reported failure'] }
  }
  // §11.1:warning 不是硬阻塞,但每条都要人工裁决清空——open 未处理、或裁决
  // 绑定在旧指纹上(重渲染后旧 accept 不算数),都视为未决,打包必须先裁决。
  const currentFingerprint = composition.inputFingerprint ?? composition.id
  const adjudicable = await app.db.qualityFinding.findMany({
    where: { compositionId: composition.id, severity: 'warning' },
  })
  const pending = adjudicable.filter(row => !(row.status === 'accepted' || row.status === 'resolved') || row.fingerprint !== currentFingerprint)
  if (pending.length > 0) {
    return {
      ok: false,
      reasons: pending.map(row => `${row.dimension}: ${row.message} (${row.findingKey})`),
      pendingCount: pending.length,
      nextAction: 'adjudicate',
    }
  }
  return { ok: true }
}

/** `reasons` 是给测试与排查看的原文（一条 QC 结论就是一整段中英混排），不是给人看的。
 *  界面只认 `pendingCount`——「还有 55 条等你裁决」是行动指令，55 段散文不是。 */
function qualityGateBody(gate: { ok: false; reasons: string[]; pendingCount?: number; nextAction?: 'adjudicate' }) {
  return {
    error: 'delivery:qualityGate',
    reasons: gate.reasons,
    ...(gate.pendingCount !== undefined ? { pendingCount: gate.pendingCount } : {}),
    ...(gate.nextAction !== undefined ? { nextAction: gate.nextAction } : {}),
  }
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
        include: { mediaArtifacts: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      const tasksOf = (storyboardId: string): SucceededTask[] =>
        succeededTasks.filter(task => task.storyboardId === storyboardId)
      // Composition has no timestamp columns; cuid ids sort chronologically.
      const compositions = await app.db.composition.findMany({ where: { episodeId: episode.id }, orderBy: { id: 'desc' } })
      const finished = compositions.find(composition => composition.status === 'COMPLETED' && composition.artifactId !== null)
      const master = finished?.artifactId ? await app.db.mediaArtifact.findUnique({ where: { id: finished.artifactId } }) : null

      const reasons: string[] = []
      const gapShots: number[] = []
      if (!finished) {
        reasons.push(compositions.length === 0 ? 'delivery.gap.noComposition' : 'delivery.gap.compositionNotDone')
      } else if (!master) {
        reasons.push('delivery.gap.masterMissing')
      }
      // 交付门问的是「母带里到底有没有这一镜」，不是「这一镜跑没跑过 VIDEO 任务」。
      // 字卡镜、导入片段和编辑文档钦定的 cut 都不挂在逐镜生成任务下，按任务口径它们
      // 永远缺画面——实测一集 63 镜已合成出 204 秒母带，打包却报 30 镜没有画面。
      // 母带的 storyboardIds 是排队时冻结的入带镜头表，COMPLETED 即每一镜都拿到了片段。
      if (finished) {
        const inMaster = new Set(manifestStoryboardIds(finished.manifest))
        for (const storyboard of storyboards) {
          if (!inMaster.has(storyboard.id)) gapShots.push(storyboard.number)
        }
        if (gapShots.length > 0) reasons.push('delivery.gap.shotNoClip')
      }
      if (reasons.length > 0 || !finished || !master) {
        return reply.code(409).send({ error: 'delivery:notReady', reasons, shotNumbers: gapShots })
      }

      // V07:技术检查门禁——blocking 结论(损坏/缺流/越界)拦下打包;未执行则补查。
      // US-034:warning/info 未裁决(或裁决已随指纹过期)同样拦下,先走裁决队列。
      const gate = await qualityGate(app, finished, master)
      if (!gate.ok) return reply.code(409).send(qualityGateBody(gate))

      const [source, script, subtitle, score] = await Promise.all([
        app.db.sourceDocumentVersion.findFirst({ where: { episodeId: episode.id }, orderBy: { version: 'desc' }, select: { version: true, checksum: true, status: true } }),
        app.db.scriptVersion.findFirst({ where: { episodeId: episode.id }, orderBy: { version: 'desc' }, select: { version: true, checksum: true, status: true } }),
        // Through the composition, not "the newest of the stage": a score regenerated after
        // the compose is not the one mixed into this file.
        finished.subtitleArtifactId
          ? app.db.mediaArtifact.findUnique({ where: { id: finished.subtitleArtifactId } })
          : Promise.resolve(null),
        finished.scoreArtifactId
          ? app.db.mediaArtifact.findUnique({ where: { id: finished.scoreArtifactId } })
          : Promise.resolve(null),
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

      // The compose worker records what labeling the master actually carries; a master
      // from before labeling shipped reads as null instead of pretending compliance.
      let labeling: DeliveryManifest['labeling'] = null
      let postProcess: DeliveryManifest['postProcess'] = null
      try {
        const parsed = JSON.parse(finished.manifest) as { labeling?: ManifestLabeling; postProcess?: ManifestPostProcess }
        labeling = parsed.labeling ?? null
        postProcess = parsed.postProcess ?? null
      } catch {
        labeling = null
        postProcess = null
      }

      // 验收三读数（S5）：从这份母带自己的台账里量节奏、转场落位、声音是否配齐。
      // 打包不拦（缺项只是证据不全，草稿照样值得留档），拦的是「合成完成」那一下。
      const review = readCompositionReview({
        manifest: finished.manifest,
        masterDurationMs: finished.durationMs,
        hasMusic: finished.scoreArtifactId !== null,
        rhythmSettings: resolveShotRhythm(episode.project.shotRhythm),
      })

      const manifest: DeliveryManifest = {
        schemaVersion: 1,
        packagedAt: new Date().toISOString(),
        episode: { id: episode.id, number: episode.number, title: episode.title },
        source: source ?? null,
        script: script ?? null,
        labeling,
        postProcess,
        storyboards: storyboards.map(storyboard => ({
          number: storyboard.number,
          title: storyboard.title,
          durationMs: storyboard.durationMs,
          artifacts: tasksOf(storyboard.id).flatMap(task => task.mediaArtifacts.map(toManifestArtifact)),
        })),
        composition: {
          objectKey: master.objectKey,
          checksum: master.checksum,
          mimeType: master.mimeType,
          durationMs: master.durationMs,
          // A silent master owes none of these and an audio master owes both; naming them
          // here is what lets a reader know what the container holds without opening it.
          tracks: [subtitle, score].filter((artifact): artifact is MediaArtifact => artifact !== null).map(toManifestArtifact),
        },
        quality: {
          checks: grouped.reduce((sum, group) => sum + group._count._all, 0),
          approved: counts.APPROVED ?? 0,
          rejected: counts.NEEDS_REVIEW ?? 0,
          threshold: QUALITY_THRESHOLD,
        },
        review,
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

  // 剪辑交接:从这一份交付清单生成 EDL/FCPXML/OTIO,精剪在 NLE 里做。时长优先用切片
  // 实测值，缺失才回退分镜规划值并在导出里如实标注——导出必须诚实于母带。
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/deliveries/:id/edit-list',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const format = request.query.format ?? 'edl'
      if (format !== 'edl' && format !== 'fcpxml' && format !== 'otio' && format !== 'xmeml') {
        return reply.code(400).send({ error: "format must be 'edl', 'fcpxml', 'otio' or 'xmeml'" })
      }
      const delivery = await findDeliveryInOrg(app.db, request.params.id, auth.organizationId)
      if (!delivery) return reply.code(404).send({ error: 'Delivery not found' })

      const manifest = parseManifest(delivery.manifest)

      // F13/Q04:剪辑清单冻结在打包那次合成上;源入点/fps/画幅/独立音轨与可重链
      // 相对媒体名(media/<artifactId>.<ext>)一并导出,媒体包按同名落文件。
      const frozen = await resolveFrozenEditExport(app, delivery)
      if (frozen) {
        const et = `EP${manifest.episode.number} ${manifest.episode.title}`
        const common = { title: et, clips: frozen.clips, fps: frozen.fps, ...(frozen.frame ? { frame: frozen.frame } : {}) } as const
        const frozenScore = frozen.audioTracks.some(track => track.name.startsWith('Master mix')) ? undefined : manifest.composition.tracks.find(artifact => artifact.stage === 'MUSIC')
        const body = format === 'edl'
          ? buildEdl(common)
          : format === 'fcpxml'
            ? buildFcpxml({ ...common, audioTracks: frozen.audioTracks })
            : format === 'xmeml'
              ? buildXmeml({ ...common, audioTracks: frozen.audioTracks })
              : buildOtio({ ...common, ...(frozenScore ? { score: { sourceUrl: mediaNameFor(frozenScore.id, frozenScore.mimeType), durationMs: frozenScore.durationMs } } : {}), audioTracks: frozen.audioTracks })
        reply.header('content-type', format === 'edl' ? 'text/plain; charset=utf-8' : format === 'fcpxml' || format === 'xmeml' ? 'application/xml; charset=utf-8' : 'application/json; charset=utf-8')
        reply.header('content-disposition', `attachment; filename="episode-${manifest.episode.number}-edit.${format}"`)
        return body
      }

      const clips: EditClip[] = manifest.storyboards.map(storyboard => {
        // 清单按"新→旧"记录每镜产物：交付闸门保证每镜都有成功切片，取最新的
        // VIDEO 即合成自动选版的同一对象；人工钦定版由选优门留痕另行核对。
        const video = storyboard.artifacts.find(artifact => artifact.stage === 'VIDEO')
        return {
          number: storyboard.number,
          title: storyboard.title,
          durationMs: video?.durationMs ?? storyboard.durationMs,
          sourceFile: video?.objectKey ?? `missing-shot-${storyboard.number}`,
          measured: video?.durationMs != null,
        }
      })
      const title = `EP${manifest.episode.number} ${manifest.episode.title}`
      // FCPXML 的序列画幅来自切片实测值：清单里第一个带完整尺寸的 VIDEO 产物即整集
      // 画幅（单集同源同参，尺寸一致）；老交付拿不到尺寸时由构建器回落竖屏旧默认。
      const sized = manifest.storyboards
        .map(storyboard => storyboard.artifacts.find(artifact => artifact.stage === 'VIDEO'))
        .filter((artifact): artifact is ManifestArtifact & { width: number; height: number } =>
          artifact?.width != null && artifact?.height != null)
      const frame = sized[0] ? { width: sized[0].width, height: sized[0].height } : undefined
      // OTIO 把 EDL 丢掉的配乐轨带回来:清单 tracks 里的 MUSIC 就是合成时真正混入的那条。
      const score = manifest.composition.tracks.find(artifact => artifact.stage === 'MUSIC')
      const body = format === 'edl'
        ? buildEdl({ title, clips })
        : format === 'fcpxml'
          ? buildFcpxml({ title, clips, frame })
          : buildOtio({
              title,
              clips,
              ...(score ? { score: { sourceUrl: score.objectKey, durationMs: score.durationMs } } : {}),
            })
      const extension = format
      reply.header('content-type', format === 'edl' ? 'text/plain; charset=utf-8' : format === 'fcpxml' ? 'application/xml; charset=utf-8' : 'application/json; charset=utf-8')
      reply.header('content-disposition', `attachment; filename="episode-${manifest.episode.number}-edit.${extension}"`)
      return body
    },
  )

  // 字幕交付：SRT 是交付物的一部分——烧进画面或挂成软轨都不等于「交出去了」，
  // 用户要能拿到文件去外部工具校对、复用、替换重合成。合成 worker 早已把它落成
  // SUBTITLE 制品并记在 composition 上；这里经 delivery.artifactId 精确回到打包时
  // 的那一次合成取件，而不是「该集最新」——母带之后重新合成过也不能换掉这份字幕。
  app.get<{ Params: { id: string } }>(
    '/deliveries/:id/subtitle',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const delivery = await findDeliveryInOrg(app.db, request.params.id, auth.organizationId)
      if (!delivery) return reply.code(404).send({ error: 'Delivery not found' })

      const composition = delivery.artifactId
        ? await app.db.composition.findFirst({ where: { artifactId: delivery.artifactId }, select: { subtitleArtifactId: true } })
        : null
      const artifact = composition?.subtitleArtifactId
        ? await app.db.mediaArtifact.findFirst({ where: { id: composition.subtitleArtifactId, organizationId: auth.organizationId } })
        : null
      if (!composition?.subtitleArtifactId || !artifact) {
        return reply.code(404).send({ error: 'delivery:noSubtitles' })
      }
      const stored = await app.storage.open(artifact.objectKey)
      if (!stored) return reply.code(404).send({ error: 'artifact file not found' })
      const manifest = parseManifest(delivery.manifest)
      reply.header('content-type', 'application/x-subrip; charset=utf-8')
      reply.header('content-length', String(stored.sizeBytes))
      reply.header('content-disposition', `attachment; filename="episode-${manifest.episode.number}.srt"`)
      return reply.send(stored.body)
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

      // V07:验收前重验门禁——打包之后母带被复查出 blocking(或打包时的 blocking
      // 一直未消除)时,验收必须拒绝;已损坏的文件不得被批准交出去。
      // S5:同一处再读一遍验收三读数——「合成完成」只签台账齐全的母带,缺任一项
      // 这份交付就停在草稿,让人回去补合成而不是拿标称值签字。
      if (delivery.artifactId) {
        const linked = await app.db.composition.findFirst({ where: { artifactId: delivery.artifactId } })
        const masterRow = await app.db.mediaArtifact.findUnique({ where: { id: delivery.artifactId } })
        if (linked && masterRow) {
          const gate = await qualityGate(app, linked, masterRow)
          if (!gate.ok) return reply.code(409).send(qualityGateBody(gate))
          const owner = await app.db.episode.findUnique({ where: { id: linked.episodeId }, select: { project: { select: { shotRhythm: true } } } })
          const review = readCompositionReview({
            manifest: linked.manifest,
            masterDurationMs: linked.durationMs,
            hasMusic: linked.scoreArtifactId !== null,
            rhythmSettings: resolveShotRhythm(owner?.project.shotRhythm ?? null),
          })
          if (!review.complete) return reply.code(409).send({ error: 'delivery:reviewIncomplete', reasons: reviewGapCodes(review), review })
        }
      }

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

  // Q04:媒体包——冻结剪辑的全部媒体 + 四种交接格式,文件名与清单引用一一对应,
  // 解压即是 NLE 可重链的工程目录。旧交付(无编辑链接)按清单顺序打同样的包。
  app.get<{ Params: { id: string } }>(
    '/deliveries/:id/media-package',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const delivery = await findDeliveryInOrg(app.db, request.params.id, auth.organizationId)
      if (!delivery) return reply.code(404).send({ error: 'Delivery not found' })
      const manifest = parseManifest(delivery.manifest)
      const episode = await app.db.episode.findUnique({ where: { id: delivery.episodeId }, select: { project: { select: { organizationId: true } } } })
      if (!episode || episode.project.organizationId !== auth.organizationId) return reply.code(404).send({ error: 'Delivery not found' })

      const frozen = await resolveFrozenEditExport(app, delivery)
      const title = `EP${manifest.episode.number} ${manifest.episode.title}`
      const files = new Map<string, Uint8Array>()

      const readOrNull = async (objectKey: string): Promise<Uint8Array | null> => {
        try {
          const open = await app.storage.open(objectKey)
          if (!open) return null
          const chunks: Buffer[] = []
          for await (const chunk of open.body) chunks.push(Buffer.from(chunk as Buffer))
          return new Uint8Array(Buffer.concat(chunks))
        } catch {
          return null
        }
      }

      // 媒体落包:冻结剪辑与轨道源(有编辑时),否则按清单逐镜取最新 VIDEO。
      if (frozen) {
        for (const mediaName of frozen.mediaNames) {
          const artifact = await app.db.mediaArtifact.findUnique({ where: { id: frozen.mediaArtifactIds.get(mediaName)! } })
          const bytes = artifact ? await readOrNull(artifact.objectKey) : null
          if (!bytes) return reply.code(409).send({ error: 'delivery:mediaMissing', mediaName })
          const transform = frozen.mediaTransforms.get(mediaName)
          if (!transform) { files.set(mediaName, bytes); continue }
          const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
          const path = (await import('node:path')).default
          const os = (await import('node:os')).default
          const dir = await mkdtemp(path.join(os.tmpdir(), 'nle-package-'))
          try {
            const source = path.join(dir, 'source')
            await writeFile(source, bytes)
            if (transform.kind === 'video') {
              const result = await conformToEditMedia(source, frozen.fps, 1, dir)
              if (!result) return reply.code(409).send({ error: 'delivery:mediaConformFailed', mediaName })
              files.set(mediaName, new Uint8Array(await readFile(result.outputPath)))
            } else {
              const output = path.join(dir, 'audio.wav')
              await run('ffmpeg', ['-y', '-v', 'error', '-i', source, '-vn', '-af', `volume=${transform.gain ?? 1}`, '-c:a', 'pcm_s16le', output])
              files.set(mediaName, new Uint8Array(await readFile(output)))
            }
          } finally { await rm(dir, { recursive: true, force: true }) }

        }
      } else {
        for (const storyboard of manifest.storyboards) {
          const video = storyboard.artifacts.find(artifact => artifact.stage === 'VIDEO')
          if (!video) continue
          const name = mediaNameFor(video.id, video.mimeType)
          const row = await app.db.mediaArtifact.findUnique({ where: { id: video.id } })
          const bytes = row ? await readOrNull(row.objectKey) : null
          if (bytes) files.set(name, bytes)
        }
      }
      // 母带与字幕/配乐轨随包交付——NLE 对照成片与独立轨用。
      const master = delivery.artifactId ? await app.db.mediaArtifact.findUnique({ where: { id: delivery.artifactId } }) : null
      if (master) {
        const bytes = await readOrNull(master.objectKey)
        if (bytes) files.set(mediaNameFor(master.id, master.mimeType), bytes)
      }
      for (const track of manifest.composition.tracks) {
        const row = await app.db.mediaArtifact.findUnique({ where: { id: track.id } })
        if (!row) continue
        const bytes = await readOrNull(row.objectKey)
        if (bytes) files.set(mediaNameFor(row.id, row.mimeType), bytes)
      }

      // 四种交接格式引用包内相对名;冻结分支已带源入点/fps/画幅/音轨。
      const fallbackClips: EditClip[] = manifest.storyboards.map((storyboard, index) => {
        const video = storyboard.artifacts.find(artifact => artifact.stage === 'VIDEO')
        return {
          number: storyboard.number,
          title: storyboard.title,
          durationMs: video?.durationMs ?? storyboard.durationMs,
          sourceFile: video ? mediaNameFor(video.id, video.mimeType) : `missing-shot-${storyboard.number}`,
          measured: video?.durationMs != null,
        }
      })
      const clips = frozen ? frozen.clips : fallbackClips
      const common = { title, clips, ...(frozen ? { fps: frozen.fps, ...(frozen.frame ? { frame: frozen.frame } : {}) } : {}) } as const
      const score = frozen?.audioTracks.some(track => track.name.startsWith('Master mix')) ? undefined : manifest.composition.tracks.find(artifact => artifact.stage === 'MUSIC')
      const scoreRef = score ? mediaNameFor(score.id, score.mimeType) : undefined
      const editFiles: Record<string, Uint8Array> = {
        'edit.edl': strToU8(buildEdl(common)),
        'edit.fcpxml': strToU8(buildFcpxml({ ...common, ...(frozen ? { audioTracks: frozen.audioTracks } : {}) })),
        'edit.xmeml': strToU8(buildXmeml({ ...common, ...(frozen ? { audioTracks: frozen.audioTracks } : {}) })),
        'edit.otio': strToU8(buildOtio({ ...common, ...(scoreRef && score ? { score: { sourceUrl: scoreRef, durationMs: score.durationMs } } : {}), ...(frozen ? { audioTracks: frozen.audioTracks } : {}) })),
      }
      const mediaEntries: Record<string, Uint8Array> = {}
      for (const [name, bytes] of files) mediaEntries[name] = bytes
      const zip = zipSync({ ...editFiles, ...mediaEntries, 'README.txt': strToU8('Video media is conformed to the sequence FPS. When available, Master mix reproduces the delivered audio; separate source stems are disabled to prevent double playback. Disable Master mix and enable stems to remix.\n') })
      reply.header('content-type', 'application/zip')
      reply.header('content-disposition', `attachment; filename="episode-${manifest.episode.number}-media-package.zip"`)
      return reply.send(Buffer.from(zip))
    },
  )
}

/** 媒体包内文件名:media/<artifactId>.<按 mime 推的扩展>——清单引用与磁盘同名。 */
function mediaNameFor(artifactId: string, mimeType: string): string {
  const extByMime: Record<string, string> = {
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
    'application/x-subrip': 'srt',
  }
  return `media/${artifactId}.${extByMime[mimeType] ?? 'bin'}`
}

/**
 * F13/Q04:交付冻结的编辑导出解析——经 delivery.artifactId → composition.editRevisionId
 * 加载打包时消费的修订,产出带源入点/fps/画幅/独立音轨与可重链媒体名的导出材料。
 * 新合成无编辑修订时消费 resolved;只有旧合成缺冻结输入才回退清单顺序。
 */
async function resolveFrozenEditExport(app: import('fastify').FastifyInstance, delivery: Delivery): Promise<{
  clips: EditClip[]
  fps: number
  frame?: { width: number; height: number }
  audioTracks: Array<{ name: string; sourceUrl: string; startMs: number; sourceInMs?: number; durationMs: number | null; gain: number; muted: boolean }>
  mediaNames: string[]
  mediaArtifactIds: Map<string, string>
  mediaTransforms: Map<string, { kind: 'video' | 'audio'; gain?: number }>
} | null> {
  const linked = delivery.artifactId
    ? await app.db.composition.findFirst({ where: { artifactId: delivery.artifactId }, select: { editRevisionId: true, manifest: true, artifactId: true } })
    : null
  const revision = linked?.editRevisionId
    ? await app.db.episodeEditRevision.findUnique({ where: { id: linked.editRevisionId } })
    : null
  const frozenManifest = linked ? JSON.parse(linked.manifest) : {}
  if (!revision && (!frozenManifest.resolved || !frozenManifest.nleAudio)) return null
  const episode = await app.db.episode.findUnique({ where: { id: delivery.episodeId }, select: { project: { select: { organizationId: true } } } })
  const organizationId = episode?.project.organizationId
  if (!organizationId) return null

  const fps = revision ? revision.fpsNum / revision.fpsDen : 25
  const resolvedShots = (frozenManifest.resolved?.shots ?? []) as Array<{ storyboardId: string; clipId?: string; videoArtifactId: string | null; trimInFrame: number | null; trimOutFrame: number | null }>
  const editClips = revision ? JSON.parse(revision.clips) as Array<{ clipId: string; storyboardId: string; artifactId: string; sourceInFrame: number; sourceOutFrame: number }> : await Promise.all(resolvedShots.map(async (shot, index) => {
    const artifact = shot.videoArtifactId ? await app.db.mediaArtifact.findFirst({ where: { id: shot.videoArtifactId, organizationId }, select: { durationMs: true } }) : null
    if (!artifact?.durationMs) throw new Error(`frozen video ${shot.videoArtifactId} has no duration`)
    return { clipId: shot.clipId ?? `resolved-${index}`, storyboardId: shot.storyboardId, artifactId: shot.videoArtifactId!, sourceInFrame: shot.trimInFrame ?? 0, sourceOutFrame: shot.trimOutFrame ?? Math.round(artifact.durationMs / 1000 * fps) }
  }))
  for (const clip of editClips) {
    if (!clip.artifactId) clip.artifactId = resolvedShots.find(shot => shot.clipId === clip.clipId)?.videoArtifactId ?? ''
  }
  const tracks = (revision ? JSON.parse(revision.tracks) : []) as Array<{ elementId: string; sourceArtifactId: string; anchor: 'clip' | 'sequence'; clipId?: string; offsetFrame: number; gain: number; muted: boolean; sourceInFrame?: number; sourceOutFrame?: number }>
  const nleAudio = frozenManifest.nleAudio as Array<{ name: string; artifactId: string; startMs: number; durationMs: number; gain: number; muted: boolean }> | undefined
  const titles = new Map((await app.db.storyboard.findMany({ where: { id: { in: editClips.map(ec => ec.storyboardId) } }, select: { id: true, title: true } })).map(sb => [sb.id, sb.title]))

  const mediaArtifactIds = new Map<string, string>()
  const mediaTransforms = new Map<string, { kind: 'video' | 'audio'; gain?: number }>()
  const clipArtifactIds = [...new Set(editClips.filter(ec => ec.artifactId !== '').map(ec => ec.artifactId))]
  const clipArtifactRows = clipArtifactIds.length
    ? await app.db.mediaArtifact.findMany({ where: { id: { in: clipArtifactIds }, organizationId }, select: { id: true, mimeType: true, width: true, height: true } })
    : []
  const clipArtifactById = new Map(clipArtifactRows.map(row => [row.id, row]))
  for (const row of clipArtifactRows) {
    const name = mediaNameFor(row.id, row.mimeType)
    mediaArtifactIds.set(name, row.id)
    mediaTransforms.set(name, { kind: 'video' })
  }

  // 可见片段的导出与时间线起点(轨道锚定换算用)。
  const clips: EditClip[] = []
  let cursorMs = 0
  const clipStartMs = new Map<string, number>()
  for (const [index, ec] of editClips.entries()) {
    if (ec.clipId.startsWith('__hidden__')) continue
    clipStartMs.set(ec.clipId, cursorMs)
    const durationMs = Math.round((ec.sourceOutFrame - ec.sourceInFrame) / fps * 1000)
    const artifactRow = ec.artifactId !== '' ? clipArtifactById.get(ec.artifactId) : undefined
    clips.push({
      number: clips.length + 1,
      title: titles.get(ec.storyboardId) ?? ec.clipId,
      durationMs,
      sourceFile: artifactRow ? mediaNameFor(artifactRow.id, artifactRow.mimeType) : `missing-${index + 1}`,
      measured: true,
      ...(nleAudio ? { audio: false } : {}),
      ...(ec.sourceInFrame > 0 ? { sourceInMs: Math.round(ec.sourceInFrame / fps * 1000) } : {}),
    })
    cursorMs += durationMs
  }
  // The composer holds the last frame when dialogue exceeds V1. Preserve that
  // actual rendered tail as a separate, silent video cut in the handoff.
  const masterRow = nleAudio && linked?.artifactId ? await app.db.mediaArtifact.findFirst({ where: { id: linked.artifactId, organizationId } }) : null
  const tailFrames = masterRow?.durationMs ? Math.round(masterRow.durationMs / 1000 * fps) - Math.round(cursorMs / 1000 * fps) : 0
  if (masterRow && tailFrames > 0) {
    const name = `media/${masterRow.id}-tail.mp4`
    mediaArtifactIds.set(name, masterRow.id)
    mediaTransforms.set(name, { kind: 'video' })
    clips.push({ number: clips.length + 1, title: 'Rendered final-frame hold', durationMs: tailFrames / fps * 1000, sourceInMs: cursorMs, sourceFile: name, measured: true, audio: false })
    cursorMs += tailFrames / fps * 1000
  }
  const frameSource = clipArtifactRows.find(row => row.width != null && row.height != null)
  let frame = frameSource?.width != null && frameSource.height != null ? { width: frameSource.width, height: frameSource.height } : undefined
  // V06:序列画幅以渲染同一份 resolved snapshot 为准——outputSpec.aspect 指定了
  // 画幅时,序列就是那个画幅(源素材 1920×1080 放进 9:16 序列,导出不能还写横屏,
  // 否则 NLE 建序即错)。未指定才回落源素材实测尺寸。
  try {
    const spec = JSON.parse(revision?.outputSpec ?? '{}') as { aspect?: '9:16' | '16:9' }
    if (spec?.aspect === '9:16') frame = { width: 1080, height: 1920 }
    else if (spec?.aspect === '16:9') frame = { width: 1920, height: 1080 }
  } catch { /* 旧修订 outputSpec 非法按源尺寸 */ }

  // 独立音轨:源制品解析成包内媒体名,锚定换算成时间线毫秒;解析不到的跳过。
  const audioTracks: Array<{ name: string; sourceUrl: string; startMs: number; sourceInMs?: number; durationMs: number | null; gain: number; muted: boolean }> = []
  if (nleAudio) {
    for (const track of nleAudio) {
      const durationMs = Math.min(track.durationMs, cursorMs - track.startMs)
      if (durationMs <= 0) continue
      const row = await app.db.mediaArtifact.findFirst({ where: { id: track.artifactId, organizationId }, select: { id: true, mimeType: true } })
      if (!row) throw new Error(`frozen NLE audio ${track.artifactId} is missing`)
      const name = mediaNameFor(row.id, row.mimeType)
      mediaArtifactIds.set(name, row.id)
      audioTracks.push({ ...track, durationMs, sourceUrl: name })
    }
  } else for (const [index, element] of tracks.entries()) {
    if (element.anchor === 'clip' && (!element.clipId || !clipStartMs.has(element.clipId))) continue
    const row = await app.db.mediaArtifact.findFirst({ where: { id: element.sourceArtifactId, organizationId }, select: { id: true, mimeType: true, durationMs: true } })
    if (!row) throw new Error(`edit audio ${element.sourceArtifactId} is missing`)
    const anchorMs = element.anchor === 'sequence' ? 0 : clipStartMs.get(element.clipId!) ?? 0
    const range = resolveAudioRange(element, Math.round(anchorMs / 1000 * fps), Math.round(cursorMs / 1000 * fps), row.durationMs == null ? undefined : Math.round(row.durationMs / 1000 * fps))
    if (!range) continue
    // Bake gain into a packaged WAV: OTIO readers need no vendor-specific volume effect.
    const name = `media/${row.id}-track-${index}.wav`
    mediaArtifactIds.set(name, row.id)
    mediaTransforms.set(name, { kind: 'audio', gain: element.gain })
    audioTracks.push({ name: element.elementId, sourceUrl: name, startMs: range.recordStartFrame / fps * 1000, sourceInMs: range.sourceInFrame / fps * 1000, durationMs: (range.sourceOutFrame! - range.sourceInFrame) / fps * 1000, gain: 1, muted: element.muted })
  }

  return { clips, fps, ...(frame ? { frame } : {}), audioTracks, mediaNames: [...mediaArtifactIds.keys()], mediaArtifactIds, mediaTransforms }
}
