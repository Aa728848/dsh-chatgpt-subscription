import { describe, expect, it } from 'vitest'
import type { ContentBlock, GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import { NO_RESOLVED_IMAGES } from '../src/host/common/request-images.ts'
import { toToolCallId } from '../src/host/common/brand-compat.ts'
import { TEST_FIRST_PARTY_CONTEXT } from './claude-api-fixtures.ts'
import { resolveClaudeApiModel, type ClaudeApiModelEntry } from '../src/host/claude-api/model-catalog.ts'
import { defaultClaudeApiSettings, type ClaudeApiSettings } from '../src/host/claude-api/token-store.ts'
import {
  buildClaudeApiRequest,
  claudeApiFirstUserText,
  countClaudeApiCacheBreakpoints,
  deriveClaudeApiBetas,
  type ClaudeApiRequestContext,
} from '../src/host/claude-api/mapper.ts'
import {
  CLAUDE_API_BASE_BETAS,
  CLAUDE_API_BETA_CLEAR_AT,
  CLAUDE_API_BETA_COMPACT,
  CLAUDE_API_BETA_FAST_MODE,
  CLAUDE_API_BETA_INLINE_TOOLS,
  CLAUDE_API_BETA_THINKING_BINDING,
  CLAUDE_API_IDENTITY_TEXT,
  claudeApiBillingBlock,
  claudeApiFingerprint,
  claudeApiMetadataUserId,
} from '../src/host/claude-api/types.ts'

const DEVICE_ID = 'a'.repeat(64)
const SESSION_UUID = '11111111-2222-4333-8444-555555555555'

function msg(role: Message['role'], content: ContentBlock[], source?: Message['source']): Message {
  return { role, content, ...(source !== undefined ? { source } : {}) }
}
function userText(text: string, source?: Message['source']): Message {
  return msg('user', [{ type: 'text', text }], source)
}
function assistantText(text: string): Message {
  return msg('assistant', [{ type: 'text', text }])
}
function systemText(text: string): Message {
  return msg('system', [{ type: 'text', text }])
}
function options(messages: Message[], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'claude-api', model: 'claude-fable-5-2', messages, ...extra }
}
function contextFor(entry: ClaudeApiModelEntry, settings: Partial<ClaudeApiSettings> = {}, extra: Partial<ClaudeApiRequestContext> = {}): ClaudeApiRequestContext {
  return { entry, settings: { ...defaultClaudeApiSettings(), ...settings }, version: '2.1.330', deviceId: DEVICE_ID, sessionUuid: SESSION_UUID, firstParty: TEST_FIRST_PARTY_CONTEXT, ...extra }
}
const fable = () => resolveClaudeApiModel('claude-fable-5-2')
const build = (opts: GenerateOptions, entry: ClaudeApiModelEntry = fable(), settings: Partial<ClaudeApiSettings> = {}, extra: Partial<ClaudeApiRequestContext> = {}) =>
  buildClaudeApiRequest(opts, NO_RESOLVED_IMAGES, contextFor(entry, settings, extra))
const messagesOf = (body: Record<string, unknown>) => body.messages as Array<Record<string, unknown>>
const systemOf = (body: Record<string, unknown>) => body.system as Array<Record<string, unknown>>
const effort = (value: string) => value as GenerateOptions['reasoningEffort']
const tool = (name: string, deferLoading?: true) => ({ name, description: name + ' tool', parameters: { type: 'object', properties: {} }, ...(deferLoading ? { deferLoading } : {}) })

