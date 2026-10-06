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
import type { OllamaWebStatus } from '../src/shared/ollama-contracts.ts'

// Typed as the status the host actually sends, so a fixture cannot quietly
// omit a field the card depends on.
const STATUS: OllamaWebStatus = {
  pool: {
    accounts: [
      { id: 'a1', alias: '主号', isPrimary: true, lastUsedAt: Date.now() - 1000 },
      { id: 'a2', alias: '备用号', isPrimary: false, cooldownUntil: Date.now() + 600_000, cooldownReason: '429' },
    ],
    activeAccountId: 'a1',
    rotationStrategy: 'round-robin',
  },
  models: [{ id: 'gpt-oss:120b-cloud' }, { id: 'gemma4:31b' }],
  enabledModelIds: [],
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

async function renderWith(
  overrides: Partial<OllamaWebStatus> = {},
): Promise<HTMLDivElement> {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    ok: true,
    value: { ...STATUS, ...overrides },
  })))
  const root = createRoot(container as HTMLDivElement)
  await act(async () => {
    root.render(<OllamaSection />)
  })
  return container as HTMLDivElement
}

async function render(): Promise<HTMLDivElement> {
  return renderWith()
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

  it('tells the user to sync before the model list can be anything', async () => {
    const el = await renderWith({ models: [], catalogSynced: false, usable: false })
    // A first-time user has no key and no synced list, so the model block is
    // empty. Saying only 'not synced' left the tab looking broken with no hint
    // that the button above it is the next step.
    expect(el.textContent).toContain(zh.catalogNeverSynced)
    expect(el.textContent).toContain('同步模型列表')
    // No key means no sync is possible, and that is said rather than left to be
    // discovered by pressing the button and getting an error back.
    expect(el.textContent).toContain(zh.catalogNeedKey)
  })

  it('offers a checkbox per model, so the line can be switched off', async () => {
    const el = await render()
    // Every other line lets the user turn its models off; without this the
    // Ollama models always appear in the picker with no way to hide them.
    const boxes = el.querySelectorAll('.dsh-mcl-option[role="checkbox"]')
    expect(boxes).toHaveLength(2)
    // ...and the two bulk controls its siblings ship.
    expect(el.textContent).toContain(zh.selectAll)
    expect(el.textContent).toContain(zh.unselectAll)
  })

  it('shows each key own consumption, not a shared pool total', async () => {
    const el = await renderWith({
      pool: {
        ...STATUS.pool,
        accounts: [
          { id: 'a1', alias: '主号', isPrimary: true, usage: { inputTokens: 1500, outputTokens: 250, requestCount: 4 } },
          { id: 'a2', alias: '备用号', isPrimary: false },
        ],
      },
    })
    // A pool total would be wrong twice over: it hides which key is actually
    // being used, and it reads like a quota the service does not publish.
    expect(el.textContent).toContain('1.5K')
    // The key that has served nothing says so rather than showing a zero.
    expect(el.textContent).toContain(zh.usageNone)
  })

  it('reports the synced model count rather than an empty state', async () => {
    const el = await render()
    expect(el.textContent).toContain('2')
    expect(el.textContent).not.toContain(zh.catalogNeverSynced)
  })

  /**
   * Issue #36, seen from where the user saw it.
   *
   * The web server answers a route handler that rejected with a bare 400 and NO
   * body. The card used to hand that straight to response.json(), so the browser
   * raised its own "Failed to execute 'json' on 'Response': Unexpected end of
   * JSON input" and that sentence — naming neither the status nor the request —
   * became the error the user was left with.
   */
  describe('a sync the card cannot read', () => {
    async function syncWith(reply: () => Response): Promise<string> {
      const el = await render()
      vi.stubGlobal('fetch', vi.fn(reply))
      const button = Array.from(el.querySelectorAll('button'))
        .find(node => node.textContent?.includes(zh.catalogSync))
      expect(button, 'the sync button is on the tab').not.toBeUndefined()
      await act(async () => {
        button?.click()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      return el.textContent ?? ''
    }

    it('names the status when the answer has no body', async () => {
      const text = await syncWith(() => new Response('', { status: 400 }))

      expect(text).toContain(zh.error.split('{detail}')[0]!)
      expect(text).toContain('400')
      expect(text).not.toContain('Unexpected end of JSON input')
    })

    it('names the content type when the answer is not JSON', async () => {
      const text = await syncWith(() => new Response('<html>Sign in</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }))

      expect(text).toContain('text/html')
      expect(text).not.toContain('Unexpected token')
    })
  })
})