/**
 * The MiniMax Code reset-card ("额度重置卡") surfaces.
 *
 * Three upstream calls, all on the API hosts this line already reads usage from
 * (`QUOTA_HOST_CANDIDATES` in ./types.ts), all authenticated the same way the
 * usage read is:
 *
 * - `GET  /backend/account/reset_card/list?page=1&size=20`
 * - `GET  /backend/account/reset_card/flows?create_time=<ms>&page=1&size=20`
 * - `POST /backend/account/reset_card/use` with `{ source_type, out_biz_no }`
 *
 * Two facts below are load-bearing and were measured, not inferred:
 *
 * 1. `flows` REQUIRES `create_time`. Without it the service answers HTTP 200
 *    with `base_resp.status_code: 2013` ("invalid params"), so the window start
 *    is always sent — 30 days back, which is the window the panel shows.
 *
 * 2. The use call is idempotent on `out_biz_no`, which is a field OF THE CARD.
 *    The client therefore sends the card's own `source_type` and `out_biz_no`
 *    verbatim and generates no request id of its own: a self-minted id would
 *    defeat the de-duplication the service performs and turn one user click into
 *    several cards spent.
 *
 * The desktop client sends these calls with a literal `token:` header; measured,
 * that answers 401. The bearer form used here works, and no `yy` /
 * `x-timestamp` / `x-signature` attribution headers are sent — this package
 * does not forge the official client's identity (see ./types.ts).
 *
 * Parsing is deliberately forgiving: a row with a missing or mistyped field is
 * SKIPPED rather than thrown, because one malformed card must not blank the whole
 * panel. A business failure (`base_resp.status_code !== 0`) is a different thing
 * and is reported, using the same classification the usage read uses.
 */

import type {
  MinimaxCodeResetCardDto,
  MinimaxCodeResetCardFlowDto,
  MinimaxCodeResetCardsDto,
  MinimaxCodeResetOutcome,
} from '../../shared/minimax-code-contracts.ts'
import type { MinimaxCodeCredentials } from './token-store.ts'
import { USER_AGENT, quotaHostCandidates } from './types.ts'

/** Path of the available-cards read. */
export const RESET_CARD_LIST_PATH = '/backend/account/reset_card/list'
/** Path of the flow history read. REQUIRES `create_time`; see the header note. */
export const RESET_CARD_FLOWS_PATH = '/backend/account/reset_card/flows'
/** Path that spends a card. */
export const RESET_CARD_USE_PATH = '/backend/account/reset_card/use'

/** Page size every read asks for. */
export const RESET_CARD_PAGE_SIZE = 20
/** The flow window the panel shows, and the start `flows` is asked from. */
export const RESET_CARD_FLOW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
/** Local timeout for one reset-card call. */
export const RESET_CARD_TIMEOUT_MS = 15_000

/** The outcomes the service reports, exactly. */
const RESET_OUTCOMES: ReadonlySet<string> = new Set<MinimaxCodeResetOutcome>([
  'SUCCESS',
  'REPLAYED',
  'EXPIRED',
  'NOT_FOUND',
  'RETRYABLE_FAIL',
  'LOCK_BUSY',
])

/** Business codes this surface is known to answer with. */
export const RESET_CARD_RATE_LIMIT = 1002
export const RESET_CARD_UNAUTHORIZED = 1004
export const RESET_CARD_INVALID_PARAMS = 2013

/**
 * A reset-card call that failed.
 *
 * `statusCode` is the envelope's `base_resp.status_code` (the platform answers
 * HTTP 200 for a refusal), `httpStatus` the status line when the transport
 * itself refused. Both are kept so the route can answer 401 for an expired token
 * rather than the generic 502 it would otherwise send for an upstream refusal.
 */
export class MinimaxCodeResetCardError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly statusCode: number | null,
  ) {
    super(message)
    this.name = 'MinimaxCodeResetCardError'
  }
}

/**
 * Status line one failure should be reported to the browser with.
 *
 * The envelope codes are mapped rather than flattened, because "rate limited"
 * and "your sign-in expired" ask the user for opposite things: one is a
 * "try in a minute", the other is a refresh this line performs on its own.
 */
export function resetCardHttpStatus(error: unknown): number {
  if (!(error instanceof MinimaxCodeResetCardError)) return 502
  if (error.httpStatus === 401 || error.httpStatus === 403) return 401
  if (error.statusCode === RESET_CARD_RATE_LIMIT) return 429
  if (error.statusCode === RESET_CARD_UNAUTHORIZED) return 401
  if (error.statusCode === RESET_CARD_INVALID_PARAMS) return 404
  return error.httpStatus !== null && error.httpStatus >= 400 ? 502 : 502
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A finite number, or undefined. The service's epoch fields are milliseconds. */
function ms(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function withTimeout(signal: AbortSignal | undefined, ms_: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms_)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/**
 * Headers for one reset-card call.
 *
 * The bearer is the only credential field: measured, the desktop client's
 * literal `token:` header is refused with 401 by these routes. Nothing derived
 * from the token is ever logged, so a failure sentence can name the surface
 * without naming the credential.
 */
export function resetCardRequestHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: 'Bearer ' + accessToken,
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
  }
}

