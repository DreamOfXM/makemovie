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
  pollTimeoutMs: number
}

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const shared = loadConfig(env)
  return {
    databaseUrl: shared.databaseUrl,
    redisUrl: shared.redisUrl,
    masterKey: shared.masterKey,
    storage: shared,
    qcMode: qcModeFrom(env.STUDIO_QC_MODE),
    pollTimeoutMs: shared.pollTimeoutMs,
  }
}

function qcModeFrom(value: string | undefined): QcMode {
  // 默认 `model`:近零成本的视觉审核是"送贵模型前"的守门员,坏帧在这里被
  // 重做或打回,而不是混进视频阶段烧额度。空响应/无绑定时会显式失败(unjudged),
  // 宁可重生成一次首帧,也不让没审过的内容冒充合格品流向下游。
  // `pass` 仍然可选:确认要无人值守大批量跑、愿意自担质检缺位时显式设置。
  if (value === undefined || value === '') return 'model'
  if (value === 'random' || value === 'pass' || value === 'fail' || value === 'model') return value
  throw new Error(`STUDIO_QC_MODE must be one of random|pass|fail|model, got "${value}"`)
}
