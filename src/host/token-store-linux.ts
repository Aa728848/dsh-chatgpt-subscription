import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TokenStore, StoredOAuthCredentials } from './token-store.ts'
import { parseStoredCredentials } from './token-store.ts'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

export function defaultLinuxCredentialPath(): string {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(dshHome, 'storages', 'dsh-chatgpt-subscription', 'oauth.json')
}

/**
 * Linux credential storage protected by owner-only filesystem permissions.
 * The payload is not encrypted at rest, so callers must report that distinction
 * instead of presenting this store as equivalent to Windows DPAPI.
 */
export class LinuxFileTokenStore implements TokenStore {
  readonly storage = { kind: 'linux-file', encrypted: false } as const
  private readonly noFollow = constants.O_NOFOLLOW

  constructor(private readonly path = defaultLinuxCredentialPath()) {
    if (process.platform !== 'linux') throw new Error('Linux credential storage requires Linux')
    if (this.noFollow === undefined) throw new Error('Linux credential storage requires O_NOFOLLOW support')
    if (dirname(path) === path) throw new Error('invalid Linux credential path')
  }

  async load(): Promise<StoredOAuthCredentials | null> {
    let handle
    try {
      handle = await open(this.path, constants.O_RDONLY | this.noFollow)
    } catch (error) {
      if (isMissing(error)) return null
      throw new Error('Linux credential read failed', { cause: error })
    }

    try {
      const stats = await handle.stat()
      if (!stats.isFile()) throw new Error('credential path is not a regular file')
      if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
        throw new Error('credential file is owned by another user')
      }
      if ((stats.mode & 0o777) !== FILE_MODE) {
        throw new Error('credential file permissions must be 0600')
      }
      const payload = await handle.readFile({ encoding: 'utf8' })
      return parseStoredCredentials(JSON.parse(payload) as unknown)
    } catch (error) {
      throw new Error('Linux credential payload is invalid or insecure', { cause: error })
    } finally {
      await handle.close()
    }
  }

  async save(value: StoredOAuthCredentials): Promise<void> {
    const directory = dirname(this.path)
    const temporary = `${this.path}.tmp-${randomUUID()}`
    try {
      const existing = await lstat(this.path)
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error('credential path is not a regular file')
      }
      assertOwnedByCurrentUser(existing.uid, 'credential file')
    } catch (error) {
      if (!isMissing(error)) throw new Error('Linux credential write failed', { cause: error })
    }
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE })
    const directoryStats = await stat(directory)
    if (!directoryStats.isDirectory()) throw new Error('Linux credential directory is invalid')
    assertOwnedByCurrentUser(directoryStats.uid, 'credential directory')
    await chmod(directory, DIRECTORY_MODE)

    let handle
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE)
      await handle.writeFile(JSON.stringify(value), { encoding: 'utf8' })
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, this.path)
      await chmod(this.path, FILE_MODE)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw new Error('Linux credential write failed', { cause: error })
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path)
    } catch (error) {
      if (isMissing(error)) return
      throw new Error('Linux credential deletion failed', { cause: error })
    }
  }
}

function assertOwnedByCurrentUser(owner: number, label: string): void {
  if (typeof process.getuid === 'function' && owner !== process.getuid()) {
    throw new Error(`${label} is owned by another user`)
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
