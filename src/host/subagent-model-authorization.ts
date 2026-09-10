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

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import * as SettingsModule from '@deepseek-ai/dsh-settings'

/** DSH settings namespace owned by the Subagent settings card. */
export const SUBAGENT_MODEL_SELECTION_NAMESPACE = 'subagent-model-selection'

/** Durable Session event carrying one Session's authorized child routes. */
export const SUBAGENT_POLICY_EVENT = 'subagent/model-selection-policy'

/** Delegation tools whose child routes this guard authorizes. */
export const DEFAULT_DELEGATION_TOOLS: readonly string[] = ['subagent']

/** One exact provider/model route the user authorized for children. */
export interface AllowedModelRoute {
  readonly provider: string
  readonly model: string
}

/** Resolved model-selection preference read from the Host settings document. */
export interface SubagentModelSelectionPreference {
  readonly enabled: boolean
  readonly allowedModels: readonly AllowedModelRoute[]
}

/** One durable Session record this module reads: its events and its lineage. */
export interface PolicySession {
  eventAt?(seq: number): { type?: unknown; data?: unknown } | undefined
  readonly header?: {
    readonly origin?: unknown
    readonly parentSession?: unknown
  }
}

/** Session lookup the guard walks from the calling agent to its ancestors. */
export interface SessionsResolver {
  get(id: string): PolicySession | undefined
}

/** Calling agent fields the guard reads. */
export interface AuthorizationAgent {
  readonly session?: PolicySession
  readonly options?: { readonly provider?: unknown; readonly model?: unknown }
}

/** What the delegation tool received from the model. */
export interface DelegationArguments {
  readonly provider?: unknown
  readonly model?: unknown
}

/**
 * Read one deployment event field as a string.
 * @param value - Candidate field value from a durable event.
 * @returns the string value, or undefined for any other type.
 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Read one deployment event field as a plain object.
 * @param value - Candidate field value from a durable event.
 * @returns the record value, or undefined for arrays, null, and primitives.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read one deployment event field as a boolean.
 * @param value - Candidate field value from a durable event.
 * @returns the boolean value, or undefined for any other type.
 */
function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Parse the allowlist out of a durable route-policy event.
 * @param data - `subagent/model-selection-policy` event payload.
 * @returns every well-formed route, or undefined when the payload carries none.
 */
export function parseAllowedRoutes(data: unknown): AllowedModelRoute[] | undefined {
  const allowed = asRecord(data)?.['allowedModels']
  if (!Array.isArray(allowed)) return undefined
  const routes: AllowedModelRoute[] = []
  for (const entry of allowed) {
    const record = asRecord(entry)
    const provider = asString(record?.['provider'])
    const model = asString(record?.['model'])
    if (provider === undefined || model === undefined) continue
    if (provider.length === 0 || model.length === 0) continue
    routes.push({ provider, model })
  }
  return routes.length === 0 ? undefined : routes
}

/**
 * Find one Session's recorded allowlist among its durable events.
 * @param session - Session whose log is scanned.
 * @returns the authorized routes, or undefined for a Session that recorded none.
 */
export function policyRoutesOf(session: PolicySession | undefined): AllowedModelRoute[] | undefined {
  if (session === undefined || typeof session.eventAt !== 'function') return undefined
  // Policy events precede the first model request, so the scan stays short; the
  // bound keeps a Session without one from walking its whole log.
  for (let seq = 0; seq < 256; seq += 1) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      return undefined
    }
    if (event === undefined) return undefined
    if (event.type !== SUBAGENT_POLICY_EVENT) continue
    const routes = parseAllowedRoutes(event.data)
    if (routes !== undefined) return routes
  }
  return undefined
}

/**
 * Resolve the allowlist a delegation from this agent must respect: the agent's
 * own recorded policy, else the nearest ancestor Session that recorded one
 * (the inheritance the delegation tool applies to child Sessions).
 * @param agent - Calling agent.
 * @param sessions - Session registry used for ancestor lookup.
 * @returns the authorized routes, or undefined when no Session recorded any.
 */
export function authorizedRoutesFor(
  agent: AuthorizationAgent | undefined,
  sessions: SessionsResolver,
): AllowedModelRoute[] | undefined {
  let session = agent?.session
  for (let depth = 0; depth < 8 && session !== undefined; depth += 1) {
    const recorded = policyRoutesOf(session)
    if (recorded !== undefined) return recorded
    const header = session.header
    if (header?.origin !== 'subagent') return undefined
    const parentId = asString(header.parentSession)
    if (parentId === undefined) return undefined
    session = sessions.get(parentId)
  }
  return undefined
}

