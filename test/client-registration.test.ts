// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.tsx'

describe('client registration', () => {
  it('contributes one top-level Codex subscription settings section', () => {
    let injectedSlot = ''
    let registration: Record<string, unknown> | null = null
    const disposers: Array<() => void> = []
    const ctx = {
      effect(factory: () => void | (() => void)) {
        const dispose = factory()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      locale: {
        register() { return () => undefined },
      },
      slots: {
        inject(name: string, callback: () => () => void) {
          injectedSlot = name
          disposers.push(callback())
        },
        register(options: Record<string, unknown>) {
          registration = options
          return () => undefined
        },
      },
    }

    apply(ctx as never)

    expect(injectedSlot).toBe('settings.section')
    expect(registration).toMatchObject({
      name: 'settings.section',
      id: 'codex-subscription',
      label: 'Codex 订阅',
    })
    expect(document.querySelector('style[data-plugin="@eddyskywalker/dsh-chatgpt-subscription"]')).not.toBeNull()
    for (const dispose of disposers.reverse()) dispose()
  })
})
