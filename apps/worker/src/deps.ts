import type { PrismaClient } from '@studio/db'
import type { PipelinePayload } from '@studio/jobs'
import type { Composer, Storage } from '@studio/media'
import type { QcMode } from './config.js'

export interface PipelineDeps {
  db: PrismaClient
  storage: Storage
  composer: Composer
  masterKey: string
  qcMode: QcMode
  enqueueJob(payload: PipelinePayload): Promise<void>
  pollIntervalMs?: number
  pollTimeoutMs?: number
}
