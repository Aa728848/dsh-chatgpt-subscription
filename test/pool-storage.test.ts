import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AccountPoolCore,
  poolCredentialAccount,
  type AccountPoolHooks,
} from '../src/host/common/account-pool.ts'
import {
  configurePoolStorage,
  CredentialsRecordStore,
  poolStorageChanged,
  resolvePoolStorage,
  resetPoolStorage,
  type ProbeableKeyringStore,
} from '../src/host/common/pool-storage.ts'
import { asCredentialsSeam, credentialsRecordKey, isCredentialKeySegment } from '../src/host/common/credentials-compat.ts'
import { SecretServiceCredentialStore } from '../src/host/credential-store-secret-service.ts'
import { CodexAccountPool, codexPoolPath } from '../src/host/codex-account-pool.ts'
import { CorruptStoredDocumentError, MemoryTokenStore, type CredentialStore } from '../src/host/token-store.ts'
import type { AccountRotationStrategy, PoolAccountSummaryDto } from '../src/shared/account-pool-contracts.ts'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))

afterEach(() => {
  resetPoolStorage()
  vi.resetAllMocks()
})

//
// Doubles
//

interface ToyCredentials {
  access: string
  refresh: string
  expiresAt: number
  email: string
}

interface ToyAccount {
  id: string
  alias: string
  credentials: ToyCredentials
  addedAt: number
  isPrimary?: boolean
  email?: string
}

type ToyPool = {
  version: 1
  activeAccountId?: string
  rotationStrategy: AccountRotationStrategy
  accounts: ToyAccount[]
}

/** The pool document's own parser: it drops nothing, so a round trip is exact. */
function parseToyPool(value: unknown): ToyPool {
  const record = value as Partial<ToyPool>
  if (typeof record !== 'object' || record === null || !Array.isArray(record.accounts)) {
    throw new Error('invalid toy pool')
  }
  return {
    version: 1,
    ...(typeof record.activeAccountId === 'string' ? { activeAccountId: record.activeAccountId } : {}),
    rotationStrategy: record.rotationStrategy ?? 'sequential',
    accounts: record.accounts,
  }
}

/** A keyring that answers, or refuses to, on demand. */
class FakeKeyring<T = unknown> implements ProbeableKeyringStore<T> {
  /** How many times the resolver asked whether this keyring answers. */
  pings = 0

  constructor(private data: T | null = null, public available = true) {}

  async ping(): Promise<{ available: boolean; reason?: string }> {
    this.pings += 1
    return this.available ? { available: true } : { available: false, reason: 'no Secret Service here' }
  }

  async load(): Promise<T | null> {
    if (!this.available) throw new Error('no Secret Service here')
    return this.data
  }

  async save(value: T): Promise<void> {
    if (!this.available) throw new Error('no Secret Service here')
    this.data = value
  }

  async clear(): Promise<void> {
    this.data = null
  }
}

/**
 * A keyring that records every call it receives.
 *
 * Used to prove a NEGATIVE: with the credential store chosen, no path — read,
 * save, or a refresh writing its rotated token back — may reach the Secret
 * Service. A tripwire is the only way to assert that, because "the pool worked"
 * is equally true when it works through the wrong store.
 */
class TripwireKeyring<T> implements ProbeableKeyringStore<T> {
  readonly calls: string[] = []

  async ping(): Promise<{ available: boolean; reason?: string }> {
    this.calls.push('ping')
    return { available: true }
  }

  async load(): Promise<T | null> {
    this.calls.push('load')
    throw new Error('the keyring must not be read when another backend is configured')
  }

  async save(): Promise<void> {
    this.calls.push('save')
    throw new Error('the keyring must not be written when another backend is configured')
  }

  async clear(): Promise<void> {
    this.calls.push('clear')
    throw new Error('the keyring must not be cleared when another backend is configured')
  }
}

/**
 * The seam's own key grammar, copied from `@deepseek-ai/dsh-credentials`
 * (`KEY_SEGMENT_PATTERN`): each of the two segments of `<scope>/<id>`.
 */
const SEAM_KEY_SEGMENT = /^[a-z][a-z0-9-]*$/

/**
 * DSH's credential seam, in memory.
 *
 * Deliberately only the record half: `readRecord` / `modifyRecord` /
 * `deleteRecord`, exactly the three calls `credentials-compat.ts` states. A seam
 * double that also offered `set`/`unset` would let a mistake in the plugin pass by
 * calling a method the real `CredentialProvider` has but the pool must not use.
 *
 * And it validates keys the way the REAL seam does, which is not pedantry: the
 * seam's write path does not check a key, so a bad key is written happily and only
 * fails on the next start, when the whole record document is parsed — taking every
 * other credential on the host with it. A double that accepted anything made the
 * tests blind to exactly that, because both sides of the assertion were written by
 * the same expression.
 */
