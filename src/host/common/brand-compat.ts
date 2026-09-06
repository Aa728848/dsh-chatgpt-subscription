import * as LlmModule from '@deepseek-ai/dsh-llm'

export const toToolCallId = (id: string): any => {
  const mod = LlmModule as unknown as Record<string, Function>
  const brander = mod.ToolCallId ?? mod.CallId ?? ((x: string) => x)
  return brander(id)
}
