// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { CODEX_IMAGE_TOOL_NAME } from '../src/compat.ts'
import { storageLabel, storageNotice } from '../src/client/CodexSubscriptionSection.tsx'
import { apply } from '../src/client/index.tsx'
import { zh } from '../src/client/locales.ts'

describe('client registration', () => {
  it('presents the actual Host credential storage security boundary', () => {
    const t = ((key: keyof typeof zh) => zh[key]) as never
    const linux = { kind: 'linux-file', encrypted: false, available: true } as const
    const windows = { kind: 'windows-dpapi', encrypted: true, available: true } as const

    expect(storageLabel(linux, t)).toContain('0600')
    expect(storageNotice(linux, t)).toContain('不会额外加密')
    expect(storageLabel(windows, t)).toContain('DPAPI')
    expect(storageNotice({ ...linux, available: false }, t)).toContain('无法安全访问')
  })
  it('contributes one top-level Codex subscription settings section', () => {
    const injectedSlots: string[] = []
    const registrations: Array<Record<string, unknown>> = []
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
          injectedSlots.push(name)
          disposers.push(callback())
        },
        register(options: Record<string, unknown>) {
          registrations.push(options)
          return () => undefined
        },
      },
    }

    apply(ctx as never)

    expect(injectedSlots).toEqual(['settings.section', 'conversation.input.right', 'tool.call.toolview'])
    expect(registrations.find((registration) => registration.name === 'settings.section')).toMatchObject({
      name: 'settings.section',
      id: 'codex-subscription',
      label: 'Codex 订阅',
    })
    expect(registrations.find((registration) => registration.name === 'tool.call.toolview')).toMatchObject({
      key: CODEX_IMAGE_TOOL_NAME,
    })
    expect(document.querySelector('style[data-plugin="@eddyskywalker/dsh-chatgpt-subscription"]')).not.toBeNull()
    for (const dispose of disposers.reverse()) dispose()
  })
})