describe('claude-api request shape', () => {
  it('sends three system blocks, billing first without a cache marker, and the metadata user_id', () => {
    const body = build(options([userText('Reply with exactly: OK')], { system: 'DSH system prompt' }))
    const system = systemOf(body)
    expect(system).toHaveLength(3)
    // The capture anchor: fingerprint of the user's own first text at 2.1.330 is 9e1.
    expect(claudeApiFingerprint('Reply with exactly: OK', '2.1.330')).toBe('9e1')
    expect(system[0]).toEqual({ type: 'text', text: claudeApiBillingBlock('2.1.330', 'Reply with exactly: OK', TEST_FIRST_PARTY_CONTEXT) })
    expect(system[1]).toEqual({ type: 'text', text: CLAUDE_API_IDENTITY_TEXT })
    expect(system[2]).toEqual({ type: 'text', text: 'DSH system prompt', cache_control: { type: 'ephemeral', scope: 'global' } })
    expect(body.metadata).toEqual({ user_id: claudeApiMetadataUserId(DEVICE_ID, SESSION_UUID) })
    expect(JSON.parse((body.metadata as Record<string, string>).user_id)).toEqual({ device_id: DEVICE_ID, account_uuid: '', session_id: SESSION_UUID })
    expect(body.stream).toBe(true)
    expect(body.model).toBe('claude-fable-5-2')
  })

  it('omits the third system block when there is no system prompt', () => {
    const body = build(options([userText('hello')]))
    expect(systemOf(body)).toHaveLength(2)
  })

  it('uses ONE context version for the billing block and the fingerprint', () => {
    const body = build(options([userText('Reply with exactly: OK')]), fable(), {}, { version: '9.9.9' })
    expect(systemOf(body)[0]?.text).toBe(claudeApiBillingBlock('9.9.9', 'Reply with exactly: OK', TEST_FIRST_PARTY_CONTEXT))
    expect(systemOf(body)[0]?.text).toContain('cc_version=9.9.9.' + claudeApiFingerprint('Reply with exactly: OK', '9.9.9'))
  })

  it('reads the user own first text past reminders and tool results', () => {
    const reminder = '<system-reminder>\nbootstrap\n</system-reminder>'
    const mixed = msg('user', [{ type: 'text', text: reminder }, { type: 'text', text: 'Own prompt' }])
    expect(claudeApiFirstUserText(options([mixed]))).toBe('Own prompt')
    const toolTurn = msg('user', [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'result text' }] }], { kind: 'tool', callId: 'c1' })
    expect(claudeApiFirstUserText(options([toolTurn, userText('Real request')]))).toBe('Real request')
    expect(claudeApiFirstUserText(options([msg('user', [{ type: 'text', text: reminder }])]))).toBe('')
    expect(claudeApiFirstUserText(options([]))).toBe('')
  })

  it('bounds max_tokens by the model cap', () => {
    expect(build(options([userText('u')], { maxTokens: 999_999 })).max_tokens).toBe(128_000)
    expect(build(options([userText('u')])).max_tokens).toBe(16_384)
  })
})

describe('claude-api system messages', () => {
  it('keeps a legal mid-conversation system message in place', () => {
    const body = build(options([userText('u'), systemText('mid instruction'), assistantText('a')]))
    const messages = messagesOf(body)
    expect(messages.map(m => m.role)).toEqual(['user', 'system', 'assistant', 'user'])
    expect(messages[1]?.content).toEqual([{ type: 'text', text: 'mid instruction' }])
    expect(systemOf(body)).toHaveLength(2)
  })

  it('folds system messages on a model without midConversationSystem', () => {
    const body = build(options([userText('u'), systemText('mid instruction'), assistantText('a')]), resolveClaudeApiModel('claude-sonnet-4-6'))
    expect(messagesOf(body).some(m => m.role === 'system')).toBe(false)
    expect(systemOf(body)[2]?.text).toBe('mid instruction')
  })

  it('folds a system message at an illegal position (first)', () => {
    const body = build(options([systemText('leading'), userText('u')]))
    expect(messagesOf(body).some(m => m.role === 'system')).toBe(false)
    expect(systemOf(body)[2]?.text).toBe('leading')
  })

  it('allows a system message after an assistant turn ending in a server tool result', () => {
    const serverTurn = msg('assistant', [{ type: 'text', text: 'searching' }], { kind: 'model', replayState: { response: { provider: 'claude-api', protocol: 'anthropic' }, blocks: [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
    ] } })
    const legal = build(options([userText('u'), serverTurn, systemText('mid'), assistantText('a')]))
    expect(messagesOf(legal).map(m => m.role)).toEqual(['user', 'assistant', 'system', 'assistant', 'user'])
    const plainTurn = msg('assistant', [{ type: 'text', text: 'no server result' }], { kind: 'model', replayState: { response: { provider: 'claude-api', protocol: 'anthropic' }, blocks: [{ type: 'text', text: 'no server result' }] } })
    const illegal = build(options([userText('u'), plainTurn, systemText('mid'), assistantText('a')]))
    expect(messagesOf(illegal).some(m => m.role === 'system')).toBe(false)
  })

  it('judges adjacent system messages as a group', () => {
    const legal = build(options([userText('u'), systemText('A'), systemText('B'), assistantText('a')]))
    expect(messagesOf(legal).map(m => m.role)).toEqual(['user', 'system', 'system', 'assistant', 'user'])
    const illegal = build(options([userText('u'), systemText('A'), systemText('B'), userText('u2')]))
    expect(messagesOf(illegal).some(m => m.role === 'system')).toBe(false)
    expect(systemOf(illegal)[2]?.text).toBe('A\n\nB')
  })
})

