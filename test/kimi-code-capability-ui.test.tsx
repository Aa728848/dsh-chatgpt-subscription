// @vitest-environment jsdom
/**
 * Layout tests for the Kimi capability table.
 *
 * The first revision rendered capability prose inline beside each model name,
 * which stretched the name column and misaligned the descriptions. These pin
 * the structure that replaced it: one column per capability, short tags, and a
 * per-model hover carrying the detail.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { KimiCodeModelOption } from '../src/shared/kimi-code-contracts.ts'
import { KimiModelCapabilities } from '../src/client/kimi-code/KimiModelCapabilities.tsx'

function model(overrides: Partial<KimiCodeModelOption> = {}): KimiCodeModelOption {
  return {
    id: 'k3',
    name: 'K3',
    enabled: true,
    defaultContextWindow: 262144,
    contextWindow: 262144,
    defaultMaxTokens: 32768,
    wire: 'openai',
    description: 'Flagship model',
    supportsVideo: true,
    supportsDynamicTools: true,
    minimumPlan: 'Moderato',
    ...overrides,
  }
}

describe('Kimi capability table', () => {
  it('renders one row per model with a column for each capability', () => {
    const html = renderToStaticMarkup(<KimiModelCapabilities models={[
      model(),
      model({ id: 'k3-256k', name: 'K3 (256K)', supportsVideo: false }),
    ]} />)
    // Four columns: name, multimodal, dynamic tools, notes.
    expect((html.match(/<th>/g) ?? [])).toHaveLength(4)
    expect((html.match(/<tr>/g) ?? [])).toHaveLength(3)
  })

  it('uses short tags and no explanatory prose anywhere', () => {
    const html = renderToStaticMarkup(<KimiModelCapabilities models={[model()]} />)
    expect(html).toContain('dsha-cap-on')
    // The table explains itself through its columns; a paragraph of prose here
    // was removed on request, and long text must not creep back into a cell.
    expect(html).not.toContain('dsha-cap-hint')
    expect(html).not.toContain('前缀缓存')
    expect(html).not.toContain('dynamically_loaded_tools')
  })

  it('distinguishes video from dynamic tools per model', () => {
    const html = renderToStaticMarkup(<KimiModelCapabilities models={[
      model({ id: 'highspeed', name: 'HighSpeed', supportsVideo: true, supportsDynamicTools: false }),
      model({ id: 'k3-256k', name: 'K3 (256K)', supportsVideo: false, supportsDynamicTools: true }),
    ]} />)
    // Counted inside the body only: the column headers reuse two of these
    // labels, so a whole-document count would over-report them.
    const body = html.slice(html.indexOf('<tbody>'))
    expect((body.match(/>视频</g) ?? [])).toHaveLength(1)
    expect((body.match(/>仅图片</g) ?? [])).toHaveLength(1)
    expect((body.match(/>动态工具</g) ?? [])).toHaveLength(1)
    expect((body.match(/>—</g) ?? [])).toHaveLength(1)
  })

  it('keeps wire, effort and plan facts in the hover title, not the cells', () => {
    const html = renderToStaticMarkup(<KimiModelCapabilities models={[
      model({ defaultReasoningEffort: 'high' }),
    ]} />)
    const title = /title="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(title).toContain('k3')
    expect(title).toContain('Moderato')
    expect(title).toContain('high')
  })

  it('renders an empty notes cell rather than the word null', () => {
    const html = renderToStaticMarkup(<KimiModelCapabilities models={[model({ description: null })]} />)
    expect(html).not.toContain('null')
  })
})
