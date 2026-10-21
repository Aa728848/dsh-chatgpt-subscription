// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { UpdateCheck } from '../src/client/hub/UpdateCheck.tsx'
import { HubOverview } from '../src/client/hub/HubOverview.tsx'
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
  const status = (): string => container.querySelector('.dsh-hub-update-state')?.textContent ?? ''
  const command = (): string => container.querySelector('.dsh-hub-update-command')?.textContent ?? ''

  async function clickButton(): Promise<void> {
    await act(async () => button().click())
    // Let the awaited fetch settle inside the same act boundary.
    await act(async () => { await Promise.resolve() })
  }

  it('asks nothing until the button is clicked', async () => {
    const calls = mockHost({ check: checkDto() })
    await render()
    expect(calls).toEqual([])
    expect(button().textContent).toBe(zh.hubUpdateCheck)
    expect(button().disabled).toBe(false)
    // No status line before an answer: there is nothing true to say yet.
    expect(status()).toBe('')
  })

  it('reports the newest version when one click can install it', async () => {
    const calls = mockHost({ check: checkDto() })
    await render()
    await clickButton()
    expect(calls).toEqual([{ url: '/api/dsh-chatgpt-subscription/update/check', method: 'GET' }])
    // The button offers the specific version rather than a generic "update".
    expect(button().textContent).toBe('更新到 v0.99.0')
    expect(status()).toContain('0.99.0')
    expect(status()).toContain('0.34.0')
    expect(command()).toBe('')
  })

  it('reports "up to date" and keeps offering a re-check', async () => {
    mockHost({ check: checkDto({ latest: '0.34.0', updateAvailable: false, canApply: false }) })
    await render()
    await clickButton()
    expect(button().textContent).toBe(zh.hubUpdateCheck)
    expect(status()).toBe('已是最新版本 0.34.0')
  })

  it('offers only the command on a local development link', async () => {
    mockHost({ check: checkDto({ installKind: 'link', canApply: false, reason: 'development-install' }) })
    await render()
    await clickButton()
    // No auto-update button: the offer would replace the linked checkout.
    expect(button().textContent).toBe(zh.hubUpdateCheck)
    expect(status()).toBe('有新版本 0.99.0；当前是本地链接安装，无法自动更新')
    expect(command()).toBe('dsh plugin add @eddyskywalker/dsh-chatgpt-subscription@latest')
    // The command is a read-only element the user can select, not a button.
    expect(container.querySelector('.dsh-hub-update-command')?.tagName).toBe('CODE')
  })

  it('offers only the command when the Host has no plugin manager', async () => {
    mockHost({ check: checkDto({ canApply: false, reason: 'plugin-manager-missing' }) })
    await render()
    await clickButton()
    expect(button().textContent).toBe(zh.hubUpdateCheck)
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
    expect(button().textContent).toBe(zh.hubUpdateCheck)
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
    expect(button().textContent).toBe('更新到 v0.99.0')
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
    expect(button().textContent).toBe('更新到 v0.99.0')
    expect(button().disabled).toBe(false)
  })

  it('disables the button while a request is in flight', async () => {
    let release: (value: Response) => void = () => undefined
    globalThis.fetch = vi.fn(async () => await new Promise<Response>((resolve) => { release = resolve })) as typeof fetch
    await render()
    await act(async () => button().click())
    expect(button().disabled).toBe(true)
    expect(button().textContent).toBe(zh.hubUpdateChecking)
    await act(async () => {
      release(Response.json({ ok: true, value: checkDto({ updateAvailable: false, latest: '0.34.0', canApply: false }) }))
      await Promise.resolve()
    })
    expect(button().disabled).toBe(false)
  })
})

describe('the overview hint row', () => {
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

  it('keeps the hint text and puts the update control in the same row', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: { providers: [] } })) as typeof fetch
    await act(async () => root.render(createElement(HubOverview, { t, onOpen: () => undefined } as never)))
    const row = container.querySelector('.dsh-hub-hintrow')!
    expect(row.querySelector('.dsh-hub-hint')?.textContent).toBe(zh.hubOverviewHint)
    expect(row.querySelector('.dsh-hub-update-button')).not.toBeNull()
    // The control is the row's last child: right-hand side, as designed.
    expect(row.lastElementChild?.className).toBe('dsh-hub-update')
  })
})
