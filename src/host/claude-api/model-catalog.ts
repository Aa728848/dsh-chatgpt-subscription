import type { ClaudeApiModelDto, ClaudeApiReasoningEffort } from '../../shared/claude-api-contracts.ts'
import type { ClaudeApiSettings } from './token-store.ts'

/**
 * Per-model capability table of the Claude API line.
 *
 * SOURCES. Support lists are the featureMetadata.supportedModels blocks of the official
 * pages fetched 2026-11-21 under https://platform.claude.com/docs/en/ :
 *   build-with-claude/mid-conversation-system-messages   -> midConversationSystem
 *   build-with-claude/preserved-thinking/prefix-checks    -> preservedThinking
 *   build-with-claude/compaction-on-demand                -> serverCompaction
 *   build-with-claude/fast-mode                           -> fastMode ('beta' = needs the fast-mode header)
 *   build-with-claude/context-editing                     -> contextEditing
 * Window, output cap, thinking form, effort ladder and temperature come from the in-repo
 * transcription src/host/claude/model-catalog.ts (read as a reference, not imported), and
 * three of them were re-checked live: claude-haiku-5-5 rejects budget thinking and a
 * non-default temperature, and 128000 is the output cap of claude-haiku-5-5 and claude-opus-5-5.
 * UNVERIFIED: the Mythos rows mirror their Fable siblings because the docs list them together.
 */
export type ClaudeApiThinkingMode = 'adaptive' | 'budget' | 'none'
export type ClaudeApiFastMode = 'ga' | 'beta' | null
type Effort = Exclude<ClaudeApiReasoningEffort, 'none'>

export interface ClaudeApiModelEntry {
  id: string
  name: string
  contextWindow: number
  maxOutputTokens: number
  supportsImages: boolean
  supportsTemperature: boolean
  thinkingMode: ClaudeApiThinkingMode
  /** Selectable effort levels, lowest first; never contains 'none'. */
  reasoningEfforts: readonly Effort[]
  canDisableThinking: boolean
  /** Accepts role:system entries inside messages (and tool_addition / tool_removal in them). */
  midConversationSystem: boolean
  /** Runs the preserved-thinking prefix check, so block_binding is sent. */
  preservedThinking: boolean
  fastMode: ClaudeApiFastMode
  serverCompaction: boolean
  contextEditing: boolean
  /** false when the id is not in the shipped table and a template was used. */
  known: boolean
}

const FULL: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const NO_XHIGH: readonly Effort[] = ['low', 'medium', 'high', 'max']
const LEGACY: readonly Effort[] = ['low', 'medium', 'high']

type Row = Partial<Omit<ClaudeApiModelEntry, 'id' | 'name' | 'known'>>
const CURRENT: Omit<ClaudeApiModelEntry, 'id' | 'name' | 'known'> = {
  contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, supportsTemperature: false,
  thinkingMode: 'adaptive', reasoningEfforts: FULL, canDisableThinking: false,
  midConversationSystem: true, preservedThinking: true, fastMode: null, serverCompaction: true, contextEditing: true,
}
const LEGACY_ROW: Row = {
  contextWindow: 200_000, maxOutputTokens: 64_000, supportsTemperature: true, thinkingMode: 'budget', reasoningEfforts: LEGACY,
  canDisableThinking: true, midConversationSystem: false, preservedThinking: false, serverCompaction: false,
}
function row(id: string, name: string, overrides: Row = {}): ClaudeApiModelEntry {
  return Object.freeze({ ...CURRENT, ...overrides, id, name, known: true })
}

