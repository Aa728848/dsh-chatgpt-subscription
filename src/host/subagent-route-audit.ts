/**
 * Post-hoc visibility for child routes the delegation guard cannot pre-empt.
 *
 * `subagentModelAuthorization` gates one model-authored tool call. Two whole
 * classes of child creation never pass through such a call, so no tool guard can
 * see them:
 *
 * - a delegation tool that exposes no route parameters and inherits the
 *   caller's route (`subagent_fork`);
 * - a subsystem that starts children itself without any delegation tool at all
 *   (`ralph`, the `workflow` engine, a plugin calling `ctx.subagents.start`).
 *
 * Every session-backed child still leaves two durable facts, which is enough to
 * reconstruct what actually ran:
 *
 * - the parent records one `subagent/catalog` event per continuable child, and
 *   the child's own session header names its `parentSession`;
 * - the child records one immutable `subagent/descriptor` whose
 *   `agentProvider`/`agentModel` are the resolved child route (absent when the
 *   child inherited the parent's route, which is the common case).
 *
 * This module folds those facts into an advisory list. It never blocks and never
 * mutates a session: its whole job is to make an unauthorized child route
 * visible instead of silent.
 * @module dsh-chatgpt-subscription/subagent-route-audit
 */

/** One record of a child session whose route is known. */
export interface ChildRouteFinding {
  /** The child session id. */
  readonly childId: string
  /** The parent session id, when the child's header names one. */
  readonly parentId?: string
  /** The `ctx.subagents` provider that established the child. */
  readonly provider?: string
  /** The child's own resolved provider, absent when it inherited the parent's. */
  readonly childProvider?: string
  /** The child's own resolved model, absent when it inherited the parent's. */
  readonly childModel?: string
  /** Short display label recorded with the descriptor. */
  readonly label?: string
}

/** One child that ran on a route the governing allowlist does not authorize. */
export interface RouteViolation {
  /** The child that ran on the unauthorized route. */
  readonly finding: ChildRouteFinding
  /**
   * The route the child actually ran on. For a route-preserving child this is
   * the parent's route, which is why the finding keeps both.
   */
  readonly route: { readonly provider?: string; readonly model?: string }
  /**
   * Whether the child's route equals its parent's current route.
   *
   * This is deliberately a comparison rather than a claim about which mechanism
   * chose the route. A forked child's descriptor DOES record the route it ran
   * on — the delegation seam stamps the parent's route into the child's options
   * — so a descriptor alone cannot prove whether the child inherited the route
   * or was handed it explicitly. Equality is the checkable fact, and it is the
   * one that decides whether re-delegating through an explicit tool would even
   * change anything.
   */
  readonly sameAsParent: boolean
}

/** One exact provider/model route authorized for children. */
export interface AuditedRoute {
  readonly provider: string
  readonly model: string
}

/** Minimal session view this fold reads: the header and the ordered event log. */
export interface AuditedSession {
  readonly id?: unknown
  readonly header?: {
    readonly parentSession?: unknown
    readonly origin?: unknown
  }
  readonly events?: readonly { readonly type?: unknown; readonly data?: unknown }[]
}

/** Session lookup used to resolve a child's parent for inherited-route attribution. */
export interface AuditedSessions {
  get(id: string): AuditedSession | undefined
}

/**
 * Read one field as a string.
 * @param value - Candidate value from a durable event or header.
 * @returns the string, or undefined for any other type.
 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read one field as a plain object.
 * @param value - Candidate value.
 * @returns the record, or undefined for arrays, null, and primitives.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Extract the child route a descriptor recorded.
 * @param data - `subagent/descriptor` payload.
 * @returns the declared route fields plus provider and label, each when present.
 */
export function readChildDescriptor(data: unknown): Omit<ChildRouteFinding, 'childId' | 'parentId'> | undefined {
  const record = asRecord(data)
  if (record === undefined) return undefined
  const provider = asString(record['provider'])
  const childProvider = asString(record['agentProvider'])
  const childModel = asString(record['agentModel'])
  const label = asString(record['label'])
  if (provider === undefined && childProvider === undefined && childModel === undefined) return undefined
  return {
    ...provider === undefined ? {} : { provider },
    ...childProvider === undefined ? {} : { childProvider },
    ...childModel === undefined ? {} : { childModel },
    ...label === undefined ? {} : { label },
  }
}

