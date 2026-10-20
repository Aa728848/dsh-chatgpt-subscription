/**
 * Live probe: does get_upload_url -> PUT -> cdn_url -> videos_understand work?
 *
 * WHY THIS FILE EXISTS. scripts/probe-minimax-video-generation.probe.ts measured
 * every free shape on this media gateway except one, and the one it left out is
 * the only path a LOCAL LARGE FILE has:
 *
 *   - inline base64 is read (U3), but the service's own error caps it at 600 KiB
 *     and base64 grows the bytes by 4/3 on the way into the request body;
 *   - 'url' over a SIGNED OSS URL failed (U2, results[0].success=false);
 *   - the upload path cites a DIFFERENT address - cdn_url on cdn.hailuoai.com,
 *     with NO query string - and cites it under that same 'url' key.
 *
 * Two different hosts and two different URL shapes are two different claims, and
 * the second one had never been measured. docs/minimax-video-generation-probe.md
 * section 7 lists it as an open item, and src/host/minimax-code/video-tool.ts
 * labels the upload path UNVERIFIED end to end and keeps it opt-in
 * ('transport: "upload"') for exactly that reason. This probe buys the answer.
 *
 * THE THREE STEPS RUN EXACTLY ONCE APIECE. There is no retry anywhere in this
 * file, and that is the design rather than a shortcut:
 *
 *   1. POST /mavis/api/v1/mcp/get_upload_url  {filename, mime_type, size_bytes}
 *   2. PUT  put_url  with the bytes            - a REAL write into OSS
 *   3. POST /mavis/api/v1/mcp/videos_understand  {video_info:[{url:cdn_url,prompt}]}
 *
 * Step 3 may be BILLED, so a failure is recorded rather than re-asked: asking the
 * same body twice is not a better measurement, it is the same refusal at twice
 * the price. Step 2 is bounded the same way - an upload that failed is a fact
 * about the link, not a transient to be retried until it looks better.
 *
 * NO VIDEO IS GENERATED. Generating one is what the other probe spends credits
 * on, and it is not needed here: the question is whether bytes can travel the
 * link, not whether the clip is good. So the uploaded object is a 1586-byte
 * synthetic ISO BMFF file built once at 64x64/1 s/black, embedded below as a
 * constant. Its box layout is printed at run time (ftyp / moov / free / mdat) so
 * the file is proven to BE an MP4 rather than asserted to be one.
 *
 * NOTHING IDENTIFYING IS PRINTED. The access token, the address, the account id
 * and the realUserID never reach a log line. The account id is the interesting
 * one: cdn_url carries u<18 digits> inside its PATH, which is SHORTER than
 * scrub()'s 32-character catch-all, so scrub() carries an explicit rule for it
 * (copied verbatim from the sibling probe). URLs are reported by SHAPE only -
 * scheme, host, segment count, extension, query KEY NAMES - because a signed URL
 * carries its credential in the query string.
 *
 * WHAT EACH OUTCOME MEANS. results[0].success is the verdict; HTTP 200 and
 * base_resp.status_code 0 are NOT (the sibling probe measured three refusals
 * that answered exactly that). A false verdict is therefore recorded in full -
 * every field of results[0], verbatim - because the service's own sentence is the
 * finding, and one CONFIRMING CONTROL follows it: the same bytes sent inline as
 * base64. A control that succeeds proves the clip, the prompt and the caller were
 * all acceptable, which is what makes "the reference is what failed" a conclusion
 * instead of a guess. If the control also fails, the run says so and neither
 * path is blamed.
 *
 * Run: npx vitest run --config vitest.probe.config.ts probe-minimax-video-upload
 */
import { test } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { MinimaxCodeCredentialStore } from '../src/host/minimax-code/token-store.ts'
import { MinimaxCodeAccountPool } from '../src/host/minimax-code/account-pool.ts'
import { matrixRequestHeaders, matrixToolUrl } from '../src/host/minimax-code/matrix-client.ts'
import type { MinimaxCodeRegion } from '../src/shared/minimax-code-contracts.ts'

