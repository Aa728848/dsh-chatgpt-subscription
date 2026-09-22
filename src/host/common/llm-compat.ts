/**
 * Version bridge for the harness conversation model.
 *
 * Harness 0.1.7 flattened tool results: `tool-result` stopped being a content
 * block inside a user-role message and became a first-class `role: 'tool'`
 * message carrying `toolCallId`/`isError` directly, while
 * `GenerateOptions.messages` widened from `Message[]` to `RequestMessage[]` and
 * `MessageSourceMap` lost its catch-all `plugin` kind.
 *
 * Every mapper in this package reads the pre-0.1.7 vocabulary, so the request
 * path normalizes once at the adapter boundary ({@link normalizeGenerateOptions})
 * and the mappers keep one vocabulary on every supported harness generation.
 * The types below are that vocabulary: real harness block types for everything
 * the two generations share, plus this package's own `tool-result` block.
 *
 * @module dsh-chatgpt-subscription/llm-compat
 */

import type {
  ContentBlock as HarnessContentBlock,
  GenerateOptions as HarnessGenerateOptions,
} from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm/message'

export {
  LlmError,
  type FinishReason,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Content this package injects into a request no user turn produced. */
    'dsh-chatgpt-subscription': { kind: 'dsh-chatgpt-subscription' } & ContextFormed
  }
}

/** This package's kind in the harness message-source map. */
export const PLUGIN_MESSAGE_SOURCE_KIND = 'dsh-chatgpt-subscription' as const

/** The result of a tool invocation as every harness generation before 0.1.7 carried it. */
export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: string
  content: ContentBlock[]
  isError?: boolean
}

/**
 * Every content block the mappers read.
 *
 * Harness blocks the two generations share stay harness-typed — 0.1.7 dropped
 * the harness's own `tool-result` arm, and `Exclude` removes it where an older
 * harness still declares one — and {@link ToolResultBlock} supplies the single
 * spelling the mappers pattern-match on.
 */
export type ContentBlock = Exclude<HarnessContentBlock, { type: 'tool-result' }> | ToolResultBlock

/**
 * Blocks this package hands back to the harness.
 *
 * Emission sites build text, reasoning, tool-call, and image blocks only; the
 * harness has no `tool-result` block to accept one, so outbound values are the
 * shared harness blocks without it.
 */
export type OutboundContentBlock = Exclude<ContentBlock, ToolResultBlock>

/** Producer-declared provenance, read for `kind` and the model replay envelope. */
export interface MessageSource {
  readonly kind: string
  readonly callId?: unknown
  readonly provider?: unknown
  readonly replayState?: unknown
}

/** One conversation message in the vocabulary the mappers read. */
export interface Message {
  readonly id?: unknown
  readonly role: 'system' | 'developer' | 'user' | 'assistant'
  readonly content: ContentBlock[]
  readonly source?: MessageSource
}

/** Request options carrying the normalized conversation. */
export type GenerateOptions = Omit<HarnessGenerateOptions, 'messages'> & { messages: Message[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a message body's blocks, keeping every entry that carries a block tag. */
function readBlocks(raw: unknown): ContentBlock[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((block): block is ContentBlock => isRecord(block) && typeof block.type === 'string')
}

/**
 * Normalize one harness message list into {@link Message}.
 *
 * A 0.1.7 `role: 'tool'` message is re-wrapped as the user-role message holding
 * one {@link ToolResultBlock} that the mappers expect, keeping the tool
 * provenance (`kind: 'tool'`) they use to tell a real tool result from a user
 * turn. Everything a newer harness adds beside that keeps its own shape.
 * @param messages - Messages straight off the request options, in either generation's shape.
 * @returns The same conversation in the pre-0.1.7 vocabulary.
 */
export function normalizeMessages(messages: readonly unknown[] | undefined): Message[] {
  const normalized: Message[] = []
  for (const raw of messages ?? []) {
    if (!isRecord(raw)) continue
    const content = readBlocks(raw.content)
    if (raw.role === 'tool') {
      const source = isRecord(raw.source) ? raw.source : undefined
      const callId = String(raw.toolCallId ?? source?.callId ?? '')
      normalized.push({
        id: raw.id,
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content,
          ...(raw.isError === true ? { isError: true } : {}),
        }],
        source: { kind: 'tool', callId },
      })
      continue
    }
    normalized.push({
      id: raw.id,
      role: typeof raw.role === 'string' ? raw.role as Message['role'] : 'user',
      content,
      ...(isRecord(raw.source) ? { source: raw.source as unknown as MessageSource } : {}),
    })
  }
  return normalized
}

/**
 * Normalize request options for the mappers.
 * @param options - Request options the harness handed the adapter.
 * @returns The same options with {@link Message} history.
 */
export function normalizeGenerateOptions(options: HarnessGenerateOptions): GenerateOptions {
  return { ...options, messages: normalizeMessages(options.messages) }
}
