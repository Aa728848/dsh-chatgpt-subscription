import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import { buildChatRequest } from '../src/host/workbuddy/mapper.ts'

/**
 * The exact text a call that never produced a result is answered with.
 *
 * Written out here rather than imported on purpose: the whole point of the
 * placeholder is that the upstream sees this literal, so the test pins the
 * bytes instead of trusting a constant to stay put.
 */
const NO_RESULT = '[no result: the tool call did not complete]'

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } as unknown as Message
}

function assistantMessage(blocks: any[], model = 'glm-5.3'): Message {
  return {
    role: 'assistant',
    content: blocks,
    source: { kind: 'model', provider: 'workbuddy', model },
  } as unknown as Message
}

/** A tool result in the vocabulary the adapter normalizes to. */
function toolResult(callId: string, text: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
    source: { kind: 'tool', callId },
  } as unknown as Message
}

function call(id: string, name = 'read_file', args = '{}'): Record<string, unknown> {
  return { type: 'tool-call', id, name, arguments: args }
}

function options(overrides: Record<string, unknown> = {}): GenerateOptions {
  // Loose on purpose: `reasoningEffort` is a branded id upstream, and what these
  // tests care about is the plain wire object that reaches the request body.
  return {
    provider: 'workbuddy',
    model: 'glm-5.3',
    messages: [userMessage('hello')],
    ...overrides,
  } as unknown as GenerateOptions
}

function wire(overrides: Record<string, unknown> = {}): Array<Record<string, any>> {
  return buildChatRequest(options(overrides)).messages as Array<Record<string, any>>
}

const SYSTEM = { role: 'system', content: 'You are a helpful assistant.' }

describe('WorkBuddy history repair: split parallel batches', () => {
  it('merges two adjacent assistant turns that each carry tool calls into one turn', () => {
    // A parallel batch the harness serialized as two assistant turns. An
    // upstream that allows one assistant turn per batch rejects every later
    // turn of the conversation, so the two turns must leave as one.
    const messages = wire({
      messages: [
        userMessage('go'),
        assistantMessage([call('call_1', 'read_file', '{"path":"a.txt"}')]),
        assistantMessage([call('call_2', 'read_file', '{"path":"b.txt"}')]),
        toolResult('call_1', 'first'),
        toolResult('call_2', 'second'),
      ],
    })

    expect(messages).toEqual([
      SYSTEM,
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
          { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'first' },
      { role: 'tool', tool_call_id: 'call_2', content: 'second' },
    ])
  })

  it('concatenates the text of the merged turns and keeps the call order', () => {
    const messages = wire({
      messages: [
        userMessage('go'),
        assistantMessage([{ type: 'text', text: 'let me look' }, call('call_1')]),
        assistantMessage([call('call_2'), { type: 'text', text: ' and again' }]),
        toolResult('call_1', 'first'),
        toolResult('call_2', 'second'),
      ],
    })

    expect(messages[2]).toEqual({
      role: 'assistant',
      content: 'let me look and again',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ],
    })
  })

  it('does not merge two assistant turns that a tool result separates', () => {
    // The merge is for one batch that was split, not for two real turns: a
    // result between them proves they are separate exchanges.
    const messages = wire({
      messages: [
        userMessage('go'),
        assistantMessage([call('call_1')]),
        toolResult('call_1', 'first'),
        assistantMessage([call('call_2')]),
        toolResult('call_2', 'second'),
      ],
    })

    expect(messages).toEqual([
      SYSTEM,
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'first' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_2', content: 'second' },
    ])
  })
})