export const CLAUDE_API_MODELS: readonly ClaudeApiModelEntry[] = Object.freeze([
  row('claude-fable-5-2', 'Claude Fable 5.2', { fastMode: 'ga' }),
  row('claude-mythos-5-2', 'Claude Mythos 5.2', { fastMode: 'ga' }),
  row('claude-fable-5-1', 'Claude Fable 5.1', { supportsTemperature: true }),
  row('claude-mythos-5-1', 'Claude Mythos 5.1', { supportsTemperature: true }),
  row('claude-fable-5', 'Claude Fable 5', { supportsTemperature: true, preservedThinking: false }),
  // Binary 2.1.330 capabilities only; live serving is unverified on the test account group.
  row('claude-mythos-5', 'Claude Mythos 5', {
    supportsTemperature: true, preservedThinking: false, thinkingMode: 'budget', reasoningEfforts: [],
    canDisableThinking: true, midConversationSystem: false, fastMode: null, serverCompaction: false, contextEditing: false,
  }),
  row('claude-opus-5-5', 'Claude Opus 5.5', { fastMode: 'ga' }),
  row('claude-opus-5', 'Claude Opus 5', { canDisableThinking: true, preservedThinking: false, fastMode: 'beta' }),
  row('claude-sonnet-5-5', 'Claude Sonnet 5.5'),
  row('claude-sonnet-5', 'Claude Sonnet 5', { supportsTemperature: true, canDisableThinking: true, midConversationSystem: false, preservedThinking: false }),
  row('claude-haiku-5-5', 'Claude Haiku 5.5', { canDisableThinking: true }),
  row('claude-opus-4-8', 'Claude Opus 4.8', { canDisableThinking: true, preservedThinking: false, fastMode: 'beta' }),
  row('claude-opus-4-7', 'Claude Opus 4.7', { canDisableThinking: true, midConversationSystem: false, preservedThinking: false }),
  row('claude-opus-4-6', 'Claude Opus 4.6', { supportsTemperature: true, reasoningEfforts: NO_XHIGH, canDisableThinking: true, midConversationSystem: false, preservedThinking: false }),
  row('claude-sonnet-4-6', 'Claude Sonnet 4.6', { supportsTemperature: true, reasoningEfforts: NO_XHIGH, canDisableThinking: true, midConversationSystem: false, preservedThinking: false }),
  row('claude-opus-4-5-20251101', 'Claude Opus 4.5', LEGACY_ROW),
  row('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', LEGACY_ROW),
  row('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', LEGACY_ROW),
])

/** Template for an id the table has never heard of. */
function templateFor(id: string, name: string): ClaudeApiModelEntry {
  // A newer Claude id inherits the current generation: every current model is adaptive and
  // supports the request-shape features, and block_binding in drop mode is the safe side.
  if (id.toLowerCase().startsWith('claude-')) return { ...CURRENT, id, name, known: false }
  // Anything else a custom gateway lists gets the plainest Messages request this line can build.
  return {
    id, name, contextWindow: 200_000, maxOutputTokens: 32_000, supportsImages: true, supportsTemperature: true,
    thinkingMode: 'none', reasoningEfforts: [], canDisableThinking: true, midConversationSystem: false,
    preservedThinking: false, fastMode: null, serverCompaction: false, contextEditing: false, known: false,
  }
}

/** Facts for one model id: the caller's catalog first, then the shipped table, then a template. */
export function resolveClaudeApiModel(id: string, catalog?: readonly ClaudeApiModelEntry[]): ClaudeApiModelEntry {
  return catalog?.find(entry => entry.id === id)
    ?? CLAUDE_API_MODELS.find(entry => entry.id === id)
    ?? templateFor(id, id)
}

