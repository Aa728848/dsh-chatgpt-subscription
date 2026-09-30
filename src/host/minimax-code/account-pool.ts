/**
 * MiniMax Code 号池：the account pool for the MiniMax Code (编程订阅) line.
 *
 * This is the second line in this package that pools a credential it does not
 * own (WorkBuddy was the first), and that one fact decides every shape below:
 *
 * 1. MiniMax Code's normal credential is the desktop application's own
 *    \`~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json\`. The plugin
 *    reads it so a user already signed in to the app never signs in twice, which
 *    is exactly the WorkBuddy precedent for the CodeBuddy client's \`*.info\`
 *    files.
 * 2. ADOPTED MEANS NEVER DESTROYED. That file belongs to an application the
 *    user is running. The pool may read it, may adopt it into its own account
 *    list, and may write a rotated token back through the store's atomic
 *    replacement — but no path in this file may revoke it or delete it. A
 *    deleted \`auth.json\` signs the user out of MiniMax Code itself, so such an
 *    account is reported as \`removable: false\` and deletion is refused
 *    ({@link MinimaxCodeAccountPool.deleteAccount}), mirroring WorkBuddy's
 *    desktop accounts.
 * 3. What the pool adds on top of the single-credential line is rotation: more
 *    than one sign-in can serve requests, a 429 cools one account down instead
 *    of taking the line offline, and the settings card can list, alias, promote
 *    and switch between them.
 *
 * The credential format stays the store's: this file never invents a field of
 * its own inside a token record, so a write back into the app's document keeps
 * the exact shape the app expects.
 */

import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import { dshHomeDir } from '../common/home.ts'
import {
  AccountPoolCore,
  normalizeRotationStrategy,
  type AccountPoolHooks,
  type PoolAccountShape,
  type PoolData,
} from '../common/account-pool.ts'
import { isSameOriginMutation } from '../common/same-origin.ts'
import type { CredentialStore } from '../token-store.ts'
import {
  MinimaxCodeCredentialStore,
  credentialIsFresh,
  credentialNeedsRefresh,
  minimaxCodeCredentialAdvancedPast,
  minimaxCodeSameCredentialSession,
  parseMinimaxCodeCredentials,
  rotateMinimaxCodeCredential,
  type MinimaxCodeCredentialSource,
  type MinimaxCodeCredentials,
} from './token-store.ts'
import {
  MinimaxCodeUnauthorizedError,
  isRefreshTokenRejected,
  refreshAccessToken,
} from './oauth.ts'
import { PROVIDER_ID, isRegion } from './types.ts'
import type { MinimaxCodeRegion } from '../../shared/minimax-code-contracts.ts'
import type {
  AccountAuthStatus,
  AccountRotationStrategy,
  PoolAccountSummaryDto,
} from '../../shared/account-pool-contracts.ts'

/**
 * One pooled MiniMax Code account.
 *
 * The credential travels whole (the pool persists it, and the store knows how to
 * write it back to the file it came from); everything else here is a non-secret
 * fact the settings card renders without a second round trip.
 */
export interface MinimaxCodePoolAccount extends PoolAccountShape<MinimaxCodeCredentials> {
  /** Region the credential was issued in; decides every host this account uses. */
  region: MinimaxCodeRegion
  /**
   * Which store owns the credential.
   *
   * \`minimax-native\` is MiniMax Code's own \`auth.json\`: adopted and renewed,
   * never deletable from here. \`file\` is the plugin's own store, written by a
   * device-code sign-in started in this plugin.
   */
  source: MinimaxCodeCredentialSource
  /** Display facts, when the credential's token claims carry them. */
  email?: string
  planName?: string
}

/** The pool slice the settings card renders, mirroring {@link AccountPoolStatusDto}. */
export interface MinimaxCodeAccountSummaryDto extends PoolAccountSummaryDto {
  region?: MinimaxCodeRegion
  source?: MinimaxCodeCredentialSource
  /** Credential generation; diagnostics for two-sided refresh contention with the app. */
  generation?: number
}

/**
 * Encrypted pool file this line owns.
 *
 * Separate from the credential file on purpose: the pool may hold several
 * accounts, while \`~/.minimax/auth\` holds exactly one session per region and is
 * the desktop app's to write.
 */
