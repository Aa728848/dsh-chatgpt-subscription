import type { Context } from '@deepseek-ai/cordis';
import type { SubscriptionPreferenceStore } from './preferences.ts';
/**
 * Route in-process delegated agents through the configured ChatGPT subscription
 * model. Root sessions retain their own model selection.
 */
export declare function installSubagentModelPreference(ctx: Context, preferences: SubscriptionPreferenceStore): () => void;
//# sourceMappingURL=subagent-model-preference.d.ts.map