class FakeCredentialsSeam {
  readonly records = new Map<string, { kind: 'grant'; payload: unknown }>()
  failWrites = false
  modifyCalls = 0

  /** Reject a key the real seam rejects, with the real seam's message. */
  private checkKey(key: string): void {
    const segments = key.split('/')
    if (segments.length !== 2 || !segments.every((segment) => SEAM_KEY_SEGMENT.test(segment))) {
      throw new TypeError(`credential key segment "${key}" must match ${String(SEAM_KEY_SEGMENT)}`)
    }
  }

  async readRecord(key: string) {
    this.checkKey(key)
    return this.records.get(key)
  }

  async modifyRecord(key: string, mutate: (current: { kind: 'grant'; payload: unknown } | undefined) => Promise<{ kind: 'grant'; payload: unknown } | undefined>) {
    this.checkKey(key)
    this.modifyCalls += 1
    if (this.failWrites) throw new Error('the credential document is not writable')
    const next = await mutate(this.records.get(key))
    if (next === undefined) return this.records.get(key)
    this.records.set(key, next)
    return next
  }

  async deleteRecord(key: string): Promise<void> {
    this.checkKey(key)
    this.records.delete(key)
  }
}

const silentLogger = { info: vi.fn(), warn: vi.fn() }

function request<T>(overrides: Partial<Parameters<typeof resolvePoolStorage<T>>[0]> = {}): Parameters<typeof resolvePoolStorage<T>>[0] {
  return {
    platform: 'linux',
    displayName: 'Toy',
    poolFile: '/tmp/toy-pool.json',
    keychainService: 'dsh-toy-pool',
    account: 'account-digest',
    parsePoolData: (value) => value as T,
    logger: silentLogger,
    ...overrides,
  }
}

//
// Selection: the configured mode, per platform
//

describe('account pool storage selection', () => {
  it('defaults to the platform keyring when nothing is configured', async () => {
    // The default is the whole compatibility promise: an install that never
    // mentions `poolStorage` keeps the store it always had.
    const desktop = new FakeKeyring()
    const win = await resolvePoolStorage(request<unknown>({ platform: 'win32', desktopStore: desktop }))
    expect(win.storage).toMatchObject({ mode: 'keyring', backend: 'dpapi', encrypted: true })
    expect(win.store).toBe(desktop)

    const mac = await resolvePoolStorage(request<unknown>({ platform: 'darwin', desktopStore: desktop }))
    expect(mac.storage).toMatchObject({ mode: 'keyring', backend: 'keychain', encrypted: true })
    expect(mac.store).toBe(desktop)

    const keyring = new FakeKeyring()
    const linux = await resolvePoolStorage(request<unknown>({ platform: 'linux', keyring }))
    expect(linux.storage).toMatchObject({ mode: 'keyring', backend: 'keyring', encrypted: true })
    expect(linux.store).toBe(keyring)
  })

  it('keeps the credential store available on Windows and macOS', async () => {
    // DSH's own store is not platform-bound, so a macOS or Windows server can
    // choose it too — and choosing it must not touch DPAPI or the Keychain.
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      const seam = new FakeCredentialsSeam()
      const resolution = await resolvePoolStorage(request<unknown>({
        platform,
        mode: 'credentials',
        credentials: seam,
        desktopStore: new TripwireKeyring<unknown>(),
      }))
      expect(resolution.storage).toMatchObject({ mode: 'credentials', backend: 'credentials', encrypted: false })
      expect(resolution.store).toBeInstanceOf(CredentialsRecordStore)
      await resolution.store.save({ version: 1, rotationStrategy: 'sequential', accounts: [] })
      expect(seam.records.size).toBe(1)
    }
  })

  it('still stores in the platform keyring when `keyring` is configured there', async () => {
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      const desktop = new FakeKeyring()
      const seam = new FakeCredentialsSeam()
      const resolution = await resolvePoolStorage(request<unknown>({
        platform,
        mode: 'keyring',
        credentials: seam,
        desktopStore: desktop,
      }))
      expect(resolution.store).toBe(desktop)
      expect(resolution.storage.backend).toBe(platform === 'win32' ? 'dpapi' : 'keychain')
      expect(seam.records.size).toBe(0)
    }
  })

  it('refuses a platform it has no keyring for', async () => {
    await expect(resolvePoolStorage(request<unknown>({ platform: 'freebsd' as NodeJS.Platform, mode: 'keyring' })))
      .rejects.toThrow('Toy pool storage requires Windows, macOS, or Linux.')
  })

  it('reports an explicit credentials choice on a harness that has no credential store', async () => {
    const resolution = await resolvePoolStorage(request<unknown>({ platform: 'linux', mode: 'credentials' }))
    // Not silently replaced by the keyring: the card must say what was asked for
    // and why it could not be had.
    expect(resolution.storage).toMatchObject({
      mode: 'credentials',
      backend: 'credentials',
      unavailable: 'no-credentials-service',
    })
    await expect(resolution.store.load()).rejects.toThrow('no ctx.credentials service')
    await expect(resolution.store.save({})).rejects.toThrow('no ctx.credentials service')
    expect(silentLogger.warn).toHaveBeenCalledWith(expect.stringContaining('poolStorage is "credentials"'))
  })
})

