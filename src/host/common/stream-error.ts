import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * A failure the provider reported INSIDE a 200 stream.
 *
 * A service can answer 200 and then report the failure in the stream, in the
 * same `{ error: { type, message } }` envelope a non-2xx body carries. A mapper
 * has to type that event with one code, and the code that is right in general is
 * PROVIDER_ERROR - it cannot know whether output has started - which is outside
 * every retry set. So a transient failure delivered this way ends the turn on
 * the first try while the identical failure delivered as a status is retried.
 *
 * The reclassification itself is per line, because only the adapter knows
 * whether anything has reached the caller yet, and because every line owns rules
 * its own HTTP path already owns. What is shared is the question each line asks
 * its own classifier: what status WOULD this failure have carried?
 */

/**
 * The status an in-band `error` event stands for, or null for a type this
 * vocabulary does not name.
 *
 * The Anthropic-compatible shims (MiniMax Code, Kimi Code, and Command Code's
 * messages stream) speak one vocabulary, and each of these types already has a
 * status: 529 is Anthropic's documented overload, 429 the rate limit, and a 5xx
 * the server-side failure. Naming the STATUS rather than the verdict is what lets
 * each line hand the answer to its own classifier, so a rule that line already
 * owns - a 429 that names an exhausted plan, a credential refusal reported as
 * 403 - keeps owning it here.
 *
 * Null for everything else: a request the provider rejected, a context
 * overflow, a credential refusal, a type from the future. Null is what keeps
 * the mapper's own verdict, and that is the safe direction to fail in - a
 * fallback to some made-up status would file an unknown type as a retryable
 * server error, which is worse than not retrying at all.
 */
export function inBandAnthropicStatus(error: unknown): number | null {
  const type = readErrorType(error)
  if (type === null) return null
  return ANTHROPIC_IN_BAND_STATUS[type] ?? null
}

/** The status each transient Anthropic-compatible in-band type stands for. */
const ANTHROPIC_IN_BAND_STATUS: Readonly<Record<string, number>> = {
  overloaded_error: 529,
  rate_limit_error: 429,
  api_error: 500,
}

/**
 * The DSH code an in-band Responses-vocabulary failure becomes, or null when it
 * names nothing transient.
 *
 * The Responses stream reports failure as `response.failed` or `error`, whose
 * message is free text and whose structured evidence is split across TWO fields:
 * this plugin's own routes document `{"error":{"message":"Upstream model
 * provider is temporarily unavailable. Please try again in a moment.","type":
 * "server_error"}}` - `type`, not `code` - so reading only `code` would miss
 * the exact body this exists for, and its message names nothing the heuristic
 * would catch. Both fields are read, and the message is read too, because a
 * deployment that says "overloaded" in prose is the whole signal there.
 *
 * Anything not recognized keeps the mapper's verdict.
 */
export function inBandResponsesCode(error: unknown, message: string): string | null {
  const fields = isRecord(error) ? error : {}
  // Both fields, and `??` is correct here BECAUSE asString answers undefined for an
  // absent one - the contract every mapper's asString in this plugin keeps, so a
  // chain of them reaches `type` whenever `code` is missing.
  const rawCode = (asString(fields.code) ?? asString(fields.type) ?? '').toLowerCase()
  const text = message.toLowerCase()
  if (text.includes('rate limit') || rawCode === 'rate_limit' || rawCode === 'rate_limit_exceeded') return 'RATE_LIMIT'
  if (text.includes('overload')
    || text.includes('server error')
    || rawCode === 'server_error'
    || rawCode === 'service_unavailable'
    || rawCode === 'internal_error') return 'SERVER'
  return null
}

/**
 * The error one in-band stream failure becomes, or `thrown` itself when the
 * line's own verdict stands.
 *
 * Call this only while nothing has reached the caller: the whole reason a fresh
 * request is still free is what makes the retry safe (see module note 1 in the
 * Claude adapter, which this generalizes). After the first chunk the mapper's
 * verdict stands and this must not be called at all.
 *
 * Only the CODE changes. The message stays the mapper's, which names the wire
 * type the user saw, and no `status` is attached: the response really was a
 * 200, and a synthetic one would misreport what the provider said.
 *
 * @param thrown - the mapper's own verdict, passed through when it stands.
 * @param rawError - the event's wire `error` object, from the stream state.
 * @param classify - this line's own failure classifier, so every rule its HTTP
 *   path owns still owns the verdict reached here.
 * @param statusFor - the vocabulary's status table; Responses lines pass
 *   {@link inBandResponsesCode} through {@link reclassifyInBandResponsesError}.
 */
export function reclassifyInBandError(
  thrown: LlmError,
  rawError: unknown,
  classify: (status: number, bodyText: string) => { code: string; retryable: boolean },
  statusFor: (error: unknown) => number | null = inBandAnthropicStatus,
): LlmError {
  const status = statusFor(rawError)
  if (status === null) return thrown
  const failure = classify(status, JSON.stringify({ error: rawError }))
  if (!failure.retryable) return thrown
  return new LlmError(thrown.message, failure.code, { cause: thrown })
}

/**
 * {@link reclassifyInBandError} for a line whose classifier reads a status, fed
 * by the Responses vocabulary instead of the Anthropic one.
 *
 * The transient verdict found here is a QUESTION, not the answer: a
 * `rate_limit` code says only that the failure is worth retrying, and whether
 * it actually is - a 429 naming a spent balance is this route's PROVIDER_ERROR,
 * not a RATE_LIMIT - is a rule the line's own classifier owns. So the answer is
 * asked of `classify` at the status the verdict stands for, exactly as the
 * Anthropic sibling does, and the CODE that comes back is the one the HTTP path
 * would have produced for the same body. That agreement is the whole point: the
 * in-band delivery must not be the one delivery with its own opinion.
 */
export function reclassifyInBandResponsesError(
  thrown: LlmError,
  rawError: unknown,
  message: string,
  classify: (status: number, bodyText: string) => { code: string; retryable: boolean },
): LlmError {
  const code = inBandResponsesCode(rawError, message)
  if (code === null) return thrown
  const failure = classify(code === 'RATE_LIMIT' ? 429 : 500, JSON.stringify({ error: rawError, message }))
  if (!failure.retryable) return thrown
  return new LlmError(thrown.message, failure.code, { cause: thrown })
}

/** The wire `error` object of an in-band event, read defensively. */
function readErrorType(error: unknown): string | null {
  if (!isRecord(error)) return null
  return typeof error.type === 'string' ? error.type : null
}


function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