/**
 * The host that last answered a reset-card call.
 *
 * Mirrors the usage read's own habit: only a live call settles which candidate
 * serves this subscription, so the winner is tried first from then on and the
 * remaining uncertainty stays in one place.
 */
let resetCardHostInForce: string | null = null

/** Forget the remembered host (a sign-out, or a test). */
export function clearResetCardHost(): void {
  resetCardHostInForce = null
}

/** The remembered winning host, if one has answered. */
export function resetCardHost(): string | null {
  return resetCardHostInForce
}

export interface ResetCardRequestOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  /** Clock injection for tests; also decides the flow window start. */
  nowMs?: () => number
}

/** Candidates for one region, the remembered winner first. */
function orderedHosts(region: MinimaxCodeCredentials['region']): string[] {
  const candidates = quotaHostCandidates(region)
  return resetCardHostInForce === null
    ? candidates
    : [resetCardHostInForce, ...candidates.filter((host) => host !== resetCardHostInForce)]
}

/** The envelope's verdict: 0 means the call did what it was asked. */
function readStatusCode(payload: unknown): number {
  return asRecord(asRecord(payload)?.base_resp)?.status_code === undefined
    ? 0
    : Number(asRecord(asRecord(payload)?.base_resp)?.status_code)
}

function statusMessage(payload: unknown, fallback: string): string {
  const message = asRecord(asRecord(payload)?.base_resp)?.status_msg
  return typeof message === 'string' && message !== '' ? message : fallback
}

/**
 * One JSON call, walking the host candidates.
 *
 * Every candidate is tried for a TRANSPORT or business failure alike: a 401 on
 * one host is a host that does not serve this route, not a verdict on the
 * credential — and the task this read serves (which card the user still holds)
 * is worth finding on the next candidate rather than failing over.
 */
async function resetCardCall(input: {
  url: string
  method: 'GET' | 'POST'
  accessToken: string
  host: string
  body?: string
  signal?: AbortSignal
  fetchFn: typeof fetch
}): Promise<unknown> {
  let response: Response
  try {
    response = await input.fetchFn(input.url, {
      method: input.method,
      headers: resetCardRequestHeaders(input.accessToken),
      ...(input.body === undefined ? {} : { body: input.body }),
      signal: withTimeout(input.signal, RESET_CARD_TIMEOUT_MS),
    })
  } catch (error) {
    throw new MinimaxCodeResetCardError(
      'reset-card call could not be reached: ' + (error instanceof Error ? error.message : String(error)),
      null,
      null,
    )
  }
  if (!response.ok) {
    throw new MinimaxCodeResetCardError(
      'reset-card call failed with HTTP ' + response.status,
      response.status,
      null,
    )
  }
  const payload: unknown = await response.json().catch(() => undefined)
  const statusCode = readStatusCode(payload)
  if (statusCode !== 0) {
    throw new MinimaxCodeResetCardError(
      statusMessage(payload, 'reset-card call rejected with base_resp ' + statusCode),
      response.status,
      statusCode,
    )
  }
  resetCardHostInForce = input.host
  return payload
}

/** Run one call against the candidate list, keeping the last failure to report. */
async function callAcrossHosts(input: {
  path: string
  method: 'GET' | 'POST'
  credentials: MinimaxCodeCredentials
  body?: string
  options: ResetCardRequestOptions
}): Promise<unknown> {
  const fetchFn = input.options.fetchFn ?? fetch
  let lastError: unknown = null
  for (const host of orderedHosts(input.credentials.region)) {
    try {
      return await resetCardCall({
        url: host.replace(/\/+$/, '') + input.path,
        method: input.method,
        accessToken: input.credentials.accessToken,
        host,
        fetchFn,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.options.signal === undefined ? {} : { signal: input.options.signal }),
      })
    } catch (error) {
      lastError = error
    }
  }
  if (lastError instanceof MinimaxCodeResetCardError) throw lastError
  throw new MinimaxCodeResetCardError('reset-card call had no usable host', null, null)
}

/** One card, or undefined when a required field is missing or mistyped. */
export function parseResetCard(raw: unknown): MinimaxCodeResetCardDto | undefined {
  const row = asRecord(raw)
  if (row === undefined) return undefined
  const cardId = text(row.card_id)
  const sourceType = text(row.source_type)
  const outBizNo = text(row.out_biz_no)
  const expiresAtMs = ms(row.expire_time)
  const createdAtMs = ms(row.create_time)
  // Every field below is one the card is useless without: without the
  // idempotency key it cannot be spent at all, without the source type it cannot
  // be spent correctly, and without the two instants the panel would have to
  // render a card with no expiry and no age. Skipping is the whole point of the
  // tolerant parse — the rest of the panel is still true.
  if (cardId === undefined || sourceType === undefined || outBizNo === undefined) return undefined
  if (expiresAtMs === undefined || createdAtMs === undefined) return undefined
  return { cardId, sourceType, expiresAtMs, createdAtMs, outBizNo }
}

