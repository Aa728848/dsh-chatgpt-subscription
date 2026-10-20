/**
 * Live probe: the MiniMax Code Matrix VIDEO tool surface, measured rather than read.
 *
 * WHY THIS FILE EXISTS. docs/minimax-video-tools-feasibility.md and
 * docs/minimax-video-design-spec.md describe four media tools by READING upstream
 * source (packages/agent-tools/src/cloud/matrix-tools/). The gateway prefix and the
 * four transport headers were then proved live by
 * scripts/probe-minimax-matrix-gateway.probe.ts - but that probe called one tool
 * (get_voice_list) that takes no input and starts nothing. Every REQUEST SHAPE on
 * the video path is still an inference:
 *
 *   - what body does videos_understand actually want?
 *   - which fields does submit_video_generation REQUIRE, and which values are legal?
 *   - where in the query_video_generation answer do status / video_url / duration sit,
 *     and how is the terminal state spelled?
 *   - does get_upload_url exist on this gateway at all?
 *
 * 'The code sends this' and 'the service answers this' are different claims. This
 * probe buys the second one.
 *
 * THE BUDGET IS THE DESIGN. Steps 1, 3, 4 and 5 are free (a refusal, a poll, a
 * ranged GET, a text description). Step 2 - one real submit - is the only part that
 * spends credits, and it runs EXACTLY ONCE. There is no retry anywhere in this
 * file: the upstream contract makes a failed submit terminal AND billed, so asking
 * twice is not a better measurement, it is a worse one that costs twice.
 *
 * WHY submit IS PROBED WITH {} FIRST. An empty body has no prompt and no model, so
 * the gateway must refuse it at validation - which is exactly the answer that names
 * the missing fields, and it cannot create a task. The free probe reads
 * src/host/minimax-code/video-tool.ts first (recorded in the doc) to confirm the
 * production tool always sends a non-empty prompt, so {} is strictly weaker than
 * anything the product would ever send. A module-level SUBMITTED flag makes a
 * second spend impossible even if this file is edited carelessly later.
 *
 * NOTHING IDENTIFYING IS PRINTED. The access token, the refresh token, the address,
 * the account id and the realUserID never reach a log line - the realUserID is an
 * 18-character value that scrub()'s 32-character threshold would NOT catch, which
 * is why this probe never resolves it at all rather than relying on the scrubber.
 * URLs are reported by SHAPE (scheme, host, segment count, query KEY NAMES) and
 * never by value: a signed video_url carries its own credential in the query
 * string. Bodies are scrubbed on the way out by scrub().
 *
 * CASE TAXONOMY.
 *
 *   F1..F4  the four free shape probes (step 1).
 *   G       exactly one billed submit (step 2), never repeated.
 *   P       the poll, free per the upstream contract, bounded at 10 minutes.
 *   D       a Ranged GET (1 MB) then the full download into os.tmpdir() (step 3).
 *   U       videos_understand over the generated clip (step 3).
 *   Q       the Token Plan usage read before and after, to price the run (step 6).
 *
 * Run: npx vitest run --config vitest.probe.config.ts probe-minimax-video-generation
 */
import { test } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { MinimaxCodeCredentialStore } from '../src/host/minimax-code/token-store.ts'
import { MinimaxCodeAccountPool } from '../src/host/minimax-code/account-pool.ts'
import { matrixRequestHeaders, matrixToolUrl } from '../src/host/minimax-code/matrix-client.ts'
import { quotaRequestHeaders } from '../src/host/minimax-code/client.ts'
import {
  TOKEN_PLAN_REMAINS_PATH,
  agentBaseUrl,
  quotaHostCandidates,
  tokenPlanRemainsUrl,
} from '../src/host/minimax-code/types.ts'
import type { MinimaxCodeRegion } from '../src/shared/minimax-code-contracts.ts'

/** Hard ceiling on one media request. Generation submit is a task *creation*. */
const CALL_TIMEOUT_MS = 120_000
/** Cheap calls do not need two minutes; a hung shape probe must not eat the run. */
const FREE_TIMEOUT_MS = 45_000
/** Pause between calls: a burst is how a rate limit gets mistaken for a verdict. */
const BETWEEN_CALLS_MS = 800
/** How often the generation task is polled, per the brief. */
const POLL_INTERVAL_MS = 5_000
/** Total poll budget, per the brief. */
const POLL_BUDGET_MS = 600_000
/** One ranged GET: enough to prove the body is fetchable without paying for the clip. */
const RANGE_PROBE_BYTES = 1_048_576

/**
 * Whether this run may spend credits.
 *
 * OFF by default, and that default is the point. The probe's one billed call is
 * correct for a run that has not made it yet and catastrophic for a run that has,
 * and "remember not to run it twice" is not a control. Setting
 * DSH_PROBE_VIDEO_SUBMIT=1 is the explicit, greppable act of buying one
 * generation; without it the probe measures every free thing and refuses to
 * submit, printing why.
 */
