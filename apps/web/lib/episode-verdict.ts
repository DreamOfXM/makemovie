import { isLiveStoryboard, toWorkflowStatus, type Episode } from './api'

/**
 * Where an episode actually stopped, read off its shots.
 *
 * `episode.status` cannot answer that: nothing in the product writes it, so a row
 * reads 草稿 whether the episode is blocked on a failed render or already shipped.
 * The ladder is failure-first — the thing that costs the most if it is ignored is
 * the thing the row names.
 */
export type EpisodeStage =
  | 'blocked'
  | 'review'
  | 'source'
  | 'running'
  | 'deliverable'
  | 'delivered'
  | 'start'
  | 'none'

/** The lifecycle strip's colour: 绿=可交付, 琥珀=等你, 红=被阻塞, 灰=还没动.
 *  'running' is its own tone because it is neither yours nor nobody's — painting it
 *  grey would read as "not started", painting it amber would blame you. */
export type EpisodeTone = 'blocked' | 'waiting' | 'running' | 'done' | 'idle'

export interface EpisodeVerdict {
  stage: EpisodeStage
  tone: EpisodeTone
  /** Live shots — the breakdown in use, not the history beside it. */
  shots: number
  /** Live shots whose render you have already signed off. */
  approved: number
  /** Number going into the label: shots blocking you, shots awaiting your review. */
  count: number
  /** Counts toward 「1/6 完成」: every shot signed off, or a delivery on record. */
  done: boolean
}

export function episodeVerdict(episode: Episode): EpisodeVerdict {
  const shots = (episode.storyboards ?? []).filter(isLiveStoryboard)
  const statuses = shots.map(shot => toWorkflowStatus(shot.status))
  const blocked = statuses.filter(status => status === 'blocked').length
  const review = statuses.filter(status => status === 'needs_review').length
  const running = statuses.filter(status => status === 'running').length
  const approved = statuses.filter(status => status === 'approved' || status === 'completed').length
  const pendingSources = (episode.sourceVersions ?? []).filter(version => version.status === 'DRAFT').length
  const delivered = episode.progress?.delivered ?? 0
  const atRest = shots.length > 0 && approved === shots.length

  const base = {
    shots: shots.length,
    approved,
    done: atRest || delivered > 0,
  }

  if (blocked > 0) return { ...base, stage: 'blocked', tone: 'blocked', count: blocked }
  if (review > 0) return { ...base, stage: 'review', tone: 'waiting', count: review }
  if (pendingSources > 0) return { ...base, stage: 'source', tone: 'waiting', count: pendingSources }
  if (running > 0) return { ...base, stage: 'running', tone: 'running', count: running }
  if (shots.length === 0) return { ...base, stage: 'none', tone: 'idle', count: 0 }
  if (atRest) return { ...base, stage: delivered > 0 ? 'delivered' : 'deliverable', tone: 'done', count: 0 }
  // Shots exist, nothing is running, nothing waits on a verdict: the next move is
  // yours, but nothing is overdue — the grey of "hasn't moved yet", not the amber
  // of "you left something sitting".
  return { ...base, stage: 'start', tone: 'idle', count: 0 }
}

/** Right-hand half of 「6 镜 · 0 有画面」: the furthest thing that actually exists. */
export type ProgressToken = 'delivered' | 'composed' | 'approved' | 'frames' | 'nothing'

export function episodeProgressToken(episode: Episode, verdict: EpisodeVerdict): { token: ProgressToken; count: number } {
  if (verdict.shots === 0) return { token: 'nothing', count: 0 }
  const progress = episode.progress
  if ((progress?.delivered ?? 0) > 0) return { token: 'delivered', count: 0 }
  if ((progress?.composed ?? 0) > 0) return { token: 'composed', count: 0 }
  if (verdict.approved > 0) return { token: 'approved', count: verdict.approved }
  return { token: 'frames', count: progress?.frames ?? 0 }
}
