import type { PrismaClient } from '@studio/db'
import type { PipelinePayload } from '@studio/jobs'
import type { Composer, Storage } from '@studio/media'
import type { QcMode } from './config.js'
import type { QualityChecker } from './qc.js'

export interface PipelineDeps {
  db: PrismaClient
  storage: Storage
  composer: Composer
  masterKey: string
  qcMode: QcMode
  enqueueJob(payload: PipelinePayload): Promise<void>
  // Only model mode injects one. The hash checker has to be built per task from its
  // id and attempt, which a worker-wide dependency cannot carry, so run-task builds
  // it itself when this is unset.
  checker?: QualityChecker
  pollIntervalMs?: number
  pollTimeoutMs: number
}
