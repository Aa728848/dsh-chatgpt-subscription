/**
 * Credential storage for the MiniMax Code line.
 *
 * Unlike every other line in this package, this one does not own its credential
 * format: MiniMax Code itself keeps the signed-in session in
 * `~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`, and the whole
 * point of reusing it is that a user who is already signed in to the desktop app
 * does not sign in again here.
 *
 * That sharing is the design constraint:
 *
 * 1. READ-ONLY FIRST. Every call reads the file and uses the stored token when it
 *    is still valid; the plugin never rotates a credential it does not have to.
 * 2. WRITE-BACK IS ATOMIC. A rotated token replaces the file through a temporary
 *    file plus `rename`, so a failed or interrupted refresh leaves the previous
 *    `auth.json` byte-for-byte intact — the requirement the brief states at
 *    section 2.6.4.
 * 3. NO LOCK IS TAKEN. MiniMax Code holds `auth.lock` while it refreshes, and a
 *    second process must not create, delete or wait on that file: doing so could
 *    break the app's own refresh. Atomic replacement is what makes lock-free
 *    sharing safe instead — a reader sees either the whole old file or the whole
 *    new one, never a half-written one, and the record's key is preserved so the
 *    app finds its own entry where it left it.
 * 4. THE SHAPE IS PRESERVED. `schemaVersion` and every other record in
 *    `records` survive a write untouched; only the `mcode-public` record and the
 *    matching `auth-state.json` fields change.
 *
 * A credential this plugin obtained itself (device-code login with no native file
 * present) is kept in the plugin's own store under `$DSH_HOME/storages`, so the
 * two provenances never overwrite each other.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import z from '@deepseek-ai/schemastery'
import { dshHomeDir } from '../common/home.ts'
import {
  CREDENTIAL_ROTATION_WAIT_MS,
  MINIMAX_CODE_BUILD_ENV,
  MINIMAX_CODE_CLIENT_ID,
  PRE_EXPIRY_REFRESH_MS,
  REFRESH_MARGIN_MS,
} from './types.ts'
import { hasRegister, resolveSettingsNamespace, type SettingsScope } from '../common/settings-compat.ts'
import { mergeContextWindowOverrides, type ContextWindowOverridePatch } from '../common/context-window-overrides.ts'
import { MINIMAX_CODE_REASONING_EFFORTS } from '../../shared/minimax-code-contracts.ts'
import type { MinimaxCodeReasoningEffort, MinimaxCodeRegion } from '../../shared/minimax-code-contracts.ts'
import { minimaxCodeModelIds } from './model-catalog.ts'

/** Where the credential and the token came from. */
export type MinimaxCodeCredentialSource = 'minimax-native' | 'file'

/**
 * One MiniMax Code subscription credential.
 *
 * Field names follow `auth.json` exactly; nothing is renamed on the way in or
 * out, so a round trip cannot lose a field the desktop app depends on.
 */
export interface MinimaxCodeCredentials {
  /** Bearer access token for the agent API. Host-only; never sent to a browser. */
  accessToken: string
  /** Rotating refresh token. Host-only. */
  refreshToken: string
  /** Always "Bearer" in the measured file; kept verbatim. */
  tokenType: string
  /** Public client the record belongs to. */
  clientId: string
  /** Scopes the token was issued for. */
  scopes: string[]
  /** Audience the token was issued for. */
  audience: string
  /** Unix milliseconds the access token stops being valid. */
  expiresAtMs: number
  /** Rotations the credential has been through; incremented on every refresh. */
  generation: number
  /** Identity of the sign-in that produced the credential. */
  loginEpoch: string
  /** Build environment segment of the path the credential lives under. */
  buildEnv: string
  /** Region the credential was issued in. */
  region: MinimaxCodeRegion
  /** Record key inside `auth.json`, preserved verbatim so a write lands in place. */
  recordKey: string | null
  /** Whether this credential is the desktop app's file or the plugin's own. */
  source: MinimaxCodeCredentialSource
  /** Unix milliseconds this plugin read or wrote the credential. */
  seenAt?: number
}

/** The MiniMax home directory: the desktop app's data root. */
export function minimaxHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.MINIMAX_HOME || '').trim()
  if (override !== '') return override
  return path.join(os.homedir(), '.minimax')
}

/** Directory holding one region's auth files. */
export function authDirFor(region: MinimaxCodeRegion, buildEnv: string = MINIMAX_CODE_BUILD_ENV): string {
  return path.join(minimaxHomeDir(), 'auth', buildEnv, region, MINIMAX_CODE_CLIENT_ID)
}

/** Path of the desktop app's credential file for one region. */
export function authJsonPath(region: MinimaxCodeRegion, buildEnv: string = MINIMAX_CODE_BUILD_ENV): string {
  return path.join(authDirFor(region, buildEnv), 'auth.json')
}

/** Path of the desktop app's non-secret state file for one region. */
export function authStateJsonPath(region: MinimaxCodeRegion, buildEnv: string = MINIMAX_CODE_BUILD_ENV): string {
  return path.join(authDirFor(region, buildEnv), 'auth-state.json')
}

/** Path of the plugin's own credential file, used when no native file exists. */
export function pluginCredentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'minimax-code-credentials.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Validate and normalize one stored credential.
 *
 * A payload that is missing a token or an expiry is rejected rather than
 * defaulted: a credential with an invented expiry would be presented to the
 * service as valid when it is not, which is exactly the failure the refresh path
 * exists to prevent.
 */
