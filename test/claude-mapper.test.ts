/**
 * Tests for the Claude subscription wire mapper.
 *
 * WHAT THESE TESTS ARE FOR. Each one is named after the property it protects,
 * because every property below is one a plausible implementation gets WRONG in
 * a way no type checker can see:
 *
 *   1. the Claude Code identity block must be system[0] on EVERY request - a
 *      subscription request without it is rejected, and the realistic way the
 *      bug appears is an "if the caller stated a prompt" guard around it;
 *   2. a signed thinking block must be replayed VERBATIM across a tool loop,
 *      because a replayed thinking block without its signature is a 400 and
 *      dropping it breaks multi-turn tool use under extended thinking;
 *   3. input_json_delta fragments are concatenated and parsed ONCE, at block
 *      stop - parsing per fragment silently invents tool arguments;
 *   4. the thinking dispatch is four cases in a fixed order, and mid-convo
 *      outranks a caller asking for thinking off;
 *   5. the budget arithmetic is transcribed, not re-derived, and its two traps
 *      (an undefined cap coerced to 0, an unresolved cap) both produce a
 *      request with no room for an answer;
 *   6. the usage counters are DISJOINT - input_tokens excludes the cache
 *      counters - so summing them double-counts every cached turn;
 *   7. the stream is LINE-oriented (event: / data: pairs), and a stream that
 *      ends without message_stop is a severed reply, not a completed answer;
 *   8. the request carries cache_control breakpoints BY DEFAULT, on the last
 *      system block, the last block of the last user message and the last tool,
 *      and never more than the wire's limit of four. The server caches nothing
 *      without a breakpoint, so an opt-in marker that the adapter forgets to
 *      turn on is exactly the bug these tests now lock out.
 *
 * Everything runs offline against fixtures written down here. Nothing in this
 * file touches the network or a credential.
 */

import { describe, expect, it } from 'vitest'
import { BlockAssembler, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock as HarnessContentBlock,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../src/host/common/llm-compat.ts'
import {
  CLAUDE_CODE_IDENTITY_TEXT,
  CLAUDE_CODE_TOOL_NAMES,
  DEFAULT_THINKING_BUDGETS,
  MAX_REQUEST_IMAGE_BYTES,
  adjustMaxTokensForThinking,
  assertStreamComplete,
  buildClaudeRequestBody,
  buildClaudeSystemBlocks,
  MAX_CACHE_BREAKPOINTS,
  canonicalClaudeToolName,
  clampReasoning,
  clampThinkingBudgetToAnswerRoom,
  claudeOriginalToolName,
  claudeThinking,
  countClaudeCacheBreakpoints,
  claudeToolNames,
  claudeWireToolName,
  claudeRequestThinks,
  closeStream,
  createStreamState,
  leadingSystemText,
  offloadOldestRequestImages,
  processStreamLine,
  resolveMaxTokens,
  thinkingBudgetForLevel,
  thinkingRequestedOff,
  type ClaudeStreamState,
  type ResolvedRequestImages,
} from '../src/host/claude/mapper.ts'
import { claudeThinkingMode, maxOutputTokensFor } from '../src/host/claude/model-catalog.ts'
import { DEFAULT_MAX_TOKENS, PROVIDER_ID } from '../src/host/claude/types.ts'

function options(overrides: Record<string, unknown> = {}): GenerateOptions {
  return {
    provider: PROVIDER_ID,
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'system', source: { kind: PLUGIN_MESSAGE_SOURCE_KIND }, content: [{ type: 'text', text: 'You are DSH.' }] },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    ],
    ...overrides,
  } as unknown as GenerateOptions
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return buildClaudeRequestBody(options(overrides))
}

function thinkingOf(built: Record<string, unknown>): Record<string, unknown> | undefined {
  return built.thinking as Record<string, unknown> | undefined
}

function outputConfigOf(built: Record<string, unknown>): Record<string, unknown> | undefined {
  return built.output_config as Record<string, unknown> | undefined
}

function systemBlocksOf(built: Record<string, unknown>): Array<Record<string, unknown>> {
  return built.system as Array<Record<string, unknown>>
}

function messagesOf(built: Record<string, unknown>): Array<{ role: string; content: Array<Record<string, unknown>> }> {
  return built.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
}

/** One SSE event, as the LINE PAIR the wire actually sends. */
function eventLines(event: unknown): string[] {
  const type = (event as { type?: unknown }).type
  return ['event: ' + String(type), 'data: ' + JSON.stringify(event)]
}

function feed(lines: readonly string[], state: ClaudeStreamState) {
  const chunks = []
  for (const line of lines) chunks.push(...processStreamLine(line, state))
  return chunks
}

/** Assemble a chunk list into blocks plus the replay envelope, as the loop does. */
function assemble(chunks: readonly ReturnType<typeof closeStream>[number][]) {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler
}

const START_USAGE = {
  input_tokens: 12,
  cache_creation_input_tokens: 3,
  cache_read_input_tokens: 4,
  output_tokens: 1,
}

function messageStart(usage: Record<string, unknown> = START_USAGE): unknown {
  return {
    type: 'message_start',
    message: {
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  }
}

describe('Claude request body', () => {
  it('posts a streaming Messages body with the resolved cap and no thinking for a non-thinking model', () => {
    const built = body({ model: 'claude-unknown-x', maxTokens: 4096 })
    expect(built.model).toBe('claude-unknown-x')
    // 4096 is the caller's cap AND the ceiling, so it is what goes on the wire.
    expect(built.max_tokens).toBe(4096)
    expect(built.stream).toBe(true)
    expect(built.thinking).toBeUndefined()
    expect(built.output_config).toBeUndefined()
    // The tail block carries the cache marker because caching is now the DEFAULT
    // for every request built here. The full shape is still asserted on purpose:
    // this is the request the adapter posts, and a marker on the wrong block is
    // as much a bug as no marker at all.
    expect(messagesOf(built)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] },
    ])
    expect(claudeThinkingMode('claude-unknown-x')).toBe('none')
  })

  it('resolves an absent caller cap to the MODEL cap, never to zero', () => {
    // Trap 1 from the catalog's RULE 4: a 0 here would make the thinking budget
    // the entire response ceiling.
    expect(buildClaudeRequestBody(options({ model: 'claude-haiku-4-5', reasoningEffort: 'medium' as ReasoningEffortId })).max_tokens)
      .toBe(maxOutputTokensFor('claude-haiku-4-5'))
    expect(maxOutputTokensFor('claude-haiku-4-5')).toBe(64_000)
    expect(resolveMaxTokens(options({ model: 'claude-haiku-4-5' }))).toBe(64_000)
    // The unknown-model stub keeps this line's default cap.
    expect(resolveMaxTokens(options({ model: 'claude-unknown-x' }))).toBe(DEFAULT_MAX_TOKENS)
  })

  it('strips $schema from a tool input_schema and keeps the rest of the schema', () => {
    const built = body({
      tools: [{
        name: 'run_code',
        description: 'run',
        parameters: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { code: { type: 'string' } },
          required: ['code'],
        },
      }],
    })
    // The LAST tool is marked (it is the only one), so the tool table sits
    // inside the cached prefix.
    expect(built.tools).toEqual([{
      name: 'run_code',
      description: 'run',
      input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      cache_control: { type: 'ephemeral' },
    }])
  })

  it('omits tools entirely when the caller offers none', () => {
    expect(body().tools).toBeUndefined()
    expect(body({ tools: [] }).tools).toBeUndefined()
  })
})