//
// The server case this option exists for
//

describe('a Linux host with no secret service', () => {
  /** `secret-tool` absent: the spawn fails with ENOENT, as on a server without libsecret. */
  function secretToolMissing(): void {
    spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
      })
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' })))
      return child
    })
  }

  /** `secret-tool` ran and answered with this exit code, stdout and stderr. */
  function secretToolAnswered(code: number, stdout = '', stderr = ''): void {
    spawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
      })
      queueMicrotask(() => {
        child.stdout.end(stdout)
        child.stderr.end(stderr)
        child.emit('close', code)
      })
      return child
    })
  }

  function realKeyring(): SecretServiceCredentialStore<unknown> {
    return new SecretServiceCredentialStore('dsh-toy-pool', 'account-digest', (value) => value)
  }

  it('treats an empty lookup as a keyring that answers, and a message as one that does not', async () => {
    // Nothing stored: exit 1 with empty stderr. The daemon answered — that is the
    // whole question, and calling it "no keyring" would push every desktop user's
    // pool off its keyring on first start.
    secretToolAnswered(1)
    expect(await realKeyring().ping()).toEqual({ available: true })

    // A locked keyring or no session bus: exit 1 WITH a message.
    secretToolAnswered(1, '', 'secret-tool: Невозможно автоматически запустить D-Bus без X11 $DISPLAY')
    const unavailable = await realKeyring().ping()
    expect(unavailable.available).toBe(false)
    expect(unavailable.reason).toContain('Secret Service')
  })

  it('fails a `keyring` save with a sentence telling the user to switch, never silently', async () => {
    secretToolMissing()
    const seam = new FakeCredentialsSeam()
    const resolution = await resolvePoolStorage(request<unknown>({
      mode: 'keyring',
      keyring: realKeyring() as ProbeableKeyringStore<unknown>,
      credentials: seam,
    }))

    expect(resolution.storage).toMatchObject({ mode: 'keyring', backend: 'keyring', unavailable: 'keyring-unreachable' })
    // The store is the keyring, not the credential store: a silent fallback would
    // move the accounts somewhere the card does not name.
    await expect(resolution.store.save({ version: 1, rotationStrategy: 'sequential', accounts: [] }))
      .rejects.toThrow('Switch "Account storage" to the DSH credential store')
    expect(seam.records.size).toBe(0)
    expect(silentLogger.warn).toHaveBeenCalledWith(expect.stringContaining('no reachable desktop keyring'))
  })

  it('saves and reads the pool through the credential store with no secret service at all', async () => {
    secretToolMissing()
    const seam = new FakeCredentialsSeam()
    const resolution = await resolvePoolStorage(request<unknown>({
      mode: 'credentials',
      keyring: realKeyring() as ProbeableKeyringStore<unknown>,
      credentials: seam,
    }))
    expect(resolution.storage).toMatchObject({ backend: 'credentials', encrypted: false })

    const document = { version: 1 as const, rotationStrategy: 'sequential' as const, accounts: [] }
    await resolution.store.save(document)
    expect(await resolution.store.load()).toEqual(document)
    // The prefixed id, not the bare digest: `04b082e7…`-style digests are not legal
    // seam segments, and the double now rejects them the way the real seam does.
    expect(seam.records.get('dsh-chatgpt-subscription/pool-account-digest')?.payload).toEqual(document)
  })
})

//
// The decision is taken once
//

