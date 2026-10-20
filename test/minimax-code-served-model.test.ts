import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MinimaxCodeAdapter, MODEL_SUBSTITUTED_CODE } from '../src/host/minimax-code/adapter.ts'
import { MinimaxCodeCredentialStore } from '../src/host/minimax-code/token-store.ts'
import {
  createStreamState,
  processMinimaxStreamLine,
} from '../src/host/minimax-code/mapper.ts'
import { resetRefreshRejections } from '../src/host/minimax-code/oauth.ts'

/**
 * The served-model check: "is the model that ANSWERED the model that was asked for?"
 *
 * Measured fact this suite exists for (docs/minimax-code-probe-capabilities.md, and
 * the probe at scripts/probe-minimax-capabilities.probe.ts): the /messages endpoint
 * does NOT reject a model id it cannot route. Four ids that should not have been
 * servable — MiniMax-M2.5, MiniMax-M1, the retired M3.1-Flash-Preview spelling, a
 * made-up `modelless-probe-id-zzz`, and the empty string — all came back HTTP 200
 * with a normal stream, and the stream HEADER named the model that actually ran:
 * M3 for the two nonsense ids. A follow-up request with the SAME nonsense id and
 * `reasoningEffort: none` really did answer without thinking blocks, which is what
 * proves M3 was RUNNING under those parameters rather than merely being written back
 * into a name field.
 *
 * The consequence is a wallet one, not an availability one: a user whose selection
 * points at an id MiniMax has since dropped keeps getting answers — from the most
 * expensive tier (measured at roughly 3x the thinking and 4x the latency of the
 * cheap ones). There is no "unknown model" payload to key an automatic delisting on,
 * so `message_start.message.model` is the ONLY signal there is, and this suite pins
 * the three ways it is read and the one way it must not be.
 *
 * No network: the transport is an injected fetch answering a synthetic SSE body.
 */

let home = ''
const originalMinimaxHome = process.env.MINIMAX_HOME

beforeEach(async () => {
  resetRefreshRejections()
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-served-model-'))
  // An EMPTY MiniMax home: no case may read the developer's real ~/.minimax.
  process.env.MINIMAX_HOME = home
})

afterEach(async () => {
  resetRefreshRejections()
  if (originalMinimaxHome === undefined) delete process.env.MINIMAX_HOME
  else process.env.MINIMAX_HOME = originalMinimaxHome
  vi.restoreAllMocks()
  // Named entries, then the directory itself. A recursive delete walks through a
  // junction and destroys its target, so it is not used here.
  await fs.rm(path.join(home, 'auth'), { force: true, recursive: false }).catch(() => undefined)
  await fs.rmdir(home).catch(() => undefined)
})

/** One SSE frame, in the shape the adapter already splits on. */
function frame(payload: Record<string, unknown>): string {
  return 'data: ' + JSON.stringify(payload) + '\n\n'
}

/**
 * A 200 SSE answer for one short text reply, whose HEADER names `answeredModel`.
 *
 * `answeredModel` omitted (undefined) is the "the header said nothing" case: the
 * message_start frame then carries usage and no model field at all, which is the
 * shape this suite must treat as "not verified" rather than "mismatched".
 */
function answerStream(answeredModel: string | undefined, text = 'hi'): Response {
  const message: Record<string, unknown> = { usage: { input_tokens: 3, output_tokens: 0 } }
  if (answeredModel !== undefined) message.model = answeredModel
  return new Response(
    frame({ type: 'message_start', message })
    + frame({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
    + frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    + frame({ type: 'content_block_stop', index: 0 })
    + frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })
    + frame({ type: 'message_stop' }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/** An adapter whose every /messages call answers with the given SSE body. */
async function adapterFor(stream: Response, bodies: string[] = []): Promise<MinimaxCodeAdapter> {
  const store = new MinimaxCodeCredentialStore('cn')
  await store.write({
    accessToken: 'ACCESS', refreshToken: 'r-own', tokenType: 'Bearer', clientId: 'mcode-public',
    scopes: [], audience: '', expiresAtMs: Date.now() + 3_600_000, generation: 1, loginEpoch: 'e',
    buildEnv: 'prod', region: 'cn', recordKey: null, source: 'file',
  })
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === 'string') bodies.push(init.body)
    return stream.clone()
  }) as unknown as typeof fetch
  return new MinimaxCodeAdapter(store, { fetchFn })
}

/** What one drained request produced, and what it threw (if anything). */
interface Drain {
  chunks: any[]
  thrown: (Error & { code?: string }) | null
  /** The reply text that actually reached the caller, in order. */
  text: string
}

/**
 * Drain one stream, recording every chunk BEFORE anything can throw.
 *
 * The chunk list is what makes the "nothing was delivered" assertion meaningful:
 * a failure that arrived after a block-start would leave that block-start here.
 */
