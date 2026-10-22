import { describe, expect, it, vi } from 'vitest'
import type { AccountRotationStrategy, PoolAccountSummaryDto } from '../src/shared/account-pool-contracts.ts'
import {
  LINE_ACCOUNT_STRATEGY_CAPABILITY_ID,
  LINE_ACCOUNT_SWITCH_CAPABILITY_ID,
  LINE_CARD_DATA_SOURCE_ID,
  LINE_CARD_SCHEMA,
  LINE_REFRESH_CAPABILITY_ID,
  type LineCardData,
} from '../src/host/widget-board/line-contracts.ts'
import {
  LINE_QUOTA_NORMALIZERS,
  minimaxAccountQuotaReading,
  normalizeAntigravityQuota,
  normalizeClaudeQuota,
  normalizeClinePassQuota,
  normalizeCodexQuota,
  normalizeCommandCodeQuota,
  normalizeGlmCodingPlanQuota,
  normalizeKimiCodeQuota,
  normalizeMinimaxCodeQuota,
  normalizeOpenDesignQuota,
  normalizeQoderQuota,
  normalizeStepCodeQuota,
  qoderAccountQuotaReading,
} from '../src/host/widget-board/line-quota.ts'
import {
  LINE_ACCOUNT_QUOTA_CACHE_MS,
  LINE_ACCOUNT_QUOTA_CONCURRENCY,
  LINE_ACCOUNT_QUOTA_FAILURE_CACHE_MS,
  LINE_ACCOUNT_QUOTA_MAX_ACCOUNTS,
  LINE_ACCOUNT_QUOTA_READERS,
  LINE_ACCOUNT_QUOTA_TIMEOUT_MS,
  LINE_ACCOUNT_QUOTA_WHOLE_BUDGET_MS,
  LINE_DEFINITIONS,
  LINE_HTTP_TIMEOUT_MS,
  createAccountQuotaReaders,
  createLineRegistry,
  lineOfProps,
  type LineAccountQuotaClient,
  type LineAccountSource,
  type LineRegistry,
} from '../src/host/widget-board/line-registry.ts'
import {
  registerWidgetBoard,
  type WidgetBoardCapabilityRegistration,
  type WidgetBoardContext,
  type WidgetBoardDataSourceRegistration,
  type WidgetBoardHandle,
  type WidgetBoardScope,
  type WidgetBoardService,
} from '../src/host/widget-board/provider.ts'
import { WIDGET_BOARD_PROVIDER } from '../src/host/widget-board/line-contracts.ts'
import { LIVE_STATUS_PAYLOADS } from './widget-board-lines.fixtures.ts'

/**
 * The line registry, its normalizers and the registrations they back.
 *
 * The fixtures are REAL `GET /status` answers captured from a running host, so
 * every assertion below is grounded in what a line actually sends: the unit
 * disagreements, the per-account readings, the nulls, and the sentinel dates.
 * Nothing here reaches a network: the HTTP half is a fake `fetch`, the account
 * half a fake pool.
 */

/** The `value` of one line's captured status payload. */
function statusOf(line: string): unknown {
  const entry = LIVE_STATUS_PAYLOADS[line] as { value?: unknown } | undefined
  if (entry === undefined) throw new Error('no fixture for ' + line)
  return entry.value
}

/** The whole captured envelope, as the route answers it. */
function envelopeOf(line: string): unknown {
  return LIVE_STATUS_PAYLOADS[line]
}

