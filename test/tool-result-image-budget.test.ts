/**
 * Why the four lines without a body guard still have to measure a tool result.
 *
 * Each of them keeps its own copy of the image budget — the numbers differ and so
 * do the scaling policies — but all four copied a traversal that stopped at the
 * top level while their own builders recursed into a tool result and sent the
 * image. The request therefore grew past the route's own ceiling while nothing
 * local counted it: no omission, no diagnostic, only the upstream answering.
 *
 * These cases pin the recursion on the measurement AND on the replacement, and
 * pin that the replacement spends its count on the same occurrences the
 * measurement named.
 */
import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import { offloadOldestRequestImages as claudeOffload, MAX_REQUEST_IMAGE_BYTES as CLAUDE_MAX } from '../src/host/claude/mapper.ts'
import { offloadOldestRequestImages as commandCodeOffload, MAX_REQUEST_IMAGE_BYTES as COMMAND_CODE_MAX } from '../src/host/command-code/mapper.ts'
import { offloadOldestRequestImages as workbuddyOffload, MAX_REQUEST_IMAGE_BYTES as WORKBUDDY_MAX } from '../src/host/workbuddy/mapper.ts'
import { offloadOldestRequestImages as antigravityOffload, MAX_REQUEST_IMAGE_BYTES as ANTIGRAVITY_MAX } from '../src/host/antigravity/mapper.ts'

interface Ref {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
}

/** One image, large enough that two of them exceed any of the four budgets. */
function big(id: string): Ref {
  return { attachmentId: id, mediaType: 'image/png', bytes: 9 * 1024 * 1024, width: 1, height: 1 }
}

/** A user message carrying a top-level image. */
function imageMessage(ref: Ref): Message {
  return {
    role: 'user',
    content: [{ type: 'image', attachment: ref }],
  } as unknown as Message
}

/** A tool result carrying an image, the shape a screenshot tool produces. */
function toolResultMessage(ref: Ref): Message {
  return {
    role: 'user',
    content: [{
      type: 'tool-result',
      toolCallId: 'call_1',
      content: [
        { type: 'text', text: 'screenshot taken' },
        { type: 'image', attachment: ref },
      ],
    }],
  } as unknown as Message
}

function options(messages: Message[]): GenerateOptions {
  return { model: 'm', messages } as GenerateOptions
}

/** Attachment ids still carrying an image, at any nesting depth. */
function surviving(messages: Message[]): string[] {
  return messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .flatMap((block) => {
      const nested = (block as { content?: unknown }).content
      const list = Array.isArray(nested) ? nested : [block]
      return list
        .filter((inner) => typeof inner === 'object' && inner !== null && (inner as { type?: string }).type === 'image')
        .map((inner) => String((inner as { attachment?: { attachmentId?: string } }).attachment?.attachmentId))
    })
}

/** Placeholder count, at any nesting depth. */
function omitted(messages: Message[]): number {
  return messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .flatMap((block) => {
      const nested = (block as { content?: unknown }).content
      const list = Array.isArray(nested) ? nested : [block]
      return list.filter((inner) => typeof inner === 'object' && inner !== null
        && (inner as { type?: string }).type === 'text'
        && String((inner as { text?: string }).text).startsWith('[image omitted'))
    }).length
}

const LINES = [
  { name: 'claude', offload: claudeOffload, max: CLAUDE_MAX },
  { name: 'command-code', offload: commandCodeOffload, max: COMMAND_CODE_MAX },
  { name: 'workbuddy', offload: workbuddyOffload, max: WORKBUDDY_MAX },
  { name: 'antigravity', offload: antigravityOffload, max: ANTIGRAVITY_MAX },
] as const

describe.each(LINES)('$name counts and replaces images nested in a tool result', ({ offload, max }) => {
  it('measures a tool-result image against the budget', () => {
    // Two images that no single budget can hold, both inside tool results, so
    // a top-level-only traversal finds nothing to trim and returns unchanged.
    const messages = [toolResultMessage(big('shot-a')), toolResultMessage(big('shot-b'))]
    expect(Math.ceil(9 * 1024 * 1024 / 3) * 4 * 2).toBeGreaterThan(max)

    const offloaded = offload(options(messages))

    // Before the fix this was the input object itself, with both images intact.
    expect(offloaded).not.toBe(options(messages))
    expect(omitted(offloaded.messages)).toBeGreaterThan(0)
    expect(surviving(offloaded.messages).length).toBeLessThan(2)
  })

  it('spends the count on the same occurrences the measurement named', () => {
    // Oldest first, across nesting: the nested image is the older one here, so a
    // replacement that only walked the top level would keep it and drop the
    // wrong image instead.
    const nested = big('nested-shot')
    const topLevel = { ...big('top-level-shot'), bytes: 1024 }
    const messages = [toolResultMessage(nested), imageMessage(topLevel)]

    const offloaded = offload(options(messages))

    expect(omitted(offloaded.messages)).toBe(1)
    expect(surviving(offloaded.messages)).toEqual(['top-level-shot'])
  })

  it('leaves a request that fits untouched', () => {
    const messages = [toolResultMessage({ ...big('small'), bytes: 512 })]
    const opts = options(messages)
    expect(offload(opts)).toBe(opts)
  })
})

describe('the four copies reached the same verdict the shared traversal would', () => {
  it('omits exactly one image when two sit just over the budget', () => {
    // Sized per line: half the budget each, so every line has to drop one and
    // dropping one is enough. The budgets differ, so the SAME input would drop
    // a different COUNT on claude than on the three 12 MB lines; the point is
    // that each reaches that count only because it saw the nested image at all.
    for (const { name, offload, max } of LINES) {
      // Sized at ~60% of the ceiling once base64-encoded: two clear it, one
      // fits, so each line has to drop exactly one. A third would be dropped too.
      const encoded = Math.floor((max * 0.6) / 4) * 4
      const bytes = (encoded / 4) * 3
      const offloaded = offload(options([
        toolResultMessage({ ...big('nested-shot'), bytes }),
        imageMessage({ ...big('top-level-shot'), bytes }),
      ]))
      expect(omitted(offloaded.messages), name).toBe(1)
      // Oldest first: the nested image is the older of the two.
      expect(surviving(offloaded.messages), name).toEqual(['top-level-shot'])
    }
  })
})
