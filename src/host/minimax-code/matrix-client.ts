/**
 * The Matrix media gateway client for the MiniMax Code subscription.
 *
 * The Messages route (`{agentBase}/mavis/api/v1/llm/v1/messages`) carries the
 * chat surface only. Everything else the subscription can do — video generation,
 * video understanding, image and audio tools — lives behind a SECOND prefix on
 * the SAME origin: `{agentBase}/mavis/api/v1/mcp/<tool>`. Nothing in
 * ./client.ts reaches it, and this module is that missing half.
 *
 * Why the endpoint set is what it is (docs/minimax-video-design-spec.md section
 * 3, and the live probe in scripts/probe-minimax-matrix-gateway.probe.ts):
 *
 * - the host is the AGENT host, not the API host. cn is `https://agent.minimax.cn`
 *   and global is `https://agent.minimax.io`, both already named by
 *   ./types.ts's REGION_HOSTS. `agent.minimaxi.com` is the CHECK-IN surface's
 *   host — the upstream tree spells it LEGACY (matrix-env.ts:28) — and pointing
 *   a media call at it would miss.
 * - authentication is the subscription bearer and nothing else. The measured
 *   request carried exactly accept / authorization / content-type / user-agent
 *   and was answered HTTP 200 `base_resp.status_code: 0`. The `yy` /
 *   `x-timestamp` / `x-signature` triple belongs to the check-in surface, and
 *   `user_id` / `biz_id` / `request_sk` are gated on a non-prod build env and
 *   resolve to {} in prod, so none of them is sent here either.
 *
 * TWO FAILURE KINDS, and they are not the same verdict:
 *
 * - a BUSINESS failure is HTTP 200 with `base_resp.status_code !== 0` OR with a
 *   non-zero TOP-LEVEL `code`. Both are the service accepting the request,
 *   understanding it, and refusing it: retrying the same body asks the same
 *   question again and gets the same answer, so it is terminal. Upstream proves
 *   the same pair (packages/agent-tools/src/cloud/matrix-tools/client.ts:140-158)
 *   and a client that only reads the first one reports a refusal as a success.
 * - a REQUEST failure is a non-2xx status. Which one it is (a refused
 *   credential, back-pressure, an overloaded gateway, a malformed body) is
 *   decided by {@link classifyMinimaxFailure}, which this line already uses for
 *   every other refusal it reports.
 *
 * The classification SHAPE is reused rather than reinvented: `code`,
 * `message`, `retryable`, `accountScoped`. A caller that reads a verdict from
 * the Messages route and a caller that reads one from here must not have to
 * know which surface produced it.
 *
 * @module dsh-chatgpt-subscription/minimax-code/matrix-client
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { MinimaxCodeRegion } from '../../shared/minimax-code-contracts.ts'
import { classifyMinimaxFailure, type MinimaxFailureClassification } from './adapter.ts'
import { summarizeFailureBody } from './client.ts'
import { PROVIDER_NAME, agentBaseUrl } from './types.ts'

/** Prefix every Matrix media tool hangs off. */
export const MATRIX_API_PREFIX = '/mavis/api/v1/mcp'

/**
 * User agent the gateway was measured to accept.
 *
 * NOT the package's own product token (./types.ts USER_AGENT). A media call is
 * a first-party-client surface rather than an LLM endpoint, and the measured
 * shape sent this literal; the note in ./types.ts about not impersonating the
 * official app is about the TELEMETRY headers (`yy` and friends), which are
 * still never sent.
 */
export const MATRIX_USER_AGENT = 'MiniMaxAgent'

/** Default per-call time budget, matching the upstream media-tool timeout table. */
export const MATRIX_DEFAULT_TIMEOUT_MS = 120_000

/** Path segment of the video-understanding tool. */
export const MATRIX_TOOL_VIDEOS_UNDERSTAND = 'videos_understand'
/** Path segment of the async video-generation submit tool. */
export const MATRIX_TOOL_SUBMIT_VIDEO = 'submit_video_generation'
/** Path segment of the async video-generation query tool. */
export const MATRIX_TOOL_QUERY_VIDEO = 'query_video_generation'
/** Path segment of the presigned-upload broker. */
export const MATRIX_TOOL_GET_UPLOAD_URL = 'get_upload_url'

