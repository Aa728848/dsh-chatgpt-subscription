// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { OpenCodeGoSection } from '../../../src/client/providers/opencode-go/OpenCodeGoSection.tsx'
import { selectOpenCodeGoBadgeFacts } from '../../../src/client/providers/opencode-go/OpenCodeGoComposerQuota.tsx'
import { webStatus } from './helpers.ts'

describe('OpenCodeGoSection', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, value: webStatus() }), { status: 200, headers: { 'content-type': 'application/json' } })))
  })
  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
    vi.unstubAllGlobals()
  })

  it('renders the shared Kimi account shell and indexed OPENCODE letters', async () => {
    await act(async () => { root.render(<OpenCodeGoSection />); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(container.querySelectorAll('.dsha-account-card--kimi')).toHaveLength(1)
    const letters = [...container.querySelectorAll('.dshoc-art text')]
    expect(letters.map(node => node.textContent).join('')).toBe('OPENCODE')
    expect(letters.map(node => (node as HTMLElement).style.getPropertyValue('--i'))).toEqual(['0', '1', '2', '3', '4', '5', '6', '7'])
    expect(container.querySelector('.dshoc-apikey')).toBeNull()
    expect(document.body.innerHTML).not.toContain('oc_sk_test')
  })

  it('updates only the active vendor group using the original OpenCode model ids', async () => {
    const status = webStatus()
    const model = status.models[0]!
    status.models = [
      model,
      { ...model, id: 'v4-pro', canonicalId: 'deepseek/deepseek-v4-pro', enabled: false },
      ...Array.from({ length: 8 }, (_, index) => ({
        ...model, id: `qwen-${index}`, canonicalId: `qwen/qwen-${index}`, enabled: index === 0,
      })),
    ]
    status.catalogCount = status.models.length
    const savedSelections: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        const { enabledModelIds } = JSON.parse(init.body) as { enabledModelIds?: string[] }
        if (enabledModelIds !== undefined) {
          savedSelections.push(enabledModelIds)
          status.models = status.models.map(item => ({ ...item, enabled: enabledModelIds.includes(item.id) }))
        }
      }
      return new Response(JSON.stringify({ ok: true, value: status }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    await act(async () => { root.render(<OpenCodeGoSection />); await new Promise(resolve => setTimeout(resolve, 0)) })
    const vendor = container.querySelector<HTMLButtonElement>('[data-vendor="deepseek"]')!
    await act(async () => vendor.click())
    const groupActions = () => container.querySelectorAll<HTMLButtonElement>('.dsh-mcl-pane-head .dsh-mcl-action')
    expect(groupActions()).toHaveLength(2)
    await act(async () => groupActions()[0]!.click())
    await act(async () => groupActions()[1]!.click())
    expect(savedSelections).toEqual([['deepseek-v4.1-flash', 'qwen-0', 'v4-pro'], ['qwen-0']])
  })

  it('opens the password-only API Key form and selects the shortest-window badge', async () => {
    await act(async () => { root.render(<OpenCodeGoSection />); await new Promise(resolve => setTimeout(resolve, 0)) })
    const login = container.querySelector('button[aria-expanded]') as HTMLButtonElement
    await act(async () => { login.click() })
    const input = container.querySelector('input[type=password]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.value).toBe('')
    expect(selectOpenCodeGoBadgeFacts(webStatus())).toMatchObject({ text: '88%' })
  })
})
