import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AdvisorService } from '../../src/host/runtime/advisor/index.ts'
import { AdvisorSelectionStore, type AdvisorDefaults } from '../../src/host/runtime/advisor/selection-store.ts'
import { projectAdvisorTranscript } from '../../src/host/runtime/advisor/transcript.ts'
import { requestAdvisor, type AdvisorLlm } from '../../src/host/runtime/advisor/request.ts'
import { ADVISOR_TOOL_DESCRIPTION } from '../../src/host/runtime/advisor/prompt.ts'

const files: string[] = []
afterEach(async () => { await Promise.all(files.splice(0).map((file) => fs.unlink(file).catch(() => undefined))) })
function defaults(): AdvisorDefaults {
  return {
    enabled: false, selection: null, maxTokens: 4096, timeoutMs: 300000,
    maxRetries: 1, contextTokenBudget: 100000, sessionTokenBudget: 200000,
  }
}
function store(): AdvisorSelectionStore {
  const file = path.join(os.tmpdir(), `dsh-advisor-${randomUUID()}.json`)
  files.push(file)
  return new AdvisorSelectionStore(defaults, file)
}
function user(text: string) { return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) }
function agent(messages = [user('Implement the feature')], header?: { provider: string; model: string }) {
  return {
    id: 'session-a',
    session: {
      id: 'session-a',
      deriveMessages: () => messages,
      requestHeader: () => (header === undefined ? undefined : { config: header }),
    },
  }
}
function success(text = 'Check the completion criteria.'): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text } as const
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 8 } } as const
    yield { type: 'finish', reason: { kind: 'stop' } } as const
  })()
}

// The description is the only trigger the main model reads, so the boundary with
// ask_user_question is a contract rather than prose: a second opinion on the model's own
// reading, never an answer to what the user wants.
describe('ADVISOR_TOOL_DESCRIPTION', () => {
  it('sends user-owned decisions to the user instead of the advisor', () => {
    expect(ADVISOR_TOOL_DESCRIPTION).toContain('Ask the user instead')
    expect(ADVISOR_TOOL_DESCRIPTION).toContain('never grants a decision the user owns')
    expect(ADVISOR_TOOL_DESCRIPTION).toContain('Never put the same question to both')
    expect(ADVISOR_TOOL_DESCRIPTION).not.toMatch(/abandon/i)
  })
})

