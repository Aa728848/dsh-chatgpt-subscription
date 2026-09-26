/**
 * Credential and model-settings persistence for the Claude subscription line.
 *
 * ---------------------------------------------------------------------------
 * WHY ACCOUNT IDENTITY HAS TWO LAYERS
 * ---------------------------------------------------------------------------
 *
 * A subscription credential is not stable text. Every refresh returns a NEW
 * refresh token, and signing in to the same account a second time mints yet
 * another one. The obvious key — a hash of the refresh token — therefore says
 * "new account" for what is the same account, and one ghost row appears per
 * refresh and per re-login. That is the defect this module exists to prevent.
 *
 * A stored account therefore carries two distinct things:
 *
 * 1. `internalId` — minted exactly once, at the first save of an account, as
 *    `cl_` + ten random bytes in hex. It never changes for the lifetime of the
 *    record, and it is the ONLY key routing may use: set-primary, delete and
 *    re-login all address a record by this id.
 * 2. `identityKeys` — an append-only set of ALIASES derived from the credential
 *    itself: `uuid:<account.uuid>`, `email:<address>`, and — only when neither
 *    of those is available — `seed:<sha256(refreshToken).slice(0,16)>`. Every save
 *    MERGES the freshly derived keys into the stored set: a key is never
 *    replaced, never dropped, and never re-derived from a token that rotated.
 *
 * Both spellings of the account's address (`email_address`, the wire's own, and
 * `emailAddress`) and both of the account's uuid spellings are read, because a
 * silently missed field here is precisely the ghost-account failure above. Keys
 * are lower-cased on the way in for the same reason: an address that differs only
 * in case is one account.
 *
 * ---------------------------------------------------------------------------
 * THE KNOWN, ACCEPTED LIMITATION: `seed:` CANNOT RECOGNISE A RE-LOGIN
 * ---------------------------------------------------------------------------
 *
 * `seed:` is a digest of the refresh token, so the SAME account signing in again
 * produces a DIFFERENT seed and is stored as a SECOND record. Nothing can tell
 * those two records apart from two genuinely different accounts: neither states
 * a uuid or an address, and the tokens they hold have nothing in common.
 *
 * This is a real limitation, and it is deliberately NOT papered over with an id
 * that pretends to be stable — an id derived from a rotating token is exactly
 * the bug this design removes. The remedy is the one the settings card must
 * offer: a MANUAL MERGE, where the user marks two rows as one account and the
 * surviving record merges the other's keys. Nothing in this module guesses it.
 * A provider whose exchange always returns a uuid or an address never reaches
 * this case; only a credential stating neither does.
 *
 * A second, narrower case follows from the same rule and is worth stating
 * outright: matching requires a SHARED alias, so a sign-in that states only a
 * uuid and a later one that states only an address for the very same account are
 * two records. They become one the moment any single save states both — which is
 * why {@link identityKeysFor} collects everything a credential offers rather
 * than stopping at the first field it finds — and otherwise the same manual
 * merge applies.
 *
 * ---------------------------------------------------------------------------
 * STORAGE
 * ---------------------------------------------------------------------------
 *
 * Encryption is the platform's own and identical to the sibling provider lines:
 * Windows CurrentUser DPAPI (`<file>.dpapi`), the macOS login Keychain, and the
 * Linux Secret Service through `secret-tool`. There is no plaintext fallback — a
 * platform with none of the three throws rather than writing bearer tokens in
 * the clear. The plaintext JSON beside the encrypted file is only ever a
 * MIGRATION SOURCE: it is read once, written back encrypted, verified by
 * reading the ciphertext back, and only then deleted. A failed verification
 * throws and leaves the previous good data untouched.
 *
 * Mutations are serialised per absolute path, so a token refresh, a settings
 * save and a re-login cannot interleave into a read-modify-write that loses an
 * account.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import z from '@deepseek-ai/schemastery'
import { PROVIDER_ID } from './types.ts'
import { DEFAULT_VISIBLE_MODEL_IDS } from './model-catalog.ts'
import type { CredentialStore } from '../token-store.ts'
import { hasRegister, resolveSettingsNamespace, type SettingsScope } from '../common/settings-compat.ts'
import { mergeContextWindowOverrides, type ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { dshHomeDir } from '../common/home.ts'

/** Namespace the model settings live in when the harness still registers one. */
export const CLAUDE_PREFERENCES_NAMESPACE = 'dsh-claude'

