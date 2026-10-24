/**
 * Which store holds a provider line's account pool.
 *
 * The pool document is one JSON object per line. The store used to be decided by
 * `process.platform` alone: DPAPI on Windows, Keychain on macOS, and on Linux the
 * Secret Service — which a headless server does not have. There the token exchange
 * succeeded, saving failed, and the account could not be added at all; the only
 * workaround was running `gnome-keyring` unlocked with an empty password, which
 * protects the keyring file by permissions and nothing else.
 *
 * So the store becomes a choice with exactly two values:
 *
 * - `keyring` (default) — the platform store: DPAPI on Windows, the Keychain on
 *   macOS, the Secret Service on Linux. Every existing install has this, and
 *   nobody who never touches the setting sees a change.
 * - `credentials` — DSH's own credential store, through `ctx.credentials`. The
 *   option a server install should use: no external daemon, one store for every
 *   secret the host holds.
 *
 * There is deliberately NO automatic mode. An `auto` that picks by probing would
 * let one pool move between two stores depending on whether a daemon happened to
 * answer, and a pool that moves looks exactly like a pool whose accounts were
 * lost. A wrong choice is reported instead — the card names the store in use, says
 * why the configured one is unusable and offers the switch — and the accounts that
 * stayed behind in the other store are still there.
 */
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { CorruptStoredDocumentError, type CredentialStore } from '../token-store.ts'
import { credentialsRecordKey, type CredentialsRecordSeam } from './credentials-compat.ts'
import type {
  PoolStorageBackend,
  PoolStorageDto,
  PoolStorageMode,
  PoolStorageUnavailableReason,
} from '../../shared/contracts.ts'

/** Store a deployment gets when no `poolStorage` is configured anywhere. */
export const DEFAULT_POOL_STORAGE_MODE: PoolStorageMode = 'keyring'

/** Record scope the pool document occupies in DSH's credential store. */
const POOL_RECORD_SCOPE = 'dsh-chatgpt-subscription'

/**
 * Record id prefix for one pool: `<scope>/pool-<digest>`.
 *
 * The prefix is load-bearing, not decoration. The seam requires each key segment
 * to match `/^[a-z][a-z0-9-]*$/` while a pool's id is a sha256 hex digest, and
 * 62.5% of digests start with a digit — those keys are rejected on the NEXT start,
 * when the record document is parsed, and an invalid key fails the whole provider's
 * activation: the DeepSeek key, the Telegram token and every other secret in
 * `$DSH_HOME/.credentials.yaml` become unreadable. `pool-` puts a letter first and
 * leaves the digest untouched, so the address stays stable and the Secret Service
 * entry (which uses the bare digest as its account attribute) is unaffected.
 */
function poolRecordKey(account: string): string {
  return credentialsRecordKey(POOL_RECORD_SCOPE, `pool-${account}`)
}

/**
 * The deployment-wide choice, as the runtime sees it.
 *
 * One plugin instance serves every provider line and one profile carries one
 * `poolStorage`, so the value is read where the lines are built and consulted
 * here. Module state rather than a constructor argument on eleven pools: a
 * parameter would have to be threaded through ten provider constructors (one of
 * which takes no options at all) to describe one deployment-wide decision.
 */
export interface PoolStorageDefaults {
  /** Where the configured value comes from; read on every resolve. */
  mode?: () => PoolStorageMode
  /** Awaited before the mode is read, so a choice stored on disk is in place. */
  ready?: () => Promise<void>
  /**
   * `ctx.credentials`, read on EVERY resolve rather than captured once.
   *
   * A getter because the service is deliberately not in `inject`: nothing orders
   * it before this plugin's `apply`, and a value captured there would send every
   * pool of the process down the "no ctx.credentials service" branch for the rest
   * of the process's life — `poolStorage: 'credentials'` reporting an unusable
   * store on a host that has one.
   */
  credentials?: () => CredentialsRecordSeam | undefined
  logger?: Pick<Console, 'info' | 'warn'>
}

let defaults: PoolStorageDefaults = { mode: () => DEFAULT_POOL_STORAGE_MODE }

