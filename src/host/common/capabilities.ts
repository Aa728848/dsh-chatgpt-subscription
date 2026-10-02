/**
 * Explicit evidence registry and runtime capability gate.
 *
 * Preserves legacy exports and inventory TABLE while introducing a strict,
 * verified capability gate. evaluateCapability / requireCapability allow ONLY
 * verified offline-contract or live-validated matching evidence.
 * Requires non-empty provider, wire, model, authMode, and capability.
 * All unverified/unimplemented queries fail closed.
 *
 * @module dsh-chatgpt-subscription/capabilities
 */

/** Whether a documented provider feature is known to work on this route. */
export type CapabilityState = 'supported' | 'unsupported' | 'unknown'

/** Evidence validation tiers. */
export type EvidenceLevel =
  | 'live-validated'   // Verified against live production endpoint telemetry
  | 'offline-contract' // Verified by official offline contract, test fixtures, or client source
  | 'unverified'       // Candidate or speculative; fail closed

/** Supported capability features across all routes. */
export type Capability =
  | 'prompt-cache-read'
  | 'prompt-cache-write'
  | 'thinking-replay'
  | 'thinking-control'
  | 'server-side-compaction'
  | 'tool-search'
  | 'append-only-tools'
  | 'native-image'
  | 'native-video'
  | 'multi-agent-server'
  | 'websocket-transport'
  | 'zdr'

/** Concrete evidence record for a capability. */
export interface CapabilityEvidenceRecord {
  readonly id: string
  readonly provider: string
  readonly wire: string | readonly string[]
  readonly modelSelector: string | readonly string[] | ((modelId: string) => boolean)
  readonly authMode: string | readonly string[]
  readonly capability: Capability
  readonly status: CapabilityState
  readonly evidenceLevel: EvidenceLevel
  readonly implemented: boolean
  readonly date: string
  readonly link?: string
  readonly testPath?: string
  readonly versionTag?: string
  readonly notes?: string
}

/** Target query for capability evaluation. All fields are required. */
export interface CapabilityQuery {
  readonly provider: string
  readonly wire: string
  readonly model: string
  readonly authMode: string
  readonly capability: Capability
}

/** Evaluation outcome returned by evaluateCapability. */
export interface CapabilityEvaluation {
  readonly allowed: boolean
  readonly state: CapabilityState
  readonly implemented: boolean
  readonly evidenceLevel?: EvidenceLevel
  readonly evidence?: CapabilityEvidenceRecord
  readonly reason?: string
}

/** Error thrown by requireCapability when a capability contract fails. */
export class CapabilityError extends Error {
  readonly query: CapabilityQuery
  readonly evaluation: CapabilityEvaluation

  constructor(message: string, query: CapabilityQuery, evaluation: CapabilityEvaluation) {
    super(message)
    this.name = 'CapabilityError'
    this.query = query
    this.evaluation = evaluation
  }
}

// ---------------------------------------------------------------------------
// Ollama exact known model prefix definitions (accessible without cyclic import)
// ---------------------------------------------------------------------------

/** Known Ollama vision model prefixes per official model documentation. */
export const KNOWN_OLLAMA_VISION_PREFIXES = [
  'llava',
  'bakllava',
  'llama3.2-vision',
  'moondream',
  'minicpm-v',
  'qwen2.5-vl',
  'qwen2-vl',
] as const

/**
 * Matcher for Ollama vision models, aligned with src/host/ollama/types.ts.
 * Checks exact base name before ':' or '/' to prevent partial hijacking (e.g. 'llava-evil').
 */
export function isKnownOllamaVisionModel(modelId: string): boolean {
  const trimmed = modelId.toLowerCase().trim()
  const base = trimmed.split(':')[0]?.trim() ?? ''
  return (KNOWN_OLLAMA_VISION_PREFIXES as readonly string[]).includes(base)
}

/** Ollama thinking models with level control ('low'|'medium'|'high'). */
export const KNOWN_OLLAMA_THINKING_LEVELS_PREFIXES = ['gpt-oss'] as const

/** Ollama thinking models with boolean control (true|false). */
export const KNOWN_OLLAMA_THINKING_BOOLEAN_PREFIXES = ['deepseek-r1', 'qwq', 'qwen3'] as const

/** Matcher for Ollama thinking models, aligned with src/host/ollama/types.ts. */
export function isKnownOllamaThinkingModel(modelId: string): boolean {
  const trimmed = modelId.toLowerCase().trim()
  const base = trimmed.split(':')[0]?.trim() ?? ''
  return (
    (KNOWN_OLLAMA_THINKING_LEVELS_PREFIXES as readonly string[]).includes(base) ||
    (KNOWN_OLLAMA_THINKING_BOOLEAN_PREFIXES as readonly string[]).includes(base)
  )
}