/** Prefix of every internal account id. */
export const INTERNAL_ID_PREFIX = 'cl_'
/** Bytes of randomness behind an internal id — 10 bytes, 20 hex characters. */
const INTERNAL_ID_BYTES = 10
/** Hex characters of the refresh-token digest a `seed:` alias carries. */
const IDENTITY_SEED_LENGTH = 16
/** The OAuth scope that makes a credential a *subscription* credential. */
export const SUBSCRIPTION_INFERENCE_SCOPE = 'user:inference'
/** Revision of the on-disk credential document. */
export const CREDENTIAL_DOCUMENT_VERSION = 1

/** Shape every generated internal id has, so a hand-edited id is refused. */
const INTERNAL_ID_PATTERN = /^cl_[0-9a-f]{20}$/

/** Account facts the exchange states about the signed-in user. */
export interface ClaudeAccountInfo {
  /** Stable account uuid the exchange reports, when it reports one. */
  uuid?: string
  /** Account address, as the wire spells it. */
  email_address?: string
  /** The same address, as a hand-written credential spells it. */
  emailAddress?: string
}

/**
 * One stored subscription credential.
 *
 * `scopes` is not decoration: `user:inference` is what makes the token usable
 * against /v1/messages at all, so its absence means this is not a subscription
 * credential and is refused rather than tried. See
 * {@link isSubscriptionCredential}.
 */
export interface ClaudeCredentials {
  /** Bearer access token. Host-only; never sent to a browser. */
  accessToken: string
  /** Rotating refresh token. Host-only. */
  refreshToken: string
  /** Unix milliseconds the access token stops being valid. */
  expiresAt: number
  /** OAuth scopes the exchange granted. */
  scopes?: string[]
  /** Subscription tier the exchange reported, when it reported one. */
  subscriptionType?: string
  /** Account facts the exchange reported, when it reported any. */
  account?: ClaudeAccountInfo
}

/**
 * One account record in the credential document.
 *
 * The index signature is deliberate: a later chunk may hang its own fields on a
 * record (an alias, an added-at stamp, a primary flag), and a save from this
 * module must carry them through instead of silently dropping them. Nothing
 * here reads them.
 */
export interface ClaudeAccountRecord {
  /** Immutable routing key. See the module comment. */
  internalId: string
  /** Append-only alias set. Never empty in practice; see {@link mergeIdentityKeys}. */
  identityKeys: string[]
  credentials: ClaudeCredentials
  [key: string]: unknown
}

/** Whole credential file: every signed-in account, in insertion order. */
export interface ClaudeCredentialDocument {
  /** Format revision, so a later chunk can migrate without guessing. */
  version: number
  accounts: ClaudeAccountRecord[]
  [key: string]: unknown
}

