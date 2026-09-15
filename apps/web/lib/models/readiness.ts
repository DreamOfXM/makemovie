import { canBind, type CapabilitySlot, type ModelModality } from '@studio/domain'
import type { Binding, Catalog, Connection, GenerationStage } from '@/lib/api'

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
          .filter(capability => capability.entitlementVerifiedAt)
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
   * The stages that actually resolve this slot, per `stageSlots` in the pipeline.
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
  video_i2v: { stages: [], qcOnly: false, required: false },
  video_r2v: { stages: [], qcOnly: false, required: false },
  tts_voice: { stages: ['AUDIO'], qcOnly: false, required: false },
  music_gen: { stages: ['MUSIC'], qcOnly: false, required: false },
  visual_audit: { stages: [], qcOnly: true, required: false },
}

export type SlotReadinessState = 'ready' | 'needsBinding' | 'missing'

export interface SlotReadiness {
  slot: CapabilitySlot
  usage: SlotUsage
  /** Distinct probe-verified, enabled models that would fit this slot if bound. */
  bindableCount: number
  /** Models this slot can run with right now, deduplicated the way the pipeline does. */
  usableCount: number
  /** Usable, but only through project-scoped bindings — other projects still have nothing. */
  projectOnly: boolean
  state: SlotReadinessState
}

/**
 * Mirrors `resolveSlotCandidates`: a binding counts only while it is enabled, its
 * capability's entitlement was confirmed, and its connection is still enabled.
 * Computed here so the console can say what is missing without another round trip.
 */
export function slotReadiness(connections: Connection[], bindings: Binding[]): SlotReadiness[] {
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
      state: usableCount > 0 ? 'ready' : candidatesForSlot(pool, slot).length > 0 ? 'needsBinding' : 'missing',
    }
  })
}

/** The three rules `resolveSlotCandidates` applies: enabled binding, verified capability, enabled connection. */
function isUsable(binding: Binding, slot: CapabilitySlot): boolean {
  if (binding.slot !== slot || !binding.enabled) return false
  const capability = binding.capability
  return !!capability?.entitlementVerifiedAt && !!capability.connection?.enabled
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
  return requiredSlots(readiness).filter(item => item.state === 'ready').length
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

export interface CatalogCoverage {
  provider: string
  label: string
  covered: CapabilitySlot[]
  missing: CapabilitySlot[]
}

/**
 * How far one provider's brochure gets you, measured with the same `canBind` rule
 * the binding endpoint enforces. The console quotes the best one so "how many
 * vendors do I have to buy" is answered from the catalog rather than from memory.
 */
function catalogCoverage(catalogs: Catalog[]): CatalogCoverage[] {
  const required = wiredRequiredSlots()
  return catalogs
    // Mock needs no key, so counting it would win every comparison and say nothing.
    .filter(catalog => catalog.provider !== 'mock')
    .map(catalog => {
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
      const covered = required.filter(slot => candidatesForSlot(pool, slot).length > 0)
      return { provider: catalog.provider, label: catalog.label, covered, missing: required.filter(slot => !covered.includes(slot)) }
    })
}

export function bestCatalogCoverage(catalogs: Catalog[]): CatalogCoverage | null {
  const ranked = catalogCoverage(catalogs).sort((left, right) => right.covered.length - left.covered.length)
  return ranked[0] ?? null
}