export function parseMinimaxCodeCredentials(
  value: unknown,
  fallback: {
    region: MinimaxCodeRegion
    buildEnv?: string
    recordKey?: string | null
    source?: MinimaxCodeCredentialSource
  },
): MinimaxCodeCredentials {
  if (!isRecord(value)) throw new Error('MiniMax Code credential payload is invalid')
  const accessToken = asString(value.accessToken)
  if (accessToken === undefined) throw new Error('MiniMax Code credential is missing its access token')
  const refreshToken = asString(value.refreshToken)
  if (refreshToken === undefined) throw new Error('MiniMax Code credential is missing its refresh token')
  const expiresAtMs = asFiniteNumber(value.expiresAtMs)
  if (expiresAtMs === undefined) throw new Error('MiniMax Code credential expiry is invalid')
  return {
    accessToken,
    refreshToken,
    tokenType: asString(value.tokenType) ?? 'Bearer',
    clientId: asString(value.clientId) ?? MINIMAX_CODE_CLIENT_ID,
    scopes: asStringArray(value.scopes),
    audience: asString(value.audience) ?? '',
    expiresAtMs,
    generation: asFiniteNumber(value.generation) ?? 0,
    loginEpoch: asString(value.loginEpoch) ?? '',
    buildEnv: fallback.buildEnv ?? MINIMAX_CODE_BUILD_ENV,
    // The record's own region wins over the caller's default. The region decides
    // every host a request goes to, and a credential signed in through the global
    // flow must be read back as global: a caller-side default would silently
    // redirect that account at the mainland endpoints. The record is authoritative
    // because the file the plugin keeps holds exactly one credential, while the
    // caller's value is only ever the path it happened to look in.
    region: isRegion(value.region) ? value.region : fallback.region,
    recordKey: fallback.recordKey ?? null,
    source: fallback.source ?? 'file',
  }
}

/** Whether one value is a region this line understands. */
function isRegion(value: unknown): value is MinimaxCodeRegion {
  return value === 'cn' || value === 'global'
}

/** Whether a credential is valid for long enough to use as-is. */
export function credentialIsFresh(
  credentials: MinimaxCodeCredentials,
  now: number = Date.now(),
): boolean {
  return credentials.expiresAtMs - now > REFRESH_MARGIN_MS
}

/**
 * Whether a credential should be renewed BEFORE it can be refused.
 *
 * {@link credentialIsFresh} answers "can this token be presented right now"; this
 * answers "is it worth rotating on this plugin's own schedule instead of waiting
 * for the service to say no". The two questions need different answers: the whole
 * one-hour sign-out was the second question being answered with the first, so the
 * line only ever rotated inside the last sixty seconds of a sixty-minute token —
 * exactly the window in which concurrent callers spend the same rotating refresh
 * token, and exactly the window in which a request can already be refused.
 *
 * The desktop app reads the same file and remains the first authority for it: this
 * plugin renews a few minutes early, writes the rotation back atomically, and
 * never touches the app's own `auth.lock`.
 */
export function credentialNeedsRefresh(
  credentials: MinimaxCodeCredentials,
  now: number = Date.now(),
): boolean {
  return credentials.expiresAtMs - now <= PRE_EXPIRY_REFRESH_MS
}

/**
 * Write one file through a temporary sibling plus `rename`.
 *
 * The temporary file is created in the same directory so the rename stays on one
 * volume, which is what makes it atomic. A failed write removes the temporary and
 * leaves the destination untouched.
 */
async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = filePath + '.dsh-tmp-' + process.pid + '-' + Date.now()
  try {
    await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
    // No sidecar copy is kept. The destination may be MiniMax Code's own
    // directory, and this plugin must not leave a second copy of a live
    // credential (or of the app's document shape) beside the one the app owns;
    // the atomic rename below already guarantees the previous file survives
    // intact until the replacement is complete, which is the property a backup
    // would have been there for.
    await fs.rename(temporary, filePath)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw new Error(
      'MiniMax Code credential write failed; the previous file was left untouched ('
      + (error instanceof Error ? error.message : String(error)) + ')',
    )
  }
}

// Reads, writes and refreshes of one file share an ordering, so a refresh that
// lands while a status read is in flight cannot interleave a stale value back in.
const fileOperations = new Map<string, Promise<void>>()

function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(key)
  const result = (fileOperations.get(resolved) || Promise.resolve()).then(operation)
  const settled = result.then(() => undefined, () => undefined)
  fileOperations.set(resolved, settled)
  void settled.then(() => {
    if (fileOperations.get(resolved) === settled) fileOperations.delete(resolved)
  })
  return result
}

// ---------------------------------------------------------------------------
// Rotation registry
// ---------------------------------------------------------------------------

/**
 * One rotation a holder of a credential is performing RIGHT NOW.
 *
 * The registry is process-wide and keyed by credential IDENTITY rather than by
 * file path: the pool and the usage path reach the very same file through different
 * MinimaxCodeCredentialStore objects, and a path-keyed registry would let them race
 * each other.
 *
 * A rotation the DESKTOP APP performs is not claimed here — it is another process,
 * and its only observable act is the atomic replace of its own `auth.json`. That
 * case is handled by re-reading the file, which is where the app's result is. This
 * registry never creates, deletes or waits on the app's own `auth.lock`.
 */
interface RotationRecord {
  /** Refresh token being spent. A credential carrying a different one wins. */
  token: string
  /** Expiry the rotation seeks to beat; a materially later one ends the wait. */
  expiresAtMs: number
  /** The in-process rotation, when THIS process started one. */
  promise: Promise<MinimaxCodeCredentials> | null
}

const rotations = new Map<string, RotationRecord>()

