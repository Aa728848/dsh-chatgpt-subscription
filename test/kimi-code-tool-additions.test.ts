import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import { buildOpenAIRequest } from '../src/host/kimi-code/mapper.ts'

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    model: 'k3',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello there' }] } as Message],
    ...overrides,
  } as GenerateOptions
}

function tool(name: string, deferLoading = false): Record<string, unknown> {
  return {
    name,
    description: name + ' tool',
    parameters: { type: 'object', properties: {} },
    ...(deferLoading ? { deferLoading: true } : {}),
  }
}

function addition(name: string): Message {
  return { role: 'developer', content: [{ type: 'tool-addition', toolName: name }] } as unknown as Message
}

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] } as Message
}

describe('mid-conversation tool additions', () => {
  it('replays an addition at its history position and keeps it out of the top-level list', () => {
    const body = buildOpenAIRequest(options({
      messages: [user('first'), addition('widget_define'), user('second')],
      tools: [tool('widget_catalog'), tool('widget_define', true)] as never,
    }), undefined, true, { messageTools: true })

    // The deferred definition is declared through the message, never at the top:
    // a top-level entry would sit inside the very prefix being held still.
    expect((body.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name))
      .toEqual(['widget_catalog'])

    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages.map((message) => message.role)).toEqual(['user', 'system', 'user'])
    const declaration = messages[1]!.tools as Array<{ function: Record<string, unknown> }>
    expect(declaration).toHaveLength(1)
    expect(declaration[0]!.function.name).toBe('widget_define')
    expect(declaration[0]!.function).not.toHaveProperty('deferLoading')
  })

  it('degrades to a notice when the model cannot take a message-level declaration', () => {
    const body = buildOpenAIRequest(options({
      messages: [addition('widget_define'), user('go')],
      tools: [tool('widget_define', true)] as never,
    }), undefined, true, { messageTools: false })

    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]!.tools).toBeUndefined()
    expect(String(messages[0]!.content)).toContain('dynamically_loaded_tools')
  })

  it('ignores an addition naming a tool the request does not declare', () => {
    const body = buildOpenAIRequest(options({
      messages: [addition('ghost'), user('go')],
      tools: [tool('widget_catalog')] as never,
    }), undefined, true, { messageTools: true })

    expect((body.messages as Array<Record<string, unknown>>).every((message) => message.tools === undefined))
      .toBe(true)
  })

  it('turns a revocation into a note at its history position, keeping the declaration in place', () => {
    // in-history keeps the declaration list intact (that is why the prefix
    // survives), so the ONLY thing telling the model the tool is gone is this
    // note. Dropping it would leave a callable-looking tool that fails on use.
    const body = buildOpenAIRequest(options({
      messages: [
        user('first'),
        { role: 'developer', content: [{ type: 'tool-removal', toolName: 'widget_place' }] } as unknown as Message,
        user('second'),
      ],
      tools: [tool('widget_catalog'), tool('widget_place', true)] as never,
    }), undefined, true, { messageTools: true })

    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages.map((message) => message.role)).toEqual(['user', 'system', 'user'])
    expect(String(messages[1]!.content)).toContain('widget_place')
    expect(String(messages[1]!.content)).toContain('no longer available')
    // The declaration itself is NOT removed: removing it would change the
    // top-level list and throw the prefix away.
    expect((body.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name))
      .toEqual(['widget_catalog'])
  })

  it('leaves a non-deferred tool list untouched', () => {
    const body = buildOpenAIRequest(options({
      tools: [tool('widget_catalog'), tool('widget_place')] as never,
    }))
    expect((body.tools as unknown[])).toHaveLength(2)
  })
})
