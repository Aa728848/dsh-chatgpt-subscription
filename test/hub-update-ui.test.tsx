// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { UpdateCheck } from '../src/client/hub/UpdateCheck.tsx'
import { HubOverview } from '../src/client/hub/HubOverview.tsx'
import { ProviderHubSection } from '../src/client/ProviderHubSection.tsx'
import { zh } from '../src/client/locales.ts'
import type { UpdateApplyDto, UpdateCheckDto, UpdateFailureDto } from '../src/shared/update-contracts.ts'

const t = ((key: keyof typeof zh) => zh[key]) as never

/** One check answer, with the fields each outcome cares about spelled out. */
function checkDto(overrides: Partial<UpdateCheckDto> = {}): UpdateCheckDto {
  return {
    current: '0.34.0',
    latest: '0.99.0',
    updateAvailable: true,
    installKind: 'registry',
    canApply: true,
    command: 'dsh plugin add @eddyskywalker/dsh-chatgpt-subscription@latest',
    checkedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('UpdateCheck', () => {
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

  /** A Host that answers the check with `check` and the apply with `apply`. */
  function mockHost(options: {
    check?: UpdateCheckDto | 'network-failure'
    apply?: { ok: true; value: UpdateApplyDto } | UpdateFailureDto
  }) {
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/update/apply')) {
        return Response.json(options.apply ?? { ok: true, value: { installed: '0.35.0', restartRequired: true, removedFirst: false } })
      }
      if (options.check === 'network-failure' || options.check === undefined) {
        return Response.json({ ok: false, error: { code: 'internal', message: 'boom' } }, { status: 500 })
      }
      return Response.json({ ok: true, value: options.check })
    }) as typeof fetch
    return calls
  }

  async function render() {
    await act(async () => root.render(createElement(UpdateCheck, { t } as never)))
  }

  const button = (): HTMLButtonElement => container.querySelector('.dsh-hub-update-button')!
  const control = (): Element => container.querySelector('.dsh-hub-update')!
  /** The row pairing the status line with the icon button. */
  const row = (): Element => container.querySelector('.dsh-hub-update-row')!
  const status = (): string => container.querySelector('.dsh-hub-update-state')?.textContent ?? ''
  const command = (): string => container.querySelector('.dsh-hub-update-command')?.textContent ?? ''
  /** One element's children by their first class, in DOM order. */
  const classesOf = (element: Element): string[] => [...element.children].map((node) => node.className.split(' ')[0] ?? '')
  /** The icon's accessible name: the only place the state is spelled out now. */
  const name = (): string | null => button().getAttribute('aria-label')

  async function clickButton(): Promise<void> {
    await act(async () => button().click())
    // Let the awaited fetch settle inside the same act boundary.
    await act(async () => { await Promise.resolve() })
  }

  it('asks nothing until the icon is clicked', async () => {
    const calls = mockHost({ check: checkDto() })
    await render()
    expect(calls).toEqual([])
    // The icon carries its meaning in the accessible name, not in visible text.
    expect(button().textContent).toBe('')
    expect(name()).toBe(zh.hubUpdateCheck)
    expect(button().title).toBe(zh.hubUpdateCheck)
    expect(button().disabled).toBe(false)
    // No status line before an answer: there is nothing true to say yet.
    expect(status()).toBe('')
  })

  it('draws a ring icon inside the button and no visible label', async () => {
    mockHost({ check: checkDto() })
    await render()
    const icon = button().querySelector('svg')
    expect(icon).not.toBeNull()
    expect(icon?.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(icon?.getAttribute('stroke')).toBe('currentColor')
    // The label lives in the accessible name only; nothing is rendered as text.
    expect(button().textContent).toBe('')
  })

  it('marks the offer with a dot instead of widening the button', async () => {
    mockHost({ check: checkDto() })
    await render()
    // Before the check there is nothing to offer, so no dot.
    expect(container.querySelector('.dsh-hub-update-dot')).toBeNull()
    await clickButton()
    // One click can install: the accent dot appears, the icon keeps its size.
    expect(container.querySelector('.dsh-hub-update-dot')).not.toBeNull()
    expect(name()).toBe('更新到 v0.99.0')
    // The dot is inside the button, next to the icon rather than in place of it.
    expect(button().querySelector('.dsh-hub-update-dot')).not.toBeNull()
    expect(button().querySelector('svg')).not.toBeNull()
  })

  it('shows no dot for an offer this Host cannot perform', async () => {
    mockHost({ check: checkDto({ canApply: false, reason: 'development-install', installKind: 'link' }) })
    await render()
    await clickButton()
    // The command is the way out here; nothing invites a click that cannot work.
    expect(container.querySelector('.dsh-hub-update-dot')).toBeNull()
    expect(name()).toBe(zh.hubUpdateCheck)
  })

  it('renders the icon last in its row, so the text beside it can never move it', async () => {
    mockHost({ check: checkDto() })
    await render()
    // Before any answer the icon is alone, holding the row's right edge.
    expect(classesOf(row())).toEqual(['dsh-hub-update-button'])
    await clickButton()
    // A line of text appears on its left, and the icon is still the last child:
    // the text grows leftwards into the free space instead of pushing it aside.
    expect(classesOf(row())).toEqual(['dsh-hub-update-state', 'dsh-hub-update-button'])
  })

  it('puts the command on its own line under the row, not beside the icon', async () => {
    mockHost({ check: checkDto({ canApply: false, reason: 'development-install', installKind: 'link' }) })
    await render()
    await clickButton()
    // The control is a column: the status row, then the command beneath it.
    expect(classesOf(control())).toEqual(['dsh-hub-update-row', 'dsh-hub-update-command'])
    expect(classesOf(row())).toEqual(['dsh-hub-update-state', 'dsh-hub-update-button'])
    // The command keeps the properties that make it copyable and wrappable.
    const code = container.querySelector('.dsh-hub-update-command')!
    expect(code.tagName).toBe('CODE')
    expect(code.textContent).not.toBe('')
  })

  it('keeps the icon last when the status line is an error', async () => {
    mockHost({
      check: checkDto(),
      apply: { ok: false, error: { code: 'install-failed', message: 'pnpm: ENOSPC' } },
    })
    await render()
    await clickButton()
    await clickButton()
    // The error is a sibling before the icon, not a line under it.
    expect(classesOf(row())).toEqual(['dsh-hub-update-state', 'dsh-hub-update-state', 'dsh-hub-update-button'])
    expect(row().lastElementChild?.className).toBe('dsh-hub-update-button')
    // …and it is still the red one.
    expect(container.querySelectorAll('.dsh-hub-note-danger')).toHaveLength(1)
  })

  it('reports the newest version when one click can install it', async () => {
    const calls = mockHost({ check: checkDto() })
    await render()
    await clickButton()
    expect(calls).toEqual([{ url: '/api/dsh-chatgpt-subscription/update/check', method: 'GET' }])
    // The button offers the specific version rather than a generic "update".
    expect(name()).toBe('更新到 v0.99.0')
    expect(status()).toContain('0.99.0')
    expect(status()).toContain('0.34.0')
    expect(command()).toBe('')
  })

  it('reports "up to date" and keeps offering a re-check', async () => {
    mockHost({ check: checkDto({ latest: '0.34.0', updateAvailable: false, canApply: false }) })
    await render()
    await clickButton()
    expect(name()).toBe(zh.hubUpdateCheck)
    expect(status()).toBe('已是最新版本 0.34.0')
  })

  it('offers only the command on a local development link', async () => {
    mockHost({ check: checkDto({ installKind: 'link', canApply: false, reason: 'development-install' }) })
    await render()
    await clickButton()
    // No auto-update button: the offer would replace the linked checkout.
    expect(name()).toBe(zh.hubUpdateCheck)
    expect(status()).toBe('有新版本 0.99.0；当前是本地链接安装，无法自动更新')
    expect(command()).toBe('dsh plugin add @eddyskywalker/dsh-chatgpt-subscription@latest')
    // The command is a read-only element the user can select, not a button.
    expect(container.querySelector('.dsh-hub-update-command')?.tagName).toBe('CODE')
  })

  it('offers only the command when the Host has no plugin manager', async () => {
    mockHost({ check: checkDto({ canApply: false, reason: 'plugin-manager-missing' }) })
    await render()
    await clickButton()
    expect(name()).toBe(zh.hubUpdateCheck)
    expect(status()).toBe('有新版本 0.99.0；宿主未提供 pluginManager，无法自动更新')
    expect(command()).not.toBe('')
  })

  it('reports a failed check in place, without the command', async () => {
    mockHost({ check: checkDto({ latest: null, updateAvailable: false, canApply: false, reason: 'registry-unreachable' }) })
    await render()
    await clickButton()
    expect(status()).toBe(zh.hubUpdateCheckFailed)
    // The failure line is the danger color, in the same small line.
    expect(container.querySelector('.dsh-hub-update-state')?.className).toContain('dsh-hub-note-danger')
    expect(command()).toBe('')
  })

  it('shows the running version is unknown rather than claiming up to date', async () => {
    mockHost({ check: checkDto({ current: null, latest: '0.99.0', updateAvailable: false, canApply: false }) })
    await render()
    await clickButton()
    expect(status()).toBe('最新版本 0.99.0，当前版本未知')
  })

  it('installs the update and says a restart is needed', async () => {
    const calls = mockHost({ check: checkDto() })
    await render()
    await clickButton()
    await clickButton()
    const post = calls.find((call) => call.method === 'POST')
    expect(post?.url).toBe('/api/dsh-chatgpt-subscription/update/apply')
    expect(status()).toBe('已安装 v0.35.0，重启宿主后生效')
    // The offer is gone once the install settled.
    expect(name()).toBe(zh.hubUpdateCheck)
    expect(container.querySelector('.dsh-hub-update-dot')).toBeNull()
  })

  it('says a restart is unnecessary when the Host applied the update live', async () => {
    mockHost({
      check: checkDto(),
      apply: { ok: true, value: { installed: '0.35.0', restartRequired: false, removedFirst: false } },
    })
    await render()
    await clickButton()
    await clickButton()
    expect(status()).toBe('已安装 v0.35.0，当前已生效，无需重启')
    expect(container.querySelector('.dsh-hub-update-state')?.className).not.toContain('dsh-hub-note-danger')
  })

  it('says the installed copy was removed first when the update took that path', async () => {
    mockHost({
      check: checkDto(),
      apply: { ok: true, value: { installed: '0.35.0', restartRequired: true, removedFirst: true } },
    })
    await render()
    await clickButton()
    await clickButton()
    // Naming the removal is honest: the plugin was briefly uninstalled.
    expect(status()).toBe('已移除旧版并安装 v0.35.0，重启宿主后生效')
  })

  it('shows a failed update that was rolled back, in red, with both facts', async () => {
    mockHost({
      check: checkDto(),
      apply: {
        ok: false,
        error: {
          code: 'install-failed',
          message: 'pnpm: ENOSPC The installed copy had already been removed…',
          rollback: 'restored',
          restoredVersion: '0.34.0',
        },
      },
    })
    await render()
    await clickButton()
    await clickButton()
    const alert = container.querySelector('[role="alert"]')
    // The red line says the update failed AND which version is running again.
    expect(alert?.textContent).toContain('更新失败，已恢复 v0.34.0')
    expect(alert?.textContent).toContain('pnpm: ENOSPC')
    expect(alert?.className).toContain('dsh-hub-note-danger')
  })

  it('warns that the plugin may be gone when the rollback failed too', async () => {
    const recovery = 'dsh plugin add @eddyskywalker/dsh-chatgpt-subscription@0.34.0'
    mockHost({
      check: checkDto(),
      apply: {
        ok: false,
        error: {
          code: 'install-failed',
          message: `pnpm: ENOSPC Putting 0.34.0 back failed as well (pnpm: E404), so the plugin is most likely no longer installed. Reinstall it by hand with ${recovery} and restart the Host.`,
          rollback: 'failed',
        },
      },
    })
    await render()
    await clickButton()
    await clickButton()
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain(zh.hubUpdateFailedRollbackFailed)
    // The manual recovery command reaches the user verbatim.
    expect(alert?.textContent).toContain(recovery)
    expect(alert?.className).toContain('dsh-hub-note-danger')
    // The offer stays: retrying is still possible once the Host is fixed.
    expect(name()).toBe('更新到 v0.99.0')
  })

  it('shows a refused install in place, keeping the offer', async () => {
    mockHost({
      check: checkDto(),
      apply: { ok: false, error: { code: 'install-failed', message: 'pnpm: ENOSPC' } },
    })
    await render()
    await clickButton()
    await clickButton()
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('pnpm: ENOSPC')
    expect(alert?.className).toContain('dsh-hub-note-danger')
    // Back to the offer: the user can retry without another check.
    expect(name()).toBe('更新到 v0.99.0')
    expect(button().disabled).toBe(false)
  })

  it('disables and spins the icon while a request is in flight', async () => {
    let release: (value: Response) => void = () => undefined
    globalThis.fetch = vi.fn(async () => await new Promise<Response>((resolve) => { release = resolve })) as typeof fetch
    await render()
    await act(async () => button().click())
    expect(button().disabled).toBe(true)
    // The wait is shown by the ring turning, not by the control changing size.
    expect(button().className).toContain('dsh-hub-update-busy')
    expect(name()).toBe(zh.hubUpdateChecking)
    await act(async () => {
      release(Response.json({ ok: true, value: checkDto({ updateAvailable: false, latest: '0.34.0', canApply: false }) }))
      await Promise.resolve()
    })
    expect(button().disabled).toBe(false)
    // The rotation class goes away with the request.
    expect(button().className).not.toContain('dsh-hub-update-busy')
  })
})