export function minimaxCodePoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'minimax-code-pool.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('MiniMax Code pool account field is invalid')
  return value
}

/**
 * Non-secret display facts the credential's own access token carries.
 *
 * The measured MiniMax access token is a JWT, and its claim set is the only
 * place an email address or a plan name could come from: the stored record
 * states tokens, an audience and a scope, and no account profile. Reading the
 * claims is therefore opportunistic and must never fail a request — a token that
 * is not a JWT, one that is truncated, or one whose payload is not JSON simply
 * contributes nothing.
 *
 * The decode is deliberately limited to an allowlist of display claims. An
 * access token is a credential: it is never logged, never returned to a browser
 * and never copied into the pool file. Only the few claim values the card
 * actually renders leave this function.
 */
function claimDisplayFacts(accessToken: string): { email?: string; planName?: string } {
  const segments = accessToken.split('.')
  if (segments.length !== 3) return {}
  const payload = segments[1]
  if (payload === undefined || payload === '') return {}
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
  } catch {
    return {}
  }
  if (!isRecord(claims)) return {}
  const str = (value: unknown): string | undefined => (
    typeof value === 'string' && value !== '' ? value : undefined
  )
  return {
    // \`preferred_username\` is accepted only when it is email-shaped: an
    // arbitrary username is not something the card labelled 邮箱.
    email: str(claims.email)
      ?? (str(claims.preferred_username)?.includes('@') === true ? str(claims.preferred_username) : undefined),
    planName: str(claims.plan) ?? str(claims.plan_name) ?? str(claims.planName) ?? str(claims.tier),
  }
}

/** The display facts one credential yields, from its claims alone. */
function displayFacts(credentials: MinimaxCodeCredentials): { email?: string; planName?: string } {
  return claimDisplayFacts(credentials.accessToken)
}

/**
 * Build one pooled account record.
 *
 * Used by both {@link createAccount} and {@link legacyAccount} so the account
 * minted by a fresh sign-in and the account projected from the pre-pool
 * credential cannot drift apart.
 */
function projectAccount(input: {
  id: string
  alias: string
  credentials: MinimaxCodeCredentials
  addedAt: number
  isPrimary: boolean
  display?: { email?: string; planName?: string }
}): MinimaxCodePoolAccount {
  const facts = input.display ?? displayFacts(input.credentials)
  return {
    id: input.id,
    alias: input.alias,
    credentials: input.credentials,
    addedAt: input.addedAt,
    isPrimary: input.isPrimary,
    // Both facts are read from the credential rather than defaulted, because the
    // credential is what the store wrote back to the app: a pool row that
    // disagreed with its own credential about the region would send requests to
    // the wrong property.
    region: input.credentials.region,
    source: input.credentials.source,
    ...(facts.email === undefined ? {} : { email: facts.email }),
    ...(facts.planName === undefined ? {} : { planName: facts.planName }),
  }
}

/**
 * Whether an account row carries an auth failure the card would render.
 *
 * Takes the summary shape as well as the pool row, because both the card's list
 * and the routing read ask the same question about it.
 */
function isMarkedFailed(account: { authStatus?: AccountAuthStatus }): boolean {
  return account.authStatus !== undefined && account.authStatus !== 'ok'
}

/** The alias an account is labelled with when the user has not named it. */
function defaultAliasFor(credentials: MinimaxCodeCredentials, position: number): string {
  const email = displayFacts(credentials).email
  if (email !== undefined) return email
  const suffix = credentials.source === 'minimax-native' ? '桌面端' : '账号 ' + position
  return 'MiniMax Code · ' + credentials.region + ' · ' + suffix
}

/**
 * Identity two credentials share when they are the same account.
 *
 * Neither token can be used for this: the access token is replaced on every
 * refresh and the refresh token rotates, so keying on either would make one
 * account look new after every rotation. A hash of the refresh token would have
 * the same defect and no compensating benefit, so it is not done.
 *
 * Two different identities are available, one per provenance:
 *
 * - A native credential names the desktop app's own record slot through
 *   \`recordKey\`. That key is a non-secret digest of the app's auth-home path, so
 *   it is stable across every rotation, and the app keeps exactly one session per
 *   slot: re-signing in there replaces the session, which for routing purposes is
 *   the same account, so updating the row in place is the correct outcome.
 * - A plugin-owned credential has no record slot (the app's key is a hash this
 *   plugin cannot reproduce) and no account profile, so the sign-in that produced
 *   it — its \`loginEpoch\`, which survives every rotation — is the identity. A
 *   second device-code sign-in is genuinely a second session with its own refresh
 *   token chain, so it is its own account.
 *
 * When neither is present there is nothing stable to key on: the function returns
 * undefined, the core mints \`acc_<random>\`, and the row is added rather than
 * silently merged with an unrelated credential.
 */
