/**
 * The Cline Pass engine: ordinary model checks, account verification, catalog
 * reads and streaming transport. Cline owns model routing; no client-supplied
 * upstream pin or provider-options field is added to a request.
 *
 * @module dsh-chatgpt-subscription/cline-pass-engine
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  chatCompletion,
  fetchGatewayCatalog,
  fetchOfficialModels,
  openChatStream,
  type ClinePassGatewayCatalog,
} from './client.ts'
import { errorText, isAuthenticationError, parseRouting, unwrapEnvelope } from './protocol.ts'
import { DEFAULT_BASE_URL, type ClinePassCatalogScan } from './types.ts'
import type { ClinePassStore } from './store.ts'
import type { ClinePassAccountPool } from './account-pool.ts'
import { bearerFor } from './token-store.ts'

/** One resolved account, as the engine hands it to a request. */
export interface ClinePassAccount {
  id: string
  name: string
  key: string
  baseURL: string
}

export interface ClinePassEngineOptions {
  fetchFn: typeof fetch
  /** Controlled/diagnostic fetch used only for live chat streams; defaults to fetchFn. */
  streamFetchFn?: typeof fetch
  accountPool: ClinePassAccountPool
  store: ClinePassStore
  /** The route's default gateway, used when an account names none. */
  baseURL(): string
  logger?: { warn(message: string, ...args: unknown[]): void }
}

/** All methods are safe to call while the pool is serving live traffic. */
export class ClinePassEngine {
  constructor(private readonly options: ClinePassEngineOptions) {}

  private get fetchFn(): typeof fetch {
    return this.options.fetchFn
  }

  private get store(): ClinePassStore {
    return this.options.store
  }

  /** The account a request would use right now, without consuming a rotation slot. */
  async resolveAccount(exclude: ReadonlySet<string> = new Set()): Promise<ClinePassAccount> {
    const effective = await this.options.accountPool.getEffectiveCredential(exclude, this.fetchFn)
    const credentials = effective.credentials
    return {
      id: effective.account.id,
      name: effective.account.alias || effective.account.id,
      key: bearerFor(credentials),
      // An account's own gateway wins; an empty one means the route's default.
      baseURL: credentials.baseURL && credentials.baseURL.trim() !== '' ? credentials.baseURL.trim() : this.options.baseURL(),
    }
  }

