/**
 * Live probe: what does this endpoint actually answer when it CANNOT serve a
 * request, and can this line tell those refusals apart without reading prose?
 *
 * Three questions drove this file, and every one of them was previously
 * answered only from second-hand material:
 *
 * 1. DELISTING. When a model id stops being servable, what comes back? An
 *    answer that can be recognized as "this model cannot be called" is what
 *    makes automatic removal from the picker safe. An answer indistinguishable
 *    from "a parameter was wrong" is not - treating it as a delisting would
 *    silently drop a model the account still pays for, and that is worse than
 *    offering a model that fails, because a failure is visible.
 * 2. WHERE THE NUMBER LIVES. A parallel change wants to judge 2056/2067 by
 *    `base_resp.status_code` rather than by wording. That is only possible if an
 *    Anthropic-shaped request refusal carries that field at all - the envelope
 *    is documented on the QUOTA and Files surfaces, not on this one - so the
 *    bodies below are dumped structurally instead of being summarized.
 * 3. THE OUTPUT CAP. models.dev says 512000 for M3, the upstream fallback table
 *    says 128000, and this line ships 128000 as a value nobody measured. What
 *    the service ACCEPTS is the only thing that can settle it.
 *
 * Q1 IS NOT ANSWERED BY THE STATUS ALONE. A 200 is not proof that the id was
 * served: the head of the stream names the model that actually answered, so
 * every accepted case records that field and the first assistant text. An id the
 * gateway does not know has to show up SOMEWHERE, and if it does not show up in
 * either the status or the answered-by field, then it does not show up at all.
 *
 * QUOTA DISCIPLINE. Every prompt is one short line, and every request that could
 * be ACCEPTED is abandoned after its first bytes: an accepted
 * `max_tokens: 512000` request is evidence about VALIDATION and nothing else -
 * it is not an invitation to generate 512K tokens. Nothing here walks a model
 * list either; a sweep is the shape that actually costs a subscription its
 * window, and the catalog is hardcoded for the same reason. The two cases that
 * cost nothing (an empty body, a deliberately wrong bearer) are there precisely
 * because they buy an envelope shape for free.
 *
 * NOTHING IDENTIFYING IS PRINTED. These bodies are written by a service that
 * knows who is calling, so every string is scrubbed of addresses, UUIDs and
 * token-shaped runs before it can reach a log. What survives is the structural
 * fact this probe exists for: field names, numeric codes, the answered-by
 * model, and the service's own wording.
 *
 * The bodies come from the real `buildMinimaxRequest`, so a case measures what
 * the adapter would send. The exceptions are the cases whose entire point is a
 * shape the mapper cannot produce (an empty body, malformed JSON) or a header
 * the line would never send, and each of those says so out loud on its own
 * evidence line.
 *
 * Run: npx vitest run --config vitest.probe.config.ts probe-minimax-capabilities
 */
import { test } from 'vitest'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { MinimaxCodeCredentialStore } from '../src/host/minimax-code/token-store.ts'
import { MinimaxCodeAccountPool } from '../src/host/minimax-code/account-pool.ts'
import { modelRequestHeaders } from '../src/host/minimax-code/client.ts'
import { messagesUrl } from '../src/host/minimax-code/types.ts'
import { buildMinimaxRequest } from '../src/host/minimax-code/mapper.ts'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'

/** Hard ceiling on one request, so a case can never hang the run. */
const TIMEOUT_MS = 120_000
/** How long an ACCEPTED request is allowed to stream before it is abandoned. */
const EARLY_STREAM_MS = 8_000
/** Characters an accepted request may deliver before it is abandoned. */
const EARLY_STREAM_CHARS = 4_000
/** Pause between cases: a burst is how a rate limit gets mistaken for a verdict. */
const BETWEEN_CASES_MS = 250

const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

/**
 * The shortest prompt that still produces a real turn.
 *
 * Deliberately one line: none of these questions is about the answer, and a
 * long prompt would only add input tokens to every case.
 */
const PROMPT = 'Reply with the single word ok.'

/** Models this run is allowed to spend quota on. Named, never enumerated. */
const MODEL_LIVE = 'MiniMax-M3'
const MODEL_LIVE_ALT = 'MiniMax-M3.1-Flash'

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Text that is safe to put in a log line.
 *
 * An error body is written by a service that knows exactly who is calling and
 * may echo it back, so the scrubbing happens on the way OUT rather than being
 * assumed unnecessary. What is removed is only ever something that could name a
 * person or a session - an address, a UUID, a JWT, a long opaque run. Wording is
 * kept, because the wording is half the evidence.
 */
