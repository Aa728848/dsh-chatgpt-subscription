import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import { PROVIDER_ID } from './model-catalog.ts'
import type { SubscriptionPreferenceStore } from './preferences.ts'

/**
 * Route in-process delegated agents through the configured ChatGPT subscription
 * model. Root sessions retain their own model selection.
 */
export function installSubagentModelPreference(ctx: Context, preferences: SubscriptionPreferenceStore): () => void {
  return ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (payload.agent.session.header.origin !== 'subagent') return resolved
    const selection = preferences.status()
    return {
      ...resolved,
      provider: PROVIDER_ID,
      model: selection.subagentModel,
      reasoningEffort: ReasoningEffortId(selection.subagentReasoningEffort),
    }
  })
}
