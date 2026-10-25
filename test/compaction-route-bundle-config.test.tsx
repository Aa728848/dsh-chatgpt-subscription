// @vitest-environment jsdom
/**
 * Where the compaction card appears: this plugin's own bundle page in the DSH
 * plugin manager.
 *
 * The slot is keyed by package name, so the page itself decides whose page this
 * is. What this entry still controls is the view: `summary` is the one-liner
 * drawn beside the bundle card, and rendering (or fetching) anything there would
 * cost a status read for text nobody expands.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPACTION_ROUTE_PACKAGE,
  CompactionRouteBundleConfig,
} from '../src/client/CompactionRouteBundleConfig.tsx'
import { zh } from '../src/client/locales.ts'

const STATUS = {
  ok: true,
  value: {
    preferences: {
      quickQuotaVisible: false,
      fastMode: false,
      outputVerbosity: null,
      reasoningSummary: null,
      visibleModelIds: [],
      searchProvider: 'dsh',
      contextWindowOverrides: {},
      proxyMode: 'auto',
      customProxyUrl: null,
      compactionRoute: null,
      writable: true,
    },
  },
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function mount(view: 'summary' | 'page'): Promise<{ node: HTMLDivElement; fetchMock: ReturnType<typeof vi.fn> }> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const fetchMock = vi.fn(async () => Response.json(STATUS))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(CompactionRouteBundleConfig as never, {
    view,
    t: (key: keyof typeof zh) => zh[key],
  })))
  return { node: container, fetchMock }
}

afterEach(async () => {
  if (root !== null) await act(async () => root!.unmount())
  root = null
  container?.remove()
  container = null
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
  vi.restoreAllMocks()
})

describe('compaction route bundle configuration', () => {
  it('renders nothing and reads nothing in the summary view', async () => {
    const { node, fetchMock } = await mount('summary')
    expect(node.textContent).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders the card in the page view and reads the status once', async () => {
    const { node, fetchMock } = await mount('page')
    expect(node.textContent).toContain(zh.compactionRoute)
    expect(node.textContent).toContain(zh.compactionRouteFollow)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('is registered under this package, which is what keys the page', () => {
    // The key is the contract with the plugin manager: a renamed package would
    // silently lose its configuration section rather than fail loudly.
    expect(COMPACTION_ROUTE_PACKAGE).toBe('@eddyskywalker/dsh-chatgpt-subscription')
  })
})