describe('the resolved backend is cached per process', () => {
  const buildHooks = (
    overrides: Partial<AccountPoolHooks<ToyCredentials, ToyAccount, PoolAccountSummaryDto>> = {},
  ): AccountPoolHooks<ToyCredentials, ToyAccount, PoolAccountSummaryDto> => ({
    providerId: 'toy',
    displayName: 'Toy',
    poolFile: '/tmp/toy-pool.json',
    keychainService: 'dsh-toy-pool',
    parsePoolData: parseToyPool,
    createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
      id, alias, credentials, addedAt, isPrimary, email: credentials.email,
    }),
    dedupeKey: (credentials) => credentials.email,
    defaultAlias: (credentials, position) => credentials.email || `account ${position}`,
    expiresAt: (credentials) => credentials.expiresAt,
    ...overrides,
  })

  it('probes the keyring once, not once per request', async () => {
    const keyring = new FakeKeyring<ToyPool>()
    const seam = new FakeCredentialsSeam()
    configurePoolStorage({ mode: () => 'keyring', credentials: () => seam, logger: silentLogger })
    // `platform` pinned: this asserts the Linux keyring branch, and an ambient
    // `process.platform` would silently assert the DPAPI one on a Windows runner.
    const pool = new AccountPoolCore(buildHooks({ platform: 'linux', keyring }))

    await pool.addAccount({
      access: 'a', refresh: 'r', expiresAt: Date.now() + 3_600_000, email: 'a@example.com',
    })
    // Three request-path reads, one decision: a per-request probe would be a
    // `secret-tool` launch per model call and could hand one turn two stores.
    for (let index = 0; index < 3; index += 1) await pool.getEffectiveAccount()
    expect(keyring.pings).toBe(1)
  })

  it('resolves again only when the choice changes', async () => {
    const keyring = new FakeKeyring<ToyPool>()
    const seam = new FakeCredentialsSeam()
    configurePoolStorage({ mode: () => 'keyring', credentials: () => seam, logger: silentLogger })
    const pool = new AccountPoolCore(buildHooks({ platform: 'linux', keyring }))

    expect(await pool.poolStorage()).toMatchObject({ backend: 'keyring' })
    expect(keyring.pings).toBe(1)

    // What the settings route does after storing the new choice.
    poolStorageChanged()
    configurePoolStorage({ mode: () => 'credentials', credentials: () => seam, logger: silentLogger })
    expect(await pool.poolStorage()).toMatchObject({ backend: 'credentials' })
  })

  it('picks up a credentials service that mounts after the plugin was applied', async () => {
    // The service is not in `inject`, so nothing orders it before `apply`. A getter
    // is what lets the second resolve see it; a value captured once would report
    // `no-credentials-service` for the life of the process.
    let seam: FakeCredentialsSeam | undefined
    configurePoolStorage({ mode: () => 'credentials', credentials: () => seam, logger: silentLogger })
    const keyring = new FakeKeyring<ToyPool>(null, false)
    const pool = new AccountPoolCore(buildHooks({ platform: 'linux', keyring }))

    expect(await pool.poolStorage()).toMatchObject({
      mode: 'credentials',
      backend: 'credentials',
      unavailable: 'no-credentials-service',
    })

    seam = new FakeCredentialsSeam()
    poolStorageChanged()
    const mounted = await pool.poolStorage()
    expect(mounted).toMatchObject({ mode: 'credentials', backend: 'credentials', encrypted: false })
    expect(mounted?.unavailable).toBeUndefined()

    // And it is usable at once, not merely reported as such.
    await pool.addAccount({ access: 'a', refresh: 'r', expiresAt: Date.now() + 3_600_000, email: 'late@example.com' })
    expect(seam.records.size).toBe(1)
  })

  it('names the platform keyring for a caller-supplied store', async () => {
    // `hooks.backend` replaces the store, not the choice; inventing
    // `{ backend: 'keyring', encrypted: false }` for it named an unencrypted keyring
    // that does not exist, and the wrong store on Windows and macOS.
    for (const [platform, backend] of [['win32', 'dpapi'], ['darwin', 'keychain'], ['linux', 'keyring']] as const) {
      const pool = new AccountPoolCore(buildHooks({ platform, backend: new FakeKeyring<ToyPool>() }))
      expect(await pool.poolStorage()).toEqual({ mode: 'keyring', backend, encrypted: true })
    }
  })
})

//
// The record key: the one thing here that can destroy a host's credentials
//

