import {
  BILLING_CREDITS_PATH,
  CATALOG_CACHE_TTL_MS,
  DEFAULT_CONTEXT_WINDOW,
  BILLING_SUBSCRIPTIONS_PATH,
  DISCOVERY_TIMEOUT_MS,
  HEADER_CLI_ENVIRONMENT,
  HEADER_CLI_VERSION,
  HEADER_OSS_PRIMARY_PROVIDER,
  HEADER_PROJECT_SLUG,
  HEADER_SESSION_ID,
  HEADER_TASTE_LEARNING,
  PROVIDER_ID,
  PROVIDER_NAME,
  QUOTA_CACHE_TTL_MS,
  USAGE_SUMMARY_PATH,
  WHOAMI_PATH,
  apiBaseUrl,
  maxOutputTokensFor,
  providerUrl,
  reasoningEffortsFor,
  resolveApiEnv,
  wireForModel,
} from './types.ts'
import { FileCredentialStore, type CommandCodeCatalogModel, type CommandCodeCredentials } from './token-store.ts'
import { commandCodePlanLabel, resolveCommandCodePlan } from './plans.ts'
import type {
  CommandCodeAccount,
  CommandCodeAccountQuota,
  CommandCodeApiEnv,
  CommandCodeMeter,
  CommandCodeUsageWindow,
} from '../../shared/command-code-contracts.ts'

const CLI_VERSION = '1.0.0'

export interface CommandCodeRequestOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  apiEnv?: CommandCodeApiEnv
}

/**
 * Attribution headers for every Command Code request.
 *
 * The alpha routes are the ones the official CLI calls, so the plugin
 * identifies with the same vocabulary; the provider API only needs the bearer
 * token plus a JSON content type.
 */
export function commandCodeHeaders(
  apiKey: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': `${PROVIDER_ID}/${CLI_VERSION}`,
    [HEADER_CLI_VERSION]: CLI_VERSION,
    [HEADER_CLI_ENVIRONMENT]: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    [HEADER_PROJECT_SLUG]: 'dsh-chatgpt-subscription',
    [HEADER_TASTE_LEARNING]: 'false',
    [HEADER_SESSION_ID]: process.env.DSH_SESSION_ID ?? 'dsh',
    [HEADER_OSS_PRIMARY_PROVIDER]: 'dsh',
    ...extra,
  }
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
    const parsed = Number(value.replace(/[,\s$]/g, ''))
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

