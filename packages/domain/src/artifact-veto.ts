/**
 * SD-172｜机器过线的版本没有人工否决位。
 *
 * 否决（「这一版不要」）是人对**一件产物**说的话，不是对镜头说的：同一镜可能有五条
 * 付费成片，人否的是其中一条。它必须
 * ① 落在版本自己的履历里看得见，② 被下游（合成取版、生效版读数）真的跳过，
 * ③ 不新增数据库列——所以它写进 `MediaArtifact.metadata` 这个既有 JSON 文本位，
 *   与人工导入件的 `filename` 同处一格，读写只经本文件这一份编解码。
 *
 * 判定发生在 API（写）与 worker/API（读），三处必须共用同一份解析：一处放宽、
 * 另一处收紧，就会出现「界面上已否决、母带照旧取走它」。
 */

export interface ArtifactVeto {
  /** 下这一刀的时刻（ISO 字符串，与 review 快照同一口径）。 */
  at: string
  /** 下这一刀的人（userId）：否决要能回答「谁说的」。 */
  by: string
  /** 人写的理由，必填：没有理由的否决只是一个消失的版本。 */
  reason: string
}

/** metadata 里承载否决的那一格；改名等于把历史数据里的否决整批抹掉，不许动。 */
export const ARTIFACT_VETO_FIELD = 'veto'

export const VETABLE_ARTIFACT_STAGES = ['VIDEO', 'FIRST_FRAME', 'AUDIO'] as const
export type VetableArtifactStage = (typeof VETABLE_ARTIFACT_STAGES)[number]

export function isVetableArtifactStage(value: unknown): value is VetableArtifactStage {
  return typeof value === 'string' && (VETABLE_ARTIFACT_STAGES as readonly string[]).includes(value)
}

/** 只认形状完整的一格：坏数据当作「没被否决过」，而不是当作一个空理由的否决。 */
export function parseArtifactVeto(metadata: string | null | undefined): ArtifactVeto | null {
  if (!metadata) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(metadata)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const raw = (parsed as Record<string, unknown>)[ARTIFACT_VETO_FIELD]
  if (typeof raw !== 'object' || raw === null) return null
  const { at, by, reason } = raw as { at?: unknown; by?: unknown; reason?: unknown }
  if (typeof at !== 'string' || typeof reason !== 'string' || reason === '') return null
  return { at, by: typeof by === 'string' ? by : '', reason }
}

export function isArtifactVetoed(metadata: string | null | undefined): boolean {
  return parseArtifactVeto(metadata) !== null
}

/**
 * 把一格 metadata 解析成可继续编辑的对象。非 JSON 的旧值（导入件之外的历史写入）
 * 原样存进 `legacy`，绝不静默丢掉字节之外的信息。
 */
function readMetadata(metadata: string | null | undefined): Record<string, unknown> {
  if (!metadata) return {}
  try {
    const parsed: unknown = JSON.parse(metadata)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ...(parsed as Record<string, unknown>) }
    return { legacy: metadata }
  } catch {
    return { legacy: metadata }
  }
}

/** 写入或清除否决，返回新的 metadata 文本（null = 这一格现在是空的）。 */
export function writeArtifactVeto(metadata: string | null | undefined, veto: ArtifactVeto | null): string | null {
  const base = readMetadata(metadata)
  if (veto === null) {
    if (!(ARTIFACT_VETO_FIELD in base)) return metadata ?? null
    delete base[ARTIFACT_VETO_FIELD]
  } else {
    base[ARTIFACT_VETO_FIELD] = veto
  }
  return Object.keys(base).length === 0 ? null : JSON.stringify(base)
}