  /** Send one small, automatically routed request and report what served it. */
  async test(
    model: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<{
    ok: boolean
    ms: number
    model: string
    error: string
    actual: string
    actualName: string
    pipeline: string
    canonicalSlug: string
    account: string
    content: string
    plan: string
    fingerprint: string
    anonymous: boolean
    warnings: string[]
  }> {
    const account = await this.resolveAccount()
    const started = Date.now()
    const result = await chatCompletion({
      fetchFn: this.fetchFn,
      baseURL: account.baseURL || DEFAULT_BASE_URL,
      apiKey: account.key,
      body: { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 },
      signal,
      timeoutMs: 180_000,
    })
    const payload = unwrapEnvelope(result.json)
    const ms = Date.now() - started
    const failed = !result.ok || (payload.error !== undefined && payload.choices === undefined)
    const routing = failed ? parseRouting({}) : parseRouting(payload)
    const error = failed
      ? (errorText(payload.error) || result.text.slice(0, 400) || `HTTP ${result.status}`)
      : ''
    const warnings = routing.anonymous
      ? [`anonymousServed: this answer came from the gateway's anonymous contributor route (${routing.finalProvider ?? 'openai-compatible-private'}) — it may be used for training and carries no zero-data-retention guarantee`]
      : []
    this.store.learn(model, {
      ok: !failed,
      pipeline: routing.pipeline,
      canonicalSlug: routing.canonicalSlug,
      lastProvider: routing.finalProvider,
      lastFingerprint: routing.fingerprint,
      lastMs: ms,
      lastError: error,
    })
    this.store.record({
      model,
      provider: routing.finalProvider ?? '',
      canonical: routing.canonicalSlug ?? '',
      ms,
      stream: false,
      error,
      account: account.name,
      fingerprint: routing.fingerprint ?? '',
      anonymous: routing.anonymous,
      warnings,
    })
    return {
      ok: !failed,
      ms,
      model,
      error,
      actual: routing.finalProvider ?? '',
      actualName: routing.finalProviderName ?? '',
      pipeline: routing.pipeline ?? '',
      canonicalSlug: routing.canonicalSlug ?? '',
      account: account.name,
      content: failed ? '' : String(routing.content ?? '').slice(0, 120),
      plan: routing.plan,
      fingerprint: routing.fingerprint ?? '',
      anonymous: routing.anonymous,
      warnings,
    }
  }

  /**
   * Check one account key against the gateway with a single small request.
   *
   * A key that authenticates but whose model still errors (a reasoning model
   * burning `max_tokens` into an empty completion, for example) counts as
   * authorized: only a real authentication failure is reported as one.
   */
  async testAccount({
    key,
    baseURL,
    model,
    signal,
    timeoutMs = 60_000,
  }: {
    key: string
    baseURL?: string
    model: string
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<{ ok: boolean; authorized: boolean; ms: number; model: string; error: string }> {
    const started = Date.now()
    try {
      const result = await chatCompletion({
        fetchFn: this.fetchFn,
        baseURL: baseURL && baseURL.trim() !== '' ? baseURL.trim() : this.options.baseURL(),
        apiKey: key,
        body: { model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 },
        signal,
        timeoutMs,
      })
      const payload = unwrapEnvelope(result.json)
      const ms = Date.now() - started
      const message = errorText(payload.error) || String(payload.message ?? '') || (result.ok ? '' : result.text.slice(0, 400)) || (result.ok ? '' : `HTTP ${result.status}`)
      if (isAuthenticationError(message, result.status)) return { ok: false, authorized: false, ms, model, error: message || `HTTP ${result.status}` }
      const hasCompletion = result.ok && Array.isArray(payload.choices) && payload.choices.length > 0
      // A structured model/quota refusal can establish authorization without a
      // completion. Server failures, HTML and malformed success bodies cannot.
      const modelError = /empty response content|\bmodel(?:id)?\b|context|max[_ -]?tokens|reasoning|no (?:allowed|available) providers/i.test(message)
      const modelRefusal = payload.error !== undefined && (
        [402, 429].includes(result.status)
        || ((result.ok || [400, 404, 422].includes(result.status)) && modelError)
      )
      const authorized = hasCompletion || modelRefusal
      return { ok: authorized, authorized, ms, model, error: authorized && hasCompletion ? '' : (message || 'gateway returned no completion; authorization could not be verified') }
    } catch (error) {
      return { ok: false, authorized: false, ms: Date.now() - started, model, error: errorText(error) }
    }
  }

  /** Refresh the gateway's own catalog: ids plus published metadata. */
  async gatewayCatalog({ signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ClinePassGatewayCatalog> {
    const account = await this.resolveAccount()
    return await fetchGatewayCatalog({ fetchFn: this.fetchFn, baseURL: account.baseURL || DEFAULT_BASE_URL, apiKey: account.key, signal, timeoutMs })
  }

  /** Refresh the official subscription model list. */
  async officialModels({ signal }: { signal?: AbortSignal } = {}): Promise<ClinePassCatalogScan> {
    return await fetchOfficialModels({ fetchFn: this.fetchFn, signal })
  }

  /** Open one chat stream for the adapter; transport only. */
  async openStream(
    account: ClinePassAccount,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    return await openChatStream({
      fetchFn: this.options.streamFetchFn ?? this.fetchFn,
      baseURL: account.baseURL || DEFAULT_BASE_URL,
      apiKey: account.key,
      body,
      signal,
    })
  }

  /** Raise the engine's own error for a request that has no usable account. */
  noAccountError(error: unknown): LlmError {
    if (error instanceof LlmError) return error
    const message = error instanceof Error ? error.message : String(error)
    return new LlmError(`Cline Pass has no usable account: ${message}`, 'MISSING_CREDENTIAL')
  }
}
