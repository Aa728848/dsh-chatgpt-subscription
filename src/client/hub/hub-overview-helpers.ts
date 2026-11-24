import type { HubOverviewDto, HubProviderSummaryDto } from '../../shared/hub-contracts.ts'
import type { ApiEnvelope } from '../../shared/contracts.ts'
import { HUB_OVERVIEW_PATH } from '../../shared/hub-contracts.ts'
import type { LineProxySnapshot } from '../common/LineProxySection.tsx'
import { hubCardName, HUB_PROVIDERS, type HubProviderCategory, type HubProviderDescriptor } from './providers.tsx'

export const HUB_PROVIDER_ORDER_STORAGE_KEY = 'dsh-chatgpt-subscription:hub-provider-order:v1'
export const HUB_ADDED_PROVIDERS_STORAGE_KEY = 'dsh-chatgpt-subscription:hub-added-providers:v1'
export const HUB_HIDDEN_PROVIDERS_STORAGE_KEY = 'dsh-chatgpt-subscription:hub-hidden-providers:v1'
const HUB_OVERVIEW_CACHE_STORAGE_KEY = 'dsh-chatgpt-subscription:hub-overview-cache:v1'
const HUB_PROXY_CACHE_STORAGE_KEY = 'dsh-chatgpt-subscription:hub-proxy-cache:v1'

export async function fetchOverview(): Promise<HubOverviewDto> {
  const response = await fetch(HUB_OVERVIEW_PATH, { credentials: 'same-origin' })
  const envelope = await response.json() as ApiEnvelope<HubOverviewDto>
  if (!response.ok || !envelope.ok) {
    throw new Error(envelope.ok ? `Request failed (${response.status})` : envelope.error.message)
  }
  return envelope.value
}

export function readIdSet(key: string): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((item): item is string => typeof item === 'string'))
  } catch {
    return new Set()
  }
}

export function saveIdSet(key: string, ids: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify([...ids]))
  } catch {
    // Storage may be unavailable in privacy mode.
  }
}