/**
 * Revision of the deployment-wide choice.
 *
 * Every resolved pool remembers the revision it resolved under and re-resolves
 * when this moves. Without it, switching the store in the settings card would keep
 * serving the old backend until the host restarted: the resolution is deliberately
 * cached — the decision must not be retaken per request — so the switch has to
 * invalidate it explicitly.
 */
let revision = 0

/** Record the deployment-wide storage choice; call once, before any pool is built. */
export function configurePoolStorage(next: PoolStorageDefaults): void {
  defaults = next.mode === undefined ? { ...next, mode: () => DEFAULT_POOL_STORAGE_MODE } : next
  revision += 1
}

/**
 * Announce that the stored choice changed.
 *
 * Called by the settings route after the new value is on disk; every pool drops
 * the backend it cached and resolves again on its next read.
 */
export function poolStorageChanged(): void {
  revision += 1
}

/** The revision the current choice stands at. */
export function poolStorageRevision(): number {
  return revision
}

/** The configured mode, without resolving a backend. */
export function poolStorageMode(): PoolStorageMode {
  return defaults.mode?.() ?? DEFAULT_POOL_STORAGE_MODE
}

/** Clear the deployment-wide choice, so one test cannot leak into the next. */
export function resetPoolStorage(): void {
  defaults = { mode: () => DEFAULT_POOL_STORAGE_MODE }
  revision += 1
}

/** The keyring store as this module needs it: a credential store that can be asked whether it answers. */
export interface ProbeableKeyringStore<T> extends CredentialStore<T> {
  ping(): Promise<{ available: boolean; reason?: string }>
}

export interface PoolStorageRequest<T> {
  /** Configured choice; defaults to the process-wide {@link configurePoolStorage} value. */
  mode?: PoolStorageMode
  /** Defaults to `process.platform`; explicit so every branch is testable. */
  platform?: NodeJS.Platform
  /** Provider label, used only in the error raised on an unsupported platform. */
  displayName: string
  /** Plain path of the pool document the keyring entry is derived from. */
  poolFile: string
  /** Keychain / Secret Service service name, as the desktop backends already use it. */
  keychainService: string
  /** Per-pool keychain account name (the digest of {@link poolFile}). */
  account: string
  /** Validates and normalizes one whole pool document. */
  parsePoolData: (value: unknown) => T
  /** `ctx.credentials` when the harness has one; absent otherwise. */
  credentials?: CredentialsRecordSeam
  logger?: Pick<Console, 'info' | 'warn'>
  /** Test seam: the Secret Service backend, so a probe result can be supplied. */
  keyring?: ProbeableKeyringStore<T>
  /**
   * Test seam: the store a Windows or macOS host would use.
   *
   * DPAPI and the Keychain constructors refuse to exist on another platform, so
   * without this the desktop branches could only ever be tested on the desks they
   * belong to — which is how a platform branch ends up untested in CI.
   */
  desktopStore?: CredentialStore<T>
}

export interface PoolStorageResolution<T> {
  store: CredentialStore<T>
  storage: PoolStorageDto
}

const BACKEND_LABELS: Record<PoolStorageBackend, string> = {
  keyring: 'desktop keyring (Secret Service)',
  credentials: 'DSH credential store',
  dpapi: 'Windows DPAPI',
  keychain: 'macOS Keychain',
}

/** Human label of one backend, for the log line and for diagnostics. */
export function poolStorageBackendLabel(backend: PoolStorageBackend): string {
  return BACKEND_LABELS[backend]
}

/** Whether the backend encrypts the document at rest. */
export function poolStorageEncrypted(backend: PoolStorageBackend): boolean {
  return backend === 'keyring' || backend === 'dpapi' || backend === 'keychain'
}

/**
 * The pool document as a record in DSH's own credential store.
 *
 * Stored through the seam's record half (see `credentials-compat.ts`): the
 * document is this plugin's own format, and a `grant` payload is exactly the slot
 * the seam keeps for a value only its owner can interpret.
 *
 * Writes are LAST-WRITER-WINS, and honestly so. `modifyRecord` is the seam's only
 * write path and it does hand back the record as it stands under its lock, but a
 * whole pool document is written from one in-memory copy: a second process that
 * saved between this process's read and this write is overwritten. The lock makes
 * the write atomic, not the transaction. This is the same guarantee the keyring
 * backend has always given, and exactly what the `keyring` option gives — one
 * process is the normal case (one `DSH_HOME`, one host), and it is stated here
 * rather than implied away.
 */
