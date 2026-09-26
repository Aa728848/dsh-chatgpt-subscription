/**
 * OPT-IN adoption of a pre-existing Claude Code sign-in.
 *
 * WHAT THIS IS FOR. A user who already runs the unmodified Claude Code client is
 * already signed in to the very subscription this provider serves. Asking them
 * to sign in a second time is pure friction, so this module offers the one thing
 * that removes it: reading back the credential Claude Code itself stored. It is
 * opt-in — nothing here runs until the user asks for it.
 *
 * ---------------------------------------------------------------------------
 * RULE 1 — THIS MODULE NEVER WRITES. IT IS A READER, AND ONLY A READER.
 * ---------------------------------------------------------------------------
 * It must not create, modify, move or delete any file belonging to Claude Code.
 * No file this module touches is ever opened for writing, no directory is
 * created, nothing is renamed and nothing is unlinked. The guarantee is
 * structural rather than a promise in prose: the module imports exactly two
 * functions BY NAME from 'node:fs/promises' — readFile and stat — instead of the
 * whole namespace, so introducing a write would require a visible change to the
 * import list, which is the line a reviewer reads first. Nothing exported here
 * writes. The tests assert the stronger, observable form of the rule: a
 * credential file's bytes, size and mtime are identical before and after both
 * entry points run, and its directory gains no entries.
 *
 * ---------------------------------------------------------------------------
 * RULE 2 — PRESENCE AND CONTENT ARE TWO SEPARATE FUNCTIONS
 * ---------------------------------------------------------------------------
 * claudeCodeCredentialPresence() is cheap enough to call on plugin startup and
 * answers only yes/no: it stats candidates and never opens one for reading. It
 * exists so the settings card can offer the import before the user has agreed to
 * it, and so a user who never opts in never has their token read at all.
 *
 * readClaudeCodeCredentials() is the full read, and it is called only AFTER the
 * user explicitly opts in. Keeping the two apart is the whole point: a startup
 * path that slurped the file "just in case" would make the opt-in decorative.
 *
 * ---------------------------------------------------------------------------
 * RULE 3 — AN ADOPTED CREDENTIAL IS A SNAPSHOT, AND THIS PLUGIN NEVER REFRESHES IT
 * ---------------------------------------------------------------------------
 * An adopted credential is used only while its own accessToken is still valid.
 * Once it is expired we report it as expired and tell the user to sign in again
 * in Claude Code and re-adopt. That is deliberate, not a gap:
 *
 *   Claude Code's refresh token is ROTATING — every refresh both consumes the
 *   stored refresh token and issues a new one. Two processes refreshing the same
 *   grant therefore invalidate each other: whoever loses the race holds a token
 *   the server has already retired, and the user ends up signed OUT of Claude
 *   Code by this plugin's good intentions. An in-process single-flight cannot fix
 *   that, because the race is across PROCESSES: this plugin and Claude Code are
 *   separate programs with separate memories, and the only shared state between
 *   them is the file — which this module must not write back into (Rule 1).
 *
 * So the honest contract is: borrow the access token for as long as Claude Code
 * itself vouched for it, and never touch the refresh token. Expiry is therefore
 * part of the adoption decision rather than a detail — see
 * {@link isAdoptedCredentialExpired}.
 *
 * The marker the pool chunk must honour is the literal 'adopted: true' on every
 * returned snapshot, plus {@link isAdoptedClaudeCredential}; an account carrying
 * it must be treated as read-only, non-refreshable and disposable. There is
 * deliberately no refresh function in this module to find in the first place.
 *
 * ---------------------------------------------------------------------------
 * RULE 4 — AN UNRECOGNISED SHAPE YIELDS undefined, NEVER AN EXCEPTION
 * ---------------------------------------------------------------------------
 * The card shows 'unrecognised local sign-in format' for undefined, which is a
 * far better outcome than a thrown error escaping into the settings route.
 * Nothing is guessed: a document missing either token, a claudeAiOauth that is
 * not an object, an unreadable or unparsable file — all of them are undefined.
 * Extra and unknown fields are ignored rather than rejected, so a future Claude
 * Code that adds one does not break adoption.
 *
 * THE TRAP THIS PARSER EXISTS TO AVOID. The credential document is NOT a flat bag
 * of tokens. The same file also carries MCP server sign-ins under
 * mcpOAuth.*.accessToken, and those are DIFFERENT tokens for DIFFERENT services.
 * A "find the first accessToken anywhere in the JSON" scan silently picks
 * whichever one the serializer happened to emit first, which is how an MCP token
 * ends up presented to the Messages API as the user's subscription credential.
 * The read is therefore a direct, specific lookup of claudeAiOauth.accessToken —
 * never a tree walk — and the test suite holds a fixture containing BOTH tokens
 * and asserts which one comes back.
 *
 * ---------------------------------------------------------------------------
 * WHAT COULD NOT BE VERIFIED, AND IS THEREFORE NOT CLAIMED
 * ---------------------------------------------------------------------------
 * The file layout below (a credential file named .credentials.json inside the
 * config home, JSON of the shape { "claudeAiOauth": { accessToken, refreshToken,
 * expiresAt, scopes, subscriptionType } } with expiresAt in EPOCH MILLISECONDS)
 * is assembled from secondary sources. This machine has NO Claude Code
 * installation and NO such file — all candidate paths were checked and every one
 * is absent — so this reader is proven by CONSTRUCTION against fixtures and NOT
 * by a live read of a real client's file. A layout difference in a future Claude
 * Code would surface as 'unrecognised local sign-in format' rather than as a
 * wrong token, because the parser is written to refuse rather than to improvise.
 *
 * A KNOWN NON-GOAL: on macOS Claude Code also keeps an entry in the login
 * Keychain (reported as service 'Claude Code-credentials'). This module does NOT
 * read it. The service name is unverified — a third-party guide and the real
 * client disagree about it — and asking the Keychain for a name that is not the
 * real one either finds nothing or, worse, finds somebody else's item. A file
 * path that can be printed in the UI and inspected by the user beats a guessed
 * Keychain query, so the Keychain is left strictly alone.
 */