function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<address>')
    .replace(/eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){0,2}/g, '<token>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/[A-Za-z0-9_-]{32,}/g, (run) => '<redacted:' + run.length + '>')
}

function oneLine(text: string, limit = 400): string {
  const flat = scrub(text).replace(/[\r\n\t]+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '...' : flat
}

// ---------------------------------------------------------------------------
// Structural dump of a response body
// ---------------------------------------------------------------------------

interface Field {
  path: string
  type: string
  value: string
}

/**
 * Walk a body and record every field with its path and type.
 *
 * This is the part of the evidence that cannot be inferred later: a numeric
 * code is only actionable if the PATH it sits at is known, and two envelopes
 * that both carry a number are two different detectors.
 */
function fieldsOf(value: unknown, path = '', out: Field[] = [], depth = 0): Field[] {
  const at = path === '' ? '$' : path
  if (value === null) {
    out.push({ path: at, type: 'null', value: 'null' })
    return out
  }
  if (Array.isArray(value)) {
    out.push({ path: at, type: 'array[' + value.length + ']', value: '' })
    if (depth < 6) value.forEach((item, index) => fieldsOf(item, at + '[' + index + ']', out, depth + 1))
    return out
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    out.push({ path: at, type: 'object{' + keys.join(',') + '}', value: '' })
    if (depth < 6) {
      for (const key of keys) {
        fieldsOf((value as Record<string, unknown>)[key], path === '' ? key : path + '.' + key, out, depth + 1)
      }
    }
    return out
  }
  if (typeof value === 'string') {
    out.push({ path: at, type: 'string', value: JSON.stringify(oneLine(value, 300)) })
    return out
  }
  out.push({ path: at, type: typeof value, value: String(value) })
  return out
}

/**
 * The numbers a detector would have to read, wherever the envelope put them.
 *
 * Searched instead of asserted: the point of the run is to learn which path a
 * refusal uses, and a helper that only looked where the quota envelope puts its
 * code would report "no numeric code" for a refusal that carries one elsewhere.
 */
function numericCodes(body: unknown): string[] {
  const found: string[] = []
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, path + '[' + index + ']', depth + 1))
      return
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const at = path === '' ? key : path + '.' + key
      if (typeof child === 'number' && /(code|status|errno)/i.test(key)) found.push(at + '=' + child)
      walk(child, at, depth + 1)
    }
  }
  walk(body, '', 0)
  return found
}

/** Digits the service wrote into a refusal's own wording, e.g. the " (2013)". */
function codesInWording(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/\((\d{3,6})\)/g)) found.push('(' + match[1] + ')')
  return found
}

// ---------------------------------------------------------------------------
// Early-abandon read of an accepted stream
// ---------------------------------------------------------------------------

interface EarlyStream {
  chars: number
  events: string[]
  error: unknown
  reachedEnd: boolean
  /** The model the head of the stream says actually answered. */
  servedModel: string
  /** Content block types the head of the stream opened. */
  blockTypes: string[]
  /** Characters of assistant text seen before the abort. */
  textChars: number
}

/**
 * Take a few bytes off an accepted response, then abort the connection.
 *
 * The abort is the whole point: an accepted request has already produced the
 * evidence (it validated), and every further token is quota spent on an answer
 * nobody reads. Reading the HEAD is still worth it twice over - it distinguishes
 * a genuinely streaming 200 from a 200 carrying its refusal in-band, and its
 * `message_start.message.model` is the only place the service says which model
 * really answered a request for an id it may not have recognized.
 */