/**
 * Read the Host preference that owns the allowlist. Values in the stored
 * document are untrusted JSON, so every field is narrowed before use.
 * @param settings - Live settings service, when composed.
 * @returns the resolved preference, or undefined without a settings service.
 */
export function subagentModelSelectionPreference(
  settings: SettingsProvider | undefined,
): SubagentModelSelectionPreference | undefined {
  if (settings === undefined) return undefined
  const register = (settings as unknown as Record<string, unknown>)['register']
  if (typeof register !== 'function') return undefined
  try {
    const scope = (register as (ns: string, schema: unknown) => { get(): unknown })
      .call(settings, SUBAGENT_MODEL_SELECTION_NAMESPACE, z.object({
        enabled: z.boolean().default(false),
        allowedModels: z.array(z.object({
          provider: z.string().min(1).required(),
          model: z.string().min(1).required(),
        })).default([]),
      }))
    const value = asRecord(scope.get())
    if (value === undefined) return undefined
    return {
      enabled: asBoolean(value['enabled']) === true,
      allowedModels: parseAllowedRoutes(value) ?? [],
    }
  } catch {
    // A deployment without this namespace, or with a malformed stored section,
    // leaves delegations exactly as the built-in tool resolves them.
    return undefined
  }
}

/** Whether an exact route is authorized by a allowlist. */
function routesInclude(
  allowed: readonly AllowedModelRoute[],
  provider: string,
  model: string,
): boolean {
  return allowed.some(route => route.provider === provider && route.model === model)
}

/**
 * Build the denial reason for a delegation that would run on an unauthorized
 * route. The reason names the authorized routes so the next call can select one.
 * @param provider - Effective child provider id, when one is known.
 * @param model - Effective child model id, when one is known.
 * @param allowed - Routes the calling Session authorizes.
 * @param explicit - Whether the model named the route in the tool arguments.
 * @returns the corrective reason handed back to the model.
 */
export function unauthorizedRouteReason(
  provider: string | undefined,
  model: string | undefined,
  allowed: readonly AllowedModelRoute[],
  explicit: boolean,
): string {
  const route = provider === undefined || model === undefined
    ? 'the inherited route'
    : `route "${provider}/${model}"`
  const origin = explicit
    ? 'the model this call selected is not on the Session allowlist'
    : 'the route this call would inherit from the parent is not on the Session allowlist'
  const routes = allowed.map(entry => `${entry.provider}/${entry.model}`).join(', ')
  return `subagent model selection: ${origin} (${route}). `
    + `Provide an authorized provider and model — ${routes} — `
    + 'using list_subagent_models to inspect their reasoning efforts.'
}

/** Which Session's recorded allowlist a delegation must respect. */
export type AuthorizationScope =
  /**
   * `session` (default): a Session that recorded an allowlist governs itself
   * and its descendants, matching the delegation tool's durable snapshot; a
   * Session that recorded none keeps the built-in behavior.
   */
  | 'session'
  /**
   * `preference`: the current Host preference also governs Sessions that never
   * recorded an allowlist, so the Settings card applies without restarting the
   * Session. A Session that recorded its own routes still outranks it.
   */
  | 'preference'

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
export function delegationDenialReason(
  agent: AuthorizationAgent | undefined,
  toolName: string,
  args: unknown,
  preference: SubagentModelSelectionPreference | undefined,
  sessions: SessionsResolver,
  toolNames: readonly string[] = DEFAULT_DELEGATION_TOOLS,
  scope: AuthorizationScope = 'session',
): string | undefined {
  if (!toolNames.includes(toolName)) return undefined
  // An explicit "off" in the Host document suspends enforcement everywhere,
  // matching the preference the Settings card owns.
  if (preference !== undefined && !preference.enabled) return undefined
  const recorded = authorizedRoutesFor(agent, sessions)
  const allowed = recorded ?? (scope === 'preference' ? preference?.allowedModels ?? [] : [])
  if (allowed.length === 0) return undefined
  const request = asRecord(args) ?? {}
  const requestedProvider = asString(request['provider'])
  const requestedModel = asString(request['model'])
  const explicit = requestedProvider !== undefined || requestedModel !== undefined
  // A call that names no route inherits the parent's provider and model, so
  // both fall back there. A call that names only one of them is still undecided
  // here: the built-in tool completes that pair from its own configuration, and
  // guessing the missing half from the parent route would deny a compliant call.
  const implicit = requestedProvider === undefined && requestedModel === undefined
  const provider = implicit ? asString(agent?.options?.provider) : requestedProvider
  const model = implicit ? asString(agent?.options?.model) : requestedModel
  if (provider === undefined || model === undefined) {
    // An incompletely resolvable route stays with the built-in tool, which owns
    // the configured defaults and the provider-owned route baseline.
    return undefined
  }
  if (routesInclude(allowed, provider, model)) return undefined
  return unauthorizedRouteReason(provider, model, allowed, explicit)
}

