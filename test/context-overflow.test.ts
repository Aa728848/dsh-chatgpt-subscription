import { describe, expect, it } from 'vitest'
import { isContextOverflow, isHttpContextOverflow } from '../src/host/common/context-overflow.ts'
import { classifyMinimaxFailure } from '../src/host/minimax-code/adapter.ts'
import { classifyKimiFailure } from '../src/host/kimi-code/adapter.ts'
import { createStreamState as minimaxState, processMinimaxStreamLine } from '../src/host/minimax-code/mapper.ts'
import { createStreamState as kimiState, processOpenAIStreamLine, processAnthropicStreamLine } from '../src/host/kimi-code/mapper.ts'

import { createStreamState as commandState, processOpenAIStreamLine as commandOpenAI, processAnthropicStreamLine as commandAnthropic, processResponsesStreamLine } from '../src/host/command-code/mapper.ts'
import { createStreamState as buddyState, processStreamLine as buddyStream } from '../src/host/workbuddy/mapper.ts'
import { classifyFailure as buddyFailure } from '../src/host/workbuddy/adapter.ts'
import { createStreamState as claudeState, processStreamLine as claudeStream } from '../src/host/claude/mapper.ts'
import { toLlmError } from '../src/host/claude/adapter.ts'
import { classifyFailure as claudeFailure } from '../src/host/claude/client.ts'

import { createStreamState as antiState, processStreamLine as antiStream } from '../src/host/antigravity/mapper.ts'

const overflow = [
  { code: 'context_length_exceeded', message: 'invalid request' },
  { type: 'context_window_exceeded' },
  { message: 'maximum context length is 200000 tokens, but you requested 210000 tokens' },
  { message: 'prompt is too long: 210000 tokens > 200000 maximum' },
  { message: 'Your request exceeded model token limit: 262144' },
  { message: 'input exceeds the model context window' },
]
const unrelated = [
  'quota exceeded', 'tokens per minute limit exceeded', 'request body too large',
  'max_tokens must be less than 8192', 'thinking budget exceeds max_tokens',
  'prompt is too long in bytes', 'invalid request', 'maximum output tokens exceeded',
  'maximum context length must be a positive integer',
  'max_tokens must be less than maximum context length',
]

describe('provider context overflow classification', () => {
  it.each(overflow)('recognizes provider diagnostic %j', error => {
    expect(isContextOverflow(error)).toBe(true)
    expect(isContextOverflow(JSON.stringify({ error }))).toBe(true)
    for (const classify of [classifyMinimaxFailure, classifyKimiFailure]) {
      expect(classify(400, JSON.stringify({ error }))).toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED', retryable: false })
    }
  })
  it.each(unrelated)('does not compact unrelated failure %s', message => {
    expect(isContextOverflow({ message })).toBe(false)
    expect(classifyMinimaxFailure(400, message).code).toBe('PROVIDER_ERROR')
    expect(classifyKimiFailure(400, message).code).toBe('PROVIDER_ERROR')
  })
  it.each([401, 402, 403, 404, 429, 500, 503])('does not reinterpret HTTP %s', status => {
    expect(isHttpContextOverflow(status, overflow[0])).toBe(false)
    expect(classifyMinimaxFailure(status, JSON.stringify(overflow[0])).code).not.toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(classifyKimiFailure(status, JSON.stringify(overflow[0])).code).not.toBe('CONTEXT_WINDOW_EXCEEDED')
  })
  it('does not scan echoed request content', () => {
    expect(isContextOverflow({ error: { message: 'bad tool schema' }, request: { message: 'context_length_exceeded' } })).toBe(false)
  })
  it.each(overflow)('preserves structured SSE overflow %j', error => {
    const frame = 'data: ' + JSON.stringify({ type: 'error', error })
    expect(buddyFailure(400, JSON.stringify({ error })).code).toBe('CONTEXT_WINDOW_EXCEEDED')
    if ('message' in error && error.message !== 'invalid request') {
      expect(toLlmError(claudeFailure(400, JSON.stringify({ error }))).code).toBe('CONTEXT_WINDOW_EXCEEDED')
    }
    for (const run of [
      () => commandOpenAI(frame, commandState('openai')),
      () => commandAnthropic(frame, commandState('anthropic')),
      () => processResponsesStreamLine(frame, commandState('responses')),
      () => buddyStream(frame, buddyState()),
      () => antiStream(frame, antiState()),
      () => antiStream('data: ' + JSON.stringify({ response: { error } }), antiState()),
      () => claudeStream(frame, claudeState()),
    ]) expect(run).toThrow(expect.objectContaining({ code: 'CONTEXT_WINDOW_EXCEEDED' }))
    expect(() => processMinimaxStreamLine(frame, minimaxState())).toThrow(expect.objectContaining({ code: 'CONTEXT_WINDOW_EXCEEDED' }))
    for (const wire of ['openai', 'anthropic'] as const) {
      expect(() => (wire === 'openai' ? processOpenAIStreamLine : processAnthropicStreamLine)(frame, kimiState(wire))).toThrow(expect.objectContaining({ code: 'CONTEXT_WINDOW_EXCEEDED' }))
    }
  })
})
