import { createHash } from 'node:crypto'
import { RELAYONE_REASONING_EFFORTS } from '../../shared/relayone-contracts.ts'
import type {
  RelayOneModelDto,
  RelayOneModelKind,
  RelayOneProtocol,
  RelayOneReasoningEffort,
} from '../../shared/relayone-contracts.ts'
import type { RelayOneSettings } from './token-store.ts'

export interface RelayOneModelEntry {
  id: string
  name: string
  kind: RelayOneModelKind
  groups: readonly string[]
  endpoints: readonly string[]
  protocol: RelayOneProtocol | null
  vendor: string | null
  description: string | null
  contextWindow: number
  maxOutputTokens: number
  reasoningEfforts: readonly RelayOneReasoningEffort[]
  supportsImages: boolean
  /** Model-specific media billing/input schema published by /api/pricing. */
  parameterSchema: Readonly<Record<string, unknown>> | null
}

interface UpstreamModel {
  id: string
  ownedBy: string | null
  endpoints: readonly string[]
}
interface PricingRecord {
  groups: readonly string[]
  endpoints: readonly string[]
  vendorId: number | null
  description: string | null
  tags: string
  parameterSchema: Readonly<Record<string, unknown>> | null
}
interface PricingCatalog {
  rows: ReadonlyMap<string, PricingRecord>
  vendors: ReadonlyMap<number, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() !== '' ? value.trim() : null
const strings = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim()))]
  : []
const finiteNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

/** Parse the OpenAI-shaped /v1/models envelope. Only these ids are callable by the key. */
export function parseRelayOneModelListing(payload: unknown): UpstreamModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return []
  const seen = new Set<string>()
  const result: UpstreamModel[] = []
  for (const raw of payload.data) {
    if (!isRecord(raw)) continue
    const id = text(raw.id) ?? text(raw.model_name)
    if (id === null || seen.has(id)) continue
    seen.add(id)
    result.push({ id, ownedBy: text(raw.owned_by) ?? text(raw.owner_by), endpoints: strings(raw.supported_endpoint_types) })
  }
  return result
}

export function parseRelayOnePricing(payload: unknown): PricingCatalog {
  const vendors = new Map<number, string>()
  const rows = new Map<string, PricingRecord>()
  if (!isRecord(payload)) return { rows, vendors }
  if (Array.isArray(payload.vendors)) {
    for (const raw of payload.vendors) {
      if (!isRecord(raw)) continue
      const id = finiteNumber(raw.id)
      const name = text(raw.name)
      if (id !== null && name !== null) vendors.set(id, name)
    }
  }
  if (Array.isArray(payload.data)) {
    for (const raw of payload.data) {
      if (!isRecord(raw)) continue
      const id = text(raw.model_name) ?? text(raw.id)
      if (id === null) continue
      rows.set(id, {
        groups: strings(raw.enable_groups).length > 0 ? strings(raw.enable_groups) : strings(raw.enable_group),
        endpoints: strings(raw.supported_endpoint_types),
        vendorId: finiteNumber(raw.vendor_id),
        description: text(raw.description),
        tags: typeof raw.tags === 'string' ? raw.tags : '',
        parameterSchema: isRecord(raw.billing_usage_schema) ? structuredClone(raw.billing_usage_schema) : null,
      })
    }
  }
  return { rows, vendors }
}

const DEFAULT_REASONING: readonly RelayOneReasoningEffort[] = ['low', 'medium', 'high']
const ADAPTIVE_REASONING: readonly RelayOneReasoningEffort[] = [...DEFAULT_REASONING, 'xhigh', 'max']
const DISABLEABLE_ADAPTIVE_REASONING: readonly RelayOneReasoningEffort[] = ['none', ...ADAPTIVE_REASONING]

interface AdaptiveThinkingPolicy {
  efforts: readonly RelayOneReasoningEffort[]
  enabledByDefault: boolean
  allowsTemperatureWhenOff: boolean
}

