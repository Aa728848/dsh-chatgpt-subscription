/**
 * Rough prompt-size estimation for one request.
 *
 * Shared because every line uses it for the same purpose: keeping `max_tokens`
 * from making a request the service will reject outright, before a single token is
 * spent. The service count stays authoritative; this only has to be close enough
 * to leave room.
 *
 * @module dsh-chatgpt-subscription/prompt-estimate
 */

import type { GenerateOptions } from "./llm-compat.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Tool-call arguments as the JSON string a wire carries, whatever shape they arrived in. */
function toolCallArguments(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw === undefined || raw === null) return '{}'
  try {
    return JSON.stringify(raw)
  } catch {
    return '{}'
  }
}
/**
 * Rough prompt size for one request, in tokens.
 *
 * Derived from the serialized text with the usual ~4 characters per token
 * heuristic. It is deliberately an estimate: the purpose is only to keep
 * `max_tokens` from making a request the service will reject outright, and the
 * service's own count remains authoritative. Undefined is returned for an empty
 * request so the caller leaves the cap alone rather than clamping against zero.
 */
export function estimatedInputTokens(options: GenerateOptions): number | undefined {
  let characters = typeof options.system === 'string' ? options.system.length : 0
  if (options.tools !== undefined) {
    for (const tool of options.tools) {
      characters += tool.name.length + (tool.description?.length ?? 0)
      try {
        characters += JSON.stringify(tool.parameters).length
      } catch {
        // A non-serializable schema contributes nothing to the estimate.
      }
    }
  }
  const contentCharacters = (content: unknown): number => {
    if (!Array.isArray(content)) return typeof content === 'string' ? content.length : 0
    return content.reduce((total, block) => {
      if (!isRecord(block)) return total
      if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') return total + block.text.length
      if (block.type === 'tool-result') return total + contentCharacters(block.content)
      if (block.type === 'tool-call') {
        const args = toolCallArguments(block.arguments)
        return total + String(block.name ?? '').length + args.length
      }
      return total
    }, 0)
  }
  for (const message of options.messages) characters += contentCharacters(message.content)
  if (characters === 0) return undefined
  return Math.ceil(characters / 4)
}