describe('The Claude Code identity block', () => {
  it('is system[0] even when the caller states NO system prompt at all', () => {
    const built = buildClaudeRequestBody(options({
      system: undefined,
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
    }) as unknown as GenerateOptions)
    const system = systemBlocksOf(built)
    expect(system).toHaveLength(1)
    // With no caller prompt the identity block IS the last block, so the default
    // breakpoint lands on it.
    expect(system[0]).toEqual({ type: 'text', text: CLAUDE_CODE_IDENTITY_TEXT, cache_control: { type: 'ephemeral' } })
    expect(system[0]!.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.")
  })

  it('is always block 0, with the caller prompt folded into block 1', () => {
    const built = body()
    const system = systemBlocksOf(built)
    expect(system).toHaveLength(2)
    expect(system[0]).toEqual({ type: 'text', text: CLAUDE_CODE_IDENTITY_TEXT })
    expect(system[1]).toEqual({ type: 'text', text: 'You are DSH.', cache_control: { type: 'ephemeral' } })
  })

  it('folds a one-shot system header and role:system messages into block 1 without a system role on the wire', () => {
    const built = buildClaudeRequestBody(options({
      system: 'Header prompt.',
      messages: [
        { role: 'system', source: { kind: PLUGIN_MESSAGE_SOURCE_KIND }, content: [{ type: 'text', text: 'First system turn.' }] },
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
        { role: 'system', source: { kind: PLUGIN_MESSAGE_SOURCE_KIND }, content: [{ type: 'text', text: 'Later system turn.' }] },
      ],
    }) as unknown as GenerateOptions)
    const system = systemBlocksOf(built)
    expect(system).toHaveLength(2)
    expect(system[1]!.text).toBe('Header prompt.\n\nFirst system turn.\n\nLater system turn.')
    // No system role survives on the wire.
    expect(messagesOf(built).map((message) => message.role)).toEqual(['user'])
    expect(leadingSystemText(options())).toBe('You are DSH.')
    expect(leadingSystemText(options({ messages: [] }) as unknown as GenerateOptions)).toBeUndefined()
  })

  it('places the ephemeral cache marker on the LAST system block, by default', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. This assertion used to read "the
    // default is off: the plain builder must not put a marker anywhere", which
    // encoded the bug: with no marker on the wire the server caches nothing, so
    // every turn was billed as fresh input and cache_read_input_tokens never
    // appeared. The default is now ON, and only an explicit false opts out.
    const on = body()
    const system = systemBlocksOf(on)
    // The marker goes on the LAST block, so it also covers the identity block
    // above it; marking the identity block alone would cache what never changes.
    expect(system[0]).toEqual({ type: 'text', text: CLAUDE_CODE_IDENTITY_TEXT })
    expect(system[1]).toEqual({ type: 'text', text: 'You are DSH.', cache_control: { type: 'ephemeral' } })

    // The opt-OUT is what removes it.
    expect(JSON.stringify(buildClaudeRequestBody(options(), undefined, { cacheControl: false }))).not.toContain('cache_control')

    // With no caller prompt there is only the identity block, and it is last.
    const solo = buildClaudeSystemBlocks(options({ system: undefined, messages: [] }) as unknown as GenerateOptions)
    expect(solo).toHaveLength(1)
    expect(solo[0]!.cache_control).toEqual({ type: 'ephemeral' })
    const soloOff = buildClaudeSystemBlocks(options({ system: undefined, messages: [] }) as unknown as GenerateOptions, false)
    expect(soloOff[0]!.cache_control).toBeUndefined()
  })
})

describe('Prompt-cache breakpoints', () => {
  const TOOLS = [
    { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  ]

  /** A conversation deep enough that the prefix is worth caching. */
  function busyMessages(): unknown[] {
    const messages: unknown[] = [
      { role: 'system', source: { kind: PLUGIN_MESSAGE_SOURCE_KIND }, content: [{ type: 'text', text: 'You are DSH.' }] },
    ]
    for (let turn = 0; turn < 6; turn++) {
      messages.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'question ' + turn }] })
      messages.push({
        role: 'assistant',
        source: { kind: 'model', provider: PROVIDER_ID, model: 'claude-opus-5-5' },
        content: [{ type: 'text', text: 'answer ' + turn }],
      })
    }
    messages.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'and now?' }] })
    return messages
  }

  it('marks all three sites on a DEFAULT request, with no option stated', () => {
    // No third argument at all: this is the plain call the adapter makes, and it
    // is the request shape that showed no cache hits before the fix.
    const built = buildClaudeRequestBody(options({
      model: 'claude-opus-5-5',
      tools: TOOLS,
    }) as unknown as GenerateOptions)

    // (1) the LAST system block — the head of the cached prefix.
    const system = systemBlocksOf(built)
    expect(system).toHaveLength(2)
    expect(system[0]!.cache_control).toBeUndefined()
    expect(system[1]!.cache_control).toEqual({ type: 'ephemeral' })

    // (2) the last block of the LAST user message — what caches history.
    const messages = messagesOf(built)
    const lastUser = messages[messages.length - 1]!
    expect(lastUser.role).toBe('user')
    expect(lastUser.content[lastUser.content.length - 1]!.cache_control).toEqual({ type: 'ephemeral' })

    // (3) the last tool — the tool table stays inside the prefix.
    const tools = built.tools as Array<Record<string, unknown>>
    expect(tools).toHaveLength(2)
    expect(tools[0]!.cache_control).toBeUndefined()
    expect(tools[1]!.cache_control).toEqual({ type: 'ephemeral' })

    // Three sites, three markers, one each.
    expect(countClaudeCacheBreakpoints(built)).toBe(3)
  })

  it('marks the tool_result block of a tool-using turn — the turn caching matters most', () => {
    // The shape the loop actually sends after a tool call: assistant turn with a
    // tool_use, then a USER turn whose only block is that call's tool_result.
    const built = buildClaudeRequestBody(options({
      model: 'claude-opus-5-5',
      tools: TOOLS,
      messages: [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'list the files' }] },
        {
          role: 'assistant',
          source: { kind: 'model', provider: PROVIDER_ID, model: 'claude-opus-5-5' },
          content: [
            { type: 'text', text: 'Listing now.' },
            { type: 'tool-call', id: 'toolu_01', name: 'bash', arguments: '{"command":"ls"}' },
          ],
        },
        {
          role: 'tool',
          source: { kind: 'tool' },
          toolCallId: 'toolu_01',
          content: [{ type: 'text', text: 'a.txt' }],
        },
      ],
    }) as unknown as GenerateOptions)

    const messages = messagesOf(built)
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    const toolResult = messages[2]!.content[0]!
    expect(toolResult.type).toBe('tool_result')
    expect(toolResult.cache_control).toEqual({ type: 'ephemeral' })
    // The text turn BEFORE it is not marked: there is one message breakpoint.
    expect(messages[0]!.content[0]!.cache_control).toBeUndefined()
  })

  it('marks the block that SURVIVES the same-role merge, not the one it swallowed', () => {
    // Two user turns in a row (an injected notice then the real turn) merge into
    // one. Marking before the merge would put the marker on the notice, which is
    // not the tail of the merged turn and therefore caches the wrong prefix.
    const built = buildClaudeRequestBody(options({
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', source: { kind: PLUGIN_MESSAGE_SOURCE_KIND }, content: [{ type: 'text', text: 'context notice' }] },
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'the real turn' }] },
      ],
    }) as unknown as GenerateOptions)

    const messages = messagesOf(built)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: 'context notice' },
      { type: 'text', text: 'the real turn', cache_control: { type: 'ephemeral' } },
    ])
  })

  it('never exceeds the wire limit of 4 breakpoints on a busy conversation with images', () => {
    const images: ResolvedRequestImages = new Map([['att-1', { kind: 'inline', mediaType: 'image/png', data: 'AAAA' }]])
    const built = buildClaudeRequestBody(options({
      model: 'claude-opus-5-5',
      tools: TOOLS,
      messages: [
        ...busyMessages(),
        {
          role: 'user',
          source: { kind: 'user' },
          content: [
            { type: 'text', text: 'what is in this?' },
            { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 3, name: 'shot.png' } },
          ],
        },
      ],
    }) as unknown as GenerateOptions, images)

    // The raw wire limit, not a magic three: marking one site twice would pass a
    // "<= 3" assertion written by hand.
    expect(countClaudeCacheBreakpoints(built)).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS)
    expect(MAX_CACHE_BREAKPOINTS).toBe(4)
    // Exactly the three intended sites, and the image is the marked tail of the
    // final user turn.
    expect(countClaudeCacheBreakpoints(built)).toBe(3)
    const messages = messagesOf(built)
    const lastBlock = messages[messages.length - 1]!.content.at(-1)!
    expect(lastBlock.type).toBe('image')
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('leaves the request uncached with no marker anywhere when a caller opts out', () => {
    const built = buildClaudeRequestBody(options({ model: 'claude-opus-5-5', tools: TOOLS }) as unknown as GenerateOptions, undefined, { cacheControl: false })
    expect(countClaudeCacheBreakpoints(built)).toBe(0)
    expect(JSON.stringify(built)).not.toContain('cache_control')
  })

  it('marks nothing on the message list when the history ends on an assistant turn', () => {
    const built = buildClaudeRequestBody(options({
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', source: { kind: 'model', provider: PROVIDER_ID, model: 'claude-opus-5-5' }, content: [{ type: 'text', text: 'partial' }] },
      ],
    }) as unknown as GenerateOptions)
    const messages = messagesOf(built)
    expect(messages[messages.length - 1]!.role).toBe('assistant')
    expect(messages[0]!.content[0]!.cache_control).toBeUndefined()
    // The system breakpoint is still there: it is independent of the message one.
    expect(countClaudeCacheBreakpoints(built)).toBe(1)
  })
})

