import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import { PROVIDER_ID } from './model-catalog.ts'
import type { SubscriptionPreferenceStore } from './preferences.ts'

/**
 * Refine in-process delegated agents that already inherit the ChatGPT subscription
 * provider. Non-Codex parents keep DSH's native child model inheritance unchanged.
 */
export function installSubagentModelPreference(ctx: Context, preferences: SubscriptionPreferenceStore): () => void {
  return ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (payload.agent.session.header.origin !== 'subagent' || resolved.provider !== PROVIDER_ID) return resolved
    const selection = preferences.status()
    return {
      ...resolved,
      provider: PROVIDER_ID,
      model: selection.subagentModel,
      reasoningEffort: ReasoningEffortId(selection.subagentReasoningEffort),
    }
  })
}
