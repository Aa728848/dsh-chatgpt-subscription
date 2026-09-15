import {
  CATALOG_CACHE_TTL_MS,
  DEFAULT_CONTEXT_WINDOW,
  DISCOVERY_TIMEOUT_MS,
  PROVIDER_NAME,
  QUOTA_CACHE_TTL_MS,
  anthropicUrl,
  inputModalitiesFor,
  maxOutputTokensFor,
  openAIUrl,
  reasoningEffortsFor,
  wireForModel,
} from './types.ts'
import {
  FileCredentialStore,
  resolveRegion,
  type KimiCodeCatalogModel,
  type KimiCodeCredentials,
} from './token-store.ts'
import { KimiCodeUnauthorizedError, ensureAccessToken, identityFromTokens, kimiIdentityHeaders } from './oauth.ts'
import { kimiCodeModelDef } from './model-catalog.ts'
import type {
  KimiCodeAccount,
  KimiCodeAccountQuota,
  KimiCodeExtraUsage,
  KimiCodeModelOption,
  KimiCodeRegion,
  KimiCodeUsageWindow,
  KimiCodeWire,
} from '../../shared/kimi-code-contracts.ts'

/** Endpoint suffixes on the coding API base. */
export const MODELS_PATH = '/models'
export const USAGES_PATH = '/usages'
export const ME_PATH = '/me'

/** The service reports money in fixed-point units of 1e-6 cents. */
const FIXED_POINT_CENTS = 1_000_000

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

/** Accept a number, or a numeric string as the service sometimes sends. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = asString(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = asNumber(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Parse an ISO string, Unix seconds, or Unix milliseconds into Unix milliseconds. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e11 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return parseTimestamp(numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function formatAmount(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, timeoutSignalOnly(ms)]) : timeoutSignalOnly(ms)
}

function timeoutSignalOnly(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

/**
 * Headers for a managed coding API request.
 *
 * The OpenAI-compatible surface authenticates with a bearer token. On the
 * Anthropic-compatible surface the Anthropic SDK sends the token as
 * `x-api-key` instead and deliberately omits `authorization`, so both are
 * emitted — the service documents each surface and only reads its own field.
 */
export async function kimiCodeHeaders(
  accessToken: string,
  wire: KimiCodeWire = 'openai',
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  // The two surfaces authenticate differently: the Anthropic-compatible one
  // reads `x-api-key`, the OpenAI-compatible one a bearer token.
  const auth: Record<string, string> = wire === 'anthropic'
    ? { 'x-api-key': accessToken, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${accessToken}` }
  return kimiIdentityHeaders({
    accept: 'application/json',
    ...auth,
    ...extra,
  })
}

/**
 * Headers for one model call.
 *
 * The managed service attributes usage to the installation, so the same
 * \`X-Msh-*\` device identity the account endpoints require is sent here too.
 * The product token stays this plugin's own: the service documents third-party
 * clients against this endpoint, and claiming to be the official CLI is both
 * dishonest and, per its own terms, grounds for suspending the subscription.
 * The cost of that honesty is that a non-whitelisted user agent can be routed to
 * a deprioritized pool, which answers with a transient 429 — the retry policy in
 * the adapter is what absorbs it.
 */
export async function modelRequestHeaders(accessToken: string, wire: KimiCodeWire): Promise<Record<string, string>> {
  const auth: Record<string, string> = wire === 'anthropic'
    ? { 'x-api-key': accessToken, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${accessToken}` }
  return kimiIdentityHeaders({
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...auth,
  })
}

