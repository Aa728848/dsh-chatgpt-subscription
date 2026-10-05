import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import {
  buildMinimaxRequest,
  outputConfigFor,
} from '../src/host/minimax-code/mapper.ts'

/**
 * A reasoning effort as the request type wants it.
 *
 * The harness brands the id, so a test that wants to prove "this level is
 * accepted" cannot hand the mapper a plain string without saying so.
 */
function effort(value: string | undefined): GenerateOptions['reasoningEffort'] {
  return value as GenerateOptions['reasoningEffort']
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    model: 'MiniMax-M3.1-Flash-Preview',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hello there' }] } as Message,
    ],
    ...overrides,
  } as GenerateOptions
}

/**
 * The request shape, which is what these tests exist to pin.
 *
 * They are here because nothing asserted it before: the thinking field was
 * inferred when the line was written, shipped an undocumented shape for months,
 * and no test could have caught it - the replay suite only ever inspects the
 * RESPONSE side. A wrong request field is invisible until the service reads it
 * differently, which is exactly the failure this file is meant to make loud.
 */
describe('the thinking control on the wire', () => {
  it('never sends a thinking object', () => {
    for (const model of ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M3', 'MiniMax-M3.1-Flash-Preview']) {
      for (const level of [undefined, 'low', 'high', 'max', 'none']) {
        const body = buildMinimaxRequest(options({ model, reasoningEffort: effort(level) }))
        // MiniMax documents thinking as on by default with no configuration;
        // the only control is a top-level output_config. A `thinking` key is a
        // field this endpoint never agreed to.
        expect(body['thinking']).toBeUndefined()
      }
    }
  })

  it('sends the depth level at the top level, where the docs put it', () => {
    const body = buildMinimaxRequest(options({ reasoningEffort: effort('xhigh') }))
    expect(body['output_config']).toEqual({ effort: 'xhigh' })
  })

  it('omits the whole field when the caller picks no level', () => {
    // "When omitted, the default is max" - so the honest request for an
    // unstated level is the one that says nothing, not one that spells out max.
    expect(buildMinimaxRequest(options({ reasoningEffort: effort('default') }))['output_config']).toBeUndefined()
    expect(buildMinimaxRequest(options())['output_config']).toBeUndefined()
  })

  it('omits the level for an always-on model, which has no level to set', () => {
    for (const model of ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed']) {
      expect(outputConfigFor(model, 'low')).toBeUndefined()
      expect(outputConfigFor(model, 'none')).toBeUndefined()
    }
  })

  it('sends nothing for a toggle model that is left on', () => {
    // A request that says nothing already gets the on state, so the on state
    // is not worth a field.
    expect(buildMinimaxRequest(options({ model: 'MiniMax-M3' }))['output_config']).toBeUndefined()
  })

  it('keeps the off switch a toggle model documents', () => {
    const body = buildMinimaxRequest(options({ model: 'MiniMax-M3', reasoningEffort: effort('none') }))
    expect(body['output_config']).toEqual({ effort: 'none' })
  })

  it('accepts every documented effort level and nothing invented', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(buildMinimaxRequest(options({ reasoningEffort: effort(level) }))['output_config'])
        .toEqual({ effort: level })
    }
    // A level the model does not document must not reach the wire.
    expect(buildMinimaxRequest(options({ reasoningEffort: effort('turbo') }))['output_config']).toBeUndefined()
  })
})
