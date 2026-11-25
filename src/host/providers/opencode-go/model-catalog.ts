import { catalogSnapshotName, catalogSnapshotPath, rehydrateCatalogCache, writeCatalogSnapshot } from '../../common/catalog-snapshot.ts'
import { LlmError } from '../../common/llm-compat.ts'
import { OPENCODE_GO_REASONING_EFFORTS, type OpenCodeGoModelOption, type OpenCodeGoReasoningEffort } from '../../../shared/opencode-go-contracts.ts'
import type { OpenCodeGoSettings } from './token-store.ts'
import { fetchOpenCodeGoModels } from './client.ts'
import type { OpenCodeGoCredentials } from './types.ts'

export interface OpenCodeGoModelEntry {
  id: string
  name: string
  description: string | null
  canonicalId: string | null
  contextWindow: number
  maxOutputTokens: number
  reasoningEfforts: readonly OpenCodeGoReasoningEffort[]
  supportsTools: boolean
  supportsImages: boolean
  training: boolean | null
  zdr: boolean | null
  limitedRegions: boolean | null
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function positiveInt(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback }
function optionalBool(value: unknown): boolean | null { return typeof value === 'boolean' ? value : null }

export function parseOpenCodeGoModelEntries(value: unknown): OpenCodeGoModelEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: OpenCodeGoModelEntry[] = []
  for (const raw of value) {
    if (!isRecord(raw) || raw.type !== 'chat' || typeof raw.id !== 'string' || raw.id === '') continue
    const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {}
    const limit = isRecord(raw.limit) ? raw.limit : {}
    const contextWindow = positiveInt(limit.context, 128_000)
    const reasoning = isRecord(capabilities.reasoning) ? capabilities.reasoning : {}
    const efforts = Array.isArray(reasoning.effort) ? reasoning.effort.filter((effort): effort is OpenCodeGoReasoningEffort => (OPENCODE_GO_REASONING_EFFORTS as readonly string[]).includes(String(effort))) : []
    const modalities = isRecord(raw.modalities) && Array.isArray(raw.modalities.input) ? raw.modalities.input : []
    const go = isRecord(raw.go) ? raw.go : {}
    entries.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.id,
      description: typeof raw.description === 'string' && raw.description !== '' ? raw.description : null,
      canonicalId: typeof raw.canonical_id === 'string' ? raw.canonical_id : null,
      contextWindow,
      maxOutputTokens: positiveInt(limit.output, contextWindow),
      reasoningEfforts: [...new Set(efforts)],
      supportsTools: !isRecord(capabilities.tools) || capabilities.tools.supported !== false,
      supportsImages: modalities.some(item => typeof item === 'string' && item.startsWith('image/')),
      training: optionalBool(go.training),
      zdr: optionalBool(go.zdr),
      limitedRegions: optionalBool(go.limited_regions),
    })
  }
  return entries
}

export function persistedOpenCodeGoModelEntries(entries: readonly OpenCodeGoModelEntry[]): OpenCodeGoModelEntry[] { return entries.map(entry => ({ ...entry, reasoningEfforts: [...entry.reasoningEfforts] })) }
export function parsePersistedOpenCodeGoModelEntries(value: unknown): OpenCodeGoModelEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: OpenCodeGoModelEntry[] = []
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '') continue
    const contextWindow = positiveInt(raw.contextWindow, 128_000)
    entries.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.id,
      description: typeof raw.description === 'string' && raw.description !== '' ? raw.description : null,
      canonicalId: typeof raw.canonicalId === 'string' ? raw.canonicalId : null,
      contextWindow,
      maxOutputTokens: positiveInt(raw.maxOutputTokens, contextWindow),
      reasoningEfforts: Array.isArray(raw.reasoningEfforts) ? raw.reasoningEfforts.filter((effort): effort is OpenCodeGoReasoningEffort => (OPENCODE_GO_REASONING_EFFORTS as readonly string[]).includes(String(effort))) : [],
      supportsTools: raw.supportsTools !== false,
      supportsImages: raw.supportsImages === true,
      training: optionalBool(raw.training),
      zdr: optionalBool(raw.zdr),
      limitedRegions: optionalBool(raw.limitedRegions),
    })
  }
  return entries
}

export function resolveOpenCodeGoModel(entries: readonly OpenCodeGoModelEntry[], id: string): OpenCodeGoModelEntry {
  const entry = entries.find(candidate => candidate.id === id)
  if (entry === undefined) throw new LlmError('OpenCode Go model "' + id + '" is not in the current key catalog. Refresh the line settings.', 'NOT_FOUND')
  return entry
}

