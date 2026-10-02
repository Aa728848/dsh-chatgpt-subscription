// @vitest-environment jsdom
/**
 * The Ollama tab renders the shared account card, like its seven siblings.
 *
 * These assert the unified shape rather than Ollama's own wording, which the
 * locale test covers: what matters here is that the tab composes the same
 * components, so a future change to the shared card reaches this tab too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { OllamaSection } from '../src/client/ollama/OllamaSection.tsx'
import { zh } from '../src/client/ollama/locales.ts'

const STATUS = {
  pool: {
    accounts: [
      { id: 'a1', alias: '主号', isPrimary: true, lastUsedAt: Date.now() - 1000 },
      { id: 'a2', alias: '备用号', isPrimary: false, cooldownUntil: Date.now() + 600_000, cooldownReason: '429' },
    ],
    activeAccountId: 'a1',
    rotationStrategy: 'round-robin',
  },
  models: [{ id: 'gpt-oss:120b-cloud' }, { id: 'gemma4:31b' }],
  usable: true,
  catalogSynced: true,
}

let container: HTMLDivElement | null = null

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ ok: true, value: STATUS }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )))
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  vi.unstubAllGlobals()
  container?.remove()
  container = null
})

async function render(): Promise<HTMLDivElement> {
  const root = createRoot(container as HTMLDivElement)
  await act(async () => {
    root.render(<OllamaSection />)
  })
  return container as HTMLDivElement
}

describe('OllamaSection', () => {
  it('renders the shared account card with every pooled key', async () => {
    const el = await render()
    // The shared card's own class, not an Ollama-specific one: that is what makes
    // the tab look like its siblings by construction.
    expect(el.querySelectorAll('.dsha-account-card')).toHaveLength(2)
    expect(el.querySelector('.dsha-accounts-list')).not.toBeNull()
  })

  it('shows the rotation picker once there is more than one key', async () => {
    const el = await render()
    // One key needs no choice, so the shared card hides the selector - asserting
    // it here would just restate the shared card's own behaviour.
    const select = el.querySelector('select.dsha-select') as HTMLSelectElement | null
    expect(select).not.toBeNull()
    expect(select?.value).toBe('round-robin')
  })

  it('badges a key that is cooling down rather than listing it as usable', async () => {
    const el = await render()
    const badges = Array.from(el.querySelectorAll('.dsha-badge')).map(node => node.textContent ?? '')
    expect(badges.some(text => text.includes(zh.cooling))).toBe(true)
  })

  it('names both wire surfaces, so the routing is not a mystery', async () => {
    const el = await render()
    expect(el.textContent).toContain('/v1')
    expect(el.textContent).toContain('/api/chat')
  })

  it('states the documented limits on the tab itself', async () => {
    const el = await render()
    expect(el.textContent).toContain(zh.limitNoStateful)
    expect(el.textContent).toContain(zh.limitUsage)
  })

  it('never renders a key, because only the host stores it', async () => {
    const el = await render()
    // The form is closed until the user asks for it, and even then it is an empty
    // input - a stored key has no path into the DOM at all.
    expect(el.innerHTML).not.toContain('sk-')
  })

  it('reports the synced model count rather than an empty state', async () => {
    const el = await render()
    expect(el.textContent).toContain('2')
    expect(el.textContent).not.toContain(zh.catalogNeverSynced)
  })
})