export class CredentialsRecordStore<T> implements CredentialStore<T> {
  constructor(
    private readonly seam: CredentialsRecordSeam,
    private readonly key: string,
    private readonly parse: (value: unknown) => T,
  ) {}

  /** The `<scope>/<id>` address this pool occupies; a location, never a credential. */
  recordKey(): string {
    return this.key
  }

  async load(): Promise<T | null> {
    const record = await this.seam.readRecord(this.key)
    if (record === undefined) return null
    if (record.kind !== 'grant') throw new CorruptStoredDocumentError('pool record is not a grant')
    try {
      return this.parse(record.payload)
    } catch (error) {
      // Typed as CORRUPT, not unavailable: a document that does not parse is what
      // the next write repairs, while a seam that did not answer must not be
      // treated as an empty pool.
      throw new CorruptStoredDocumentError('DSH credential store pool payload is invalid', { cause: error })
    }
  }

  async save(value: T): Promise<void> {
    // The seam promises the payload survives a JSON round trip and nothing more,
    // so the document is normalized to plain JSON BEFORE it is handed over: a
    // field of `undefined` inside it would otherwise vanish on read-back and make
    // the pool's own write verification fail on a save that actually succeeded.
    const payload = JSON.parse(JSON.stringify(value)) as unknown
    // `current` is deliberately not merged: this class holds one pool document and
    // the caller owns its contents, so the load-modify-save it performs is the
    // merge. Writing back the record as it stood would resurrect accounts this
    // process has just deleted. See the class comment for the scope of the lock.
    await this.seam.modifyRecord(this.key, async () => ({ kind: 'grant', payload }))
  }

  async clear(): Promise<void> {
    await this.seam.deleteRecord(this.key)
  }
}

/**
 * A backend that cannot be used on this host, kept so the failure is reported with
 * its reason instead of being replaced by a silent substitution.
 *
 * `poolStorage` is an instruction. Answering it with a different store would make
 * the settings card describe a backend the user did not choose, and — worse —
 * would spread one deployment's accounts across two stores without saying so.
 * Every operation therefore fails with the sentence the card also shows, and
 * `unavailable` tells the card which reason code to translate.
 */
class UnusablePoolStore<T> implements CredentialStore<T> {
  constructor(private readonly message: string) {}

  async load(): Promise<T | null> {
    throw new Error(this.message)
  }

  async save(): Promise<void> {
    throw new Error(this.message)
  }

  async clear(): Promise<void> {
    throw new Error(this.message)
  }
}

/** What the user is told when `keyring` is configured and there is no keyring. */
const KEYRING_UNREACHABLE = 'poolStorage is "keyring", but this host has no reachable desktop keyring: '
  + 'the Secret Service does not answer (no secret-tool, no session bus, or a locked keyring). '
  + 'Switch "Account storage" to the DSH credential store, or set poolStorage: "credentials".'

/** What the user is told when `credentials` is configured and the harness has no such seam. */
const NO_CREDENTIALS_SERVICE = 'poolStorage is "credentials", but this harness has no ctx.credentials service, '
  + 'so there is no DSH credential store to write into. Switch "Account storage" to the desktop keyring, '
  + 'or set poolStorage: "keyring".'

/**
 * Resolve the pool store for one line.
 *
 * Async because `credentials` availability is a runtime fact and the configured
 * value may still be loading from disk; callers hold the promise rather than the
 * store (see `AccountPoolCore`).
 */
