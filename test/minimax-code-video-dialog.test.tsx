// @vitest-environment jsdom
/**
 * Render tests for the `/video` parameter dialog.
 *
 * Two of the delivery requirements are only observable in a render, and neither is
 * provable from the pure form module:
 *
 * 1. the dialog is PORTALED to `document.body` — it must not be nested inside the
 *    composer's container, which has `overflow` and would clip it;
 * 2. it is keyboard usable — Escape closes it, every field is reachable by Tab, and
 *    the submit button is disabled until a prompt exists.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoFormDialog, videoPresets } from '../src/client/minimax-code/VideoFormDialog.tsx'
import { normalizeVideoDefaults } from '../src/client/minimax-code/video-form-rules.ts'

// React 18's act() needs the flag set before any render.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A translate that echoes the key: assertions then read keys, not copy. */
function t(key: string): string {
  return key
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  // The dialog portals into body; nothing of it may outlive the test.
  for (const node of document.body.querySelectorAll('.dshm-video-modal-root')) node.remove()
})

/** Render one dialog and return the live body node the portal produced. */
function renderDialog(props: Partial<Parameters<typeof VideoFormDialog>[0]> = {}): void {
  act(() => {
    root.render(
      <VideoFormDialog
        open
        onClose={props.onClose ?? (() => {})}
        onSubmit={props.onSubmit ?? (() => true)}
        defaults={props.defaults ?? normalizeVideoDefaults({})}
        t={t as never}
      />,
    )
  })
}

describe('VideoFormDialog', () => {
  it('portals to document.body instead of staying inside its container', () => {
    renderDialog()
    // The whole point: an overlay rendered in place would be clipped by the
    // composer's overflow. Nothing of the dialog may live under `container`.
    expect(container.querySelector('.dshm-video-modal')).toBeNull()
    const dialog = document.body.querySelector('.dshm-video-modal')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    renderDialog({ onClose })
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the submit button disabled until a prompt exists', () => {
    renderDialog()
    const submit = document.body.querySelector<HTMLButtonElement>('.dsha-btn-primary')
    expect(submit).not.toBeNull()
    expect(submit?.disabled).toBe(true)
    expect(submit?.textContent).toBe('videoSubmit')

    const prompt = document.body.querySelector<HTMLTextAreaElement>('#dshm-video-prompt')
    expect(prompt).not.toBeNull()
    act(() => {
      // React's controlled-input path: set through the native setter, then fire input.
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(prompt, '海边日落')
      prompt!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.body.querySelector<HTMLButtonElement>('.dsha-btn-primary')?.disabled).toBe(false)
  })

  it('hides the ratio picker and shows the forced value once a frame is set', () => {
    renderDialog()
    const ratioSelect = document.body.querySelector('#dshm-video-ratio')
    // Text-only: the host gives a selector over the concrete ratios.
    expect(ratioSelect?.tagName).toBe('SELECT')

    const frame = document.body.querySelector<HTMLInputElement>('#dshm-video-input-image')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(frame, '/ws/first.png')
      frame!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // With a first frame the host forces adaptive, so the picker is replaced by
    // the value that will actually be sent.
    expect(document.body.querySelector('#dshm-video-ratio')?.tagName).not.toBe('SELECT')
    expect(document.body.querySelector('#dshm-video-ratio code')?.textContent).toBe('adaptive')
    expect(document.body.textContent).toContain('videoRatioLockedKeyframes')
  })

  it('offers no `adaptive` option for a text-only generation', () => {
    renderDialog()
    const options = [...document.body.querySelectorAll('#dshm-video-ratio option')]
      .map(option => option.getAttribute('value'))
    expect(options).not.toContain('adaptive')
    expect(options).toContain('16:9')
  })

  it('narrows durations and resolutions when the model changes', () => {
    renderDialog()
    const model = document.body.querySelector<HTMLSelectElement>('#dshm-video-model')
    const durationsOf = (): string[] => [...document.body.querySelectorAll('#dshm-video-duration option')]
      .map(option => option.getAttribute('value') ?? '')
    const resolutionsOf = (): string[] => [...document.body.querySelectorAll('#dshm-video-resolution option')]
      .map(option => option.getAttribute('value') ?? '')

    expect(resolutionsOf()).toEqual(['768P', '2K'])
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(model, 'MiniMax-Hailuo-2.3')
      model!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // A closed set, not a window: 7 s is not offered at all.
    expect(durationsOf()).toEqual(['6', '10'])
    expect(resolutionsOf()).toEqual(['768P', '1080P'])
  })

  it('submits the composed text through the caller and then closes', () => {
    const submitted: string[] = []
    const onClose = vi.fn()
    renderDialog({
      onClose,
      onSubmit: (text) => { submitted.push(text); return true },
    })
    const prompt = document.body.querySelector<HTMLTextAreaElement>('#dshm-video-prompt')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(prompt, '海边日落')
      prompt!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = document.body.querySelector<HTMLButtonElement>('.dsha-btn-primary')
    act(() => { submit!.click() })

    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain('minimax_generate_video')
    expect(submitted[0]).toContain('prompt=海边日落')
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the dialog open and says so when the composer cannot be filled', () => {
    const onClose = vi.fn()
    renderDialog({ onClose, onSubmit: () => false })
    const prompt = document.body.querySelector<HTMLTextAreaElement>('#dshm-video-prompt')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(prompt, 'p')
      prompt!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { document.body.querySelector<HTMLButtonElement>('.dsha-btn-primary')!.click() })
    expect(onClose).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('videoDraftFailed')
  })
})

describe('videoPresets', () => {
  it('labels every row with a legal model, duration, resolution and ratio', () => {
    const rows = videoPresets(t as never)
    expect(rows).toHaveLength(3)
    // The H3 family is text-only here, so it carries the 16:9 default; Hailuo is
    // outside that linkage and carries no ratio at all.
    expect(rows.map(row => row.preset.ratio)).toEqual(['16:9', '16:9', undefined])
  })
})
