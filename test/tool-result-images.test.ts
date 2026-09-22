import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import { normalizeGenerateOptions } from '../src/host/common/llm-compat.ts'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

import {
  type AttachmentImageReader as CommandCodeImageReader,
  buildAnthropicRequest as ccAnthropic,
  buildOpenAIRequest as ccOpenAI,
  resolveRequestImages as ccResolve,
} from '../src/host/command-code/mapper.ts'
import {
  type AttachmentImageReader as AntigravityImageReader,
  buildRequest as agRequest,
  resolveRequestImages as agResolve,
} from '../src/host/antigravity/mapper.ts'
import { MODELS as AG_MODELS } from '../src/host/antigravity/types.ts'
import {
  type AttachmentImageReader as KimiImageReader,
  buildAnthropicRequest as kimiAnthropic,
  buildOpenAIRequest as kimiOpenAI,
  resolveRequestImages as kimiResolve,
} from '../src/host/kimi-code/mapper.ts'

/** The three mappers declare structurally identical readers. */
type AttachmentImageReader = CommandCodeImageReader & AntigravityImageReader & KimiImageReader

/**
 * Tool-result images have to survive the trip to the wire. Every mapper used to
 * read only the top level of a message, so an image nested inside a
 * `tool-result` was collected as nothing and flattened to "[image: name]" text:
 * the model was told a picture existed without ever receiving one. These cover
 * the collection, the flattening, and — just as importantly — that a tool result
 * with no image still serializes exactly as it did before.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_BASE64 = Buffer.from(PNG).toString('base64')

const ATTACHMENT = {
  attachmentId: 'sha256:tool-result-shot',
  mediaType: 'image/png',
  bytes: PNG.length,
  width: 1,
  height: 1,
  name: 'screenshot.png',
} as unknown as ImageAttachmentRef

/** An attachment store that hands back one real PNG. */
function reader(overrides: Partial<AttachmentImageReader> = {}): AttachmentImageReader {
  return {
    readImage: async () => ({ ref: ATTACHMENT as never, data: PNG }),
    ...overrides,
  } as unknown as AttachmentImageReader
}

/** The shape DSH builds for a tool that returned text plus a screenshot. */
function toolResultMessages(): Message[] {
  return [
    {
      role: 'assistant',
      source: { kind: 'model', provider: 'p', model: 'm' } as never,
      content: [{ type: 'tool-call', id: 'call_1', name: 'get_window_state', arguments: '{}' }],
    } as unknown as Message,
    {
      role: 'user',
      source: { kind: 'tool', callId: 'call_1' } as never,
      content: [{
        type: 'tool-result',
        toolCallId: 'call_1',
        content: [
          { type: 'text', text: 'screenshot taken' },
          { type: 'image', attachment: ATTACHMENT },
        ],
      }],
    } as unknown as Message,
  ]
}

function plainToolResultMessages(): Message[] {
  return [
    {
      role: 'assistant',
      source: { kind: 'model', provider: 'p', model: 'm' } as never,
      content: [{ type: 'tool-call', id: 'call_1', name: 'run_code', arguments: '{}' }],
    } as unknown as Message,
    {
      role: 'user',
      source: { kind: 'tool', callId: 'call_1' } as never,
      content: [{
        type: 'tool-result',
        toolCallId: 'call_1',
        content: [{ type: 'text', text: 'exit code 0' }],
      }],
    } as unknown as Message,
  ]
}

function ccOptions(messages: Message[]): GenerateOptions {
  return { provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash', messages } as unknown as GenerateOptions
}

function kimiOptions(messages: Message[]): GenerateOptions {
  return { provider: 'kimi-code', model: 'k3', messages } as unknown as GenerateOptions
}

function agOptions(messages: Message[]): GenerateOptions {
  return { provider: 'antigravity', model: 'gemini-3.7-flash', messages } as unknown as GenerateOptions
}

/**
 * The same exchange as {@link toolResultMessages}, in the shape harness 0.1.7
 * delivers: the tool result is its own `role: 'tool'` message, normalized at the
 * adapter boundary before any mapper reads it.
 * @param content - raw result blocks the tool returned.
 */
function currentGenerationMessages(content: readonly unknown[]): Message[] {
  return normalizeGenerateOptions({
    provider: 'command-code',
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [
      createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'get_window_state', arguments: '{}' }],
        source: { provider: 'p', model: 'm' },
      }),
      createToolResultMessage({
        callId: ToolCallId('call_1'),
        content: content as never,
        isError: false,
      }),
    ],
  }).messages
}