// NEVER widen this import to the fs namespace object, by importing 'node:fs'
// or a star-import of 'node:fs/promises': the named-only form is what makes the
// no-write rule of the module comment mechanically visible. readFile and stat
// are the only filesystem calls this module makes, and the test suite asserts
// both halves of that sentence against this file's own source text.
import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ClaudeCredentials } from './token-store.ts'

/**
 * Environment variable that relocates Claude Code's config directory.
 *
 * Highest precedence, and honoured exactly as the client honours it: when it is
 * set to a non-blank value it names the config home, whatever the platform's
 * conventional location happens to be. This is also what makes the whole module
 * testable without touching a developer's real profile.
 */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR'

/** File name of the credential document inside the config home. */
export const CLAUDE_CODE_CREDENTIAL_FILE = '.credentials.json'

/**
 * Top-level key holding the subscription sign-in.
 *
 * Named as a constant because the specificity of this key IS the defence
 * described in the module comment: the read addresses this key, not the first
 * token it can find anywhere in the document.
 */
export const CLAUDE_CODE_CREDENTIAL_KEY = 'claudeAiOauth'

/** Where an adopted snapshot came from, for the card and for the pool record. */
export const CLAUDE_CODE_CREDENTIAL_SOURCE = 'claude-code'

/**
 * Expiry value stamped on a credential that states no usable one.
 *
 * Epoch zero, and it is a deliberate choice over "now" or "Infinity". Infinity
 * would turn a missing field into a credential that never expires — the exact
 * inversion of the safe reading, because a credential whose validity cannot be
 * established must not be used. Epoch zero is unambiguous, survives a JSON round
 * trip, and compares as expired against any clock a user's machine can hold, so
 * a damaged document degrades into "expired, sign in again" instead of into a
 * request carrying a token nobody vouched for.
 */
export const UNKNOWN_CREDENTIAL_EXPIRY = 0

/**
 * What the user is told when an adopted credential has aged out.
 *
 * Exported so the settings card and the pool report the same sentence, and so the
 * instruction is stated once: re-sign-in happens in CLAUDE CODE, not here, and
 * the import has to be repeated afterwards.
 */
export const ADOPTED_CREDENTIAL_EXPIRED_HINT =
  'The sign-in imported from Claude Code has expired. Sign in again in Claude '
  + 'Code, then import it again from this settings card.'

/** One adopted credential: the store's own credential shape plus its provenance. */
export interface ClaudeCodeAdoptedCredential {
  /**
   * The pool marker. Literal true on every snapshot this module returns.
   *
   * A discriminant rather than a description: a pool chunk that stores this
   * record must refuse to refresh it, and a boolean it can test is harder to
   * overlook than a comment it can read past.
   */
  readonly adopted: true
  /** Which local sign-in this was taken from. */
  readonly source: typeof CLAUDE_CODE_CREDENTIAL_SOURCE
  /** The exact file it was read from, so the card can name it. */
  readonly sourcePath: string
  /** The credential in the store's own shape, ready to be persisted by the caller. */
  readonly credentials: ClaudeCredentials
}

