import { describe, expect, it } from 'vitest'
import {
  createStreamState,
  processAnthropicStreamLine,
  processOpenAIStreamLine,
} from '../src/host/kimi-code/mapper.ts'
import { KimiToolArgumentGuard, toolArgumentLimit } from '../src/host/kimi-code/tool-argument-guard.ts'

function malformedQuestionArguments(): string {
  const keys = [
    'header（可选）',
    'header（可选）_comment',
    'header（可选）_unused',
    'header（可选）_',
    'header（可选）__',
    'header（可选）___',
    'header（可选）____',
    'header（可选）_____',
  ]
  return '{"questions":[{' + keys.map((key) => JSON.stringify(key) + ':""').join(',') + '}]}'
}

function chunks(text: string, size: number): string[] {
  const out: string[] = []
  for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size))
  return out
}

describe('Kimi tool argument guard', () => {
  it('detects a runaway key family across arbitrary deltas without retaining the payload', () => {
    const guard = new KimiToolArgumentGuard('ask_user_question')
    let violation
    for (const delta of chunks(malformedQuestionArguments(), 3)) {
      violation = guard.observe(delta)
      if (violation !== undefined) break
    }
    expect(violation).toMatchObject({ rule: 'repeated-key', toolName: 'ask_user_question' })
    expect(JSON.stringify(violation)).not.toContain('header')
  })

  it('allows ordinary repeated header fields without a suffix variant', () => {
    const questions = Array.from({ length: 12 }, (_, index) => ({ id: `q${index}`, header: 'Confirm', question: 'Continue?' }))
    const guard = new KimiToolArgumentGuard('ask_user_question')
    expect(guard.observe(JSON.stringify({ questions }))).toBeUndefined()
  })

  it('does not interpret quoted key-like text inside a string value as members', () => {
    const text = Array.from({ length: 12 }, () => '"header（可选）___": ""').join(', ')
    const guard = new KimiToolArgumentGuard('ask_user_question')
    for (const delta of chunks(JSON.stringify({ questions: [{ id: 'q', question: text }] }), 2)) {
      expect(guard.observe(delta)).toBeUndefined()
    }
  })

  it('uses a small coordination budget and a separate large-source budget', () => {
    const ask = new KimiToolArgumentGuard('ask_user_question')
    expect(ask.observe('x'.repeat(toolArgumentLimit('ask_user_question')))).toBeUndefined()
    expect(ask.observe('x')).toMatchObject({ rule: 'argument-bytes' })

    const write = new KimiToolArgumentGuard('write')
    const large = JSON.stringify({ file_path: 'a.txt', content: 'x'.repeat(100_000) })
    expect(write.observe(large)).toBeUndefined()
    expect(toolArgumentLimit('write')).toBe(1024 * 1024)
    expect(toolArgumentLimit('read')).toBe(256 * 1024)
  })

  it('counts a split surrogate pair as UTF-8 bytes rather than two lone surrogates', () => {
    const guard = new KimiToolArgumentGuard('ask_user_question')
    const payload = '😀'.repeat(8_193)
    const splitAt = payload.indexOf('😀', 1) + 1
    const first = payload.slice(0, splitAt)
    expect(first.charCodeAt(first.length - 1)).toBeGreaterThanOrEqual(0xD800)
    guard.observe(first)
    expect(guard.observe(payload.slice(splitAt))).toMatchObject({ rule: 'argument-bytes' })
  })

  it('stops an OpenAI tool stream with a non-retryable provider error', () => {
    const state = createStreamState('openai', 'guard-openai')
    expect(() => {
      for (const delta of chunks(malformedQuestionArguments(), 17)) {
        processOpenAIStreamLine(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{
            index: 0,
            id: 'call-1',
            function: { name: 'ask_user_question', arguments: delta },
          }] } }],
        })}`, state)
      }
    }).toThrow(/runaway repeated-key/)
    expect(state.toolGuard).toMatchObject({ rule: 'repeated-key', toolName: 'ask_user_question' })
  })

  it('stops the equivalent Anthropic input_json_delta stream', () => {
    const state = createStreamState('anthropic', 'guard-anthropic')
    processAnthropicStreamLine(`data: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'ask_user_question' },
    })}`, state)
    expect(() => {
      for (const delta of chunks(malformedQuestionArguments(), 11)) {
        processAnthropicStreamLine(`data: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: delta },
        })}`, state)
      }
    }).toThrow(/runaway repeated-key/)
    expect(state.toolGuard).toMatchObject({ rule: 'repeated-key', toolName: 'ask_user_question' })
  })
})