type FetchLike = typeof fetch

/**
 * The Matrix media route for one region and tool.
 *
 * @param region - subscription region (`cn` or `global`).
 * @param tool - tool path segment, e.g. `videos_understand`.
 * @returns the absolute endpoint URL.
 */
export function matrixToolUrl(region: MinimaxCodeRegion, tool: string): string {
  const segment = tool.startsWith('/') ? tool.slice(1) : tool
  return agentBaseUrl(region) + MATRIX_API_PREFIX + '/' + segment
}

/**
 * The complete header set of one Matrix request: exactly four entries.
 *
 * Kept as a function of the token alone so a test can assert the absence of the
 * check-in surface's signature headers and the routing headers by name, rather
 * than trusting that nobody added one later.
 *
 * @param accessToken - subscription access token.
 * @returns the four headers, in the measured spelling.
 */
export function matrixRequestHeaders(accessToken: string): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: 'Bearer ' + accessToken,
    'content-type': 'application/json',
    'user-agent': MATRIX_USER_AGENT,
  }
}

/** A JSON object, or undefined for anything else (including a failed parse). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** The whole number one field holds, or undefined when it holds anything else. */
function integerOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/**
 * One settled Matrix call.
 *
 * `body` is the parsed JSON envelope with `base_resp` still on it, so a caller
 * can read `status_msg` when it needs the service's own wording. Payload fields
 * sit at the TOP level of that envelope on every tool this line has read.
 *
 * The one top-level key that is NOT a payload field is `code`: it is the
 * envelope's second status code, already proven zero by the time a response is
 * returned (see {@link businessStatusOf}).
 */
export interface MatrixToolResponse {
  /** The tool the call named. */
  readonly tool: string
  /** HTTP status of the answer. */
  readonly status: number
  /** Parsed JSON object body. */
  readonly body: Record<string, unknown>
}

/** One Matrix failure, carrying the verdict the rest of the line speaks. */
export class MatrixToolError extends HarnessError {
  /** The reused classification: `code`/`message`/`retryable`/`accountScoped`. */
  readonly classification: MinimaxFailureClassification
  /** HTTP status when there was one; undefined for a transport failure. */
  readonly status: number | undefined
  /** The tool the failing call named. */
  readonly tool: string

  constructor(
    message: string,
    code: string,
    classification: MinimaxFailureClassification,
    tool: string,
    status?: number,
  ) {
    super(message, code)
    this.name = 'MatrixToolError'
    this.classification = classification
    this.tool = tool
    this.status = status
  }
}

/** Error code for a business refusal (HTTP 200, `base_resp.status_code !== 0`). */
export const MATRIX_BUSINESS_ERROR_CODE = 'MINIMAX_MATRIX_BUSINESS_ERROR'
/** Error code for a non-2xx answer. */
export const MATRIX_HTTP_ERROR_CODE = 'MINIMAX_MATRIX_HTTP_ERROR'
/** Error code for a request that never produced a response. */
export const MATRIX_TRANSPORT_ERROR_CODE = 'MINIMAX_MATRIX_TRANSPORT_ERROR'
/** Error code for a call that outlived its budget. */
export const MATRIX_TIMEOUT_ERROR_CODE = 'MINIMAX_MATRIX_TIMEOUT'