/** Answer to the startup question: is there anything to adopt? */
export interface ClaudeCodeCredentialPresence {
  /** Whether a candidate exists. Says nothing about whether it is usable. */
  present: boolean
  /** The first candidate that exists, or null when none does. */
  path: string | null
  /**
   * Every candidate consulted, in precedence order, whether or not it existed.
   *
   * Returned so the card can print the exact list it looked at — the difference
   * between "not found" and "your client stores it somewhere else" is invisible
   * to a user who is only told the first path.
   */
  searched: string[]
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
 * Claude Code's config home.
 *
 * The environment override wins whenever it is set to a non-blank value — a blank
 * or whitespace-only variable is treated as unset rather than as "the directory
 * whose name is empty", which on Windows would resolve to a drive-relative path.
 * Otherwise the conventional home/.claude directory is used, os.homedir() being
 * the same %USERPROFILE% on Windows and ~ on POSIX that the client itself uses.
 *
 * Read at CALL time rather than captured in a module constant: a test (or an
 * embedder) that sets the variable after import must see the change.
 */
export function claudeConfigDir(): string {
  const override = process.env[CLAUDE_CONFIG_DIR_ENV]?.trim()
  if (override) return override
  return path.join(os.homedir(), '.claude')
}

/**
 * Every path this module will look at, most authoritative first.
 *
 * The FIRST entry is always the config home from {@link claudeConfigDir} — the
 * location the client is documented to use — so the card can print it as "the"
 * path.
 *
 * The conventional home/.claude/.credentials.json follows as a FALLBACK whenever
 * it is not already the first entry. Judgement call, stated plainly: treating the
 * environment override as absolutely exclusive would make a stale or
 * freshly-created override directory — a user who once pointed the variable at a
 * scratch profile and forgot — report "no sign-in found" while a perfectly good
 * one sits in the conventional location. The fallback costs one stat, is
 * consulted only when the earlier candidate yields nothing usable, and the file
 * actually used is always reported back in
 * {@link ClaudeCodeAdoptedCredential.sourcePath}. The residual risk is adopting a
 * snapshot belonging to a different profile than the one Claude Code is currently
 * using; it is bounded by the fact that such a snapshot is only ever used while
 * its own access token is unexpired, and it is visible to the user because the
 * source path is shown.
 *
 * A pure function — no filesystem access at all — so it is safe to call just to
 * render the card, and so its precedence is testable without touching a disk.
 */
export function claudeCodeCredentialPaths(): string[] {
  const paths = [path.join(claudeConfigDir(), CLAUDE_CODE_CREDENTIAL_FILE)]
  const conventional = path.join(os.homedir(), '.claude', CLAUDE_CODE_CREDENTIAL_FILE)
  if (!paths.includes(conventional)) paths.push(conventional)
  return paths
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
 * Is there a local Claude Code sign-in to offer?
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
 * paths is injectable so tests drive it against fixtures instead of a real
 * profile; production callers take the default.
 */
export async function claudeCodeCredentialPresence(
  paths: readonly string[] = claudeCodeCredentialPaths(),
): Promise<ClaudeCodeCredentialPresence> {
  const searched = [...paths]
  for (const candidate of searched) {
    if (await existsAsFile(candidate)) return { present: true, path: candidate, searched }
  }
  return { present: false, path: null, searched }
}

/**
 * Normalize a scopes value, tolerantly.
 *
 * Claude Code stores an array of strings. A space-delimited string is also
 * accepted because that is how RFC 6749 states a scope set and a serializer could
 * legitimately write it that way. A non-string entry is DROPPED rather than
 * rejected: one junk element must not cost the user the whole sign-in, and a
 * dropped scope shows up honestly as a missing scope on the card.
 *
 * undefined means "the document did not state scopes" and is kept distinct from an
 * empty array, which means "it stated none". This module does not invent scopes:
 * asserting what the user was granted is not this reader's job.
 */
function normalizeScopes(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    return value.split(/\s+/).filter((scope) => scope !== '')
  }
  if (!Array.isArray(value)) return undefined
  const scopes: string[] = []
  for (const entry of value) {
    const scope = nonEmptyString(entry)
    if (scope !== undefined) scopes.push(scope)
  }
  return scopes
}

/**
 * Epoch milliseconds a credential states, or {@link UNKNOWN_CREDENTIAL_EXPIRY}.
 *
 * Strict on purpose. Only a finite number is accepted: a numeric STRING is refused
 * even though it could be coerced, because the writer here is a local JSON
 * serializer of a JavaScript number, so a string would mean the document's shape
 * is not the one this module understands — and the response to an unrecognised
 * shape is to stop, not to convert and hope. null, NaN, Infinity and a missing
 * field all collapse to the expired sentinel, which is the safe direction: the
 * failure mode is "asks the user to adopt again", never "uses a credential whose
 * validity nothing established".
 */
function finiteEpochMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN_CREDENTIAL_EXPIRY
}

