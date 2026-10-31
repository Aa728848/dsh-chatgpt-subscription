import { describe, expect, it } from 'vitest'
import type { ToolGuard } from '@deepseek-ai/dsh-tools'
import {
  type AllowedModelRoute,
  type AuthorizationAgent,
  type PolicySession,
  type SessionsResolver,
  type SubagentModelSelectionPreference,
  DEFAULT_SUBAGENT_INHERIT_TOOLS,
  UNRESTRICTED_ROUTING_NOTICE,
  authorizedRoutesFor,
  createSubagentAuthorization,
  delegationDenialReason,
  delegationModeOf,
  effectiveAllowedRoutes,
  enrichListSubagentModelsOutput,
  explicitRoutePair,
  filterListSubagentModelsOutput,
  mergePreferenceOverrides,
  resolveRootSessionAndMainRoute,
  inheritOverrideReason,
  inheritRouteDenialReason,
  inheritedRouteOf,
  installSubagentModelAuthorization,
  normalizeDelegationToolNames,
  normalizeInheritToolNames,
  parseAllowedRoutes,
  policyRoutesOf,
  rewriteAuthorizedPromptAssembly,
  rewriteAuthorizedToolDescriptions,
  routeParameterProbe,
  subagentModelSelectionPreference,
  unauthorizedRouteReason,
  validateAuthorizationScope,
  validateDelegationToolNames,
  validateInheritToolNames,
} from '../src/host/subagent-model-authorization.ts'

