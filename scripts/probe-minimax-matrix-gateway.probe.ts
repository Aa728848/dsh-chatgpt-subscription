/**
 * Live probe: does the Matrix media gateway accept a MiniMax Code SUBSCRIPTION
 * bearer token?
 *
 * WHY THIS FILE EXISTS. docs/minimax-video-tools-feasibility.md concluded that the
 * official client's 18 media tools (video generation/understanding, image, TTS,
 * ASR, search) ride the SUBSCRIPTION gateway rather than the platform API key
 * surface, on the same origin this line already posts Messages to. That
 * conclusion was reached by READING upstream source only: not one live request
 * was sent. 'The code sends this' and 'the service answers this' are different
 * claims, and the second one is the only one that can sink the plan. This probe
 * buys that second claim for the price of one read-only request.
 *
 * WHY get_voice_list. Of the 18 tools it is the one that takes no input, does no
 * file I/O, starts no generation and writes no artifact (upstream
 * tool-defs.ts:582; tools/get-voice-list.ts is a Pattern-A passthrough). It
 * exercises the two things in question - authentication and routing - and
 * nothing else. NOTHING HERE MAY EVER NAME A GENERATION ENDPOINT
 * (submit_video_generation / gen_videos / image_synthesize / batch_*): those
 * spend credits, and credits are not what this probe is measuring.
 *
 * WHY TWO REQUESTS, NOT ONE. Upstream also sends a set of OPTIONAL routing
 * headers (user_id / biz_id / request_sk, matrix-client.ts:37-38, 113-116).
 * Whether the gateway requires them, ignores them, or refuses without them is
 * exactly the difference between 'we can call this today' and 'we need one more
 * piece first'. So the first request carries the bare upstream shape (bearer +
 * User-Agent + JSON), and the second repeats it with the routing vocabulary this
 * repository has already measured on the check-in line
 * (checkin-gateway.ts:206-222): the device_platform/biz_id/app_id query set plus
 * a user_id header. The delta between the two answers IS the answer to 'what
 * does the server actually want'.
 *
 * CASE TAXONOMY (the two cases below are A and B+C-minus-signature).
 *
 *   A  the upstream PROD shape: bearer + User-Agent + Content-Type, no query,
 *      no signature headers, no identity headers.                <- R1-bare
 *   B  A + the check-in surface's yy / x-timestamp / x-signature.  NOT built.
 *   C  A + identity headers (user_id / biz_id) and query vocabulary. <- R2-routed
 *   D  not a shape but a CLASSIFICATION: a 404/405 answer says the path or the
 *      verb is wrong, which is not an auth verdict. Kept apart in classify().
 *
 * A IS THE PRIMARY AND IT PASSED. A later reading of the upstream tree
 * (packages/agent-tools/src/desktop/managed-routing.ts) shows that the routing
 * headers are gated on a non-prod build env and resolve to {} in prod, so A is
 * not merely the minimal shape - it is the whole shape a prod client sends.
 * That is why B is deliberately NOT implemented: it would be a branch that can
 * never be reached on the evidence this probe already holds, and unexercised
 * code in a probe is the exact thing a probe exists to avoid. If A ever starts
 * failing with an AUTH verdict, B is the next thing to build, and the salt it
 * needs lives in checkin-gateway.ts (module-private, deliberately not copied
 * here for a branch nothing has ever asked for).
 *
 * R2 IS KEPT, NOT GATED, AND THAT IS A RECORDED CHOICE. With A passing, C is
 * strictly unnecessary; the run that produced this file's evidence spent two
 * requests, not one. Keeping C in the file makes "the headers do not matter"
 * a MEASURED statement rather than an inferred one, and it is the only shape
 * that could still show a hidden requirement if A ever degrades. It costs one
 * read-only request with no side effects. Drop it to a single request by
 * returning early when case A is accepted, if that trade stops being worth it.
 *
 * TWO REQUESTS IS A BUDGET, NOT AN ASPIRATION. There is no loop, no retry, no
 * sweep, no concurrency. A second attempt after a refusal would turn 'the
 * service said no' into 'the service said no twice', which is a worse
 * measurement, not a better one.
 *
 * NOTHING IDENTIFYING IS PRINTED. The token, the refresh token, the address, the
 * account id and the resolved realUserID never reach a log line. Bodies are
 * scrubbed on the way out by scrub(); the routing query is reported by KEY NAMES
 * only, because a realUserID is frequently a short numeric string that no
 * pattern-based scrubber would catch, and 'print it only if it looks secret'
 * fails exactly on the identifiers that do not look secret.
 *
 * Run: npx vitest run --config vitest.probe.config.ts probe-minimax-matrix-gateway
 */