/** Depth-first search for the first value stored under any of `keys`. */
function deepValue(value: unknown, keys: readonly string[], depth = 0): unknown {
  if (depth > 6) return undefined
  if (Array.isArray(value)) {
    for (const entry of value) {
      const hit = deepValue(entry, keys, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key]
  }
  for (const nested of Object.values(value)) {
    const hit = deepValue(nested, keys, depth + 1)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Depth-first search for the first object carrying any of `keys`. */
function deepRecord(value: unknown, keys: readonly string[], depth = 0): Record<string, unknown> | undefined {
  if (depth > 6) return undefined
  if (Array.isArray(value)) {
    for (const entry of value) {
      const hit = deepRecord(entry, keys, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (keys.some((key) => value[key] !== undefined)) return value
  for (const nested of Object.values(value)) {
    const hit = deepRecord(nested, keys, depth + 1)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Every object reachable from `value` that mentions any of `keys`. */
function collectRecords(value: unknown, keys: readonly string[], depth = 0, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (depth > 6) return out
  if (Array.isArray(value)) {
    for (const entry of value) collectRecords(entry, keys, depth + 1, out)
    return out
  }
  if (!isRecord(value)) return out
  if (keys.some((key) => value[key] !== undefined)) out.push(value)
  for (const nested of Object.values(value)) collectRecords(nested, keys, depth + 1, out)
  return out
}

const USER_KEYS = ['user', 'profile', 'account', 'identity'] as const
const ORG_KEYS = ['organization', 'org', 'team', 'workspace', 'company'] as const

/** Map `/alpha/whoami` (or a stored key's own facts) onto the public account DTO. */
export function parseWhoami(payload: unknown, fallback: Partial<CommandCodeAccount> = {}): CommandCodeAccount {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data) ?? root
  const user = asRecord(deepValue(data, USER_KEYS)) ?? {}
  const org = asRecord(deepValue(data, ORG_KEYS)) ?? {}
  const key = asRecord(deepValue(data, ['apiKey', 'key', 'credential'])) ?? {}
  const subscription = asRecord(deepValue(data, ['subscription', 'plan', 'tier'])) ?? {}

  const email = firstString(user, ['email', 'primaryEmail'])
    ?? (typeof user.email === 'string' ? user.email : undefined)
    ?? fallback.email

  return {
    userId: firstString(user, ['id', 'userId', 'uid']) ?? firstString(root, ['userId']) ?? fallback.userId ?? null,
    userName: firstString(user, ['userName', 'username', 'name', 'displayName', 'fullName'])
      ?? firstString(root, ['userName'])
      ?? fallback.userName
      ?? null,
    email: email ?? null,
    organizationName: firstString(org, ['name', 'displayName', 'slug']) ?? fallback.organizationName ?? null,
    keyName: firstString(key, ['name', 'keyName', 'label']) ?? fallback.keyName ?? null,
    planLabel: firstString(subscription, ['name', 'displayName', 'label', 'planName'])
      ?? firstString(data, ['planName', 'planLabel'])
      ?? fallback.planLabel
      ?? null,
    planId: firstString(subscription, ['id', 'planId', 'slug', 'tier'])
      ?? fallback.planId
      ?? null,
    authenticatedAt: fallback.authenticatedAt ?? null,
  }
}

const LIMIT_KEYS = ['limit', 'quota', 'allowance', 'cap', 'total', 'credits', 'balance', 'remaining', 'used', 'usedPercent', 'used_percent', 'usagePercent'] as const

/**
 * Display name and nominal length for one window key in `credits.windowLimits`.
 *
 * The service keys its windows by name (`fiveHour`, `weekly`) with no display
 * string, so without this table every meter is labelled `meter-1`/`meter-2` —
 * exactly what the official CLI avoids by hard-coding the same two labels.
 */
interface WindowDescriptor {
  label: string
  windowDurationMins: number
}

const WINDOW_DESCRIPTORS: Record<string, WindowDescriptor> = {
  fiveHour: { label: '5-hour', windowDurationMins: 300 },
  daily: { label: 'Daily', windowDurationMins: 1_440 },
  weekly: { label: 'Weekly', windowDurationMins: 10_080 },
  monthly: { label: 'Monthly', windowDurationMins: 43_200 },
}

/**
 * Meter key order for `windowLimits`, shortest window first.
 *
 * The composer badge picks the shortest window, and the settings card lists
 * them in this order, so a payload that happens to serialize `weekly` before
 * `fiveHour` still renders the 5-hour allowance first.
 */
const WINDOW_ORDER = ['fiveHour', 'daily', 'weekly', 'monthly'] as const

/** Title-cases an unknown window key so a new one is readable rather than `meter-3`. */
function humanizeWindowKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim()
  return spaced === '' ? key : spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Read the credit-window block the service actually sends.
 *
 * `/alpha/billing/credits` answers with named windows under `windowLimits`:
 * `{ fiveHour: { used, cap, exceeded, resetAt }, weekly: { … } }`. The generic
 * sweep below cannot label those entries — their key is the only name they have
 * — so they are read here first, by name.
 */
function parseWindowLimits(payload: unknown, consumed: unknown[] = []): CommandCodeMeter[] {
  const root = asRecord(payload) ?? {}
  const rootData = asRecord(root.data) ?? root
  const limits = asRecord(deepValue(rootData, ['windowLimits', 'window_limits']))
  if (limits === undefined) return []

  const keys = [
    ...WINDOW_ORDER.filter((key) => limits[key] !== undefined),
    ...Object.keys(limits).filter((key) => !(WINDOW_ORDER as readonly string[]).includes(key)),
  ]

  const meters: CommandCodeMeter[] = []
  for (const key of keys) {
    if (key === 'limited' || key === 'exceeded') continue
    const record = asRecord(limits[key])
    if (record === undefined) continue
    const cap = firstNumber(record, ['cap', 'limit', 'total'])
    const used = firstNumber(record, ['used', 'consumed'])
    if (cap === undefined && used === undefined) continue

    // Claimed so the generic sweep does not report the same object again under
    // a nameless label — these records carry no id for the sweep to match on.
    consumed.push(record)
    const usedFraction = cap !== undefined && cap > 0 && used !== undefined ? clamp01(used / cap) : null
    const descriptor = WINDOW_DESCRIPTORS[key]
    meters.push({
      id: key,
      label: descriptor?.label ?? humanizeWindowKey(key),
      usedFraction,
      remainingFraction: usedFraction === null ? null : Math.max(0, 1 - usedFraction),
      used: formatAmount(used),
      limit: formatAmount(cap),
      // The service reports this in Unix milliseconds, which parseTimestamp keeps as-is.
      resetsAt: parseTimestamp(record.resetAt ?? record.resetTime ?? record.resetsAt),
      description: descriptor === undefined ? null : `${descriptor.label} rolling window`,
    })
  }
  return meters
}

/**
 * Read the credit balance block (`credits.monthlyCredits` and friends).
 *
 * These are dollar amounts, not a bounded percentage: the plan's own allowance
 * (see `plans.ts`) is the only sensible denominator, and the caller adds that
 * context. Reporting them as a limit is deliberate — the card has no other
 * source for a remaining balance.
 */
function parseCreditBalances(payload: unknown, consumed: unknown[] = []): CommandCodeMeter[] {
  const root = asRecord(payload) ?? {}
  const rootData = asRecord(root.data) ?? root
  const credits = asRecord(deepValue(rootData, ['credits']))
  if (credits === undefined) return []

  const monthly = firstNumber(credits, ['monthlyCredits', 'monthly_credits'])
  const purchased = firstNumber(credits, ['purchasedCredits', 'purchased_credits'])
  const free = firstNumber(credits, ['freeCredits', 'free_credits'])
  if (monthly === undefined && purchased === undefined && free === undefined) return []
  consumed.push(credits)

  const meters: CommandCodeMeter[] = []
  const push = (id: string, label: string, value: number | undefined, description: string): void => {
    if (value === undefined) return
    meters.push({
      id,
      label,
      usedFraction: null,
      remainingFraction: null,
      used: null,
      limit: formatAmount(value),
      resetsAt: null,
      description,
    })
  }
  push('monthly-credits', 'Monthly credits', monthly, 'Remaining credits from the plan allowance')
  push('purchased-credits', 'Purchased credits', purchased, 'Remaining pay-as-you-go credits')
  push('free-credits', 'Free credits', free, 'Remaining promotional credits')
  return meters
}

/** Resolve the plan id the subscription or credits payload reports, when either does. */
export function parsePlanId(payloads: readonly unknown[]): string | null {
  for (const payload of payloads) {
    const value = deepValue(payload, ['planId', 'plan_id', 'priceId', 'price_id'])
    const id = asString(value)
    if (id !== undefined) return id
  }
  return null
}

/**
 * Subscription status such as `active`, `trialing`, or `past_due`.
 *
 * The CLI treats exactly `active`, `trialing`, and `past_due` as entitled, so
 * the status is surfaced rather than swallowed: a card that showed an expired
 * subscription's remaining credits as usable would be worse than showing none.
 */
export function parseSubscriptionStatus(payload: unknown): string | null {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data) ?? root
  return asString(deepValue(data, ['status'])) ?? null
}

/** End of the current billing period, in Unix milliseconds. */
export function parseSubscriptionPeriodEnd(payload: unknown): number | null {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data) ?? root
  return parseTimestamp(deepValue(data, ['currentPeriodEnd', 'current_period_end']))
}

/**
 * Turn one billing/usage payload into meters.
 *
 * The named blocks the service actually sends are read first, so windows carry
 * their real labels; the generic sweep afterwards still catches any bounded
 * allowance a future payload introduces, rather than reporting nothing.
 */
export function parseMeters(payload: unknown): CommandCodeMeter[] {
  const consumed: unknown[] = []
  const named = [...parseWindowLimits(payload, consumed), ...parseCreditBalances(payload, consumed)]
  const namedIds = new Set(named.map((meter) => meter.id))
  return [...named, ...sweepMeters(payload, namedIds, new Set(consumed))]
}

/**
 * Generic bounded-allowance sweep.
 *
 * Maps whatever limit/balance/percentage objects a payload contains instead of
 * binding to one exact schema, and yields nothing for an unrecognized payload
 * rather than a fabricated 0%.
 */
function sweepMeters(
  payload: unknown,
  skipIds: ReadonlySet<string>,
  consumed: ReadonlySet<unknown>,
): CommandCodeMeter[] {
  const records = collectRecords(payload, LIMIT_KEYS)
  const seen = new Set<string>()
  const meters: CommandCodeMeter[] = []
  /** How many allowances so far had no name of their own to report. */
  let anonymized = 0

  for (const record of records) {
    if (consumed.has(record)) continue
    const limit = firstNumber(record, ['limit', 'quota', 'allowance', 'cap', 'total'])
    const used = firstNumber(record, ['used', 'consumed', 'spent'])
    const remainingRaw = firstNumber(record, ['remaining', 'left'])
    const balance = firstNumber(record, ['balance', 'credits'])
    const usedPercentRaw = firstNumber(record, ['usedPercent', 'used_percent', 'usagePercent', 'percentUsed'])
    const remainingPercentRaw = firstNumber(record, ['remainingPercent', 'remaining_percent', 'percentRemaining'])

    let usedFraction: number | null = null
    let remainingFraction: number | null = null
    if (usedPercentRaw !== undefined) {
      usedFraction = normalizePercent(usedPercentRaw)
      remainingFraction = usedFraction === null ? null : Math.max(0, 1 - usedFraction)
    } else if (remainingPercentRaw !== undefined) {
      remainingFraction = normalizePercent(remainingPercentRaw)
      usedFraction = remainingFraction === null ? null : Math.max(0, 1 - remainingFraction)
    } else if (limit !== undefined && limit > 0 && used !== undefined) {
      usedFraction = clamp01(used / limit)
      remainingFraction = Math.max(0, 1 - usedFraction)
    } else if (limit !== undefined && limit > 0 && remainingRaw !== undefined) {
      remainingFraction = clamp01(remainingRaw / limit)
      usedFraction = Math.max(0, 1 - remainingFraction)
    }

    if (usedFraction === null && remainingFraction === null && limit === undefined && balance === undefined) continue

    const rawId = firstString(record, ['id', 'bucketId', 'bucket_id', 'name', 'slug', 'type', 'key'])
    const label = firstString(record, ['displayName', 'display_name', 'label', 'name', 'title', 'id', 'type'])
    // A window the named parser already reported must not appear twice.
    if (rawId !== undefined && skipIds.has(rawId)) continue
    // An allowance that cannot name itself is still real, so it is reported
    // rather than hidden — but under a descriptive label, never `meter-N`,
    // which told the user nothing about what the number counted.
    const unnamed = rawId ?? label
    const id = unnamed ?? `extra-${anonymized + 1}`
    if (unnamed === undefined) anonymized += 1
    if (seen.has(id) || skipIds.has(id)) continue
    seen.add(id)

    const isAnonymous = unnamed === undefined
    meters.push({
      id,
      label: label ?? (isAnonymous ? 'Extra allowance' : id),
      usedFraction,
      remainingFraction,
      used: formatAmount(used ?? (usedFraction !== null && limit !== undefined ? usedFraction * limit : undefined)),
      limit: formatAmount(limit),
      resetsAt: parseTimestamp(deepValue(record, ['resetTime', 'resetsAt', 'reset_at', 'periodEnd', 'renewalDate'])),
      description: firstString(record, ['description', 'detail', 'subtitle'])
        ?? (isAnonymous ? 'Allowance reported without a name' : null),
    })
  }

  // A payload that only reports a bare credit balance still deserves one meter.
  if (meters.length === 0 && skipIds.size === 0) {
    const balanceValue = deepValue(payload, ['creditBalance', 'credits', 'balance', 'remainingCredits'])
    const balance = asNumber(balanceValue)
    if (balance !== undefined && !skipIds.has('credits')) {
      meters.push({
        id: 'credits',
        label: 'Credits',
        usedFraction: null,
        remainingFraction: null,
        used: null,
        limit: formatAmount(balance),
        resetsAt: null,
        description: 'Remaining credit balance',
      })
    }
  }

  return meters
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Accepts both 0-1 fractions and 0-100 percentages from the same field. */
function normalizePercent(value: number): number | null {
  if (!Number.isFinite(value)) return null
  if (value > 1) return clamp01(value / 100)
  return clamp01(value)
}

function formatAmount(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
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

/** Map `/alpha/usage/summary` onto the windowed allowance DTO. */
export function parseUsageWindows(payload: unknown): CommandCodeUsageWindow[] {
  const records = collectRecords(payload, ['usedPercent', 'used_percent', 'usagePercent', 'window', 'windowDurationMins', 'remaining'])
  const windows: CommandCodeUsageWindow[] = []
  const seen = new Set<string>()

  for (const record of records) {
    const percent = firstNumber(record, ['usedPercent', 'used_percent', 'usagePercent', 'percentUsed'])
    if (percent === undefined) continue
    const id = firstString(record, ['id', 'bucketId', 'name', 'label', 'type', 'window']) ?? `window-${windows.length + 1}`
    if (seen.has(id)) continue
    seen.add(id)
    windows.push({
      id,
      label: firstString(record, ['displayName', 'label', 'name', 'type', 'window']) ?? id,
      usedPercent: Math.round(clamp01(normalizePercent(percent) ?? 0) * 100),
      windowDurationMins: firstNumber(record, ['windowDurationMins', 'window_minutes', 'durationMins', 'windowMinutes']) ?? null,
      resetsAt: parseTimestamp(deepValue(record, ['resetsAt', 'resetTime', 'reset_at'])),
    })
  }

  return windows
}

/**
 * Total remaining credits.
 *
 * `/alpha/billing/credits` reports three separate pools rather than one total
 * (`credits.monthlyCredits`, `purchasedCredits`, `freeCredits`), and a plain
 * `credits` lookup only finds the containing object — which is why this used to
 * answer null and the card showed a blank balance. The pools are summed exactly
 * as the CLI sums them; a payload that reports a flat balance still works.
 */
/** Exported for the quota regression tests; not part of the route surface. */
export function extractCreditsBalanceForTest(payload: unknown): string | null {
  return extractCreditsBalance(payload)
}

function extractCreditsBalance(payload: unknown): string | null {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data) ?? root
  const credits = asRecord(data.credits)
  if (credits !== undefined) {
    const pools = ['monthlyCredits', 'purchasedCredits', 'freeCredits'] as const
    let total = 0
    let found = false
    for (const key of pools) {
      const value = asNumber(credits[key])
      if (value !== undefined) { total += value; found = true }
    }
    if (found) return formatAmount(total)
  }
  const direct = asNumber(deepValue(data, ['creditBalance', 'balance', 'remainingCredits', 'remaining']))
  return formatAmount(direct)
}

function extractUnlimited(payload: unknown): boolean {
  const value = deepValue(payload, ['unlimited', 'isUnlimited'])
  return value === true
}

// ---------------------------------------------------------------------------
// Live model catalog
// ---------------------------------------------------------------------------

let cachedCatalog: { models: CommandCodeCatalogModel[]; fetchedAt: number } | undefined
let catalogInFlight: Promise<CommandCodeCatalogModel[]> | null = null

/** Parse the public `/provider/v1/models` payload. */
export function parseProviderModels(payload: unknown): CommandCodeCatalogModel[] {
  const root = asRecord(payload) ?? {}
  const list = Array.isArray(root.data) ? root.data : Array.isArray(payload) ? payload : []
  const models: CommandCodeCatalogModel[] = []
  for (const entry of list) {
    const record = asRecord(entry)
    if (!record) continue
    const id = firstString(record, ['id', 'model', 'name'])
    if (id === undefined) continue
    models.push({
      id,
      name: firstString(record, ['displayName', 'name']) ?? id,
      contextWindow: firstNumber(record, ['context_length', 'contextLength', 'context_window', 'contextWindow']),
    })
  }
  return models
}

/**
 * Fetch the live catalog. The endpoint is public, so this works before sign-in
 * and is what fills the settings card's context-window defaults.
 */
export async function fetchProviderModels(
  options: CommandCodeRequestOptions = {},
): Promise<CommandCodeCatalogModel[]> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.apiEnv ?? resolveApiEnv()
  const response = await fetchFn(`${providerUrl(env)}/models`, {
    headers: { accept: 'application/json', 'user-agent': PROVIDER_NAME },
    signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Command Code model catalog failed: ${response.status}`)
  }
  return parseProviderModels(await response.json())
}

/** Cached catalog with a TTL; a failed refresh keeps the previous snapshot. */
export async function loadProviderModels(
  options: CommandCodeRequestOptions & { force?: boolean } = {},
): Promise<CommandCodeCatalogModel[]> {
  if (!options.force && cachedCatalog && Date.now() - cachedCatalog.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return cachedCatalog.models
  }
  if (catalogInFlight) return catalogInFlight
  const request = fetchProviderModels(options)
    .then((models) => {
      if (models.length > 0) cachedCatalog = { models, fetchedAt: Date.now() }
      return models.length > 0 ? models : cachedCatalog?.models ?? []
    })
    .catch(() => cachedCatalog?.models ?? [])
  catalogInFlight = request
  try {
    return await request
  } finally {
    if (catalogInFlight === request) catalogInFlight = null
  }
}

export function getCachedCatalog(): CommandCodeCatalogModel[] {
  return cachedCatalog?.models ?? []
}

export function clearCachedCatalog(): void {
  cachedCatalog = undefined
  catalogInFlight = null
}

/** Effective context window: a saved override wins over the catalog value. */
export function effectiveContextWindow(
  modelId: string,
  catalog: readonly CommandCodeCatalogModel[],
  overrides: Record<string, number>,
): number {
  const override = overrides[modelId]
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override
  const entry = catalog.find((model) => model.id === modelId)
  return entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
}

// ---------------------------------------------------------------------------
// Authenticated account facts
// ---------------------------------------------------------------------------

async function getJson(
  path: string,
  apiKey: string,
  options: CommandCodeRequestOptions & { method?: 'GET' | 'POST'; body?: Record<string, unknown> } = {},
): Promise<unknown> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.apiEnv ?? resolveApiEnv()
  const response = await fetchFn(`${apiBaseUrl(env)}${path}`, {
    method: options.method ?? 'GET',
    headers: commandCodeHeaders(apiKey),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Command Code ${path} failed: ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`)
  }
  return response.json()
}

export function whoami(apiKey: string, options: CommandCodeRequestOptions = {}): Promise<unknown> {
  return getJson(WHOAMI_PATH, apiKey, options)
}

/**
 * Verify one API key and read the account facts behind it.
 *
 * This is the single validation point used by manual key entry, by the browser
 * callback, and by the connection test, so a key that cannot answer `whoami`
 * is never stored.
 */
export async function verifyApiKey(
  apiKey: string,
  options: CommandCodeRequestOptions = {},
): Promise<CommandCodeAccount> {
  const payload = await whoami(apiKey, options)
  return parseWhoami(payload, { authenticatedAt: Date.now() })
}

let cachedQuota: CommandCodeAccountQuota | undefined
let quotaInFlight: Promise<CommandCodeAccountQuota> | null = null
let quotaCacheEpoch = 0

export function getCachedQuota(): CommandCodeAccountQuota | undefined {
  return cachedQuota
}

export function clearCachedQuota(): void {
  quotaCacheEpoch += 1
  cachedQuota = undefined
  quotaInFlight = null
}

/**
 * Read credits, subscriptions, and usage, tolerating a service that answers
 * only some of the three. Every failure is captured as a missing source rather
 * than failing the whole snapshot, because a working credit balance is still
 * worth showing when the usage route is down.
 */
export async function fetchAccountQuota(
  store = new FileCredentialStore(),
  fetchFn: typeof fetch = fetch,
  force = false,
): Promise<CommandCodeAccountQuota> {
  if (!force && cachedQuota && Date.now() - (cachedQuota.fetchedAt || 0) < QUOTA_CACHE_TTL_MS) {
    return cachedQuota
  }
  if (quotaInFlight) return quotaInFlight

  const epoch = quotaCacheEpoch
  const request = (async (): Promise<CommandCodeAccountQuota> => {
    const credentials = await store.read()
    if (!credentials) throw new Error('Not signed in to Command Code.')
    const options: CommandCodeRequestOptions = { fetchFn, apiEnv: credentials.apiEnv ?? resolveApiEnv() }

    const [whoamiResult, creditsResult, subscriptionsResult, usageResult] = await Promise.allSettled([
      whoami(credentials.apiKey, options),
      getJson(BILLING_CREDITS_PATH, credentials.apiKey, options),
      getJson(BILLING_SUBSCRIPTIONS_PATH, credentials.apiKey, options),
      getJson(USAGE_SUMMARY_PATH, credentials.apiKey, options),
    ])

    const sources: string[] = []
    const value = (result: PromiseSettledResult<unknown>, name: string): unknown => {
      if (result.status === 'fulfilled') {
        sources.push(name)
        return result.value
      }
      return undefined
    }

    const whoamiPayload = value(whoamiResult, 'whoami')
    const creditsPayload = value(creditsResult, 'billing/credits')
    const subscriptionsPayload = value(subscriptionsResult, 'billing/subscriptions')
    const usagePayload = value(usageResult, 'usage/summary')

    // The plan lives on the subscription (or, when that route is down, on the
    // credits payload) and only the id is reported, so it is resolved to the
    // name the CLI shows. `/alpha/whoami` never mentions the plan at all.
    const storedPlan = resolveCommandCodePlan(credentials.planId)
    const planId = parsePlanId([subscriptionsPayload, creditsPayload])
      ?? storedPlan?.id
      ?? credentials.planId
      ?? null

    const account = parseWhoami(whoamiPayload, {
      userId: credentials.userId,
      userName: credentials.userName,
      email: credentials.email,
      keyName: credentials.keyName,
      organizationName: credentials.organizationName,
      planLabel: commandCodePlanLabel(planId) ?? credentials.planLabel,
      planId,
      authenticatedAt: credentials.authenticatedAt ?? null,
    })

    const subscriptionStatus = parseSubscriptionStatus(subscriptionsPayload)
    const plan = resolveCommandCodePlan(planId)

    const snapshot: CommandCodeAccountQuota = {
      account,
      creditBalance: extractCreditsBalance(creditsPayload) ?? extractCreditsBalance(subscriptionsPayload),
      unlimited: extractUnlimited(creditsPayload) || extractUnlimited(subscriptionsPayload),
      planId,
      planName: account.planLabel,
      planMonthlyCredits: plan?.monthlyCredits ?? null,
      subscriptionStatus,
      periodEndsAt: parseSubscriptionPeriodEnd(subscriptionsPayload),
      meters: [...parseMeters(creditsPayload), ...parseMeters(subscriptionsPayload)],
      windows: parseUsageWindows(usagePayload),
      fetchedAt: Date.now(),
      sources,
    }

    if (epoch !== quotaCacheEpoch) return snapshot
    cachedQuota = snapshot
    return snapshot
  })()

  quotaInFlight = request
  try {
    return await request
  } finally {
    if (quotaInFlight === request) quotaInFlight = null
  }
}

/** Catalog entry list with the exact defaults the settings card renders. */
export function buildModelOptions(
  catalog: readonly CommandCodeCatalogModel[],
  enabledModelIds: readonly string[],
  overrides: Record<string, number>,
): Array<{
  id: string
  name: string
  enabled: boolean
  defaultContextWindow: number
  contextWindow: number
  defaultMaxTokens: number
  reasoningEfforts?: string[]
  wire: 'openai' | 'anthropic'
}> {
  const enabled = new Set(enabledModelIds)
  return catalog.map((model) => {
    const contextWindow = model.contextWindow ?? 128_000
    const efforts = reasoningEffortsFor(model.id)
    return {
      id: model.id,
      name: model.name ?? model.id,
      enabled: enabled.has(model.id),
      defaultContextWindow: contextWindow,
      contextWindow: overrides[model.id] && overrides[model.id] > 0 ? overrides[model.id] : contextWindow,
      defaultMaxTokens: maxOutputTokensFor(model.id),
      ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
      wire: wireForModel(model.id),
    }
  })
}

export { PROVIDER_ID }