/**
 * The credential the most recent storage read produced, and when.
 *
 * The store is read on every request, and on Windows each uncached read spawns
 * DPAPI - so the reads a single turn performs are served from here. Correctness
 * rests on one property the write path enforces: a rotation is written back
 * BEFORE its caller is handed the credential, and every write lands in the same
 * `fileOperations` chain this snapshot is filled from. A cached value therefore
 * can never outlive a write - it is either the current credential or one the very
 * next write replaces.
 *
 * The window is short for the opposite kind of risk: another process (the desktop
 * app) rotates the same file on its own schedule, and this snapshot must not hide
 * that for long.
 */
const RECENT_READ_WINDOW_MS = 1_500
let recentRead: { at: number; path: string; credentials: MinimaxCodeCredentials | null } | null = null

function rememberCredentialRead(filePath: string, credentials: MinimaxCodeCredentials | null): void {
  recentRead = { at: Date.now(), path: path.resolve(filePath), credentials }
}

/**
 * The credential a read of THIS file inside the window produced, if any.
 *
 * The file is part of the key because a store whose path no longer matches what the
 * snapshot was taken from has nothing to do with it: one process can hold several
 * stores, and the tests point each case at a fresh temporary home.
 */
function recentCredentialRead(filePath: string): MinimaxCodeCredentials | null {
  if (recentRead === null) return null
  if (recentRead.path !== path.resolve(filePath) || Date.now() - recentRead.at > RECENT_READ_WINDOW_MS) {
    recentRead = null
    return null
  }
  return recentRead.credentials
}

/** Test seam: forget the snapshot, so one case cannot observe another's read. */
export function resetMinimaxCodeCredentialReads(): void {
  recentRead = null
  rotations.clear()
}

/**
 * Identity one credential rotation is registered under.
 *
 * Built from the same facts {@link minimaxCodePoolIdentity} uses - a native
 * record slot, or the sign-in that produced the credential - so every holder of
 * one session agrees on the key. The region is part of it because the same record
 * key in two regions is two different sessions.
 */
function rotationKey(credentials: MinimaxCodeCredentials): string {
  if (credentials.recordKey !== null && credentials.recordKey !== '') {
    return 'native:' + credentials.region + ':' + credentials.recordKey
  }
  if (credentials.loginEpoch !== '') return 'signin:' + credentials.region + ':' + credentials.loginEpoch
  return 'token:' + credentials.refreshToken
}

/**
 * Whether two credentials are two generations of ONE session.
 *
 * The file this line reads holds a single record, but the plugin's own file is a
 * mirror that the pool writes for whichever account is primary — so a credential
 * read from storage may belong to a completely different account than the one a
 * caller is working on. Adopting a stranger's token would present one account's
 * session as another's, which is the one mistake this whole line must never make.
 *
 * The identity is therefore the same one {@link rotationKey} uses: a native record
 * slot, or the sign-in that produced a plugin-owned credential.
 */
export function minimaxCodeSameCredentialSession(
  a: MinimaxCodeCredentials | null,
  b: MinimaxCodeCredentials | null,
): boolean {
  if (a === null || b === null) return false
  if (a.source !== b.source || a.region !== b.region) return false
  if (a.recordKey !== b.recordKey) return false
  if (a.recordKey === null || a.recordKey === '') return a.loginEpoch === b.loginEpoch
  return true
}

/**
 * Whether one credential is a LATER state of another.
 *
 * The generation is the desktop app's own rotation counter and the expiry moves
 * forward with every rotation, so either being greater means the candidate is the
 * result of a rotation the baseline predates. This is also what stops a stale copy
 * from rolling a newer state back: a pool row the mirror could not write must never
 * overwrite a fresh file.
 */
export function minimaxCodeCredentialAdvancedPast(
  candidate: MinimaxCodeCredentials | null,
  baseline: MinimaxCodeCredentials,
): boolean {
  if (candidate === null) return false
  if (candidate.refreshToken !== baseline.refreshToken) {
    return candidate.generation > baseline.generation || candidate.expiresAtMs > baseline.expiresAtMs
  }
  // The SAME refresh token: nothing rotated, so the only question left is whether
  // this credential was renewed — that is, whether its expiry moved materially
  // forward. The tolerance is what separates a renewal (a fresh full lifetime from
  // now) from the same record observed again a moment later, which must not count
  // as progress: treating it as such would let a re-read "heal" an account whose
  // refresh token really was refused.
  return candidate.expiresAtMs > baseline.expiresAtMs + SAME_TOKEN_ADVANCE_TOLERANCE_MS
}

/**
 * How much later an expiry must be, with an unchanged refresh token, to count as a
 * renewal rather than the same credential read twice.
 */
const SAME_TOKEN_ADVANCE_TOLERANCE_MS = 60_000

/** Sleep, honouring an abort signal. */
function rotationSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    // The listener is removed on every path: a rotation can poll for the whole wait
    // window, and a listener per poll on one long-lived signal would accumulate.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Rotate one credential, or adopt the rotation somebody else is doing.
 *
 * The distinction matters: a caller that ADOPTED a result must use the credential
 * that comes back, because the winner replaced the whole record.
 */
