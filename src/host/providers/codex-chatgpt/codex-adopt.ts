/**
 * OPT-IN adoption of a pre-existing Codex CLI sign-in.
 */

// NEVER widen this import to the fs namespace object, by importing 'node:fs'
// or a star-import of 'node:fs/promises': the named-only form is what makes the
// no-write rule of the module comment mechanically visible. readFile and stat
// are the only filesystem calls this module makes, and the test suite asserts
// both halves of that sentence against this file's own source text.
import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CODEX_AUTH_CLAIMS_KEY } from './codex-identity.ts'
import type { StoredOAuthCredentials } from '../../infra/storage/token-store.ts'

/**
 * Environment variable that relocates the Codex CLI's home directory.
 *
 * Highest precedence, and honoured exactly as the CLI honours it: when it is set
 * to a non-blank value it names the home that holds auth.json, whatever the
 * platform's conventional location happens to be. This is also what makes the
 * whole module testable without touching a developer's real profile.
 */
export const CODEX_HOME_ENV = 'CODEX_HOME'

/** File name of the credential document inside the Codex home. */
export const CODEX_CLI_CREDENTIAL_FILE = 'auth.json'

/**
 * Top-level key holding the OAuth tokens.
 *
 * Named as a constant because the specificity of this key IS the defence
 * described in the module comment: the read addresses this key, not the first
 * token it can find anywhere in the document.
 */
export const CODEX_CLI_TOKENS_KEY = 'tokens'

/**
 * The one auth_mode this provider can adopt.
 *
 * A Codex home may also hold an API-key sign-in, which is a different kind of
 * credential for a different billing arrangement. Adopting it as a subscription
 * sign-in would present the wrong credential to the Responses API, so the mode is
 * checked rather than assumed: an unrecognised mode is an unrecognised document.
 */
export const CODEX_CLI_CHATGPT_AUTH_MODE = 'chatgpt'

/** Where an adopted snapshot came from, for the card and for the pool record. */
export const CODEX_CLI_CREDENTIAL_SOURCE = 'codex'

/**
 * What the user is told when an adopted credential has aged out.
 *
 * Exported so the pool report and the settings card say the same sentence, and
 * so the instruction is stated once: the re-sign-in happens in the CODEX CLI, not
 * here, and the import has to be repeated afterwards.
 */
export const ADOPTED_CODEX_CREDENTIAL_EXPIRED_HINT =
  'The sign-in imported from the Codex CLI has expired. Sign in again in the Codex '
  + 'CLI, then import it again from this settings card.'

/** One adopted credential: the store's own credential shape plus its provenance. */
export interface CodexCliAdoptedCredential {
  /**
   * The pool marker. Literal true on every snapshot this module returns.
   *
   * A discriminant rather than a description: a pool chunk that stores this record
   * must refuse to refresh it, and a boolean it can test is harder to overlook
   * than a comment it can read past.
   */
  readonly adopted: true
  /** Which local sign-in this was taken from. */
  readonly source: typeof CODEX_CLI_CREDENTIAL_SOURCE
  /** The exact file it was read from, so the card can name it. */
  readonly sourcePath: string
  /** The credential in the store's own shape, ready to be persisted by the caller. */
  readonly credentials: StoredOAuthCredentials
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A trimmed, non-empty string, or nothing. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * The Codex CLI's home directory.
 *
 * The environment override wins whenever it is set to a non-blank value — a blank
 * or whitespace-only variable is treated as unset rather than as "the directory
 * whose name is empty", which on Windows would resolve to a drive-relative path.
 * Otherwise the conventional home/.codex directory is used, os.homedir() being
 * the same %USERPROFILE% on Windows and ~ on POSIX that the CLI itself uses.
 *
 * Read at CALL time rather than captured in a module constant: a test (or an
 * embedder) that sets the variable after import must see the change.
 */
export function codexHomeDir(): string {
  const override = process.env[CODEX_HOME_ENV]?.trim()
  if (override) return override
  return path.join(os.homedir(), '.codex')
}

/**
 * Every path this module will look at, most authoritative first.
 *
 * A single candidate, which is a judgement call stated plainly. The Claude reader
 * in this package also falls back to the conventional home when the environment
 * override points somewhere else; here the override IS the user's own statement of
 * where this CLI keeps its sign-in, and honouring a stale scratch directory is
 * more dangerous than reporting nothing: a snapshot belonging to a profile the CLI
 * is not currently using would be adopted silently. The path actually consulted is
 * returned and printed by the caller, so "not found" is always accompanied by the
 * exact place that was looked at.
 *
 * A pure function — no filesystem access at all — so it is safe to call just to
 * render the card, and so its precedence is testable without touching a disk.
 */
export function codexCliCredentialPaths(): readonly string[] {
  return [path.join(codexHomeDir(), CODEX_CLI_CREDENTIAL_FILE)]
}

/**
 * Whether a plain file exists at one path.
 *
 * stat, not lstat: a credential file reached through a symlink is a legitimate
 * layout — a user may keep profiles behind links — and the question asked here is
 * whether the client has a file there, not how it is reached.
 *
 * Any error (ENOENT, EACCES, ENOTDIR, an unsupported path shape) answers "no". A
 * failure to establish existence is not evidence of existence, and this path runs
 * on startup where throwing would take the plugin down over a missing file.
 */
async function existsAsFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile()
  } catch {
    return false
  }
}

