import type { OpenCodeGoConnectionDto, OpenCodeGoQuotaSnapshotDto } from '../../../shared/opencode-go-contracts.ts'
import { OPENCODE_GO_CHAT_URL, OPENCODE_GO_MODELS_URL, OPENCODE_GO_USAGE_URL, opencodeGoHeaders, opencodeGoSessionId, type OpenCodeGoCredentials } from './types.ts'

export class OpenCodeGoHttpError extends Error {
  readonly status: number
  readonly detail: string
  constructor(status: number, detail: string) {
    super('OpenCode Go returned HTTP ' + status + (detail === '' ? '' : ': ' + detail))
    this.name = 'OpenCodeGoHttpError'
    this.status = status
    this.detail = detail
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function safeDetail(text: string, credentials: OpenCodeGoCredentials): string {
  return text.split(credentials.apiKey).join('[redacted]').slice(0, 600)
}

async function getJson(url: string, credentials: OpenCodeGoCredentials, fetchFn: typeof fetch): Promise<unknown> {
  const response = await fetchFn(url, { headers: opencodeGoHeaders(credentials), signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new OpenCodeGoHttpError(response.status, safeDetail(await response.text().catch(() => ''), credentials))
  return response.json()
}

export async function fetchOpenCodeGoModels(credentials: OpenCodeGoCredentials, fetchFn: typeof fetch = fetch): Promise<unknown[]> {
  const payload = await getJson(OPENCODE_GO_MODELS_URL, credentials, fetchFn)
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error('OpenCode Go model catalog has an invalid shape')
  return payload.data
}

function quotaWindow(value: unknown, key: 'rolling' | 'weekly' | 'monthly') {
  if (!isRecord(value) || typeof value.percent !== 'number' || !Number.isFinite(value.percent)) return null
  const resetsAt = typeof value.resetsAt === 'string' ? Date.parse(value.resetsAt) : Number.NaN
  return {
    key,
    usedPercent: Math.max(0, Math.min(100, value.percent)),
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    status: value.status === 'rate-limited' ? 'rate-limited' : 'ok',
  }
}

export function parseOpenCodeGoQuotaSnapshot(value: unknown): OpenCodeGoQuotaSnapshotDto | undefined {
  if (!isRecord(value) || typeof value.fetchedAt !== 'number' || !Number.isFinite(value.fetchedAt) || !Array.isArray(value.windows)) return undefined
  const windows: OpenCodeGoQuotaSnapshotDto['windows'] = []
  for (const raw of value.windows) {
    if (!isRecord(raw) || (raw.key !== 'rolling' && raw.key !== 'weekly' && raw.key !== 'monthly')) return undefined
    if (typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent)) return undefined
    windows.push({
      key: raw.key,
      usedPercent: Math.max(0, Math.min(100, raw.usedPercent)),
      resetsAt: typeof raw.resetsAt === 'number' && Number.isFinite(raw.resetsAt) ? raw.resetsAt : null,
    })
  }
  return { windows, planName: typeof value.planName === 'string' ? value.planName : null, fetchedAt: value.fetchedAt }
}

const quotaCache = new Map<string, OpenCodeGoQuotaSnapshotDto>()
export function getCachedOpenCodeGoQuota(accountId: string): OpenCodeGoQuotaSnapshotDto | null { return quotaCache.get(accountId) ?? null }

export async function fetchOpenCodeGoUsage(accountId: string, credentials: OpenCodeGoCredentials, fetchFn: typeof fetch = fetch): Promise<OpenCodeGoQuotaSnapshotDto> {
  const payload = await getJson(OPENCODE_GO_USAGE_URL, credentials, fetchFn)
  const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : {}
  const windows = (['rolling', 'weekly', 'monthly'] as const).map(key => quotaWindow(usage[key], key))
  if (windows.some(window => window === null)) throw new Error('OpenCode Go usage response is missing a window')
  const snapshot: OpenCodeGoQuotaSnapshotDto = { windows: windows.filter(window => window !== null).map(window => ({ key: window.key, usedPercent: window.usedPercent, resetsAt: window.resetsAt })), planName: null, fetchedAt: Date.now() }
  quotaCache.set(accountId, snapshot)
  return snapshot
}

export async function testOpenCodeGoConnection(accountId: string, credentials: OpenCodeGoCredentials, fetchFn: typeof fetch = fetch): Promise<OpenCodeGoConnectionDto> {
  const startedAt = Date.now()
  let model: string | null = null
  try {
    const models = await fetchOpenCodeGoModels(credentials, fetchFn)
    const candidate = models.find(entry => isRecord(entry) && entry.type === 'chat' && typeof entry.id === 'string')
    if (candidate === undefined || !isRecord(candidate)) throw new Error('OpenCode Go returned no chat model for this key')
    model = String(candidate.id)
    const response = await fetchFn(OPENCODE_GO_CHAT_URL, {
      method: 'POST',
      headers: opencodeGoHeaders(credentials, opencodeGoSessionId(undefined, accountId)),
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false, max_tokens: 1 }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new OpenCodeGoHttpError(response.status, safeDetail(await response.text().catch(() => ''), credentials))
    const payload = await response.json() as unknown
    if (!isRecord(payload) || !Array.isArray(payload.choices)) throw new Error('OpenCode Go response is missing choices')
    return { connected: true, latencyMs: Date.now() - startedAt, model, checkedAt: Date.now() }
  } catch (error) {
    return { connected: false, latencyMs: Date.now() - startedAt, model, checkedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
  }
}