export async function rotateMinimaxCodeCredential(
  store: MinimaxCodeCredentialStore,
  credentials: MinimaxCodeCredentials,
  perform: () => Promise<MinimaxCodeCredentials>,
  options: { signal?: AbortSignal } = {},
): Promise<{ credentials: MinimaxCodeCredentials; adopted: boolean }> {
  const key = rotationKey(credentials)
  const seen = credentials.refreshToken
  const deadline = Date.now() + CREDENTIAL_ROTATION_WAIT_MS

  // Another holder of this very token is rotating it right now. Join or wait:
  // spending it again is what turns a successful refresh into a false expiration.
  while (true) {
    const active = rotations.get(key)
    if (active === undefined) break
    if (active.promise !== null) {
      if (active.token === seen) {
        // This process is rotating the very token this caller was about to spend:
        // join it rather than racing it.
        return { credentials: await active.promise, adopted: true }
      }
      // A rotation of a LATER credential of this same session is running, so the
      // token in hand is already spent. Waiting for that rotation and adopting its
      // result is the only correct move.
      await active.promise.catch(() => undefined)
      break
    }
    // No in-process promise to join: the desktop app is rotating its own file, and
    // re-reading it is the only observation available. Adopting the app's result is
    // the whole point of waiting - spending this token would be a duplicate.
    const current = await store.readFresh().catch(() => null)
    if (minimaxCodeSameCredentialSession(current, credentials)
      && minimaxCodeCredentialAdvancedPast(current, credentials)) {
      return { credentials: current as MinimaxCodeCredentials, adopted: true }
    }
    if (Date.now() >= deadline) break
    await rotationSleep(200, options.signal)
  }

  // Even with no registry entry, the file may already hold a newer credential of
  // THIS session - the desktop app rotates its own session on its own schedule.
  // The session check is load-bearing: the plugin's own file mirrors whichever
  // pooled account is primary, so "newer" alone could mean "a different account".
  const latest = await store.readFresh().catch(() => null)
  if (minimaxCodeSameCredentialSession(latest, credentials)
    && minimaxCodeCredentialAdvancedPast(latest, credentials)) {
    return { credentials: latest as MinimaxCodeCredentials, adopted: true }
  }

  const record: RotationRecord = {
    token: seen,
    expiresAtMs: credentials.expiresAtMs,
    promise: null,
  }
  const pending = (async (): Promise<MinimaxCodeCredentials> => {
    // Claim the slot BEFORE the network call. The service spends the refresh token
    // during that call, so from the first request byte onward any other caller that
    // arrives is holding a token that is already gone — and it must find this entry
    // rather than start a rotation of its own.
    rotations.set(key, record)
    try {
      const next = await perform()
      // A FINAL verdict may still have been about a token somebody else rotated
      // away while this call was in flight, and that somebody may be the desktop
      // app — whose only trace is its own file. Storage is asked before the verdict
      // is believed, because the two possibilities are indistinguishable from the
      // response itself.
      const settled = await store.readFresh().catch(() => null)
      if (minimaxCodeSameCredentialSession(settled, credentials)
        && minimaxCodeCredentialAdvancedPast(settled, credentials)) {
        return settled as MinimaxCodeCredentials
      }
      // The rotation must know where to write itself back. A caller that produced
      // a credential without provenance is repaired from the credential the
      // rotation was started from, rather than letting the store guess a target.
      const rotated: MinimaxCodeCredentials =
        next.source === credentials.source && next.recordKey === credentials.recordKey
          ? next
          : { ...next, source: credentials.source, recordKey: credentials.recordKey, buildEnv: credentials.buildEnv }
      await store.write(rotated)
      // The entry stays in the registry until the write is on disk, so a caller
      // that observes it waits instead of spending the token this rotation just
      // replaced. A newer credential on disk means somebody else won the race, and
      // that result is what the caller has to present.
      const verified = await store.readFresh().catch(() => null)
      if (minimaxCodeSameCredentialSession(verified, rotated)
        && minimaxCodeCredentialAdvancedPast(verified, rotated)) {
        return verified as MinimaxCodeCredentials
      }
      return rotated
    } catch (error) {
      // The rotation failed. If storage has moved on from the credential this call
      // presented, the failure was about a spent token rather than about the
      // account, and the cure is the credential that is already there.
      if (error instanceof Error && error.name === 'MinimaxCodeUnauthorizedError') {
        const settled = await store.readFresh().catch(() => null)
        if (minimaxCodeSameCredentialSession(settled, credentials)
          && minimaxCodeCredentialAdvancedPast(settled, credentials)) {
          return settled as MinimaxCodeCredentials
        }
      }
      throw error
    } finally {
      // The slot is released only after the write landed, so a caller arriving in
      // between observes the rotation rather than a token that is already spent.
      if (rotations.get(key) === record) rotations.delete(key)
    }
  })()
  // A rotation that fails must not surface as an unhandled rejection merely
  // because a waiting caller attached its handler a tick later.
  void pending.catch(() => undefined)
  record.promise = pending
  rotations.set(key, record)
  return { credentials: await pending, adopted: false }
}

/** Test seam: forget every rotation, so one test cannot leak into the next. */
export function resetMinimaxCodeRotations(): void {
  rotations.clear()
}

/** The desktop app's auth document, kept whole so a write preserves its shape. */
interface NativeAuthDocument {
  root: Record<string, unknown>
  records: Record<string, unknown>
  recordKey: string
  record: Record<string, unknown>
}

/**
 * Read the desktop app's credential document for one region.
 *
 * The record is located by its `clientId` rather than by recomputing the record
 * key: the key embeds a hash over the app's own auth-home path, which this plugin
 * has no way to reproduce faithfully. Finding the entry by the field the app
 * writes into it is what lets a rotated token be written back to the exact place
 * the app will look for it.
 */