/** Test seam: resolve the URL one request goes to. */
export function requestUrl(wire: KimiCodeWire, region: KimiCodeRegion): string {
  return wire === 'anthropic'
    ? anthropicUrl('/v1/messages?beta=true', region)
    : openAIUrl('/chat/completions', region)
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

interface CatalogCache {
  fetchedAt: number
  models: KimiCodeCatalogModel[]
  key: string
}

let catalogCache: CatalogCache | null = null

export function clearCachedCatalog(): void {
  catalogCache = null
}

export function getCachedCatalog(): KimiCodeCatalogModel[] {
  return catalogCache?.models ?? []
}

/**
 * Read one model entry from the live catalog.
 *
 * The service reports far more than this plugin uses, so only the fields that
 * change a request or the picker are read; an entry with no positive context
 * length is dropped rather than shown as a zero-capacity model.
 */
function parseCatalogModel(value: unknown): KimiCodeCatalogModel | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const id = asString(record.id)
  if (id === undefined) return undefined
  const contextWindow = firstNumber(record, ['context_length', 'contextLength'])
  if (contextWindow === undefined || contextWindow <= 0) return undefined

  const efforts = asRecord(record.think_efforts) ?? asRecord(record.thinkEfforts)
  const validEfforts = Array.isArray(efforts?.valid_efforts)
    ? efforts.valid_efforts.filter((entry): entry is string => typeof entry === 'string')
    : Array.isArray(efforts?.validEfforts)
      ? efforts.validEfforts.filter((entry): entry is string => typeof entry === 'string')
      : undefined

  const modalities: Array<'text' | 'image' | 'video'> = ['text']
  if (record.supports_image_in === true || record.supportsImageIn === true) modalities.push('image')
  // The live listing uses the same capability tag the official CLI's model
  // table declares, so a model that gains video acceptance server-side starts
  // working here without a plugin release.
  if (record.supports_video_in === true || record.supportsVideoIn === true) modalities.push('video')

  const protocol = asString(record.protocol)
  return {
    id,
    name: asString(record.display_name) ?? asString(record.displayName) ?? undefined,
    contextWindow,
    ...(validEfforts === undefined || validEfforts.length === 0 ? {} : { reasoningEfforts: validEfforts }),
    ...(asString(efforts?.default_effort ?? efforts?.defaultEffort) === undefined
      ? {}
      : { defaultReasoningEffort: asString(efforts?.default_effort ?? efforts?.defaultEffort) }),
    inputModalities: modalities,
    protocol: protocol === 'anthropic' ? 'anthropic' : 'openai',
    ...(record.supports_video_in === true || record.supportsVideoIn === true ? { supportsVideo: true } : {}),
    // Three-state on purpose: the listing may assert true, assert false, or say
    // nothing at all. Collapsing false into "absent" would make an explicit
    // denial indistinguishable from silence, and the static fallback would then
    // re-enable a capability the service just turned off.
    ...(typeof (record.supports_dynamic_tools ?? record.supportsDynamicTools) === 'boolean'
      ? { supportsDynamicTools: (record.supports_dynamic_tools ?? record.supportsDynamicTools) as boolean }
      : {}),
  }
}

/**
 * Fetch the models the signed-in subscription can use.
 *
 * The live listing is authoritative — it is what tells the plugin which models
 * the account's tier actually unlocks — so it is cached for half an hour and
 * re-read on demand from the settings card.
 */