export function minimaxCodePoolIdentity(credentials: MinimaxCodeCredentials): string | undefined {
  if (credentials.recordKey !== null && credentials.recordKey !== '') {
    return 'native:' + credentials.region + ':' + credentials.recordKey
  }
  if (credentials.loginEpoch !== '') {
    return 'signin:' + credentials.region + ':' + credentials.loginEpoch
  }
  return undefined
}

/**
 * Validate and normalize one whole pool document.
 *
 * The credential is re-parsed through the store's own validator, so a row can
 * never hold a token shape the store would refuse to write back. \`source\`,
 * \`recordKey\` and \`buildEnv\` have to be restored explicitly: the validator
 * takes them from its fallback rather than from the payload, and a native account
 * that lost them would be re-labelled as plugin-owned (so the card would offer a
 * delete that must never happen, and a rotation would land in the plugin's file
 * instead of the app's).
 */
export function parseMinimaxCodePoolData(value: unknown): PoolData<MinimaxCodePoolAccount> {
  if (!isRecord(value)) throw new Error('MiniMax Code pool payload is invalid')
  const record = value
  const accounts: MinimaxCodePoolAccount[] = []
  for (const item of Array.isArray(record.accounts) ? record.accounts : []) {
    if (!isRecord(item)) continue
    if (typeof item.id !== 'string') continue
    const rawCredentials = isRecord(item.credentials) ? item.credentials : {}
    const region = isRegion(item.region)
      ? item.region
      : (isRegion(rawCredentials.region) ? rawCredentials.region : 'cn')
    let credentials: MinimaxCodeCredentials
    try {
      credentials = parseMinimaxCodeCredentials(item.credentials, {
        region,
        buildEnv: typeof rawCredentials.buildEnv === 'string' ? rawCredentials.buildEnv : undefined,
        recordKey: typeof rawCredentials.recordKey === 'string' ? rawCredentials.recordKey : null,
        source: item.source === 'minimax-native' || rawCredentials.source === 'minimax-native'
          ? 'minimax-native'
          : 'file',
      })
    } catch {
      // A row whose credential cannot serve a request is DROPPED, not repaired and
      // not fatal. Throwing here would make one corrupt row take the whole pool
      // with it: `read` catches a load failure and falls back to the legacy
      // projection, so every other account would disappear as well. The dropped
      // account is recoverable — sign in again, or adopt the app's session back —
      // while a vanished pool is not.
      continue
    }
    const account = projectAccount({
      id: item.id,
      alias: typeof item.alias === 'string' ? item.alias : defaultAliasFor(credentials, accounts.length + 1),
      credentials,
      addedAt: typeof item.addedAt === 'number' ? item.addedAt : Date.now(),
      isPrimary: item.isPrimary === true,
    })
    // Stored display facts win over the ones re-derived from the token: the row
    // was written from a credential whose claims this plugin had already read.
    const email = optionalString(item, 'email') ?? account.email
    const planName = optionalString(item, 'planName') ?? account.planName
    if (email !== undefined) account.email = email
    if (planName !== undefined) account.planName = planName
    if (typeof item.lastUsedAt === 'number') account.lastUsedAt = item.lastUsedAt
    if (typeof item.cooldownUntil === 'number') account.cooldownUntil = item.cooldownUntil
    if (typeof item.cooldownReason === 'string') account.cooldownReason = item.cooldownReason
    if (item.authStatus === 'expired' || item.authStatus === 'invalid') account.authStatus = item.authStatus
    if (typeof item.authFailedReason === 'string') account.authFailedReason = item.authFailedReason
    accounts.push(account)
  }
  const result: PoolData<MinimaxCodePoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(record.rotationStrategy),
    accounts,
  }
  if (typeof record.activeAccountId === 'string') result.activeAccountId = record.activeAccountId
  return result
}