describe('line quota normalizers', () => {
  it('converts the ChatGPT line quote from Unix SECONDS', () => {
    const facts = normalizeCodexQuota(statusOf('codex'))
    expect(facts.quota).toEqual({
      windows: [{ label: '每月', usedPercent: 0, windowMinutes: 43200, resetsAt: 1795250462000 }],
      credits: { unlimited: false, balance: null },
      resetCredits: { available: 1, expiresAt: 1792701235000 },
      fetchedAt: 1792658463000,
      refreshing: true,
      error: null,
    })
    expect(facts.planLabel).toBe('free')
    expect(facts.accountLabel).toBe('c***@gmail.com')
    expect(facts.signedIn).toBe(true)
    expect(facts.error).toBe(null)
  })

  it('keeps the Kimi Code wallet in its own currency', () => {
    const facts = normalizeKimiCodeQuota(statusOf('kimi-code'))
    expect(facts.quota?.windows).toEqual([
      { label: '5-hour', usedPercent: 0, windowMinutes: 300, resetsAt: 1792672850000 },
      { label: 'Weekly (7-day)', usedPercent: 0, windowMinutes: 10080, resetsAt: 1793198450000 },
    ])
    // Minor unit divided once, and the currency kept: a bare "75.00" would be
    // read as provider credits by every other card.
    expect(facts.quota?.credits).toEqual({ unlimited: false, balance: '75.00 CNY' })
    expect(facts.quota?.fetchedAt).toBe(1792658462522)
    expect(facts.planLabel).toBe('Allegro')
    // The line states a nickname and no email; that is what it gets to name.
    expect(facts.accountLabel).toBe('快跑')
  })

  it('names the MiniMax Code windows from their machine keys', () => {
    const facts = normalizeMinimaxCodeQuota(statusOf('minimax-code'))
    expect(facts.quota?.windows).toEqual([
      { label: '5 小时', usedPercent: 14, windowMinutes: 300, resetsAt: 1792669916718 },
      { label: '每周', usedPercent: 54, windowMinutes: 10080, resetsAt: 1793011729936 },
    ])
    expect(facts.quota?.fetchedAt).toBe(1792658462726)
    expect(facts.quota?.refreshing).toBe(true)
    expect(facts.planLabel).toBe('Token Plan')
  })

  it('inverts Antigravity remaining fractions and parses its ISO resets', () => {
    const facts = normalizeAntigravityQuota(statusOf('antigravity'))
    const windows = facts.quota?.windows ?? []
    // Shortest window first, and both groups named once there is more than one.
    expect(windows.map((window) => window.label)).toEqual([
      'Gemini Models · 5 小时',
      'Claude and GPT models · 5 小时',
      'Gemini Models · 每周',
      'Claude and GPT models · 每周',
    ])
    // remainingFraction 0.9784805 remaining => 2.15195% used.
    expect(windows[0]?.usedPercent).toBeCloseTo(2.15195, 5)
    expect(windows[0]?.windowMinutes).toBe(300)
    expect(windows[2]?.usedPercent).toBeCloseTo(24.41002, 5)
    expect(windows[2]?.resetsAt).toBe(Date.parse('2026-10-24T06:23:12Z'))
    expect(facts.planLabel).toBe('Google AI Ultra')
    expect(facts.accountLabel).toBe('cchen2422@gmail.com')
  })

  it('reports Command Code credit meters that measured nothing as no bars', () => {
    const facts = normalizeCommandCodeQuota(statusOf('command-code'))
    // Every meter states a null usedFraction: a spend meter, not a bounded
    // allowance, so nothing becomes a bar.
    expect(facts.quota?.windows).toEqual([])
    expect(facts.quota?.credits).toEqual({ unlimited: false, balance: '0' })
    expect(facts.accountLabel).toBe('1729375685@qq.com')
  })

  it('reports a signed-out line as null quota with no error', () => {
    const facts = normalizeClaudeQuota(statusOf('claude'))
    // A first read before the line's own POST /quota: nothing measured yet.
    expect(facts.quota).toBe(null)
    expect(facts.error).toBe(null)
    expect(facts.signedIn).toBe(false)
  })

  it('carries the line own quota failure where the card can show it', () => {
    const glm = normalizeGlmCodingPlanQuota(statusOf('glm-coding-plan'))
    expect(glm.quota).toBe(null)
    expect(glm.error).toContain('GLM')
    const step = normalizeStepCodeQuota(statusOf('step-code'))
    expect(step.quota).toBe(null)
    expect(step.error).toContain('401')
  })

  it('drops the Qoder never-expires sentinel and keeps the credit balance', () => {
    const facts = normalizeQoderQuota(statusOf('qoder'))
    // total 0 is a stated zero, not a percentage: no bar, but the balance is real.
    expect(facts.quota?.windows).toEqual([])
    expect(facts.quota?.credits).toEqual({ unlimited: false, balance: '0 credits' })
    expect(facts.quota?.fetchedAt).toBe(1792658467268)
    // A real ratio becomes a bar, and 9999-12-31 never reaches the card.
    const withRatio = normalizeQoderQuota({
      authenticated: true,
      quota: {
        buckets: [{ kind: 'personal', total: 100, used: 40, remaining: 60, unit: 'credits' }],
        expiresAt: 253402214400000,
        fetchedAt: 1,
      },
    })
    expect(withRatio.quota?.windows).toEqual([
      { label: '个人额度', usedPercent: 40, windowMinutes: null, resetsAt: null },
    ])
    expect(withRatio.quota?.credits).toEqual({ unlimited: false, balance: '60 credits' })
  })

  it('leaves the wallet lines without windows when nothing was read', () => {
    const cline = normalizeClinePassQuota(statusOf('cline-pass'))
    expect(cline.quota).toBe(null)
    expect(cline.error).toBe(null)
    expect(cline.signedIn).toBe(false)
    const openDesign = normalizeOpenDesignQuota(statusOf('opendesign'))
    expect(openDesign.quota).toBe(null)
    expect(openDesign.signedIn).toBe(true)
  })

  it('reads a Cline Pass per-account reading through its ISO resets', () => {
    const facts = normalizeClinePassQuota({
      authenticated: true,
      quotaRefreshing: false,
      pool: { activeAccountId: 'acc_b' },
      usage: {
        fetchedAt: 10,
        accounts: [
          { accountId: 'acc_a', alias: 'a', ok: true, windows: [], error: '', fetchedAt: 1 },
          {
            accountId: 'acc_b',
            alias: 'b',
            ok: true,
            windows: [
              { type: 'five_hour', label: '5 hour', percentUsed: 12.5, resetsAt: '2026-10-22T12:25:00Z' },
              { type: 'weekly', label: 'Weekly', percentUsed: 60, resetsAt: '2026-10-24T06:23:12Z' },
            ],
            error: '',
            fetchedAt: 2,
          },
        ],
      },
    })
    expect(facts.quota?.windows).toEqual([
      { label: '5 hour', usedPercent: 12.5, windowMinutes: 300, resetsAt: Date.parse('2026-10-22T12:25:00Z') },
      { label: 'Weekly', usedPercent: 60, windowMinutes: 10080, resetsAt: Date.parse('2026-10-24T06:23:12Z') },
    ])
    // The ACTIVE account's reading, not the first row's.
    expect(facts.quota?.fetchedAt).toBe(2)
  })

  it('turns OpenDesign wallet balances into the card credit figure', () => {
    const facts = normalizeOpenDesignQuota({
      authenticated: true,
      pool: { activeAccountId: 'acc_1' },
      usage: {
        fetchedAt: 5,
        accounts: [
          {
            accountId: 'acc_1',
            alias: 'For SK',
            ok: true,
            balanceUsd: '12.34',
            updatedAt: null,
            error: '',
            fetchedAt: 5,
            billing: { plan: 'free' },
          },
        ],
      },
    })
    expect(facts.quota?.windows).toEqual([])
    expect(facts.quota?.credits).toEqual({ unlimited: false, balance: '12.34 USD' })
    expect(facts.planLabel).toBe('free')
  })

  it('derives a share some lines only state as a remainder', () => {
    const minimax = normalizeMinimaxCodeQuota({
      authenticated: true,
      quota: { label: 'Token Plan', windows: [{ key: 'interval', remainingPercent: 80, resetsAtMs: 7 }], fetchedAtMs: 8 },
    })
    expect(minimax.quota?.windows).toEqual([
      { label: '5 小时', usedPercent: 20, windowMinutes: 300, resetsAt: 7 },
    ])
    const steps = normalizeStepCodeQuota({
      authenticated: true,
      quota: {
        kind: 'credit',
        fetchedAt: 3,
        creditBuckets: [
          { total: 100, remaining: 40, expiresAt: null, resetsAt: null },
          { total: 10, remaining: 2.5, expiresAt: null, resetsAt: null },
        ],
        windows: [],
      },
    })
    // Absolute buckets are a balance, never a bar nobody measured.
    expect(steps.quota?.windows).toEqual([])
    expect(steps.quota?.credits).toEqual({ unlimited: false, balance: '42.5' })
  })

  it('survives an unreadable payload for every line, with nothing measured', () => {
    for (const [line, normalize] of Object.entries(LINE_QUOTA_NORMALIZERS)) {
      for (const broken of [null, undefined, 42, 'nope', [], {}, { quota: null }, { usage: null }]) {
        const facts = normalize(broken)
        expect(facts.quota, line + ' on ' + JSON.stringify(broken)).toBe(null)
        expect(facts.planLabel).toBe(null)
        expect(facts.accountLabel).toBe(null)
        expect(facts.signedIn).toBe(null)
        expect(facts.error).toBe(null)
      }
    }
  })

  it('drops a window nobody measured instead of drawing it as empty', () => {
    const facts = normalizeAntigravityQuota({
      authenticated: true,
      quota: {
        groups: [{
          displayName: 'Gemini Models',
          buckets: [
            { window: '5h', remainingFraction: null, resetTime: '2026-10-22T12:25:00Z' },
            { window: 'weekly', remainingFraction: 0, resetTime: '2026-10-24T06:23:12Z' },
          ],
        }],
      },
    })
    // Only one group, so no group prefix; the immeasurable bucket is gone and
    // the real 0%-remaining one is a full bar.
    expect(facts.quota?.windows).toEqual([
      { label: '每周', usedPercent: 100, windowMinutes: 10080, resetsAt: Date.parse('2026-10-24T06:23:12Z') },
    ])
  })

  it('derives a Qoder account share only from a bounded bucket', () => {
    // The same rule the line-level normalizer applies, applied to ONE account's
    // snapshot: total and used, or nothing. A never-expires sentinel still goes.
    expect(qoderAccountQuotaReading({
      buckets: [{ kind: 'personal', total: 100, used: 40, remaining: 60 }],
      expiresAt: 253402214400000,
      // No window list: this line has no percentage windows to list.
    })).toEqual({ usedPercent: 40, resetsAt: null, windows: [] })
    // remaining alone, with no allowance to divide by, is a balance and not a bar.
    expect(qoderAccountQuotaReading({
      buckets: [{ kind: 'personal', total: 0, remaining: 500, unit: 'credits' }],
    })).toBe(null)
    // A bucket that states both amounts has its share derived, and the reset kept.
    expect(qoderAccountQuotaReading({
      buckets: [{ kind: 'add-on', total: 200, remaining: 50 }],
      expiresAt: 1_790_000_000_000,
    })).toEqual({ usedPercent: 75, resetsAt: 1_790_000_000_000, windows: [] })
    expect(qoderAccountQuotaReading({ buckets: [] })).toBe(null)
    expect(qoderAccountQuotaReading(null)).toBe(null)
    expect(qoderAccountQuotaReading('nope')).toBe(null)
  })

  it('draws a MiniMax account 5-hour window, not its weekly one', () => {
    // Both windows are always stated; the row is the tight one.
    expect(minimaxAccountQuotaReading({
      windows: [
        { key: 'interval', usedPercent: 12, remainingPercent: 88, resetsAtMs: 5 },
        { key: 'weekly', usedPercent: 90, remainingPercent: 10, resetsAtMs: 9 },
      ],
      // The bar is the 5-hour window, and the list behind it is EVERY window the
      // line stated, named the same way the line-level normalizer names them.
    })).toEqual({
      usedPercent: 12,
      resetsAt: 5,
      windows: [
        { label: '5 小时', usedPercent: 12, windowMinutes: 300, resetsAt: 5 },
        { label: '每周', usedPercent: 90, windowMinutes: 10_080, resetsAt: 9 },
      ],
    })
    // A remaining-only window is inverted rather than left unread.
    expect(minimaxAccountQuotaReading({
      windows: [{ key: 'interval', remainingPercent: 88, resetsAtMs: 7 }],
    })).toEqual({
      usedPercent: 12,
      resetsAt: 7,
      windows: [{ label: '5 小时', usedPercent: 12, windowMinutes: 300, resetsAt: 7 }],
    })
    // An unlimited window measured nothing: no bar, and no invented zero.
    expect(minimaxAccountQuotaReading({
      windows: [{ key: 'interval', remainingPercent: null, unlimited: true }],
    })).toBe(null)
    // A snapshot with no window detail states one headline, which is the 5-hour one.
    expect(minimaxAccountQuotaReading({ usedPercent: 14, resetsAtMs: 3, windows: [] }))
      .toEqual({
        usedPercent: 14,
        resetsAt: 3,
        // The one window that headline describes, so the bar and the list agree.
        windows: [{ label: '5 小时', usedPercent: 14, windowMinutes: 300, resetsAt: 3 }],
      })
    // Nothing measurable anywhere is still nothing: no bar, and no padded list.
    expect(minimaxAccountQuotaReading({ windows: [] })).toBe(null)
    expect(minimaxAccountQuotaReading(null)).toBe(null)
  })
})