/** Runtime inputs the guard closes over. */
export interface SubagentAuthorizationOptions {
  /** Live settings service, when composed; absent leaves recorded policies in charge. */
  readonly settings?: SettingsProvider
  /** Session registry used for ancestor lookup. */
  readonly sessions: SessionsResolver
  /** Exact delegation tool names this guard authorizes. */
  readonly toolNames: readonly string[]
  /** Whether an unrecorded Session falls back to the current preference. */
  readonly scope?: AuthorizationScope
}

/** The exact guard signature the Host tool registry evaluates. */
export type DelegationGuard = (
  agent: AuthorizationAgent | undefined,
  toolName: string,
  args: unknown,
) => string | undefined

/**
 * Build the monotonic tool guard for one deployment. The Host preference is
 * sampled from the live settings document on every call, because a settings
 * edit must not rebuild the guard the way it cannot rebuild a Session.
 * @param options - settings, session registry, and delegation tool names.
 * @returns a guard that denies delegations outside the Session allowlist.
 */
export function createSubagentAuthorization(
  options: SubagentAuthorizationOptions,
): DelegationGuard {
  return (agent, toolName, args) => delegationDenialReason(
    agent,
    toolName,
    args,
    subagentModelSelectionPreference(options.settings),
    options.sessions,
    options.toolNames,
    options.scope ?? 'session',
  )
}

/** Delegation names this guard recognizes when configuration omits them. */
export function normalizeDelegationToolNames(value: unknown): string[] {
  const names = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
  return [...new Set(names.length === 0 ? [...DEFAULT_DELEGATION_TOOLS] : names.map(name => name.trim()))]
}

/**
 * Validate the plugin configuration that owns this guard.
 * @param toolNames - Candidate delegation tool names.
 * @returns the exact names this guard authorizes.
 */
export function validateDelegationToolNames(toolNames: readonly string[]): string[] {
  if (toolNames.length === 0) {
    throw new Error('dsh-chatgpt-subscription: subagentModelAuthorization.toolNames must name at least one delegation tool')
  }
  for (const name of toolNames) {
    if (name.length === 0 || name !== name.trim()) {
      throw new Error(`dsh-chatgpt-subscription: subagentModelAuthorization.toolNames entry "${name}" must be a non-empty trimmed string`)
    }
  }
  return [...toolNames]
}

/** Configuration accepted by {@link installSubagentModelAuthorization}. */
export interface SubagentModelAuthorizationConfig {
  /** Delegation tool names the guard authorizes. */
  readonly toolNames?: readonly string[]
  /** Whether an unrecorded Session falls back to the current preference. */
  readonly scope?: AuthorizationScope
}

/**
 * Register the monotonic guard on the Host tool registry.
 * @param ctx - Host context carrying `tools` (and optionally `settings`).
 * @param sessions - Session registry used for ancestor lookup.
 * @param config - Enforcement toggle and delegation tool names.
 * @returns the exact disposer that unregisters the guard.
 */
export function installSubagentModelAuthorization(
  ctx: Context,
  sessions: SessionsResolver,
  config: SubagentModelAuthorizationConfig = {},
): () => void {
  const toolNames = validateDelegationToolNames(config.toolNames ?? [...DEFAULT_DELEGATION_TOOLS])
  const scope = validateAuthorizationScope(config.scope ?? 'session')
  const settings = (ctx as unknown as { get?(name: string): unknown }).get?.('settings') as SettingsProvider | undefined
  const authorize = createSubagentAuthorization({ settings, sessions, toolNames, scope })
  return ctx.tools.guard(exec =>
    authorize(exec.agent as AuthorizationAgent | undefined, exec.name, exec.arguments))
}
/**
 * Validate the configured authorization scope.
 * @param scope - Candidate scope from deployment configuration.
 * @returns the exact scope this guard enforces.
 */
export function validateAuthorizationScope(scope: unknown): AuthorizationScope {
  if (scope === 'session' || scope === 'preference') return scope
  throw new Error(
    `dsh-chatgpt-subscription: subagentModelScope must be "session" or "preference", received ${JSON.stringify(scope)}`,
  )
}