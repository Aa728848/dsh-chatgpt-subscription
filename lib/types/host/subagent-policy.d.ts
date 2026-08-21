import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubscriptionPreferenceStore } from './preferences.ts';
/**
 * Enforce global limits with a user-facing preflight on built-in delegation
 * tools and an authoritative synchronous Agent-publication gate. The latter
 * also covers workflows, Ralph, and nested subagents without depending on the
 * parent's provider or model. Throwing from `agent/created` vetoes and rolls
 * back the new child before its loop starts; already-running children remain.
 */
export declare function installSubagentPolicy(ctx: Context, preferences: SubscriptionPreferenceStore): () => void;
/** Return the highest currently live ancestor that owns this subagent tree. */
export declare function subagentTreeRoot(ctx: Pick<Context, 'agents'>, agent: Agent): Agent;
/** Return currently live descendants in one caller's subagent tree. */
export declare function activeDescendantIds(ctx: Pick<Context, 'agents'>, parentId: string): Set<string>;
export declare function activeDescendantCount(ctx: Pick<Context, 'agents'>, parentId: string): number;
//# sourceMappingURL=subagent-policy.d.ts.map