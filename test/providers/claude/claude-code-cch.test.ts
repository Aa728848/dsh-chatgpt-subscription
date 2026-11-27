import { describe, expect, it } from 'vitest'
import {
  claudeCodeCchHashView,
  claudeCodeCchToken,
  claudeCodeXxHash64,
  signClaudeCodeCch,
  signClaudeCodeRequest,
} from '../../../src/host/providers/_claude-shared/claude-code-cch.ts'

describe('Claude Code cch', () => {
  it.each([
    ['', 'ef46db3751d8e999'],
    ['a', 'd24ec4f1a98c6e5b'],
    ['abc', '44bc2cf5ad770999'],
    ['xxhash', '32dd38952c4bc720'],
  ])('matches the xxHash64 known-answer vector for %j', (input, expected) => {
    expect(claudeCodeXxHash64(input).toString(16).padStart(16, '0')).toBe(expected)
  })

  it('matches the independent reference vector and preserves the wire length', () => {
    const body = JSON.stringify({
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.330.9e1; cc_entrypoint=cli; cch=00000;' }],
      model: 'claude-test',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'OK' }],
      stream: true,
    })
    expect(claudeCodeCchToken(body)).toBe('9ab5d')
    const signed = signClaudeCodeCch(body)
    expect(signed).toBe(body.replace('cch=00000', 'cch=9ab5d'))
    expect(signed).toHaveLength(body.length)
    expect(signClaudeCodeCch(signed)).toBe(signed)
  })

  it('applies textual model and numeric max_tokens rewrites at any depth', () => {
    const body = JSON.stringify({
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=00000;' }],
      model: 'nested',
      tools: [{ name: 'x', input_schema: { properties: { model: { model: 'inner', max_tokens: 42 } } } }],
      max_tokens: 99,
    })
    expect(claudeCodeCchToken(body)).toBe('85660')
    expect(signClaudeCodeCch(body)).toContain('cch=85660')
    const view = claudeCodeCchHashView(body)
    expect(view).not.toContain('"model":"nested"')
    expect(view).not.toContain('"max_tokens":99')
    expect(view).not.toContain('"max_tokens":42')
  })

  it('ignores model changes but changes the token for other body changes', () => {
    const body = JSON.stringify({
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=00000;' }],
      model: 'one', max_tokens: 128, messages: [{ role: 'user', content: 'same' }],
    })
    const otherModel = body.replace('"model":"one"', '"model":"two"')
    const otherText = body.replace('same', 'changed')
    expect(claudeCodeCchToken(otherModel)).toBe(claudeCodeCchToken(body))
    expect(claudeCodeCchToken(otherText)).not.toBe(claudeCodeCchToken(body))
  })

  describe('billing block only', () => {
    const quoted = 'source: "; cch=00000; cc_prompt_id=" + id'
    const payload = (history: unknown[]) => ({
      model: 'claude-test',
      messages: history,
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.330.9e1; cc_entrypoint=cli; cch=00000; cc_prompt_id=p1;' },
        { type: 'text', text: 'STATIC' },
      ],
      max_tokens: 128,
    })
    const turn = (text: string) => [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] },
    ]

    it('signs the billing block even when history quotes the placeholder first', () => {
      const request = payload([{ role: 'user', content: 'read it' }, ...turn(quoted)])
      const unsigned = JSON.stringify(request)
      const signed = signClaudeCodeRequest(request)
      const token = claudeCodeCchToken(unsigned)
      expect(JSON.parse(signed).messages).toEqual(request.messages)
      expect(JSON.parse(signed).system[0].text).toContain(`cch=${token};`)
      expect(signed).toHaveLength(unsigned.length)
      expect(signClaudeCodeCch(unsigned)).toBe(signed)
    })

    it('keeps shared history byte-identical across consecutive requests', () => {
      const history = [{ role: 'user', content: 'read it' }, ...turn(quoted)]
      const first = JSON.parse(signClaudeCodeRequest(payload(history)))
      const second = JSON.parse(signClaudeCodeRequest(payload([...history, ...turn('ok')])))
      expect(JSON.stringify(second.messages.slice(0, history.length))).toBe(JSON.stringify(first.messages))
      expect(first.system[0].text).not.toContain('cch=00000;')
      expect(second.system[0].text).not.toContain('cch=00000;')
    })

    it('leaves a body without a billing placeholder verbatim', () => {
      const request = { model: 'm', messages: [{ role: 'user', content: quoted }], system: [{ type: 'text', text: 'identity' }] }
      expect(signClaudeCodeRequest(request)).toBe(JSON.stringify(request))
      expect(signClaudeCodeCch(JSON.stringify(request))).toBe(JSON.stringify(request))
    })

    it('does not guess when the billing text occurs more than once in a serialized body', () => {
      const header = 'x-anthropic-billing-header: cch=00000; cc_prompt_id=p1;'
      const body = JSON.stringify({ messages: [{ role: 'user', content: header }], system: [{ type: 'text', text: header }] })
      expect(signClaudeCodeCch(body)).toBe(body)
    })
  })
})