describe('Thinking dispatch - the four catalog cases', () => {
  it('mid-convo sends adaptive+block_binding AND output_config.effort', () => {
    expect(claudeThinkingMode('claude-opus-5')).toBe('mid-convo')
    const built = body({ model: 'claude-opus-5', reasoningEffort: 'medium' as ReasoningEffortId })
    expect(thinkingOf(built)).toEqual({
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    })
    expect(outputConfigOf(built)).toEqual({ effort: 'medium' })
  })

  it('mid-convo outranks a caller asking for thinking off, and defaults the effort to high', () => {
    // The disable request must NOT be sent: suppressing the block_binding is how
    // the persistent 400 the reference documents comes back.
    const off = body({ model: 'claude-opus-5', reasoningEffort: 'none' as ReasoningEffortId })
    expect(thinkingOf(off)).toEqual({
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    })
    expect(outputConfigOf(off)).toEqual({ effort: 'high' })
    expect(JSON.stringify(off)).not.toContain('disabled')

    const unnamed = body({ model: 'claude-opus-5' })
    expect(outputConfigOf(unnamed)).toEqual({ effort: 'high' })
  })

  it('adaptive sends the plain adaptive form, with output_config only when an effort was named', () => {
    expect(claudeThinkingMode('claude-sonnet-4-6')).toBe('adaptive')
    const named = body({ model: 'claude-sonnet-4-6', reasoningEffort: 'high' as ReasoningEffortId })
    expect(thinkingOf(named)).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(outputConfigOf(named)).toEqual({ effort: 'high' })

    const unnamed = body({ model: 'claude-sonnet-4-6' })
    expect(thinkingOf(unnamed)).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(unnamed.output_config).toBeUndefined()
    expect(JSON.stringify(named)).not.toContain('budget_tokens')
  })

  it('passes the catalog effort vocabulary through AS-IS, including xhigh and max', () => {
    // No convergence table exists on this line and none is wanted here.
    const xhigh = body({ model: 'claude-sonnet-4-6', reasoningEffort: 'xhigh' as ReasoningEffortId })
    expect(outputConfigOf(xhigh)).toEqual({ effort: 'xhigh' })
    const max = body({ model: 'claude-fable-5', reasoningEffort: 'max' as ReasoningEffortId })
    expect(outputConfigOf(max)).toEqual({ effort: 'max' })
  })

  it('budget sends enabled+budget_tokens, clamped to leave an answer inside the ceiling', () => {
    expect(claudeThinkingMode('claude-haiku-4-5')).toBe('budget')
    const built = body({ model: 'claude-haiku-4-5', reasoningEffort: 'medium' as ReasoningEffortId })
    expect(built.max_tokens).toBe(64_000)
    expect(thinkingOf(built)).toEqual({ type: 'enabled', budget_tokens: 8192, display: 'summarized' })

    const high = body({ model: 'claude-haiku-4-5', reasoningEffort: 'high' as ReasoningEffortId })
    expect(thinkingOf(high)).toEqual({ type: 'enabled', budget_tokens: 16_384, display: 'summarized' })
    // xhigh is clamped onto high for the BUDGET only; the field itself is not sent.
    const xhigh = body({ model: 'claude-haiku-4-5', reasoningEffort: 'xhigh' as ReasoningEffortId })
    expect(thinkingOf(xhigh)).toEqual({ type: 'enabled', budget_tokens: 16_384, display: 'summarized' })
  })

  it('keeps the budget inside a small caller cap rather than letting it eat the ceiling', () => {
    // 100 + 8192 = 8292 of ceiling; the wire clamp leaves 1024 tokens of answer.
    const tiny = body({ model: 'claude-haiku-4-5', reasoningEffort: 'medium' as ReasoningEffortId, maxTokens: 100 })
    expect(tiny.max_tokens).toBe(8292)
    expect(thinkingOf(tiny)).toEqual({ type: 'enabled', budget_tokens: 7268, display: 'summarized' })
    // Below 1024 of ceiling there is no answer room at all, so the budget floors
    // at 0 and the request carries no thinking worth having. The clamp is on the
    // WIRE budget; the ceiling itself is never rewritten down.
    const absurd = adjustMaxTokensForThinking(1, 64_000, 'medium')
    expect(absurd.maxTokens).toBe(8193)
    expect(absurd.thinkingBudget).toBe(8192)
    expect(clampThinkingBudgetToAnswerRoom(8192, 1)).toBe(0)
    expect(clampThinkingBudgetToAnswerRoom(8192, 1024)).toBe(0)
    expect(clampThinkingBudgetToAnswerRoom(8192, 1025)).toBe(1)
    const floor = body({ model: 'claude-haiku-4-5', reasoningEffort: 'medium' as ReasoningEffortId, maxTokens: 1 })
    expect(floor.max_tokens).toBe(8193)
    expect(thinkingOf(floor)).toEqual({ type: 'enabled', budget_tokens: 7169, display: 'summarized' })
  })

  it('none sends NO thinking field at all', () => {
    const built = body({ model: 'claude-unknown-x', reasoningEffort: 'high' as ReasoningEffortId })
    expect('thinking' in built).toBe(false)
    expect('output_config' in built).toBe(false)
  })

  it('sends the disable request only where the model allows it', () => {
    // canDisableThinking: true -> the caller's ask is honored...
    const haiku = body({ model: 'claude-haiku-4-5', reasoningEffort: 'none' as ReasoningEffortId })
    expect(thinkingOf(haiku)).toEqual({ type: 'disabled' })
    expect(haiku.output_config).toBeUndefined()
    const sonnet = body({ model: 'claude-sonnet-4-6', reasoningEffort: 'off' as ReasoningEffortId })
    expect(thinkingOf(sonnet)).toEqual({ type: 'disabled' })

    // ...and where the model forbids it, the model's own form is used instead.
    const fable = body({ model: 'claude-fable-5', reasoningEffort: 'none' as ReasoningEffortId })
    expect(thinkingOf(fable)).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(JSON.stringify(fable)).not.toContain('disabled')
    expect(thinkingRequestedOff('none')).toBe(true)
    expect(thinkingRequestedOff('NONE')).toBe(true)
    expect(thinkingRequestedOff('disabled')).toBe(true)
    expect(thinkingRequestedOff('minimal')).toBe(false)
    expect(thinkingRequestedOff(undefined)).toBe(false)
  })

  it('reports the same dispatch through claudeThinking() as through the body', () => {
    expect(claudeThinking('claude-opus-5', 'low', 'low', 1000)).toEqual({
      thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      outputConfig: { effort: 'low' },
    })
    expect(claudeThinking('claude-sonnet-5', undefined, 'medium', 1000)).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
    })
    expect(claudeThinking('claude-opus-4-5', 'high', 'high', 64_000)).toEqual({
      thinking: { type: 'enabled', budget_tokens: 16_384, display: 'summarized' },
    })
    expect(claudeThinking('claude-unknown-x', 'high', 'high', 1000)).toEqual({})
  })
})

describe('Thinking budget arithmetic (transcribed from the catalog)', () => {
  it('carries the reference table and the xhigh/max clamp', () => {
    expect(DEFAULT_THINKING_BUDGETS).toEqual({ minimal: 1024, low: 2048, medium: 8192, high: 16_384 })
    expect(clampReasoning('xhigh')).toBe('high')
    expect(clampReasoning('max')).toBe('high')
    expect(clampReasoning('LOW')).toBe('low')
    expect(clampReasoning('')).toBeUndefined()
    expect(clampReasoning(undefined)).toBeUndefined()
    expect(thinkingBudgetForLevel('minimal')).toBe(1024)
    expect(thinkingBudgetForLevel('xhigh')).toBe(16_384)
    expect(thinkingBudgetForLevel('max')).toBe(16_384)
    expect(thinkingBudgetForLevel('unknown-level')).toBeUndefined()
    expect(thinkingBudgetForLevel('high', { high: 4096 })).toBe(4096)
    expect(thinkingBudgetForLevel(undefined)).toBeUndefined()
  })

  it('adjusts the ceiling the way the reference does, in both branches', () => {
    // undefined base cap -> the MODEL cap wins and the budget fits inside it.
    expect(adjustMaxTokensForThinking(undefined, 64_000, 'medium'))
      .toEqual({ maxTokens: 64_000, thinkingBudget: 8192 })
    // A resolved base cap adds the budget to it, bounded by the model cap.
    expect(adjustMaxTokensForThinking(4096, 64_000, 'medium'))
      .toEqual({ maxTokens: 12_288, thinkingBudget: 8192 })
    expect(adjustMaxTokensForThinking(200_000, 64_000, 'medium'))
      .toEqual({ maxTokens: 64_000, thinkingBudget: 8192 })
  })

  it('shrinks the budget when the ceiling itself is too small for it', () => {
    // modelMax below the budget: 4096 <= 8192, so the budget keeps 1024 of room.
    expect(adjustMaxTokensForThinking(4096, 4096, 'medium'))
      .toEqual({ maxTokens: 4096, thinkingBudget: 3072 })
    expect(adjustMaxTokensForThinking(undefined, 2048, 'medium'))
      .toEqual({ maxTokens: 2048, thinkingBudget: 1024 })
    expect(clampThinkingBudgetToAnswerRoom(8192, 4096)).toBe(3072)
    expect(clampThinkingBudgetToAnswerRoom(8192, 1)).toBe(0)
    expect(clampThinkingBudgetToAnswerRoom(8192, 64_000)).toBe(8192)
  })

  it('does not walk into trap 1: an undefined cap is never coerced to zero', () => {
    // The wrong implementation returns maxTokens === thinkingBudget (8192), which
    // leaves the answer nothing at all.
    const adjusted = adjustMaxTokensForThinking(undefined, 64_000, 'medium')
    expect(adjusted.maxTokens).not.toBe(0)
    expect(adjusted.maxTokens).toBeGreaterThan(adjusted.thinkingBudget!)
  })
})