describe('the pool record key', () => {
  it('keeps the digest inside the seam grammar when it starts with a digit or a letter', async () => {
    // Real digests: `04b082e7…` is what `minimax-code-pool.json` hashes to on this
    // host and `165dd7f2…` what `codex-pool.json` does. 62.5% of sha256 digests
    // start with a digit, and the seam rejects `04b082e7…` as a segment — so the
    // prefix is the difference between a working pool and a credential document
    // that stops loading on the next start.
    // Two digit-leading digests (illegal as a segment) and one letter-leading.
    expect(isCredentialKeySegment('04b082e7deadbeef')).toBe(false)
    expect(isCredentialKeySegment('bf13945fdeadbeef')).toBe(true)
    for (const digest of ['04b082e7deadbeef', '165dd7f2deadbeef', 'bf13945fdeadbeef']) {
      expect(isCredentialKeySegment(`pool-${digest}`)).toBe(true)
      const seam = new FakeCredentialsSeam()
      const resolution = await resolvePoolStorage(request<unknown>({
        platform: 'linux', mode: 'credentials', credentials: seam, account: digest,
      }))
      const store = resolution.store as CredentialsRecordStore<unknown>
      expect(store.recordKey()).toBe(`dsh-chatgpt-subscription/pool-${digest}`)
      expect(store.recordKey()).toMatch(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/)

      // The double validates the key like the real seam, so this is the seam's
      // own rule applied to the address the pool really uses.
      const document = { version: 1 as const, rotationStrategy: 'sequential' as const, accounts: [] }
      await store.save(document)
      expect(await store.load()).toEqual(document)
      expect(seam.records.has(`dsh-chatgpt-subscription/pool-${digest}`)).toBe(true)
    }
  })

  it('refuses to build a key the seam would reject, instead of handing it over', () => {
    // Locally, in the line that named the segment: a bad key must never reach a
    // seam whose write path does not validate it.
    expect(() => credentialsRecordKey('dsh-chatgpt-subscription', '04b082e7deadbeef')).toThrow(TypeError)
    expect(() => credentialsRecordKey('Dsh-Chat', 'pool-04b0')).toThrow(/must match/)
    expect(() => credentialsRecordKey('dsh-chatgpt-subscription', 'pool_04b0')).toThrow(TypeError)
    expect(credentialsRecordKey('dsh-chatgpt-subscription', 'pool-04b082e7')).toBe('dsh-chatgpt-subscription/pool-04b082e7')
  })

  it('is enforced by the double, so a bare digest cannot pass unnoticed', async () => {
    // The shape of regression this test exists for: the seam double is the only
    // witness, and it has to reject what the real seam rejects.
    const seam = new FakeCredentialsSeam()
    const store = new CredentialsRecordStore(seam, 'dsh-chatgpt-subscription/04b082e7deadbeef', parseToyPool)
    await expect(store.save({ version: 1, rotationStrategy: 'sequential', accounts: [] })).rejects.toThrow(TypeError)
    await expect(store.load()).rejects.toThrow(TypeError)
    expect(seam.records.size).toBe(0)
  })
})

//
// The credential-store backend itself
//

describe('CredentialsRecordStore', () => {
  const key = credentialsRecordKey('dsh-chatgpt-subscription', 'account-digest')

  it('round-trips a pool document through the seam record space', async () => {
    const seam = new FakeCredentialsSeam()
    const store = new CredentialsRecordStore(seam, key, parseToyPool)
    expect(await store.load()).toBeNull()

    const document: ToyPool = {
      version: 1,
      activeAccountId: 'acc_1',
      rotationStrategy: 'round-robin',
      accounts: [{
        id: 'acc_1',
        alias: 'main',
        credentials: { access: 'a', refresh: 'r', expiresAt: 1, email: 'a@example.com' },
        addedAt: 2,
        isPrimary: true,
      }],
    }
    await store.save(document)

    expect(seam.records.get(key)?.kind).toBe('grant')
    expect(await store.load()).toEqual(document)
    // The payload crosses the seam as plain JSON: the record space promises a JSON
    // round trip and nothing else, and a `undefined` field would vanish silently.
    expect(JSON.parse(JSON.stringify(seam.records.get(key)?.payload))).toEqual(document)

    await store.clear()
    expect(await store.load()).toBeNull()
    expect(seam.records.has(key)).toBe(false)
  })

  it('normalizes the document before it is handed over', async () => {
    const seam = new FakeCredentialsSeam()
    const store = new CredentialsRecordStore(seam, key, (value) => value as Record<string, unknown>)
    await store.save({ version: 1, dropped: undefined, kept: 'yes' })
    expect(seam.records.get(key)?.payload).toEqual({ version: 1, kept: 'yes' })
  })

  it('refuses a record that is not a grant', async () => {
    const seam = new FakeCredentialsSeam()
    seam.records.set(key, { kind: 'api-key' } as never)
    await expect(new CredentialsRecordStore(seam, key, parseToyPool).load())
      .rejects.toThrow('pool record is not a grant')
  })

  it('surfaces a write failure instead of reporting success', async () => {
    const seam = new FakeCredentialsSeam()
    seam.failWrites = true
    const store = new CredentialsRecordStore(seam, key, parseToyPool)
    await expect(store.save({ version: 1, rotationStrategy: 'sequential', accounts: [] }))
      .rejects.toThrow('the credential document is not writable')
    expect(seam.modifyCalls).toBe(1)
  })
})

//
// Through the pool core
//

