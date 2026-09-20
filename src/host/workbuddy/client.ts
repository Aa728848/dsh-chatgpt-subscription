import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  WorkBuddyAccount,
  WorkBuddyAccountQuota,
  WorkBuddyMeter,
} from '../../shared/workbuddy-contracts.ts'
import {
  BILLING_PATH,
  CLIENT_PRODUCT,
  CLIENT_USER_AGENT,
  CONFIG_PATH,
  DEFAULT_DOMAIN,
  DISCOVERY_TIMEOUT_MS,
  HEADER_DOMAIN,
  HEADER_ENTERPRISE_ID,
  HEADER_IDE_NAME,
  HEADER_PRODUCT,
  HEADER_REFRESH_SOURCE,
  HEADER_REFRESH_TOKEN,
  HEADER_REQUESTED_WITH,
  HEADER_TENANT_ID,
  HEADER_USER_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
  REFRESH_PATH,
  QUOTA_CACHE_TTL_MS,
  isIntlDomain,
  refreshSourceForDomain,
} from './types.ts'
import { FileCredentialStore, workBuddyAccountId, type WorkBuddyCredentials } from './token-store.ts'
import type { WorkBuddyModelEntry } from './model-catalog.ts'
import { WORKBUDDY_REASONING_EFFORTS } from '../../shared/workbuddy-contracts.ts'