describe('The response ceiling', () => {
  it('is inflated by the thinking budget ONLY for a request that will think', () => {
    // A non-thinking model must ask for exactly the cap it was given.
    const plain = body({ model: 'claude-unknown-x', maxTokens: 4096 })
    expect(plain.max_tokens).toBe(4096)
    expect(claudeRequestThinks('claude-unknown-x', 'high')).toBe(false)

    // A thinking model's ceiling grows to hold the budget.
    const thinking = body({ model: 'claude-haiku-4-5', reasoningEffort: 'medium' as ReasoningEffortId, maxTokens: 4096 })
    expect(thinking.max_tokens).toBe(12_288)
    expect(claudeRequestThinks('claude-haiku-4-5', 'medium')).toBe(true)

    // ...unless the caller turned it off on a model that allows that, in which
    // case the cap is the caller's again and the budget is not spent.
    const disabled = body({ model: 'claude-haiku-4-5', reasoningEffort: 'none' as ReasoningEffortId, maxTokens: 4096 })
    expect(disabled.max_tokens).toBe(4096)
    expect(thinkingOf(disabled)).toEqual({ type: 'disabled' })
    expect(claudeRequestThinks('claude-haiku-4-5', 'none')).toBe(false)

    // A model that forbids the disable request still thinks, so its ceiling still
    // grows even though the caller asked for no thinking.
    const forced = body({ model: 'claude-sonnet-4-6', reasoningEffort: 'none' as ReasoningEffortId, maxTokens: 4096 })
    expect(thinkingOf(forced)).toEqual({ type: 'disabled' })
    // A mid-convo model thinks even when the caller asked it not to, so its
    // ceiling is inflated anyway - the adaptive form has no budget to spend, so
    // the inflation is the only thing the mid-convo branch does to max_tokens.
    const midConvo = body({ model: 'claude-opus-5', reasoningEffort: 'none' as ReasoningEffortId, maxTokens: 4096 })
    expect(midConvo.max_tokens).toBe(12_288)
    expect(thinkingOf(midConvo)!.type).toBe('adaptive')
    expect(claudeRequestThinks('claude-opus-5', 'none')).toBe(true)
  })

  it('never lets the ceiling exceed the model cap or fall below the caller cap', () => {
    // 200_000 + 16384 is above the model's own 128_000, so the model cap wins.
    const high = body({ model: 'claude-fable-5', reasoningEffort: 'high' as ReasoningEffortId, maxTokens: 200_000 })
    expect(high.max_tokens).toBe(128_000)
    const defaulted = body({ model: 'claude-fable-5' })
    expect(defaulted.max_tokens).toBe(128_000)
  })
})

describe('Temperature gating', () => {
  it('omits temperature whenever thinking is enabled', () => {
    const built = body({ model: 'claude-haiku-4-5', reasoningEffort: 'medium' as ReasoningEffortId, temperature: 0.4 })
    expect(thinkingOf(built)!.type).toBe('enabled')
    expect('temperature' in built).toBe(false)
  })

  it('omits temperature on a model whose catalog row forbids one', () => {
    const built = body({ model: 'claude-opus-4-7', temperature: 0.4 })
    expect(thinkingOf(built)!.type).toBe('adaptive')
    expect('temperature' in built).toBe(false)
  })

  it('sends temperature when the model accepts one and thinking is off', () => {
    const built = body({ model: 'claude-sonnet-4-6', reasoningEffort: 'none' as ReasoningEffortId, temperature: 0.4 })
    expect(thinkingOf(built)).toEqual({ type: 'disabled' })
    expect(built.temperature).toBe(0.4)

    const nonThinking = body({ model: 'claude-unknown-x', temperature: 0.2 })
    expect(nonThinking.temperature).toBe(0.2)
  })

  it('passes stop sequences through when the caller states them', () => {
    expect(body({ stop: ['\n\n', 'END'] }).stop_sequences).toEqual(['\n\n', 'END'])
    expect('stop_sequences' in body()).toBe(false)
  })
})

describe('Message projection', () => {
  it('sends an assistant tool call as tool_use with a PARSED input object', () => {
    const built = buildClaudeRequestBody(options({
      messages: [
        { role: 'assistant', source: { kind: 'model', provider: PROVIDER_ID, model: 'm' }, content: [
          { type: 'text', text: 'let me look' },
          { type: 'tool-call', id: 'toolu_1', name: 'read_file', arguments: '{"path":"a.txt","limit":10}' },
        ] },
      ],
    }) as unknown as GenerateOptions)
    expect(messagesOf(built)).toEqual([{
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me look' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt', limit: 10 } },
      ],
    }])
    // The image-free text content stays a plain string elsewhere; this is the
    // assistant turn, whose content is always blocks.
    expect(typeof messagesOf(built)[0]!.content).not.toBe('string')
  })

  it('places a tool result in a USER message, because this wire has no tool role', () => {
    const built = buildClaudeRequestBody(options({
      messages: [
        { role: 'assistant', source: { kind: 'model', provider: PROVIDER_ID, model: 'm' }, content: [
          { type: 'tool-call', id: 'toolu_1', name: 'Read', arguments: '{"file_path":"a.txt"}' },
        ] },
        { role: 'user', source: { kind: 'tool', callId: 'toolu_1' }, content: [
          { type: 'tool-result', toolCallId: 'toolu_1', content: [{ type: 'text', text: 'contents' }] },
        ] },
      ],
    }) as unknown as GenerateOptions)
    expect(messagesOf(built)).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.txt' } }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents', cache_control: { type: 'ephemeral' } }],
      },
    ])
  })

  it('marks an errored tool result and merges a run of consecutive user turns', () => {
    const built = buildClaudeRequestBody(options({
      messages: [
        { role: 'user', source: { kind: 'tool', callId: 'a' }, content: [
          { type: 'tool-result', toolCallId: 'a', content: [{ type: 'text', text: 'boom' }], isError: true },
        ] },
        { role: 'user', source: { kind: 'tool', callId: 'b' }, content: [
          { type: 'tool-result', toolCallId: 'b', content: [{ type: 'text', text: 'fine' }] },
        ] },
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'and now?' }] },
      ],
    }) as unknown as GenerateOptions)
    const messages = messagesOf(built)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: 'boom', is_error: true },
      { type: 'tool_result', tool_use_id: 'b', content: 'fine' },
      // The marker sits on the tail of the MERGED turn, which is the text turn.
      { type: 'text', text: 'and now?', cache_control: { type: 'ephemeral' } },
    ])
  })
})