/**
 * Read the child-route allowlist a session recorded, from its own log.
 *
 * The live guard reads the same event through `policyRoutesOf`, which walks a
 * session's `eventAt` accessor. The audit holds a resolved session instead, so
 * it scans the snapshot it already has rather than reopening the log per child.
 * @param session - the session whose policy is read.
 * @returns the authorized routes, or undefined when the session recorded none.
 */
export function auditedRoutesOf(session: AuditedSession): AuditedRoute[] | undefined {
  for (const event of session.events ?? []) {
    if (event.type !== 'subagent/model-selection-policy') continue
    const allowed = asRecord(event.data)?.['allowedModels']
    if (!Array.isArray(allowed)) continue
    const routes: AuditedRoute[] = []
    for (const entry of allowed) {
      const provider = asString(asRecord(entry)?.['provider'])
      const model = asString(asRecord(entry)?.['model'])
      if (provider !== undefined && model !== undefined) routes.push({ provider, model })
    }
    if (routes.length > 0) return routes
  }
  return undefined
}

/**
 * Collect the child routes one parent session recorded.
 *
 * Discovery uses both durable signals because they cover different backends: a
 * `subagent/catalog` event names every continuable child the parent created,
 * while a descriptor-less or one-shot child is only reachable by scanning the
 * registry for a session whose header names this parent.
 * @param parent - the parent session to inspect.
 * @param sessions - registry used to resolve each child's own log and header.
 * @returns one finding per child whose route could be read.
 */
export function childRoutesOf(parent: AuditedSession, sessions: AuditedSessions): ChildRouteFinding[] {
  const parentId = asString(parent.id)
  const seen = new Set<string>()
  const findings: ChildRouteFinding[] = []

  const inspect = (child: AuditedSession | undefined, childId: string): void => {
    if (child === undefined || seen.has(childId)) return
    seen.add(childId)
    const descriptor = child.events
      ?.map(event => event.type === 'subagent/descriptor' ? readChildDescriptor(event.data) : undefined)
      .find(entry => entry !== undefined)
    if (descriptor === undefined) return
    const headerParent = asString(child.header?.parentSession)
    findings.push({
      childId,
      ...headerParent === undefined ? {} : { parentId: headerParent },
      ...descriptor,
    })
  }

  for (const event of parent.events ?? []) {
    if (event.type !== 'subagent/catalog') continue
    const childId = asString(asRecord(event.data)?.['childId'])
    if (childId === undefined) continue
    inspect(sessions.get(childId), childId)
  }
  if (parentId !== undefined) {
    // Registry sweep covers children that never wrote a catalog event (one-shot
    // runs) and children whose catalog event predates this fold's window.
    for (const child of listSessions(sessions)) {
      const childId = asString(child.id)
      if (childId === undefined || childId === parentId) continue
      if (asString(child.header?.parentSession) !== parentId) continue
      inspect(child, childId)
    }
  }
  return findings
}

/**
 * Enumerate the registry, tolerating a resolver that exposes no listing.
 * @param sessions - the resolver to enumerate.
 * @returns every session it can serve, or an empty array.
 */
function listSessions(sessions: AuditedSessions): AuditedSession[] {
  const list = (sessions as { list?(): unknown }).list
  if (typeof list !== 'function') return []
  try {
    const entries = list.call(sessions)
    return Array.isArray(entries) ? entries as AuditedSession[] : []
  } catch {
    return []
  }
}

/**
 * Read the route a session's next request would use: its latest request header,
 * else its declared creation options. A child that recorded no route of its own
 * runs here, and this is also the baseline a recorded child route is compared
 * against.
 * @param session - the session to read.
 * @returns the route fields, each absent when its source did not supply it.
 */
