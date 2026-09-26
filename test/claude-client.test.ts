/**
 * Tests for the Claude subscription HTTP surface.
 *
 * WHAT THESE TESTS ARE FOR. Each one is named after the property it protects
 * rather than after the function it calls, because every property below is one
 * that a plausible implementation gets WRONG in a way no type checker can see:
 *
 *   1. a subscription request must carry NO x-api-key — sending both it and the
 *      bearer token is a documented 401 cause, and the realistic way the bug
 *      returns is a caller spreading another provider's header map;
 *   2. the reported client version must be read at CALL time, because upstream
 *      enforces a minimum and the pin exists precisely so a running host can
 *      react to claude_code_version_too_old without a restart;
 *   3. the live model listing may write the context window and NOTHING else —
 *      image support and the thinking form are catalog facts that the listing
 *      does not speak about, and a merge that clobbered them would produce
 *      requests the model rejects;
 *   4. the two quota sources are in DIFFERENT UNITS: the usage payload's
 *      utilization is a percent 0-100 while the unified response header's is a
 *      fraction 0-1, and their reset instants are ISO 8601 versus epoch SECONDS.
 *      A parser that conflates either pair shows a confidently wrong number;
 *   5. response-header data may feed the badge but may not permanently replace a
 *      full read, so the cache tracks "last write" and "last full read"
 *      separately.
 *
 * Everything runs against an injected fetch. No test in this file touches the
 * network, and no endpoint's behaviour is asserted without a fixture that was
 * written down here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ClaudeRequestError,
  PROBE_DEFAULT_MODEL,
  buildClaudeHeaders,
  claudeBetas,
  claudeUserAgent,
  classifyFailure,
  clearCachedCatalog,
  clearCachedQuota,
  epochSecondsToIso,
  fetchAccountQuota,
  getCachedCatalog,
  getCachedQuota,
  isCatalogFallback,
  loadCatalog,
  mergeListingIntoCatalog,
  parseQuotaHeaders,
  parseUsagePayload,
  probeConnection,
  recordQuotaFromHeaders,
  tightestQuotaWindow,
  type ClaudeFailure,
  type ClaudeUsageWindow,
} from '../src/host/claude/client.ts'
import { FALLBACK_MODELS, resolveClaudeModel } from '../src/host/claude/model-catalog.ts'
import {
  ANTHROPIC_VERSION,
  API_BASE,
  CATALOG_CACHE_TTL_MS,
  CLAUDE_CODE_BETA,
  ERROR_CODE_CLIENT_VERSION_TOO_OLD,
  ERROR_TYPE,
  INTERLEAVED_THINKING_BETA,
  MESSAGES_PATH,
  MODELS_PATH,
  OAUTH_BETA,
  QUOTA_CACHE_TTL_MS,
  QUOTA_FULL_REFRESH_MS,
  USAGE_PATH,
  claudeCliVersion,
  setClaudeCliVersion,
  type ClaudeErrorType,
} from '../src/host/claude/types.ts'
import type { ClaudeCredentials } from '../src/host/claude/token-store.ts'

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** Distinctive secret sentinel, so a leak would be greppable rather than plausible. */
const ACCESS_TOKEN = 'ACCESS-TOKEN-SENTINEL-8f3a'
/** The credential's cache key, spelled the way the module derives it. */
const ACCOUNT_KEY = ACCESS_TOKEN.slice(-8)

const CREDENTIALS: ClaudeCredentials = {
  accessToken: ACCESS_TOKEN,
  refreshToken: 'REFRESH-TOKEN-SENTINEL-91cd',
  expiresAt: 4_000_000_000_000,
  scopes: ['user:inference', 'user:profile'],
}

/** A reset instant used by BOTH quota fixtures, so the two units can be compared. */
const RESET_ISO = '2026-01-01T05:00:00.000Z'
/** The same instant, in the unit the RESPONSE HEADER uses: epoch SECONDS. */
const RESET_EPOCH_SECONDS = String(Date.parse(RESET_ISO) / 1000)

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/**
 * A fetch stub that records every call.
 *
 * The recorded headers are read through a real Headers object so the assertions
 * below are case-insensitive, exactly as the wire is.
 */
function recordingFetch(respond: (call: FetchCall, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers((init?.headers ?? {}) as HeadersInit)
    const flat: Record<string, string> = {}
    headers.forEach((value, key) => { flat[key] = value })
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: flat,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
    }
    calls.push(call)
    return respond(call, calls.length - 1)
  })
  return { fn: fn as unknown as typeof fetch, calls, mock: fn }
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function errorResponse(status: number, type: ClaudeErrorType | string, message: string, headers: Record<string, string> = {}): Response {
  return jsonResponse({ type: 'error', error: { type, message } }, status, headers)
}

/** The unified rate-limit headers, as one map. */
function unifiedHeaders(entries: Record<string, string> = {}): Headers {
  return new Headers(entries)
}

beforeEach(() => {
  // Every test starts from a clean cache and the shipped version baseline; both
  // are process-global module state that would otherwise leak across tests.
  clearCachedCatalog()
  clearCachedQuota()
  setClaudeCliVersion(null)
})

afterEach(() => {
  vi.useRealTimers()
  setClaudeCliVersion(null)
  clearCachedCatalog()
  clearCachedQuota()
})

// ---------------------------------------------------------------------------
// 1. Headers
// ---------------------------------------------------------------------------