async function readNativeDocument(region: MinimaxCodeRegion): Promise<NativeAuthDocument | null> {
  const filePath = authJsonPath(region)
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed) || !isRecord(parsed.records)) return null
  const records = parsed.records as Record<string, unknown>
  for (const [recordKey, entry] of Object.entries(records)) {
    if (!isRecord(entry)) continue
    if (asString(entry.clientId) !== MINIMAX_CODE_CLIENT_ID) continue
    if (asString(entry.accessToken) === undefined) continue
    return { root: parsed, records, recordKey, record: entry }
  }
  return null
}

/**
 * Update `auth-state.json`'s generation and expiry after a rotation.
 *
 * The file is non-secret state the app reads to decide whether it is signed in.
 * Leaving it stale after a refresh would show the app a generation that no longer
 * matches its credential, so it is updated beside the credential — and, like the
 * credential, only the fields this plugin actually knows about are touched.
 */
async function syncAuthState(
  region: MinimaxCodeRegion,
  options: { generation: number; expiresAtMs: number },
): Promise<void> {
  const filePath = authStateJsonPath(region)
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
  } catch {
    // No state file (or an unreadable one) is not an error: the credential is
    // what authenticates, and the app recreates its own state on next start.
    return
  }
  if (!isRecord(parsed)) return
  const next: Record<string, unknown> = {
    ...parsed,
    generation: options.generation,
    expiresAtMs: options.expiresAtMs,
  }
  await writeFileAtomic(filePath, JSON.stringify(next, null, 2) + '\n').catch(() => undefined)
}

/**
 * The credential store for this line.
 *
 * `read()` prefers the desktop app's file and falls back to the plugin's own, so
 * a user who signed in through either path is served. `write()` returns the
 * credential to the file it came from, which is what keeps the two provenances
 * from clobbering each other.
 */
export class MinimaxCodeCredentialStore {
  // Declared and assigned explicitly rather than as a constructor parameter
  // property: Node's type-stripping loader rejects a parameter property outright,
  // and this package is imported directly by tooling that runs TypeScript as-is.
  private readonly region: MinimaxCodeRegion

  constructor(region: MinimaxCodeRegion = 'cn') {
    this.region = region
  }

  /** Path of the file the next read or write targets. */
  path(): string {
    return authJsonPath(this.region)
  }

  private async readNative(): Promise<MinimaxCodeCredentials | null> {
    // Both region directories are probed, cheapest first: the constructor's
    // region is the common case, and the other one is a single extra stat for a
    // user who signed in to the other property. Probing only the configured
    // region made a global sign-in invisible to this whole line.
    const order: MinimaxCodeRegion[] = this.region === 'cn' ? ['cn', 'global'] : ['global', 'cn']
    for (const region of order) {
      const document = await readNativeDocument(region)
      if (document === null) continue
      try {
        // The region the record was found under is carried on the returned
        // credential, which is what every later host and write-back is keyed on;
        // no separate field is needed to remember it.
        return parseMinimaxCodeCredentials(document.record, {
          region,
          buildEnv: asString(document.record.buildEnv) ?? MINIMAX_CODE_BUILD_ENV,
          recordKey: document.recordKey,
          source: 'minimax-native',
        })
      } catch {
        // A present-but-unusable native record falls through to the next region
        // and then to the plugin store rather than being reported as "signed in".
      }
    }
    return null
  }

  private async readPluginFile(): Promise<MinimaxCodeCredentials | null> {
    let raw: string
    try {
      raw = await fs.readFile(pluginCredentialPath(), 'utf8')
    } catch {
      return null
    }
    try {
      return parseMinimaxCodeCredentials(JSON.parse(raw) as unknown, {
        region: this.region,
        source: 'file',
      })
    } catch {
      return null
    }
  }

  async read(): Promise<MinimaxCodeCredentials | null> {
    // Queue behind whatever is already in flight FIRST. Callers use a read to
    // drain this store's fire-and-forget mirror write, so answering from the
    // snapshot without draining would hand back the very state that write is about
    // to replace. The drain is free when nothing is queued.
    await this.drain()
    // The in-process snapshot is then safe: a read that ran inside this turn is
    // more current than the file, because the rotation is written back before its
    // caller is handed the credential.
    const recent = recentCredentialRead(this.path())
    if (recent !== null) return recent
    return serialize(this.path(), async () => (await this.readNative()) ?? (await this.readPluginFile()))
  }

  /** Resolve once every operation already queued for this store's file settled. */
  private drain(): Promise<void> {
    return fileOperations.get(path.resolve(this.path())) ?? Promise.resolve()
  }

  /**
   * Read storage, ignoring the snapshot.
   *
   * Used by the rotation path, where the whole question is whether somebody else
   * has already replaced the credential: a cached answer would report the very
   * state the caller is trying to move past. This is also what makes a rotation
   * observable at all - the desktop app's write is only visible by reading the
   * file again.
   */
  readFresh(): Promise<MinimaxCodeCredentials | null> {
    return serialize(this.path(), async () => {
      const stored = (await this.readNative()) ?? (await this.readPluginFile())
      rememberCredentialRead(this.path(), stored)
      return stored
    })
  }

  /**
   * The credential in force plus where it came from, in one pass.
   *
   * A status response needs all three facts, and each of the targeted accessors
   * re-reads and re-parses the native document (a file read plus a JSON parse per
   * region probed). Reading once here keeps one /status call from doing that work
   * three times, which matters because the settings card polls this route.
   */
  readWithProvenance(): Promise<{
    credentials: MinimaxCodeCredentials | null
    source: MinimaxCodeCredentialSource
    path: string
  }> {
    return serialize(this.path(), async () => {
      const native = await this.readNative()
      if (native !== null) {
        return { credentials: native, source: 'minimax-native' as const, path: authJsonPath(native.region) }
      }
      return { credentials: await this.readPluginFile(), source: 'file' as const, path: pluginCredentialPath() }
    })
  }

