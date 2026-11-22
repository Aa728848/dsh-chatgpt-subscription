/**
 * Wire contract of the one-shot "compact when this turn ends" switch.
 *
 * The browser half is a row in the composer's model menu; the Host half watches
 * the session's agent and runs one manual compaction once the turn that was
 * running (or the next one) ends. The two halves only share this file.
 *
 * @module dsh-chatgpt-subscription/shared/compact-after-turn
 */

/** Route of the state read (GET `?session=<id>`) and the switch write (POST). */
export const COMPACT_AFTER_TURN_PATH = '/api/dsh-compact-after-turn/state'

/**
 * Where one session stands.
 *
 * - `off`: nothing will happen when the turn ends.
 * - `armed`: the next turn end that leaves the agent idle compacts once, then
 *   the switch turns itself off.
 * - `compacting`: that compaction is running; the switch cannot be changed.
 */
export type CompactAfterTurnPhase = 'off' | 'armed' | 'compacting'

/** How the last one-shot compaction of a session ended. */
export interface CompactAfterTurnOutcomeDto {
  /** `nothing`: the engine found no safe range worth compacting. */
  readonly kind: 'compacted' | 'nothing' | 'failed'
  /** Engine diagnostic of a failed attempt; never shown as the headline. */
  readonly detail?: string
  /** Epoch milliseconds the attempt settled. */
  readonly at: number
}

/** The state the Host reports for one session. */
export interface CompactAfterTurnStateDto {
  readonly sessionId: string
  readonly phase: CompactAfterTurnPhase
  /** Whether this Host has a compaction engine at all. */
  readonly available: boolean
  readonly last: CompactAfterTurnOutcomeDto | null
}

/** Body of the switch write. */
export interface CompactAfterTurnUpdateDto {
  readonly sessionId: string
  readonly armed: boolean
}

/** Machine-readable refusal codes; the browser localizes them. */
export type CompactAfterTurnErrorCode = 'busy' | 'unavailable' | 'bad-request' | 'forbidden'
