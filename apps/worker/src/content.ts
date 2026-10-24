import { createHash } from 'node:crypto'
import { Prisma } from '@studio/db'
import { normalizeSpeaker } from '@studio/domain'
import {
  auditScriptText,
  auditStoryboardShots,
  describeFindings,
  matchShotAssetLinks,
  normalizeAssetName,
  normalizeShotLines,
  normalizeShotRole,
  parseStoryboardContract,
  parseStoryboardJson,
  resolveTransition,
  type ExtractedAsset,
} from '@studio/pipeline'

export class ContentRejectedError extends Error {}

interface ContentTask {
  id: string
  stage: string
  requestSnapshot: string | null
  batch: { episodeId: string }
}

/**
 * Writes AI-generated episode content back into the domain after a task
 * succeeds: a SCRIPT task becomes a new ScriptVersion, a STORYBOARD task fans
 * out into Storyboard rows plus the episode's cast, props and scenes. Without
 * this the generated text would sit in a text artifact with no link to the
 * thing it is meant to produce.
 */
export async function recordGeneratedContent(db: Prisma.TransactionClient, task: ContentTask, text: string): Promise<void> {
  if (task.stage === 'SCRIPT') return recordScriptVersion(db, task, text)
  if (task.stage === 'STORYBOARD') return recordStoryboards(db, task, text)
}

function checksumOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

async function recordScriptVersion(db: Prisma.TransactionClient, task: ContentTask, text: string): Promise<void> {
  const episodeId = task.batch.episodeId
  const content = text.trim()
  if (!content) throw new ContentRejectedError('script generation returned empty content')
  // 结构体检:prompt 的成文契约没被满足时这一抽不算数——换下一个候选,而不是把
  // 一份分镜切不动的剧本写进库里。零成本,不调模型。
  const scriptFindings = auditScriptText(content)
  if (scriptFindings.length > 0) throw new ContentRejectedError(`script content rejected — ${describeFindings(scriptFindings)}`)

  const checksum = checksumOf(content)
  const existing = await db.scriptVersion.findFirst({ where: { episodeId, checksum } })
  if (existing) return

  const latest = await db.scriptVersion.findFirst({ where: { episodeId }, orderBy: { version: 'desc' } })
  await db.scriptVersion.create({
    data: { episodeId, version: (latest?.version ?? 0) + 1, content, checksum, status: 'DRAFT', generationTaskId: task.id },
  })
}

// The authoring vocabulary the assets panel offers as presets; anything else the
// model invents would show up as an untranslatable kind in the console.
const ASSET_KINDS = ['character', 'prop', 'scene'] as const

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asDuration(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 5000
}

function asAssetKind(value: unknown): string | null {
  const kind = asString(value).trim().toLowerCase()
  return (ASSET_KINDS as readonly string[]).includes(kind) ? kind : null
}