/**
 * Public Messages capabilities, not the Claude Code subscription's OAuth/betas.
 * https://platform.claude.com/docs/en/build-with-claude/thinking#when-thinking-turns-on
 * https://platform.claude.com/docs/en/build-with-claude/effort#effort-levels
 */
export function relayOneClaudeAdaptiveThinking(id: string): AdaptiveThinkingPolicy | undefined {
  // Match known models (including dated ids), not arbitrary gateway suffixes like -fast.
  const model = id.toLowerCase().replace(/-\d{8}$/, '')
  if (/^claude-(?:opus|sonnet)-4-6$/.test(model)) {
    return { efforts: [...DEFAULT_REASONING, 'max'], enabledByDefault: false, allowsTemperatureWhenOff: true }
  }
  if (/^claude-opus-4-[78]$/.test(model)) {
    return { efforts: ADAPTIVE_REASONING, enabledByDefault: false, allowsTemperatureWhenOff: false }
  }
  if (/^claude-(?:(?:opus|sonnet)-5|haiku-5-5)$/.test(model)) {
    return { efforts: DISABLEABLE_ADAPTIVE_REASONING, enabledByDefault: true, allowsTemperatureWhenOff: false }
  }
  if (/^claude-(?:(?:opus|sonnet)-5-5|(?:fable|mythos)-5(?:-[12])?)$/.test(model)) {
    return { efforts: ADAPTIVE_REASONING, enabledByDefault: true, allowsTemperatureWhenOff: false }
  }
  if (model === 'claude-mythos-preview') {
    return { efforts: [...DEFAULT_REASONING, 'max'], enabledByDefault: true, allowsTemperatureWhenOff: false }
  }
  return undefined
}

function modelFacts(id: string, protocol: RelayOneProtocol | null): Pick<RelayOneModelEntry, 'contextWindow' | 'maxOutputTokens' | 'supportsImages' | 'reasoningEfforts'> {
  const normalized = id.toLowerCase()
  // Conservative local budgets; users can override context windows in the line settings.
  if (/^(gpt-|o[134](?:-|$)|codex)/.test(normalized)) {
    return { contextWindow: 272_000, maxOutputTokens: 128_000, supportsImages: true, reasoningEfforts: RELAYONE_REASONING_EFFORTS }
  }
  if (normalized.startsWith('claude-')) {
    const adaptive = protocol === 'anthropic' ? relayOneClaudeAdaptiveThinking(normalized) : undefined
    return { contextWindow: 200_000, maxOutputTokens: 32_768, supportsImages: true, reasoningEfforts: adaptive?.efforts ?? DEFAULT_REASONING }
  }
  if (normalized.includes('gemini') || normalized.includes('banana')) {
    return { contextWindow: 1_000_000, maxOutputTokens: 32_768, supportsImages: true, reasoningEfforts: DEFAULT_REASONING }
  }
  if (normalized.includes('qwen') || normalized.includes('deepseek') || normalized.includes('kimi')) {
    return { contextWindow: 256_000, maxOutputTokens: 32_768, supportsImages: true, reasoningEfforts: DEFAULT_REASONING }
  }
  if (normalized.includes('glm') || normalized.includes('minimax') || normalized.includes('step')) {
    return { contextWindow: 200_000, maxOutputTokens: 16_384, supportsImages: false, reasoningEfforts: DEFAULT_REASONING }
  }
  return { contextWindow: 128_000, maxOutputTokens: 8_192, supportsImages: false, reasoningEfforts: [] }
}

function mediaKind(id: string, groups: readonly string[], endpoints: readonly string[], tags: string): RelayOneModelKind {
  const normalizedTags = tags.toLowerCase()
  const groupText = groups.join('\n')
  if (/(?:^|[,\s])model-type:video(?:$|[,\s])/i.test(normalizedTags) || /视频/.test(groupText)) return 'video'
  if (endpoints.includes('image-generation') || /(?:^|[,\s])model-type:image(?:$|[,\s])/i.test(normalizedTags)
    || /图片|生图/.test(groupText) || /^midjourney/i.test(id)) return 'image'
  return 'chat'
}

