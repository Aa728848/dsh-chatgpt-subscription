/**
 * Where an automatic compaction summarizes, and what disqualifies a target.
 *
 * A host routes a compaction summary through the same model that built the
 * conversation unless the compaction config names another route. That config
 * belongs to the preset, which a line's plugin cannot own per deployment, so
 * this plugin re-routes the call at the `llm/stream` seam instead. Everything
 * in this module is pure, so the decision is testable without a request.
 *
 * The split between hard and soft refusal follows what the harness itself does:
 * a model that cannot take images has them projected to text placeholders
 * before dispatch, so the summary still completes (degraded, not broken),
 * while a video block has no projection at all and would fail the request.
 *
 * @module dsh-chatgpt-subscription/compaction-route
 */

/** One exact provider/model route a compaction summary may be sent to. */
export interface CompactionRouteTarget {
  readonly provider: string
  readonly model: string
}

/** Runtime membership test for one stored target. */
export function isCompactionRouteTarget(value: unknown): value is CompactionRouteTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return isNonEmptyString(record.provider) && isNonEmptyString(record.model)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** The content a payload actually carries; that is what a target must accept. */
export interface CompactionPayloadNeeds {
  readonly image: boolean
  readonly video: boolean
}

/** What the provider directory discloses about the chosen target. */
export interface CompactionTargetFacts {
  /** Accepted input types, or `undefined` when the route discloses none. */
  readonly modalities?: readonly string[] | undefined
}

/**
 * Reasons a target is refused outright — the payload carries something that has
 * no fallback representation on the wire.
 */
export type CompactionSkipReason = 'target-accepts-no-video'

/**
 * Decide whether the payload is admissible on the target.
 *
 * An undisclosed modality list is unknown, not negative: the harness documents
 * absence as "not disclosed", so refusing on it would disable the feature on
 * every route that simply does not advertise. The request still runs, and a
 * real rejection falls back the same way an error does.
 *
 * @param facts - what the directory says about the target.
 * @param needs - what the payload contains.
 * @returns the refusal reason, or `undefined` when the target may take it.
 */
export function compactionSkipReason(
  facts: CompactionTargetFacts,
  needs: CompactionPayloadNeeds,
): CompactionSkipReason | undefined {
  const modalities = facts.modalities
  if (modalities === undefined) return undefined
  const accepts = new Set(modalities)
  if (needs.video && !accepts.has('video')) return 'target-accepts-no-video'
  return undefined
}

/**
 * Whether the target can carry images inline.
 *
 * Used for the recorded outcome only: an image the target cannot take is
 * replaced by a placeholder during projection, so the summary is still produced
 * but may describe a screenshot it never saw.
 *
 * @param facts - what the directory says about the target.
 * @returns false only when the target discloses image support and omits it.
 */
export function compactionRoutesImages(facts: CompactionTargetFacts): boolean {
  const modalities = facts.modalities
  if (modalities === undefined) return true
  return modalities.includes('image')
}