async function readEarly(response: Response, controller: AbortController): Promise<EarlyStream> {
  const body = (response as unknown as { body?: ReadableStream<Uint8Array> | null }).body
  const result: EarlyStream = {
    chars: 0,
    events: [],
    error: undefined,
    reachedEnd: false,
    servedModel: '(none)',
    blockTypes: [],
    textChars: 0,
  }
  if (body === null || body === undefined) {
    controller.abort()
    return result
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + EARLY_STREAM_MS
  let text = ''
  try {
    while (text.length < EARLY_STREAM_CHARS) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remaining)
      })
      const chunk = await Promise.race([reader.read(), timeout])
      if (timer !== undefined) clearTimeout(timer)
      if (chunk === null) break
      if (chunk.done) {
        result.reachedEnd = true
        break
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } catch {
    // The abort below surfaces here; it is the intended ending, not a failure.
  }
  controller.abort()
  await reader.cancel().catch(() => undefined)

  result.chars = text.length
  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    let event: unknown
    try {
      event = JSON.parse(payload) as unknown
    } catch {
      continue
    }
    const asRecord = event as Record<string, unknown> | null
    const type = typeof asRecord?.type === 'string' ? String(asRecord.type) : '(none)'
    if (!result.events.includes(type)) result.events.push(type)
    if (type === 'error' && result.error === undefined) result.error = event
    if (type === 'message_start') {
      const model = (asRecord?.message as Record<string, unknown> | undefined)?.model
      if (typeof model === 'string') result.servedModel = model
    }
    if (type === 'content_block_start') {
      const blockType = (asRecord?.content_block as Record<string, unknown> | undefined)?.type
      if (typeof blockType === 'string' && !result.blockTypes.includes(blockType)) result.blockTypes.push(blockType)
    }
    if (type === 'content_block_delta') {
      const delta = asRecord?.delta as Record<string, unknown> | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') result.textChars += delta.text.length
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// One probe case
// ---------------------------------------------------------------------------

interface ProbeCase {
  id: string
  /** Which of the four questions this case answers. */
  question: string
  /**
   * What this case changes relative to a plain mapper build, in words.
   *
   * Stated per case because "we sent a slightly different body" is exactly the
   * kind of detail that makes a measurement unreproducible later.
   */
  changed: string
  /** Body the mapper produced. */
  body?: Record<string, unknown>
  /** Raw bytes for a case that must not be JSON the mapper could produce. */
  rawBody?: string
  /**
   * Header replacement for a case whose point is the AUTH SHAPE.
   *
   * Only the deliberately-wrong bearer uses it, and it uses a literal that is
   * not this account's token: nothing real is ever weakened to take a reading.
   */
  headers?: Record<string, string>
}

interface Observation {
  id: string
  question: string
  http: string
  served: string
  codes: string
  fields: string
  verdict: string
}

const observations: Observation[] = []

function describeRequest(body: Record<string, unknown> | undefined, rawBody: string | undefined): string {
  if (rawBody !== undefined) return 'raw=' + JSON.stringify(oneLine(rawBody, 60))
  const source = body ?? {}
  const parts = [
    'model=' + JSON.stringify(source.model),
    'max_tokens=' + JSON.stringify(source.max_tokens),
    'stream=' + JSON.stringify(source.stream),
  ]
  if (source.thinking !== undefined) parts.push('thinking=' + JSON.stringify(source.thinking))
  if (source.output_config !== undefined) parts.push('output_config=' + JSON.stringify(source.output_config))
  parts.push('messages=' + (Array.isArray(source.messages) ? source.messages.length : 0))
  return parts.join(' ')
}

async function runCase(item: ProbeCase, url: string, headers: Record<string, string>): Promise<void> {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)])
  const payload = item.rawBody ?? JSON.stringify(item.body)
  const started = Date.now()
  console.log('[probe] ---- ' + item.id + ' (Q' + item.question + ')')
  console.log('[probe]   changed: ' + item.changed)
  console.log('[probe]   request: ' + describeRequest(item.body, item.rawBody) + ' bytes=' + Buffer.byteLength(payload))

  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: item.headers ?? headers,
      body: payload,
      signal,
    }) as unknown as Response
  } catch (error) {
    // A credential/quota/network failure here is a fact about the RUN, not about
    // the service's refusal shape, and it must be reported as such.
    const message = oneLine(error instanceof Error ? error.message : String(error), 200)
    console.log('[probe]   transport failure: ' + message)
    observations.push({
      id: item.id, question: item.question, http: 'transport', served: '-', codes: '-', fields: '-', verdict: message,
    })
    return
  }

  const contentType = response.headers.get('content-type') ?? '(none)'
  const elapsed = Date.now() - started

  if (response.ok) {
    const early = await readEarly(response, controller)
    console.log('[probe]   http=' + response.status + ' content-type=' + JSON.stringify(contentType) + ' ms=' + elapsed)
    console.log('[probe]   ACCEPTED; abandoned after ' + early.chars + ' chars (reachedEnd=' + early.reachedEnd + ')')
    console.log('[probe]   served-model=' + JSON.stringify(early.servedModel)
      + ' blockTypes=' + JSON.stringify(early.blockTypes)
      + ' textChars=' + early.textChars
      + ' events=' + JSON.stringify(early.events))
    let codes = '(none)'
    if (early.error !== undefined) {
      codes = numericCodes(early.error).join(', ') || '(none)'
      for (const field of fieldsOf(early.error)) {
        console.log('[probe]     in-stream ' + field.path + ': ' + field.type + (field.value === '' ? '' : ' = ' + field.value))
      }
    }
    observations.push({
      id: item.id,
      question: item.question,
      http: String(response.status),
      served: early.servedModel,
      codes,
      fields: early.events.join(','),
      verdict: 'accepted; blocks=' + (early.blockTypes.join('+') || '(none)'),
    })
    return
  }

  // A refusal: the whole body is small and IS the evidence.
  const raw = await response.text().catch(() => '')
  console.log('[probe]   http=' + response.status + ' content-type=' + JSON.stringify(contentType) + ' ms=' + elapsed
    + ' bodyBytes=' + Buffer.byteLength(raw))
  console.log('[probe]   body raw: ' + oneLine(raw, 600))
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    parsed = undefined
  }
  const codes = parsed === undefined ? [] : numericCodes(parsed)
  const wordingCodes = codesInWording(raw)
  console.log('[probe]   numeric fields: ' + (codes.length === 0 ? '(none)' : codes.join(', '))
    + ' | codes only in wording: ' + (wordingCodes.length === 0 ? '(none)' : wordingCodes.join(', ')))
  if (parsed !== undefined) {
    for (const field of fieldsOf(parsed)) {
      console.log('[probe]     ' + field.path + ': ' + field.type + (field.value === '' ? '' : ' = ' + field.value))
    }
  }
  observations.push({
    id: item.id,
    question: item.question,
    http: String(response.status),
    served: '-',
    codes: (codes.length === 0 ? '(none)' : codes.join(', ')) + ' wording=' + (wordingCodes.join(',') || '(none)'),
    fields: parsed === undefined ? '(not JSON)' : fieldsOf(parsed).map((field) => field.path).join(' '),
    verdict: oneLine(raw, 160),
  })
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

