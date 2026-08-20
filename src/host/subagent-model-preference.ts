import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type { SubscriptionPreferenceStore } from './preferences.ts'
import { SubagentContextAdapter } from './subagent-context-adapter.ts'

/**
 * Apply the configured provider/model/reasoning route to in-process delegated agents
 * only when their inherited parent route uses the ChatGPT subscription provider.
 */
export function installSubagentModelPreference(ctx: Context, preferences: SubscriptionPreferenceStore): () => void {
  return ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (payload.agent.session.header.origin !== 'subagent'
      || (resolved.provider !== 'codex-chatgpt' && resolved.provider !== SubagentContextAdapter.provider)) return resolved
    const selection = preferences.status()
    return {
      ...resolved,
      provider: SubagentContextAdapter.provider,
      model: selection.subagentModel,
      ...(selection.subagentReasoningEffort === null ? {} : { reasoningEffort: ReasoningEffortId(selection.subagentReasoningEffort) }),
    }
  })
}
