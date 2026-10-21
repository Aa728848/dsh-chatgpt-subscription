/**
 * Transport for the OpenDesign link gateway. Transport only: no account or
 * retry policy lives here (see `adapter.ts`).
 *
 * - `POST {baseURL}/chat/completions` — the chat endpoint this line speaks
 * - `GET  {baseURL}/models` — the key's live catalog; also the auth probe,
 *   because listing costs no credits while a token of chat does
 *
 * The base URL is the OpenAI spelling and already ends in `/v1`
 * (src/host/opendesign/types.ts records how that was verified), so paths append
 * literally.
 *
 * @module dsh-chatgpt-subscription/opendesign-client
 */
import { AMR_API_BASE, WALLET_BALANCE_PATH, type OpenDesignDiscoveredModel } from './types.ts'

export interface OpenDesignHttpResult {
  status: number
  ok: boolean
  json: unknown
  text: string
}

/** Combine a caller signal with a timeout signal. */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const signals: AbortSignal[] = []
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  if (signal !== undefined && signal !== null) signals.push(signal)
  if (signals.length === 0) return undefined
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

/** Strip a trailing slash so paths can be appended literally. */
export function trimBase(baseURL: string): string {
  return String(baseURL ?? '').trim().replace(/\/+$/, '')
}

/** The gateway's chat-completions endpoint for one base URL. */
export function chatURL(baseURL: string): string {
  return `${trimBase(baseURL)}/chat/completions`
}