async function recordStoryboards(db: Prisma.TransactionClient, task: ContentTask, text: string): Promise<void> {
  const episodeId = task.batch.episodeId
  const parsed = parseStoryboardJson(text)
  if (!parsed) throw new ContentRejectedError('storyboard generation returned no parseable shot list')

  let scriptVersionId: string | null = null
  let scriptContent: string | undefined
  try {
    const snapshot = JSON.parse(task.requestSnapshot ?? '') as { scriptVersionId?: unknown }
    if (typeof snapshot.scriptVersionId === 'string' && snapshot.scriptVersionId !== '') {
      scriptVersionId = snapshot.scriptVersionId
      const script = await db.scriptVersion.findUnique({ where: { id: scriptVersionId }, select: { content: true } })
      scriptContent = script?.content ?? undefined
    }
  } catch {
    // No script linkage available; the storyboards are still created, just unlinked.
  }
  // 分镜表的时长是作者拍板的确定性数据,模型只负责逐行转录。模型把某一行抄快/抄慢
  // 一秒不该作废整批付费结果(实测第 53 镜 2s 抄成 3s,63 镜全部重买)。行数一致时
  // 以表为准覆盖;行数不一致时保持原样,交给下面的契约审计按镜数拦下。
  const contract = scriptContent === undefined ? null : parseStoryboardContract(scriptContent)
  if (contract && contract.rows.length === parsed.shots.length) {
    const drifted = parsed.shots.filter((shot, index) => shot.durationMs !== contract.rows[index]!.durationMs).length
    for (const [index, shot] of parsed.shots.entries()) {
      const row = contract.rows[index]!
      shot.durationMs = row.durationMs
      // 场景列是作者写死的地点（卧室/楼道/字卡…），模型自由拆解时不带这一列；
      // 保留模型自己报的 location，契约有值时才以契约为准。
      if (row.location !== '') shot.location = row.location
      // 「生成方式」同样以表为准：这一列决定这一镜要不要花平台额度，模型的自由
      // 拆解里没有它，只有契约能回答。
      if (row.method !== '') shot.method = row.method
      // 分镜层的三列（plan_2026-10-24 §3–§5）同样是作者拍板的：镜头类型决定这一镜
      // 该长该短，转场决定它怎么接进来，声音是合成时垫在配音下的声床。模型转录
      // 漏抄时以表为准，不让整批付费结果白丢。
      if (row.shotRole !== '') shot.shotRole = row.shotRole
      if (row.transition !== '') shot.transition = row.transition
      if (row.sound !== '') shot.ambience = row.sound
    }
    if (drifted > 0) console.warn(`[storyboard] task ${task.id}: replaced ${drifted} model duration(s) with the script's storyboard table`)
  }
  // 结构体检:空描述/场次断号是通用契约;剧本自带分镜表时,行数、每镜时长、总时长
  // 与字卡文字也逐项核对——表里的每一行都是作者拍板的镜头,不是模型的自由发挥。
  // 不过关即换候选,不把一份压过镜的分镜写进库。
  const shotFindings = auditStoryboardShots(parsed.shots, scriptContent)
  if (shotFindings.length > 0) throw new ContentRejectedError(`storyboard content rejected — ${describeFindings(shotFindings)}`)

  // A regenerate replaces the breakdown instead of appending to it: composition
  // builds its manifest from the episode's storyboards, so two live revisions
  // would be concatenated into one episode. Shots are numbered from 1 within the
  // revision, which the (episodeId, revision, number) key allows.
  const latest = await db.storyboard.aggregate({ where: { episodeId }, _max: { revision: true } })
  const revision = (latest._max.revision ?? 0) + 1
  for (const [index, shot] of parsed.shots.entries()) {
    const number = index + 1
    const lines = normalizeShotLines(shot.lines)
    const transition = resolveTransition(shot.transition, shot.transitionMs)
    await db.storyboard.create({
      data: {
        episodeId,
        scriptVersionId,
        generationTaskId: task.id,
        revision,
        number,
        title: asString(shot.title).trim() || `Shot ${number}`,
        durationMs: asDuration(shot.durationMs),
        description: asString(shot.description).trim(),
        dialogue: asString(shot.dialogue).trim(),
        speaker: normalizeSpeaker(asString(shot.speaker)),
        sourceExcerpt: asString(shot.sourceExcerpt),
        // r06·A：场次号（LLM 输出 scene）。非法值（0/负/非整数）丢弃置 null，
        // 旧模型不带该字段时整集 null——不参与场景主帧逻辑，行为与从前一致。
        sceneNumber: Number.isInteger(shot.scene) && (shot.scene as number) > 0 ? (shot.scene as number) : null,
        // 剧本分镜表的场景列：一个场次跨多个地点时，场次号回答不了「这一镜在哪个景」。
        location: asString(shot.location).trim() || null,
        // 生成方式（视频/字卡/屏幕录制/合成/UI）：IMAGE/VIDEO 只为「视频」那一档排队。
        // null = 旧数据或自由拆解，分类时按视频处理。
        method: asString(shot.method).trim() || null,
        // 分镜层：镜头角色只在词表内落库（认不出就是没有），转场认不出时按硬切，
        // 硬切的时长恒为 0；镜内多句台词不足两句时不落（单句仍走 dialogue）。
        shotRole: normalizeShotRole(shot.shotRole),
        transition: transition.transition,
        transitionMs: transition.transitionMs,
        lines: lines === null ? Prisma.DbNull : (lines as unknown as Prisma.InputJsonValue),
        ambience: (asString(shot.ambience).trim() || asString(shot.sound).trim()) || null,
        continuityIn: asString(shot.continuityIn),
        continuityOut: asString(shot.continuityOut),
        status: 'DRAFT',
      },
    })
  }

  // Supersede after the new revision exists: a half-written revision then stays
  // recoverable, because the next attempt supersedes it too. Prior shots are only
  // stamped, never deleted — they may carry first frames and video already paid for.
  await db.storyboard.updateMany({
    where: { episodeId, revision: { not: revision }, supersededAt: null },
    data: { supersededAt: new Date() },
  })

  await recordExtractedAssets(db, task, parsed.assets)
  // 分镜 AI 的输出里没有镜头级素材关联,而零绑定会让首帧既没有素材描述也没有
  // 定妆照参考——一致性的源头断在这里。按"镜头文本提到素材名"建立绑定:
  // 提到「小满」就绑小满的定妆照。专名匹配,误绑远好过全空。
  await bindShotsToAssets(db, episodeId, revision)
}

