/**
 * The live model catalogue: one ACP session, read once, then cached.
 *
 * The catalogue is not a property of this plugin - it is a property of the
 * account signed in to the official CLI, and it changes when Google changes a
 * plan. So it is read from the server, never shipped as a table, and the read
 * itself is cheap: `initialize` + `session/new` on a throwaway process, then the
 * process is closed.
 *
 * Two rules follow from that, and both matter more than they look:
 *
 * - **A cold start must not wait on the network.** The last successful listing is
 *   persisted and rehydrated first; the refresh runs behind it. A picker that
 *   blocks for twenty seconds because Google is slow is a picker that looks
 *   broken.
 * - **A failed refresh is not a failed line.** If the agent cannot be reached,
 *   the cached listing still answers, and the card says the listing is stale
 *   rather than pretending the account has no models.
 *
 * @module dsh-chatgpt-subscription/host/antigravity-acp/catalog
 */

import type { AcpClient } from './acp-client.ts'
import { AcpClient as Client } from './acp-client.ts'
import { collapseModels, type AcpAvailableModel, type AcpModelOption } from './types.ts'
import {
  catalogSnapshotName,
  readCatalogSnapshot,
  writeCatalogSnapshot,
} from '../common/catalog-snapshot.ts'
import type { AntigravityAcpModelDto } from '../../shared/antigravity-acp-contracts.ts'
import type { AcpLaunch } from './adapter.ts'
import { CATALOG_SNAPSHOT_NAME } from './types.ts'

/** How long a live listing is trusted before a background refresh replaces it. */
export const CATALOG_TTL_MS = 60_000

/** Budget for one catalogue read; a hung agent must not hold the picker. */
export const CATALOG_TIMEOUT_MS = 20_000

/** One read's result. */
export interface AcpCatalogRead {
  models: AntigravityAcpModelDto[]
  /** Subscription tier the server reported, when it reported one. */
  tier?: { id: string; name: string }
  /** Whether this came from the persisted snapshot rather than a live session. */
  fromSnapshot: boolean
  /** Unix milliseconds this listing was produced. */
  fetchedAt: number
}

/** The reader, with the cache it maintains. */
export class AcpCatalog {
  private cached: AcpCatalogRead | undefined
  private inflight: Promise<AcpCatalogRead | undefined> | undefined
  private readonly snapshotName: string

  /**
   * @param resolveLaunch - Resolves the executable for a read.
   * @param spawnClient - Test seam for the protocol client.
   * @param scope - Credential/plan scope folded into the snapshot file name.
   * @param now - Clock seam.
   */
  constructor(
    private readonly resolveLaunch: () => Promise<AcpLaunch>,
    private readonly spawnClient: (launch: AcpLaunch) => AcpClient,
    private readonly scope: string = 'default',
    private readonly now: () => number = Date.now,
  ) {
    this.snapshotName = catalogSnapshotName(CATALOG_SNAPSHOT_NAME, scope)
  }

  /** The listing without touching the network: what the picker renders first. */
  async rehydrate(): Promise<AcpCatalogRead | undefined> {
    if (this.cached !== undefined) return this.cached
    const snapshot = await readCatalogSnapshot<AntigravityAcpModelDto>(this.snapshotName, parseSnapshotModels)
    if (snapshot === undefined) return undefined
    this.cached = { models: snapshot.models, fromSnapshot: true, fetchedAt: snapshot.fetchedAt }
    return this.cached
  }

