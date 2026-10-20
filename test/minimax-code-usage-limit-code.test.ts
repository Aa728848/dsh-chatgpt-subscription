import { describe, expect, it } from 'vitest'
import { classifyMinimaxFailure } from '../src/host/minimax-code/adapter.ts'
import { PROVIDER_NAME } from '../src/host/minimax-code/types.ts'

/**
 * The usage-limit verdict, settled on the upstream STATUS CODE.
 *
 * The official MiniMax Code client decides "this account's window is spent" from a
 * number — `LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODES = [2056, 2067]` in
 * packages/shared/src/llm-error-classifier.ts — while this line decided it from an
 * English-and-Chinese phrase table alone. A phrase table cannot see a body that
 * carries only a code, which is exactly the shape the platform envelope
 * (`{"base_resp":{"status_code":2056}}`) and the client envelope
 * (`{"errorCode":2056}`) both produce.
 *
 * So these cases pin the numeric branch, the things it must NOT swallow (2013 is a
 * generic invalid-params code here, not a quota verdict), and — the one that matters
 * most — that the numeric verdict is the SAME verdict the wording path already
 * produced, field for field. A new branch that invented its own code, or flipped
 * retryable, or dropped accountScoped, would cool the wrong thing or nothing at all.
 *
 * No network, no credential, no adapter: `classifyMinimaxFailure` is a pure function
 * of the status and the raw body, so every case below is one call.
 */

/** The verdict the phrase path already produces, written out once. */
const PHRASE_QUOTA_VERDICT = {
  code: 'PROVIDER_ERROR',
  retryable: false,
  accountScoped: true,
} as const

/** The one body shape the wording table has always matched (Chinese, no code). */
const CHINESE_WORDING_BODY = JSON.stringify({ errorReason: '您的额度已用尽，请充值后重试' })

/**
 * The message the quota verdict builds around one body's excerpt.
 *
 * Written out rather than captured from the classifier so the two arms are compared
 * against the SAME fixed sentence: a numeric branch that quietly changed the template
 * would fail the comparison instead of redefining the expectation.
 */
function quotaMessage(detail: string): string {
  return PROVIDER_NAME + ' reports the account quota is exhausted: '
    + (detail === '' ? 'no remaining quota' : detail)
    + '. Top up or wait for the window to reset.'
}

