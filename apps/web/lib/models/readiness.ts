/**
 * The readiness rules moved to @studio/domain so the API can run the exact same
 * sentences (`/api/system/readiness`, `/api/bindings/auto`) without a second
 * implementation. This module stays as the console's import path; the re-export is
 * explicit so nothing quietly starts reaching domain symbols through it.
 */
export {
  bindableCapabilities,
  candidatesForSlot,
  gapSlots,
  isHeldUp,
  minimumConnections,
  planAutoBind,
  readyCount,
  requiredSlotCoverage,
  slotReadiness,
  unwiredSlots,
  wiredRequiredSlots,
} from '@studio/domain'
export type {
  AutoBindChoice,
  AutoBindPlan,
  BindableCapability,
  CallEvidenceLike,
  CallEvidenceMapLike,
  CapabilityLike,
  CatalogLike,
  CatalogModelLike,
  ConnectionLike,
  BindingLike,
  MinimumConnectionsResult,
  SlotCallBlock,
  SlotCandidateProviders,
  SlotReadiness,
  SlotReadinessState,
  SlotUsage,
} from '@studio/domain'
