// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { PLUGIN_ID } from '../src/client/common/plugin-style.ts'
import { installStyles } from '../src/client/styles.ts'
import { installAntigravityStyles } from '../src/client/antigravity/styles.ts'
import { installClaudeStyles } from '../src/client/claude/styles.ts'
import { installKimiCodeStyles } from '../src/client/kimi-code/styles.ts'
import { installMinimaxCodeStyles } from '../src/client/minimax-code/styles.ts'
import { installWorkBuddyStyles } from '../src/client/workbuddy/styles.ts'
import { installPoolStyles } from '../src/client/common/styles.ts'
import { installMermaidStyles } from '../src/client/mermaid/styles.ts'

/** Every sheet this plugin injects, by its `data-plugin-css` sub-name. */
const SHEETS = [
  { name: 'main', install: installStyles },
  { name: 'antigravity', install: installAntigravityStyles },
  { name: 'claude', install: installClaudeStyles },
  { name: 'kimi-code', install: installKimiCodeStyles },
  { name: 'minimax-code', install: installMinimaxCodeStyles },
  { name: 'workbuddy', install: installWorkBuddyStyles },
  { name: 'pool', install: installPoolStyles },
  { name: 'mermaid', install: installMermaidStyles },
] as const

const owned = (): HTMLStyleElement[] =>
  [...document.querySelectorAll<HTMLStyleElement>(`style[data-plugin="${PLUGIN_ID}"]`)]

const installAll = (): void => {
  for (const sheet of SHEETS) sheet.install()
}

afterEach(() => {
  for (const tag of owned()) tag.remove()
})

describe('plugin stylesheet ownership', () => {
  it('tags every injected sheet, leaving nothing for another package to claim', () => {
    installAll()
    // The client module system stamps `style:not([data-plugin])` with whichever
    // package materializes next and later deletes the tag as that package's
    // bookkeeping. An untagged sheet is therefore a sheet waiting to disappear,
    // which is how the shared `.dsha-*` design system vanished from the
    // settings page while the already-tagged `…/main` sheet survived.
    expect(document.querySelectorAll('style:not([data-plugin])')).toHaveLength(0)
    expect(owned()).toHaveLength(SHEETS.length)
    expect(owned().map((tag) => tag.getAttribute('data-plugin-css'))).toEqual(
      SHEETS.map((sheet) => `${PLUGIN_ID}/${sheet.name}`),
    )
  })

  it('keeps the shared provider design system reachable from the ChatGPT tab', () => {
    // The hub's default ChatGPT tab renders its controls with the shared
    // `.dsha-*` classes, whose base sheet the sibling provider modules install.
    installKimiCodeStyles()
    installAntigravityStyles()
    const base = owned().filter((tag) => (tag.textContent ?? '').includes('.dsha-page'))
    expect(base.length).toBeGreaterThan(0)
    for (const tag of base) expect(tag.getAttribute('data-plugin')).toBe(PLUGIN_ID)
  })

  it('restores every sheet after the module system drops the package styles', () => {
    installAll()
    // `removeOwnedStyles()` on a reload/replacement/prune deletes tags by owner.
    for (const tag of owned()) tag.remove()
    expect(owned()).toHaveLength(0)
    installAll()
    expect(owned()).toHaveLength(SHEETS.length)
    expect(owned().every((tag) => (tag.textContent ?? '').length > 0)).toBe(true)
  })

  it('reclaims a legacy untagged sheet that another package had already claimed', () => {
    // A bundle predating the ownership attributes injected a plain tag; the
    // module system then claimed it for an unrelated package. Installing must
    // adopt and re-stamp that element instead of leaving it to be deleted.
    const legacy = document.createElement('style')
    legacy.id = 'dsh-antigravity-settings-style'
    legacy.dataset.plugin = 'some-other-package'
    legacy.textContent = '.dsha-page{display:flex}'
    document.head.append(legacy)

    installAntigravityStyles()

    const adopted = [...document.querySelectorAll<HTMLStyleElement>('style')].filter(
      (tag) => tag.getAttribute('data-plugin-css') === `${PLUGIN_ID}/antigravity`,
    )
    expect(adopted).toHaveLength(1)
    expect(adopted[0]).toBe(legacy)
    expect(legacy.dataset.plugin).toBe(PLUGIN_ID)
    expect(legacy.textContent).toContain('.dsha-account-card')
  })

  it('refreshes stale CSS from an older bundle instead of deduping to a no-op', () => {
    installKimiCodeStyles()
    const tag = owned()[0]!
    tag.textContent = '.stale-from-old-bundle{}'
    installKimiCodeStyles()
    expect(owned()).toHaveLength(1)
    expect(tag.textContent).toContain('.dsha-page')
    expect(tag.textContent).not.toContain('.stale-from-old-bundle')
  })
})
