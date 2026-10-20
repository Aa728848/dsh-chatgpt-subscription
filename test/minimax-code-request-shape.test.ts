import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import {
  buildMinimaxRequest,
  outputConfigFor,
  thinkingFieldFor,
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
    model: 'MiniMax-M3.1-Flash',
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
 *
 * The shapes below are the ones MEASURED on this subscription endpoint on
 * 2026-10-20 (scripts/probe-minimax-thinking-channels.probe.ts):
 *
 * | request | response block | where the reasoning lands |
 * | --- | --- | --- |
 * | no `thinking` field | `text` | in the answer text |
 * | `thinking: { type: 'adaptive' }` | `thinking` | in a thinking block |
 *
 * So the `thinking` object is not decoration: it is what puts the reasoning in
 * the channel the harness renders as reasoning and the interleaved-thinking
 * replay can replay. A forced-on model (M3.1) answers in that channel either
 * way, which is why only the switchable one needs the object.
 */
describe('the thinking control on the wire', () => {
  it('asks a switchable model for the thinking channel', () => {
    const body = buildMinimaxRequest(options({ model: 'MiniMax-M3' }))
    expect(body['thinking']).toEqual({ type: 'adaptive' })
  })

  it('leaves a forced-on model without a thinking object', () => {
    // M3.1 answers in the thinking channel whatever the request says, so the
    // object would be a field the service does not need.
    for (const level of [undefined, 'low', 'max']) {
      const body = buildMinimaxRequest(options({ model: 'MiniMax-M3.1-Flash', reasoningEffort: effort(level) }))
      expect(body['thinking']).toBeUndefined()
    }
  })

  it('says nothing at all for an always-on model', () => {
    for (const level of [undefined, 'low', 'max', 'none']) {
      const body = buildMinimaxRequest(options({ model: 'MiniMax-M2.7', reasoningEffort: effort(level) }))
      expect(body['thinking']).toBeUndefined()
      expect(body['output_config']).toBeUndefined()
    }
  })

  it('sends the depth level at the top level, where the docs put it', () => {
    const body = buildMinimaxRequest(options({ reasoningEffort: effort('xhigh') }))
    expect(body['output_config']).toEqual({ effort: 'xhigh' })
  })

  it('states the default level instead of leaving it to the server', () => {
    // The docs say an omitted effort means max, so the old local 'default'
    // spelling was dropped before sending - and every request silently ran at
    // the most expensive level. The models now name their default outright.
    expect(buildMinimaxRequest(options())['output_config']).toEqual({ effort: 'max' })
    expect(buildMinimaxRequest(options({ model: 'MiniMax-M3' }))['output_config']).toEqual({ effort: 'max' })
  })

  it('turns thinking off with the disabled object, and carries no level beside it', () => {
    const body = buildMinimaxRequest(options({ model: 'MiniMax-M3', reasoningEffort: effort('none') }))
    expect(body['thinking']).toEqual({ type: 'disabled' })
    expect(body['output_config']).toBeUndefined()
  })

  it('cannot turn a forced-on model off, and says nothing when asked to', () => {
    // Measured: M3.1 keeps thinking whatever 'none' says, so the honest
    // request is the one that states no level at all.
    const body = buildMinimaxRequest(options({ model: 'MiniMax-M3.1-Flash', reasoningEffort: effort('none') }))
    expect(body['thinking']).toBeUndefined()
    expect(body['output_config']).toBeUndefined()
  })

  it('accepts every documented effort level and nothing invented', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(buildMinimaxRequest(options({ reasoningEffort: effort(level) }))['output_config'])
        .toEqual({ effort: level })
    }
    // A level the model does not document must not reach the wire: it falls
    // back to the model's own default instead of travelling as itself.
    expect(buildMinimaxRequest(options({ reasoningEffort: effort('turbo') }))['output_config'])
      .toEqual({ effort: 'max' })
  })

  it('offers no level for a model that has none', () => {
    expect(outputConfigFor('MiniMax-M2.7', 'low')).toBeUndefined()
    expect(outputConfigFor('MiniMax-M2.7', 'none')).toBeUndefined()
    expect(thinkingFieldFor('MiniMax-M2.7', 'low')).toBeUndefined()
  })

  it('drops the temperature only while thinking is actually on', () => {
    const on = buildMinimaxRequest(options({ model: 'MiniMax-M3', temperature: 0.2 }))
    expect(on['temperature']).toBeUndefined()
    const off = buildMinimaxRequest(options({ model: 'MiniMax-M3', temperature: 0.2, reasoningEffort: effort('none') }))
    expect(off['temperature']).toBe(0.2)
  })
})
