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
  // The default has to be `pass`: the hash checker is a placeholder with no
  // opinion about the media, so letting it reject artifacts at random would stall
  // the automated chain — and with a real provider, re-buy work nobody faulted.
  // `random` is still there to exercise the rework path on purpose.
  if (value === undefined || value === '') return 'pass'
  if (value === 'random' || value === 'pass' || value === 'fail' || value === 'model') return value
  throw new Error(`STUDIO_QC_MODE must be one of random|pass|fail|model, got "${value}"`)
}
