import { createHash } from 'node:crypto'
import type { PrismaClient } from '@studio/db'
import { parseStoryboardJson, type ExtractedAsset } from '@studio/pipeline'

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
export async function recordGeneratedContent(db: PrismaClient, task: ContentTask, text: string): Promise<void> {
  if (task.stage === 'SCRIPT') return recordScriptVersion(db, task, text)
  if (task.stage === 'STORYBOARD') return recordStoryboards(db, task, text)
}

function checksumOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

async function recordScriptVersion(db: PrismaClient, task: ContentTask, text: string): Promise<void> {
  const episodeId = task.batch.episodeId
  const content = text.trim()
  if (!content) throw new Error('script generation returned empty content')

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

async function recordStoryboards(db: PrismaClient, task: ContentTask, text: string): Promise<void> {
  const episodeId = task.batch.episodeId
  const parsed = parseStoryboardJson(text)
  if (!parsed) throw new Error('storyboard generation returned no parseable shot list')

  let scriptVersionId: string | null = null
  try {
    const snapshot = JSON.parse(task.requestSnapshot ?? '') as { scriptVersionId?: unknown }
    if (typeof snapshot.scriptVersionId === 'string' && snapshot.scriptVersionId !== '') scriptVersionId = snapshot.scriptVersionId
  } catch {
    // No script linkage available; the storyboards are still created, just unlinked.
  }

  // A regenerate replaces the breakdown instead of appending to it: composition
  // builds its manifest from the episode's storyboards, so two live revisions
  // would be concatenated into one episode. Shots are numbered from 1 within the
  // revision, which the (episodeId, revision, number) key allows.
  const latest = await db.storyboard.aggregate({ where: { episodeId }, _max: { revision: true } })
  const revision = (latest._max.revision ?? 0) + 1
  for (const [index, shot] of parsed.shots.entries()) {
    const number = index + 1
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
        speaker: asString(shot.speaker).trim() || null,
        sourceExcerpt: asString(shot.sourceExcerpt),
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
async function bindShotsToAssets(db: PrismaClient, episodeId: string, revision: number): Promise<void> {
  const shots = await db.storyboard.findMany({
    where: { episodeId, revision, supersededAt: null },
    select: { id: true, title: true, description: true, dialogue: true, speaker: true },
  })
  const assets = await db.asset.findMany({ where: { episodeId }, select: { id: true, name: true, kind: true } })
  const names = assets
    .map(asset => ({ ...asset, normalizedName: normalizeAssetName(asset.name).trim() }))
    .filter(asset => asset.normalizedName.length >= 2)
  for (const shot of shots) {
    // 台词与说话人都算镜头文本:说话的人就是出场的人,[小满] 的台词该绑上小满的定妆照。
    const text = `${shot.title} ${shot.description} ${shot.dialogue} ${shot.speaker ?? ''}`
    for (const asset of names) {
      if (!text.includes(asset.normalizedName)) continue
      try {
        await db.storyboardAsset.create({
          data: { storyboardId: shot.id, assetId: asset.id, role: asset.kind },
        })
      } catch (error) {
        if (!isPrismaUniqueViolation(error)) throw error
      }
    }
  }
}

// The storyboard call also reports the episode's cast, props and scenes, which is
// what lets the ASSET stage run without a human authoring the first asset.
async function recordExtractedAssets(db: PrismaClient, task: ContentTask, assets: ExtractedAsset[]): Promise<void> {
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
    try {
      await db.asset.create({
        data: {
          episodeId,
          kind,
          name,
          description: asString(asset.description).trim(),
          status: 'DRAFT',
          generationTaskId: task.id,
          projectAssetId,
        },
      })
    } catch (error) {
      // Regenerating re-extracts the same cast, and (episodeId, kind, name) is
      // unique: the asset already there may carry approved versions, so the
      // collision is a skip rather than a failure of the task that just succeeded.
      if (!isPrismaUniqueViolation(error)) throw error
    }
  }
}

// 「林小雨(主角)」→「林小雨」:括号注记是修辞不是身份,不参与匹配。
function normalizeAssetName(name: string): string {
  return name.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
}

async function matchOrCreateProjectAsset(
  db: PrismaClient,
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
  const created = await db.projectAsset.create({
    data: { projectId, kind, name, description, status: 'DRAFT', generationTaskId },
  })
  return created.id
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
}
