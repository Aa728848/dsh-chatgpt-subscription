import { stat } from 'node:fs/promises'

/**
 * Identity a file-backed credential store reports when nothing is stored.
 *
 * An absent file is a *known* answer, not a cache miss: the store returns null
 * without decrypting anything, which is what makes the signed-out settings card
 * cheap to render.
 */
export const ABSENT_CREDENTIAL = 'absent'

/**
 * Cheap identity of one credential file: its last write time and size.
 *
 * Returns {@link ABSENT_CREDENTIAL} when the file does not exist, and `null`
 * when its state cannot be established at all (a stat failure other than
 * ENOENT) — `null` disables caching for that read rather than risking a stale
 * answer.
 */
export async function fileCredentialIdentity(path: string): Promise<string | null> {
  try {
    const stats = await stat(path)
    return `${stats.mtimeMs}:${stats.size}`
  } catch (error) {
    return isMissing(error) ? ABSENT_CREDENTIAL : null
  }
}

/**
 * Identity for a keyring-backed credential, which has no file to compare.
 *
 * A time bucket is the honest substitute: a burst of reads inside one bucket
 * shares a single keyring lookup, and the bucket bounds how long a write from
 * another process can go unnoticed. Fifteen seconds matches the scan cache the
 * WorkBuddy store already keeps, and stays far below the polling interval of
 * every surface that reads these credentials.
 */
export async function keyringCredentialIdentity(ttlMs: number): Promise<string> {
  return `bucket:${Math.floor(Date.now() / ttlMs)}`
}

/**
 * In-memory snapshot of one credential read.
 *
 * Reading a credential is expensive on every platform this plugin supports:
 * Windows runs a DPAPI unprotect through a spawned `powershell.exe` (measured
 * at 200-243 ms on a real machine), macOS spawns `security`, and Linux spawns
 * `secret-tool`. One settings request reads several credentials — a pool is
 * read once per `read()` call, and a status card asks for the pool twice — so
 * opening a tab cost 3-5 process launches and took 1-3 s.
 *
 * A snapshot is reused only while the stored value is provably unchanged, so a
 * write from another process (the CLI login helper, a second Host) is still
 * observed. The identity is read *before* the value: a write that lands during
 * a read leaves the cached identity older than the stored bytes, so the next
 * read compares against a newer identity and decrypts again. Reading it after
 * would cache the older value under the newer identity and hide that write.
 *
 * Concurrent reads that observe the same identity share one in-flight read,
 * which is what makes the two reads inside `readPoolStatus` cost one launch
 * rather than two.
 *
 * Every write through the owning store calls {@link invalidate}, so the
 * write-then-read verification the pools perform still reads real storage
 * instead of the snapshot it just wrote.
 */
export class CredentialReadCache<T> {
  private entry: { identity: string; value: T | null } | null = null
  private pending: { identity: string; promise: Promise<T | null> } | null = null

  /**
   * @param identity - cheap identity of the stored value; `null` disables
   *   caching for the read.
   */
  constructor(private readonly identity: () => Promise<string | null>) {}

  /**
   * Read through the snapshot.
   *
   * @param read - the expensive read, invoked only when the snapshot cannot
   *   answer.
   * @returns the stored value, or null when nothing is stored.
   */
  async load(read: () => Promise<T | null>): Promise<T | null> {
    const identity = await this.identity().catch(() => null)
    if (identity === null) return read()

    if (this.entry !== null && this.entry.identity === identity) return this.entry.value
    // Nothing is stored: answering null skips the read entirely.
    if (identity === ABSENT_CREDENTIAL) {
      this.entry = { identity, value: null }
      return null
    }
    if (this.pending !== null && this.pending.identity === identity) return this.pending.promise

    const promise = read()
    this.pending = { identity, promise }
    const settle = (value: T | null): void => {
      if (this.pending !== null && this.pending.promise === promise) this.pending = null
      this.entry = { identity, value }
    }
    promise.then(settle, () => {
      if (this.pending !== null && this.pending.promise === promise) this.pending = null
    })
    return promise
  }

  /** Drop the snapshot; the next read consults storage again. */
  invalidate(): void {
    this.entry = null
    this.pending = null
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}