async function drain(adapter: MinimaxCodeAdapter, model: string): Promise<Drain> {
  const chunks: any[] = []
  let thrown: (Error & { code?: string }) | null = null
  try {
    for await (const chunk of adapter.stream({
      provider: 'minimax-code',
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    } as never)) chunks.push(chunk)
  } catch (error) {
    thrown = error as Error & { code?: string }
  }
  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => String(chunk.text))
    .join('')
  return { chunks, thrown, text }
}

describe('a model id the request asked for that the service did not route', () => {
  it('completes normally when the header names the id the request sent', async () => {
    // The ordinary case, and the one that must never start failing: the service
    // echoes the id it was asked for. Nothing about this turn is unusual, so the
    // whole existing pipeline - block starts, text deltas, the terminal finish -
    // has to come through untouched.
    const bodies: string[] = []
    const { chunks, thrown, text } = await drain(await adapterFor(answerStream('MiniMax-M3'), bodies), 'MiniMax-M3')

    expect(thrown).toBeNull()
    expect(text).toBe('hi')
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
    // And the id that was COMPARED is the id that was SENT: the check reads the
    // serialized body's own model field rather than trusting the catalogue name it
    // resolved for display.
    expect((JSON.parse(bodies[0]) as { model?: string }).model).toBe('MiniMax-M3')
  })

  it('refuses the turn when the header names a different model, before any content block', async () => {
    // The measured substitution: an id the endpoint cannot route is answered by M3
    // under a normal 200. This is the case the whole feature exists for.
    const { chunks, thrown, text } = await drain(
      await adapterFor(answerStream('MiniMax-M3')),
      'modelless-probe-id-zzz',
    )

    expect(thrown).not.toBeNull()
    expect(thrown?.code).toBe(MODEL_SUBSTITUTED_CODE)
    // Terminal by construction: the code is not in
    // MINIMAX_CODE_RETRY_POLICY_CONFIG.retryableCodes, which is what stops the
    // harness from paying for the same substitution three more times.
    const policy = new MinimaxCodeAdapter(new MinimaxCodeCredentialStore()).providerRetryPolicy()
    const retryable = policy.mode === 'normal' ? policy.retryableCodes : []
    expect(retryable).not.toContain(MODEL_SUBSTITUTED_CODE)
    // Both ids are named - they are model names, not secrets - so the reader can act.
    expect(thrown?.message).toContain('modelless-probe-id-zzz')
    expect(thrown?.message).toContain('MiniMax-M3')
    // ...and nothing else about the request leaks into it.
    expect(thrown?.message).not.toContain('ACCESS')
    expect(thrown?.message).not.toContain('r-own')

    // NOTHING reached the caller. message_start precedes the first content block on
    // this protocol, so the refusal lands before any block-start: no orphan block,
    // no partial text, and a retry could not duplicate output.
    expect(text).toBe('')
    expect(chunks).toHaveLength(0)
    expect(chunks.some((chunk) => chunk.type === 'block-start')).toBe(false)
  })

  it('completes normally when the header carries no model at all', async () => {
    // This route's own earlier shape: message_start with usage and nothing else. An
    // absent field is not evidence of a substitution, so the turn is unverified -
    // not failed. Turning a protocol variation into an outage is the failure mode
    // this case exists to rule out.
    const { chunks, thrown, text } = await drain(await adapterFor(answerStream(undefined)), 'MiniMax-M3')

    expect(thrown).toBeNull()
    expect(text).toBe('hi')
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
  })

  it('treats a case difference in the same letters as the same model', async () => {
    // The comparison rule, locked in: case-insensitive equality is a match, and
    // everything else is a mismatch. A service that re-cases the id it echoes is
    // still running the model that was asked for, and refusing to answer over the
    // spelling would fail a turn that is being served correctly.
    const { thrown, text } = await drain(await adapterFor(answerStream('minimax-m3')), 'MiniMax-M3')

    expect(thrown).toBeNull()
    expect(text).toBe('hi')

    // The other direction too, so the rule is not one-way by accident.
    const reversed = await drain(await adapterFor(answerStream('MINIMAX-M3')), 'MiniMax-M3')
    expect(reversed.thrown).toBeNull()
    expect(reversed.text).toBe('hi')
  })
})

describe('the answered model reaches the stream state through the mapper alone', () => {
  it('records message_start.message.model and leaves it unset when the field is absent', () => {
    // The one-line read this feature rests on, exercised without an adapter so the
    // two halves can be reasoned about separately: the mapper RECORDS, the adapter
    // JUDGES.
    const started = createStreamState()
    processMinimaxStreamLine(
      'data: ' + JSON.stringify({ type: 'message_start', message: { model: 'MiniMax-M3', usage: { input_tokens: 1 } } }),
      started,
    )
    expect(started.answeredModel).toBe('MiniMax-M3')
    // The pre-existing reads are untouched by the new one.
    expect(started.inputTokens).toBe(1)

    const silent = createStreamState()
    processMinimaxStreamLine(
      'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } }),
      silent,
    )
    expect(silent.answeredModel).toBeUndefined()
  })
})