describe('AdvisorService', () => {
  it('is disabled by default and performs no model request', async () => {
    const stream = vi.fn()
    const service = new AdvisorService(store(), { stream })
    const result = await service.consult({ question: 'Review plan' }, agent(), new AbortController().signal)
    expect(result.status).toBe('disabled')
    expect(stream).not.toHaveBeenCalled()
  })

  it('routes a read-only independent request through the selected provider', async () => {
    const selections = store()
    await selections.update('session-a', { enabled: true, selection: { provider: 'claude-api', model: 'claude-opus', reasoningEffort: 'high' } })
    let request: GenerateOptions<'advisor'> | undefined
    const llm: AdvisorLlm = {
      stream: (options) => { request = options; return success() },
      resolveModelInfo: async () => ({ contextWindow: 200000, maxTokens: 8192, inputModalities: ['text', 'image'] }),
    }
    const service = new AdvisorService(selections, llm)
    const result = await service.consult({ question: 'Check completeness', focus: 'completion' }, agent(), new AbortController().signal)
    expect(result.status).toBe('ok')
    expect(result.advice).toContain('completion criteria')
    expect(request).toMatchObject({ provider: 'claude-api', model: 'claude-opus', reasoningEffort: 'high', purpose: 'advisor', tools: [], maxTokens: 4096 })
    expect(request?.system).toContain('Only messages written by the human user define requirements')
    expect(request?.system).toContain('Check completeness')
  })

  it('accumulates advisor usage per conversation without touching the selection', async () => {
    const selections = store()
    await selections.update('session-a', { enabled: true, selection: { provider: 'kimi-code', model: 'k2' } })
    const service = new AdvisorService(selections, { stream: () => success() })
    await service.consult({ question: 'first' }, agent(), new AbortController().signal)
    await service.consult({ question: 'second' }, agent(), new AbortController().signal)
    const state = await selections.state('session-a')
    expect(state.usage).toMatchObject({ inputTokens: 240, outputTokens: 16, calls: 2 })
    expect(state.selection).toMatchObject({ provider: 'kimi-code', model: 'k2' })
  })

  it('refuses further consultations once the conversation budget is spent', async () => {
    const selections = new AdvisorSelectionStore(() => ({ ...defaults(), sessionTokenBudget: 100 }), (() => {
      const file = path.join(os.tmpdir(), `dsh-advisor-${randomUUID()}.json`)
      files.push(file)
      return file
    })())
    await selections.update('session-a', { enabled: true, selection: { provider: 'kimi-code', model: 'k2' } })
    const stream = vi.fn(() => success())
    const service = new AdvisorService(selections, { stream })
    const first = await service.consult({ question: 'first' }, agent(), new AbortController().signal)
    expect(first.status).toBe('ok')
    expect(stream).toHaveBeenCalledTimes(1)
    const second = await service.consult({ question: 'second' }, agent(), new AbortController().signal)
    expect(second.status).toBe('budget-exhausted')
    expect(stream).toHaveBeenCalledTimes(1)
    expect(second.detail).toContain('advisor tokens')
  })

  it('warns when the advisor is the same model as the main model', async () => {
    const selections = store()
    await selections.update('session-a', { enabled: true, selection: { provider: 'kimi-code', model: 'k3' } })
    const service = new AdvisorService(selections, { stream: () => success() })
    const result = await service.consult({ question: 'review' }, agent(undefined, { provider: 'kimi-code', model: 'k3' }), new AbortController().signal)
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('same model as the main model')
  })

  it('isolates session selections and persists routes without transcript content', async () => {
    const selections = store()
    await selections.update('session-a', { enabled: true, selection: { provider: 'kimi-code', model: 'k2' } })
    expect((await selections.state('session-b')).enabled).toBe(false)
    expect((await selections.state('session-b')).selection).toBeNull()
    const file = files[0]!
    const restored = new AdvisorSelectionStore(defaults, file)
    expect((await restored.state('session-a')).selection).toMatchObject({ provider: 'kimi-code', model: 'k2' })
    expect(await fs.readFile(file, 'utf8')).not.toContain('Implement the feature')
  })

  it('lets a saved user default govern conversations that never overrode it', async () => {
    const selections = store()
    await selections.setDefault({ provider: 'claude-api', model: 'sonnet' }, true)
    const fresh = await selections.state('brand-new')
    expect(fresh.enabled).toBe(true)
    expect(fresh.selection).toMatchObject({ provider: 'claude-api', model: 'sonnet' })
    expect(fresh.inherited).toBe(true)
    await selections.update('brand-new', { enabled: false })
    const overridden = await selections.state('brand-new')
    expect(overridden.enabled).toBe(false)
    expect(overridden.inherited).toBe(false)
    // Reverting the override falls back to the user default again.
    await selections.update('brand-new', { enabled: null })
    expect((await selections.state('brand-new')).enabled).toBe(true)
  })
})

describe('requestAdvisor', () => {
  const base = () => ({
    route: { provider: 'minimax-code', model: 'm3' },
    transcript: { messages: [user('task')], sourceSystem: '', omittedMessages: 0, orphanedToolCalls: 0 },
    maxTokens: 1024, timeoutMs: 1000, maxRetries: 1, sessionId: 'session-a' as GenerateOptions['sessionId'], question: 'review',
  })

  it('retries a transient provider failure once', async () => {
    let calls = 0
    const llm: AdvisorLlm = { stream: () => {
      calls++
      if (calls === 1) return (async function* () { throw Object.assign(new Error('temporary'), { code: 'SERVER' }) })()
      return success('Second opinion')
    } }
    const result = await requestAdvisor({ ...base(), llm, signal: new AbortController().signal })
    expect(calls).toBe(2)
    expect(result.status).toBe('ok')
  })

  it('honors cancellation before any request', async () => {
    const stream = vi.fn()
    const controller = new AbortController()
    controller.abort()
    const result = await requestAdvisor({ ...base(), llm: { stream }, signal: controller.signal })
    expect(result.status).toBe('cancelled')
    expect(stream).not.toHaveBeenCalled()
  })

  it('reports an empty answer as declined instead of retrying it', async () => {
    let calls = 0
    const llm: AdvisorLlm = { stream: () => {
      calls++
      return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as const })()
    } }
    const result = await requestAdvisor({ ...base(), llm, signal: new AbortController().signal })
    expect(result.status).toBe('declined')
    expect(calls).toBe(1)
  })
})