export async function resolvePoolStorage<T>(request: PoolStorageRequest<T>): Promise<PoolStorageResolution<T>> {
  const platform = request.platform ?? process.platform
  const logger = request.logger ?? defaults.logger ?? console
  await defaults.ready?.()
  const mode = request.mode ?? defaults.mode?.() ?? DEFAULT_POOL_STORAGE_MODE
  const seam = request.credentials ?? defaults.credentials?.()

  if (mode === 'credentials') {
    if (seam === undefined) {
      logger.warn(`[dsh-chatgpt-subscription] ${NO_CREDENTIALS_SERVICE}`)
      return unusable<T>(mode, 'credentials', 'no-credentials-service', NO_CREDENTIALS_SERVICE)
    }
    const store = new CredentialsRecordStore(
      seam,
      poolRecordKey(request.account),
      request.parsePoolData,
    )
    logger.info(`[dsh-chatgpt-subscription] account pool stored in ${BACKEND_LABELS.credentials}`)
    return resolved(store, mode, 'credentials')
  }

  // `keyring`: the platform store — a different store on each platform, and
  // exactly what it was before this option existed.
  if (platform === 'win32' || platform === 'darwin') {
    const backend: PoolStorageBackend = platform === 'win32' ? 'dpapi' : 'keychain'
    const store = request.desktopStore ?? (platform === 'win32'
      ? new WindowsDpapiCredentialStore(`${request.poolFile}.dpapi`, request.parsePoolData)
      : new MacKeychainCredentialStore(request.keychainService, request.account, request.parsePoolData))
    logger.info(`[dsh-chatgpt-subscription] account pool stored in ${BACKEND_LABELS[backend]}`)
    return resolved(store, mode, backend)
  }
  if (platform !== 'linux') {
    throw new Error(`${request.displayName} pool storage requires Windows, macOS, or Linux.`)
  }

  const keyring = request.keyring
    ?? new SecretServiceCredentialStore(request.keychainService, request.account, request.parsePoolData)
  const availability = await probeKeyring(keyring)
  if (!availability.available) {
    // No silent fallback: the user asked for the keyring, so a save has to fail
    // with the sentence that says what to change, instead of succeeding in a store
    // they did not choose and cannot see from the card.
    const reason = availability.reason === undefined
      ? KEYRING_UNREACHABLE
      : `${KEYRING_UNREACHABLE} (${availability.reason})`
    logger.warn(`[dsh-chatgpt-subscription] ${reason}`)
    return unusable<T>(mode, 'keyring', 'keyring-unreachable', reason)
  }
  logger.info(`[dsh-chatgpt-subscription] account pool stored in ${BACKEND_LABELS.keyring}`)
  return resolved(keyring, mode, 'keyring')
}

/**
 * The store a caller-supplied backend stands in for, on this platform.
 *
 * `AccountPoolHooks.backend` replaces the STORE, not the choice, and adoption
 * harnesses use it without a `storage` to go with it. Falling back to
 * `{ backend: 'keyring', encrypted: false }` there described a backend that cannot
 * exist (the platform keyring is encrypted on every platform it exists on) and the
 * wrong one on Windows or macOS.
 */
export function poolStorageBackendForPlatform(platform: NodeJS.Platform): PoolStorageBackend {
  if (platform === 'win32') return 'dpapi'
  if (platform === 'darwin') return 'keychain'
  return 'keyring'
}

function resolved<T>(
  store: CredentialStore<T>,
  mode: PoolStorageMode,
  backend: PoolStorageBackend,
): PoolStorageResolution<T> {
  return { store, storage: { mode, backend, encrypted: poolStorageEncrypted(backend) } }
}

function unusable<T>(
  mode: PoolStorageMode,
  backend: PoolStorageBackend,
  unavailable: PoolStorageUnavailableReason,
  message: string,
): PoolStorageResolution<T> {
  return {
    store: new UnusablePoolStore<T>(`ChatGPT account pool storage is unavailable: ${message}`),
    storage: { mode, backend, encrypted: poolStorageEncrypted(backend), unavailable },
  }
}

/** Whether the keyring answers at all; a backend without a probe is assumed to. */
async function probeKeyring<T>(keyring: ProbeableKeyringStore<T>): Promise<{ available: boolean; reason?: string }> {
  if (typeof keyring.ping !== 'function') return { available: true }
  return keyring.ping()
}

/**
 * Human description of where a resolved pool lives, for diagnostics.
 *
 * A location, never a credential: the sentence the pool printed before, now
 * derived from the backend that actually won.
 */
export function describePoolStoragePath(
  platform: NodeJS.Platform,
  poolFile: string,
  storage: PoolStorageDto,
  keychainService: string,
  account: string,
): string {
  if (storage.backend === 'dpapi') return `${poolFile}.dpapi`
  if (storage.backend === 'credentials') return `credentials://${poolRecordKey(account)}`
  return `${platform === 'darwin' ? 'Keychain' : 'Secret Service'}: ${keychainService}/${account}`
}
