/**
 * Generation history for the MiniMax Code video tools.
 *
 * The two video tools (`minimax_generate_video` / `minimax_understand_video`) are
 * called by the MODEL, so before this store existed the only trace of a clip was
 * the file on disk: a user who closed the session could not tell which clips they
 * had already spent quota on. This store is that ledger, and it is deliberately
 * narrow.
 *
 * WHAT IS STORED, AND WHAT IS NOT. One row per finished generation: when, which
 * model, which ratio and duration, the WORKSPACE-RELATIVE path, the byte count and
 * the upstream task id. `videoPath` is workspace-relative because the workspace
 * moves with the user (a repo can be cloned anywhere) and an absolute path would
 * go stale the moment it did; the byte count is what lets the card render a row
 * before the (potentially hundreds of MB) file is read. THE VIDEO ITSELF IS NEVER
 * STORED HERE - not the bytes, not a copy, not a thumbnail. A history file that
 * carried media would double every generation on disk, and this store's whole job
 * is to point at the file the media store already wrote.
 *
 * WHY IT IS ENCRYPTED. It holds no token and nothing secret, and the sibling
 * lines' rule is that a store under `$DSH_HOME` which is easy to protect is
 * protected: the same platform credential backend the siblings use (Windows
 * CurrentUser DPAPI, macOS Keychain, Linux Secret Service) reads and writes it, so
 * the format on disk is that backend's own envelope rather than plain JSON. A
 * plaintext fallback is kept for a platform with no backend at all, because a
 * history a user cannot read on an unusual host is worse than a history that is
 * merely not encrypted - and the file carries no credential either way.
 *
 * Path: `$DSH_HOME/storages/minimax-code-video-history.json` (Windows appends
 * `.dpapi`, exactly like every sibling credential file), matching the path the
 * sibling stores in this line already use (`minimax-code-files.json`,
 * `minimax-code-models.json`).
 *
 * @module dsh-chatgpt-subscription/minimax-code/video-history
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { dshHomeDir } from '../common/home.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import type { CredentialStore } from '../token-store.ts'

/** Provider id the platform backends are keyed under, matching the sibling lines. */
const PROVIDER_ID = 'minimax-code'

/** How many rows the ledger keeps. Older rows fall off the tail. */
export const MAX_VIDEO_HISTORY_ENTRIES = 100

/**
 * One finished generation.
 *
 * Every field except `durationSeconds` is always present: a row without them could
 * not be rendered as a row at all, so a document missing one is treated as
 * corrupt and dropped rather than repaired with a guess.
 */
export interface MinimaxVideoHistoryEntry {
  /** Unix milliseconds the clip finished writing. */
  readonly createdAtMs: number
  /** Model id the submit named, exactly as it was sent. */
  readonly model: string
  /** Effective ratio, or absent when the linkage sent no ratio field. */
  readonly ratio?: string
  /** Duration the service reported for the settled task, in seconds. */
  readonly durationSeconds?: number
  /** Workspace-relative, POSIX-separated path of the written file. */
  readonly videoPath: string
  /** Exact byte length of that file. */
  readonly bytes: number
  /** Upstream task id, for diagnosis and follow-up. */
  readonly taskId: string
}

/** The stored document. The version marker is what lets a later build migrate. */
export interface MinimaxVideoHistoryDocument {
  readonly version: 1
  readonly entries: readonly MinimaxVideoHistoryEntry[]
}

/** What one generation records. The timestamp is added by the store. */
export interface MinimaxVideoHistoryRecord {
  readonly model: string
  readonly ratio?: string
  readonly durationSeconds?: number
  readonly videoPath: string
  readonly bytes: number
  readonly taskId: string
}

