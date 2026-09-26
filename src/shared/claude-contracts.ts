/**
 * Wire contracts between the Claude subscription host routes and the browser
 * settings card. Everything here is public: NO CREDENTIAL EVER CROSSES THIS
 * BOUNDARY, and no shape below has a field a token could live in.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THIS FILE OBEYS, AND WHY IT IS NOT NEGOTIABLE
 * ---------------------------------------------------------------------------
 *
 * **Nothing in this file may resolve a module under 'src/host/'.** Not a value
 * import, not an `import type`, not an `export type … from`.
 *
 * This file is compiled by TWO projects with different worlds:
 *
 * - the host project ('tsconfig.host.json'): Node types, and 'src/host/**' in
 *   its include list;
 * - the client project ('tsconfig.client.json'): NO 'types' at all, and
 *   'src/host/**' deliberately absent from its include list.
 *
 * The second one is the constraint. A type-only import is ERASED for emit but
 * still RESOLVED for checking, so a single `import type` of
 * '../host/claude/account-pool.ts' from here pulls that whole subtree —
 * node:path, node:fs, node:http, node:crypto — into the client program. It does
 * not degrade quietly; it fails the build:
 *
 *   src/host/claude/account-pool.ts(104,18): error TS2307:
 *     Cannot find module 'node:path' or its corresponding type declarations.
 *   src/host/claude/account-pool.ts(105,28): error TS6307:
 *     File '…/src/host/common/home.ts' is not listed within the file list of
 *     project '…/tsconfig.client.json'.
 *
 * That was measured, not assumed: `npx tsc -p tsconfig.client.json` exits 0
 * with this file absent and exits 2 with a single type-only host re-export in
 * it. So the boundary is a property of the build, and this file is on the public
 * side of it.
 *
 * ---------------------------------------------------------------------------
 * THE TWO CONSEQUENCES, STATED PLAINLY RATHER THAN HIDDEN
 * ---------------------------------------------------------------------------
 *
 * 1. {@link ClaudeAccountSummaryDto} is DECLARED here rather than re-exported
 *    from 'src/host/claude/account-pool.ts', which is where the pool chunk put
 *    it. A re-export is what this file would prefer — and it is what the task
 *    asked for — but it cannot compile, for the reason above.
 *
 *    The drift that risks is closed from the OTHER side instead:
 *    'src/host/claude/routes.ts' imports BOTH declarations and carries a
 *    compile-time assertion that each is assignable to the other. Adding a field
 *    to the pool's copy without adding it here is therefore a build failure in
 *    `npx tsc -p tsconfig.host.json` — the same protection a re-export would
 *    have given, minus the impossible direction.
 *
 * 2. {@link CLAUDE_REASONING_EFFORTS} cannot be DERIVED from the catalog's
 *    ladders by an indexed access, for the same reason. It is a literal, and the
 *    equivalence between it and the catalog is asserted at the bottom of
 *    'src/host/claude/routes.ts' — against the real `CLAUDE_MODELS` table, in
 *    the project that can read it. Adding a level to a catalog ladder without
 *    adding it here stops the host typecheck, so the card cannot silently omit a
 *    level the wire would accept.
 *
 * Both assertions live in the host project because that is the only project that
 * can see both sides. Neither is documentation: each is a line of TypeScript
 * whose deletion is the only way to make it stop working.
 */

import type { AccountPoolStatusDto, AccountRotationStrategy, PoolAccountSummaryDto } from './account-pool-contracts.ts'

/**
 * How a model wants its thinking block shaped on the wire.
 *
 * Restated here rather than indexed off `ClaudeModelEntry` — see the module
 * comment. These four are not a quality ordering: 'mid-convo' and 'adaptive' are
 * different wire SHAPES, and the first is checked before every other branch
 * because a managed-effort model needs `block_binding` and `output_config`
 * or it answers with persistent 400s.
 *
 * The equivalence with the catalog's own `thinkingMode` field is asserted in
 * 'src/host/claude/routes.ts'.
 */
export type ClaudeThinkingMode = 'mid-convo' | 'adaptive' | 'budget' | 'none'

/**
 * Every thinking level this route can name, in escalating order.
 *
 * The union of the whole shipped catalog rather than one model's ladder: these
 * are WIRE effort values, already collapsed by the upstream reference mapping
 * the frozen catalog transcribes ('minimal' and 'low' both send 'low', so
 * offering both would advertise a distinction the wire cannot make). The card
 * offers them as default-effort choices and narrows the dropdown per model with
 * {@link ClaudeModelOption.reasoningEfforts}.
 *
 * 'off' is deliberately absent, exactly as it is from every ladder in the
 * catalog: turning thinking off is the ABSENCE of a thinking block rather than
 * an effort level, and whether a model permits it is stated separately in
 * {@link ClaudeModelOption.canDisableThinking}.
 *
 * NOT derived from the catalog by an indexed access — the client project cannot
 * read that module. The equivalence is asserted against the real table in
 * 'src/host/claude/routes.ts'; see the module comment.
 */