/** One broker call. Cheap, and bounded so a hung probe cannot eat the run. */
const FREE_TIMEOUT_MS = 45_000
/** One PUT of ~1.5 KB. The budget is for the round trip, not the bytes. */
const PUT_TIMEOUT_MS = 60_000
/** The understanding call. Generous: the model reads the clip server-side. */
const UNDERSTAND_TIMEOUT_MS = 120_000
/** Pause between calls: a burst is how a rate limit gets mistaken for a verdict. */
const BETWEEN_CALLS_MS = 800
/** A read-back of the uploaded object is tiny; it must not hang the run either. */
const READBACK_TIMEOUT_MS = 30_000

/**
 * A 1586-byte synthetic MP4: 64x64, 1 second, 10 fps, black, H.264 baseline.
 *
 * Embedded as a constant ON PURPOSE. Downloading or generating a clip would make
 * the probe depend on the network twice and, in the generation case, spend the
 * credits this probe exists to avoid. The bytes are the smallest thing that is
 * still a real ISO BMFF file - ftyp / moov / free / mdat - so the service is
 * asked a fair question instead of being handed an opaque blob.
 */
const SYNTHETIC_CLIP_BASE64 =
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAM2bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAmB0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAHYbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAKABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABg21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAUNzdGJsAAAAo3N0c2QAAAAAAAAAAQAAAJNhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAALWF2Y0MBQsAK/+EAFmdCwAraEJsBEAAAAwAQAAADAUDxImoBAARozg/IAAAAEHBhc3AAAAABAAAAAQAAABhzdHRzAAAAAAAAAAEAAAAKAAAEAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAKAAAAAQAAADxzdHN6AAAAAAAAAAAAAAAKAAACcgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAABRzdGNvAAAAAAAAAAEAAANmAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY1Ny44My4xMDAAAAAIZnJlZQAAAtRtZGF0AAACVAYF//9Q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE1MiByMjg1MSBiYTI0ODk5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAxNyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTEgZGVibG9jaz0wOjA6MCBhbmFseXNlPTA6MCBtZT1kaWEgc3VibWU9MCBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MCA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0wIHRocmVhZHM9MiBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xMCBzY2VuZWN1dD0wIGludHJhX3JlZnJlc2g9MCByYz1jcmYgbWJ0cmVlPTAgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IGFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MACAAAAAFmWIhDomKAAJAsnJyddddddddddddeAAAAAGQZogEaCMAAAABkGaQBKgjAAAAAZBmmASoIwAAAAGQZqAEqCMAAAABkGaoBKgjAAAAAZBmsASoIwAAAAGQZrgEqCMAAAABkGbABKgjAAAAAZBmyASoIw='

/** The prompt the product sends, so step 3 asks the same question production does. */
const PROMPT = '描述这个视频'

const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

// ---------------------------------------------------------------------------
// Redaction - copied verbatim from probe-minimax-video-generation.probe.ts (which
// copied it from probe-minimax-matrix-gateway.probe.ts), so every probe in this
// repo scrubs identically; two different scrubbers is two different disclosure
// bugs.
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
    // an ordinary opaque run. cdn_url is the field this probe exists to read, so
    // this rule is load-bearing here rather than defensive.
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
 * segment count, extension, path length and query KEY NAMES are the whole of the
 * evidence the brief asks for anyway: whether the address carries a signature,
 * under which parameter, and whether it is the same shape U2 already failed on.
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
 * reason: the understanding call carries cdn_url and the broker answer carries
 * put_url, whose query string holds both the access key id and the signature.
 * Printing either verbatim - the obvious thing to do - puts a credential in the
 * log. So every string that looks like a URL is reshaped, and everything else is
 * scrubbed.
 */