const agModel = AG_MODELS.find((m) => m.id === 'gemini-3.7-flash')!

/** The single `tool_result` block a body carries, wherever it landed. */
function toolResultBlock(body: Record<string, unknown>): Record<string, unknown> {
  for (const message of body.messages as Array<Record<string, unknown>>) {
    const content = message.content
    if (!Array.isArray(content)) continue
    const found = content.find((block) => (block as Record<string, unknown>).type === 'tool_result')
    if (found) return found as Record<string, unknown>
  }
  throw new Error('no tool_result block in body')
}

describe.each([
  ['command-code', ccResolve, ccOptions],
  ['antigravity', agResolve, agOptions],
  ['kimi-code', kimiResolve, kimiOptions],
] as const)('%s resolves images nested in a tool result', (_name, resolve, makeOptions) => {
  it('collects the nested attachment instead of skipping the tool result', async () => {
    const images = await resolve(makeOptions(toolResultMessages()), reader())
    expect([...images.keys()]).toEqual(['sha256:tool-result-shot'])
    expect(images.get('sha256:tool-result-shot')).toEqual({
      kind: 'inline',
      mediaType: 'image/png',
      data: PNG_BASE64,
    })
  })

  it('still resolves a top-level pasted image', async () => {
    const images = await resolve(makeOptions([
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: ATTACHMENT }] } as unknown as Message,
    ]), reader())
    expect([...images.keys()]).toEqual(['sha256:tool-result-shot'])
  })

  it('collects the same nested attachment from a 0.1.7 tool-role result message', async () => {
    const messages = currentGenerationMessages([
      { type: 'text', text: 'screenshot taken' },
      { type: 'image', attachment: ATTACHMENT },
    ])
    // The harness delivered one `role: 'tool'` message; the mappers read the
    // user-role tool result the adapter normalized it into.
    const images = await resolve(makeOptions(messages), reader())
    expect([...images.keys()]).toEqual(['sha256:tool-result-shot'])
    expect(images.get('sha256:tool-result-shot')).toEqual({
      kind: 'inline',
      mediaType: 'image/png',
      data: PNG_BASE64,
    })
  })
})

