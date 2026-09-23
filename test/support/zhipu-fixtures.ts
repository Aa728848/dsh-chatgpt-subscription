import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import type { CredentialStore } from '../../src/host/token-store.ts'
import {
  FileCredentialStore,
  parseZhipuCredentials,
  type ZhipuCredentials,
} from '../../src/host/zhipu/token-store.ts'
import type { ZhipuAccountPool } from '../../src/host/zhipu/account-pool.ts'
import { ZhipuAccountPool as ZhipuPool } from '../../src/host/zhipu/account-pool.ts'

/** Temporary directories a test created; the suite removes them afterwards. */
export const temporaryDirs: string[] = []

/** An in-memory encrypted-store double, so tests never touch a platform store. */
function memoryBackend(): CredentialStore<ZhipuCredentials> {
  let value: ZhipuCredentials | null = null
  return {
    async load() { return value },
    async save(next) { value = next },
    async clear() { value = null },
  }
}

/**
 * A credential store backed by memory, or by a real file when one is named.
 *
 * `FileCredentialStore` serializes through the encrypted platform backend, which
 * on Windows spawns a helper process; pointing it at a memory double keeps these
 * tests about this route's own logic.
 */
export async function createZhipuCredentialStore(
  options: { credentials?: ZhipuCredentials; backend?: CredentialStore<ZhipuCredentials> } = {},
): Promise<FileCredentialStore> {
  const backend = options.backend ?? memoryBackend()
  if (options.credentials !== undefined) await backend.save(options.credentials)
  return new FileCredentialStore(path.join(await zhipuOptions(), 'credentials.json'), backend)
}

/**
 * A scratch *file* path for a settings store.
 *
 * Distinct from {@link zhipuOptions}, which returns a directory: the settings
 * store writes through a temp file and renames onto the path it was given, and
 * renaming onto a directory fails with EPERM.
 */
export async function zhipuSettingsFile(): Promise<string> {
  return path.join(await zhipuOptions(), 'models.json')
}

/** A unique scratch directory for a temporary file. */
export async function zhipuOptions(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhipu-test-'))
  temporaryDirs.push(dir)
  return dir
}

/**
 * A `fetch` double that routes every call through one responder.
 *
 * The adapter passes its own `fetchFn` into every request it makes, so a test
 * observes exactly the requests this route issues without stubbing globals.
 */
export function makeZhipuFetch(respond: (url: string, init?: RequestInit) => Response): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    respond(String(input), init)) as unknown as typeof fetch
}

/**
 * An in-memory pool backend.
 *
 * The pool's own file path is the real encrypted store location, which would
 * make one test's accounts visible to the next; this keeps each pool isolated
 * to the test that built it.
 */
export function memoryPoolBackend<T>(): CredentialStore<T> {
  let value: T | null = null
  return {
    async load() { return value },
    async save(next) { value = next },
    async clear() { value = null },
  }
}

/** A pool whose storage is in memory, so tests never share pool state. */
export function createZhipuPool(
  options: { store: FileCredentialStore; preferAccountId?: () => string | null } ,
): ZhipuAccountPool {
  return new ZhipuPool({
    store: options.store,
    backend: memoryPoolBackend(),
    ...(options.preferAccountId === undefined ? {} : { preferAccountId: options.preferAccountId }),
  })
}

/** One valid credential, for tests that need an account to exist. */
export function sampleCredentials(overrides: Partial<ZhipuCredentials> = {}): ZhipuCredentials {
  return { ...parseZhipuCredentials({ apiKey: 'key-abc-1234', region: 'intl' }), ...overrides }
}