export interface MinimaxCodeAccountPoolOptions {
  /**
   * Credential store the pool reads the desktop app's sign-in through and mirrors
   * its primary account into.
   */
  store?: MinimaxCodeCredentialStore
  /** Test seam; production builds the platform backend from the pool path. */
  backend?: CredentialStore<PoolData<MinimaxCodePoolAccount>>
  /** Accounts this pool accepts; defaults to the core's limit. */
  maxAccounts?: number
}

/**
 * MiniMax Code's account pool.
 *
 * It owns rotation and the write-back, exactly like the sibling lines, with one
 * asymmetry the hooks below enforce: an account whose credential lives in the
 * desktop app's file is adopted, never owned.
 */
export class MinimaxCodeAccountPool extends AccountPoolCore<
  MinimaxCodeCredentials,
  MinimaxCodePoolAccount,
  MinimaxCodeAccountSummaryDto
> {
  // Declared and assigned explicitly rather than as a constructor parameter
  // property: Node's type-stripping loader rejects a parameter property outright.
  private readonly store: MinimaxCodeCredentialStore

  constructor(options: MinimaxCodeAccountPoolOptions = {}) {
    const store = options.store ?? new MinimaxCodeCredentialStore()
    const hooks: AccountPoolHooks<
      MinimaxCodeCredentials,
      MinimaxCodePoolAccount,
      MinimaxCodeAccountSummaryDto
    > = {
      providerId: PROVIDER_ID,
      displayName: 'MiniMax Code',
      poolFile: minimaxCodePoolPath(),
      keychainService: 'dsh-minimax-code-pool',
      parsePoolData: parseMinimaxCodePoolData,
      // Identity, never a token: both tokens rotate, so keying on either would
      // make one account look new after every refresh.
      dedupeKey: minimaxCodePoolIdentity,
      defaultAlias: defaultAliasFor,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => projectAccount({
        id,
        alias,
        credentials,
        addedAt,
        isPrimary,
      }),
      expiresAt: (credentials) => credentials.expiresAtMs,
      // Renew BEFORE the service can refuse, not once it already has.
      //
      // This is the line's whole every-hour sign-out in one hook. The access token
      // lives one hour; the store's freshness rule only asks "is this token still
      // valid", so the pool used to start its rotation inside the last sixty
      // seconds of that hour — the one window in which a request is already being
      // refused and in which two callers spend the same rotating refresh token.
      // Five minutes of headroom moves the rotation somewhere the service is not
      // already answering 401.
      needsRefresh: (credentials, now) => credentialNeedsRefresh(credentials, now),
      refresh: async (credentials, fetchFn) => {
        // Every rotation of one session goes through the store's registry, whoever
        // asks: the pool, the usage path, or the check-in. The refresh token is
        // single-use, so two rotations of the same session are not two refreshes —
        // the second one presents a token the first already spent, the service
        // answers with a final verdict, and a successful rotation is recorded as a
        // dead sign-in. Joining an in-flight rotation, and waiting for a rotation
        // the desktop app is doing to its own file, are both handled inside.
        const rotation = await rotateMinimaxCodeCredential(store, credentials, async () => {
          // The refresh targets THIS account's own region. A global account must
          // never be refreshed into a cn one (or the reverse): the region decides
          // every host the account uses, and the token endpoint of the other
          // property would either refuse the grant or hand back a token for an
          // account the user did not pick.
          const token = await refreshAccessToken(credentials.refreshToken, {
            fetchFn,
            region: credentials.region,
          })
          const next: MinimaxCodeCredentials = {
            ...credentials,
            accessToken: token.accessToken,
            // A response that omits the refresh token means the service kept the
            // old one; storing an empty string would strand the next rotation.
            refreshToken: token.refreshToken === '' ? credentials.refreshToken : token.refreshToken,
            tokenType: token.tokenType,
            expiresAtMs: token.expiresAtMs,
            // The generation is the desktop app's own rotation counter; advancing
            // it keeps the two sides' views of the credential in step.
            generation: credentials.generation + 1,
            seenAt: Date.now(),
          }
          // A native credential is shared with a running application, and the
          // refresh token rotates: the new pair has to reach the app's own
          // auth.json through the store's atomic replacement, or the app is left
          // holding a token this plugin already spent — and the next refresh on
          // either side fails. This is a WRITE, never a delete: the store preserves
          // the document's shape, its other records and its record key. A
          // plugin-owned credential is written by the pool itself (and by the
          // mirror when it is primary), so it is left alone here. The failure is
          // swallowed on purpose: the rotation itself succeeded, and the pool's own
          // record plus the mirror still carry it.
          if (next.source === 'minimax-native' && next.recordKey !== null) {
            await store.write(next).catch(() => undefined)
          }
          return next
        })
        // A rotation that succeeded is the end of a false auth failure. The account
        // row may still carry the previous rotation's verdict — the one this very
        // fix exists to stop producing — and leaving it there keeps a healthy
        // account out of rotation until the user presses a button. Only this
        // account's own rows are touched, and only on success.
        return rotation.credentials
      },
      // A refresh the service calls final is that account's problem; a transient
      // refresh failure (429, 5xx, transport) leaves it in the pool untouched.
      refreshFailureStatus: (error) => (error instanceof MinimaxCodeUnauthorizedError ? 'expired' : undefined),
      // Pure check: the token layer records the rejection, and the pool only stops
      // routing to the account it belongs to.
      authRejectedReason: (credentials) => (isRefreshTokenRejected(credentials.refreshToken)
        ? 'MiniMax Code 已拒绝该账号的刷新令牌，需要重新登录。'
        : undefined),
      // The credential in force before the pool existed: the desktop app's file
      // when it exists, the plugin's own file otherwise. Projecting it is what
      // makes an already signed-in user see one account instead of an empty card.
      legacyAccount: async () => {
        const stored = await store.read()
        if (stored === null) return null
        return projectAccount({
          id: 'acc_primary',
          alias: defaultAliasFor(stored, 1),
          credentials: stored,
          addedAt: Date.now(),
          isPrimary: true,
        })
      },
      // The mirror is the store the single-credential line used. \`delete()\` there
      // removes ONLY the plugin's own file: the desktop app's \`auth.json\` is
      // deliberately outside its reach (see token-store.ts), which is what keeps
      // "delete every account" from signing the user out of MiniMax Code.
      mirrorPrimary: async (credentials) => {
        if (credentials === null) {
          await store.delete()
          return
        }
        await store.write(credentials)
      },
      extendSummary: (account, base) => {
        const source = account.source ?? account.credentials.source
        const email = account.email ?? displayFacts(account.credentials).email
        const planName = account.planName ?? displayFacts(account.credentials).planName
        // `base` is spread first and deliberately: it already carries the state
        // the core derives (authStatus, authFailedReason, cooldown, lastUsedAt,
        // expiresAt), and rebuilding the object from scratch would silently drop
        // an account's expired marker and let a dead credential stay in rotation.
        return {
          ...base,
          region: account.region ?? account.credentials.region,
          source,
          generation: account.credentials.generation,
          // The card offers Delete only for an account this plugin signed in
          // itself. A desktop account is adopted: deleting it would delete the
          // user's MiniMax Code session, so the card must offer no such action.
          removable: source === 'file',
          ...(email === undefined ? {} : { email }),
          ...(planName === undefined ? {} : { planName, planLabel: planName }),
        }
      },
      // An account adopted from the desktop app is a COPY of a session that
      // application keeps rotating: the token the row holds is spent the moment
      // either side rotates. The store is the authority, so a row whose copy is
      // older adopts what is on file instead of spending a dead token and being
      // recorded as expired by the answer.
      liveCredentialsFor: (account) => this.nativeAuthority(account),
      emptyMessage: 'Not signed in to MiniMax Code. Sign in with the MiniMax Code app, or add an account from Settings > MiniMax Code.',
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
    }
    super(hooks)
    this.store = store
  }

  /**
   * Account summaries, with a false auth failure cleared.
   *
   * A row can carry an `authStatus` of expired for a rotation that actually
   * succeeded — the second of two concurrent rotations of one session gets a final
   * verdict for a token the first already spent. Nobody comes back to clear that
   * marker, so the account stays out of rotation until the user presses 重新登录.
   *
   * The verdict is re-checked against the token in force instead: a row whose
   * credential has moved on since the failure is routable again, and the marker is
   * removed. A row still holding the refused token keeps its marker, because that
   * one really does need a sign-in.
   */
  override async listAccounts(): Promise<MinimaxCodeAccountSummaryDto[]> {
    const summaries = await super.listAccounts()
    if (!summaries.some(isMarkedFailed)) return summaries
    await this.healStaleAuthFailures().catch(() => undefined)
    return await super.listAccounts()
  }

  /**
   * Pick an account, healing a stale auth failure first.
   *
   * The healing matters here, not only on the card: an account marked expired is
   * excluded by the core's eligibility rule, so until the marker is gone the line
   * answers a single-account pool with "all accounts need a new sign-in" — for a
   * rotation that succeeded. Doing it on the request path means the very next
   * request after a false refusal routes normally instead of waiting for the card's
   * next poll.
   */
  override async getEffectiveAccount(
    excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ account: MinimaxCodePoolAccount; credentials: MinimaxCodeCredentials }> {
    const data = await this.read()
    if (data.accounts.some(isMarkedFailed)) {
      await this.healStaleAuthFailures(data).catch(() => undefined)
    }
    return await super.getEffectiveAccount(excludeIds, fetchFn)
  }

  /**
   * Drop an `authStatus` that describes a credential this machine no longer holds.
   *
   * A row can be marked expired by a rotation that actually SUCCEEDED: the refresh
   * token is single-use, so when two callers of one session rotate at the same time
   * the loser is told `invalid_grant` for a token the winner already spent. That is
   * a verdict about a spent generation, not about the sign-in — and nothing else in
   * the system ever revisits it, which is why the account stayed parked at
   * "需要重新登录" until the user pressed a button.
   *
   * The verdict is re-checked against the credential in force: if the stored
   * credential for the same session has moved on, the marker was about the old
   * token and is removed. A row still holding the refused token keeps its marker,
   * because that one genuinely needs a sign-in.
   */
  private async healStaleAuthFailures(current?: PoolData<MinimaxCodePoolAccount>): Promise<boolean> {
    const data = current ?? await this.read()
    const failedAccounts = data.accounts.filter(isMarkedFailed)
    if (failedAccounts.length === 0) return false
    const targets = new Map(
      failedAccounts.map((account) => [
        account.id,
        { credentials: account.credentials, authStatus: account.authStatus },
      ]),
    )
    const live = await this.store.read().catch(() => null)
    if (live === null) return false
    return await this.updatePool((draft) => {
      let changed = false
      for (const account of draft.accounts) {
        const expected = targets.get(account.id)
        if (!expected) continue
        if (account.authStatus !== expected.authStatus) continue
        if (!isDeepStrictEqual(account.credentials, expected.credentials)) continue
        if (!minimaxCodeSameCredentialSession(live, account.credentials)) continue
        if (!minimaxCodeCredentialAdvancedPast(live, account.credentials)) continue

        account.authStatus = undefined
        account.authFailedReason = undefined
        account.credentials = live
        changed = true
      }
      return changed
    })
  }

  /**
   * Pick the account for the next request.
   *
   * The returned credential carries its own region and record key, so a caller
   * must use those rather than any process-wide default. This is the method the
   * adapter uses; {@link getEffectiveAccount} beneath it already refreshes a
   * credential that is about to expire and writes the rotation back.
   */
  async getEffectiveCredential(
    excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ account: MinimaxCodePoolAccount; credentials: MinimaxCodeCredentials }> {
    const effective = await this.getEffectiveAccount(excludeIds, fetchFn)
    const live = await this.liveNativeCredential(effective.account)
    if (live === null) return effective
    if (live.accessToken !== effective.credentials.accessToken) {
      // The desktop app is the newer authority for its own session; remembering
      // the token it currently holds is what keeps the pool's copy from going
      // stale between two of this plugin's requests.
      const updated = await this.updateAccountCredentials(
        effective.account.id,
        live,
        effective.credentials,
      ).catch(() => undefined)
      if (updated) {
        return { account: updated, credentials: updated.credentials }
      }
    }
    return { account: effective.account, credentials: live }
  }

  /**
   * The desktop app's own current copy of one native account's credential.
   *
   * The app rotates its token on its own schedule, so the copy the pool adopted
   * can be older than what is on disk. Only the same record slot counts: a
   * different record key or region is a different account, and substituting it
   * would present one account's token as another's. A file whose token is already
   * stale is not newer authority either — the refresh path has just written the
   * pair back, and reading the pre-refresh file would undo it.
   */
  private async liveNativeCredential(
    account: MinimaxCodePoolAccount,
  ): Promise<MinimaxCodeCredentials | null> {
    const found = await this.nativeAuthority(account)
    return found === null || !found.advanced ? null : found.credentials
  }

  /**
   * The desktop app's own copy of one native account's session, and whether it has
   * moved on from the row's copy.
   *
   * The app rotates its token on its own schedule, so the copy the pool adopted can
   * be older than what is on disk. Only the same record slot counts: a different
   * record key or region is a different account, and substituting it would present
   * one account's token as another's.
   *
   * `advanced` is the whole reason this does not simply return the file: an
   * EXPIRED file is not newer authority (that is the app's session having lapsed),
   * while one that has moved on from the row is. The row's refresh token was spent
   * by whichever side rotated last, and only the file can say what replaced it.
   */
  private async nativeAuthority(
    account: MinimaxCodePoolAccount,
  ): Promise<{ credentials: MinimaxCodeCredentials; advanced: boolean } | null> {
    if (account.source !== 'minimax-native') return null
    const recordKey = account.credentials.recordKey
    if (recordKey === null || recordKey === '') return null
    const stored = await this.store.read().catch(() => null)
    if (stored === null || stored.source !== 'minimax-native') return null
    if (stored.recordKey !== recordKey || stored.region !== account.credentials.region) return null
    if (!credentialIsFresh(stored)) return null
    return { credentials: stored, advanced: stored.refreshToken !== account.credentials.refreshToken }
  }

  /**
   * Adopt the sign-in the desktop app currently holds into the pool.
   *
   * The pre-pool projection ({@link legacyAccount}) only surfaces when the pool is
   * empty, so a user who already has a plugin-owned account needs an explicit way
   * to bring the app's session in as well. Nothing is ever removed from the app;
   * the account is added under its own record-slot identity, so adopting twice
   * updates the same row.
   */
  async adoptNativeAccount(alias?: string): Promise<MinimaxCodePoolAccount> {
    const { credentials, source } = await this.store.readWithProvenance()
    if (credentials === null || source !== 'minimax-native') {
      throw new Error('MiniMax Code 桌面端当前没有可导入的登录态。')
    }
    return this.addAccount(credentials, alias)
  }

  /**
   * Remove one account inside a transaction.
   *
   * An account whose credential is the desktop app's own \`auth.json\` is refused:
   * this plugin does not own that file, and removing the account would either
   * strand the app's session or — if the deletion were ever allowed to reach the
   * file — sign the user out of MiniMax Code itself. Signing out there is the
   * supported way to end it, and the card is told so by \`removable: false\`.
   */
  protected override deleteAccountFromPool(data: PoolData<MinimaxCodePoolAccount>, accountId: string): void {
    const target = data.accounts.find((account) => account.id === accountId)
    if (target?.source === 'minimax-native') {
      throw new Error('该账号来自 MiniMax Code 桌面端（~/.minimax/auth），本插件只能读取和续期，不能删除。请在 MiniMax Code 应用中退出登录。')
    }
    super.deleteAccountFromPool(data, accountId)
  }

  /** The credential store this pool mirrors its primary account into. */
  mirrorStore(): MinimaxCodeCredentialStore {
    return this.store
  }
}

