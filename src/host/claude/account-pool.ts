/**
 * The Claude subscription line's account pool.
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF ACCOUNT, AND ONLY ONE OF THEM MAY BE REFRESHED
 * ---------------------------------------------------------------------------
 *
 * A row in this pool is one of:
 *
 * - **managed** — signed in through this plugin. Its credential lives in the
 *   pool's encrypted storage AND in the pre-pool credential document beside it,
 *   it is refreshable, and deleting it is this plugin's business.
 * - **adopted** — a SNAPSHOT read out of a local Claude Code sign-in by
 *   'adopt.ts' (marker 'adopted: true', source 'claude-code'). It is used only
 *   while its own access token is still valid.
 *
 * An adopted snapshot is NEVER refreshed, and the reason is not an optimisation:
 * Claude Code's refresh token ROTATES. Every refresh consumes the stored token
 * and issues a new one, so two processes refreshing the same grant invalidate
 * each other — whoever loses the race holds a token the server has already
 * retired, and the user ends up signed OUT of Claude Code by this plugin's good
 * intentions. An in-process single-flight cannot fix that, because the race is
 * across PROCESSES: this plugin and Claude Code are separate programs, and the
 * only shared state between them is a file that 'adopt.ts' must never write.
 * Once such a snapshot is expired the pool takes it out of rotation and
 * surfaces ADOPTED_CREDENTIAL_EXPIRED_HINT — sign in again in CLAUDE CODE and
 * re-import, not here.
 *
 * The rule is enforced twice on purpose:
 *
 * 1. {@link claudeNeedsRefresh} returns false for an adopted credential no
 *    matter what its expiry says, so neither the routing path nor the auxiliary
 *    credential path ever reaches for a refresh.
 * 2. the refresh hook itself refuses one ({@link ClaudeAdoptedCredentialError}),
 *    so a future caller that forgets rule 1 fails loudly instead of silently
 *    spending a grant that is not ours to spend.
 *
 * ---------------------------------------------------------------------------
 * ONE ACCOUNT, ONE KEY
 * ---------------------------------------------------------------------------
 *
 * 'token-store.ts' keys a stored account by an immutable internalId
 * ('cl_' + 20 hex) and keeps identity aliases ('uuid:..', 'email:..',
 * 'seed:<sha256(refreshToken)>') as an APPEND-ONLY set hanging off it. This pool
 * adopts that same id rather than minting its own, and it resolves every
 * identity question THROUGH it:
 *
 * - {@link ClaudeAccountPool.recordIdFor} turns a credential's strongest alias
 *   into the owning record's internalId, never into an alias string and never
 *   into a token digest. Both the dedupeKey and the accountId hook return that
 *   id, so the pool and the credential document cannot drift into two key
 *   spaces — which is how ghost accounts appear: one account, two rows, one of
 *   them stale forever.
 * - 'seed:' aliases are LOOKUP keys only. A seed is a digest of a rotating
 *   token, so it is never returned, never stored as an account id, and never
 *   compared for equality between two credentials.
 *
 * The single accepted limitation is inherited from the store and restated here
 * so nobody has to rediscover it: a credential that states NEITHER a uuid NOR an
 * address has only its token seed as identity, so a re-login produces a
 * different seed and a second record. {@link ClaudeAccountPool.mergeAccounts} is
 * the remedy, and it is a deliberate user action rather than a guess.
 *
 * ---------------------------------------------------------------------------
 * THE DOCUMENT SEAM (why an adapter class exists here)
 * ---------------------------------------------------------------------------
 *
 * 'oauth.ts' signs in and refreshes against a minimal two-method store (read /
 * write of ONE credential), because that module deliberately knows nothing about
 * how accounts are laid out on disk. This line's store is
 * {@link FileCredentialStore} — a MULTI-account document. The bridge is
 * {@link ClaudeCredentialStoreAdapter}: it addresses exactly one record by
 * internalId on read and writes back into that record's own entry (through
 * saveAccount(credentials, { internalId }), which MERGES identity aliases
 * instead of replacing them). Every caller that needs the two-method surface —
 * the sign-in flow, and a later route that acts on one account — gets it from
 * {@link ClaudeAccountPool.credentialStoreFor}.
 *
 * The pool's own refresh deliberately calls 'oauth.ts''s refreshAccessToken
 * rather than its higher-level ensureAccessToken. That is not a shortcut: the
 * single-flight in ensureAccessToken is ONE MODULE-LEVEL PROMISE shared by every
 * caller in the process, so with a pool it would hand the second account the
 * first account's freshly rotated credential — and, through the adapter above,
 * write it into the second account's record. The pool therefore keeps its OWN
 * single-flight, per account (see the inFlight map), which preserves the property
 * the frozen module wanted (one rotation per expiry, no two callers spending the
 * same rotating token) without the cross-account contamination.
 *
 * ---------------------------------------------------------------------------
 * MANAGED WINS A CONFLICT
 * ---------------------------------------------------------------------------
 *
 * The same Claude account can reach the pool twice: as a plugin sign-in and as
 * an adopted snapshot. The two rows merge into one, and the MANAGED one wins the
 * refresh right — it is the only one that is allowed to refresh at all. When
 * they merge the adopted marker must NOT survive, because a surviving
 * 'adopted: true' would silently freeze the merged record out of refreshing
 * forever. That is why this class writes the marker (including its false case)
 * on EVERY account it creates, rather than only on the adopted ones: the core
 * merges a re-authorization as { ...existing, ...created }, so an omitted key
 * would leave the stored marker in place.
 */

import path from 'node:path'
import { dshHomeDir } from '../common/home.ts'
import {
  AccountPoolCore,
  normalizeRotationStrategy,
  type AccountPoolHooks,
  type PoolAccountShape,
  type PoolData,
} from '../common/account-pool.ts'
import type { CredentialStore } from '../token-store.ts'
import type { AccountAuthStatus, PoolAccountSummaryDto } from '../../shared/account-pool-contracts.ts'
import {
  FileCredentialStore,
  SUBSCRIPTION_INFERENCE_SCOPE,
  createInternalId,
  identityKeysFor,
  isSubscriptionCredential,
  mergeIdentityKeys,
  type ClaudeAccountRecord,
  type ClaudeCredentialDocument,
  type ClaudeCredentials,
} from './token-store.ts'
import {
  ClaudeUnauthorizedError,
  refreshAccessToken,
  type ClaudeTokenStore,
} from './oauth.ts'
import {
  ADOPTED_CREDENTIAL_EXPIRED_HINT,
  CLAUDE_CODE_CREDENTIAL_SOURCE,
  isAdoptedCredentialExpired,
} from './adopt.ts'
import { PROVIDER_ID, PROVIDER_NAME } from './types.ts'
import type { ClaudeFailure } from './client.ts'

/** Keychain / Secret Service service name of this line's pool. */
const KEYCHAIN_SERVICE = 'dsh-claude-pool'

/** Prefix of every alias 'token-store.ts' derives from a credential. */
const SEED_ALIAS_PREFIX = 'seed:'

/**
 * How early this pool refreshes, mirroring 'oauth.ts''s own REFRESH_MARGIN_MS.
 *
 * A mirror rather than an import because the frozen module keeps that constant
 * private, and this chunk's rule is to mirror the five-minute margin rather than
 * invent one. The consequence is stated rather than hidden: 'oauth.ts' ALREADY
 * subtracts the same five minutes when it stamps expiresAt, so a credential this
 * pool refreshes is refreshed roughly ten minutes ahead of the real expiry. That
 * direction is the safe one for this line — a refresh that arrives early costs
 * one rotation, while one that arrives late costs a 401 in the middle of a turn.
 */
