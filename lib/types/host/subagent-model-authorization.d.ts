/**
 * Host-side authorization for the models a subagent may run.
 *
 * The `subagent-model-selection` preference is sampled into each Session as a
 * durable route allowlist, but the built-in delegation tool only rejects an
 * explicit route outside that list: a call that selects no route lets the child
 * inherit the parent's model, so a DeepSeek parent could spawn DeepSeek
 * children even though the allowlist authorizes only other models.
 *
 * This guard closes that gap from the plugin plane. Whenever the calling
 * Session (or the nearest ancestor that recorded one) carries an allowlist,
 * a delegation whose effective child route the list does not authorize is
 * denied before the child starts, with the authorized routes in the reason so
 * the model can retry and pick one of them.
 * @module dsh-chatgpt-subscription/subagent-model-authorization
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SettingsProvider } from '@deepseek-ai/dsh-settings';
/** DSH settings namespace owned by the Subagent settings card. */
export declare const SUBAGENT_MODEL_SELECTION_NAMESPACE = "subagent-model-selection";
/** Durable Session event carrying one Session's authorized child routes. */
export declare const SUBAGENT_POLICY_EVENT = "subagent/model-selection-policy";
/** Delegation tools whose child routes this guard authorizes. */
export declare const DEFAULT_DELEGATION_TOOLS: readonly string[];
/** One exact provider/model route the user authorized for children. */
export interface AllowedModelRoute {
    readonly provider: string;
    readonly model: string;
}
/** Resolved model-selection preference read from the Host settings document. */
export interface SubagentModelSelectionPreference {
    readonly enabled: boolean;
    readonly allowedModels: readonly AllowedModelRoute[];
}
/** One durable Session record this module reads: its events and its lineage. */
export interface PolicySession {
    eventAt?(seq: number): {
        type?: unknown;
        data?: unknown;
    } | undefined;
    readonly header?: {
        readonly origin?: unknown;
        readonly parentSession?: unknown;
    };
}
/** Session lookup the guard walks from the calling agent to its ancestors. */
export interface SessionsResolver {
    get(id: string): PolicySession | undefined;
}
/** Calling agent fields the guard reads. */
export interface AuthorizationAgent {
    readonly session?: PolicySession;
    readonly options?: {
        readonly provider?: unknown;
        readonly model?: unknown;
    };
}
/** What the delegation tool received from the model. */
export interface DelegationArguments {
    readonly provider?: unknown;
    readonly model?: unknown;
}
/**
 * Parse the allowlist out of a durable route-policy event.
 * @param data - `subagent/model-selection-policy` event payload.
 * @returns every well-formed route, or undefined when the payload carries none.
 */
export declare function parseAllowedRoutes(data: unknown): AllowedModelRoute[] | undefined;
/**
 * Find one Session's recorded allowlist among its durable events.
 * @param session - Session whose log is scanned.
 * @returns the authorized routes, or undefined for a Session that recorded none.
 */
export declare function policyRoutesOf(session: PolicySession | undefined): AllowedModelRoute[] | undefined;
/**
 * Resolve the allowlist a delegation from this agent must respect: the agent's
 * own recorded policy, else the nearest ancestor Session that recorded one
 * (the inheritance the delegation tool applies to child Sessions).
 * @param agent - Calling agent.
 * @param sessions - Session registry used for ancestor lookup.
 * @returns the authorized routes, or undefined when no Session recorded any.
 */
export declare function authorizedRoutesFor(agent: AuthorizationAgent | undefined, sessions: SessionsResolver): AllowedModelRoute[] | undefined;
/**
 * Read the Host preference that owns the allowlist. Values in the stored
 * document are untrusted JSON, so every field is narrowed before use.
 * @param settings - Live settings service, when composed.
 * @returns the resolved preference, or undefined without a settings service.
 */
export declare function subagentModelSelectionPreference(settings: SettingsProvider | undefined): SubagentModelSelectionPreference | undefined;
/**
 * Build the denial reason for a delegation that would run on an unauthorized
 * route. The reason names the authorized routes so the next call can select one.
 * @param provider - Effective child provider id, when one is known.
 * @param model - Effective child model id, when one is known.
 * @param allowed - Routes the calling Session authorizes.
 * @param explicit - Whether the model named the route in the tool arguments.
 * @returns the corrective reason handed back to the model.
 */
