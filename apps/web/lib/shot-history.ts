import type { GenerationBatch, GenerationTask, Storyboard } from './api'

/**
 * The per-shot timeline: everything that ever happened to one shot number, across
 * revisions and across batches. The batch list is the only place that knows a re-pull
 * failed and why, and it files that under a batch — this reads the same rows grouped by
 * shot, because the question on a shot card is 「#3 这一镜怎么样了」, not 「22:24 那一批」.
 */
export type ShotEventKind = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'BREAKDOWN'
export type ShotEventTone = 'ok' | 'failed' | 'running' | 'replaced'

export interface ShotEvent {
  key: string
  /** When this happened: the task's last write, or the moment a breakdown revision was replaced. */
  at: string
  kind: ShotEventKind
  tone: ShotEventTone
  storyboardId: string
  revision: number
  /** The artifact's own version (v2), or the breakdown revision for a text event. */
  version: number | null
  /** This entry is the clip the human pinned for the master. */
  selected: boolean
  /** The verdict this task ended on. */
  score: number | null
  /** Best across its attempts — a task that re-pulled three times has three scored images. */
  bestScore: number | null
  attempts: number | null
  durationMs: number | null
  model: string | null
  error: string | null
  /** 「批 N」: 1-based position of this task's batch in the episode's run order. */
  batchSeq: number | null
  artifactId: string | null
}

const MEDIA_STAGES = ['IMAGE', 'VIDEO', 'AUDIO'] as const

/** The API stores the vendor's text verbatim, sometimes as a JSON array of reasons. */
function readableError(snapshot: string | null): string | null {
  if (!snapshot) return null
  try {
    const parsed: unknown = JSON.parse(snapshot)
    if (Array.isArray(parsed)) return parsed.map(String).join(' | ').slice(0, 400)
    if (typeof parsed === 'string') return parsed.slice(0, 400)
  } catch {
    // keep the raw text
  }
  return snapshot.slice(0, 400)
}

function toneOf(task: GenerationTask): ShotEventTone {
  if (task.status === 'FAILED') return 'failed'
  if (task.status === 'QUEUED' || task.status === 'RUNNING') return 'running'
  return 'ok'
}

/** The newest version is what the shot shows; earlier ones are the re-pulls that failed. */
function latestArtifact(task: GenerationTask) {
  return task.artifacts.reduce<(typeof task.artifacts)[number] | null>(
    (best, artifact) => (!best || artifact.version > best.version ? artifact : best),
    null,
  )
}

/**
 * One pass over the episode's batches and revisions, keyed by shot number. Shots the
 * worker never touched yield no events rather than a fabricated row: a breakdown edited
 * in place leaves no timestamp in the database, and this column does not invent one.
 */
export function buildShotEvents(
  batches: GenerationBatch[],
  storyboards: Storyboard[],
): Map<number, ShotEvent[]> {
  const byId = new Map(storyboards.map(storyboard => [storyboard.id, storyboard]))
  const seqOf = new Map(
    batches
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((batch, index) => [batch.id, index + 1]),
  )
  const events = new Map<number, ShotEvent[]>()
  const push = (number: number, event: ShotEvent) => {
    const list = events.get(number)
    if (list) list.push(event)
    else events.set(number, [event])
  }

  for (const batch of batches) {
    for (const task of batch.tasks) {
      const shot = task.storyboardId ? byId.get(task.storyboardId) : null
      if (!shot) continue
      if (!MEDIA_STAGES.includes(task.stage as (typeof MEDIA_STAGES)[number])) continue
      const artifact = latestArtifact(task)
      const tone = toneOf(task)
      push(shot.number, {
        key: task.id,
        at: tone === 'running' ? task.createdAt : task.updatedAt,
        kind: task.stage as ShotEventKind,
        tone,
        storyboardId: shot.id,
        revision: shot.revision ?? 1,
        version: artifact?.version ?? null,
        selected: artifact !== null && artifact.id === shot.selectedVideoArtifactId,
        score: task.qc?.score ?? null,
        bestScore: task.scores.length > 0 ? Math.max(...task.scores) : null,
        attempts: task.attempts,
        durationMs: artifact?.durationMs ?? null,
        model: task.model,
        error: readableError(task.error),
        batchSeq: seqOf.get(batch.id) ?? null,
        artifactId: artifact?.id ?? null,
      })
    }
  }

  // The breakdown's own history: a regenerate writes revision N+1 and stamps the old row
  // instead of deleting it, so the text this shot used to carry is still on screen-reading
  // distance. Its timestamp is when it was replaced.
  for (const shot of storyboards) {
    if (!shot.supersededAt) continue
    push(shot.number, {
      key: `breakdown:${shot.id}`,
      at: shot.supersededAt,
      kind: 'BREAKDOWN',
      tone: 'replaced',
      storyboardId: shot.id,
      revision: shot.revision ?? 1,
      version: shot.revision ?? 1,
      selected: false,
      score: null,
      bestScore: null,
      attempts: null,
      durationMs: shot.durationMs,
      model: null,
      error: null,
      batchSeq: null,
      artifactId: null,
    })
  }

  for (const list of events.values()) list.sort((a, b) => b.at.localeCompare(a.at))
  return events
}

/** How many batches this shot's history spans — the header's 「来自 N 个批次」. */
export function batchCountOf(events: ShotEvent[]): number {
  return new Set(events.flatMap(event => (event.batchSeq === null ? [] : [event.batchSeq]))).size
}