import { test } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { MinimaxCodeCredentialStore } from '../src/host/minimax-code/token-store.ts'
import { MinimaxCodeAccountPool } from '../src/host/minimax-code/account-pool.ts'
import { agentBaseUrl } from '../src/host/minimax-code/types.ts'
import {
  checkinAccountIdentity,
  fetchAccountIdentity,
} from '../src/host/minimax-code/checkin-gateway.ts'
import { dshHomeDir } from '../src/host/common/home.ts'
import type { MinimaxCodeCredentials } from '../src/host/minimax-code/token-store.ts'
import type { MinimaxCodeRegion } from '../src/shared/minimax-code-contracts.ts'

/** Hard ceiling on one request, so a case can never hang the run. */
const TIMEOUT_MS = 30_000
/** Pause between the two cases: a burst is how a rate limit gets mistaken for a verdict. */
const BETWEEN_CASES_MS = 500

/** Gateway prefix the desktop client rewrites /matrix/api/v1/mcp/ INTO. */
const LOCAL_GATEWAY_PREFIX = '/mavis/api/v1/mcp/'
/** The one tool this probe is allowed to call. See the header comment. */
const TOOL = 'get_voice_list'
/**
 * User-Agent the upstream Matrix client sends (matrix-client.ts:204).
 *
 * Sent verbatim because the brief asks for the upstream shape, and because a
 * differing UA in case 1 would confound the very comparison the two cases exist
 * to make. This is a probe of ONE read-only request; whether a shipped client
 * should present this UA is a separate policy decision and is NOT settled here -
 * this package's types.ts product-token note refuses to claim to be the official
 * app, so the finding must not be read as an endorsement of the UA.
 */
const MATRIX_USER_AGENT = 'MiniMaxAgent'

const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

// ---------------------------------------------------------------------------
// Redaction - copied from probe-minimax-capabilities.probe.ts so both probes
// scrub identically; two different scrubbers is two different disclosure bugs.
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
 * A numeric code is only actionable if the PATH it sits at is known: this probe
 * asks specifically whether base_resp.status_code exists on THIS surface (it is
 * documented on the quota and Files surfaces, not on a media one), and two
 * envelopes that both carry a number are two different detectors.
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
    out.push({ path: here, type: 'string', value: JSON.stringify(oneLine(value, 300)) })
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

/** Digits the service wrote into a refusal's own wording, e.g. the ' (2013)'. */
function codesInWording(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/\((\d{3,6})\)/g)) found.push('(' + match[1] + ')')
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

// ---------------------------------------------------------------------------
// Routing vocabulary
// ---------------------------------------------------------------------------

/**
 * The routing query this repository has already MEASURED on the check-in line
 * (checkin-gateway.ts:206-222), reused as the second case's variable.
 *
 * Deliberately NOT included: request_sk. Upstream sends one, but its format is
 * not in anything read so far, and inventing a value would put an unmeasured
 * parameter into the one request that is supposed to isolate a measured one - a
 * refusal caused by a malformed request_sk is indistinguishable, inside a
 * two-request budget, from a refusal caused by the routing headers themselves.
 * That is a limitation of this probe, and it is recorded as one.
 */