/** The pool slice of a status response; exactly the fields the card renders. */
export interface MinimaxCodePoolStatus {
  accounts: MinimaxCodeAccountSummaryDto[]
  activeAccountId?: string
  rotationStrategy: AccountRotationStrategy
  /** Whether this process installed a pool at all. */
  poolInstalled: boolean
}

/**
 * Read the pool slice of the status DTO.
 *
 * A pool that cannot be read must not fail the whole card: the connection
 * section is still worth rendering, just with an empty account list.
 */
export async function minimaxCodePoolStatus(
  pool: MinimaxCodeAccountPool | undefined,
): Promise<MinimaxCodePoolStatus> {
  if (pool === undefined) {
    return { accounts: [], rotationStrategy: 'sequential', poolInstalled: false }
  }
  const data = await pool.read().catch(() => null)
  const accounts = await pool.listAccounts().catch(() => [])
  return {
    accounts,
    ...(data?.activeAccountId === undefined ? {} : { activeAccountId: data.activeAccountId }),
    rotationStrategy: data?.rotationStrategy ?? 'sequential',
    poolInstalled: true,
  }
}

// ---------------------------------------------------------------------------
// The /accounts route
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    request.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Malformed JSON request'))
      }
    })
    request.on('error', reject)
  })
}

/** Whether one value is a rotation strategy this route accepts. */
function isStrategy(value: unknown): value is AccountRotationStrategy {
  return value === 'sequential' || value === 'round-robin' || value === 'sticky'
}

