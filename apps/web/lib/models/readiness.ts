import { canBind, callEvidenceKey, isTerminalFailure, type CapabilitySlot, type FailureKind, type ModelModality } from '@studio/domain'
import type { Binding, CallEvidenceMap, Catalog, Connection, GenerationStage } from '@/lib/api'

export interface BindableCapability {
  capabilityId: string
  model: string
  displayName: string | null
  modality: string
  connectionId: string
  connectionName: string
  provider: string
  acceptsFirstFrame: boolean
  acceptsReferenceImages: boolean
  maxReferenceImages: number
}

/**
 * Only capabilities on an enabled connection whose entitlement the provider
 * confirmed are offered here — the same two rules `POST /bindings` enforces.
 */
export function bindableCapabilities(connections: Connection[]): BindableCapability[] {
  return connections.flatMap(connection =>
    connection.enabled
      ? connection.capabilities
          .filter(capability => capability.entitlementVerifiedAt || capability.credentialVerifiedAt)
          .map(capability => ({
            capabilityId: capability.id,
            model: capability.model,
            displayName: capability.displayName,
            modality: capability.modality,
            connectionId: connection.id,
            connectionName: connection.name,
            provider: connection.provider,
            acceptsFirstFrame: capability.acceptsFirstFrame,
            acceptsReferenceImages: capability.acceptsReferenceImages,
            maxReferenceImages: capability.maxReferenceImages,
          }))
      : [],
  )
}

export function candidatesForSlot(pool: BindableCapability[], slot: CapabilitySlot): BindableCapability[] {
  return pool.filter(item =>
    canBind(slot, {
      provider: item.provider,
      model: item.model,
      modality: item.modality as ModelModality,
      acceptsFirstFrame: item.acceptsFirstFrame,
      acceptsReferenceImages: item.acceptsReferenceImages,
      maxReferenceImages: item.maxReferenceImages,
    }).ok,
  )
}

export interface SlotUsage {
  /**
   * The stages that actually resolve this slot: `stageSlots` in the pipeline for the one
   * every stage plans against, plus VIDEO's optional lookup of a conditioning model beside it.
   * An empty list means no code path reads the slot, so nothing is waiting on it.
   */
  stages: readonly GenerationStage[]
  /** The slot only ever serves the worker quality gate, which is off unless `STUDIO_QC_MODE=model`. */
  qcOnly: boolean
  /** Without a usable binding the chain cannot finish, rather than finishing with less. */
  required: boolean
}

const slotUsage: Record<CapabilitySlot, SlotUsage> = {
  script_text: { stages: ['SCRIPT'], qcOnly: false, required: true },
  storyboard_text: { stages: ['STORYBOARD'], qcOnly: false, required: true },
  image_gen: { stages: ['ASSET', 'IMAGE'], qcOnly: false, required: true },
  video_t2v: { stages: ['VIDEO'], qcOnly: false, required: true },
  // The optional half of VIDEO: when a model is bound here, each shot's own newest first
  // frame — the one no review sent back — conditions its clip. With nothing bound the stage
  // runs on `video_t2v` alone, exactly as it did before conditioning existed.
  video_i2v: { stages: ['VIDEO'], qcOnly: false, required: false },
  // Unwired because of our own upstream data, not the contract: the reference type exists
  // and binds, but the pipeline attributes no asset to a shot, so the only
  // `StoryboardAsset` rows that exist are the ones a human routed by hand.
  video_r2v: { stages: [], qcOnly: false, required: false },
  tts_voice: { stages: ['AUDIO'], qcOnly: false, required: false },
  music_gen: { stages: ['MUSIC'], qcOnly: false, required: false },
  visual_audit: { stages: [], qcOnly: true, required: false },
}

export type SlotReadinessState = 'ready' | 'needsBinding' | 'missing'

/** 本槽全部可用模型最近一次真实调用都撞在同一类终局原因上。 */
export interface SlotCallBlock {
  kind: FailureKind
  at: string
  models: string[]
}

export interface SlotReadiness {
  slot: CapabilitySlot
  usage: SlotUsage
  /** Distinct probe-verified, enabled models that would fit this slot if bound. */
  bindableCount: number
  /** Models this slot can run with right now, deduplicated the way the pipeline does. */
  usableCount: number
  /** Usable, but only through project-scoped bindings — other projects still have nothing. */
  projectOnly: boolean
  /**
   * 绑定一条没变、探测记录也还是绿的，但这一档模型现在跑不通。探测时间戳只证明
   * 「曾经通过」，额度用尽和权限被收回不会自己把它改红（2026-09-26 全站验收 B2）。
   */
  callBlocked: SlotCallBlock | null
  state: SlotReadinessState
}