/**
 * Is there a local Codex CLI sign-in to offer?
 *
 * Safe on plugin startup: this NEVER opens a candidate for reading, so a user who
 * never opts in never has the credential's contents touched — not by this
 * function, not by the route that renders the card. Only stat runs, which reveals
 * existence and timestamps and nothing else.
 *
 * Deliberately NOT reported here: whether the file is valid, expired, or even
 * JSON. Answering that would require the read this function exists to avoid, and
 * the card does not need it — validity is answered by the read, after opt-in, and
 * lands on the card as either a credential or 'unrecognised local sign-in
 * format'.
 *
 * A boolean, rather than the record the Claude reader returns, because the two
 * callers want different things and neither needs the other's shape: the status
 * route wants a flag, and reports the path it consulted beside it. paths
 * is injectable so tests drive it against fixtures instead of a real profile;
 * production callers take the default.
 */
export async function codexCliCredentialPresence(
  paths: readonly string[] = codexCliCredentialPaths(),
): Promise<boolean> {
  for (const candidate of paths) {
    if (await existsAsFile(candidate)) return true
  }
  return false
}

/**
 * The claims of a JWT, decoded in process, or nothing.
 *
 * The payload is the second base64url segment; the signature is never touched and
 * the result is used only for the three non-secret facts below. Never sent
 * anywhere: a token handed to a decoder service is a token handed away.
 *
 * No verification is claimed and none is possible here — the signing key is the
 * issuer's, and this module has no business holding it. What it does instead is
 * refuse to invent: a token that does not decode is treated as stating nothing.
 */
function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const value = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The access token's expiry, in EPOCH MILLISECONDS, or nothing.
 *
 * RFC 7519 states 'exp' in SECONDS since the epoch, and the store's
 * StoredOAuthCredentials states milliseconds — a thousand-fold difference that is
 * silent when it goes the wrong way (a credential stamped a thousand times too
 * late reads as unexpired for centuries) and catastrophic the other. The
 * conversion is therefore done here, once, with a comment on it.
 *
 * Only a finite, non-negative number is accepted. A string, null, NaN, a
 * negative value or a missing claim are all "this document states no usable
 * expiry", and the caller's answer to that is to refuse the whole document rather
 * than import a credential whose validity nothing established.
 */
function expiryFromAccessToken(accessToken: string): number | undefined {
  const claims = decodeJwtClaims(accessToken)
  if (claims === undefined) return undefined
  const exp = claims.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp < 0) return undefined
  return Math.round(exp * 1000)
}

/**
 * Map one parsed credential document onto the store's credential shape.
 *
 * Pure and exported so the format rules can be tested without a filesystem, and
 * so a later chunk that reads the document from somewhere else (a backup, a pasted
 * blob) reuses the one set of rules instead of growing a second, drifting copy.
 *
 * Returns undefined for every shape it does not recognise, and never throws — see
 * Rule 4 in the module comment. The gate is deliberately narrow: the document must
 * be a JSON object in the ChatGPT auth mode, its tokens block must be an object,
 * and it must carry BOTH a non-empty access token and a non-empty refresh token.
 * An access token alone is not adopted because the store's record is a sign-in,
 * not a bare token, and a record with an empty one could never be re-recognised.
 *
 * The unrelated-token trap is handled by construction: value.tokens is addressed
 * directly and no other key of the document is ever traversed, so whatever else
 * the file carries cannot reach the result.
 */