/**
 * One flow row.
 *
 * `event_type` is a closed vocabulary, and an unknown value is dropped rather
 * than passed through: the contract says GRANT | USE, and a card rendered with a
 * third value would be showing this plugin an assumption it cannot back.
 */
export function parseResetCardFlow(raw: unknown): MinimaxCodeResetCardFlowDto | undefined {
  const row = asRecord(raw)
  if (row === undefined) return undefined
  const cardId = text(row.card_id)
  const eventType = text(row.event_type)
  const createdAtMs = ms(row.create_time)
  if (cardId === undefined || createdAtMs === undefined) return undefined
  if (eventType !== 'GRANT' && eventType !== 'USE') return undefined
  return { cardId, eventType, createdAtMs }
}

/** The available cards from one `list` document. */
export function parseResetCardList(payload: unknown): MinimaxCodeResetCardDto[] {
  const rows = asRecord(payload)?.cards
  if (!Array.isArray(rows)) return []
  const cards: MinimaxCodeResetCardDto[] = []
  for (const raw of rows) {
    const card = parseResetCard(raw)
    if (card !== undefined) cards.push(card)
  }
  return cards
}

/** The flow rows from one `flows` document. */
export function parseResetCardFlows(payload: unknown): MinimaxCodeResetCardFlowDto[] {
  const rows = asRecord(payload)?.flows
  if (!Array.isArray(rows)) return []
  const flows: MinimaxCodeResetCardFlowDto[] = []
  for (const raw of rows) {
    const flow = parseResetCardFlow(raw)
    if (flow !== undefined) flows.push(flow)
  }
  return flows
}

/** The query the flow read is sent with. `create_time` is mandatory. */
export function resetCardFlowsQuery(sinceMs: number, page: number = 1, size: number = RESET_CARD_PAGE_SIZE): string {
  return new URLSearchParams({
    create_time: String(Math.floor(sinceMs)),
    page: String(page),
    size: String(size),
  }).toString()
}

/** The query the list read is sent with. */
export function resetCardListQuery(page: number = 1, size: number = RESET_CARD_PAGE_SIZE): string {
  return new URLSearchParams({ page: String(page), size: String(size) }).toString()
}

/**
 * The reset-card panel: the cards still held, plus the recent flow.
 *
 * Two requests, and the asymmetry between them is the point: the LIST is the
 * panel's substance, so a failure of it is reported; the FLOW is context, so its
 * failure degrades to an empty list and the cards still render. A user whose
 * flow read is refused loses a history row, not the button they came to press.
 */
export async function fetchResetCards(
  credentials: MinimaxCodeCredentials,
  options: ResetCardRequestOptions = {},
): Promise<MinimaxCodeResetCardsDto> {
  const now = (options.nowMs ?? Date.now)()
  const listPath = RESET_CARD_LIST_PATH + '?' + resetCardListQuery()
  const cards = parseResetCardList(
    await callAcrossHosts({
      path: listPath,
      method: 'GET',
      credentials,
      options,
    }),
  )
  const flowsPath = RESET_CARD_FLOWS_PATH + '?' + resetCardFlowsQuery(now - RESET_CARD_FLOW_WINDOW_MS)
  const flows = parseResetCardFlows(
    await callAcrossHosts({ path: flowsPath, method: 'GET', credentials, options }).catch(() => null),
  )
  return { cards, flows, fetchedAtMs: now }
}

/**
 * Spend one card.
 *
 * The body is exactly two fields, both copied off the card. There is deliberately
 * no request id here: de-duplication is the service's, keyed on `out_biz_no`,
 * and a self-minted id would make a second click spend a second card — the exact
 * harm this line's contract warns about.
 *
 * The returned outcome is passed through rather than collapsed into a boolean,
 * because three of the six values mean "possibly spent, confirm with THIS card"
 * (REPLAYED, LOCK_BUSY, RETRYABLE_FAIL) and the caller has to be able to tell the
 * user to retry the same card instead of another one.
 */
export async function useResetCard(
  credentials: MinimaxCodeCredentials,
  card: { sourceType: string; outBizNo: string },
  options: ResetCardRequestOptions = {},
): Promise<MinimaxCodeResetOutcome> {
  if (card.sourceType === '' || card.outBizNo === '') {
    throw new MinimaxCodeResetCardError('the reset card is missing its source type or idempotency key', null, null)
  }
  const payload = await callAcrossHosts({
    path: RESET_CARD_USE_PATH,
    method: 'POST',
    credentials,
    body: JSON.stringify({ source_type: card.sourceType, out_biz_no: card.outBizNo }),
    options,
  })
  const outcome = text(asRecord(payload)?.outcome)
  if (outcome === undefined || !RESET_OUTCOMES.has(outcome)) {
    // An unreadable verdict is NOT reported as success: doing so would tell a
    // user their card was spent when the service never said so.
    throw new MinimaxCodeResetCardError(
      'reset-card use answered without a usable outcome',
      null,
      readStatusCode(payload),
    )
  }
  return outcome as MinimaxCodeResetOutcome
}