describe('claude-api tool changes', () => {
  it('converts a developer tool change at a legal position into a system tool_addition', () => {
    const opts = options([userText('u'), msg('developer', [{ type: 'tool-addition', toolName: 'Bash' }]), assistantText('a')], { tools: [tool('Bash')] })
    const body = build(opts)
    expect(messagesOf(body)[1]).toEqual({ role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'Bash' } }] })
    expect(deriveClaudeApiBetas(body, fable())).not.toContain(CLAUDE_API_BETA_INLINE_TOOLS)
  })

  it('falls back to a user-side note at an illegal position', () => {
    const opts = options([msg('developer', [{ type: 'tool-removal', toolName: 'Bash' }]), userText('u')], { tools: [tool('Bash')] })
    const messages = messagesOf(build(opts))
    expect(messages[0]?.role).toBe('user')
    expect(JSON.stringify(messages[0]?.content)).toContain('Bash')
    expect(JSON.stringify(messages[0]?.content)).toContain('no longer available')
    expect(messages.some(m => m.role === 'system')).toBe(false)
  })

  it('prepends a non-deferred placeholder when every tool is deferred and history states a change', () => {
    const opts = options([userText('u'), msg('developer', [{ type: 'tool-addition', toolName: 'Bash' }]), assistantText('a')], { tools: [tool('Bash', true)] })
    const tools = build(opts).tools as Array<Record<string, unknown>>
    expect(tools[0]?.name).toBe('tool_update_placeholder')
    expect(tools[0]?.defer_loading).toBeUndefined()
    expect(tools[1]?.defer_loading).toBe(true)
    const noChange = build(options([userText('u')], { tools: [tool('Bash', true)] }))
    expect((noChange.tools as Array<Record<string, unknown>>)[0]?.name).toBe('Bash')
  })

  it('sends exactly the four tool fields without case normalization', () => {
    const body = build(options([userText('u')], { tools: [{ name: 'readFile', description: 'd', parameters: { type: 'object', properties: {}, $schema: 'http://json-schema.org/draft-07/schema#' } }] }))
    const tools = body.tools as Array<Record<string, unknown>>
    expect(Object.keys(tools[0] ?? {}).filter(key => key !== 'cache_control').sort()).toEqual(['description', 'input_schema', 'name'])
    expect(tools[0]?.name).toBe('readFile')
    expect((tools[0]?.input_schema as Record<string, unknown>).$schema).toBeUndefined()
  })
})