/** The gateway's catalog endpoint for one base URL. */
export function modelsURL(baseURL: string): string {
  return `${trimBase(baseURL)}/models`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Send one JSON request and decode whatever comes back; never throws for HTTP errors. */
export async function sendJSON(
  fetchFn: typeof fetch,
  url: string,
  {
    method = 'GET',
    apiKey = '',
    body,
    signal,
    timeoutMs = 60_000,
    headers = {},
  }: {
    method?: string
    apiKey?: string
    body?: unknown
    signal?: AbortSignal
    timeoutMs?: number
    headers?: Record<string, string>
  } = {},
): Promise<OpenDesignHttpResult> {
  const outgoing: RequestInit = {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: withTimeout(signal, timeoutMs),
  }
  const response = await fetchFn(url, outgoing)
  const text = await response.text()
  let json: unknown = null
  if (text.length > 0) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { status: response.status, ok: response.ok, json, text }
}

/** Open a streaming chat completion and hand back the live response. */
export async function openChatStream({
  fetchFn,
  baseURL,
  apiKey,
  body,
  signal,
  headers = {},
}: {
  fetchFn: typeof fetch
  baseURL: string
  apiKey: string
  body: unknown
  signal?: AbortSignal
  headers?: Record<string, string>
}): Promise<Response> {
  return await fetchFn(chatURL(baseURL), {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      ...(apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` }),
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  })
}

/** The gateway's own one-line explanation, when it sent one. */
export function firstMessage(envelope: unknown): string {
  if (!isRecord(envelope)) return ''
  const message = envelope.error ?? envelope.message
  if (typeof message === 'string') return message.slice(0, 200)
  if (isRecord(message) && typeof message.message === 'string') return message.message.slice(0, 200)
  return ''
}

/**
 * One catalog entry read defensively.
 *
 * The exact listing shape is unverified (reading it needs a real key): an
 * OpenAI-compatible gateway answers `{ data: [{ id, ... }] }`, and this reader
 * also accepts a bare array. Metadata fields are adopted only when present with
 * the OpenAI spellings (`context_window` or `contextWindow`, `max_tokens` or
 * `maxTokens`, `modalities.input` or `input`); an id-only row is still a
 * catalog entry.
 */
function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function pickPositiveInteger(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  }
  return undefined
}

function pickStringArray(record: Record<string, unknown>, keys: readonly string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      if (items.length > 0) return items
      return []
    }
  }
  return undefined
}

/**
 * One catalog entry read defensively.
 *
 * The exact listing shape is unverified (reading it needs a real key): an
 * OpenAI-compatible gateway answers `{ data: [{ id, ... }] }`, and this reader
 * also accepts a bare array. Metadata is adopted from every spelling the
 * ecosystem uses — the AMR control-plane catalog publishes
 * `metadata.contextWindowTokens` (the open-source daemon's reader accepts
 * `contextWindowTokens` / `context_window_tokens` / `contextLength`), while a
 * gateway that describes itself richer may publish `context_window`,
 * `max_output_tokens`, `inputModalities` or `reasoningEfforts`. An id-only row
 * is still a catalog entry; it simply contributes nothing but its id.
 */
function catalogEntryOf(raw: unknown): { id: string; meta: OpenDesignDiscoveredModel } | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.trim() === '') return undefined
  const metadata = isRecord(raw.metadata) ? raw.metadata : {}
  const limit = isRecord(raw.limit) ? raw.limit : {}
  const modalities = isRecord(raw.modalities) ? raw.modalities : {}
  const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {}
  const meta: OpenDesignDiscoveredModel = {}

  const name = pickString(raw, ['name', 'display_name', 'displayName', 'label'])
  if (name !== undefined) meta.name = name

  const contextWindow = pickPositiveInteger(raw, ['context_window', 'contextWindow', 'contextWindowTokens', 'context_window_tokens', 'contextLength', 'context_length'])
    ?? pickPositiveInteger(metadata, ['contextWindowTokens', 'context_window_tokens', 'contextLength', 'context_length'])
    ?? pickPositiveInteger(limit, ['context'])
  if (contextWindow !== undefined) meta.contextWindow = contextWindow

  const maxTokens = pickPositiveInteger(raw, ['max_tokens', 'maxTokens', 'max_output_tokens', 'maxOutputTokens', 'max_completion_tokens', 'maxCompletionTokens'])
    ?? pickPositiveInteger(metadata, ['maxOutputTokens', 'max_output_tokens', 'maxTokens'])
    ?? pickPositiveInteger(limit, ['output'])
  if (maxTokens !== undefined) meta.maxTokens = maxTokens

  const input = pickStringArray(raw, ['inputModalities', 'input_modalities'])
    ?? pickStringArray(modalities, ['input'])
    ?? pickStringArray(capabilities, ['input'])
    ?? (Array.isArray(raw.input) && raw.input.every((item) => typeof item === 'string')
      ? (raw.input as string[]).filter((item) => item.length > 0)
      : undefined)
  if (input !== undefined && input.length > 0) meta.input = input
  // A boolean capability flag is the other common spelling; it can only ADD
  // image input, and only when the listing states it (never as a guess).
  if (meta.input === undefined
    && (raw.supportsVision === true || raw.supports_vision === true || raw.vision === true)) {
    meta.input = ['text', 'image']
  }

  const efforts = pickStringArray(raw, ['efforts', 'reasoningEfforts', 'reasoning_efforts', 'reasoningLevels'])
    ?? pickStringArray(metadata, ['efforts', 'reasoningEfforts', 'reasoning_efforts'])
  if (efforts !== undefined && efforts.length > 0) meta.efforts = efforts
  if (typeof raw.reasoning === 'boolean') meta.reasoning = raw.reasoning
  else if (raw.supports_reasoning === false || raw.supportsReasoning === false) meta.reasoning = false
  return { id: raw.id.trim(), meta }
}

/**
 * The live catalog one key may list.
 *
 * Returns ids plus whatever metadata the listing published, or null on any
 * failure — a refused or unreachable gateway is a fact the caller reports, not
 * an exception the route drops.
 */
export async function fetchGatewayCatalog({
  fetchFn,
  baseURL,
  apiKey,
  signal,
  timeoutMs = 30_000,
}: {
  fetchFn: typeof fetch
  baseURL: string
  apiKey: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<{ ids: string[]; catalog: Record<string, OpenDesignDiscoveredModel> } | null> {
  try {
    const result = await sendJSON(fetchFn, modelsURL(baseURL), { apiKey, signal, timeoutMs })
    if (!result.ok) return null
    const rows = isRecord(result.json) && Array.isArray(result.json.data)
      ? result.json.data
      : Array.isArray(result.json) ? result.json : []
    const ids: string[] = []
    const catalog: Record<string, OpenDesignDiscoveredModel> = {}
    for (const row of rows) {
      const entry = catalogEntryOf(row)
      if (entry === undefined) continue
      if (!ids.includes(entry.id)) ids.push(entry.id)
      if (Object.keys(entry.meta).length > 0) catalog[entry.id] = entry.meta
    }
    return { ids, catalog }
  } catch {
    return null
  }
}

/**
 * One id compared without its separators.
 *
 * The AMR control-plane catalog spells ids `public_model_deepseek_v4_1_flash`
 * (the open-source daemon normalizes the same spellings at its boundary), while
 * the link gateway and this line's table use `deepseek-v4.1-flash`. Comparing
 * alphanumerics only maps one onto the other without a per-model translation
 * table that would rot the moment a model is added.
 */
export function canonicalModelKey(id: string): string {
  // The AMR catalog prefixes its public ids (`public_model_deepseek_v4_1_flash`,
  // and `vela/` in some listings); the prefix is transport detail, not identity.
  const withoutPrefix = id.trim().replace(/^vela\//i, '').replace(/^public_model_/i, '')
  return withoutPrefix.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The control-plane catalog: the AMR-side listing, which DOES carry metadata.
 *
 * `GET {amr}/models` with a control key (the open-source daemon reads the same
 * catalog through `vela model list --all --format json`, whose items carry
 * `metadata.contextWindowTokens`). Ids are normalized onto the known wire ids
 * with {@link canonicalModelKey}; an id the line does not know is kept as the
 * slug it arrived as, never dropped.
 *
 * A runtime key is not accepted here (the console's control-plane surfaces
 * reject it), so this is an OAuth-account capability; the gateway listing stays
 * the path for a pasted key.
 */
export async function fetchControlPlaneCatalog({
  fetchFn,
  controlKey,
  apiBase = AMR_API_BASE,
  knownIds = [],
  signal,
  timeoutMs = 30_000,
}: {
  fetchFn: typeof fetch
  controlKey: string
  apiBase?: string
  knownIds?: readonly string[]
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<{ ids: string[]; catalog: Record<string, OpenDesignDiscoveredModel> } | null> {
  const byKey = new Map(knownIds.map((id) => [canonicalModelKey(id), id]))
  try {
    const result = await sendJSON(fetchFn, `${trimBase(apiBase)}/models`, { apiKey: controlKey, signal, timeoutMs })
    if (!result.ok) return null
    const rows = isRecord(result.json) && Array.isArray(result.json.data)
      ? result.json.data
      : Array.isArray(result.json) ? result.json : []
    const ids: string[] = []
    const catalog: Record<string, OpenDesignDiscoveredModel> = {}
    for (const row of rows) {
      const entry = catalogEntryOf(row)
      if (entry === undefined) continue
      const id = byKey.get(canonicalModelKey(entry.id)) ?? entry.id
      if (!ids.includes(id)) ids.push(id)
      if (Object.keys(entry.meta).length > 0) catalog[id] = { ...(catalog[id] ?? {}), ...entry.meta }
    }
    return { ids, catalog }
  } catch {
    return null
  }
}

/**
 * Verify one key with the free catalog read.
 *
 * A chat probe would spend credits to learn the same thing, so the probe is the
 * listing: 200 proves the key works (and how many models it sees), 401/403
 * proves it does not, and anything else is reported as the gateway sent it.
 */
export async function testApiKey({
  fetchFn,
  baseURL,
  apiKey,
  signal,
  timeoutMs = 30_000,
}: {
  fetchFn: typeof fetch
  baseURL: string
  apiKey: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<{ authorized: boolean; ms: number; error: string; modelCount: number }> {
  const startedAt = Date.now()
  try {
    const result = await sendJSON(fetchFn, modelsURL(baseURL), { apiKey, signal, timeoutMs })
    const ms = Date.now() - startedAt
    if (result.ok) {
      const rows = isRecord(result.json) && Array.isArray(result.json.data)
        ? result.json.data
        : Array.isArray(result.json) ? result.json : []
      return { authorized: true, ms, error: '', modelCount: rows.length }
    }
    const detail = firstMessage(result.json) || result.text.slice(0, 160)
    return {
      authorized: false,
      ms,
      error: detail === '' ? `the gateway answered HTTP ${result.status}` : detail,
      modelCount: 0,
    }
  } catch (error) {
    return {
      authorized: false,
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      modelCount: 0,
    }
  }
}

/** One wallet reading: the balance string as served, or the refusal as data. */
export interface OpenDesignWalletBalance {
  ok: boolean
  /** USD balance, exactly as the service strings it (e.g. "12.34"). */
  balanceUsd: string | null
  /** ISO instant the service stamped on the reading, when it sent one. */
  updatedAt: string | null
  error: string
}

/**
 * Read one OAuth account's wallet balance with its control key.
 *
 * Wire shape from the open-source daemon's reader
 * (apps/daemon/src/integrations/vela-wallet.ts, nexu-io/open-design): the
 * balance is a STRING matching /^\d+(?:\.\d+)?$/ — a number-shaped field of
 * any other type is not a balance. A refusal is reported as data, never thrown:
 * the card shows it beside controls that keep working without it. Billing reads
 * are display-only upstream too (OPEND-3553 in the same repo): a wallet 401/403
 * says nothing about the chat credential, so it must never mark the account.
 */
export async function fetchWalletBalance({
  fetchFn,
  controlKey,
  apiBase = AMR_API_BASE,
  signal,
  timeoutMs = 15_000,
}: {
  fetchFn: typeof fetch
  controlKey: string
  apiBase?: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<OpenDesignWalletBalance> {
  const refusal = { ok: false, balanceUsd: null, updatedAt: null } as const
  try {
    const result = await sendJSON(fetchFn, `${trimBase(apiBase)}${WALLET_BALANCE_PATH}`, { apiKey: controlKey, signal, timeoutMs })
    if (!result.ok) {
      const detail = firstMessage(result.json) || result.text.slice(0, 120)
      return { ...refusal, error: `the wallet endpoint answered HTTP ${result.status}${detail === '' ? '' : `: ${detail}`}` }
    }
    const body = isRecord(result.json) ? result.json : {}
    const balance = body.balanceUsd
    if (typeof balance !== 'string' || !/^\d+(?:\.\d+)?$/.test(balance)) {
      return { ...refusal, error: 'the wallet endpoint returned no usable balanceUsd' }
    }
    return {
      ok: true,
      balanceUsd: balance,
      updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : null,
      error: '',
    }
  } catch (error) {
    return { ...refusal, error: error instanceof Error ? error.message : String(error) }
  }
}