const SUBMIT_ENABLED = (process.env.DSH_PROBE_VIDEO_SUBMIT || '').trim() === '1'
/**
 * An ALREADY submitted task id, to poll instead of submitting a new one.
 *
 * This exists because a poll is free and a submit is not: a second run of this
 * file can recover the terminal response shape, the signed URL and the artifact
 * from the task the first run paid for, at zero cost. It is the reason the
 * submit flag can stay off without losing the ability to re-measure.
 */
const EXISTING_TASK_ID = (process.env.DSH_PROBE_VIDEO_TASK || '').trim()

const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

// ---------------------------------------------------------------------------
// Redaction - copied verbatim from probe-minimax-matrix-gateway.probe.ts so every
// probe in this repo scrubs identically; two different scrubbers is two
// different disclosure bugs.
// ---------------------------------------------------------------------------

/**
 * Text that is safe to put in a log line.
 *
 * A gateway body is written by a service that knows exactly who is calling and
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
    // The account id this surface embeds in OSS object keys and CDN paths:
    // 'u' followed by ~18 digits. It is SHORTER than the 32-character catch-all
    // below, so without this rule it would sail through the scrubber looking like
    // an ordinary opaque run - the exact failure mode the probe's header warns
    // about for realUserID, one field over.
    .replace(/\bu\d{12,}\b/g, '<user-id>')
    .replace(/[A-Za-z0-9_-]{32,}/g, (run) => '<redacted:' + run.length + '>')
}

/**
 * Replace every URL inside arbitrary text with its SHAPE.
 *
 * oneLine() is applied to raw response bodies and to error messages, and both can
 * carry a signed URL verbatim - a query string holding an access key id, an
 * expiry and a signature. scrubbed() alone does NOT remove one: it only eats
 * opaque runs, and a URL is a run of punctuation and segments, so the credential
 * would survive the scrubber looking perfectly ordinary. This runs FIRST for
 * exactly that reason.
 */