export function readCachedSummaries(): ReadonlyMap<string, HubProviderSummaryDto> | null {
  try {
    const raw = globalThis.localStorage?.getItem(HUB_OVERVIEW_CACHE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const map = new Map<string, HubProviderSummaryDto>()
    for (const item of parsed) {
      if (item && typeof item === 'object' && typeof (item as HubProviderSummaryDto).id === 'string') {
        map.set((item as HubProviderSummaryDto).id, item as HubProviderSummaryDto)
      }
    }
    return map.size > 0 ? map : null
  } catch {
    return null
  }
}

export function saveCachedSummaries(providers: readonly HubProviderSummaryDto[]): void {
  try {
    globalThis.localStorage?.setItem(HUB_OVERVIEW_CACHE_STORAGE_KEY, JSON.stringify(providers))
  } catch {
    // Storage may be unavailable in privacy mode.
  }
}

export function readCachedProxySnapshot(): LineProxySnapshot | null {
  try {
    const raw = globalThis.localStorage?.getItem(HUB_PROXY_CACHE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as LineProxySnapshot
  } catch {
    return null
  }
}

export function saveCachedProxySnapshot(snapshot: LineProxySnapshot): void {
  try {
    globalThis.localStorage?.setItem(HUB_PROXY_CACHE_STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Storage may be unavailable in privacy mode.
  }
}

export function orderedProviders(): HubProviderDescriptor[] {
  const fallback = [...HUB_PROVIDERS]
  try {
    const raw = globalThis.localStorage?.getItem(HUB_PROVIDER_ORDER_STORAGE_KEY)
    if (raw === null || raw === undefined) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return fallback
    const byId = new Map<string, HubProviderDescriptor>(HUB_PROVIDERS.map((provider) => [provider.id, provider]))
    const seen = new Set<string>()
    const ordered: HubProviderDescriptor[] = []
    for (const id of parsed) {
      if (typeof id !== 'string' || seen.has(id)) continue
      const provider = byId.get(id)
      if (provider === undefined) continue
      seen.add(id)
      ordered.push(provider)
    }
    ordered.push(...HUB_PROVIDERS.filter((provider) => !seen.has(provider.id)))
    return ordered
  } catch {
    return fallback
  }
}

export function saveProviderOrder(providers: readonly HubProviderDescriptor[]): void {
  try {
    globalThis.localStorage?.setItem(
      HUB_PROVIDER_ORDER_STORAGE_KEY,
      JSON.stringify(providers.map((provider) => provider.id)),
    )
  } catch {
    // Storage may be unavailable in privacy mode.
  }
}

export function moveBeforeTarget(
  providers: readonly HubProviderDescriptor[],
  sourceId: string,
  targetId: string,
): HubProviderDescriptor[] {
  const from = providers.findIndex((provider) => provider.id === sourceId)
  const target = providers.findIndex((provider) => provider.id === targetId)
  if (from < 0 || target < 0 || from === target) return [...providers]
  const next = [...providers]
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved!)
  return next
}

export function moveProviderToIndex(
  providers: readonly HubProviderDescriptor[],
  id: string,
  targetIndex: number,
): HubProviderDescriptor[] {
  const from = providers.findIndex((provider) => provider.id === id)
  if (from < 0) return [...providers]
  const clamped = Math.max(0, Math.min(providers.length - 1, targetIndex))
  if (from === clamped) return [...providers]
  const next = [...providers]
  const [moved] = next.splice(from, 1)
  next.splice(clamped, 0, moved!)
  return next
}

/** Whether a provider belongs in the main hub list (enabled, configured, or explicitly added). */
export function isProviderInMainList(
  descriptor: HubProviderDescriptor,
  summary: HubProviderSummaryDto | undefined,
  addedIds: ReadonlySet<string>,
  hiddenIds: ReadonlySet<string>,
): boolean {
  if (summary === undefined) return false
  if (summary.enabled) return true
  if (summary.accountCount > 0 || summary.authenticated) return true
  if (hiddenIds.has(descriptor.id)) return false
  return addedIds.has(descriptor.id)
}

function squash(text: string): string {
  return text.toLowerCase().replace(/[\s._-]+/g, '')
}

export function matchProviderQuery(
  descriptor: HubProviderDescriptor,
  summary: HubProviderSummaryDto | undefined,
  query: string,
  t: (key: string) => string,
): { matched: boolean; matchedModels: string[] } {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return { matched: true, matchedModels: [] }
  const words = trimmed.split(/\s+/).filter(Boolean)
  const name = hubCardName(descriptor, t)
  const haystack = [
    name,
    descriptor.name,
    descriptor.id,
    summary?.providerId,
    summary?.accountHint,
    descriptor.category,
  ].filter(Boolean).join(' ').toLowerCase()
  const unmatched = words.filter((word) => !haystack.includes(word))
  if (unmatched.length === 0) return { matched: true, matchedModels: [] }
  const modelIds = summary?.modelIds ?? []
  const hits = modelIds.filter((modelId) => {
    const normalized = squash(modelId)
    return unmatched.every((word) => normalized.includes(squash(word)))
  })
  return { matched: hits.length > 0, matchedModels: hits }
}

export const HUB_ADD_SHEET_GROUPS: readonly {
  category: HubProviderCategory
  titleKey: 'hubGroupSubscription' | 'hubGroupApiKey' | 'hubGroupLocal'
  hintKey: 'hubGroupSubscriptionHint' | 'hubGroupApiKeyHint' | 'hubGroupLocalHint'
}[] = [
  { category: 'subscription', titleKey: 'hubGroupSubscription', hintKey: 'hubGroupSubscriptionHint' },
  { category: 'api-key', titleKey: 'hubGroupApiKey', hintKey: 'hubGroupApiKeyHint' },
  { category: 'local', titleKey: 'hubGroupLocal', hintKey: 'hubGroupLocalHint' },
]
