/**
 * Live probe: the MiniMax Code Matrix VIDEO model rules, asked at ZERO cost.
 *
 * WHY THIS FILE EXISTS. docs/minimax-video-free-checks.md closed with three rows
 * still marked "not measured": the resolution set for MiniMax-Hailuo-2.3, the
 * resolution set and the duration floor for MiniMax-H3-Max, and the legal values of
 * ratio. All three are reachable at zero cost because of ONE measured property of
 * this gateway:
 *
 *   THE ARGUMENT VALIDATION RUNS BEFORE THE TASK IS CREATED, AND IT SHORT-CIRCUITS.
 *
 * Measured (docs/minimax-video-free-checks.md section 2): the order is
 * model -> duration -> resolution -> ratio, the body is refused at the FIRST illegal
 * argument, and the refusal carries NO task_id. So the recipe is: make every
 * argument BEFORE the one under test legal, make the one under test illegal, and the
 * service names its own legal values for it in the refusal sentence. That sentence
 * is the specification, and it costs nothing.
 *
 * THE FOUR QUESTIONS.
 *
 *   A  MiniMax-Hailuo-2.3 : which resolutions does it accept? duration 6 is one of
 *      its two legal values (measured: 6 or 10), and resolution "4K" is legal for
 *      nothing on this surface, so the refusal must be about resolution.
 *   B  MiniMax-H3-Max     : the same question (duration 5 is legal for it), plus a
 *      re-check of its duration floor: is 4 really below it?
 *   C  ratio              : its legal values, WITHOUT ever creating a task. This is
 *      the one case that needs a design rather than a guess - see the note below.
 *   D  20 MiB inline data : the earlier reading was a TIMEOUT, and a timeout is our
 *      own transport budget, not a refusal. Re-sent ONCE with 300 s instead of 120 s
 *      so that "the service refuses 20 MiB" and "we did not wait long enough" stop
 *      being the same observation.
 *
 * C IS THE ONLY CASE THAT COULD COST ANYTHING, AND IT IS SHAPED NOT TO.
 * A body that reaches ratio validation must already carry a legal model, a legal
 * duration and a legal resolution. If ratio then turned out not to be validated at
 * all, that body would create a task and be billed. The way out is to LEAVE OUT
 * prompt: a missing prompt is a refusal of its own, so the body cannot succeed - the
 * only open question is which refusal comes first.
 *
 *   - refusal about ratio   -> the legal ratio values are free evidence. Take them.
 *   - refusal about prompt  -> prompt is checked BEFORE ratio, so ratio is NOT
 *                              measurable at zero cost, and this file STOPS there.
 *                              It deliberately does NOT re-ask with a legal prompt:
 *                              that body is the one that would create a billed task.
 *
 * THE GUARD IS THE DESIGN, NOT A COMMENT. Every response is walked for a
 * task_id/taskId anywhere in the envelope (findKey below). The first one found sets
 * stopAll and EVERY later case is skipped - not just the failing one. A probe that
 * keeps asking after an accidental task would be billing in a loop; a probe that
 * stops and prints why leaves an honest, complete record of the one spend.
 *
 * NOTHING IDENTIFYING IS PRINTED. Token, address, account id and realUserID never
 * reach a log line; URLs are reported by SHAPE (scheme, host, segment count,
 * extension, query KEY NAMES) and never by value. The scrubber is the one from
 * probe-minimax-video-free-checks.probe.ts, unmodified: two different scrubbers in
 * one repo is two different disclosure bugs.
 *
 * Run: npx vitest run --config vitest.probe.config.ts probe-minimax-video-model-rules
 */
import { test } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { MinimaxCodeCredentialStore } from '../src/host/minimax-code/token-store.ts'
import { MinimaxCodeAccountPool } from '../src/host/minimax-code/account-pool.ts'
import { matrixRequestHeaders, matrixToolUrl } from '../src/host/minimax-code/matrix-client.ts'
import { agentBaseUrl } from '../src/host/minimax-code/types.ts'
import type { MinimaxCodeRegion } from '../src/shared/minimax-code-contracts.ts'

/** A validation refusal is immediate; a hung shape probe must not eat the run. */
const FREE_TIMEOUT_MS = 45_000
/** Pause between calls: a burst is how a rate limit gets mistaken for a verdict. */
const BETWEEN_CALLS_MS = 800
/**
 * Budget for the ONE 20 MiB understand call.
 *
 * The previous run gave the same payload 120 s and recorded a transport timeout,
 * which is a statement about that budget and not about the service: the same rung
 * once answered 200 at 84 s in another run. 300 s is the value under test - if the
 * service has a size bound it should still refuse fast, and if it merely needs time
 * then time is what this must not be short of.
 */
