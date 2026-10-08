// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { LocalLoginsBlock } from '../src/client/hub/LocalLoginsBlock.tsx'
import { ProviderHubSection } from '../src/client/ProviderHubSection.tsx'
import { zh } from '../src/client/locales.ts'
import { ROUTE_PREFIX } from '../src/compat.ts'
import type { LocalLoginScanDto, LocalLoginSourceDto } from '../src/shared/contracts.ts'

const t = ((key: keyof typeof zh) => zh[key]) as never

function source(overrides: Partial<LocalLoginSourceDto> & Pick<LocalLoginSourceDto, 'id'>): LocalLoginSourceDto {
  return {
    detected: true,
    paths: ['C:/Users/example/.codex/auth.json'],
    importMode: 'settings-only',
    providerLabel: 'Some CLI',
    ...overrides,
  }
}

/** The host's fixed three rows: one this line imports, two that own their own control. */
function scan(): LocalLoginScanDto {
  return {
    sources: [
      source({ id: 'codex', importMode: 'adopt', providerLabel: 'Codex CLI' }),
      source({ id: 'claude-code', providerLabel: 'Claude Code', paths: ['C:/Users/example/.claude/.credentials.json'] }),
      source({ id: 'minimax-code', providerLabel: 'MiniMax Code', detected: false, paths: ['C:/Users/example/.minimax/auth.json'] }),
    ],
  }
}

interface Call { url: string; method: string; body?: unknown }