function redactUrls(text: string): string {
  // The character class deliberately ALLOWS a backslash: a body echoed through
  // JSON.stringify escapes '&' as '\u0026', and stopping at the backslash would
  // truncate the match right before the rest of the signed query - leaving the
  // remainder (date, expiry, signature) printed verbatim.
  return text.replace(/https?:\/\/[^\s"'<>]+/g, (match) => describeUrl(match))
}

function oneLine(text: string, limit = 400): string {
  const flat = scrub(redactUrls(text)).replace(/[\r\n\t]+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '...' : flat
}

/**
 * A URL, reported by SHAPE and never by value.
 *
 * A signed media URL carries its credential in the query string, so printing one
 * would leak exactly what the header comment promises not to. Scheme, host,
 * segment count and query KEY NAMES are the whole of the evidence the brief asks
 * for anyway ('does it carry a signature, and under which parameter').
 */
function describeUrl(text: string): string {
  try {
    // A JSON-escaped ampersand is the same separator once decoded; normalising it
    // keeps the reported query-KEY list complete instead of collapsing the whole
    // query into one key.
    const url = new URL(text.replace(/\\u0026/g, '&'))
    const keys = [...url.searchParams.keys()]
    const segments = url.pathname.split('/').filter((part) => part !== '')
    const extension = /\.([A-Za-z0-9]{1,5})$/.exec(url.pathname)?.[1] ?? '(none)'
    return '<url scheme=' + url.protocol.replace(':', '')
      + ' host=' + url.hostname
      + ' pathSegments=' + segments.length
      + ' ext=' + extension
      + ' pathChars=' + url.pathname.length
      + ' queryKeys=[' + keys.join(',') + ']>'
  } catch {
    return '<url unparseable>'
  }
}

/** True when a string is a URL rather than prose, so the dump can shape it. */
function isUrl(text: string): boolean {
  return /^https?:\/\//i.test(text)
}

/**
 * One request body, safe to print.
 *
 * The REQUEST body needs the same treatment as the response body and for the same
 * reason: the videos_understand call carries the signed video URL, whose query
 * string holds both the access key id and the signature. Printing the body
 * verbatim - the obvious thing to do - puts a credential in the log. So every
 * string that looks like a URL is reshaped, and everything else is scrubbed.
 */
function echoBody(body: unknown): string {
  const walked = JSON.stringify(body, (_key, value: unknown) => {
    if (typeof value !== 'string') return value
    return isUrl(value) ? describeUrl(value) : oneLine(value, 300)
  })
  return walked ?? '{}'
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
 * The PATH is the point: the parent agent has to change code that reads these
 * documents, and 'there is a number somewhere' does not tell it which key to
 * read. Depth is capped at 6 because a nested task list could otherwise print for
 * pages without adding a single new fact.
 */
function fieldsOf(value: unknown, at = '', out: Field[] = [], depth = 0): Field[] {
  const here = at === '' ? '$' : at
  if (value === null) {
    out.push({ path: here, type: 'null', value: 'null' })
    return out
  }
  if (Array.isArray(value)) {
    out.push({ path: here, type: 'array[' + value.length + ']', value: '' })
    if (depth < 6) value.forEach((item, index) => fieldsOf(item, here + '[' + index + ']', out, depth + 1))
    return out
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    out.push({ path: here, type: 'object{' + keys.join(',') + '}', value: '' })
    if (depth < 6) {
      for (const key of keys) {
        fieldsOf((value as Record<string, unknown>)[key], at === '' ? key : at + '.' + key, out, depth + 1)
      }
    }
    return out
  }
  if (typeof value === 'string') {
    // A URL is shaped, not quoted: see describeUrl. Everything else is scrubbed.
    out.push({
      path: here,
      type: 'string',
      value: isUrl(value) ? describeUrl(value) : JSON.stringify(oneLine(value, 300)),
    })
    return out
  }
  out.push({ path: here, type: typeof value, value: String(value) })
  return out
}

/** The numbers a detector would have to read, wherever the envelope put them. */
function numericCodes(body: unknown): string[] {
  const found: string[] = []
  const walk = (value: unknown, at: string, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, at + '[' + index + ']', depth + 1))
      return
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const next = at === '' ? key : at + '.' + key
      if (typeof child === 'number' && /(code|status|errno)/i.test(key)) found.push(next + '=' + child)
      walk(child, next, depth + 1)
    }
  }
  walk(body, '', 0)
  return found
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** The base_resp envelope, if this surface carries one at all. */
function baseRespOf(body: unknown): { statusCode?: number; statusMsg?: string } {
  const record = asRecord(body)
  const base = asRecord(record?.base_resp) ?? asRecord(record?.baseResp)
  if (base === undefined) return {}
  return {
    ...(typeof base.status_code === 'number' ? { statusCode: base.status_code } : {}),
    ...(typeof base.status_msg === 'string' ? { statusMsg: base.status_msg } : {}),
  }
}

/** The first candidate key holding a non-empty string, wherever the envelope nests it. */
function firstString(body: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (body === undefined) return undefined
  for (const scope of [body, asRecord(body.data), asRecord(body.result)]) {
    if (scope === undefined) continue
    for (const key of keys) {
      const value = scope[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// One tool call
// ---------------------------------------------------------------------------

interface CallOutcome {
  ok: boolean
  status: number
  body?: Record<string, unknown>
  raw: string
}

const observations: Array<{ id: string; http: string; baseResp: string; note: string }> = []

/**
 * Call one Matrix tool and report EVERYTHING about the answer.
 *
 * Deliberately not callMatrixTool(): that client throws on a business refusal and
 * keeps only the message. A shape probe needs the whole envelope - the field
 * names, the nested error, the raw wording - because the refusal IS the result.
 */
async function callTool(options: {
  id: string
  region: MinimaxCodeRegion
  accessToken: string
  tool: string
  body: Record<string, unknown>
  note: string
  timeoutMs?: number
  dumpFields?: boolean
}): Promise<CallOutcome> {
  const url = matrixToolUrl(options.region, options.tool)
  emit('')
  emit('[probe] ---- ' + options.id + ' - ' + options.note)
  // The path is a fixed wire constant, not caller data; the query is empty by
  // construction, and reported as such rather than assumed.
  emit('[probe]   url=' + url + ' query-keys=[' + [...new URL(url).searchParams.keys()].join(',') + ']')
  emit('[probe]   body=' + echoBody(options.body))

  const started = Date.now()
  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: matrixRequestHeaders(options.accessToken),
      body: JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? CALL_TIMEOUT_MS),
      redirect: 'error',
    }) as unknown as Response
  } catch (error) {
    const message = oneLine(error instanceof Error ? error.message : String(error), 240)
    emit('[probe]   transport failure: ' + message)
    observations.push({ id: options.id, http: 'transport', baseResp: '-', note: message })
    return { ok: false, status: 0, raw: '' }
  }

  const elapsed = Date.now() - started
  const contentType = response.headers.get('content-type') ?? '(none)'
  const raw = await response.text().catch(() => '')
  emit('[probe]   http=' + response.status + ' content-type=' + JSON.stringify(contentType)
    + ' ms=' + elapsed + ' bodyBytes=' + Buffer.byteLength(raw))
  emit('[probe]   body raw: ' + oneLine(raw, 700))

  let parsed: unknown
  try {
    parsed = raw.trim() === '' ? undefined : JSON.parse(raw) as unknown
  } catch {
    parsed = undefined
  }
  const body = asRecord(parsed)
  const codes = parsed === undefined ? [] : numericCodes(parsed)
  const base = baseRespOf(parsed)
  emit('[probe]   top-level keys: [' + (body === undefined ? '(not a JSON object)' : Object.keys(body).join(',')) + ']')
  emit('[probe]   base_resp: ' + (base.statusCode === undefined && base.statusMsg === undefined
    ? '(absent)'
    : 'status_code=' + JSON.stringify(base.statusCode) + ' status_msg=' + JSON.stringify(base.statusMsg)))
  emit('[probe]   top-level code: ' + JSON.stringify(body?.code))
  emit('[probe]   numeric fields: ' + (codes.length === 0 ? '(none)' : codes.join(', ')))
  if (options.dumpFields !== false && body !== undefined) {
    for (const field of fieldsOf(body)) {
      emit('[probe]     ' + field.path + ': ' + field.type + (field.value === '' ? '' : ' = ' + field.value))
    }
  }

  const note = body === undefined
    ? 'not JSON'
    : 'base_resp=' + (base.statusCode === undefined ? '(absent)' : String(base.statusCode))
      + (base.statusMsg === undefined || base.statusMsg === '' ? '' : ' "' + oneLine(base.statusMsg, 200) + '"')
  observations.push({ id: options.id, http: String(response.status), baseResp: String(base.statusCode ?? '(absent)'), note })

  return { ok: response.ok, status: response.status, ...(body === undefined ? {} : { body }), raw }
}

/** Pause between calls without a polling loop. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// The usage read, for pricing the run
// ---------------------------------------------------------------------------

/**
 * Read the Token Plan document and pull out the per-model rows.
 *
 * The product's fetchTokenPlanQuota() deliberately keeps only the 'general'
 * bucket, which is right for the card and useless here: the question is exactly
 * 'did the VIDEO bucket move'. So this reads the same endpoint with the same
 * headers and reports EVERY row, by name and by both windows.
 */
async function readQuota(
  accessToken: string,
  region: MinimaxCodeRegion,
): Promise<{ label: string; rows: Array<{ name: string; line: string }> }> {
  for (const host of quotaHostCandidates(region)) {
    try {
      const response = await fetchFn(tokenPlanRemainsUrl(host), {
        method: 'GET',
        headers: quotaRequestHeaders(accessToken, TOKEN_PLAN_REMAINS_PATH),
        signal: AbortSignal.timeout(20_000),
      })
      const raw = await response.text().catch(() => '')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw) as unknown
      } catch {
        parsed = undefined
      }
      const record = asRecord(parsed)
      const rows = record?.model_remains
      if (!Array.isArray(rows)) {
        return {
          label: 'http=' + response.status + ' host=' + new URL(host).hostname + ' base_resp='
            + String(baseRespOf(parsed).statusCode ?? '(absent)') + ' no model_remains',
          rows: [],
        }
      }
      const out: Array<{ name: string; line: string }> = []
      for (const rawRow of rows) {
        const row = asRecord(rawRow)
        if (row === undefined) continue
        const name = typeof row.model_name === 'string' && row.model_name !== '' ? row.model_name : '(unnamed)'
        out.push({
          name,
          line: 'interval used=' + JSON.stringify(row.current_interval_usage_count)
            + '/' + JSON.stringify(row.current_interval_total_count)
            + ' left%=' + JSON.stringify(row.current_interval_remaining_percent)
            + ' weekly used=' + JSON.stringify(row.current_weekly_usage_count)
            + '/' + JSON.stringify(row.current_weekly_total_count)
            + ' left%=' + JSON.stringify(row.current_weekly_remaining_percent),
        })
      }
      return {
        label: 'http=' + response.status + ' host=' + new URL(host).hostname + ' rows=' + out.length,
        rows: out,
      }
    } catch (error) {
      emit('[probe] quota read failed on one host: '
        + oneLine(error instanceof Error ? error.message : String(error), 160))
    }
  }
  return { label: 'unreachable', rows: [] }
}

