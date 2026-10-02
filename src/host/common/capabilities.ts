/**
 * Per-route capability matrix.
 *
 * Every provider here fronts a third-party model behind somebody else's gateway,
 * so what the public API documents and what this route can actually do are
 * different questions. A model having a feature upstream says nothing about
 * whether the subscription endpoint in front of it accepts the field.
 *
 * This table records the difference instead of resolving it by assumption. An
 * entry is one of:
 *
 * - `supported`: exercised against this route, or plainly required by a wire
 *   contract the route already depends on.
 * - `unsupported`: confirmed rejected or ignored by this route.
 * - `unknown`: plausible and unverified. Never a licence to send the field.
 *
 * A `default: false` here means the request builder does not send the field,
 * so an unknown entry costs nothing at runtime and only limits what may be
 * turned on later, with evidence.
 *
 * @module dsh-chatgpt-subscription/capabilities
 */

/** Whether a documented provider feature is known to work on this route. */
export type CapabilityState = 'supported' | 'unsupported' | 'unknown'

/** The features that differ meaningfully between these routes. */
export type Capability =
  | 'prompt-cache-read'
  | 'prompt-cache-write'
  | 'thinking-replay'
  | 'server-side-compaction'
  | 'tool-search'
  | 'append-only-tools'
  | 'native-image'
  | 'native-video'
  | 'multi-agent-server'
  | 'websocket-transport'

const TABLE: Readonly<Record<string, Readonly<Partial<Record<Capability, CapabilityState>>>>> = {
  'codex-chatgpt': {
    'prompt-cache-read': 'supported',
    'prompt-cache-write': 'supported',
    'thinking-replay': 'supported',
    // The Responses API exposes these, but this route fronts the subscription
    // endpoint, which has not been shown to accept them. They stay off.
    'server-side-compaction': 'unknown',
    'tool-search': 'unknown',
    'append-only-tools': 'unknown',
    'native-image': 'supported',
    'native-video': 'unsupported',
    'multi-agent-server': 'unknown',
    // Implemented as an opt-in transport, defaulting to the SSE path.
    'websocket-transport': 'supported',
  },
  claude: {
    'prompt-cache-read': 'supported',
    'prompt-cache-write': 'supported',
    'thinking-replay': 'supported',
    // Implemented here, but only on the direct API surface: the OAuth gateway
    // has not been shown to pass it through, so it is not enabled.
    'server-side-compaction': 'unknown',
    'tool-search': 'unknown',
    'append-only-tools': 'unsupported',
    'native-image': 'supported',
    'native-video': 'unsupported',
    'multi-agent-server': 'unsupported',
    'websocket-transport': 'unsupported',
  },
  antigravity: {
    'prompt-cache-read': 'supported',
    // Cloud Code serves an automatic cache with no write field on the wire.
    'prompt-cache-write': 'unsupported',
    'thinking-replay': 'supported',
    'server-side-compaction': 'unsupported',
    'tool-search': 'unsupported',
    'append-only-tools': 'unsupported',
    'native-image': 'supported',
    'native-video': 'unsupported',
    'multi-agent-server': 'unsupported',
    'websocket-transport': 'unsupported',
  },
  'kimi-code': {
    'prompt-cache-read': 'supported',
    'prompt-cache-write': 'supported',
    'thinking-replay': 'supported',
    'server-side-compaction': 'unknown',
    'tool-search': 'unsupported',
    'append-only-tools': 'supported',
    'native-image': 'supported',
    'native-video': 'supported',
    'multi-agent-server': 'unsupported',
    'websocket-transport': 'unsupported',
  },
  'minimax-code': {
    'prompt-cache-read': 'supported',
    'prompt-cache-write': 'supported',
    // Replayed verbatim from the service's own block; the gateway contract for
    // anything else is unverified.
    'thinking-replay': 'supported',
    'server-side-compaction': 'unknown',
    'tool-search': 'unsupported',
    'append-only-tools': 'unsupported',
    'native-image': 'supported',
    'native-video': 'unsupported',
    'multi-agent-server': 'unsupported',
    'websocket-transport': 'unsupported',
  },
  'command-code': {
    'prompt-cache-read': 'supported',
    'prompt-cache-write': 'unknown',
    'thinking-replay': 'supported',
    'server-side-compaction': 'unsupported',
    'tool-search': 'unsupported',
    'append-only-tools': 'unsupported',
    'native-image': 'supported',
    'native-video': 'unsupported',
    'multi-agent-server': 'unsupported',
    'websocket-transport': 'unsupported',
  },
  workbuddy: {
    'prompt-cache-read': 'supported',
    'prompt-cache-write': 'unsupported',
    'thinking-replay': 'unsupported',
    'server-side-compaction': 'unsupported',
    'tool-search': 'unsupported',
    'append-only-tools': 'unsupported',
    'native-image': 'supported',
    'native-video': 'unsupported',
    'multi-agent-server': 'unsupported',
    'websocket-transport': 'unsupported',
  },
  ollama: {
    'prompt-cache-read': 'unsupported',
    'prompt-cache-write': 'unsupported',
    'thinking-replay': 'supported',
    'server-side-compaction': 'unsupported',
    'tool-search': 'unsupported',
    'append-only-tools': 'unsupported',
    'native-image': 'supported',
    'native-video': 'unsupported',
    'multi-agent-server': 'unsupported',
    'websocket-transport': 'unsupported',
  },
}

/**
 * State of one capability on one route.
 *
 * A route with no entry at all is treated as `unknown` rather than
 * `unsupported`: an unrecorded feature is unproven, not proven absent.
 */
export function capabilityOf(provider: string, capability: Capability): CapabilityState {
  return TABLE[provider]?.[capability] ?? 'unknown'
}

/**
 * Whether a request builder may send this feature.
 *
 * The single gate every route should consult before adding a field, so an
 * `unknown` entry can never leak onto the wire by accident.
 */
export function maySend(provider: string, capability: Capability): boolean {
  return capabilityOf(provider, capability) === 'supported'
}

/** The whole matrix, for diagnostics and tests. */
export function capabilityTable(): Readonly<Record<string, Readonly<Partial<Record<Capability, CapabilityState>>>>> {
  return TABLE
}