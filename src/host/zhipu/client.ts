import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ZhipuAccount,
  ZhipuAccountQuota,
  ZhipuMeter,
  ZhipuQuotaWindow,
} from '../../shared/zhipu-contracts.ts'
import {
  CATALOG_CACHE_TTL_MS,
  CHAT_PATH,
  DEFAULT_CONTEXT_WINDOW,
  DISCOVERY_TIMEOUT_MS,
  ERROR_CODE,
  MODELS_PATH,
  PLUGIN_USER_AGENT,
  PROVIDER_NAME,
  QUOTA_CACHE_TTL_MS,
  QUOTA_PATH,
  SUBSCRIPTION_PATH,
  apiBaseForRegion,
  regionForBaseUrl,
} from './types.ts'
import {
  FileCredentialStore,
  zhipuAccountKey,
  zhipuKeyHint,
  type ZhipuCredentials,
} from './token-store.ts'
import { ZHIPU_MODELS, resolveZhipuModel, type ZhipuModelEntry } from './model-catalog.ts'

export interface ZhipuRequestOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[,\s%]/g, ''))
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Headers one model request carries.
 *
 * The chat surface uses the documented bearer form. The key never appears in a
 * log line: only the response body and status are ever reported.
 */
export function zhipuHeaders(
  credentials: Pick<ZhipuCredentials, 'apiKey'>,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${credentials.apiKey}`,
    'user-agent': PLUGIN_USER_AGENT,
    ...extra,
  }
}

/**
 * Headers the monitor/subscription surfaces carry.
 *
 * These two answer to the **raw** key with no `Bearer` prefix, which is the
 * scheme the plan's own usage page uses: measured live, a request carrying the
 * prefixed form is rejected with `code 401` where the raw form authenticates.
 */
export function zhipuMonitorHeaders(
  apiKey: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: apiKey,
    'user-agent': PLUGIN_USER_AGENT,
    'accept-language': 'en-US,en',
    ...extra,
  }
}

/** Public account facts for the settings card. */
export function accountFromCredentials(credentials: ZhipuCredentials): ZhipuAccount {
  return {
    id: zhipuAccountKey(credentials),
    keyHint: zhipuKeyHint(credentials.apiKey),
    email: null,
    planLabel: credentials.planLabel ?? null,
    region: credentials.region,
    apiBase: credentials.apiBase || apiBaseForRegion(credentials.region),
    authenticatedAt: credentials.authenticatedAt ?? null,
  }
}

/**
 * Read the platform's own envelope error out of a business-level refusal.
 *
 * These two surfaces answer HTTP 200 with `success: false` and a numeric `code`
 * for an authentication problem, so a caller that only checks `response.ok`
 * would treat a rejected key as a successful read. Returns null when the body
 * is not a refusal.
 */
export function readEnvelopeError(payload: unknown): { code: number | null; message: string } | null {
  const root = asRecord(payload)
  if (root === undefined) return null
  if (root.success === true) return null
  const code = asNumber(root.code)
  const message = asString(root.msg) ?? asString(root.message) ?? 'no detail'
  // `success` is the platform's own flag; a body without it is only a refusal
  // when it carries a non-zero business code.
  if (root.success === false || (code !== undefined && code !== 0)) {
    return { code: code ?? null, message }
  }
  return null
}

/**
 * Verify one key by asking the model listing for it.
 *
 * The listing is the cheapest authenticated read on the Coding Plan surface and
 * is the same host the chat requests go to, so a success proves the key works
 * on the deployment it was entered for. A key from the wrong console (a general
 * open-platform key, or one issued by the other region) is rejected here rather
 * than failing later inside a conversation.
 *
 * @returns the live catalog this read produced, so a caller that verifies does
 *   not have to fetch it again.
 */
export async function verifyApiKey(
  apiKey: string,
  region: ZhipuCredentials['region'],
  options: ZhipuRequestOptions = {},
): Promise<ZhipuModelEntry[]> {
  const fetchFn = options.fetchFn ?? fetch
  const apiBase = apiBaseForRegion(region)
  let response: Response
  try {
    response = await fetchFn(`${apiBase}${MODELS_PATH}`, {
      headers: zhipuHeaders({ apiKey }, { accept: 'application/json' }),
      signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
    })
  } catch (error) {
    throw new LlmError(
      `${PROVIDER_NAME} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      'TRANSPORT',
      { cause: error },
    )
  }

  const text = await response.text().catch(() => '')
  // Where the key must have come from. A general open-platform key, or one
  // issued by the other deployment, authenticates nowhere on this surface —
  // which is the most common mistake with this product.
  const consoleHint = `Check that the key comes from the ${consoleName(region)} console and that a GLM Coding Plan is active.`
  if (!response.ok) {
    throw new LlmError(
      `${PROVIDER_NAME} rejected the API key (${response.status}). ${consoleHint}`
      + `${text ? ` ${text.slice(0, 300)}` : ''}`,
      response.status === 401 || response.status === 403 ? 'INVALID_CREDENTIAL' : 'PROVIDER_ERROR',
      { status: response.status },
    )
  }

  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    throw new LlmError(`${PROVIDER_NAME} returned an unreadable model listing`, 'PROVIDER_ERROR')
  }
  const refusal = readEnvelopeError(payload)
  if (refusal !== null) {
    // How the platform usually reports a bad key: HTTP 200 carrying its own
    // envelope, so it needs the same console guidance as a status-line refusal.
    throw new LlmError(
      `${PROVIDER_NAME} rejected the API key: ${refusal.message}. ${consoleHint}`,
      'INVALID_CREDENTIAL',
    )
  }
  return parseCatalogModels(payload, region)
}

