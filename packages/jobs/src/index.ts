import { Queue, type ConnectionOptions } from 'bullmq'

export const PIPELINE_QUEUE = 'studio-pipeline'

export interface RunTaskPayload {
  kind: 'run-task'
  taskId: string
  organizationId: string
  attempt: number
  candidates: RunTaskCandidate[]
}

export interface RunTaskCandidate {
  connectionId: string
  capabilityId: string
  provider: string
  model: string
}

export interface ComposeEpisodePayload {
  kind: 'compose-episode'
  compositionId: string
  episodeId: string
  organizationId: string
}

export interface RunArtifactOperationPayload {
  kind: 'run-artifact-operation'
  operationId: string
  organizationId: string
  attempt: number
  candidate: RunTaskCandidate
}

export type PipelinePayload = RunTaskPayload | ComposeEpisodePayload | RunArtifactOperationPayload
export type JobName = PipelinePayload['kind']

export function pipelineConnection(): ConnectionOptions {
  return { url: process.env.REDIS_URL || 'redis://127.0.0.1:6380' }
}

export function createPipelineQueue(connection: ConnectionOptions = pipelineConnection()): Queue<PipelinePayload> {
  return new Queue<PipelinePayload>(PIPELINE_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 500 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  })
}

/** Deduplicated per (task, attempt) so a rework enqueue never collides with its predecessor. */
export function jobIdFor(payload: PipelinePayload): string {
  return payload.kind === 'run-task'
    ? `run-${payload.taskId}-${payload.attempt}`
    : payload.kind === 'compose-episode'
      ? `compose-${payload.compositionId}`
      : `op-${payload.operationId}-${payload.attempt}`
}

export async function enqueue(queue: Queue<PipelinePayload>, payload: PipelinePayload): Promise<void> {
  await queue.add(payload.kind, payload, { jobId: jobIdFor(payload) })
}