export function isRelayOneOpenAIModel(id: string, vendor: string | null): boolean {
  return vendor?.toLowerCase() === 'openai' || /^(?:gpt-|o[134](?:-|$)|codex)/i.test(id)
}

/** Host-side protocol policy; clients render the result instead of inferring from a name. */
export function selectRelayOneProtocol(
  id: string,
  vendor: string | null,
  endpoints: readonly string[],
  kind: RelayOneModelKind = 'chat',
): RelayOneProtocol | null {
  if (kind !== 'chat') return null
  if (endpoints.includes('openai-response') || endpoints.includes('openai-responses')) return 'openai-responses'
  if (endpoints.includes('anthropic')) return 'anthropic'
  if (isRelayOneOpenAIModel(id, vendor)) return 'openai-responses'
  if (endpoints.length === 0 || endpoints.includes('openai')) return 'openai-chat'
  return null
}

/** Merge live accessibility with public metadata. Public-only models are deliberately not added. */
export function mergeRelayOneCatalog(listingPayload: unknown, pricingPayload?: unknown): RelayOneModelEntry[] {
  const listing = parseRelayOneModelListing(listingPayload)
  const pricing = parseRelayOnePricing(pricingPayload)
  return listing.flatMap(model => {
    const row = pricing.rows.get(model.id)
    const endpoints = model.endpoints.length > 0 ? model.endpoints : row?.endpoints ?? []
    const groups = row?.groups ?? []
    const vendor = row?.vendorId !== null && row?.vendorId !== undefined
      ? pricing.vendors.get(row.vendorId) ?? null : null
    const kind = mediaKind(model.id, groups, endpoints, row?.tags ?? '')
    const protocol = selectRelayOneProtocol(model.id, vendor, endpoints, kind)
    if (kind === 'chat' && protocol === null) return []
    return [{
      id: model.id,
      name: model.id,
      kind,
      groups,
      endpoints,
      protocol,
      vendor,
      description: row?.description ?? null,
      parameterSchema: row?.parameterSchema ?? null,
      ...modelFacts(model.id, protocol),
    }]
  })
}

export function relayOneProtocolLabel(protocol: RelayOneProtocol | null): string {
  return protocol === 'openai-responses' ? 'Responses'
    : protocol === 'anthropic' ? 'Claude Messages'
      : protocol === 'openai-chat' ? 'Chat Completions' : 'Media'
}
export function describeRelayOneModel(entry: RelayOneModelEntry): string {
  return [entry.vendor, relayOneProtocolLabel(entry.protocol), ...entry.groups].filter(Boolean).join(' · ')
}

export function convergeRelayOneEnabledModelIds(
  catalog: readonly RelayOneModelEntry[],
  selected: readonly string[] | null,
): string[] | null {
  if (selected === null) return null
  const live = new Set(catalog.filter(entry => entry.kind === 'chat').map(entry => entry.id))
  const wanted = new Set(selected)
  return catalog.filter(entry => entry.kind === 'chat' && wanted.has(entry.id) && live.has(entry.id)).map(entry => entry.id)
}

export function relayOneModelOptions(
  catalog: readonly RelayOneModelEntry[],
  settings: RelayOneSettings,
): RelayOneModelDto[] {
  const selected = settings.enabledModelIds === null ? null : new Set(convergeRelayOneEnabledModelIds(catalog, settings.enabledModelIds))
  return catalog.map(entry => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    hint: describeRelayOneModel(entry),
    enabled: entry.kind === 'chat' && (selected === null || selected.has(entry.id)),
    groups: [...entry.groups],
    endpoints: [...entry.endpoints],
    protocol: entry.protocol,
    vendor: entry.vendor,
    description: entry.description,
    contextWindow: settings.contextWindowOverrides[entry.id] ?? entry.contextWindow,
    defaultContextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    reasoningEfforts: [...entry.reasoningEfforts],
    supportsImages: entry.supportsImages,
  }))
}

