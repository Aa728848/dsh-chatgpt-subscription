/**
 * Where the account-pool storage choice is remembered between restarts.
 *
 * The profile's `poolStorage` is the deployment's default, and the settings card
 * writes the operator's own answer here instead of rewriting `cordis.yml`: that
 * file is the harness composition, and a card that edited it would be rewriting
 * the deployment to change a preference. The document lives beside the plugin's
 * other storage under the harness home, is written atomically, validated with the
 * same schema machinery as the preferences, and — because it stores `null` until
 * somebody chooses — the profile's value keeps winning until a card actually says
 * otherwise.
 * @module dsh-chatgpt-subscription/pool-storage-settings
 */

import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { dshHomeDir } from './home.ts'
import { FilePreferencesStore } from './file-preferences.ts'
import { DEFAULT_POOL_STORAGE_MODE, poolStorageChanged } from './pool-storage.ts'
import type { PoolStorageMode } from '../../shared/contracts.ts'

/** Where the card's choice is kept. */
export function poolStorageSettingsPath(): string {
  return join(dshHomeDir(), 'storages', 'dsh-chatgpt-subscription-pool-storage.json')
}

/** The stored document. `null` means "nobody chose here; use the profile". */
interface PoolStorageDocument {
  mode: PoolStorageMode | null
}

const schema = z.object({
  mode: z.union([z.const('keyring'), z.const('credentials'), z.const(null)])
    .default(null),
}) as unknown as z<PoolStorageDocument>

/** The choice the settings card writes, and the pools read. */
export class PoolStorageSettings {
  private readonly store: FilePreferencesStore<PoolStorageDocument>

  constructor(filePath = poolStorageSettingsPath()) {
    this.store = new FilePreferencesStore<PoolStorageDocument>(schema, filePath)
  }

  /** Load the document once; a missing or corrupt one counts as "nothing chosen". */
  hydrate(): Promise<void> {
    return this.store.hydrate()
  }

  /** The chosen mode, or `null` while the profile's value stands. */
  chosen(): PoolStorageMode | null {
    return this.store.get().mode
  }

  /**
   * The mode to use: the card's choice, else the profile's value, else the default.
   *
   * @param configured - `poolStorage` from the profile, when it carries one.
   */
  effective(configured?: PoolStorageMode): PoolStorageMode {
    return this.chosen() ?? configured ?? DEFAULT_POOL_STORAGE_MODE
  }

  /**
   * Persist one choice and tell the pools to resolve their backend again.
   *
   * The announcement is part of the write rather than the route's job: a caller
   * that stores a mode without invalidating the caches would leave every pool on
   * the old store until the host restarted, which is the one failure this whole
   * option exists to avoid — reading and writing in different places.
   */
  async update(mode: PoolStorageMode): Promise<void> {
    await this.store.update({ mode })
    poolStorageChanged()
  }
}