/** Persisted model settings for this line. */
export interface ClaudeModelSettings {
  enabled?: boolean
  enabledModelIds: string[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: string | null
  /** Account pinned in the card, by {@link ClaudeAccountRecord.internalId}. */
  selectedAccountId: string | null
}

/**
 * One settings patch. `null` in an override map drops that override, and a
 * field left out keeps its stored value.
 */
export interface ClaudeSettingsPatch {
  enabled?: boolean
  enabledModelIds?: string[]
  /** `null` deletes one override and falls back to the catalog default. */
  contextWindowOverrides?: ContextWindowOverridePatch
  defaultReasoningEffort?: string | null
  selectedAccountId?: string | null
}

/** The preference surface the routes and the settings card talk to. */
export interface ClaudePreferenceStore {
  status(): ClaudeModelSettings
  update(patch: ClaudeSettingsPatch): Promise<ClaudeModelSettings>
}

const DEFAULT_ENABLED_MODEL_IDS: readonly string[] = [...DEFAULT_VISIBLE_MODEL_IDS]

/** A fresh settings document, with a copy of the default model list. */
export function defaultClaudeSettings(): ClaudeModelSettings {
  return {
    enabled: true,
    enabledModelIds: [...DEFAULT_ENABLED_MODEL_IDS],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    selectedAccountId: null,
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A trimmed, non-empty string, or nothing.
 *
 * Tokens are trimmed on the way in as well: a token copied out of a browser by
 * hand can carry a trailing newline, and storing that verbatim would make the
 * seed below differ for what is one credential.
 */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Mint an internal id. Called once per record; never derived from a token. */
export function createInternalId(): string {
  return INTERNAL_ID_PREFIX + randomBytes(INTERNAL_ID_BYTES).toString('hex')
}

/**
 * Whether a value has the shape of an internal id this module minted.
 *
 * A shape test for the settings card and for tests — NOT a gate on the stored
 * document, which keeps a foreign id verbatim rather than discarding the account
 * it names.
 */
export function isClaudeAccountId(value: unknown): value is string {
  return typeof value === 'string' && INTERNAL_ID_PATTERN.test(value)
}

/**
 * Whether a credential is a *subscription* credential.
 *
 * The exchange can hand back a token that authenticates but is not entitled to
 * the routes this provider exists to serve; `user:inference` is the scope that
 * separates the two, so its absence is a refusal rather than a retry.
 */
export function isSubscriptionCredential(credentials: Pick<ClaudeCredentials, 'scopes'>): boolean {
  return (credentials.scopes ?? []).includes(SUBSCRIPTION_INFERENCE_SCOPE)
}

/**
 * Aliases one credential states about its account.
 *
 * Order is deliberate — uuid, then address — because {@link mergeIdentityKeys}
 * appends in this order and a stable order keeps the stored file diffable. The
 * `seed:` fallback is emitted ONLY when neither of the other two exists: a
 * seed is not identity, it is a fingerprint of a token that rotates, and mixing
 * it into a set that already has real identity would add noise that changes on
 * every refresh.
 */
export function identityKeysFor(credentials: Pick<ClaudeCredentials, 'refreshToken' | 'account'>): string[] {
  const account = credentials.account
  const uuid = nonEmptyString(account?.uuid)?.toLowerCase()
  // The wire's own spelling wins, but an empty `email_address` must fall through to
  // `emailAddress` rather than swallowing it — `??` alone would not.
  const email = nonEmptyString(account?.email_address) ?? nonEmptyString(account?.emailAddress)
  const keys: string[] = []
  if (uuid !== undefined) keys.push('uuid:' + uuid)
  if (email !== undefined) keys.push('email:' + email.toLowerCase())
  if (keys.length === 0) keys.push('seed:' + seedFor(credentials.refreshToken))
  return keys
}

/**
 * Digest standing in for identity when a credential states none.
 *
 * Hashes the trimmed token so a copy-paste artifact cannot mint a second seed
 * for one credential. It still cannot survive a rotation — see the module
 * comment; that is the accepted limitation.
 */
function seedFor(refreshToken: string): string {
  const token = refreshToken.trim()
  return createHash('sha256').update(token).digest('hex').slice(0, IDENTITY_SEED_LENGTH)
}

/**
 * Union of two alias sets, existing first.
 *
 * Append-only in both directions: a key already present is kept where it is, a
 * new key is appended, and an exact duplicate is not repeated. Nothing is ever
 * removed — including a `seed:` a credential has since outgrown, because a user
 * who signs in with the same token again would otherwise get a ghost row.
 */
export function mergeIdentityKeys(existing: readonly string[], incoming: readonly string[]): string[] {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const key of [...existing, ...incoming]) {
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(key)
  }
  return merged
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  return nonEmptyString(value)
}

/**
 * Normalize a scopes value.
 *
 * RFC 6749 states `scope` as ONE space-delimited string, while an SDK wrapper
 * usually hands back the array; both are accepted and both become the array this
 * module stores, so the subscription test cannot be defeated by the encoding.
 */
function normalizeScopes(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\s+/).filter((scope) => scope !== '')
  if (Array.isArray(value)) {
    const scopes: string[] = []
    for (const entry of value) {
      if (typeof entry !== 'string') throw new Error('Claude credential scopes are invalid')
      const scope = entry.trim()
      if (scope !== '') scopes.push(scope)
    }
    return scopes
  }
  throw new Error('Claude credential scopes are invalid')
}

function parseAccountInfo(value: unknown): ClaudeAccountInfo | undefined {
  if (!isRecord(value)) return undefined
  const account: ClaudeAccountInfo = {}
  const uuid = optionalString(value, 'uuid')
  if (uuid !== undefined) account.uuid = uuid
  const email = optionalString(value, 'email_address')
  if (email !== undefined) account.email_address = email
  const emailAlias = optionalString(value, 'emailAddress')
  if (emailAlias !== undefined) account.emailAddress = emailAlias
  return Object.keys(account).length === 0 ? undefined : account
}

/**
 * Validate and normalize one credential, strictly.
 *
 * Every field is rebuilt from a validated value rather than carried over from
 * the input, so nothing a caller happens to attach — an `undefined`-valued key
 * among it — can make the encrypted write fail its own read-back comparison.
 * A wrong shape throws; nothing is guessed, and in particular a credential with
 * no `user:inference` scope is refused here (see {@link isSubscriptionCredential}).
 */
export function parseClaudeCredentials(value: unknown): ClaudeCredentials {
  if (!isRecord(value)) throw new Error('Claude credential payload is invalid')
  const accessToken = nonEmptyString(value.accessToken)
  if (accessToken === undefined) throw new Error('Claude credential is missing its access token')
  const refreshToken = nonEmptyString(value.refreshToken)
  if (refreshToken === undefined) throw new Error('Claude credential is missing its refresh token')
  const expiresAt = value.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new Error('Claude credential expiry is invalid')
  }
  const scopes = value.scopes === undefined || value.scopes === null ? [] : normalizeScopes(value.scopes)
  const credentials: ClaudeCredentials = { accessToken, refreshToken, expiresAt, scopes }
  const subscriptionType = optionalString(value, 'subscriptionType')
  if (subscriptionType !== undefined) credentials.subscriptionType = subscriptionType
  const account = parseAccountInfo(value.account)
  if (account !== undefined) credentials.account = account