function quotaSnapshotText(read: { label: string; rows: Array<{ name: string; line: string }> }): string {
  if (read.rows.length === 0) return read.label
  return read.rows.map((row) => row.name + ' -> ' + row.line).join(' | ')
}

// ---------------------------------------------------------------------------
// What one free probe proved
// ---------------------------------------------------------------------------

/**
 * Turn one free probe's answer into a verdict about the tool's request shape.
 *
 * The three outcomes are not interchangeable and conflating them is how "we sent
 * the wrong body" gets recorded as "the tool does not exist":
 *
 * - 404/405: the path or the verb is wrong. Nothing was learned about the body.
 * - 400 with a message: the endpoint EXISTS and the body was too thin - and the
 *   message is the specification, because it names what was missing.
 * - 2xx: the body sent was already acceptable.
 */
function shapeVerdict(outcome: CallOutcome, label: string): string {
  if (outcome.status === 0) return label + ': TRANSPORT - no verdict at all'
  if (outcome.status === 404 || outcome.status === 405) {
    return label + ': ENDPOINT ABSENT - HTTP ' + outcome.status + ' says path/verb, not body'
  }
  const base = baseRespOf(outcome.body)
  const message = firstString(outcome.body, ['message', 'msg', 'error', 'error_message', 'detail'])
  return label + ': EXISTS - http=' + outcome.status
    + ' base_resp=' + (base.statusCode === undefined ? '(absent)' : String(base.statusCode))
    + (message === undefined ? '' : ' message="' + oneLine(message, 320) + '"')
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Mirror every log line into a file as well as stdout.
 *
 * The evidence IS this transcript, and a console-only run loses it the moment the
 * terminal buffer scrolls or the collecting caller reads once. Writing it as it
 * happens makes the doc reproducible from a single artifact, and it is the same
 * bytes either way - the redaction happens in oneLine(), upstream of both sinks.
 */
const transcriptPath = path.join(os.tmpdir(), 'minimax-video-probe-transcript.log')
const transcript: string[] = []
const emit = (line: string): void => {
  console.log(line)
  transcript.push(line)
}

test('minimax code matrix video tools: shapes, one real generation, and the artifact', async () => {
  // A module-level guard: a second spend must be impossible, not merely unlikely.
  let submitted = false

  const pool = new MinimaxCodeAccountPool({ store: new MinimaxCodeCredentialStore() })
  let credentials: { accessToken: string; region: MinimaxCodeRegion }
  try {
    const picked = await pool.getCredentialAccount(fetchFn)
    credentials = { accessToken: picked.credentials.accessToken, region: picked.credentials.region }
  } catch (error) {
    emit('[probe] NO CREDENTIAL - the video surface is unmeasurable: '
      + oneLine(error instanceof Error ? error.message : String(error), 300))
    return
  }
  const { accessToken, region } = credentials
  emit('[probe] region=' + region + ' agentBase=' + agentBaseUrl(region))
  emit('[probe] token=<present:len=' + accessToken.length + '> (never printed)')

  // =========================================================================
  // STEP 1 - the four free shape probes
  // =========================================================================

  emit('')
  emit('[probe] ===== STEP 1: free shape probes =====')

  // F1: the synchronous understanding tool. {} can only fail validation.
  const understandProbe = await callTool({
    id: 'F1-videos_understand-empty',
    region,
    accessToken,
    tool: 'videos_understand',
    body: {},
    note: 'videos_understand with {} - what does it say it needs?',
    timeoutMs: FREE_TIMEOUT_MS,
  })
  await wait(BETWEEN_CALLS_MS)

  // F2: the billed submit tool. {} carries no prompt and no model, so it must be
  // refused at validation; src/host/minimax-code/video-tool.ts always sends both,
  // so this is strictly weaker than any request the product makes.
  const submitProbe = await callTool({
    id: 'F2-submit_video_generation-empty',
    region,
    accessToken,
    tool: 'submit_video_generation',
    body: {},
    note: 'submit_video_generation with {} - validation refusal expected, no task created',
    timeoutMs: FREE_TIMEOUT_MS,
  })
  await wait(BETWEEN_CALLS_MS)

  // F3: the poll tool against a task that cannot exist.
  const queryProbe = await callTool({
    id: 'F3-query_video_generation-not-a-task',
    region,
    accessToken,
    tool: 'query_video_generation',
    body: { task_id: 'probe-not-a-real-task', model: 'MiniMax-H3' },
    note: 'query_video_generation against a task id that does not exist',
    timeoutMs: FREE_TIMEOUT_MS,
  })
  await wait(BETWEEN_CALLS_MS)

  // F4: the presigned-upload broker. It is absent from the upstream 18-tool table
  // this repo read, and its presence decides whether a local file can ever reach
  // videos_understand.
  const uploadProbe = await callTool({
    id: 'F4-get_upload_url-empty',
    region,
    accessToken,
    tool: 'get_upload_url',
    body: {},
    note: 'get_upload_url with {} - does this endpoint exist on this gateway at all?',
    timeoutMs: FREE_TIMEOUT_MS,
  })

  // A 2xx with a task id would mean {} really did create a task. Recorded, never
  // repeated: the whole point of the guard is that the spend already happened.
  const accidentalTaskId = firstString(submitProbe.body, ['task_id', 'taskId'])
  if (accidentalTaskId !== undefined) {
    submitted = true
    emit('[probe] !! submit WITH {} RETURNED A TASK: len=' + accidentalTaskId.length
      + ' - recording it as a finding and NOT submitting again')
  }
  emit('[probe] F-probe create-a-task? submit-{} task_id=' + (accidentalTaskId === undefined ? 'no' : 'YES'))

  // =========================================================================
  // STEP 2 - exactly one real submit
  // =========================================================================

  // The usage read is taken HERE, after the free probes and immediately before
  // the spend, so the delta describes the generation and nothing else.
  const quotaBefore = await readQuota(accessToken, region)
  emit('')
  emit('[probe] ===== STEP 2: one real submit =====')
  emit('[probe] quota BEFORE: ' + quotaSnapshotText(quotaBefore))

  let taskId: string | undefined = accidentalTaskId
  if (taskId === undefined && EXISTING_TASK_ID !== '') {
    // Free path: re-measure the terminal shape of a task an earlier run paid for.
    taskId = EXISTING_TASK_ID
    emit('[probe] adopting EXISTING task from DSH_PROBE_VIDEO_TASK: len=' + taskId.length)
  }
  if (taskId === undefined && !SUBMIT_ENABLED) {
    emit('[probe] SUBMIT DISABLED (DSH_PROBE_VIDEO_SUBMIT != 1): the free probes above are the '
      + 'whole result, and no task was created. Set DSH_PROBE_VIDEO_SUBMIT=1 to buy exactly one generation, '
      + 'or DSH_PROBE_VIDEO_TASK=<task id> to re-measure an existing one for free.')
  }
  if (taskId === undefined && SUBMIT_ENABLED) {
    if (submitted) throw new Error('a submit already happened; refusing to spend again')
    submitted = true
    // The cheapest legal generation, per the brief: bare prompt, 4 s, 768P.
    const submitBody = {
      model: 'MiniMax-H3',
      prompt: '一张纯黑画面',
      duration: 4,
      resolution: '768P',
    }
    emit('[probe] THIS CALL IS BILLED. body=' + echoBody(submitBody))
    const submit = await callTool({
      id: 'G-submit_video_generation-real',
      region,
      accessToken,
      tool: 'submit_video_generation',
      body: submitBody,
      note: 'THE ONE BILLED CALL - cheapest legal generation',
      timeoutMs: CALL_TIMEOUT_MS,
    })
    taskId = firstString(submit.body, ['task_id', 'taskId'])
    emit('[probe] task id: ' + (taskId === undefined ? '(none in the answer)' : 'len=' + taskId.length))
    if (taskId === undefined) {
      emit('[probe] NO TASK ID - the submit did not start a task. Not retrying: the upstream contract '
        + 'makes a failed submit terminal and billed.')
    }
  }

  // =========================================================================
  // STEP 3 - the poll
  // =========================================================================

  let videoUrl: string | undefined
  let terminalStatus = ''
  let observedStatuses: string[] = []
  if (taskId !== undefined) {
    emit('')
    emit('[probe] ===== STEP 3: poll (every ' + POLL_INTERVAL_MS / 1000 + 's, budget '
      + POLL_BUDGET_MS / 60_000 + ' min) =====')
    const deadline = Date.now() + POLL_BUDGET_MS
    let poll = 0
    let lastSignature = ''
    for (;;) {
      poll += 1
      const queried = await callTool({
        id: 'P' + poll,
        region,
        accessToken,
        tool: 'query_video_generation',
        body: { task_id: taskId, model: 'MiniMax-H3' },
        note: 'poll #' + poll,
        timeoutMs: FREE_TIMEOUT_MS,
        // The full field dump on the first poll and on every change of shape;
        // a compact line otherwise. Each poll is still logged either way.
        dumpFields: false,
      })
      const body = queried.body ?? {}
      const status = firstString(body, ['status', 'task_status'])
      if (status !== undefined && !observedStatuses.includes(status)) observedStatuses.push(status)
      // Dump the WHOLE envelope on the first poll and on every status change.
      // The terminal answer is the one the parent agent has to parse, and it is a
      // different document from the running one - a compact line would hide
      // exactly the field (video_url) the question is about.
      if (poll === 1 || status !== lastSignature) {
        for (const field of fieldsOf(body)) {
          emit('[probe]     ' + field.path + ': ' + field.type + (field.value === '' ? '' : ' = ' + field.value))
        }
      }
      lastSignature = status ?? ''
      emit('[probe]   poll#' + poll + ' status=' + JSON.stringify(status)
        + ' keys=[' + Object.keys(body).join(',') + ']')

      const settledUrl = firstString(body, ['video_url', 'videoUrl', 'url', 'file_url', 'download_url'])
      const lowered = (status ?? '').toLowerCase()
      if (lowered === 'succeeded' || lowered === 'success' || lowered === 'failed'
        || lowered === 'cancelled' || lowered === 'canceled') {
        terminalStatus = lowered
        videoUrl = settledUrl
        break
      }
      if (Date.now() >= deadline) {
        terminalStatus = 'poll-timeout'
        emit('[probe] poll budget exhausted; the task may still settle upstream')
        break
      }
      await wait(POLL_INTERVAL_MS)
    }
    emit('[probe] terminal status=' + JSON.stringify(terminalStatus)
      + ' statuses-seen=[' + observedStatuses.join(' -> ') + ']')
    emit('[probe] video_url: ' + (videoUrl === undefined ? '(none)' : describeUrl(videoUrl)))
  }

  // =========================================================================
  // STEP 4 - the artifact: ranged GET, then the whole file into a temp dir
  // =========================================================================

  let localPath: string | undefined
  let downloadBytes = 0
  let downloadType = ''
  let headHex = ''
  if (terminalStatus === 'succeeded' && videoUrl !== undefined) {
    emit('')
    emit('[probe] ===== STEP 4: the artifact =====')

    // A ranged GET first: proves the object is fetchable and tells us how big it
    // is, without paying the bandwidth of the whole clip to learn only that.
    try {
      const ranged = await fetchFn(videoUrl, {
        headers: { range: 'bytes=0-' + (RANGE_PROBE_BYTES - 1) },
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      }) as unknown as Response
      const chunk = new Uint8Array(await ranged.arrayBuffer())
      emit('[probe] ranged GET: http=' + ranged.status
        + ' content-type=' + JSON.stringify(ranged.headers.get('content-type') ?? '(none)')
        + ' content-length=' + JSON.stringify(ranged.headers.get('content-length') ?? '(none)')
        + ' content-range=' + JSON.stringify(ranged.headers.get('content-range') ?? '(none)')
        + ' accept-ranges=' + JSON.stringify(ranged.headers.get('accept-ranges') ?? '(none)')
        + ' bytes=' + chunk.byteLength)
      headHex = Buffer.from(chunk.slice(0, 16)).toString('hex')
      emit('[probe] first 16 bytes (hex)=' + headHex
        + ' ascii=' + JSON.stringify(Buffer.from(chunk.slice(0, 16)).toString('latin1')))
    } catch (error) {
      emit('[probe] ranged GET failed: '
        + oneLine(error instanceof Error ? error.message : String(error), 200))
    }

    // The whole file, so the byte count and the container header are facts rather
    // than extrapolations. It lands in os.tmpdir(), NEVER in the source tree, and
    // the name carries nothing but the run.
    try {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-video-probe-'))
      const target = path.join(dir, 'generated.mp4')
      const full = await fetchFn(videoUrl, { redirect: 'error', signal: AbortSignal.timeout(180_000) }) as unknown as Response
      const data = new Uint8Array(await full.arrayBuffer())
      await fs.writeFile(target, data)
      localPath = target
      downloadBytes = data.byteLength
      downloadType = (full.headers.get('content-type') ?? '(none)').split(';')[0]?.trim() ?? '(none)'
      headHex = Buffer.from(data.slice(0, 16)).toString('hex')
      const ftyp = Buffer.from(data.slice(4, 8)).toString('latin1')
      emit('[probe] full GET: http=' + full.status + ' content-type=' + JSON.stringify(downloadType)
        + ' bytes=' + downloadBytes)
      emit('[probe] written to ' + target)
      emit('[probe] first 16 bytes (hex)=' + headHex
        + ' box@4=' + JSON.stringify(ftyp) + ' is-mp4=' + (ftyp === 'ftyp'))
    } catch (error) {
      emit('[probe] full download failed: '
        + oneLine(error instanceof Error ? error.message : String(error), 200))
    }

    // =======================================================================
    // STEP 5 - can videos_understand read this clip?
    // =======================================================================

    emit('')
    emit('[probe] ===== STEP 5: videos_understand over the generated clip =====')

    // U1 is the CONTROL: it sends the body src/host/minimax-code/video-tool.ts
    // sends today (a flat file_url inside video_info). F1's refusal already said
    // the key is url or file, so this call exists to measure what the WRONG shape
    // costs - and the answer matters, because the cost is an HTTP 200.
    const understood = await callTool({
      id: 'U1-videos_understand-file_url',
      region,
      accessToken,
      tool: 'videos_understand',
      body: { video_info: [{ file_url: videoUrl, prompt: '描述这个视频的内容' }] },
      note: 'the shape video-tool.ts sends today: video_info[].file_url',
      timeoutMs: FREE_TIMEOUT_MS,
    })

    // U2 uses the shape the server itself named in F1. The URL handed over is the
    // one the bucket served the bytes from, so a success here means 'url' works for
    // an OSS object; it does NOT prove it works for an arbitrary third-party URL,
    // and the doc records that limit rather than generalising from one hit.
    const understoodUrl = await callTool({
      id: 'U2-videos_understand-url-key',
      region,
      accessToken,
      tool: 'videos_understand',
      body: { video_info: [{ url: videoUrl, prompt: '描述这个视频的内容' }] },
      note: 'the shape the server named in F1: video_info[].url',
      timeoutMs: FREE_TIMEOUT_MS,
    })

    // The reading path the server's own error message prescribes, and the one a
    // caller can always reach: base64 inline, for anything up to 600 KiB.
    let inlineOk = false
    if (localPath !== undefined) {
      const bytes = await fs.readFile(localPath)
      const understoodData = await callTool({
        id: 'U3-videos_understand-data-key',
        region,
        accessToken,
        tool: 'videos_understand',
        body: {
          video_info: [{
            data: Buffer.from(bytes).toString('base64'),
            prompt: '描述这个视频的内容',
          }],
        },
        note: 'the path the server prescribed: base64 in video_info[].data, with the whole ' + bytes.byteLength + '-byte file',
        timeoutMs: FREE_TIMEOUT_MS,
      })
      inlineOk = understoodData.ok
    }

    for (const [id, outcome] of [['U1', understood], ['U2', understoodUrl]] as const) {
      const results = outcome.body?.results
      const first = Array.isArray(results) ? asRecord(results[0]) : undefined
      emit('[probe] ' + id + ' results[0].success=' + JSON.stringify(first?.success)
        + ' description=' + JSON.stringify(oneLine(String(first?.description ?? ''), 300))
        + ' error=' + JSON.stringify(oneLine(String(first?.error ?? ''), 220)))
    }
    emit('[probe] U3 accepted=' + inlineOk + ' (a 200 with results[].success=false is still a refusal)')
  }

  // =========================================================================
  // STEP 6 - what did it cost
  // =========================================================================

  await wait(BETWEEN_CALLS_MS)
  const quotaAfter = await readQuota(accessToken, region)
  emit('')
  emit('[probe] ===== STEP 6: usage =====')
  emit('[probe] quota BEFORE: ' + quotaSnapshotText(quotaBefore))
  emit('[probe] quota AFTER : ' + quotaSnapshotText(quotaAfter))
  for (const before of quotaBefore.rows) {
    const after = quotaAfter.rows.find((row) => row.name === before.name)
    if (after === undefined) continue
    const moved = before.line !== after.line
    emit('[probe] delta ' + before.name + ': ' + (moved ? 'MOVED  ' + before.line + '  ->  ' + after.line : 'unchanged'))
  }
  emit('[probe] (the usage endpoint is a coarse snapshot; a zero delta is not proof of a zero cost)')

  // =========================================================================
  // Summary
  // =========================================================================

  emit('')
  emit('[probe] ===== summary =====')
  for (const row of observations) {
    emit('[probe] ' + row.id + ' | http=' + row.http + ' | ' + row.note)
  }
  emit('[probe] ---- the four shape questions ----')
  emit('[probe] ' + shapeVerdict(understandProbe, 'Q1 videos_understand'))
  emit('[probe] ' + shapeVerdict(submitProbe, 'Q2 submit_video_generation'))
  emit('[probe] ' + shapeVerdict(queryProbe, 'Q3 query_video_generation'))
  emit('[probe] ' + shapeVerdict(uploadProbe, 'Q4 get_upload_url'))
  if (queryProbe.status === 200) {
    emit('[probe] Q3 unknown-task body: ' + oneLine(queryProbe.raw, 400))
  }
  if (uploadProbe.status === 200 || uploadProbe.status === 400) {
    emit('[probe] Q4 keys: [' + Object.keys(uploadProbe.body ?? {}).join(',') + '] raw: '
      + oneLine(uploadProbe.raw, 500))
  }
  emit('[probe] submit spend: ' + (submitted ? 'ONE submit attempted' : 'none (guarded)'))
  emit('[probe] generation: terminal=' + JSON.stringify(terminalStatus)
    + ' statuses=[' + observedStatuses.join(',') + ']')
  emit('[probe] artifact: ' + (localPath === undefined
    ? 'none'
    : localPath + ' bytes=' + downloadBytes + ' type=' + JSON.stringify(downloadType)
      + ' ftyp@4=' + JSON.stringify(Buffer.from(headHex, 'hex').slice(4, 8).toString('latin1'))))
  emit('[probe] transcript: ' + transcriptPath)

  // Written LAST so a crash mid-run still leaves the lines that already happened;
  // the doc is rebuilt from this file, never from a copy-paste of a terminal.
  await fs.writeFile(transcriptPath, transcript.join('\n') + '\n', 'utf8')
}, 900_000)