const INLINE_TIMEOUT_MS = 300_000
/** The one size this file re-asks about. */
const INLINE_BYTES_20MIB = 20 * 1024 * 1024

/** The model the real generation ran on; the control in cases A and B. */
const BASELINE_MODEL = 'MiniMax-H3'
/** Question A: its duration is a two-value set (6 or 10), measured, so 6 is legal. */
const HAILUO_MODEL = 'MiniMax-Hailuo-2.3'
/** Question B: its duration floor is documented as 5 and is re-checked here. */
const H3_MAX_MODEL = 'MiniMax-H3-Max'

/**
 * A resolution that is legal for NOTHING on this surface.
 *
 * Measured: MiniMax-H3 accepts 768P or 2K and refuses "4K" and "720p" with the same
 * sentence. Using it here means the resolution check must fire for any model, which
 * is exactly what makes the refusal readable as "your resolution is wrong" rather
 * than "your model is wrong".
 */
const ILLEGAL_RESOLUTION = '4K'
/** A ratio no one has measured. The value is irrelevant; that it is unknown is the point. */
const ILLEGAL_RATIO = '5:4'
/** A prompt, sent wherever a prompt is needed so its absence cannot mask the field under test. */
const PROMPT = '一张纯黑画面'

const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

// ---------------------------------------------------------------------------
// Redaction - copied verbatim from probe-minimax-video-free-checks.probe.ts so
// every probe in this repo scrubs identically; two different scrubbers is two
// different disclosure bugs.
// ---------------------------------------------------------------------------

/**
 * Text that is safe to put in a log line.
 *
 * A gateway body is written by a service that knows exactly who is calling and may
 * echo it back, so the scrubbing happens on the way OUT rather than being assumed
 * unnecessary. What is removed is only ever something that could name a person or a
 * session - an address, a UUID, a JWT, a long opaque run. Wording is kept, because
 * the wording is the entire evidence here.
 */
function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<address>')
    .replace(/eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){0,2}/g, '<token>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    // The account id this surface embeds in OSS object keys and CDN paths:
    // 'u' followed by ~18 digits. It is SHORTER than the 32-character catch-all
    // below, so without this rule it would sail through the scrubber looking like
    // an ordinary opaque run.
    .replace(/\bu\d{12,}\b/g, '<user-id>')
    .replace(/[A-Za-z0-9_-]{32,}/g, (run) => '<redacted:' + run.length + '>')
}

/**
 * Replace every URL inside arbitrary text with its SHAPE.
 *
 * oneLine() is applied to raw response bodies and to error messages, and both can
 * carry a signed URL verbatim - a query string holding an access key id, an expiry
 * and a signature. scrub() alone does NOT remove one: it only eats opaque runs, and
 * a URL is a run of punctuation and segments, so the credential would survive the
 * scrubber looking perfectly ordinary. This runs FIRST for exactly that reason.
 */
