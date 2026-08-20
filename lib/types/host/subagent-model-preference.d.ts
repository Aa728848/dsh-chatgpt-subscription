import type { Context } from '@deepseek-ai/cordis';
import type { SubscriptionPreferenceStore } from './preferences.ts';
/**
 * Apply the configured provider/model/reasoning route to in-process delegated agents
 * only when their inherited parent route uses the ChatGPT subscription provider.
 */
export declare function installSubagentModelPreference(ctx: Context, preferences: SubscriptionPreferenceStore): () => void;
//# sourceMappingURL=subagent-model-preference.d.ts.map