  /** Which file the credential currently in force lives in. */
  async activeSource(): Promise<MinimaxCodeCredentialSource> {
    return (await this.readNative()) === null ? 'file' : 'minimax-native'
  }

  /**
   * Persist a credential back where it came from.
   *
   * A native credential is written into the existing record, preserving the
   * document's `schemaVersion` and every other record; a plugin credential is
   * written to the plugin's own file. Either way the write is atomic.
   */
  write(credentials: MinimaxCodeCredentials): Promise<void> {
    const native = credentials.source === 'minimax-native' && credentials.recordKey !== null
    // Keyed on the credential's own region, not the constructor default: a
    // rotation must land in the file it was read from, or the desktop app keeps
    // the stale token while this plugin holds a live one.
    const target = native ? authJsonPath(credentials.region, credentials.buildEnv) : pluginCredentialPath()
    return serialize(target, async () => {
      await this.writeOnce(credentials)
      // The rotated pair is authoritative the moment it is durable, and recording
      // it is what lets {@link read} answer from this process instead of spawning
      // a DPAPI helper for every request. The registry that keeps OTHER callers
      // from spending the token this write replaced is held by
      // {@link rotateMinimaxCodeCredential}, which wraps the whole rotation.
      rememberCredentialRead(target, credentials)
    })
  }

  /**
   * One write, to whichever file the credential came from.
   *
   * Called with the destination already held by {@link write}'s `serialize`; it
   * must NOT claim the same chain again, or the outer frame would be waiting on the
   * inner one while the inner one waits on the outer.
   */
  private async writeOnce(credentials: MinimaxCodeCredentials): Promise<void> {
    const native = credentials.source === 'minimax-native' && credentials.recordKey !== null
    // The destination the caller resolved (its own region, its own build env).
    const target = native ? authJsonPath(credentials.region, credentials.buildEnv) : pluginCredentialPath()
    {
      if (!native) {
        await writeFileAtomic(pluginCredentialPath(), JSON.stringify(credentials, null, 2) + '\n')
        return
      }
      const document = await readNativeDocument(credentials.region)
      const recordKey = credentials.recordKey ?? document?.recordKey
      if (document === null || recordKey === undefined || recordKey === null) {
        // The native document vanished between the read and the write (the app
        // signed out, or the directory was cleaned). Writing a fabricated record
        // key would leave an entry the app never reads, so the credential is kept
        // in the plugin's own store instead of being lost.
        await writeFileAtomic(
          pluginCredentialPath(),
          JSON.stringify({ ...credentials, source: 'file' }, null, 2) + '\n',
        )
        return
      }
      const nextRecord: Record<string, unknown> = {
        ...document.record,
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        tokenType: credentials.tokenType,
        clientId: credentials.clientId,
        scopes: credentials.scopes,
        audience: credentials.audience,
        expiresAtMs: credentials.expiresAtMs,
        generation: credentials.generation,
        loginEpoch: credentials.loginEpoch,
      }
      const nextRoot: Record<string, unknown> = {
        ...document.root,
        // schemaVersion is the app's own format marker and is preserved verbatim;
        // this plugin must never advance or drop it.
        schemaVersion: document.root.schemaVersion ?? 1,
        records: { ...document.records, [recordKey]: nextRecord },
      }
      await writeFileAtomic(target, JSON.stringify(nextRoot, null, 2) + '\n')
      await syncAuthState(credentials.region, {
        generation: credentials.generation,
        expiresAtMs: credentials.expiresAtMs,
      })
    }
  }

  /**
   * Forget the credential this plugin owns.
   *
   * The desktop app's `auth.json` is deliberately left alone: it is not this
   * plugin's to delete, and removing it would sign the user out of MiniMax Code
   * itself. A credential this store is only *reading* from the app therefore
   * remains in force after a sign-out, which the status route reports so the
   * user is not told a session ended when it did not.
   */
  delete(): Promise<void> {
    return serialize(pluginCredentialPath(), async () => {
      await fs.rm(pluginCredentialPath(), { force: true })
      // The snapshot has to go with the file: a read right after a sign-out must
      // not hand the caller the credential that was just removed.
      recentRead = null
    })
  }
}

// ---------------------------------------------------------------------------
// Model settings
// ---------------------------------------------------------------------------

/** Namespace the model selection is registered under on a register-capable harness. */
export const MINIMAX_CODE_PREFERENCES_NAMESPACE = 'dsh-minimax-code'