describe('local sign-in block', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
  })

  function mockFetch(answers: { scan?: unknown; adopt?: 'ok' | string } = {}) {
    const calls: Call[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) })
      // The page-level test below mounts the whole settings section, so the hub
      // overview answers here too.
      if (url.endsWith('/hub/overview')) {
        const ids = ["chatgpt","antigravity","command-code","kimi-code","workbuddy","minimax-code","claude","ollama"]
        return Response.json({ ok: true, value: { providers: ids.map((id, index) => ({
          id, providerId: `${id}-provider`, canToggle: id !== 'ollama', enabled: true,
          accountCount: index % 3, authenticated: index % 3 > 0, enabledModelCount: null, totalModelCount: null,
        })) } })
      }
      if (url.endsWith('/local-logins')) {
        if (answers.scan === 'fail') return Response.json({ ok: false, error: { code: 'internal', message: 'scan failed' } }, { status: 500 })
        // Deliberately untyped: a malformed payload is the case under test, and
        // a cast at the call site would only hide which answers are legal.
        return Response.json({ ok: true, value: answers.scan ?? scan() })
      }
      if (url.endsWith('/adopt')) {
        return answers.adopt !== undefined && answers.adopt !== 'ok'
          ? Response.json({ ok: false, error: { code: 'bad-request', message: answers.adopt } }, { status: 400 })
          : Response.json({ ok: true, value: { authenticated: true } })
      }
      return Response.json({ ok: true, value: {} })
    }) as typeof fetch
    return calls
  }

  async function render(onImported = vi.fn()) {
    await act(async () => root.render(createElement(LocalLoginsBlock, { t, onImported } as never)))
    return onImported
  }

  function rows(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('.dsh-hub-local-row')]
  }

  it('renders one row per host source, in the order the host returned them', async () => {
    mockFetch()
    await render()
    expect(rows().map((row) => row.querySelector('.dsh-hub-local-name')?.textContent))
      .toEqual(['Codex CLI', 'Claude Code', 'MiniMax Code'])
    // The paths are what answers "where did you look?", so they are on the row.
    expect(rows()[0]!.querySelector('.dsh-hub-local-path')?.textContent).toBe('C:/Users/example/.codex/auth.json')
  })

  it('follows the host list instead of a client-side copy of it', async () => {
    // A provider the client has never heard of, in an order of the host's choosing.
    mockFetch({ scan: { sources: [
      source({ id: 'minimax-code', providerLabel: 'MiniMax Code' }),
      source({ id: 'claude-code', providerLabel: 'Claude Code' }),
    ] } })
    await render()
    expect(rows().map((row) => row.querySelector('.dsh-hub-local-name')?.textContent))
      .toEqual(['MiniMax Code', 'Claude Code'])
    expect(rows()).toHaveLength(2)
  })

  it('states an absent sign-in rather than hiding the row', async () => {
    mockFetch()
    await render()
    const missing = rows()[2]!
    expect(missing.querySelector('.dsh-hub-local-state')?.textContent).toBe(zh.localLoginNotDetected)
    expect(missing.querySelector<HTMLElement>('.dsh-hub-local-state')?.dataset.detected).toBe('false')
    expect(rows()[0]!.querySelector('.dsh-hub-local-state')?.textContent).toBe(zh.localLoginDetected)
    // Nothing to import when the host found nothing, so no button is offered.
    expect(missing.querySelector('button')).toBeNull()
  })

  it('imports the Codex sign-in by naming its source, then re-reads the scan', async () => {
    const calls = mockFetch()
    const onImported = await render()
    const button = rows()[0]!.querySelector<HTMLButtonElement>('button')!
    expect(button.textContent).toBe(zh.localLoginImport)
    expect(button.getAttribute('aria-label')).toBe('导入 Codex CLI 的本机登录')
    await act(async () => button.click())

    const adopt = calls.find((call) => call.url === `${ROUTE_PREFIX}/adopt`)
    expect(adopt?.method).toBe('POST')
    expect(adopt?.body).toEqual({ source: 'codex' })
    // The scan is read again rather than assumed: importing copies the CLI's own
    // file and never removes it.
    expect(calls.filter((call) => call.url === `${ROUTE_PREFIX}/local-logins`)).toHaveLength(2)
    expect(onImported).toHaveBeenCalledTimes(1)
  })

  it('offers no import button on a settings-only row', async () => {
    mockFetch()
    await render()
    // Two of the three rows are the providers' own business.
    expect(rows()[1]!.querySelector('button')).toBeNull()
    expect(rows()[2]!.querySelector('button')).toBeNull()
    expect(rows()[1]!.textContent).toContain(zh.localLoginSettingsOnly)
    // Exactly one button on the block: the one import this line owns.
    expect(container.querySelectorAll('.dsh-hub-local-row button')).toHaveLength(1)
  })

  it("shows the host's own refusal in the error strip", async () => {
    mockFetch({ adopt: 'No usable local Codex CLI sign-in was found (unrecognised local sign-in format).' })
    await render()
    await act(async () => rows()[0]!.querySelector<HTMLButtonElement>('button')!.click())
    await act(async () => Promise.resolve())

    const strip = container.querySelector('[role="alert"]')!
    expect(strip.textContent).toContain('No usable local Codex CLI sign-in was found (unrecognised local sign-in format).')
    // The rows survive a refused import: they were still true.
    expect(rows()).toHaveLength(3)
  })

  it('offers a retry when the scan itself never arrived', async () => {
    const calls = mockFetch({ scan: 'fail' })
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('scan failed')
    mockFetch()
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click())
    expect(rows()).toHaveLength(3)
    expect(calls.every((call) => call.url.endsWith('/local-logins'))).toBe(true)
  })

  it('survives a 200 answer that is not a scan at all', async () => {
    // A body of some other object's shape reaches the client intact: the
    // envelope unwraps happily and nothing downstream knows it is wrong.
    mockFetch({ scan: { authenticated: true } })
    await expect(render()).resolves.toBeDefined()
    const strip = container.querySelector('[role="alert"]')!
    expect(strip.textContent).toContain('unexpected shape')
    expect(strip.querySelector('button')?.textContent).toBe(zh.retry)
    // No rows invented for a scan that never arrived: the host owns that list.
    expect(rows()).toHaveLength(0)
  })

  it('treats a sources value that is not an array as a failed scan', async () => {
    for (const sources of ['codex', null, 7, { codex: true }]) {
      mockFetch({ scan: { sources } })
      await expect(render()).resolves.toBeDefined()
      expect(rows()).toHaveLength(0)
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('unexpected shape')
    }
  })

  it('leaves the rest of the settings page standing when the scan is malformed', async () => {
    // The block shares its page with every provider card, none of which depend on
    // this request; a malformed scan may cost the block its rows and nothing else.
    mockFetch({ scan: {} })
    await expect(act(async () => root.render(createElement(ProviderHubSection, { t } as never)))).resolves.toBeUndefined()
    expect(container.querySelectorAll('.dsh-hub-card')).toHaveLength(8)
    expect(container.querySelector('.dsh-hub-locals [role="alert"]')?.textContent).toContain('unexpected shape')
  })

  it('drops a row it cannot key rather than taking the page down', async () => {
    mockFetch({ scan: { sources: [null, { providerLabel: 'No id' }, scan().sources[0]] } })
    await render()
    expect(rows().map((row) => row.querySelector('.dsh-hub-local-name')?.textContent)).toEqual(['Codex CLI'])
  })

  it('shows a busy state while the import is in flight', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/local-logins')) return Response.json({ ok: true, value: scan() })
      await gate
      return Response.json({ ok: true, value: { authenticated: true } })
    }) as typeof fetch
    await render()
    const button = rows()[0]!.querySelector<HTMLButtonElement>('button')!

    // One flush is enough: the busy state is set synchronously by the click, and
    // only the host's answer is still outstanding.
    await act(async () => { button.click() })
    expect(rows()[0]!.getAttribute('aria-busy')).toBe('true')
    expect(button.textContent).toBe(zh.localLoginImporting)
    expect(button.disabled).toBe(true)

    release()
    await act(async () => { await gate })
    expect(button.disabled).toBe(false)
    expect(rows()[0]!.getAttribute('aria-busy')).toBe('false')
  })
})