describe('Thinking-block replay across a tool loop', () => {
  const FIRST_TURN_LINES = [
    ...eventLines(messageStart()),
    ...eventLines({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    ...eventLines({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I should list the directory first.' } }),
    ...eventLines({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }),
    ...eventLines({ type: 'content_block_stop', index: 0 }),
    ...eventLines({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    ...eventLines({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Listing now.' } }),
    ...eventLines({ type: 'content_block_stop', index: 1 }),
    ...eventLines({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} } }),
    ...eventLines({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"comm' } }),
    ...eventLines({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'and":"ls"}' } }),
    ...eventLines({ type: 'content_block_stop', index: 2 }),
    ...eventLines({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } }),
    ...eventLines({ type: 'message_stop' }),
  ]

  it('replays a signed thinking block verbatim on the next turn, beside its tool result', () => {
    const tools = [{ name: 'bash', description: 'run', parameters: { type: 'object' } }]
    const names = claudeToolNames(tools)

    const state = createStreamState(names)
    const chunks = feed(FIRST_TURN_LINES, state)
    assertStreamComplete(state)
    const assembler = assemble(chunks)
    const blocks = assembler.blocks()
    expect(blocks.map((block) => block.type)).toEqual(['reasoning', 'text', 'tool-call'])
    expect(blocks[0]).toEqual({ type: 'reasoning', text: 'I should list the directory first.' })

    const call = blocks.find((block) => block.type === 'tool-call')
    if (call === undefined || call.type !== 'tool-call') throw new Error('no tool call assembled')
    // The call name is reported back in the CALLER's spelling, not the wire's.
    expect(call.name).toBe('bash')
    expect(call.arguments).toBe('{"command":"ls"}')

    const assistant = createAssistantMessage({
      content: blocks as HarnessContentBlock[],
      source: { provider: PROVIDER_ID, model: 'claude-sonnet-4-6', replayState: assembler.replayState },
    })
    // The harness 0.1.7 shape on purpose: a first-class role:'tool' message whose
    // content IS the result blocks and whose call id sits on the message. This is
    // what the loop actually sends, and mapping it as a plain user turn would
    // leave the tool_use above unanswered.
    const toolResult = createToolResultMessage({
      callId: call.id,
      content: [{ type: 'text', text: 'a.txt b.txt' }],
      isError: false,
    })

    const second = buildClaudeRequestBody(options({
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'high' as ReasoningEffortId,
      tools,
      messages: [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'list the files' }] },
        assistant,
        toolResult,
      ],
    }) as unknown as GenerateOptions, undefined, { toolNames: names })

    const messages = messagesOf(second)
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    // THE PROPERTY: the thinking block comes back with its exact text and its
    // exact signature. A replayed thinking block without its signature is a 400.
    expect(messages[1]!.content[0]).toEqual({
      type: 'thinking',
      thinking: 'I should list the directory first.',
      signature: 'sig-abc',
    })
    expect(messages[1]!.content[1]).toEqual({ type: 'text', text: 'Listing now.' })
    // The tool call goes back out in the CANONICAL spelling with its parsed input.
    expect(messages[1]!.content[2]).toEqual({ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } })
    expect(messages[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_01', content: 'a.txt b.txt', cache_control: { type: 'ephemeral' } },
    ])
    // And thinking is still requested for the continued generation.
    expect(thinkingOf(second)).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(outputConfigOf(second)).toEqual({ effort: 'high' })
  })

  it('drops a thinking block with NO signature, and prefers the envelope payload over the block text', () => {
    const unsigned = buildClaudeRequestBody(options({
      messages: [
        { role: 'assistant', source: { kind: 'model', provider: PROVIDER_ID, model: 'm' }, content: [
          { type: 'reasoning', text: 'unsig' },
          { type: 'text', text: 'answer' },
        ] },
      ],
    }) as unknown as GenerateOptions)
    expect(messagesOf(unsigned)[0]!.content).toEqual([{ type: 'text', text: 'answer' }])

    const enveloped = buildClaudeRequestBody(options({
      messages: [
        {
          role: 'assistant',
          source: {
            kind: 'model',
            provider: PROVIDER_ID,
            model: 'm',
            replayState: {
              response: { provider: PROVIDER_ID },
              blocks: [
                { type: 'thinking', thinking: 'what the wire said', signature: 'sig-wire' },
                { type: 'text', text: 'answer' },
              ],
            },
          },
          content: [{ type: 'reasoning', text: 'a re-encoded copy' }, { type: 'text', text: 'answer' }],
        },
      ],
    }) as unknown as GenerateOptions)
    expect(messagesOf(enveloped)[0]!.content[0]).toEqual({
      type: 'thinking',
      thinking: 'what the wire said',
      signature: 'sig-wire',
    })
  })

  it('replays a redacted_thinking block too, and drops one with no payload', () => {
    const redacted = buildClaudeRequestBody(options({
      messages: [
        {
          role: 'assistant',
          source: {
            kind: 'model',
            provider: PROVIDER_ID,
            model: 'm',
            replayState: { response: {}, blocks: [{ type: 'redacted_thinking', data: 'ENCRYPTED_BLOB', signature: 'sig-r' }] },
          },
          content: [{ type: 'reasoning', text: '' }],
        },
      ],
    }) as unknown as GenerateOptions)
    expect(messagesOf(redacted)[0]!.content).toEqual([
      { type: 'redacted_thinking', data: 'ENCRYPTED_BLOB', signature: 'sig-r' },
    ])

    const payloadless = buildClaudeRequestBody(options({
      messages: [
        {
          role: 'assistant',
          source: { kind: 'model', provider: PROVIDER_ID, model: 'm', replayState: { response: {}, blocks: [{ type: 'redacted_thinking' }] } },
          content: [{ type: 'reasoning', text: '' }],
        },
      ],
    }) as unknown as GenerateOptions)
    // An empty assistant turn carries nothing at all on this wire.
    expect(messagesOf(payloadless)).toEqual([])
  })
})

describe('Tool-name normalization', () => {
  it('sends canonical spellings for known tools and leaves unknown names alone', () => {
    expect(CLAUDE_CODE_TOOL_NAMES).toContain('AskUserQuestion')
    expect(CLAUDE_CODE_TOOL_NAMES).toContain('TodoWrite')
    expect(CLAUDE_CODE_TOOL_NAMES).toHaveLength(17)
    expect(canonicalClaudeToolName('bash')).toBe('Bash')
    expect(canonicalClaudeToolName('WEBSEARCH')).toBe('WebSearch')
    expect(canonicalClaudeToolName(' todoWrite ')).toBe('TodoWrite')
    expect(canonicalClaudeToolName('run_code')).toBeUndefined()

    const built = body({
      tools: [
        { name: 'read', description: 'r', parameters: { type: 'object' } },
        { name: 'my_tool', description: 'm', parameters: { type: 'object' } },
        { name: 'WebSearch', description: 'w', parameters: { type: 'object' } },
      ],
    })
    expect((built.tools as Array<Record<string, unknown>>).map((tool) => tool.name))
      .toEqual(['Read', 'my_tool', 'WebSearch'])
  })

  it('maps a returned canonical name back to the caller spelling, by exact then case-insensitive match', () => {
    const names = claudeToolNames([{ name: 'read' }, { name: 'bash' }])
    expect(names.enabled).toBe(true)
    expect(claudeOriginalToolName('Read', names)).toBe('read')
    expect(claudeOriginalToolName('READ', names)).toBe('read')
    expect(claudeOriginalToolName('Bash', names)).toBe('bash')
    expect(claudeOriginalToolName('my_tool', names)).toBe('my_tool')
    expect(claudeOriginalToolName('Nope', names)).toBe('Nope')
    // Without a translation table the name passes through unchanged.
    expect(claudeOriginalToolName('Read')).toBe('Read')
    expect(claudeWireToolName('read')).toBe('Read')
    // An offered name the translation does not carry is still normalized by the
    // single-name rule, and a name in NO list keeps its spelling.
    expect(claudeWireToolName('grep', names)).toBe('Grep')
    expect(claudeWireToolName('my_tool', names)).toBe('my_tool')
    expect(claudeWireToolName('zzz', names)).toBe('zzz')
  })

  it('DISABLES normalization for a request whose tools would collide', () => {
    // Two offered tools that canonicalize onto one wire name: sending 'Read'
    // twice would make the reply unattributable, so the real names go out.
    const names = claudeToolNames([{ name: 'read' }, { name: 'READ' }])
    expect(names.enabled).toBe(false)
    const built = buildClaudeRequestBody(options({
      tools: [{ name: 'read', description: 'r', parameters: { type: 'object' } }, { name: 'READ', description: 'R', parameters: { type: 'object' } }],
    }) as unknown as GenerateOptions, undefined, { toolNames: names })
    expect((built.tools as Array<Record<string, unknown>>).map((tool) => tool.name)).toEqual(['read', 'READ'])

    // The same rule catches a collision that exists only under case folding.
    const folded = claudeToolNames([{ name: 'bash' }, { name: 'Bash' }])
    expect(folded.enabled).toBe(false)
    expect(claudeWireToolName('bash', folded)).toBe('bash')
    expect(claudeWireToolName('Bash', folded)).toBe('Bash')
    // Distinct tools are not a collision.
    expect(claudeToolNames([{ name: 'read' }, { name: 'write' }]).enabled).toBe(true)
  })

  it('uses the request translation for a replayed tool call and for the response side', () => {
    const names = claudeToolNames([{ name: 'bash' }])
    const built = buildClaudeRequestBody(options({
      tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
      messages: [
        { role: 'assistant', source: { kind: 'model', provider: PROVIDER_ID, model: 'm' }, content: [
          { type: 'tool-call', id: 'toolu_9', name: 'bash', arguments: '{"command":"ls"}' },
        ] },
      ],
    }) as unknown as GenerateOptions, undefined, { toolNames: names })
    expect(messagesOf(built)[0]!.content[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_9',
      name: 'Bash',
      input: { command: 'ls' },
    })

    const state = createStreamState(names)
    const chunks = feed([
      ...eventLines({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: {} } }),
      ...eventLines({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } }),
      ...eventLines({ type: 'content_block_stop', index: 0 }),
    ], state)
    const block = chunks.find((chunk) => chunk.type === 'block-end')
    expect(block).toBeDefined()
    if (block === undefined || block.type !== 'block-end' || block.block.type !== 'tool-call') throw new Error('no tool-call block')
    expect(block.block.name).toBe('bash')
  })
})