describe('claude-api thinking and temperature', () => {
  it('sends adaptive thinking with unconditional block_binding on preservedThinking models', () => {
    const body = build(options([userText('u')]))
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
    expect(body.output_config).toBeUndefined()
    const withEffort = build(options([userText('u')], { reasoningEffort: effort('high') }))
    expect(withEffort.output_config).toEqual({ effort: 'high' })
  })

  it('omits block_binding when preservedThinking is false', () => {
    const body = build(options([userText('u')]), resolveClaudeApiModel('claude-fable-5'))
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  })

  it('sends disabled thinking WITHOUT block_binding (upstream 400 on thinking.disabled.block_binding)', () => {
    const entry = resolveClaudeApiModel('claude-haiku-5-5')
    const body = build(options([userText('u')], { reasoningEffort: effort('none') }), entry)
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.context_management).toBeUndefined()
    expect(deriveClaudeApiBetas(body, entry)).toContain(CLAUDE_API_BETA_THINKING_BINDING)
  })

  it('sends the budget form on legacy models', () => {
    const body = build(options([userText('u')]), resolveClaudeApiModel('claude-sonnet-4-5-20250929'))
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(body.max_tokens as number).toBeGreaterThanOrEqual(8192 + 1024)
    const off = build(options([userText('u')], { reasoningEffort: effort('none') }), resolveClaudeApiModel('claude-sonnet-4-5-20250929'))
    expect(off.thinking).toEqual({ type: 'disabled' })
  })

  it('sends no thinking field on a plain gateway model', () => {
    const body = build(options([userText('u')], { temperature: 0.5 }), resolveClaudeApiModel('gateway-plain'))
    expect(body.thinking).toBeUndefined()
    expect(body.temperature).toBe(0.5)
  })

  it('never sends temperature where forbidden', () => {
    expect(build(options([userText('u')], { temperature: 0.7 })).temperature).toBeUndefined()
    expect(build(options([userText('u')], { temperature: 0.7 }), resolveClaudeApiModel('claude-fable-5-1')).temperature).toBeUndefined()
    const off = build(options([userText('u')], { temperature: 0.7, reasoningEffort: effort('none') }), resolveClaudeApiModel('claude-sonnet-4-6'))
    expect(off.temperature).toBe(0.7)
  })

  it('sends context_management only while thinking is enabled and contextEditing is true', () => {
    const body = build(options([userText('u')]))
    expect(body.context_management).toEqual({ edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] })
    // The frozen legacy row keeps contextEditing true, so budget thinking carries it too.
    const legacy = build(options([userText('u')]), resolveClaudeApiModel('claude-sonnet-4-5-20250929'))
    expect(legacy.context_management).toEqual({ edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] })
    const off = build(options([userText('u')], { reasoningEffort: effort('none') }), resolveClaudeApiModel('claude-sonnet-4-5-20250929'))
    expect(off.context_management).toBeUndefined()
  })
})

describe('claude-api replay', () => {
  it('replays signed thinking (even empty) and server tool blocks verbatim from the envelope', () => {
    const wireBlocks = [
      { type: 'thinking', thinking: '', signature: 'sig-empty' },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', title: 't', url: 'u', encrypted_content: 'e' }] },
      { type: 'text', text: 'answer' },
    ]
    const message = msg('assistant', [{ type: 'reasoning', text: '' }, { type: 'text', text: 'answer' }], { kind: 'model', replayState: { response: { provider: 'claude-api', protocol: 'anthropic' }, blocks: wireBlocks } })
    const body = build(options([userText('u'), message]))
    expect(messagesOf(body)[1]?.content).toEqual(wireBlocks)
  })

  it('does not replay an envelope from another provider', () => {
    const message = msg('assistant', [{ type: 'text', text: 'right' }], { kind: 'model', replayState: { response: { provider: 'relayone', protocol: 'anthropic' }, blocks: [{ type: 'text', text: 'WRONG' }] } })
    const body = build(options([userText('u'), message]))
    expect(messagesOf(body)[1]?.content).toEqual([{ type: 'text', text: 'right' }])
  })

  it('drops unsigned reasoning without an envelope', () => {
    const body = build(options([msg('assistant', [{ type: 'reasoning', text: 'unsigned' }])]))
    expect(messagesOf(body)).toHaveLength(0)
  })

  it('replays a signed reasoning block without an envelope', () => {
    const signed = { type: 'reasoning', text: 'thought', signature: 'sig' } as unknown as ContentBlock
    const body = build(options([msg('assistant', [signed])]))
    expect(messagesOf(body)[0]?.content).toEqual([{ type: 'thinking', thinking: 'thought', signature: 'sig' }])
  })

  it('maps tool calls and tool results onto the wire', () => {
    const call = msg('assistant', [{ type: 'tool-call', id: toToolCallId('toolu_1'), name: 'Bash', arguments: '{"command":"ls"}' }])
    const result = msg('user', [{ type: 'tool-result', toolCallId: 'toolu_1', content: [{ type: 'text', text: 'file list' }] }], { kind: 'tool', callId: 'toolu_1' })
    const messages = messagesOf(build(options([userText('u'), call, result])))
    expect(messages[1]?.content).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }])
    // The last user block carries the conversation cache breakpoint (tool_result is markable).
    expect(messages[2]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file list', cache_control: { type: 'ephemeral' } }])
  })

  it('normalizes a foreign Responses tool id consistently before pairing its result', () => {
    const foreign = 'call_4mt2LEbvc0DaBPCGP3dK5cvc|fc_0e3c3b45d14c8351016aea0c329d5887d2aa952cfd9841fc8c'
    const call = msg('assistant', [{ type: 'tool-call', id: toToolCallId(foreign), name: 'run_code', arguments: '{"code":"return 1"}' }], { kind: 'model', provider: 'sub2api' })
    const result = msg('user', [{ type: 'tool-result', toolCallId: foreign, content: [{ type: 'text', text: '1' }] }], { kind: 'tool', callId: foreign })
    const messages = messagesOf(build(options([userText('u'), call, result, userText('next')])))
    const toolUse = (messages[1]?.content as Array<Record<string, unknown>>)[0]
    const toolResult = (messages[2]?.content as Array<Record<string, unknown>>)[0]
    expect(toolUse?.type).toBe('tool_use')
    expect(toolUse?.id).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: toolUse?.id })
    expect(toolUse?.id).not.toBe(foreign)
  })
})

