// @vitest-environment jsdom
/**
 * The image Tool view is dispatched at every stage the harness reports.
 *
 * Harness 0.1.7-rc.1 replaced the running-call shape with a phase union: a view
 * is now rendered while its call is still *preparing*, and a preparing block
 * carries no `argsRaw` at all. Each stage's wire shape is written literally
 * here, because a harness factory would only produce the installed
 * generation's shape — the one thing this file must not depend on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { CodexImageToolView } from '../src/client/CodexImageToolView.tsx'
import type { ImageLoader } from '../src/client/CodexImageToolView.tsx'
import { en } from '../src/client/locales.ts'
import { installStyles } from '../src/client/styles.ts'

type ViewProps = Parameters<typeof CodexImageToolView>[0]

/** 0.1.7-rc.1 dispatch: the call exists, its arguments do not yet. */
const PREPARING = {
  phase: 'preparing', callId: 'call-1', name: 'codex_image_generate',
  turn: 1, step: 1, time: 0, subCalls: [],
}

/** 0.1.7-rc.1 dispatch: arguments arrived, no result yet. */
const STARTED = { ...PREPARING, phase: 'start', argsRaw: '{"prompt":"a red fox"}' }

/** The same stage on harness ≤0.1.7-alpha.1, which carries no `phase` at all. */
const LEGACY_RUNNING = {
  callId: 'call-1', name: 'codex_image_generate', argsRaw: '{"prompt":"a red fox"}',
  turn: 1, step: 1, time: 0, subCalls: [],
}

const RESULT = {
  kind: 'tool-result',
  isError: false,
  call: { callId: 'call-1', name: 'codex_image_generate', argsRaw: '{"prompt":"a red fox"}' },
  content: [
    { type: 'text', text: 'generated' },
    { type: 'image', attachment: { attachmentId: 'att-1', name: 'fox.png' } },
  ],
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function viewProps(block: unknown, loadImage: ImageLoader): ViewProps {
  return {
    block,
    loadImage,
    t: (key: keyof typeof en) => en[key],
  } as unknown as ViewProps
}

async function render(block: unknown, loadImage: ImageLoader = async () => 'blob:fox'): Promise<void> {
  await act(async () => root.render(createElement(CodexImageToolView, viewProps(block, loadImage))))
}

/** The card root, which carries the stage in `data-state`. */
function card(): HTMLDivElement {
  return container.querySelector<HTMLDivElement>('.dsh-codex-image-tool')!
}

function title(): string | null {
  return container.querySelector('.dsh-codex-image-title')?.textContent ?? null
}

function summary(): string | null {
  return container.querySelector('.dsh-codex-image-summary')?.textContent ?? null
}

function previews(): NodeListOf<HTMLImageElement> {
  return container.querySelectorAll<HTMLImageElement>('img.dsh-codex-image-preview')
}

/** The full prompt, kept on the summary because the visible text ellipsizes. */
function summaryTitle(): string | null {
  return container.querySelector('.dsh-codex-image-summary')?.getAttribute('title') ?? null
}

/** The tray a running call reserves for the image it is about to produce. */
function placeholder(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.dsh-codex-image-placeholder')
}

/** The live region that carries the stage to a screen reader. */
function statusRegion(): HTMLElement {
  return container.querySelector<HTMLElement>('.dsh-codex-image-title')!
}

const HOST_STYLE_SELECTOR = 'style[data-plugin-css="@eddyskywalker/dsh-chatgpt-subscription/main"]'

/** The card's CSS exactly as the page receives it. */
function css(): string {
  installStyles()
  return document.querySelector<HTMLStyleElement>(HOST_STYLE_SELECTOR)?.textContent ?? ''
}

/** The reduced-motion block, which is the sheet's last rule. */
function reducedMotion(): string {
  const raw = css()
  const at = raw.indexOf('@media(prefers-reduced-motion:reduce)')
  expect(at).toBeGreaterThanOrEqual(0)
  return raw.slice(at)
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  for (const tag of [...document.querySelectorAll<HTMLStyleElement>(HOST_STYLE_SELECTOR)]) tag.remove()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = undefined
})

describe('image Tool view dispatch stages', () => {
  it('renders a preparing call as running, with no arguments to summarize', async () => {
    await render(PREPARING)

    expect(title()).toBe(en.imageToolRunning)
    expect(card().dataset.state).toBe('running')
    expect(summary()).toBeNull()
  })

  it('reads a preparing prompt from the lazy argument view', async () => {
    await render({
      ...PREPARING,
      args: { text: (key: string) => key === 'prompt' ? 'a fox still being written' : undefined },
    })

    expect(title()).toBe(en.imageToolRunning)
    expect(summary()).toBe('a fox still being written')
  })

  it('summarizes the dispatched arguments once they exist', async () => {
    await render(STARTED)

    expect(title()).toBe(en.imageToolRunning)
    expect(summary()).toBe('a red fox')
  })

  it('renders the pre-0.1.7-rc.1 running shape unchanged', async () => {
    await render(LEGACY_RUNNING)

    expect(title()).toBe(en.imageToolRunning)
    expect(summary()).toBe('a red fox')
  })

  it('renders generated images from a settled result', async () => {
    await render(RESULT)

    expect(title()).toBe(en.imageToolDone)
    expect(card().dataset.state).toBe('done')
    expect(summary()).toBe('a red fox')
    expect([...previews()].map((image) => image.getAttribute('src'))).toEqual(['blob:fox'])
  })

  it('reports an errored result without rendering its images', async () => {
    await render({ ...RESULT, isError: true })

    expect(title()).toBe(en.imageToolFailed)
    expect(card().dataset.state).toBe('error')
    expect(previews().length).toBe(0)
  })

  it('tolerates an argument payload that is not JSON', async () => {
    await render({ ...STARTED, argsRaw: 'not json' })

    expect(title()).toBe(en.imageToolRunning)
    expect(summary()).toBeNull()
  })
})
/**
 * The head is one line at every width, and a running call reserves its tray.
 *
 * A 320px column is where this card used to break: nothing in the head held its
 * own size, so the label was squeezed until each character sat on its own row.
 */