function sessionRouteOf(session: AuditedSession | undefined): RouteViolation['route'] {
  const header = asRecord((session as { requestHeader?(): unknown } | undefined)?.requestHeader?.())
  const config = asRecord(header?.['config'])
  const provider = asString(config?.['provider'])
  const model = asString(config?.['model'])
  if (provider !== undefined || model !== undefined) {
    return {
      ...provider === undefined ? {} : { provider },
      ...model === undefined ? {} : { model },
    }
  }
  const options = asRecord((session as { options?: unknown } | undefined)?.options)
  return {
    ...asString(options?.['provider']) === undefined ? {} : { provider: asString(options?.['provider']) },
    ...asString(options?.['model']) === undefined ? {} : { model: asString(options?.['model']) },
  }
}

/**
 * Resolve the route a finding actually ran on, following the parent when the
 * child recorded none, and report whether it matches the parent's.
 * @param finding - the child under audit.
 * @param sessions - registry used to resolve the parent.
 * @returns the effective route and whether it equals the parent's route.
 */
export function effectiveRouteOf(
  finding: ChildRouteFinding,
  sessions: AuditedSessions,
): RouteViolation['route'] & { sameAsParent: boolean } {
  const parentRoute = finding.parentId === undefined ? {} : sessionRouteOf(sessions.get(finding.parentId))
  const declared = finding.childProvider !== undefined || finding.childModel !== undefined
  const route = declared
    ? { provider: finding.childProvider, model: finding.childModel }
    : parentRoute
  return {
    ...route,
    // Equality needs a route on both sides. Two unresolved routes are unknown,
    // not equal, and saying otherwise would put a false claim in the report.
    sameAsParent: route.provider !== undefined && route.model !== undefined
      && parentRoute.provider === route.provider && parentRoute.model === route.model,
  }
}

/**
 * Decide whether one effective route is covered by an allowlist.
 * @param allowed - routes the governing Session authorized.
 * @param route - the route the child actually ran on.
 * @returns whether the route is authorized.
 */
function routeAllowed(
  allowed: readonly AuditedRoute[],
  route: RouteViolation['route'],
): boolean {
  if (route.provider === undefined || route.model === undefined) return true
  return allowed.some(entry => entry.provider === route.provider && entry.model === route.model)
}

/**
 * Fold one parent session's children into the violations worth reporting.
 * A finding with an unresolvable route is reported as neither: guessing would
 * turn this advisory list into a source of false accusations.
 * @param parent - the parent session to audit.
 * @param sessions - registry used to resolve children and parents.
 * @param allowed - routes the parent Session authorized, when it recorded any.
 * @returns violations, ordered as the children were discovered.
 */
export function auditChildRoutes(
  parent: AuditedSession,
  sessions: AuditedSessions,
  allowed: readonly AuditedRoute[] | undefined,
): RouteViolation[] {
  if (allowed === undefined || allowed.length === 0) return []
  const violations: RouteViolation[] = []
  for (const finding of childRoutesOf(parent, sessions)) {
    const effective = effectiveRouteOf(finding, sessions)
    if (routeAllowed(allowed, effective)) continue
    violations.push({
      finding,
      route: { provider: effective.provider, model: effective.model },
      sameAsParent: effective.sameAsParent,
    })
  }
  return violations
}

/**
 * Render one violation as a single model-facing line.
 * @param violation - the violation to describe.
 * @returns a one-line summary naming the child, its route, and its origin.
 */
export function violationText(violation: RouteViolation): string {
  const { finding, route, sameAsParent } = violation
  const label = finding.label === undefined ? '' : ` "${finding.label}"`
  const where = route.provider === undefined || route.model === undefined
    ? 'an unresolved route'
    : `${route.provider}/${route.model}`
  // Only the comparison is stated; which layer chose the route is not knowable
  // from the descriptor alone, so the text never asserts it.
  return `subagent ${finding.childId}${label} ran on ${where}`
    + `${sameAsParent ? ' — the same route as its parent' : ' — a route of its own'}`
    + `${finding.provider === undefined ? '' : ` (provider "${finding.provider}")`}`
}
