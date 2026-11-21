/**
 * Server-side compaction for the claude-api line (spec: docs/claude-api-line-plan.md,
 * server compaction section). The request is built THROUGH buildClaudeApiRequest so system, tools,
 * cache markers and thinking are byte-identical to a main turn, then adjusted: the
 * trailing directive message is stripped, context_management / stop_sequences /
 * structured output / forced tool_choice are removed, compaction: { type: 'summarize',
 * instructions } is added, and max_tokens is at least 8192.
 */

import type { GenerateOptions } from '../common/llm-compat.ts'
import type { ResolvedRequestImages } from '../common/request-images.ts'
import { COMPACTION_INSTRUCTION, SHIPPED_INSTRUCTION_OPENING } from '../compaction-prompt.ts'
import { buildClaudeApiRequest, type ClaudeApiRequestContext } from './mapper.ts'
import { CLAUDE_API_BETA_COMPACT } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The compaction engine's auxiliary call is the one with purpose 'compaction'. */
export function isClaudeApiCompactionRequest(options: GenerateOptions): boolean {
  return options.purpose === 'compaction'
}

const INSTRUCTION_FIRST_LINE = COMPACTION_INSTRUCTION.split('\n')[0] ?? ''

/**
 * A copy of the options without the trailing directive user message, or null when the
 * last message is not that directive. The directive is recognized by the FIRST LINE of
 * either the shipped instruction or this repo's replacement (both exported by
 * src/host/compaction-prompt.ts); the harness may reword later sections without warning.
 */
export function stripClaudeApiCompactionDirective(options: GenerateOptions): GenerateOptions | null {
  const messages = options.messages
  const last = messages[messages.length - 1]
  if (last === undefined || last.role !== 'user') return null
  const isDirective = last.content.some(block => block.type === 'text' && typeof block.text === 'string'
    && (block.text.startsWith(SHIPPED_INSTRUCTION_OPENING) || block.text.startsWith(INSTRUCTION_FIRST_LINE)))
  if (!isDirective) return null
  return { ...options, messages: messages.slice(0, -1) }
}

/**
 * One compaction request. The shared mapper adds a wire-only user continuation when
 * the stripped history ends in assistant content, because upstream rejects prefill.
 */
export function buildClaudeApiCompactionRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages,
  context: ClaudeApiRequestContext,
): Record<string, unknown> {
  const stripped = stripClaudeApiCompactionDirective(options)
  const body = buildClaudeApiRequest(stripped ?? options, images, context)
  // A compaction request must not carry these (upstream 400 on context_management).
  delete body.context_management
  delete body.stop_sequences
  delete body.tool_choice
  delete body.response_format
  body.compaction = { type: 'summarize', instructions: COMPACTION_INSTRUCTION }
  const current = typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens) ? body.max_tokens : 0
  body.max_tokens = Math.max(8192, current)
  return body
}

/**
 * Every error-text field of the three documented body shapes (official envelope, gateway
 * { error: { message } }, bare { code, message }); a non-JSON body is matched as raw text.
 */
function compactionErrorTexts(bodyText: string): string[] {
  const parts: string[] = []
  try {
    const parsed = JSON.parse(bodyText) as unknown
    if (isRecord(parsed)) {
      const error = isRecord(parsed.error) ? parsed.error : undefined
      const details = error !== undefined && isRecord(error.details) ? error.details : undefined
      for (const value of [error?.message, parsed.message, parsed.code, error?.type, details?.error_code]) {
        const text = asString(value)
        if (text !== undefined) parts.push(text)
      }
    }
  } catch {
    // Not JSON: fall back to the raw body text.
  }
  return parts.length > 0 ? parts : [bodyText]
}

/**
 * A 400 about the compaction BLOCK itself - its content/signature or its placement.
 * Such a block is stale or misplaced, not a missing capability: the caller forgets the
 * stored summary and retries once. Co-usage errors (compaction + context_management)
 * are request-shape problems and match neither predicate.
 */
export function isClaudeApiCompactionBlockInvalid(status: number, bodyText: string): boolean {
  if (status !== 400) return false
  const haystack = compactionErrorTexts(bodyText).join('\n').toLowerCase()
  if (!haystack.includes('compaction') || haystack.includes('context_management')) return false
  return haystack.includes('block') || haystack.includes('signature')
}

/**
 * Whether an upstream 400 is a real "server compaction not supported" signal: the
 * compaction parameter refused as an unknown/extra input, an unexpected/unsupported
 * anthropic-beta value naming compact-2026-09-04, or a message saying the model does
 * not support compaction. Block-validity errors and the context_management co-usage
 * error are explicitly NOT unsupported signals.
 */
export function isClaudeApiCompactionUnsupported(status: number, bodyText: string): boolean {
  if (status !== 400) return false
  const haystack = compactionErrorTexts(bodyText).join('\n').toLowerCase()
  const namesCompaction = haystack.includes('compaction')
  const namesBeta = haystack.includes(CLAUDE_API_BETA_COMPACT.toLowerCase())
  if (!namesCompaction && !namesBeta) return false
  if (haystack.includes('block') || haystack.includes('signature') || haystack.includes('context_management')) return false
  if (namesCompaction && /(extra inputs are not permitted|unexpected|unknown|unrecognized|not permitted)/.test(haystack)) return true
  if (namesBeta && /(unexpected|unsupported|invalid|unknown|not supported|not permitted)/.test(haystack)) return true
  if (namesCompaction && /(not support|unsupported|does not support|not available|cannot compact)/.test(haystack)) return true
  return false
}

/**
 * The trimmed text between <compacted-summary> and </compacted-summary> (the marker
 * the harness wraps a checkpoint in, see compaction-prompt.ts PRIOR_CHECKPOINT_OPEN_TAG),
 * or null when the text carries no such block.
 */
export function extractCheckpointSummary(text: string): string | null {
  const match = /<compacted-summary>([\s\S]*?)<\/compacted-summary>/.exec(text)
  if (match === null) return null
  return (match[1] ?? '').trim()
}
