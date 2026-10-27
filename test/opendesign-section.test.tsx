// @vitest-environment jsdom
/**
 * The OpenDesign tab renders the shared account card and the things this line
 * owns: the paste-key form, the catalog sync button, and the plan/credit card
 * the billing summary feeds. No credential ever reaches the DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { OpenDesignSection } from '../src/client/opendesign/OpenDesignSection.tsx'
import { zh } from '../src/client/opendesign/locales.ts'
import type { OpenDesignCodingPlanDto, OpenDesignModelDto, OpenDesignUsageDto, OpenDesignWebStatus } from '../src/shared/opendesign-contracts.ts'

const STATUS: OpenDesignWebStatus = {
  enabled: true,
  providerId: 'opendesign',
  baseURL: 'https://amr-link.open-design.ai/v1',
  serving: true,
  conflict: null,
  usable: true,
  authenticated: true,
  pool: {
    accounts: [
      { id: 'a1', alias: '主号', isPrimary: true, authKind: 'api-key' },
      { id: 'a2', alias: '备用号', isPrimary: false, authKind: 'api-key', cooldownUntil: Date.now() + 600_000 },
      { id: 'a3', alias: 'Dev', isPrimary: false, authKind: 'oauth', plan: 'pro', email: 'dev@example.com' },
    ],
    activeAccountId: 'a1',
    rotationStrategy: 'sequential',
  },
  models: [
    {
      id: 'gpt-6-luna',
      name: 'GPT-6 Luna',
      hint: '128k · text · reasoning · $0.1/$0.5',
      contextWindow: 128_000,
      defaultContextWindow: 128_000,
      maxTokens: 64_000,
      reasoning: true,
      input: ['text'],
      enabled: true,
      pricing: { input: 0.1, output: 0.5 },
    },
    {
      id: 'kimi-k3',
      name: 'Kimi K3',
      hint: '128k · text · reasoning · $3/$15',
      contextWindow: 128_000,
      defaultContextWindow: 128_000,
      maxTokens: 64_000,
      reasoning: true,
      input: ['text'],
      enabled: false,
    },
  ],
  catalogSynced: false,
  catalogCount: 0,
  usage: null,
  login: null,
  settings: {
    baseURL: 'https://amr-link.open-design.ai/v1',
    defaultContextWindow: 128_000,
    defaultMaxTokens: 64_000,
    maxConcurrentRequests: 10,
    streamIdleTimeoutMs: 300_000,
  },
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  vi.unstubAllGlobals()
  container?.remove()
  container = null
})

function statusPayload(overrides: Partial<OpenDesignWebStatus> = {}): OpenDesignWebStatus {
  return { ...STATUS, ...overrides }
}

async function render(
  overrides: Partial<OpenDesignWebStatus> = {},
  onPost?: (url: string, body: unknown) => void,
  usageForRead?: OpenDesignUsageDto,
): Promise<HTMLDivElement> {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    // Only this line's own prefix answers; a stray call to a sibling route fails loud.
    if (!url.startsWith('/opendesign/api')) throw new Error(`unexpected fetch: ${url}`)
    if (init?.method === 'POST') {
      onPost?.(url, JSON.parse(String(init.body ?? '{}')))
      if (url === '/opendesign/api/accounts') {
        const body = JSON.parse(String(init.body ?? '{}')) as { action?: string }
        if (body.action === 'test') {
          return Response.json({ ok: true, value: { ok: true, authorized: true, ms: 42, error: '', modelCount: 2 } })
        }
      }
      // The card reads plan/credits once when it opens; the answer carries the
      // reading plus the refreshed status, exactly like the host route.
      if (url === '/opendesign/api/usage') {
        const usage = usageForRead ?? overrides.usage ?? { accounts: [], fetchedAt: Date.now() }
        return Response.json({
          ok: true,
          value: { usage, status: statusPayload({ ...overrides, usage }) },
        })
      }
    }
    return Response.json({ ok: true, value: statusPayload(overrides) })
  }))
  await act(async () => {
    root = createRoot(container!)
    root.render(<OpenDesignSection />)
  })
  return container!
}

describe('OpenDesignSection', () => {
  it('renders the pooled accounts with the shared card', async () => {
    const node = await render()
    expect(node.textContent).toContain('主号')
    expect(node.textContent).toContain('备用号')
    expect(node.textContent).toContain(zh.accountPool)
    // The primary badge and the cooling badge come from the shared card.
    expect(node.textContent).toContain(zh.primaryAccount)
    expect(node.textContent).toContain(zh.cooling)
  })

  it('keeps the heading rows to the shared shape: at most two action buttons each', async () => {
    const node = await render()
    const heads = [...node.querySelectorAll('.dsha-grouphead')]
    expect(heads.length).toBeGreaterThan(0)
    for (const head of heads) {
      expect(head.querySelectorAll('button').length).toBeLessThanOrEqual(2)
    }
  })

  it('draws no quota block: the gateway answers an API key no balance', async () => {
    const node = await render()
    // The shared card's quota legend must not appear; the notes say why instead.
    expect(node.textContent).not.toContain(zh.accountQuota)
    expect(node.textContent).not.toContain(zh.quotaNone)
    expect(node.textContent).toContain(zh.limitQuota)
  })

  it('never renders a key, and the add form posts it only to the accounts route', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = []
    const node = await render({}, (url, body) => posts.push({ url, body: body as Record<string, unknown> }))
    const addButton = [...node.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === zh.addAccount)!
    await act(async () => { addButton.click() })
    const input = node.querySelector<HTMLInputElement>('#opendesign-key')!
    expect(input.type).toBe('password')
    await act(async () => {
      // React 18 onChange reads the native setter value.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'od_live_secret')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...node.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === zh.keySave)!
    await act(async () => { save.click() })
    expect(posts.some((post) => post.url === '/opendesign/api/accounts' && post.body.action === 'add' && post.body.apiKey === 'od_live_secret')).toBe(true)
    // The DOM never holds the secret: not in markup, not in the cleared input.
    expect(node.innerHTML).not.toContain('od_live_secret')
  })

  it('renders the checklist from the status models and toggles post the selection', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = []
    const node = await render({}, (url, body) => posts.push({ url, body: body as Record<string, unknown> }))
    expect(node.textContent).toContain('GPT-6 Luna')
    expect(node.textContent).toContain('Kimi K3')
    // Not synced yet: the card says the bundled table is what it shows.
    expect(node.textContent).toContain(zh.catalogNeverSynced)
    const row = [...node.querySelectorAll<HTMLElement>('.dsh-mcl-option')]
      .find((option) => option.textContent?.includes('Kimi K3'))!
    expect(row.getAttribute('aria-checked')).toBe('false')
    await act(async () => { row.click() })
    // Enabling the last unchecked model turns the whole list on, which the card
    // stores as the tri-state "no filter" (null), not as an all-ids list.
    const enable = posts.find((post) => post.url === '/opendesign/api/models')
    expect(enable).toBeDefined()
    expect(enable!.body.enabledModelIds).toBeNull()
    // Unchecking the one enabled model posts an explicit empty selection.
    const gpt = [...node.querySelectorAll<HTMLElement>('.dsh-mcl-option')]
      .find((option) => option.textContent?.includes('GPT-6 Luna'))!
    await act(async () => { gpt.click() })
    const disable = posts.filter((post) => post.url === '/opendesign/api/models').pop()
    expect(disable!.body.enabledModelIds).toEqual([])
  })

  it('an empty pool renders the paste-key guidance, not a fake signed-in state', async () => {
    const node = await render({
      pool: { accounts: [], rotationStrategy: 'sequential' },
      usable: false,
      authenticated: false,
    })
    expect(node.textContent).toContain(zh.noAccounts)
    expect(node.textContent).not.toContain(zh.primaryAccount)
  })

  it('the key form links to the console where keys are created', async () => {
    const node = await render()
    const addButton = [...node.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === zh.addAccount)!
    await act(async () => { addButton.click() })
    const link = node.querySelector<HTMLAnchorElement>('a.dshod-link')!
    expect(link.href).toBe('https://open-design.ai/cloud')
    expect(link.target).toBe('_blank')
  })
})

describe('OpenDesignSection sign-in', () => {
  it('offers exactly the two sign-in entries in the account card heading', async () => {
    const node = await render()
    const head = [...node.querySelectorAll('.dsha-grouphead')]
      .find((element) => element.textContent?.includes(zh.accountPool))!
    const buttons = [...head.querySelectorAll('button')].map((button) => button.textContent)
    expect(buttons).toEqual([zh.login, zh.useApiKey])
  })

  it('renders a pending flow with its code and activation link, and polls by id', async () => {
    const posted: Array<{ url: string; body: unknown }> = []
    const node = await render({}, (url, body) => posted.push({ url, body }))
    const loginButton = [...node.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === zh.login)!
    // The host flow this card drives.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.startsWith('/opendesign/api')) throw new Error('unexpected fetch: ' + url)
      if (url === '/opendesign/api/login/start') {
        return Response.json({ ok: true, value: {
          id: 'flow-1',
          status: 'pending',
          userCode: 'AB12CD',
          verificationUri: 'https://open-design.ai/cloud/cli/activate?deviceId=dev-1&userCode=AB12CD',
          expiresAt: Date.now() + 300_000,
          intervalSeconds: 2,
          error: '',
          accountAlias: '',
        } })
      }
      if (url.startsWith('/opendesign/api/login/status')) {
        return Response.json({ ok: true, value: {
          id: 'flow-1',
          status: 'pending',
          userCode: 'AB12CD',
          verificationUri: 'https://open-design.ai/cloud/cli/activate?deviceId=dev-1&userCode=AB12CD',
          expiresAt: Date.now() + 300_000,
          intervalSeconds: 2,
          error: '',
          accountAlias: '',
        } })
      }
      return Response.json({ ok: true, value: statusPayload() })
    }))
    await act(async () => { loginButton.click() })
    expect(node.textContent).toContain('AB12CD')
    const link = node.querySelector<HTMLAnchorElement>('.dshod-login-row a')!
    expect(link.href).toContain('deviceId=dev-1')
    expect(link.target).toBe('_blank')
    expect(node.textContent).toContain(zh.loginWaiting)
  })

  it('idle with accounts says the pool holds them; idle and empty says not signed in', async () => {
    const withAccounts = await render()
    expect(withAccounts.textContent).toContain(zh.loginHaveAccounts.replace('{count}', '3'))
    const empty = await render({
      pool: { accounts: [], rotationStrategy: 'sequential' },
      usable: false,
      authenticated: false,
    })
    expect(empty.textContent).toContain(zh.loginIdle)
  })

  it('an OAuth account row shows its sign-in kind and plan; a balance read shows beside it', async () => {
    const node = await render({
      usage: {
        accounts: [{ accountId: 'a3', alias: 'Dev', ok: true, balanceUsd: '12.34', updatedAt: null, error: '', fetchedAt: Date.now() }],
        fetchedAt: Date.now(),
      },
    })
    expect(node.textContent).toContain(zh.oauthAccount)
    expect(node.textContent).toContain('pro')
    expect(node.textContent).toContain('$12.34')
    expect(node.textContent).toContain(zh.apiKeyAccount)
  })

  it('shows the billed tier and credits, not the sign-in plan string', async () => {
    const posts: Array<{ url: string; body: unknown }> = []
    const billed = {
      accounts: [{
        accountId: 'a3',
        alias: 'Dev',
        ok: true,
        balanceUsd: '1.5000',
        updatedAt: null,
        error: '',
        fetchedAt: Date.now(),
        billing: {
          plan: 'go',
          status: 'active',
          entitlementStatus: 'active',
          billingInterval: 'monthly',
          periodStart: '2026-10-21T03:33:15.000Z',
          periodEnd: '2026-11-21T03:33:15.000Z',
          subscriptionCredits: '10000',
          rechargeCredits: '5000',
          totalAvailableCredits: '15000',
          subscriptionCreditsUsd: '1.0000',
          rechargeCreditsUsd: '0.5000',
          totalAvailableCreditsUsd: '1.5000',
          totalConsumedUsd: '0.0000',
          todayConsumedUsd: '0.0000',
          usageCount: 1429,
          updatedAt: '2026-10-22T01:06:22.615Z',
        },
      }],
      fetchedAt: Date.now(),
    }
    const node = await render({}, (url, body) => posts.push({ url, body }), billed)
    // Opening the card reads them itself; the section is not a button away.
    expect(posts.some((post) => post.url === '/opendesign/api/usage')).toBe(true)
    // The billing tier wins over the sign-in snapshot (`plan: 'pro'` above).
    expect(node.textContent).toContain(zh.usagePlan.replace('{plan}', 'Go'))
    expect(node.textContent).toContain(zh.usagePlanActive)
    expect(node.textContent).toContain(zh.usageSubscriptionCredits.replace('{credits}', '10,000').replace('{usd}', '1.0000'))
    expect(node.textContent).toContain(zh.usageTotalCredits.replace('{credits}', '15,000').replace('{usd}', '1.5000'))
    expect(node.textContent).toContain(zh.usageTodayConsumed.replace('{amount}', '0.0000'))
    expect(node.textContent).toContain(zh.usageUsageCount.replace('{count}', '1429'))
    expect(node.textContent).not.toContain('· pro')
  })

  it('does not ask for plan and credits when only a pasted key is pooled', async () => {
    const posts: Array<{ url: string; body: unknown }> = []
    await render({
      pool: {
        accounts: [{ id: 'a1', alias: '主号', isPrimary: true, authKind: 'api-key' }],
        activeAccountId: 'a1',
        rotationStrategy: 'sequential',
      },
    }, (url, body) => posts.push({ url, body }))
    // No control key exists on a pasted key: the request would only answer 400.
    expect(posts.some((post) => post.url === '/opendesign/api/usage')).toBe(false)
  })
})

describe('OpenDesignSection design plan windows', () => {
  const BILLING = {
    plan: 'go',
    status: 'active',
    entitlementStatus: 'active',
    billingInterval: 'monthly',
    periodStart: null,
    periodEnd: null,
    subscriptionCredits: '10000',
    rechargeCredits: '5000',
    totalAvailableCredits: '15000',
    subscriptionCreditsUsd: '2.0000',
    rechargeCreditsUsd: '6.0000',
    totalAvailableCreditsUsd: '8.0000',
    totalConsumedUsd: '2.0000',
    todayConsumedUsd: '0.0000',
    usageCount: 12,
    updatedAt: null,
  }

  /** One readable account; `codingPlan` is what the window bars are built from. */
  function usageWith(codingPlan: OpenDesignCodingPlanDto | undefined): OpenDesignUsageDto {
    return {
      accounts: [{
        accountId: 'a3',
        alias: 'Dev',
        ok: true,
        balanceUsd: '8.0000',
        updatedAt: null,
        error: '',
        fetchedAt: Date.now(),
        billing: BILLING,
        codingPlan,
      }],
      fetchedAt: Date.now(),
    }
  }

  it('draws one bar per Design Plan window, with the share each window has spent', async () => {
    const node = await render({}, undefined, usageWith({
      tier: 'go',
      error: '',
      windows: [
        { policyId: 'five-hour', durationSeconds: 18_000, limitCredits: '1000', remainingCredits: '900', resetsAt: '2026-10-22T01:06:22.615Z' },
        { policyId: 'seven-day', durationSeconds: 604_800, limitCredits: '1000', remainingCredits: '810', resetsAt: null },
      ],
    }))
    expect(node.textContent).toContain(zh.usageWindowsTitle)
    // The name comes from the window's own length, not from its policy id.
    expect([...node.querySelectorAll<HTMLElement>('.dshod-plan-window-name')].map((element) => element.textContent))
      .toEqual([
        zh.usageWindowHours.replace('{count}', '5'),
        zh.usageWindowDays.replace('{count}', '7'),
      ])
    // 900 of 1000 left is 10% spent; 810 of 1000 left is 19% spent.
    expect(node.textContent).toContain(zh.usageWindowUsed.replace('{used}', '10'))
    expect(node.textContent).toContain(zh.usageWindowRemaining.replace('{remaining}', '90'))
    expect(node.textContent).toContain(zh.usageWindowUsed.replace('{used}', '19'))
    expect(node.textContent).toContain(zh.usageWindowRemaining.replace('{remaining}', '81'))
    const tracks = [...node.querySelectorAll<HTMLElement>('.dshod-meter-track')]
    expect(tracks).toHaveLength(2)
    expect(tracks.map((track) => track.getAttribute('role'))).toEqual(['progressbar', 'progressbar'])
    expect(tracks.map((track) => track.getAttribute('aria-valuenow'))).toEqual(['10', '19'])
    expect([...node.querySelectorAll<HTMLElement>('.dshod-meter-fill')].map((fill) => fill.style.width))
      .toEqual(['10%', '19%'])
    // The window that states a reset says when; the one that does not stays quiet.
    const resets = [...node.querySelectorAll<HTMLElement>('.dshod-plan-resets')]
    expect(resets).toHaveLength(1)
    expect(resets[0]!.textContent!.endsWith('重置')).toBe(true)
    expect(node.textContent).not.toContain(zh.usageWindowsUnavailable)
  })

  it('draws no bar and says so when the plan configures no window', async () => {
    const node = await render({}, undefined, usageWith({ tier: 'go', error: '', windows: [] }))
    expect(node.querySelector('.dshod-plan')).toBeNull()
    expect(node.querySelector('.dshod-meter-track')).toBeNull()
    expect(node.textContent).toContain(zh.usageWindowsUnavailable)
    // The numeric grid is untouched: the figures the summary did send remain.
    expect(node.textContent).toContain(zh.usageTotalCredits.replace('{credits}', '15,000').replace('{usd}', '8.0000'))
    expect(node.textContent).toContain(zh.usageTotalConsumed.replace('{amount}', '2.0000'))
  })

  it('draws no bar when the window read failed, even if a window list came with it', async () => {
    const node = await render({}, undefined, usageWith({
      tier: 'go',
      error: 'HTTP 502',
      windows: [{ policyId: 'five-hour', durationSeconds: 18_000, limitCredits: '1000', remainingCredits: '900', resetsAt: null }],
    }))
    expect(node.querySelector('.dshod-plan')).toBeNull()
    expect(node.querySelector('.dshod-meter-track')).toBeNull()
    expect(node.textContent).toContain(zh.usageWindowsUnavailable)
  })

  it('says the windows are unavailable when the account carries no plan reading', async () => {
    const node = await render({}, undefined, usageWith(undefined))
    expect(node.querySelector('.dshod-plan')).toBeNull()
    expect(node.textContent).toContain(zh.usageWindowsUnavailable)
  })

  it('names the console, not a failed read, when the endpoint refuses plugin credentials', async () => {
    const node = await render({}, undefined, usageWith({
      tier: 'go',
      error: 'HTTP 401: unauthenticated (tried: bearer control key; bearer runtime key; x-api-key runtime key)',
      windows: [],
    }))
    expect(node.querySelector('.dshod-meter-track')).toBeNull()
    expect(node.textContent).toContain(zh.usageWindowsConsoleOnly)
    // The windows are configured; blaming the read would send the user to retry
    // something that can never succeed from here.
    expect(node.textContent).not.toContain(zh.usageWindowsUnavailable)
  })

  it('still blames the read for a status that is not about credentials', async () => {
    const node = await render({}, undefined, usageWith({
      tier: 'go',
      error: 'HTTP 404: coding_plan_configuration_unavailable',
      windows: [],
    }))
    expect(node.querySelector('.dshod-meter-track')).toBeNull()
    expect(node.textContent).toContain(zh.usageWindowsUnavailable)
    expect(node.textContent).not.toContain(zh.usageWindowsConsoleOnly)
  })
})

