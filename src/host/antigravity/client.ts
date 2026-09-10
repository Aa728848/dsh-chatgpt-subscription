import {
  DEFAULT_ANTIGRAVITY_CL,
  DEFAULT_ANTIGRAVITY_VERSION,
  DEFAULT_ENDPOINT,
  DISCOVERY_TIMEOUT_MS,
  ENDPOINT_FALLBACKS,
  FREE_TIER_ID,
  MODELS,
  ONBOARD_POLL_INTERVAL_MS,
  ONBOARD_TIMEOUT_MS,
  PROJECT_CACHE_TTL_MS,
} from './types.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type AntigravityCatalogModel,
} from './token-store.ts'
import { ensureApiKey } from './oauth.ts'
import type {
  AntigravityAccountQuota,
  AntigravityQuotaGroup,
} from '../../shared/antigravity-contracts.ts'

const projectCache = new Map<string, { projectId: string; expiresAt: number }>()
export const ANTIGRAVITY_QUOTA_CACHE_TTL_MS = 2 * 60 * 1000
let cachedQuota: AntigravityAccountQuota | undefined
let quotaFetchInFlight: Promise<AntigravityAccountQuota> | null = null
/** Bumped by every cache clear so an in-flight fetch cannot publish stale state. */
let quotaCacheEpoch = 0

const PLATFORM = process.platform === 'darwin' ? 'MACOS' : process.platform === 'win32' ? 'WINDOWS' : 'LINUX'

export function defaultUserAgent(): string {
  const version = process.env.DSH_ANTIGRAVITY_VERSION || DEFAULT_ANTIGRAVITY_VERSION
  const cl = process.env.DSH_ANTIGRAVITY_CL || DEFAULT_ANTIGRAVITY_CL
  const os = process.env.DSH_ANTIGRAVITY_OS
    || (process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux')
  const arch = process.env.DSH_ANTIGRAVITY_ARCH || (process.arch === 'x64' ? 'amd64' : process.arch)
  return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`
}

export function antigravityHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': process.env.DSH_ANTIGRAVITY_USER_AGENT || defaultUserAgent(),
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify({
      ideType: 'ANTIGRAVITY',
      platform: PLATFORM,
      pluginType: 'GEMINI',
    }),
  }
}

export function jsonHeaders(token: string): Record<string, string> {
  return {
    ...antigravityHeaders(token),
    Accept: 'application/json',
  }
}

export function endpointCandidates(): string[] {
  const custom = process.env.DSH_ANTIGRAVITY_ENDPOINT?.trim()
  if (custom) return [custom]
  return ENDPOINT_FALLBACKS
}

function extractProjectId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  const direct =
    record.antigravityProjectId ??
    record.projectId ??
    record.backendProjectId ??
    record.userDefinedCloudaicompanionProject ??
    record.cloudaicompanionProject ??
    record.project

  if (typeof direct === 'string' && direct.length > 0) return direct
  if (typeof direct === 'object' && direct !== null && 'id' in direct && typeof (direct as { id?: unknown }).id === 'string') {
    return (direct as { id: string }).id
  }

  for (const key of ['projects', 'projectIds', 'cloudaicompanionProjects']) {
    const list = record[key]
    if (Array.isArray(list)) {
      for (const item of list) {
        const nested = extractProjectId(item)
        if (nested) return nested
        if (typeof item === 'string' && item.length > 0) return item
      }
    }
  }
  return undefined
}

export interface AntigravityTierInfo {
  id?: string
  name?: string
  description?: string
}

export interface AntigravityIneligibleTier {
  tierId?: string
  reasonMessage?: string
  validationUrl?: string
}

export interface LoadCodeAssistDetailResult {
  currentTier?: AntigravityTierInfo | null
  paidTier?: AntigravityTierInfo | null
  allowedTiers?: AntigravityTierInfo[]
  ineligibleTiers?: AntigravityIneligibleTier[]
  projectId?: string
  raw?: Record<string, unknown>
}

export async function loadCodeAssistDetail(
  token: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<LoadCodeAssistDetailResult | undefined> {
  const metadata = {
    ideType: 'ANTIGRAVITY',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
  }

  for (const endpoint of endpointCandidates()) {
    try {
      const response = await fetchFn(`${endpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({ metadata }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]) : AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      })
      if (!response.ok) continue
      const data = (await response.json()) as Record<string, unknown>
      const projectId = extractProjectId(data)

      const allowedTiers: AntigravityTierInfo[] = Array.isArray(data.allowedTiers)
        ? (data.allowedTiers as AntigravityTierInfo[])
        : []
      const ineligibleTiers: AntigravityIneligibleTier[] = Array.isArray(data.ineligibleTiers)
        ? (data.ineligibleTiers as AntigravityIneligibleTier[])
        : []

      return {
        currentTier: (data.currentTier as AntigravityTierInfo) || null,
        paidTier: (data.paidTier as AntigravityTierInfo) || null,
        allowedTiers,
        ineligibleTiers,
        projectId,
        raw: data,
      }
    } catch {
      // try next
    }
  }
  return undefined
}