describe('subscription request headers', () => {
  it('never sends x-api-key alongside the bearer token', () => {
    const headers = buildClaudeHeaders(ACCESS_TOKEN, { model: 'claude-sonnet-4-6' })

    // The two halves of the property: the bearer token IS there, and the API-key
    // field is ABSENT — not empty, absent. A present-but-empty x-api-key is
    // still a header the gateway can reject on.
    expect(headers.authorization).toBe('Bearer ' + ACCESS_TOKEN)
    expect('x-api-key' in headers).toBe(false)
    expect(Object.keys(headers)).not.toContain('x-api-key')
    // Belt and braces: a case-insensitive scan, in case a later change starts
    // emitting the key in some other casing.
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('x-api-key')
  })

  it('strips an x-api-key a caller tries to inject through extra', () => {
    const headers = buildClaudeHeaders(ACCESS_TOKEN, {
      extra: { 'X-Api-Key': 'SMUGGLED-KEY', 'anthropic-beta': OAUTH_BETA },
    })

    expect('x-api-key' in headers).toBe(false)
    expect(Object.values(headers)).not.toContain('SMUGGLED-KEY')
    // A caller MAY still override a header this module owns — extra is spread
    // last — which is why the beta the caller named is the one that survived.
    expect(headers['anthropic-beta']).toBe(OAUTH_BETA)
  })

  it('reports the Claude Code identity, read at call time rather than frozen at import', () => {
    expect(buildClaudeHeaders(ACCESS_TOKEN)['user-agent']).toBe('claude-cli/' + claudeCliVersion() + ' (external, cli)')
    expect(buildClaudeHeaders(ACCESS_TOKEN)['x-app']).toBe('cli')
    expect(buildClaudeHeaders(ACCESS_TOKEN)['anthropic-version']).toBe(ANTHROPIC_VERSION)

    // A pin applied AFTER the module was loaded must reach the next request: the
    // version is the one value upstream enforces a floor on, and the whole point
    // of setClaudeCliVersion is that a running host can raise it without a
    // restart after claude_code_version_too_old.
    setClaudeCliVersion('9.9.9')
    expect(buildClaudeHeaders(ACCESS_TOKEN)['user-agent']).toBe('claude-cli/9.9.9 (external, cli)')
  })

  it('reports the claude-code product string on the usage surface', () => {
    expect(claudeUserAgent('code')).toBe('claude-code/' + claudeCliVersion())
    expect(claudeUserAgent('cli')).toBe('claude-cli/' + claudeCliVersion() + ' (external, cli)')
  })

  it('always sends the oauth and claude-code betas, and adds thinking only when asked', () => {
    const plain = buildClaudeHeaders(ACCESS_TOKEN, { model: 'claude-sonnet-4-6' })['anthropic-beta'].split(',')
    expect(plain).toContain(OAUTH_BETA)
    expect(plain).toContain(CLAUDE_CODE_BETA)
    expect(plain).not.toContain(INTERLEAVED_THINKING_BETA)

    const thinking = buildClaudeHeaders(ACCESS_TOKEN, { model: 'claude-sonnet-4-6', thinking: true })['anthropic-beta'].split(',')
    expect(thinking).toContain(INTERLEAVED_THINKING_BETA)
    expect(thinking).toContain(OAUTH_BETA)
  })

  it('withholds the claude-code beta from a haiku model, the reference own rule', () => {
    const haiku = claudeBetas({ model: 'claude-haiku-4-5' })
    expect(haiku).not.toContain(CLAUDE_CODE_BETA)
    // The oauth beta is unconditional: it is what makes the token usable at all.
    expect(haiku).toContain(OAUTH_BETA)

    // A dated haiku id is matched on the family token, not on an exact string.
    expect(claudeBetas({ model: 'claude-haiku-4-5-20251001' })).not.toContain(CLAUDE_CODE_BETA)
    // A request that names no model keeps the beta; the usage read is one.
    expect(claudeBetas({})).toContain(CLAUDE_CODE_BETA)
    expect(claudeBetas({ model: 'claude-opus-4-7' })).toContain(CLAUDE_CODE_BETA)
  })

  it('sends content-type on a write and omits it on a read', () => {
    expect(buildClaudeHeaders(ACCESS_TOKEN, { method: 'POST' })['content-type']).toBe('application/json')
    expect(buildClaudeHeaders(ACCESS_TOKEN)['content-type']).toBe('application/json')
    expect('content-type' in buildClaudeHeaders(ACCESS_TOKEN, { method: 'GET' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Model listing
// ---------------------------------------------------------------------------

describe('model listing', () => {
  it('reads the listing envelope and keeps every capability from the catalog', () => {
    const merged = mergeListingIntoCatalog([
      { id: 'claude-opus-4-7', contextWindow: 500_000 },
      { id: 'claude-haiku-4-5', contextWindow: 999_999 },
    ])

    // The listing wrote exactly one field: the whole entry is the catalog entry
    // with a different window, so a capability cannot have been replaced by
    // accident or by design.
    expect(merged[0]).toEqual({ ...resolveClaudeModel('claude-opus-4-7'), contextWindow: 500_000 })
    // Without the listing, this model would still report 1M; with it, 500K.
    expect(resolveClaudeModel('claude-opus-4-7').contextWindow).toBe(1_000_000)
    expect(merged[0]?.contextWindow).toBe(500_000)
    // Capabilities that the listing said nothing about are untouched.
    expect(merged[0]?.supportsTemperature).toBe(false)
    expect(merged[0]?.thinkingMode).toBe('adaptive')
    expect(merged[0]?.reasoningEfforts).toEqual(resolveClaudeModel('claude-opus-4-7').reasoningEfforts)
    expect(merged[1]?.supportsImage).toBe(true)
    expect(merged[1]?.maxTokens).toBe(resolveClaudeModel('claude-haiku-4-5').maxTokens)
  })

  it('keeps the conservative stub for an id the catalog does not know', () => {
    const merged = mergeListingIntoCatalog([{ id: 'claude-unheard-of-9', contextWindow: 123_456 }])

    const stub = resolveClaudeModel('claude-unheard-of-9')
    expect(merged[0]).toEqual({ ...stub, contextWindow: 123_456 })
    // The stub's defining property: it claims nothing.
    expect(merged[0]?.supportsImage).toBe(false)
    expect(merged[0]?.thinkingMode).toBe('none')
    expect(merged[0]?.reasoningEfforts).toEqual([])
  })

  it('leaves the catalog window in place when the listing states none', () => {
    const merged = mergeListingIntoCatalog([{ id: 'claude-sonnet-4-6', contextWindow: null }])
    expect(merged[0]?.contextWindow).toBe(resolveClaudeModel('claude-sonnet-4-6').contextWindow)
  })

  it('GETs the listing with subscription headers and maps the documented envelope', async () => {
    const fetchStub = recordingFetch(() => jsonResponse({
      data: [
        { id: 'claude-opus-4-7', context_window: 400_000 },
        { id: 'claude-sonnet-4-6', max_input_tokens: 300_000 },
        { nonsense: true },
      ],
      has_more: false,
    }))

    const models = await loadCatalog(CREDENTIALS, { fetchFn: fetchStub.fn })

    expect(fetchStub.calls).toHaveLength(1)
    expect(fetchStub.calls[0]?.url).toBe(API_BASE + MODELS_PATH)
    expect(fetchStub.calls[0]?.method).toBe('GET')
    expect(fetchStub.calls[0]?.headers.authorization).toBe('Bearer ' + ACCESS_TOKEN)
    expect('x-api-key' in (fetchStub.calls[0]?.headers ?? {})).toBe(false)
    // Only the ids the server named: the catalog is not widened by the listing.
    expect(models.map((model) => model.id)).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6'])
    expect(models[0]?.contextWindow).toBe(400_000)
    expect(models[1]?.contextWindow).toBe(300_000)
  })

  it('accepts a bare array as well as the envelope', async () => {
    const fetchStub = recordingFetch(() => jsonResponse([{ id: 'claude-sonnet-4-6', context_window: 250_000 }]))
    const models = await loadCatalog(CREDENTIALS, { fetchFn: fetchStub.fn })
    expect(models.map((model) => model.id)).toEqual(['claude-sonnet-4-6'])
    expect(models[0]?.contextWindow).toBe(250_000)
  })

  it('serves the shipped table when the listing fails, so the line still works offline', async () => {
    const fetchStub = recordingFetch(() => new Response('nope', { status: 503 }))

    const models = await loadCatalog(CREDENTIALS, { fetchFn: fetchStub.fn })

    // DSH makes "the model must appear in the catalog" a hard gate, so an empty
    // answer here would block model switching entirely while the account is
    // perfectly usable.
    expect(models).toBe(FALLBACK_MODELS)
    expect(models.length).toBeGreaterThan(0)
    expect(isCatalogFallback()).toBe(true)
    expect(getCachedCatalog()).toBe(FALLBACK_MODELS)
  })

  it('serves the shipped table when the listing succeeds but names nothing usable', async () => {
    const fetchStub = recordingFetch(() => jsonResponse({ data: [{ id: '' }, { nothing: 1 }] }))
    const models = await loadCatalog(CREDENTIALS, { fetchFn: fetchStub.fn })
    expect(models).toBe(FALLBACK_MODELS)
    expect(isCatalogFallback()).toBe(true)
  })

  it('caches a successful listing for its TTL and re-reads only when forced', async () => {
    let version = 1
    const fetchStub = recordingFetch(() => jsonResponse({
      data: [{ id: 'claude-sonnet-4-6', context_window: version === 1 ? 300_000 : 400_000 }],
    }))

    await loadCatalog(CREDENTIALS, { fetchFn: fetchStub.fn })
    const cached = await loadCatalog(CREDENTIALS, { fetchFn: fetchStub.fn })
    expect(fetchStub.mock).toHaveBeenCalledTimes(1)
    expect(cached[0]?.contextWindow).toBe(300_000)

    version = 2
    const forced = await loadCatalog(CREDENTIALS, { fetchFn: fetchStub.fn, force: true })
    expect(fetchStub.mock).toHaveBeenCalledTimes(2)
    expect(forced[0]?.contextWindow).toBe(400_000)
  })

  it('re-reads the listing once the TTL has passed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const fetchStub = recordingFetch(() => jsonResponse({ data: [{ id: 'claude-sonnet-4-6', context_window: 300_000 }] }))

    await loadCatalog(CREDENTIALS, { fetchFn: fetchStub.fn })
    expect(fetchStub.mock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date(Date.now() + CATALOG_CACHE_TTL_MS - 1))
    await loadCatalog(CREDENTIALS, { fetchFn: fetchStub.fn })
    expect(fetchStub.mock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date(Date.now() + 2))
    await loadCatalog(CREDENTIALS, { fetchFn: fetchStub.fn })
    expect(fetchStub.mock).toHaveBeenCalledTimes(2)
  })

  it('collapses concurrent loads into one request', async () => {
    const fetchStub = recordingFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return jsonResponse({ data: [{ id: 'claude-sonnet-4-6', context_window: 300_000 }] })
    })

    // The harness resolves every model of every provider when it builds the
    // picker, so an un-deduplicated load is one round trip per model.
    await Promise.all([
      loadCatalog(CREDENTIALS, { fetchFn: fetchStub.fn }),
      loadCatalog(CREDENTIALS, { fetchFn: fetchStub.fn }),
      loadCatalog(CREDENTIALS, { fetchFn: fetchStub.fn }),
    ])
    expect(fetchStub.mock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Quota — the usage payload, whose unit is a PERCENT
// ---------------------------------------------------------------------------

/** A usage body with the documented keys, plus one churning feature-flag key. */
function usageBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    five_hour: { utilization: 25, resets_at: RESET_ISO },
    seven_day: { utilization: 0, resets_at: '2026-01-08T00:00:00.000Z' },
    seven_day_sonnet: null,
    extra_usage: { is_enabled: true, monthly_limit: 20, used_credits: 3.5, utilization: 17.5 },
    // A feature-flag codename of the kind the payload carries. It is not a
    // window, and reading it as one is how a wrong number reaches the card.
    iguana_necktie: { utilization: 99, resets_at: 'not-a-date' },
    ...overrides,
  })
}

describe('quota — the usage payload reports a PERCENT (0-100)', () => {
  it('reads utilization 25 as 25 percent USED and 75 percent remaining', () => {
    const { windows } = parseUsagePayload(JSON.parse(usageBody()) as unknown)

    expect(windows.map((window) => window.id)).toEqual(['five_hour', 'seven_day'])
    const fiveHour = windows[0] as ClaudeUsageWindow
    expect(fiveHour.usedPercent).toBe(25)
    expect(fiveHour.usedFraction).toBe(0.25)
    expect(fiveHour.remainingPercent).toBe(75)
    expect(fiveHour.resetsAt).toBe(RESET_ISO)
    expect(fiveHour.windowMinutes).toBe(300)
    expect(fiveHour.source).toBe('usage')
  })

  it('treats utilization 0 as nothing used, not as an empty or failed window', () => {
    const { windows } = parseUsagePayload(JSON.parse(usageBody()) as unknown)
    const weekly = windows[1] as ClaudeUsageWindow

    // 0 is the ordinary state of a healthy account. Remaining is 100, and the
    // window is NOT dropped, NOT null and NOT an error.
    expect(weekly.usedPercent).toBe(0)
    expect(weekly.usedFraction).toBe(0)
    expect(weekly.remainingPercent).toBe(100)
  })

  it('ignores unknown keys and never reads a missing key as zero', () => {
    const { windows } = parseUsagePayload(JSON.parse(usageBody()) as unknown)
    expect(windows.map((window) => window.id)).not.toContain('iguana_necktie')

    // A payload that omits a window yields no window for it — it must not be
    // invented as a zeroed one.
    const trimmed = parseUsagePayload({ five_hour: { utilization: 10, resets_at: null } })
    expect(trimmed.windows.map((window) => window.id)).toEqual(['five_hour'])
    expect(trimmed.extraUsage).toBeNull()

    // A documented null window is absent, not zero.
    const nulled = parseUsagePayload({ seven_day_sonnet: null })
    expect(nulled.windows).toEqual([])
  })

  it('reports a window whose utilization the payload did not state as unknown', () => {
    const { windows } = parseUsagePayload({ five_hour: { resets_at: RESET_ISO } })
    const fiveHour = windows[0] as ClaudeUsageWindow
    // "Not stated" is a different statement from 0, and this line does not
    // collapse the two.
    expect(fiveHour.usedPercent).toBeNull()
    expect(fiveHour.usedFraction).toBeNull()
    expect(fiveHour.remainingPercent).toBeNull()
    expect(fiveHour.resetsAt).toBe(RESET_ISO)
  })

  it('reads extra_usage into its own shape', () => {
    const { extraUsage } = parseUsagePayload(JSON.parse(usageBody()) as unknown)
    expect(extraUsage).toEqual({ isEnabled: true, monthlyLimit: 20, usedCredits: 3.5, utilization: 17.5 })
  })
})

// ---------------------------------------------------------------------------
// 4. Quota — the response headers, whose unit is a FRACTION
// ---------------------------------------------------------------------------

describe('quota — the unified response headers report a FRACTION (0-1)', () => {
  it('reads a 5h utilization of 0.25 as 25 percent used', () => {
    const reading = parseQuotaHeaders(unifiedHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '0.25',
      'anthropic-ratelimit-unified-5h-reset': RESET_EPOCH_SECONDS,
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    }))

    expect(reading.windows).toHaveLength(1)
    const fiveHour = reading.windows[0]!
    // The header's own unit is preserved on the wire-shaped fields...
    expect(fiveHour.usedFraction).toBe(0.25)
    // ...and the percent is derived at this boundary, once.
    expect(fiveHour.usedPercent).toBe(25)
    expect(fiveHour.remainingPercent).toBe(75)
    // Epoch SECONDS in, ISO 8601 out.
    expect(fiveHour.resetsAt).toBe(RESET_ISO)
    expect(reading.status).toBe('allowed')
    expect(reading.representativeClaim).toBe('five_hour')
  })

  it('refuses to read a millisecond reset as an epoch-second one', () => {
    // The realistic mistake is a caller handing over Date.now(). Reading it as
    // seconds would place the reset tens of thousands of years out, so the
    // implausible instant is dropped and the card says "unknown" instead.
    expect(epochSecondsToIso(Date.parse(RESET_ISO))).toBeNull()
    const reading = parseQuotaHeaders(unifiedHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '0.25',
      'anthropic-ratelimit-unified-5h-reset': String(Date.parse(RESET_ISO)),
    }))
    expect(reading.windows[0]?.resetsAt).toBeNull()
    // The window itself survives: only the instant was unusable.
    expect(reading.windows[0]?.usedPercent).toBe(25)
  })

  it('carries the 7d window and the overage trio when the response has them', () => {
    const reading = parseQuotaHeaders(unifiedHeaders({
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': RESET_EPOCH_SECONDS,
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-utilization': '0.5',
    }))

    expect(reading.windows.map((window) => window.id)).toEqual(['seven_day'])
    expect(reading.windows[0]?.usedPercent).toBe(100)
    expect(reading.windows[0]?.remainingPercent).toBe(0)
    expect(reading.overage).toEqual({ status: 'allowed', utilization: 0.5 })
    expect(reading.status).toBe('rejected')
  })

  it('yields no reading at all when the response carried no unified headers', () => {
    const reading = parseQuotaHeaders(unifiedHeaders({ 'content-type': 'application/json' }))
    expect(reading.windows).toEqual([])
    expect(reading.status).toBeNull()
    expect(reading.representativeClaim).toBeNull()
    expect(reading.overage).toBeNull()
  })

  it('is case-insensitive, as HTTP headers are', () => {
    const plain = { 'Anthropic-RateLimit-Unified-5H-Utilization': '0.25' }
    expect(parseQuotaHeaders(plain).windows[0]?.usedPercent).toBe(25)
    expect(parseQuotaHeaders(new Headers({ 'Anthropic-RateLimit-Unified-5H-Utilization': '0.25' })).windows[0]?.usedPercent).toBe(25)
  })
})

describe('the two quota units are handled distinctly', () => {
  it('agrees on the number while keeping the two source units separate', () => {
    // 0.25 from a response header and 25 from a usage body describe the SAME
    // state of the world. A parser that conflated the units would produce 0.25%
    // or 2500% for one of them, and this is the assertion that fails.
    const headerWindow = parseQuotaHeaders(unifiedHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '0.25',
      'anthropic-ratelimit-unified-5h-reset': RESET_EPOCH_SECONDS,
    })).windows[0]!
    const bodyWindow = parseUsagePayload({
      five_hour: { utilization: 25, resets_at: RESET_ISO },
    }).windows[0]!

    expect(headerWindow.usedFraction).toBe(0.25)
    expect(bodyWindow.usedFraction).toBe(0.25)
    expect(headerWindow.usedPercent).toBe(25)
    expect(bodyWindow.usedPercent).toBe(25)
    expect(headerWindow.remainingPercent).toBe(75)
    expect(bodyWindow.remainingPercent).toBe(75)
    // Same id, same label, same nominal length, and the same instant arrived at
    // from epoch seconds on one side and an ISO string on the other.
    expect(headerWindow.id).toBe(bodyWindow.id)
    expect(headerWindow.windowMinutes).toBe(bodyWindow.windowMinutes)
    expect(headerWindow.resetsAt).toBe(bodyWindow.resetsAt)
    // Only the provenance differs.
    expect(headerWindow.source).toBe('headers')
    expect(bodyWindow.source).toBe('usage')
  })

  it('does not read a body percent of 100 as a whole fraction', () => {
    const bodyWindow = parseUsagePayload({ five_hour: { utilization: 100, resets_at: RESET_ISO } }).windows[0]!
    expect(bodyWindow.usedFraction).toBe(1)
    expect(bodyWindow.remainingPercent).toBe(0)
  })

  it('does not read a header fraction of 1 as one percent', () => {
    const headerWindow = parseQuotaHeaders(unifiedHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '1',
    })).windows[0]!
    expect(headerWindow.usedPercent).toBe(100)
    expect(headerWindow.remainingPercent).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Quota — caching and the header-versus-full-read policy
// ---------------------------------------------------------------------------

describe('quota caching policy', () => {
  it('reads the usage endpoint and stores the account snapshot', async () => {
    const fetchStub = recordingFetch(() => new Response(usageBody(), { status: 200 }))

    const quota = await fetchAccountQuota(CREDENTIALS, { fetchFn: fetchStub.fn })

    expect(fetchStub.calls[0]?.url).toBe(API_BASE + USAGE_PATH)
    expect(fetchStub.calls[0]?.method).toBe('GET')
    expect(fetchStub.calls[0]?.headers.authorization).toBe('Bearer ' + ACCESS_TOKEN)
    expect('x-api-key' in (fetchStub.calls[0]?.headers ?? {})).toBe(false)
    // The usage surface reports the claude-code product identity.
    expect(fetchStub.calls[0]?.headers['user-agent']).toBe('claude-code/' + claudeCliVersion())
    expect(quota.fetchedAt).not.toBeNull()
    expect(getCachedQuota(CREDENTIALS)).toBe(quota)
    expect(getCachedQuota()).toBe(quota)
  })

  it('serves a warm snapshot inside the TTL and re-reads once it lapses', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-01-01T00:00:00.000Z')
    vi.setSystemTime(start)
    const fetchStub = recordingFetch(() => new Response(usageBody(), { status: 200 }))

    await fetchAccountQuota(CREDENTIALS, { fetchFn: fetchStub.fn })
    expect(fetchStub.mock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date(start.getTime() + QUOTA_CACHE_TTL_MS - 1))
    await fetchAccountQuota(CREDENTIALS, { fetchFn: fetchStub.fn })
    expect(fetchStub.mock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date(start.getTime() + QUOTA_CACHE_TTL_MS + 1))
    await fetchAccountQuota(CREDENTIALS, { fetchFn: fetchStub.fn })
    expect(fetchStub.mock).toHaveBeenCalledTimes(2)
  })

  it('collapses concurrent usage reads into one request', async () => {
    const fetchStub = recordingFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return new Response(usageBody(), { status: 200 })
    })
    await Promise.all([
      fetchAccountQuota(CREDENTIALS, { fetchFn: fetchStub.fn }),
      fetchAccountQuota(CREDENTIALS, { fetchFn: fetchStub.fn }),
    ])
    expect(fetchStub.mock).toHaveBeenCalledTimes(1)
  })

  it('updates the cache from response headers without claiming a full read', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-01-01T00:00:00.000Z')
    vi.setSystemTime(start)
    const fetchStub = recordingFetch(
      () => new Response(usageBody({ seven_day: { utilization: 0, resets_at: null } }), { status: 200 }),
    )

    const fetched = await fetchAccountQuota(CREDENTIALS, { fetchFn: fetchStub.fn })

    vi.setSystemTime(new Date(start.getTime() + 1000))
    const recorded = recordQuotaFromHeaders(unifiedHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '0.25',
      'anthropic-ratelimit-unified-5h-reset': RESET_EPOCH_SECONDS,
      'anthropic-ratelimit-unified-status': 'allowed',
    }), ACCOUNT_KEY)

    expect(recorded).not.toBeNull()
    // fetchedAt is the FULL-READ clock and it has NOT moved: header data is
    // allowed to satisfy the badge, not to stand in for a real reading.
    expect(recorded?.fetchedAt).toBe(fetched.fetchedAt)
    expect(recorded?.observedAt).toBe(Date.now())
    expect(recorded?.status).toBe('allowed')
    // The 5h window the headers carried is now in the percent form.
    const fiveHour = recorded?.windows.find((window) => window.id === 'five_hour')
    expect(fiveHour?.usedPercent).toBe(25)
    expect(fiveHour?.source).toBe('headers')
    // A window the headers did not mention keeps what the full read said.
    expect(recorded?.windows.find((window) => window.id === 'seven_day')?.usedPercent).toBe(0)
    // And the order the payload established is preserved for the card.
    expect(recorded?.windows.map((window) => window.id)).toEqual(['five_hour', 'seven_day'])
  })

  it('still performs a full read when only header data has kept the cache warm', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-01-01T00:00:00.000Z')
    vi.setSystemTime(start)
    const fetchStub = recordingFetch(() => new Response(usageBody(), { status: 200 }))

    await fetchAccountQuota(CREDENTIALS, { fetchFn: fetchStub.fn })
    expect(fetchStub.mock).toHaveBeenCalledTimes(1)

    // Just past the full-refresh ceiling, a response header arrives. The cache
    // is now warm by the TTL clock and stale by the full-read clock — exactly
    // the state that must NOT answer the card from memory. An implementation
    // that gated on one clock alone would return here and issue no request.
    vi.setSystemTime(new Date(start.getTime() + QUOTA_FULL_REFRESH_MS + 1))
    const recorded = recordQuotaFromHeaders(unifiedHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.25' }), ACCOUNT_KEY)
    expect(recorded).not.toBeNull()
    expect(Date.now() - (recorded?.observedAt ?? 0)).toBe(0)

    await fetchAccountQuota(CREDENTIALS, { fetchFn: fetchStub.fn })
    expect(fetchStub.mock).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous snapshot when a refresh fails, but never hides a credential failure', async () => {
    const good = recordingFetch(() => new Response(usageBody(), { status: 200 }))
    const previous = await fetchAccountQuota(CREDENTIALS, { fetchFn: good.fn })

    const outage = recordingFetch(() => new Response('gateway down', { status: 502 }))
    const afterOutage = await fetchAccountQuota(CREDENTIALS, { fetchFn: outage.fn, force: true })
    // A transient outage says nothing about the account's usage.
    expect(afterOutage).toBe(previous)

    const rejected = recordingFetch(() => errorResponse(401, ERROR_TYPE.AUTHENTICATION, 'OAuth token has been revoked'))
    const failure = await fetchAccountQuota(CREDENTIALS, { fetchFn: rejected.fn, force: true }).then(
      () => null,
      (error: unknown) => error,
    )
    // Hiding a revoked credential behind stale numbers is the one thing a card
    // must not do, so this path signals instead of falling back.
    expect(failure).toBeInstanceOf(ClaudeRequestError)
    expect((failure as ClaudeRequestError).failure.kind).toBe('credential')
  })

  it('discards a header reading that belongs to another account', () => {
    const first = recordQuotaFromHeaders(unifiedHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.1' }), 'ACCOUNT-A')
    expect(first).not.toBeNull()

    const other = recordQuotaFromHeaders(unifiedHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.9' }), 'ACCOUNT-B')
    // Mixing two accounts' windows is worse than a stale number.
    expect(other).toBeNull()
    expect(getCachedQuota()?.windows[0]?.usedPercent).toBe(10)
  })

  it('reports the tightest window for the composer badge', () => {
    const { windows } = parseUsagePayload(
      JSON.parse(usageBody({ seven_day: { utilization: 80, resets_at: null } })) as unknown,
    )
    expect(tightestQuotaWindow(windows)?.id).toBe('seven_day')
    // A window that states nothing is not a candidate for "tightest".
    expect(tightestQuotaWindow([{
      id: 'x',
      label: 'x',
      windowMinutes: null,
      usedFraction: null,
      usedPercent: null,
      remainingPercent: null,
      resetsAt: null,
      source: 'usage',
    }])).toBeNull()
  })

  it('files an unnamed header reading under the cached account, and still re-reads later', async () => {
    const fetchStub = recordingFetch(() => new Response(usageBody(), { status: 200 }))
    await fetchAccountQuota(CREDENTIALS, { fetchFn: fetchStub.fn })

    // The realistic call pattern for a single-account line: the adapter holds a
    // Response, not an account id. The reading must land on the account the
    // snapshot already belongs to, not on nobody.
    const recorded = recordQuotaFromHeaders(unifiedHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.5' }))
    expect(recorded).not.toBeNull()
    expect(getCachedQuota(CREDENTIALS)?.windows.find((window) => window.id === 'five_hour')?.usedPercent).toBe(50)

    // And the snapshot is still recognised as this credential's, so the next
    // read is served from cache rather than being orphaned by the update.
    const warm = await fetchAccountQuota(CREDENTIALS, { fetchFn: fetchStub.fn })
    expect(fetchStub.mock).toHaveBeenCalledTimes(1)
    expect(warm.windows.find((window) => window.id === 'five_hour')?.usedPercent).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// 6. Connectivity probe
// ---------------------------------------------------------------------------

describe('connectivity probe', () => {
  it('posts one minimal message and reports the latency', async () => {
    const fetchStub = recordingFetch(() => jsonResponse({ id: 'msg_1', stop_reason: 'max_tokens' }))

    const result = await probeConnection(CREDENTIALS, { fetchFn: fetchStub.fn, model: 'claude-sonnet-4-6' })

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.model).toBe('claude-sonnet-4-6')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    if (!result.ok) throw new Error('expected a successful probe')
    expect(result.stopReason).toBe('max_tokens')

    expect(fetchStub.calls[0]?.url).toBe(API_BASE + MESSAGES_PATH)
    expect(fetchStub.calls[0]?.method).toBe('POST')
    const body = fetchStub.calls[0]?.body as { model: string; max_tokens: number }
    expect(body.model).toBe('claude-sonnet-4-6')
    // The smallest request the Messages API accepts: a probe run from the
    // settings card must not consume anything meaningful.
    expect(body.max_tokens).toBe(1)
    expect('x-api-key' in (fetchStub.calls[0]?.headers ?? {})).toBe(false)
  })

  it('defaults to the cheap model when the caller names none', async () => {
    const fetchStub = recordingFetch(() => jsonResponse({ stop_reason: 'max_tokens' }))
    const result = await probeConnection(CREDENTIALS, { fetchFn: fetchStub.fn })
    expect(result.model).toBe(PROBE_DEFAULT_MODEL)
    expect((fetchStub.calls[0]?.body as { model: string }).model).toBe(PROBE_DEFAULT_MODEL)
  })

  it('returns a structured failure instead of throwing when upstream rejects it', async () => {
    const fetchStub = recordingFetch(() => errorResponse(401, ERROR_TYPE.AUTHENTICATION, 'Invalid bearer token'))

    const result = await probeConnection(CREDENTIALS, { fetchFn: fetchStub.fn })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failed probe')
    expect(result.status).toBe(401)
    expect(result.failure.kind).toBe('credential')
    expect(result.failure.retryable).toBe(false)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('returns a structured failure when no response arrives at all', async () => {
    const fetchStub = recordingFetch(() => { throw new TypeError('fetch failed') })
    const result = await probeConnection(CREDENTIALS, { fetchFn: fetchStub.fn })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failed probe')
    expect(result.status).toBe(0)
    expect(result.failure.kind).toBe('network')
    expect(result.failure.retryable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. Failure classification
// ---------------------------------------------------------------------------

describe('failure classification', () => {
  it('treats 401 and 403 as a FINAL credential failure', () => {
    const unauthorized = classifyFailure(
      401,
      JSON.stringify({ error: { type: ERROR_TYPE.AUTHENTICATION, message: 'revoked' } }),
      {},
    )
    expect(unauthorized.kind).toBe('credential')
    expect(unauthorized.type).toBe(ERROR_TYPE.AUTHENTICATION)
    expect(unauthorized.retryable).toBe(false)
    expect(unauthorized.accountScoped).toBe(false)

    const forbidden = classifyFailure(
      403,
      JSON.stringify({ error: { type: ERROR_TYPE.PERMISSION, message: 'not entitled' } }),
      {},
    )
    expect(forbidden.kind).toBe('credential')
    expect(forbidden.retryable).toBe(false)
  })

  it('treats an invalid_request_error as a non-retryable request problem', () => {
    const failure = classifyFailure(
      400,
      JSON.stringify({ error: { type: ERROR_TYPE.INVALID_REQUEST, message: 'bad parameter: x' } }),
      {},
    )
    expect(failure.kind).toBe('request')
    expect(failure.retryable).toBe(false)
    expect(failure.clientVersionTooOld).toBe(false)
  })

  it('flags the reported-client-version floor inside an ordinary invalid_request_error', () => {
    // The failure arrives as an invalid_request_error whose details carry the
    // code, so the code has to be looked for separately from the type.
    const failure = classifyFailure(400, JSON.stringify({
      error: {
        type: ERROR_TYPE.INVALID_REQUEST,
        message: 'the requested model requires a newer client',
        details: { code: ERROR_CODE_CLIENT_VERSION_TOO_OLD },
      },
    }), {})
    expect(failure.kind).toBe('request')
    expect(failure.clientVersionTooOld).toBe(true)
    expect(failure.retryable).toBe(false)
  })

  it('separates a spent window of THIS account from a global rate limit', () => {
    const body = JSON.stringify({ error: { type: ERROR_TYPE.RATE_LIMIT, message: 'rate limited' } })

    // A 429 with no unified header is not attributable to any window of this
    // account. Rotating the pool on it would burn every account at once.
    const global = classifyFailure(429, body, {})
    expect(global.kind).toBe('rate_limit_global')
    expect(global.accountScoped).toBe(false)
    expect(global.retryable).toBe(true)

    // The same 429 with a window at 100% is this account's own.
    const spent = classifyFailure(429, body, unifiedHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': RESET_EPOCH_SECONDS,
    }))
    expect(spent.kind).toBe('rate_limit_account')
    expect(spent.accountScoped).toBe(true)
    expect(spent.resetsAt).toBe(RESET_ISO)
  })

  it('reads an explicit rejected verdict as this account window', () => {
    const failure = classifyFailure(
      429,
      JSON.stringify({ error: { type: ERROR_TYPE.RATE_LIMIT, message: 'slow down' } }),
      unifiedHeaders({ 'anthropic-ratelimit-unified-status': 'rejected' }),
    )
    expect(failure.kind).toBe('rate_limit_account')
    expect(failure.accountScoped).toBe(true)
  })

  it('keeps a global rate limit global even when the account has headroom', () => {
    const failure = classifyFailure(
      429,
      JSON.stringify({ error: { type: ERROR_TYPE.RATE_LIMIT, message: 'slow down' } }),
      unifiedHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.1',
      }),
    )
    expect(failure.kind).toBe('rate_limit_global')
    expect(failure.accountScoped).toBe(false)
  })

  it('reads the reset instant out of a rate-limit message when it is stated in prose', () => {
    const failure = classifyFailure(429, JSON.stringify({
      error: { type: ERROR_TYPE.RATE_LIMIT, message: 'usage limit reached; it will reset at ' + RESET_ISO },
    }), {})
    expect(failure.resetsAt).toBe(RESET_ISO)
  })

  it('treats an overload as retryable but never account-specific', () => {
    const typed = classifyFailure(
      529,
      JSON.stringify({ error: { type: ERROR_TYPE.OVERLOADED, message: 'overloaded' } }),
      {},
    )
    expect(typed.kind).toBe('overloaded')
    expect(typed.retryable).toBe(true)
    expect(typed.accountScoped).toBe(false)

    // An unreadable body must not lose the overload signal: 529 is the
    // documented status for it, and it is above the generic 5xx floor.
    const untyped = classifyFailure(529, '', {})
    expect(untyped.kind).toBe('overloaded')
    expect(untyped.retryable).toBe(true)
  })

  it('treats a server failure above 500 as retryable', () => {
    const failure = classifyFailure(503, '', {})
    expect(failure.kind).toBe('server')
    expect(failure.retryable).toBe(true)
    expect(failure.accountScoped).toBe(false)
    expect(failure.message).toContain('503')
  })

  it('falls back to the status line when the body is not the documented envelope', () => {
    // A body this parser cannot read costs a more precise type, never a wrong
    // classification.
    const notJson = classifyFailure(401, '<html>gateway</html>', {})
    expect(notJson.kind).toBe('credential')
    expect(notJson.type).toBeNull()

    const unknownType = classifyFailure(400, JSON.stringify({ error: { type: 'something_new', message: 'nope' } }), {})
    expect(unknownType.kind).toBe('request')
    expect(unknownType.type).toBeNull()
    expect(unknownType.message).toBe('nope')

    // A type this line knows outranks a status that would have said otherwise.
    const apiError = classifyFailure(503, JSON.stringify({ error: { type: ERROR_TYPE.API, message: 'internal' } }), {})
    expect(apiError.kind).toBe('server')
    expect(apiError.type).toBe(ERROR_TYPE.API)
  })

  it('reports retry-after in milliseconds, from either spelling', () => {
    const seconds = classifyFailure(
      429,
      JSON.stringify({ error: { type: ERROR_TYPE.RATE_LIMIT, message: 'x' } }),
      { 'retry-after': '30' },
    )
    expect(seconds.retryAfterMs).toBe(30_000)

    const date = classifyFailure(
      429,
      JSON.stringify({ error: { type: ERROR_TYPE.RATE_LIMIT, message: 'x' } }),
      { 'retry-after': new Date(Date.now() + 5000).toUTCString() },
    )
    expect(date.retryAfterMs).toBeGreaterThan(0)
    expect(date.retryAfterMs).toBeLessThanOrEqual(5000)
  })

  it('does not mistake a transport failure for a credential failure', () => {
    // Status 0 with an empty body is the shape an aborted request produces. It
    // is not a 4xx, so nothing about it says the credential is bad.
    const failure: ClaudeFailure = classifyFailure(0, '', {})
    expect(failure.kind).toBe('server')
    expect(failure.retryable).toBe(true)
    expect(failure.accountScoped).toBe(false)
  })
})
