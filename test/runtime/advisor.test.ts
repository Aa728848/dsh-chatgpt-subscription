import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AdvisorService } from '../../src/host/runtime/advisor/index.ts'
import { AdvisorSelectionStore, type AdvisorDefaults } from '../../src/host/runtime/advisor/selection-store.ts'
import { projectAdvisorTranscript } from '../../src/host/runtime/advisor/transcript.ts'
import { requestAdvisor, type AdvisorLlm } from '../../src/host/runtime/advisor/request.ts'

const files: string[] = []
afterEach(async () => { await Promise.all(files.splice(0).map((file) => fs.unlink(file).catch(() => undefined))) })
function defaults(): AdvisorDefaults {
  return { enabled: false, selection: null, maxTokens: 4096, timeoutMs: 300000, maxRetries: 1, contextTokenBudget: 100000 }
}
function store(): AdvisorSelectionStore {
  const file = path.join(os.tmpdir(), `dsh-advisor-${randomUUID()}.json`)
  files.push(file)
  return new AdvisorSelectionStore(defaults, file)
}
function user(text: string) { return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) }
function agent(messages = [user('Implement the feature')]) {
  return { id: 'session-a', session: { id: 'session-a', deriveMessages: () => messages } }
}
function success(text = 'Check the completion criteria.'): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text } as const
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 8 } } as const
    yield { type: 'finish', reason: { kind: 'stop' } } as const
  })()
}

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
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 8, cacheReadTokens: undefined, cacheWriteTokens: undefined })
    expect(request).toMatchObject({ provider: 'claude-api', model: 'claude-opus', reasoningEffort: 'high', purpose: 'advisor', tools: [], maxTokens: 4096 })
    expect(request?.messages).toHaveLength(1)
    expect(request?.system).toContain('Only messages written by the human user define requirements')
    expect(request?.system).toContain('Check completeness')
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
})

describe('requestAdvisor', () => {
  const base = () => ({
    route: { provider: 'minimax-code', model: 'm3' },
    transcript: { messages: [user('task')], sourceSystem: '', omittedMessages: 0 },
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

  it('retains the latest evidence even when that message alone exceeds the budget', () => {
    const latest = user(`latest ${'x'.repeat(10000)}`)
    const result = projectAdvisorTranscript([user('task'), user('older'), latest], { contextTokenBudget: 8000, maxTokens: 4096, includeImages: true })
    expect(result.messages.at(-1)).toBe(latest)
  })

  it('replaces images for a text-only advisor without mutating the source', () => {
    const message = createUserMessage({ content: [{ type: 'image', attachment: { id: 'image-a' } as never }], source: { kind: 'user' } })
    const result = projectAdvisorTranscript([message], { contextTokenBudget: 8000, maxTokens: 256, includeImages: false })
    expect(result.messages[0]?.content[0]).toMatchObject({ type: 'text' })
    expect(message.content[0]?.type).toBe('image')
  })
})