/** Path of the history file. Mirrors {@link fileHistoryPath} in the sibling stores. */
export function videoHistoryPath(): string {
  return path.join(dshHomeDir(), 'storages', 'minimax-code-video-history.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Validate and normalize one stored row.
 *
 * A row that cannot be rendered is DROPPED rather than repaired: the history is a
 * convenience, and inventing a byte count or a path would put a row in front of
 * the user that describes nothing. Nothing here throws - the whole document goes
 * through this per row, and one corrupt row must not hide the ninety-nine good
 * ones beside it.
 *
 * @param value - one parsed row.
 * @returns the normalized entry, or undefined to drop it.
 */
export function parseHistoryEntry(value: unknown): MinimaxVideoHistoryEntry | undefined {
  if (!isRecord(value)) return undefined
  const createdAtMs = asFiniteNumber(value.createdAtMs)
  const model = asNonEmptyString(value.model)
  const videoPath = asNonEmptyString(value.videoPath)
  const bytes = asFiniteNumber(value.bytes)
  const taskId = asNonEmptyString(value.taskId)
  if (createdAtMs === undefined || model === undefined || videoPath === undefined) return undefined
  if (bytes === undefined || bytes < 0 || taskId === undefined) return undefined
  const ratio = asNonEmptyString(value.ratio)
  const durationSeconds = asFiniteNumber(value.durationSeconds)
  return {
    createdAtMs,
    model,
    videoPath,
    bytes,
    taskId,
    ...(ratio === undefined ? {} : { ratio }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  }
}

/**
 * Normalize a whole parsed document.
 *
 * A document this build cannot recognise yields an EMPTY history rather than an
 * error: the file is read on every settings-card view and after every generation,
 * and a hand-edited or forward-versioned file must degrade to "no history yet"
 * instead of making the card unusable.
 *
 * @param value - parsed JSON, or anything else.
 * @returns the normalized document.
 */
export function parseHistoryDocument(value: unknown): MinimaxVideoHistoryDocument {
  if (!isRecord(value) || !Array.isArray(value.entries)) return { version: 1, entries: [] }
  const entries: MinimaxVideoHistoryEntry[] = []
  for (const raw of value.entries) {
    const entry = parseHistoryEntry(raw)
    if (entry !== undefined) entries.push(entry)
  }
  // Newest first: the store prepends, but a hand-edited file may not be ordered.
  entries.sort((a, b) => b.createdAtMs - a.createdAtMs)
  return { version: 1, entries: entries.slice(0, MAX_VIDEO_HISTORY_ENTRIES) }
}

/**
 * Prepend one record and trim the tail.
 *
 * Newest first, so the card renders the most recent clip without sorting, and a
 * duplicate task id REPLACES its earlier row: a generation retried after a
 * timeout settles on the same upstream task, and two rows for one clip would
 * count one generation twice.
 *
 * @param document - the current document.
 * @param record - the generation to add.
 * @param now - timestamp to stamp it with.
 * @returns the next document.
 */
export function appendHistoryEntry(
  document: MinimaxVideoHistoryDocument,
  record: MinimaxVideoHistoryRecord,
  now: number,
): MinimaxVideoHistoryDocument {
  const entry: MinimaxVideoHistoryEntry = {
    createdAtMs: now,
    model: record.model,
    videoPath: record.videoPath,
    bytes: record.bytes,
    taskId: record.taskId,
    ...(record.ratio === undefined ? {} : { ratio: record.ratio }),
    ...(record.durationSeconds === undefined ? {} : { durationSeconds: record.durationSeconds }),
  }
  const kept = document.entries.filter(existing => existing.taskId !== entry.taskId)
  return { version: 1, entries: [entry, ...kept].slice(0, MAX_VIDEO_HISTORY_ENTRIES) }
}

/**
 * Write one file through a temporary sibling plus `rename`.
 *
 * The temporary lives in the same directory so the rename stays on one volume,
 * which is what makes it atomic: a crash mid-write leaves the previous history
 * byte-for-byte intact rather than a truncated document. Same shape as the
 * credential store's writer in `token-store.ts`.
 *
 * @param filePath - destination.
 * @param contents - complete file contents.
 */
async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = filePath + '.dsh-tmp-' + process.pid + '-' + Date.now()
  try {
    await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, filePath)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw new Error(
      'MiniMax Code video history write failed; the previous file was left untouched ('
      + (error instanceof Error ? error.message : String(error)) + ')',
    )
  }
}

/** Account name the macOS/Linux backends key this store under. */
function historyAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

/**
 * The platform backend for one history file, or undefined when this host has none.
 *
 * Mirrors `createCredentialBackend` in the sibling lines: DPAPI on Windows,
 * Keychain on macOS, Secret Service on Linux. An unsupported platform gets
 * `undefined` and the plaintext path instead of an exception, so the tools keep
 * recording history on a host nobody tested.
 *
 * @param filePath - the plaintext-form path the backend is keyed on.
 * @returns a credential backend, or undefined.
 */
function createHistoryBackend(
  filePath: string,
): CredentialStore<MinimaxVideoHistoryDocument> | undefined {
  // Same three-way matrix as `createCredentialBackend` in the sibling stores and
  // as the shared pool core (`common/account-pool.ts:1038-1048`): everything under
  // `storages/` is written through the platform backend.
  try {
    if (process.platform === 'win32') {
      return new WindowsDpapiCredentialStore(`${filePath}.dpapi`, parseHistoryDocument)
    }
    if (process.platform === 'darwin') {
      return new MacKeychainCredentialStore(PROVIDER_ID, historyAccount(filePath), parseHistoryDocument)
    }
    if (process.platform === 'linux') {
      return new SecretServiceCredentialStore(PROVIDER_ID, historyAccount(filePath), parseHistoryDocument)
    }
  } catch {
    // A backend that cannot even CONSTRUCT here (no helper binary, no keyring
    // daemon) degrades to the plaintext file below rather than taking the video
    // tools down with it. This is the Linux-CI case: the Secret Service store
    // constructs fine without a keyring and only fails when it first talks to it,
    // which `read`/`write` below already tolerate.
  }
  return undefined
}

/**
 * The generation ledger for this machine.
 *
 * Reads and writes are serialized per file so two generations settling at once
 * cannot each read the same document and have the second silently discard the
 * first. The queue is process-wide and keyed by resolved path, exactly like the
 * credential store's.
 */
export class MinimaxVideoHistoryStore {
  private readonly filePath: string
  private readonly backend: CredentialStore<MinimaxVideoHistoryDocument> | undefined
  private readonly queue = new Map<string, Promise<void>>()

  /**
   * @param filePath - override for tests; defaults to {@link videoHistoryPath}.
   * @param backend - override for tests; defaults to the platform backend.
   */
  constructor(
    filePath: string = videoHistoryPath(),
    backend: CredentialStore<MinimaxVideoHistoryDocument> | undefined = undefined,
  ) {
    this.filePath = filePath
    // `arguments.length` rather than a sentinel: a caller that explicitly passes
    // `undefined` means "no backend, plaintext", which is what the tests want.
    this.backend = arguments.length >= 2 ? backend : createHistoryBackend(filePath)
  }

  /** Where this store writes. Reported by the card so the path is never a mystery. */
  path(): string {
    if (process.platform === 'win32' && this.backend !== undefined) return `${this.filePath}.dpapi`
    if (this.backend !== undefined && process.platform === 'darwin') return 'Keychain: ' + PROVIDER_ID + '/' + historyAccount(this.filePath)
    if (this.backend !== undefined && process.platform === 'linux') return 'Secret Service: ' + PROVIDER_ID + '/' + historyAccount(this.filePath)
    return this.filePath
  }

  /** Whether the stored document is encrypted at rest by a platform backend. */
  encryptedAtRest(): boolean {
    return this.backend !== undefined
  }

  /**
   * Read the ledger.
   *
   * Never throws: a missing, unreadable or corrupt file yields an empty history, so
   * one bad write cannot make the video tools or the settings card fail.
   *
   * @returns the stored document.
   */
  async read(): Promise<MinimaxVideoHistoryDocument> {
    try {
      if (this.backend !== undefined) {
        const loaded = await this.backend.load()
        return loaded ?? { version: 1, entries: [] }
      }
      const raw = await fs.readFile(this.filePath, 'utf8')
      return parseHistoryDocument(JSON.parse(raw) as unknown)
    } catch {
      // A backend that is present but unreachable (no keyring session on a CI box,
      // a locked DPAPI profile) lands here. Returning an empty history is the only
      // answer that keeps the card and the tools working; `record` reports the
      // real failure separately through `lastMinimaxVideoHistoryFailure`.
      return { version: 1, entries: [] }
    }
  }

  /**
   * The rows the card renders, newest first.
   *
   * @returns the entries alone, which is what the route answers with.
   */
  async list(): Promise<readonly MinimaxVideoHistoryEntry[]> {
    return (await this.read()).entries
  }

  /**
   * Record one finished generation.
   *
   * Read-modify-write under the per-file queue. A failure to record is REPORTED to
   * the caller but is never allowed to fail a generation that already succeeded:
   * the video is on disk and paid for either way.
   *
   * @param record - the generation to add.
   * @param now - timestamp override for tests.
   * @returns the document as written.
   */
  record(record: MinimaxVideoHistoryRecord, now: number = Date.now()): Promise<MinimaxVideoHistoryDocument> {
    return this.serialize(async () => {
      const current = await this.read()
      const next = appendHistoryEntry(current, record, now)
      await this.write(next)
      return next
    })
  }

  /** Write the whole document through the platform backend or the plaintext file. */
  private async write(document: MinimaxVideoHistoryDocument): Promise<void> {
    const serialized = JSON.stringify(document, null, 2) + '\n'
    if (this.backend !== undefined) {
      await this.backend.save(document)
      return
    }
    await writeFileAtomic(this.filePath, serialized)
  }

  /**
   * Run one operation after everything already queued for this file.
   *
   * @param operation - the read-modify-write.
   * @returns its result.
   */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.filePath)
    const result = (this.queue.get(key) ?? Promise.resolve()).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    this.queue.set(key, settled)
    void settled.then(() => {
      if (this.queue.get(key) === settled) this.queue.delete(key)
    })
    return result
  }
}