/** Runtime membership test for one stored effort value. */
function isReasoningEffort(value: unknown): value is MinimaxCodeReasoningEffort {
  return typeof value === 'string' && (MINIMAX_CODE_REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * The model-selection half of this line's settings.
 *
 * The catalog (`MINIMAX_CODE_MODELS`) is deliberately not stored here. A shipped
 * catalog changes with the code, so persisting a copy of it would leave a user
 * whose file is a release behind reading a model list the build no longer serves;
 * only the user's own choices live in this document.
 */
export interface MinimaxCodeModelSettings {
  /** Line-wide switch. Absent means enabled: this line shipped enabled. */
  enabled?: boolean
  /** Catalog ids DSH offers in the conversation model picker. */
  enabledModelIds: string[]
  /** Per-model context window, replacing the catalog's own number. */
  contextWindowOverrides: Record<string, number>
  /** Level used when a conversation picks none; null means the model's own. */
  defaultReasoningEffort: MinimaxCodeReasoningEffort | null
  /** Daily check-in scheduler switch. Absent means enabled. */
  checkin?: { enabled: boolean }
}

/**
 * One settings patch.
 *
 * `contextWindowOverrides` is a patch rather than the whole map because `null`
 * has to survive as a value: it is the settings card's "restore the catalog
 * default" and deletes exactly one key. A full replacement could not express
 * that without the caller first reading the document it wants to edit.
 */
export interface MinimaxCodeSettingsPatch {
  enabled?: boolean
  enabledModelIds?: string[]
  contextWindowOverrides?: ContextWindowOverridePatch
  defaultReasoningEffort?: MinimaxCodeReasoningEffort | null
  checkin?: { enabled: boolean }
}

/**
 * The seam the routes and the adapter share.
 *
 * `status()` is synchronous on purpose: it is read on every model-picker query
 * and on every settings-card poll, and both callers only need a snapshot. A
 * promise-shaped reader here would make each of them await a file read on a hot
 * path for a value that changes at human speed.
 */
export interface MinimaxCodePreferenceStore {
  /**
   * The file-backed store warms up asynchronously, so `status()` answers from
   * shipped defaults until that read settles. A caller that acts on a
   * preference at startup — the check-in scheduler signing in on boot — must
   * await this first, or it acts on the default instead of the user's choice.
   * A register-backed store reads synchronously and resolves immediately.
   */
  ready(): Promise<void>
  status(): MinimaxCodeModelSettings
  update(patch: MinimaxCodeSettingsPatch): Promise<MinimaxCodeModelSettings>
}

/** Every catalog id, in catalog order: the shipped selection and the parse fallback. */
const DEFAULT_ENABLED_MODEL_IDS: string[] = minimaxCodeModelIds()

/** The settings a fresh install has: everything on, nothing overridden. */
function defaultMinimaxCodeSettings(): MinimaxCodeModelSettings {
  return {
    enabled: true,
    enabledModelIds: [...DEFAULT_ENABLED_MODEL_IDS],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
  }
}

/** Path of the settings file used when no settings service is present. */
export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'minimax-code-models.json')
}

/**
 * Normalize one parsed settings document.
 *
 * Nothing here throws. The file is read on boot and on every status poll, and a
 * hand-edited or downgraded document must degrade to a usable selection instead
 * of making the whole line unusable; every branch that cannot be trusted falls
 * back to the value the catalog itself declares.
 */
function parseMinimaxCodeModelSettings(value: unknown): MinimaxCodeModelSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return defaultMinimaxCodeSettings()
  const record = value as Record<string, unknown>
  const enabledModelIds = Array.isArray(record.enabledModelIds)
    ? record.enabledModelIds.filter((id): id is string => typeof id === 'string')
    : [...DEFAULT_ENABLED_MODEL_IDS]
  const contextWindowOverrides: Record<string, number> = {}
  if (typeof record.contextWindowOverrides === 'object' && record.contextWindowOverrides !== null) {
    for (const [modelId, raw] of Object.entries(record.contextWindowOverrides as Record<string, unknown>)) {
      // A non-positive or non-finite window is dropped rather than clamped to
      // some minimum. It would size every request on that model against a
      // window the catalog never declared, and the route's own validation
      // refuses those values, so reaching here means the file was hand-edited.
      // Falling back to the catalog default is the honest repair.
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        contextWindowOverrides[modelId] = Math.floor(raw)
      }
    }
  }
  return {
    // Only an explicit false disables the line: an absent key is the shipped
    // state, and reading it as "off" would hide every model from a user who
    // never touched the switch.
    enabled: record.enabled !== false,
    enabledModelIds,
    contextWindowOverrides,
    defaultReasoningEffort: isReasoningEffort(record.defaultReasoningEffort) ? record.defaultReasoningEffort : null,
    checkin: parseCheckinSettings(record.checkin),
  }
}

/**
 * Normalize the check-in half of the settings document.
 *
 * Absent means enabled, matching the sibling lines' scheduler default: a user
 * who never opened the card gets the same behaviour a fresh workbuddy install
 * has, and only an explicit `false` parks the scheduler.
 */
function parseCheckinSettings(value: unknown): { enabled: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { enabled: true }
  const enabled = (value as Record<string, unknown>).enabled
  return { enabled: enabled !== false }
}

/**
 * Apply one patch to one settings document.
 *
 * The merge lives outside both stores because the register-backed store has to
 * normalize the scope's value through the same rules the file store applies; two
 * copies of this logic is how the two storage paths drift apart the first time
 * one of them learns a new field.
 */
export function mergeMinimaxCodeSettings(
  current: MinimaxCodeModelSettings,
  patch: MinimaxCodeSettingsPatch,
): MinimaxCodeModelSettings {
  return {
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled !== false,
    enabledModelIds: patch.enabledModelIds ?? current.enabledModelIds,
    contextWindowOverrides: patch.contextWindowOverrides !== undefined
      ? mergeContextWindowOverrides(current.contextWindowOverrides, patch.contextWindowOverrides)
      : current.contextWindowOverrides,
    defaultReasoningEffort: patch.defaultReasoningEffort !== undefined
      ? patch.defaultReasoningEffort
      : current.defaultReasoningEffort,
    checkin: patch.checkin !== undefined
      ? { enabled: patch.checkin.enabled !== false }
      : current.checkin ?? { enabled: true },
  }
}

/**
 * The settings file beside the credentials.
 *
 * This is what a harness without the register seam (0.1.7, and a headless host)
 * reads back on boot, so it is the store that has to survive a crash: the write
 * is a temporary sibling plus `rename`, and the document just written is read
 * back and compared before the write is reported as done. Without the read-back
 * a partial write, or a filesystem that dropped the rename, would report a
 * selection the next boot does not agree with — the card would show a model
 * grid the adapter never applies.
 */
