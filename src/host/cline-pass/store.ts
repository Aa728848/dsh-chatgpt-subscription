/**
 * Runtime observation state: pipeline detection, discovered upstream channels,
 * per-channel verdicts, the last catalog scan, the last quota reading, and
 * request history.
 *
 * Configuration lives in the settings file instead (see `token-store.ts`).
 * Everything here is derived data any probe can rebuild, so it is never
 * persisted.
 *
 * @module dsh-chatgpt-subscription/cline-pass-store
 */
import { MAX_UPSTREAMS } from './types.ts'
import type { ClinePipeline } from './protocol.ts'
import type {
  ClinePassHistoryRowDto,
  ClinePassUsageDto,
} from '../../shared/cline-pass-contracts.ts'
import { DEFAULT_HISTORY_LIMIT } from './types.ts'

export type ClinePassVerdictStatus = 'ok' | 'limited' | 'bad' | 'auth' | 'not-adopted' | 'unknown'

/** One upstream availability verdict. */
export interface ClinePassUpstreamVerdict {
  status: ClinePassVerdictStatus
  note: string
  ms: number
  checkedAt: number
}

/** Per-upstream endpoint detail harvested from OpenRouter's public catalog. */
export interface ClinePassUpstreamDetail {
  slug: string
  name: string
  endpoints: number
  context: number
  uptime: number
}

/** Discovered metadata for one model. */
export interface ClinePassModelObservation {
  ok?: boolean
  pipeline?: ClinePipeline | null
  pinnable?: boolean
  canonicalSlug?: string | null
  openrouterSlug?: string | null
  upstreams?: string[]
  channels?: Partial<Record<ClinePipeline, string[]>>
  upstreamStatus?: Record<string, ClinePassUpstreamVerdict>
  upstreamDetail?: Record<string, ClinePassUpstreamDetail>
  availableProviders?: string[]
  tier0?: string[]
  lastProvider?: string | null
  lastMs?: number
  probedAt?: number
  validatedAt?: number
  staleAt?: number
  lastError?: string
}

/** One recorded model call. */
export interface ClinePassHistoryEntry extends Omit<ClinePassHistoryRowDto, 'usageReported' | 'usage'> {
  /** Null means the gateway sent no usage frame, which is not a zero-cost call. */
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    reasoningTokens?: number
  } | null
  code?: string
}

/** What a caller supplies when recording a call; the store stamps the time. */
export type ClinePassHistoryInput = Pick<ClinePassHistoryEntry, 'model'>
  & Partial<Omit<ClinePassHistoryEntry, 'model' | 'ts'>>

/** The last cached catalog scan. */
export interface ClinePassCatalogState {
  ids: string[]
  sources: string[]
  models: Record<string, unknown>
  fetchedAt: number
}

function verdict(status: ClinePassVerdictStatus, note: unknown, ms: unknown): ClinePassUpstreamVerdict {
  return { status, note: String(note ?? '').slice(0, 200), ms: Number(ms ?? 0), checkedAt: Date.now() }
}

