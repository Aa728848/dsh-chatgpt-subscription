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
import { dshHomeDir } from '../common/home.ts'
import { MINIMAX_CODE_BUILD_ENV, MINIMAX_CODE_CLIENT_ID, REFRESH_MARGIN_MS } from './types.ts'
import type { MinimaxCodeRegion } from '../../shared/minimax-code-contracts.ts'

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

  read(): Promise<MinimaxCodeCredentials | null> {
    return serialize(this.path(), async () => (await this.readNative()) ?? (await this.readPluginFile()))
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
    })
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
    })
  }
}
