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
import { OLLAMA_REASONING_EFFORTS, type OllamaWebStatus } from '../src/shared/ollama-contracts.ts'

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
  enabledModelIds: null,
  usable: true,
  catalogSynced: true,
  defaultReasoningEffort: null,
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

  it('keeps every model unchecked after clear-all, instead of snapping back', async () => {
    // Empty used to mean 'no filter': clear-all wrote [] and the card read it
    // back as all-checked, so a long list could never be narrowed.
    const el = await render()
    let posted: unknown = null
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      // The write is the only call to '/models'; the status re-read behind it
      // is a GET to '/status' and must not overwrite what the test captured.
      if (String(url).endsWith('/models')) {
        posted = JSON.parse(String(init?.body ?? 'null'))
        return Response.json({ ok: true, value: { enabledModelIds: (posted as { enabledModelIds?: unknown })?.enabledModelIds ?? null } })
      }
      return Response.json({ ok: true, value: STATUS })
    }))

    const clearAll = Array.from(el.querySelectorAll('button'))
      .find(node => node.textContent === zh.unselectAll)
    expect(clearAll, 'the clear-all button is on the list').not.toBeUndefined()
    await act(async () => {
      clearAll?.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(posted).toEqual({ enabledModelIds: [] })
    const boxes = Array.from(el.querySelectorAll('.dsh-mcl-option[role="checkbox"]'))
    expect(boxes.length).toBeGreaterThan(0)
    expect(boxes.every(node => node.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(el.textContent).toContain('0/2')
  })

  it('stores a fully-checked list as no filter again, not as an explicit list', async () => {
    // Checking every box by hand must collapse back to null: an explicit
    // all-ids list would hide any model the service adds tomorrow.
    const el = await render()
    const posts: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      // Only the '/models' write is a post; the status re-read behind it is a
      // GET and would otherwise be captured as an empty-bodied "post".
      if (String(url).endsWith('/models')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { enabledModelIds?: unknown }
        posts.push(body)
        return Response.json({ ok: true, value: { enabledModelIds: body.enabledModelIds ?? null } })
      }
      return Response.json({ ok: true, value: STATUS })
    }))

    const gemma = Array.from(el.querySelectorAll('.dsh-mcl-option'))
      .find(node => node.textContent?.includes('gemma4:31b')) as HTMLElement | undefined
    expect(gemma, 'the gemma row is on the list').not.toBeUndefined()
    await act(async () => {
      gemma?.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await act(async () => {
      gemma?.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(posts).toEqual([{ enabledModelIds: ['gpt-oss:120b-cloud'] }, { enabledModelIds: null }])
  })

  it('keeps rendering when an action answer is not the full status', async () => {
    // The host once answered 'add' with a bare '{id}'. The card stored it as
    // its status and the next render crashed on 'status.models.length' — the
    // whole settings page went blank. A partial payload now degrades to empty
    // blocks instead of taking the page down.
    const el = await render()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, value: { id: 'a3' } })))

    const openForm = Array.from(el.querySelectorAll('button'))
      .find(node => node.textContent === zh.addAccount)
    expect(openForm, 'the add-account button is on the tab').not.toBeUndefined()
    await act(async () => {
      openForm?.click()
    })

    const input = el.querySelector('#ollama-key') as HTMLInputElement | null
    expect(input, 'the key input opened with the form').not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, 'sk-live')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const save = Array.from(el.querySelectorAll('button'))
      .find(node => node.textContent === zh.keySave)
    expect(save, 'the save button is on the form').not.toBeUndefined()
    await act(async () => {
      save?.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    // The malformed reply was stored as the status, and the tab still draws.
    expect(el.textContent).toContain(zh.title)
    expect(el.textContent).toContain(zh.catalogNeverSynced)
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
  // -------------------------------------------------------------------------
  // The default thinking level
  // -------------------------------------------------------------------------

  describe('the default thinking level', () => {
    /** The dropdown, found by the label the card gives it. */
    function effortSelect(el: HTMLElement): HTMLSelectElement {
      const select = el.querySelector('select[aria-label="' + zh.defaultReasoningEffort + '"]')
      return select as HTMLSelectElement
    }

    /** Change the dropdown the way a click does, past React's value tracker. */
    async function choose(select: HTMLSelectElement, value: string): Promise<void> {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
      await act(async () => {
        setter?.call(select, value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }

    it('offers every level the line knows, plus a way to un-choose one', async () => {
      const el = await render()
      const select = effortSelect(el)
      expect(select, 'the thinking-level dropdown is on the tab').not.toBeNull()
      // The empty first option is the card's "not specified", which is null on
      // the wire — the host has to be able to tell it from "not mentioned".
      expect(select.options[0]?.value).toBe('')
      expect(select.options[0]?.textContent).toBe(zh.defaultEffortAuto)
      expect(Array.from(select.options).slice(1).map(option => option.value))
        .toEqual([...OLLAMA_REASONING_EFFORTS])
      expect(el.textContent).toContain(zh.defaultReasoningEffort)
    })

    it('shows the level the host sent, rather than always the default', async () => {
      const el = await renderWith({ defaultReasoningEffort: 'high' })
      // A dropdown stuck on its first option would report every stored choice
      // as unset, and the user would re-pick one that was already in effect.
      expect(effortSelect(el).value).toBe('high')
    })

    it('renders with the level left unspecified, which is the common case', async () => {
      const el = await renderWith({ defaultReasoningEffort: null })
      expect(effortSelect(el).value).toBe('')
    })

    it('still renders when an older host answers without the field at all', async () => {
      // The card once blanked the entire settings page over one absent field.
      // A host predating this one has no such key, and that answer must read as
      // "not specified" rather than take the page down.
      vi.stubGlobal('fetch', vi.fn(async () => {
        const { defaultReasoningEffort: _omitted, ...withoutField } = STATUS
        return Response.json({ ok: true, value: withoutField })
      }))
      const root = createRoot(container as HTMLDivElement)
      await act(async () => {
        root.render(<OllamaSection />)
      })

      const el = container as HTMLDivElement
      expect(el.textContent).toContain(zh.title)
      expect(effortSelect(el).value).toBe('')
    })

    it('posts the chosen level to the settings route', async () => {
      const el = await render()
      const calls: Array<{ url: string; body: unknown }> = []
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        calls.push({ url: String(url), body: init?.body === undefined ? null : JSON.parse(String(init.body)) })
        return Response.json({ ok: true, value: STATUS })
      }))

      await choose(effortSelect(el), 'medium')

      const write = calls.find(call => call.url.endsWith('/ollama/api/settings'))
      expect(write, 'the choice was written to the settings route').not.toBeUndefined()
      expect(write?.body).toEqual({ defaultReasoningEffort: 'medium' })
    })

    it('sends null when the user picks "not specified" again', async () => {
      const el = await renderWith({ defaultReasoningEffort: 'low' })
      const calls: Array<{ url: string; body: unknown }> = []
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        calls.push({ url: String(url), body: init?.body === undefined ? null : JSON.parse(String(init.body)) })
        return Response.json({ ok: true, value: STATUS })
      }))

      await choose(effortSelect(el), '')

      // The body must carry the key with a null value. Leaving it out would
      // leave the stored level in place, and "not specified" would be a choice
      // the user could never get back to.
      const write = calls.find(call => call.url.endsWith('/ollama/api/settings'))
      expect(write?.body).toEqual({ defaultReasoningEffort: null })
    })

    it('reports a refused level in the tab instead of failing silently', async () => {
      const el = await render()
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        if (init?.method === 'POST') {
          return Response.json({ ok: false, error: 'Unsupported reasoning effort.' })
        }
        return Response.json({ ok: true, value: STATUS })
      }))

      await choose(effortSelect(el), 'high')

      expect(el.textContent).toContain('Unsupported reasoning effort.')
    })
  })

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