describe('image Tool view layout', () => {
  it('keeps dot and label at full size and ellipsizes only the summary', async () => {
    const long = 'a very long prompt '.repeat(20)
    await render({ ...STARTED, argsRaw: JSON.stringify({ prompt: long }) })

    expect(container.querySelector('.dsh-codex-image-tool-head')?.children.length).toBe(3)
    expect(title()).toBe(en.imageToolRunning)
    // The visible text is clipped by CSS; the whole prompt stays in the title.
    expect(summary()).toBe(long)
    expect(summaryTitle()).toBe(long)

    const sheet = css()
    expect(sheet).toContain('.dsh-codex-image-tool-head{align-items:center;display:flex;flex-wrap:nowrap')
    expect(sheet).toMatch(/\.dsh-codex-image-dot\{[^}]*flex:none/)
    expect(sheet).toContain('.dsh-codex-image-title{flex:none;font-weight:600;white-space:nowrap}')
    expect(sheet).toMatch(/\.dsh-codex-image-summary\{[^}]*flex:1 1 auto/)
    expect(sheet).toMatch(/\.dsh-codex-image-summary\{[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/)
  })

  it('reserves a tray shaped like the ratio the call asked for', async () => {
    await render({ ...STARTED, argsRaw: '{"prompt":"a red fox","aspectRatio":"16:9"}' })

    const tray = placeholder()
    expect(tray?.dataset.ratio).toBe('16:9')
    expect(tray?.getAttribute('aria-hidden')).toBe('true')
    expect(tray?.parentElement?.className).toBe('dsh-codex-image-grid')
    // Portrait is a legal ratio too: the box follows it instead of forcing 16:9.
    await render({ ...STARTED, argsRaw: '{"prompt":"a red fox","aspectRatio":"9:16"}' })
    expect(placeholder()?.dataset.ratio).toBe('9:16')
  })

  it('falls back to a stable square when no legal ratio is known', async () => {
    await render(PREPARING)
    expect(placeholder()?.dataset.ratio).toBe('1:1')

    await render({ ...STARTED, argsRaw: '{"prompt":"a red fox","aspectRatio":"7:5"}' })
    expect(placeholder()?.dataset.ratio).toBe('1:1')

    await render(LEGACY_RUNNING)
    expect(placeholder()?.dataset.ratio).toBe('1:1')
  })

  it('keeps the extreme strip ratios the tool accepts instead of falling back', async () => {
    // The host enum carries the strip family (1:4 / 4:1 / 1:8 / 8:1). A card
    // that does not know them draws a square and calls a banner square.
    await render({ ...STARTED, argsRaw: '{"prompt":"a red fox","aspectRatio":"1:4"}' })
    expect(placeholder()?.dataset.ratio).toBe('1:4')
    await render({ ...STARTED, argsRaw: '{"prompt":"a red fox","aspectRatio":"1:8"}' })
    expect(placeholder()?.dataset.ratio).toBe('1:8')

    for (const ratio of ['4:1', '8:1']) {
      await render({ ...STARTED, argsRaw: JSON.stringify({ prompt: 'a red fox', aspectRatio: ratio }) })
      expect(placeholder()?.dataset.ratio).toBe(ratio)
    }
  })

  it('fixes only the short side of the tray and lets the ratio derive the rest', async () => {
    // Portrait: the height is the short side, so the width follows it down.
    await render({ ...STARTED, argsRaw: '{"prompt":"a red fox","aspectRatio":"1:8"}' })
    expect(placeholder()?.dataset.shortSide).toBe('height')
    expect(placeholder()?.style.height).toBe('112px')
    expect(placeholder()?.style.width).toBe('')
    expect(placeholder()?.getAttribute('style')).toContain('aspect-ratio: 1 / 8')

    // Landscape: the width is the short side, capped at the card edge, so an 8:1
    // strip shrinks its height instead of being clamped into a squarer box.
    // jsdom's cssstyle drops the min() value, so the axis is what it can check;
    // the rendered geometry is asserted in the browser during review.
    await render({ ...STARTED, argsRaw: '{"prompt":"a red fox","aspectRatio":"8:1"}' })
    expect(placeholder()?.dataset.shortSide).toBe('width')
    expect(placeholder()?.style.height).toBe('')
    expect(placeholder()?.getAttribute('style')).toContain('aspect-ratio: 8 / 1')
  })

  it('drops the tray as soon as the call settles', async () => {
    await render(RESULT)
    expect(placeholder()).toBeNull()

    await render({ ...RESULT, isError: true })
    expect(placeholder()).toBeNull()
  })

  it('announces the stage through a polite status region', async () => {
    await render(PREPARING)
    expect(statusRegion().getAttribute('role')).toBe('status')
    expect(statusRegion().getAttribute('aria-live')).toBe('polite')
    expect(statusRegion().textContent).toBe(en.imageToolRunning)

    // The region survives the stage change, so the new label is announced.
    await render({ ...RESULT, isError: true })
    expect(statusRegion().getAttribute('role')).toBe('status')
    expect(statusRegion().textContent).toBe(en.imageToolFailed)
  })

  it('stops the tray animation under prefers-reduced-motion', () => {
    expect(css()).toContain('.dsh-codex-image-placeholder{animation:dsh-codex-pulse')
    expect(reducedMotion()).toContain('.dsh-codex-image-placeholder{animation:none}')
  })
})
