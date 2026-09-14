import type { FastifyInstance } from 'fastify'
import { createPipelineQueue, enqueue, type PipelinePayload } from '@studio/jobs'

type PipelineQueue = ReturnType<typeof createPipelineQueue>

/**
 * The app's pipeline queue as an `enqueueJob`, for the routes that hand work to the
 * worker. Lazily created: constructing a BullMQ queue opens a Redis connection, and
 * an instance that never enqueues — a read-only replica, a test that only exercises
 * refusals — should not need one. The queue it does create is closed with the app.
 */
export function pipelineJobs(app: FastifyInstance): (payload: PipelinePayload) => Promise<void> {
  let queue: PipelineQueue | undefined
  app.addHook('onClose', async () => {
    await queue?.close()
  })
  return payload => {
    queue ??= createPipelineQueue()
    return enqueue(queue, payload)
  }
}