export function resolveRelayOneModel(
  catalog: readonly RelayOneModelEntry[],
  id: string,
): RelayOneModelEntry | undefined {
  const wanted = id.trim()
  return catalog.find(entry => entry.id === wanted)
}

export function relayOneCatalogGroups(catalog: readonly RelayOneModelEntry[]): string[] {
  return [...new Set(catalog.flatMap(entry => entry.groups))]
}

/** Stable content fingerprint; reference equality is not a change detector. */
export function relayOneCatalogFingerprint(catalog: readonly RelayOneModelEntry[]): string {
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex')
}

/** The production snapshot writer uses this exact record shape. */
export function persistedRelayOneModelRecord(entry: RelayOneModelEntry): Record<string, unknown> {
  return {
    id: entry.id, name: entry.name, kind: entry.kind, groups: [...entry.groups], endpoints: [...entry.endpoints],
    protocol: entry.protocol, vendor: entry.vendor, description: entry.description,
    contextWindow: entry.contextWindow, maxOutputTokens: entry.maxOutputTokens,
    reasoningEfforts: [...entry.reasoningEfforts], supportsImages: entry.supportsImages,
    parameterSchema: entry.parameterSchema,
  }
}

/** Parser paired with persistedRelayOneModelRecord; malformed snapshots are rejected as a whole. */
export function parsePersistedRelayOneModelEntries(value: unknown): RelayOneModelEntry[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const result: RelayOneModelEntry[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) return undefined
    const id = text(raw.id)
    const kind = raw.kind
    const protocol = raw.protocol
    if (id === null || seen.has(id) || !['chat', 'image', 'video'].includes(String(kind))) return undefined
    if (protocol !== null && !['openai-responses', 'openai-chat', 'anthropic'].includes(String(protocol))) return undefined
    const contextWindow = finiteNumber(raw.contextWindow)
    const maxOutputTokens = finiteNumber(raw.maxOutputTokens)
    if (contextWindow === null || contextWindow <= 0 || maxOutputTokens === null || maxOutputTokens <= 0) return undefined
    seen.add(id)
    const entry: RelayOneModelEntry = {
      id, name: text(raw.name) ?? id, kind: kind as RelayOneModelKind,
      groups: strings(raw.groups), endpoints: strings(raw.endpoints), protocol: protocol as RelayOneProtocol | null,
      vendor: text(raw.vendor), description: text(raw.description),
      // Local capability policy is recomputed on upgrades instead of freezing an old ladder.
      ...modelFacts(id, protocol as RelayOneProtocol | null),
      parameterSchema: isRecord(raw.parameterSchema) ? structuredClone(raw.parameterSchema) : null,
    }
    result.push(entry)
  }
  return result
}

export function isRelayOneProtocolUnsupported(status: number, detail: string): boolean {
  if (![400, 404, 405, 422].includes(status)) return false
  const normalized = detail.toLowerCase()
  if (/model_not_found|invalid token|insufficient|context|tool|argument|parameter/.test(normalized)
    && !/unsupported (?:api|endpoint|protocol)/.test(normalized)) return false
  return /unknown (?:endpoint|path)|unsupported (?:api|endpoint|protocol)|not support(?:ed|s)?(?: .*)?(?:responses|messages|chat completions)|no route|cannot be used with/.test(normalized)
}

export function fallbackRelayOneProtocol(entry: RelayOneModelEntry, current: RelayOneProtocol): RelayOneProtocol | null {
  if (current === 'openai-responses') {
    if (entry.endpoints.includes('anthropic')) return 'anthropic'
    if (entry.endpoints.includes('openai') || entry.endpoints.length === 0) return 'openai-chat'
  }
  if (current === 'anthropic' && entry.endpoints.includes('openai')) return 'openai-chat'
  return null
}