export async function loadProviderModels(options: {
  fetchFn?: typeof fetch
  store?: FileCredentialStore
  accessToken?: string
  region?: KimiCodeRegion
  signal?: AbortSignal
  force?: boolean
} = {}): Promise<KimiCodeCatalogModel[]> {
  const region = options.region ?? await resolveRegion()
  let accessToken = options.accessToken
  if (accessToken === undefined) {
    if (options.store === undefined) return []
    try {
      accessToken = (await ensureAccessToken(options.store, { fetchFn: options.fetchFn, signal: options.signal })).accessToken
    } catch {
      return []
    }
  }

  const cacheKey = `${region}:${accessToken.slice(-8)}`
  if (options.force !== true && catalogCache !== null
    && catalogCache.key === cacheKey
    && Date.now() - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache.models
  }

  const response = await (options.fetchFn ?? fetch)(openAIUrl(MODELS_PATH, region), {
    headers: await kimiCodeHeaders(accessToken, 'openai'),
    signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Kimi Code model listing failed (${response.status}).`)

  const payload: unknown = await response.json().catch(() => undefined)
  const data = Array.isArray(payload) ? payload : asRecord(payload)?.data
  if (!Array.isArray(data)) throw new Error('Kimi Code model listing was not in the documented shape.')

  const models = data.map(parseCatalogModel).filter((model): model is KimiCodeCatalogModel => model !== undefined)
  catalogCache = { fetchedAt: Date.now(), models, key: cacheKey }
  return models
}

/** Choose the wire dialect for one model, from the live catalog when it says. */
export function wireForCatalogEntry(modelId: string, catalog: readonly KimiCodeCatalogModel[]): KimiCodeWire {
  const entry = catalog.find((model) => model.id === modelId)
  if (entry?.protocol === 'anthropic') return 'anthropic'
  return wireForModel(modelId)
}

/** Thinking levels for one model, from the catalog when it declares them. */
export function reasoningEffortsForEntry(modelId: string, catalog: readonly KimiCodeCatalogModel[]): string[] {
  const entry = catalog.find((model) => model.id === modelId)
  if (entry?.reasoningEfforts !== undefined) return [...entry.reasoningEfforts]
  return reasoningEffortsFor(modelId)
}

/**
 * Whether one model accepts message-level tool declarations.
 *
 * THE single resolution point for `dynamically_loaded_tools`: the settings card
 * and the request builder must never disagree, because the failure mode is a UI
 * that promises a capability the sent request silently drops. Precedence is the
 * live listing (including an explicit false), then the shipped registry.
 *
 * @param modelId - exact model id.
 * @param catalog - live catalog, possibly empty when offline.
 */
export function dynamicToolsForEntry(
  modelId: string,
  catalog: readonly KimiCodeCatalogModel[],
): boolean {
  const entry = catalog.find((model) => model.id === modelId)
  if (entry?.supportsDynamicTools !== undefined) return entry.supportsDynamicTools
  return kimiCodeModelDef(modelId)?.supportsDynamicTools === true
}

/** Input modalities for one model, from the catalog when it declares them. */
export function inputModalitiesForEntry(modelId: string, catalog: readonly KimiCodeCatalogModel[]): Array<'text' | 'image' | 'video'> {
  const entry = catalog.find((model) => model.id === modelId)
  if (entry?.inputModalities !== undefined) return [...entry.inputModalities]
  return inputModalitiesFor(modelId)
}

/** Build the picker entries the settings card renders. */
export function buildModelOptions(
  catalog: readonly KimiCodeCatalogModel[],
  enabledModelIds: readonly string[],
  contextWindowOverrides: Record<string, number>,
): KimiCodeModelOption[] {
  const enabled = new Set(enabledModelIds)
  return catalog.map((model) => {
    const override = contextWindowOverrides[model.id]
    const contextWindow = typeof override === 'number' && Number.isFinite(override) && override > 0
      ? override
      : model.contextWindow ?? DEFAULT_CONTEXT_WINDOW
    const efforts = model.reasoningEfforts ?? reasoningEffortsFor(model.id)
    const defaultEffort = model.defaultReasoningEffort
    return {
      id: model.id,
      name: model.name ?? model.id,
      enabled: enabled.has(model.id),
      defaultContextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      contextWindow,
      defaultMaxTokens: maxOutputTokensFor(model.id),
      ...(efforts.length === 0 ? {} : { reasoningEfforts: [...efforts] }),
      ...(defaultEffort === undefined ? {} : { defaultReasoningEffort: defaultEffort }),
      wire: model.protocol ?? wireForModel(model.id),
      // The live catalog carries capabilities but not the marketing copy, so
      // the static registry fills the gaps rather than the card showing blanks.
      description: model.description ?? kimiCodeModelDef(model.id)?.description ?? null,
      supportsVideo: model.supportsVideo ?? (kimiCodeModelDef(model.id)?.inputModalities.includes('video') ?? false),
      minimumPlan: model.minimumPlan ?? kimiCodeModelDef(model.id)?.minimumPlan ?? null,
      // Resolved through the shared helper so the card cannot drift from what
      // the request builder will actually do with the same catalog.
      supportsDynamicTools: dynamicToolsForEntry(model.id, catalog),
    }
  })
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

let quotaCache: KimiCodeAccountQuota | null = null

export function getCachedQuota(): KimiCodeAccountQuota | null {
  return quotaCache
}

export function clearCachedQuota(): void {
  quotaCache = null
}

/**
 * Display name and nominal length for each window key the service reports.
 *
 * The keys are the service's own names, and two of them describe different
 * monthly pools: the membership-wide one and the Kimi Code one. They are
 * labelled distinctly because a user who has spent their shared membership
 * quota is blocked even while the Code pool still has room.
 */
const WINDOW_DESCRIPTORS: Record<string, { label: string; minutes: number | null }> = {
  limit_5h: { label: '5-hour', minutes: 300 },
  limit5h: { label: '5-hour', minutes: 300 },
  limit_7d: { label: 'Weekly (7-day)', minutes: 10_080 },
  limit7d: { label: 'Weekly (7-day)', minutes: 10_080 },
  limit_month_total: { label: 'Monthly (membership)', minutes: 43_200 },
  monthTotal: { label: 'Monthly (membership)', minutes: 43_200 },
  limit_month_code: { label: 'Monthly (Kimi Code)', minutes: 43_200 },
  monthCode: { label: 'Monthly (Kimi Code)', minutes: 43_200 },
}

/** Window order for the card: shortest window first. */
const WINDOW_ORDER = [
  'limit_5h', 'limit5h',
  'limit_7d', 'limit7d',
  'limit_month_total', 'monthTotal',
  'limit_month_code', 'monthCode',
] as const

function humanizeWindowKey(key: string): string {
  const spaced = key.replace(/^limit[_-]?/i, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim()
  return spaced === '' ? key : spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** One `{usedRatio, resetAt}` entry into a renderable window. */
function usageWindow(
  id: string,
  record: Record<string, unknown>,
  descriptor: { label: string; minutes: number | null } | undefined,
): KimiCodeUsageWindow | undefined {
  const limit = firstNumber(record, ['limit'])
  const used = firstNumber(record, ['used'])
  const remaining = firstNumber(record, ['remaining'])
  // The service normally reports a ready ratio; the alternative shape reports a
  // used/limit pair instead, so the ratio is derived from it rather than the
  // window being dropped.
  const reported = firstNumber(record, ['used_ratio', 'usedRatio'])
  const usedRatio = reported ?? (limit !== undefined && limit > 0 && used !== undefined ? used / limit : undefined)
  if (usedRatio === undefined || !Number.isFinite(usedRatio)) return undefined
  const usedFraction = clamp01(usedRatio)
  return {
    id,
    label: descriptor?.label ?? humanizeWindowKey(id),
    usedFraction,
    usedPercent: Math.round(usedFraction * 100),
    windowDurationMins: descriptor?.minutes ?? null,
    resetsAt: parseTimestamp(record.reset_time ?? record.resetTime ?? record.resetsAt),
    limit: formatAmount(limit),
    used: formatAmount(used ?? (limit === undefined ? undefined : usedFraction * limit)),
    remaining: formatAmount(remaining ?? (limit === undefined ? undefined : Math.max(0, limit - usedFraction * limit))),
  }
}

/**
 * Read the windowed quota block.
 *
 * The service's own shape nests one entry per window under `usages`; a
 * community-documented alternative reports a top-level `usage` plus a
 * `limits[]` array. Both are read so a service-side change of shape does not
 * silently blank the card, and an unrecognized payload yields no windows rather
 * than a fabricated 0%.
 */
export function parseUsageWindows(payload: unknown): KimiCodeUsageWindow[] {
  const root = asRecord(payload) ?? {}
  const windows: KimiCodeUsageWindow[] = []
  const seen = new Set<string>()

  const push = (id: string, record: Record<string, unknown>, descriptor?: { label: string; minutes: number | null }): void => {
    if (seen.has(id)) return
    const parsed = usageWindow(id, record, descriptor)
    if (parsed === undefined) return
    seen.add(id)
    windows.push(parsed)
  }

  // Official shape: usages.{limit_5h,limit_7d,limit_month_total,limit_month_code}
  const usages = asRecord(root.usages) ?? asRecord(root.usageWindows)
  if (usages !== undefined) {
    const keys = [
      ...WINDOW_ORDER.filter((key) => usages[key] !== undefined),
      ...Object.keys(usages).filter((key) => !(WINDOW_ORDER as readonly string[]).includes(key)),
    ]
    for (const key of keys) {
      const record = asRecord(usages[key])
      if (record === undefined) continue
      push(key, record, WINDOW_DESCRIPTORS[key])
    }
  }

  // Alternative shape: top-level usage (the 7-day pool) plus limits[].
  const topLevel = asRecord(root.usage)
  if (topLevel !== undefined && seen.size === 0) {
    push('limit_7d', topLevel, WINDOW_DESCRIPTORS.limit_7d)
  }
  const limits = Array.isArray(root.limits) ? root.limits : []
  for (const entry of limits) {
    const record = asRecord(entry)
    if (record === undefined) continue
    const detail = asRecord(record.detail) ?? record
    const window = asRecord(record.window)
    const duration = firstNumber(window ?? {}, ['duration'])
    const unit = asString(window?.timeUnit ?? window?.time_unit)
    const minutes = duration === undefined ? null : unit === 'TIME_UNIT_HOUR' ? duration * 60 : duration
    const id = minutes === 300 ? 'limit_5h' : minutes === 10_080 ? 'limit_7d' : firstString(record, ['id', 'name']) ?? `limit-${windows.length + 1}`
    push(id, detail, minutes === null ? undefined : { label: minutes === 300 ? '5-hour' : `${minutes}-minute`, minutes })
  }

  return windows
}

/**
 * Convert the fixed-point money field the service uses into cents.
 *
 * Amounts arrive as 1e-6 cents; a positive amount that would round to zero is
 * reported as one cent, because "you have something left" is closer to the
 * truth than "you have nothing".
 */
export function fixedPointToCents(value: unknown): number | null {
  const raw = asNumber(value)
  if (raw === undefined) return null
  const cents = Math.round(raw / FIXED_POINT_CENTS)
  if (cents === 0 && raw > 0) return 1
  return cents
}

/**
 * Read a money object's `priceInCents` field.
 *
 * Unlike the wallet balance — which is fixed-point 1e-6 cents — this field is
 * already a plain cent amount, so applying the fixed-point divisor here would
 * under-report a charge limit by six orders of magnitude.
 */
function moneyCents(value: unknown): number | null {
  const record = asRecord(value)
  if (record === undefined) return null
  const cents = asNumber(record.priceInCents ?? record.price_in_cents)
  return cents === undefined || !Number.isFinite(cents) ? null : Math.round(cents)
}

function moneyCurrency(value: unknown): string | undefined {
  const record = asRecord(value)
  return record === undefined ? undefined : asString(record.currency)
}

/**
 * Read the booster wallet (the pay-as-you-go top-up pool).
 *
 * The wallet only counts when its balance is a real booster balance; anything
 * else is reported as absent so the card does not advertise credit the account
 * cannot spend.
 */
export function parseExtraUsage(payload: unknown): KimiCodeExtraUsage | null {
  const root = asRecord(payload) ?? {}
  const wallet = asRecord(root.boosterWallet) ?? asRecord(root.booster_wallet) ?? asRecord(root.extraUsage)
  if (wallet === undefined) return null

  const balance = asRecord(wallet.balance)
  const balanceType = asString(balance?.type)
  const amount = asNumber(balance?.amount)
  if (balance === undefined || balanceType !== 'BOOSTER' || amount === undefined || amount <= 0) return null

  const limit = wallet.monthlyChargeLimit ?? wallet.monthly_charge_limit
  const used = wallet.monthlyUsed ?? wallet.monthly_used
  return {
    balanceCents: fixedPointToCents(balance.amountLeft ?? balance.amount_left ?? balance.amount),
    totalCents: fixedPointToCents(balance.amount),
    monthlyChargeLimitEnabled: wallet.monthlyChargeLimitEnabled === true || wallet.monthly_charge_limit_enabled === true,
    monthlyChargeLimitCents: moneyCents(limit),
    monthlyUsedCents: moneyCents(used),
    currency: moneyCurrency(limit) ?? moneyCurrency(used) ?? asString(wallet.currency) ?? 'USD',
  }
}

/**
 * Display name for each machine membership level the service reports.
 *
 * `/usages` used to carry `user_level_name` directly and stopped doing so, so
 * the code is now often the only tier signal available; without this table the
 * card would show a raw enum. Names are the ones Kimi's own pricing page uses.
 */
const MEMBERSHIP_LEVEL_NAMES: Record<string, string> = {
  LEVEL_FREE: 'Adagio',
  LEVEL_BASIC: 'Adagio',
  LEVEL_ANDANTE: 'Andante',
  LEVEL_STANDARD: 'Moderato',
  LEVEL_MODERATO: 'Moderato',
  LEVEL_INTERMEDIATE: 'Allegretto',
  LEVEL_ALLEGRETTO: 'Allegretto',
  LEVEL_ADVANCED: 'Allegro',
  LEVEL_ALLEGRO: 'Allegro',
  LEVEL_PREMIUM: 'Vivace',
  LEVEL_VIVACE: 'Vivace',
}

/** Human name for one machine level code, or the code itself when unknown. */
export function membershipLevelName(level: string | null | undefined): string | null {
  if (level === null || level === undefined || level.trim() === '') return null
  const key = level.trim().toUpperCase()
  return MEMBERSHIP_LEVEL_NAMES[key] ?? level
}

/**
 * Subscription tier the payload names, from any documented shape.
 *
 * Prefers the display name when the service still sends one, then the machine
 * level (mapped to its marketing name), so a payload that dropped
 * `user_level_name` still yields a readable tier instead of a raw enum.
 */
export function parsePlanName(payload: unknown): string | null {
  const root = asRecord(payload) ?? {}
  const direct = firstString(root, ['user_level_name', 'userLevelName', 'planName', 'plan_name'])
  if (direct !== undefined) return direct
  const user = asRecord(root.user)
  const membership = asRecord(user?.membership)
  const named = asString(membership?.level_name ?? membership?.levelName)
  if (named !== undefined) return named
  return membershipLevelName(asString(membership?.level) ?? null)
}

/** Machine tier level when the service reports one. */
export function parsePlanLevel(payload: unknown): string | null {
  const root = asRecord(payload) ?? {}
  const direct = firstNumber(root, ['user_level', 'userLevel'])
  if (direct !== undefined) return String(direct)
  const user = asRecord(root.user)
  const membership = asRecord(user?.membership)
  return asString(membership?.level ?? membership?.levelId ?? membership?.level_id) ?? null
}

/**
 * Turn a `/me` payload into the public account DTO.
 *
 * The endpoint answers with snake_case fields while the card consumes
 * camelCase, and either profile source may be the one that answered, so both
 * spellings are accepted.
 */
export function parseUserInfo(payload: unknown, fallback: Partial<KimiCodeAccount> = {}): KimiCodeAccount {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data) ?? root
  const record = asRecord(data.userInfo) ?? data
  return {
    userId: firstString(record, ['user_id', 'userId', 'global_id', 'globalId']) ?? fallback.userId ?? null,
    nickname: firstString(record, ['nickname', 'name', 'username']) ?? fallback.nickname ?? null,
    email: firstString(record, ['email']) ?? fallback.email ?? null,
    planName: firstString(record, ['user_level_name', 'userLevelName']) ?? fallback.planName ?? null,
    planLevel: firstString(record, ['user_level', 'userLevel']) ?? fallback.planLevel ?? null,
    region: (asString(record.region) as KimiCodeRegion | undefined) ?? fallback.region ?? null,
    authenticatedAt: fallback.authenticatedAt ?? null,
  }
}

export interface QuotaFetchOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  /** Bypass the local cache and read the service again. */
  force?: boolean
}

/**
 * Fetch and cache the account's quota snapshot.
 *
 * A 401 is surfaced as a rejection so the caller can invalidate the stored
 * credential; every other failure leaves the previous snapshot in place rather
 * than blanking the card, because a transient outage says nothing about the
 * account's real usage.
 */
export async function fetchAccountQuota(
  store: FileCredentialStore,
  options: QuotaFetchOptions = {},
): Promise<KimiCodeAccountQuota | null> {
  if (options.force !== true && quotaCache !== null && Date.now() - quotaCache.fetchedAt < QUOTA_CACHE_TTL_MS) {
    return quotaCache
  }

  const fetchFn = options.fetchFn ?? fetch
  let credentials: KimiCodeCredentials
  try {
    credentials = await ensureAccessToken(store, { fetchFn, signal: options.signal })
  } catch (error) {
    throw error
  }

  const response = await fetchFn(openAIUrl(USAGES_PATH, credentials.region), {
    headers: await kimiCodeHeaders(credentials.accessToken, 'openai'),
    signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
  })

  if (response.status === 401) {
    // A rejected credential must be distinguishable from a transient outage:
    // callers surface the first and retry the second, so it carries the same
    // typed error the token layer uses.
    throw new KimiCodeUnauthorizedError(
      'Kimi Code rejected the stored credential (401). Sign in again from Settings > Kimi Code.',
    )
  }
  if (response.status === 404) {
    throw new Error('The Kimi Code usage endpoint is unavailable for this account. Confirm the subscription is active.')
  }
  if (!response.ok) {
    throw new Error(`Kimi Code usage request failed (${response.status}).`)
  }

  const payload: unknown = await response.json().catch(() => undefined)

  // `/usages` no longer names the plan, so `/me` supplies it; both are folded
  // in and whatever is learned is written back for the status fallback to read.
  const profile = await fetchProfile(store, { fetchFn, signal: options.signal })
  const account = accountFromCredentials(credentials, payload, profile ?? undefined)
  const learned: Partial<KimiCodeCredentials> = {}
  if (account.planName !== null && account.planName !== credentials.planName) learned.planName = account.planName
  if (account.nickname !== null && account.nickname !== credentials.nickname) learned.nickname = account.nickname
  if (Object.keys(learned).length > 0) {
    void store.write({ ...credentials, ...learned }).catch(() => undefined)
  }

  const snapshot: KimiCodeAccountQuota = {
    account,
    planName: account.planName,
    windows: parseUsageWindows(payload),
    extraUsage: parseExtraUsage(payload),
    fetchedAt: Date.now(),
    sources: [openAIUrl(USAGES_PATH, credentials.region)],
  }
  quotaCache = snapshot
  return snapshot
}

/**
 * Build the account view for one credential.
 *
 * There is no account-profile endpoint on the coding API: the signed-in
 * identity lives in the token's own claims, so the account is assembled from
 * the stored credential (which the login and every refresh keep populated) and
 * enriched by whatever the usage payload reports about the tier.
 */
export function accountFromCredentials(
  credentials: KimiCodeCredentials,
  payload?: unknown,
  profile?: unknown,
): KimiCodeAccount {
  const identity = identityFromTokens(credentials.accessToken, credentials.refreshToken)
  // The tier is read from whichever source has it: `/me` is authoritative for
  // the plan (and is now the only place that names it), while `/usages` may
  // still carry the code.
  const planName = (profile === undefined ? null : parsePlanName(profile))
    ?? (payload === undefined ? null : parsePlanName(payload))
    ?? credentials.planName
    ?? null
  const planLevel = (profile === undefined ? null : parsePlanLevel(profile))
    ?? (payload === undefined ? null : parsePlanLevel(payload))
  return {
    userId: credentials.userId ?? identity.userId ?? null,
    nickname: (profile === undefined ? null : firstString(asRecord(profile) ?? {}, ['nickname', 'username', 'name']))
      ?? credentials.nickname
      ?? null,
    // A claim decoded from the live token outranks the stored copy, so a
    // credential written before the claims were read still shows the account.
    email: credentials.email ?? identity.email ?? null,
    planName,
    planLevel,
    region: credentials.region,
    authenticatedAt: credentials.authenticatedAt ?? null,
  }
}

/**
 * Read the plan profile from `/me`.
 *
 * The endpoint exists and is the only remaining source of the plan's display
 * name: `/usages` used to carry `user_level_name` and stopped. It is called
 * with the OAuth access token only (never a pasted plan key) and is treated as
 * enrichment — a failure returns null so the card still renders the identity it
 * already has from the token.
 */
export async function fetchProfile(
  store: FileCredentialStore,
  options: QuotaFetchOptions = {},
): Promise<unknown | null> {
  const fetchFn = options.fetchFn ?? fetch
  let credentials: KimiCodeCredentials
  try {
    credentials = await ensureAccessToken(store, { fetchFn, signal: options.signal })
  } catch {
    return null
  }
  try {
    const response = await fetchFn(openAIUrl(ME_PATH, credentials.region), {
      headers: await kimiCodeHeaders(credentials.accessToken, 'openai'),
      signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
    })
    if (!response.ok) return null
    return await response.json().catch(() => null)
  } catch {
    // A profile is enrichment; a network failure must not fail the card.
    return null
  }
}

/**
 * Read the account identity for a stored credential.
 *
 * Combines the token's own claims (the identity) with `/me` (the plan name) and
 * persists what it learns, so a later call needs no network work. It never
 * throws for a missing profile: the identity is derived locally.
 */
export async function fetchUserInfo(
  store: FileCredentialStore,
  options: QuotaFetchOptions = {},
): Promise<KimiCodeAccount | null> {
  const credentials = await store.read()
  if (credentials === null) return null
  const profile = await fetchProfile(store, options)
  const account = accountFromCredentials(credentials, undefined, profile)
  // Persist anything new (identity claims, the plan name) so the next status
  // call can render without asking the service again.
  const learned: Partial<KimiCodeCredentials> = {}
  if (credentials.userId === undefined && account.userId !== null) learned.userId = account.userId
  if (credentials.email === undefined && account.email !== null) learned.email = account.email
  if (credentials.nickname === undefined && account.nickname !== null) learned.nickname = account.nickname
  if (account.planName !== null && account.planName !== credentials.planName) learned.planName = account.planName
  if (Object.keys(learned).length > 0) {
    try {
      await store.write({ ...credentials, ...learned })
    } catch {
      // A read-only store must not break the card; the value is still returned.
    }
  }
  return account
}

/**
 * Prove the stored credential still authenticates, and report how long that took.
 *
 * The probe is the real usage call rather than a profile lookup, because there
 * is no profile endpoint: a 200 from `/usages` is what shows the token is
 * accepted, and it doubles as a quota refresh for the card.
 */
export async function testConnection(
  store: FileCredentialStore,
  options: QuotaFetchOptions = {},
): Promise<{ account: KimiCodeAccount | null; latencyMs: number }> {
  const startedAt = Date.now()
  try {
    const quota = await fetchAccountQuota(store, { ...options, force: true })
    return { account: quota?.account ?? null, latencyMs: Date.now() - startedAt }
  } catch (error) {
    // A rejected credential is the failure worth surfacing; a transient outage
    // is reported as "not connected" without failing the whole request.
    if (error instanceof KimiCodeUnauthorizedError) throw error
    const credentials = await store.read()
    return {
      account: credentials === null ? null : accountFromCredentials(credentials),
      latencyMs: Date.now() - startedAt,
    }
  }
}

export { PROVIDER_NAME }