function routingQuery(realUserID: string | undefined): Record<string, string> {
  return {
    device_platform: 'web',
    biz_id: '3',
    app_id: '3001',
    version_code: '22201',
    is_desktop: '1',
    desktop_version: '0.0.0',
    unix: String(Date.now()),
    timezone_offset: String(new Date().getTimezoneOffset() * -60),
    sys_language: 'zh',
    lang: 'zh',
    device_id: '0',
    os_name: process.platform,
    browser_name: 'mcode',
    user_id: realUserID ?? '0',
    client: 'mcode',
  }
}

// ---------------------------------------------------------------------------
// The realUserID, from the cheapest source available
// ---------------------------------------------------------------------------

/**
 * State document the check-in scheduler keeps beside the other plugin stores.
 *
 * Mirrors checkinStatePath() (checkin.ts:64-66). Spelled out rather than imported
 * so this probe does not pull the whole scheduler module in for one path; the
 * duplication is one line and is pinned by this comment.
 */
function checkinStatePath(): string {
  return path.join(dshHomeDir(), 'storages', 'minimax-code-checkin.json')
}

/**
 * Resolve the account's realUserID WITHOUT spending a media request if possible.
 *
 * The check-in scheduler caches it in its state document, keyed by pool account
 * id and pinned to the sign-in that resolved it. Reading that cache is free; the
 * identity surface (GET /v1/api/user/info) is the fallback, and it is a call this
 * line already makes daily in production - it is not part of the media budget the
 * brief caps. A missing cache, an unreadable file and a failed identity call all
 * degrade to undefined, because 'no realUserID' only costs case 2 its user_id
 * value, not the probe its answer.
 */
async function resolveRealUserID(
  accountId: string | undefined,
  credentials: MinimaxCodeCredentials,
  region: MinimaxCodeRegion,
): Promise<{ realUserID: string | undefined; source: string }> {
  const pin = checkinAccountIdentity(credentials)
  try {
    const parsed = asRecord(JSON.parse(await fs.readFile(checkinStatePath(), 'utf8')) as unknown)
    const identities = asRecord(parsed?.identities)
    if (identities !== undefined) {
      for (const [id, value] of Object.entries(identities)) {
        const entry = asRecord(value)
        if (entry === undefined || typeof entry.realUserID !== 'string' || entry.realUserID === '') continue
        if (entry.region !== region) continue
        // Prefer the row this credential is pinned to; fall back to matching the
        // pool account id when nothing is pinned (an unpinned entry is a format
        // upgrade, not a mismatch).
        if (pin !== undefined && typeof entry.accountIdentity === 'string' && entry.accountIdentity !== '') {
          if (entry.accountIdentity !== pin) continue
        } else if (accountId !== undefined && id !== accountId) {
          continue
        }
        return { realUserID: entry.realUserID, source: 'checkin-state cache' }
      }
    }
  } catch {
    // No state document: fall through to the identity surface.
  }
  try {
    const identity = await fetchAccountIdentity(credentials.accessToken, region, { fetchFn })
    return { realUserID: identity.realUserID, source: 'identity surface' }
  } catch (error) {
    return {
      realUserID: undefined,
      source: 'unavailable: ' + oneLine(error instanceof Error ? error.message : String(error), 160),
    }
  }
}

// ---------------------------------------------------------------------------
// One probe case
// ---------------------------------------------------------------------------

interface Observation {
  id: string
  http: string
  baseResp: string
  fields: string
  verdict: string
}

const observations: Observation[] = []

/**
 * Classify one answer against the three outcomes the brief names.
 *
 * Kept as a function rather than decided inline so the classification is the
 * same for both cases and cannot drift into 'this one looked fine to me'.
 */