  /**
   * Read the live listing, or answer from cache while a refresh runs.
   *
   * @param options - `force` bypasses the TTL; `signal` cancels the read.
   * @returns The best listing available, or undefined when nothing has ever been read.
   */
  async read(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<AcpCatalogRead | undefined> {
    const current = this.cached ?? await this.rehydrate()
    if (!options.force && current !== undefined && this.now() - current.fetchedAt < CATALOG_TTL_MS) {
      return current
    }
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.refresh(options.signal)
      .catch(() => current)
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /** Discard the in-memory listing; the next read rehydrates from disk. */
  invalidate(): void {
    this.cached = undefined
  }

  private async refresh(signal?: AbortSignal): Promise<AcpCatalogRead | undefined> {
    const launch = await this.resolveLaunch()
    const client = this.spawnClient(launch)
    try {
      const result = await withTimeout(readCatalogFrom(client, signal), CATALOG_TIMEOUT_MS)
      const read: AcpCatalogRead = {
        models: result.models,
        ...(result.tier === undefined ? {} : { tier: result.tier }),
        fromSnapshot: false,
        fetchedAt: this.now(),
      }
      this.cached = read
      await writeCatalogSnapshot(this.snapshotName, read.models, read.fetchedAt).catch(() => undefined)
      return read
    } finally {
      await client.dispose().catch(() => undefined)
    }
  }
}

/**
 * Read one catalogue from a connected agent.
 *
 * ACP publishes the model list twice - as `availableModels` (tier ids) and as a
 * `model` config option (base ids) - and the thinking ladder as a separate
 * `thought_level` option. The three are reconciled here rather than in three
 * call sites; see {@link collapseModels}.
 *
 * @param client - A freshly spawned client.
 * @param signal - Cancellation.
 * @returns Collapsed models and the tier the server reported.
 */
export async function readCatalogFrom(
  client: AcpClient,
  signal?: AbortSignal,
): Promise<{ models: AntigravityAcpModelDto[]; tier?: { id: string; name: string } }> {
  const init = asRecord(await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'dsh-chatgpt-subscription', version: '1.0.0' },
  }, signal))
  const authMethods = Array.isArray(init?.authMethods) ? init.authMethods : []
  const create = async (): Promise<Record<string, unknown>> => {
    const value = asRecord(await client.request('session/new', { cwd: process.cwd(), mcpServers: [] }, signal))
    if (value === undefined) throw new Error('Antigravity ACP did not return a session.')
    return value
  }
  let session: Record<string, unknown>
  try {
    session = await create()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/authentication required/i.test(message) || authMethods.length === 0) throw error
    await client.request('authenticate', { methodId: 'oauth-personal' }, signal)
    session = await create()
  }
  // The server nests the tier list under `models.availableModels`; an older
  // shape published it at the top level. Both are read, because the cost of
  // reading one wrong is a silently empty thinking ladder on every model.
  const availableModels = readAvailableModels(
    asRecord(session.models)?.availableModels ?? session.availableModels,
  )
  const configOptions = Array.isArray(session.configOptions) ? session.configOptions : []
  const modelOption = configOptions.find((entry): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).id === 'model')
  // The thought_level option describes the session's current model only; each
  // model's own ladder comes from its tier-suffixed ids, so it is not read here.
  const optionValues = readOptionValues(modelOption)
  const models = collapseModels(optionValues, availableModels)
  const tier = readTier(session._meta)
  return { models, ...(tier === undefined ? {} : { tier }) }
}

function readAvailableModels(raw: unknown): AcpAvailableModel[] {
  if (!Array.isArray(raw)) return []
  const models: AcpAvailableModel[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.modelId !== 'string') continue
    models.push({
      modelId: record.modelId,
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
    })
  }
  return models
}

function readOptionValues(raw: Record<string, unknown> | undefined): AcpModelOption[] {
  const options = raw?.options
  if (!Array.isArray(options)) return []
  const values: AcpModelOption[] = []
  for (const entry of options) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.value !== 'string') continue
    values.push({ value: record.value, ...(typeof record.name === 'string' ? { name: record.name } : {}) })
  }
  return values
}

function readTier(meta: unknown): { id: string; name: string } | undefined {
  const antigravity = asRecord(asRecord(meta)?.antigravity)
  const tier = asRecord(antigravity?.tier)
  if (tier === undefined) return undefined
  const id = typeof tier.id === 'string' ? tier.id : undefined
  const name = typeof tier.name === 'string' ? tier.name : undefined
  if (id === undefined || name === undefined) return undefined
  return { id, name }
}

/** Parse one persisted snapshot; anything that is not a model row is dropped. */
function parseSnapshotModels(value: unknown): AntigravityAcpModelDto[] | undefined {
  if (!Array.isArray(value)) return undefined
  const models: AntigravityAcpModelDto[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.name !== 'string') continue
    models.push({
      id: record.id,
      name: record.name,
      efforts: Array.isArray(record.efforts) ? record.efforts.filter((level): level is string => typeof level === 'string') : [],
      ...(typeof record.contextWindow === 'number' ? { contextWindow: record.contextWindow } : {}),
    })
  }
  return models.length === 0 ? undefined : models
}

function withTimeout<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Antigravity ACP catalogue read timed out after ${budgetMs}ms.`)), budgetMs)
    timer.unref?.()
    promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }, (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export { Client }