export const CLAUDE_REFRESH_MARGIN_MS = 300_000

/**
 * Message raised when the pool holds no account at all.
 *
 * Word for word the string 'oauth.ts' raises when its store is empty, so a user
 * who reads either one is sent to the same place.
 */
export const CLAUDE_EMPTY_POOL_MESSAGE = 'Not signed in to Claude. Sign in from Settings > Claude.'

/**
 * Message for a credential that cannot reach /v1/messages at all.
 *
 * 'user:inference' is the scope that makes a token a SUBSCRIPTION credential;
 * without it the credential authenticates but is not entitled to the routes this
 * provider exists to serve, so the account is listed and refused rather than
 * retried.
 */
export function claudeNonSubscriptionReason(): string {
  return 'This Claude credential is not a subscription credential: it does not carry the '
    + SUBSCRIPTION_INFERENCE_SCOPE + ' scope. Sign in again from Settings > Claude.'
}

/**
 * Message raised if a refresh of a still-valid adopted snapshot were ever
 * attempted.
 *
 * Unreachable through this pool's own paths (see the module comment); it exists
 * because 'unreachable' is a claim the guard has to be able to make good on.
 */
export const ADOPTED_NEVER_REFRESHED_MESSAGE =
  'The sign-in imported from Claude Code is never refreshed by this plugin: Claude '
  + 'Code refreshes the same rotating token, and two refreshers would invalidate each '
  + 'other. Sign in again in Claude Code, then import the new sign-in from this settings card.'

// ---------------------------------------------------------------------------
// Credential shape carried by a pooled account
// ---------------------------------------------------------------------------

/**
 * The adoption markers, as they hang off a credential stored by this pool.
 *
 * FLATTENED onto the credential, unlike the snapshot 'adopt.ts' returns, which
 * nests the token under 'credentials'. Two reasons, both structural:
 *
 * - the pool's hooks (needsRefresh, refresh, authRejectedReason) receive the
 *   CREDENTIAL and never the account record, so the marker has to be reachable
 *   from there;
 * - every other field this line reads (expiresAt, accessToken) sits at the top
 *   level, and a second nesting level would mean two shapes for one account.
 *
 * The predicate is therefore {@link isAdoptedPoolCredential} rather than
 * 'adopt.ts''s own isAdoptedClaudeCredential, which additionally requires that
 * nested 'credentials' record and so answers false for this spelling. The FIELDS
 * it tests — adopted === true and source === 'claude-code' — are the same two,
 * and the source constant is imported from that module rather than re-typed.
 */
export interface ClaudeAdoptedCredentialMarkers {
  adopted?: true
  source?: string
  sourcePath?: string
}

/** One pooled credential: the stored credential, plus the markers above. */
export type ClaudePoolCredentials = ClaudeCredentials & ClaudeAdoptedCredentialMarkers

/** Where a pooled account's credential came from. */
export type ClaudePoolAccountSource = 'managed' | typeof CLAUDE_CODE_CREDENTIAL_SOURCE

/** One pooled Claude account: the credential plus the facts the card renders. */
export interface ClaudePoolAccount extends PoolAccountShape<ClaudeCredentials> {
  /**
   * Append-only alias set, mirroring the credential document's own.
   *
   * Kept on the row so a merge (or the explicit
   * {@link ClaudeAccountPool.mergeAccounts}) can carry an alias across instead of
   * losing the only handle a seed-only snapshot has.
   */
  identityKeys: string[]
  /** Which store owns the credential. Only managed rows may be refreshed. */
  source: ClaudePoolAccountSource
  /**
   * Whether this row is a borrowed snapshot.
   *
   * Required rather than optional: every construction site has to state it, which
   * is what keeps a stale true from surviving an in-place re-authorization.
   */
  adopted: boolean
  /** Claude Code file an adopted snapshot was read from; absent for managed rows. */
  sourcePath?: string
  /** Address the sign-in reported, when it reported one. */
  email?: string
  /** Subscription tier the exchange reported, verbatim ('max', 'pro', ...). */
  subscriptionType?: string
  /** Display form of {@link subscriptionType}; the card's plan badge. */
  planLabel?: string
}

/**
 * One account as the Claude settings card renders it.
 *
 * Declared here rather than under 'src/shared/': this slice is the pool's own
 * vocabulary, and a later chunk imports it from this module instead of growing a
 * second copy that drifts.
 */
export interface ClaudeAccountSummaryDto extends PoolAccountSummaryDto {
  /** Where the credential came from; a card offers different actions per source. */
  source?: ClaudePoolAccountSource
  /** Whether this row is a snapshot borrowed from a local Claude Code sign-in. */
  adopted?: boolean
  /** The Claude Code file an adopted snapshot was read from. */
  sourcePath?: string
  /** Subscription tier, from the credential itself. */
  subscriptionType?: string
}

/** Encrypted pool file this line owns; the credential document stays the mirror. */
export function claudePoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'claude-pool.json')
}

// ---------------------------------------------------------------------------
// Credential parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A trimmed, non-empty string, or nothing. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** The address a credential states, in either spelling the wire uses. */
function claudeEmailFor(credentials: Pick<ClaudeCredentials, 'account'>): string | undefined {
  const account = credentials.account
  // '??' alone would swallow an empty email_address instead of falling through,
  // which is the same trap 'token-store.ts' documents for its own derivation.
  return nonEmptyString(account?.email_address) ?? nonEmptyString(account?.emailAddress)
}

/** Name an account whose credential states nothing the user would recognize. */
function claudeAliasFor(credentials: ClaudeCredentials, position: number): string {
  return claudeEmailFor(credentials) ?? '账号 ' + position
}

/**
 * Parse one stored credential TOLERANTLY; null when the row cannot serve.
 *
 * Deliberately not 'token-store.ts''s parseClaudeCredentials, and the difference
 * is the point:
 *
 * - that parser is STRICT and refuses a credential with no 'user:inference'
 *   scope, which is right for the document it guards but would DELETE the row
 *   here. This pool has to be able to LIST a credential it refuses, so the
 *   refusal can be reported with a reason (see {@link claudeAuthRejectedReason})
 *   instead of the account silently vanishing from the card.
 * - an adopted snapshot states no scopes at all when Claude Code's document did
 *   not, and 'adopt.ts' refuses to invent them.
 *
 * What is still refused, because such a row could never serve a request: a
 * missing token, or an expiry that is not a finite number.
 */
export function parseClaudePoolCredentials(value: unknown): ClaudePoolCredentials | null {
  if (!isRecord(value)) return null
  const accessToken = nonEmptyString(value.accessToken)
  const refreshToken = nonEmptyString(value.refreshToken)
  if (accessToken === undefined || refreshToken === undefined) return null
  const expiresAt = value.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null

  const credentials: ClaudePoolCredentials = { accessToken, refreshToken, expiresAt }

  if (value.scopes !== undefined && value.scopes !== null) {
    // A scope set is a space-delimited list (RFC 6749) or an array; both are
    // accepted so the subscription test below cannot be defeated by encoding.
    const entries = typeof value.scopes === 'string' ? value.scopes.split(' ') : value.scopes
    if (Array.isArray(entries)) {
      const scopes: string[] = []
      for (const entry of entries) {
        const scope = nonEmptyString(entry)
        if (scope !== undefined) scopes.push(scope)
      }
      credentials.scopes = scopes
    }
  }

  const subscriptionType = nonEmptyString(value.subscriptionType)
  if (subscriptionType !== undefined) credentials.subscriptionType = subscriptionType

  if (isRecord(value.account)) {
    const uuid = nonEmptyString(value.account.uuid)
    const emailAddress = nonEmptyString(value.account.email_address)
    const emailCamel = nonEmptyString(value.account.emailAddress)
    if (uuid !== undefined || emailAddress !== undefined || emailCamel !== undefined) {
      credentials.account = {
        ...(uuid === undefined ? {} : { uuid }),
        ...(emailAddress === undefined ? {} : { email_address: emailAddress }),
        ...(emailCamel === undefined ? {} : { emailAddress: emailCamel }),
      }
    }
  }

  if (value.adopted === true && value.source === CLAUDE_CODE_CREDENTIAL_SOURCE) {
    credentials.adopted = true
    credentials.source = CLAUDE_CODE_CREDENTIAL_SOURCE
    const sourcePath = nonEmptyString(value.sourcePath)
    if (sourcePath !== undefined) credentials.sourcePath = sourcePath
  }

  return credentials
}

