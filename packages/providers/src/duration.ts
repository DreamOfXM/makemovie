import { DURATION_KEY } from '@studio/domain'

/**
 * The one file in this repository allowed to know a vendor's name for "how long this clip
 * is". The canonical field, the model's declaration shapes, and the pinning rule live in
 * `@studio/domain`; this table holds only the dialect, because that is the part that
 * changes with the connection an operator buys rather than with the product.
 *
 * The split is deliberately asymmetric: the *name and type* travel through this table, the
 * *placement* stays with each adapter, because placement is not a dialect quirk but the
 * body itself — Ark wants the value beside `model`, Kling inside its own typed body,
 * DashScope nested under `parameters`, Sora in a multipart form field. A shared table for
 * that would need a second discriminator nobody else uses.
 */

interface DurationSlot {
  /** The vendor's own key, spelled as its API reference spells it. */
  field: string
  /**
   * The type the vendor validates. Kling and Sora reject a JSON number where they expect a
   * string, so this is not a rendering preference — it is the difference between a billed
   * clip and a 400.
   */
  as: 'number' | 'string'
}

/**
 * Keyed by `ProviderConnection.provider`, the same string `createAdapter` switches on.
 * A provider missing from this table is refused by name below rather than quietly dropped,
 * because "asked for 15 seconds, got the vendor's default" is the exact defect this file
 * exists to remove.
 */
const SLOTS: Record<string, DurationSlot> = {
  // Volcano Ark: a top-level number. Doubao and the OpenAI-style relays that mount Ark's
  // task routes both speak this dialect, since both are driven by this one adapter.
  seedance: { field: 'duration', as: 'number' },
  // Kling: a top-level *string*. The vendor's own examples quote it.
  kling: { field: 'duration', as: 'string' },
  // DashScope: inside `parameters`. The key name is NOT verified against a live account —
  // see docs/2026-10-19-duration-adaptation-list.md. This adapter spreads the caller's map
  // straight through, so an unmapped canonical key would have reached the vendor as-is.
  dashscope: { field: 'duration', as: 'number' },
  // Gemini/Veo: inside the predict parameters, and already named `durationSeconds`, which
  // is why that string is the canonical one.
  google: { field: 'durationSeconds', as: 'number' },
  // Sora: a form field named `seconds`, quoted.
  openai: { field: 'seconds', as: 'string' },
}

/** Which vendors this table has a mapping for. Read by the anti-drift test. */
export const mappedDurationProviders = Object.keys(SLOTS)

/**
 * The mapped pair to spread into a vendor body: `{}` when the caller asked for no length,
 * so the field is absent rather than sent as a zero or an empty string.
 *
 * Whole positive seconds are enforced here rather than upstream, because this is the
 * boundary the vendor's validator sits behind: a `duration: 7.5` or `duration: NaN` in a
 * rebuilt snapshot would otherwise be paid for before anyone noticed.
 */
export function vendorDurationField(provider: string, parameters: Record<string, unknown>): Record<string, unknown> {
  const requested = parameters[DURATION_KEY]
  if (requested === undefined || requested === null) return {}
  const slot = SLOTS[provider]
  if (!slot) {
    throw new Error(`provider "${provider}" has no duration mapping in packages/providers/src/duration.ts, and a requested clip length must not be dropped`)
  }
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested <= 0) {
    throw new Error(`"${DURATION_KEY}" must be a whole number of positive seconds, got ${JSON.stringify(requested)} for provider "${provider}"`)
  }
  return { [slot.field]: slot.as === 'number' ? requested : String(requested) }
}
