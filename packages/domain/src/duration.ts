/**
 * The platform's own vocabulary for "how long this clip should be".
 *
 * Nothing in this file knows a vendor's name for it — that table lives in
 * `packages/providers/src/duration.ts`, one arrow away. The split is the whole point: the
 * field a shot carries, and the way a model declares the lengths it accepts, are stable
 * product facts, while `duration` / `seconds` / `durationSeconds` and whether each vendor
 * quotes them change with the connection an operator buys.
 */

/** The canonical field the pipeline writes into a task snapshot. Whole seconds. */
export const DURATION_KEY = 'durationSeconds'

/** Reads the canonical field out of a caller's parameters, or undefined when none was asked for. */
export function durationSecondsOf(parameters: Record<string, unknown>): number | undefined {
  const value = parameters[DURATION_KEY]
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * `parameters` with the canonical key removed. Needed by every adapter that spreads the
 * caller's map straight into the vendor body: leaving both spellings in one request would
 * put two durations on one bill, and the paid-for length would stop being provable.
 */
export function withoutDurationKey(parameters: Record<string, unknown>): Record<string, unknown> {
  if (!(DURATION_KEY in parameters)) return parameters
  const { [DURATION_KEY]: _canonical, ...rest } = parameters
  return rest
}

/**
 * How a model declares the lengths it accepts. Three shapes, because vendors genuinely
 * differ: a continuous range (Wan 2.7 takes any whole 2–15), an enumerable set (Veo ships
 * 4, 6 and 8 only), and one fixed value (Wan 2.2 gives no choice at all).
 *
 * The shape is always declared, never inferred: the catalog used to carry a bare
 * `durations: [5, 10]` for Kling meaning "5 or 10" beside `durations: [2, 15]` for Wan
 * meaning "anything between", and no array shows which rule produced it.
 */
export type DurationSpec =
  | { kind: 'range'; min: number; max: number }
  | { kind: 'steps'; values: number[] }
  | { kind: 'fixed'; value: number }

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads `spec.duration`. Anything unrecognisable comes back undeclared — which the worker
 * records in the task log instead of guessing a bound for it. A model that declares
 * nothing gets no length sent, and the clip's duration then belongs to the vendor; that is
 * a fact the log states, not a number this product invents.
 */
export function readDurationSpec(spec: unknown): DurationSpec | undefined {
  if (!isRecord(spec) || !isRecord(spec.duration)) return undefined
  const declared = spec.duration
  switch (declared.kind) {
    case 'range': {
      const min = positiveInteger(declared.min)
      const max = positiveInteger(declared.max)
      if (min === undefined || max === undefined || max < min) return undefined
      return { kind: 'range', min, max }
    }
    case 'steps': {
      const values = Array.isArray(declared.values) ? declared.values.map(positiveInteger) : []
      if (values.length === 0 || values.some(value => value === undefined)) return undefined
      return { kind: 'steps', values: [...new Set(values as number[])].sort((a, b) => a - b) }
    }
    case 'fixed': {
      const value = positiveInteger(declared.value)
      return value === undefined ? undefined : { kind: 'fixed', value }
    }
    default:
      return undefined
  }
}

/** The longest clip this model can be asked for, or undefined when it declares nothing. */
export function maxDurationSeconds(spec: DurationSpec | undefined): number | undefined {
  if (!spec) return undefined
  if (spec.kind === 'range') return spec.max
  if (spec.kind === 'fixed') return spec.value
  return Math.max(...spec.values)
}

/** The shortest clip this model accepts, or undefined when it declares nothing. */
export function minDurationSeconds(spec: DurationSpec | undefined): number | undefined {
  if (!spec) return undefined
  if (spec.kind === 'range') return spec.min
  if (spec.kind === 'fixed') return spec.value
  return Math.min(...spec.values)
}

/** How the declaration reads in an error or a log line, in the model's own terms. */
export function formatDurationSpec(spec: DurationSpec): string {
  if (spec.kind === 'range') return `${spec.min}–${spec.max} s`
  if (spec.kind === 'fixed') return `${spec.value} s`
  return `${spec.values.join(' / ')} s`
}

/**
 * Bounds a requested length to what one model accepts, and says whether it had to.
 *
 * Never throws: the fallback candidate runs right after a refused one, and a shot planned
 * at 15 s is a plan, not a contract with the vendor that finally wins the slot. The rule
 * is the largest accepted value at or below the request — a shorter clip is still the
 * scene the storyboard wrote, while a longer one would pad it with invented motion.
 * Below the model's floor, the floor itself is the answer: sending nothing there would
 * hand the length to a vendor default this product cannot read back.
 */
export function pinDuration(spec: DurationSpec | undefined, requestedSeconds: number | undefined): { seconds: number; capped: boolean } | undefined {
  if (!spec || requestedSeconds === undefined) return undefined
  if (spec.kind === 'fixed') return { seconds: spec.value, capped: spec.value !== requestedSeconds }
  if (spec.kind === 'range') {
    const seconds = Math.min(Math.max(requestedSeconds, spec.min), spec.max)
    return { seconds, capped: seconds !== requestedSeconds }
  }
  const below = spec.values.filter(value => value <= requestedSeconds)
  const seconds = below.length > 0 ? Math.max(...below) : spec.values[0]!
  return { seconds, capped: seconds !== requestedSeconds }
}

/**
 * What the platform actually saw a model do, as opposed to what its catalog declaration
 * claims. A declaration is a vendor document: it is right until a paid call contradicts
 * it, and then the contradiction wins for that connection.
 *
 * `probe` is the only source allowed to lower the effective max on its own. A doc link
 * or an operator's note is an annotation — the declaration stays, the label says where
 * it came from. That asymmetry is deliberate: a doc can be stale in both directions,
 * while a probe produced a clip of exactly this length on this connection.
 */
export interface DurationEvidence {
  source: 'probe' | 'doc' | 'manual'
  /** ISO date (YYYY-MM-DD) of the document read or the probe run. */
  checkedAt: string
  /** Longest clip a probe actually produced, in seconds. Ignored for doc/manual. */
  verifiedSeconds?: number
  /** The length the declaration claimed at check time, for the "declared vs measured" label. */
  declaredSeconds?: number
  url?: string
  taskId?: string
  note?: string
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  return value
}

export function readDurationEvidence(value: unknown): DurationEvidence | undefined {
  if (!isRecord(value)) return undefined
  const source = value.source
  if (source !== 'probe' && source !== 'doc' && source !== 'manual') return undefined
  const checkedAt = isoDate(value.checkedAt)
  if (!checkedAt) return undefined
  const verifiedSeconds = positiveInteger(value.verifiedSeconds)
  const declaredSeconds = positiveInteger(value.declaredSeconds)
  return {
    source,
    checkedAt,
    ...(verifiedSeconds === undefined ? {} : { verifiedSeconds }),
    ...(declaredSeconds === undefined ? {} : { declaredSeconds }),
    ...(typeof value.url === 'string' && value.url !== '' ? { url: value.url } : {}),
    ...(typeof value.taskId === 'string' && value.taskId !== '' ? { taskId: value.taskId } : {}),
    ...(typeof value.note === 'string' && value.note !== '' ? { note: value.note } : {}),
  }
}

/** The measured cap a probe established, in seconds. Doc and manual evidence never cap. */
export function measuredMaxSeconds(evidence: DurationEvidence | undefined): number | undefined {
  if (!evidence || evidence.source !== 'probe') return undefined
  return evidence.verifiedSeconds
}

/**
 * The declaration after the probe has had its say. A 30 s declaration disproved by a
 * probe that only ever produced 8 s becomes an 8 s declaration — the worker still pins
 * against this value, so a manifest promising 30 s cannot quietly bill a truncated clip.
 *
 * A fixed declaration above the measured cap becomes fixed at the cap: the probe is proof
 * that exact length was produced. A range whose floor sits above the cap is unusable and
 * comes back undeclared, which removes it from the candidate chain instead of guessing.
 */
export function capDurationSpec(spec: DurationSpec | undefined, evidence: DurationEvidence | undefined): DurationSpec | undefined {
  if (!spec) return undefined
  const cap = measuredMaxSeconds(evidence)
  if (cap === undefined) return spec
  if (spec.kind === 'range') return spec.min > cap ? undefined : { kind: 'range', min: spec.min, max: Math.min(spec.max, cap) }
  if (spec.kind === 'fixed') return { kind: 'fixed', value: Math.min(spec.value, cap) }
  const values = spec.values.filter(value => value <= cap)
  return values.length === 0 ? undefined : { kind: 'steps', values }
}

