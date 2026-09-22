/**
 * Plugin-owned JSON storage for the preferences the settings document cannot hold.
 *
 * Harness 0.1.7 removed the register-based settings API, so the in-memory
 * fallback this plugin used without a settings service would forget every
 * selection at exit. The replacement keeps the same synchronous `get()`/`update()`/
 * `watch()` contract the settings scope offers, hydrates once from a JSON file
 * under the harness home, and writes atomically so a crash cannot leave a
 * half-written document behind.
 * @module dsh-chatgpt-subscription/file-preferences
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type z from '@deepseek-ai/schemastery'
import { dshHomeDir } from '../antigravity/token-store.ts'
import type { SettingsScope, SettingsWatch } from './settings-compat.ts'

/** Where the plugin keeps the preferences that have no settings namespace to live in. */
export function preferencesPath(): string {
  return path.join(dshHomeDir(), 'storages', 'dsh-chatgpt-subscription-preferences.json')
}

/** Distinguishes concurrent temporary files written by one process. */
let writeSequence = 0

/** One JSON document, validated and shaped by a schemastery schema. */
export class FilePreferencesStore<T extends object> implements SettingsScope<T> {
  private value: T
  private loaded: Promise<void> | undefined
  private writing: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<SettingsWatch<T>>()

  /**
   * @param schema - Schema the document is validated and defaulted with.
   * @param filePath - Document location; defaults to {@link preferencesPath}.
   * @param legacy - One-shot source seeded into an absent or default-only
   * document, so preferences a generation kept in the harness's own settings
   * document are not lost when that document stops being written.
   */
  constructor(
    private readonly schema: z<T>,
    private readonly filePath = preferencesPath(),
    private readonly legacy?: () => Promise<object | undefined>,
  ) {
    this.value = this.normalize({})
  }

  /** Current snapshot; the shipped defaults until {@link hydrate} lands. */
  get(): T {
    return this.value
  }

  /** Load and validate the file once; a missing or corrupt document keeps the defaults. */
  hydrate(): Promise<void> {
    this.loaded ??= this.read()
    return this.loaded
  }

  async update(patch: Partial<T>): Promise<T> {
    // A patch that arrives before the file is read must land on top of it, not
    // be overwritten by the hydration that is still in flight.
    await this.hydrate()
    const operation = this.writing.then(async () => {
      const prev = this.value
      const next = this.normalize({ ...this.value, ...patch })
      await this.write(next)
      this.value = next
      this.notify(next, prev)
      return next
    })
    this.writing = operation.then(() => undefined, () => undefined)
    return operation
  }

  watch(callback: SettingsWatch<T>): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  /** Validate one candidate document, throwing the schema's error when it is invalid. */
  private normalize(input: object): T {
    return this.schema(input as never) as T
  }

  private async read(): Promise<void> {
    const stored = await this.readDocument()
    // A default-only document proves nothing: it may predate the import below,
    // and skipping the import there would lose the legacy values for good.
    if (stored !== undefined && !isDeepStrictEqual(stored, this.normalize({}))) {
      this.adopt(stored)
      return
    }
    const imported = await this.legacy?.().catch(() => undefined)
    if (imported === undefined) return
    let value: T
    try {
      value = this.normalize(imported)
    } catch {
      return
    }
    if (isDeepStrictEqual(value, this.normalize({}))) return
    this.adopt(value)
    // Persist the import: the legacy document may then be removed without the
    // preferences going with it, and the next start reads the file instead.
    await this.write(value).catch(() => undefined)
  }

  /** The validated document, or `undefined` when the file is absent or rejected. */
  private async readDocument(): Promise<T | undefined> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown
    } catch {
      return undefined
    }
    try {
      return this.normalize(parsed as object)
    } catch {
      // A document the schema rejects is discarded rather than half-trusted.
      return undefined
    }
  }

  /** Publish one document, telling listeners only when it differs from the snapshot. */
  private adopt(value: T): void {
    if (isDeepStrictEqual(value, this.value)) return
    const prev = this.value
    this.value = value
    this.notify(value, prev)
  }

  private notify(next: T, prev: T): void {
    for (const listener of [...this.listeners]) listener(next, prev)
  }

  private async write(value: T): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    writeSequence += 1
    const tmp = `${this.filePath}.tmp.${process.pid}.${writeSequence}`
    try {
      // Owner-only on POSIX: a custom proxy URL can carry its own credentials.
      await fs.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(tmp, this.filePath)
    } finally {
      // The rename consumed the temporary; a failed one must not leave it behind.
      await fs.unlink(tmp).catch(() => undefined)
    }
  }
}
