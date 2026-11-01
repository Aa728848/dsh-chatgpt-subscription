import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import {
  buildMinimaxRequest,
  outputConfigFor,
  thinkingFieldFor,
  TOOL_CALL_PREAMBLE_REMINDER,
} from '../src/host/minimax-code/mapper.ts'
import { effortForModel, MINIMAX_CODE_MODELS } from '../src/host/minimax-code/model-catalog.ts'

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

  it('leaves the level out of the request when the conversation picked none', () => {
    // The official catalog names no default effort for these models, and the
    // official agent sends no `output_config.effort` unless a level was
    // picked: the server's own default is what an unset level means.
    //
    // Spelling out `max` here did two things at once - it put the most
    // expensive setting on every turn that said nothing, and it said something
    // the caller never asked for.
    expect(buildMinimaxRequest(options())['output_config']).toBeUndefined()
    expect(buildMinimaxRequest(options({ model: 'MiniMax-M3' }))['output_config']).toBeUndefined()
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
    // back to the model's own default instead of travelling as itself - and
    // that default is no level at all, so an invented level is DROPPED rather
    // than silently answered with the most expensive setting.
    expect(buildMinimaxRequest(options({ reasoningEffort: effort('turbo') }))['output_config'])
      .toBeUndefined()
  })

  it('drops the temperature for a model whose thinking cannot be turned off', () => {
    // M3.1 thinks at every level, so a temperature beside it contradicts the
    // request. With no level sent, "is thinking on?" can no longer be answered
    // by the presence of `output_config` - it is answered by the model's own
    // thinking mode.
    const body = buildMinimaxRequest(options({ model: 'MiniMax-M3.1-Flash', temperature: 0.2 }))
    expect(body['temperature']).toBeUndefined()
    expect(body['output_config']).toBeUndefined()
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

describe('the level a model resolves to', () => {
  it('names no default for a model that has levels', () => {
    // The official catalog (packages/config/src/minimax-model-catalog.ts)
    // names no default effort, and this catalog now mirrors it: a model with
    // levels and no default is a model that sends no `output_config` until a
    // level is picked.
    for (const model of MINIMAX_CODE_MODELS) {
      expect(model.defaultReasoningEffort).toBeNull()
    }
    expect(MINIMAX_CODE_MODELS.find((model) => model.id === 'MiniMax-M3')?.reasoningEfforts)
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('resolves an unset, empty or unknown request to no level', () => {
    expect(effortForModel('MiniMax-M3', undefined)).toBeNull()
    expect(effortForModel('MiniMax-M3', null)).toBeNull()
    expect(effortForModel('MiniMax-M3', '   ')).toBeNull()
    expect(effortForModel('MiniMax-M3', 'turbo')).toBeNull()
    expect(effortForModel('MiniMax-M3.1-Flash', 'low')).toBe('low')
    expect(effortForModel('MiniMax-M3.1-Flash', 'none')).toBeNull()
    expect(effortForModel('a-model-this-line-does-not-serve', 'low')).toBeNull()
  })
})

describe('the tool shape on the wire', () => {
  it('asks for the tool arguments to stream eagerly', () => {
    // The official agent asks for eager input streaming on every tool: the
    // arguments can start arriving before the model finished describing the
    // call, so the tool does not wait on the description.
    const body = buildMinimaxRequest(options({
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
    }))
    const tools = body.tools as Array<Record<string, unknown>>
    expect(tools[0]).toMatchObject({ name: 't', eager_input_streaming: true })
  })

  it('states the tool-call preamble rule in a session that has tools', () => {
    const body = buildMinimaxRequest(options({
      system: 'be brief',
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
    }))
    const system = body.system as Array<{ text: string }>
    expect(system[0]!.text).toContain(TOOL_CALL_PREAMBLE_REMINDER)
    // The caller's own prompt keeps the head of the system text: it is the
    // cached prefix, and the rule is appended after it.
    expect(system[0]!.text.startsWith('be brief')).toBe(true)
  })

  it('leaves a session with no tools and no prompt without a system block', () => {
    const body = buildMinimaxRequest(options())
    expect(body.system).toBeUndefined()
    expect(body.tools).toBeUndefined()
  })
})
