// @vitest-environment jsdom
/**
 * The compaction-model card: what it sends when a route is chosen, and what it
 * warns about before the user finds out the hard way.
 *
 * Two behaviours are pinned here that the settings page depends on:
 *
 * - mounting the card must cost no request (the settings page is opened for
 *   unrelated reasons, and every other card counts its own fetches), so the
 *   directory is read only once the user opens the picker;
 * - a saved route that the directory no longer offers still reads as
 *   configured, because a blank card would look like "nothing is set" while
 *   the host keeps summarizing on it.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompactionRouteCard, type CompactionRouteCardLabels } from '../src/client/CompactionRouteCard.tsx'
import { zh } from '../src/client/locales.ts'
import type {
  CompactionCandidatesDto,
  SubscriptionPreferencesDto,
  SubscriptionPreferencesUpdateDto,
} from '../src/shared/contracts.ts'

const LABELS: CompactionRouteCardLabels = {
  title: zh.compactionRoute,
  hint: zh.compactionRouteHint,
  provider: zh.compactionRouteProvider,
  model: zh.compactionRouteModel,
  save: zh.compactionRouteSave,
  clear: zh.compactionRouteClear,
  change: zh.compactionRouteChange,
  follow: zh.compactionRouteFollow,
  saved: zh.compactionRouteSaved,
  failed: zh.compactionRouteFailed,
  noVideo: zh.compactionRouteNoVideo,
  noImage: zh.compactionRouteNoImage,
  empty: zh.compactionRouteEmpty,
}

const CANDIDATES: CompactionCandidatesDto = {
  providers: [{
    id: 'opendesign',
    name: 'OpenDesign',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', modalities: ['text', 'image'] },
      { id: 'k3', name: 'K3', modalities: ['text', 'image', 'video'] },
    ],
  }],
}

function preferences(route: { provider: string; model: string } | null = null): SubscriptionPreferencesDto {
  return {
    quickQuotaVisible: false,
    fastMode: false,
    outputVerbosity: null,
    reasoningSummary: null,
    visibleModelIds: [],
    searchProvider: 'dsh',
    contextWindowOverrides: {},
    proxyMode: 'auto',
    customProxyUrl: null,
    compactionRoute: route,
    writable: true,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function mount(options: {
  route?: { provider: string; model: string } | null
  candidates?: CompactionCandidatesDto
} = {}): Promise<{
  node: HTMLDivElement
  candidates: ReturnType<typeof vi.fn>
  updatePreferences: ReturnType<typeof vi.fn>
  saved: SubscriptionPreferencesDto[]
}> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const saved: SubscriptionPreferencesDto[] = []
  let current = preferences(options.route ?? null)
  const candidates = vi.fn(async () => options.candidates ?? CANDIDATES)
  const updatePreferences = vi.fn(async (patch: SubscriptionPreferencesUpdateDto) => {
    current = { ...current, compactionRoute: patch.compactionRoute ?? null }
    return current
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(CompactionRouteCard, {
    api: { compactionCandidates: candidates, updatePreferences } as never,
    preferences: current,
    labels: LABELS,
    onSaved: (next: SubscriptionPreferencesDto) => { saved.push(next) },
  })))
  return { node: container, candidates, updatePreferences, saved }
}

afterEach(async () => {
  if (root !== null) await act(async () => root!.unmount())
  root = null
  container?.remove()
  container = null
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
  vi.restoreAllMocks()
})

function select(node: HTMLElement, label: string): HTMLSelectElement {
  const element = node.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  if (element === null) throw new Error(`select "${label}" missing`)
  return element
}

async function choose(node: HTMLElement, label: string, value: string): Promise<void> {
  const element = select(node, label)
  await act(async () => {
    element.value = value
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function click(node: HTMLElement, text: string): Promise<void> {
  const button = [...node.querySelectorAll('button')].find((entry) => entry.textContent === text)
  if (button === undefined) throw new Error(`button "${text}" missing`)
  await act(async () => button.click())
}

describe('compaction route card', () => {
  it('costs no request until the picker is opened', async () => {
    const { node, candidates } = await mount()
    expect(candidates).not.toHaveBeenCalled()
    expect(node.textContent).toContain(LABELS.follow)
    await click(node, LABELS.change)
    expect(candidates).toHaveBeenCalledTimes(1)
    expect([...select(node, LABELS.provider).options].map((option) => option.value)).toEqual(['', 'opendesign'])
    expect(select(node, LABELS.model).disabled).toBe(true)
  })

  it('lists the models of the chosen line', async () => {
    const { node } = await mount()
    await click(node, LABELS.change)
    await choose(node, LABELS.provider, 'opendesign')
    expect(select(node, LABELS.model).disabled).toBe(false)
    expect([...select(node, LABELS.model).options].map((option) => option.value))
      .toEqual(['', 'deepseek-v4.1-flash', 'k3'])
  })

  it('saves the pair the user chose', async () => {
    const { node, updatePreferences, saved } = await mount()
    await click(node, LABELS.change)
    await choose(node, LABELS.provider, 'opendesign')
    await choose(node, LABELS.model, 'deepseek-v4.1-flash')
    await click(node, LABELS.save)
    expect(updatePreferences).toHaveBeenCalledWith({
      compactionRoute: { provider: 'opendesign', model: 'deepseek-v4.1-flash' },
    })
    expect(saved).toHaveLength(1)
    expect(node.textContent).toContain(LABELS.saved)
  })

  it('clears back to the conversation model', async () => {
    const { node, updatePreferences } = await mount({ route: { provider: 'opendesign', model: 'k3' } })
    expect(node.textContent).toContain('opendesign / k3')
    await click(node, LABELS.change)
    await click(node, LABELS.clear)
    expect(updatePreferences).toHaveBeenCalledWith({ compactionRoute: null })
  })

  it('warns that a model without video falls back, before anything is compacted', async () => {
    const { node } = await mount()
    await click(node, LABELS.change)
    await choose(node, LABELS.provider, 'opendesign')
    await choose(node, LABELS.model, 'deepseek-v4.1-flash')
    expect(node.textContent).toContain(LABELS.noVideo)
    // A model that does declare video carries no such warning.
    await choose(node, LABELS.model, 'k3')
    expect(node.textContent).not.toContain(LABELS.noVideo)
  })

  it('shows what is configured even after every route disappears', async () => {
    const { node } = await mount({
      route: { provider: 'gone-line', model: 'gone-model' },
      candidates: { providers: [] },
    })
    expect(node.textContent).toContain('gone-line / gone-model')
    await click(node, LABELS.change)
    expect(node.textContent).toContain(LABELS.empty)
  })
})