/**
 * Prefix of the id this pool gives a borrowed snapshot.
 *
 * A snapshot has no credential-document record, so there is no internalId to
 * adopt; the pool has to name it. The name is WHERE IT CAME FROM rather than a
 * digest of its tokens, and that choice is load-bearing: Claude Code refreshes
 * its own file, so a re-import of an unchanged sign-in carries a DIFFERENT
 * refresh token and therefore a different 'seed:' alias. Keying on the source
 * file is what makes "import it again after signing in again in Claude Code" an
 * UPDATE of the row the user already has, instead of a new row every time.
 *
 * The residual, stated rather than hidden: two accounts imported one after the
 * other from the SAME path are one row, because the row means 'the sign-in that
 * file currently holds' — which is exactly what a borrowed snapshot is. And a
 * snapshot whose route did not record a path at all shares the 'unstated' name
 * with any other such snapshot, so those collapse into one row too.
 */
export const ADOPTED_ACCOUNT_KEY_PREFIX = 'adopted:'

/** The pool's own name for a borrowed snapshot. Never a token digest. */
export function adoptedPoolAccountKey(credentials: ClaudeCredentials): string {
  const marker = credentials as ClaudePoolCredentials
  return ADOPTED_ACCOUNT_KEY_PREFIX + (nonEmptyString(marker.sourcePath) ?? 'unstated')
}

/**
 * Whether a pooled credential is an adopted snapshot.
 *
 * The two fields, and only those two: a plain credential has no 'adopted' field
 * and must never be mistaken for a snapshot, because treating a plugin-owned
 * account as disposable would refuse to refresh an account the user added here.
 */
export function isAdoptedPoolCredential(credentials: ClaudeCredentials): boolean {
  const marker = credentials as ClaudePoolCredentials
  return marker.adopted === true && marker.source === CLAUDE_CODE_CREDENTIAL_SOURCE
}

/**
 * Whether an adopted snapshot's access token is already unusable.
 *
 * 'adopt.ts''s own predicate, reached by handing it the shape it reads
 * ({ credentials }) — this pool keeps the token at the top level (see
 * {@link ClaudeAdoptedCredentialMarkers}), so the wrapper is the seam rather
 * than a second copy of the rule.
 */
function adoptedCredentialExpired(credentials: ClaudeCredentials): boolean {
  return isAdoptedCredentialExpired({ credentials })
}

/**
 * Whether a credential must be refreshed before the next request.
 *
 * FALSE for every adopted snapshot, valid or expired. That is this chunk's core
 * rule: an adopted credential is borrowed for exactly as long as Claude Code
 * vouched for it, and this pool has no business rotating a token another process
 * is rotating too. See the module comment.
 */
export function claudeNeedsRefresh(credentials: ClaudeCredentials, now: number): boolean {
  if (isAdoptedPoolCredential(credentials)) return false
  return credentials.expiresAt - now <= CLAUDE_REFRESH_MARGIN_MS
}

/**
 * Why a stored credential is already known to be unusable, or nothing.
 *
 * Reported purely — nothing is written here — and consulted by the core for both
 * routing eligibility and credential usability, which is what makes an expired
 * snapshot non-routable without a write on every read.
 *
 * Order matters: the expired-snapshot hint comes first because it is the
 * actionable one (the remedy is in Claude Code, not here).
 */
export function claudeAuthRejectedReason(credentials: ClaudeCredentials): string | undefined {
  if (isAdoptedPoolCredential(credentials)) {
    // The scope gate below is deliberately NOT applied to a borrowed snapshot,
    // and the reason is a fact about what adoption can know rather than a
    // concession: 'adopt.ts' refuses to invent scopes its document did not
    // state, so 'no scopes' here usually means 'we did not read them', not
    // 'this token is unentitled'. Applying the gate would make adoption useless
    // in exactly the case it exists for. The token is Claude Code's own; if the
    // account really is unentitled, the request gets a 403 and the account is
    // marked through the ordinary credential-failure path.
    return adoptedCredentialExpired(credentials) ? ADOPTED_CREDENTIAL_EXPIRED_HINT : undefined
  }
  if (!isSubscriptionCredential(credentials)) return claudeNonSubscriptionReason()
  return undefined
}

/** Validate and normalize one whole pool document. */
export function parseClaudePoolData(value: unknown): PoolData<ClaudePoolAccount> {
  if (!isRecord(value)) throw new Error('Claude pool payload is invalid')
  const accounts: ClaudePoolAccount[] = []
  for (const item of Array.isArray(value.accounts) ? value.accounts : []) {
    if (!isRecord(item)) continue
    if (typeof item.id !== 'string') continue
    // One unreadable row is dropped rather than failing the whole document: a
    // pool whose parse throws reports 'not signed in' for every account in it,
    // so a single damaged row would take the entire line offline.
    const credentials = parseClaudePoolCredentials(item.credentials)
    if (credentials === null) continue
    const adopted = isAdoptedPoolCredential(credentials)
    const account: ClaudePoolAccount = {
      id: item.id,
      alias: nonEmptyString(item.alias) ?? claudeAliasFor(credentials, accounts.length + 1),
      credentials,
      addedAt: typeof item.addedAt === 'number' && Number.isFinite(item.addedAt) ? item.addedAt : Date.now(),
      isPrimary: item.isPrimary === true,
      // Derived from the credential, never from the row: the credential is what
      // every refresh-related hook reads, so the two spellings of the marker
      // cannot disagree about one row.
      adopted,
      source: adopted ? CLAUDE_CODE_CREDENTIAL_SOURCE : 'managed',
      identityKeys: [],
    }
    const storedKeys = Array.isArray(item.identityKeys)
      ? item.identityKeys.filter((key): key is string => typeof key === 'string' && key !== '')
      : []
    account.identityKeys = mergeIdentityKeys(storedKeys, identityKeysFor(credentials))
    const email = nonEmptyString(item.email) ?? claudeEmailFor(credentials)
    if (email !== undefined) account.email = email
    const subscriptionType = nonEmptyString(item.subscriptionType) ?? credentials.subscriptionType
    if (subscriptionType !== undefined) {
      account.subscriptionType = subscriptionType
      account.planLabel = nonEmptyString(item.planLabel) ?? subscriptionType
    }
    const sourcePath = nonEmptyString(item.sourcePath)
    if (adopted && sourcePath !== undefined) account.sourcePath = sourcePath
    if (typeof item.lastUsedAt === 'number') account.lastUsedAt = item.lastUsedAt
    if (typeof item.cooldownUntil === 'number') account.cooldownUntil = item.cooldownUntil
    if (typeof item.cooldownReason === 'string') account.cooldownReason = item.cooldownReason
    if (item.authStatus === 'expired' || item.authStatus === 'invalid') account.authStatus = item.authStatus
    if (typeof item.authFailedReason === 'string') account.authFailedReason = item.authFailedReason
    accounts.push(account)
  }
  const result: PoolData<ClaudePoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(value.rotationStrategy),
    accounts,
  }
  if (typeof value.activeAccountId === 'string') result.activeAccountId = value.activeAccountId
  return result
}

