// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installStyles } from '../src/client/styles.ts'
import { installGlmCodingPlanStyles } from '../src/client/glm-coding-plan/styles.ts'
import { installHubStyles } from '../src/client/hub/hub-styles.ts'
import { installKimiCodeStyles } from '../src/client/kimi-code/styles.ts'
import { installModelChecklistStyles } from '../src/client/common/model-checklist-styles.ts'
import { installPoolStyles } from '../src/client/common/styles.ts'
import { installWorkBuddyStyles } from '../src/client/workbuddy/styles.ts'

const SELECTOR = 'style[data-plugin-css="@eddyskywalker/dsh-chatgpt-subscription/main"]'
const HUB_SELECTOR = 'style[data-plugin-css="@eddyskywalker/dsh-chatgpt-subscription/hub"]'
const CHECKLIST_SELECTOR = 'style[data-plugin-css="@eddyskywalker/dsh-chatgpt-subscription/model-checklist"]'
const POOL_SELECTOR = 'style[data-plugin-css="@eddyskywalker/dsh-chatgpt-subscription/pool"]'
const KIMI_SELECTOR = 'style[data-plugin-css="@eddyskywalker/dsh-chatgpt-subscription/kimi-code"]'
const GLM_SELECTOR = 'style[data-plugin-css="@eddyskywalker/dsh-chatgpt-subscription/glm-coding-plan"]'
const WORKBUDDY_SELECTOR = 'style[data-plugin-css="@eddyskywalker/dsh-chatgpt-subscription/workbuddy"]'
const tags = () => document.querySelectorAll<HTMLStyleElement>(SELECTOR)

/**
 * One sheet's text with its CSS comments removed, so a rule can be looked up by
 * the selector it declares rather than by the prose written above it.
 */