  if (scopes.length === 0) {
    throw new Error(
      'Claude credential carries no OAuth scopes, so it is not a subscription '
      + 'credential (it must include ' + SUBSCRIPTION_INFERENCE_SCOPE + '). Sign in again to obtain one.',
    )
  }
  if (!isSubscriptionCredential(credentials)) {
    throw new Error(
      'Claude credential is not a subscription credential: its scopes ['
      + scopes.join(' ') + '] do not include ' + SUBSCRIPTION_INFERENCE_SCOPE + '. Sign in again to obtain one.',
    )
  }
  return credentials
}

function parseAccountRecord(value: unknown): ClaudeAccountRecord | null {
  if (!isRecord(value)) return null
  let credentials: ClaudeCredentials
  try {
    credentials = parseClaudeCredentials(value.credentials)
  } catch {
    // One unreadable record is dropped rather than failing the whole document:
    // a document whose parse throws reports "not signed in" for every account in
    // it, so a single damaged row would take the whole line offline.
    return null
  }
  const identityKeys: string[] = []
  if (Array.isArray(value.identityKeys)) {
    for (const key of value.identityKeys) {
      const normalized = nonEmptyString(key)
      if (normalized !== undefined) identityKeys.push(normalized)
    }
  }
  // A record with no id at all is the one shape that is still repaired rather
  // than dropped: it states no way to address it, so it would be lost forever.
  // One is minted here, which makes this parse non-idempotent for that record
  // alone — the id it mints is what the next save persists. A foreign id from
  // another writer is kept verbatim, because dropping it would lose an account
  // this module can neither address nor reconstruct.
  const internalId = nonEmptyString(value.internalId) ?? createInternalId()
  // The spread carries whatever a later chunk added to the record through a save
  // unchanged. It is safe here in a way it is not in the credential parse above:
  // this value came out of JSON, so it can hold no `undefined` that would
  // vanish on the way back and fail the read-back comparison.
  return { ...value, internalId, identityKeys, credentials }
}