/** Build a pool row from a record of the credential document. */
function poolAccountForRecord(record: ClaudeAccountRecord, isPrimary: boolean): ClaudePoolAccount {
  const credentials = record.credentials
  const account: ClaudePoolAccount = {
    id: record.internalId,
    alias: claudeAliasFor(credentials, 1),
    credentials,
    addedAt: Date.now(),
    isPrimary,
    // A document record is never an adopted snapshot: 'adopt.ts' snapshots are
    // borrowed, and this plugin's own document only ever holds its own sign-ins
    // (see the mirrorPrimary hook).
    adopted: false,
    source: 'managed',
    identityKeys: [...record.identityKeys],
  }
  const email = claudeEmailFor(credentials)
  if (email !== undefined) account.email = email
  if (credentials.subscriptionType !== undefined) {
    account.subscriptionType = credentials.subscriptionType
    account.planLabel = credentials.subscriptionType
  }
  return account
}

// ---------------------------------------------------------------------------
// The document seam
// ---------------------------------------------------------------------------

/**
 * The two-method credential store 'oauth.ts' wants, addressed at ONE account.
 *
 * See the module comment for why this bridge exists at all. The id is the
 * document's own immutable internalId, which is also the pool row's id, so a
 * refresh driven through here lands in the very record the pool lists — no
 * second key space.
 *
 * write goes through saveAccount(credentials, { internalId }) rather than
 * replacing the document, so the record keeps its append-only alias set and
 * whatever a later chunk hung on it. It does NOT special-case an adopted
 * snapshot: nothing in the pool ever asks this adapter to write one (the refresh
 * guard refuses first), and silently discarding a caller's write would be a
 * worse failure than the store's own strict validation.
 */
export class ClaudeCredentialStoreAdapter implements ClaudeTokenStore {
  constructor(
    private readonly store: FileCredentialStore,
    private readonly internalId: string,
  ) {}

  async read(): Promise<ClaudeCredentials | null> {
    const document = await this.store.read()
    if (document === null) return null
    const record = document.accounts.find((account) => account.internalId === this.internalId)
    return record === undefined ? null : record.credentials
  }

  async write(credentials: ClaudeCredentials): Promise<void> {
    await this.store.saveAccount(credentials, { internalId: this.internalId })
  }
}

// ---------------------------------------------------------------------------
// Rotation contract
// ---------------------------------------------------------------------------

/**
 * What the adapter must do with the account that produced a failed request.
 *
 * THE CONTRACT, and it is the adapter's to honour rather than this module's to
 * enforce:
 *
 * - switch accounts, or cool one down, ONLY for a CREDENTIAL failure or an
 *   ACCOUNT-SCOPED rate limit. Both are attributable to one account, so another
 *   account can plausibly serve the same request.
 * - NEVER rotate on a global rate limit, an overload (529), a server error, a
 *   transport failure, or a malformed request. None of them is any account's
 *   fault, and rotating would spend the whole pool against a wall every account
 *   is behind — while cooling accounts down would take the line offline with a
 *   cooldown nobody earned.
 *
 * The rule is NOT re-derived here: 'client.ts' classifyFailure already answers
 * it, and ClaudeFailure.accountScoped is precisely 'this is THIS account's own
 * spent window' (true only for rate_limit_account, and a 429 carrying no unified
 * rate-limit header is deliberately classified GLOBAL). The helper below is that
 * flag applied to a decision, so the adapter has one place to ask.
 */
export type ClaudeAccountRotationAction =
  | { action: 'mark-auth-failed'; status: AccountAuthStatus }
  | { action: 'cool-down'; durationMs: number }
  | { action: 'none' }

/**
 * Fallback cooldown for an account-scoped 429 that named no retry-after.
 *
 * Fifteen minutes mirrors the core's own assumption in its all-unavailable
 * message, so a pool that falls back computes the wait a user would have been
 * shown anyway.
 */
export const CLAUDE_DEFAULT_COOLDOWN_MS = 900_000

/**
 * The rotation decision for one classified failure.
 *
 * @param failure - a 'client.ts' ClaudeFailure, or the three fields of one.
 */
export function claudeAccountRotationAction(
  failure: Pick<ClaudeFailure, 'kind' | 'accountScoped' | 'retryAfterMs'>,
  options: { fallbackCooldownMs?: number } = {},
): ClaudeAccountRotationAction {
  // A rejected credential is that account's problem alone: mark it — the row is
  // kept, since signing in again is what restores it — and let the next account
  // serve the request.
  if (failure.kind === 'credential') return { action: 'mark-auth-failed', status: 'expired' }
  if (failure.accountScoped) {
    return {
      action: 'cool-down',
      durationMs: failure.retryAfterMs ?? options.fallbackCooldownMs ?? CLAUDE_DEFAULT_COOLDOWN_MS,
    }
  }
  // Global rate limit, overload, server, network, request: nothing here is
  // attributable to an account, so the pool keeps the account it has.
  return { action: 'none' }
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

/** Raised when a refresh of an adopted snapshot is attempted. Never a 401. */
export class ClaudeAdoptedCredentialError extends ClaudeUnauthorizedError {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeAdoptedCredentialError'
  }
}

export interface ClaudeAccountPoolOptions {
  /** Pre-pool credential document the pool mirrors its accounts into. */
  store?: FileCredentialStore
  /** Test seam; production builds the platform backend from the pool path. */
  backend?: CredentialStore<PoolData<ClaudePoolAccount>>
  /** Accounts this pool accepts; defaults to the core's limit. */
  maxAccounts?: number
  /** The account the card pinned, or null for automatic selection. */
  preferAccountId?: () => string | null
  /**
   * Test seam for the token exchange itself.
   *
   * Replacing it does NOT bypass the adopted guard or the per-account
   * single-flight above it, and the document write-back still happens: the seam
   * is the network call, not the policy.
   */
  refreshCredentials?: (credentials: ClaudeCredentials, fetchFn: typeof fetch) => Promise<ClaudeCredentials>
}

/**
 * Refresh one managed credential through 'oauth.ts''s own refresh path.
 *
 * The merge below mirrors what 'oauth.ts' does inside ensureAccessToken (that
 * code is private, and its single-flight is process-wide — see the module
 * comment for why this pool cannot use that function). Two fields are KEPT when
 * the response omits them, and both are correctness rather than politeness:
 *
 * - the refresh token, because a rotation endpoint that answers without one
 *   means 'keep the one you have'; storing an empty string would make an
 *   otherwise healthy account unusable.
 * - the scopes, because dropping 'user:inference' would turn the credential into
 *   one the routing check refuses, i.e. the row would go non-routable right
 *   after a successful refresh.
 */