export function openCodeGoModelOptions(entries: readonly OpenCodeGoModelEntry[], settings: OpenCodeGoSettings): OpenCodeGoModelOption[] {
  return entries.map(entry => {
    const contextWindow = settings.contextWindowOverrides[entry.id] ?? entry.contextWindow
    const capabilities: string[] = []
    capabilities.push(contextWindow >= 1_000_000 ? '1M' : Math.round(contextWindow / 1000) + 'K')
    capabilities.push(entry.supportsImages ? 'text+image' : 'text')
    if (entry.reasoningEfforts.length > 0) capabilities.push('effort ' + entry.reasoningEfforts.join('/'))
    if (entry.supportsTools === false) capabilities.push('no tools')
    if (entry.training === true) capabilities.push('training enabled')
    if (entry.limitedRegions === true) capabilities.push('region limited')
    return {
      id: entry.id, name: entry.name, hint: capabilities.join(' · '), enabled: settings.enabledModelIds === null || settings.enabledModelIds.includes(entry.id),
      defaultContextWindow: entry.contextWindow, contextWindow, defaultMaxTokens: entry.maxOutputTokens,
      reasoningEfforts: entry.reasoningEfforts, supportsTools: entry.supportsTools, supportsImages: entry.supportsImages, description: entry.description,
      canonicalId: entry.canonicalId, training: entry.training, zdr: entry.zdr, limitedRegions: entry.limitedRegions,
    }
  })}

export class OpenCodeGoCatalogManager {
  private scope = ''
  private entries: OpenCodeGoModelEntry[] = []
  private fetchedAt = 0
  private rehydrated = false
  private inFlight: Promise<OpenCodeGoModelEntry[]> | null = null
  private readonly ttlMs: number
  constructor(ttlMs = 60_000) { this.ttlMs = ttlMs }

  snapshot(): { entries: readonly OpenCodeGoModelEntry[]; fetchedAt: number; scope: string } { return { entries: this.entries, fetchedAt: this.fetchedAt, scope: this.scope } }
  async restore(scope: string): Promise<readonly OpenCodeGoModelEntry[]> { await this.rehydrate(scope); return this.entries }
  fingerprint(): string { return this.entries.map(entry => entry.id).join('\0') }

  private async rehydrate(scope: string): Promise<void> {
    if (this.rehydrated && this.scope === scope) return
    this.scope = scope
    this.rehydrated = true
    this.entries = []
    this.fetchedAt = 0
    await rehydrateCatalogCache(catalogSnapshotName('opencode-go', scope), parsePersistedOpenCodeGoModelEntries, (fetchedAt, models) => {
      this.entries = models
      this.fetchedAt = fetchedAt
    }, this.fetchedAt)
  }

  async warm(target: { account: { id: string }; credentials: OpenCodeGoCredentials }, fetchFn: typeof fetch = fetch, force = false): Promise<readonly OpenCodeGoModelEntry[]> {
    await this.rehydrate(target.account.id)
    if (!force && this.entries.length > 0 && Date.now() - this.fetchedAt < this.ttlMs) return this.entries
    return this.refresh(target, fetchFn)
  }

  async refresh(target: { account: { id: string }; credentials: OpenCodeGoCredentials }, fetchFn: typeof fetch = fetch): Promise<OpenCodeGoModelEntry[]> {
    if (this.inFlight !== null && this.scope === target.account.id) return this.inFlight
    if (this.inFlight !== null) await this.inFlight.catch(() => undefined)
    const scope = target.account.id
    this.scope = scope
    this.rehydrated = true
    this.inFlight = (async () => {
      const raw = await fetchOpenCodeGoModels(target.credentials, fetchFn)
      const entries = parseOpenCodeGoModelEntries(raw) ?? []
      if (entries.length === 0) throw new Error('OpenCode Go returned no usable chat models for this key')
      const fetchedAt = Date.now()
      void writeCatalogSnapshot(catalogSnapshotName('opencode-go', scope), persistedOpenCodeGoModelEntries(entries), fetchedAt)
      // A concurrent warmer may switch the visible account; this caller still needs its own catalog.
      if (this.scope !== scope) return entries
      this.entries = entries
      this.fetchedAt = fetchedAt
      return entries
    })()
    return this.inFlight.finally(() => { this.inFlight = null })
  }
}

export { catalogSnapshotPath }
