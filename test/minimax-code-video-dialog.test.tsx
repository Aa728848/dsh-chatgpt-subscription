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
import { VideoFormDialog } from '../src/client/minimax-code/VideoFormDialog.tsx'
import { videoPresets } from '../src/client/minimax-code/video-presets.ts'
import { normalizeVideoDefaults } from '../src/client/minimax-code/video-form-rules.ts'
import { workspaceListerFor } from '../src/client/minimax-code/video-workspace.ts'

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
  })

  it('floats over the page instead of dimming it with a mask', () => {
    renderDialog()
    // A backdrop would grey out the conversation the user is writing in; the
    // panel is a floating layer, not a modal takeover.
    expect(document.body.querySelector('.dshm-video-modal-mask')).toBeNull()
    expect(document.body.querySelector('[aria-modal="true"]')).toBeNull()
  })

  it('carries the composer text in as the clip description', () => {
    act(() => {
      root.render(
        <VideoFormDialog
          open
          onClose={() => {}}
          onSubmit={() => true}
          defaults={normalizeVideoDefaults({})}
          seedPrompt="海浪拍在礁石上"
          t={t as never}
        />,
      )
    })
    const prompt = document.body.querySelector<HTMLTextAreaElement>('#dshm-video-prompt')
    expect(prompt?.value).toBe('海浪拍在礁石上')
    // The description is already there, so the panel is immediately submittable.
    expect(document.body.querySelector<HTMLButtonElement>('.dsha-btn-primary')?.disabled).toBe(false)
    expect(document.body.textContent).toContain('videoPromptFromComposer')
  })

  it('keeps the ratio and media behind "more parameters" until asked', () => {
    renderDialog()
    // The description and the tier chips are the first thing seen; media blocks
    // are not in the initial layout at all.
    expect(document.body.querySelector('#dshm-video-ref-images')).toBeNull()
    expect(document.body.querySelectorAll('.dshm-video-tier')).toHaveLength(3)
    act(() => { document.body.querySelector<HTMLButtonElement>('.dshm-video-advanced')!.click() })
    expect(document.body.querySelector('#dshm-video-ref-images')).not.toBeNull()
    // Three models, each with its own first-frame block.
    expect(document.body.querySelector('#dshm-video-input-image')).not.toBeNull()
  })

  it('refuses a web link in a media block instead of pretending to accept it', () => {
    renderDialog()
    act(() => { document.body.querySelector<HTMLButtonElement>('.dshm-video-advanced')!.click() })
    const entry = document.body.querySelector('#dshm-video-ref-images .dshm-media-entry-input')!
    act(() => {
      const event = new Event('paste', { bubbles: true }) as Event & { clipboardData: unknown }
      event.clipboardData = { getData: () => 'https://example.com/a.png' }
      entry.dispatchEvent(event)
    })
    // A third-party link never reaches the service, so it is refused here.
    expect(document.body.textContent).toContain('videoMediaUrlRejected')
    expect(document.body.querySelector('#dshm-video-ref-images .dshm-media-item')).toBeNull()
  })

  it('adds a pasted local path as a removable chip', () => {
    renderDialog()
    act(() => { document.body.querySelector<HTMLButtonElement>('.dshm-video-advanced')!.click() })
    const entry = document.body.querySelector('#dshm-video-ref-images .dshm-media-entry-input')!
    act(() => {
      const event = new Event('paste', { bubbles: true }) as Event & { clipboardData: unknown }
      event.clipboardData = { getData: () => 'C:\\ws\\a.png' }
      entry.dispatchEvent(event)
    })
    const chips = document.body.querySelectorAll('#dshm-video-ref-images .dshm-media-item')
    expect(chips).toHaveLength(1)
    expect(chips[0].textContent).toContain('a.png')
    act(() => { document.body.querySelector<HTMLButtonElement>('#dshm-video-ref-images .dshm-media-remove')!.click() })
    expect(document.body.querySelectorAll('#dshm-video-ref-images .dshm-media-item')).toHaveLength(0)
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

  it('accepts a typed or @-referenced workspace path', () => {
    renderDialog()
    act(() => { document.body.querySelector<HTMLButtonElement>('.dshm-video-advanced')!.click() })
    const input = document.body.querySelector<HTMLInputElement>('#dshm-video-ref-images .dshm-media-entry-input')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '@docs/shore.png')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      document.body.querySelector<HTMLButtonElement>('#dshm-video-ref-images .dshm-media-add')!.click()
    })
    const chips = document.body.querySelectorAll('#dshm-video-ref-images .dshm-media-item')
    expect(chips).toHaveLength(1)
    // The @ is a composition spelling, not part of the path the tool receives.
    expect(chips[0].querySelector('.dshm-media-item-name')?.getAttribute('title')).toBe('docs/shore.png')
  })

  it('suggests real workspace files when a path starts with @', async () => {
    const list = async (_sessionId: string, path: string) => ({
      ok: true as const,
      value: {
        path,
        entries: path === ''
          ? [{ name: 'assets', type: 'directory' }, { name: 'clip.mp4', type: 'file' }]
          : [{ name: 'clip.mp4', type: 'file' }],
        truncated: false,
      },
    })
    const ctx = { get: (name: string) => (name === 'remote.workspaceFiles' ? { list } : undefined) }
    act(() => {
      root.render(
        <VideoFormDialog
          open
          onClose={() => {}}
          onSubmit={() => true}
          defaults={normalizeVideoDefaults({})}
          listWorkspace={workspaceListerFor(ctx as never, 's1')}
          t={t as never}
        />,
      )
    })
    act(() => { document.body.querySelector<HTMLButtonElement>('.dshm-video-advanced')!.click() })
    const input = document.body.querySelector<HTMLInputElement>('#dshm-video-ref-images .dshm-media-entry-input')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '@')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // The list resolves asynchronously; let the microtask queue drain.
    await act(async () => { await Promise.resolve() })
    const rows = [...document.body.querySelectorAll('#dshm-video-ref-images .dshm-media-suggest-item')]
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('assets')

    // Picking a file adds it as a chip with the @ stripped.
    act(() => { (rows[1] as HTMLButtonElement).click() })
    const chips = document.body.querySelectorAll('#dshm-video-ref-images .dshm-media-item')
    expect(chips).toHaveLength(1)
    expect(chips[0].querySelector('.dshm-media-item-name')?.getAttribute('title')).toBe('clip.mp4')
  })

  it('keeps every tier chip on one row with a short label', () => {
    renderDialog()
    const chips = [...document.body.querySelectorAll('.dshm-video-tier')]
    expect(chips).toHaveLength(3)
    // The shared "MiniMax-" prefix is dropped on the chip; the full parameter
    // set stays reachable through the tooltip.
    expect(chips[0].textContent).toBe('H3 · 4videoDurationUnit')
    expect(chips[0].getAttribute('title')).toContain('768P')
    expect(chips[0].getAttribute('title')).toContain('16:9')
  })

  it('hides the ratio picker and shows the forced value once a frame is set', () => {
    renderDialog()
    const ratioSelect = document.body.querySelector('#dshm-video-ratio')
    // Text-only: the host gives a selector over the concrete ratios.
    expect(ratioSelect?.tagName).toBe('SELECT')

    // Media lives behind "more parameters"; open it, then paste a path into the
    // first-frame well the way a user would.
    const advanced = document.body.querySelector<HTMLButtonElement>('.dshm-video-advanced')!
    act(() => { advanced.click() })
    const entry = document.body.querySelector('#dshm-video-input-image .dshm-media-entry-input')!
    act(() => {
      const event = new Event('paste', { bubbles: true }) as Event & { clipboardData: unknown }
      event.clipboardData = { getData: () => '/ws/first.png' }
      entry.dispatchEvent(event)
    })
    // With a first frame the host forces adaptive, so the picker is replaced by
    // the value that will actually be sent.
    expect(document.body.querySelector('#dshm-video-ratio')?.tagName).not.toBe('SELECT')
    expect(document.body.querySelector('#dshm-video-ratio code')?.textContent).toBe('adaptive')
    expect(document.body.textContent).toContain('videoRatioLockedKeyframes')
  })

  it('opens on the ratio that will really be sent', () => {
    renderDialog()
    // Text-only H3 resolves to 16:9; the select must SHOW that rather than the
    // first option in the list, or the panel would be quoting a different request.
    const select = document.body.querySelector<HTMLSelectElement>('#dshm-video-ratio')
    expect(select?.value).toBe('16:9')
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
