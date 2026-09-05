import {
  DEFAULT_ENDPOINT,
  DISCOVERY_TIMEOUT_MS,
  ENDPOINT_FALLBACKS,
  PROJECT_CACHE_TTL_MS,
  MODELS,
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
let cachedQuota: AntigravityAccountQuota | undefined

const PLATFORM = process.platform === 'darwin' ? 'MACOS' : process.platform === 'win32' ? 'WINDOWS' : 'LINUX'

export function defaultUserAgent(): string {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux'
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  return `antigravity/1.15.8 ${os}/${arch}`
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

  const body = JSON.stringify({
    metadata: {
      ideType: 'ANTIGRAVITY',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    },
  })

  for (const endpoint of endpointCandidates()) {
    try {
      const response = await fetchFn(`${endpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: antigravityHeaders(token),
        body,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      })
      if (!response.ok) continue
      const project = extractProjectId(await response.json())
      if (project) {
        projectCache.set(token, { projectId: project, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS })
        return project
      }
      const listProj = await listCloudAICompanionProjects(token, fetchFn)
      if (listProj) {
        projectCache.set(token, { projectId: listProj, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS })
        return listProj
      }
    } catch {
      // try next
    }
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
): Promise<AntigravityAccountQuota> {
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

  cachedQuota = {
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

  if (modelSettings && catalogModels.length > 0) {
    const current = await modelSettings.read()
    const isFirstTime = current.catalogModels.length === 0 && current.enabledModelIds.length === 0
    const catalogIds = new Set(catalogModels.map((m) => m.id))
    const mergedEnabled = isFirstTime
      ? catalogModels.map((m) => m.id)
      : current.enabledModelIds.filter((id) => catalogIds.has(id))
    await modelSettings.setCatalogModels(catalogModels, { enabledModelIds: mergedEnabled })
  }

  return cachedQuota
}

export function getCachedQuota(): AntigravityAccountQuota | undefined {
  return cachedQuota
}