/** A real, minimal mapper request: the shape a caller with a tiny turn sends. */
function requestFor(model: string, maxTokens: number): GenerateOptions {
  return {
    model,
    maxTokens,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] } as Message],
  } as GenerateOptions
}

function caseList(): ProbeCase[] {
  const cases: ProbeCase[] = []

  // --- Q4 first: the account has to be healthy before any of the rest means
  // --- anything. A quota or credential failure upstream would otherwise be
  // --- read as "the model was rejected", which is the one wrong conclusion.
  cases.push({
    id: 'Q4-control-M3',
    question: '4',
    changed: 'nothing: the mapper builds this exactly as the adapter would',
    body: buildMinimaxRequest(requestFor(MODEL_LIVE, 32)),
  })
  cases.push({
    id: 'Q4-control-M3.1-Flash',
    question: '4',
    changed: 'nothing: model id only',
    body: buildMinimaxRequest(requestFor(MODEL_LIVE_ALT, 32)),
  })

  // --- Q1: what a delisted model looks like. Four flavours of "not servable",
  // --- because they may not share one answer: an id that exists in the public
  // --- catalog but not on this subscription, an id that never existed, and two
  // --- real but old ids this line once named.
  for (const model of ['MiniMax-M2.5', 'modelless-probe-id-zzz']) {
    cases.push({
      id: 'Q1-unknown-' + model,
      question: '1',
      changed: 'nothing but the model id: an id this subscription does not serve',
      body: buildMinimaxRequest(requestFor(model, 32)),
    })
  }
  for (const model of ['MiniMax-M1', 'MiniMax-M3.1-Flash-Preview']) {
    cases.push({
      id: 'Q1-retired-' + model,
      question: '1',
      changed: 'nothing but the model id: a real but old id this line once named',
      body: buildMinimaxRequest(requestFor(model, 32)),
    })
  }
  // The boundary of the same question: a model field that is not a model at
  // all. If a delisting is ever detectable, this is the shape it has to look
  // like, so the absence of a refusal here is itself the finding.
  cases.push({
    id: 'Q1-empty-model',
    question: '1',
    changed: 'model="" passed to the mapper: an identifier that names nothing at all',
    body: buildMinimaxRequest(requestFor('', 32)),
  })

  // WHY THE TWO CASES ABOVE NEED A CONTROL. "The gateway answered with M3" and
  // "the M3 request itself answered with M3" are the same string, so a served
  // model equal to M3 cannot tell substitution apart from a coincidence. Two
  // shapes break the tie without spending anything new: an unknown id with
  // thinking explicitly OFF (the substitute would have to come back with no
  // thinking object at all, which is exactly what this line's M3 refuses to
  // do), and an unknown id whose cap only a large model could accept (a small
  // model substituted for it would refuse).
  cases.push({
    id: 'Q1-unknown-thinking-off',
    question: '1',
    changed: 'the unknown id from above WITH an explicit thinking-off effort, which M3 honours',
    body: buildMinimaxRequest({
      ...requestFor('modelless-probe-id-zzz', 32),
      reasoningEffort: 'none',
    } as GenerateOptions),
  })
  cases.push({
    id: 'Q1-unknown-large-cap',
    question: '1',
    changed: 'the unknown id with a cap only a 512K-class model could accept; abandoned on first bytes',
    body: buildMinimaxRequest(requestFor('modelless-probe-id-zzz', 512_000)),
  })

  // --- Q2: a parameter that is wrong, sent on an otherwise perfect request.
  // --- The cap goes through the builder's own option, so the body is still the
  // --- mapper's - that field is the only thing that differs.
  cases.push({
    id: 'Q2-max-tokens-zero',
    question: '2',
    changed: 'maxTokens=0 passed to the mapper (max_tokens:0); nothing else differs',
    body: buildMinimaxRequest(requestFor(MODEL_LIVE, 0)),
  })
  cases.push({
    id: 'Q2-max-tokens-absurd',
    question: '2',
    changed: 'maxTokens=999999999 passed to the mapper with a one-line prompt',
    body: buildMinimaxRequest(requestFor(MODEL_LIVE, 999_999_999)),
  })
  // The two shapes the mapper cannot build, on purpose: an empty object is what
  // a client that forgot every field sends, and malformed JSON answers the
  // separate question of whether the refusal is JSON at all.
  cases.push({
    id: 'Q2-empty-object',
    question: '2',
    changed: 'HAND-BUILT: the literal body {} - the mapper cannot produce this',
    rawBody: '{}',
  })
  cases.push({
    id: 'Q2-malformed-json',
    question: '2',
    changed: 'HAND-BUILT: the literal bytes {"model": - deliberately not valid JSON',
    rawBody: '{"model":',
  })
  // The second envelope this service is known to use, bought for free: a wrong
  // bearer is refused before any model work happens, and its body is the one
  // place a numeric `code` has actually been measured on this route.
  cases.push({
    id: 'Q2-wrong-bearer',
    question: '2',
    changed: 'HAND-BUILT header: authorization replaced with a literal non-token; body unchanged',
    body: buildMinimaxRequest(requestFor(MODEL_LIVE, 32)),
    headers: { ...modelRequestHeaders('probe-invalid-bearer-not-a-credential') },
  })

  // --- Q3: the output cap. Both requests are ACCEPTED-then-abandoned if the
  // --- service takes them; neither is allowed to run.
  for (const maxTokens of [128_000, 512_000]) {
    cases.push({
      id: 'Q3-max-tokens-' + maxTokens,
      question: '3',
      changed: 'maxTokens=' + maxTokens + ' on a one-line prompt; abandoned on first bytes if accepted',
      body: buildMinimaxRequest(requestFor(MODEL_LIVE, maxTokens)),
    })
  }

  return cases
}

