import { createHash } from 'node:crypto'
import type { PrismaClient } from '@studio/db'

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

interface StoryboardShot {
  title?: unknown
  description?: unknown
  sourceExcerpt?: unknown
  durationMs?: unknown
  continuityIn?: unknown
  continuityOut?: unknown
}

interface ExtractedAsset {
  kind?: unknown
  name?: unknown
  description?: unknown
}

export interface ParsedStoryboard {
  shots: StoryboardShot[]
  assets: ExtractedAsset[]
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

// Models wrap the payload in prose or code fences, so scan for the balanced JSON
// values in the reply instead of requiring it to be bare JSON. `{shots, assets}` is
// the current contract; a bare array is the shots-only shape the earlier prompt
// produced, and is still accepted.
export function parseStoryboardJson(text: string): ParsedStoryboard | null {
  for (const block of jsonBlocks(text)) {
    // A document that names `shots` is the reply even when the shot list came back
    // empty — falling through to the assets array would write the cast as shots.
    if (isRecord(block) && 'shots' in block) return asStoryboardDocument(block)
    if (Array.isArray(block) && block.length > 0) return { shots: block as StoryboardShot[], assets: [] }
  }
  return null
}

function asStoryboardDocument(document: Record<string, unknown>): ParsedStoryboard | null {
  const shots = document.shots
  if (!Array.isArray(shots) || shots.length === 0) return null
  const assets = document.assets
  return { shots: shots as StoryboardShot[], assets: Array.isArray(assets) ? (assets as ExtractedAsset[]) : [] }
}

function* jsonBlocks(text: string): Generator<unknown> {
  for (let start = 0; start < text.length; start += 1) {
    const open = text[start]
    if (open !== '{' && open !== '[') continue
    const end = balancedEnd(text, start)
    if (end === -1) continue
    try {
      yield JSON.parse(text.slice(start, end + 1)) as unknown
      start = end
    } catch {
      // A brace in the surrounding prose, or a truncated payload: keep looking.
    }
  }
}

function balancedEnd(text: string, start: number): number {
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
}

// The storyboard call also reports the episode's cast, props and scenes, which is
// what lets the ASSET stage run without a human authoring the first asset.
async function recordExtractedAssets(db: PrismaClient, task: ContentTask, assets: ExtractedAsset[]): Promise<void> {
  const episodeId = task.batch.episodeId
  for (const asset of assets) {
    const kind = asAssetKind(asset.kind)
    const name = asString(asset.name).trim()
    if (!kind || !name) continue
    try {
      await db.asset.create({
        data: {
          episodeId,
          kind,
          name,
          description: asString(asset.description).trim(),
          status: 'DRAFT',
          generationTaskId: task.id,
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

function isPrismaUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
}
