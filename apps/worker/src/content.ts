import { createHash } from 'node:crypto'
import type { PrismaClient } from '@studio/db'

interface ContentTask {
  stage: string
  requestSnapshot: string | null
  batch: { episodeId: string }
}

/**
 * Writes AI-generated episode content back into the domain after a task
 * succeeds: a SCRIPT task becomes a new ScriptVersion, a STORYBOARD task fans
 * out into Storyboard rows. Without this the generated text would sit in a
 * text artifact with no link to the thing it is meant to produce.
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
    data: { episodeId, version: (latest?.version ?? 0) + 1, content, checksum, status: 'DRAFT' },
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

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asDuration(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 5000
}

// Models often wrap the array in prose or code fences, so pull out the first
// `[ ... ]` block rather than requiring the whole reply to be bare JSON.
export function parseStoryboardJson(text: string): StoryboardShot[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    return parsed as StoryboardShot[]
  } catch {
    return null
  }
}

async function recordStoryboards(db: PrismaClient, task: ContentTask, text: string): Promise<void> {
  const episodeId = task.batch.episodeId
  const shots = parseStoryboardJson(text)
  if (!shots) throw new Error('storyboard generation returned no parseable shot list')

  let scriptVersionId: string | null = null
  try {
    const parsed = JSON.parse(task.requestSnapshot ?? '') as { scriptVersionId?: unknown }
    if (typeof parsed.scriptVersionId === 'string' && parsed.scriptVersionId !== '') scriptVersionId = parsed.scriptVersionId
  } catch {
    // No script linkage available; the storyboards are still created, just unlinked.
  }

  const maxNumber = await db.storyboard.aggregate({ where: { episodeId }, _max: { number: true } })
  let next = maxNumber._max.number ?? 0
  for (const shot of shots) {
    next += 1
    await db.storyboard.create({
      data: {
        episodeId,
        scriptVersionId,
        number: next,
        title: asString(shot.title).trim() || `Shot ${next}`,
        durationMs: asDuration(shot.durationMs),
        description: asString(shot.description).trim(),
        sourceExcerpt: asString(shot.sourceExcerpt),
        continuityIn: asString(shot.continuityIn),
        continuityOut: asString(shot.continuityOut),
        status: 'DRAFT',
      },
    })
  }
}