/**
 * Mirrors `resolveSlotCandidates`: a binding counts only while it is enabled, its
 * capability was verified against the vendor (entitlement, or at least the key), and
 * its connection is still enabled. Computed here so the console can say what is
 * missing without another round trip.
 */
export function slotReadiness(connections: Connection[], bindings: Binding[], evidence: CallEvidenceMap = {}): SlotReadiness[] {
  const pool = bindableCapabilities(connections)
  return (Object.keys(slotUsage) as CapabilitySlot[]).map(slot => {
    const usage = slotUsage[slot]
    const usable = bindings.filter(binding => isUsable(binding, slot))
    const capabilityIds = new Set(usable.map(binding => binding.capabilityId))
    const usableCount = capabilityIds.size
    return {
      slot,
      usage,
      bindableCount: candidatesForSlot(pool, slot).length,
      usableCount,
      projectOnly: usableCount > 0 && usable.every(binding => binding.projectId !== null),
      callBlocked: callBlock(usable, evidence),
      state: usableCount > 0 ? 'ready' : candidatesForSlot(pool, slot).length > 0 ? 'needsBinding' : 'missing',
    }
  })
}

/**
 * 只有「一个都不通」才算这个槽位跑不通：只要还有一个可用模型最近一次真调用成功、
 * 或者根本没调用过（未知 ≠ 坏），就绪度就不许改口。
 */
function callBlock(usable: Binding[], evidence: CallEvidenceMap): SlotCallBlock | null {
  const failing = new Map<string, { model: string; at: string; kind: FailureKind }>()
  const seen = new Set<string>()
  for (const binding of usable) {
    const provider = binding.capability?.connection?.provider
    const model = binding.capability?.model
    if (!provider || !model) return null
    const key = callEvidenceKey(provider, model)
    if (seen.has(key)) continue
    seen.add(key)
    const record = evidence[key]
    if (!record || record.lastStatus !== 'FAILED' || !isTerminalFailure(record.lastKind)) return null
    failing.set(key, { model, at: record.lastAt, kind: record.lastKind })
  }
  if (failing.size === 0) return null
  const latest = [...failing.values()].sort((left, right) => right.at.localeCompare(left.at))[0]
  return { kind: latest.kind, at: latest.at, models: [...failing.values()].map(item => item.model) }
}

/** The three rules `resolveSlotCandidates` applies: enabled binding, verified capability, enabled connection. */
function isUsable(binding: Binding, slot: CapabilitySlot): boolean {
  if (binding.slot !== slot || !binding.enabled) return false
  const capability = binding.capability
  return (
    !!capability &&
    !!(capability.entitlementVerifiedAt || capability.credentialVerifiedAt) &&
    !!capability.connection?.enabled
  )
}

/** Required slots the pipeline resolves today; anything unwired is excluded by construction. */
export function wiredRequiredSlots(): CapabilitySlot[] {
  return (Object.keys(slotUsage) as CapabilitySlot[]).filter(slot => {
    const usage = slotUsage[slot]
    return usage.required && usage.stages.length > 0
  })
}

function requiredSlots(readiness: SlotReadiness[]): SlotReadiness[] {
  const required = new Set(wiredRequiredSlots())
  return readiness.filter(item => required.has(item.slot))
}

export function readyCount(readiness: SlotReadiness[]): number {
  return requiredSlots(readiness).filter(item => item.state === 'ready' && !item.callBlocked).length
}

/**
 * 面板只挑一个「现在挡你」的行：要么没绑可用模型，要么绑了但这一档模型现在跑不通。
 * 后者不看真实调用就会绿着撒谎——探测时间戳不会自己变红。
 */
export function isHeldUp(item: SlotReadiness): boolean {
  return item.usage.required && (item.state !== 'ready' || item.callBlocked !== null)
}

/** Slots that are wired but hold no usable model, worst first. */
export function gapSlots(readiness: SlotReadiness[]): SlotReadiness[] {
  return readiness
    .filter(item => item.usage.stages.length > 0 && item.state !== 'ready')
    .sort((left, right) => Number(right.usage.required) - Number(left.usage.required))
}

/** Wired into the domain but never resolved by the pipeline — never ask a user to buy one. */
export function unwiredSlots(readiness: SlotReadiness[]): SlotReadiness[] {
  return readiness.filter(item => item.usage.stages.length === 0 && !item.usage.qcOnly)
}