describe('Request images', () => {
  const images: ResolvedRequestImages = new Map([
    ['att-1', { kind: 'inline', mediaType: 'image/png', data: 'AAAA' }],
    ['att-2', { kind: 'unavailable' }],
  ])

  it('inlines a durable image and turns an unreadable or unsupported one into visible text', () => {
    const built = buildClaudeRequestBody(options({
      messages: [
        { role: 'user', source: { kind: 'user' }, content: [
          { type: 'text', text: 'look' },
          { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 3, name: 'shot.png' } },
          { type: 'image', attachment: { attachmentId: 'att-2', mediaType: 'image/png', bytes: 3, name: 'gone.png' } },
          { type: 'image', attachment: { attachmentId: 'att-9', mediaType: 'image/tiff', bytes: 3, name: 'scan.tiff' }, data: 'data:image/tiff;base64,BBBB' },
        ] },
      ],
    }) as unknown as GenerateOptions, images)
    const content = messagesOf(built)[0]!.content
    expect(content[0]).toEqual({ type: 'text', text: 'look' })
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } })
    expect(String(content[2]!.text)).toContain('gone.png could not be read')
    expect(String(content[3]!.text)).toContain('scan.tiff uses image/tiff')
    expect(content[3]!.type).toBe('text')
  })

  it('inlines an image inside a tool result and takes the block-array form only then', () => {
    const built = buildClaudeRequestBody(options({
      messages: [
        { role: 'user', source: { kind: 'tool', callId: 'a' }, content: [
          { type: 'tool-result', toolCallId: 'a', content: [
            { type: 'text', text: 'screenshot follows' },
            { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 3 } },
          ] },
        ] },
      ],
    }) as unknown as GenerateOptions, images)
    expect(messagesOf(built)[0]!.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'a',
      content: [
        { type: 'text', text: 'screenshot follows' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
      cache_control: { type: 'ephemeral' },
    })
  })

  it('replaces the OLDEST images with a placeholder past the cap, leaving durable history untouched', () => {
    const durableMessages = [
      { role: 'user' as const, source: { kind: 'user' }, content: [
        { type: 'image' as const, attachment: { attachmentId: 'huge', mediaType: 'image/png', bytes: 9_000_000 } },
        { type: 'image' as const, attachment: { attachmentId: 'small', mediaType: 'image/png', bytes: 3 } },
      ] },
    ]
    const offloaded = offloadOldestRequestImages(options({ messages: durableMessages }) as unknown as GenerateOptions)
    const content = (offloaded.messages[0]!.content as unknown as Array<Record<string, unknown>>)
    expect(String(content[0]!.text)).toContain('[image omitted')
    expect(content[1]).toEqual(durableMessages[0]!.content[1])
    // The durable history the caller handed in is untouched.
    expect(durableMessages[0]!.content[0]).toEqual({ type: 'image', attachment: { attachmentId: 'huge', mediaType: 'image/png', bytes: 9_000_000 } })
    // Under the cap, nothing is rewritten at all: the same options object comes
    // back rather than a copy with a rewritten message.
    const small = options({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'image', data: 'AAA' }] }] }) as unknown as GenerateOptions
    expect(offloadOldestRequestImages(small)).toBe(small)
    expect(MAX_REQUEST_IMAGE_BYTES).toBe(8 * 1024 * 1024)
    // 9,000,000 raw bytes expand to 12,000,000 base64 characters, over the cap.
    expect(Math.ceil(9_000_000 / 3) * 4).toBeGreaterThan(MAX_REQUEST_IMAGE_BYTES)
  })
})

