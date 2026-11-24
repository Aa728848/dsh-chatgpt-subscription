import type { ClaudeApiConnectionDto } from '../../../shared/claude-api-contracts.ts'
import { claudeCodeFirstPartyHeaders, type ClaudeCodeFirstPartyContext } from '../_claude-shared/claude-code-first-party.ts'
import { parseClaudeApiModelListing, type ClaudeApiModelEntry } from './model-catalog.ts'
import {
  CLAUDE_API_ANTHROPIC_VERSION,
  CLAUDE_API_BASE_BETAS,
  CLAUDE_API_ENTRYPOINT,
  CLAUDE_API_MODELS_PATH,
  CLAUDE_API_STAINLESS_HEADERS,
  claudeApiSafeDetail,
  claudeApiSessionUuid,
  claudeApiUrl,
  claudeApiUserAgent,
} from './types.ts'

/**
 * Host I/O of the Claude API line: the official Claude Code header set, the
 * paginated model listing and the explicit connectivity check.
 *
 * Every wire constant is imported from ./types.ts (capture-backed); this module
 * only assembles requests and parses answers. See docs/claude-api-line-plan.md.
 */

export interface ClaudeApiHeadersInput {
  apiKey: string
  version: string
  sessionUuid: string
  betas: readonly string[]
  firstParty?: ClaudeCodeFirstPartyContext
  /**
   * Accepted so a caller can state its intent, but it does NOT change the header
   * set: the captured client sends accept: application/json on stream:true
   * requests too (both requests of test/fixtures/claude-api/request-2.1.330.json).
   */
  stream?: boolean
}

/** Lower-case header names, exactly the captured set. */
export function buildClaudeApiHeaders(input: ClaudeApiHeadersInput): Record<string, string> {
  const betas = [...new Set(input.betas.filter(beta => beta !== ''))]
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': claudeApiUserAgent(input.version),
    'x-app': CLAUDE_API_ENTRYPOINT,
    'x-claude-code-session-id': input.sessionUuid,
    'anthropic-version': CLAUDE_API_ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-api-key': input.apiKey,
    ...CLAUDE_API_STAINLESS_HEADERS,
    ...(input.firstParty === undefined ? {} : claudeCodeFirstPartyHeaders(input.firstParty)),
  }
  if (betas.length > 0) headers['anthropic-beta'] = betas.join(',')
  return headers
}

export interface ClaudeApiErrorDetail {
  message: string
  type: string | null
  code: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * The three body shapes of the plan's "error body" section: the official
 * {type,error:{message,type,details:{error_code}},request_id}, the gateway's
 * {error:{message,type},type} and the bare {code,message}. The public message
 * always carries the HTTP status and is redacted before it can reach a DTO.
 */
export function parseClaudeApiError(status: number, text: string, apiKey?: string): ClaudeApiErrorDetail {
  let payload: unknown
  try { payload = JSON.parse(text) } catch { payload = undefined }
  const root = isRecord(payload) ? payload : {}
  const error = isRecord(root.error) ? root.error : {}
  const details = isRecord(error.details) ? error.details : {}
  const detail = nonEmpty(error.message) ?? nonEmpty(root.message) ?? (text.trim() !== '' ? text : 'empty response body')
  const code = nonEmpty(details.error_code) ?? nonEmpty(error.code)
    ?? (typeof root.code === 'number' && Number.isFinite(root.code) ? String(root.code) : nonEmpty(root.code))
  return {
    message: claudeApiSafeDetail('Claude API request failed (' + status + '): ' + detail, apiKey),
    type: nonEmpty(error.type),
    code,
  }
}

export interface ClaudeApiListingInput {
  baseUrl: string
  apiKey: string
  version: string
  fetchFn: typeof fetch
  signal?: AbortSignal
}

const PAGE_LIMIT = 1000
const MAX_PAGES = 10

/**
 * GET <baseUrl>/v1/models?limit=1000, following has_more/last_id with after_id.
 * The page cap bounds a gateway that always answers has_more:true; ids are
 * de-duplicated across pages because a cursor may repeat the boundary row.
 */
export async function listClaudeApiModels(input: ClaudeApiListingInput): Promise<ClaudeApiModelEntry[]> {
  const headers = buildClaudeApiHeaders({
    apiKey: input.apiKey,
    version: input.version,
    // A listing belongs to no conversation; a stable id keeps its pages one session.
    sessionUuid: claudeApiSessionUuid('claude-api-catalog:' + input.baseUrl),
    betas: CLAUDE_API_BASE_BETAS,
  })
  const entries: ClaudeApiModelEntry[] = []
  const seen = new Set<string>()
  let afterId: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = '?limit=' + PAGE_LIMIT + (afterId === null ? '' : '&after_id=' + encodeURIComponent(afterId))
    const init: RequestInit = { method: 'GET', headers }
    if (input.signal !== undefined) init.signal = input.signal
    const response = await input.fetchFn(claudeApiUrl(input.baseUrl, CLAUDE_API_MODELS_PATH) + query, init)
    const raw = await response.text()
    if (!response.ok) throw new Error(parseClaudeApiError(response.status, raw, input.apiKey).message)
    let payload: unknown
    try { payload = JSON.parse(raw) } catch { throw new Error('Claude API model listing returned malformed JSON.') }
    for (const entry of parseClaudeApiModelListing(payload)) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      entries.push(entry)
    }
    const root = isRecord(payload) ? payload : {}
    const lastId = nonEmpty(root.last_id)
    if (root.has_more !== true || lastId === null || lastId === afterId) break
    afterId = lastId
  }
  return entries
}

/** Explicit connectivity check through the real listing, never a paid generation. Never throws. */
export async function testClaudeApiConnection(input: ClaudeApiListingInput & { now?: () => number }): Promise<ClaudeApiConnectionDto> {
  const now = input.now ?? Date.now
  const startedAt = now()
  try {
    const entries = await listClaudeApiModels(input)
    return { connected: true, latencyMs: now() - startedAt, checkedAt: now(), modelCount: entries.length }
  } catch (error) {
    return {
      connected: false,
      latencyMs: now() - startedAt,
      checkedAt: now(),
      modelCount: 0,
      error: claudeApiSafeDetail(error, input.apiKey),
    }
  }
}
