/**
 * Transport for the Cline gateway and its public catalogs. Transport only: no
 * pinning, retry, or failover policy lives here (see `adapter.ts`).
 *
 * - `POST {baseURL}/chat/completions` — the gateway
 * - `GET  {baseURL}/models` — the gateway's own catalog
 * - `GET  {baseURL}/users/me/plan/usage-limits` — the account's quota windows
 * - `GET  api.cline.bot/…/recommended-models` — official subscription list
 * - `GET  models.dev/api.json` — community registry, a metadata backstop
 * - `GET  ai-gateway.vercel.sh/v1/models` — the upstream's own catalog
 * - `GET  openrouter.ai/api/v1/…` — endpoint detail for direct-pipeline models
 *
 * @module dsh-chatgpt-subscription/cline-pass-client
 */
import {
  MODELS_DEV_URL,
  OPENROUTER_API,
  RECOMMENDED_MODELS_URL,
  USAGE_LIMITS_PATH,
  VERCEL_MODELS_URL,
  REASONING_EFFORTS,
  type ClinePassCatalogScan,
  type ClinePassDiscoveredModel,
} from './types.ts'

export interface ClinePassHttpResult {
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

/** The gateway's own chat-completions endpoint for one base URL. */
export function chatURL(baseURL: string): string {
  return `${trimBase(baseURL)}/chat/completions`
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
): Promise<ClinePassHttpResult> {
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

/** Send one chat completion, non-streaming. */
export async function chatCompletion({
  fetchFn,
  baseURL,
  apiKey,
  body,
  signal,
  timeoutMs = 180_000,
}: {
  fetchFn: typeof fetch
  baseURL: string
  apiKey: string
  body: unknown
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<ClinePassHttpResult> {
  return await sendJSON(fetchFn, chatURL(baseURL), { method: 'POST', apiKey, body, signal, timeoutMs })
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

/** The metadata one catalog source publishes about a model. */
function modelMetadata(entry: Record<string, unknown>): ClinePassDiscoveredModel {
  const meta: ClinePassDiscoveredModel = {}
  const name = entry.name
  if (typeof name === 'string' && name.trim().length > 0) meta.name = name.trim()
  const modalities = isRecord(entry.modalities) ? entry.modalities.input : entry.input
  if (Array.isArray(modalities)) {
    const input = modalities.filter((value): value is string => typeof value === 'string' && value.length > 0)
    if (input.length > 0) {
      if (isRecord(entry.modalities)) meta.inputModalities = input
      else meta.input = input
    }
  }
  const contextWindow = isRecord(entry.limit) ? entry.limit.context : entry.contextWindow
  if (typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0) meta.contextWindow = contextWindow
  const maxTokens = isRecord(entry.limit) ? entry.limit.output : entry.maxTokens
  if (typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0) meta.maxTokens = maxTokens
  return meta
}

/**
 * The reasoning levels one model offers, from the upstream's `reasoning_options`.
 *
 * A `toggle` entry is the model's on/off switch, which in the harness vocabulary
 * is `none`. A model published with only a toggle names no levels at all, so it
 * returns undefined rather than an invented list — narrowing it to a lone `none`
 * would take away the switch the catalog just described.
 */
function effortsFromOptions(options: unknown): string[] | undefined {
  if (!Array.isArray(options)) return undefined
  const levels = new Set<string>()
  let toggle = false
  for (const option of options) {
    if (!isRecord(option)) continue
    if (option.type === 'toggle') toggle = true
    if (option.type !== 'effort' || !Array.isArray(option.values)) continue
    for (const value of option.values) if (typeof value === 'string' && value.length > 0) levels.add(value)
  }
  if (levels.size === 0) return undefined
  if (toggle) levels.add('none')
  const ordered = REASONING_EFFORTS.map((effort) => effort.id).filter((id) => levels.has(id))
  return ordered.length > 0 ? ordered : undefined
}

/** List the gateway's own catalog ids; an empty array when the call fails. */
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
}): Promise<string[]> {
  try {
    const result = await sendJSON(fetchFn, `${trimBase(baseURL)}/models`, { apiKey, signal, timeoutMs })
    const data = isRecord(result.json) && Array.isArray(result.json.data) ? result.json.data : []
    return data.map((model) => (isRecord(model) ? model.id : undefined)).filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

/** One quota window as the gateway reports it. */
export interface ClinePassRawUsageLimit {
  type: string
  percentUsed: number
  resetsAt: string
}

/**
 * Read the account's official quota consumption.
 *
 * The gateway answers with `{ success, data: { limits: [{ type, percentUsed,
 * resetsAt }] } }`, where `type` is `five_hour`, `weekly` or `monthly`. A refusal
 * is reported as data, never thrown: the card shows quota beside controls that
 * keep working without it.
 */
export async function fetchUsageLimits({
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
}): Promise<{ ok: boolean; limits: ClinePassRawUsageLimit[]; error: string }> {
  const refusal = { ok: false, limits: [] as ClinePassRawUsageLimit[], error: 'the usage endpoint is unavailable' }
  try {
    const result = await sendJSON(fetchFn, `${trimBase(baseURL)}${USAGE_LIMITS_PATH}`, { apiKey, signal, timeoutMs })
    if (!result.ok) {
      const detail = firstMessage(result.json) ?? result.text.slice(0, 120)
      return { ...refusal, error: `the usage endpoint answered HTTP ${result.status}${detail === '' ? '' : `: ${detail}`}` }
    }
    // The envelope wrapper is not contractual: read the payload whether the
    // gateway nests it under `data` or answers with the window list itself.
    const payload = isRecord(result.json) && isRecord(result.json.data) ? result.json.data : result.json
    const limits = (isRecord(payload) && Array.isArray(payload.limits) ? payload.limits : [])
      .map((limit) => ({
        type: String(isRecord(limit) ? limit.type ?? '' : ''),
        percentUsed: Number(isRecord(limit) ? limit.percentUsed ?? 0 : 0),
        resetsAt: String(isRecord(limit) ? limit.resetsAt ?? '' : ''),
      }))
      .filter((limit) => limit.type.length > 0)
    return { ok: true, limits, error: firstMessage(result.json) ?? '' }
  } catch (error) {
    return { ...refusal, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The gateway's own one-line explanation, when it sent one. */
function firstMessage(envelope: unknown): string {
  if (!isRecord(envelope)) return ''
  const message = envelope.error ?? envelope.message
  if (typeof message === 'string') return message.slice(0, 200)
  if (isRecord(message) && typeof message.message === 'string') return message.message.slice(0, 200)
  return ''
}

/**
 * Collect `cline-pass/*` ids and metadata from the official endpoints and the
 * community registry. Additive by design: a source that fails is skipped.
 */
export async function fetchOfficialModels({
  fetchFn,
  signal,
  timeoutMs = 30_000,
}: {
  fetchFn: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<ClinePassCatalogScan> {
  const found = new Map<string, ClinePassDiscoveredModel>()
  const sources: string[] = []
  /** Keep the first metadata a source supplies; both sources are advisory. */
  const add = (value: unknown): void => {
    const id = typeof value === 'string' ? value : isRecord(value) ? value.id : undefined
    if (typeof id !== 'string') return
    const normalized = id.trim().toLowerCase()
    if (!normalized.startsWith('cline-pass/')) return
    const incoming = typeof value === 'string' ? {} : modelMetadata(value as Record<string, unknown>)
    const existing = found.get(normalized)
    found.set(normalized, existing === undefined ? incoming : { ...incoming, ...existing })
  }
  try {
    const response = await fetchFn(RECOMMENDED_MODELS_URL, { signal: withTimeout(signal, timeoutMs) })
    if (response.ok) {
      const json = await response.json() as unknown
      const list = isRecord(json)
        ? (Array.isArray(json.clinePass) ? json.clinePass : isRecord(json.data) && Array.isArray(json.data.clinePass) ? json.data.clinePass : undefined)
        : undefined
      if (Array.isArray(list) && list.length > 0) {
        list.forEach(add)
        sources.push('cline.api')
      }
    }
  } catch { /* source unavailable */ }
  try {
    const response = await fetchFn(MODELS_DEV_URL, { signal: withTimeout(signal, timeoutMs) })
    if (response.ok) {
      const json = await response.json() as unknown
      const providers = isRecord(json) && isRecord(json.providers) ? json.providers : json
      const provider = isRecord(providers) && isRecord(providers['cline-pass']) ? providers['cline-pass'] : undefined
      if (provider !== undefined && isRecord(provider.models)) {
        for (const [id, entry] of Object.entries(provider.models)) {
          add({ ...(isRecord(entry) ? entry : {}), id: id.startsWith('cline-pass/') ? id : `cline-pass/${id}` })
        }
        sources.push('models.dev')
      }
    }
  } catch { /* source unavailable */ }
  // The upstream's own catalog, matched by the id's tail: `cline-pass/glm-5.3`
  // and `zai/glm-5.3` are the same model reached through the same gateway. It is
  // also the only source that describes a model published after this release.
  //
  // Its output cap is deliberately NOT taken: it disagrees with the published one
  // and it moves, and adopting it would silently resize every request's
  // completion reserve.
  const upstreamByTail = new Map<string, ClinePassDiscoveredModel>()
  try {
    const response = await fetchFn(VERCEL_MODELS_URL, { signal: withTimeout(signal, timeoutMs) })
    if (response.ok) {
      const json = await response.json() as unknown
      const rows = isRecord(json) && Array.isArray(json.data) ? json.data : isRecord(json) && Array.isArray(json.models) ? json.models : []
      for (const row of rows) {
        if (!isRecord(row) || typeof row.id !== 'string') continue
        const meta = modelMetadata(row)
        const contextWindow = row.context_window ?? row.contextWindow
        if (typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0) meta.contextWindow = contextWindow
        const efforts = effortsFromOptions(row.reasoning_options)
        if (efforts !== undefined) meta.efforts = efforts
        if (Object.keys(meta).length > 0) upstreamByTail.set(row.id.split('/').pop() ?? '', meta)
      }
      if (upstreamByTail.size > 0) sources.push('vercel')
    }
  } catch { /* source unavailable */ }
  const models = [...found.keys()].filter((id) => /^cline-pass\/[a-z0-9._-]+$/.test(id))
  const catalog: Record<string, ClinePassDiscoveredModel> = {}
  for (const id of models) {
    const meta = found.get(id) ?? {}
    const upstream = upstreamByTail.get(id.slice('cline-pass/'.length))
    if (upstream === undefined) {
      if (Object.keys(meta).length > 0) catalog[id] = meta
      continue
    }
    // Gap filler, not an override: a source that did describe a field keeps it.
    const entry: ClinePassDiscoveredModel = { ...upstream, ...meta }
    // The exception is the name: the id list's "name" is the id itself and says
    // nothing, while the upstream publishes the label a person reads.
    if (upstream.name !== undefined && (entry.name === undefined || entry.name === id || entry.name === id.slice('cline-pass/'.length))) {
      entry.name = upstream.name
    }
    catalog[id] = entry
  }
  return { models, catalog, sources }
}

/** Resolve a canonical slug against OpenRouter's public catalog. */
export async function resolveOpenRouterSlug(
  fetchFn: typeof fetch,
  slug: string,
  { signal, timeoutMs = 30_000 }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  try {
    const result = await sendJSON(fetchFn, `${OPENROUTER_API}/models`, { signal, timeoutMs })
    const data = isRecord(result.json) && Array.isArray(result.json.data) ? result.json.data : []
    const ids = data.map((model) => (isRecord(model) ? model.id : undefined)).filter((id): id is string => typeof id === 'string')
    const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')
    return ids.find((id) => id === slug) ?? ids.find((id) => normalize(id) === normalize(slug)) ?? null
  } catch {
    return null
  }
}

/** One upstream endpoint detail, as OpenRouter reports it. */
export interface ClinePassEndpointDetail {
  slug: string
  name: string
  endpoints: number
  context: number
  uptime: number
}

/** Per-upstream endpoint detail (context length, recent uptime) for one model. */
export async function openRouterEndpoints(
  fetchFn: typeof fetch,
  slug: string,
  { signal, timeoutMs = 30_000 }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ slug: string; endpoints: ClinePassEndpointDetail[] }> {
  const real = await resolveOpenRouterSlug(fetchFn, slug, { signal, timeoutMs })
  if (real === null) return { slug, endpoints: [] }
  try {
    const result = await sendJSON(fetchFn, `${OPENROUTER_API}/models/${real}/endpoints`, { signal, timeoutMs })
    const payload = isRecord(result.json) && isRecord(result.json.data) ? result.json.data : undefined
    const rows = payload !== undefined && Array.isArray(payload.endpoints) ? payload.endpoints : []
    const detail = new Map<string, ClinePassEndpointDetail>()
    for (const entry of rows) {
      if (!isRecord(entry)) continue
      const providerSlug = String(entry.tag ?? '').split('/')[0] || String(entry.provider_name ?? '').toLowerCase().replace(/\s+/g, '-')
      if (providerSlug === '') continue
      const current = detail.get(providerSlug) ?? {
        slug: providerSlug,
        name: String(entry.provider_name ?? providerSlug),
        endpoints: 0,
        context: 0,
        uptime: 0,
      }
      current.endpoints += 1
      current.context = Math.max(current.context, Number(entry.context_length ?? 0))
      current.uptime = Math.max(current.uptime, Math.round(Number(entry.uptime_last_30m ?? 0)))
      detail.set(providerSlug, current)
    }
    return { slug: real, endpoints: [...detail.values()] }
  } catch {
    return { slug: real, endpoints: [] }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
