import os from 'node:os'
import path from 'node:path'
import type { CredentialStore } from '../../src/host/token-store.ts'
import {
  FileCredentialStore,
  ManagedCredentialStore,
  type WorkBuddyCredentials,
} from '../../src/host/workbuddy/token-store.ts'

type ManagedPayload = { version: 1; accounts: WorkBuddyCredentials[] }

/**
 * In-memory encrypted backend for the plugin-managed WorkBuddy accounts.
 *
 * The real backend dispatches per platform: Windows DPAPI and the macOS
 * Keychain both work headlessly, but the Linux Secret Service needs
 * `secret-tool` and an unlocked keyring that a CI runner does not have. Every
 * WorkBuddy test therefore failed on `ubuntu-latest` — not on WorkBuddy
 * behaviour, but on the host keyring being absent.
 */
export function memoryManagedBackend(): CredentialStore<ManagedPayload> {
  let value: ManagedPayload | null = null
  return {
    async load() { return value === null ? null : structuredClone(value) },
    async save(next) { value = structuredClone(next) },
    async clear() { value = null },
  }
}

function memoryManagedStore(): ManagedCredentialStore {
  const filePath = path.join(os.tmpdir(), `wb-managed-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  return new ManagedCredentialStore(filePath, memoryManagedBackend())
}

/**
 * A WorkBuddy credential store whose managed half is in memory.
 *
 * The desktop half still scans a real directory (explicit `dir`, or the
 * `CODEBUDDY_AUTH_DIR` the test setup isolates), so these tests keep measuring
 * the scan, selection and refresh behaviour they are about. Only the encrypted
 * pool is replaced, which is where the platform dependency lives.
 */
export function createWorkBuddyStore(dir?: string, cacheTtlMs?: number): FileCredentialStore {
  return new FileCredentialStore(dir, cacheTtlMs, memoryManagedStore())
}
