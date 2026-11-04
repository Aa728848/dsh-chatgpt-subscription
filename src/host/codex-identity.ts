import { createHash } from 'node:crypto'
import type { StoredOAuthCredentials } from './token-store.ts'

/**
 * Who one ChatGPT credential belongs to, and what makes two sign-ins the same
 * account.
 *
 * TWO IDENTITIES, AND THEY ARE NOT THE SAME THING.
 *
 * - The WORKSPACE identity is `chatgpt_account_id`, carried as
 *   `credentials.accountId` and sent upstream as `chatgpt-account-id`. It
 *   decides which workspace a request is billed to and what its listing serves,
 *   and every member of that workspace shares it.
 * - The LOCAL LOGIN identity is (workspace, user): that same workspace id plus a
 *   stable id for the person who signed in. Two members of one workspace are two
 *   accounts here — separate tokens, separate rows, separately selectable — and
 *   re-authorizing the same person updates the row that person already owns.
 *
 * Keying the account pool on the workspace alone is the bug this module exists to
 * prevent. Adding a second member of a workspace replaced the first: the card read
 * "1 account signed in", the earlier sign-in was gone from the list, and nothing in
 * the credential was wrong — the pool simply believed both sign-ins were one
 * account, because that is what the key said.
 *
 * The user id is read from the tokens themselves, most explicit claim first:
 * `chatgpt_user_id` (the field upstream states for exactly this purpose), then
 * the OIDC `sub` that an id token always carries, then the address. Only when none
 * of the three is present does the workspace stand in on its own, because nothing
 * better exists then and merging is what every row written before this module
 * already did. The workspace id alone is NEVER treated as a user identity while
 * some user claim is available.
 */

/** Namespace of the ChatGPT auth claims inside an id or access token. */
export const CODEX_AUTH_CLAIMS_KEY = 'https://api.openai.com/auth'

/**
 * The claims this line reads, and no others.
 *
 * Every field is non-secret: an id, an address and a plan name. The token's
 * signature is never touched and never verified here — the signing key is the
 * issuer's, and what this module needs is who the token says it is, not whether
 * someone could forge that claim. Forging it is the issuer's problem; a token this
 * plugin accepted from the issuer is the input either way.
 */
export interface OAuthClaims {
  email?: unknown
  sub?: unknown
  chatgpt_account_id?: unknown
  chatgpt_user_id?: unknown
  chatgpt_plan_type?: unknown
  organizations?: Array<{ id?: unknown }>
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: unknown
    chatgpt_user_id?: unknown
    chatgpt_plan_type?: unknown
    organizations?: Array<{ id?: unknown }>
  }
}

/** The non-secret facts a credential states about its owner. */
export interface CodexIdentity {
  /** Upstream workspace id (`chatgpt-account-id`), shared by its whole membership. */
  accountId?: string
  /** Stable id of the human who signed in; see {@link codexUserId}. */
  userId?: string
  email?: string
  planType?: string
}

/** The parts of a credential an identity can be read from. */
export type CodexIdentityInput = Pick<
  StoredOAuthCredentials,
  'accessToken' | 'idToken' | 'accountId' | 'email' | 'userId'
>

/**
 * The claims of a JWT, decoded in process, or nothing.
 *
 * The payload is the second base64url segment; the signature is never touched and
 * the result is used only for the non-secret facts above. Never sent anywhere: a
 * token handed to a decoder service is a token handed away.
 *
 * No verification is claimed and none is possible here. What this does instead is
 * refuse to invent: a token that does not decode is treated as stating nothing,
 * which leaves the caller on its own fallback rather than on a guessed identity.
 */
export function parseJwtClaims(token: string | undefined): OAuthClaims | undefined {
  if (token === undefined) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const value = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown
    return typeof value === 'object' && value !== null ? value as OAuthClaims : undefined
  } catch {
    return undefined
  }
}

/**
 * What the tokens state about their owner.
 *
 * The id token is read before the access token, because it is the document that
 * describes the sign-in; the access token is the fallback for credentials stored
 * without one. First statement wins, so a value the id token states is never
 * overwritten by the access token's copy of it.
 */
