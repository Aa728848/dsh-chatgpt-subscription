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

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = undefined
})

describe('image Tool view dispatch stages', () => {
  it('renders a preparing call as running, with no arguments to summarize', async () => {
    await render(PREPARING)

    expect(title()).toBe(en.imageToolRunning)
    expect(card().dataset.state).toBe('running')
    expect(summary()).toBeNull()
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
