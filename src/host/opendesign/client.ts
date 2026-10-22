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
import {
  AMR_API_BASE,
  BILLING_SUMMARY_PATH,
  CODING_PLAN_USAGE_SUFFIX,
  CURRENT_WORKSPACE_PATH,
  WALLET_BALANCE_PATH,
  WORKSPACES_PATH,
  type OpenDesignDiscoveredModel,
} from './types.ts'
import type { OpenDesignCodingPlanDto, OpenDesignCodingPlanWindowDto } from '../../shared/opendesign-contracts.ts'

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

/**
 * One account's plan and credit state, as `/billing/summary` states it.
 *
 * Balance strings keep the service's own spelling. `plan` is the paid tier
 * (`go` / `plus` / `pro` / `max`) and is the only field that answers "which
 * subscription is this"; `/me.plan` answers `free` even for an active paid
 * account and is deliberately not used as a tier.
 */
export interface OpenDesignBillingSummary {
  plan: string
  /** `active`, `trialing`, `canceled`, ... as served. */
  status: string
  entitlementStatus: string
  billingInterval: string
  periodStart: string | null
  periodEnd: string | null
  /** Credits the subscription grants and has left, in integer credits. */
  subscriptionCredits: string | null
  /** Purchased top-up credits left. */
  rechargeCredits: string | null
  totalAvailableCredits: string | null
  subscriptionCreditsUsd: string | null
  rechargeCreditsUsd: string | null
  totalAvailableCreditsUsd: string | null
  totalConsumedUsd: string | null
  todayConsumedUsd: string | null
  /** How many spent requests the service counted (a diagnostic, not a quota). */
  usageCount: number | null
  /** ISO instant the service stamped on the summary. */
  updatedAt: string | null
}

/** One billing read: the parsed summary, or the refusal as data. */
export interface OpenDesignBillingRead {
  ok: boolean
  billing: OpenDesignBillingSummary | null
  error: string
}

function usdString(value: unknown): string | null {
  return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) ? value : null
}

function creditString(value: unknown): string | null {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : null
}

