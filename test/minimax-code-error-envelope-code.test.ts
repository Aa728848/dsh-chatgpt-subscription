import { describe, expect, it } from 'vitest'
import { classifyMinimaxFailure } from '../src/host/minimax-code/adapter.ts'
import { PROVIDER_NAME } from '../src/host/minimax-code/types.ts'

/**
 * The numeric status code, read out of the envelope the /messages route ACTUALLY sends.
 *
 * This file exists beside test/minimax-code-usage-limit-code.test.ts rather than inside
 * it on purpose: that suite covers the two envelopes this line documented before the
 * probe — `{"base_resp":{"status_code":…}}` and `{"errorCode":…}` — and this one covers
 * the third, which it did not.
 *
 * Measured on 2026-10-20 (docs/minimax-code-probe-capabilities.md):
 *
 *  · a 400 on /messages carries NO numeric field at all —
 *    `{"type":"error","error":{"type":"invalid_request_error","message":"…(2013)…"}}` —
 *    with its 2013 sitting in the message TEXT;
 *  · a 401 on /messages carries the route's only number, at the TOP level:
 *    `{"code":401,"message":"auth failed"}`.
 *
 * So `statusCodeIn` read `base_resp.status_code ?? errorCode`, and on this route that
 * arm could never fire: every /messages refusal fell through to the phrase table, and a
 * spent window that arrived as a bare code was read as ordinary back-pressure. These
 * cases pin the top-level `code` arm in both directions — a quota code it must catch,
 * and a credential code it must NOT mistake for one — because an arm that only ever
 * said "quota" would cool working accounts over every 401.
 *
 * No network and no credential: `classifyMinimaxFailure` is a pure function of the
 * status and the raw body, so every case below is one call.
 */

/** The verdict the phrase path already produces, written out once. */
const PHRASE_QUOTA_VERDICT = {
  code: 'PROVIDER_ERROR',
  retryable: false,
  accountScoped: true,
} as const

describe('the code this route actually sends in its error envelope', () => {
  it('reads a top-level 2056 as a spent window', () => {
    // The shape the 401 documents, with a quota code in it: no base_resp, no
    // errorCode, and — in the code-only form below — no sentence either. The number
    // is the whole verdict, which is exactly what the phrase table cannot see.
    const body = JSON.stringify({ code: 2056, message: 'plan quota exhausted' })

    expect(classifyMinimaxFailure(429, body)).toMatchObject(PHRASE_QUOTA_VERDICT)
    // The same window arriving as a 403 is the same verdict, exactly as it is for the
    // other two envelopes: the status is not what separates a spent plan from a
    // refused token (see isSpentWindow403).
    expect(classifyMinimaxFailure(403, body)).toMatchObject(PHRASE_QUOTA_VERDICT)
    // A bare code with no wording at all: nothing for the phrase table to match, so
    // this case fails outright if the numeric arm regresses.
    expect(classifyMinimaxFailure(429, JSON.stringify({ code: 2067 }))).toMatchObject(PHRASE_QUOTA_VERDICT)
    // And it is the SAME verdict the base_resp arm produces: one code, three
    // envelopes, one classification. Compared on the three fields every caller
    // branches on — the quoted excerpt differs only because the two bodies differ,
    // which is this classifier's documented behaviour.
    const shallow = classifyMinimaxFailure(429, JSON.stringify({ base_resp: { status_code: 2056 } }))
    expect(classifyMinimaxFailure(429, body)).toMatchObject({
      code: shallow.code,
      retryable: shallow.retryable,
      accountScoped: shallow.accountScoped,
    })
    // The remedy still names the quota, not a retry the policy will not perform.
    expect(classifyMinimaxFailure(429, body).message).toContain(PROVIDER_NAME + ' reports the account quota is exhausted')
    expect(classifyMinimaxFailure(429, body).message).not.toMatch(/retrying/i)
  })

  it('does not read a top-level 401 as a spent window', () => {
    // The route's real 401 body, verbatim. 401 is not in the usage-limit table, so
    // this must stay a refused credential: reading quota into it would cool a working
    // account and send a working token off to be renewed.
    const body = JSON.stringify({ code: 401, message: 'auth failed' })

    expect(classifyMinimaxFailure(401, body)).toMatchObject({
      code: 'INVALID_CREDENTIAL',
      retryable: false,
      accountScoped: true,
    })
    expect(classifyMinimaxFailure(401, body)).not.toMatchObject(PHRASE_QUOTA_VERDICT)
    // 401 must not be read as a quota verdict under any status, since a 429 carrying
    // it is ordinary back-pressure and belongs to no single account.
    expect(classifyMinimaxFailure(429, body)).toMatchObject({
      code: 'RATE_LIMIT',
      retryable: true,
      accountScoped: false,
    })
    // 2013 stays the generic invalid-params code in this envelope too: it is absent
    // from the table, and the table is the only thing that decides.
    expect(classifyMinimaxFailure(429, JSON.stringify({ code: 2013, message: 'invalid params' })))
      .toMatchObject({ code: 'RATE_LIMIT', retryable: true, accountScoped: false })
    // A top-level code the table does not name, and a body with no code at all, both
    // fall back to the status — the new arm ADDS a reading, it never replaces one.
    expect(classifyMinimaxFailure(429, JSON.stringify({ code: 1004 })))
      .toMatchObject({ code: 'RATE_LIMIT', retryable: true, accountScoped: false })
    expect(classifyMinimaxFailure(429, JSON.stringify({ message: 'too many requests' })))
      .toMatchObject({ code: 'RATE_LIMIT', retryable: true, accountScoped: false })
  })
})
