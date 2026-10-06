import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  inBandAnthropicStatus,
  inBandResponsesCode,
  reclassifyInBandError,
  reclassifyInBandResponsesError,
} from '../src/host/common/stream-error.ts'

/**
 * A line's own failure classifier, reduced to the shape the helpers ask for.
 *
 * It mirrors the rule the lines actually own: a 429 that names a spent balance
 * is not a rate limit. That single rule is what the helpers exist to preserve
 * - an in-band failure must produce the same verdict its status delivery would,
 * or the retry policy acts on a verdict the HTTP path would never have given.
 */
function classify(status: number, bodyText: string): { code: string; retryable: boolean } {
  if (status === 429 && /balance|recharge|arrears/i.test(bodyText)) {
    return { code: 'PROVIDER_ERROR', retryable: false }
  }
  if (status === 429) return { code: 'RATE_LIMIT', retryable: true }
  if (status >= 500) return { code: 'SERVER', retryable: true }
  return { code: 'PROVIDER_ERROR', retryable: false }
}

const OVERLOAD = 'Overloaded'

describe('in-band error helpers', () => {
  it('names the status each Anthropic-compatible type stands for', () => {
    expect(inBandAnthropicStatus({ type: 'overloaded_error', message: OVERLOAD })).toBe(529)
    expect(inBandAnthropicStatus({ type: 'rate_limit_error', message: 'Too many requests' })).toBe(429)
    expect(inBandAnthropicStatus({ type: 'api_error', message: 'Internal server error' })).toBe(500)
  })

  it('refuses to name a status for anything else', () => {
    // A fallback here would file a type from the future, or a credential
    // refusal, as a retryable server error - strictly worse than not retrying.
    for (const type of ['invalid_request_error', 'authentication_error', 'request_too_large', 'some_future_error']) {
      expect(inBandAnthropicStatus({ type, message: 'nope' })).toBeNull()
    }
    expect(inBandAnthropicStatus(null)).toBeNull()
    expect(inBandAnthropicStatus('overloaded_error')).toBeNull()
    expect(inBandAnthropicStatus({ message: 'no type at all' })).toBeNull()
  })

  it('reads BOTH structured fields of a Responses error', () => {
    // The body this plugin's own retry-policy docstring quotes names `type`, not
    // `code`, and its message carries none of the prose the heuristic looks for:
    // reading `code` alone missed it, which is why both are read.
    const documented = {
      message: 'Upstream model provider is temporarily unavailable. Please try again in a moment.',
      type: 'server_error',
    }
    expect(inBandResponsesCode(documented, documented.message)).toBe('SERVER')
    expect(inBandResponsesCode({ code: 'server_error', message: 'x' }, 'x')).toBe('SERVER')
    expect(inBandResponsesCode({ code: 'rate_limit_exceeded', message: 'x' }, 'x')).toBe('RATE_LIMIT')
    // A bare-string envelope carries no object at all, so the prose is the only
    // evidence there is.
    expect(inBandResponsesCode(null, 'The engine is currently overloaded.')).toBe('SERVER')
    expect(inBandResponsesCode(null, 'Rate limit exceeded for this key')).toBe('RATE_LIMIT')
    expect(inBandResponsesCode({ code: 'invalid_request' }, 'bad request')).toBeNull()
  })

  it('reclassifies a retryable Anthropic-type failure and preserves the message', () => {
    const thrown = new LlmError('stream error (overloaded_error): Overloaded', 'PROVIDER_ERROR')
    const reclassified = reclassifyInBandError(thrown, { type: 'overloaded_error', message: OVERLOAD }, classify)
    expect(reclassified.code).toBe('SERVER')
    expect(reclassified.message).toBe(thrown.message)
    expect(reclassified.cause).toBe(thrown)
    // No synthetic status: the response really was a 200.
    expect((reclassified as { failure?: { status?: number } }).failure?.status).toBeUndefined()
  })

  it('keeps the mapper verdict whenever the classifier would not retry', () => {
    for (const type of ['invalid_request_error', 'authentication_error', 'some_future_error']) {
      const thrown = new LlmError('Kimi stream error', 'PROVIDER_ERROR')
      expect(reclassifyInBandError(thrown, { type, message: 'nope' }, classify)).toBe(thrown)
    }
  })

  it('asks the line classifier about a Responses verdict instead of trusting it', () => {
    // The heuristic says "worth retrying"; only the classifier knows that a 429
    // naming a spent balance is not. Trusting the heuristic here is how an
    // in-band delivery ends up the one delivery with its own opinion - and it
    // would also leave a `classify` parameter declared and never called.
    const rawError = { code: 'rate_limit_exceeded', message: 'insufficient balance, please recharge your account' }
    const thrown = new LlmError('responses stream failed: insufficient balance', 'PROVIDER_ERROR')
    expect(reclassifyInBandResponsesError(thrown, rawError, rawError.message, classify)).toBe(thrown)
    // The same envelope without the balance wording is a real rate limit.
    const transient = { code: 'rate_limit_exceeded', message: 'Too many requests' }
    expect(reclassifyInBandResponsesError(thrown, transient, transient.message, classify).code).toBe('RATE_LIMIT')
  })
})
