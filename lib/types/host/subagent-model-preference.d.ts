import type { Context } from '@deepseek-ai/cordis';
import type { SubscriptionPreferenceStore } from './preferences.ts';
/**
 * Refine in-process delegated agents that already inherit the ChatGPT subscription
 * provider. Non-Codex parents keep DSH's native child model inheritance unchanged.
 */
export declare function installSubagentModelPreference(ctx: Context, preferences: SubscriptionPreferenceStore): () => void;
//# sourceMappingURL=subagent-model-preference.d.ts.map