/** Create the observation store. */
export function createClinePassStore({ historyLimit = DEFAULT_HISTORY_LIMIT }: { historyLimit?: number } = {}) {
  /** Model id -> discovered metadata. */
  const models = new Map<string, ClinePassModelObservation>()
  /** Newest first. */
  const history: ClinePassHistoryEntry[] = []
  let historyRevision = 0
  let limit = historyLimit
  let catalog: ClinePassCatalogState = { ids: [], sources: [], models: {}, fetchedAt: 0 }
  let usage: ClinePassUsageDto = { accounts: [], fetchedAt: 0 }

  return {
    /** Discovered metadata for one model (never undefined). */
    metaOf(model: string): ClinePassModelObservation {
      return models.get(model) ?? {}
    },
    /** Every model with discovered metadata. */
    allMeta(): Array<ClinePassModelObservation & { id: string }> {
      return [...models.entries()].map(([id, meta]) => ({ id, ...meta }))
    },
    /** Merge one discovery result into a model's metadata. */
    learn(model: string, patch: Partial<ClinePassModelObservation>): ClinePassModelObservation {
      const current = models.get(model) ?? {}
      const next: ClinePassModelObservation = { ...current, ...patch }
      if (patch.upstreamStatus !== undefined) {
        next.upstreamStatus = { ...(current.upstreamStatus ?? {}), ...patch.upstreamStatus }
      }
      if (next.upstreams !== undefined) {
        // Same bound as the protocol layer's merge: a tighter cap here would
        // silently drop channels the probe just discovered.
        next.upstreams = [...new Set(next.upstreams.map(String).filter((name) => name.length > 0))].slice(0, MAX_UPSTREAMS)
      }
      models.set(model, next)
      return next
    },
    /** Record a verdict; explicit validation also replaces stale results with unknown. */
    learnUpstream(
      model: string,
      upstream: string | null | undefined,
      status: ClinePassVerdictStatus,
      note: unknown,
      ms: unknown,
      { includeUnknown = false }: { includeUnknown?: boolean } = {},
    ): void {
      if (upstream === undefined || upstream === null || upstream === '') return
      if (status === 'unknown' && !includeUnknown) return
      const current = models.get(model) ?? {}
      models.set(model, {
        ...current,
        upstreamStatus: { ...(current.upstreamStatus ?? {}), [upstream]: verdict(status, note, ms) },
      })
    },
    /** Append one request-history row (newest first, bounded). */
    record(entry: ClinePassHistoryInput): void {
      historyRevision += 1
      // A caller records only the facts it has (a transport failure has no
      // usage frame and no serving channel). Normalize here so every reader gets
      // the full row shape instead of a field that is present on some rows and
      // absent on others.
      const row: ClinePassHistoryEntry = {
        ts: Date.now(),
        model: entry.model,
        provider: entry.provider ?? '',
        canonical: entry.canonical ?? '',
        account: entry.account ?? '',
        ms: entry.ms ?? 0,
        ttfb: entry.ttfb ?? 0,
        ttft: entry.ttft ?? 0,
        stream: entry.stream === true,
        effort: entry.effort ?? '',
        usage: entry.usage ?? null,
        error: entry.error ?? '',
        attempts: entry.attempts ?? [],
        adherence: entry.adherence ?? '',
        warnings: entry.warnings ?? [],
        ...(entry.code === undefined ? {} : { code: entry.code }),
      }
      history.unshift(row)
      if (history.length > limit) history.length = limit
    },
    /** Adopt a changed retention budget from the settings file. */
    setHistoryLimit(next: number): void {
      if (!Number.isSafeInteger(next) || next <= 0) return
      limit = next
      if (history.length > limit) history.length = limit
    },
    /** Read request history, newest first. */
    readHistory(limitParam = limit, model = ''): ClinePassHistoryEntry[] {
      const needle = String(model ?? '').trim().toLowerCase()
      return history
        .filter((entry) => needle === '' || String(entry.model ?? '').toLowerCase().includes(needle))
        .slice(0, Math.max(0, Math.min(limitParam, limit)))
    },
    /** Total rows retained, before any filter. */
    historySize(): number {
      return history.length
    },
    /** Monotonic change counter, including replacements at the retention cap. */
    historyRevision(): number {
      return historyRevision
    },
    /** The last cached official-catalog scan. */
    catalog(): ClinePassCatalogState {
      return catalog
    },
    /** Replace the cached official-catalog scan. */
    setCatalog(next: Omit<ClinePassCatalogState, 'fetchedAt'> & { fetchedAt?: number }): ClinePassCatalogState {
      catalog = { ...next, fetchedAt: Date.now() }
      return catalog
    },
    /** The last quota reading (never undefined). */
    usage(): ClinePassUsageDto {
      return usage
    },
    /** Replace the cached quota reading. */
    setUsage(next: Pick<ClinePassUsageDto, 'accounts'>): ClinePassUsageDto {
      usage = { accounts: next.accounts, fetchedAt: Date.now() }
      return usage
    },
  }
}

export type ClinePassStore = ReturnType<typeof createClinePassStore>