/**
 * Map one parsed credential document onto the store's credential shape.
 *
 * Pure and exported so the format rules can be tested without a filesystem, and
 * so a later chunk that reads the document from somewhere else (a backup, a
 * pasted blob) reuses the one set of rules instead of growing a second, drifting
 * copy.
 *
 * Returns undefined for every shape it does not recognise, and never throws — see
 * Rule 4 in the module comment. The gate is deliberately narrow: the document must
 * be a JSON object, claudeAiOauth must be an object, and it must carry BOTH a
 * non-empty accessToken and a non-empty refreshToken. An access token alone is not
 * adopted because the store's record is a sign-in, not a bare token: its identity
 * aliases are derived from the refresh token, and a record with an empty one would
 * mint an identity that matches nothing and can never be re-recognised.
 *
 * The MCP trap is handled by construction here: value.claudeAiOauth is addressed
 * directly and no other key of the document is ever traversed, so whatever
 * mcpOAuth holds cannot reach the result.
 */
export function parseAdoptedClaudeCredential(
  value: unknown,
  sourcePath: string,
): ClaudeCodeAdoptedCredential | undefined {
  if (!isRecord(value)) return undefined
  const oauth = value[CLAUDE_CODE_CREDENTIAL_KEY]
  if (!isRecord(oauth)) return undefined

  const accessToken = nonEmptyString(oauth.accessToken)
  if (accessToken === undefined) return undefined
  const refreshToken = nonEmptyString(oauth.refreshToken)
  if (refreshToken === undefined) return undefined

  const credentials: ClaudeCredentials = {
    accessToken,
    refreshToken,
    expiresAt: finiteEpochMs(oauth.expiresAt),
  }
  const scopes = normalizeScopes(oauth.scopes)
  if (scopes !== undefined) credentials.scopes = scopes
  const subscriptionType = nonEmptyString(oauth.subscriptionType)
  if (subscriptionType !== undefined) credentials.subscriptionType = subscriptionType
  // The 'account' field is deliberately NOT read. There is no verified evidence of
  // how a Claude Code document would spell it, and a guessed field would produce a
  // wrong identity alias — the exact ghost-account failure the store's two-layer
  // identity design exists to prevent. Leaving it out makes the alias set fall back
  // to the refresh-token seed, which is honest about knowing nothing more.

  return {
    adopted: true,
    source: CLAUDE_CODE_CREDENTIAL_SOURCE,
    sourcePath,
    credentials,
  }
}

/**
 * Read the local Claude Code sign-in; the first usable candidate wins.
 *
 * ONLY call this after the user has explicitly opted in — see the module comment.
 *
 * Never throws and never rejects: an absent file, an unreadable file, a file that
 * is not JSON, and a JSON document of an unrecognised shape all produce
 * undefined, which the card renders as 'unrecognised local sign-in format'. A
 * settings route must not be able to fail because a user's file was mid-write.
 *
 * A candidate that EXISTS but cannot be parsed does not stop the search; the next
 * candidate is tried. That trade-off is stated in {@link claudeCodeCredentialPaths}
 * and the file actually used is reported in the result, so a fallback is always
 * visible rather than silent.
 */
export async function readClaudeCodeCredentials(
  paths: readonly string[] = claudeCodeCredentialPaths(),
): Promise<ClaudeCodeAdoptedCredential | undefined> {
  for (const candidate of paths) {
    try {
      const raw = await readFile(candidate, 'utf8')
      const adopted = parseAdoptedClaudeCredential(JSON.parse(raw) as unknown, candidate)
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
 * The predicate the pool chunk tests a stored account with before deciding whether
 * it may ever be refreshed. It recognises this module's snapshot and nothing else:
 * a plain store credential has no 'adopted' field and must NOT be mistaken for
 * one, because treating a plugin-owned account as a disposable snapshot would
 * discard an account the user added here.
 */
export function isAdoptedClaudeCredential(value: unknown): value is ClaudeCodeAdoptedCredential {
  if (!isRecord(value)) return false
  return value.adopted === true && value.source === CLAUDE_CODE_CREDENTIAL_SOURCE && isRecord(value.credentials)
}

/**
 * Whether an adopted credential's access token is already unusable.
 *
 * A structural mirror of the expiry test the OAuth module applies to its own
 * credentials (expiresAt - Date.now() > 0), asked of an adopted snapshot so the
 * pool can refuse it WITHOUT ever reaching for a refresh this module deliberately
 * does not perform. A non-finite expiresAt counts as expired, matching
 * {@link finiteEpochMs}: no field, no validity.
 *
 * now is injectable so a test can reason about a fixed clock.
 */
export function isAdoptedCredentialExpired(
  credential: Pick<ClaudeCodeAdoptedCredential, 'credentials'>,
  now: number = Date.now(),
): boolean {
  const expiresAt = credential.credentials.expiresAt
  return !(typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > now)
}
