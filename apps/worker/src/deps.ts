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
  // Optional because apps/worker/test is covered by no tsconfig: a required member
  // would break the existing pipeline tests at runtime rather than at typecheck.
  checker?: QualityChecker
  pollIntervalMs?: number
  pollTimeoutMs?: number
}