export async function onboardUser(
  token: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + ONBOARD_TIMEOUT_MS
  const body = JSON.stringify({
    tierId: FREE_TIER_ID,
    metadata: { ideType: 'ANTIGRAVITY' },
  })
  let lastError: unknown

  for (const endpoint of endpointCandidates()) {
    try {
      const remainingTime = Math.max(1_000, deadline - Date.now())
      const timeoutSignal = AbortSignal.timeout(remainingTime)
      const callSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

      const response = await fetchFn(`${endpoint}/v1internal:onboardUser`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body,
        signal: callSignal,
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        throw new Error(`onboardUser failed: ${response.status} ${response.statusText}: ${errorText}`)
      }

      let operation = (await response.json()) as {
        name?: string
        done?: boolean
        error?: { code?: number; message?: string }
        response?: unknown
      }

      while (true) {
        if (operation.done === true) {
          if (operation.error) {
            const msg = operation.error.message || `Error code ${operation.error.code}`
            throw new Error(`OnboardUser operation failed: ${msg}`)
          }
          return
        }

        const waitMs = Math.min(ONBOARD_POLL_INTERVAL_MS, Math.max(100, deadline - Date.now()))
        if (Date.now() >= deadline) {
          throw new Error(`onboardUser timed out after ${ONBOARD_TIMEOUT_MS}ms`)
        }
        await new Promise((r) => setTimeout(r, waitMs))
        if (signal?.aborted) throw new Error('OAuth login cancelled')

        const operationName = operation.name || ''
        if (!operationName) {
          throw new Error('onboardUser returned an operation without a name')
        }

        const pollTime = Math.max(1_000, deadline - Date.now())
        const pollTimeoutSignal = AbortSignal.timeout(pollTime)
        const pollSignal = signal ? AbortSignal.any([signal, pollTimeoutSignal]) : pollTimeoutSignal

        const pollResp = await fetchFn(`${endpoint}/v1internal/${operationName}`, {
          method: 'GET',
          headers: jsonHeaders(token),
          signal: pollSignal,
        })

        if (!pollResp.ok) {
          const pollErr = await pollResp.text().catch(() => '')
          throw new Error(`onboardUser operation poll failed: ${pollResp.status}: ${pollErr}`)
        }

        operation = (await pollResp.json()) as typeof operation
      }
    } catch (err) {
      lastError = err
      if (Date.now() >= deadline || signal?.aborted) {
        throw err
      }
    }
  }

  // Every candidate failed before the deadline: report the last failure instead of
  // letting the caller treat onboarding as complete.
  throw lastError instanceof Error ? lastError : new Error('onboardUser failed on every endpoint')
}

export async function listCloudAICompanionProjects(token: string, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  for (const endpoint of endpointCandidates()) {
    try {
      const response = await fetchFn(`${endpoint}/v1internal:listCloudAICompanionProjects`, {
        method: 'POST',
        headers: antigravityHeaders(token),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      })
      if (!response.ok) continue
      return extractProjectId(await response.json())
    } catch {
      // try next
    }
  }
  return undefined
}

export async function loadCodeAssist(token: string, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  const cached = projectCache.get(token)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.projectId
  }

  const detail = await loadCodeAssistDetail(token, fetchFn)
  if (detail?.projectId) {
    projectCache.set(token, { projectId: detail.projectId, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS })
    return detail.projectId
  }

  const listProj = await listCloudAICompanionProjects(token, fetchFn)
  if (listProj) {
    projectCache.set(token, { projectId: listProj, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS })
    return listProj
  }

  return undefined
}

export async function postJson(
  path: string,
  token: string,
  body: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<{ endpoint: string; status: number; data: unknown }> {
  for (const endpoint of endpointCandidates()) {
    try {
      const response = await fetchFn(`${endpoint}${path}`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify(body),
      })
      if (response.ok) {
        return {
          endpoint,
          status: response.status,
          data: await response.json(),
        }
      }
    } catch {
      // try next
    }
  }
  throw new Error(`Failed to call Antigravity API ${path}`)
}

export function parseQuotaSummary(data: unknown): {
  groups: AntigravityQuotaGroup[]
  description?: string
} {
  const summary = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  const rawGroups = Array.isArray(summary.groups) ? summary.groups : []
  const groups: AntigravityQuotaGroup[] = []

  for (const group of rawGroups) {
    if (typeof group !== 'object' || group === null) continue
    const groupRec = group as Record<string, unknown>
    const buckets: AntigravityQuotaGroup['buckets'] = []

    const rawBuckets = Array.isArray(groupRec.buckets) ? groupRec.buckets : []
    for (const bucket of rawBuckets) {
      if (typeof bucket !== 'object' || bucket === null) continue
      const bRec = bucket as Record<string, unknown>
      const remaining = typeof bRec.remainingFraction === 'number'
        ? Math.max(0, Math.min(1, bRec.remainingFraction))
        : 0

      buckets.push({
        bucketId: String(bRec.bucketId || bRec.displayName || 'limit'),
        displayName: String(bRec.displayName || bRec.bucketId || 'Limit'),
        window: typeof bRec.window === 'string' ? bRec.window : undefined,
        resetTime: typeof bRec.resetTime === 'string' ? bRec.resetTime : undefined,
        description: typeof bRec.description === 'string' ? bRec.description : undefined,
        remainingFraction: remaining,
      })
    }

    if (buckets.length > 0 || groupRec.displayName) {
      groups.push({
        displayName: String(groupRec.displayName || 'Quota group'),
        description: typeof groupRec.description === 'string' ? groupRec.description : undefined,
        buckets,
      })
    }
  }

  return {
    groups,
    description: typeof summary.description === 'string' ? summary.description : undefined,
  }
}