/** A complete model row, with every field the card needs already filled in. */
function modelFixture(overrides: Partial<OpenDesignModelDto>): OpenDesignModelDto {
  return {
    id: 'model',
    name: 'Model',
    contextWindow: 128_000,
    defaultContextWindow: 128_000,
    maxTokens: 64_000,
    reasoning: false,
    input: ['text'],
    enabled: true,
    ...overrides,
  }
}

/** The one quiet hint line the row naming this model carries. */
function hintOf(node: HTMLDivElement, name: string): string {
  const row = [...node.querySelectorAll<HTMLElement>('.dsh-mcl-option')]
    .find((option) => option.textContent?.includes(name))!
  return row.querySelector<HTMLElement>('.dsh-mcl-hint')!.textContent!
}

describe('OpenDesignSection models the plan withholds', () => {
  const SERVED = modelFixture({ id: 'gpt-6-luna', name: 'GPT-6 Luna', hint: '128k · text · reasoning · $0.1/$0.5', reasoning: true })
  const UNMARKED = modelFixture({ id: 'kimi-k3', name: 'Kimi K3', hint: '128k · text · reasoning · $3/$15', reasoning: true })
  const WITHHELD = modelFixture({ id: 'llama-unserved', name: 'Llama Unserved', hint: '128k · text', served: false })

  it('labels the withheld row and leaves the served and unmarked rows verbatim', async () => {
    const node = await render({ models: [SERVED, UNMARKED, WITHHELD] })
    // The badge is appended behind the same separator the hint itself uses.
    expect(hintOf(node, 'Llama Unserved')).toBe('128k · text · ' + zh.unservedBadge)
    // A row stating served: true and a row stating nothing keep their hint.
    expect(hintOf(node, 'GPT-6 Luna')).toBe('128k · text · reasoning · $0.1/$0.5')
    expect(hintOf(node, 'Kimi K3')).toBe('128k · text · reasoning · $3/$15')
    const labelled = [...node.querySelectorAll<HTMLElement>('.dsh-mcl-hint')]
      .filter((hint) => hint.textContent?.includes(zh.unservedBadge))
    expect(labelled).toHaveLength(1)
  })

  it('explains the withheld rows beside the model hint while one is listed', async () => {
    const node = await render({ models: [SERVED, WITHHELD] })
    expect(node.textContent).toContain(zh.modelsHint)
    expect(node.textContent).toContain(zh.unservedHint)
  })

  it('says nothing extra when every listed model is served', async () => {
    // The default status states no plan marker on either model, which means
    // served: the card renders exactly the hint block it always did.
    const node = await render()
    expect(node.textContent).not.toContain(zh.unservedHint)
    expect(node.textContent).not.toContain(zh.unservedBadge)
  })
})