export class MinimaxCodeModelSettingsStore {
  // Declared and assigned explicitly rather than as a constructor parameter
  // property: Node's type-stripping loader rejects a parameter property, and
  // this package is imported directly by tooling that runs TypeScript as-is.
  private readonly filePath: string

  constructor(filePath: string = modelSettingsPath()) {
    this.filePath = filePath
  }

  path(): string {
    return this.filePath
  }

  async read(): Promise<MinimaxCodeModelSettings> {
    try {
      return parseMinimaxCodeModelSettings(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown)
    } catch {
      // A missing or unreadable settings file falls back to the shipped defaults.
      return defaultMinimaxCodeSettings()
    }
  }

  async write(settings: MinimaxCodeModelSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = this.filePath + '.tmp.' + Date.now()
    // The trailing newline matches what the sibling lines' files look like on
    // disk; only the parsed value is compared below, so it never affects the
    // verification.
    await fs.writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', 'utf8')
    await fs.rename(temporary, this.filePath)
    const restored = parseMinimaxCodeModelSettings(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown)
    if (!isDeepStrictEqual(restored, settings)) {
      throw new Error('MiniMax Code model settings write failed; the stored selection does not match what was written')
    }
  }

  /**
   * Read-modify-write under the same per-path lock the credential writes use.
   *
   * Without it two patches landing together each read the same document and the
   * second write silently discards the first — a lost model selection, with no
   * error anywhere. The lock is shared with the credential paths because it is
   * keyed by resolved path, and the two never name the same file.
   */
  updateSettings(patch: MinimaxCodeSettingsPatch): Promise<MinimaxCodeModelSettings> {
    return serialize(this.filePath, async () => {
      const next = mergeMinimaxCodeSettings(await this.read(), patch)
      await this.write(next)
      return next
    })
  }
}

/**
 * Bind the model selection to the DSH settings document when the harness still
 * offers one, and to the JSON file beside it otherwise: a harness without the
 * register seam (0.1.7, and a headless host) reads that file back on boot.
 */
export function registerMinimaxCodePreferenceStore(
  settings?: unknown,
  fallbackStore: MinimaxCodeModelSettingsStore = new MinimaxCodeModelSettingsStore(),
): MinimaxCodePreferenceStore {
  if (!hasRegister(settings)) {
    // With no settings namespace to persist in, the JSON file beside the
    // credentials is the store. It is read once here, so a selection saved by an
    // earlier run is still the selection on the next boot; the read is not
    // awaited so that a caller wiring the plugin at startup is not blocked on a
    // disk read, and `status()` answers from the shipped defaults until it lands.
    let snapshot: MinimaxCodeModelSettings = defaultMinimaxCodeSettings()
    // The warmup promise is kept so a startup caller can await it instead of
    // racing it; `status()` still answers immediately from the defaults.
    const warmed = fallbackStore.read().then((stored) => { snapshot = stored }).catch(() => undefined)
    return {
      ready: () => warmed,
      status: () => snapshot,
      update: async (patch) => {
        snapshot = await fallbackStore.updateSettings(patch)
        return snapshot
      },
    }
  }

  const scope = settings.register(resolveSettingsNamespace(MINIMAX_CODE_PREFERENCES_NAMESPACE), z.object({
    enabled: z.boolean().default(true),
    enabledModelIds: z.array(z.string()).default([...DEFAULT_ENABLED_MODEL_IDS]),
    contextWindowOverrides: z.dict(z.number()).default({}),
    defaultReasoningEffort: z
      .union([
        ...MINIMAX_CODE_REASONING_EFFORTS.map((effort) => z.const(effort)),
        z.const(null),
      ])
      .default(null),
    checkin: z.object({
      enabled: z.boolean().default(true),
    }).default({ enabled: true }),
  })) as SettingsScope<{
    enabled: boolean
    enabledModelIds: string[]
    contextWindowOverrides: Record<string, number>
    defaultReasoningEffort: MinimaxCodeReasoningEffort | null
    checkin: { enabled: boolean }
  }>

  return {
    // The register-backed scope reads synchronously, so there is nothing to
    // wait for; the seam exists so callers need not know which store they hold.
    ready: async () => undefined,
    status: () => {
      const value = scope.get()
      return {
        enabled: value.enabled !== false,
        enabledModelIds: value.enabledModelIds,
        contextWindowOverrides: value.contextWindowOverrides,
        defaultReasoningEffort: value.defaultReasoningEffort,
        checkin: { enabled: value.checkin?.enabled !== false },
      }
    },
    update: async (patch) => {
      // Read once: two reads of a live scope could straddle a write from another
      // subscriber, and merging against the second while persisting the first is
      // exactly the lost update this store exists to avoid.
      const value = scope.get()
      const normalized = mergeMinimaxCodeSettings({
        enabled: value.enabled !== false,
        enabledModelIds: value.enabledModelIds,
        contextWindowOverrides: value.contextWindowOverrides,
        defaultReasoningEffort: value.defaultReasoningEffort,
        checkin: { enabled: value.checkin?.enabled !== false },
      }, patch)
      await scope.update(normalized)
      // Mirror into the file as well, so a later run on a harness that dropped
      // the register seam still finds the selection the user made. The mirror is
      // best effort: the registered document is the store that just succeeded.
      void fallbackStore.updateSettings(patch).catch(() => undefined)
      return normalized
    },
  }
}