describe('a usage-limit verdict carried by the upstream status code', () => {
  it('reads 2056 out of the base_resp/status_code envelope as a spent window', () => {
    // The platform envelope, and NOTHING but the code: no sentence, no wording the
    // phrase table could ever match. Before the numeric branch this body was a
    // generic non-2xx and the account was never cooled.
    const body = JSON.stringify({ base_resp: { status_code: 2056 } })

    expect(classifyMinimaxFailure(429, body)).toMatchObject(PHRASE_QUOTA_VERDICT)
    // ...and the same verdict under the 403 that carries the same window, because
    // the status is not what separates them (see the 403/429 suite next door).
    expect(classifyMinimaxFailure(403, body)).toMatchObject(PHRASE_QUOTA_VERDICT)
  })

  it('reads 2067 out of the same envelope, and out of the errorReason envelope', () => {
    expect(classifyMinimaxFailure(429, JSON.stringify({ base_resp: { status_code: 2067 } })))
      .toMatchObject(PHRASE_QUOTA_VERDICT)
    // The OTHER envelope this line documents (types.ts:22, model-catalog.ts:6) puts
    // the code in errorCode and the sentence in errorReason. Both arms are read for
    // the same reason the phrase table reads the raw body: a body judged by one field
    // it does not carry is a body that was never judged.
    expect(classifyMinimaxFailure(429, JSON.stringify({ errorCode: 2067, errorReason: 'weekly limit' })))
      .toMatchObject(PHRASE_QUOTA_VERDICT)
    expect(classifyMinimaxFailure(429, JSON.stringify({ errorCode: 2056 })))
      .toMatchObject(PHRASE_QUOTA_VERDICT)
  })

  it('does not read 2013 as a quota verdict — it is the generic invalid-params code', () => {
    // Upstream says so explicitly, and this repo already reads 2013 that way on the
    // reset-card and Files API paths. A 429 whose code is 2013 is therefore still the
    // back-pressure verdict: retryable, and NOT this account's own failure.
    expect(classifyMinimaxFailure(429, JSON.stringify({ base_resp: { status_code: 2013, status_msg: 'invalid params' } })))
      .toMatchObject({ code: 'RATE_LIMIT', retryable: true, accountScoped: false })

    // Under a 403 the same code is the credential branch, exactly as before: 2013
    // names nothing about this account's remaining quota, so it must not be cooled.
    expect(classifyMinimaxFailure(403, JSON.stringify({ base_resp: { status_code: 2013, status_msg: 'invalid params' } })))
      .toMatchObject({ code: 'INVALID_CREDENTIAL', retryable: false, accountScoped: true })

    // And a 2013 in the sibling envelope is not a quota verdict either.
    expect(classifyMinimaxFailure(429, JSON.stringify({ errorCode: 2013, errorReason: 'invalid params' })))
      .toMatchObject({ code: 'RATE_LIMIT', retryable: true, accountScoped: false })
  })

  it('leaves an unrelated status code with no quota wording alone', () => {
    // A code nobody has claimed, carrying no wording at all: no verdict to read.
    for (const code of [1004, 2013, 50115, 0]) {
      expect(classifyMinimaxFailure(429, JSON.stringify({ base_resp: { status_code: code } })))
        .toMatchObject({ code: 'RATE_LIMIT', retryable: true, accountScoped: false })
    }
    // A 400 keeps its own verdict whatever the code says — this branch only ever
    // ADDS a quota reading, never rewrites a status that already had one.
    expect(classifyMinimaxFailure(400, JSON.stringify({ base_resp: { status_code: 2056 } })))
      .toMatchObject({ code: 'PROVIDER_ERROR', retryable: false, accountScoped: false })
  })

  it('still reads the Chinese wording when the body carries no code at all', () => {
    // The fallback the numeric branch must not have replaced. Same body the phrase
    // table was written for: a domestic service answering in its own language.
    expect(classifyMinimaxFailure(429, CHINESE_WORDING_BODY)).toMatchObject(PHRASE_QUOTA_VERDICT)
    expect(classifyMinimaxFailure(429, CHINESE_WORDING_BODY).message).toContain('您的额度已用尽')
    expect(classifyMinimaxFailure(403, CHINESE_WORDING_BODY)).toMatchObject(PHRASE_QUOTA_VERDICT)
    // A non-JSON body has no field to read, so the wording is the only evidence.
    expect(classifyMinimaxFailure(429, 'insufficient balance, please recharge')).toMatchObject(PHRASE_QUOTA_VERDICT)
  })

  it('produces EXACTLY the phrase path verdict when the code and the wording both fire', () => {
    // The anti-drift assertion: one code + one sentence, and a sentence alone, must
    // be indistinguishable to every caller. `toEqual` rather than `toMatchObject`
    // on purpose — a branch that added a field, or reworded the message for the
    // numeric case, would fail here.
    const both = JSON.stringify({ base_resp: { status_code: 2056, status_msg: '您的额度已用尽，请充值后重试' } })
    const wordingOnly = JSON.stringify({ base_resp: { status_msg: '您的额度已用尽，请充值后重试' } })

    expect(classifyMinimaxFailure(429, both)).toEqual(classifyMinimaxFailure(429, wordingOnly))
    expect(classifyMinimaxFailure(403, both)).toEqual(classifyMinimaxFailure(403, wordingOnly))
    // The same equality against the English wording path, so the message shape is
    // pinned against the table's older arm too.
    expect(classifyMinimaxFailure(429, JSON.stringify({ errorCode: 2067, errorReason: 'insufficient balance' })))
      .toEqual(classifyMinimaxFailure(429, JSON.stringify({ errorReason: 'insufficient balance' })))
  })

  it('reads the code out of the in-band body the adapter builds for itself', () => {
    // The in-stream path does not re-implement this rule; it hands the classifier the
    // body a non-2xx would have carried — { error: <the stream's own error object> }
    // (adapter.ts, the reclassification in generate) — so the envelope sits one level
    // deeper. Reading it here is what makes that inheritance a fact rather than a
    // coincidence, and it is the same call the adapter makes on both paths.
    const inBand = JSON.stringify({ error: { base_resp: { status_code: 2056 } } })
    expect(classifyMinimaxFailure(429, inBand)).toMatchObject(PHRASE_QUOTA_VERDICT)
    // The VERDICT is the same one the top-level envelope gets — the same three fields
    // every caller branches on. The message excerpt differs only because the bodies
    // differ, which is the same thing that happens between any two bodies and is the
    // classification's documented behaviour, not the numeric branch's.
    const shallow = classifyMinimaxFailure(429, JSON.stringify({ base_resp: { status_code: 2056 } }))
    expect(classifyMinimaxFailure(429, inBand)).toMatchObject({
      code: shallow.code,
      retryable: shallow.retryable,
      accountScoped: shallow.accountScoped,
    })
    // Inside error, a 2013 stays what it is everywhere else.
    expect(classifyMinimaxFailure(429, JSON.stringify({ error: { base_resp: { status_code: 2013 } } })))
      .toMatchObject({ code: 'RATE_LIMIT', retryable: true, accountScoped: false })
  })

  it('keeps the message naming the account quota, not a retry', () => {
    // The verdict is only half of it: the sentence the user reads must not promise a
    // retry the policy will not perform, which is what the back-pressure arm says.
    const failure = classifyMinimaxFailure(429, JSON.stringify({ base_resp: { status_code: 2056 } }))
    expect(failure.message).toContain(PROVIDER_NAME + ' reports the account quota is exhausted')
    expect(failure.message).not.toMatch(/retrying/i)
    // A code-only body carries no sentence, so the excerpt is the envelope itself —
    // exactly what every sentence-less body has always shown on this line, and the
    // one thing a numeric branch must not "improve" into a message the wording path
    // would never have produced.
    expect(failure.message).toEqual(quotaMessage(JSON.stringify({ base_resp: { status_code: 2056 } })))
  })
})