describe('AccountPoolCore over the credential store', () => {
  // The pool addresses its record by `pool-` plus the digest of its own file: the
  // prefix is what makes the id a legal seam segment (`account-digest` below is a
  // fixed stand-in only for the tests that call `resolvePoolStorage` directly).
  // Spelled out here rather than rebuilt with the production helper, so the
  // address itself is asserted and not just compared to itself.
  const recordKey = `dsh-chatgpt-subscription/pool-${poolCredentialAccount('/tmp/toy-pool.json')}`

  const buildHooks = (
    overrides: Partial<AccountPoolHooks<ToyCredentials, ToyAccount, PoolAccountSummaryDto>> = {},
  ): AccountPoolHooks<ToyCredentials, ToyAccount, PoolAccountSummaryDto> => ({
    providerId: 'toy',
    displayName: 'Toy',
    poolFile: '/tmp/toy-pool.json',
    keychainService: 'dsh-toy-pool',
    parsePoolData: parseToyPool,
    createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
      id, alias, credentials, addedAt, isPrimary, email: credentials.email,
    }),
    dedupeKey: (credentials) => credentials.email,
    defaultAlias: (credentials, position) => credentials.email || `account ${position}`,
    expiresAt: (credentials) => credentials.expiresAt,
    ...overrides,
  })

  const credential = (n: number): ToyCredentials => ({
    access: `access-${n}`, refresh: `refresh-${n}`, expiresAt: Date.now() + 3_600_000, email: `acc${n}@example.com`,
  })

  beforeEach(() => {
    silentLogger.info.mockClear()
    silentLogger.warn.mockClear()
  })

  it('writes and reads accounts through ctx.credentials on a host with no keyring', async () => {
    const seam = new FakeCredentialsSeam()
    configurePoolStorage({ mode: () => 'credentials', credentials: () => seam, logger: silentLogger })
    const pool = new AccountPoolCore(buildHooks({ keyring: new FakeKeyring<ToyPool>(null, false) }))

    await pool.addAccount(credential(1))
    const data = await pool.read()
    expect(data.accounts).toHaveLength(1)
    expect(data.accounts[0]!.credentials.email).toBe('acc1@example.com')
    expect(seam.records.size).toBe(1)

    // A second instance over the same seam (a restart) reads the same accounts.
    const restarted = new AccountPoolCore(buildHooks({ keyring: new FakeKeyring<ToyPool>(null, false) }))
    expect((await restarted.read()).accounts).toHaveLength(1)
  })

  it('reports the backend it resolved, for the settings card', async () => {
    configurePoolStorage({ mode: () => 'credentials', credentials: () => new FakeCredentialsSeam(), logger: silentLogger })
    const pool = new AccountPoolCore(buildHooks({ keyring: new FakeKeyring<ToyPool>(null, false) }))
    expect(await pool.poolStorage()).toEqual({
      mode: 'credentials',
      backend: 'credentials',
      encrypted: false,
    })
    // The diagnostic sentence follows the backend, not the platform.
    expect(pool.path()).toContain('credentials://dsh-chatgpt-subscription/')
  })

  it('stays on the platform store when the deployment pins `keyring`', async () => {
    const keyring = new FakeKeyring<ToyPool>(null, false)
    configurePoolStorage({ mode: () => 'keyring', credentials: () => new FakeCredentialsSeam(), logger: silentLogger })
    // Pinned: the DTO asserted below is the Linux one (`keyring` + the probe
    // reason), and an ambient Windows runner resolves `dpapi` with no probe.
    const pool = new AccountPoolCore(buildHooks({ platform: 'linux', keyring }))
    expect(await pool.poolStorage()).toEqual({ mode: 'keyring', backend: 'keyring', encrypted: true, unavailable: 'keyring-unreachable' })
    // And the honest refusal with the hint, not a silent success somewhere else.
    await expect(pool.addAccount(credential(1)))
      .rejects.toThrow('Switch "Account storage" to the DSH credential store')
  })

  it('refuses writes on a store it declared unusable, while reads still project', async () => {
    // Two halves of one rule. A store the resolver declared unusable keeps its
    // documented reading — the line still shows what it has outside the pool, which
    // is what keeps a headless install usable — but a WRITE built from that read
    // would replace a document nobody can see with one built out of nothing, so it
    // refuses with the reason the card also shows.
    const legacy = vi.fn(async () => ({
      id: 'acc_legacy',
      alias: 'legacy',
      credentials: credential(9),
      addedAt: 1,
      isPrimary: true,
    }))
    configurePoolStorage({ mode: () => 'keyring', logger: silentLogger })
    const pool = new AccountPoolCore(buildHooks({
      platform: 'linux',
      keyring: new FakeKeyring<ToyPool>(null, false),
      legacyAccount: legacy,
    }))

    expect((await pool.read()).accounts.map((account) => account.id)).toEqual(['acc_legacy'])
    expect((await pool.listAccounts()).map((account) => account.id)).toEqual(['acc_legacy'])
    expect(await pool.poolStorage()).toMatchObject({ unavailable: 'keyring-unreachable' })

    await expect(pool.setStrategy('round-robin')).rejects.toThrow('storage is unavailable')
    await expect(pool.addAccount(credential(1))).rejects.toThrow('Switch "Account storage" to the DSH credential store')
  })

  it('fails loudly when the store refuses the write', async () => {
    const seam = new FakeCredentialsSeam()
    seam.failWrites = true
    configurePoolStorage({ mode: () => 'credentials', credentials: () => seam, logger: silentLogger })
    const pool = new AccountPoolCore(buildHooks())
    await expect(pool.addAccount(credential(1))).rejects.toThrow(/not writable/)
    // Nothing is left behind to be mistaken for a saved account.
    expect(await seam.readRecord(recordKey)).toBeUndefined()
  })

  it('reads the access token a request needs from the same backend it was saved in', async () => {
    const seam = new FakeCredentialsSeam()
    configurePoolStorage({ mode: () => 'credentials', credentials: () => seam, logger: silentLogger })
    const keyring = new TripwireKeyring<ToyPool>()
    const pool = new AccountPoolCore(buildHooks({ keyring, refresh: vi.fn() }))

    await pool.addAccount(credential(1))
    // A request path, not a settings read: this is the call the adapter makes per
    // model request, and it must serve the token that was just saved.
    const served = await pool.getEffectiveAccount()
    expect(served.credentials.access).toBe('access-1')
    expect(keyring.calls).toEqual([])

    // A restart re-resolves the backend from scratch and must find the account.
    const restarted = new AccountPoolCore(buildHooks({ keyring, refresh: vi.fn() }))
    expect((await restarted.getEffectiveAccount()).credentials.access).toBe('access-1')
    expect(keyring.calls).toEqual([])
  })

  it('writes a rotated refresh token back into the same backend, never the keyring', async () => {
    const seam = new FakeCredentialsSeam()
    configurePoolStorage({ mode: () => 'credentials', credentials: () => seam, logger: silentLogger })
    const keyring = new TripwireKeyring<ToyPool>()
    const refresh = vi.fn(async (credentials: ToyCredentials) => ({
      ...credentials,
      access: `refreshed-${credentials.access}`,
      refresh: `rotated-${credentials.refresh}`,
      expiresAt: Date.now() + 3_600_000,
    }))
    // Already inside the refresh margin, so the first request rotates the token.
    const pool = new AccountPoolCore(buildHooks({ keyring, refresh }))

    await pool.addAccount({ ...credential(1), expiresAt: Date.now() + 1_000 })
    const served = await pool.getEffectiveAccount()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(served.credentials.access).toBe('refreshed-access-1')

    // The rotation landed in DSH's credential store — the store the next process
    // will read — and nowhere else.
    const stored = await new CredentialsRecordStore(seam, recordKey, parseToyPool).load()
    expect(stored?.accounts[0]!.credentials.refresh).toBe('rotated-refresh-1')
    expect(stored?.accounts[0]!.credentials.access).toBe('refreshed-access-1')
    expect(keyring.calls).toEqual([])

    // And the rotated token is what the pool serves afterwards, from the store.
    expect((await pool.read()).accounts[0]!.credentials.refresh).toBe('rotated-refresh-1')
  })
})

