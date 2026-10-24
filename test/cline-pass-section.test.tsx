// @vitest-environment jsdom
/**
 * The Cline Pass tab renders the shared account card and the one thing this
 * line owns: the per-model upstream channel panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrandTile } from '../src/client/hub/brand-icons.tsx'
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
      has: [],
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
    pinSpelling: 'both',
  },
}

import type { Root } from 'react-dom/client'

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

async function render(overrides: Partial<ClinePassWebStatus> = {}, onPost?: (url: string, body: unknown) => void): Promise<HTMLDivElement> {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown
    if (init?.method === 'POST') onPost?.(url, body)
    if (url.includes('/cline-pass/api/catalog/search')) {
      return Response.json({
        ok: true,
        value: {
          results: [
            { id: 'cline-pass/glm-5.3-extra', added: false, billing: 'subscription' },
            { id: 'deepseek/deepseek-v4-pro', added: false, billing: 'credits' },
          ],
        },
      })
    }
    if (url.endsWith('/cline-pass/api/catalog/add')) {
      const posted = (body ?? {}) as { model?: string; acknowledgeBilling?: boolean }
      const currentModels = overrides.models ?? STATUS.models
      const template = currentModels[0]!
      const addedModel = { ...template, id: posted.model ?? 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true, has: [] }
      return Response.json({ ok: true, value: { added: true, billing: posted.acknowledgeBilling === true ? 'credits' : 'subscription', status: { ...STATUS, ...overrides, models: [...currentModels, addedModel] } } })
    }
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
          status: { ...STATUS, ...overrides },
        },
      })
    }
    if (url.endsWith('/cline-pass/api/accounts')) {
      return Response.json({ ok: true, value: STATUS })
    }
    return Response.json({ ok: true, value: { ...STATUS, ...overrides } })
  }))
  await act(async () => {
    root?.unmount()
  })
  root = createRoot(container as HTMLDivElement)
  await act(async () => {
    root!.render(<ClinePassSection />)
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

  it('marks the anonymous contributor route on the channel chips and warns on pin', async () => {
    const model = STATUS.models[0]!
    const el = await render({
      models: [{ ...model, upstreams: ['openai-compatible-private', 'deepseek'], pinned: ['openai-compatible-private'] }],
    })
    const chips = [...el.querySelectorAll<HTMLElement>('.dshcp-channel')]
    expect(chips[0]?.getAttribute('data-anonymous')).toBe('true')
    expect(chips[0]?.textContent).toContain('⚠')
    expect(chips[0]?.getAttribute('title')).toContain(zh.anonymousChannelHint)
    expect(chips[1]?.getAttribute('data-anonymous')).toBe('false')
    // The stored pin loads into the draft, so the no-ZDR warning shows at once.
    expect(el.textContent).toContain('可能被用于训练')
  })

  it('pins a channel typed by hand when the probe discovered nothing', async () => {
    const model = STATUS.models[0]!
    const posts: Array<{ url: string; body: unknown }> = []
    const el = await render({
      models: [{ ...model, upstreams: [], upstreamStatus: [], pinned: [] }],
    }, (url, body) => posts.push({ url, body }))
    const input = el.querySelector<HTMLInputElement>('.dshcp-body input[list]')!
    expect(input).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'deepseek')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const add = [...el.querySelectorAll('button')].find((button) => button.textContent === zh.addChannel)!
    await act(async () => add.click())
    const chips = [...el.querySelectorAll<HTMLElement>('.dshcp-channel')]
    expect(chips.map((chip) => chip.firstChild?.textContent)).toContain('deepseek')
    expect(chips[0]?.getAttribute('data-pinned')).toBe('true')
    const save = [...el.querySelectorAll('button')].find((button) => button.textContent === zh.savePin)!
    await act(async () => save.click())
    expect(posts.find((entry) => entry.url.endsWith('/models/pin'))?.body).toMatchObject({
      model: 'cline-pass/glm-5.3',
      upstreams: ['deepseek'],
    })
  })

  it('edits and saves the gateway capability filter', async () => {
    const model = STATUS.models[0]!
    const posts: Array<{ url: string; body: unknown }> = []
    const el = await render({
      models: [{ ...model, pinned: ['deepseek'], has: ['vision', 'implicit-caching'] }],
    }, (url, body) => posts.push({ url, body }))
    const input = el.querySelector<HTMLInputElement>('input[placeholder="vision, implicit-caching"]')!
    expect(input.value).toBe('vision, implicit-caching')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'vision')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...el.querySelectorAll('button')].find((button) => button.textContent === zh.savePin)!
    await act(async () => save.click())
    expect(posts.find((entry) => entry.url.endsWith('/models/pin'))?.body).toMatchObject({
      model: 'cline-pass/glm-5.3',
      upstreams: ['deepseek'],
      has: ['vision'],
    })
  })

  it('survives a host older than the capability filter, which sends no has at all', async () => {
    // A newer client bundle can meet an older host: the browser loads client
    // assets on demand while the host loaded them at startup. Spreading an
    // absent `has` used to throw during render and unmount the whole card.
    const model = STATUS.models[0]!
    const olderHostModel: Record<string, unknown> = { ...model }
    delete olderHostModel.has
    expect('has' in olderHostModel).toBe(false)
    // The DTO type requires `has`; the point is that a host which predates it
    // sends a payload the type does not describe, so the cast has to go through
    // `unknown` rather than claiming the two shapes overlap.
    const el = await render({ models: [olderHostModel as unknown as typeof model] })
    const box = el.querySelector<HTMLInputElement>('input[placeholder="vision, implicit-caching"]')
    expect(box?.value).toBe('')
  })

  it('does not reset a half-typed filter when an unrelated status answer arrives', async () => {
    // `projectModels` builds a fresh `has` array on every status answer, so
    // keying the reseed effect on the array identity rewrote a half-typed value
    // on each poll. Only a changed VALUE may reseed the box.
    const model = STATUS.models[0]!
    // A getter that hands back a NEW array each read, exactly what a fresh
    // status projection does.
    const modelWithFreshArray = { ...model, pinned: ['deepseek'], has: ['vision'] }
    Object.defineProperty(modelWithFreshArray, 'has', { get: () => ['vision'], enumerable: true })
    const el = await render({ models: [modelWithFreshArray] })
    const box = el.querySelector<HTMLInputElement>('input[placeholder="vision, implicit-caching"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(box, 'vision, ')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(box.value).toBe('vision, ')
    // Saving the pin is an unrelated action whose answer replaces the whole
    // status, so the model object (and its `has` array) is new again.
    const save = [...el.querySelectorAll('button')].find((button) => button.textContent === zh.savePin)!
    await act(async () => save.click())
    expect(box.value).toBe('vision, ')
  })

  it('adds a subscription hit in one click and a marketplace hit only after acknowledging credits', async () => {
    const posts: Array<{ url: string; body: unknown }> = []
    const el = await render({}, (url, body) => posts.push({ url, body }))
    expect(el.querySelectorAll('.dsh-mcl-option')).toHaveLength(1)
    const input = el.querySelector<HTMLInputElement>(`input[placeholder="${zh.catalogSearchPlaceholder}"]`)!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'glm')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const search = [...el.querySelectorAll('button')].find((button) => button.textContent === zh.catalogSearch)!
    await act(async () => search.click())
    const chipFor = (id: string): HTMLElement => [...el.querySelectorAll<HTMLElement>('.dshcp-channel')]
      .find((chip) => chip.textContent?.includes(id))!
    expect(chipFor('cline-pass/glm-5.3-extra').textContent).toContain(zh.catalogBillingSubscription)
    expect(chipFor('deepseek/deepseek-v4-pro').textContent).toContain(zh.catalogBillingCredits)

    await act(async () => chipFor('cline-pass/glm-5.3-extra').querySelector('button')!.click())
    expect(posts.filter((entry) => entry.url.endsWith('/catalog/add')).map((entry) => entry.body))
      .toEqual([{ model: 'cline-pass/glm-5.3-extra' }])

    // A marketplace id spends the Credits balance: the first click only explains
    // that, and nothing is posted until the second one.
    await act(async () => chipFor('deepseek/deepseek-v4-pro').querySelector('button')!.click())
    expect(posts.filter((entry) => entry.url.endsWith('/catalog/add'))).toHaveLength(1)
    expect(el.textContent).toContain(zh.catalogCreditsWarning)
    await act(async () => chipFor('deepseek/deepseek-v4-pro').querySelector('button')!.click())
    expect(posts.filter((entry) => entry.url.endsWith('/catalog/add')).map((entry) => entry.body))
      .toEqual([{ model: 'cline-pass/glm-5.3-extra' }, { model: 'deepseek/deepseek-v4-pro', acknowledgeBilling: true }])
    expect(el.textContent).toContain('DeepSeek V4 Pro')
  })

  it('shows each account its own quota window inside the shared account card', async () => {
    const el = await render()
    const row = el.querySelector('.dsha-account-quota-row')
    expect(row).not.toBeNull()
    expect(row?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42')
    expect(el.textContent).toContain('5 小时')
    expect(el.textContent).toContain('42%')
  })

  it('renders the three-state idle note and keeps login progress inside the account card', async () => {
    const populated = await render()
    expect(populated.textContent).toContain(zh.loginHaveAccounts.replace('{count}', '2'))
    const empty = await render({ authenticated: false, usable: false, pool: { accounts: [], rotationStrategy: 'sequential' } })
    expect(empty.textContent).toContain(zh.loginIdle)
    const pending = await render({
      login: {
        id: 'flow-1',
        status: 'pending',
        userCode: 'ABCD-1234',
        verificationUri: 'https://app.cline.bot/device?code=ABCD-1234',
        expiresAt: Date.now() + 300_000,
        intervalSeconds: 5,
        error: '',
        accountAlias: '',
      },
    })
    expect(pending.querySelector('.dshcp-flow')?.textContent).toContain('ABCD-1234')
    // No separate h3 section for sign-in.
    const headings = [...pending.querySelectorAll('.dsha-grouphead h3')].map((h) => h.textContent)
    expect(headings).not.toContain(zh.loginTitle)
  })

  it('states the capability boundaries inside a collapsed details block', async () => {
    const el = await render()
    const details = el.querySelector('details.dshcp-details')
    expect(details).not.toBeNull()
    expect(el.textContent).toContain(zh.limitKey)
    expect(el.textContent).toContain(zh.limitGateway)
    expect(el.textContent).toContain(zh.limitQuota)
  })

  it('never renders a stored key, only the alias', async () => {
    const el = await render()
    expect(el.innerHTML).not.toContain('sk-')
    expect(el.textContent).toContain('主号')
  })

  it('aligns advanced settings into shared dsha-row and dsha-pref-row rows with matching hints', async () => {
    const el = await render()
    const advGroup = [...el.querySelectorAll('section.dsha-group')].find(
      (section) => section.querySelector('.dsha-grouphead h3')?.textContent === zh.advancedSection,
    )!
    expect(advGroup).toBeDefined()
    expect(advGroup.querySelectorAll('.dsha-row')).toHaveLength(6)
    const prefRows = [...advGroup.querySelectorAll('.dsha-pref-row')]
    expect(prefRows).toHaveLength(2)
    // Each preference row pairs its own heading and hint.
    expect(prefRows[0]?.textContent).toContain(zh.pinSpelling)
    expect(prefRows[0]?.textContent).toContain(zh.pinSpellingHint)
    expect(prefRows[1]?.textContent).toContain(zh.exposeTools)
    expect(prefRows[1]?.textContent).toContain(zh.exposeToolsHint)
  })
})

describe('the hub card mark', () => {
  it('uses the official Cline glyph rather than a monogram', () => {
    const markup = renderToStaticMarkup(<BrandTile id="cline-pass" />)
    // The official white icon's viewBox and single currentColor path.
    expect(markup).toContain('viewBox="0 0 113 113"')
    expect(markup).toContain('fill="currentColor"')
    expect(markup).not.toContain('dsh-hub-brand-mono')
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
