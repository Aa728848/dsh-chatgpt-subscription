// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { AdvisorEffortTrigger, AdvisorModelPane, AdvisorModelTrigger, type AdvisorApi } from '../../src/client/features/advisor/AdvisorModelOption.tsx'
import type { AdvisorRoute, AdvisorStateDto } from '../../src/shared/advisor-contracts.ts'

const t = (key: string) => key
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); document.getElementById('dshadv-model-popover')?.remove() })

function state(): AdvisorStateDto {
  return {
    sessionId: 's1', enabled: false, selection: null, defaultEnabled: false, defaultSelection: null,
    limits: { maxTokens: 4096, timeoutMs: 300000, maxRetries: 1, contextTokenBudget: 100000 },
  }
}
function directory(): { subscribe: (cb: () => void) => () => void; getSnapshot: () => ModelDirectoryState } {
  const value: ModelDirectoryState = {
    current: null, routable: null, groups: [{ id: 'kimi-code', name: 'Kimi Code', models: [{
      id: 'k3', name: 'K3', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] },
    }] }], failures: [], status: 'ready', pending: null, error: null,
  }
  const listeners = new Set<() => void>()
  return {
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    getSnapshot: () => value,
  }
}

describe('Advisor composer entry', () => {
  it('opens its own popover and toggles the current conversation', async () => {
    const current = state()
    const write = vi.fn(async (_session: string, patch: { enabled?: boolean }) => ({ ...current, ...patch }))
    const api: AdvisorApi = { read: async () => current, write }
    await act(async () => {
      root.render(<AdvisorModelTrigger sessionId="s1" directory={directory()} load={vi.fn()} locked={false} reportFailure={vi.fn()} t={t} api={api} />)
    })
    const trigger = container.querySelector<HTMLButtonElement>('.dshadv-trigger, .dshadv-effort-trigger')!
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { trigger.click() })
    expect(document.getElementById('dshadv-model-popover')).not.toBeNull()
    const toggle = document.querySelector<HTMLButtonElement>('#dshadv-model-popover [role=switch]')!
    await act(async () => { toggle.click() })
    expect(write).toHaveBeenCalledWith('s1', { enabled: true })
  })

  it('selects an advisor route without touching the main model selector', async () => {
    const current = state()
    const write = vi.fn(async (_session: string, patch: { selection?: AdvisorRoute }) => ({ ...current, selection: patch.selection ?? null }))
    const api: AdvisorApi = { read: async () => current, write: write as AdvisorApi['write'] }
    await act(async () => {
      root.render(<AdvisorModelPane sessionId="s1" directory={directory()} load={vi.fn()} locked={false} reportFailure={vi.fn()} t={t} api={api} />)
    })
    const choice = container.querySelector<HTMLButtonElement>('[role=menuitemradio]')!
    await act(async () => { choice.click() })
    expect(write).toHaveBeenCalledWith('s1', { selection: { provider: 'kimi-code', model: 'k3', reasoningEffort: 'high' } })
  })

  it('renders no visible privacy paragraph and no native select', async () => {
    const current = state()
    const api: AdvisorApi = { read: async () => current, write: vi.fn(async () => current) }
    await act(async () => {
      root.render(<AdvisorModelTrigger sessionId="s1" directory={directory()} load={vi.fn()} locked={false} reportFailure={vi.fn()} t={t} api={api} />)
    })
    expect(container.textContent).not.toContain('privacy')
    expect(container.querySelector('select')).toBeNull()
  })

  it('closes on Escape', async () => {
    const current = state()
    const api: AdvisorApi = { read: async () => current, write: vi.fn(async () => current) }
    await act(async () => {
      root.render(<AdvisorModelTrigger sessionId="s1" directory={directory()} load={vi.fn()} locked={false} reportFailure={vi.fn()} t={t} api={api} />)
    })
    await act(async () => { container.querySelector<HTMLButtonElement>('.dshadv-trigger')!.click() })
    expect(document.getElementById('dshadv-model-popover')).not.toBeNull()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.getElementById('dshadv-model-popover')).toBeNull()
  })

  it('exposes reasoning as its own seat, separate from the model seat', async () => {
    const current: AdvisorStateDto = { ...state(), enabled: true, selection: { provider: 'kimi-code', model: 'k3', reasoningEffort: 'high' } }
    const write = vi.fn(async (_session: string, patch: { selection?: AdvisorRoute }) => ({ ...current, selection: patch.selection ?? null }))
    const api: AdvisorApi = { read: async () => current, write: write as AdvisorApi['write'] }
    await act(async () => {
      root.render(<AdvisorEffortTrigger sessionId="s1" directory={directory()} load={vi.fn()} locked={false} reportFailure={vi.fn()} t={t} api={api} />)
    })
    const trigger = container.querySelector<HTMLButtonElement>('.dshadv-effort-trigger')!
    expect(trigger.textContent).toBe('High')
    expect(container.querySelector('.dshadv-trigger')).toBeNull()
    await act(async () => { trigger.click() })
    const slider = document.querySelector<HTMLElement>('#dshadv-effort-popover [role=slider]')!
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    await act(async () => { slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(write).toHaveBeenCalledWith('s1', { selection: { provider: 'kimi-code', model: 'k3', reasoningEffort: 'max' } })
  })
})