/**
 * 按镜头描述中的素材名匹配建立镜头-素材绑定。名字先做括号注记剥离与去重,
 * 两字以下的短名不做匹配(误绑率高于价值);绑定冲突静默跳过——重复拆解
 * 重建素材行时,同一对 (shot, asset) 可能已被上一轮建过。
 */
async function bindShotsToAssets(db: Prisma.TransactionClient, episodeId: string, revision: number): Promise<void> {
  const shots = await db.storyboard.findMany({
    where: { episodeId, revision, supersededAt: null },
    select: { id: true, title: true, description: true, dialogue: true, speaker: true, location: true },
  })
  const assets = await db.asset.findMany({ where: { episodeId }, select: { id: true, name: true, kind: true } })
  const rows = matchShotAssetLinks(shots, assets)
  // 重复拆解重建素材行时同一对 (shot, asset) 可能已被建过。事务里的唯一键冲突
  // 即使被 catch 也会把整个 Postgres 事务置为 aborted,后续查询全部 25P02,所以
  // 这里必须让冲突根本不发生。
  if (rows.length > 0) await db.storyboardAsset.createMany({ data: rows, skipDuplicates: true })
}

// The storyboard call also reports the episode's cast, props and scenes, which is
// what lets the ASSET stage run without a human authoring the first asset.
async function recordExtractedAssets(db: Prisma.TransactionClient, task: ContentTask, assets: ExtractedAsset[]): Promise<void> {
  const episodeId = task.batch.episodeId
  // 素材身份归属项目,不归属单集:同一角色跨集复用全局库里的同一份档案,
  // 拆解时按归一化名称匹配——命中即链接复用,未命中才新建库条目。
  const episode = await db.episode.findUnique({ where: { id: episodeId }, select: { projectId: true } })
  const projectId = episode?.projectId
  for (const asset of assets) {
    const kind = asAssetKind(asset.kind)
    const name = asString(asset.name).trim()
    if (!kind || !name) continue
    const projectAssetId = projectId
      ? await matchOrCreateProjectAsset(db, projectId, kind, name, asString(asset.description).trim(), task.id)
      : null
    // Regenerating re-extracts the same cast, and (episodeId, kind, name) is
    // unique: the asset already there may carry approved versions, so an existing
    // row is kept untouched. An upsert rather than a catch: inside a Postgres
    // transaction a caught unique violation still aborts the whole transaction.
    await db.asset.upsert({
      where: { episodeId_kind_name: { episodeId, kind, name } },
      update: {},
      create: {
        episodeId,
        kind,
        name,
        description: asString(asset.description).trim(),
        status: 'DRAFT',
        generationTaskId: task.id,
        projectAssetId,
      },
    })
  }
}

// 「林小雨(主角)」→「林小雨」:括号注记是修辞不是身份,不参与匹配。
async function matchOrCreateProjectAsset(
  db: Prisma.TransactionClient,
  projectId: string,
  kind: string,
  name: string,
  description: string,
  generationTaskId: string,
): Promise<string | null> {
  const normalized = normalizeAssetName(name)
  const candidates = await db.projectAsset.findMany({ where: { projectId, kind } })
  const match =
    candidates.find(candidate => candidate.name === name) ??
    (normalized !== '' ? candidates.find(candidate => normalizeAssetName(candidate.name) === normalized) : undefined) ??
    null
  if (match) return match.id
  // Same reason as the episode asset upsert: a concurrent breakdown may create the
  // same (project, kind, name) between the read above and this write.
  const created = await db.projectAsset.upsert({
    where: { projectId_kind_name: { projectId, kind, name } },
    update: {},
    create: { projectId, kind, name, description, status: 'DRAFT', generationTaskId },
  })
  return created.id
}
