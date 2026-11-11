/**
 * Cline Pass wire protocol: response routing observation and error parsing.
 * Client-side upstream selection is deliberately not part of this module; Cline
 * owns routing and every request uses its automatic route.
 *
 * @module dsh-chatgpt-subscription/cline-pass-protocol
 */
import { isClinePassAnonymousUpstream } from '../../shared/cline-pass-contracts.ts'

/** Which pipeline the gateway routed one response through. */
export type ClinePipeline = 'direct' | 'planner'

/** What one response says about how the gateway routed it. */
export interface RoutingFacts {
  content: string | null
  toolCalls: unknown[]
  usage: unknown
  pipeline: ClinePipeline | null
  canonicalSlug: string | null
  finalProvider: string | null
  finalProviderName: string | null
  fallbacks: string[]
  plan: string
  /**
   * First-party DeepSeek fingerprint, when the answer carries one.
   *
   * `provider_metadata.deepseek.systemFingerprint` is the only field that
   * proves the answer came from first-party DeepSeek; the top-level
   * `system_fingerprint` is minted by the gateway per request and says
   * nothing about the upstream.
   */
  fingerprint: string | null
  /** Whether the serving channel is the gateway's anonymous contributor route. */
  anonymous: boolean
}

/**
 * The gateway wraps some answers in a `{ data: … }` envelope; unwrap it.
 * @param json - raw decoded response body.
 * @returns the OpenAI-shaped payload.
 */
export function unwrapEnvelope(json: unknown): Record<string, unknown> {
  if (isRecord(json) && isRecord(json.data) && json.data.choices !== undefined) {
    return json.data
  }
  return isRecord(json) ? json : {}
}

/** Turn any error-shaped value into display text. */
export function errorText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value.message === 'string') return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Account authentication refusals, including responses with no useful body. */
export function isAuthenticationError(message: unknown, status?: number): boolean {
  const detail = String(message ?? '').replace(/[_-]/g, ' ')
  return status === 401 || status === 403 || /unauthorized|re\s*authenticate|invalid\s*(?:api\s*key|token)|\b401\b|\b403\b/i.test(detail)
}

/**
 * Read the routing facts out of one completed gateway response.
 * @param json - raw decoded response body (enveloped or not).
 * @returns pipeline, canonical slug, chosen upstream and fallback list.
 */
export function parseRouting(json: unknown): RoutingFacts {
  const payload = unwrapEnvelope(json)
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const first = isRecord(choices[0]) ? choices[0] : {}
  const message = isRecord(first.message) ? first.message : {}
  // A non-streaming answer carries the routing block on `message`; a streaming
  // frame carries it on `delta` (the gateway appends it to a terminal frame,
  // after the content). Reading only `message` leaves every streamed request
  // with no serving-channel reading at all.
  const delta = isRecord(first.delta) ? first.delta : {}
  const metadata = [message, delta, payload].map(providerMetadataOf).find((entry) => entry !== null) ?? {}
  const gateway = isRecord(metadata.gateway) ? metadata.gateway : {}
  const direct = typeof payload.provider === 'string' ? payload.provider : null
  let routing: Record<string, unknown> = isRecord(gateway.routing) ? gateway.routing : {}
  if (typeof routing.finalProvider !== 'string') {
    // The gateway has moved this block between nestings before; hunt for it
    // rather than grow one case per observed shape. Wire JSON is acyclic, so
    // the depth cap is the only guard the walk needs.
    routing = huntRouting(payload) ?? routing
  }
  const finalProvider = typeof routing.finalProvider === 'string'
    ? routing.finalProvider
    : (direct === null ? null : slugify(direct))
  const canonicalSlug = typeof routing.canonicalSlug === 'string'
    ? routing.canonicalSlug
    : (typeof payload.model === 'string' && payload.model.includes('/') ? payload.model : null)
  return {
    content: typeof message.content === 'string' ? message.content : (typeof delta.content === 'string' ? delta.content : null),
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : (Array.isArray(delta.tool_calls) ? delta.tool_calls : []),
    usage: payload.usage ?? null,
    pipeline: typeof routing.finalProvider === 'string' ? 'planner' : (direct === null ? null : 'direct'),
    canonicalSlug,
    finalProvider,
    finalProviderName: typeof routing.finalProvider === 'string' ? routing.finalProvider : direct,
    fallbacks: Array.isArray(routing.fallbacksAvailable) ? routing.fallbacksAvailable.map(String) : [],
    plan: typeof routing.planningReasoning === 'string' ? routing.planningReasoning : '',
    fingerprint: huntFingerprint(payload),
    anonymous: isClinePassAnonymousUpstream(finalProvider ?? '', canonicalSlug ?? ''),
  }
}

/** Nodes one payload walk may visit before giving up. */
const HUNT_NODE_BUDGET = 4_000

/** `provider_metadata` of one node, when present. */
function providerMetadataOf(node: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(node.provider_metadata) ? node.provider_metadata : null
}

/** Depth-bounded hunt for the gateway's routing block anywhere in one payload. */
function huntRouting(node: unknown, depth = 0, budget: { left: number } = { left: HUNT_NODE_BUDGET }): Record<string, unknown> | null {
  if (depth > 8 || budget.left <= 0 || node === null || typeof node !== 'object') return null
  budget.left -= 1
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = huntRouting(entry, depth + 1, budget)
      if (found !== null) return found
    }
    return null
  }
  const record = node as Record<string, unknown>
  const gateway = isRecord(record.gateway) ? record.gateway : null
  const routing = gateway !== null && isRecord(gateway.routing)
    ? gateway.routing
    : (isRecord(record.routing) ? record.routing : null)
  if (routing !== null && typeof routing.finalProvider === 'string') return routing
  for (const value of Object.values(record)) {
    const found = huntRouting(value, depth + 1, budget)
    if (found !== null) return found
  }
  return null
}

/** Read the first-party DeepSeek fingerprint wherever `provider_metadata` carries it. */
function huntFingerprint(node: unknown, depth = 0, budget: { left: number } = { left: HUNT_NODE_BUDGET }): string | null {
  if (depth > 8 || budget.left <= 0 || node === null || typeof node !== 'object') return null
  budget.left -= 1
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = huntFingerprint(entry, depth + 1, budget)
      if (found !== null) return found
    }
    return null
  }
  const record = node as Record<string, unknown>
  const metadata = providerMetadataOf(record)
  if (metadata !== null) {
    const deepseek = isRecord(metadata.deepseek) ? metadata.deepseek : null
    if (deepseek !== null && typeof deepseek.systemFingerprint === 'string' && deepseek.systemFingerprint !== '') {
      return deepseek.systemFingerprint
    }
  }
  for (const value of Object.values(record)) {
    const found = huntFingerprint(value, depth + 1, budget)
    if (found !== null) return found
  }
  return null
}

/** Lowercase a display name into an upstream slug. */
function slugify(value: unknown): string {
  return String(value).toLowerCase().replace(/\s+/g, '-')
}

/** Whether a value is a non-null object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
