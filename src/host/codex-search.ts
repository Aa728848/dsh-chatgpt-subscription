import { randomUUID } from 'node:crypto'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'
import {
  CODEX_ENHANCED_ORIGINATOR,
  CODEX_SEARCH_PROVIDER_ID,
  CODEX_SEARCH_URL,
} from '../compat.ts'
import { OAuthService } from './oauth-service.ts'
import type { StoredOAuthCredentials } from './token-store.ts'
import { codexHeaders } from './wire-auth.ts'

type FetchLike = typeof fetch

export interface CodexSearchProviderOptions {
  fetchFn?: FetchLike
  model?: string
  idFactory?: () => string
}

const DEFAULT_SEARCH_MODEL = 'gpt-5.6-luna'

export function createCodexSearchProvider(
  oauth: OAuthService,
  options: CodexSearchProviderOptions = {},
): WebSearchProvider {
  const fetchFn = options.fetchFn ?? fetch
  const model = options.model ?? DEFAULT_SEARCH_MODEL
  const idFactory = options.idFactory ?? randomUUID

  return {
    id: CODEX_SEARCH_PROVIDER_ID,
    available: () => true,
    async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
      const query = request.query.trim()
      if (query === '') return { sources: [], truncated: false }
      let credentials = await searchCredentials(oauth)
      let response = await sendSearch(fetchFn, credentials, query, model, idFactory(), signal)
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined)
        credentials = await searchCredentials(oauth, true)
        response = await sendSearch(fetchFn, credentials, query, model, idFactory(), signal)
      }
      if (response.status === 429) {
        await response.body?.cancel().catch(() => undefined)
        throw new WebError('Codex subscription search was rate limited.', 'WEB_PROVIDER_RATE_LIMITED')
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new WebError(`Codex subscription search failed (${response.status}).`, 'WEB_PROVIDER_ERROR')
      }
      const data = await response.json() as unknown
      return normalizeSearchResult(data, request.maxResults)
    },
  }
}

async function searchCredentials(oauth: OAuthService, force = false): Promise<StoredOAuthCredentials> {
  try {
    // A tool purpose, not a request purpose: search is not metered against the
    // Codex rate-limit window, so an account cooling down after a chat 429 must
    // still serve it. Asking as a request let one spent window fail every search
    // with a sign-in message the user did not need.
    return await oauth.credentials(force, { purpose: 'tool' })
  } catch (error) {
    throw credentialError(error)
  }
}

/**
 * Map a credential failure onto the right web error.
 *
 * The old single mapping called every failure "credentials are required", so
 * an unavailable account sent the user hunting for a sign-in problem they did
 * not have. The provider's own code is preserved and the reason is carried
 * through, because the two failures need opposite actions: refill the quota
 * versus sign in again.
 */
function credentialError(error: unknown): WebError {
  const reason = error instanceof Error && error.message !== '' ? error.message : ''
  if (error instanceof LlmError && error.code === 'RATE_LIMIT') {
    return new WebError(
      reason === '' ? 'Codex search is rate limited.' : `Codex search is rate limited. ${reason}`,
      'WEB_PROVIDER_RATE_LIMITED',
      { cause: error },
    )
  }
  if (error instanceof LlmError && (error.code === 'AUTH' || error.code === 'INVALID_CREDENTIAL')) {
    return new WebError(
      reason === '' ? 'Sign in with ChatGPT to use Codex search.' : `Sign in with ChatGPT to use Codex search. ${reason}`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
      { cause: error },
    )
  }
  return new WebError(
    reason === ''
      ? 'ChatGPT subscription credentials are required for Codex search.'
      : `ChatGPT subscription credentials are required for Codex search. (${reason})`,
    'WEB_PROVIDER_CREDENTIAL_MISSING',
    { cause: error },
  )
}

function sendSearch(
  fetchFn: FetchLike,
  credentials: StoredOAuthCredentials,
  query: string,
  model: string,
  id: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchFn(CODEX_SEARCH_URL, {
    method: 'POST',
    headers: {
      ...codexHeaders(credentials),
      originator: CODEX_ENHANCED_ORIGINATOR,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      id,
      model,
      input: query,
      commands: {
        search_query: [{ q: query }],
      },
      settings: {
        allowed_callers: ['direct'],
        external_web_access: true,
      },
      max_output_tokens: 4096,
    }),
    signal,
  })
}

function normalizeSearchResult(data: unknown, maxResults: number | undefined): WebSearchResult {
  const sources = dedupeSources(readSources(data))
  const limit = typeof maxResults === 'number' && Number.isFinite(maxResults) && maxResults >= 0
    ? Math.floor(maxResults)
    : undefined
  const truncated = limit !== undefined && sources.length > limit
  return {
    content: readContent(data),
    sources: limit !== undefined ? sources.slice(0, limit) : sources,
    truncated,
  }
}

function readSources(data: unknown): WebSearchSource[] {
  const root = record(data)
  if (root === null) return []
  const candidates = [
    root.sources,
    root.results,
    record(root.search_result)?.sources,
    record(root.web_search)?.sources,
  ]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const sources = candidate.map(readSource).filter(isSource)
    if (sources.length > 0) return sources
  }
  return []
}

function readSource(value: unknown): WebSearchSource | null {
  const data = record(value)
  if (data === null) return null
  const url = string(data.url) ?? string(data.link) ?? string(data.uri)
  if (url === null || !isHttpUrl(url)) return null
  const title = string(data.title) ?? string(data.name)
  const snippet = string(data.snippet) ?? string(data.text) ?? string(data.description)
  const publishedAt = string(data.published_at) ?? string(data.publishedAt)
  return {
    url,
    ...(title !== null ? { title } : {}),
    ...(snippet !== null ? { snippet } : {}),
    ...(publishedAt !== null ? { publishedAt } : {}),
  }
}

function readContent(data: unknown): string | undefined {
  const root = record(data)
  if (root === null) return undefined
  return string(root.content)
    ?? string(root.output_text)
    ?? string(root.summary)
    ?? undefined
}

function dedupeSources(sources: WebSearchSource[]): WebSearchSource[] {
  const seen = new Set<string>()
  const result: WebSearchSource[] = []
  for (const source of sources) {
    const key = source.url.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(source)
  }
  return result
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isSource(value: WebSearchSource | null): value is WebSearchSource {
  return value !== null
}