describe('command-code tool-result images', () => {
  it('sends an Anthropic tool_result carrying an image as a native block array', async () => {
    const options = ccOptions(toolResultMessages())
    const images = await ccResolve(options, reader())
    const body = ccAnthropic(options, images)
    const messages = body.messages as Array<Record<string, unknown>>
    const result = messages.find((m) => (m.content as Array<Record<string, unknown>>)
      .some((b) => b.type === 'tool_result'))!.content as Array<Record<string, unknown>>
    const toolResult = result.find((b) => b.type === 'tool_result')!

    expect(toolResult.tool_use_id).toBe('call_1')
    expect(toolResult.content).toEqual([
      { type: 'text', text: 'screenshot taken' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
    ])
  })

  it('leaves a tool result without an image a byte-identical string', () => {
    const toolResult = toolResultBlock(ccAnthropic(ccOptions(plainToolResultMessages())))
    expect(toolResult.content).toBe('exit code 0')
    expect(typeof toolResult.content).toBe('string')
  })

  it('appends one user message with the image after a run of parallel tool calls', async () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' } as never,
        content: [
          { type: 'tool-call', id: 'call_1', name: 'get_window_state', arguments: '{}' },
          { type: 'tool-call', id: 'call_2', name: 'run_code', arguments: '{}' },
        ],
      } as unknown as Message,
      {
        role: 'user',
        source: { kind: 'tool', callId: 'call_1' } as never,
        content: [{
          type: 'tool-result',
          toolCallId: 'call_1',
          content: [{ type: 'text', text: 'shot' }, { type: 'image', attachment: ATTACHMENT }],
        }],
      } as unknown as Message,
      {
        role: 'user',
        source: { kind: 'tool', callId: 'call_2' } as never,
        content: [{ type: 'tool-result', toolCallId: 'call_2', content: [{ type: 'text', text: 'ok' }] }],
      } as unknown as Message,
    ]
    const options = ccOptions(messages)
    const images = await ccResolve(options, reader())
    const body = ccOpenAI(options, images)
    const wire = body.messages as Array<Record<string, unknown>>

    expect(wire.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
    // The two tool messages stay adjacent: a user message between them would be
    // rejected by upstreams that require each tool_call answered contiguously.
    // Their text is untouched — the image travels beside it, not instead of it.
    expect(wire[1]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'shot[image: screenshot.png]' })
    expect(wire[2]).toEqual({ role: 'tool', tool_call_id: 'call_2', content: 'ok' })
    expect(wire[3]!.content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
    ])
  })

  it('adds nothing to the OpenAI wire for a tool result without an image', () => {
    const body = ccOpenAI(ccOptions(plainToolResultMessages()))
    expect((body.messages as Array<Record<string, unknown>>).map((m) => m.role)).toEqual(['assistant', 'tool'])
  })

  it('degrades an unreadable image to explicit text rather than dropping it', async () => {
    const options = ccOptions(toolResultMessages())
    const images = await ccResolve(options, undefined)
    expect(images.get('sha256:tool-result-shot')).toEqual({ kind: 'unavailable' })

    const toolResult = toolResultBlock(ccAnthropic(options, images))
    expect(JSON.stringify(toolResult.content)).toContain('screenshot.png could not be read')

    const openai = ccOpenAI(options, images).messages as Array<Record<string, unknown>>
    expect(JSON.stringify(openai[openai.length - 1]!.content)).toContain('screenshot.png could not be read')
  })

  it('maps a 0.1.7 tool-role result message onto the same two wires', async () => {
    const options = ccOptions(currentGenerationMessages([
      { type: 'text', text: 'screenshot taken' },
      { type: 'image', attachment: ATTACHMENT },
    ]))
    const images = await ccResolve(options, reader())
    const toolResult = toolResultBlock(ccAnthropic(options, images))
    expect(toolResult.tool_use_id).toBe('call_1')
    expect(toolResult.content).toEqual([
      { type: 'text', text: 'screenshot taken' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
    ])

    const wire = ccOpenAI(options, images).messages as Array<Record<string, unknown>>
    expect(wire.map((m) => m.role)).toEqual(['assistant', 'tool', 'user'])
    expect(wire[1]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'screenshot taken[image: screenshot.png]' })
    expect(wire[2]!.content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
    ])
  })
})

describe('antigravity tool-result images', () => {
  it('appends inlineData parts to the same user content as the functionResponse', async () => {
    const options = agOptions(toolResultMessages())
    const images = await agResolve(options, reader())
    const body = agRequest(options, agModel, 'project', 'gemini-3.7-flash', undefined, images)
    const contents = ((body.request as Record<string, unknown>).contents) as Array<Record<string, unknown>>
    const turn = contents[contents.length - 1]!
    const parts = turn.parts as Array<Record<string, unknown>>

    expect(turn.role).toBe('user')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toHaveProperty('functionResponse')
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } })
  })

  it('keeps the parts array unchanged for a tool result without an image', () => {
    const body = agRequest(agOptions(plainToolResultMessages()), agModel, 'project', 'gemini-3.7-flash')
    const contents = ((body.request as Record<string, unknown>).contents) as Array<Record<string, unknown>>
    const parts = contents[contents.length - 1]!.parts as Array<Record<string, unknown>>
    expect(parts).toHaveLength(1)
    expect(parts[0]).toHaveProperty('functionResponse')
    expect(JSON.stringify(parts[0])).not.toContain('inlineData')
  })

  it('maps a 0.1.7 tool-role result message onto the same functionResponse turn', async () => {
    const options = agOptions(currentGenerationMessages([
      { type: 'text', text: 'screenshot taken' },
      { type: 'image', attachment: ATTACHMENT },
    ]))
    const images = await agResolve(options, reader())
    const body = agRequest(options, agModel, 'project', 'gemini-3.7-flash', undefined, images)
    const contents = ((body.request as Record<string, unknown>).contents) as Array<Record<string, unknown>>
    const turn = contents[contents.length - 1]!
    const parts = turn.parts as Array<Record<string, unknown>>

    expect(turn.role).toBe('user')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toHaveProperty('functionResponse')
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } })
  })
})