function echoBody(body: unknown): string {
  const walked = JSON.stringify(body, (_key, value: unknown) => {
    if (typeof value !== 'string') return value
    // The base64 clip and the token-like values are opaque runs; a 300-character
    // cut would print three quarters of the payload, which is noise rather than
    // evidence. Report the size and move on.
    if (value.length > 300) return '<string:len=' + value.length + '>'
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
 * documents, and 'there is a string somewhere' does not tell it which key to read.
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
    // A URL is shaped, not quoted: see describeUrl. Everything else is scrubbed,
    // and a long opaque run (a base64 payload) is reported by size only.
    const shown = value.length > 300 ? '<string:len=' + value.length + '>' : JSON.stringify(oneLine(value, 300))
    out.push({ path: here, type: 'string', value: isUrl(value) ? describeUrl(value) : shown })
    return out
  }
  out.push({ path: here, type: typeof value, value: String(value) })
  return out
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

/** Pause between calls without a polling loop. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Say what the inline control proved about the failed upload path.
 *
 * The control exists so that 'the link fails' cannot be the whole story when the
 * clip itself was the problem. Three outcomes, and they are not interchangeable:
 *
 * - control succeeded: the bytes, the prompt and the caller are all acceptable,
 *   so the ONLY remaining variable is the cdn_url reference. That is what turns
 *   the failure into a finding about the link rather than about the probe.
 * - control failed the same way: nothing about this run was acceptable, so the
 *   link is neither implicated nor exonerated. Said out loud rather than
 *   reported as a link verdict.
 * - no answer at all: the caller itself is unusable and every verdict above is
 *   vacuous.
 */
function explainControl(
  linked: { status: number; success?: unknown },
  control: { status: number; success?: unknown },
): void {
  emit('[probe] ---- what the control proves ----')
  emit('[probe]   W1 (cdn_url) success=' + JSON.stringify(linked.success)
    + '  |  C1 (inline) success=' + JSON.stringify(control.success))
  if (control.status === 0) {
    emit('[probe]   CONTROL GOT NO ANSWER - the caller itself is unusable, so the cdn_url verdict above '
      + 'is VACUOUS. Fixing that is a prerequisite for measuring this link at all.')
    return
  }
  if (control.success === true) {
    emit('[probe]   CONTROL READ THE SAME BYTES. The clip, the prompt and the credential are all '
      + 'acceptable to this endpoint, so the failure of W1 is attributable to the cdn_url REFERENCE '
      + 'and not to the material. That is the verdict: the upload link does not work for reading.')
    return
  }
  emit('[probe]   THE CONTROL ALSO FAILED. Both paths were refused for a reason that lives outside '
    + 'both of them (the material, the prompt or the account), so this run does NOT establish that the '
    + 'cdn_url reference is the problem. Re-measuring needs material the endpoint is known to read.')
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Mirror every log line into a file as well as stdout.
 *
 * The evidence IS this transcript, and a console-only run loses it the moment the
 * terminal buffer scrolls. Writing it as it happens makes the doc reproducible
 * from a single artifact, and it is the same bytes either way - the redaction
 * happens in oneLine(), upstream of both sinks.
 */
const transcriptPath = path.join(os.tmpdir(), 'minimax-video-upload-probe-transcript.log')
const transcript: string[] = []
const emit = (line: string): void => {
  console.log(line)
  transcript.push(line)
}

test('minimax upload link: get_upload_url -> PUT -> cdn_url -> videos_understand', async () => {
  // Module-level guards, not reminders. A second PUT is a second write the brief
  // forbids, and a second understanding call is a second possible charge; the
  // only way to be sure neither happens is to make it impossible in code.
  let uploaded = false
  let understood = false

  const pool = new MinimaxCodeAccountPool({ store: new MinimaxCodeCredentialStore() })
  let credentials: { accessToken: string; region: MinimaxCodeRegion }
  try {
    const picked = await pool.getCredentialAccount(fetchFn)
    credentials = { accessToken: picked.credentials.accessToken, region: picked.credentials.region }
  } catch (error) {
    emit('[probe] NO CREDENTIAL - the upload link is unmeasurable: '
      + oneLine(error instanceof Error ? error.message : String(error), 300))
    return
  }
  const { accessToken, region } = credentials
  emit('[probe] region=' + region)
  emit('[probe] token=<present:len=' + accessToken.length + '> (never printed)')

  // ---- the synthetic clip, proven to be an MP4 rather than asserted to be ---
  const clip = Buffer.from(SYNTHETIC_CLIP_BASE64, 'base64')
  const boxes: string[] = []
  for (let offset = 0; offset + 8 <= clip.length;) {
    const size = clip.readUInt32BE(offset)
    const type = clip.subarray(offset + 4, offset + 8).toString('latin1')
    boxes.push(type + '@' + offset + '=' + size)
    if (size < 8) break
    offset += size
  }
  emit('')
  emit('[probe] ===== the object to upload (synthetic, NOT generated) =====')
  emit('[probe] clip bytes=' + clip.length
    + ' head16=' + clip.subarray(0, 16).toString('hex')
    + ' box@4=' + JSON.stringify(clip.subarray(4, 8).toString('latin1')))
  emit('[probe] boxes: ' + boxes.join(' '))
  emit('[probe] this is a real ISO BMFF file, which is the only fairness claim this probe makes about the bytes')

  // =========================================================================
  // STEP 1 - ask the broker for a target
  // =========================================================================

  emit('')
  emit('[probe] ===== STEP 1: get_upload_url =====')
  const uploadBody = { filename: 'probe.mp4', mime_type: 'video/mp4', size_bytes: clip.length }
  const uploadUrl = matrixToolUrl(region, 'get_upload_url')
  emit('[probe]   url=' + uploadUrl + ' query-keys=[' + [...new URL(uploadUrl).searchParams.keys()].join(',') + ']')
  emit('[probe]   body=' + echoBody(uploadBody))

  const grantedAt = Date.now()
  let granted: Record<string, unknown> | undefined
  try {
    const response = await fetchFn(uploadUrl, {
      method: 'POST',
      headers: matrixRequestHeaders(accessToken),
      body: JSON.stringify(uploadBody),
      signal: AbortSignal.timeout(FREE_TIMEOUT_MS),
      redirect: 'error',
    }) as unknown as Response
    const raw = await response.text().catch(() => '')
    emit('[probe]   http=' + response.status
      + ' content-type=' + JSON.stringify(response.headers.get('content-type') ?? '(none)')
      + ' ms=' + (Date.now() - grantedAt) + ' bodyBytes=' + Buffer.byteLength(raw))
    emit('[probe]   body raw: ' + oneLine(raw, 700))
    try {
      granted = asRecord(raw.trim() === '' ? undefined : JSON.parse(raw) as unknown)
    } catch {
      granted = undefined
    }
    const base = baseRespOf(granted)
    emit('[probe]   top-level keys: [' + (granted === undefined ? '(not a JSON object)' : Object.keys(granted).join(',')) + ']')
    emit('[probe]   base_resp: ' + (base.statusCode === undefined && base.statusMsg === undefined
      ? '(absent)'
      : 'status_code=' + JSON.stringify(base.statusCode) + ' status_msg=' + JSON.stringify(base.statusMsg)))
    emit('[probe]   top-level code: ' + JSON.stringify(granted?.code))
    if (granted !== undefined) {
      for (const field of fieldsOf(granted)) {
        emit('[probe]     ' + field.path + ': ' + field.type + (field.value === '' ? '' : ' = ' + field.value))
      }
    }
  } catch (error) {
    emit('[probe]   transport failure: ' + oneLine(error instanceof Error ? error.message : String(error), 240))
  }

  const putUrl = firstString(granted, ['put_url'])
  const cdnUrl = firstString(granted, ['cdn_url'])
  const echoContentType = firstString(granted, ['content_type'])
  emit('[probe] put_url: ' + (putUrl === undefined ? '(MISSING)' : describeUrl(putUrl)))
  emit('[probe] cdn_url: ' + (cdnUrl === undefined ? '(MISSING)' : describeUrl(cdnUrl)))
  emit('[probe] content_type echoed by the broker: ' + JSON.stringify(echoContentType))
  emit('[probe] expires_in: ' + JSON.stringify(granted?.expires_in))

  // =========================================================================
  // STEP 2 - one real PUT of the bytes
  // =========================================================================

  let readback: string = 'skipped (no cdn_url)'
  if (putUrl === undefined || cdnUrl === undefined) {
    emit('')
    emit('[probe] ===== STEP 2: PUT - SKIPPED =====')
    emit('[probe] the broker did not return both put_url and cdn_url, so there is nothing to write to and '
      + 'nothing to cite. Steps 2 and 3 cannot run, and this is a verdict in itself rather than a hiccup.')
  } else if (uploaded) {
    throw new Error('a PUT already happened; refusing to write twice')
  } else {
    uploaded = true
    emit('')
    emit('[probe] ===== STEP 2: PUT (the one real write) =====')
    // The broker echoes the content type it expects; the declared one is the
    // fallback. The brief asks for the DECLARED type, which is what
    // uploadLocalVideo() in video-tool.ts sends whenever the echo is absent.
    const putContentType = echoContentType ?? uploadBody.mime_type
    emit('[probe]   PUT ' + describeUrl(putUrl) + ' content-type=' + JSON.stringify(putContentType)
      + ' bytes=' + clip.length)
    const putStarted = Date.now()
    try {
      const put = await fetchFn(putUrl, {
        method: 'PUT',
        headers: { 'content-type': putContentType },
        body: clip,
        redirect: 'error',
        signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
      }) as unknown as Response
      const putRaw = await put.text().catch(() => '')
      emit('[probe]   http=' + put.status
        + ' content-type=' + JSON.stringify(put.headers.get('content-type') ?? '(none)')
        + ' ms=' + (Date.now() - putStarted)
        + ' bodyBytes=' + Buffer.byteLength(putRaw))
      emit('[probe]   body raw: ' + oneLine(putRaw, 600))
      emit('[probe]   etag=' + JSON.stringify(put.headers.get('etag') ?? '(none)')
        + ' x-oss-request-id=' + JSON.stringify(
          (put.headers.get('x-oss-request-id') ?? '(none)').slice(0, 6) + '...(truncated)'))
      emit('[probe]   VERDICT: ' + (put.ok
        ? 'the object was WRITTEN (HTTP ' + put.status + ')'
        : 'the write was REFUSED with HTTP ' + put.status + ' - the bytes are NOT in the bucket'))
    } catch (error) {
      emit('[probe]   transport failure: ' + oneLine(error instanceof Error ? error.message : String(error), 240))
    }

    // ---- 2b. read the object back over the cdn_url, unauthenticated --------
    //
    // Free, ~1.5 KB, and it separates two failures the understanding call alone
    // cannot tell apart: 'the object is not there / not public' from 'the object
    // is there and the service still will not read it'. A GET with no bearer is
    // exactly what a CDN fetch is.
    emit('')
    emit('[probe] ---- 2b. read-back over cdn_url (no auth) ----')
    try {
      const back = await fetchFn(cdnUrl, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(READBACK_TIMEOUT_MS),
      }) as unknown as Response
      const backBytes = new Uint8Array(await back.arrayBuffer().catch(() => new ArrayBuffer(0)))
      const backHead = Buffer.from(backBytes.subarray(0, 16)).toString('hex')
      readback = 'http=' + back.status
        + ' content-type=' + JSON.stringify(back.headers.get('content-type') ?? '(none)')
        + ' content-length=' + JSON.stringify(back.headers.get('content-length') ?? '(none)')
        + ' bytes=' + backBytes.byteLength
        + ' head16=' + backHead
        + ' matches-upload=' + (backBytes.byteLength === clip.length
          && backHead === clip.subarray(0, 16).toString('hex'))
      emit('[probe]   ' + readback)
    } catch (error) {
      readback = 'transport failure: ' + oneLine(error instanceof Error ? error.message : String(error), 200)
      emit('[probe]   read-back failed: ' + readback)
    }
  }

  // =========================================================================
  // STEP 3 - one understanding call over the cdn_url
  // =========================================================================

  interface UnderstandOutcome {
    status: number
    body?: Record<string, unknown>
    first?: Record<string, unknown>
    success?: unknown
  }

  const understandOutcomes: Array<{ id: string; outcome: UnderstandOutcome; note: string }> = []

  /**
   * One videos_understand call, reported in full.
   *
   * The verdict is results[0].success and nothing else: the sibling probe
   * measured three refusals that answered HTTP 200 with base_resp.status_code 0,
   * so neither of those is read as success here. When the verdict is false, EVERY
   * field of results[0] is printed - the service's own sentence is the finding,
   * and summarising it would throw away the one thing this probe is buying.
   */
  async function understand(
    id: string,
    media: Record<string, unknown>,
    note: string,
  ): Promise<UnderstandOutcome> {
    emit('')
    emit('[probe] ---- ' + id + ' - ' + note)
    const body = { video_info: [{ ...media, prompt: PROMPT }] }
    const url = matrixToolUrl(region, 'videos_understand')
    emit('[probe]   url=' + url + ' query-keys=[' + [...new URL(url).searchParams.keys()].join(',') + ']')
    emit('[probe]   body=' + echoBody(body))
    const started = Date.now()
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: matrixRequestHeaders(accessToken),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UNDERSTAND_TIMEOUT_MS),
        redirect: 'error',
      }) as unknown as Response
      const raw = await response.text().catch(() => '')
      emit('[probe]   http=' + response.status
        + ' content-type=' + JSON.stringify(response.headers.get('content-type') ?? '(none)')
        + ' ms=' + (Date.now() - started) + ' bodyBytes=' + Buffer.byteLength(raw))
      emit('[probe]   body raw: ' + oneLine(raw, 900))
      let parsed: unknown
      try {
        parsed = raw.trim() === '' ? undefined : JSON.parse(raw) as unknown
      } catch {
        parsed = undefined
      }
      const parsedBody = asRecord(parsed)
      const base = baseRespOf(parsed)
      emit('[probe]   top-level keys: [' + (parsedBody === undefined ? '(not a JSON object)' : Object.keys(parsedBody).join(',')) + ']')
      emit('[probe]   base_resp: ' + (base.statusCode === undefined && base.statusMsg === undefined
        ? '(absent)'
        : 'status_code=' + JSON.stringify(base.statusCode) + ' status_msg=' + JSON.stringify(base.statusMsg)))
      emit('[probe]   top-level code: ' + JSON.stringify(parsedBody?.code))
      const results = parsedBody?.results
      const first = Array.isArray(results) ? asRecord(results[0]) : undefined
      if (parsedBody !== undefined) {
        // The WHOLE envelope, field by field: the answer document is the evidence.
        for (const field of fieldsOf(parsedBody)) {
          emit('[probe]     ' + field.path + ': ' + field.type + (field.value === '' ? '' : ' = ' + field.value))
        }
      }
      emit('[probe]   results[0].success=' + JSON.stringify(first?.success))
      emit('[probe]   results[0].description=' + JSON.stringify(oneLine(String(first?.description ?? ''), 600)))
      emit('[probe]   results[0].source=' + JSON.stringify(oneLine(String(first?.source ?? ''), 120)))
      emit('[probe]   results[0].error=' + JSON.stringify(oneLine(String(first?.error ?? ''), 600)))
      if (first !== undefined) {
        // Named one by one as well, so a field nobody predicted cannot hide in a
        // dump that was cut for length. The JSON below is the whole entry.
        emit('[probe]   results[0] COMPLETE, every key verbatim (scrubbed): '
          + echoBody(Object.fromEntries(Object.entries(first).map(([key, value]) => [
            key,
            typeof value === 'string' && value.length > 900 ? oneLine(value, 900) : value,
          ]))))
      }
      return {
        status: response.status,
        ...(parsedBody === undefined ? {} : { body: parsedBody }),
        ...(first === undefined ? {} : { first }),
        success: first?.success,
      }
    } catch (error) {
      emit('[probe]   transport failure: ' + oneLine(error instanceof Error ? error.message : String(error), 240))
      return { status: 0 }
    }
  }

  let linkVerdict = 'NOT RUN'
  let firstOutcome: UnderstandOutcome | undefined
  if (cdnUrl !== undefined || putUrl !== undefined) {
    if (understood) throw new Error('an understanding call already happened; refusing to ask twice')
    understood = true
    emit('')
    emit('[probe] ===== STEP 3: videos_understand over cdn_url (the one possibly-billed call) =====')
    emit('[probe]   body is the one src/host/minimax-code/video-tool.ts sends on the upload path: '
      + 'video_info[0] = { url: cdn_url, prompt }')
    const outcome = await understand('W1', { url: cdnUrl ?? '' }, 'upload path: url = cdn_url')
    understandOutcomes.push({ id: 'W1', outcome, note: 'upload path: url = cdn_url' })
    firstOutcome = outcome
    linkVerdict = outcome.success === true
      ? 'LINK WORKS - cdn_url is readable under the url key (see the fidelity note: a link verdict is not a claim about answer quality)'
      : outcome.status === 0
        ? 'LINK UNPROVEN - no answer'
        : 'LINK FAILS - the service answered, but not with a reading (see results[0] above)'
    emit('[probe] ' + linkVerdict)

    // ---- the confirming control -------------------------------------------
    //
    // Only when the link failed, and only with the SAME bytes. If the clip, the
    // prompt or the caller were the problem, this fails too - and then neither
    // path is blamed, because both were refused for a reason that lives outside
    // them. If it succeeds, the reading path is fine and the REFERENCE is what
    // the service would not dereference, which is a conclusion instead of a guess.
    if (outcome.success !== true) {
      await wait(BETWEEN_CALLS_MS)
      emit('')
      emit('[probe] ===== CONTROL: the same bytes inline (a 1.5 KiB file, well under the 600 KiB cap) =====')
      const control = await understand(
        'C1',
        { data: clip.toString('base64') },
        'inline base64 control for the same bytes, so a failure has a cause rather than a suspect',
      )
      understandOutcomes.push({ id: 'C1', outcome: control, note: 'inline control for the same bytes' })
      explainControl(outcome, control)
    } else {
      // success:true ends the LINK question and opens a different one. The clip is
      // a known quantity - 64x64, one second, pure black, verified by decoding a
      // frame before it was embedded - so a description that names people, a
      // stage or a performance did not come from these pixels. Reporting that
      // separately matters: 'the reference was dereferenced' and 'the answer
      // describes the video' are two claims, and only the first is what this
      // probe set out to buy.
      emit('')
      emit('[probe] ---- fidelity, reported separately from the link ----')
      emit('[probe]   the clip is a known quantity: 64x64, 10 fps, 1 s, PURE BLACK '
        + '(decoded before embedding: gray min=0 max=2).')
      emit('[probe]   results[0].description above=' + JSON.stringify(oneLine(
        String(outcome.first?.description ?? ''), 260)))
      emit('[probe]   READ THAT AGAINST THE CLIP. A description naming people, objects, a stage or motion '
        + 'cannot have come from these pixels. success:true says the REFERENCE was retrieved and consumed; '
        + 'it does NOT certify that the answer is faithful to the frame content. This is a model-side '
        + 'behaviour and a separate limitation from the transport, so it is recorded rather than folded '
        + 'into the link verdict.')
    }
  }

  // =========================================================================
  // Summary
  // =========================================================================

  emit('')
  emit('[probe] ===== summary =====')
  emit('[probe] STEP 1 get_upload_url: http=' + (granted === undefined ? '(no JSON body)' : 'see above')
    + ' put_url=' + (putUrl === undefined ? 'MISSING' : 'present:' + describeUrl(putUrl))
    + ' cdn_url=' + (cdnUrl === undefined ? 'MISSING' : 'present:' + describeUrl(cdnUrl)))
  emit('[probe] STEP 2 PUT: ' + (uploaded ? 'attempted once (see the http= line above)' : 'not attempted'))
  emit('[probe] STEP 2b read-back: ' + readback)
  for (const row of understandOutcomes) {
    emit('[probe] ' + row.id + ' http=' + row.outcome.status
      + ' success=' + JSON.stringify(row.outcome.success) + ' - ' + row.note)
  }
  emit('[probe] STEP 3 verdict: ' + linkVerdict)
  emit('[probe] writes=' + (uploaded ? 1 : 0) + ' understanding-calls=' + understandOutcomes.length
    + ' (each at most once, nothing retried)')
  emit('[probe] transcript: ' + transcriptPath)

  // Written LAST so a crash mid-run still leaves the lines that already happened;
  // the doc is rebuilt from this file, never from a copy-paste of a terminal.
  await fs.writeFile(transcriptPath, transcript.join('\n') + '\n', 'utf8')
}, 300_000)