/**
 * Validate one whole credential document, migrating the pre-two-layer shape.
 *
 * A bare credential object — one token pair, no account envelope — is what an
 * earlier build wrote, and it is accepted as a one-account document so an
 * existing sign-in survives the upgrade instead of forcing a re-login. The
 * record it becomes is minted an internal id right here, at the moment it is
 * first read.
 */
export function parseClaudeCredentialDocument(value: unknown): ClaudeCredentialDocument {
  if (!isRecord(value)) throw new Error('Claude credential file payload is invalid')
  if (!Array.isArray(value.accounts)) {
    if (value.accessToken !== undefined || value.refreshToken !== undefined) {
      const credentials = parseClaudeCredentials(value)
      return {
        version: CREDENTIAL_DOCUMENT_VERSION,
        accounts: [{ internalId: createInternalId(), identityKeys: identityKeysFor(credentials), credentials }],
      }
    }
    throw new Error('Claude credential file payload is invalid')
  }
  const accounts: ClaudeAccountRecord[] = []
  const seen = new Set<string>()
  for (const entry of value.accounts) {
    const record = parseAccountRecord(entry)
    if (record === null) continue
    // Two records sharing an internal id are one record by definition, so the
    // second is a duplicate of a corrupted file rather than an account being
    // lost; the first copy wins.
    if (seen.has(record.internalId)) continue
    seen.add(record.internalId)
    accounts.push(record)
  }
  const version = typeof value.version === 'number' && Number.isFinite(value.version)
    ? value.version
    : CREDENTIAL_DOCUMENT_VERSION
  // Spread before overriding, for the same reason as the record above.
  return { ...value, version, accounts }
}

/**
 * Validate one settings document.
 *
 * Unlike the credential parse this one is lenient by design: settings are
 * preferences, and a hand-edited or half-written value must degrade to the
 * shipped default for that one field instead of unlinking the user's model
 * choice entirely. Being lenient is also what lets a document written by an
 * EARLIER build keep working: this reader picks the fields it knows and ignores
 * every other key rather than rejecting the document for stating one, so a file
 * still carrying a key this build no longer has is read successfully and every
 * field it does have survives. Rejecting unknown keys here would answer "not
 * signed in" for a user whose model selection is sitting intact on disk.
 * The settings route's zod schema has the same property for its own store:
 * schemastery strips undeclared keys instead of failing on them.
 */
export function parseClaudeModelSettings(value: unknown): ClaudeModelSettings {
  const record = isRecord(value) ? value : {}
  const defaults = defaultClaudeSettings()
  const enabledModelIds = Array.isArray(record.enabledModelIds)
    ? record.enabledModelIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    : defaults.enabledModelIds
  const contextWindowOverrides: Record<string, number> = {}
  if (isRecord(record.contextWindowOverrides)) {
    for (const [model, window] of Object.entries(record.contextWindowOverrides)) {
      if (typeof window === 'number' && Number.isFinite(window) && window > 0) contextWindowOverrides[model] = window
    }
  }
  const defaultReasoningEffort = nonEmptyString(record.defaultReasoningEffort) ?? null
  const selectedAccountId = nonEmptyString(record.selectedAccountId) ?? null
  return {
    enabled: record.enabled !== false,
    enabledModelIds,
    contextWindowOverrides,
    defaultReasoningEffort,
    selectedAccountId,
  }
}

/** Merge one patch over a settings document, applying the override semantics. */
function mergeClaudeSettings(current: ClaudeModelSettings, patch: ClaudeSettingsPatch): ClaudeModelSettings {
  return {
    enabled: patch.enabled !== undefined ? patch.enabled : (current.enabled !== false),
    enabledModelIds: patch.enabledModelIds !== undefined ? [...patch.enabledModelIds] : current.enabledModelIds,
    contextWindowOverrides: patch.contextWindowOverrides !== undefined
      ? mergeContextWindowOverrides(current.contextWindowOverrides, patch.contextWindowOverrides)
      : current.contextWindowOverrides,
    defaultReasoningEffort: patch.defaultReasoningEffort !== undefined
      ? patch.defaultReasoningEffort
      : current.defaultReasoningEffort,
    selectedAccountId: patch.selectedAccountId !== undefined ? patch.selectedAccountId : current.selectedAccountId,
  }
}