/**
 * One fake pool, recording what the registry asked it to do.
 *
 * `credential` is the per-account resolver the pool kernel exposes as
 * `getFreshCredential`; a test that does not pass one gets the same method,
 * answering for every account, because the registry only calls it for a line
 * that opted into a per-account read.
 */
function fakePool(options: {
  accounts: PoolAccountSummaryDto[]
  rotationStrategy?: AccountRotationStrategy
  activeAccountId?: string
  document?: unknown
  credential?: (accountId: string) => Promise<unknown>
}) {
  const calls = {
    listAccounts: 0,
    setPrimary: [] as string[],
    setStrategy: [] as AccountRotationStrategy[],
    credentialFor: [] as string[],
  }
  const source: LineAccountSource = {
    listAccounts: async () => {
      calls.listAccounts += 1
      return options.accounts
    },
    setPrimary: async (accountId) => {
      calls.setPrimary.push(accountId)
    },
    setStrategy: async (strategy) => {
      calls.setStrategy.push(strategy)
    },
    getFreshCredential: async (accountId) => {
      calls.credentialFor.push(accountId)
      if (options.credential !== undefined) return await options.credential(accountId)
      return { accessToken: 'token-' + accountId, accountId }
    },
    read: async () => options.document ?? {
      rotationStrategy: options.rotationStrategy ?? 'sequential',
      activeAccountId: options.activeAccountId ?? options.accounts.find((account) => account.isPrimary)?.id,
      accounts: [],
    },
  }
  return { source, calls }
}

/** One recorded HTTP call. */
interface HttpCall {
  url: string
  init: RequestInit | undefined
}

/** A fake fetch that answers from a table and records every call. */
function fakeFetch(answer: (call: HttpCall) => Response | Promise<Response>) {
  const calls: HttpCall[] = []
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init }
    calls.push(call)
    return await answer(call)
  }
  return { calls, fetchFn: fetchFn as unknown as typeof fetch }
}

/** A JSON response, the way the routes answer. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** A registry over one line, with the pool and fetch the test owns. */
function registryFor(options: {
  line: string
  pool?: LineAccountSource
  fetchFn: typeof fetch
  timeoutMs?: number
  accountQuotaClients?: Readonly<Record<string, LineAccountQuotaClient | undefined>>
  accountQuotaCacheMs?: number
  accountQuotaTimeoutMs?: number
  accountQuotaWholeBudgetMs?: number
  accountQuotaMaxAccounts?: number
}): LineRegistry {
  return createLineRegistry({
    origin: () => 'http://127.0.0.1:3080',
    pools: { [options.line]: options.pool },
    fetchFn: options.fetchFn,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.accountQuotaClients === undefined ? {} : { accountQuotaClients: options.accountQuotaClients }),
    ...(options.accountQuotaCacheMs === undefined ? {} : { accountQuotaCacheMs: options.accountQuotaCacheMs }),
    ...(options.accountQuotaTimeoutMs === undefined ? {} : { accountQuotaTimeoutMs: options.accountQuotaTimeoutMs }),
    ...(options.accountQuotaWholeBudgetMs === undefined
      ? {}
      : { accountQuotaWholeBudgetMs: options.accountQuotaWholeBudgetMs }),
    ...(options.accountQuotaMaxAccounts === undefined
      ? {}
      : { accountQuotaMaxAccounts: options.accountQuotaMaxAccounts }),
    definitions: LINE_DEFINITIONS.filter((definition) => definition.id === options.line),
  })
}

