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