function redactUrls(text: string): string {
  // The character class deliberately ALLOWS a backslash: a body echoed through
  // JSON.stringify escapes '&' as '\u0026', and stopping at the backslash would
  // truncate the match right before the rest of the signed query.
  return text.replace(/https?:\/\/[^\s"'<>]+/g, (match) => describeUrl(match))
}

function oneLine(text: string, limit = 400): string {
  const flat = scrub(redactUrls(text)).replace(/[\r\n\t]+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '...' : flat
}

/** A URL, reported by SHAPE and never by value. */
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
 * A body is echoed on the way out for the same reason a response is scrubbed: the
 * understand body can carry a URL, and printing an arbitrary URL verbatim is the
 * disclosure this file's header promises not to make.
 */
function echoBody(body: unknown): string {
  const walked = JSON.stringify(body, (_key, value: unknown) => {
    if (typeof value !== 'string') return value
    return isUrl(value) ? describeUrl(value) : oneLine(value, 300)
  })
  return walked ?? '{}'
}

// ---------------------------------------------------------------------------
// Reading a body
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

interface Hit {
  path: string
  value: string
}

/**
 * Every place an envelope carries a key, by PATH.
 *
 * The task_id guard has to be exhaustive rather than convenient: the gateway has
 * been observed putting its payload at the TOP level, and observed nesting a second
 * status under base_resp, so "check body.task_id" is a check that can miss the one
 * shape that matters. This walks the whole document, arrays included.
 */
function findKey(value: unknown, wanted: string, at = '', out: Hit[] = [], depth = 0): Hit[] {
  if (depth > 8 || value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    value.forEach((item, index) => findKey(item, wanted, at + '[' + index + ']', out, depth + 1))
    return out
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = at === '' ? key : at + '.' + key
    if (key === wanted) out.push({ path: here, value: typeof child === 'string' ? child : String(child) })
    findKey(child, wanted, here, out, depth + 1)
  }
  return out
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

/**
 * The name of a thrown value, without assuming it is an Error.
 *
 * A DOMException is NOT an Error instance in Node, and AbortSignal.timeout() throws
 * exactly that. Reading '.name' through a type guard is what keeps "we ran out of
 * patience" (TimeoutError) distinguishable from "the socket died" (TypeError) in the
 * one place this file has to tell those two apart.
 */
function failureName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string') return name
  }
  return '(unnamed)'
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

// ---------------------------------------------------------------------------
// One call
// ---------------------------------------------------------------------------

interface CallOutcome {
  status: number
  body?: Record<string, unknown>
  raw: string
  /** The service's own sentence, when it supplied one. */
  message: string
  /** Paths where a task id was found; empty means no task was created. */
  taskIdPaths: string[]
  elapsedMs: number
  /** The DOMException/Error name when no response was produced; empty otherwise. */
  failure: string
}

const observations: Array<{ id: string; http: string; code: string; note: string }> = []

/** The log sink; assigned in the test so every line is also appended to the transcript. */
let emit: (line: string) => void = (line) => { console.log(line) }

/**
 * Call one Matrix tool and report EVERYTHING about the answer.
 *
 * Deliberately not callMatrixTool(): that client throws on a business refusal and
 * keeps only the message. This probe's entire evidence is the refusal TEXT - the
 * service naming its own legal values - so throwing it away would throw away the
 * result.
 */
async function callTool(options: {
  id: string
  region: MinimaxCodeRegion
  accessToken: string
  tool: string
  body: Record<string, unknown>
  note: string
  timeoutMs?: number
  /**
   * What to print in place of echoBody().
   *
   * A body carrying 20 MiB of base64 is not evidence, it is a wall: echoing it
   * verbatim would also defeat the point of scrubbing, since a decoder would print
   * megabytes of an input the reader already knows the size of.
   */
  displayBody?: string
}): Promise<CallOutcome> {
  const url = matrixToolUrl(options.region, options.tool)
  emit('')
  emit('[probe] ---- ' + options.id + ' - ' + options.note)
  // The path is a fixed wire constant, not caller data; the query is empty by
  // construction, and reported as such rather than assumed.
  emit('[probe]   url=' + url + ' query-keys=[' + [...new URL(url).searchParams.keys()].join(',') + ']')
  emit('[probe]   body=' + (options.displayBody ?? echoBody(options.body)))

  const started = Date.now()
  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: matrixRequestHeaders(options.accessToken),
      body: JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? FREE_TIMEOUT_MS),
      redirect: 'error',
    }) as unknown as Response
  } catch (error) {
    const name = failureName(error)
    const message = oneLine(failureMessage(error), 240)
    emit('[probe]   transport failure: name=' + name + ' ms=' + (Date.now() - started) + ' message=' + message)
    observations.push({ id: options.id, http: 'transport', code: '-', note: name + ': ' + message })
    return {
      status: 0,
      raw: '',
      message,
      taskIdPaths: [],
      elapsedMs: Date.now() - started,
      failure: name,
    }
  }

  const elapsed = Date.now() - started
  const raw = await response.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = raw.trim() === '' ? undefined : JSON.parse(raw) as unknown
  } catch {
    parsed = undefined
  }
  const body = asRecord(parsed)
  const base = baseRespOf(parsed)
  const message = firstString(body, ['message', 'msg', 'error', 'error_message', 'detail']) ?? ''
  const taskHits = findKey(parsed, 'task_id').concat(findKey(parsed, 'taskId'))

  emit('[probe]   http=' + response.status + ' content-type='
    + JSON.stringify(response.headers.get('content-type') ?? '(none)')
    + ' ms=' + elapsed + ' bodyBytes=' + Buffer.byteLength(raw))
  emit('[probe]   top-level keys: [' + (body === undefined ? '(not a JSON object)' : Object.keys(body).join(',')) + ']')
  emit('[probe]   top-level code: ' + JSON.stringify(body?.code)
    + ' base_resp: ' + (base.statusCode === undefined && base.statusMsg === undefined
      ? '(absent)'
      : 'status_code=' + JSON.stringify(base.statusCode) + ' status_msg=' + JSON.stringify(base.statusMsg)))
  emit('[probe]   body raw: ' + oneLine(raw, 900))
  emit('[probe]   TASK_ID CHECK: ' + (taskHits.length === 0
    ? 'absent - no task was created, nothing billed'
    : 'FOUND at ' + taskHits.map((hit) => hit.path + '(len=' + hit.value.length + ')').join(', ')))

  observations.push({
    id: options.id,
    http: String(response.status),
    code: String(body?.code ?? '(absent)'),
    note: oneLine(message === '' ? raw : message, 300),
  })

  return {
    status: response.status,
    ...(body === undefined ? {} : { body }),
    raw,
    message: message === '' ? oneLine(raw, 400) : message,
    taskIdPaths: taskHits.map((hit) => hit.path),
    elapsedMs: elapsed,
    failure: '',
  }
}

