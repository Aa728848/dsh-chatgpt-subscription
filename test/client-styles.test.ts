// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installStyles } from '../src/client/styles.ts'

const SELECTOR = 'style[data-plugin-css="@eddyskywalker/dsh-chatgpt-subscription/main"]'
const tags = () => document.querySelectorAll<HTMLStyleElement>(SELECTOR)

afterEach(() => {
  for (const tag of [...tags()]) tag.remove()
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