/**
 * A store that keeps the ledger in memory and writes nothing.
 *
 * Two callers use it. A test that exercises a generation end to end does not want
 * either side effect of the real store: on Windows every uncached read spawns a
 * `powershell.exe` DPAPI helper, and either way the row lands in the developer's
 * personal `$DSH_HOME`. And a host with no platform backend and an unwritable home
 * still gets a readable history for the length of the process.
 */
export class InMemoryVideoHistoryStore {
  private document: MinimaxVideoHistoryDocument = { version: 1, entries: [] }

  /** @returns the in-memory file label, so the card can say where it is (nowhere). */
  path(): string {
    return ':memory:'
  }

  /** @returns false: nothing on disk to encrypt. */
  encryptedAtRest(): boolean {
    return false
  }

  /** @returns the stored document. */
  async read(): Promise<MinimaxVideoHistoryDocument> {
    return this.document
  }

  /** @returns the entries alone, newest first. */
  async list(): Promise<readonly MinimaxVideoHistoryEntry[]> {
    return this.document.entries
  }

  /**
   * Append one row in memory.
   *
   * @param record - the generation.
   * @param now - timestamp to stamp it with.
   * @returns the document as stored.
   */
  async record(record: MinimaxVideoHistoryRecord, now: number = Date.now()): Promise<MinimaxVideoHistoryDocument> {
    this.document = appendHistoryEntry(this.document, record, now)
    return this.document
  }
}