describe('where the control lives', () => {
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

  it('leaves the overview with just its hint paragraph', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: { providers: [] } })) as typeof fetch
    await act(async () => root.render(createElement(HubOverview, { t, onOpen: () => undefined } as never)))
    expect(container.querySelector('.dsh-hub-hint')?.textContent).toBe(zh.hubOverviewHint)
    // The control belongs to the section header, not to the list of cards.
    expect(container.querySelector('.dsh-hub-update')).toBeNull()
    expect(container.querySelector('.dsh-hub-hintrow')).toBeNull()
  })

  it('puts the section title and the control in one header row', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: { providers: [] } })) as typeof fetch
    sessionStorage.removeItem('dsh-chatgpt-subscription:hub-view')
    await act(async () => root.render(createElement(ProviderHubSection, { t, close: () => undefined } as never)))
    const header = container.querySelector('.dsh-codex-page > header')!
    expect(header.className).toContain('dsh-hub-head')
    expect(header.querySelector('#dsh-hub-title')?.textContent).toBe(zh.hubTitle)
    // The control is the header's last child: the right-hand side, where the
    // icon holds still.
    expect(header.lastElementChild?.className).toBe('dsh-hub-update')
    expect(header.lastElementChild?.querySelector('.dsh-hub-update-button')).not.toBeNull()
    // …and the overview below it is still the plain hint plus the cards.
    expect(container.querySelector('.dsh-hub-hint')?.textContent).toBe(zh.hubOverviewHint)
  })
})