const GEMINI: AllowedModelRoute = { provider: 'antigravity', model: 'gemini-3.8-flash' }
const OPUS: AllowedModelRoute = { provider: 'antigravity', model: 'claude-opus-4-6' }
const MINIMAX: AllowedModelRoute = { provider: 'minimax-code', model: 'MiniMax-M3.1-Flash' }
const SLASHED: AllowedModelRoute = { provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash' }
const PREFERENCE: SubagentModelSelectionPreference = { enabled: true, allowedModels: [GEMINI, OPUS] }
const NO_SESSIONS: SessionsResolver = { get: () => undefined }
const DEEPSEEK_OPTIONS = { provider: 'deepseek-official', model: 'deepseek-flash' }

/** Minimal Session double over a dense event list. */
function session(
  events: readonly unknown[],
  header: { origin?: unknown; parentSession?: unknown } = {},
): PolicySession {
  return {
    header,
    eventAt(seq: number) {
      return events[seq] as { type?: unknown; data?: unknown } | undefined
    },
  }
}

/** A session double whose request header names the route the next request uses. */
function routedSession(
  routes: readonly AllowedModelRoute[],
  config: { provider?: string; model?: string; reasoningEffort?: string },
  header: { origin?: unknown; parentSession?: unknown } = {},
): PolicySession {
  const events = [policyEvent(routes)]
  return {
    header,
    eventAt: (seq: number) => events[seq] as { type?: unknown; data?: unknown } | undefined,
    requestHeader: () => ({ config }),
  }
}

/** Session registry double backed by an id map. */
function registry(entries: Record<string, PolicySession>): SessionsResolver {
  return { get: id => entries[id] }
}

function policyEvent(routes: readonly AllowedModelRoute[]): unknown {
  return { type: 'subagent/model-selection-policy', data: { allowedModels: [...routes] } }
}

/** An agent whose Session recorded the allowlist the delegation tool snapshots. */
function recordingAgent(
  routes: readonly AllowedModelRoute[],
  options: { provider?: string; model?: string } = DEEPSEEK_OPTIONS,
): AuthorizationAgent {
  return { options, session: session([policyEvent(routes)]) }
}

/** Settings-provider double serving one resolved namespace value. */
function settingsServing(value: unknown) {
  return {
    register(_namespace: unknown, schema: { (input: unknown): unknown }) {
      return { get: () => schema(value) }
    },
  }
}

const SETTINGS = settingsServing({ enabled: true, allowedModels: [GEMINI, OPUS] })

describe('subagent model authorization', () => {
  it('parses only well-formed routes out of a policy payload', () => {
    expect(parseAllowedRoutes({ allowedModels: [GEMINI, { provider: 'x' }, { provider: '', model: 'm' },
      { provider: 'a', model: '' }, 7] })).toEqual([GEMINI])
    expect(parseAllowedRoutes({ allowedModels: [] })).toBeUndefined()
    expect(parseAllowedRoutes({ allowedModels: 'nope' })).toBeUndefined()
    expect(parseAllowedRoutes(undefined)).toBeUndefined()
  })

  it('reads the policy a Session recorded and tolerates gaps and failing accessors', () => {
    expect(policyRoutesOf(session([{ type: 'session' }, policyEvent([GEMINI])]))).toEqual([GEMINI])
    expect(policyRoutesOf(session([{ type: 'session' }]))).toBeUndefined()
    expect(policyRoutesOf(undefined)).toBeUndefined()
    expect(policyRoutesOf({})).toBeUndefined()
    expect(policyRoutesOf({ eventAt() { throw new Error('log unavailable') } })).toBeUndefined()
  })

  it('inherits an ancestor policy only through a subagent lineage', () => {
    const child = session([{ type: 'session' }], { origin: 'subagent', parentSession: 'parent' })
    const root = session([policyEvent([GEMINI])])
    expect(authorizedRoutesFor({ session: child }, registry({ parent: root }))).toEqual([GEMINI])
    expect(authorizedRoutesFor(
      { session: session([], { parentSession: 'parent' }) },
      registry({ parent: root }),
    )).toBeUndefined()
    expect(authorizedRoutesFor(
      { session: session([], { origin: 'subagent', parentSession: 'missing' }) },
      registry({}),
    )).toBeUndefined()
    expect(authorizedRoutesFor({}, registry({}))).toBeUndefined()
  })

  it('reads the Host preference and refuses an unusable settings service', () => {
    expect(subagentModelSelectionPreference(settingsServing({ enabled: true, allowedModels: [GEMINI] }) as never))
      .toEqual({ enabled: true, allowedModels: [GEMINI] })
    expect(subagentModelSelectionPreference(undefined)).toBeUndefined()
    expect(subagentModelSelectionPreference({} as never)).toBeUndefined()
    expect(subagentModelSelectionPreference({
      register() { throw new Error('namespace unavailable') },
    } as never)).toBeUndefined()
  })

  it('denies an explicit route outside the allowlist with the authorized routes', () => {
    const reason = delegationDenialReason(
      recordingAgent([GEMINI, OPUS]),
      'subagent',
      { provider: 'codex-chatgpt', model: 'gpt-6-astra' },
      PREFERENCE,
      NO_SESSIONS,
    )
    expect(reason).toContain('codex-chatgpt/gpt-6-astra')
    expect(reason).toContain('antigravity/gemini-3.8-flash, antigravity/claude-opus-4-6')
  })

  it('requires an explicit route even when the parent model is authorized', () => {
    const reason = delegationDenialReason(
      recordingAgent([GEMINI, OPUS], { provider: 'antigravity', model: 'gemini-3.8-flash' }),
      'subagent',
      {},
      PREFERENCE,
      NO_SESSIONS,
    )
    expect(reason).toContain('requires an explicit child model')
    expect(reason).toContain('list_subagent_models')
    expect(reason).toContain('antigravity/gemini-3.8-flash, antigravity/claude-opus-4-6')
  })

  it('denies a half-specified route and names the missing field', () => {
    const agent = recordingAgent([GEMINI, OPUS])
    const missingProvider = delegationDenialReason(
      agent, 'subagent', { model: 'gemini-3.8-flash' }, PREFERENCE, NO_SESSIONS,
    )
    expect(missingProvider).toContain('requires an explicit child model')
    expect(missingProvider).toContain('model "gemini-3.8-flash"')
    expect(missingProvider).toContain('provider must be named together')

    const missingModel = delegationDenialReason(
      agent, 'subagent', { provider: 'antigravity' }, PREFERENCE, NO_SESSIONS,
    )
    expect(missingModel).toContain('provider "antigravity"')
    expect(missingModel).toContain('model must be named together')

    // Empty strings are not a named pair either: they cannot be authorized.
    expect(delegationDenialReason(agent, 'subagent', { provider: '', model: '' }, PREFERENCE, NO_SESSIONS))
      .toContain('not on the Session allowlist')
  })

  it('stays out of the way for authorized routes, other tools, and disabled authorization', () => {
    const agent = recordingAgent([GEMINI, OPUS], { provider: 'antigravity', model: 'gemini-3.8-flash' })
    expect(delegationDenialReason(agent, 'subagent', {
      provider: 'antigravity', model: 'gemini-3.8-flash',
    }, PREFERENCE, NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason(agent, 'subagent', { provider: 'antigravity', model: 'claude-opus-4-6' },
      PREFERENCE, NO_SESSIONS)).toBeUndefined()
    // `subagent_fork` is not an explicit-route tool, so a plain name list still
    // leaves it alone; inherit mode is configured separately.
    expect(delegationDenialReason(agent, 'subagent_fork', {}, PREFERENCE, NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason(agent, 'subagent', {}, { enabled: false, allowedModels: [GEMINI] },
      NO_SESSIONS)).toBeUndefined()
  })

  it('keeps a recorded policy authoritative when the settings service is absent', () => {
    const agent = recordingAgent([GEMINI, OPUS], { provider: 'antigravity', model: 'gemini-3.8-flash' })
    expect(delegationDenialReason(agent, 'subagent', {}, undefined, NO_SESSIONS))
      .toContain('requires an explicit child model')
    expect(delegationDenialReason(agent, 'subagent', {
      provider: 'antigravity', model: 'gemini-3.8-flash',
    }, undefined, NO_SESSIONS)).toBeUndefined()
  })

  it('leaves a Session that recorded no policy on the built-in behavior', () => {
    const agent: AuthorizationAgent = { options: DEEPSEEK_OPTIONS }
    expect(delegationDenialReason(agent, 'subagent', { provider: 'codex-chatgpt', model: 'gpt-6-astra' },
      PREFERENCE, NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason(agent, 'subagent', {}, PREFERENCE, NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason({}, 'subagent', {}, PREFERENCE, NO_SESSIONS)).toBeUndefined()
  })

  it('governs an unrecorded Session only under preference scope', () => {
    const agent: AuthorizationAgent = { options: DEEPSEEK_OPTIONS }
    expect(delegationDenialReason(agent, 'subagent', {}, PREFERENCE, NO_SESSIONS, ['subagent'], 'preference'))
      .toContain('requires an explicit child model')
    expect(delegationDenialReason(agent, 'subagent', { provider: 'antigravity', model: 'gemini-3.8-flash' },
      PREFERENCE, NO_SESSIONS, ['subagent'], 'preference')).toBeUndefined()
  })

  it('denies an explicit route that is not registered rather than resolving it locally', () => {
    const agent = recordingAgent([GEMINI, OPUS])
    expect(delegationDenialReason(agent, 'subagent', { provider: 'not-registered', model: 'some-model' },
      PREFERENCE, NO_SESSIONS)).toContain('is not on the Session allowlist')
    expect(delegationDenialReason(agent, 'subagent', { provider: 'not-registered', model: 'gemini-3.8-flash' },
      PREFERENCE, NO_SESSIONS)).toContain('is not on the Session allowlist')
    expect(unauthorizedRouteReason(undefined, undefined, [GEMINI], false)).toContain('the inherited route')
  })

  it('prefers the recorded Session policy over the current preference', () => {
    const agent = recordingAgent([GEMINI], { provider: 'antigravity', model: 'claude-opus-4-6' })
    // OPUS is authorized by the current preference only, and the Session
    // recorded GEMINI alone, so the recorded list decides both the verdict and
    // the routes the denial names.
    expect(delegationDenialReason(agent, 'subagent', {
      provider: 'antigravity', model: 'claude-opus-4-6',
    }, PREFERENCE, NO_SESSIONS)).toContain('antigravity/gemini-3.8-flash')
    expect(delegationDenialReason(agent, 'subagent', {
      provider: 'antigravity', model: 'claude-opus-4-6',
    }, PREFERENCE, NO_SESSIONS)).not.toContain('claude-opus-4-6 with')
  })

  it('binds the guard to the Session policy, the preference, and the configured names', () => {
    const authorize = createSubagentAuthorization({
      settings: SETTINGS as never,
      sessions: NO_SESSIONS,
      toolNames: ['delegate'],
    })
    const unrecorded: AuthorizationAgent = { options: DEEPSEEK_OPTIONS }
    expect(authorize(unrecorded, 'subagent', {})).toBeUndefined()
    expect(authorize(unrecorded, 'delegate', {})).toBeUndefined()
    expect(authorize(recordingAgent([GEMINI, OPUS]), 'delegate', {}))
      .toContain('requires an explicit child model')
    const permissive = createSubagentAuthorization({
      settings: SETTINGS as never,
      sessions: NO_SESSIONS,
      toolNames: ['subagent'],
      scope: 'preference',
    })
    expect(permissive(unrecorded, 'subagent', {})).toContain('requires an explicit child model')
    expect(permissive(unrecorded, 'subagent', { provider: 'antigravity', model: 'gemini-3.8-flash' }))
      .toBeUndefined()
  })

  it('resolves each tool name to the mode the guard enforces on it', () => {
    expect(delegationModeOf([{ name: 'subagent', mode: 'explicit' }], 'subagent')).toBe('explicit')
    expect(delegationModeOf([{ name: 'subagent_fork', mode: 'inherit' }], 'subagent_fork')).toBe('inherit')
    expect(delegationModeOf([{ name: 'subagent', mode: 'explicit' }], 'read')).toBeUndefined()
    // Precedence is first-match, so a name listed in both lists is not ambiguous
    // inside the decision function; the installer rejects that configuration.
    expect(delegationModeOf([
      { name: 'x', mode: 'explicit' }, { name: 'x', mode: 'inherit' },
    ], 'x')).toBe('explicit')
  })

  it('reads the inherited route from the request header, falling back only when it says nothing', () => {
    expect(inheritedRouteOf({ session: routedSession([GEMINI], { provider: 'kimi-code', model: 'k3' }) }))
      .toEqual({ provider: 'kimi-code', model: 'k3', reasoningEffort: undefined })
    // The header is authoritative: stale creation options must not win after a
    // mid-session model switch.
    expect(inheritedRouteOf({
      options: { provider: 'antigravity', model: 'gemini-3.8-flash' },
      session: routedSession([GEMINI], { provider: 'kimi-code', model: 'k3' }),
    })).toMatchObject({ provider: 'kimi-code', model: 'k3' })
    // A header naming no route leaves the declared options in charge.
    expect(inheritedRouteOf({
      options: { provider: 'antigravity', model: 'gemini-3.8-flash' },
      session: routedSession([GEMINI], {}),
    })).toMatchObject({ provider: 'antigravity', model: 'gemini-3.8-flash' })
    expect(inheritedRouteOf({ options: DEEPSEEK_OPTIONS }))
      .toMatchObject({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(inheritedRouteOf(undefined)).toEqual({ provider: undefined, model: undefined })
    // An unavailable fold degrades to the declared options rather than throwing.
    expect(inheritedRouteOf({
      options: DEEPSEEK_OPTIONS,
      session: { header: {}, requestHeader() { throw new Error('fold unavailable') } },
    })).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('denies an inherit-mode delegation whose inherited route is not authorized', () => {
    const agent = { session: routedSession([GEMINI], { provider: 'kimi-code', model: 'k3' }) }
    const reason = delegationDenialReason(
      agent, 'subagent_fork', {}, PREFERENCE, NO_SESSIONS,
      ['subagent'], 'session', ['subagent_fork'],
    )
    expect(reason).toContain('subagent_fork')
    expect(reason).toContain('"kimi-code/k3"')
    // The Session recorded GEMINI alone, so that — not the wider preference —
    // is the list the denial must name.
    expect(reason).toContain('antigravity/gemini-3.8-flash')
  })

  it('allows an inherit-mode delegation when the inherited route is authorized', () => {
    const agent = { session: routedSession([GEMINI], { provider: 'antigravity', model: 'gemini-3.8-flash' }) }
    expect(delegationDenialReason(
      agent, 'subagent_fork', {}, PREFERENCE, NO_SESSIONS,
      ['subagent'], 'session', ['subagent_fork'],
    )).toBeUndefined()
  })

  it('denies an inherit-mode delegation that tries to name a route it cannot accept', () => {
    // The inherited route IS authorized, so only the override can deny this call:
    // that proves the override check runs before the route check.
    const agent = { session: routedSession([GEMINI], { provider: 'antigravity', model: 'gemini-3.8-flash' }) }
    const reason = delegationDenialReason(
      agent, 'subagent_fork', { provider: 'antigravity', model: 'claude-opus-4-6' },
      PREFERENCE, NO_SESSIONS, ['subagent'], 'session', ['subagent_fork'],
    )
    expect(reason).toContain('accepts no')
    expect(reason).toContain('antigravity/claude-opus-4-6')
  })

  it('leaves inherit mode inert without a recorded allowlist', () => {
    const agent = { session: routedSession([GEMINI], { provider: 'kimi-code', model: 'k3' }) }
    expect(delegationDenialReason(
      { options: DEEPSEEK_OPTIONS }, 'subagent_fork', {}, PREFERENCE, NO_SESSIONS,
      ['subagent'], 'session', ['subagent_fork'],
    )).toBeUndefined()
    // A disabled preference suspends it everywhere, exactly like explicit mode.
    expect(delegationDenialReason(
      agent, 'subagent_fork', {}, { enabled: false, allowedModels: [GEMINI] }, NO_SESSIONS,
      ['subagent'], 'session', ['subagent_fork'],
    )).toBeUndefined()
  })

  it('renders inherit-mode reasons without a route and without a named pair', () => {
    expect(inheritRouteDenialReason('subagent_fork', undefined, undefined, [GEMINI]))
      .toContain("the calling agent's route")
    expect(inheritRouteDenialReason('subagent_fork', 'a', 'b', [GEMINI], 'high')).toContain('(high)')
    // Option A's remedy must be reachable: fork is denied because the SESSION's
    // route is unauthorized, so the refusal has to say the tool returns once the
    // session moves to an authorized model — otherwise the model has no way out.
    const denied = inheritRouteDenialReason('subagent_fork', 'kimi-code', 'k3', [GEMINI])
    expect(denied).toContain('unavailable for now')
    expect(denied).toContain('works again')
    expect(denied).toContain('antigravity/gemini-3.8-flash')
    expect(inheritOverrideReason('subagent_fork', 'a', 'b')).toContain('"a/b"')
  })

  it('policies spawn_teammate as an inherit tool, never as an explicit one', () => {
    // The Agent Teams runtime starts every teammate with no agentOptions, so the
    // tool exposes no route parameters. Treating it as explicit would deny every
    // creation with "name provider and model" — an instruction the model cannot
    // follow, because the schema has no such fields.
    expect(DEFAULT_SUBAGENT_INHERIT_TOOLS).toContain('spawn_teammate')
    expect(DEFAULT_SUBAGENT_INHERIT_TOOLS).not.toContain('subagent')
    expect(normalizeInheritToolNames(undefined)).toContain('spawn_teammate')

    const unauthorized = { session: routedSession([GEMINI], { provider: 'kimi-code', model: 'k3' }) }
    const reason = delegationDenialReason(
      unauthorized, 'spawn_teammate', {}, PREFERENCE, NO_SESSIONS,
      ['subagent'], 'session', [...DEFAULT_SUBAGENT_INHERIT_TOOLS],
    )
    // The denial must be the inherit one — it names the tool and routes the
    // model at tools it can actually re-route, not at unfillable fields.
    expect(reason).toContain('spawn_teammate')
    expect(reason).toContain('"kimi-code/k3"')
    expect(reason).toContain('antigravity/gemini-3.8-flash')
    expect(reason).not.toContain('requires an explicit child model')

    // An authorized Lead route lets the teammate through untouched.
    const authorized = { session: routedSession([GEMINI], { provider: 'antigravity', model: 'gemini-3.8-flash' }) }
    expect(delegationDenialReason(
      authorized, 'spawn_teammate', {}, PREFERENCE, NO_SESSIONS,
      ['subagent'], 'session', [...DEFAULT_SUBAGENT_INHERIT_TOOLS],
    )).toBeUndefined()

    // A named route is meaningless on a tool with no route fields: denying it is
    // the override branch, which is the only thing that can still deny a call
    // whose inherited route is already authorized.
    expect(delegationDenialReason(
      authorized, 'spawn_teammate', { provider: 'antigravity', model: 'claude-opus-4-6' },
      PREFERENCE, NO_SESSIONS, ['subagent'], 'session', [...DEFAULT_SUBAGENT_INHERIT_TOOLS],
    )).toContain('accepts no')

    // Opting out of the default restores the untouched behavior.
    expect(delegationDenialReason(
      unauthorized, 'spawn_teammate', {}, PREFERENCE, NO_SESSIONS,
      ['subagent'], 'session', [],
    )).toBeUndefined()
  })

  it('installs inherit names and rejects a tool listed in both modes', () => {
    const registered: ToolGuard[] = []
    const ctx = {
      tools: { guard: (guard: ToolGuard) => { registered.push(guard); return () => undefined } },
      get: () => undefined,
    }
    installSubagentModelAuthorization(ctx as never, registry({}), {
      toolNames: ['subagent'],
      inheritToolNames: ['subagent_fork'],
    })
    expect(registered).toHaveLength(1)
    expect(() => installSubagentModelAuthorization(ctx as never, registry({}), {
      toolNames: ['subagent', 'subagent_fork'],
      inheritToolNames: ['subagent_fork'],
    })).toThrow(/both an explicit and an inherit tool/)
    // Emptiness is a legal opt-out here, unlike the explicit list.
    expect(validateInheritToolNames([])).toEqual([])
    expect(() => { validateInheritToolNames([' fork']) }).toThrow(/non-empty trimmed string/)
    expect(normalizeInheritToolNames(undefined)).toEqual([...DEFAULT_SUBAGENT_INHERIT_TOOLS])
    expect(normalizeInheritToolNames([])).toEqual([])
    expect(normalizeInheritToolNames([' subagent_fork ', 'subagent_fork'])).toEqual(['subagent_fork'])
  })

  it('normalizes and validates delegation names and scope at the configuration boundary', () => {
    expect(normalizeDelegationToolNames(undefined)).toEqual(['subagent'])
    expect(normalizeDelegationToolNames([])).toEqual(['subagent'])
    expect(normalizeDelegationToolNames([' subagent ', 'subagent', 'delegate']))
      .toEqual(['subagent', 'delegate'])
    expect(validateDelegationToolNames(['subagent'])).toEqual(['subagent'])
    expect(() => { validateDelegationToolNames([]) }).toThrow(/at least one delegation tool/)
    expect(() => { validateDelegationToolNames([' delegate']) }).toThrow(/non-empty trimmed string/)
    expect(validateAuthorizationScope('session')).toBe('session')
    expect(validateAuthorizationScope('preference')).toBe('preference')
    expect(() => { validateAuthorizationScope('everything') }).toThrow(/must be "session" or "preference"/)
  })

  it('registers one monotonic guard on the Host tool registry', () => {
    const registered: ToolGuard[] = []
    let disposed = 0
    const ctx = {
      tools: { guard: (guard: ToolGuard) => { registered.push(guard); return () => { disposed += 1 } } },
      get: (name: string) => name === 'settings' ? SETTINGS : undefined,
    }
    const dispose = installSubagentModelAuthorization(
      ctx as never,
      registry({}),
      { toolNames: ['subagent'] },
    )
    expect(registered).toHaveLength(1)
    const guard = registered[0]!
    const exec = { name: 'subagent', arguments: {}, agent: recordingAgent([GEMINI, OPUS]), signal: new AbortController().signal }
    expect(guard(exec as never)).toContain('requires an explicit child model')
    expect(guard({ ...exec, name: 'read' } as never)).toBeUndefined()
    // An agent without a recorded policy stays on the built-in behavior under
    // session scope, even when its own route would be authorized.
    expect(guard({
      ...exec,
      agent: { options: { provider: 'antigravity', model: 'gemini-3.8-flash' } },
    } as never)).toBeUndefined()
    expect(guard({
      ...exec,
      arguments: { provider: 'antigravity', model: 'gemini-3.8-flash' },
    } as never)).toBeUndefined()
    dispose()
    expect(disposed).toBe(1)
    expect(() => installSubagentModelAuthorization(ctx as never, registry({}), { toolNames: [] }))
      .toThrow(/at least one delegation tool/)
  })

  it('names the split when a model repeats the provider prefix', () => {
    const agent = recordingAgent([MINIMAX])
    // `list_subagent_models` prints every route as `provider/model`, and the
    // `model` parameter is documented as the id for that provider — so a model
    // that copies the printed line into `model` while naming `provider`
    // separately sends a doubled id. That is the route the user authorized, not
    // a different one, and it is refused with the exact split rather than an
    // opaque "not on the allowlist": accepting the doubled id would only hand
    // an unresolvable model to the adapter.
    const prefixed = delegationDenialReason(agent, 'subagent', {
      provider: 'minimax-code', model: 'minimax-code/MiniMax-M3.1-Flash',
    }, PREFERENCE, NO_SESSIONS)
    expect(prefixed).toContain('passed a whole route as `model`')
    expect(prefixed).toContain('provider "minimax-code", model "MiniMax-M3.1-Flash"')
    expect(prefixed).not.toContain('is not on the Session allowlist')
    // The same authorized route passed as two fields is accepted unchanged.
    expect(delegationDenialReason(agent, 'subagent', {
      provider: 'minimax-code', model: 'MiniMax-M3.1-Flash',
    }, PREFERENCE, NO_SESSIONS)).toBeUndefined()
    expect(explicitRoutePair('minimax-code', 'minimax-code/MiniMax-M3.1-Flash'))
      .toEqual({ provider: 'minimax-code', model: 'MiniMax-M3.1-Flash' })

    // An id that merely contains a slash belongs to its own provider and is
    // left untouched, so a genuine cross-provider id is never rewritten.
    expect(explicitRoutePair('minimax-code', 'deepseek/deepseek-v4.1-flash'))
      .toEqual({ provider: 'minimax-code', model: 'deepseek/deepseek-v4.1-flash' })
    // A model id that legitimately contains the provider prefix is authorized
    // exactly as written, and the prefix reading must not shadow it.
    expect(delegationDenialReason(recordingAgent([SLASHED]), 'subagent', {
      provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash',
    }, PREFERENCE, NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason(agent, 'subagent', {
      provider: 'minimax-code', model: 'deepseek/deepseek-v4.1-flash',
    }, PREFERENCE, NO_SESSIONS)).toContain('is not on the Session allowlist')

    // A half-specified pair never resolves, and a prefix with nothing behind it
    // is not a model id either.
    expect(explicitRoutePair('minimax-code', undefined)).toBeUndefined()
    expect(explicitRoutePair(undefined, 'MiniMax-M3.1-Flash')).toBeUndefined()
    expect(explicitRoutePair('', 'MiniMax-M3.1-Flash')).toBeUndefined()
    expect(explicitRoutePair('p', 'p/')).toEqual({ provider: 'p', model: 'p/' })

    // A doubled id that resolves to no authorized route is still reported as
    // the unauthorized route it is, with the authorized list.
    const reason = delegationDenialReason(agent, 'subagent', {
      provider: 'minimax-code', model: 'minimax-code/MiniMax-M2',
    }, PREFERENCE, NO_SESSIONS)
    expect(reason).toContain('minimax-code/minimax-code/MiniMax-M2')
    expect(reason).toContain('minimax-code/MiniMax-M3.1-Flash')
    expect(reason).toContain('is not on the Session allowlist')
  })

  it('enriches list_subagent_models output with split authorized routes and rewrites misleading tool descriptions', async () => {
    expect(effectiveAllowedRoutes(recordingAgent([MINIMAX]), PREFERENCE, NO_SESSIONS)).toEqual([MINIMAX])
    expect(effectiveAllowedRoutes(recordingAgent([MINIMAX]), { enabled: false, allowedModels: [MINIMAX] }, NO_SESSIONS))
      .toEqual([])

    const rawProviderList = 'minimax-code — MiniMax Code'
    const enriched = enrichListSubagentModelsOutput(rawProviderList, [MINIMAX])
    expect(enriched).toContain('minimax-code — MiniMax Code')
    expect(enriched).toContain('already filtered by the Session allowlist')
    expect(enriched).toContain('- minimax-code/MiniMax-M3.1-Flash -> provider: "minimax-code", model: "MiniMax-M3.1-Flash"')
    // Idempotent when called twice.
    expect(enrichListSubagentModelsOutput(enriched, [MINIMAX])).toBe(enriched)
    // With no allowlist the output states the opposite fact instead of staying
    // silent: the tool row is mounted statically, so a mounted tool must not be
    // readable as an active allowlist.
    const unlisted = enrichListSubagentModelsOutput(rawProviderList, [])
    expect(unlisted).toContain('minimax-code — MiniMax Code')
    expect(unlisted).toContain('No allowlist is in force for this Session')
    expect(unlisted).toContain('subagent routing is unrestricted')
    expect(unlisted).toContain('omitting provider/model is legitimate')
    expect(unlisted).not.toContain('Authorized child routes for this Session')
    // Idempotent there too, and a bare empty output becomes the notice alone.
    expect(enrichListSubagentModelsOutput(unlisted, [])).toBe(unlisted)
    expect(enrichListSubagentModelsOutput('', [])).toBe(UNRESTRICTED_ROUTING_NOTICE)
    expect(enrichListSubagentModelsOutput('', [MINIMAX])).not.toContain('No allowlist is in force')
    // The notice stays a statement of two facts. This listener is host-level and
    // reaches Sessions that never touch the dispatch preset, so a recommendation
    // to change a setting would be noise in most of them — and a model that reads
    // it as an instruction repeats it in unrelated summaries.
    expect(UNRESTRICTED_ROUTING_NOTICE).not.toContain('Settings')
    expect(UNRESTRICTED_ROUTING_NOTICE).not.toContain('Subagents')
    expect(UNRESTRICTED_ROUTING_NOTICE).not.toContain('enable')

    const upstreamListDesc = 'Discover LLM routes for subagents without changing the current Agent. '
      + 'Catalog membership is advisory: an adapter may accept an unlisted model id.'
    const upstreamSubagentDesc = 'Delegate a self-contained task. '
      + 'Child LLM selection is optional. Omit `provider`, `model`, and `reasoning_effort` to use configured child defaults and inherit compatible missing values from the parent Agent.'
    expect(rewriteAuthorizedToolDescriptions(upstreamListDesc, [MINIMAX]))
      .toContain("Output is already filtered to this Session's allowlist (minimax-code/MiniMax-M3.1-Flash)")
    expect(rewriteAuthorizedToolDescriptions(upstreamListDesc, [MINIMAX]))
      .not.toContain('Catalog membership is advisory')
    expect(rewriteAuthorizedToolDescriptions(upstreamSubagentDesc, [MINIMAX]))
      .toContain('Child LLM selection is required in this Session')
    expect(rewriteAuthorizedToolDescriptions(upstreamSubagentDesc, [MINIMAX]))
      .not.toContain('Child LLM selection is optional')

    const assembly = {
      sections: [{ name: 'tools:sdk', text: `${upstreamListDesc}\n${upstreamSubagentDesc}` }],
      tools: [
        {
          name: 'list_subagent_models',
          description: upstreamListDesc,
          parameters: { type: 'object', properties: {} },
        },
        {
          name: 'subagent',
          description: upstreamSubagentDesc,
          parameters: {
            type: 'object',
            properties: {
              provider: {
                type: 'string',
                description: 'LLM provider route for the child. Supply together with model; omit both to use configured child defaults or inherit the parent route.',
              },
              model: {
                type: 'string',
                description: 'Model id interpreted by provider. Supply together with provider; omit both to use configured child defaults or inherit the parent route.',
              },
            },
          },
        },
      ],
    }
    const rewritten = rewriteAuthorizedPromptAssembly(assembly, [MINIMAX])
    expect(rewritten.sections[0]!.text).not.toContain('Catalog membership is advisory')
    expect(rewritten.sections[0]!.text).not.toContain('Child LLM selection is optional')
    expect(rewritten.tools[0]!.description).toContain("Output is already filtered to this Session's allowlist")
    expect(rewritten.tools[1]!.description).toContain('Child LLM selection is required in this Session')
    const props = (rewritten.tools[1]!.parameters as { properties: Record<string, { description: string }> }).properties
    expect(props['provider']!.description).toContain('Required in this Session: pass an authorized provider id')
    expect(props['model']!.description).toContain('Required in this Session: pass the authorized model id (without the provider/ prefix)')
    // Unrestricted sessions keep the original assembly reference untouched.
    expect(rewriteAuthorizedPromptAssembly(assembly, [])).toBe(assembly)

    // Verify the event hooks registered by installSubagentModelAuthorization.
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    let disposedEvents = 0
    const ctx = {
      tools: { guard: () => () => undefined },
      get: (name: string) => name === 'settings' ? SETTINGS : undefined,
      on: (event: string, fn: (...args: unknown[]) => unknown) => {
        listeners.set(event, fn)
        return () => { disposedEvents += 1 }
      },
    }
    const dispose = installSubagentModelAuthorization(ctx as never, NO_SESSIONS)
    const postExecute = listeners.get('tools/post-execute')!
    const postDecision = await postExecute(
      { name: 'list_subagent_models', agent: recordingAgent([MINIMAX]) },
      { isError: false, value: rawProviderList },
      async () => ({ kind: 'accept' }),
    ) as { kind: string; value: string }
    expect(postDecision.kind).toBe('accept')
    expect(postDecision.value).toContain('provider: "minimax-code", model: "MiniMax-M3.1-Flash"')

    // The unlisted posture reaches the model through the same hook: a Session
    // that recorded no allowlist gets the fact that nothing is enforced, instead
    // of silence that would read as "the mounted tool is the allowlist".
    const unlistedDecision = await postExecute(
      { name: 'list_subagent_models', agent: recordingAgent([]) },
      { isError: false, value: rawProviderList },
      async () => ({ kind: 'accept' }),
    ) as { kind: string; value: string }
    expect(unlistedDecision.kind).toBe('accept')
    expect(unlistedDecision.value).toContain(UNRESTRICTED_ROUTING_NOTICE)
    expect(unlistedDecision.value).toContain(rawProviderList)

    const assembleHook = listeners.get('system-prompt/assemble')!
    const assembledOut = await assembleHook(
      assembly,
      { scope: recordingAgent([MINIMAX]) },
      async () => assembly,
    ) as typeof assembly
    expect(assembledOut.sections[0]!.text).toContain('Child LLM selection is required in this Session')

    dispose()
    expect(disposedEvents).toBe(2)
  })
})

describe('per-main-model subagent routing', () => {
  const DEEPSEEK: AllowedModelRoute = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const CODEX: AllowedModelRoute = { provider: 'codex-chatgpt', model: 'gpt-6-astra' }
  const BY_MAIN: SubagentModelSelectionPreference = {
    enabled: true,
    allowedModels: [GEMINI, OPUS],
    defaultAllowedModels: [MINIMAX],
    byMainModel: {
      'codex-chatgpt/gpt-6-astra': [CODEX],
    },
  }

  /** A root Session that recorded its policy and whose header names its main route. */
  function rootSession(
    routes: readonly AllowedModelRoute[],
    mainRoute: { provider?: string; model?: string },
  ): PolicySession {
    return routedSession(routes, mainRoute)
  }

  it('applies the entry for the root Session main model, then the fallback list, then the policy', () => {
    const codexRoot = rootSession([GEMINI, OPUS], { provider: 'codex-chatgpt', model: 'gpt-6-astra' })
    expect(effectiveAllowedRoutes({ session: codexRoot }, BY_MAIN, NO_SESSIONS)).toEqual([CODEX])
    // An unmatched main model falls back to the deployment's fallback list.
    const deepseekRoot = rootSession([GEMINI, OPUS], DEEPSEEK)
    expect(effectiveAllowedRoutes({ session: deepseekRoot }, BY_MAIN, NO_SESSIONS)).toEqual([MINIMAX])
    // A deployment with no override configured keeps the Session policy.
    const plain = rootSession([GEMINI, OPUS], DEEPSEEK)
    expect(effectiveAllowedRoutes({ session: plain }, PREFERENCE, NO_SESSIONS)).toEqual([GEMINI, OPUS])
    // An override can never invent an allowlist for a Session that governs none.
    expect(effectiveAllowedRoutes({ session: session([]) }, BY_MAIN, NO_SESSIONS)).toEqual([])
    expect(effectiveAllowedRoutes({ session: session([]) }, BY_MAIN, NO_SESSIONS, 'preference')).toEqual([MINIMAX])
    // An explicit "off" still suspends enforcement everywhere.
    expect(effectiveAllowedRoutes({ session: codexRoot }, { ...BY_MAIN, enabled: false }, NO_SESSIONS)).toEqual([])
  })

  it('resolves the main model from the ROOT Session, never from the child', () => {
    const root = rootSession([GEMINI, OPUS], { provider: 'codex-chatgpt', model: 'gpt-6-astra' })
    const child = session([policyEvent([GEMINI, OPUS])], { origin: 'subagent', parentSession: 'root' })
    const sessions = registry({ root })
    // The child's own route is irrelevant: the main model belongs to the root.
    const childAgent = { session: child, options: DEEPSEEK }
    expect(resolveRootSessionAndMainRoute(childAgent, sessions).mainRoute).toEqual({
      provider: 'codex-chatgpt', model: 'gpt-6-astra',
    })
    expect(effectiveAllowedRoutes(childAgent, BY_MAIN, sessions)).toEqual([CODEX])
  })

  it('reads the main route from the live model accessor and the delegation hint', () => {
    const live = session([policyEvent([GEMINI, OPUS])])
    expect(resolveRootSessionAndMainRoute({ session: live, model: { current: () => DEEPSEEK } }, NO_SESSIONS).mainRoute)
      .toEqual(DEEPSEEK)
    const hinted = session([policyEvent([GEMINI, OPUS])])
    expect(resolveRootSessionAndMainRoute({ session: hinted }, NO_SESSIONS, CODEX).mainRoute).toEqual(CODEX)
    // A header that names the route outranks the creation options, which go stale
    // after a mid-session switch.
    const switched = rootSession([GEMINI, OPUS], { provider: 'codex-chatgpt', model: 'gpt-6-astra' })
    expect(resolveRootSessionAndMainRoute({ session: switched, options: DEEPSEEK }, NO_SESSIONS).mainRoute)
      .toEqual({ provider: 'codex-chatgpt', model: 'gpt-6-astra' })
  })

  it('locks the first resolved main route so the allowlist never drifts mid-session', () => {
    // A Session whose main model is switched AFTER its policy was first read
    // keeps the routes it started with: re-pointing them would change the
    // prompt-advertised list mid-conversation and invalidate its prefix cache.
    const events = [policyEvent([GEMINI, OPUS])]
    let config: { provider?: string; model?: string } = { provider: 'codex-chatgpt', model: 'gpt-6-astra' }
    const lockable: PolicySession = {
      eventAt: (seq: number) => events[seq] as { type?: unknown; data?: unknown } | undefined,
      requestHeader: () => ({ config }),
    }
    const agent = { session: lockable }
    expect(effectiveAllowedRoutes(agent, BY_MAIN, NO_SESSIONS, 'session', true)).toEqual([CODEX])
    config = DEEPSEEK
    // Locked: the answer is still the entry for the model the Session started on.
    expect(effectiveAllowedRoutes(agent, BY_MAIN, NO_SESSIONS, 'session', true)).toEqual([CODEX])
    expect(resolveRootSessionAndMainRoute(agent, NO_SESSIONS).mainRoute)
      .toEqual({ provider: 'codex-chatgpt', model: 'gpt-6-astra' })
    // A different Session object is a different lock.
    const other = rootSession([GEMINI, OPUS], DEEPSEEK)
    expect(effectiveAllowedRoutes({ session: other }, BY_MAIN, NO_SESSIONS, 'session', true)).toEqual([MINIMAX])
  })

  it('locks the resolved route LIST so a Settings edit never rewrites a running session prompt', () => {
    // The main route is only the key into byMainModel. Editing the list while a
    // session runs must not change what that session advertises: the
    // prompt-assembly hook rewrites the subagent description and the tools:sdk
    // section from it, so a mid-conversation change loses the prefix cache and
    // contradicts the card's "applies to new sessions" promise.
    const live = rootSession([GEMINI, OPUS], { provider: 'codex-chatgpt', model: 'gpt-6-astra' })
    const agent = { session: live }
    expect(effectiveAllowedRoutes(agent, BY_MAIN, NO_SESSIONS, 'session', true)).toEqual([CODEX])

    // A later step sees an edited preference: the entry is replaced and the
    // fallback list changes too.
    const edited: SubagentModelSelectionPreference = {
      ...BY_MAIN,
      defaultAllowedModels: [{ provider: 'antigravity', model: 'gemini-3.8-flash' }],
      byMainModel: { 'codex-chatgpt/gpt-6-astra': [MINIMAX] },
    }
    // The running session keeps the list it started with...
    expect(effectiveAllowedRoutes(agent, edited, NO_SESSIONS, 'session', true)).toEqual([CODEX])
    expect(effectiveAllowedRoutes(agent, edited, NO_SESSIONS, 'session', true)).not.toEqual([MINIMAX])
    // ...including through the prompt hook, which must not rewrite a locked
    // session's description with the new list.
    const upstreamDesc = 'Delegate a task. Child LLM selection is optional. '
      + 'Omit `provider`, `model`, and `reasoning_effort` to use configured child defaults and inherit compatible missing values from the parent Agent.'
    const assembly = {
      sections: [{ name: 'tools:sdk', text: upstreamDesc }],
      tools: [{ name: 'subagent', description: upstreamDesc }],
    }
    const rewritten = rewriteAuthorizedPromptAssembly(assembly, effectiveAllowedRoutes(agent, edited, NO_SESSIONS, 'session', true))
    expect(rewritten.sections[0]!.text).toContain('codex-chatgpt/gpt-6-astra')
    expect(rewritten.sections[0]!.text).not.toContain('minimax-code/MiniMax-M3.1-Flash')

    // A session created AFTER the edit picks the new list up.
    const fresh = rootSession([GEMINI, OPUS], { provider: 'codex-chatgpt', model: 'gpt-6-astra' })
    expect(effectiveAllowedRoutes({ session: fresh }, edited, NO_SESSIONS, 'session', true)).toEqual([MINIMAX])
    // The fallback list is locked the same way for a main model with no entry.
    const deepseekLive = rootSession([GEMINI, OPUS], DEEPSEEK)
    expect(effectiveAllowedRoutes({ session: deepseekLive }, BY_MAIN, NO_SESSIONS, 'session', true)).toEqual([MINIMAX])
    const editedFallback: SubagentModelSelectionPreference = {
      ...BY_MAIN,
      defaultAllowedModels: [CODEX],
    }
    expect(effectiveAllowedRoutes({ session: deepseekLive }, editedFallback, NO_SESSIONS, 'session', true))
      .toEqual([MINIMAX])
    expect(effectiveAllowedRoutes({ session: rootSession([GEMINI, OPUS], DEEPSEEK) }, editedFallback, NO_SESSIONS, 'session', true))
      .toEqual([CODEX])
    // A session with a request header locks on first use even without the flag.
    const headerLocked = rootSession([GEMINI, OPUS], { provider: 'codex-chatgpt', model: 'gpt-6-astra' })
    expect(effectiveAllowedRoutes({ session: headerLocked }, BY_MAIN, NO_SESSIONS)).toEqual([CODEX])
    expect(effectiveAllowedRoutes({ session: headerLocked }, edited, NO_SESSIONS)).toEqual([CODEX])
  })

  it('denies a delegation outside the overridden list with that list in the reason', () => {
    const codexRoot = rootSession([GEMINI, OPUS], { provider: 'codex-chatgpt', model: 'gpt-6-astra' })
    const agent = { session: codexRoot }
    // GEMINI is on the Session policy but not on this main model's entry.
    expect(delegationDenialReason(agent, 'subagent', { provider: GEMINI.provider, model: GEMINI.model }, BY_MAIN, NO_SESSIONS))
      .toContain('codex-chatgpt/gpt-6-astra')
    expect(delegationDenialReason(agent, 'subagent', { provider: CODEX.provider, model: CODEX.model }, BY_MAIN, NO_SESSIONS))
      .toBeUndefined()
  })

  it('merges live overrides into the preference, including without a settings namespace', () => {
    expect(mergePreferenceOverrides(PREFERENCE, undefined)).toBe(PREFERENCE)
    expect(mergePreferenceOverrides(undefined, undefined)).toBeUndefined()
    expect(mergePreferenceOverrides(undefined, { defaultAllowedModels: [MINIMAX] })).toEqual({
      enabled: true, allowedModels: [MINIMAX], defaultAllowedModels: [MINIMAX],
    })
    expect(mergePreferenceOverrides(undefined, { byMainModel: { 'a/b': [CODEX] } })).toEqual({
      enabled: true, allowedModels: [], byMainModel: { 'a/b': [CODEX] },
    })
    expect(mergePreferenceOverrides(PREFERENCE, { byMainModel: { 'a/b': [CODEX] } })).toEqual({
      enabled: true, allowedModels: [GEMINI, OPUS], byMainModel: { 'a/b': [CODEX] },
    })
  })

  it('filters upstream provider and model lines that this Session does not authorize', () => {
    const providerList = [
      'minimax-code — MiniMax Code',
      'codex-chatgpt — ChatGPT Subscription',
      'antigravity — Antigravity',
    ].join('\n')
    const filteredProviders = enrichListSubagentModelsOutput(providerList, [CODEX])
    expect(filteredProviders).toContain('codex-chatgpt — ChatGPT Subscription')
    expect(filteredProviders).not.toContain('minimax-code — MiniMax Code')
    expect(filteredProviders).not.toContain('antigravity — Antigravity')
    expect(filteredProviders).toContain('codex-chatgpt/gpt-6-astra -> provider: "codex-chatgpt", model: "gpt-6-astra"')

    const modelList = 'codex-chatgpt/gpt-6-astra — GPT-6 Astra\ncodex-chatgpt/gpt-5.6-sol — GPT-5.6 Sol\nminimax-code/MiniMax-M3.1-Flash — MiniMax'
    const filteredModels = enrichListSubagentModelsOutput(modelList, [CODEX])
    expect(filteredModels).toContain('codex-chatgpt/gpt-6-astra — GPT-6 Astra')
    expect(filteredModels).not.toContain('gpt-5.6-sol')
    expect(filteredModels).not.toContain('minimax-code/MiniMax-M3.1-Flash')

    // Everything filtered out still says something true instead of nothing.
    expect(enrichListSubagentModelsOutput('minimax-code — MiniMax Code', [CODEX])).toContain('(no LLM providers)')
    expect(enrichListSubagentModelsOutput('minimax-code/MiniMax-M3.1-Flash — MiniMax', [CODEX]))
      .toContain('(no advertised models for minimax-code)')
    // A reasoning-efforts block is detail the call asked for, never filtered.
    const withEfforts = 'codex-chatgpt/gpt-6-astra — GPT-6 Astra\nReasoning efforts:\n- high\n- low'
    expect(filterListSubagentModelsOutput(withEfforts, [CODEX])).toBe(withEfforts)
    // Text that matches neither rendering is passed through untouched.
    expect(filterListSubagentModelsOutput('Nothing here.', [CODEX])).toBe('Nothing here.')
    // An unrestricted Session filters nothing at all.
    expect(filterListSubagentModelsOutput(providerList, [])).toBe(providerList)
  })
})

describe('route-parameter adaptivity', () => {
  const undeclared = () => false
  const declared = () => true
  const unanswerable = () => undefined

  it('enforces the inherited route instead of demanding a parameter the tool lacks', () => {
    const reason = delegationDenialReason(
      recordingAgent([GEMINI, OPUS]), 'subagent', {}, PREFERENCE, NO_SESSIONS, ['subagent'], 'session', [], undeclared,
    )
    expect(reason).toContain('keeps its child on')
    expect(reason).toContain('deepseek-official/deepseek-flash')
    expect(reason).not.toContain('requires an explicit child model')
  })

  it('lets a parameterless delegation through when the inherited route is authorized', () => {
    const agent = recordingAgent([GEMINI, OPUS], { provider: 'antigravity', model: 'gemini-3.8-flash' })
    expect(delegationDenialReason(
      agent, 'subagent', {}, PREFERENCE, NO_SESSIONS, ['subagent'], 'session', [], undeclared,
    )).toBeUndefined()
  })

  it('authorizes a complete pair even when the probe says the tool has no parameters', () => {
    // A false probe answer must never make an explicit dispatch impossible to
    // satisfy: the pair is still judged against the allowlist, and an
    // unauthorized one is refused for THAT reason rather than for its shape.
    const agent = recordingAgent([GEMINI, OPUS])
    expect(delegationDenialReason(
      agent, 'subagent', { provider: 'antigravity', model: 'gemini-3.8-flash' },
      PREFERENCE, NO_SESSIONS, ['subagent'], 'session', [], undeclared,
    )).toBeUndefined()
    expect(delegationDenialReason(
      agent, 'subagent', { provider: 'minimax-code', model: 'MiniMax-M3.1-Flash' },
      PREFERENCE, NO_SESSIONS, ['subagent'], 'session', [], undeclared,
    )).toContain('is not on the Session allowlist')
    // A half-named route still gets the diagnostic that names the real problem.
    const partial = delegationDenialReason(
      agent, 'subagent', { provider: 'antigravity' }, PREFERENCE, NO_SESSIONS, ['subagent'], 'session', [], undeclared,
    )
    expect(partial).toContain('exposes no provider/model parameter')
    expect(partial).not.toContain('requires an explicit child model')
  })

  it('keeps the configured mode when the registry cannot answer', () => {
    const agent = recordingAgent([GEMINI, OPUS])
    for (const probe of [unanswerable, declared]) {
      expect(delegationDenialReason(
        agent, 'subagent', {}, PREFERENCE, NO_SESSIONS, ['subagent'], 'session', [], probe,
      )).toContain('requires an explicit child model')
    }
  })

  it('reads the live parameter table through the tools registry', () => {
    // The registry serves the model-facing JSON Schema, so the argument names sit
    // under `properties`. A probe that read the parameter object directly would
    // answer `false` for every real tool and deny each explicit dispatch, which is
    // exactly the regression this shape guards.
    const withRoutes = routeParameterProbe({ tools: { definitions: () => [
      { name: 'subagent', parameters: { type: 'object', properties: { provider: {}, model: {}, prompt: {} } } },
    ] } } as never)
    expect(withRoutes?.({}, 'subagent')).toBe(true)

    // A definition that flattens the names onto the parameter object is still read.
    const flattened = routeParameterProbe({ tools: { definitions: () => [
      { name: 'subagent', parameters: { provider: {}, model: {}, prompt: {} } },
    ] } } as never)
    expect(flattened?.({}, 'subagent')).toBe(true)

    const withoutRoutes = routeParameterProbe({ tools: { definitions: () => [
      { name: 'subagent', parameters: { type: 'object', properties: { prompt: {}, description: {} } } },
    ] } } as never)
    expect(withoutRoutes?.({}, 'subagent')).toBe(false)
    expect(withoutRoutes?.({}, 'absent')).toBeUndefined()

    expect(routeParameterProbe({} as never)).toBeUndefined()
    expect(routeParameterProbe({ tools: {} } as never)).toBeUndefined()
    const throwing = routeParameterProbe({ tools: { definitions: () => { throw new Error('no scope') } } } as never)
    expect(throwing?.({}, 'subagent')).toBeUndefined()
  })
})