export const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** One selectable thinking level. */
export type ClaudeReasoningEffort = (typeof CLAUDE_REASONING_EFFORTS)[number]

/**
 * Whether a posted value is one of the levels this route can name.
 *
 * The membership test every settings route in this plugin performs against its
 * own constant, so a level no ladder carries is refused at the wire boundary
 * instead of being persisted and converged later.
 */
export function isClaudeReasoningEffort(value: unknown): value is ClaudeReasoningEffort {
  return typeof value === 'string' && (CLAUDE_REASONING_EFFORTS as readonly string[]).includes(value)
}

/** One model offered by the Claude subscription route. */
export interface ClaudeModelOption {
  id: string
  name: string
  /** Enabled models are the ones DSH offers in the conversation model picker. */
  enabled: boolean
  /** Context window this route assumes when the card saves no override. */
  defaultContextWindow: number
  /** Effective context window: the override when one is saved, else the default. */
  contextWindow: number
  /** Maximum output tokens this route requests when a caller omits one. */
  defaultMaxTokens: number
  /** Thinking levels this model exposes; empty for a model that takes none. */
  reasoningEfforts: string[]
  /**
   * Whether thinking can be turned off for this model.
   *
   * Reported because it is NOT derivable from {@link reasoningEfforts}: a model
   * the catalog maps `off: null` has a full ladder and still refuses to stop
   * thinking, and a card that offered the switch anyway would send a request the
   * wire rejects.
   */
  canDisableThinking: boolean
  /** Which thinking form this model needs; see {@link ClaudeThinkingMode}. */
  thinkingMode: ClaudeThinkingMode
  /** Whether the model accepts image input on this route. */
  supportsImage: boolean
  /** Whether the model accepts a `temperature` at all. */
  supportsTemperature: boolean
}

/**
 * One quota window, as the usage endpoint or the response headers stated it.
 *
 * The three numeric fields are null TOGETHER: null means "the source did not
 * say", which is a different statement from 0. A card that rendered null as 0
 * would show "nothing used" for a window nobody measured.
 */
export interface ClaudeQuotaWindow {
  /** Wire key: `five_hour`, `seven_day`, `seven_day_sonnet`. */
  id: string
  label: string
  /** Nominal length of the window in minutes, or null when unknown. */
  windowMinutes: number | null
  /** Fraction of the window consumed, 0-1. */
  usedFraction: number | null
  /** The same number as a percent, 0-100. */
  usedPercent: number | null
  /** Percent still available, 0-100. */
  remainingPercent: number | null
  /** ISO 8601 instant the window resets, or null. */
  resetsAt: string | null
  /** Which source these numbers came from, for the card's footnote. */
  source: 'usage' | 'headers'
}

/** One credit / usage meter the account carries beside its windows. */
export interface ClaudeMeter {
  id: string
  label: string
  /** Percent of the allowance consumed, 0-100. Null when the source said nothing. */
  usedPercent: number | null
  /** Percent still available, 0-100. Null when the source said nothing. */
  remainingPercent: number | null
  /** Monthly limit, in the account's own unit, when stated. */
  limit: number | null
  /** Amount consumed, in the same unit, when stated. */
  used: number | null
  /** Whether this meter is switched on for the account. */
  enabled: boolean
}

/** One point-in-time quota snapshot for the account the card displays. */
export interface ClaudeAccountQuota {
  /** Every window the account currently has, shortest first. */
  windows: ClaudeQuotaWindow[]
  /** Pay-as-you-go overage pool, when the account has one. */
  extraUsage: ClaudeMeter | null
  /** Unix milliseconds of the last successful FULL usage read; null if none. */
  fetchedAt: number | null
  /** Unix milliseconds of the most recent update from any source. */
  observedAt: number
  /** Unified rate-limit verdict the headers last reported, when they did. */
  status: string | null
  /** Window the headers last named as representative, when they did. */
  representativeClaim: string | null
}

/**
 * Account identity as the settings card renders it.
 *
 * There is no bearer field and no token: the identity this line can state from a
 * credential alone is exactly what the exchange reported — an address and a tier
 * — and everything else the card shows about WHO is signed in comes from the
 * account list.
 */
export interface ClaudeAccount {
  /** Address the sign-in reported, when it reported one. */
  email: string | null
  /** Subscription tier the exchange reported, verbatim ('max', 'pro', …). */
  subscriptionType: string | null
}

/**
 * One Claude account as the shared pool card renders it. Never carries a token.
 *
 * DECLARED here rather than re-exported from 'src/host/claude/account-pool.ts';
 * see the module comment for the measured reason. The two are kept identical by
 * the compile-time assertion in 'src/host/claude/routes.ts'.
 */