function isoString(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function textString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read one OAuth account's plan and credits with its control key.
 *
 * The summary is display data: a refusal is returned as data, never thrown, and
 * must never mark the account (billing 401/403 is display-only upstream —
 * OPEND-3553 — exactly like the wallet read). A summary with no
 * `membershipTier` is not treated as a plan: "the tier is unknown" and "the plan
 * is free" are different statements.
 */
export async function fetchBillingSummary({
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
}): Promise<OpenDesignBillingRead> {
  const refusal: OpenDesignBillingRead = { ok: false, billing: null, error: '' }
  try {
    const result = await sendJSON(fetchFn, trimBase(apiBase) + BILLING_SUMMARY_PATH, { apiKey: controlKey, signal, timeoutMs })
    if (!result.ok) {
      const detail = firstMessage(result.json) || result.text.slice(0, 120)
      return {
        ...refusal,
        error: 'the billing summary answered HTTP ' + result.status + (detail === '' ? '' : ': ' + detail),
      }
    }
    const body = isRecord(result.json) ? result.json : {}
    const plan = textString(body.membershipTier)
    if (plan === '') {
      return { ...refusal, error: 'the billing summary named no membershipTier' }
    }
    const balances = isRecord(body.balances) ? body.balances : {}
    return {
      ok: true,
      billing: {
        plan,
        status: textString(body.subscriptionStatus),
        entitlementStatus: textString(body.subscriptionEntitlementStatus),
        billingInterval: textString(body.billingInterval),
        periodStart: isoString(body.subscriptionCurrentPeriodStart),
        periodEnd: isoString(body.subscriptionCurrentPeriodEnd),
        subscriptionCredits: creditString(balances.subscriptionCredits),
        rechargeCredits: creditString(balances.rechargeCredits),
        totalAvailableCredits: creditString(balances.totalAvailableCredits),
        subscriptionCreditsUsd: usdString(body.subscriptionCreditsUsd),
        rechargeCreditsUsd: usdString(body.rechargeCreditsUsd),
        totalAvailableCreditsUsd: usdString(body.totalAvailableCreditsUsd),
        totalConsumedUsd: usdString(body.totalConsumedUsd),
        todayConsumedUsd: usdString(body.todayConsumedUsd),
        usageCount: typeof body.usageCount === 'number' && Number.isSafeInteger(body.usageCount) && body.usageCount >= 0
          ? body.usageCount
          : null,
        updatedAt: isoString(body.updatedAt),
      },
      error: '',
    }
  } catch (error) {
    return { ...refusal, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The Design Plan's two DTOs are DEFINED beside this line's other wire contracts
 * (src/shared/opendesign-contracts.ts) and re-exported here.
 *
 * The card in the browser reads the same objects, so the declaration has to live
 * where both halves of the plugin can reach it. A `import type` from the shared
 * file back into the host would point the client's type-check program at host
 * sources; re-exporting the other way round keeps the direction of every existing
 * import (host → shared) intact and still lets a host-side caller import the DTO
 * from the module that produced it.
 */
export type { OpenDesignCodingPlanDto, OpenDesignCodingPlanWindowDto } from '../../shared/opendesign-contracts.ts'

/** One workspace lookup: the id a coding-plan read is addressed by, or why not. */
export interface OpenDesignWorkspaceIdRead {
  ok: boolean
  /** The workspace id to address; null whenever the lookup did not land on one. */
  id: string | null
  /** Why no id was read; the empty string on success. */
  error: string
}

/**
 * The refusal one endpoint stated, as one line.
 *
 * The machine `code` comes first because that is the only part a caller can act
 * on — `coding_plan_configuration_unavailable` means "this workspace has no
 * coding plan", which is a fact about the account rather than a fault. Both
 * `{ code }` and `{ error: { code } }` are read (the control plane uses both
 * spellings across its surfaces), then the usual `error`/`message` prose, then
 * the raw body. Nothing is invented when the body says nothing: that case stays
 * empty and the caller prints the status alone.
 */
function refusalDetail(json: unknown, text: string): string {
  if (isRecord(json)) {
    const code = pickString(json, ['code'])
    if (code !== undefined) return code
    if (isRecord(json.error)) {
      const nested = pickString(json.error, ['code', 'message'])
      if (nested !== undefined) return nested
    }
    const message = firstMessage(json)
    if (message !== '') return message
  }
  return text.trim().slice(0, 120)
}

/** `HTTP <status>: <code or first message>`, or the bare status when nothing was said. */
function httpRefusal(status: number, json: unknown, text: string): string {
  const detail = refusalDetail(json, text)
  return detail === '' ? `HTTP ${status}` : `HTTP ${status}: ${detail}`
}

/**
 * The keys a workspace id travels under, in the order the console's payloads
 * spell them.
 *
 * `activeWorkspaceId` is what the current-workspace read answers; `workspaceId`
 * and `id` are how a listing entry or a nested `workspace` object names the same
 * fact.
 */
const WORKSPACE_ID_KEYS: readonly string[] = ['activeWorkspaceId', 'workspaceId', 'id']

/**
 * One id out of one object: the direct keys first, then a nested `workspace`.
 *
 * @param record - Candidate object.
 * @returns The id, or null when nothing in it states one.
 */
function workspaceIdIn(record: Record<string, unknown>): string | null {
  const direct = pickString(record, WORKSPACE_ID_KEYS)
  if (direct !== undefined) return direct
  const nested = record.workspace
  if (isRecord(nested)) return pickString(nested, WORKSPACE_ID_KEYS) ?? null
  return null
}

/**
 * The entries a listing endpoint answered, whatever wrapper it used.
 *
 * The wrapper is not worth trusting: the same control-plane family answers a bare
 * array, `{ workspaces }`, `{ items }`, `{ data }` and `{ data: { items | workspaces } }`
 * on its own different surfaces, and a lookup that guesses one of them reports
 * "no workspace" on a response that carried several.
 *
 * @param body - The decoded response.
 * @returns The candidate entries; empty when none of the shapes matched.
 */
function listedWorkspaces(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  if (!isRecord(body)) return []
  if (Array.isArray(body.workspaces)) return body.workspaces
  if (Array.isArray(body.items)) return body.items
  if (Array.isArray(body.data)) return body.data
  if (isRecord(body.data)) {
    if (Array.isArray(body.data.items)) return body.data.items
    if (Array.isArray(body.data.workspaces)) return body.data.workspaces
  }
  return []
}

/**
 * The first id a listing states.
 *
 * @param body - The decoded response.
 * @returns The id, or null when no entry states one.
 */
function listedWorkspaceId(body: unknown): string | null {
  for (const entry of listedWorkspaces(body)) {
    if (!isRecord(entry)) continue
    // A listing entry names its own workspace, never somebody's active one: the
    // keys are `id` then `workspaceId`, then the same pair under `workspace`.
    // `activeWorkspaceId` is deliberately NOT read here — on a listing it would
    // point at a different row.
    const direct = pickString(entry, ['id', 'workspaceId'])
    if (direct !== undefined) return direct
    const nested = isRecord(entry.workspace) ? pickString(entry.workspace, ['id', 'workspaceId']) : undefined
    if (nested !== undefined) return nested
  }
  return null
}

/**
 * The SHAPE of a response body — never its content.
 *
 * Diagnostic only. A failed lookup has to say what the endpoint actually answered
 * without leaking a single value: the top-level keys, sorted and capped, are the
 * one thing that makes the next live attempt debuggable while an id, a workspace
 * name or a token stays out of the log and out of the card.
 *
 * @param json - The decoded response.
 * @returns A key summary such as `keys: activeWorkspaceId, role, workspaceType`.
 */
function bodyShape(json: unknown): string {
  if (Array.isArray(json)) return `a bare array of ${json.length}`
  if (!isRecord(json)) return 'no object body'
  const keys = Object.keys(json).sort().slice(0, 8)
  return keys.length === 0 ? 'an empty object' : `keys: ${keys.join(', ')}`
}

/**
 * Read the workspace id the coding-plan endpoint is addressed by.
 *
 * TWO READS, in this order, because the console itself does not use one:
 *
 * 1. `GET {amr}/workspaces/current` — the workspace this account is on right now,
 *    the object the console's own switcher starts from. The id is read from
 *    `activeWorkspaceId`, then `workspaceId`, then `id`, then the same keys under
 *    a nested `workspace`, then the same order again under a `data` wrapper.
 * 2. Only when that states NO id, `GET {amr}/workspaces` — the listing, which
 *    answers what the account could switch to rather than where it is. Its
 *    first entry with an id wins, and every wrapper shape it has been seen in is
 *    accepted (bare array, `{ workspaces }`, `{ items }`, `{ data }`,
 *    `{ data: { items | workspaces } }`).
 *
 * The listing used to be the ONLY read here, and on a live account it answered
 * 200 with a body whose entries carried no id: the lookup must therefore say
 * WHICH endpoint failed and what it looked like, or the next attempt is blind.
 * A failure reports the endpoint, its HTTP status (or the transport error) and a
 * keys-only shape summary; no value and no id ever appears in it.
 *
 * Pure data in, data out: a refusal, a timeout or a malformed body is returned as
 * `error`, never thrown, and a transport failure on the first read does not stop
 * the second from answering. The caller composes the result into the account
 * reading, so one unreadable surface cannot take the whole quota read down.
 *
 * @param options.fetchFn - Injected fetch (tests never reach the network).
 * @param options.controlKey - The OAuth account's `vela_ctrl_…` key.
 * @param options.apiBase - Control-plane base; overridable for a deployment.
 * @param options.signal - Caller cancellation.
 * @param options.timeoutMs - Per-request budget.
 * @returns The id, or the reason neither endpoint stated one.
 */
export async function fetchWorkspaceId({
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
}): Promise<OpenDesignWorkspaceIdRead> {
  const base = trimBase(apiBase)
  const notes: string[] = []
  /** One read, with its outcome kept as a NOTE: a throw here must not hide the next one. */
  const probe = async (path: string): Promise<OpenDesignHttpResult | null> => {
    try {
      return await sendJSON(fetchFn, `${base}${path}`, { apiKey: controlKey, signal, timeoutMs })
    } catch (error) {
      notes.push(`GET ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
  /** One endpoint's diagnostic line: what was called, what it answered, what shape. */
  const noteOf = (path: string, result: OpenDesignHttpResult): string => (
    result.ok
      ? `GET ${path} HTTP ${result.status}, ${bodyShape(result.json)}`
      : `GET ${path} ${httpRefusal(result.status, result.json, result.text)}, ${bodyShape(result.json)}`
  )
  try {
    // 1. The active workspace. Its id is the answer; nothing else is needed.
    const current = await probe(CURRENT_WORKSPACE_PATH)
    if (current !== null) {
      if (current.ok) {
        const body = current.json
        const id = isRecord(body)
          ? workspaceIdIn(body) ?? (isRecord(body.data) ? workspaceIdIn(body.data) : null)
          : null
        if (id !== null) return { ok: true, id, error: '' }
      }
      notes.push(noteOf(CURRENT_WORKSPACE_PATH, current))
    }
    // 2. The listing, only when the read above stated no id.
    const list = await probe(WORKSPACES_PATH)
    if (list !== null) {
      if (list.ok) {
        const id = listedWorkspaceId(list.json)
        if (id !== null) return { ok: true, id, error: '' }
      }
      notes.push(noteOf(WORKSPACES_PATH, list))
    }
    return {
      ok: false,
      id: null,
      error: `the workspaces endpoint listed no workspace id (${notes.join('; ')})`,
    }
  } catch (error) {
    return { ok: false, id: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The tiers this line knows how to name; anything else is "unknown", never a guess. */
const CODING_PLAN_TIERS: readonly string[] = ['go', 'plus', 'pro', 'max']

/**
 * One window read strictly: a field that does not state what the card needs
 * makes the whole window unreadable, and an unreadable window is dropped rather
 * than patched with a plausible default. A guessed `limitCredits` is a made-up
 * denominator on a progress bar, which is precisely the failure this contract
 * exists to prevent.
 *
 * @param raw - One entry of the response's `windows`.
 * @returns The window, or null when any field it needs was not stated.
 */
function codingPlanWindowOf(raw: unknown): OpenDesignCodingPlanWindowDto | null {
  if (!isRecord(raw)) return null
  const policyId = pickString(raw, ['policyId'])
  if (policyId === undefined) return null
  const durationSeconds = raw.durationSeconds
  if (typeof durationSeconds !== 'number' || !Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) return null
  const remainingCredits = raw.remainingCredits
  if (typeof remainingCredits !== 'string' || !/^\d+$/.test(remainingCredits)) return null
  const limitCredits = raw.limitCredits
  if (typeof limitCredits !== 'string' || !/^\d+$/.test(limitCredits)) return null
  // Both sides have to be real amounts: a digit string that overflows to
  // Infinity cannot be divided by, and a zero limit is no denominator at all.
  const limit = Number(limitCredits)
  if (!Number.isFinite(limit) || limit <= 0) return null
  if (!Number.isFinite(Number(remainingCredits))) return null
  const reset = codingPlanResetOf(raw.resetsAt)
  if (reset === undefined) return null
  return { policyId, durationSeconds, remainingCredits, limitCredits, resetsAt: reset }
}

/**
 * A window's reset instant as the DTO states it.
 *
 * Absent and `null` both mean "the service stated no reset" and are kept as
 * null; a string has to parse as an instant, and anything else (a number, a
 * sentence) is `undefined` — the sentinel that makes the window unreadable.
 *
 * @param value - The raw field.
 * @returns The ISO string, null for "not stated", or undefined for "unreadable".
 */
function codingPlanResetOf(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : undefined
}

/**
 * One credential shape to try against the coding-plan endpoint.
 *
 * `label` is the only part allowed to reach a message, a card or a log: it names
 * the SHAPE (which header carried which kind of key), never the key itself.
 */
interface CodingPlanCredentialAttempt {
  /** How a failure record names this shape. */
  label: string
  /** The Bearer this request carries; the empty string means no Authorization. */
  apiKey: string
  /** Extra headers this shape needs. */
  headers: Record<string, string>
}

/**
 * The credential shapes to try, in order, for one coding-plan read.
 *
 * The console signs this call with a browser SESSION (`credentials: "include"`),
 * so which of this line's two keys the endpoint accepts is not public: a control
 * key returned 401 live, which is exactly the ambiguity this list settles by
 * trying rather than by guessing. The order is "most likely intended first":
 * the control key already reads the rest of the control plane, the runtime key is
 * the gateway's own, and `x-api-key` is the spelling some routes use instead of
 * a Bearer.
 *
 * A runtime key of `''` (a pasted key account, or a credential that never got
 * one) leaves the first shape alone rather than sending an empty header.
 *
 * @param controlKey - The account's `vela_ctrl_…` key.
 * @param runtimeKey - The account's `sk-amr-…` key, or ''.
 * @returns The shapes to try, one to three.
 */
function codingPlanAttempts(controlKey: string, runtimeKey: string): CodingPlanCredentialAttempt[] {
  const attempts: CodingPlanCredentialAttempt[] = [
    { label: 'bearer control key', apiKey: controlKey, headers: {} },
  ]
  const runtime = runtimeKey.trim()
  if (runtime === '') return attempts
  attempts.push({ label: 'bearer runtime key', apiKey: runtime, headers: {} })
  // No Authorization at all here: a route that reads `x-api-key` may reject a
  // Bearer it did not ask for, so this shape must not send one.
  attempts.push({ label: 'x-api-key runtime key', apiKey: '', headers: { 'x-api-key': runtime } })
  return attempts
}

/**
 * A successful response body as the DTO.
 *
 * @param json - The decoded body.
 * @returns The plan, with `error` empty and only the windows that survived.
 */
function codingPlanOf(json: unknown): OpenDesignCodingPlanDto {
  const body = isRecord(json) ? json : {}
  const windows: OpenDesignCodingPlanWindowDto[] = []
  for (const row of Array.isArray(body.windows) ? body.windows : []) {
    const window = codingPlanWindowOf(row)
    if (window !== null) windows.push(window)
  }
  const tierText = typeof body.tier === 'string' ? body.tier.trim().toLowerCase() : ''
  return {
    tier: CODING_PLAN_TIERS.includes(tierText) ? tierText : null,
    windows,
    error: '',
  }
}

/**
 * Read one account's Design Plan allowance.
 *
 * This is the line's REAL quota surface — the 5-hour and 7-day windows the
 * console draws as "剩余 90% / 81%" — and it is the only endpoint that states a
 * bounded window at all: `/billing/summary` states credits and a tier, never a
 * rolling allowance.
 *
 * `GET {amr}/workspaces/{id}/billing/coding-plan-usage`, always the same URL with
 * the same `x-vela-workspace-id`, tried once per credential SHAPE (see
 * {@link codingPlanAttempts}). The retry rule is the important half: only
 * `401` / `403` — "these credentials are not accepted" — moves on to the next
 * shape, because that is the only verdict a different key could change. A `404` or
 * a `500`, and in particular `coding_plan_configuration_unavailable`, is the
 * endpoint's own verdict about the WORKSPACE, so it stops the search and travels
 * out verbatim.
 *
 * Exhausting every shape yields one sentence a user can act on: the last refusal
 * plus the shapes that were tried. A success carries NO trace of which credential
 * worked — the shape of a credential is not the card's business.
 *
 * It never throws and never fills a window nobody measured.
 *
 * @param options.fetchFn - Injected fetch.
 * @param options.controlKey - The account's `vela_ctrl_…` key.
 * @param options.runtimeKey - The account's `sk-amr-…` key; `''` skips the two
 *   shapes that need one.
 * @param options.workspaceId - From {@link fetchWorkspaceId}.
 * @param options.apiBase - Control-plane base.
 * @param options.signal - Caller cancellation.
 * @param options.timeoutMs - Per-request budget.
 * @returns The plan, or the reason every shape it knew failed.
 */
export async function fetchCodingPlanUsage({
  fetchFn,
  controlKey,
  runtimeKey,
  workspaceId,
  apiBase = AMR_API_BASE,
  signal,
  timeoutMs = 15_000,
}: {
  fetchFn: typeof fetch
  controlKey: string
  runtimeKey: string
  workspaceId: string
  apiBase?: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<OpenDesignCodingPlanDto> {
  const url = `${trimBase(apiBase)}${WORKSPACES_PATH}/${encodeURIComponent(workspaceId)}${CODING_PLAN_USAGE_SUFFIX}`
  const tried: string[] = []
  let refusal = ''
  try {
    for (const attempt of codingPlanAttempts(controlKey, runtimeKey)) {
      const result = await sendJSON(fetchFn, url, {
        apiKey: attempt.apiKey,
        signal,
        timeoutMs,
        headers: { 'x-vela-workspace-id': workspaceId, ...attempt.headers },
      })
      if (result.ok) return codingPlanOf(result.json)
      refusal = httpRefusal(result.status, result.json, result.text)
      // A credential refusal is the one answer another shape could change.
      if (result.status !== 401 && result.status !== 403) {
        return { tier: null, windows: [], error: refusal }
      }
      tried.push(attempt.label)
    }
    return {
      tier: null,
      windows: [],
      error: (refusal === '' ? 'the coding plan could not be read' : refusal) + ` (tried: ${tried.join('; ')})`,
    }
  } catch (error) {
    return { tier: null, windows: [], error: error instanceof Error ? error.message : String(error) }
  }
}