describe('WorkBuddy history repair: tool calls that never returned', () => {
  it('answers an unanswered call with the placeholder text, after the results that did arrive', () => {
    const messages = wire({
      messages: [
        userMessage('go'),
        assistantMessage([call('call_1'), call('call_2', 'write_file')]),
        toolResult('call_1', 'first'),
      ],
    })

    expect(messages).toEqual([
      SYSTEM,
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'write_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'first' },
      { role: 'tool', tool_call_id: 'call_2', content: NO_RESULT },
    ])
  })

  it('fills each assistant turn from its own calls only, never from an earlier turn', () => {
    // The window is "until the next assistant turn": call_1 already has its
    // result and must not be answered twice, and call_2 has none.
    const messages = wire({
      messages: [
        userMessage('go'),
        assistantMessage([call('call_1')]),
        toolResult('call_1', 'first'),
        userMessage('next'),
        assistantMessage([call('call_2')]),
      ],
    })

    expect(messages).toEqual([
      SYSTEM,
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'first' },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_2', content: NO_RESULT },
    ])
  })

  it('answers the missing call before the user message a tool-result image rides', () => {
    // A tool-result image cannot travel in the `tool` message, so it rides its
    // own `user` turn. A placeholder wedged after that turn would break the run
    // of tool messages the upstream wants, so it goes before it.
    const messages = wire({
      messages: [
        userMessage('go'),
        assistantMessage([call('call_1'), call('call_2')]),
        {
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: 'call_1',
            content: [
              { type: 'text', text: 'shot' },
              { type: 'image', attachment: { attachmentId: 'a1', name: 'shot.png', bytes: 10, mediaType: 'image/png' } },
            ],
          }],
          source: { kind: 'tool', callId: 'call_1' },
        } as unknown as Message,
      ],
    })

    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user'])
    expect(messages.slice(3, 5)).toEqual([
      // The image is named inside the tool text; its pixels ride the user turn.
      { role: 'tool', tool_call_id: 'call_1', content: 'shot[image: shot.png]' },
      { role: 'tool', tool_call_id: 'call_2', content: NO_RESULT },
    ])
  })

  it('answers a call whose turn was merged from a split batch', () => {
    // Both repairs together: the merged turn declares two calls, one of which
    // never returned.
    const messages = wire({
      messages: [
        userMessage('go'),
        assistantMessage([call('call_1')]),
        assistantMessage([call('call_2')]),
        toolResult('call_2', 'second'),
      ],
    })

    expect(messages).toEqual([
      SYSTEM,
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_2', content: 'second' },
      { role: 'tool', tool_call_id: 'call_1', content: NO_RESULT },
    ])
  })
})

describe('WorkBuddy reasoning_content backfill', () => {
  const deepseek = {
    model: 'deepseek-v4.1-flash',
    messages: [
      userMessage('go'),
      assistantMessage([call('call_1')], 'deepseek-v4.1-flash'),
      toolResult('call_1', 'first'),
    ],
  }

  it('never invents a reasoning_content, measured as not required on both deployments', () => {
    // Provenance: scripts/probe-workbuddy-assumptions.probe.ts sent this exact
    // history — an assistant turn carrying tool_calls and no reasoning text —
    // with and without `reasoning_content: ""` against BOTH backends. All four
    // answered 200, and the reply's reasoning length varied on both sides
    // (0/31/0/34 with the field, 7/45/18/31 without), so the field is neither
    // required nor an influence. What this line sends is what it was measured to
    // accept: nothing extra.
    const messages = wire({ ...deepseek, reasoningEffort: 'high' })

    expect(messages).toEqual([
      SYSTEM,
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'first' },
    ])
  })

  it('leaves the field out when thinking is off, for the same model', () => {
    const body = buildChatRequest(options({ ...deepseek, reasoningEffort: 'none' }))
    expect(body.reasoning_effort).toBe('none')
    expect((body.messages as Array<Record<string, any>>)[2]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    })
  })

  it('leaves the field out for a model outside the deepseek family', () => {
    const body = buildChatRequest(options({
      reasoningEffort: 'high',
      messages: [userMessage('go'), assistantMessage([call('call_1')]), toolResult('call_1', 'first')],
    }))
    expect(body.reasoning_effort).toBe('high')
    expect((body.messages as Array<Record<string, any>>)[2]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    })
  })

  it('leaves the field out for deepseek when no reasoning_effort is sent at all', () => {
    const messages = wire(deepseek)
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    })
  })
})

describe('WorkBuddy unchanged wire shape', () => {
  it('keeps a plain single-batch conversation byte-identical to the pre-repair output', () => {
    // Nothing in this history triggers a repair, so the exact JSON must not
    // move: same order, same keys, no added field.
    const plain = {
      messages: [
        userMessage('hello'),
        assistantMessage([call('call_1', 'read_file', '{"path":"a.txt"}')]),
        toolResult('call_1', 'first'),
        userMessage('and then?'),
      ],
    }
    const pinned = '[{"role":"system","content":"You are a helpful assistant."},'
      + '{"role":"user","content":"hello"},'
      + '{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function",'
      + '"function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]},'
      + '{"role":"tool","tool_call_id":"call_1","content":"first"},'
      + '{"role":"user","content":"and then?"}]'

    expect(JSON.stringify(buildChatRequest(options(plain)).messages)).toBe(pinned)
    // The same history on a deepseek model without a reasoning effort is also
    // untouched: the backfill needs both conditions, not one.
    expect(JSON.stringify(buildChatRequest(options({ ...plain, model: 'deepseek-v4.1-flash' })).messages))
      .toBe(pinned)
  })
})