// ---------------------------------------------------------------------------
// Verified Capability Evidence Registry (Immutable)
// ---------------------------------------------------------------------------

const VERIFIED_RECORDS: readonly CapabilityEvidenceRecord[] = [
  // 1. Ollama Native Image (strictly gated to exact known vision model prefixes)
  {
    id: 'ollama-native-image',
    provider: 'ollama',
    wire: ['openai', 'native'],
    modelSelector: isKnownOllamaVisionModel,
    authMode: 'api-key',
    capability: 'native-image',
    status: 'supported',
    evidenceLevel: 'offline-contract',
    implemented: true,
    date: '2026-10-03',
    testPath: 'test/ollama-projection.test.ts',
    versionTag: '0.2.0-rc.2',
    notes: 'Supported strictly for verified vision model prefixes (llava, bakllava, llama3.2-vision, moondream, minicpm-v, qwen2.5-vl, qwen2-vl). Exact boundary prevents llava-evil.',
  },
  // 2. Ollama Thinking Control (mapped think parameter for known thinking models)
  {
    id: 'ollama-thinking-control',
    provider: 'ollama',
    wire: ['openai', 'native'],
    modelSelector: isKnownOllamaThinkingModel,
    authMode: 'api-key',
    capability: 'thinking-control',
    status: 'supported',
    evidenceLevel: 'offline-contract',
    implemented: true,
    date: '2026-10-03',
    testPath: 'test/ollama-projection.test.ts',
    link: 'https://github.com/ollama/ollama/blob/main/docs/capabilities/thinking.mdx',
    versionTag: '0.2.0-rc.2',
    notes: 'Model-level think control for gpt-oss (levels) and deepseek-r1/qwq/qwen3 (boolean). Replay across turns remains unsupported.',
  },
  // 3. Command Code ZDR across all wires (protocol invariant, official contract)
  {
    id: 'command-code-zdr',
    provider: 'command-code',
    wire: ['responses', 'anthropic', 'openai', 'chat-completions', 'messages'],
    modelSelector: '*',
    authMode: ['api-key', 'token', 'oauth'],
    capability: 'zdr',
    status: 'supported',
    evidenceLevel: 'offline-contract',
    implemented: true,
    date: '2026-10-03',
    testPath: 'test/command-code-adapter.test.ts',
    link: 'https://github.com/CommandCodeAI/pi-commandcode-provider/blob/main/index.ts',
    versionTag: '0.2.0-rc.2',
    notes: 'Official contract: x-cmd-zdr: 1 header active across provider wires. 422 cmd_zdr_no_providers cannot silently degrade.',
  },
]

/** Immutable validated capability evidence registry. */
export const CAPABILITY_EVIDENCE_REGISTRY: readonly CapabilityEvidenceRecord[] = Object.freeze(
  VERIFIED_RECORDS.map(r => Object.freeze({
    ...r,
    wire: Array.isArray(r.wire) ? Object.freeze([...r.wire]) : r.wire,
    authMode: Array.isArray(r.authMode) ? Object.freeze([...r.authMode]) : r.authMode,
    modelSelector: Array.isArray(r.modelSelector) ? Object.freeze([...r.modelSelector]) : r.modelSelector,
  })),
)

// ---------------------------------------------------------------------------
// Match helpers & Registry queries
// ---------------------------------------------------------------------------

function matchesWire(expected: string | readonly string[], actual: string): boolean {
  const normActual = actual.toLowerCase().trim()
  if (typeof expected === 'string') {
    if (expected === '*') return true
    return expected.toLowerCase().trim() === normActual
  }
  return expected.some(w => w.toLowerCase().trim() === normActual)
}

function matchesAuth(expected: string | readonly string[], actual: string): boolean {
  const normActual = actual.toLowerCase().trim()
  if (typeof expected === 'string') {
    if (expected === '*') return true
    return expected.toLowerCase().trim() === normActual
  }
  return expected.some(a => a.toLowerCase().trim() === normActual)
}