describe('SSE state machine', () => {
  it('parses the line-oriented event/data pair form and ignores unknown events', () => {
    const state = createStreamState()
    expect(feed(['event: ping', 'data: {"type":"ping"}'], state)).toEqual([])
    expect(feed([': keep-alive', '', 'data: {"type":"future_thing","payload":1}'], state)).toEqual([])
    expect(state.finished).toBe(false)
    expect(state.hasContent).toBe(false)
    // A malformed payload is skipped rather than thrown on.
    expect(feed(['data: {not json'], state)).toEqual([])
    // The 'event:' line alone never produces anything, even for a known type.
    expect(feed(['event: content_block_stop'], state)).toEqual([])
  })

  it('emits text, reasoning, tool-call and usage chunks for a full stream', () => {
    const lines = [
      ...eventLines(messageStart()),
      ...eventLines({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ...eventLines({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
      ...eventLines({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
      ...eventLines({ type: 'content_block_stop', index: 0 }),
      ...eventLines({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }),
      ...eventLines({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'weighing' } }),
      ...eventLines({ type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig-1' } }),
      ...eventLines({ type: 'content_block_stop', index: 1 }),
      ...eventLines({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_02', name: 'Read', input: {} } }),
      ...eventLines({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_' } }),
      ...eventLines({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'path":"a"}' } }),
      ...eventLines({ type: 'content_block_stop', index: 2 }),
      ...eventLines({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } }),
      ...eventLines({ type: 'message_stop' }),
    ]
    const state = createStreamState()
    const chunks = feed(lines, state)
    assertStreamComplete(state)

    const text = chunks.filter((chunk) => chunk.type === 'text-delta')
    expect(text).toEqual([
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
    ])
    const reasoning = chunks.filter((chunk) => chunk.type === 'reasoning-delta')
    expect(reasoning).toEqual([{ type: 'reasoning-delta', index: 1, text: 'weighing' }])
    expect(chunks.filter((chunk) => chunk.type === 'block-start')).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-start', index: 1, blockType: 'reasoning' },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
    ])

    const usage = chunks.find((chunk) => chunk.type === 'usage')
    expect(usage).toEqual({
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 42, cacheReadTokens: 4, cacheWriteTokens: 3, reasoningTokens: 2 },
    })
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    expect(finish !== undefined && finish.type === 'finish' ? finish.reason : undefined).toEqual({ kind: 'tool-calls' })

    // One closeStream call after the body ends is a no-op, not a second finish.
    expect(closeStream(state)).toEqual([])
  })

  it('concatenates input_json_delta fragments and parses them ONCE, at content_block_stop', () => {
    const state = createStreamState()
    const opening = feed([
      ...eventLines({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_03', name: 'Write', input: {} } }),
      ...eventLines({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_' } }),
      ...eventLines({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'path":"a",' } }),
    ], state)
    // Nothing is assembled before the block closes.
    expect(opening.filter((chunk) => chunk.type === 'block-end')).toEqual([])
    // The first delta is the (empty) seed from content_block_start, so a stream
    // whose input is complete at the start block is not mistaken for one whose
    // fragments are empty.
    expect(opening.filter((chunk) => chunk.type === 'tool-call-delta')).toEqual([
      { type: 'tool-call-delta', index: 0, id: 'toolu_03', name: 'Write', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 0, id: 'toolu_03', name: 'Write', argumentsDelta: '{"file_' },
      { type: 'tool-call-delta', index: 0, id: 'toolu_03', name: 'Write', argumentsDelta: 'path":"a",' },
    ])
    const closing = feed([
      ...eventLines({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"content":"hi"}' } }),
      ...eventLines({ type: 'content_block_stop', index: 0 }),
    ], state)
    expect(closing).toEqual([
      { type: 'tool-call-delta', index: 0, id: 'toolu_03', name: 'Write', argumentsDelta: '"content":"hi"}' },
      {
        type: 'block-end',
        index: 0,
        // The fragments are concatenated and parsed ONCE, here, into one object;
        // the caller still receives the RAW concatenated text.
        block: { type: 'tool-call', id: 'toolu_03', name: 'Write', arguments: '{"file_path":"a","content":"hi"}' },
      },
    ])
  })

  it('carries unparseable tool arguments through as raw text instead of killing the stream', () => {
    const state = createStreamState()
    const chunks = feed([
      ...eventLines({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_04', name: 'Read', input: {} } }),
      ...eventLines({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } }),
      ...eventLines({ type: 'content_block_stop', index: 0 }),
      ...eventLines({ type: 'message_stop' }),
    ], state)
    const block = chunks.find((chunk) => chunk.type === 'block-end')
    expect(block !== undefined && block.type === 'block-end' ? block.block : undefined).toEqual({
      type: 'tool-call',
      id: 'toolu_04',
      name: 'Read',
      arguments: '{"file_path":',
    })
  })

  it('seeds the accumulated input from content_block_start, so a non-fragment stream still assembles', () => {
    const state = createStreamState()
    const chunks = feed([
      ...eventLines({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_05', name: 'Glob', input: { pattern: '**/*.ts' } } }),
      ...eventLines({ type: 'content_block_stop', index: 0 }),
    ], state)
    const block = chunks.find((chunk) => chunk.type === 'block-end')
    expect(block !== undefined && block.type === 'block-end' ? block.block : undefined).toEqual({
      type: 'tool-call',
      id: 'toolu_05',
      name: 'Glob',
      arguments: '{"pattern":"**/*.ts"}',
    })
  })

  it('emits a redacted_thinking block as an empty reasoning block and replays its payload', () => {
    const state = createStreamState()
    const chunks = feed([
      ...eventLines({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'BLOB' } }),
      ...eventLines({ type: 'content_block_stop', index: 0 }),
    ], state)
    expect(chunks.filter((chunk) => chunk.type === 'block-end')).toEqual([
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } },
    ])
    const finish = closeStream(state)
    const terminal = finish.find((chunk) => chunk.type === 'finish')
    if (terminal === undefined || terminal.type !== 'finish') throw new Error('no finish chunk')
    expect(terminal.replayState).toEqual({
      response: { provider: PROVIDER_ID },
      blocks: [{ type: 'redacted_thinking', data: 'BLOB' }],
    })
  })

  it('THROWS on an error event and on a stream that never reached message_stop', () => {
    const errored = createStreamState()
    expect(() => feed([
      ...eventLines(messageStart()),
      ...eventLines({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    ], errored)).toThrow(/Overloaded/)

    const truncated = createStreamState()
    feed([
      ...eventLines(messageStart()),
      ...eventLines({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ...eventLines({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half an ans' } }),
    ], truncated)
    // The flush itself does not judge completeness...
    const flushed = closeStream(truncated)
    expect(flushed.filter((chunk) => chunk.type === 'block-end')).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'half an ans' } },
    ])
    // ...the verdict is separate, and a severed reply is not a finished answer.
    expect(() => assertStreamComplete(truncated)).toThrow(/terminal event/)
    expect(() => assertStreamComplete(createStreamState())).toThrow(/terminal event/)
  })

  it('maps an output-only stop to max-tokens and a plain stop to stop', () => {
    const state = createStreamState()
    const chunks = feed([
      ...eventLines(messageStart()),
      ...eventLines({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } }),
      ...eventLines({ type: 'message_stop' }),
    ], state)
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    expect(finish !== undefined && finish.type === 'finish' ? finish.reason : undefined).toEqual({ kind: 'max-tokens' })

    const stopped = createStreamState()
    const plain = feed([
      ...eventLines(messageStart()),
      ...eventLines({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
      ...eventLines({ type: 'message_stop' }),
    ], stopped)
    const plainFinish = plain.find((chunk) => chunk.type === 'finish')
    expect(plainFinish !== undefined && plainFinish.type === 'finish' ? plainFinish.reason : undefined).toEqual({ kind: 'stop' })
  })
})

describe('The finish chunk survives DSH\'s lossless-JSON check', () => {
  /**
   * The harness validates EVERY stream chunk as lossless JSON before the
   * session log accepts it, and throws "Assistant stream chunk must be
   * losslessly JSON-serializable" - failing the caller's whole turn - over a
   * single value JSON cannot carry. This is a transcription of those rules, so
   * the assertions below fail for the same reason the harness would, rather
   * than for a hand-written property that could drift from it.
   *
   * Its own `snapshotJsonValue`/`isJsonValue` live in the harness's internal
   * JSON-value module, which no published entry point re-exports, so the rules
   * are restated here. The cases that matter are the ones JSON.parse produces:
   * `undefined` (a parse miss or a reserved slot), `-0`, and out-of-range
   * literals that parse to a non-finite number.
   */
  function losslessJsonReason(value: unknown): string | undefined {
    const ancestors = new Set<object>()
    const walk = (current: unknown, path: string): string | undefined => {
      if (current === null) return undefined
      switch (typeof current) {
        case 'string':
        case 'boolean':
          return undefined
        case 'number':
          if (!Number.isFinite(current)) return `${path}: ${String(current)} is not a finite JSON number`
          if (Object.is(current, -0)) return `${path}: negative zero is not preserved by a JSON round trip`
          return undefined
        case 'object':
          break
        default:
          return `${path}: ${typeof current} is not a JSON value`
      }
      const object = current as object
      if (ancestors.has(object)) return `${path}: circular reference`
      ancestors.add(object)
      if (Array.isArray(object)) {
        // A hole and an explicit undefined both fail; JSON has no notion of one.
        for (let index = 0; index < object.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(object, index)) return `${path}[${index}]: array hole`
          const reason = walk(object[index], `${path}[${index}]`)
          if (reason !== undefined) return reason
        }
        ancestors.delete(object)
        return undefined
      }
      for (const key of Object.keys(object)) {
        const reason = walk((object as Record<string, unknown>)[key], `${path}.${key}`)
        if (reason !== undefined) return reason
      }
      ancestors.delete(object)
      return undefined
    }
    return walk(value, 'finish')
  }

  function finishOf(lines: readonly string[]): Record<string, unknown> {
    const state = createStreamState()
    const chunks = [...feed(lines, state), ...closeStream(state)]
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    if (finish === undefined || finish.type !== 'finish') throw new Error('no finish chunk')
    return finish as unknown as Record<string, unknown>
  }

  /**
   * The replay envelope's block entries, read with the whole `finish` chunk
   * narrowed first: `ReplayEnvelope.blocks` is `readonly unknown[] | undefined`,
   * so reading it needs the chunk in hand rather than a cast on the field.
   */
  function replayBlocksOf(finish: Record<string, unknown>): unknown[] {
    const state = finish.replayState as { blocks?: readonly unknown[] } | undefined
    return [...(state?.blocks ?? [])]
  }

  /**
   * A stream whose blocks cover every kind that writes a replay slot.
   *
   * Deliberately WITHOUT message_stop: the caller closes the stream itself, so a
   * test can still mutate state between the last block and the terminal chunk.
   * (A real stream ends with message_stop, which closes the stream in-line and
   * makes a later closeStream a documented no-op.)
   */
  const everyBlockKind = (toolInput: string): string[] => [
    ...eventLines(messageStart()),
    ...eventLines({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...eventLines({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'an answer' } }),
    ...eventLines({ type: 'content_block_stop', index: 0 }),
    ...eventLines({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }),
    ...eventLines({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'weighing' } }),
    ...eventLines({ type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig-1' } }),
    ...eventLines({ type: 'content_block_stop', index: 1 }),
    ...eventLines({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} } }),
    ...eventLines({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: toolInput } }),
    ...eventLines({ type: 'content_block_stop', index: 2 }),
    ...eventLines({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }),
  ]

  it('emits a finish chunk that is lossless JSON for every block kind', () => {
    // The regression: the text and tool-call branches used to reserve their
    // replay slot with `undefined`, so ANY answer containing text or a tool call
    // failed the caller's turn. Reproduced on this machine as 6 of 6 affected
    // turns across 5 sessions.
    const finish = finishOf(everyBlockKind('{"file_path":"a"}'))
    expect(losslessJsonReason(finish)).toBeUndefined()
    expect(finish.replayState).toEqual({
      response: { provider: PROVIDER_ID },
      // Index-aligned with the emitted blocks, in the order they opened.
      blocks: [
        null, // text: no verbatim wire block to replay
        { type: 'thinking', thinking: 'weighing', signature: 'sig-1' },
        { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: 'a' } },
      ],
    })
  })

  it('reserves a replay slot with null, never undefined', () => {
    // Asserted on the state as well as the chunk, because the slot is reserved
    // at content_block_start - long before closeStream runs the guard.
    const state = createStreamState()
    feed([
      ...eventLines(messageStart()),
      ...eventLines({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ...eventLines({ type: 'content_block_stop', index: 0 }),
      ...eventLines({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_02', name: 'Read', input: {} } }),
    ], state)
    expect(Object.keys(state.replayBlocks).length).toBe(2)
    expect(state.replayBlocks[0]).toBeNull()
    expect(state.replayBlocks[1]).toBeNull()
    for (const slot of state.replayBlocks) expect(slot === undefined).toBe(false)
  })

  it('turns a tool call with no arguments and an unparseable one into a JSON-safe empty input', () => {
    // safeJsonParse returns undefined for a missing or malformed fragment; that
    // used to be written straight into `input`.
    for (const raw of ['', '{not json', '{"a":1,"b":']) {
      const finish = finishOf(everyBlockKind(raw))
      expect(losslessJsonReason(finish)).toBeUndefined()
      expect(replayBlocksOf(finish)[2]).toEqual({ type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} })
    }
  })

  it('keeps a parsed tool input that JSON.parse accepts but a JSON round trip does not preserve', () => {
    // JSON.parse is not a safe source: it accepts -0 and out-of-range literals,
    // so a model emitting {"n":-0} or {"n":1e999} used to reach the harness as a
    // negative zero or an Infinity and reject the chunk.
    const finish = finishOf(everyBlockKind('{"neg":-0,"big":1e999,"ok":1}'))
    expect(losslessJsonReason(finish)).toBeUndefined()
    const blocks = replayBlocksOf(finish)
    expect(blocks[2]).toEqual({ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { neg: 0, ok: 1 } })
    // `-0` is normalized, not merely tolerated: it must read back as +0.
    const input = (blocks[2] as { input: Record<string, number> }).input
    expect(Object.is(input.neg, -0)).toBe(false)
    expect(input.neg).toBe(0)
  })

  it('still replays a signed thinking block verbatim, and reads a null slot as "nothing to replay"', () => {
    // The guard must not cost replay fidelity: this is the property the tool
    // loop depends on, and a null slot must read back exactly as undefined did.
    // Exercised through buildClaudeRequestBody (the real read path), because a
    // null that leaked into the wire body would be a 400.
    const blocks = [
      { type: 'text', text: 'an answer' },
      { type: 'reasoning', text: 'weighing' },
      { type: 'tool-call', id: 'toolu_01', name: 'Read', arguments: '{"file_path":"a"}' },
    ]
    const finish = finishOf(everyBlockKind('{"file_path":"a"}'))
    const assistant = createAssistantMessage({
      content: blocks as HarnessContentBlock[],
      source: { provider: PROVIDER_ID, model: 'claude-sonnet-4-6', replayState: finish.replayState },
    })
    const body = buildClaudeRequestBody(options({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] },
        assistant,
      ],
    }) as unknown as GenerateOptions)
    const messages = messagesOf(body)
    // The signed thinking block comes back byte-for-byte, in the position its
    // replay slot occupies (DSH index 1, after the text block)...
    expect(messages[1]!.content[1]).toEqual({ type: 'thinking', thinking: 'weighing', signature: 'sig-1' })
    // ...the text block whose slot is null is rebuilt from the DSH block, with
    // no null leaking into the request...
    expect(messages[1]!.content[0]).toEqual({ type: 'text', text: 'an answer' })
    // ...and the tool call is rebuilt from its DSH block with its parsed input.
    expect(messages[1]!.content[2]).toEqual({ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: 'a' } })
    expect(JSON.stringify(messages[1])).not.toContain('null')
  })

  it('does not let a future uninitialized slot cost the caller the whole turn', () => {
    // The guard's reason to exist: a block type added later that forgets to
    // reserve its slot degrades to a dropped replay entry, not a failed turn.
    const state = createStreamState()
    feed(everyBlockKind('{"file_path":"a"}'), state)
    // Simulate the future mistake BEFORE the terminal chunk is built: a slot
    // exactly where a producer forgot to write one (and a non-finite number,
    // which is the other shape a JSON round trip does not preserve).
    state.replayBlocks[2] = undefined as never
    const finish = closeStream(state).find((chunk) => chunk.type === 'finish')
    if (finish === undefined || finish.type !== 'finish') throw new Error('no finish chunk')
    expect(losslessJsonReason(finish)).toBeUndefined()
    const blocks = replayBlocksOf(finish)
    expect(blocks[2]).toBeNull()
    // The other entries keep their content.
    expect(blocks[1]).toEqual({ type: 'thinking', thinking: 'weighing', signature: 'sig-1' })
  })

  it('is idempotent: message_stop already emitted the terminal chunk', () => {
    // Pinned because the tests above rely on it: a real stream ends with
    // message_stop, and the adapter's own closing call must not add a second
    // finish (or a second replay envelope the harness would reject).
    const state = createStreamState()
    const chunks = feed([
      ...eventLines(messageStart()),
      ...eventLines({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ...eventLines({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }),
      ...eventLines({ type: 'content_block_stop', index: 0 }),
      ...eventLines({ type: 'message_stop' }),
    ], state)
    expect(chunks.filter((chunk) => chunk.type === 'finish')).toHaveLength(1)
    expect(closeStream(state)).toEqual([])
  })
})

describe('Usage mapping', () => {
  it('keeps the cache counters separate from inputTokens, because the three are disjoint', () => {
    const state = createStreamState()
    const chunks = feed([
      ...eventLines(messageStart()),
      ...eventLines({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }),
      ...eventLines({ type: 'message_stop' }),
    ], state)
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    if (usage === undefined || usage.type !== 'usage') throw new Error('no usage chunk')
    expect(usage.usage).toEqual({
      inputTokens: 12,
      outputTokens: 42,
      cacheReadTokens: 4,
      cacheWriteTokens: 3,
    })
    // The wire reports no reasoning split and this stream produced no thinking
    // text, so the field is absent rather than present-and-zero.
    expect(usage.usage.reasoningTokens).toBeUndefined()
    // The arithmetic this test exists for: inputTokens EXCLUDES cache reads and
    // writes, so billed input is the SUM of the three and not inputTokens alone.
    const billedInput = usage.usage.inputTokens + (usage.usage.cacheReadTokens ?? 0) + (usage.usage.cacheWriteTokens ?? 0)
    expect(billedInput).toBe(19)
    expect(usage.usage.inputTokens).toBe(12)
    expect(usage.usage.inputTokens).not.toBe(billedInput)
    expect(usage.usage.outputTokens).toBe(42)
  })

  it('reports the cache counters on the Opus 5.5 path — the request that asks for caching, and the answer that confirms it', () => {
    // The whole user-visible bug in one test: the REQUEST must ask for caching
    // (breakpoints) and the RESPONSE must then be able to report the counters.
    // Either half missing reads as "no cache hits at all" in the UI.
    const built = buildClaudeRequestBody(options({ model: 'claude-opus-5-5' }) as unknown as GenerateOptions)
    expect(countClaudeCacheBreakpoints(built)).toBeGreaterThan(0)

    const chunks = feed([
      ...eventLines(messageStart({
        input_tokens: 900,
        cache_creation_input_tokens: 12_000,
        cache_read_input_tokens: 40_000,
        output_tokens: 5,
      })),
      ...eventLines({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } }),
      ...eventLines({ type: 'message_stop' }),
    ], createStreamState())
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    if (usage === undefined || usage.type !== 'usage') throw new Error('no usage chunk')
    expect(usage.usage.cacheReadTokens).toBe(40_000)
    expect(usage.usage.cacheWriteTokens).toBe(12_000)
    expect(usage.usage.inputTokens).toBe(900)
  })

  it('omits the cache keys entirely when the stream reports none', () => {
    const state = createStreamState()
    const chunks = feed([
      ...eventLines(messageStart({ input_tokens: 5, output_tokens: 0 })),
      ...eventLines({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
      ...eventLines({ type: 'message_stop' }),
    ], state)
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    if (usage === undefined || usage.type !== 'usage') throw new Error('no usage chunk')
    expect(usage.usage).toEqual({ inputTokens: 5, outputTokens: 7 })
    expect('cacheReadTokens' in usage.usage).toBe(false)
    expect('cacheWriteTokens' in usage.usage).toBe(false)
  })

  it('treats message_delta output_tokens as CUMULATIVE rather than per-delta', () => {
    const state = createStreamState()
    const chunks = feed([
      ...eventLines(messageStart({ input_tokens: 5, output_tokens: 1 })),
      ...eventLines({ type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 10 } }),
      ...eventLines({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } }),
      ...eventLines({ type: 'message_stop' }),
    ], state)
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    if (usage === undefined || usage.type !== 'usage') throw new Error('no usage chunk')
    // Adding the two deltas would report 36; the last one is the total.
    expect(usage.usage.outputTokens).toBe(25)
  })

  it('emits no usage chunk at all when the stream stated none', () => {
    const state = createStreamState()
    const chunks = feed([
      ...eventLines({ type: 'message_start', message: { id: 'msg_x', usage: undefined } }),
      ...eventLines({ type: 'message_stop' }),
    ], state)
    expect(chunks.filter((chunk) => chunk.type === 'usage')).toEqual([])
  })
})

describe('The four modes as complete bodies', () => {
  /** One request shape, varied only by model and effort. */
  function requestFor(model: string, effort: string): Record<string, unknown> {
    return buildClaudeRequestBody(options({
      model,
      reasoningEffort: effort as ReasoningEffortId,
      maxTokens: 8000,
      // A temperature is asked for every time, so the gating is visible in the
      // per-mode snapshots below rather than only in its own test.
      temperature: 0.3,
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'bash', description: 'run', parameters: { $schema: 'x', type: 'object' } }],
    }) as unknown as GenerateOptions)
  }

  it('mid-convo emits adaptive+block_binding, output_config, an inflated ceiling and no temperature', () => {
    const built = requestFor('claude-opus-5', 'medium')
    expect(claudeThinkingMode('claude-opus-5')).toBe('mid-convo')
    expect(built.max_tokens).toBe(8000 + 8192)
    expect(built.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    })
    expect(built.output_config).toEqual({ effort: 'medium' })
    expect('temperature' in built).toBe(false)
    expect((built.tools as Array<Record<string, unknown>>)[0]).toEqual({
      name: 'Bash', description: 'run', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' },
    })
  })

  it('adaptive emits the plain adaptive form with an effort-named output_config', () => {
    const built = requestFor('claude-sonnet-4-6', 'high')
    expect(claudeThinkingMode('claude-sonnet-4-6')).toBe('adaptive')
    // The ceiling still grows by the level's budget, which is the reference's
    // own unconditional behaviour on the caller side (catalog RULE 4, lines
    // 676-685): max_tokens is a ceiling, and the form that spends it here is
    // chosen by the model rather than by this module.
    expect(built.max_tokens).toBe(8000 + 16_384)
    expect(built.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(built.output_config).toEqual({ effort: 'high' })
    expect('temperature' in built).toBe(false)
  })

  it('budget emits enabled+budget_tokens and no output_config', () => {
    const built = requestFor('claude-haiku-4-5', 'medium')
    expect(claudeThinkingMode('claude-haiku-4-5')).toBe('budget')
    expect(built.max_tokens).toBe(8000 + 8192)
    expect(built.thinking).toEqual({ type: 'enabled', budget_tokens: 8192, display: 'summarized' })
    expect('output_config' in built).toBe(false)
    expect('temperature' in built).toBe(false)
  })

  it('none emits no thinking field, no output_config, an untouched ceiling and the temperature', () => {
    const built = requestFor('claude-unknown-x', 'high')
    expect(claudeThinkingMode('claude-unknown-x')).toBe('none')
    expect(built.max_tokens).toBe(8000)
    expect('thinking' in built).toBe(false)
    expect('output_config' in built).toBe(false)
    expect(built.temperature).toBe(0.3)
  })
})