// ---------------------------------------------------------------------------
// Paths and platform backends
// ---------------------------------------------------------------------------

export function credentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'claude-credentials.json')
}

export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'claude-models.json')
}

function credentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

/**
 * The encrypted store this platform has, or a refusal.
 *
 * The same three-way choice as every sibling line, keyed on the same provider id
 * so the Keychain/Secret Service entry is named after the line that owns it.
 * There is deliberately no fourth branch: an unsupported platform gets a thrown
 * error rather than a plaintext file holding bearer tokens.
 */
function createCredentialBackend(filePath: string): CredentialStore<ClaudeCredentialDocument> {
  if (process.platform === 'win32') {
    return new WindowsDpapiCredentialStore(filePath + '.dpapi', parseClaudeCredentialDocument)
  }
  if (process.platform === 'darwin') {
    return new MacKeychainCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseClaudeCredentialDocument)
  }
  if (process.platform === 'linux') {
    return new SecretServiceCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseClaudeCredentialDocument)
  }
  throw new Error('Claude subscription credential storage requires Windows, macOS, or Linux.')
}

// Refresh, re-login and settings reads share migration ordering per path.
const credentialOperations = new Map<string, Promise<void>>()
const settingsOperations = new Map<string, Promise<void>>()

/** Queue one mutation behind the last one for the same absolute path. */
function serializeOn<T>(operations: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
  const result = (operations.get(key) || Promise.resolve()).then(operation)
  const settled = result.then(() => undefined, () => undefined)
  operations.set(key, settled)
  void settled.then(() => {
    if (operations.get(key) === settled) operations.delete(key)
  })
  return result
}

// ---------------------------------------------------------------------------
// Credential store
// ---------------------------------------------------------------------------

/**
 * Encrypted credential store; the plaintext JSON is only a migration source.
 *
 * Every mutation goes through {@link saveVerified}: encrypt, read the ciphertext
 * back, compare, and only then remove the plaintext. A verification failure
 * throws and leaves both the ciphertext and the plaintext as they were, so the
 * previous good data is never destroyed by a failed write.
 */
export class FileCredentialStore {
  constructor(
    private readonly filePath = credentialPath(),
    private readonly backend: CredentialStore<ClaudeCredentialDocument> = createCredentialBackend(filePath),
  ) {}

  /** Human-readable location, in the form the settings card reports it. */
  path(): string {
    if (process.platform === 'win32') return this.filePath + '.dpapi'
    const kind = process.platform === 'darwin' ? 'Keychain' : 'Secret Service'
    return kind + ': ' + PROVIDER_ID + '/' + credentialAccount(this.filePath)
  }

  /**
   * Test seam and extension point: the one place an id is minted.
   *
   * Overridable so a test can make the id deterministic without reaching into
   * the randomness, and so a later chunk can mint ids through the same path.
   */
  protected createAccountId(): string {
    return createInternalId()
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    return serializeOn(credentialOperations, path.resolve(this.filePath), operation)
  }

  private async removeLegacy(): Promise<void> {
    try {
      await fs.unlink(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Claude legacy credential removal failed')
      }
    }
  }

  private async saveVerified(document: ClaudeCredentialDocument): Promise<ClaudeCredentialDocument> {
    // Canonicalize before encrypting: what is stored is exactly what the read
    // path will reconstruct, which is what makes the comparison below meaningful.
    const canonical = parseClaudeCredentialDocument(document)
    await this.backend.save(canonical)
    const restored = await this.backend.load()
    if (!isDeepStrictEqual(restored, canonical)) {
      throw new Error('Claude encrypted credential verification failed')
    }
    await this.removeLegacy()
    return canonical
  }