/** Console the user must have created the key on, named as it appears there. */
export function consoleName(region: ZhipuCredentials['region']): string {
  return region === 'cn' ? '智谱开放平台 (open.bigmodel.cn)' : 'Z.ai (api.z.ai)'
}

/**
 * Parse one `/models` payload.
 *
 * The listing reports each model's context window. It is merged over the
 * shipped table, which stays the authority on the reasoning ladder and on image
 * support: the listing states a window but not a capability, so a field it
 * omits keeps the value this table declares rather than becoming a guess.
 */
export function parseCatalogModels(payload: unknown, region: ZhipuCredentials['region']): ZhipuModelEntry[] {
  const root = asRecord(payload) ?? {}
  const list = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : []
  const models: ZhipuModelEntry[] = []
  for (const item of list) {
    const record = asRecord(item)
    if (record === undefined) continue
    const id = asString(record.id)
    if (id === undefined) continue
    const known = resolveZhipuModel(id)
    // A window the listing reports wins; anything else keeps the shipped fact.
    const contextWindow = asNumber(record.context_window)
      ?? asNumber(record.contextWindow)
      ?? asNumber(record.max_input_tokens)
      ?? known.contextWindow
    models.push({
      ...known,
      id,
      name: asString(record.name) ?? known.name,
      contextWindow: contextWindow > 0 ? contextWindow : known.contextWindow,
      // The listing is region-scoped by construction: every entry it returns is
      // one this deployment serves, which is exactly what the filter reads.
      regions: known.regions.includes(region) ? known.regions : [...known.regions, region],
    })
  }
  return models
}

// ---------------------------------------------------------------------------
// Live model catalog cache
// ---------------------------------------------------------------------------

let cachedCatalog: { region: ZhipuCredentials['region']; models: ZhipuModelEntry[]; fetchedAt: number } | undefined
let catalogInFlight: Promise<ZhipuModelEntry[]> | null = null
let catalogInFlightRegion: ZhipuCredentials['region'] | null = null

export function getCachedCatalog(): ZhipuModelEntry[] {
  return cachedCatalog?.models ?? []
}

export function clearCachedCatalog(): void {
  cachedCatalog = undefined
  catalogInFlight = null
  catalogInFlightRegion = null
}

/**
 * Fetch the live catalog for one account.
 *
 * A failure returns an empty list and the caller falls back to the shipped
 * table, which keeps a first run usable before sign-in.
 */
export async function fetchCatalog(
  credentials: ZhipuCredentials,
  options: ZhipuRequestOptions = {},
): Promise<ZhipuModelEntry[]> {
  return verifyApiKey(credentials.apiKey, credentials.region, options)
}