async function refreshClaudeCredential(
  credentials: ClaudeCredentials,
  fetchFn: typeof fetch,
): Promise<ClaudeCredentials> {
  const token = await refreshAccessToken(credentials.refreshToken, { fetchFn })
  const next = token.account
  const current = credentials.account
  const uuid = next.uuid ?? current?.uuid
  const emailAddress = next.email_address ?? current?.email_address
  const emailCamel = next.emailAddress ?? current?.emailAddress
  const account = {
    ...(uuid === undefined ? {} : { uuid }),
    ...(emailAddress === undefined ? {} : { email_address: emailAddress }),
    ...(emailCamel === undefined ? {} : { emailAddress: emailCamel }),
  }
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken === '' ? credentials.refreshToken : token.refreshToken,
    expiresAt: token.expiresAt,
    scopes: token.scopes.length > 0 ? token.scopes : (credentials.scopes ?? []),
    ...(credentials.subscriptionType === undefined ? {} : { subscriptionType: credentials.subscriptionType }),
    ...(Object.keys(account).length === 0 ? {} : { account }),
  }
}

/**
 * The Claude subscription account pool.
 *
 * Read the module comment first: it carries the two rules this class exists to
 * enforce — an adopted snapshot is never refreshed, and one account has one key
 * — together with the reasoning behind both.
 */
export class ClaudeAccountPool extends AccountPoolCore<
  ClaudeCredentials,
  ClaudePoolAccount,
  ClaudeAccountSummaryDto
