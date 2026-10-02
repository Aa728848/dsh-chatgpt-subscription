import { describe, expect, it } from 'vitest'
import {
  buildMinimaxRequest,
  closeMinimaxStream,
  createStreamState,
  processMinimaxStreamLine,
} from '../src/host/minimax-code/mapper.ts'
import {
  MinimaxCodeAdapter,
} from '../src/host/minimax-code/adapter.ts'
import {
  computeMinimaxAuthOwner,
  PROVIDER_ID,
} from '../src/host/minimax-code/types.ts'

describe('minimax thinking replay', () => {
  it('replays the trace and signature with scoped provenance and native ordering', () => {
    const authOwner = 'auth-owner-hash-1'
    const state = createStreamState({ model: 'minimax-M3', authOwner, route: PROVIDER_ID })
    const send = (event: unknown) => processMinimaxStreamLine('data: ' + JSON.stringify(event), state)
    const out = [
      ...send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'first I check' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' the file' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }),
      ...send({ type: 'content_block_stop', index: 0 }),
      ...send({ type: 'message_stop' }),
      ...closeMinimaxStream(state),
    ]

    const finish = out.find(chunk => chunk.type === 'finish') as { replayState?: any } | undefined
    expect(finish?.replayState).toEqual({
      response: {
        provider: PROVIDER_ID,
        route: PROVIDER_ID,
        model: 'minimax-M3',
        authOwner,
        visibleContentHash: expect.any(String),
        minimaxThinking: [{ type: 'thinking', thinking: 'first I check the file', signature: 'sig-abc' }],
      },
      blocks: [
        { type: 'thinking', thinking: 'first I check the file', signature: 'sig-abc' },
      ],
    })

    const replayed = buildMinimaxRequest(
      {
        provider: PROVIDER_ID,
        model: 'minimax-M3',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          {
            role: 'assistant',
            content: [{ type: 'reasoning', text: 'first I check the file' }],
            source: { kind: 'dsh-chatgpt-subscription', replayState: finish?.replayState },
          },
          {
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: 't1', content: [{ type: 'text', text: 'done' }] }],
            source: { kind: 'tool', callId: 't1' },
          },
        ],
      } as never,
      undefined,
      { authOwner, route: PROVIDER_ID },
    )

    const messages = replayed.messages as Array<{ role: string; content: unknown[] }>
    const assistant = messages.find(message => message.role === 'assistant')
    expect(assistant?.content?.[0]).toEqual({
      type: 'thinking',
      thinking: 'first I check the file',
      signature: 'sig-abc',
    })
  })

  it('preserves native block ordering with interleaved text, thinking, and tool-call blocks', () => {
    const authOwner = 'auth-owner-hash-interleaved'
    const state = createStreamState({ model: 'minimax-M3', authOwner, route: PROVIDER_ID })
    const send = (event: unknown) => processMinimaxStreamLine('data: ' + JSON.stringify(event), state)

    // Stream: text (0) -> thinking (1) -> tool_use (2)
    const out = [
      ...send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'prefix text' } }),
      ...send({ type: 'content_block_stop', index: 0 }),
      ...send({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }),
      ...send({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'interleaved thought' } }),
      ...send({ type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig-interleaved' } }),
      ...send({ type: 'content_block_stop', index: 1 }),
      ...send({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} } }),
      ...send({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":"cat"}' } }),
      ...send({ type: 'content_block_stop', index: 2 }),
      ...send({ type: 'message_stop' }),
      ...closeMinimaxStream(state),
    ]

    const finish = out.find(chunk => chunk.type === 'finish') as { replayState?: any } | undefined
    expect(finish?.replayState.blocks).toHaveLength(3)
    expect(finish?.replayState.blocks[0]).toBeNull()
    expect(finish?.replayState.blocks[1]).toEqual({
      type: 'thinking',
      thinking: 'interleaved thought',
      signature: 'sig-interleaved',
    })
    expect(finish?.replayState.blocks[2]).toBeNull()

    // Next turn request with text before reasoning before tool-call
    const replayed = buildMinimaxRequest(
      {
        provider: PROVIDER_ID,
        model: 'minimax-M3',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'prefix text' },
              { type: 'reasoning', text: 'interleaved thought' },
              { type: 'tool-call', id: 'toolu_1', name: 'search', arguments: '{"q":"cat"}' },
            ],
            source: { kind: 'model', replayState: finish?.replayState },
          },
        ],
      } as never,
      undefined,
      { authOwner, route: PROVIDER_ID },
    )

    const messages = replayed.messages as Array<{ role: string; content: Array<{ type: string }> }>
    const assistant = messages.find(message => message.role === 'assistant')
    // Crucial check: native order is text, THEN thinking, THEN tool_use (NOT prepended!)
    expect(assistant?.content.map(b => b.type)).toEqual(['text', 'thinking', 'tool_use'])
    expect(assistant?.content[0]).toEqual({ type: 'text', text: 'prefix text' })
    expect(assistant?.content[1]).toEqual({
      type: 'thinking',
      thinking: 'interleaved thought',
      signature: 'sig-interleaved',
    })
    expect(assistant?.content[2]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'search',
      input: { q: 'cat' },
    })
  })

  it('preserves native ordering in multi-turn tool loops', () => {
    const authOwner = 'auth-owner-loop'
    // Turn 1: thinking + tool_use
    const state1 = createStreamState({ model: 'minimax-M3', authOwner, route: PROVIDER_ID })
    const send1 = (event: unknown) => processMinimaxStreamLine('data: ' + JSON.stringify(event), state1)
    const out1 = [
      ...send1({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ...send1({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'call tool' } }),
      ...send1({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } }),
      ...send1({ type: 'content_block_stop', index: 0 }),
      ...send1({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_t1', name: 'calc', input: {} } }),
      ...send1({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"n":1}' } }),
      ...send1({ type: 'content_block_stop', index: 1 }),
      ...send1({ type: 'message_stop' }),
      ...closeMinimaxStream(state1),
    ]
    const finish1 = out1.find(c => c.type === 'finish') as { replayState?: any }

    // Turn 2: thinking + text
    const state2 = createStreamState({ model: 'minimax-M3', authOwner, route: PROVIDER_ID })
    const send2 = (event: unknown) => processMinimaxStreamLine('data: ' + JSON.stringify(event), state2)
    const out2 = [
      ...send2({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ...send2({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'got result' } }),
      ...send2({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-2' } }),
      ...send2({ type: 'content_block_stop', index: 0 }),
      ...send2({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      ...send2({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'finished' } }),
      ...send2({ type: 'content_block_stop', index: 1 }),
      ...send2({ type: 'message_stop' }),
      ...closeMinimaxStream(state2),
    ]
    const finish2 = out2.find(c => c.type === 'finish') as { replayState?: any }

    // Request for Turn 3 with history
    const replayed = buildMinimaxRequest(
      {
        provider: PROVIDER_ID,
        model: 'minimax-M3',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'do calc' }] },
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'call tool' },
              { type: 'tool-call', id: 'call_t1', name: 'calc', arguments: '{"n":1}' },
            ],
            source: { kind: 'model', replayState: finish1?.replayState },
          },
          {
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: 'call_t1', content: [{ type: 'text', text: '2' }] }],
            source: { kind: 'tool', callId: 'call_t1' },
          },
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'got result' },
              { type: 'text', text: 'finished' },
            ],
            source: { kind: 'model', replayState: finish2?.replayState },
          },
        ],
      } as never,
      undefined,
      { authOwner, route: PROVIDER_ID },
    )

    const messages = replayed.messages as Array<{ role: string; content: Array<{ type: string }> }>
    const assistants = messages.filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0]?.content.map(b => b.type)).toEqual(['thinking', 'tool_use'])
    expect(assistants[1]?.content.map(b => b.type)).toEqual(['thinking', 'text'])
  })

  it('fails safely and omits thinking blocks when model is switched', () => {
    const authOwner = 'owner-model-switch'
    const state = createStreamState({ model: 'minimax-M3', authOwner, route: PROVIDER_ID })
    const send = (event: unknown) => processMinimaxStreamLine('data: ' + JSON.stringify(event), state)
    const out = [
      ...send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'm3 thought' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-m3' } }),
      ...send({ type: 'content_block_stop', index: 0 }),
      ...send({ type: 'message_stop' }),
      ...closeMinimaxStream(state),
    ]
    const finish = out.find(c => c.type === 'finish') as { replayState?: any }

    // Request asks for a DIFFERENT model 'minimax-M3.1'
    const replayed = buildMinimaxRequest(
      {
        provider: PROVIDER_ID,
        model: 'minimax-M3.1',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          {
            role: 'assistant',
            content: [{ type: 'reasoning', text: 'm3 thought' }],
            source: { kind: 'model', replayState: finish?.replayState },
          },
        ],
      } as never,
      undefined,
      { authOwner, route: PROVIDER_ID },
    )

    const messages = replayed.messages as Array<{ role: string; content: unknown[] }>
    const assistant = messages.find(m => m.role === 'assistant')
    // Must NOT reuse state when model mismatched
    expect(assistant?.content ?? []).toEqual([])
  })

  it('fails safely and omits thinking blocks when account (authOwner) is switched', () => {
    const state = createStreamState({ model: 'minimax-M3', authOwner: 'account-A', route: PROVIDER_ID })
    const send = (event: unknown) => processMinimaxStreamLine('data: ' + JSON.stringify(event), state)
    const out = [
      ...send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'account A thought' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-A' } }),
      ...send({ type: 'content_block_stop', index: 0 }),
      ...send({ type: 'message_stop' }),
      ...closeMinimaxStream(state),
    ]
    const finish = out.find(c => c.type === 'finish') as { replayState?: any }

    // Request is made by account-B
    const replayed = buildMinimaxRequest(
      {
        provider: PROVIDER_ID,
        model: 'minimax-M3',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          {
            role: 'assistant',
            content: [{ type: 'reasoning', text: 'account A thought' }],
            source: { kind: 'model', replayState: finish?.replayState },
          },
        ],
      } as never,
      undefined,
      { authOwner: 'account-B', route: PROVIDER_ID },
    )

    const messages = replayed.messages as Array<{ role: string; content: unknown[] }>
    const assistant = messages.find(m => m.role === 'assistant')
    // Must NOT reuse state across different accounts
    expect(assistant?.content ?? []).toEqual([])
  })

  it('fails safely on legacy unscoped replayState', () => {
    const legacyState = {
      response: {
        minimaxThinking: [{ type: 'thinking', thinking: 'unscoped', signature: 'sig-unscoped' }],
      },
    }

    const replayed = buildMinimaxRequest(
      {
        provider: PROVIDER_ID,
        model: 'minimax-M3',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          {
            role: 'assistant',
            content: [{ type: 'reasoning', text: 'unscoped' }],
            source: { kind: 'model', replayState: legacyState },
          },
        ],
      } as never,
      undefined,
      { authOwner: 'current-owner', route: PROVIDER_ID },
    )

    const messages = replayed.messages as Array<{ role: string; content: unknown[] }>
    const assistant = messages.find(m => m.role === 'assistant')
    expect(assistant?.content ?? []).toEqual([])
  })

  it('handles streamed redacted_thinking blocks and signatures', () => {
    const authOwner = 'owner-redacted'
    const state = createStreamState({ model: 'minimax-M3', authOwner, route: PROVIDER_ID })
    const send = (event: unknown) => processMinimaxStreamLine('data: ' + JSON.stringify(event), state)
    const out = [
      ...send({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'redacted_thinking', data: 'encrypted-base64-blob' },
      }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-redacted-xyz' } }),
      ...send({ type: 'content_block_stop', index: 0 }),
      ...send({ type: 'message_stop' }),
      ...closeMinimaxStream(state),
    ]

    const finish = out.find(chunk => chunk.type === 'finish') as { replayState?: any }
    expect(finish?.replayState.blocks[0]).toEqual({
      type: 'redacted_thinking',
      data: 'encrypted-base64-blob',
      signature: 'sig-redacted-xyz',
    })

    const replayed = buildMinimaxRequest(
      {
        provider: PROVIDER_ID,
        model: 'minimax-M3',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'run' }] },
          {
            role: 'assistant',
            content: [{ type: 'reasoning', text: '' }],
            source: { kind: 'model', replayState: finish?.replayState },
          },
        ],
      } as never,
      undefined,
      { authOwner, route: PROVIDER_ID },
    )

    const messages = replayed.messages as Array<{ role: string; content: unknown[] }>
    const assistant = messages.find(m => m.role === 'assistant')
    expect(assistant?.content[0]).toEqual({
      type: 'redacted_thinking',
      data: 'encrypted-base64-blob',
      signature: 'sig-redacted-xyz',
    })
  })

  it('preserves extra wire metadata via clone on replay', () => {
    const authOwner = 'owner-metadata-check'
    const state = createStreamState({ model: 'minimax-M3', authOwner, route: PROVIDER_ID })
    const send = (event: unknown) => processMinimaxStreamLine('data: ' + JSON.stringify(event), state)
    const out = [
      ...send({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'thinking',
          thinking: '',
          upstream_id: 'meta-1234',
          tier_flag: 'pro',
        },
      }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'special thought' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-meta' } }),
      ...send({ type: 'content_block_stop', index: 0 }),
      ...send({ type: 'message_stop' }),
      ...closeMinimaxStream(state),
    ]
    const finish = out.find(c => c.type === 'finish') as { replayState?: any }
    expect(finish?.replayState.blocks[0]).toMatchObject({
      upstream_id: 'meta-1234',
      tier_flag: 'pro',
    })

    const replayed = buildMinimaxRequest(
      {
        provider: PROVIDER_ID,
        model: 'minimax-M3',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          {
            role: 'assistant',
            content: [{ type: 'reasoning', text: 'special thought' }],
            source: { kind: 'model', replayState: finish?.replayState },
          },
        ],
      } as never,
      undefined,
      { authOwner, route: PROVIDER_ID },
    )

    const messages = replayed.messages as Array<{ role: string; content: any[] }>
    const assistant = messages.find(m => m.role === 'assistant')
    expect(assistant?.content[0]).toMatchObject({
      type: 'thinking',
      thinking: 'special thought',
      signature: 'sig-meta',
      upstream_id: 'meta-1234',
      tier_flag: 'pro',
    })
  })

  it('safely drops block when reasoning text was compacted or mismatched', () => {
    const authOwner = 'owner-content-check'
    const state = createStreamState({ model: 'minimax-M3', authOwner, route: PROVIDER_ID })
    const send = (event: unknown) => processMinimaxStreamLine('data: ' + JSON.stringify(event), state)
    const out = [
      ...send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'original thought' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-original' } }),
      ...send({ type: 'content_block_stop', index: 0 }),
      ...send({ type: 'message_stop' }),
      ...closeMinimaxStream(state),
    ]
    const finish = out.find(c => c.type === 'finish') as { replayState?: any }

    // History has altered/compacted reasoning text that does not match candidate thinking text
    const replayed = buildMinimaxRequest(
      {
        provider: PROVIDER_ID,
        model: 'minimax-M3',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          {
            role: 'assistant',
            content: [{ type: 'reasoning', text: 'altered compacted text' }],
            source: { kind: 'model', replayState: finish?.replayState },
          },
        ],
      } as never,
      undefined,
      { authOwner, route: PROVIDER_ID },
    )

    const messages = replayed.messages as Array<{ role: string; content: unknown[] }>
    const assistant = messages.find(m => m.role === 'assistant')
    expect(assistant?.content ?? []).toEqual([])
  })

  it('adapter rebuilds body on 401 renewal, omitting prior thinking when owner changes and scoping finish to new owner', async () => {
    const capturedBodies: any[] = []
    const tokens = ['initial-token-1', 'renewed-token-2']
    let currentTokenIndex = 0

    // Account pool mock with getEffectiveCredential and renewCredential
    const mockPool = {
      getEffectiveCredential: async () => ({
        account: { id: 'account-1' },
        credentials: {
          accessToken: tokens[currentTokenIndex],
          refreshToken: 'ref-tok',
          region: 'cn',
          source: 'file',
          loginEpoch: 'epoch-1',
          recordKey: null,
        },
      }),
      renewCredential: async (accId: string) => {
        expect(accId).toBe('account-1')
        currentTokenIndex = 1
        return {
          accessToken: tokens[1],
          refreshToken: 'ref-tok-2',
          region: 'cn',
          source: 'file',
          loginEpoch: 'epoch-1',
          recordKey: null,
        }
      },
    } as any

    const initialOwner = computeMinimaxAuthOwner(
      { accessToken: tokens[0], region: 'cn', loginEpoch: 'epoch-1' } as any,
      'account-1',
    )
    const renewedOwner = computeMinimaxAuthOwner(
      { accessToken: tokens[1], region: 'cn', loginEpoch: 'epoch-1' } as any,
      'account-1',
    )
    expect(initialOwner).not.toBe(renewedOwner)

    // Produce real Turn 1 stream output with valid visibleContentHash
    const historyState = createStreamState({ model: 'minimax-M3', authOwner: initialOwner, route: PROVIDER_ID })
    const sendHist = (event: unknown) => processMinimaxStreamLine('data: ' + JSON.stringify(event), historyState)
    const histOut = [
      ...sendHist({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ...sendHist({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thought from initial turn' } }),
      ...sendHist({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-init' } }),
      ...sendHist({ type: 'content_block_stop', index: 0 }),
      ...sendHist({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      ...sendHist({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done step 1' } }),
      ...sendHist({ type: 'content_block_stop', index: 1 }),
      ...sendHist({ type: 'message_stop' }),
      ...closeMinimaxStream(historyState),
    ]
    const historyFinish = histOut.find(c => c.type === 'finish') as { replayState?: any }

    // History contains an assistant turn with replayState bound to initialOwner
    const historyMessages = [
      { role: 'user', content: [{ type: 'text', text: 'step 1' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thought from initial turn' },
          { type: 'text', text: 'done step 1' },
        ],
        source: {
          kind: 'model',
          replayState: historyFinish.replayState,
        },
      },
      { role: 'user', content: [{ type: 'text', text: 'step 2' }] },
    ]

    const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const bodyStr = init?.body ? String(init.body) : ''
      const parsedBody = bodyStr ? JSON.parse(bodyStr) : undefined
      capturedBodies.push({
        url: String(url),
        headers: init?.headers,
        body: parsedBody,
      })

      // Attempt 0: rejected with 401
      if (capturedBodies.length === 1) {
        return new Response(JSON.stringify({ code: 401, message: 'token expired' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }

      // Attempt 1: succeeds with real SSE
      const sseData = [
        'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10 } } }) + '\n\n',
        'data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) + '\n\n',
        'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'fresh thought' } }) + '\n\n',
        'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-fresh' } }) + '\n\n',
        'data: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n',
        'data: ' + JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) + '\n\n',
        'data: ' + JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'step 2 done' } }) + '\n\n',
        'data: ' + JSON.stringify({ type: 'content_block_stop', index: 1 }) + '\n\n',
        'data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) + '\n\n',
        'data: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n',
      ].join('')

      return new Response(sseData, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }

    const adapter = new MinimaxCodeAdapter({} as any, {
      fetchFn: mockFetch as any,
      accountPool: mockPool,
    })

    const chunks: any[] = []
    for await (const chunk of adapter.stream({
      provider: PROVIDER_ID,
      model: 'minimax-M3',
      messages: historyMessages as any,
    } as any)) {
      chunks.push(chunk)
    }

    // Proves two attempts: initial followed by renewed retry
    expect(capturedBodies).toHaveLength(2)

    // Attempt 0 body was built with initialOwner -> MUST include prior thinking block
    const attempt0Assistant = capturedBodies[0].body.messages.find((m: any) => m.role === 'assistant')
    expect(attempt0Assistant.content.some((b: any) => b.type === 'thinking')).toBe(true)

    // Attempt 1 body was REBUILT with renewedOwner -> MUST OMIT old-owner thinking block
    const attempt1Assistant = capturedBodies[1].body.messages.find((m: any) => m.role === 'assistant')
    expect(attempt1Assistant.content.some((b: any) => b.type === 'thinking')).toBe(false)

    // Stream finish chunk MUST carry renewedOwner
    const finish = chunks.find(c => c.type === 'finish')
    expect(finish?.replayState).toBeDefined()
    expect(finish.replayState.response.authOwner).toBe(renewedOwner)
    expect(finish.replayState.blocks[0]).toEqual({
      type: 'thinking',
      thinking: 'fresh thought',
      signature: 'sig-fresh',
    })
  })
  it('rejects replay when content hash mismatches due to tool replacement or source.model mismatch', () => {
    const authOwner = 'owner-hash-guard'
    const state = createStreamState({ model: 'minimax-M3', authOwner, route: PROVIDER_ID })
    const send = (event: unknown) => processMinimaxStreamLine('data: ' + JSON.stringify(event), state)
    const out = [
      ...send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'calc thought' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-calc' } }),
      ...send({ type: 'content_block_stop', index: 0 }),
      ...send({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'calc', input: {} } }),
      ...send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } }),
      ...send({ type: 'content_block_stop', index: 1 }),
      ...send({ type: 'message_stop' }),
      ...closeMinimaxStream(state),
    ]
    const finish = out.find(c => c.type === 'finish') as { replayState?: any }
    expect(finish?.replayState.response.visibleContentHash).toBeDefined()

    // Case 1: Tool call has been replaced with another same-length tool call (e.g. diff arguments)
    const replacedToolRequest = buildMinimaxRequest(
      {
        provider: PROVIDER_ID,
        model: 'minimax-M3',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'calc thought' },
              { type: 'tool-call', id: 'call_1', name: 'calc', arguments: '{"x":9}' }, // altered args!
            ],
            source: { kind: 'model', replayState: finish?.replayState },
          },
        ],
      } as never,
      undefined,
      { authOwner, route: PROVIDER_ID },
    )
    const replacedAssistant = (replacedToolRequest.messages as any[]).find(m => m.role === 'assistant')
    expect(replacedAssistant?.content.some((b: any) => b.type === 'thinking')).toBe(false)

    // Case 2: source.model is declared and mismatches expectedScope.model
    const modelMismatchRequest = buildMinimaxRequest(
      {
        provider: PROVIDER_ID,
        model: 'minimax-M3',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'calc thought' },
              { type: 'tool-call', id: 'call_1', name: 'calc', arguments: '{"x":1}' },
            ],
            source: { kind: 'model', model: 'minimax-other-model', replayState: finish?.replayState },
          },
        ],
      } as never,
      undefined,
      { authOwner, route: PROVIDER_ID },
    )
    const mismatchAssistant = (modelMismatchRequest.messages as any[]).find(m => m.role === 'assistant')
    expect(mismatchAssistant?.content.some((b: any) => b.type === 'thinking')).toBe(false)
  })
})