/**
 * Cached catalog with a TTL; a failed refresh keeps the previous snapshot.
 *
 * A snapshot read for the *other* region must never stand in: its entries
 * declare only the region they came from, so the caller's region filter would
 * drop every one of them and the picker would offer nothing instead of falling
 * back to the shipped table.
 */
export async function loadCatalog(
  credentials: ZhipuCredentials,
  options: ZhipuRequestOptions & { force?: boolean } = {},
): Promise<ZhipuModelEntry[]> {
  if (!options.force
    && cachedCatalog !== undefined
    && cachedCatalog.region === credentials.region
    && Date.now() - cachedCatalog.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return cachedCatalog.models
  }
  if (catalogInFlight && catalogInFlightRegion === credentials.region) return catalogInFlight
  const sameRegionCache = (): ZhipuModelEntry[] =>
    cachedCatalog?.region === credentials.region ? cachedCatalog.models : []
  const request = fetchCatalog(credentials, options)
    .then((models) => {
      if (models.length > 0) {
        cachedCatalog = { region: credentials.region, models, fetchedAt: Date.now() }
        return models
      }
      return sameRegionCache()
    })
    .catch(() => sameRegionCache())
  catalogInFlight = request
  catalogInFlightRegion = credentials.region
  try {
    return await request
  } finally {
    if (catalogInFlight === request) {
      catalogInFlight = null
      catalogInFlightRegion = null
    }
  }
}