//
// A store that did not answer is not an empty pool
//

describe('an unreadable pool store', () => {
  /** A store that holds a document but cannot be read right now: a keyring that did not answer. */
  class UnreadableStore<T> implements CredentialStore<T> {
    saves = 0
    constructor(public document: T) {}
    async load(): Promise<T | null> { throw new Error('keyring did not answer') }
    async save(): Promise<void> { this.saves += 1 }
    async clear(): Promise<void> { this.document = undefined as unknown as T }
  }

  const hooks = (
    overrides: Partial<AccountPoolHooks<ToyCredentials, ToyAccount, PoolAccountSummaryDto>>,
  ): AccountPoolHooks<ToyCredentials, ToyAccount, PoolAccountSummaryDto> => ({
    providerId: 'toy',
    displayName: 'Toy',
    poolFile: '/tmp/toy-pool.json',
    keychainService: 'dsh-toy-pool',
    parsePoolData: parseToyPool,
    createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
      id, alias, credentials, addedAt, isPrimary, email: credentials.email,
    }),
    dedupeKey: (credentials) => credentials.email,
    defaultAlias: (credentials, position) => credentials.email || `account ${position}`,
    expiresAt: (credentials) => credentials.expiresAt,
    ...overrides,
  })

  const account = (n: number): ToyAccount => ({
    id: `acc_${n}`,
    alias: `account ${n}`,
    credentials: { access: `a${n}`, refresh: `r${n}`, expiresAt: Date.now() + 3_600_000, email: `acc${n}@example.com` },
    addedAt: 1,
    ...(n === 1 ? { isPrimary: true } : {}),
  })

  const live = (): ToyPool => ({
    version: 1, activeAccountId: 'acc_1', rotationStrategy: 'sequential', accounts: [account(1), account(2)],
  })

  it('refuses a rotation-strategy write instead of saving an empty document', async () => {
    // The reproduced loss: read fails, the error is swallowed as "no accounts",
    // the mutator edits that empty pool and the write lands — the user sees only
    // "keyring did not answer" and has no accounts left.
    const store = new UnreadableStore(live())
    const pool = new AccountPoolCore(hooks({
      backend: store as unknown as CredentialStore<ToyPool>,
      storage: { mode: 'keyring', backend: 'keyring', encrypted: true },
    }))

    await expect(pool.setStrategy('round-robin')).rejects.toThrow('keyring did not answer')
    expect(store.saves).toBe(0)
    expect(store.document.accounts).toHaveLength(2)
  })

  it('refuses an account write for the same reason, and says which', async () => {
    const store = new UnreadableStore(live())
    const pool = new AccountPoolCore(hooks({
      backend: store as unknown as CredentialStore<ToyPool>,
      storage: { mode: 'keyring', backend: 'keyring', encrypted: true },
    }))

    await expect(pool.addAccount({
      access: 'a3', refresh: 'r3', expiresAt: Date.now() + 3_600_000, email: 'acc3@example.com',
    })).rejects.toThrow('keyring did not answer')
    expect(store.saves).toBe(0)
    expect(store.document.accounts).toHaveLength(2)
  })

  it('reports the store reason on read paths instead of "no accounts"', async () => {
    const store = new UnreadableStore(live())
    const pool = new AccountPoolCore(hooks({
      backend: store as unknown as CredentialStore<ToyPool>,
      storage: { mode: 'keyring', backend: 'keyring', encrypted: true },
      legacyAccount: async () => account(9),
    }))

    // Not the legacy single-credential projection, not an empty list: the reason.
    await expect(pool.listAccounts()).rejects.toThrow('keyring did not answer')
    await expect(pool.read()).rejects.toThrow('keyring did not answer')
    await expect(pool.getEffectiveAccount()).rejects.toThrow('keyring did not answer')
  })

  it('still recovers a document that does not parse, and repairs it on the next write', async () => {
    // The other half of the rule: a CORRUPT document is what a write repairs, so
    // it must stay recoverable — otherwise one bad byte locks the pool for good.
    class CorruptOnceStore implements CredentialStore<ToyPool> {
      corrupt = true
      document: ToyPool | null = null
      async load(): Promise<ToyPool | null> {
        if (this.corrupt) throw new CorruptStoredDocumentError('ChatGPT pool payload is invalid')
        return this.document
      }
      async save(value: ToyPool): Promise<void> {
        this.corrupt = false
        this.document = structuredClone(value)
      }
      async clear(): Promise<void> { this.document = null }
    }
    const store = new CorruptOnceStore()
    const pool = new AccountPoolCore(hooks({
      backend: store as unknown as CredentialStore<ToyPool>,
      storage: { mode: 'keyring', backend: 'keyring', encrypted: true },
      legacyAccount: async () => account(9),
    }))

    const recovered = await pool.read()
    expect(recovered.accounts).toHaveLength(1)
    expect(recovered.accounts[0]!.id).toBe('acc_9')

    await pool.addAccount({
      access: 'a1', refresh: 'r1', expiresAt: Date.now() + 3_600_000, email: 'acc1@example.com',
    })
    expect(store.document?.accounts).toHaveLength(2)
  })
})