/** Pause between calls without a polling loop. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Reading a refusal
// ---------------------------------------------------------------------------

/**
 * Every token in a sentence that LOOKS like a resolution value.
 *
 * Printed as raw tokens rather than as a parsed "the legal set is X" for one reason:
 * the legal set is whatever the service says, and this file's job is to quote it,
 * not to re-derive it. The token list only makes the quote easier to scan for a
 * human; the verbatim sentence beside it is the evidence.
 *
 * The trailing word boundary is what keeps '600KiB' - which appears in the stock
 * media-source refusal - from being reported as a resolution of '600K'.
 */
function resolutionTokens(text: string): string[] {
  const out: string[] = []
  const pattern = /\b[0-9]{1,4}(?:P|K)\b/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (!out.includes(match[0])) out.push(match[0])
  }
  return out
}

/**
 * Which argument names the refusal talks about. Pure wording, printed beside the quote.
 *
 * Every pattern is WORD-BOUNDED, and that is not cosmetic. The stock closing sentence
 * of these refusals is "...for fast geneRATION", so a bare /ratio/ reports that a
 * refusal about RESOLUTION also mentions ratio - which is precisely the kind of
 * plausible-looking wrong answer this file exists to avoid. Measured consequence of
 * the unbounded version: A and B1 both printed 'names [model,resolution,ratio]'.
 */
function fieldMentions(message: string): string {
  const fields: Array<[string, RegExp]> = [
    ['model', /\bmodel\b/i],
    ['duration', /\bduration\b/i],
    ['resolution', /\bresolution\b/i],
    ['ratio', /\bratio\b|\baspect\b/i],
    ['prompt', /\bprompt\b/i],
  ]
  const named = fields.filter(([, pattern]) => pattern.test(message)).map(([name]) => name)
  return named.length === 0 ? '(none of the five argument names appears)' : '[' + named.join(',') + ']'
}

// ---------------------------------------------------------------------------
// The inline payload for D
// ---------------------------------------------------------------------------

/**
 * A synthetic MP4-shaped body of exactly size bytes.
 *
 * Deliberately SYNTHETIC: D asks whether the SERVICE refuses 20 MiB inline, not
 * whether it can describe a video, and a synthetic buffer is the only payload that
 * can be produced at an exact size on demand. Deliberately MP4-SHAPED, too - the
 * ftyp box at offset 4 - so a refusal cannot be explained away as "these bytes were
 * never a container in the first place" on the strength of the first twelve bytes.
 */
function syntheticMp4Body(size: number): Buffer {
  const buffer = Buffer.alloc(Math.max(size, 1))
  buffer.writeUInt32BE(0x18, 0)
  buffer.write('ftypisom', 4, 'latin1')
  buffer.fill(0x11, 12)
  return buffer
}

interface UnderstandAnswer {
  rawBytes: number
  encodedBytes: number
  http: number
  elapsedMs: number
  failure: string
  code: string
  baseStatus: string
  success?: boolean
  source: string
  description: string
  error: string
  taskIdPaths: string[]
}

/**
 * Classify one understand answer into the outcomes that are NOT the same thing.
 *
 * ORDER MATTERS. The stock media-source refusal - the one measured in the previous
 * run for public URLs - contains the substrings 'size_bytes' and '600KiB'. A naive
 * /exceed|size|limit/ test therefore reads that sentence as A SIZE BOUND, which is
 * the single most likely mistake this step can make. So the known generic sentence is
 * matched FIRST and labelled before any size vocabulary is consulted, and the
 * verbatim text is printed beside the label so the reader can disagree with the
 * classifier.
 */