test('minimax code refusal shapes and request ceilings', async () => {
  // The pool, not the bare store: the native MiniMax Code auth directory is
  // gone on this machine, and the plugin's own pool still holds the sessions.
  const pool = new MinimaxCodeAccountPool({ store: new MinimaxCodeCredentialStore() })
  let credentials: Awaited<ReturnType<typeof pool.getFreshCredential>>
  try {
    credentials = await pool.getFreshCredential(undefined, fetchFn)
  } catch (error) {
    // Reported rather than thrown: "no account" is one of the answers this
    // probe is allowed to return, and a stack trace would hide it.
    console.log('[probe] NO CREDENTIAL - every case below is unmeasurable: '
      + oneLine(error instanceof Error ? error.message : String(error), 300))
    return
  }
  const url = messagesUrl(credentials.region)
  const headers = modelRequestHeaders(credentials.accessToken)
  // Region is printed because a cn/global split changes every refusal shape;
  // the token, the account id and the address are not, and never reach a log.
  console.log('[probe] endpoint=' + url + ' region=' + credentials.region)

  for (const item of caseList()) {
    await runCase(item, url, headers)
    await new Promise((resolve) => setTimeout(resolve, BETWEEN_CASES_MS))
  }

  console.log('[probe] ===== summary =====')
  for (const row of observations) {
    console.log('[probe] ' + row.id + ' | http=' + row.http + ' | served=' + row.served
      + ' | codes=' + row.codes + ' | fields=' + row.fields + ' | verdict=' + row.verdict)
  }
}, 600_000)