//
// The ChatGPT pool, on its own hooks
//

describe('CodexAccountPool over the credential store', () => {
  it('serves a request and writes a rotated refresh token into DSH credentials', async () => {
    const seam = new FakeCredentialsSeam()
    configurePoolStorage({ mode: () => 'credentials', credentials: () => seam, logger: silentLogger })
    const pool = new CodexAccountPool({ store: new MemoryTokenStore() })
    pool.setRefresher({
      refreshAccount: async (credentials) => ({
        ...credentials,
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        expiresAt: Date.now() + 3_600_000,
      }),
    })

    // Inside the refresh margin: the first request rotates the pair.
    await pool.addAccount({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 1_000,
      accountId: 'acct-1',
      email: 'user@example.com',
    })

    expect((await pool.getEffectiveAccount()).credentials.accessToken).toBe('rotated-access')

    const record = seam.records.get(
      `dsh-chatgpt-subscription/pool-${poolCredentialAccount(codexPoolPath())}`,
    )
    expect(record?.kind).toBe('grant')
    const document = record?.payload as { accounts: Array<{ credentials: { refreshToken: string } }> }
    expect(document.accounts[0]!.credentials.refreshToken).toBe('rotated-refresh')
    expect(await pool.poolStorage()).toMatchObject({ mode: 'credentials', backend: 'credentials' })
  })
})

//
// The seam lookup itself
//

describe('asCredentialsSeam', () => {
  it('accepts the record half and refuses a partial service', () => {
    const seam = new FakeCredentialsSeam()
    expect(asCredentialsSeam(seam)).toBe(seam)
    expect(asCredentialsSeam(undefined)).toBeUndefined()
    expect(asCredentialsSeam(null)).toBeUndefined()
    expect(asCredentialsSeam({ readRecord: async () => undefined })).toBeUndefined()
    // A `set`/`unset`-only service is the reference half, not the record half: the
    // pool must not be written through an environment-variable-shaped slot.
    expect(asCredentialsSeam({ resolve: async () => undefined, set: async () => undefined })).toBeUndefined()
  })
})