/** One vendor's reach over the required slots, in catalog order; never surfaces in the UI on its own. */
interface ProviderSlotCoverage {
  provider: string
  label: string
  covered: CapabilitySlot[]
}

/**
 * How far each vendor's brochure gets you, measured with the same `canBind` rule the
 * binding endpoint enforces. Deduplicated by provider id. Mock is excluded because it
 * needs no key, so counting it would win every comparison and say nothing.
 */
function providerCoverage(catalogs: Catalog[]): ProviderSlotCoverage[] {
  const required = wiredRequiredSlots()
  const seen = new Set<string>()
  const result: ProviderSlotCoverage[] = []
  for (const catalog of catalogs) {
    if (catalog.provider === 'mock' || seen.has(catalog.provider)) continue
    seen.add(catalog.provider)
    const pool: BindableCapability[] = catalog.models.map(model => ({
      capabilityId: `${catalog.provider}:${model.model}`,
      model: model.model,
      displayName: model.displayName,
      modality: model.modality,
      connectionId: '',
      connectionName: '',
      provider: catalog.provider,
      acceptsFirstFrame: !!model.acceptsFirstFrame,
      acceptsReferenceImages: !!model.acceptsReferenceImages,
      maxReferenceImages: model.maxReferenceImages ?? 0,
    }))
    result.push({
      provider: catalog.provider,
      label: catalog.label,
      covered: required.filter(slot => candidatesForSlot(pool, slot).length > 0),
    })
  }
  return result
}

export interface SlotCandidateProviders {
  slot: CapabilitySlot
  providers: { provider: string; label: string }[]
}

/** Which vendors could serve each required slot — the "do I need another vendor for this step" answer. */
export function requiredSlotCoverage(catalogs: Catalog[]): { perSlot: SlotCandidateProviders[]; total: number } {
  const required = wiredRequiredSlots()
  const coverage = providerCoverage(catalogs)
  return {
    perSlot: required.map(slot => ({
      slot,
      providers: coverage
        .filter(entry => entry.covered.includes(slot))
        .map(entry => ({ provider: entry.provider, label: entry.label })),
    })),
    total: required.length,
  }
}

export interface MinimumConnectionsResult {
  /** Least number of vendors whose union covers every required slot; null when some slot has no candidate at all. */
  count: number | null
  /** Minimal combinations in catalog order; only the first `renderLimit` are carried. */
  combinations: { provider: string; label: string }[][]
  /** How many minimal combinations exist in total — `combinations` is a prefix of that list. */
  total: number
  truncated: boolean
}

/**
 * The question a buyer actually asks — "how many connections do I have to open" — answered
 * by exact set cover over the required slots. Subsets are enumerated by ascending size, and
 * *all* ties at the minimum are reported: picking one of them would be a recommendation,
 * which this product does not make. Combinatorial is fine while the catalog stays small
 * (127 subsets at today's 7 vendors); past ~20 vendors this needs a greedy approximation
 * with weaker semantics — revisit then, not now.
 */
export function minimumConnections(catalogs: Catalog[], renderLimit = 3): MinimumConnectionsResult {
  const required = wiredRequiredSlots()
  const coverage = providerCoverage(catalogs)
  if (required.some(slot => !coverage.some(entry => entry.covered.includes(slot)))) {
    return { count: null, combinations: [], total: 0, truncated: false }
  }
  for (let size = 1; size <= coverage.length; size++) {
    const found: ProviderSlotCoverage[][] = []
    eachCombination(coverage, size, combo => {
      if (required.every(slot => combo.some(entry => entry.covered.includes(slot)))) found.push(combo)
    })
    if (found.length > 0) {
      return {
        count: size,
        combinations: found
          .slice(0, renderLimit)
          .map(combo => combo.map(({ provider, label }) => ({ provider, label }))),
        total: found.length,
        truncated: found.length > renderLimit,
      }
    }
  }
  return { count: null, combinations: [], total: 0, truncated: false }
}

function eachCombination<T>(items: readonly T[], size: number, visit: (combo: T[]) => void): void {
  const pick: T[] = []
  const walk = (start: number): void => {
    if (pick.length === size) {
      visit([...pick])
      return
    }
    for (let index = start; index <= items.length - (size - pick.length); index++) {
      pick.push(items[index])
      walk(index + 1)
      pick.pop()
    }
  }
  walk(0)
}
