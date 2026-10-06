// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../src/client/common/ComposerQuotaBadge.tsx'

interface Status { authenticated: boolean; left: number }

const facts = (status: Status | null): ComposerQuotaFacts | null => status === null
  ? null
  : { text: `${status.left}%`, tooltip: `left ${status.left}%`, level: quotaLevel(status.left) }

function directory(provider: string | undefined) {
  const state = { current: { provider, model: 'm' }, models: [] }
  return { subscribe: () => () => undefined, getSnapshot: () => state }
}

describe('ComposerQuotaBadge', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  function mount(props: Partial<Parameters<typeof ComposerQuotaBadge<Status>>[0]> = {}) {
    const readStatus = vi.fn(async () => ({ authenticated: true, left: 42 }))
    const render = (overrides: Record<string, unknown> = {}) => root.render(createElement(ComposerQuotaBadge<Status>, {
      directory: directory('line-a') as never,
      loadModelDirectory: () => undefined,
      providerId: 'line-a',
      readStatus,
      selectFacts: facts,
      label: 'Quota',
      ...props,
      ...overrides,
    } as never))
    return { readStatus, render }
  }

  it('shows the line its own number, under the label it was given', async () => {
    const { render } = mount()
    await act(async () => render())
    expect(container.querySelector('.dsha-composer-quota-val')?.textContent).toBe('42%')
    expect(container.querySelector('.dsha-composer-quota-label')?.textContent).toBe('Quota')
    expect(container.querySelector('.dsha-composer-quota')?.getAttribute('data-level')).toBe('normal')
  })

  it('is inert — and silent — while the conversation is on another provider', async () => {
    const { readStatus, render } = mount({ directory: directory('line-b') as never })
    await act(async () => render())
    expect(container.querySelector('.dsha-composer-quota')).toBeNull()
    expect(readStatus).not.toHaveBeenCalled()
  })

  it('hides itself for a signed-out line', async () => {
    const { render } = mount({ readStatus: async () => ({ authenticated: false, left: 42 }) })
    await act(async () => render())
    expect(container.querySelector('.dsha-composer-quota')).toBeNull()
  })

  it('asks for the forced read on a click, and the plain one otherwise', async () => {
    const { readStatus, render } = mount()
    await act(async () => render())
    expect(readStatus).toHaveBeenLastCalledWith(false)
    await act(async () => container.querySelector('.dsha-composer-quota')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(readStatus).toHaveBeenLastCalledWith(true)
  })

  it('does not restart its poll when the caller re-renders with fresh callbacks', async () => {
    // The copies took these callbacks as effect dependencies, so a caller that
    // wrote them inline refetched on every render — once a second, in a card
    // that re-renders on model-directory churn.
    const { readStatus, render } = mount()
    await act(async () => render())
    expect(readStatus).toHaveBeenCalledTimes(1)
    await act(async () => render({ readStatus: async () => ({ authenticated: true, left: 7 }) }))
    await act(async () => render({ readStatus: async () => ({ authenticated: true, left: 8 }) }))
    expect(readStatus).toHaveBeenCalledTimes(1)
  })
})
