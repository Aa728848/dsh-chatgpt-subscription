import { createHash } from 'node:crypto'
import * as LlmModule from '@deepseek-ai/dsh-llm'

/** A stable Messages-safe id for tool calls replayed from another protocol. */
export function toClaudeToolUseId(value: unknown): string {
  const id = String(value)
  if (/^[a-zA-Z0-9_-]+$/.test(id)) return id
  // Responses replay ids can contain a pipe plus a second fc_ identifier. Hash the whole
  // foreign id instead of merely deleting separators, so distinct invalid ids do not collapse.
  return 'toolu_' + createHash('sha256').update(id).digest('hex').slice(0, 24)
}

export const toToolCallId = (id: string): any => {
  const mod = LlmModule as unknown as Record<string, Function>
  const brander = mod.ToolCallId ?? mod.CallId ?? ((x: string) => x)
  return brander(id)
}
