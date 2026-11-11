/**
 * Runtime observation state: the last catalog scan, quota reading, response
 * routing facts and request history. Everything here is derived and in-memory.
 * Configuration lives in the settings file instead (see `token-store.ts`).
 *
 * @module dsh-chatgpt-subscription/cline-pass-store
 */
import type { ClinePipeline } from './protocol.ts'
import type {
  ClinePassHistoryRowDto,
  ClinePassUsageDto,
} from '../../shared/cline-pass-contracts.ts'
import { DEFAULT_HISTORY_LIMIT } from './types.ts'

/** Observed metadata for one model, unrelated to client-side routing control. */
export interface ClinePassModelObservation {
  ok?: boolean
  pipeline?: ClinePipeline | null
  canonicalSlug?: string | null
  lastProvider?: string | null
  /** The last answer's first-party DeepSeek fingerprint, when it carried one. */
  lastFingerprint?: string | null
  lastMs?: number
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

/** Create the observation store. */
export function createClinePassStore({ historyLimit = DEFAULT_HISTORY_LIMIT }: { historyLimit?: number } = {}) {
  /** Model id -> observed response metadata. */
  const models = new Map<string, ClinePassModelObservation>()
  /** Newest first. */
  const history: ClinePassHistoryEntry[] = []
  let historyRevision = 0
  let limit = historyLimit
  let catalog: ClinePassCatalogState = { ids: [], sources: [], models: {}, fetchedAt: 0 }
  let usage: ClinePassUsageDto = { accounts: [], fetchedAt: 0 }

  return {
    /** Observed metadata for one model (never undefined). */
    metaOf(model: string): ClinePassModelObservation {
      return models.get(model) ?? {}
    },
    /** Every model with observed metadata. */
    allMeta(): Array<ClinePassModelObservation & { id: string }> {
      return [...models.entries()].map(([id, meta]) => ({ id, ...meta }))
    },
    /** Merge one response observation into a model's metadata. */
    learn(model: string, patch: Partial<ClinePassModelObservation>): ClinePassModelObservation {
      const next: ClinePassModelObservation = { ...(models.get(model) ?? {}), ...patch }
      models.set(model, next)
      return next
    },
    /** Append one request-history row (newest first, bounded). */
    record(entry: ClinePassHistoryInput): void {
      historyRevision += 1
      // Normalize here so every reader gets the full row shape instead of a
      // field that is present on some rows and absent on others.
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
        fingerprint: entry.fingerprint ?? '',
        anonymous: entry.anonymous === true,
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
