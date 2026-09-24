import fs from 'node:fs/promises'
import path from 'node:path'
import { dshHomeDir } from './home.ts'

/**
 * Persistent snapshot for one provider's live model catalog.
 *
 * The in-memory catalog caches keep a process alive between requests, but they
 * start cold: on the first call after a restart (or a plugin reinstall) the
 * picker and the settings page both wait on the upstream listing before they
 * can render anything, and an unreachable endpoint turns that wait into the
 * full discovery timeout — "the model server is unavailable" on a fresh
 * install. The catalog is not fast-moving data, so the last successful listing
 * is persisted to `<DSH_HOME>/storages/` and rehydrated into the in-memory
 * cache on first use. A snapshot the caller can read is therefore available
 * from the very first call, with no network in the path.
 *
 * Writes are best-effort: persistence is an optimization, never a capability.
 * A read-only home or a locked file must not fail the fetch that produced the
 * snapshot.
 */

/** File name of the persisted snapshot for one catalog. */
export function catalogSnapshotPath(name: string): string {
  return path.join(dshHomeDir(), 'storages', `${name}-catalog.json`)
}

/**
 * Read the persisted snapshot for one catalog.
 *
 * Shape errors and unreadable files both return `undefined` — the caller keeps
 * its in-memory state, and the next successful fetch overwrites the file.
 */
export async function readCatalogSnapshot<T>(
  name: string,
  parseModels: (value: unknown) => T[] | undefined,
): Promise<{ fetchedAt: number; models: T[] } | undefined> {
  try {
    const content = await fs.readFile(catalogSnapshotPath(name), 'utf8')
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    const fetchedAt = record.fetchedAt
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt) || fetchedAt <= 0) return undefined
    const models = parseModels(record.models)
    if (models === undefined || models.length === 0) return undefined
    return { fetchedAt, models }
  } catch {
    return undefined
  }
}

/** Persist one snapshot; a failure is logged nowhere and never thrown. */
export async function writeCatalogSnapshot<T>(name: string, models: T[], fetchedAt: number): Promise<void> {
  try {
    const filePath = catalogSnapshotPath(name)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify({ fetchedAt, models }, null, 2), 'utf8')
    await fs.rename(tmp, filePath)
  } catch {
    // Persistence is best-effort: an unwritable home must not fail the caller.
  }
}

/**
 * Warm an in-memory cache from the persisted snapshot when it is fresher than
 * what the cache currently holds. Called lazily on the first cache miss of a
 * process, so a restart serves the previous listing without waiting on the
 * network.
 *
 * @returns the snapshot's `fetchedAt`, or `0` when no usable snapshot exists —
 *   the caller then fetches as before.
 */
export async function rehydrateCatalogCache<T>(
  name: string,
  parseModels: (value: unknown) => T[] | undefined,
  accept: (fetchedAt: number, models: T[]) => void,
  currentFetchedAt: number,
): Promise<number> {
  const snapshot = await readCatalogSnapshot(name, parseModels)
  if (snapshot === undefined || snapshot.fetchedAt <= currentFetchedAt) return 0
  accept(snapshot.fetchedAt, snapshot.models)
  return snapshot.fetchedAt
}
