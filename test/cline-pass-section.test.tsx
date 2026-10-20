// @vitest-environment jsdom
/**
 * The Cline Pass tab renders the shared account card and the one thing this
 * line owns: the per-model upstream channel panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ClinePassSection } from '../src/client/cline-pass/ClinePassSection.tsx'
import { selectClinePassFacts } from '../src/client/cline-pass/ClinePassComposerQuota.tsx'
import { zh } from '../src/client/cline-pass/locales.ts'
import type { ClinePassWebStatus } from '../src/shared/cline-pass-contracts.ts'

const STATUS: ClinePassWebStatus = {
  enabled: true,
  providerId: 'cline-pass',
  baseURL: 'https://api.cline.bot/api/v1',
  serving: true,
  conflict: null,
  exposeTools: false,
  usable: true,
  authenticated: true,
  pool: {
    accounts: [
      { id: 'a1', alias: '主号', isPrimary: true, authKind: 'oauth' },
      { id: 'a2', alias: '备用号', isPrimary: false, cooldownUntil: Date.now() + 600_000 },
    ],
    activeAccountId: 'a1',
    rotationStrategy: 'round-robin',
  },
  models: [
    {
      id: 'cline-pass/glm-5.3',
      name: 'GLM-5.3',
      contextWindow: 1_000_000,
      defaultContextWindow: 1_000_000,
      maxTokens: 131_072,
      reasoning: true,
      input: ['text'],
      enabled: true,
      pipeline: 'direct',
      pinnable: true,
      pinned: [],
      excluded: [],
      pinMode: 'strict',
      sort: '',
      upstreams: ['baseten', 'deepseek'],
      upstreamStatus: [
        { upstream: 'baseten', status: 'ok', ms: 120, note: '', checkedAt: Date.now() },
        { upstream: 'deepseek', status: 'limited', ms: 90, note: '429', checkedAt: Date.now() },
      ],
      lastProvider: 'baseten',
      lastMs: 120,
      probedAt: Date.now(),
      validatedAt: 0,
    },
  ],
  catalogSynced: true,
  catalogCount: 1,
  usage: {
    accounts: [{
      accountId: 'a1',
      alias: '主号',
      ok: true,
      windows: [{ type: 'five_hour', label: '5 小时', percentUsed: 42, resetsAt: '' }],
      error: '',
      fetchedAt: Date.now(),
    }],
    fetchedAt: Date.now(),
  },
  historySize: 0,
  login: null,
  settings: {
    baseURL: 'https://api.cline.bot/api/v1',
    defaultContextWindow: 128_000,
    defaultMaxTokens: 64_000,
    maxConcurrentRequests: 16,
    streamIdleTimeoutMs: 300_000,
    historyLimit: 100,
    exposeCatalog: false,
    pinSpelling: 'both',
  },
}

let container: HTMLDivElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  vi.unstubAllGlobals()
  container?.remove()
  container = null
})

async function render(overrides: Partial<ClinePassWebStatus> = {}, onPost?: (url: string, body: unknown) => void): Promise<HTMLDivElement> {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown
    if (init?.method === 'POST') onPost?.(url, body)
    if (url.endsWith('/cline-pass/api/models/pin')) {
      const posted = body as { model: string; upstreams?: string[]; exclude?: string[]; pinMode?: string; sort?: string }
      return Response.json({
        ok: true,
        value: {
          pin: {
            upstreams: posted.upstreams ?? [],
            exclude: posted.exclude ?? [],
            pinMode: posted.pinMode === 'preferred' ? 'preferred' : 'strict',
            sort: posted.sort ?? '',
          },
          warnings: [],
          status: STATUS,
        },
      })
    }
    if (url.endsWith('/cline-pass/api/accounts')) {
      return Response.json({ ok: true, value: STATUS })
    }
    return Response.json({ ok: true, value: { ...STATUS, ...overrides } })
  }))
  const root = createRoot(container as HTMLDivElement)
  await act(async () => {
    root.render(<ClinePassSection />)
  })
  return container as HTMLDivElement
}

describe('ClinePassSection', () => {
  it('renders the shared account card and the model checklist', async () => {
    const el = await render()
    expect(el.querySelectorAll('.dsha-account-card')).toHaveLength(2)
    expect(el.querySelectorAll('.dsh-mcl-option')).toHaveLength(1)
    expect(el.textContent).toContain('GLM-5.3')
  })

  it('offers device sign-in as the primary action and keeps a key fallback', async () => {
    const el = await render()
    const headerButtons = [...el.querySelectorAll('.dsha-grouphead button')].map((button) => button.textContent)
    expect(headerButtons).toContain(zh.login)
    expect(headerButtons).toContain(zh.useApiKey)
    // The account row says how it signed in, without exposing a token.
    expect(el.textContent).toContain(zh.oauthAccount)
  })

  it('renders the discovered channels as chips with their verdicts', async () => {
    const el = await render()
    const chips = [...el.querySelectorAll('.dshcp-channel')]
    expect(chips.map((chip) => chip.firstChild?.textContent)).toEqual(['baseten', 'deepseek'])
    expect(chips[0]?.getAttribute('data-status')).toBe('ok')
    expect(chips[1]?.getAttribute('data-status')).toBe('limited')
  })

  it('pins a channel locally, then saves the order to the host', async () => {
    const posts: Array<{ url: string; body: unknown }> = []
    const el = await render({}, (url, body) => posts.push({ url, body }))
    const chips = [...el.querySelectorAll<HTMLElement>('.dshcp-channel')]
    await act(async () => chips[1]?.click())
    expect([...el.querySelectorAll('.dshcp-channel')][1]?.getAttribute('data-pinned')).toBe('true')
    const save = [...el.querySelectorAll('button')].find((button) => button.textContent === zh.savePin)
    expect(save).not.toBeUndefined()
    await act(async () => save?.click())
    expect(posts.find((entry) => entry.url.endsWith('/models/pin'))?.body).toMatchObject({
      model: 'cline-pass/glm-5.3',
      upstreams: ['deepseek'],
    })
  })

  it('shows each account its own quota window', async () => {
    const el = await render()
    expect(el.textContent).toContain('5 小时')
    expect(el.textContent).toContain('42%')
  })

  it('states the capability boundaries on the tab', async () => {
    const el = await render()
    expect(el.textContent).toContain(zh.limitKey)
    expect(el.textContent).toContain(zh.limitGateway)
    expect(el.textContent).toContain(zh.limitQuota)
  })

  it('never renders a stored key, only the alias', async () => {
    const el = await render()
    expect(el.innerHTML).not.toContain('sk-')
    expect(el.textContent).toContain('主号')
  })
})

describe('the composer badge facts', () => {
  it('shows the remaining share of the most-consumed window', () => {
    const status: ClinePassWebStatus = {
      ...STATUS,
      usage: {
        accounts: [STATUS.usage!.accounts[0]!],
        fetchedAt: Date.now(),
      },
    }
    expect(selectClinePassFacts(status, 'cline-pass/glm-5.3')).toMatchObject({ text: '58%' })
  })

  it('is absent while the line is disabled or nothing was read', () => {
    expect(selectClinePassFacts({ ...STATUS, authenticated: false })).toBeNull()
    expect(selectClinePassFacts({ ...STATUS, usage: null })).toBeNull()
    expect(selectClinePassFacts(null)).toBeNull()
  })
})
