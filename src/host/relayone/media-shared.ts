import { HarnessError } from '@deepseek-ai/dsh-llm'
import { relayOneSafeDetail } from './types.ts'
import type { RelayOneModelKind } from '../../shared/relayone-contracts.ts'
import type { RelayOneCatalogManager } from './catalog-manager.ts'
import type { RelayOneCredentialStore, RelayOneSettingsStore } from './token-store.ts'
import type { RelayOneModelEntry } from './model-catalog.ts'
import type { RelayOneAccountPool } from './account-pool.ts'

export interface RelayOneMediaStores {
  store: RelayOneCredentialStore
  settingsStore: RelayOneSettingsStore
  catalog: RelayOneCatalogManager
  /**
   * The multi-key pool, when this line runs one.
   *
   * Media generation is not metered against a chat rate-limit window, so the
   * pool is asked for any usable key rather than for the next rotation slot: a
   * key that is resting after a 429 can still draw an image perfectly well.
   */
  pool?: RelayOneAccountPool | null
}
export async function relayOneMediaCredential(stores: RelayOneMediaStores): Promise<string> {
  const settings = await stores.settingsStore.read()
  if (!settings.enabled) throw new HarnessError('RelayOne is disabled. Enable the line before using its media tools.', 'RELAYONE_LINE_DISABLED')
  const credentials = stores.pool != null
    ? await stores.pool.anyCredential().catch(() => null)
    : await stores.store.read()
  if (credentials === null) throw new HarnessError('Configure a RelayOne API key in the subscription hub first.', 'RELAYONE_NOT_CONFIGURED')
  return credentials.apiKey
}
export async function resolveRelayOneMediaModel(
  stores: RelayOneMediaStores,
  kind: Extract<RelayOneModelKind, 'image' | 'video'>,
  requested?: string,
): Promise<RelayOneModelEntry> {
  await stores.catalog.warm()
  const settings = await stores.settingsStore.read()
  const available = stores.catalog.snapshot().entries.filter(entry => entry.kind === kind)
  const wanted = requested?.trim() || (kind === 'image' ? settings.imageModel : settings.videoModel)
  const selected = wanted ? available.find(entry => entry.id === wanted) : available[0]
  if (selected === undefined) {
    throw new HarnessError(
      wanted ? 'RelayOne ' + kind + ' model "' + wanted + '" is not available to this key. Refresh the catalog or choose another model.'
        : 'This RelayOne key has no accessible ' + kind + ' model. Refresh the catalog after checking its token group.',
      'RELAYONE_MEDIA_MODEL_UNAVAILABLE',
    )
  }
  return selected
}
export function relayOneMediaOptions(value: unknown, reserved: readonly string[]): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new HarnessError('options must be a JSON object.', 'RELAYONE_MEDIA_OPTIONS_INVALID')
  const options = value as Record<string, unknown>
  for (const key of reserved) if (Object.prototype.hasOwnProperty.call(options, key)) {
    throw new HarnessError('options cannot override the dedicated "' + key + '" argument.', 'RELAYONE_MEDIA_OPTIONS_RESERVED')
  }
  try { return JSON.parse(JSON.stringify(options)) as Record<string, unknown> }
  catch { throw new HarnessError('options must be losslessly JSON-serializable.', 'RELAYONE_MEDIA_OPTIONS_INVALID') }
}
export async function relayOneMediaError(response: Response, operation: string, apiKey?: string): Promise<HarnessError> {
  const detail = relayOneSafeDetail(await response.text().catch(() => ''), apiKey, 600)
  return new HarnessError('RelayOne ' + operation + ' failed (' + response.status + ')' + (detail ? ': ' + detail : '.'), 'RELAYONE_MEDIA_HTTP_' + response.status)
}
export function relayOneRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
export const relayOneText = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
export function relayOneSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new HarnessError('RelayOne media operation was cancelled.', 'RELAYONE_MEDIA_ABORTED')); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    const abort = (): void => { clearTimeout(timer); reject(new HarnessError('RelayOne media operation was cancelled.', 'RELAYONE_MEDIA_ABORTED')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