describe('kimi-code tool-result images', () => {
  it('appends one user message with the image after a run of parallel tool calls', async () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' } as never,
        content: [
          { type: 'tool-call', id: 'call_1', name: 'get_window_state', arguments: '{}' },
          { type: 'tool-call', id: 'call_2', name: 'run_code', arguments: '{}' },
        ],
      } as unknown as Message,
      {
        role: 'user',
        source: { kind: 'tool', callId: 'call_1' } as never,
        content: [{
          type: 'tool-result',
          toolCallId: 'call_1',
          content: [{ type: 'text', text: 'shot' }, { type: 'image', attachment: ATTACHMENT }],
        }],
      } as unknown as Message,
      {
        role: 'user',
        source: { kind: 'tool', callId: 'call_2' } as never,
        content: [{ type: 'tool-result', toolCallId: 'call_2', content: [{ type: 'text', text: 'ok' }] }],
      } as unknown as Message,
    ]
    const options = kimiOptions(messages)
    const images = await kimiResolve(options, reader())
    const body = kimiOpenAI(options, images, false, {})
    const wire = body.messages as Array<Record<string, unknown>>

    expect(wire.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
    // The two tool messages stay adjacent and keep their text; the image rides
    // on the user message appended after the run.
    expect(wire[1]!.role).toBe('tool')
    expect(wire[1]!.tool_call_id).toBe('call_1')
    expect(wire[1]!.content).toBe('shot[image: screenshot.png]')
    expect(wire[2]!.content).toBe('ok')
    expect(wire[3]!.content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
    ])
  })

  it('sends an Anthropic tool_result carrying an image as a native block array', async () => {
    const options = kimiOptions(toolResultMessages())
    const images = await kimiResolve(options, reader())
    const body = kimiAnthropic(options, images)
    const toolResult = toolResultBlock(body)
    expect(toolResult.content).toEqual([
      { type: 'text', text: 'screenshot taken' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
    ])
  })

  it('keeps a tool result without an image a string on both wires', () => {
    const options = kimiOptions(plainToolResultMessages())
    const openai = kimiOpenAI(options, undefined, false, {}).messages as Array<Record<string, unknown>>
    expect(openai.map((m) => m.role)).toEqual(['assistant', 'tool'])
    const toolResult = toolResultBlock(kimiAnthropic(options))
    expect(toolResult.content).toBe('exit code 0')
  })

  it('maps a 0.1.7 tool-role result message onto the same two wires', async () => {
    const options = kimiOptions(currentGenerationMessages([
      { type: 'text', text: 'screenshot taken' },
      { type: 'image', attachment: ATTACHMENT },
    ]))
    const images = await kimiResolve(options, reader())
    const toolResult = toolResultBlock(kimiAnthropic(options, images))
    expect(toolResult.content).toEqual([
      { type: 'text', text: 'screenshot taken' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
    ])

    const wire = kimiOpenAI(options, images, false, {}).messages as Array<Record<string, unknown>>
    expect(wire.map((m) => m.role)).toEqual(['assistant', 'tool', 'user'])
    expect(wire[1]!.content).toBe('screenshot taken[image: screenshot.png]')
    expect(wire[2]!.content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
    ])
  })
})