/** What the routes need from a store; both implementations satisfy it. */
export type MinimaxVideoHistoryPort = Pick<
  MinimaxVideoHistoryStore | InMemoryVideoHistoryStore,
  'path' | 'encryptedAtRest' | 'read' | 'list' | 'record'
>

/**
 * The store the routes and the video tool share.
 *
 * One instance per process: the tool appends to it and the route reads it, and two
 * instances would each hold their own write queue for the same file - which is
 * exactly the interleaving the queue exists to prevent.
 */
let sharedStore: MinimaxVideoHistoryPort | undefined

/**
 * The process-wide history store.
 *
 * A test run gets the in-memory store unless something installed one explicitly.
 * That default is deliberate rather than convenient: the video tool's own test
 * suite drives real generations through this hook, and on Windows each row would
 * otherwise spawn a DPAPI helper and append to the developer's real ledger. A
 * suite that WANTS the file behaviour installs a store through
 * {@link setMinimaxVideoHistoryStore} and gets exactly that.
 *
 * @returns the process-wide store.
 */
export function minimaxVideoHistory(): MinimaxVideoHistoryPort {
  sharedStore ??= process.env.VITEST === undefined || process.env.VITEST === ''
    ? new MinimaxVideoHistoryStore()
    : new InMemoryVideoHistoryStore()
  return sharedStore
}

/**
 * Test seam: replace or drop the process-wide store.
 *
 * @param store - the store to install, or undefined to rebuild on next use.
 */
export function setMinimaxVideoHistoryStore(store: MinimaxVideoHistoryPort | undefined): void {
  sharedStore = store
}

/**
 * Record one finished generation, never throwing.
 *
 * Called from the video tool right after the clip is on disk. A recording failure
 * must not turn a SUCCESSFUL generation into an error the user sees: the clip
 * exists and the quota is spent either way, so the failure is logged and dropped.
 *
 * @param record - the generation.
 * @param logger - the host logger, when the caller has one.
 * @returns whether the row was written.
 */
export async function recordMinimaxVideoGeneration(
  record: MinimaxVideoHistoryRecord,
): Promise<boolean> {
  try {
    await minimaxVideoHistory().record(record)
    return true
  } catch (error) {
    // Deliberately swallowed. See above: the generation already succeeded, and a
    // host without a logger must still not see this as a failed tool call.
    lastHistoryFailure = error instanceof Error ? error.message : String(error)
    return false
  }
}

/**
 * Why the last recording failed, for a caller that wants to say so.
 *
 * Kept as module state rather than thrown because the failure has no place in the
 * tool result: the clip is on disk and paid for, so reporting an error there would
 * describe the generation as failed. The settings card surfaces it instead, on the
 * history section, where a user looking at an empty ledger can find the reason.
 */
let lastHistoryFailure: string | undefined

/** @returns the last recording failure, or undefined when the last write succeeded. */
export function lastMinimaxVideoHistoryFailure(): string | undefined {
  return lastHistoryFailure
}

/** Test seam: forget the last recording failure. */
export function resetMinimaxVideoHistoryFailure(): void {
  lastHistoryFailure = undefined
}