export declare function unauthorizedRouteReason(provider: string | undefined, model: string | undefined, allowed: readonly AllowedModelRoute[], explicit: boolean): string;
/** Which Session's recorded allowlist a delegation must respect. */
export type AuthorizationScope = 
/**
 * `session` (default): a Session that recorded an allowlist governs itself
 * and its descendants, matching the delegation tool's durable snapshot; a
 * Session that recorded none keeps the built-in behavior.
 */
'session'
/**
 * `preference`: the current Host preference also governs Sessions that never
 * recorded an allowlist, so the Settings card applies without restarting the
 * Session. A Session that recorded its own routes still outranks it.
 */
 | 'preference';
/**
 * Decide whether one delegation call may start its child.
 * @param agent - Calling agent.
 * @param toolName - Tool being dispatched.
 * @param args - Parsed tool arguments.
 * @param preference - Current Host preference, when the settings service exists.
 * @param sessions - Session registry used for ancestor lookup.
 * @param toolNames - Delegation tool names this guard authorizes.
 * @param scope - Whether an unrecorded Session falls back to the preference.
 * @returns a denial reason, or undefined to leave the call untouched.
 */
export declare function delegationDenialReason(agent: AuthorizationAgent | undefined, toolName: string, args: unknown, preference: SubagentModelSelectionPreference | undefined, sessions: SessionsResolver, toolNames?: readonly string[], scope?: AuthorizationScope): string | undefined;
/** Runtime inputs the guard closes over. */
export interface SubagentAuthorizationOptions {
    /** Live settings service, when composed; absent leaves recorded policies in charge. */
    readonly settings?: SettingsProvider;
    /** Session registry used for ancestor lookup. */
    readonly sessions: SessionsResolver;
    /** Exact delegation tool names this guard authorizes. */
    readonly toolNames: readonly string[];
    /** Whether an unrecorded Session falls back to the current preference. */
    readonly scope?: AuthorizationScope;
}
/** The exact guard signature the Host tool registry evaluates. */
export type DelegationGuard = (agent: AuthorizationAgent | undefined, toolName: string, args: unknown) => string | undefined;
/**
 * Build the monotonic tool guard for one deployment. The Host preference is
 * sampled from the live settings document on every call, because a settings
 * edit must not rebuild the guard the way it cannot rebuild a Session.
 * @param options - settings, session registry, and delegation tool names.
 * @returns a guard that denies delegations outside the Session allowlist.
 */
export declare function createSubagentAuthorization(options: SubagentAuthorizationOptions): DelegationGuard;
/** Delegation names this guard recognizes when configuration omits them. */
export declare function normalizeDelegationToolNames(value: unknown): string[];
/**
 * Validate the plugin configuration that owns this guard.
 * @param toolNames - Candidate delegation tool names.
 * @returns the exact names this guard authorizes.
 */
export declare function validateDelegationToolNames(toolNames: readonly string[]): string[];
/** Configuration accepted by {@link installSubagentModelAuthorization}. */
export interface SubagentModelAuthorizationConfig {
    /** Delegation tool names the guard authorizes. */
    readonly toolNames?: readonly string[];
    /** Whether an unrecorded Session falls back to the current preference. */
    readonly scope?: AuthorizationScope;
}
/**
 * Register the monotonic guard on the Host tool registry.
 * @param ctx - Host context carrying `tools` (and optionally `settings`).
 * @param sessions - Session registry used for ancestor lookup.
 * @param config - Enforcement toggle and delegation tool names.
 * @returns the exact disposer that unregisters the guard.
 */
export declare function installSubagentModelAuthorization(ctx: Context, sessions: SessionsResolver, config?: SubagentModelAuthorizationConfig): () => void;
/**
 * Validate the configured authorization scope.
 * @param scope - Candidate scope from deployment configuration.
 * @returns the exact scope this guard enforces.
 */
export declare function validateAuthorizationScope(scope: unknown): AuthorizationScope;
//# sourceMappingURL=subagent-model-authorization.d.ts.map