  /** Unserialized body shared by {@link read} and the mutations above it. */
  private async readDocument(): Promise<ClaudeCredentialDocument | null> {
    // A damaged or locked secure store must never fall back to stale plaintext.
    const current = await this.backend.load()
    if (current !== null) {
      await this.removeLegacy()
      // Parsed again even though a production backend validates on its own way
      // out: a record this store will act on must have passed THIS parse, so the
      // guarantees above cannot depend on which backend was injected. An
      // already-valid document is unchanged by a second pass, and a record with
      // no id at all is the one repair that happens here — see
      // {@link parseAccountRecord}.
      return parseClaudeCredentialDocument(current)
    }
    let legacy: string
    try {
      const stats = await fs.lstat(this.filePath)
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Invalid credential file')
      if (process.getuid && stats.uid !== process.getuid()) throw new Error('Invalid credential owner')
      if (process.platform !== 'win32') await fs.chmod(this.filePath, 0o600)
      legacy = await fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('Claude legacy credential read failed')
    }
    let document: ClaudeCredentialDocument
    try {
      document = parseClaudeCredentialDocument(JSON.parse(legacy) as unknown)
    } catch {
      throw new Error('Claude legacy credential payload is invalid')
    }
    return this.saveVerified(document)
  }

  read(): Promise<ClaudeCredentialDocument | null> {
    return this.serialize(() => this.readDocument())
  }

  async listAccounts(): Promise<ClaudeAccountRecord[]> {
    return (await this.read())?.accounts ?? []
  }

  /**
   * Store one credential, merging it into the account it belongs to.
   *
   * The merge is the whole point of the two-layer design: the same account
   * saving a SECOND, rotated refresh token is matched by the uuid or address
   * alias it still carries, so it updates the existing record — same
   * `internalId`, union of aliases — instead of adding a ghost row. Pass
   * `options.internalId` to address a record directly; that is what a re-login
   * whose token states no identity uses, and it is the only way to fold such a
   * credential onto a record the user picked by hand.
   */
  saveAccount(
    credentials: ClaudeCredentials,
    options: { internalId?: string } = {},
  ): Promise<ClaudeAccountRecord> {
    return this.serialize(async () => {
      const parsed = parseClaudeCredentials(credentials)
      const keys = identityKeysFor(parsed)
      const explicitId = options.internalId === undefined ? undefined : nonEmptyString(options.internalId)
      if (options.internalId !== undefined && explicitId === undefined) {
        throw new Error('Claude account id is invalid')
      }
      const existing = await this.readDocument()
      const accounts = existing === null ? [] : [...existing.accounts]
      const index = explicitId !== undefined
        ? accounts.findIndex((account) => account.internalId === explicitId)
        : accounts.findIndex((account) => account.identityKeys.some((key) => keys.includes(key)))

      let internalId: string
      if (index === -1) {
        internalId = explicitId ?? this.createAccountId()
        accounts.push({ internalId, identityKeys: keys, credentials: parsed })
      } else {
        const prior = accounts[index] as ClaudeAccountRecord
        // The prior record is spread first so anything a later chunk hung on it
        // (alias, timestamps) survives a token refresh untouched.
        internalId = prior.internalId
        accounts[index] = {
          ...prior,
          internalId: prior.internalId,
          identityKeys: mergeIdentityKeys(prior.identityKeys, keys),
          credentials: parsed,
        }
      }

      const saved = await this.saveVerified({
        ...(existing ?? {}),
        version: existing?.version ?? CREDENTIAL_DOCUMENT_VERSION,
        accounts,
      })
      const record = saved.accounts.find((account) => account.internalId === internalId)
      if (record === undefined) throw new Error('Claude account record was not persisted')
      return record
    })
  }

  write(document: ClaudeCredentialDocument): Promise<void> {
    return this.serialize(async () => {
      await this.saveVerified(document)
    })
  }

  delete(): Promise<void> {
    return this.serialize(async () => {
      // Remove the migration source first so a failed logout cannot resurrect it.
      await this.removeLegacy()
      await this.backend.clear()
    })
  }

  /** Drop exactly one account, by its immutable id. Returns whether it existed. */
  deleteAccount(internalId: string): Promise<boolean> {
    return this.serialize(async () => {
      const existing = await this.readDocument()
      if (existing === null) return false
      const accounts = existing.accounts.filter((account) => account.internalId !== internalId)
      if (accounts.length === existing.accounts.length) return false
      if (accounts.length === 0) {
        // Nothing left to be signed in as: clear rather than leave an empty shell.
        await this.removeLegacy()
        await this.backend.clear()
        return true
      }
      await this.saveVerified({ ...existing, accounts })
      return true
    })
  }
}