function classifyUnderstand(answer: UnderstandAnswer): string {
  if (answer.http === 0) {
    if (answer.failure === 'TimeoutError' || answer.failure === 'AbortError') {
      return 'TIMEOUT - no answer within OUR budget; a budget is not a refusal'
    }
    return 'TRANSPORT - no answer at all (' + answer.failure + ')'
  }
  const text = (answer.error + ' ' + answer.description).toLowerCase()
  if (/could not be used as a media source/.test(text)) {
    return 'GENERIC - the stock media-source refusal; it says size_bytes/600KiB as ADVICE, not as a bound'
  }
  if (/exceed|too large|too big|payload|413|maximum|limit/.test(text)) {
    return 'SIZE - the service named a size bound'
  }
  if (/decod|invalid|unsupported|format|corrupt|not a (valid )?video/.test(text)) {
    return 'CONTENT - the bytes were refused as media'
  }
  if (answer.success === true) return 'ACCEPTED - success=true'
  return 'OTHER - read the wording'
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Mirror every log line into a file as well as stdout.
 *
 * The evidence IS this transcript, and a console-only run loses it the moment the
 * terminal buffer scrolls. The append is deliberately not awaited and not batched:
 * this run contains a 20 MiB upload with a five-minute budget in it, so being killed
 * mid-flight is a real possibility rather than a theoretical one. Losing the last
 * line is fine; losing every line before it is not.
 */
const transcriptPath = path.join(os.tmpdir(), 'minimax-video-model-rules-transcript.log')
const transcript: string[] = []
/**
 * Serialises the transcript appends.
 *
 * MEASURED DEFECT THIS FIXES: firing fs.appendFile() without waiting lets the writes
 * race, and a run whose lines are emitted in a tight loop then lands on disk out of
 * order - the first run of this file wrote its summary as C1, A1, B1, D1, B2 while
 * the console showed them in sequence. The transcript is the artifact the report
 * cites, so a file whose line order disagrees with the run is worse than no file.
 * Chaining each append onto the previous one keeps the ORDER while still writing as
 * the run proceeds, which is the property that matters if the run is killed.
 */
let appendChain: Promise<void> = Promise.resolve()

test('minimax code matrix video: model rules - Hailuo-2.3 resolution, H3-Max resolution + duration floor, ratio, 20 MiB inline', async () => {
  await fs.writeFile(transcriptPath, '', 'utf8').catch(() => undefined)
  const emitLine = (line: string): void => {
    console.log(line)
    transcript.push(line)
    appendChain = appendChain
      .then(() => fs.appendFile(transcriptPath, line + String.fromCharCode(10), 'utf8'))
      .catch(() => undefined)
  }
  emit = emitLine

  const pool = new MinimaxCodeAccountPool({ store: new MinimaxCodeCredentialStore() })
  let credentials: { accessToken: string; region: MinimaxCodeRegion }
  try {
    const picked = await pool.getCredentialAccount(fetchFn)
    credentials = { accessToken: picked.credentials.accessToken, region: picked.credentials.region }
  } catch (error) {
    emit('[probe] NO CREDENTIAL - the video surface is unmeasurable: '
      + oneLine(failureMessage(error), 300))
    return
  }
  const { accessToken, region } = credentials
  emit('[probe] region=' + region + ' agentBase=' + agentBaseUrl(region))
  emit('[probe] token=<present:len=' + accessToken.length + '> (never printed)')
  emit('[probe] COST MODEL: every submit below carries at least one value the service must reject at '
    + 'validation, and validation runs BEFORE a task is created. No generation is requested by this file.')

  /**
   * Set by the first response that carries a task id.
   *
   * Once it is non-null EVERY remaining case is skipped, not merely the current one:
   * the whole premise of the free measurement has been falsified, and continuing
   * would mean asking how far the falsification goes by spending more.
   */
  let stopAll: string | null = null
  const taskIdsSeen: string[] = []

  /** Run one case unless something already created a task. */
  const guard = (id: string): boolean => {
    if (stopAll === null) return true
    emit('')
    emit('[probe] ---- ' + id + ' SKIPPED - ' + stopAll)
    return false
  }

  /** Record a task id and halt everything. */
  const noteTask = (id: string, outcome: CallOutcome): void => {
    if (outcome.taskIdPaths.length === 0) return
    taskIdsSeen.push(id)
    stopAll = 'a task_id appeared in ' + id + ' (' + outcome.taskIdPaths.join(', ') + ')'
    emit('')
    emit('[probe] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
    emit('[probe] !! ' + stopAll)
    emit('[probe] !! THE VALIDATION DID NOT CATCH THIS BODY. A task exists and is billed.')
    emit('[probe] !! Every remaining case is now SKIPPED. Not retrying, not continuing.')
    emit('[probe] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
  }

  interface CaseAnswer {
    id: string
    question: string
    http: number
    code: string
    message: string
    failure: string
    elapsedMs: number
  }
  const answers: CaseAnswer[] = []

  /** One submit whose body is guaranteed to be refused, plus the bookkeeping. */
  const submitCase = async (options: {
    id: string
    question: string
    body: Record<string, unknown>
    note: string
  }): Promise<CaseAnswer | null> => {
    if (!guard(options.id)) return null
    const outcome = await callTool({
      id: options.id,
      region,
      accessToken,
      tool: 'submit_video_generation',
      body: options.body,
      note: options.note + ' - must be refused before a task exists',
    })
    noteTask(options.id, outcome)
    const answer: CaseAnswer = {
      id: options.id,
      question: options.question,
      http: outcome.status,
      code: String(outcome.body?.code ?? '(absent)'),
      message: outcome.message,
      failure: outcome.failure,
      elapsedMs: outcome.elapsedMs,
    }
    answers.push(answer)
    await wait(BETWEEN_CALLS_MS)
    return answer
  }

  // =========================================================================
  // STEP A - the resolution set of MiniMax-Hailuo-2.3
  // =========================================================================

  emit('')
  emit('[probe] ===== STEP A: which resolutions does ' + HAILUO_MODEL + ' accept? =====')
  emit('[probe] duration 6 is one of its two legal values (measured: 6 or 10), so the ONLY illegal '
    + 'argument in this body is the resolution. The refusal must therefore be about resolution, and '
    + 'it should name its legal set.')

  const caseA = await submitCase({
    id: 'A1-hailuo-resolution',
    question: 'legal resolution values for ' + HAILUO_MODEL,
    body: { model: HAILUO_MODEL, duration: 6, resolution: ILLEGAL_RESOLUTION, prompt: PROMPT },
    note: 'legal duration 6 + illegal resolution ' + ILLEGAL_RESOLUTION,
  })

  // =========================================================================
  // STEP B - MiniMax-H3-Max: its resolution set, and its duration floor again
  // =========================================================================

  emit('')
  emit('[probe] ===== STEP B: ' + H3_MAX_MODEL + ' - resolution set, and is 4 really below its floor? =====')
  emit('[probe] B1 keeps duration at the documented floor (5) and makes resolution illegal, so a '
    + 'refusal about resolution proves BOTH model and duration passed. B2 then asks the floor '
    + 'question directly with duration 4 and no resolution at all.')

  const caseB1 = await submitCase({
    id: 'B1-h3max-resolution',
    question: 'legal resolution values for ' + H3_MAX_MODEL,
    body: { model: H3_MAX_MODEL, duration: 5, resolution: ILLEGAL_RESOLUTION, prompt: PROMPT },
    note: 'legal duration 5 + illegal resolution ' + ILLEGAL_RESOLUTION,
  })
  const caseB2 = await submitCase({
    id: 'B2-h3max-duration-floor',
    question: 'is duration 4 below the floor for ' + H3_MAX_MODEL,
    body: { model: H3_MAX_MODEL, duration: 4, prompt: PROMPT },
    note: 'duration 4 on ' + H3_MAX_MODEL + ', no resolution - re-checks the floor of 5',
  })

  // =========================================================================
  // STEP C - ratio, asked without ever creating a task
  // =========================================================================

  emit('')
  emit('[probe] ===== STEP C: the legal values of ratio =====')
  emit('[probe] The validator is sequential and short-circuits, so ratio is reached only by a body '
    + 'whose model, duration and resolution are ALL legal. That body is one step away from creating '
    + 'a task. The way out: OMIT prompt. A missing prompt is a refusal of its own, so the body cannot '
    + 'succeed; the only unknown is which refusal comes first.')
  emit('[probe]   ratio-refusal   -> the legal ratio values are free evidence')
  emit('[probe]   prompt-refusal  -> prompt precedes ratio; ratio is NOT measurable at zero cost and '
    + 'this file STOPS. It does not re-ask with a legal prompt - that is the body that would bill.')

  const caseC = await submitCase({
    id: 'C1-ratio-without-prompt',
    question: 'legal ratio values for ' + BASELINE_MODEL,
    body: { model: BASELINE_MODEL, duration: 4, resolution: '768P', ratio: ILLEGAL_RATIO },
    note: 'legal model/duration/resolution + illegal ratio ' + ILLEGAL_RATIO
      + ', and NO prompt, so it cannot be accepted',
  })

  /** Does the C refusal talk about ratio, or about the missing prompt? */
  const ratioVerdict = (answer: CaseAnswer | null): string => {
    if (answer === null) return 'NOT ASKED - the run was halted or skipped before this case'
    if (answer.http === 0) {
      return 'INCONCLUSIVE - no answer (' + answer.failure + '); nothing was learned about ratio'
    }
    // Word-bounded for the same reason as fieldMentions(): "generation" contains
    // "ratio", and a false positive here would turn "prompt precedes ratio" into a
    // confident and completely wrong "ratio answered".
    const saysRatio = /\bratio\b|\baspect\b/i.test(answer.message)
    const saysPrompt = /\bprompt\b/i.test(answer.message)
    if (saysRatio && !saysPrompt) {
      return 'RATIO ANSWERED - the refusal is about ratio, so prompt is checked LATER than ratio. '
        + 'The sentence above is the legal set.'
    }
    if (saysPrompt && !saysRatio) {
      return 'PROMPT PRECEDES RATIO - the refusal is about the missing prompt, so ratio was never '
        + 'reached. Ratio is therefore NOT measurable at zero cost, and this file stops here.'
    }
    if (saysRatio && saysPrompt) {
      return 'AMBIGUOUS - the refusal names both ratio and prompt; read the sentence verbatim'
    }
    return 'OTHER - the refusal names neither ratio nor prompt; read the sentence verbatim'
  }

  // =========================================================================
  // STEP D - is 20 MiB inline actually refused, or was it only a timeout?
  // =========================================================================

  emit('')
  emit('[probe] ===== STEP D: 20 MiB inline data, ONE call, ' + (INLINE_TIMEOUT_MS / 1000) + ' s budget =====')
  emit('[probe] The previous run gave this exact size 120 s and recorded a transport timeout. That is '
    + 'a statement about OUR budget: the same rung once answered 200 at 84 s. So the question is '
    + 're-asked with ' + (INLINE_TIMEOUT_MS / 1000) + ' s, which separates three outcomes that were '
    + 'previously one: accepted / explicitly refused with a bound / still no answer. Understood calls '
    + 'create no task and are not billed; the answer is still checked for a task_id.')
  emit('[probe] The payload is SYNTHETIC (ftyp box + 0x11 fill). Its exact size is the measurement; '
    + 'its contents are not.')

  let caseD: UnderstandAnswer | null = null
  if (guard('D1-inline-20MiB')) {
    const raw = syntheticMp4Body(INLINE_BYTES_20MIB)
    const data = raw.toString('base64')
    const outcome = await callTool({
      id: 'D1-inline-20MiB',
      region,
      accessToken,
      tool: 'videos_understand',
      body: { video_info: [{ data, prompt: '描述这个视频' }] },
      note: 'inline data at ' + (INLINE_BYTES_20MIB / (1024 * 1024)).toFixed(0) + ' MiB, sent once, never retried',
      // A 28 MB base64 blob is not evidence; its size is.
      displayBody: '{"video_info":[{"data":"<base64 omitted: ' + data.length + ' chars>","prompt":"描述这个视频"}]}',
      timeoutMs: INLINE_TIMEOUT_MS,
    })
    noteTask('D1', outcome)
    const results = outcome.body?.results
    const first = Array.isArray(results) ? asRecord(results[0]) : undefined
    const answer: UnderstandAnswer = {
      rawBytes: raw.byteLength,
      encodedBytes: data.length,
      http: outcome.status,
      elapsedMs: outcome.elapsedMs,
      failure: outcome.failure,
      code: String(outcome.body?.code ?? '(absent)'),
      baseStatus: String(baseRespOf(outcome.body).statusCode ?? '(absent)'),
      ...(typeof first?.success === 'boolean' ? { success: first.success } : {}),
      source: typeof first?.source === 'string' ? first.source : '',
      description: typeof first?.description === 'string' ? first.description : '',
      error: typeof first?.error === 'string' ? first.error : '',
      // The task-id paths the guard already searched, carried onto the answer so
      // the guard's own evidence travels with the measurement it belongs to.
      taskIdPaths: outcome.taskIdPaths,
    }
    caseD = answer
    emit('[probe]   results[0].success=' + JSON.stringify(answer.success)
      + ' source=' + JSON.stringify(oneLine(answer.source, 120)))
    emit('[probe]   results[0].description=' + JSON.stringify(oneLine(answer.description, 400)))
    emit('[probe]   results[0].error=' + JSON.stringify(oneLine(answer.error, 600)))
  }

  /** The three readings of D, kept apart on purpose. */
  const inlineVerdict = (answer: UnderstandAnswer | null): string => {
    if (answer === null) return 'NOT ASKED - the run was halted or skipped before this case'
    if (answer.http === 0) {
      if (answer.failure === 'TimeoutError' || answer.failure === 'AbortError') {
        return 'STILL TIMED OUT - no answer within ' + (INLINE_TIMEOUT_MS / 1000) + ' s. '
          + 'That is NOT a refusal and NOT an acceptance; the size ceiling remains unmeasured.'
      }
      return 'TRANSPORT FAILURE - ' + answer.failure + ' after ' + answer.elapsedMs + ' ms'
    }
    if (answer.success === true) {
      return 'ACCEPTED - the service answered success=true after ' + answer.elapsedMs + ' ms. '
        + 'It RECEIVED ' + answer.rawBytes + ' raw bytes inline. '
        + 'Whether those bytes were decoded is a separate question this answer does not settle.'
    }
    const classification = classifyUnderstand(answer)
    if (classification.startsWith('SIZE')) {
      return 'REFUSED WITH A BOUND - ' + classification + '. The sentence above is the real limit.'
    }
    if (classification.startsWith('GENERIC')) {
      return 'REFUSED, BUT NOT FOR SIZE - ' + classification
        + '. This is not a byte ceiling; read the sentence above.'
    }
    return 'REFUSED WITHOUT A SIZE CLAIM - ' + classification
  }

  // =========================================================================
  // Summary
  // =========================================================================

  emit('')
  emit('[probe] ===== summary: every call, in order =====')
  for (const row of observations) {
    emit('[probe] ' + row.id + ' | http=' + row.http + ' | code=' + row.code + ' | ' + row.note)
  }

  emit('')
  emit('[probe] ===== summary: the four questions =====')
  emit('[probe] GUARD: tasks created by this run = ' + taskIdsSeen.length
    + (taskIdsSeen.length === 0 ? ' (none)' : ' -> ' + taskIdsSeen.join(', ')))

  emit('[probe] ---- A: ' + HAILUO_MODEL + ' resolution ----')
  if (caseA === null) {
    emit('[probe]   NOT ASKED')
  } else {
    emit('[probe]   http=' + caseA.http + ' code=' + caseA.code + ' ms=' + caseA.elapsedMs)
    emit('[probe]   refusal names: ' + fieldMentions(caseA.message))
    emit('[probe]   resolution-shaped tokens in the refusal: ['
      + resolutionTokens(caseA.message).join(',') + ']')
    emit('[probe]   VERBATIM: ' + oneLine(caseA.message, 700))
    emit('[probe]   VERDICT: ' + (caseA.failure !== ''
      ? 'INCONCLUSIVE - no answer (' + caseA.failure + ')'
      : /resolution/i.test(caseA.message)
        ? 'the model and duration passed validation (the complaint is about resolution), and the '
          + 'sentence above is this model resolution set'
        : 'AMBIGUOUS - the refusal does not mention resolution; read the sentence above'))
  }

  emit('[probe] ---- B: ' + H3_MAX_MODEL + ' resolution + duration floor ----')
  for (const answer of [caseB1, caseB2]) {
    if (answer === null) {
      emit('[probe]   ' + (answer === caseB1 ? 'B1' : 'B2') + ': NOT ASKED')
      continue
    }
    emit('[probe]   ' + answer.id + ' (http=' + answer.http + ' code=' + answer.code + ' ms=' + answer.elapsedMs
      + ') names ' + fieldMentions(answer.message)
      + ' tokens=[' + resolutionTokens(answer.message).join(',') + ']')
    emit('[probe]   VERBATIM: ' + oneLine(answer.message, 700))
  }
  if (caseB1 !== null) {
    emit('[probe]   B1 VERDICT: ' + (caseB1.failure !== ''
      ? 'INCONCLUSIVE - no answer (' + caseB1.failure + ')'
      : /resolution/i.test(caseB1.message)
        ? 'duration 5 and the model both passed; the sentence above is this model resolution set'
        : 'AMBIGUOUS - the refusal does not mention resolution'))
  }
  if (caseB2 !== null) {
    emit('[probe]   B2 VERDICT: ' + (caseB2.failure !== ''
      ? 'INCONCLUSIVE - no answer (' + caseB2.failure + ')'
      : /duration/i.test(caseB2.message)
        ? 'duration 4 IS refused, so the floor of 5 is confirmed by the service own sentence'
        : 'duration 4 was NOT refused for duration - read the sentence above before assuming a floor'))
  }

  emit('[probe] ---- C: ratio ----')
  if (caseC === null) {
    emit('[probe]   NOT ASKED')
  } else {
    emit('[probe]   http=' + caseC.http + ' code=' + caseC.code + ' names ' + fieldMentions(caseC.message))
    emit('[probe]   VERBATIM: ' + oneLine(caseC.message, 700))
  }
  emit('[probe]   VERDICT: ' + ratioVerdict(caseC))

  emit('[probe] ---- D: 20 MiB inline ----')
  if (caseD === null) {
    emit('[probe]   NOT ASKED')
  } else {
    emit('[probe]   raw=' + caseD.rawBytes + 'B encoded=' + caseD.encodedBytes + 'B http=' + caseD.http
      + ' code=' + caseD.code + ' base_resp=' + caseD.baseStatus + ' ms=' + caseD.elapsedMs
      + ' failure=' + (caseD.failure === '' ? '(none)' : caseD.failure))
    emit('[probe]   success=' + JSON.stringify(caseD.success)
      + ' source=' + JSON.stringify(oneLine(caseD.source, 120)))
    emit('[probe]   error=' + JSON.stringify(oneLine(caseD.error, 700)))
    emit('[probe]   classification: ' + classifyUnderstand(caseD))
  }
  emit('[probe]   VERDICT: ' + inlineVerdict(caseD))

  emit('')
  emit('[probe] transcript: ' + transcriptPath + ' (' + transcript.length + ' lines)')
}, 900_000)