// ---------------------------------------------------------------------------
// Quota / allowance
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function formatAmount(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/**
 * Window length in minutes implied by one reported window.
 *
 * The monitor service describes a window by a unit and a number rather than by
 * a name: `unit 3 × number 5` is the plan's 5-hour credit window and
 * `unit 6 × number 1` is its weekly one. The exact unit vocabulary is not
 * documented, so this maps the two combinations the plan's own usage page shows
 * and derives minutes from anything else it does not recognise.
 */
export function windowMinutesOf(unit: number | undefined, number: number | undefined): number | null {
  if (unit === undefined || number === undefined || number <= 0) return null
  // The two documented combinations, checked first so they are exact.
  if (unit === 3 && number === 5) return 5 * 60
  if (unit === 6 && number === 1) return 7 * 24 * 60
  // Fallback: unit 1 is hours, unit 2 days, unit 3 hours, unit 6 days.
  if (unit === 1 || unit === 3) return number * 60
  if (unit === 2 || unit === 6) return number * 24 * 60
  return null
}

/** Turn one window length into the label the card shows. */
export function windowLabel(minutes: number | null, fallback: string): string {
  if (minutes === null) return fallback
  if (minutes === 5 * 60) return '5 小时额度'
  if (minutes === 7 * 24 * 60) return '每周额度'
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天额度`
  if (minutes % 60 === 0) return `${minutes / 60} 小时额度`
  return `${minutes} 分钟额度`
}

/** One parsed limit entry from the monitor service. */
export interface ParsedQuotaLimit {
  type: string
  unit: number | undefined
  number: number | undefined
  percentage: number | undefined
  currentValue: number | undefined
  total: number | undefined
  resetsAt: number | null
  usageDetails: Record<string, unknown> | undefined
}

/**
 * Parse the monitor payload's `limits` array.
 *
 * The plan's own page renders these directly. A limit is either a token/credit
 * window (`TOKENS_LIMIT`, renamed `CREDIT_LIMIT` in newer responses) or a
 * tool-call allowance (`TIME_LIMIT`); both shapes are read here rather than
 * pinned to one spelling, because the service has used both names.
 */
export function parseQuotaLimits(payload: unknown): ParsedQuotaLimit[] {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data) ?? root
  const list = Array.isArray(data.limits) ? data.limits : []
  const limits: ParsedQuotaLimit[] = []
  for (const item of list) {
    const record = asRecord(item)
    if (record === undefined) continue
    const type = asString(record.type) ?? ''
    if (type === '') continue
    const nextReset = asNumber(record.nextResetTime)
    limits.push({
      type,
      unit: asNumber(record.unit),
      number: asNumber(record.number),
      percentage: asNumber(record.percentage),
      currentValue: asNumber(record.currentValue),
      total: asNumber(record.usage) ?? asNumber(record.total),
      resetsAt: nextReset === undefined || nextReset <= 0 ? null : nextReset,
      usageDetails: asRecord(record.usageDetails),
    })
  }
  return limits
}

/** Whether a limit entry is a token/credit window under either spelling. */
export function isTokenLimit(type: string): boolean {
  return type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT'
}

/** Whether a limit entry is a tool-call allowance. */
export function isToolLimit(type: string): boolean {
  return type === 'TIME_LIMIT'
}

/** Build the window list the card renders from the parsed limits. */
export function quotaWindows(limits: readonly ParsedQuotaLimit[]): ZhipuQuotaWindow[] {
  const windows: ZhipuQuotaWindow[] = []
  for (const limit of limits) {
    if (!isTokenLimit(limit.type)) continue
    const minutes = windowMinutesOf(limit.unit, limit.number)
    const usedFraction = limit.percentage === undefined ? null : clamp01(limit.percentage / 100)
    windows.push({
      id: `tokens-${limit.unit ?? 'u'}-${limit.number ?? 'n'}`,
      label: windowLabel(minutes, 'Token 额度'),
      usedFraction,
      remainingFraction: usedFraction === null ? null : Math.max(0, 1 - usedFraction),
      used: formatAmount(limit.currentValue),
      limit: formatAmount(limit.total),
      resetsAt: limit.resetsAt,
      windowMinutes: minutes,
      description: null,
    })
  }
  return windows
}

/** Build the meter list the card renders, windows and tool allowance together. */
export function quotaMeters(windows: readonly ZhipuQuotaWindow[], limits: readonly ParsedQuotaLimit[]): ZhipuMeter[] {
  const meters: ZhipuMeter[] = windows.map((window) => ({
    id: window.id,
    label: window.label,
    usedFraction: window.usedFraction,
    remainingFraction: window.remainingFraction,
    used: window.used,
    limit: window.limit,
    resetsAt: window.resetsAt,
    description: window.windowMinutes === null ? null : `${window.windowMinutes} 分钟窗口`,
  }))

  for (const limit of limits) {
    if (!isToolLimit(limit.type)) continue
    const usedFraction = limit.percentage === undefined ? null : clamp01(limit.percentage / 100)
    meters.push({
      id: 'tools-month',
      label: 'MCP 工具调用（月度）',
      usedFraction,
      remainingFraction: usedFraction === null ? null : Math.max(0, 1 - usedFraction),
      used: formatAmount(limit.currentValue),
      limit: formatAmount(limit.total),
      resetsAt: limit.resetsAt,
      description: 'Web Search / Web Reader / Zread 等工具调用次数',
    })
  }
  return meters
}

/** Plan facts the subscription route reports. */
export interface ZhipuPlan {
  planName: string | null
  planLevel: string | null
  renewsAt: number | null
}

/**
 * Parse the plan payload.
 *
 * Best effort by design: the quota meters are what the card is for, so a
 * failure here must degrade to "no plan line" rather than blank the panel. The
 * subscription host returns the plan under `data`, and the level is reported
 * either as a machine name or as an expiry-bearing record; both shapes are read.
 */
export function parsePlan(payload: unknown): ZhipuPlan {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data) ?? root
  const records: Record<string, unknown>[] = []
  if (Array.isArray(data)) {
    for (const item of data) {
      const record = asRecord(item)
      if (record !== undefined) records.push(record)
    }
  } else {
    const single = asRecord(data)
    if (single !== undefined) records.push(single)
  }

  let planName: string | null = null
  let planLevel: string | null = null
  let renewsAt: number | null = null
  for (const record of records) {
    planName ??= asString(record.planName) ?? asString(record.name) ?? asString(record.productName) ?? null
    planLevel ??= asString(record.planLevel)
      ?? asString(record.level)
      ?? asString(record.planType)
      ?? asString(record.plan)
      ?? null
    const raw = asNumber(record.expireTime) ?? asNumber(record.expiredTime) ?? asNumber(record.renewTime)
    if (renewsAt === null && raw !== undefined && raw > 0) {
      // These arrive as epoch milliseconds; a seconds value is scaled so an
      // older response shape cannot render a date in 1970.
      renewsAt = raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw)
    }
  }
  return { planName, planLevel, renewsAt }
}

let cachedQuota: ZhipuAccountQuota | undefined
let quotaInFlight: Promise<ZhipuAccountQuota> | null = null
let quotaInFlightAccountId: string | null = null
let quotaCacheEpoch = 0

export function getCachedQuota(): ZhipuAccountQuota | undefined {
  return cachedQuota
}

export function clearCachedQuota(): void {
  quotaCacheEpoch += 1
  cachedQuota = undefined
  quotaInFlight = null
  quotaInFlightAccountId = null
}

/**
 * Read the account's plan allowance.
 *
 * Two routes answer this snapshot: the monitor route carries the windows, and
 * the subscription route carries the plan name. They are independent, so a
 * failure of the optional one must not blank the panel — but a failure of the
 * monitor route is a real failure and is raised, because a snapshot with no
 * windows would otherwise render as "nothing consumed".
 */
export async function fetchAccountQuota(
  credentials: ZhipuCredentials,
  options: ZhipuRequestOptions & { force?: boolean } = {},
): Promise<ZhipuAccountQuota> {
  const fetchFn = options.fetchFn ?? fetch
  const accountId = zhipuAccountKey(credentials)
  if (!options.force
    && cachedQuota
    && cachedQuota.account.id === accountId
    && Date.now() - (cachedQuota.fetchedAt || 0) < QUOTA_CACHE_TTL_MS) {
    return cachedQuota
  }
  // A poll already serving another account must not be reused after a switch.
  if (quotaInFlight && quotaInFlightAccountId === accountId) return quotaInFlight

  const epoch = quotaCacheEpoch
  const request = (async (): Promise<ZhipuAccountQuota> => {
    const response = await fetchFn(`${credentials.apiBase}${QUOTA_PATH}`, {
      headers: zhipuMonitorHeaders(credentials.apiKey),
      signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      throw new Error(`${PROVIDER_NAME} quota lookup failed (${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`)
    }
    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      throw new Error(`${PROVIDER_NAME} quota lookup returned unreadable data`)
    }
    const refusal = readEnvelopeError(payload)
    if (refusal !== null) {
      // A rejected key here is the same verdict the model route would give, so
      // it is reported the same way and the card can offer a re-sign-in.
      throw new Error(`${PROVIDER_NAME} quota lookup was rejected: ${refusal.message}`)
    }

    const limits = parseQuotaLimits(payload)
    const windows = quotaWindows(limits)
    const meters = quotaMeters(windows, limits)

    // The plan line is optional: it must not be able to fail the snapshot.
    let plan: ZhipuPlan = { planName: null, planLevel: null, renewsAt: null }
    const sources = ['monitor/usage/quota/limit']
    try {
      const planResponse = await fetchFn(`${credentials.apiBase}${SUBSCRIPTION_PATH}`, {
        headers: zhipuMonitorHeaders(credentials.apiKey),
        signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
      })
      if (planResponse.ok) {
        const planPayload = JSON.parse(await planResponse.text()) as unknown
        if (readEnvelopeError(planPayload) === null) {
          plan = parsePlan(planPayload)
          sources.push('biz/subscription/list')
        }
      }
    } catch {
      // Best effort only: the meters above are already complete.
    }

    const snapshot: ZhipuAccountQuota = {
      account: accountFromCredentials({
        ...credentials,
        ...(plan.planName === null ? {} : { planLabel: plan.planName }),
        ...(plan.planLevel === null ? {} : { planLevel: plan.planLevel }),
      }),
      planName: plan.planName,
      planLevel: plan.planLevel,
      renewsAt: plan.renewsAt,
      meters,
      windows,
      fetchedAt: Date.now(),
      sources,
    }

    if (epoch !== quotaCacheEpoch) return snapshot
    cachedQuota = snapshot
    return snapshot
  })()

  quotaInFlight = request
  quotaInFlightAccountId = accountId
  try {
    return await request
  } finally {
    if (quotaInFlight === request) {
      quotaInFlight = null
      quotaInFlightAccountId = null
    }
  }
}

/** The shipped table, re-exported so callers need only this module. */
export { ZHIPU_MODELS, DEFAULT_CONTEXT_WINDOW, PROVIDER_NAME, ERROR_CODE }