function matchesModel(
  selector: string | readonly string[] | ((modelId: string) => boolean),
  model: string,
): boolean {
  const normModel = model.toLowerCase().trim()
  if (typeof selector === 'function') {
    return selector(model)
  }
  if (typeof selector === 'string') {
    if (selector === '*') return true
    const normSelector = selector.toLowerCase().trim()
    return (
      normModel === normSelector ||
      normModel.startsWith(normSelector + ':') ||
      normModel.startsWith(normSelector + '/')
    )
  }
  return selector.some(s => {
    const normS = s.toLowerCase().trim()
    return normModel === normS || normModel.startsWith(normS + ':') || normModel.startsWith(normS + '/')
  })
}

/** Query evidence records matching the given criteria. Supports optional pure registry argument for tests. */
export function queryCapabilityEvidence(
  query: Partial<CapabilityQuery>,
  registry: readonly CapabilityEvidenceRecord[] = CAPABILITY_EVIDENCE_REGISTRY,
): readonly CapabilityEvidenceRecord[] {
  return registry.filter(rec => {
    if (query.provider && rec.provider.toLowerCase() !== query.provider.toLowerCase().trim()) return false
    if (query.capability && rec.capability !== query.capability) return false
    if (query.wire && !matchesWire(rec.wire, query.wire)) return false
    if (query.authMode && !matchesAuth(rec.authMode, query.authMode)) return false
    if (query.model && !matchesModel(rec.modelSelector, query.model)) return false
    return true
  })
}

// ---------------------------------------------------------------------------
// Primary Capability Gating API
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a capability is permitted for a concrete request target.
 * Fails closed if query is missing explicit fields, or lacks matching verified evidence.
 */
export function evaluateCapability(
  query: CapabilityQuery,
  registry: readonly CapabilityEvidenceRecord[] = CAPABILITY_EVIDENCE_REGISTRY,
): CapabilityEvaluation {
  if (
    !query ||
    typeof query.provider !== 'string' || !query.provider.trim() ||
    typeof query.wire !== 'string' || !query.wire.trim() ||
    typeof query.model !== 'string' || !query.model.trim() ||
    typeof query.authMode !== 'string' || !query.authMode.trim() ||
    typeof query.capability !== 'string' || !query.capability.trim()
  ) {
    return {
      allowed: false,
      state: 'unknown',
      implemented: false,
      reason: 'Capability query requires non-empty provider, wire, model, authMode, and capability',
    }
  }

  const matching = queryCapabilityEvidence(query, registry)
  if (matching.length === 0) {
    return {
      allowed: false,
      state: 'unknown',
      implemented: false,
      reason: `No matching verified evidence for ${query.provider}/${query.wire}/${query.model} (auth: ${query.authMode}, capability: ${query.capability}).`,
    }
  }

  const record = matching[0]
  const isSupportedLevel = record.evidenceLevel === 'live-validated' || record.evidenceLevel === 'offline-contract'
  const isAllowed = record.implemented && record.status === 'supported' && isSupportedLevel

  return {
    allowed: isAllowed,
    state: record.status,
    implemented: record.implemented,
    evidenceLevel: record.evidenceLevel,
    evidence: record,
    reason: isAllowed ? undefined : (record.notes ?? `Capability '${query.capability}' is not permitted.`),
  }
}

/**
 * Require that a capability is supported and allowed. Throws CapabilityError otherwise.
 */
export function requireCapability(
  query: CapabilityQuery,
  registry: readonly CapabilityEvidenceRecord[] = CAPABILITY_EVIDENCE_REGISTRY,
): CapabilityEvaluation {
  const result = evaluateCapability(query, registry)
  if (!result.allowed) {
    throw new CapabilityError(
      `Capability requirement rejected: '${query.capability}' on ${query.provider} (${query.wire}/${query.model}, auth: ${query.authMode}): ${result.reason ?? 'not permitted'}`,
      query,
      result,
    )
  }
  return result
}

// ---------------------------------------------------------------------------
// Convenience Production Paths
// ---------------------------------------------------------------------------

/** Whether Zero Data Retention (ZDR) is supported for this provider, wire, model, and auth mode. */
export function supportsZdr(
  provider: string,
  wire: string,
  model = '*',
  authMode: string = provider === 'command-code' ? 'api-key' : 'oauth',
): boolean {
  return evaluateCapability({ provider, wire, model, authMode, capability: 'zdr' }).allowed
}

/** Whether Ollama image input is supported for the target model. */
export function supportsOllamaImage(model: string, wire = 'openai', authMode = 'api-key'): boolean {
  return evaluateCapability({ provider: 'ollama', wire, model, authMode, capability: 'native-image' }).allowed
}

/** Whether Ollama thinking control is supported for the target model. */
export function supportsOllamaThinkingControl(model: string, wire = 'openai', authMode = 'api-key'): boolean {
  return evaluateCapability({ provider: 'ollama', wire, model, authMode, capability: 'thinking-control' }).allowed
}