export function parseCatalogModels(data: unknown): AntigravityCatalogModel[] {
  if (typeof data !== 'object' || data === null) return []
  const record = data as Record<string, unknown>
  const rawModels = typeof record.models === 'object' && record.models !== null ? (record.models as Record<string, unknown>) : {}
  const list: AntigravityCatalogModel[] = []

  for (const [modelId, info] of Object.entries(rawModels)) {
    if (typeof info !== 'object' || info === null) continue
    const rec = info as Record<string, unknown>
    if (rec.isInternal || modelId.startsWith('chat_')) continue

    list.push({
      id: modelId,
      name: typeof rec.displayName === 'string' ? rec.displayName : modelId,
      description: typeof rec.description === 'string' ? rec.description : undefined,
    })
  }

  return list
}

export async function fetchAccountQuota(
  store = new FileCredentialStore(),
  modelSettings?: FileModelSettingsStore,
  fetchFn: typeof fetch = fetch,
  force = false,
): Promise<AntigravityAccountQuota> {
  if (!force && cachedQuota && Date.now() - (cachedQuota.fetchedAt || 0) < ANTIGRAVITY_QUOTA_CACHE_TTL_MS) {
    return cachedQuota
  }
  if (quotaFetchInFlight) {
    return quotaFetchInFlight
  }

  const epoch = quotaCacheEpoch
  const request = (async (): Promise<AntigravityAccountQuota> => {
    const { token, projectId: credentialProjectId } = await ensureApiKey(store, fetchFn)

    const [assistResult, summaryResult] = await Promise.all([
      postJson('/v1internal:loadCodeAssist', token, {
        metadata: {
          ideType: 'ANTIGRAVITY',
          platform: 'PLATFORM_UNSPECIFIED',
          pluginType: 'GEMINI',
        },
      }, fetchFn).catch(() => null),
      postJson('/v1internal:retrieveUserQuotaSummary', token, {}, fetchFn).catch(() => null),
    ])

    const discoveredProject = assistResult ? extractProjectId(assistResult.data) : undefined
    const projectId = credentialProjectId || discoveredProject || 'antigravity-default'

    const modelsCall = await postJson('/v1internal:fetchAvailableModels', token, { project: projectId }, fetchFn).catch(() => null)
    const modelsData = modelsCall?.data

    const { groups, description } = summaryResult ? parseQuotaSummary(summaryResult.data) : { groups: [] }
    const catalogModels = modelsData ? parseCatalogModels(modelsData) : []

    const assistData = (assistResult?.data as Record<string, unknown>) || {}
    const currentTier = assistData.currentTier as { id?: string; name?: string; description?: string } | undefined
    const paidTier = assistData.paidTier as { id?: string; name?: string; description?: string } | undefined
    const planLabel = paidTier?.name || currentTier?.name || undefined

    const snapshot: AntigravityAccountQuota = {
      projectId,
      endpoint: summaryResult?.endpoint || ENDPOINT_FALLBACKS[0],
      planLabel,
      productTier: currentTier,
      paidTier,
      groups,
      groupDescription: description,
      models: catalogModels.map((m) => ({ modelId: m.id, displayName: m.name, description: m.description })),
      catalogModels,
      fetchedAt: Date.now(),
    }

    if (epoch !== quotaCacheEpoch) {
      // A logout cleared the cache while this fetch was in flight: answer the
      // caller, but publish nothing and leave the signed-out account's catalog
      // settings untouched.
      return snapshot
    }

    cachedQuota = snapshot

    if (modelSettings && catalogModels.length > 0) {
      const current = await modelSettings.read()
      const isFirstTime = current.catalogModels.length === 0 && current.enabledModelIds.length === 0
      const catalogIds = new Set(catalogModels.map((m) => m.id))
      const mergedEnabled = isFirstTime
        ? catalogModels.map((m) => m.id)
        : current.enabledModelIds.filter((id) => catalogIds.has(id))
      await modelSettings.setCatalogModels(catalogModels, { enabledModelIds: mergedEnabled })
    }

    return snapshot
  })()

  quotaFetchInFlight = request
  try {
    return await request
  } finally {
    // Only the owner of this slot clears it: a clear-then-refetch must not lose
    // the newer in-flight request.
    if (quotaFetchInFlight === request) quotaFetchInFlight = null
  }
}

export function getCachedQuota(): AntigravityAccountQuota | undefined {
  return cachedQuota
}

export function clearCachedQuota(): void {
  quotaCacheEpoch += 1
  cachedQuota = undefined
  quotaFetchInFlight = null
}