function sheetText(selector: string): string {
  const css = document.querySelector<HTMLStyleElement>(selector)?.textContent ?? ''
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * The declaration block a selector carries in one sheet, or undefined.
 *
 * The sheets are plain text, so a cascade decision ("does this hover rule
 * match that button?") can only be asserted on the selector itself. Reading a
 * rule by its exact selector keeps the assertion about the rule, not about the
 * order the declarations happen to be written in.
 */
function ruleBody(css: string, selector: string): string | undefined {
  for (const chunk of css.split('}')) {
    const [rawSelector, body] = chunk.split('{')
    if (rawSelector?.trim() === selector) return body
  }
  return undefined
}

afterEach(() => {
  for (const selector of [
    SELECTOR,
    HUB_SELECTOR,
    CHECKLIST_SELECTOR,
    POOL_SELECTOR,
    KIMI_SELECTOR,
    GLM_SELECTOR,
    WORKBUDDY_SELECTOR,
  ]) {
    for (const tag of [...document.querySelectorAll<HTMLStyleElement>(selector)]) tag.remove()
  }
})

describe('provider hub overview styles', () => {
  it('ships the overview card, the switch and the back bar as one tagged sheet', () => {
    installHubStyles()
    const css = document.querySelector<HTMLStyleElement>(HUB_SELECTOR)?.textContent ?? ''
    // The card is a full-width row: brand tile, copy block, switch + chevron.
    expect(css).toContain('.dsh-hub-card{')
    expect(css).toContain('.dsh-hub-brand-tile{')
    // The switch is a sliding pill, not a native checkbox.
    expect(css).toContain('.dsh-hub-switch[aria-checked=true]')
    expect(css).toContain('.dsh-hub-switch::after')
    // The detail page's back bar, which replaced the tab strip.
    expect(css).toContain('.dsh-hub-backbar{')
    expect(css).toContain('.dsh-hub-back{')
    // A disabled line's card reads as such.
    expect(css).toContain('[data-enabled=false]')
  })

  it('no longer carries the removed tab strip in the main sheet', () => {
    installStyles()
    const css = tags()[0]!.textContent ?? ''
    expect(css).not.toContain('.dsh-hub-tabs')
    // The overview styles live in their own sheet, installed separately.
    expect(css).not.toContain('.dsh-hub-card')
  })

  it('ships the in-row account quota block in the pool sheet', () => {
    installPoolStyles()
    const css = document.querySelector<HTMLStyleElement>(POOL_SELECTOR)?.textContent ?? ''
    // Quota follows the account, so its bar lives inside the account row.
    expect(css).toContain('.dsha-account-quota-row{')
    expect(css).toContain('.dsha-account-quota-fill{')
    expect(css).toContain('.dsha-account-quota-track{')
    // The warning/danger levels the page-level bars already use.
    expect(css).toContain('[data-level=warning]')
    expect(css).toContain('[data-level=danger]')
  })

  it('ships the shared model checklist rows in their own sheet', () => {
    installModelChecklistStyles()
    const css = document.querySelector<HTMLStyleElement>(CHECKLIST_SELECTOR)?.textContent ?? ''
    expect(css).toContain('.dsh-mcl-option{')
    expect(css).toContain('.dsh-mcl-check{')
    expect(css).toContain('.dsh-mcl-option[aria-checked=true] .dsh-mcl-check')
    expect(css).toContain('.dsh-mcl-head{')
  })

  it('drops the replaced chip rules from the line sheets that still carried them', () => {
    // The shared checklist owns the model rows now, so a line sheet that still
    // defined the old chip list would be carrying a rule nothing can match — the
    // same dead CSS the main sheet already shed.
    installKimiCodeStyles()
    for (const selector of [KIMI_SELECTOR]) {
      const css = document.querySelector<HTMLStyleElement>(selector)?.textContent ?? ''
      expect(css).not.toContain('.dsha-models{')
      expect(css).toContain('.dsha-models-hint{')
    }
  })

  it('keeps the filled primary button painted while the pointer is on it', () => {
    // The resting fill is .dsha-btn-primary at (0,1,0); the shared hover tint is
    // (0,3,0) and paints a ~6% wash. When the tint also matched the filled
    // button it replaced the blue outright while the label stayed white, so a
    // hovered "保存设置" read as an empty pill. The exclusion is part of the
    // selector — the same shape the shared chip uses for its pressed state — so
    // the line sheets that carry this vocabulary cannot drift apart on it.
    installKimiCodeStyles()
    for (const selector of [KIMI_SELECTOR]) {
      const css = sheetText(selector)
      // The unguarded rule is what made the fill disappear: it must be gone.
      expect(ruleBody(css, '.dsha-btn:hover:not(:disabled)')).toBeUndefined()
      const hover = ruleBody(css, '.dsha-btn:hover:not(:disabled):not(.dsha-btn-primary)')
      expect(hover).toBeDefined()
      // The fill the hover must not overwrite is still the info colour.
      expect(ruleBody(css, '.dsha-btn-primary')).toContain('var(--dsw-alias-button-info-fill')
    }
  })

  it('leaves the login row its own hierarchy instead of repainting every button', () => {
    // The login row used to repaint *every* .dsha-btn inside it with the info
    // fill, which was the workaround for the hover bug above. With the hover
    // fixed, what remained was the side effect: "设备码登录" and "导入本地登录"
    // sit beside "添加账号" as the two alternative ways in, and painting all
    // three the same is what makes a row of one primary plus two secondary
    // entries read as three primaries. test/codex-local-signin-ui.test.tsx
    // already asserts the two alternatives are not dsha-btn-primary; this keeps
    // the sheet from contradicting it.
    installGlmCodingPlanStyles()
    installWorkBuddyStyles()
    for (const selector of [GLM_SELECTOR, WORKBUDDY_SELECTOR]) {
      const css = sheetText(selector)
      expect(ruleBody(css, '.dsha-account-add-actions .dsha-btn')).toBeUndefined()
      // The row itself stays: it is the flex line every provider's login entries
      // are laid out in, and it is what the codex page's shrink rule targets.
      expect(ruleBody(css, '.dsha-account-add-actions')).toBeDefined()
    }
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