describe('line registry', () => {
  const codexAccounts = (statusOf('codex') as { accounts: PoolAccountSummaryDto[] }).accounts

  it('merges the account half and the quota half into one card', async () => {
    const pool = fakePool({ accounts: codexAccounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('codex')))
    const registry = registryFor({ line: 'codex', pool: pool.source, fetchFn: http.fetchFn })
    const card = await registry.read('codex')
    expect(card).toMatchObject({ line: 'codex', label: 'ChatGPT', installed: true, signedIn: true })
    expect(card.planLabel).toBe('free')
    expect(card.accountLabel).toBe('c***@gmail.com')
    expect(card.activeAccountId).toBe('acc_6dfc46661c96')
    expect(card.strategy).toBe('sequential')
    expect(card.error).toBe(null)
    expect(card.quota?.windows).toHaveLength(1)
    // The account row draws the ACCOUNT's own newest snapshot, in the pool
    // DTO's milliseconds — not the line's seconds.
    expect(card.accounts).toEqual([{
      id: 'acc_6dfc46661c96',
      label: 'cchen2422@gmail.com',
      email: 'cchen2422@gmail.com',
      primary: true,
      plan: 'free',
      cooldownUntil: null,
      authStatus: null,
      usedPercent: 0,
      resetsAt: 1795250462000,
    }])
    // One request, addressed at the line's own route, and nothing else.
    expect(http.calls.map((call) => call.url)).toEqual(['http://127.0.0.1:3080/api/dsh-chatgpt-subscription/status'])
    expect(http.calls[0]?.init?.method).toBe('GET')
    // The card's own key set is the schema's required set: a field added to one
    // of them alone fails here instead of reaching a card the board refuses.
    expect(Object.keys(card).sort()).toEqual([...(LINE_CARD_SCHEMA.required as string[])].sort())
  })

  it('refuses an unknown line with a reason that names the known ones', async () => {
    const http = fakeFetch(() => jsonResponse(envelopeOf('codex')))
    const registry = registryFor({ line: 'codex', fetchFn: http.fetchFn })
    await expect(registry.read('nope')).rejects.toThrow(/未知线路/)
    await expect(registry.refresh('nope')).rejects.toThrow(/未知线路/)
    await expect(registry.switchAccount('nope', 'acc_1')).rejects.toThrow(/未知线路/)
    await expect(registry.changeStrategy('nope', 'sticky')).rejects.toThrow(/未知线路/)
    expect(http.calls).toEqual([])
  })

  it('reports the line unreachable without losing the accounts', async () => {
    const pool = fakePool({ accounts: codexAccounts })
    const http = fakeFetch(() => jsonResponse({ ok: false, error: 'boom' }, 500))
    const card = await registryFor({ line: 'codex', pool: pool.source, fetchFn: http.fetchFn }).read('codex')
    expect(card.quota).toBe(null)
    expect(card.error).toContain('HTTP 500')
    expect(card.accounts).toHaveLength(1)
  })

  it('bounds the read in time instead of hanging the board', async () => {
    const slow = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      await new Promise<never>((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
      return jsonResponse(null)
    }
    const started = Date.now()
    const card = await registryFor({ line: 'codex', fetchFn: slow as unknown as typeof fetch, timeoutMs: 40 })
      .read('codex')
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(card.quota).toBe(null)
    expect(card.error).toContain('40 毫秒')
    // The production default is the contract the task states.
    expect(LINE_HTTP_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
  })

  it('reports a line with no pool as not installed', async () => {
    const http = fakeFetch(() => jsonResponse(envelopeOf('codex')))
    const card = await registryFor({ line: 'codex', fetchFn: http.fetchFn }).read('codex')
    expect(card.installed).toBe(false)
    expect(card.accounts).toEqual([])
    expect(card.activeAccountId).toBe(null)
    // The payload still says a credential exists, so the card does too.
    expect(card.signedIn).toBe(true)
  })

  it('reads the pool document for the active account and the strategy', async () => {
    const pool = fakePool({
      accounts: codexAccounts,
      document: { rotationStrategy: 'round-robin', activeAccountId: 'acc_other', accounts: [] },
    })
    const http = fakeFetch(() => jsonResponse(envelopeOf('codex')))
    const card = await registryFor({ line: 'codex', pool: pool.source, fetchFn: http.fetchFn }).read('codex')
    expect(card.strategy).toBe('round-robin')
    expect(card.activeAccountId).toBe('acc_other')
  })

  it('posts the line own refresh route, then reads its status again', async () => {
    const http = fakeFetch((call) => (call.init?.method === 'POST'
      ? jsonResponse({ ok: true, value: {} })
      : jsonResponse(envelopeOf('codex'))))
    const card = await registryFor({ line: 'codex', fetchFn: http.fetchFn }).refresh('codex')
    expect(http.calls.map((call) => [call.init?.method ?? 'GET', call.url])).toEqual([
      ['POST', 'http://127.0.0.1:3080/api/dsh-chatgpt-subscription/quota/refresh'],
      ['GET', 'http://127.0.0.1:3080/api/dsh-chatgpt-subscription/status'],
    ])
    const headers = http.calls[0]?.init?.headers as Record<string, string>
    // The routes compare this against the Host they were addressed to.
    expect(headers.origin).toBe('http://127.0.0.1:3080')
    expect(headers['content-type']).toBe('application/json')
    expect(card.quota?.windows).toHaveLength(1)
    expect(card.error).toBe(null)
  })

  it('keeps a readable snapshot when the refresh itself failed', async () => {
    const http = fakeFetch((call) => (call.init?.method === 'POST'
      ? jsonResponse({ ok: false, error: 'Cross-origin request rejected.' }, 403)
      : jsonResponse(envelopeOf('codex'))))
    const card = await registryFor({ line: 'codex', fetchFn: http.fetchFn }).refresh('codex')
    expect(card.quota?.windows).toHaveLength(1)
    // What the card shows is still true, it is just not newer.
    expect(card.error).toBe(null)
  })

  it('says a refresh that outlived the budget is still running', async () => {
    const http = fakeFetch(async (call) => {
      if (call.init?.method !== 'POST') return jsonResponse(envelopeOf('codex'))
      await new Promise<never>((_resolve, reject) => {
        const signal = call.init?.signal
        signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
      return jsonResponse({ ok: true, value: {} })
    })
    const card = await registryFor({ line: 'codex', fetchFn: http.fetchFn, timeoutMs: 40 }).refresh('codex')
    // The refresh is the line's own work and did not finish inside our budget;
    // the snapshot the card carries is the PREVIOUS one, and saying so is what
    // keeps the number from being read as the refreshed one.
    expect(card.quota?.refreshing).toBe(true)
    expect(card.error).toBe(null)
    expect(card.quota?.windows).toHaveLength(1)
  })

  it('reports the refresh failure when there is nothing to show', async () => {
    const http = fakeFetch((call) => (call.init?.method === 'POST'
      ? jsonResponse({ ok: false, error: 'nope' }, 403)
      : jsonResponse(envelopeOf('claude'))))
    const card = await registryFor({ line: 'claude', fetchFn: http.fetchFn }).refresh('claude')
    expect(card.quota).toBe(null)
    expect(card.error).toContain('HTTP 403')
  })

  it('pins a pooled account and answers the re-read card', async () => {
    const pool = fakePool({ accounts: codexAccounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('codex')))
    const registry = registryFor({ line: 'codex', pool: pool.source, fetchFn: http.fetchFn })
    const card = await registry.switchAccount('codex', 'acc_6dfc46661c96')
    expect(pool.calls.setPrimary).toEqual(['acc_6dfc46661c96'])
    expect(card.line).toBe('codex')
    // Refused rather than silently writing nothing, which would report a switch
    // that never happened.
    await expect(registry.switchAccount('codex', 'acc_nope')).rejects.toThrow(/未知账号/)
    expect(pool.calls.setPrimary).toEqual(['acc_6dfc46661c96'])
  })

  it('changes the rotation strategy and refuses an unknown one', async () => {
    const pool = fakePool({ accounts: codexAccounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('codex')))
    const registry = registryFor({ line: 'codex', pool: pool.source, fetchFn: http.fetchFn })
    await registry.changeStrategy('codex', 'sticky')
    expect(pool.calls.setStrategy).toEqual(['sticky'])
    await expect(registry.changeStrategy('codex', 'random')).rejects.toThrow(/轮换策略/)
    expect(pool.calls.setStrategy).toEqual(['sticky'])
  })

  it('refuses an account action on a line with no pool', async () => {
    const http = fakeFetch(() => jsonResponse(envelopeOf('codex')))
    const registry = registryFor({ line: 'codex', fetchFn: http.fetchFn })
    await expect(registry.switchAccount('codex', 'acc_1')).rejects.toThrow(/号池未安装/)
    await expect(registry.changeStrategy('codex', 'sticky')).rejects.toThrow(/号池未安装/)
  })

  it('names every line a card may ask for, and where to read it', () => {
    const ids = LINE_DEFINITIONS.map((definition) => definition.id)
    expect(ids).toEqual([
      'codex', 'claude', 'glm-coding-plan', 'step-code', 'qoder',
      'cline-pass', 'opendesign', 'kimi-code', 'minimax-code', 'antigravity', 'command-code',
    ])
    for (const definition of LINE_DEFINITIONS) {
      expect(definition.statusPath.startsWith('/')).toBe(true)
      expect(definition.label.length).toBeGreaterThan(0)
      expect(statusOf(definition.id), definition.id).toBeDefined()
    }
  })
})

/**
 * The OPTIONAL per-account quota hook.
 *
 * Shape C's `accounts[].usedPercent` used to be answerable for exactly one
 * account — the one the pool happened to read — so a two-account line drew one
 * bar and one blank. These tests are about the extension that fixes that, and
 * about the three promises it makes: an account's own numbers, a failure that
 * stays on its own row, and a line that never opted in behaving as before.
 */
describe('per-account quota hook', () => {
  /** Two accounts; only the first has a pool snapshot, like a real second row. */
  const twoAccounts: PoolAccountSummaryDto[] = [
    {
      id: 'acc_a',
      alias: 'first',
      isPrimary: true,
      email: 'first@example.com',
      quota: { windows: [{ label: '个人额度', usedPercent: 10, resetsAt: 111 }], fetchedAt: 1 },
    },
    { id: 'acc_b', alias: 'second', isPrimary: false, email: 'second@example.com' },
  ]

  /** A Qoder-shaped snapshot whose share is the number the test picks. */
  function qoderSnapshot(used: number, expiresAt: number): unknown {
    return { buckets: [{ kind: 'personal', total: 100, used, remaining: 100 - used }], expiresAt }
  }

  it('gives every account its own reading, not the one account the pool read', async () => {
    const pool = fakePool({ accounts: twoAccounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('qoder')))
    const asked: string[] = []
    const registry = registryFor({
      line: 'qoder',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaClients: {
        qoder: async (credentials, { accountId }) => {
          asked.push(accountId + '/' + (credentials as { accessToken: string }).accessToken)
          return accountId === 'acc_a' ? qoderSnapshot(25, 1_000) : qoderSnapshot(60, 2_000)
        },
      },
    })
    const card = await registry.read('qoder')
    expect(card.accounts.map((account) => [account.id, account.usedPercent, account.resetsAt])).toEqual([
      ['acc_a', 25, 1_000],
      ['acc_b', 60, 2_000],
    ])
    // Both rows were read, each with ITS OWN credential: a reading made for one
    // account and drawn on another is the bug being fixed.
    expect(asked.sort()).toEqual(['acc_a/token-acc_a', 'acc_b/token-acc_b'])
    // Reading quota is not serving a request: no pin was moved.
    expect(pool.calls.setPrimary).toEqual([])
    expect(card.error).toBe(null)
  })

  it('keeps one account failure on its own row and leaves the card alone', async () => {
    const pool = fakePool({ accounts: twoAccounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('qoder')))
    const registry = registryFor({
      line: 'qoder',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaClients: {
        qoder: async (_credentials, { accountId }) => {
          if (accountId === 'acc_a') throw new Error('upstream said no')
          return qoderSnapshot(60, 2_000)
        },
      },
    })
    const card = await registry.read('qoder')
    // The failed row falls back to the snapshot the pool already had…
    expect(card.accounts[0]).toMatchObject({ id: 'acc_a', usedPercent: 10, resetsAt: 111 })
    // …the healthy one still gets its own numbers…
    expect(card.accounts[1]).toMatchObject({ id: 'acc_b', usedPercent: 60, resetsAt: 2_000 })
    // …and a quota read that failed is not the card's error: nothing is broken.
    expect(card.error).toBe(null)
  })

  it('also survives a credential that cannot be read', async () => {
    const pool = fakePool({
      accounts: twoAccounts,
      credential: async (accountId) => {
        if (accountId === 'acc_a') throw new Error('rejected')
        return { accessToken: 'fine' }
      },
    })
    const http = fakeFetch(() => jsonResponse(envelopeOf('qoder')))
    const card = await registryFor({
      line: 'qoder',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaClients: { qoder: async () => qoderSnapshot(60, 2_000) },
    }).read('qoder')
    expect(card.accounts[0]).toMatchObject({ usedPercent: 10, resetsAt: 111 })
    expect(card.accounts[1]).toMatchObject({ usedPercent: 60, resetsAt: 2_000 })
  })

  it('reuses one reading for a minute instead of polling the upstream', async () => {
    const pool = fakePool({ accounts: twoAccounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('qoder')))
    let reads = 0
    const registry = registryFor({
      line: 'qoder',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaClients: {
        qoder: async () => {
          reads += 1
          return qoderSnapshot(25, 1_000)
        },
      },
    })
    const first = await registry.read('qoder')
    const second = await registry.read('qoder')
    // Two accounts, ONE read each, and the second card is answered from the cache.
    expect(reads).toBe(2)
    expect(second.accounts).toEqual(first.accounts)
    // The floor the board's 60 s poll depends on, asserted rather than assumed.
    expect(LINE_ACCOUNT_QUOTA_CACHE_MS).toBeGreaterThanOrEqual(60_000)
    // A failure is remembered for a much shorter time, so an account that
    // recovered is not hidden behind a minute of a blank row.
    expect(LINE_ACCOUNT_QUOTA_FAILURE_CACHE_MS).toBe(15_000)
    expect(LINE_ACCOUNT_QUOTA_FAILURE_CACHE_MS).toBeLessThan(LINE_ACCOUNT_QUOTA_CACHE_MS)
    // The budget the live Qoder endpoint needed: measured 107-1254 ms warm, and
    // over three seconds twice on a cold process.
    expect(LINE_ACCOUNT_QUOTA_TIMEOUT_MS).toBe(5_000)
    expect(LINE_ACCOUNT_QUOTA_CONCURRENCY).toBeLessThanOrEqual(2)
  })

  it('retries a failed reading after fifteen seconds, while a good one waits a minute', async () => {
    const pool = fakePool({ accounts: twoAccounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('qoder')))
    const calls: Record<string, number> = { acc_a: 0, acc_b: 0 }
    const registry = registryFor({
      line: 'qoder',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaClients: {
        qoder: async (_credentials, { accountId }) => {
          calls[accountId] = (calls[accountId] ?? 0) + 1
          if (accountId === 'acc_a') throw new Error('upstream said no')
          return qoderSnapshot(60, 2_000)
        },
      },
    })
    // Only Date is faked: the TTLs are wall-clock, while the reads themselves
    // must keep running on real timers (a fake `setTimeout` would hang them).
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      await registry.read('qoder')
      expect(calls).toEqual({ acc_a: 1, acc_b: 1 })

      // 14 s: both entries are still fresh — a failure for 15 s, a success for 60.
      vi.setSystemTime(Date.now() + 14_000)
      await registry.read('qoder')
      expect(calls).toEqual({ acc_a: 1, acc_b: 1 })

      // 16 s: the FAILED row is retried and the good one is still cached. This
      // is the whole point of the two tiers — a recovered account reappears on
      // the next poll instead of after a minute of blank row.
      vi.setSystemTime(Date.now() + 2_000)
      await registry.read('qoder')
      expect(calls).toEqual({ acc_a: 2, acc_b: 1 })

      // 76 s: the good reading finally expires too, and only then is it re-read.
      vi.setSystemTime(Date.now() + 60_000)
      await registry.read('qoder')
      expect(calls).toEqual({ acc_a: 3, acc_b: 2 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads again once the cached reading has expired', async () => {
    const pool = fakePool({ accounts: twoAccounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('qoder')))
    let reads = 0
    const registry = registryFor({
      line: 'qoder',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaCacheMs: 0,
      accountQuotaClients: {
        qoder: async () => {
          reads += 1
          return qoderSnapshot(25, 1_000)
        },
      },
    })
    await registry.read('qoder')
    await registry.read('qoder')
    expect(reads).toBe(4)
  })

  it('bounds one account read and keeps its row when it runs out', async () => {
    const pool = fakePool({ accounts: twoAccounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('qoder')))
    const started = Date.now()
    const card = await registryFor({
      line: 'qoder',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaTimeoutMs: 40,
      accountQuotaClients: { qoder: async () => await new Promise<never>(() => undefined) },
    }).read('qoder')
    expect(Date.now() - started).toBeLessThan(3_000)
    // The account with no snapshot keeps "nobody measured this"…
    expect(card.accounts[1]).toMatchObject({ id: 'acc_b', usedPercent: null, resetsAt: null })
    // …the one that had a snapshot keeps it, and the card is not an error.
    expect(card.accounts[0]).toMatchObject({ id: 'acc_a', usedPercent: 10 })
    expect(card.error).toBe(null)
  })

  it('never runs more than the gate allows at once', async () => {
    const accounts: PoolAccountSummaryDto[] = ['a', 'b', 'c', 'd'].map((id) => ({
      id: 'acc_' + id, alias: id, isPrimary: id === 'a',
    }))
    const pool = fakePool({ accounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('qoder')))
    let active = 0
    let peak = 0
    await registryFor({
      line: 'qoder',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaClients: {
        qoder: async () => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise((resolve) => setTimeout(resolve, 5))
          active -= 1
          return qoderSnapshot(25, 1_000)
        },
      },
    }).read('qoder')
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThanOrEqual(LINE_ACCOUNT_QUOTA_CONCURRENCY)
  })

  it('states the two caps the card is bounded by', () => {
    // The stage budget is what replaces ceil(accounts / concurrency) × one row.
    expect(LINE_ACCOUNT_QUOTA_WHOLE_BUDGET_MS).toBe(6_000)
    expect(LINE_ACCOUNT_QUOTA_MAX_ACCOUNTS).toBe(8)
    // It can never be SHORTER than one row's budget, or a cold first read would
    // be cut off before its single account could answer.
    expect(LINE_ACCOUNT_QUOTA_WHOLE_BUDGET_MS).toBeGreaterThanOrEqual(LINE_ACCOUNT_QUOTA_TIMEOUT_MS)
    // The number it removes: six accounts, two at a time, was 15 s.
    const unbounded = Math.ceil(6 / LINE_ACCOUNT_QUOTA_CONCURRENCY) * LINE_ACCOUNT_QUOTA_TIMEOUT_MS
    expect(unbounded).toBe(15_000)
    expect(LINE_ACCOUNT_QUOTA_WHOLE_BUDGET_MS).toBeLessThan(unbounded)
  })

  it('bounds the WHOLE stage, not one account at a time', async () => {
    // Six accounts; the first two answer instantly, the other four never answer.
    // With a 1 s row budget and concurrency 2 the unbounded cost is
    // ceil(6 / 2) × 1 s = 3 s; the 250 ms stage budget has to cut that off.
    const accounts: PoolAccountSummaryDto[] = ['1', '2', '3', '4', '5', '6'].map((suffix) => ({
      id: 'acc_' + suffix,
      alias: suffix,
      isPrimary: suffix === '1',
    }))
    const pool = fakePool({ accounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('qoder')))
    const asked: string[] = []
    const started = Date.now()
    const card = await registryFor({
      line: 'qoder',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaTimeoutMs: 1_000,
      accountQuotaWholeBudgetMs: 250,
      accountQuotaClients: {
        qoder: async (_credentials, { accountId }) => {
          asked.push(accountId)
          if (accountId === 'acc_1' || accountId === 'acc_2') return qoderSnapshot(25, 1_000)
          return await new Promise<never>(() => undefined)
        },
      },
    }).read('qoder')
    // Not 3 s: the card paid one stage budget, not one row budget per pair.
    expect(Date.now() - started).toBeLessThan(1_000)
    // Every account still has a row…
    expect(card.accounts.map((account) => account.id))
      .toEqual(['acc_1', 'acc_2', 'acc_3', 'acc_4', 'acc_5', 'acc_6'])
    // …the rows that came back have their numbers…
    expect(card.accounts.slice(0, 2).map((account) => account.usedPercent)).toEqual([25, 25])
    // …and the rows the budget never reached are BLANK, not wrong and not errors:
    // no bar, no window list, and the card itself is not in an error state.
    expect(card.accounts.slice(2).map((account) => [account.usedPercent, account.resetsAt, account.windows]))
      .toEqual([[null, null, []], [null, null, []], [null, null, []], [null, null, []]])
    expect(card.error).toBe(null)
    // Only the rows that actually got a gate slot were asked at all.
    expect(asked).toContain('acc_1')
    expect(asked.length).toBeLessThanOrEqual(accounts.length)
  }, 15_000)

  it('keeps the rows that answered just under their own budget, and only those', async () => {
    // The literal shape of the complaint: every reader takes almost its whole row
    // budget (190 of 200 ms here, 4.9 of 5 s in production). The first pair on the
    // gate therefore DOES answer — it is the rows behind it that can never get a
    // fair turn, and the stage budget is what stops them from queueing up.
    const accounts: PoolAccountSummaryDto[] = ['1', '2', '3', '4', '5', '6'].map((suffix) => ({
      id: 'acc_' + suffix,
      alias: suffix,
      isPrimary: suffix === '1',
    }))
    const pool = fakePool({ accounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('qoder')))
    const started = Date.now()
    const card = await registryFor({
      line: 'qoder',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaTimeoutMs: 200,
      accountQuotaWholeBudgetMs: 260,
      accountQuotaClients: {
        qoder: async () => {
          await new Promise((resolve) => setTimeout(resolve, 190))
          return qoderSnapshot(25, 1_000)
        },
      },
    }).read('qoder')
    // ceil(6 / 2) × 200 ms = 600 ms unbounded; the stage closed at 260 ms.
    expect(Date.now() - started).toBeLessThan(500)
    expect(card.accounts.slice(0, 2).map((account) => account.usedPercent)).toEqual([25, 25])
    expect(card.accounts.slice(2).map((account) => account.usedPercent)).toEqual([null, null, null, null])
    expect(card.error).toBe(null)
  }, 15_000)

  it('answers six hanging accounts inside the whole budget, not 3 × 5 s', async () => {
    // The real constants, no seam: six accounts whose readers do not answer (the
    // worst case of "hangs five seconds"). Before the stage budget this cost
    // ceil(6 / 2) × 5 s = 15 s and froze the board for the duration.
    const accounts: PoolAccountSummaryDto[] = ['1', '2', '3', '4', '5', '6'].map((suffix) => ({
      id: 'acc_' + suffix,
      alias: suffix,
      isPrimary: suffix === '1',
    }))
    const pool = fakePool({ accounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('qoder')))
    const started = Date.now()
    const card = await registryFor({
      line: 'qoder',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaClients: {
        qoder: async (_credentials, { accountId }) => {
          if (accountId === 'acc_1' || accountId === 'acc_2') return qoderSnapshot(25, 1_000)
          return await new Promise<never>(() => undefined)
        },
      },
    }).read('qoder')
    const elapsed = Date.now() - started
    // The number the acceptance asks for: 6 s plus a little slack, never 15 s.
    expect(elapsed).toBeGreaterThanOrEqual(LINE_ACCOUNT_QUOTA_TIMEOUT_MS)
    expect(elapsed).toBeLessThanOrEqual(LINE_ACCOUNT_QUOTA_WHOLE_BUDGET_MS + 1_500)
    // The two rows that answered before the deadline are filled in…
    expect(card.accounts.slice(0, 2).map((account) => account.usedPercent)).toEqual([25, 25])
    // …the four that did not are blank and silent.
    expect(card.accounts.slice(2).map((account) => account.usedPercent)).toEqual([null, null, null, null])
    expect(card.error).toBe(null)
  }, 20_000)

  it('reads at most eight accounts, primary first, and leaves the rest unread', async () => {
    // Pool order says nothing about which rows matter: the primary is LAST here
    // and the rest are scrambled by recency, so the ordering is the thing tested.
    const accounts: PoolAccountSummaryDto[] = [
      { id: 'acc_a', alias: 'a', isPrimary: false, lastUsedAt: 10 },
      { id: 'acc_b', alias: 'b', isPrimary: false, lastUsedAt: 90 },
      { id: 'acc_c', alias: 'c', isPrimary: false, lastUsedAt: 50 },
      { id: 'acc_d', alias: 'd', isPrimary: false, lastUsedAt: 80 },
      { id: 'acc_e', alias: 'e', isPrimary: false, lastUsedAt: 30 },
      { id: 'acc_f', alias: 'f', isPrimary: false, lastUsedAt: 70 },
      { id: 'acc_g', alias: 'g', isPrimary: false, lastUsedAt: 20 },
      { id: 'acc_h', alias: 'h', isPrimary: false, lastUsedAt: 60 },
      { id: 'acc_i', alias: 'i', isPrimary: false, lastUsedAt: 40 },
      { id: 'acc_j', alias: 'j', isPrimary: true },
    ]
    const pool = fakePool({ accounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('qoder')))
    const asked: string[] = []
    const card = await registryFor({
      line: 'qoder',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaClients: {
        qoder: async (_credentials, { accountId }) => {
          asked.push(accountId)
          return qoderSnapshot(40, 1_000)
        },
      },
    }).read('qoder')
    // Exactly the cap, not ten.
    expect(asked).toHaveLength(LINE_ACCOUNT_QUOTA_MAX_ACCOUNTS)
    // The primary goes first even though the pool lists it last…
    expect(asked[0]).toBe('acc_j')
    // …then the eight most recently used, which excludes the two coldest rows.
    expect([...asked].sort()).toEqual(['acc_b', 'acc_c', 'acc_d', 'acc_e', 'acc_f', 'acc_h', 'acc_i', 'acc_j'])
    expect(asked).not.toContain('acc_g')
    expect(asked).not.toContain('acc_a')
    // Every pooled account still gets a ROW: the cap leaves rows blank, it never
    // drops them from the card.
    expect(card.accounts).toHaveLength(accounts.length)
    const unread = card.accounts.filter((account) => account.id === 'acc_a' || account.id === 'acc_g')
    expect(unread.map((account) => [account.usedPercent, account.resetsAt, account.windows]))
      .toEqual([[null, null, []], [null, null, []]])
    expect(card.error).toBe(null)
  })

  it('still reuses a reading on the second read, inside the stage budget', async () => {
    // Six accounts, all answering quickly, bound by a small stage budget: the
    // cache is what keeps the board's 60 s poll from becoming an upstream poll.
    const accounts: PoolAccountSummaryDto[] = ['1', '2', '3', '4', '5', '6'].map((suffix) => ({
      id: 'acc_' + suffix,
      alias: suffix,
      isPrimary: suffix === '1',
    }))
    const pool = fakePool({ accounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('qoder')))
    const asked: string[] = []
    const registry = registryFor({
      line: 'qoder',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaTimeoutMs: 1_000,
      accountQuotaWholeBudgetMs: 400,
      accountQuotaClients: {
        qoder: async (_credentials, { accountId }) => {
          asked.push(accountId)
          return qoderSnapshot(40, 1_000)
        },
      },
    })
    const first = await registry.read('qoder')
    expect(asked).toHaveLength(6)
    expect(first.accounts.map((account) => account.usedPercent)).toEqual([40, 40, 40, 40, 40, 40])
    // The second read asks nobody: every row was read and remembered per account.
    const second = await registry.read('qoder')
    expect(asked).toHaveLength(6)
    expect(second.accounts).toEqual(first.accounts)
  })

  it('leaves a line with no hook exactly as it was', async () => {
    const pool = fakePool({ accounts: (statusOf('codex') as { accounts: PoolAccountSummaryDto[] }).accounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('codex')))
    const card = await registryFor({ line: 'codex', pool: pool.source, fetchFn: http.fetchFn }).read('codex')
    // The pool's own snapshot, untouched, and no credential was ever asked for.
    expect(card.accounts[0]).toMatchObject({ usedPercent: 0, resetsAt: 1795250462000 })
    expect(pool.calls.credentialFor).toEqual([])
    // Only the two lines that opted in, and only when a client was injected.
    expect(Object.keys(LINE_ACCOUNT_QUOTA_READERS).sort()).toEqual(['minimax-code', 'qoder'])
    expect(createAccountQuotaReaders(undefined)).toEqual({})
    expect(Object.keys(createAccountQuotaReaders({ qoder: async () => null }))).toEqual(['qoder'])
    // The hook also needs a pool that can hand a credential over.
    const noCredential = fakePool({ accounts: twoAccounts })
    delete (noCredential.source as { getFreshCredential?: unknown }).getFreshCredential
    const bare = await registryFor({
      line: 'qoder',
      pool: noCredential.source,
      fetchFn: http.fetchFn,
      accountQuotaClients: { qoder: async () => qoderSnapshot(60, 2_000) },
    }).read('qoder')
    expect(bare.accounts[0]).toMatchObject({ usedPercent: 10 })
    expect(bare.accounts[1]).toMatchObject({ usedPercent: null })
  })

  it('hands the MiniMax reader the account the row is about', async () => {
    const pool = fakePool({ accounts: twoAccounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('minimax-code')))
    const seen: string[] = []
    const card = await registryFor({
      line: 'minimax-code',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaClients: {
        'minimax-code': async (_credentials, { accountId }) => {
          seen.push(accountId)
          // The line's own parsed shape, weekly window deliberately tighter.
          return {
            windows: [
              { key: 'interval', usedPercent: accountId === 'acc_a' ? 12 : 34, remainingPercent: 0, resetsAtMs: 5 },
              { key: 'weekly', usedPercent: 99, remainingPercent: 1, resetsAtMs: 9 },
            ],
          }
        },
      },
    }).read('minimax-code')
    expect(seen.sort()).toEqual(['acc_a', 'acc_b'])
    expect(card.accounts.map((account) => [account.usedPercent, account.resetsAt]))
      .toEqual([[12, 5], [34, 5]])
  })

  it('gives each account its OWN full window list, not the line one', async () => {
    const pool = fakePool({ accounts: twoAccounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('minimax-code')))
    const card = await registryFor({
      line: 'minimax-code',
      pool: pool.source,
      fetchFn: http.fetchFn,
      accountQuotaClients: {
        // Two windows each, and every NUMBER differs per account: a list copied
        // from the line, or from the other row, would still pass a length check.
        'minimax-code': async (_credentials, { accountId }) => ({
          windows: [
            {
              key: 'interval',
              usedPercent: accountId === 'acc_a' ? 12 : 34,
              resetsAtMs: accountId === 'acc_a' ? 5 : 7,
            },
            {
              key: 'weekly',
              usedPercent: accountId === 'acc_a' ? 21 : 88,
              resetsAtMs: accountId === 'acc_a' ? 9 : 11,
            },
          ],
        }),
      },
    }).read('minimax-code')
    // 2 windows vs 2 windows, each row with its own two.
    expect(card.accounts.map((account) => account.windows)).toEqual([
      [
        { label: '5 小时', usedPercent: 12, windowMinutes: 300, resetsAt: 5 },
        { label: '每周', usedPercent: 21, windowMinutes: 10_080, resetsAt: 9 },
      ],
      [
        { label: '5 小时', usedPercent: 34, windowMinutes: 300, resetsAt: 7 },
        { label: '每周', usedPercent: 88, windowMinutes: 10_080, resetsAt: 11 },
      ],
    ])
    // The bar still draws the 5-hour window, so the two views of one row agree.
    expect(card.accounts.map((account) => account.usedPercent)).toEqual([12, 34])
  })

  it('states an empty list, never a 0 % placeholder, when the read measured nothing', async () => {
    const pool = fakePool({ accounts: twoAccounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('minimax-code')))
    const card = await registryFor({
      line: 'minimax-code',
      pool: pool.source,
      fetchFn: http.fetchFn,
      // The upstream answered without one measurable window.
      accountQuotaClients: { 'minimax-code': async () => ({ windows: [] }) },
    }).read('minimax-code')
    // acc_b never had a snapshot, so it has nothing — and says exactly that
    // instead of drawing a bar nobody measured.
    expect(card.accounts[1]).toMatchObject({ id: 'acc_b', usedPercent: null, resetsAt: null, windows: [] })
    // acc_a keeps the snapshot the pool already held, while its LIST is still the
    // empty answer this read gave: the bar and the list are separate facts.
    expect(card.accounts[0]).toMatchObject({ id: 'acc_a', usedPercent: 10, windows: [] })
    expect(card.error).toBe(null)
  })

  it('leaves the key off entirely for a line with no hook', async () => {
    const pool = fakePool({ accounts: (statusOf('codex') as { accounts: PoolAccountSummaryDto[] }).accounts })
    const http = fakeFetch(() => jsonResponse(envelopeOf('codex')))
    const card = await registryFor({ line: 'codex', pool: pool.source, fetchFn: http.fetchFn }).read('codex')
    // Not `windows: []`: nobody asked this line, and an empty list would report a
    // read that never happened.
    expect('windows' in card.accounts[0]!).toBe(false)
    expect(card.accounts[0]!.windows).toBeUndefined()
  })

  it('lets the account window list through the capability schema without demanding it', () => {
    const accounts = (LINE_CARD_SCHEMA.properties as Record<string, unknown>).accounts as {
      items: {
        additionalProperties: boolean
        required: string[]
        properties: Record<string, { type?: unknown; items?: { required?: string[] } }>
      }
    }
    // Allowed — a hooked line states it, and `additionalProperties: false` is
    // exactly why an undeclared key would otherwise be rejected.
    expect(accounts.items.additionalProperties).toBe(false)
    expect(accounts.items.properties.windows?.type).toBe('array')
    // The list's own items carry the same four fields as `quota.windows` …
    expect(accounts.items.properties.windows?.items?.required)
      .toEqual(['label', 'usedPercent', 'windowMinutes', 'resetsAt'])
    // … and the list is NOT required, because the nine lines without a hook omit it.
    expect(accounts.items.required).not.toContain('windows')
  })
})

describe('line card props', () => {
  it('requires the card to name its line', () => {
    expect(lineOfProps({ line: 'codex' })).toBe('codex')
    expect(lineOfProps({ line: '  codex  ' })).toBe('codex')
    expect(() => lineOfProps({})).toThrow(/line/)
    expect(() => lineOfProps(null)).toThrow(/line/)
    expect(() => lineOfProps({ line: '' })).toThrow(/line/)
  })
})

/** A board that records what one widget-type registration was handed. */
function fakeBoard() {
  const groups: Array<{
    dataSources?: WidgetBoardDataSourceRegistration[]
    capabilities?: WidgetBoardCapabilityRegistration[]
  }> = []
  const service = {
    apiVersion: 3,
    registerWidgetType: async (): Promise<WidgetBoardHandle> => ({
      provider: WIDGET_BOARD_PROVIDER,
      widgets: [],
      register: (group: { dataSources?: WidgetBoardDataSourceRegistration[], capabilities?: WidgetBoardCapabilityRegistration[] } = {}) => {
        groups.push(group)
        return () => undefined
      },
      dispose: async () => undefined,
    }),
    registerCapability: () => () => undefined,
  }
  return { service: service as unknown as WidgetBoardService, groups }
}

/** A host context whose inject hands over the board. */
function fakeContext(service: WidgetBoardService): WidgetBoardContext {
  const scope: WidgetBoardScope = {
    get: (name: string) => (name === 'widgetBoard' ? service : undefined),
    logger: { warn: () => undefined },
    effect: (callback: () => () => void) => { callback() },
  }
  return {
    inject: (_names: string[], callback: (scope: WidgetBoardScope) => void) => { callback(scope) },
  }
}

describe('line card registrations', () => {
  it('registers the line data source and its three capabilities', async () => {
    const board = fakeBoard()
    const http = fakeFetch(() => jsonResponse(envelopeOf('codex')))
    const pool = fakePool({ accounts: (statusOf('codex') as { accounts: PoolAccountSummaryDto[] }).accounts })
    registerWidgetBoard(fakeContext(board.service), {
      widgetsDirectory: '/test-widgets',
      lines: {
        origin: () => 'http://127.0.0.1:3080',
        pools: { codex: pool.source },
        fetchFn: http.fetchFn,
        definitions: LINE_DEFINITIONS.filter((definition) => definition.id === 'codex'),
      },
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const group = board.groups[0]
    expect(group?.dataSources?.map((source) => source.id)).toEqual([LINE_CARD_DATA_SOURCE_ID])
    expect(group?.capabilities?.map((capability) => capability.id)).toEqual([
      LINE_REFRESH_CAPABILITY_ID,
      LINE_ACCOUNT_SWITCH_CAPABILITY_ID,
      LINE_ACCOUNT_STRATEGY_CAPABILITY_ID,
    ])
    for (const registration of [...(group?.dataSources ?? []), ...(group?.capabilities ?? [])]) {
      expect(registration.provider).toBe(WIDGET_BOARD_PROVIDER)
    }
    const card = await (group?.dataSources ?? [])
      .find((source) => source.id === LINE_CARD_DATA_SOURCE_ID)
      ?.read({ id: 'card-1', widget: 'line-card', props: { line: 'codex' } }) as LineCardData
    expect(card.line).toBe('codex')
    expect(card.quota?.windows).toHaveLength(1)
    const refresh = (group?.capabilities ?? []).find((entry) => entry.id === LINE_REFRESH_CAPABILITY_ID)
    await expect(Promise.resolve(refresh?.call(
      { id: 'card-1', widget: 'line-card', props: { line: 'codex' } },
      { line: 'codex' },
      new AbortController().signal,
    ))).resolves.toMatchObject({ line: 'codex' })
  })

  it('carries the composition per-account quota clients through to the registry', async () => {
    // The other half of the injection: src/index.ts hands these over, the
    // provider must not swallow them. Without this the hook would work in a unit
    // test and be dead in a real host.
    const board = fakeBoard()
    const http = fakeFetch(() => jsonResponse(envelopeOf('minimax-code')))
    const pool = fakePool({
      accounts: [
        { id: 'acc_a', alias: 'a', isPrimary: true },
        { id: 'acc_b', alias: 'b', isPrimary: false },
      ],
    })
    registerWidgetBoard(fakeContext(board.service), {
      widgetsDirectory: '/test-widgets',
      lines: {
        origin: () => 'http://127.0.0.1:3080',
        pools: { 'minimax-code': pool.source },
        fetchFn: http.fetchFn,
        definitions: LINE_DEFINITIONS.filter((definition) => definition.id === 'minimax-code'),
        accountQuotaClients: {
          // Spelled out: the registration call is cast, so nothing here is
          // contextually typed.
          'minimax-code': async (_credentials: unknown, { accountId }: { accountId: string }) => ({
            windows: [{ key: 'interval', usedPercent: accountId === 'acc_a' ? 20 : 40, resetsAtMs: 5 }],
          }),
        },
      },
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const source = (board.groups[0]?.dataSources ?? []).find((entry) => entry.id === LINE_CARD_DATA_SOURCE_ID)
    const card = await source?.read({
      id: 'card-1', widget: 'line-card', props: { line: 'minimax-code' },
    }) as LineCardData
    expect(card.accounts.map((account) => account.usedPercent)).toEqual([20, 40])
  })

  it('registers no data source and no capability when the composition has no line registry', async () => {
    const board = fakeBoard()
    registerWidgetBoard(fakeContext(board.service), {
      widgetsDirectory: '/test-widgets',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const group = board.groups[0]
    // One card per line is the whole contribution: with no registry there is
    // nothing to register, and no ChatGPT-only source standing in for it.
    expect(group?.dataSources).toEqual([])
    expect(group?.capabilities).toEqual([])
  })
})