export interface MinimaxCodeAccountsRouteOptions {
  /**
   * Status the route answers a mutation with, so the card re-renders in one round
   * trip. Defaults to the pool slice alone.
   */
  readStatus?: () => Promise<unknown>
  /**
   * Called after a mutation that can move which account serves a request, so the
   * caller can drop per-account caches (quota, catalog) that belong to the account
   * that just changed.
   */
  onAccountsChanged?: () => void
}

/**
 * The \`/accounts\` route for this line, as a self-contained handler.
 *
 * It is a handler rather than a second \`webServer.register\` call because the
 * parent route already owns the \`/minimax-code/api\` prefix: registering a nested
 * prefix beside it would make which handler sees \`/accounts\` depend on the
 * server's prefix-matching order. The parent dispatches on \`path === 'accounts'\`
 * and calls this.
 *
 * Every POST goes through {@link isSameOriginMutation}, exactly like the sibling
 * lines' account routes, and no response ever carries a credential: what leaves
 * here is the summary DTO the card renders.
 */
export function createMinimaxCodeAccountsHandler(
  pool: MinimaxCodeAccountPool | undefined,
  options: MinimaxCodeAccountsRouteOptions = {},
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const readStatus = options.readStatus ?? (() => minimaxCodePoolStatus(pool))

  return async (request, response) => {
    const method = request.method ?? 'GET'
    try {
      if (method === 'GET') {
        // A read is answered with the same slice whether or not a pool exists, so
        // the card has one shape to render (`poolInstalled` says which it is).
        return sendJson(response, 200, { ok: true, value: await readStatus() })
      }
      if (method !== 'POST') {
        return sendJson(response, 405, { ok: false, error: 'Method Not Allowed' })
      }
      if (!isSameOriginMutation(request)) {
        return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
      }
      if (pool === undefined) {
        return sendJson(response, 400, { ok: false, error: 'Account pool is not installed.' })
      }

      const body = await readRequestJson(request)
      const action = typeof body.action === 'string' ? body.action : ''
      const accountId = typeof body.accountId === 'string' && body.accountId !== '' ? body.accountId : undefined

      if (action === 'set-primary' && accountId !== undefined) {
        await pool.setPrimary(accountId)
      } else if (action === 'set-alias' && accountId !== undefined && typeof body.alias === 'string') {
        await pool.setAlias(accountId, body.alias)
      } else if (action === 'delete' && accountId !== undefined) {
        await pool.deleteAccount(accountId)
      } else if (action === 'clear-cooldown' && accountId !== undefined) {
        await pool.clearCooldown(accountId)
      } else if (action === 'strategy' && isStrategy(body.strategy)) {
        await pool.setStrategy(body.strategy)
      } else if (action === 'relogin' && accountId !== undefined) {
        // Re-signing in is what restores an account whose refresh token was
        // rejected, so the marker is cleared and nothing is deleted.
        await pool.clearAuthFailed(accountId)
      } else if (action === 'adopt') {
        // Adopt the desktop app's current sign-in as an account of its own. The
        // app's file is only read; nothing about it changes.
        await pool.adoptNativeAccount(typeof body.alias === 'string' ? body.alias : undefined)
      } else {
        return sendJson(response, 400, { ok: false, error: 'Unknown account action: ' + action })
      }

      options.onAccountsChanged?.()
      return sendJson(response, 200, { ok: true, value: await readStatus() })
    } catch (error) {
      return sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