/** The shipped table as a fresh array; the cold-start placeholder before any live listing. */
export function claudeApiFallbackEntries(): ClaudeApiModelEntry[] {
  return CLAUDE_API_MODELS.map(entry => ({ ...entry }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function entryFor(id: string, displayName: string | undefined): ClaudeApiModelEntry {
  const known = CLAUDE_API_MODELS.find(entry => entry.id === id)
  if (known !== undefined) return { ...known }
  return templateFor(id, displayName !== undefined && displayName !== '' ? displayName : id)
}

/**
 * Parse the live GET /v1/models envelope ({ data: [{ id, display_name }] }).
 * Capabilities always come from this module, never from the listing: a gateway may
 * synthesize the listing (observed: display_name equal to the id and no capability fields).
 */
export function parseClaudeApiModelListing(payload: unknown): ClaudeApiModelEntry[] {
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : []
  const seen = new Set<string>()
  const entries: ClaudeApiModelEntry[] = []
  for (const raw of data) {
    if (!isRecord(raw)) continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const display = typeof raw.display_name === 'string' ? raw.display_name.trim() : ''
    entries.push(entryFor(id, display !== id ? display : undefined))
  }
  return entries
}

/** One persisted snapshot record. Written by persistedClaudeApiModelRecord, read by parsePersistedClaudeApiModelEntries. */
export interface PersistedClaudeApiModelRecord { id: string; name: string }

/** Snapshot writer half. Only identity is persisted; capabilities are recomputed on read so a table fix reaches old snapshots. */
export function persistedClaudeApiModelRecord(entry: ClaudeApiModelEntry): PersistedClaudeApiModelRecord {
  return { id: entry.id, name: entry.name }
}

/** Snapshot reader half: the inverse of mapping persistedClaudeApiModelRecord over a catalog. */
export function parsePersistedClaudeApiModelEntries(value: unknown): ClaudeApiModelEntry[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const entries: ClaudeApiModelEntry[] = []
  for (const raw of value) {
    if (!isRecord(raw)) continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    entries.push(entryFor(id, name !== id ? name : undefined))
  }
  return entries
}

/**
 * The ids a request may use: THE one selection rule for listModels, the settings card and the hub count.
 *
 * null means every listed model. An explicit [] means none, in both phases. An explicit list is
 * applied only to a LIVE catalog: the shipped fallback table and a user's list are different id
 * vocabularies, so filtering the fallback through the list could hide the whole line on a cold start.
 */
export function convergeClaudeApiSelection(entries: readonly ClaudeApiModelEntry[], settings: Pick<ClaudeApiSettings, 'enabledModelIds'>, live: boolean): Set<string> {
  const selected = settings.enabledModelIds
  if (selected === null) return new Set(entries.map(entry => entry.id))
  if (selected.length === 0) return new Set()
  if (!live) return new Set(entries.map(entry => entry.id))
  const allowed = new Set(selected)
  return new Set(entries.filter(entry => allowed.has(entry.id)).map(entry => entry.id))
}

function capacity(tokens: number): string {
  if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1) + 'M'
  return Math.round(tokens / 1000) + 'K'
}

/** Context window after the user's override, or the model default. */
export function claudeApiContextWindow(entry: ClaudeApiModelEntry, settings: Pick<ClaudeApiSettings, 'contextWindowOverrides'>): number {
  return settings.contextWindowOverrides[entry.id] ?? entry.contextWindow
}

/** Public rows for the settings card. */
export function claudeApiModelOptions(entries: readonly ClaudeApiModelEntry[], settings: ClaudeApiSettings, live: boolean): ClaudeApiModelDto[] {
  const enabled = convergeClaudeApiSelection(entries, settings, live)
  return entries.map(entry => ({
    id: entry.id,
    name: entry.name,
    hint: capacity(claudeApiContextWindow(entry, settings)) + ' / ' + capacity(entry.maxOutputTokens),
    enabled: enabled.has(entry.id),
    contextWindow: claudeApiContextWindow(entry, settings),
    defaultContextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    reasoningEfforts: entry.thinkingMode === 'none' ? [] : [...(entry.canDisableThinking ? ['none' as const] : []), ...entry.reasoningEfforts],
    supportsImages: entry.supportsImages,
    supportsFastMode: entry.fastMode !== null,
    supportsServerCompaction: entry.serverCompaction,
  }))
}