export interface WorkBuddyRequestOptions {
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
    const parsed = Number(value.replace(/[,\s]/g, ''))
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Attribution and identity headers for one backend request.
 *
 * The gateway gates on this header set: the international deployment answers
 * 401 without the CLI user agent and matching `Origin`/`Referer`, and both
 * deployments read the account identity headers rather than deriving it from
 * the bearer token alone.
 */
export function workBuddyHeaders(
  credentials: Pick<WorkBuddyCredentials, 'accessToken' | 'domain' | 'uid' | 'enterpriseId' | 'backend'>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const domain = credentials.domain || DEFAULT_DOMAIN
  const intl = isIntlDomain(domain)
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${credentials.accessToken}`,
    [HEADER_USER_ID]: credentials.uid ?? '',
    [HEADER_ENTERPRISE_ID]: credentials.enterpriseId ?? '',
    [HEADER_TENANT_ID]: credentials.enterpriseId ?? '',
    [HEADER_DOMAIN]: domain,
    [HEADER_PRODUCT]: CLIENT_PRODUCT,
    [HEADER_IDE_NAME]: 'CodeBuddyIDE',
    [HEADER_REQUESTED_WITH]: 'XMLHttpRequest',
    'user-agent': CLIENT_USER_AGENT,
    // The international backend validates the browser origin the IDE would send.
    ...(intl ? { origin: credentials.backend, referer: `${credentials.backend}/` } : {}),
    ...extra,
  }
}

/**
 * Refresh an access token against the endpoint the official IDE uses.
 *
 * The response carries a whole new `auth` block rather than just a token, so it
 * is merged over the current one: fields the endpoint omits (the domain, the
 * refresh lifetime) must survive, or the next refresh would lose its target.
 */
export async function refreshCredentials(
  credentials: WorkBuddyCredentials,
  options: WorkBuddyRequestOptions = {},
): Promise<WorkBuddyCredentials> {
  const fetchFn = options.fetchFn ?? fetch
  const response = await fetchFn(`${credentials.backend}${REFRESH_PATH}`, {
    method: 'POST',
    headers: workBuddyHeaders(credentials, {
      [HEADER_REFRESH_TOKEN]: credentials.refreshToken,
      [HEADER_REFRESH_SOURCE]: refreshSourceForDomain(credentials.domain),
    }),
    body: '{}',
    signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
  })

  const text = await response.text().catch(() => '')
  // A refresh the service refused is permanent for this account: the pool
  // records it and routes to another one, while a transport failure stays
  // transient and must leave the account in place.
  if (!response.ok) {
    const detail = text.slice(0, 200)
    throw new LlmError(
      `${PROVIDER_NAME} token refresh failed (${response.status})${detail ? `: ${detail}` : ''}`,
      response.status === 401 || response.status === 403 ? 'INVALID_CREDENTIAL' : 'TRANSPORT',
      { status: response.status },
    )
  }

  const payload = asRecord(JSON.parse(text) as unknown)
  const data = asRecord(payload?.data)
  if (payload === undefined || payload.code !== 0 || data === undefined) {
    throw new LlmError(
      `${PROVIDER_NAME} token refresh was rejected: ${asString(payload?.msg) ?? 'no detail'}`,
      'INVALID_CREDENTIAL',
    )
  }

  const accessToken = asString(data.accessToken)
  if (accessToken === undefined) {
    throw new Error(`${PROVIDER_NAME} token refresh returned no access token`)
  }

  const expiresIn = asNumber(data.expiresIn)
  const expiresAt = asNumber(data.expiresAt)
    ?? (expiresIn === undefined ? credentials.expiresAt : Date.now() + expiresIn * 1000)

  return {
    ...credentials,
    accessToken,
    refreshToken: asString(data.refreshToken) ?? credentials.refreshToken,
    expiresAt,
    // The endpoint usually echoes the domain; when it does not, the account
    // stays on the backend it was already served by.
    domain: asString(data.domain) ?? credentials.domain,
  }
}

/** Public account facts for the settings card. */
export function accountFromCredentials(credentials: WorkBuddyCredentials): WorkBuddyAccount {
  return {
    id: workBuddyAccountId(credentials),
    uid: credentials.uid ?? null,
    nickname: credentials.nickname ?? null,
    uin: credentials.uin ?? null,
    accountType: credentials.accountType ?? null,
    enterpriseId: credentials.enterpriseId ?? null,
    region: credentials.region,
    backend: credentials.backend,
    domain: credentials.domain,
    expiresAt: credentials.expiresAt > 0 ? credentials.expiresAt : null,
    sourceFile: credentials.sourceFile || null,
    source: credentials.source,
    removable: credentials.source === 'managed',
    hidden: false,
  }
}

// ---------------------------------------------------------------------------
// Live model catalog
// ---------------------------------------------------------------------------

/**
 * Parse one `/v3/config` payload's model list.
 *
 * Each entry carries the facts this route needs directly, so nothing is
 * inferred from the model's name. Image-generation tools (`tags` naming
 * `text-to-image`/`image-to-image`) are skipped: they are not chat models and
 * carry no context window.
 */
export function parseConfigModels(payload: unknown, region: WorkBuddyCredentials['region']): WorkBuddyModelEntry[] {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data) ?? root
  const list = Array.isArray(data.models) ? data.models : []

  const models: WorkBuddyModelEntry[] = []
  for (const item of list) {
    const record = asRecord(item)
    if (record === undefined) continue
    const id = asString(record.id)
    if (id === undefined) continue
    if (Array.isArray(record.tags) && record.tags.some((tag) => String(tag).includes('image'))) continue

    const maxContextWindow = asNumber(record.maxAllowedSize) ?? asNumber(record.maxInputTokens)
    if (maxContextWindow === undefined) continue

    const reasoning = asRecord(record.reasoning) ?? {}
    // The gateway publishes the reasoning ladder in two shapes:
    //   { supportedEfforts: [...], defaultEffort: 'x' }  -> an explicit ladder
    //   { effort: 'x' }                                  -> a DEFAULT only
    // The second shape must not be read as a one-entry ladder. Measured on
    // `deepseek-v4.1-flash`, which reports `effort: 'high'`, every level from
    // `minimal` to `max` is accepted; treating that field as the whole ladder
    // silently rejected a caller's explicit choice. Such a model therefore gets
    // the shared ladder while `effort` remains its default.
    const declared = Array.isArray(reasoning.supportedEfforts)
      ? reasoning.supportedEfforts.filter((effort): effort is string => typeof effort === 'string')
      : []
    const single = asString(reasoning.effort)
    const efforts = declared.length > 0
      ? declared
      : (single === undefined ? [] : [...WORKBUDDY_REASONING_EFFORTS])

    // The gateway reports the length it serves by default separately from the
    // maximum the model allows. This route requests no explicit length, so the
    // served default is the figure DSH's overflow decisions must use.
    const contextWindowConfig = asRecord(record.contextWindow)
    const servedDefault = asNumber(contextWindowConfig?.defaultLength)

    models.push({
      id,
      name: asString(record.name) ?? id,
      contextWindow: servedDefault ?? maxContextWindow,
      maxContextWindow,
      maxTokens: asNumber(record.maxOutputTokens) ?? 32_768,
      regions: [region],
      supportsImage: record.supportsImages === true,
      reasoningEfforts: efforts,
      defaultReasoningEffort: asString(reasoning.defaultEffort) ?? single ?? null,
      canDisableThinking: reasoning.canDisableThinking === true,
      description: asString(record.descriptionZh) ?? asString(record.descriptionEn) ?? '',
    })  }
  return models
}

let cachedCatalog: { region: WorkBuddyCredentials['region']; models: WorkBuddyModelEntry[]; fetchedAt: number } | undefined
let catalogInFlight: Promise<WorkBuddyModelEntry[]> | null = null
let catalogInFlightRegion: WorkBuddyCredentials['region'] | null = null
const CATALOG_CACHE_TTL_MS = 30 * 60 * 1000

export function getCachedCatalog(): WorkBuddyModelEntry[] {
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
 * The gateway is the authority on capabilities, so a successful read replaces
 * the shipped table entirely; a failure returns an empty list and the caller
 * falls back, which keeps a first run usable before sign-in.
 */
export async function fetchConfigCatalog(
  credentials: WorkBuddyCredentials,
  options: WorkBuddyRequestOptions = {},
): Promise<WorkBuddyModelEntry[]> {
  const fetchFn = options.fetchFn ?? fetch
  const response = await fetchFn(`${credentials.backend}${CONFIG_PATH}`, {
    headers: workBuddyHeaders(credentials),
    signal: timeoutSignal(options.signal, DISCOVERY_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`${PROVIDER_NAME} model catalog failed: ${response.status}`)
  }
  return parseConfigModels(await response.json(), credentials.region)
}

/** Cached catalog with a TTL; a failed refresh keeps the previous snapshot. */
export async function loadConfigCatalog(
  credentials: WorkBuddyCredentials,
  options: WorkBuddyRequestOptions & { force?: boolean } = {},
): Promise<WorkBuddyModelEntry[]> {
  if (!options.force
    && cachedCatalog !== undefined
    && cachedCatalog.region === credentials.region
    && Date.now() - cachedCatalog.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return cachedCatalog.models
  }
  if (catalogInFlight && catalogInFlightRegion === credentials.region) return catalogInFlight
  // A snapshot read for the other region must never stand in: its entries
  // declare only the region they came from, so the caller's region filter drops
  // every one of them and the picker ends up offering nothing instead of
  // falling back to the shipped table.
  const sameRegionCache = (): WorkBuddyModelEntry[] =>
    cachedCatalog?.region === credentials.region ? cachedCatalog.models : []
  const request = fetchConfigCatalog(credentials, options)
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
// Billing / allowance
// ---------------------------------------------------------------------------

function formatAmount(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Parse one `Capacity*` account record into the public quota shape. */
export interface ParsedBilling {
  packageName: string | null
  totalCredits: number | null
  remainingCredits: number | null
  cycleUsedCredits: number | null
  cycleCredits: number | null
  cycleStartsAt: number | null
  cycleEndsAt: number | null
}

/**
 * Parse the billing payload's account list.
 *
 * The response nests as `data.Response.Data.Accounts[]`; each entry describes
 * one purchased package with its own capacity counters. The first entry is the
 * active subscription, and the totals are summed across all of them because a
 * user can hold several packages at once.
 */
export function parseBilling(payload: unknown): ParsedBilling {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data) ?? root
  const response = asRecord(data.Response) ?? data
  const body = asRecord(response.Data) ?? response
  const accounts = Array.isArray(body.Accounts) ? body.Accounts : []

  let total: number | undefined
  let remaining: number | undefined
  let cycleUsed: number | undefined
  let cycleTotal: number | undefined
  let packageName: string | null = null
  let cycleStart: number | null = null
  let cycleEnd: number | null = null

  for (const entry of accounts) {
    const record = asRecord(entry)
    if (record === undefined) continue
    if (packageName === null) packageName = asString(record.PackageName) ?? null
    const size = asNumber(record.CapacitySize)
    const remain = asNumber(record.CapacityRemain)
    const used = asNumber(record.CycleCapacityUsed)
    const cycleSize = asNumber(record.CycleCapacitySize)
    if (size !== undefined) total = (total ?? 0) + size
    if (remain !== undefined) remaining = (remaining ?? 0) + remain
    if (used !== undefined) cycleUsed = (cycleUsed ?? 0) + used
    if (cycleSize !== undefined) cycleTotal = (cycleTotal ?? 0) + cycleSize
    cycleStart ??= parseCycleTime(record.CycleStartTime)
    cycleEnd ??= parseCycleTime(record.CycleEndTime)
  }

  return {
    packageName,
    totalCredits: total ?? null,
    remainingCredits: remaining ?? null,
    cycleUsedCredits: cycleUsed ?? null,
    cycleCredits: cycleTotal ?? null,
    cycleStartsAt: cycleStart,
    cycleEndsAt: cycleEnd,
  }
}

/**
 * Parse a cycle boundary.
 *
 * The service sends these as local-time strings without a zone
 * (`2026-09-01 00:00:00`), which `Date.parse` reads as local time — the same
 * reading the IDE's own panel uses, so the card agrees with it.
 */
export function parseCycleTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e11 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value !== 'string' || value.trim() === '') return null
  const normalized = value.trim().replace(' ', 'T')
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

/** Turn a parsed billing snapshot into the meters the card renders. */
export function billingMeters(billing: ParsedBilling): WorkBuddyMeter[] {
  const meters: WorkBuddyMeter[] = []
  const { cycleCredits, cycleUsedCredits, totalCredits, remainingCredits } = billing

  if (cycleCredits !== null && cycleCredits > 0 && cycleUsedCredits !== null) {
    const usedFraction = clamp01(cycleUsedCredits / cycleCredits)
    meters.push({
      id: 'cycle',
      label: 'Billing cycle',
      usedFraction,
      remainingFraction: Math.max(0, 1 - usedFraction),
      used: formatAmount(cycleUsedCredits),
      limit: formatAmount(cycleCredits),
      resetsAt: billing.cycleEndsAt,
      description: 'Credits consumed in the current cycle',
    })
  }

  // The package capacity is reported separately from the cycle counters, and a
  // package with no cycle figures still has a meaningful remaining balance.
  if (totalCredits !== null && totalCredits > 0 && remainingCredits !== null) {
    const remainingFraction = clamp01(remainingCredits / totalCredits)
    meters.push({
      id: 'package',
      label: billing.packageName ?? 'Package credits',
      usedFraction: Math.max(0, 1 - remainingFraction),
      remainingFraction,
      used: formatAmount(totalCredits - remainingCredits),
      limit: formatAmount(totalCredits),
      resetsAt: billing.cycleEndsAt,
      description: 'Remaining credits in the purchased package',
    })
  }

  return meters
}

let cachedQuota: WorkBuddyAccountQuota | undefined
let quotaInFlight: Promise<WorkBuddyAccountQuota> | null = null
let quotaInFlightAccountId: string | null = null
let quotaCacheEpoch = 0

export function getCachedQuota(): WorkBuddyAccountQuota | undefined {
  return cachedQuota
}

export function clearCachedQuota(): void {
  quotaCacheEpoch += 1
  cachedQuota = undefined
  quotaInFlight = null
  quotaInFlightAccountId = null
}

/**
 * Read the account's credit allowance.
 *
 * Only one billing route exists here, so a failure is a real failure rather
 * than a partially-answered snapshot: the caller decides whether to surface it.
 */
export async function fetchAccountQuota(
  store = new FileCredentialStore(),
  fetchFn: typeof fetch = fetch,
  force = false,
  accountId: string | null = null,
  hiddenAccountIds: readonly string[] = [],
): Promise<WorkBuddyAccountQuota> {
  const credentials = await store.read({ accountId, hiddenAccountIds })
  if (credentials === null) throw new Error(`Not signed in to ${PROVIDER_NAME}.`)
  const requestedAccountId = workBuddyAccountId(credentials)
  if (!force
    && cachedQuota
    && cachedQuota.account.id === requestedAccountId
    && Date.now() - (cachedQuota.fetchedAt || 0) < QUOTA_CACHE_TTL_MS) {
    return cachedQuota
  }
  // A poll already serving another account must not be reused after a switch.
  if (quotaInFlight && quotaInFlightAccountId === requestedAccountId) return quotaInFlight

  const epoch = quotaCacheEpoch
  const request = (async (): Promise<WorkBuddyAccountQuota> => {
    const current = await store.read({ accountId: requestedAccountId, hiddenAccountIds })
    if (current === null) throw new Error(`Not signed in to ${PROVIDER_NAME}.`)

    const fresh = await store.ensureFresh(current, (candidate) => refreshCredentials(candidate, { fetchFn }))

    const response = await fetchFn(`${fresh.backend}${BILLING_PATH}`, {
      method: 'POST',
      headers: workBuddyHeaders(fresh),
      body: '{}',
      signal: timeoutSignal(undefined, DISCOVERY_TIMEOUT_MS),
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      throw new Error(`${PROVIDER_NAME} billing lookup failed (${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`)
    }

    const payload = JSON.parse(text) as unknown
    const root = asRecord(payload)
    if (root !== undefined && root.code !== 0) {
      throw new Error(`${PROVIDER_NAME} billing lookup was rejected: ${asString(root.msg) ?? 'no detail'}`)
    }

    const billing = parseBilling(payload)
    const snapshot: WorkBuddyAccountQuota = {
      account: accountFromCredentials(fresh),
      packageName: billing.packageName,
      totalCredits: billing.totalCredits,
      remainingCredits: billing.remainingCredits,
      cycleUsedCredits: billing.cycleUsedCredits,
      cycleCredits: billing.cycleCredits,
      cycleStartsAt: billing.cycleStartsAt,
      cycleEndsAt: billing.cycleEndsAt,
      meters: billingMeters(billing),
      fetchedAt: Date.now(),
      sources: ['billing/meter/get-user-resource'],
    }

    if (epoch !== quotaCacheEpoch) return snapshot
    cachedQuota = snapshot
    return snapshot
  })()

  quotaInFlight = request
  quotaInFlightAccountId = requestedAccountId
  try {
    return await request
  } finally {
    if (quotaInFlight === request) {
      quotaInFlight = null
      quotaInFlightAccountId = null
    }
  }
}

export { PROVIDER_ID, PROVIDER_NAME }