/** Options for {@link callMatrixTool}. */
export interface CallMatrixToolOptions {
  /** Subscription region; decides which agent host is used. */
  readonly region: MinimaxCodeRegion
  /** Subscription access token (bearer). */
  readonly accessToken: string
  /** Tool path segment, e.g. `videos_understand`. */
  readonly tool: string
  /** JSON request body. */
  readonly body: Record<string, unknown>
  /** Injected fetch, so tests never touch the network. */
  readonly fetchFn?: FetchLike
  /** Caller cancellation. */
  readonly signal?: AbortSignal
  /** Per-call budget; defaults to {@link MATRIX_DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/** Fuse a caller signal with a timeout, without leaking the timer. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** One status code an envelope can refuse with, and the field that carried it. */
interface MatrixNonZeroCode {
  /** The field name, exactly as it is spelled on the wire. */
  readonly field: 'base_resp.status_code' | 'code'
  /** The non-zero value it held. */
  readonly code: number
}

/**
 * Collect every non-zero status code one envelope carries.
 *
 * There are TWO, and a call has succeeded only when BOTH are zero — the rule
 * upstream implements at packages/agent-tools/src/cloud/matrix-tools/client.ts:
 * 140-158:
 *
 * 1. `base_resp.status_code` — the wrapper's own verdict.
 * 2. the TOP-LEVEL `code` — the payload's verdict. Upstream reads it off the
 *    envelope AFTER deleting `base_resp` (`const payload = { ...resp }; delete
 *    payload.base_resp; const bizCode = payload.code`), which is the same thing
 *    as reading `body.code` here: it is a SIBLING of the payload fields, not one
 *    of them. Do not confuse it with a payload key when reading the body.
 *
 * Reading only the first is a real bug rather than a shortcut: a measured
 * `get_voice_list` answer happened to carry `code: 0`, so the gap stayed
 * invisible until some tool answered a refusal in the other field.
 *
 * Absent reads as 0 — "the envelope said nothing about it" — rather than as a
 * failure. A tool that answers a bare payload without the wrapper is still a
 * successful answer, and inventing a failure out of a missing field would report
 * a crash for a working call.
 *
 * @param body - the parsed envelope, `base_resp` still on it.
 * @returns every non-zero code found, in field order; empty means success.
 */
function businessStatusOf(body: Record<string, unknown>): readonly MatrixNonZeroCode[] {
  const found: MatrixNonZeroCode[] = []
  const base = asRecord(body.base_resp)
  const baseStatus = integerOrUndefined(base?.status_code) ?? 0
  if (baseStatus !== 0) found.push({ field: 'base_resp.status_code', code: baseStatus })
  // Top level ONLY. `code` is not looked for under `data`/`result`: upstream
  // reads it as a sibling of the payload, and a nested `code` is that tool's
  // own business field.
  const topCode = integerOrUndefined(body.code) ?? 0
  if (topCode !== 0) found.push({ field: 'code', code: topCode })
  return found
}

/** The service's own sentence for one business refusal, when it supplied one. */
function businessMessageOf(body: Record<string, unknown>): string {
  const base = asRecord(body.base_resp)
  const text = base?.status_msg
  return typeof text === 'string' ? text.trim() : ''
}

/**
 * Call one Matrix media tool and return its parsed envelope.
 *
 * @param options - region, credential, tool, body and the injectable transport.
 * @returns the parsed envelope, with the business status already proven zero.
 * @throws MatrixToolError for a business refusal, a non-2xx answer, a transport
 *   failure, or a timeout. Every one carries a reused classification.
 */
export async function callMatrixTool(options: CallMatrixToolOptions): Promise<MatrixToolResponse> {
  const fetchFn = options.fetchFn ?? fetch
  const timeoutMs = options.timeoutMs ?? MATRIX_DEFAULT_TIMEOUT_MS
  const url = matrixToolUrl(options.region, options.tool)
  const signal = withTimeout(options.signal, timeoutMs)

  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: matrixRequestHeaders(options.accessToken),
      body: JSON.stringify(options.body),
      signal,
      // A redirect on a media call is not a shape this route has measured, and
      // following one would replay a billing-bearing body against whatever host
      // the answer named. Refusing is the honest verdict.
      redirect: 'error',
    })
  } catch (error) {
    // A cancellation the caller asked for is not this client's verdict to
    // classify: it is passed through so the tool can settle as cancelled.
    if (options.signal?.aborted === true) throw error
    const timedOut = (error as { name?: string } | undefined)?.name === 'TimeoutError'
    if (timedOut) {
      const classification: MinimaxFailureClassification = {
        code: 'TIMEOUT',
        retryable: true,
        accountScoped: false,
        message: PROVIDER_NAME + ' did not answer ' + options.tool + ' within '
          + Math.round(timeoutMs / 1000) + 's. The request was not refused; it was not answered in time.',
      }
      throw new MatrixToolError(
        classification.message + ' Retrying with backoff.',
        MATRIX_TIMEOUT_ERROR_CODE,
        classification,
        options.tool,
      )
    }
    const detail = error instanceof Error ? error.message : String(error)
    const classification: MinimaxFailureClassification = {
      code: 'TRANSPORT',
      retryable: true,
      accountScoped: false,
      message: PROVIDER_NAME + ' could not reach the media gateway for ' + options.tool + ': ' + detail,
    }
    throw new MatrixToolError(
      classification.message + ' Retrying with backoff.',
      MATRIX_TRANSPORT_ERROR_CODE,
      classification,
      options.tool,
    )
  }

  const raw = await response.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = raw.trim() === '' ? undefined : JSON.parse(raw) as unknown
  } catch {
    parsed = undefined
  }
  const body = asRecord(parsed)

  if (!response.ok) {
    // The verdict for a non-2xx answer is the line's existing one, so a 401
    // here names the same sign-in remedy it names on the Messages route.
    const classification = classifyMinimaxFailure(response.status, raw)
    throw new MatrixToolError(
      classification.message,
      MATRIX_HTTP_ERROR_CODE,
      classification,
      options.tool,
      response.status,
    )
  }

  if (body === undefined) {
    // 200 with a body that is not a JSON object: the service answered something
    // this client cannot read, and pretending it succeeded would hand the caller
    // an undefined payload it would then read as an empty result.
    const detail = summarizeFailureBody(raw)
    const classification: MinimaxFailureClassification = {
      code: 'PROVIDER_ERROR',
      retryable: false,
      accountScoped: false,
      message: PROVIDER_NAME + ' answered ' + options.tool + ' with a body that is not a JSON object'
        + (detail === '' ? '' : ': ' + detail),
    }
    throw new MatrixToolError(classification.message, MATRIX_BUSINESS_ERROR_CODE, classification, options.tool, 200)
  }

  const nonZeroCodes = businessStatusOf(body)
  if (nonZeroCodes.length > 0) {
    const detail = businessMessageOf(body)
    // Each code is named with the field it came from, so a refusal that arrives
    // in the payload's `code` is not misread as the wrapper's, and a body that
    // is non-zero in BOTH reports both instead of hiding the second.
    const codes = nonZeroCodes.map(entry => entry.field + ' ' + String(entry.code)).join(', ')
    const classification: MinimaxFailureClassification = {
      // Terminal on purpose: the service understood the request and refused it,
      // so the same body asked again is the same refusal.
      code: 'PROVIDER_ERROR',
      retryable: false,
      accountScoped: false,
      message: PROVIDER_NAME + ' refused ' + options.tool + ' (' + codes + '): '
        + (detail === '' ? 'no reason given' : detail),
    }
    throw new MatrixToolError(classification.message, MATRIX_BUSINESS_ERROR_CODE, classification, options.tool, 200)
  }

  return { tool: options.tool, status: response.status, body }
}

/**
 * Read one payload field out of an envelope, trying the shapes this gateway
 * has been observed to use.
 *
 * Top level first — that is where every measured tool puts its payload — then
 * `data` and `result` for a tool that nests it. Undefined when none of them
 * carries the key, so the caller refuses rather than reading a missing field as
 * an empty string.
 *
 * @param body - the parsed envelope.
 * @param key - the field name the tool documents.
 * @returns the value, whatever it is, or undefined.
 */
export function matrixPayloadField(body: Record<string, unknown>, key: string): unknown {
  if (key in body) return body[key]
  for (const wrapper of ['data', 'result'] as const) {
    const nested = asRecord(body[wrapper])
    if (nested !== undefined && key in nested) return nested[key]
  }
  return undefined
}