> {
  private readonly store: FileCredentialStore
  private readonly refreshSeam: (credentials: ClaudeCredentials, fetchFn: typeof fetch) => Promise<ClaudeCredentials>
  /**
   * Identity alias -> internalId of the record that owns it.
   *
   * Rebuilt from the pool's own rows on every {@link read}, and additionally fed
   * by {@link addAccount} from the credential document, which is what lets an
   * incoming credential be resolved to an existing record BEFORE the core has to
   * decide whether this is a new account.
   *
   * Entries are never pruned, deliberately. Dropping a live row's alias would
   * make the very next credential for that account look new, which is the ghost
   * row this index exists to prevent; a stale entry is overwritten by the next
   * {@link read}, because a live row always re-indexes its own aliases.
   */
  private readonly recordIds = new Map<string, string>()
  /**
   * One in-flight refresh per account.
   *
   * The refresh token rotates, so two concurrent callers refreshing one account
   * would spend it twice: the second exchange carries a token the first already
   * rotated away, the endpoint answers with a final verdict, and the account is
   * marked expired immediately after a refresh that in fact succeeded. Keyed by
   * the record's id — never by a token — so it cannot mix two accounts up.
   */
  private readonly inFlight = new Map<string, Promise<ClaudeCredentials>>()

  constructor(options: ClaudeAccountPoolOptions = {}) {
    const store = options.store ?? new FileCredentialStore()
    const refreshSeam = options.refreshCredentials
      ?? ((credentials: ClaudeCredentials, fetchFn: typeof fetch) => refreshClaudeCredential(credentials, fetchFn))
    const hooks: AccountPoolHooks<ClaudeCredentials, ClaudePoolAccount, ClaudeAccountSummaryDto> = {
      providerId: PROVIDER_ID,
      displayName: PROVIDER_NAME,
      poolFile: claudePoolPath(),
      keychainService: KEYCHAIN_SERVICE,
      parsePoolData: parseClaudePoolData,

      // ---- identity: always the record's immutable internalId -------------
      //
      // What is NOT used here, in either hook, is a token or a digest of one.
      // The refresh token rotates on every refresh, so keying on it would mint a
      // new account per refresh — the ghost row the two-layer identity design
      // exists to remove. A 'seed:' alias IS such a digest, so this pool consults
      // one only as a LOOKUP into its own index, never returns it, and never
      // compares two of them for equality.
      //
      // dedupeKey answers with a record id where it can, which is what makes two
      // ACTIVE and one REFRESHED credential one row. It has one extra answer
      // available to it, though, because the core refuses to update an account it
      // cannot key: a borrowed snapshot is additionally filed under its SOURCE
      // FILE (see poolKeyFor). Without that, every re-import — which the expiry
      // hint explicitly tells the user to perform, and which always arrives with
      // a rotated token and therefore a new seed — would add a row.
      dedupeKey: (credentials) => this.poolKeyFor(credentials),
      // NOT poolKeyFor, deliberately. A dedupe key may be a source-file name,
      // while an ACCOUNT ID must be something the settings document can pin and
      // the credential document can address by. Every path into the core seeds
      // this index with the real id first (see addAccount and addAdoptedAccount),
      // so this answers with one — and answers nothing, rather than something
      // unusable, if it somehow has none.
      accountId: (credentials) => this.recordIdsFor(credentials),
      defaultAlias: (credentials, position) => claudeAliasFor(credentials, position),
      createAccount: ({ id, alias, credentials, addedAt, isPrimary, existing }) => {
        const adopted = isAdoptedPoolCredential(credentials)
        const account: ClaudePoolAccount = {
          id,
          alias,
          credentials,
          // A re-authorization must not reorder the user's list.
          addedAt: existing === undefined ? addedAt : Math.min(existing.addedAt, addedAt),
          isPrimary,
          // Written on EVERY path, including the false one. The core merges a
          // re-authorization as { ...existing, ...created }, so an omitted key
          // would leave a stored 'adopted: true' — and its never-refresh
          // consequence — on a record that is now plugin-owned.
          adopted,
          source: adopted ? CLAUDE_CODE_CREDENTIAL_SOURCE : 'managed',
          // Append-only, exactly like the document's own set: an alias the row
          // already learned must survive a re-login that no longer states it.
          identityKeys: mergeIdentityKeys(existing?.identityKeys ?? [], identityKeysFor(credentials)),
        }
        if (adopted) {
          const marker = credentials as ClaudePoolCredentials
          if (marker.sourcePath !== undefined) account.sourcePath = marker.sourcePath
        }
        const email = claudeEmailFor(credentials)
        if (email !== undefined) account.email = email
        if (credentials.subscriptionType !== undefined) {
          account.subscriptionType = credentials.subscriptionType
          account.planLabel = credentials.subscriptionType
        }
        return account
      },

      // ---- lifetime -------------------------------------------------------
      expiresAt: (credentials) => credentials.expiresAt,
      needsRefresh: (credentials, now) => claudeNeedsRefresh(credentials, now),
      refresh: (credentials, fetchFn) => this.refreshCredentials(credentials, fetchFn),
      // A refresh the service calls final takes that account out of rotation; a
      // transient refresh failure leaves it in place. The adopted guard's error
      // is a subclass, so it lands in the same bucket.
      refreshFailureStatus: (error) => (error instanceof ClaudeUnauthorizedError ? 'expired' : undefined),
      // Pure check — nothing is written — and the reason a borrowed snapshot
      // that has aged out is refused without a refresh ever being attempted.
      authRejectedReason: (credentials) => claudeAuthRejectedReason(credentials),

      // ---- the pre-pool credential document --------------------------------
      //
      // Projecting it keeps an existing sign-in working with no migration step,
      // and it projects the record's OWN internalId as the account id, so the
      // pool row and the document record are addressable by one value from the
      // very first read.
      legacyAccount: async () => {
        const document = await store.read()
        const record = document?.accounts[0]
        if (record === undefined) return null
        return poolAccountForRecord(record, true)
      },
      mirrorPrimary: async (credentials) => {
        if (credentials === null) {
          // The pool is empty, so this plugin is signed out of every account it
          // owns. Clearing the document is required rather than tidy: the
          // projection above would otherwise resurrect a just-deleted account on
          // the very next read.
          await store.delete()
          return
        }
        // A borrowed snapshot is NEVER copied into this plugin's own document. It
        // is not this plugin's sign-in to keep, and writing it here would make
        // the pre-pool projection serve a Claude Code snapshot as if the user had
        // signed in through this line.
        if (isAdoptedPoolCredential(credentials)) return
        const id = await this.recordIdFor(credentials)
        await store.saveAccount(credentials, id === undefined ? {} : { internalId: id })
      },

      // ---- card -----------------------------------------------------------
      extendSummary: (account, base) => {
        const credentials = account.credentials
        const email = account.email ?? claudeEmailFor(credentials)
        const subscriptionType = account.subscriptionType ?? credentials.subscriptionType
        const adopted = account.adopted === true
        // LIVE, not stored: an adopted snapshot becomes unusable at its own
        // expiry instant, and persisting that would mean a write on every read.
        const expired = adopted && adoptedCredentialExpired(credentials)
        return {
          ...base,
          ...(email === undefined ? {} : { email }),
          ...(subscriptionType === undefined
            ? {}
            : { subscriptionType, planLabel: account.planLabel ?? subscriptionType }),
          adopted,
          source: account.source,
          // Deleting the row is the card's action for an account this plugin
          // owns. A borrowed snapshot is not this plugin's file to delete, so the
          // card offers its own remove-import action instead — the WorkBuddy
          // pool's precedent for accounts it did not sign in.
          removable: !adopted,
          ...(account.sourcePath === undefined ? {} : { sourcePath: account.sourcePath }),
          ...(expired
            ? { authStatus: 'expired' as AccountAuthStatus, authFailedReason: ADOPTED_CREDENTIAL_EXPIRED_HINT }
            : {}),
        }
      },
      emptyMessage: CLAUDE_EMPTY_POOL_MESSAGE,
      ...(options.preferAccountId === undefined ? {} : { preferAccountId: options.preferAccountId }),
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
    }
    super(hooks)
    this.store = store
    this.refreshSeam = refreshSeam
  }

  /** The credential document this pool mirrors into. */
  mirrorStore(): FileCredentialStore {
    return this.store
  }

  /**
   * The two-method store 'oauth.ts' needs, addressed at one account.
   *
   * The seam in one place: the sign-in flow (and any later route that acts on a
   * single account) never has to know the document layout.
   */
  credentialStoreFor(accountId: string): ClaudeTokenStore {
    return new ClaudeCredentialStoreAdapter(this.store, accountId)
  }

  /**
   * Read the pool, re-indexing the identity aliases on the way.
   *
   * Every routing decision goes through this method, so this is where the index
   * {@link recordIdsFor} reads is kept in step with the rows that actually exist.
   * See the recordIds field for why entries are not pruned.
   */
  override async read(): Promise<PoolData<ClaudePoolAccount>> {
    const data = await super.read()
    for (const account of data.accounts) this.indexAccount(account)
    return data
  }

  /**
   * Add or re-authorize one account.
   *
   * The override exists for ONE reason: the account's id must be the credential
   * document's internalId, and only this method can look that value up before
   * the core has decided whether the account is new. See the module comment's
   * 'one account, one key' section.
   */
  override async addAccount(credentials: ClaudeCredentials, alias?: string): Promise<ClaudePoolAccount> {
    // A read first, so an incoming credential for an account the pool ALREADY
    // holds resolves to that row's id.
    const data = await this.read()

    if (isAdoptedPoolCredential(credentials)) {
      return this.addAdoptedAccount(credentials, data, alias)
    }

    const knownId = await this.recordIdFor(credentials)

    // Managed: the credential document is the authority on the id. Writing it is
    // what makes the two stores agree, and it folds the credential into the
    // record the identity rules say it belongs to.
    //
    // THE DOCUMENT IS WRITTEN BEFORE the core decides on the row, for the same
    // reason as above and one more: the pool's dedupe key is the document's id,
    // so a managed credential for an account the pool has never seen has NO key
    // until this write gives it one. Skipping it would leave a managed sign-in
    // keyless, and every repeat of that sign-in a second row.
    //
    // A credential the document already holds — an adopted snapshot that was
    // signed in properly — resolves to THAT record's id and re-keys the row, so
    // one Claude account does not end up with two ids and, with them, two rows.
    // The document's parse refuses a credential that is not a subscription one
    // (no 'user:inference'), so a refusal here is reported rather than silently
    // producing a row that could never serve a request.
    const record = await this.store.saveAccount(credentials)
    this.indexRecord(record)

    if (knownId !== undefined && knownId !== record.internalId) {
      const row = data.accounts.find((account) => account.id === knownId)
      if (row !== undefined) {
        row.id = record.internalId
        // MANAGED BEATS ADOPTED, applied. The row this credential landed on was
        // a borrowed snapshot: it has to take the managed tokens and drop the
        // borrowed marker, or the account stays frozen out of refreshing — and,
        // just as important here, its dedupe key stays the snapshot's source file
        // rather than the id the core is about to look for, which is what would
        // turn this very re-key into a duplicate row.
        row.credentials = credentials
        row.adopted = false
        row.source = 'managed'
        delete row.sourcePath
        row.identityKeys = mergeIdentityKeys(row.identityKeys, record.identityKeys)
        if (data.activeAccountId === knownId) data.activeAccountId = record.internalId
        await this.write(data)
      }
    }

    return super.addAccount(credentials, alias)
  }

  /**
   * Add, or re-import, one borrowed Claude Code snapshot.
   *
   * A snapshot is never written into this plugin's credential document — it is
   * not this line's sign-in to keep — so its row is named by WHERE IT CAME FROM
   * (see {@link adoptedPoolAccountKey}) and there is nothing to reconcile with
   * the document.
   *
   * MANAGED BEATS ADOPTED, and this is where the two actually meet. A snapshot
   * resolves to an existing row through its token seed, which is how an account
   * imported here and then signed in through THIS plugin is recognized as one
   * account: the row it lands on is already plugin-owned, and overwriting it with
   * a borrowed credential would freeze that account until the snapshot expired —
   * silently, and for no reason the user could see. So the snapshot contributes
   * only what is new evidence (its aliases) and refuses to touch anything else.
   *
   * The id is resolved BEFORE the core is asked whether the account is already
   * pooled, because the core computes the dedupe key at the TOP of its own
   * addAccount: a key that only becomes known afterwards misses its one chance to
   * answer, and every repeated import would add a row.
   */
  private async addAdoptedAccount(
    credentials: ClaudeCredentials,
    data: PoolData<ClaudePoolAccount>,
    alias?: string,
  ): Promise<ClaudePoolAccount> {
    // Two ways this snapshot can already be pooled, and both have to be
    // consulted BEFORE the core decides anything: by identity (its seed, when
    // the file has not been refreshed since) and by SOURCE FILE (always, since
    // Claude Code refreshes its own file in place and a re-import therefore
    // arrives with a different refresh token and a different seed).
    const byIdentity = await this.recordIdFor(credentials)
    const sourceKey = adoptedPoolAccountKey(credentials)
    const candidateId = byIdentity ?? this.recordIds.get(sourceKey)
    const existing = candidateId === undefined
      ? undefined
      : data.accounts.find((account) => account.id === candidateId)

    if (existing !== undefined && existing.adopted !== true) {
      // A row this plugin owns. Overwriting it with a borrowed credential would
      // freeze the account until that snapshot expired, silently; so the
      // snapshot contributes only its aliases and the row stays refreshable.
      const before = existing.identityKeys.length
      existing.identityKeys = mergeIdentityKeys(existing.identityKeys, identityKeysFor(credentials))
      if (existing.identityKeys.length !== before) await this.write(data)
      return existing
    }

    if (candidateId === undefined) {
      // The store's OWN format, minted through the store's own public entry
      // point for it: a borrowed row has no credential-document record, so the
      // pool has to name it, and naming it anything other than a 'cl_' id would
      // make it unaddressable by the settings document later.
      //
      // Judgement call, stated: minting through 'createInternalId' rather than
      // through the store's protected 'createAccountId' (which the store's own
      // comment offers as the single minting seam) means a test that subclasses
      // FileCredentialStore to make ids deterministic will not cover ADOPTED
      // rows. That is the price of not touching the frozen module, and it costs
      // nothing functionally — ids are opaque either way.
      const minted = createInternalId()
      this.indexCredential(credentials, minted)
      this.recordIds.set(sourceKey, minted)
    } else {
      // Registered under the source file (or its seed): the core's dedupe hook
      // will answer with this id, and the core updates that row in place.
      this.recordIds.set(sourceKey, candidateId)
      this.indexCredential(credentials, candidateId)
    }
    return super.addAccount(credentials, alias)
  }

  /**
   * Merge two rows that are one account.
   *
   * This is the user's remedy for the identity limitation 'token-store.ts'
   * documents: a credential stating neither a uuid nor an address has only a
   * token digest to go on, so a re-login produces a second record, and nothing
   * can tell that apart from a genuinely different account. The same applies to
   * an imported snapshot, which Claude Code's document gives no identity to.
   *
   * THE MANAGED ROW WINS THE CREDENTIAL — by construction, not by argument
   * order. Only a plugin-owned credential may ever be refreshed, so a merge that
   * kept a snapshot's tokens would leave the account frozen until it expired, for
   * no reason the user could see. When BOTH rows are snapshots there is nothing
   * to promote and the marker survives; otherwise the merged record is
   * plugin-owned and refreshable again.
   *
   * The keeper's id, alias and ordering are kept, since those are what the
   * settings document pins and what the user recognizes.
   */
  async mergeAccounts(keepAccountId: string, dropAccountId: string): Promise<ClaudePoolAccount> {
    if (keepAccountId === dropAccountId) throw new Error('A Claude pool merge needs two different accounts.')
    const data = await this.read()
    const keep = data.accounts.find((account) => account.id === keepAccountId)
    const drop = data.accounts.find((account) => account.id === dropAccountId)
    if (keep === undefined || drop === undefined) {
      throw new Error('The Claude pool merge addressed an account the pool does not have.')
    }

    const bothAdopted = keep.adopted === true && drop.adopted === true
    // The managed row, when exactly one of the two is one.
    const winner = keep.adopted === true ? drop : keep
    const credentials = bothAdopted ? keep.credentials : winner.credentials
    const adopted = bothAdopted || isAdoptedPoolCredential(credentials)
    const routing = bothAdopted ? keep : winner

    const merged: ClaudePoolAccount = {
      ...(bothAdopted ? keep : winner),
      id: keep.id,
      alias: keep.alias,
      credentials,
      adopted,
      source: adopted ? CLAUDE_CODE_CREDENTIAL_SOURCE : 'managed',
      identityKeys: mergeIdentityKeys(
        mergeIdentityKeys(keep.identityKeys, drop.identityKeys),
        identityKeysFor(credentials),
      ),
      addedAt: Math.min(keep.addedAt, drop.addedAt),
      isPrimary: keep.isPrimary === true || drop.isPrimary === true,
    }
    const lastUsedAt = Math.max(keep.lastUsedAt ?? 0, drop.lastUsedAt ?? 0)
    if (lastUsedAt > 0) merged.lastUsedAt = lastUsedAt
    if (adopted) {
      const sourcePath = routing.sourcePath ?? keep.sourcePath ?? drop.sourcePath
      if (sourcePath !== undefined) merged.sourcePath = sourcePath
    } else {
      delete merged.sourcePath
    }
    const email = keep.email ?? drop.email ?? claudeEmailFor(credentials)
    if (email !== undefined) merged.email = email
    const subscriptionType = routing.subscriptionType ?? credentials.subscriptionType
    if (subscriptionType !== undefined) {
      merged.subscriptionType = subscriptionType
      merged.planLabel = routing.planLabel ?? subscriptionType
    }

    // Routing state follows the credential that survived: a cooldown or an auth
    // failure recorded against the discarded row describes a credential the
    // merged record no longer holds. This is what makes the merge a real repair
    // rather than a relabelling — an expired snapshot's authStatus must not keep
    // the refreshed managed credential out of rotation.
    delete merged.cooldownUntil
    delete merged.cooldownReason
    delete merged.authStatus
    delete merged.authFailedReason
    if (routing.cooldownUntil !== undefined) {
      merged.cooldownUntil = routing.cooldownUntil
      merged.cooldownReason = routing.cooldownReason
    }
    if (routing.authStatus !== undefined && routing.authStatus !== 'ok') {
      merged.authStatus = routing.authStatus
      merged.authFailedReason = routing.authFailedReason
    }

    // Fold the two rows into one, keeping the merged row where the keeper was.
    const index = data.accounts.findIndex((account) => account.id === keepAccountId)
    data.accounts[index] = merged
    data.accounts = data.accounts.filter((account) => account.id !== dropAccountId)
    if (data.activeAccountId === dropAccountId) data.activeAccountId = merged.id
    await this.write(data)
    if (merged.isPrimary) {
      void this.hooks.mirrorPrimary?.(merged.credentials).catch(() => undefined)
    }

    await this.reconcileMergedDocument(keep, drop, merged)
    return merged
  }

  /**
   * Fold two document records into the one the merged pool row points at.
   *
   * The alias sets are unioned rather than replaced, mirroring the document's own
   * append-only rule: the discarded record's aliases are the only handles a
   * seed-only credential has, and losing them would make the merged account
   * unrecognizable to its own next refresh.
   */
  private async reconcileMergedDocument(
    keep: ClaudePoolAccount,
    drop: ClaudePoolAccount,
    merged: ClaudePoolAccount,
  ): Promise<void> {
    if (keep.id === drop.id) return
    const document = await this.store.read()
    if (document === null) return
    const keepRecord = document.accounts.find((record) => record.internalId === keep.id)
    const dropRecord = document.accounts.find((record) => record.internalId === drop.id)
    const base = keepRecord ?? dropRecord
    // Neither row has a document record — the ordinary case when both were
    // imported snapshots — so there is nothing to reconcile.
    if (base === undefined) return
    const next: ClaudeCredentialDocument = {
      ...document,
      accounts: document.accounts
        .filter((record) => record.internalId !== drop.id)
        .map((record) => (record !== base ? record : {
          ...record,
          internalId: keep.id,
          identityKeys: mergeIdentityKeys(
            record.identityKeys,
            mergeIdentityKeys(keepRecord?.identityKeys ?? [], dropRecord?.identityKeys ?? []),
          ),
          // Never write a borrowed snapshot into this plugin's own document; the
          // managed credential is what the merged record holds when one exists.
          ...(isAdoptedPoolCredential(merged.credentials) ? {} : { credentials: merged.credentials }),
        })),
    }
    await this.store.write(next)
  }

  /**
   * Drop an imported snapshot from the pool.
   *
   * A separate action because {@link deleteAccount} refuses one: the row is a
   * borrowed snapshot, and a card must not destroy an account this plugin did
   * not create with the same button that deletes its own. This is what an
   * import card's 'remove import' calls; Claude Code's own file is touched by
   * neither path.
   */
  async removeImportedAccount(accountId: string): Promise<void> {
    const data = await this.read()
    const target = data.accounts.find((account) => account.id === accountId)
    if (target === undefined) return
    if (target.adopted !== true) {
      throw new Error('That account was signed in through this plugin; delete it instead of removing an import.')
    }
    // The core's own deletion, so primary/active/mirror handling stays in one
    // place.
    await super.deleteAccount(accountId)
  }

  /**
   * Delete one plugin-owned account.
   *
   * Refused for an imported snapshot, following the WorkBuddy pool's precedent
   * for accounts it did not sign in: the card offers
   * {@link removeImportedAccount} there instead. A managed account is removed
   * from the credential document as well, so the two stores cannot disagree
   * about which accounts exist — the pre-pool projection would otherwise hand
   * back a credential the user just deleted.
   */
  override async deleteAccount(accountId: string): Promise<void> {
    const data = await this.read()
    if (data.accounts.find((account) => account.id === accountId)?.adopted === true) {
      throw new Error('The sign-in imported from Claude Code is not an account this plugin owns; remove the import instead.')
    }
    await super.deleteAccount(accountId)
    // false for a row the document never held, which is not an error.
    await this.store.deleteAccount(accountId)
  }

  /**
   * The immutable id of the record that owns a credential, or nothing.
   *
   * Resolution order mirrors 'token-store.ts''s own identity rules, minus the
   * part that must never be a key: a strong alias ('uuid:..', 'email:..') is
   * looked up first, and the 'seed:' digest is consulted ONLY as a lookup, so a
   * credential stating no real identity still finds its record without the pool
   * ever keying an account on a rotating token.
   */
  private async recordIdFor(credentials: ClaudeCredentials): Promise<string | undefined> {
    const known = this.recordIdsFor(credentials)
    if (known !== undefined) return known
    // Nothing in this process's memory claims the credential. The credential
    // DOCUMENT is the authority that knows every sign-in this plugin has ever
    // stored, so it is consulted once, and what it knows is remembered — see
    // recordIds for why entries are never pruned.
    const document = await this.store.read()
    if (document === null) return undefined
    for (const record of document.accounts) this.indexRecord(record)
    return this.recordIdsFor(credentials)
  }

  /**
   * The key the pool files a credential under, or nothing.
   *
   * A MANAGED credential is named by the credential document's immutable
   * internalId, so the pool and the document agree on one key — and that value is
   * already known here, because a managed credential reaches this point only
   * after the document has stored it and handed its id back.
   *
   * A BORROWED SNAPSHOT has no document record, so it cannot be named by one. It
   * is named by its source file instead ({@link adoptedPoolAccountKey}), which is
   * a fact the credential always carries. Answering `undefined` here for a
   * snapshot would be fatal rather than cautious: the core treats `undefined` as
   * `no dedupe key`, so every import would land as a brand new row — including
   * the re-import this line's own instructions tell the user to perform after
   * signing in again in Claude Code.
   */
  private poolKeyFor(credentials: ClaudeCredentials): string | undefined {
    // Identity first, whichever kind of row it belongs to. A snapshot that DOES
    // state a uuid or an address is recognized as the account it names, which is
    // the only case in which a borrowed row and a plugin-owned one can be told to
    // be the same account without asking the user — see mergeAccounts for the
    // case where nothing states an identity at all.
    const identity = this.recordIdsFor(credentials)
    if (identity !== undefined) return identity
    if (isAdoptedPoolCredential(credentials)) return adoptedPoolAccountKey(credentials)
    return undefined
  }

  /**
   * The id this process already knows for a credential, or nothing.
   *
   * Resolution order mirrors 'token-store.ts''s own identity rules, minus the
   * part that must never be a key: a strong alias ('uuid:..', 'email:..') is
   * looked up first, and the 'seed:' digest is consulted ONLY as a lookup, so a
   * credential stating no real identity still finds its record without the pool
   * ever keying an account on a rotating token.
   */
  private recordIdsFor(credentials: ClaudeCredentials): string | undefined {
    const keys = identityKeysFor(credentials)
    for (const key of keys) {
      if (key.startsWith(SEED_ALIAS_PREFIX)) continue
      const id = this.recordIds.get(key)
      if (id !== undefined) return id
    }
    const seed = keys.find((key) => key.startsWith(SEED_ALIAS_PREFIX))
    return seed === undefined ? undefined : this.recordIds.get(seed)
  }

  private indexCredential(credentials: ClaudeCredentials, id: string): void {
    for (const key of identityKeysFor(credentials)) this.recordIds.set(key, id)
  }

  private indexRecord(record: ClaudeAccountRecord): void {
    for (const key of [...record.identityKeys, ...identityKeysFor(record.credentials)]) {
      this.recordIds.set(key, record.internalId)
    }
  }

  private indexAccount(account: ClaudePoolAccount): void {
    for (const key of [...account.identityKeys, ...identityKeysFor(account.credentials)]) {
      this.recordIds.set(key, account.id)
    }
    // The source-file name a borrowed snapshot is filed under. Indexed from the
    // ROW rather than only from a freshly seen credential, so that a snapshot
    // restored from the pool file — after a restart, say — is still recognized by
    // its own path.
    if (isAdoptedPoolCredential(account.credentials)) {
      this.recordIds.set(adoptedPoolAccountKey(account.credentials), account.id)
    }
  }

  /**
   * Refresh one account's credential, and nothing else.
   *
   * Two guards live here and both are load-bearing:
   *
   * 1. an adopted snapshot is refused outright (see the module comment);
   * 2. a second caller for the SAME account joins the first one's rotation
   *    instead of spending the rotating token twice.
   */
  private refreshCredentials(credentials: ClaudeCredentials, fetchFn: typeof fetch): Promise<ClaudeCredentials> {
    if (isAdoptedPoolCredential(credentials)) {
      return Promise.reject(new ClaudeAdoptedCredentialError(
        adoptedCredentialExpired(credentials) ? ADOPTED_CREDENTIAL_EXPIRED_HINT : ADOPTED_NEVER_REFRESHED_MESSAGE,
      ))
    }
    return this.singleFlightRefresh(credentials, fetchFn)
  }

  /**
   * The per-account single-flight, resolving the account's id first.
   *
   * Separated from the hook above only because resolving the id consults the
   * credential document, and a hook cannot await: the guard stays synchronous so
   * it can never be skipped by a caller that forgets to wait.
   */
  private async singleFlightRefresh(
    credentials: ClaudeCredentials,
    fetchFn: typeof fetch,
  ): Promise<ClaudeCredentials> {
    const key = await this.recordIdFor(credentials)
    if (key !== undefined) {
      const shared = this.inFlight.get(key)
      if (shared !== undefined) return shared
    }
    const pending = this.performRefresh(credentials, fetchFn)
    if (key !== undefined) {
      this.inFlight.set(key, pending)
      // Cleared on settle — including on failure, so a rejected refresh does not
      // wedge the account onto a promise that can never succeed again.
      void pending.then(() => undefined, () => undefined).then(() => {
        if (this.inFlight.get(key) === pending) this.inFlight.delete(key)
      })
    }
    return pending
  }

  /**
   * Rotate one managed credential and keep the credential document in step.
   *
   * The document write is what stops the pre-pool projection from handing out a
   * token the rotation has already spent. Its failure is swallowed on purpose:
   * the credential WAS refreshed, the pool's own record holds it, and a mirror
   * that could not be written must not fail a request that can still be served —
   * the same rule the core applies to its own bookkeeping writes.
   */
  private async performRefresh(credentials: ClaudeCredentials, fetchFn: typeof fetch): Promise<ClaudeCredentials> {
    const recordId = await this.recordIdFor(credentials)
    const refreshed = await this.refreshSeam(credentials, fetchFn)
    if (recordId !== undefined) {
      await new ClaudeCredentialStoreAdapter(this.store, recordId).write(refreshed).catch(() => undefined)
    }
    return refreshed
  }
}
