// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installStyles } from '../src/client/styles.ts'

const SELECTOR = 'style[data-plugin-css="@eddyskywalker/dsh-chatgpt-subscription/main"]'
const tags = () => document.querySelectorAll<HTMLStyleElement>(SELECTOR)

afterEach(() => {
  for (const tag of [...tags()]) tag.remove()
})

describe('provider hub tab strip', () => {
  it('scrolls the hub tab strip on one line instead of wrapping it', () => {
    installStyles()
    const css = tags()[0]!.textContent ?? ''
    const hubTabs = /\.dsh-hub-tabs\{[^}]*\}/.exec(css)?.[0] ?? ''
    // Seven tabs exceed a narrow settings pane. Wrapping made them reachable but
    // produced a ragged second row (five tabs, then two); the strip now stays on
    // one line and scrolls, so every tab remains reachable at any width.
    expect(hubTabs).toContain('flex-wrap:nowrap')
    expect(hubTabs).toContain('overflow-x:auto')
    // The scrollbar is the affordance that more tabs exist, so it must not be
    // hidden: a mouse user's vertical wheel cannot scroll this row.
    expect(hubTabs).not.toContain('scrollbar-width:none')
    expect(hubTabs).not.toContain('::-webkit-scrollbar{display:none')
    // Buttons must not shrink, or the labels squash instead of the row scrolling.
    expect(css).toContain('.dsh-hub-tabs button{flex:none}')
  })

  it('leaves room for the tab focus outline inside the scroll container', () => {
    installStyles()
    const css = tags()[0]!.textContent ?? ''
    const hubTabs = /\.dsh-hub-tabs\{[^}]*\}/.exec(css)?.[0] ?? ''
    // The focus outline is 2px wide with a 2px offset (4px beyond the button), and
    // an overflow container clips at its padding box, so the strip's own padding
    // has to be at least 4px or the ring is shaved for keyboard users.
    expect(hubTabs).toContain('overflow-y:hidden')
    const padding = Number(/\.dsh-hub-tabs\{[^}]*padding:(\d+)px/.exec(hubTabs)?.[1])
    expect(padding).toBeGreaterThanOrEqual(4)
    // scroll-padding must match, or a tab scrolled into view sits under the edge.
    expect(hubTabs).toContain(`scroll-padding-inline:${padding}px`)
  })

  it('keeps the shared segments rule single-line for the ChatGPT search group', () => {
    installStyles()
    const css = tags()[0]!.textContent ?? ''
    const segments = /\.dsh-codex-segments\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(segments).toContain('flex-wrap:nowrap')
  })
})

describe('client stylesheet installation', () => {
  it('creates exactly one marked stylesheet element', () => {
    expect(installStyles()).toBeTypeOf('function')
    expect(tags()).toHaveLength(1)
    expect(tags()[0].dataset.plugin).toBe('@eddyskywalker/dsh-chatgpt-subscription')
    expect(tags()[0].textContent).toContain('.dsh-codex-page')
  })

  it('is idempotent: a second install never duplicates the tag', () => {
    installStyles()
    installStyles()
    expect(tags()).toHaveLength(1)
  })

  it('never removes the stylesheet on dispose — the document owns the tag', () => {
    const dispose = installStyles()
    dispose()
    expect(tags()).toHaveLength(1)
  })

  it('restores the stylesheet after something else removed it', () => {
    installStyles()
    tags()[0]!.remove()
    expect(tags()).toHaveLength(0)
    // Any later install (a restart, a re-mounted settings page) brings it back.
    installStyles()
    expect(tags()).toHaveLength(1)
    expect(tags()[0]!.textContent).toContain('.dsh-codex-page')
  })

  it('refreshes stale content left by an older bundle', () => {
    installStyles()
    tags()[0]!.textContent = '.stale-from-old-bundle{}'
    installStyles()
    expect(tags()).toHaveLength(1)
    expect(tags()[0]!.textContent).toContain('.dsh-codex-page')
    expect(tags()[0]!.textContent).not.toContain('.stale-from-old-bundle')
  })

  it('keeps the stylesheet alive across a real Cordis restart and a stale-fiber teardown', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const root = new Context()
    const plugin = { apply: () => installStyles() }
    await root.plugin(plugin)
    expect(tags()).toHaveLength(1)

    // A plugin fiber restart (config change, dependency reload) mounts a new
    // fiber while the old one is still tearing down asynchronously.
    const fiber = await root.plugin(plugin)
    await Promise.resolve()
    expect(tags()).toHaveLength(1)

    // The old fiber is disposed only after the new one already ran its apply —
    // the window where the previous installer's `element.remove()` disposer
    // deleted the only copy and every later install kept deduping to a no-op.
    fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(tags()).toHaveLength(1)
    expect(tags()[0]!.textContent).toContain('.dsh-codex-page')
  })

  it('recovers from the historical fiber-owned removal shape', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const root = new Context()
    // Model the previous installer verbatim: the first fiber owned the element
    // and removed it on unload, while a second fiber's install deduped to a
    // no-op disposer.
    const owning = await root.plugin({
      apply: () => {
        installStyles()
        return () => document.querySelector(SELECTOR)?.remove()
      },
    })
    expect(tags()).toHaveLength(1)
    await root.plugin({ apply: () => installStyles() })
    expect(tags()).toHaveLength(1)

    owning.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The stale owner still takes the tag — that is the reported failure —
    // but the very next install must rebuild it instead of deduping forever.
    expect(tags()).toHaveLength(0)
    installStyles()
    expect(tags()).toHaveLength(1)
  })
})