describe('projectAdvisorTranscript', () => {
  it('keeps the original task and recent messages within a separate budget', () => {
    const messages = [user('original task'), ...Array.from({ length: 20 }, (_, i) => user(`step ${i} ${'x'.repeat(300)}`)), user('latest evidence')]
    const result = projectAdvisorTranscript(messages, { contextTokenBudget: 1600, maxTokens: 256, includeImages: true })
    expect(result.messages[0]?.content).toEqual([{ type: 'text', text: 'original task' }])
    expect(result.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'latest evidence' }])
    expect(result.omittedMessages).toBeGreaterThan(0)
    expect(messages).toHaveLength(22)
  })

  it('keeps the newest evidence as the last message and bounds it when it alone exceeds the budget', () => {
    const latest = user(`latest ${'x'.repeat(24000)}`)
    const result = projectAdvisorTranscript([user('task'), user('older'), latest], { contextTokenBudget: 8000, maxTokens: 4096, includeImages: true })
    const last = result.messages.at(-1)!
    expect(last).not.toBe(latest)
    const text = last.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    expect(text.startsWith('latest ')).toBe(true)
    expect(text).toContain('omitted to fit the advisor context window')
    expect(text.length).toBeLessThan(20000)
    // The source message is never mutated.
    expect(latest.content).toHaveLength(1)
  })

  it('replaces images for a text-only advisor without mutating the source', () => {
    const message = createUserMessage({ content: [{ type: 'image', attachment: { id: 'image-a' } as never }], source: { kind: 'user' } })
    const result = projectAdvisorTranscript([message], { contextTokenBudget: 8000, maxTokens: 256, includeImages: false })
    expect(result.messages[0]?.content[0]).toMatchObject({ type: 'text' })
    expect(message.content[0]?.type).toBe('image')
  })

  it('never sends a tool call without a matching result', () => {
    const call = createAssistantMessage({
      content: [{ type: 'tool-call', id: 'call-1' as never, name: 'read', arguments: '{}' }],
      source: { provider: 'kimi-code', model: 'k3' },
    })
    const result = projectAdvisorTranscript([user('task'), call], { contextTokenBudget: 8000, maxTokens: 256, includeImages: true })
    const afterCall = result.messages[result.messages.indexOf(call as never) + 1]
    expect(afterCall?.role).toBe('tool')
    expect(result.orphanedToolCalls).toBe(1)
  })

  it('drops a tool result whose call was evicted', () => {
    const orphan = createToolResultMessage({ callId: 'gone' as never, content: [{ type: 'text', text: 'stale' }], isError: false })
    const result = projectAdvisorTranscript([user('task'), orphan], { contextTokenBudget: 8000, maxTokens: 256, includeImages: true })
    expect(result.messages.some((message) => message.role === 'tool')).toBe(false)
  })

  it('keeps a matched call and result pair in place', () => {
    const call = createAssistantMessage({
      content: [{ type: 'tool-call', id: 'call-2' as never, name: 'read', arguments: '{}' }],
      source: { provider: 'kimi-code', model: 'k3' },
    })
    const answer = createToolResultMessage({ callId: 'call-2' as never, content: [{ type: 'text', text: 'file body' }], isError: false })
    const result = projectAdvisorTranscript([user('task'), call, answer], { contextTokenBudget: 8000, maxTokens: 256, includeImages: true })
    const roles = result.messages.map((message) => message.role)
    expect(roles).toEqual(['user', 'assistant', 'tool'])
    expect(result.orphanedToolCalls).toBe(0)
  })

  it('keeps a tool call when the message that carries it is trimmed to the budget', () => {
    const call = createAssistantMessage({
      content: [
        { type: 'text', text: `analysis ${'x'.repeat(40_000)}` },
        { type: 'tool-call', id: 'call-long' as never, name: 'read', arguments: '{"path":"a"}' },
      ],
      source: { provider: 'kimi-code', model: 'k3' },
    })
    // The newest message is kept whatever it costs, so this is the one place a message
    // larger than the whole budget still reaches the trimming pass.
    const history = [
      user('task'),
      ...Array.from({ length: 20 }, (_, i) => user(`step ${i} ${'y'.repeat(200)}`)),
      call,
    ]
    const result = projectAdvisorTranscript(history, { contextTokenBudget: 9000, maxTokens: 256, includeImages: true })
    const carrying = result.messages.filter((message) => message.content.some((block) => block.type === 'tool-call'))
    expect(carrying).toHaveLength(1)
    const prose = carrying[0]!.content.filter((block) => block.type === 'text').map((block) => (block.type === 'text' ? block.text : '')).join('')
    expect(prose).toContain('omitted to fit the advisor context window')
    // The pairing is what a strict provider validates: an answer without its call is a 400.
    const answered = result.messages.filter((message) => message.role === 'tool')
    expect(answered.map((message) => String((message as { toolCallId?: string }).toolCallId))).toEqual(['call-long'])
  })

  it('leaves every projected history pairing calls and results in both directions', () => {
    const history: Message[] = [user('task')]
    for (let index = 0; index < 12; index++) {
      const id = `call-${index}`
      history.push(createAssistantMessage({
        content: [
          { type: 'text', text: `step ${index} ${'z'.repeat(index % 3 === 0 ? 3_000 : 40)}` },
          { type: 'tool-call', id: id as never, name: 'read', arguments: '{}' },
        ],
        source: { provider: 'kimi-code', model: 'k3' },
      }))
      history.push(createToolResultMessage({ callId: id as never, content: [{ type: 'text', text: `result ${index}` }], isError: false }))
    }
    history.push(user('latest evidence'))
    const result = projectAdvisorTranscript(history, { contextTokenBudget: 9000, maxTokens: 256, includeImages: true })
    const calls = new Set<string>()
    const results = new Set<string>()
    for (const message of result.messages) {
      for (const block of message.content) if (block.type === 'tool-call') calls.add(String(block.id))
      if (message.role === 'tool') results.add(String((message as { toolCallId?: string }).toolCallId))
    }
    expect([...results].filter((id) => !calls.has(id))).toEqual([])
    expect([...calls].filter((id) => !results.has(id))).toEqual([])
  })

  it('keeps a message that fits the budget instead of excerpting it to an equal share', () => {
    const big = `analysis ${'w'.repeat(12_000)}`
    const history = [
      user('task'),
      createAssistantMessage({ content: [{ type: 'text', text: big }], source: { provider: 'kimi-code', model: 'k3' } }),
      user('next'),
      user('latest evidence'),
    ]
    const result = projectAdvisorTranscript(history, { contextTokenBudget: 9000, maxTokens: 256, includeImages: true })
    const bodies = result.messages.map((message) => message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''))
    expect(bodies.some((text) => text.includes('omitted to fit the advisor context window'))).toBe(false)
    expect(bodies).toContain(big)
  })

  it('counts omitted messages against the selection, not the placeholder results it added', () => {
    const call = createAssistantMessage({
      content: [{ type: 'tool-call', id: 'call-pending' as never, name: 'read', arguments: '{}' }],
      source: { provider: 'kimi-code', model: 'k3' },
    })
    const result = projectAdvisorTranscript([user('task'), call], { contextTokenBudget: 8000, maxTokens: 256, includeImages: true })
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool'])
    // The placeholder is not a message the projection failed to fit.
    expect(result.omittedMessages).toBe(0)
  })
})
