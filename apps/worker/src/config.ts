import { loadConfig } from '@studio/config'
import type { StorageOptions } from '@studio/media'

export type QcMode = 'random' | 'pass' | 'fail' | 'model'

export interface WorkerConfig {
  databaseUrl: string
  redisUrl: string
  masterKey: string
  /** The shared config satisfies this; the worker only reads storage settings from it. */
  storage: StorageOptions
  qcMode: QcMode
}

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const shared = loadConfig(env)
  return {
    databaseUrl: shared.databaseUrl,
    redisUrl: shared.redisUrl,
    masterKey: shared.masterKey,
    storage: shared,
    qcMode: qcModeFrom(env.STUDIO_QC_MODE),
  }
}

function qcModeFrom(value: string | undefined): QcMode {
  if (value === undefined || value === '') return 'random'
  if (value === 'random' || value === 'pass' || value === 'fail' || value === 'model') return value
  throw new Error(`STUDIO_QC_MODE must be one of random|pass|fail|model, got "${value}"`)
}