// ---------------------------------------------------------------------------
// Legacy Compatibility Table & Functions (Preserved)
// ---------------------------------------------------------------------------

const TABLE: Readonly<Record<string, Readonly<Partial<Record<Capability, CapabilityState>>>>> = {
  'codex-chatgpt': { 'prompt-cache-read': 'supported', 'prompt-cache-write': 'supported', 'thinking-replay': 'supported', 'server-side-compaction': 'unknown', 'tool-search': 'unknown', 'append-only-tools': 'unknown', 'native-image': 'supported', 'native-video': 'unsupported', 'multi-agent-server': 'unknown', 'websocket-transport': 'unsupported', zdr: 'unknown' },
  claude: { 'prompt-cache-read': 'supported', 'prompt-cache-write': 'supported', 'thinking-replay': 'supported', 'server-side-compaction': 'unknown', 'tool-search': 'unknown', 'append-only-tools': 'unsupported', 'native-image': 'supported', 'native-video': 'unsupported', 'multi-agent-server': 'unsupported', 'websocket-transport': 'unsupported', zdr: 'unsupported' },
  antigravity: { 'prompt-cache-read': 'supported', 'prompt-cache-write': 'unsupported', 'thinking-replay': 'supported', 'server-side-compaction': 'unsupported', 'tool-search': 'unsupported', 'append-only-tools': 'unsupported', 'native-image': 'supported', 'native-video': 'unsupported', 'multi-agent-server': 'unsupported', 'websocket-transport': 'unsupported', zdr: 'unsupported' },
  'kimi-code': { 'prompt-cache-read': 'supported', 'prompt-cache-write': 'supported', 'thinking-replay': 'supported', 'server-side-compaction': 'unknown', 'tool-search': 'unsupported', 'append-only-tools': 'supported', 'native-image': 'supported', 'native-video': 'supported', 'multi-agent-server': 'unsupported', 'websocket-transport': 'unsupported', zdr: 'unsupported' },
  'minimax-code': { 'prompt-cache-read': 'supported', 'prompt-cache-write': 'supported', 'thinking-replay': 'unknown', 'server-side-compaction': 'unknown', 'tool-search': 'unsupported', 'append-only-tools': 'unsupported', 'native-image': 'supported', 'native-video': 'unsupported', 'multi-agent-server': 'unsupported', 'websocket-transport': 'unsupported', zdr: 'unsupported' },
  'command-code': { 'prompt-cache-read': 'supported', 'prompt-cache-write': 'unknown', 'thinking-replay': 'unknown', 'server-side-compaction': 'unsupported', 'tool-search': 'unsupported', 'append-only-tools': 'unsupported', 'native-image': 'supported', 'native-video': 'unsupported', 'multi-agent-server': 'unsupported', 'websocket-transport': 'unsupported', zdr: 'supported' },
  workbuddy: { 'prompt-cache-read': 'supported', 'prompt-cache-write': 'unsupported', 'thinking-replay': 'unsupported', 'server-side-compaction': 'unsupported', 'tool-search': 'unsupported', 'append-only-tools': 'unsupported', 'native-image': 'supported', 'native-video': 'unsupported', 'multi-agent-server': 'unsupported', 'websocket-transport': 'unsupported', zdr: 'unsupported' },
  ollama: { 'prompt-cache-read': 'unsupported', 'prompt-cache-write': 'unsupported', 'thinking-replay': 'unsupported', 'server-side-compaction': 'unsupported', 'tool-search': 'unsupported', 'append-only-tools': 'unsupported', 'native-image': 'supported', 'native-video': 'unsupported', 'multi-agent-server': 'unsupported', 'websocket-transport': 'unsupported', zdr: 'unsupported' },
}

/** State of one capability on one route in legacy inventory. */
export function capabilityOf(provider: string, capability: Capability): CapabilityState {
  return TABLE[provider]?.[capability] ?? 'unknown'
}

/**
 * Legacy inventory helper, not permission to send a model-specific parameter.
 * Production builders must use evaluateCapability / requireCapability.
 * @deprecated Use evaluateCapability or requireCapability for runtime capability gating.
 */
export function maySend(provider: string, capability: Capability): boolean {
  return capabilityOf(provider, capability) === 'supported'
}

/** The whole matrix, for diagnostics and tests. */
export function capabilityTable(): Readonly<Record<string, Readonly<Partial<Record<Capability, CapabilityState>>>>> {
  return TABLE
}