function classify(status: number, body: unknown, rawText: string): string {
  const base = baseRespOf(body)
  if (status === 401 || status === 403) return 'REJECTED: subscription bearer not accepted (HTTP ' + status + ')'
  if (base.statusCode === 1004) return 'REJECTED: 1004 wants a platform API secret key'
  // D: a 404/405 is NOT an auth verdict. It says the path or the verb is wrong,
  // and that points at a completely different next step than a refused token
  // does. Conflating them is how "we called the wrong URL" gets recorded as
  // "our subscription is not accepted".
  if (status === 404 || status === 405) {
    return 'PATH/METHOD: HTTP ' + status + ' - the URL or verb is wrong; this says nothing about the token'
  }
  if (status >= 200 && status < 300) {
    if (base.statusCode === 0) return 'ACCEPTED: 2xx and base_resp.status_code=0'
    if (base.statusCode !== undefined) return 'NEEDS-EXTRA: 2xx but base_resp.status_code=' + base.statusCode
    if (body === undefined) return 'RECORDED: 2xx, body is not JSON'
    return 'RECORDED: 2xx, no base_resp.status_code in the body'
  }
  const wording = codesInWording(rawText)
  return 'RECORDED: HTTP ' + status + (wording.length === 0 ? '' : ' wording-codes=' + wording.join(','))
}