// ---------------------------------------------------------------------------
// Model settings
// ---------------------------------------------------------------------------

/** Plain-JSON model settings used when the settings service is unavailable. */
export class FileModelSettingsStore {
  constructor(private readonly filePath = modelSettingsPath()) {}

  path(): string {
    return this.filePath
  }

  async read(): Promise<ClaudeModelSettings> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8')
      return parseClaudeModelSettings(JSON.parse(content) as unknown)
    } catch {
      // A missing or unreadable settings file falls back to the shipped defaults.
      return defaultClaudeSettings()
    }
  }

  async write(settings: ClaudeModelSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = this.filePath + '.tmp.' + Date.now()
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8')
    // tmp + rename: a reader never observes a half-written document, and a
    // failed write cannot truncate the settings it was replacing.
    await fs.rename(tmp, this.filePath)
  }

  /**
   * Read-modify-write under the same per-path lock the credentials use.
   *
   * Without it two patches landing together each read the same document and the
   * second write silently discards the first — a lost model selection, with no
   * error anywhere.
   */
  updateSettings(patch: ClaudeSettingsPatch): Promise<ClaudeModelSettings> {
    return serializeOn(settingsOperations, path.resolve(this.filePath), async () => {
      const next = mergeClaudeSettings(await this.read(), patch)
      await this.write(next)
      return next
    })
  }
}

/**
 * Bind the model selection to the DSH settings document when the harness still
 * offers one, and to the JSON file beside the credentials otherwise: a harness
 * without the register seam (0.1.7, and a headless test) reads that file back on
 * boot.
 */
export function registerClaudePreferenceStore(
  settings?: unknown,
  fallbackStore = new FileModelSettingsStore(),
): ClaudePreferenceStore {
  if (!hasRegister(settings)) {
    // With no settings namespace to persist in, the JSON file beside the
    // credentials is the store. It is read once here, so a selection saved by an
    // earlier run is still the selection on the next boot.
    let snapshot: ClaudeModelSettings = defaultClaudeSettings()
    void fallbackStore.read().then((stored) => { snapshot = stored }).catch(() => undefined)
    return {
      status: () => snapshot,
      update: async (patch) => {
        snapshot = await fallbackStore.updateSettings(patch)
        return snapshot
      },
    }
  }

  const scope = settings.register(resolveSettingsNamespace(CLAUDE_PREFERENCES_NAMESPACE), z.object({
    enabled: z.boolean().default(true),
    enabledModelIds: z.array(z.string()).default([...DEFAULT_ENABLED_MODEL_IDS]),
    contextWindowOverrides: z.dict(z.number()).default({}),
    defaultReasoningEffort: z.union([z.string(), z.const(null)]).default(null),
    selectedAccountId: z.union([z.string(), z.const(null)]).default(null),
  })) as SettingsScope<{
    enabled: boolean
    enabledModelIds: string[]
    contextWindowOverrides: Record<string, number>
    defaultReasoningEffort: string | null
    selectedAccountId: string | null
  }>

  return {
    status: () => {
      const value = scope.get()
      return {
        enabled: value.enabled !== false,
        enabledModelIds: value.enabledModelIds,
        contextWindowOverrides: value.contextWindowOverrides,
        defaultReasoningEffort: value.defaultReasoningEffort,
        selectedAccountId: value.selectedAccountId ?? null,
      }
    },
    update: async (patch) => {
      // Read once: two reads of a live scope could straddle a write from another
      // subscriber, and merging against the second while persisting the first is
      // exactly the lost update this store exists to avoid.
      const current = parseClaudeModelSettings(scope.get())
      const normalized = mergeClaudeSettings(current, patch)
      await scope.update(normalized)
      // Mirror into the file as well, so a later run on a harness that dropped
      // the register seam still finds the selection the user made.
      void fallbackStore.updateSettings(patch).catch(() => undefined)
      return normalized
    },
  }
}