export function parseAdoptedCodexCredential(
  value: unknown,
  sourcePath: string,
): CodexCliAdoptedCredential | undefined {
  if (!isRecord(value)) return undefined
  if (value.auth_mode !== CODEX_CLI_CHATGPT_AUTH_MODE) return undefined
  const tokens = value[CODEX_CLI_TOKENS_KEY]
  if (!isRecord(tokens)) return undefined

  const accessToken = nonEmptyString(tokens.access_token)
  if (accessToken === undefined) return undefined
  const refreshToken = nonEmptyString(tokens.refresh_token)
  if (refreshToken === undefined) return undefined

  const expiresAt = expiryFromAccessToken(accessToken)
  // No usable expiry is not a credential this plugin is willing to hold: see the
  // rule in the module comment. Refusing the document is the honest answer.
  if (expiresAt === undefined) return undefined

  const credentials: StoredOAuthCredentials = { accessToken, refreshToken, expiresAt }

  const idToken = nonEmptyString(tokens.id_token)
  if (idToken !== undefined) {
    credentials.idToken = idToken
    // Email and plan are read out of the id token's own claims, and only when the
    // token states them. The pool derives its identity from the tokens themselves
    // (codex-identity.ts), so nothing here is an identity field of its own: a claim
    // that is absent leaves that derivation falling back to the next one — which is
    // honest about knowing nothing more, where a guessed value would invent an
    // account the user cannot recognise.
    const claims = decodeJwtClaims(idToken)
    const email = claims === undefined ? undefined : nonEmptyString(claims.email)
    if (email !== undefined) credentials.email = email
    const authClaims = claims === undefined ? undefined : claims[CODEX_AUTH_CLAIMS_KEY]
    const planType = isRecord(authClaims) ? nonEmptyString(authClaims.chatgpt_plan_type) : undefined
    if (planType !== undefined) credentials.planType = planType
  }

  const accountId = nonEmptyString(tokens.account_id)
  if (accountId !== undefined) credentials.accountId = accountId

  return {
    adopted: true,
    source: CODEX_CLI_CREDENTIAL_SOURCE,
    sourcePath,
    credentials,
  }
}

/**
 * Read the local Codex CLI sign-in; the first usable candidate wins.
 *
 * ONLY call this after the user has explicitly opted in — see the module comment.
 *
 * Never throws and never rejects: an absent file, an unreadable file, a file that
 * is not JSON, and a JSON document of an unrecognised shape all produce undefined,
 * which the card renders as 'unrecognised local sign-in format'. A settings route
 * must not be able to fail because a user's file was mid-write.
 */
export async function readCodexCliCredentials(
  paths: readonly string[] = codexCliCredentialPaths(),
): Promise<CodexCliAdoptedCredential | undefined> {
  for (const candidate of paths) {
    try {
      const raw = await readFile(candidate, 'utf8')
      const adopted = parseAdoptedCodexCredential(JSON.parse(raw) as unknown, candidate)
      if (adopted !== undefined) return adopted
    } catch {
      // Deliberately swallowed: this module's contract is a value, never an
      // exception. The causes are enumerable and all benign to the caller —
      // ENOENT, EACCES, EISDIR when the path is a directory, and SyntaxError from
      // JSON.parse on a partially written file.
    }
  }
  return undefined
}

/**
 * Whether a value carries the adopted marker.
 *
 * The predicate the pool chunk tests a stored credential with before deciding
 * whether it may ever be refreshed. It recognises this module's snapshot and
 * nothing else: a plain store credential has no 'adopted' field and must NOT be
 * mistaken for one, because treating a plugin-owned account as a disposable
 * snapshot would freeze an account the user signed in here.
 */
export function isAdoptedCodexCredential(value: unknown): value is CodexCliAdoptedCredential {
  if (!isRecord(value)) return false
  return value.adopted === true
    && value.source === CODEX_CLI_CREDENTIAL_SOURCE
    && isRecord(value.credentials)
}

/**
 * Whether an adopted credential's access token is already unusable.
 *
 * A structural mirror of the expiry test the OAuth module applies to its own
 * credentials (expiresAt - Date.now() > 0), asked of a pooled credential so the
 * pool can refuse it WITHOUT ever reaching for a refresh this module deliberately
 * does not perform. A non-finite expiresAt counts as expired, matching the
 * refusal in the reader: no established validity, no use.
 *
 * now is injectable so a test can reason about a fixed clock.
 */
export function isAdoptedCodexCredentialExpired(
  credential: Pick<StoredOAuthCredentials, 'expiresAt'>,
  now: number = Date.now(),
): boolean {
  const expiresAt = credential.expiresAt
  return !(typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > now)
}