async function runCase(item: {
  id: string
  question: string
  changed: string
  url: URL
  headers: Record<string, string>
}): Promise<void> {
  const payload = '{}'
  console.log('[probe] ---- ' + item.id + ' (Q' + item.question + ')')
  console.log('[probe]   changed: ' + item.changed)
  // The URL is reported WITHOUT its query string: case 2's query carries the
  // realUserID, and a realUserID is often a short numeric string that no
  // pattern-based scrubber would catch. Key names only; the id by presence.
  console.log('[probe]   url=' + item.url.origin + item.url.pathname
    + ' query-keys=[' + [...item.url.searchParams.keys()].join(',') + ']'
    + ' user_id=' + (item.url.searchParams.has('user_id')
      ? '<present:len=' + (item.url.searchParams.get('user_id') ?? '').length + '>'
      : '<absent>'))
  console.log('[probe]   headers=[' + Object.keys(item.headers).sort().join(',') + '] body=' + JSON.stringify(payload))

  const started = Date.now()
  let response: Response
  try {
    response = await fetchFn(item.url.toString(), {
      method: 'POST',
      headers: item.headers,
      body: payload,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }) as unknown as Response
  } catch (error) {
    // A transport failure is a fact about the RUN, not about the gateway's
    // acceptance of the bearer, and it must be reported as such.
    const message = oneLine(error instanceof Error ? error.message : String(error), 240)
    console.log('[probe]   transport failure: ' + message)
    observations.push({ id: item.id, http: 'transport', baseResp: '-', fields: '-', verdict: message })
    return
  }

  const elapsed = Date.now() - started
  const contentType = response.headers.get('content-type') ?? '(none)'
  const raw = await response.text().catch(() => '')
  console.log('[probe]   http=' + response.status + ' content-type=' + JSON.stringify(contentType)
    + ' ms=' + elapsed + ' bodyBytes=' + Buffer.byteLength(raw))
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
  const base = baseRespOf(parsed)
  console.log('[probe]   base_resp: ' + (base.statusCode === undefined && base.statusMsg === undefined
    ? '(absent)'
    : 'status_code=' + JSON.stringify(base.statusCode) + ' status_msg=' + JSON.stringify(base.statusMsg)))
  if (parsed !== undefined) {
    for (const field of fieldsOf(parsed)) {
      console.log('[probe]     ' + field.path + ': ' + field.type + (field.value === '' ? '' : ' = ' + field.value))
    }
  }
  const verdict = classify(response.status, parsed, raw)
  console.log('[probe]   VERDICT: ' + verdict)
  observations.push({
    id: item.id,
    http: String(response.status),
    baseResp: base.statusCode === undefined ? '(absent)' : String(base.statusCode),
    fields: parsed === undefined ? '(not JSON)' : fieldsOf(parsed).map((field) => field.path).join(' '),
    verdict,
  })
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

test('minimax matrix gateway accepts the subscription bearer', async () => {
  // The pool, not the bare store: the native MiniMax Code auth directory is gone
  // on this machine, and the plugin's own pool still holds the sessions.
  const pool = new MinimaxCodeAccountPool({ store: new MinimaxCodeCredentialStore() })
  let credentials: MinimaxCodeCredentials
  let accountId: string | undefined
  try {
    const picked = await pool.getCredentialAccount(fetchFn)
    credentials = picked.credentials
    accountId = picked.account.id
  } catch (error) {
    // Reported rather than thrown: 'no account' is one of the answers this probe
    // is allowed to return, and a stack trace would hide it.
    console.log('[probe] NO CREDENTIAL - the gateway question is unmeasurable: '
      + oneLine(error instanceof Error ? error.message : String(error), 300))
    return
  }

  // The region decides the host. A fixed cn host would answer a global token
  // with a refusal that says nothing about the token.
  const region = credentials.region
  const gatewayUrl = agentBaseUrl(region) + LOCAL_GATEWAY_PREFIX + TOOL
  console.log('[probe] endpoint=' + gatewayUrl + ' region=' + region)
  console.log('[probe] tool=' + TOOL + ' (no input, no file I/O, no generation, no artifact)')

  const resolved = await resolveRealUserID(accountId, credentials, region)
  console.log('[probe] realUserID: ' + (resolved.realUserID === undefined
    ? '<unavailable>'
    : '<resolved:len=' + resolved.realUserID.length + '>') + ' source=' + resolved.source)

  /** The bare upstream shape: bearer + User-Agent + JSON, and nothing else. */
  const bareHeaders: Record<string, string> = {
    authorization: 'Bearer ' + credentials.accessToken,
    'user-agent': MATRIX_USER_AGENT,
    'content-type': 'application/json',
    accept: 'application/json',
  }

  // --- Case A (PRIMARY): no routing vocabulary at all, no query string. If the
  // --- bearer alone is enough, this is byte-for-byte the request a prod client
  // --- sends - and managed-routing.ts says prod adds nothing to it.
  await runCase({
    id: 'R1-bare',
    question: '1',
    changed: 'nothing beyond the upstream baseline: bearer + User-Agent + JSON body {}',
    url: new URL(gatewayUrl),
    headers: bareHeaders,
  })

  await new Promise((resolve) => setTimeout(resolve, BETWEEN_CASES_MS))

  // --- Case C: the same request plus the routing vocabulary this repository has
  // --- measured elsewhere. Run even when A passed, so "the headers are not
  // --- required" is measured rather than inferred.
  // --- NOTE: this is a COMBINED probe (query + user_id/biz_id headers). If it
  // --- succeeds where case 1 failed, it proves the vocabulary in aggregate is
  // --- enough and does NOT isolate which member was load-bearing; two requests
  // --- cannot.
  const routed = new URL(gatewayUrl)
  for (const [key, value] of Object.entries(routingQuery(resolved.realUserID))) {
    routed.searchParams.set(key, value)
  }
  const routedHeaders: Record<string, string> = {
    ...bareHeaders,
    ...(resolved.realUserID === undefined ? {} : { user_id: resolved.realUserID }),
    biz_id: '3',
  }
  await runCase({
    id: 'R2-routed',
    question: '2',
    changed: 'COMBINED: check-in query vocabulary (device_platform/biz_id/app_id/...)'
      + ' + user_id and biz_id headers; body unchanged. Not isolated to one member.',
    url: routed,
    headers: routedHeaders,
  })

  console.log('[probe] ===== summary =====')
  for (const row of observations) {
    console.log('[probe] ' + row.id + ' | http=' + row.http + ' | base_resp.status_code=' + row.baseResp
      + ' | fields=' + row.fields + ' | verdict=' + row.verdict)
  }
  const accepted = observations.filter((row) => row.verdict.startsWith('ACCEPTED')).length
  console.log('[probe] accepted cases: ' + accepted + '/' + observations.length)
}, 600_000)