export function extractIdentity(
  credentials: Pick<StoredOAuthCredentials, 'accessToken' | 'idToken'>,
): CodexIdentity {
  const result: CodexIdentity = {}
  // Held aside rather than assigned on the spot: `sub` is the weakest user claim
  // an OpenID token carries, so it must not win over a `chatgpt_user_id` that only
  // the other token states.
  let subject: string | undefined
  for (const token of [credentials.idToken, credentials.accessToken]) {
    const claims = parseJwtClaims(token)
    if (claims === undefined) continue
    const nested = claims[CODEX_AUTH_CLAIMS_KEY]
    result.email ??= stringClaim(claims.email)
    result.planType ??= stringClaim(claims.chatgpt_plan_type) ?? stringClaim(nested?.chatgpt_plan_type)
    result.userId ??= stringClaim(claims.chatgpt_user_id) ?? stringClaim(nested?.chatgpt_user_id)
    result.accountId ??= stringClaim(claims.chatgpt_account_id)
      ?? stringClaim(nested?.chatgpt_account_id)
      ?? stringClaim(claims.organizations?.[0]?.id)
      ?? stringClaim(nested?.organizations?.[0]?.id)
    subject ??= stringClaim(claims.sub)
  }
  result.userId ??= subject
  return result
}

/**
 * The stable id of the human behind a credential, or nothing.
 *
 * Explicit claim first, then `sub`, and deliberately NOT the email: an address is
 * the caller's fallback (see {@link codexAccountIdentity}), while this function
 * answers the narrower question "does this credential name its user outright?".
 * A persisted `userId` wins over anything re-derived from the tokens, so an opaque
 * access token handed back by a rotation cannot make an account look like a
 * different one.
 */
export function codexUserId(credentials: CodexIdentityInput): string | undefined {
  const stored = nonEmpty(credentials.userId)
  if (stored !== undefined) return stored
  return extractIdentity(credentials).userId
}

/**
 * One opaque key per local login: the pool's dedupe key, and the scope of every
 * per-account cache this line keeps.
 *
 * A digest of an EXPLICIT serialization rather than a readable join, for three
 * reasons that are really one: the string is a label, not data.
 *
 * - A separator can be forged. `workspace:user` joins two values that may
 *   themselves contain the separator, so `a` + `b:c` and `a:b` + `c` would have to
 *   be the same key. A JSON array has no such ambiguity: quotes and escapes are
 *   the boundary, and they cannot be re-cut by a value.
 * - The key becomes a FILE NAME. `catalogSnapshotName` folds everything outside
 *   `[a-z0-9]` to `_`, so a readable key would collide with its neighbours after
 *   folding *and* leave an email address on disk. Hex survives the fold unchanged.
 * - It is compared for equality only, so nothing is lost by making it opaque.
 *
 * `v1` is part of the serialized tuple, not decoration: a future change to the
 * composition has to produce different keys, and a version tag is what lets that
 * change be told apart from a corrupted row instead of silently merging two
 * accounts that the new rule would separate.
 *
 * Returns `undefined` when the credential states nothing at all about who it is.
 * The pool then mints its own `acc_<random>` and ADDS the row, which is the honest
 * answer: a credential nothing identifies cannot be recognized again, and merging
 * it with an unrelated one would be worse than a duplicate.
 */
export function codexAccountIdentity(credentials: CodexIdentityInput): string | undefined {
  const workspace = nonEmpty(credentials.accountId)
  // The address is the last resort, and only the last: it identifies a person well
  // enough to update their row, and it is never preferred over a stated user id.
  const user = codexUserId(credentials) ?? nonEmpty(credentials.email)
  if (workspace === undefined && user === undefined) return undefined
  const serialized = JSON.stringify(['v1', workspace ?? '', user ?? ''])
  return 'v1-' + createHash('sha256').update(serialized).digest('hex').slice(0, 32)
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}