export interface ClaudeAccountSummaryDto extends PoolAccountSummaryDto {
  /** Where the credential came from; a card offers different actions per source. */
  source?: 'managed' | 'claude-code'
  /** Whether this row is a snapshot borrowed from a local Claude Code sign-in. */
  adopted?: boolean
  /** The Claude Code file an adopted snapshot was read from. */
  sourcePath?: string
  /** Subscription tier, from the credential itself. */
  subscriptionType?: string
}

/** Everything the settings card and the composer badge render. */
export interface ClaudeWebStatus extends Partial<AccountPoolStatusDto> {
  enabled?: boolean
  authenticated: boolean
  hasCredentials: boolean
  /** Storage description for this line's encrypted credential store. */
  storagePath: string
  /** Whether this plugin currently owns the provider route. */
  serving: boolean
  /** Diagnostic when another adapter family owns the provider route. */
  conflict: string | null
  /**
   * Whether a local Claude Code sign-in exists to offer for adoption.
   *
   * Answered by a stat and NOT by a read (see 'src/host/claude/adopt.ts'), so
   * the card can offer the import before anything has been read from the file.
   */
  claudeCodeSignInAvailable: boolean
  /** Paths the adoption reader consulted, whether or not each existed. */
  claudeCodePaths: string[]
  /** Account the displayed credential belongs to. */
  account: ClaudeAccount | null
  quota: ClaudeAccountQuota | null
  lastFetchedAt: number | null
  /**
   * Whether a quota refresh is running behind this answer.
   *
   * The card renders the snapshot it already had instead of waiting on the
   * upstream request; when this is true the client asks again shortly so the
   * refreshed snapshot reaches the UI.
   */
  quotaRefreshing?: boolean
  /** Why the last quota read failed, when it did. Reported BESIDE the snapshot. */
  quotaError?: string | null
  models: ClaudeModelOption[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: ClaudeReasoningEffort | null
  /** Account selected for catalog, quota and all requests; null means automatic. */
  selectedAccountId: string | null
  /** Signed-in accounts; empty or absent when no pool is installed. */
  accounts?: ClaudeAccountSummaryDto[]
  /** Account the next request would use. */
  activeAccountId?: string
  rotationStrategy?: AccountRotationStrategy
}

/** Patch accepted by the models/settings route. */
export interface ClaudeSettingsUpdateDto {
  enabled?: boolean
  enabledModelIds?: string[]
  /** A number sets an override for that model; `null` restores the default. */
  contextWindowOverrides?: Record<string, number | null>
  defaultReasoningEffort?: ClaudeReasoningEffort | null
  selectedAccountId?: string | null
}

/** One account-pool action the card can post. */
export type ClaudeAccountAction =
  | 'set-primary'
  | 'set-alias'
  | 'delete'
  | 'clear-cooldown'
  | 'clear-auth-failed'
  | 'relogin'
  | 'strategy'

/** Body accepted by the accounts route. */
export interface ClaudeAccountActionDto {
  action: ClaudeAccountAction
  accountId?: string
  alias?: string
  strategy?: AccountRotationStrategy
}

/**
 * Result of an explicit connection test.
 *
 * A failure is a VALUE rather than a thrown error, because the card's whole job
 * here is to render the reason: a probe that was refused is a fact about the
 * credential, not a failed request.
 */
export interface ClaudeConnectionDto {
  connected: boolean
  /** Model the probe asked for. */
  model: string
  /** Round-trip time of the probe request, in milliseconds. */
  latencyMs: number
  /** HTTP status the probe received; 0 when no response arrived at all. */
  status: number
  /** Why the probe did not connect, when it did not. */
  error: string | null
  /** Whether repeating the same probe could succeed. */
  retryable: boolean
  /** `stop_reason` of the one-token answer, when one arrived. */
  stopReason: string | null
  checkedAt: number
}

/**
 * Live state of the sign-in flow the card polls.
 *
 * This restates 'src/host/claude/oauth.ts''s `LoginFlowStatus` field for field,
 * and the restatement is deliberate rather than lazy: that object is serialized
 * straight into the HTTP response, and its own comment records that no secret
 * has a field to live in. Renaming a field here cannot leak anything — the host
 * serializes its own object — but it CAN make the card read a field the host
 * never sends, so the two are kept in step by eye and by the tests that drive
 * the real flow.
 */
export interface ClaudeLoginFlowDto {
  status: 'idle' | 'pending' | 'exchanging' | 'complete' | 'error'
  /** Correlates a status reading with the flow the user started. */
  flowId?: string
  /** Not a secret: it is the value that goes INTO the browser. */
  authUrl?: string
  mode?: 'manual' | 'loopback'
  /** Which redirect URI is armed, for the card to display. */
  redirectUri?: string
  hint?: string
  error?: string
  /** Why a loopback attempt degraded to manual. */
  fallbackReason?: string
  createdAt?: number
  completedAt?: number
}