describe('claude-api cache breakpoints and speed', () => {
  it('marks system prompt, last user block and last tool, never identity, at 5m', () => {
    const opts = options([userText('u')], { system: 'prompt', tools: [tool('Bash'), tool('Read')] })
    const body = build(opts)
    expect(countClaudeApiCacheBreakpoints(body)).toBe(3)
    const markers: unknown[] = []
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visit); return }
      if (typeof value !== 'object' || value === null) return
      const record = value as Record<string, unknown>
      if (record.cache_control !== undefined) markers.push(record.cache_control)
      Object.values(record).forEach(visit)
    }
    visit(body)
    expect(markers).toHaveLength(3)
    expect(markers).toContainEqual({ type: 'ephemeral', scope: 'global' })
    const tools = body.tools as Array<Record<string, unknown>>
    expect(tools[0]?.cache_control).toBeUndefined()
    expect(tools[1]?.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('writes ttl 1h at the 1h tier and never marks deferred tools', () => {
    const opts = options([userText('u')], { system: 'prompt', tools: [tool('Bash'), tool('Read', true)] })
    const body = build(opts, fable(), { cacheTtl: '1h' })
    expect(countClaudeApiCacheBreakpoints(body)).toBe(3)
    const tools = body.tools as Array<Record<string, unknown>>
    expect(tools[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(tools[1]?.cache_control).toBeUndefined()
    expect(systemOf(body)[1]?.cache_control).toBeUndefined()
    expect(systemOf(body)[2]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h', scope: 'global' })
  })

  it('stays within four breakpoints in degraded shapes', () => {
    expect(countClaudeApiCacheBreakpoints(build(options([userText('u')])))).toBe(1)
    expect(countClaudeApiCacheBreakpoints(build(options([userText('u')], { system: 'p' })))).toBe(2)
    expect(countClaudeApiCacheBreakpoints(build(options([])))).toBe(0)
  })

  it('keeps the history breakpoint when a turn-scoped message ends the history', () => {
    const opts = options([userText('u'), userText('nudge text', { kind: 'progress-updates-nudge' })], { system: 'prompt', tools: [tool('Bash')] })
    const body = build(opts)
    const messages = messagesOf(body)
    expect(messages.at(-1)?.role).toBe('system')
    expect(messages.at(-1)?.clear_at).toBe('next_user_message')
    expect(countClaudeApiCacheBreakpoints(body)).toBe(3)
    expect((messages[0]?.content as Array<Record<string, unknown>>)[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(JSON.stringify(messages.at(-1))).not.toContain('cache_control')
  })

  it('keeps the history breakpoint when an in-place system message ends the history', () => {
    const opts = options([userText('u'), systemText('mid')], { system: 'prompt', tools: [tool('Bash')] })
    const body = build(opts)
    const messages = messagesOf(body)
    expect(messages.at(-1)?.role).toBe('system')
    expect(messages.at(-1)?.clear_at).toBeUndefined()
    expect(countClaudeApiCacheBreakpoints(body)).toBe(3)
    expect((messages[0]?.content as Array<Record<string, unknown>>)[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(JSON.stringify(messages.at(-1))).not.toContain('cache_control')
  })

  it('keeps the preceding user breakpoint intact as a cross-provider history advances', () => {
    const history = [
      userText('old Kimi question', { kind: 'user' }),
      assistantText('old Kimi answer'),
      userText('first Claude question'),
    ]
    const requestOptions = { system: 'static prompt', tools: [tool('Bash')] }
    const first = build(options(history, requestOptions))
    const second = build(options([...history, assistantText('first Claude answer'), userText('second Claude question')], requestOptions))
    const firstTail = (messagesOf(first).at(-1)?.content as Array<Record<string, unknown>>)[0]
    const secondPrevious = (messagesOf(second)[2]?.content as Array<Record<string, unknown>>)[0]
    expect(firstTail?.cache_control).toEqual({ type: 'ephemeral' })
    expect(secondPrevious).toEqual(firstTail)
    expect(countClaudeApiCacheBreakpoints(second)).toBe(4)

    const third = build(options([
      ...history,
      assistantText('first Claude answer'),
      userText('second Claude question'),
      assistantText('second Claude answer'),
      userText('third Claude question'),
    ], requestOptions))
    const thirdPrevious = (messagesOf(third)[4]?.content as Array<Record<string, unknown>>)[0]
    expect(thirdPrevious?.cache_control).toEqual({ type: 'ephemeral' })
    expect(countClaudeApiCacheBreakpoints(third)).toBe(4)
  })

  it('reserves the history-marker budget when static and dynamic system blocks coexist', () => {
    const history = [systemText('dynamic runtime'), userText('old Kimi question'), assistantText('old answer'), userText('current question')]
    const first = build(options(history, { system: 'static prompt', tools: [tool('Bash')] }))
    const next = build(options([...history, assistantText('answer'), userText('next question')], { system: 'static prompt', tools: [tool('Bash')] }))
    const messages = messagesOf(next)
    const previous = (messages[2]?.content as Array<Record<string, unknown>>)[0]
    const current = (messages.at(-1)?.content as Array<Record<string, unknown>>)[0]
    expect(previous?.cache_control).toEqual({ type: 'ephemeral' })
    expect(current?.cache_control).toEqual({ type: 'ephemeral' })
    expect(systemOf(next)[2]?.cache_control).toEqual({ type: 'ephemeral', scope: 'global' })
    expect(countClaudeApiCacheBreakpoints(next)).toBe(4)
    expect(countClaudeApiCacheBreakpoints(first)).toBeLessThanOrEqual(4)
  })

  it('sends speed only when settings allow it and the model has fast mode', () => {
    expect(build(options([userText('u')]), fable(), { fastMode: true }).speed).toBe('fast')
    expect(build(options([userText('u')]), resolveClaudeApiModel('claude-sonnet-5-5'), { fastMode: true }).speed).toBeUndefined()
    expect(build(options([userText('u')]), fable(), { fastMode: false }).speed).toBeUndefined()
  })
})

describe('claude-api turn-scoped system messages', () => {
  const nudge = (kind: string) => userText('nudge text', { kind })
  it('converts both turn-scoped source kinds at a legal position', () => {
    for (const kind of ['progress-updates-nudge', 'kimi-repeat-breaker']) {
      const body = build(options([userText('u'), nudge(kind), assistantText('a')]))
      expect(messagesOf(body)[1]).toEqual({ role: 'system', content: [{ type: 'text', text: 'nudge text' }], clear_at: 'next_user_message' })
      expect(deriveClaudeApiBetas(body, fable())).toContain(CLAUDE_API_BETA_CLEAR_AT)
    }
  })
  it('does not convert another source kind', () => {
    const body = build(options([userText('u'), nudge('some-other-kind'), assistantText('a')]))
    expect(messagesOf(body).some(m => m.role === 'system')).toBe(false)
    expect(deriveClaudeApiBetas(body, fable())).toContain(CLAUDE_API_BETA_CLEAR_AT)
  })
  it('does not convert at an illegal position (directly followed by a user turn)', () => {
    const body = build(options([userText('u'), nudge('progress-updates-nudge'), userText('u2'), assistantText('a')]))
    expect(messagesOf(body).some(m => m.role === 'system')).toBe(false)
    expect(JSON.stringify(messagesOf(body))).toContain('nudge text')
  })
  it('does not convert on a model without midConversationSystem', () => {
    const body = build(options([userText('u'), nudge('progress-updates-nudge'), assistantText('a')]), resolveClaudeApiModel('claude-sonnet-4-6'))
    expect(messagesOf(body).some(m => m.role === 'system')).toBe(false)
  })
  it('builds the same history byte-identically twice', () => {
    const opts = options([
      userText('u'),
      msg('developer', [{ type: 'tool-addition', toolName: 'Bash' }]),
      nudge('progress-updates-nudge'),
      assistantText('a'),
      systemText('folded'),
    ], { system: 'prompt', tools: [tool('Bash')] })
    expect(JSON.stringify(build(opts))).toBe(JSON.stringify(build(opts)))
  })
})

describe('claude-api beta derivation', () => {
  const plain = () => build(options([userText('u')]))
  it('always sends the base set first, in order', () => {
    expect(deriveClaudeApiBetas(plain(), fable()).slice(0, CLAUDE_API_BASE_BETAS.length)).toEqual([...CLAUDE_API_BASE_BETAS])
  })
  it('thinking-binding beta remains in the first-party base set', () => {
    expect(deriveClaudeApiBetas(plain(), fable())).toContain(CLAUDE_API_BETA_THINKING_BINDING)
    expect(deriveClaudeApiBetas(build(options([userText('u')]), resolveClaudeApiModel('claude-fable-5')), fable())).toContain(CLAUDE_API_BETA_THINKING_BINDING)
  })
  it('compact beta follows top-level compaction or a compaction block', () => {
    expect(deriveClaudeApiBetas({ ...plain(), compaction: { type: 'summarize' } }, fable())).toContain(CLAUDE_API_BETA_COMPACT)
    const withBlock = { messages: [{ role: 'assistant', content: [{ type: 'compaction', content: 's', signature: 'g' }] }] }
    expect(deriveClaudeApiBetas(withBlock, fable())).toContain(CLAUDE_API_BETA_COMPACT)
    expect(deriveClaudeApiBetas(plain(), fable())).not.toContain(CLAUDE_API_BETA_COMPACT)
  })
  it('inline-tools beta follows tool_definition additions or compaction with tool changes', () => {
    const inline = { messages: [{ role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', name: 'X', input_schema: {} } }] }] }
    expect(deriveClaudeApiBetas(inline, fable())).toContain(CLAUDE_API_BETA_INLINE_TOOLS)
    const compactWithChanges = { compaction: { type: 'summarize' }, messages: [{ role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'X' } }] }] }
    expect(deriveClaudeApiBetas(compactWithChanges, fable())).toContain(CLAUDE_API_BETA_INLINE_TOOLS)
    const referenceOnly = { messages: [{ role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'X' } }] }] }
    expect(deriveClaudeApiBetas(referenceOnly, fable())).not.toContain(CLAUDE_API_BETA_INLINE_TOOLS)
  })
  it('fast-mode beta follows speed on a beta fast-mode model only', () => {
    const betaEntry = resolveClaudeApiModel('claude-opus-5')
    const fast = build(options([userText('u')]), betaEntry, { fastMode: true })
    expect(fast.speed).toBe('fast')
    expect(deriveClaudeApiBetas(fast, betaEntry)).toContain(CLAUDE_API_BETA_FAST_MODE)
    const ga = build(options([userText('u')]), fable(), { fastMode: true })
    expect(deriveClaudeApiBetas(ga, fable())).not.toContain(CLAUDE_API_BETA_FAST_MODE)
    expect(deriveClaudeApiBetas(plain(), betaEntry)).not.toContain(CLAUDE_API_BETA_FAST_MODE)
  })
})

describe('claude-api checkpoint replacement', () => {
  const checkpointText = 'preamble\n\n<compacted-summary>\nsummary body\n</compacted-summary>'
  const checkpoint = () => msg('user', [{ type: 'text', text: checkpointText }], { kind: 'compact-checkpoint' })
  const stored = { content: 'summary body', signature: 'sig', toolChanges: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'Bash' } }] }
  it('replaces a leading checkpoint with the stored compaction block and derives the compact beta', () => {
    const context = contextFor(fable(), {}, { compactionBlocks: { lookup: summary => summary === 'summary body' ? stored : undefined } })
    const body = buildClaudeApiRequest(options([checkpoint(), userText('next')]), NO_RESOLVED_IMAGES, context)
    expect(messagesOf(body)[0]).toEqual({ role: 'assistant', content: [{ type: 'compaction', content: 'summary body', signature: 'sig', tool_changes: stored.toolChanges }] })
    expect(deriveClaudeApiBetas(body, fable())).toContain(CLAUDE_API_BETA_COMPACT)
  })
  it('keeps the text form when the summary is not found', () => {
    const context = contextFor(fable(), {}, { compactionBlocks: { lookup: () => undefined } })
    const body = buildClaudeApiRequest(options([checkpoint(), userText('next')]), NO_RESOLVED_IMAGES, context)
    const first = messagesOf(body)[0]
    expect(first?.role).toBe('user')
    expect(JSON.stringify(first?.content)).toContain('<compacted-summary>')
    expect(deriveClaudeApiBetas(body, fable())).not.toContain(CLAUDE_API_BETA_COMPACT)
  })
})

describe('claude-api placement after the compaction block', () => {
  const checkpoint = () => msg('user', [{ type: 'text', text: 'preamble\n\n<compacted-summary>summary body</compacted-summary>' }], { kind: 'compact-checkpoint' })
  const found = { compactionBlocks: { lookup: (summary: string) => summary === 'summary body' ? { content: 'summary body', signature: 'sig' } : undefined } }
  it('keeps a nudge directly after the block in user form', () => {
    const body = build(options([checkpoint(), userText('nudge text', { kind: 'progress-updates-nudge' }), assistantText('a')]), fable(), {}, found)
    const messages = messagesOf(body)
    expect((messages[0]?.content as Array<Record<string, unknown>>)[0]?.type).toBe('compaction')
    expect(messages[1]?.role).toBe('user')
    expect(messages.some(m => m.clear_at !== undefined)).toBe(false)
    expect(deriveClaudeApiBetas(body, fable())).toContain(CLAUDE_API_BETA_CLEAR_AT)
  })
  it('folds a system message directly after the block', () => {
    const body = build(options([checkpoint(), systemText('mid'), assistantText('a')]), fable(), {}, found)
    expect(messagesOf(body).some(m => m.role === 'system')).toBe(false)
    expect(systemOf(body)[2]?.text).toBe('mid')
  })
  it('falls back to a user note for a tool change directly after the block', () => {
    const body = build(options([checkpoint(), msg('developer', [{ type: 'tool-addition', toolName: 'Bash' }]), assistantText('a')], { tools: [tool('Bash')] }), fable(), {}, found)
    expect(messagesOf(body).some(m => m.role === 'system')).toBe(false)
    expect(JSON.stringify(messagesOf(body))).toContain('now available')
  })
  it('still converts a nudge after a checkpoint that stayed in text form', () => {
    const body = build(options([checkpoint(), userText('nudge text', { kind: 'progress-updates-nudge' }), assistantText('a')]), fable(), {}, { compactionBlocks: { lookup: () => undefined } })
    expect(messagesOf(body).some(m => m.clear_at !== undefined)).toBe(true)
  })
})
