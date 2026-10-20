/**
 * Live probe: can videos_understand describe a REAL video CORRECTLY?
 *
 * WHY THIS FILE EXISTS. docs/minimax-video-upload-probe.md section 6 left one
 * question open, and it is the only one that decides whether this feature is
 * usable by a person:
 *
 *   - success:true does NOT prove the bytes were decoded. The sibling probe
 *     uploaded filler bytes and the service answered with a confident, invented
 *     description; docs/minimax-video-free-checks.md records runs over the same
 *     black frames answering "stage acrobatics", "tiger tabby", "purple onion",
 *     "samoyed" - three different animals for the same pixels.
 *   - EVERY understanding call measured so far was fed synthetic or garbage
 *     bytes. Not one of them ever saw a real clip with known content.
 *
 * So the product claim - "feed it a video, get an accurate description" - has
 * never been tested at all. It is tested here, once.
 *
 * THE MATERIAL IS A REAL, PUBLIC, CONTENT-KNOWN CLIP. 'flower.mp4' from MDN's
 * CC0 media set: a red-orange flower with pink-edged succulent leaves, opening
 * over five seconds. Chosen because the content is unambiguous AND it MOVES - a
 * flower that opens across the clip is a temporal claim a still frame cannot
 * satisfy, so "did it read the pixels" and "did it describe them" are separable.
 * The probe re-downloads it every run and fingerprints it (bytes, head16, ftyp
 * brand, sha256), so the material is identified by content rather than by name.
 *
 * THE PATH IS THE ONE ALREADY PROVEN TO WORK, so this run spends NOTHING on
 * generation: get_upload_url -> PUT -> cdn_url -> videos_understand. A third
 * party public URL is refused by the service ("video_info.url could not be used
 * as a media source"), so the clip has to travel through the broker's own CDN
 * first. That is one free GET (the public source), one real PUT, and one
 * understanding call - exactly once each, with module-level guards making a
 * second attempt impossible rather than discouraged.
 *
 * NO VIDEO IS GENERATED. Generating one is what the sibling probe spends
 * credits on, and the question here is description fidelity, not clip quality.
 *
 * NOTHING IDENTIFYING IS PRINTED. The access token, the address, the account id
 * and the realUserID never reach a log line; cdn_url embeds 'u<18 digits>' in
 * its PATH, which is SHORTER than scrub()'s 32-character catch-all, so scrub()
 * keeps the explicit rule for it. URLs are reported by SHAPE only - scheme,
 * host, segment count, extension, query KEY NAMES - because a signed URL carries
 * its credential in the query string.
 *
 * WHAT THE VERDICT IS. results[0].success is reported, but it is NOT the
 * verdict: this file exists because that flag was already proven true for bytes
 * no model could read. The verdict is whether the returned prose MATCHES THE
 * CLIP. A keyword cross-check is printed as an AID - expected content words
 * against words that could only come from somewhere else - and the probe then
 * says, in its own output, that a human must read the two side by side.
 * Fabrication is the finding worth having: a false "success" reading would
 * charge a user for an invented description of their own video.
 *
 * Run: npx vitest run --config vitest.probe.config.ts probe-minimax-video-fidelity
 */
import { test } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { MinimaxCodeCredentialStore } from '../src/host/minimax-code/token-store.ts'
import { MinimaxCodeAccountPool } from '../src/host/minimax-code/account-pool.ts'
import { matrixRequestHeaders, matrixToolUrl } from '../src/host/minimax-code/matrix-client.ts'
import type { MinimaxCodeRegion } from '../src/shared/minimax-code-contracts.ts'

/** One broker call. Cheap, and bounded so a hung probe cannot eat the run. */
const FREE_TIMEOUT_MS = 45_000
/** The public GET of a ~1.1 MB clip. Generous enough for a slow mirror. */
const DOWNLOAD_TIMEOUT_MS = 90_000
/** One PUT of ~1.1 MB - over seven hundred times the sibling probe's 1.5 KiB. */
const PUT_TIMEOUT_MS = 180_000
/** The understanding call. The model decodes five seconds of real footage. */
const UNDERSTAND_TIMEOUT_MS = 180_000
/** A read-back of the uploaded object, to prove the CDN copy is byte-identical. */
const READBACK_TIMEOUT_MS = 60_000
/** Pause between calls: a burst is how a rate limit gets mistaken for a verdict. */
const BETWEEN_CALLS_MS = 800

/**
 * The prompt the brief specifies, sent verbatim.
 *
 * The product's own default is '描述这个视频的内容' (video-tool.ts,
 * DEFAULT_UNDERSTAND_PROMPT). The two ask the same thing - describe the video -
 * so the fidelity verdict does not hinge on the difference, and only ONE
 * understanding call is allowed, so both cannot be asked. The brief's wording
 * wins because it is the explicit instruction.
 */
const PROMPT = '描述这个视频里发生了什么'

/** One candidate source clip. */
interface Candidate {
  /** Short id used in the transcript. */
  readonly id: string
  /** Public URL of the clip. */
  readonly url: string
  /** What a person sees in it, established before the run. */
  readonly expect: string
}

/**
 * Candidate clips, tried in order until one downloads.
 *
 * All CC0 or explicitly public sample material, all with content a person can
 * name at a glance. The order is the brief's: the flower first, because a flower
 * is a subject no other genre of footage gets mistaken for.
 */
const CANDIDATES: readonly Candidate[] = [
  {
    id: 'mdn-flower',
    url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    expect: 'a red-orange flower with pink-green leaves, opening over five seconds',
  },
  {
    id: 'w3schools-bbb',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4',
    expect: 'a Big Buck Bunny excerpt: 3D animated animals in a meadow',
  },
]

/**
 * Words that can only have come from THIS clip.
 *
 * A cross-check, not a judge: a description can score 0 here and still be a
 * correct paraphrase, and a model can emit "flower" from the prompt alone. It is
 * printed so the human verdict that follows has numbers beside it instead of a
 * memory of what the answer felt like.
 */
const EXPECTED_TOKENS: readonly string[] = [
  '花', 'flower', 'bloom', 'blossom', 'petal', '花瓣',
  '植物', 'plant', '叶', 'leaf', 'leaves', '茎', 'stem',
  '红', '橙', 'red', 'orange', '绿', 'green',
  '微距', 'macro', '特写', 'close-up', 'closeup',
  '开', 'open', '绽放', 'bud', '苞',
]

/**
 * Words that CANNOT come from a macro shot of a flower on a mossy surface.
 *
 * Kept narrow on purpose: "motion", "camera" and "light" are legitimate for this
 * clip, so only subjects of a different KIND of footage appear here. A hit is
 * evidence of an invented subject rather than of a loose paraphrase.
 */
const IMPOSSIBLE_TOKENS: readonly string[] = [
  '街道', 'street', '城市', 'city', '建筑', 'building',
  '人脸', '人物', 'person', 'people', 'man', 'woman', 'girl', 'boy',
  '舞台', 'stage', '表演', 'performance', '舞蹈', 'dance', '杂技', 'acrobat',
  '汽车', 'car', 'vehicle',
  '动物', 'animal', '猫', 'cat', '狗', 'dog', '兔', 'rabbit', 'bunny', 'tiger', '虎',
  '洋葱', 'onion', '食物', 'food', '厨房', 'kitchen',
]

const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

// ---------------------------------------------------------------------------
// Redaction - copied verbatim from probe-minimax-video-upload.probe.ts, so every
// probe in this repo scrubs identically; two different scrubbers is two
// different disclosure bugs.
// ---------------------------------------------------------------------------

/**
 * Text that is safe to put in a log line.
 *
 * What is removed is only ever something that could name a person or a session -
 * an address, a UUID, a JWT, a long opaque run. Wording is kept, because the
 * wording is half the evidence.
 */
function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<address>')
    .replace(/eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){0,2}/g, '<token>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    // The account id this surface embeds in OSS object keys and CDN paths:
    // 'u' followed by ~18 digits. SHORTER than the 32-character catch-all below,
    // so without this rule it sails through the scrubber looking like an
    // ordinary opaque run - and cdn_url is the field this probe reads.
    .replace(/\bu\d{12,}\b/g, '<user-id>')
    .replace(/[A-Za-z0-9_-]{32,}/g, (run) => '<redacted:' + run.length + '>')
}

/**
 * Replace every URL inside arbitrary text with its SHAPE.
 *
 * Runs FIRST for every output line: scrub() alone does not remove a URL, it only
 * eats opaque runs, and a URL is a run of punctuation and segments - so the
 * signature would survive looking perfectly ordinary.
 */
function redactUrls(text: string): string {
  // The character class deliberately ALLOWS a backslash: a body echoed through
  // JSON.stringify escapes '&' as its unicode escape, and stopping at the
  // backslash would leave the rest of the signed query verbatim.
  return text.replace(/https?:\/\/[^\s"'<>]+/g, (match) => describeUrl(match))
}

function oneLine(text: string, limit = 400): string {
  const flat = scrub(redactUrls(text)).replace(/[\r\n\t]+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '...' : flat
}

/**
 * A URL, reported by SHAPE and never by value.
 *
 * A signed media URL carries its credential in the query string. Scheme, host,
 * segment count, extension, path length and query KEY NAMES are the whole of the
 * evidence anyway: whether the address carries a signature, under which
 * parameter, and whether it is the same shape that already works.
 */
function describeUrl(text: string): string {
  try {
    // A JSON-escaped ampersand is the same separator once decoded; normalising
    // it keeps the reported query-KEY list complete.
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
 * The REQUEST body needs the same treatment as the response body: the
 * understanding call carries cdn_url and the broker answer carries put_url,
 * whose query string holds both the access key id and the signature.
 */
function echoBody(body: unknown): string {
  const walked = JSON.stringify(body, (_key, value: unknown) => {
    if (typeof value !== 'string') return value
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
 * The PATH is the point: 'there is a string somewhere' does not tell a reader
 * which key to read, and an unexpected key is exactly what a probe is for.
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
 * Where the transcript goes.
 *
 * os.tmpdir() is normally the answer, but it can resolve to a RELATIVE
 * 'undefined/temp' when TEMP/TMP is absent from the process env - which silently
 * creates a stray directory inside the repository. Checking that the answer is
 * absolute keeps this run's own artifacts out of the working tree, which is a
 * hard requirement for this probe.
 */
function resolveScratchDir(): string {
  const candidates = [
    os.tmpdir(),
    process.env.TEMP,
    process.env.TMP,
    process.env.LOCALAPPDATA === undefined ? undefined : path.join(process.env.LOCALAPPDATA, 'Temp'),
    '/tmp',
  ]
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') continue
    if (!path.isAbsolute(candidate)) continue
    return candidate
  }
  return path.resolve('.')
}

// ---------------------------------------------------------------------------
// Material provenance helpers
// ---------------------------------------------------------------------------

/**
 * Find an ffmpeg binary, if this machine has one.
 *
 * Provenance is OPTIONAL here: the fingerprints already identify the file by
 * content, and a missing decoder must not fail a probe whose actual job is the
 * upload. When one is present, its output is recorded - duration, frame size,
 * codec - because "5.06 s, 960x540, H.264" is the kind of fact a reader can
 * check against the description, while "it is a video" is not.
 */
async function findFfmpeg(): Promise<string | undefined> {
  const configured = process.env.PROBE_FFMPEG
  const candidates = [
    ...(configured === undefined ? [] : [configured]),
    'ffmpeg',
    'C:\\Program Files\\ImageMagick-7.0.8-Q8\\ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ]
  for (const candidate of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(candidate, ['-version'], { stdio: 'ignore', windowsHide: true })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    })
    if (ok) return candidate
  }
  return undefined
}

/** Run a command and collect stdout+stderr, bounded, without a shell. */
function run(binary: string, args: readonly string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args], { windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { if (output.length < 20_000) output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { if (output.length < 20_000) output += chunk.toString('utf8') })
    child.on('error', () => resolve({ code: -1, output: '' }))
    child.on('close', (code) => resolve({ code: code ?? -1, output }))
  })
}

/**
 * What the material IS, in words the reader can hold against the answer.
 *
 * Written from the FRAMES, not from the file name: the first, middle and last
 * frames were extracted and looked at before this probe was run, and the
 * description below is that inspection. It is a CONSTANT because the claim under
 * test is "the service describes this clip", and the clip is the same CC0 object
 * every run - its sha256 is printed beside it so a reader can tell the material
 * did not drift underneath the verdict.
 */
const MATERIAL_DESCRIPTION =
  'A MACRO SHOT OF A SINGLE RED-ORANGE FLOWER on a slender green stem, with '
  + 'fleshy leaves that are green in the middle and PINK/PURPLE along their '
  + 'edges, against a dark blurred background (mossy soil, a few blurred buds). '
  + 'Across the 5 seconds the flower OPENS: it starts as a closed reddish bud and '
  + 'the petals spread outward and brighten, revealing yellow stamens at the '
  + 'centre. One continuous static close-up, no cuts, no people, no animals, no '
  + 'text.'

/** Which tokens of a list appear in a text, case-insensitively. */
function hits(text: string, tokens: readonly string[]): string[] {
  const lower = text.toLowerCase()
  return tokens.filter((token) => lower.includes(token.toLowerCase()))
}

/**
 * Whether a body carries a task_id anywhere a payload field could sit.
 *
 * Checked on EVERY call. A task_id means the request was queued as work with a
 * lifecycle - a generation to poll - and this probe is not authorised to spend
 * generation quota, so the honest response to seeing one is to stop.
 */
function hasTaskId(body: Record<string, unknown> | undefined): boolean {
  if (body === undefined) return false
  for (const scope of [body, asRecord(body.data), asRecord(body.result)]) {
    if (scope === undefined) continue
    const value = scope.task_id ?? scope.taskId
    if (typeof value === 'string' && value.trim() !== '') return true
    if (typeof value === 'number') return true
  }
  return false
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Mirror every log line into a file as well as stdout.
 *
 * The evidence IS this transcript, and a console-only run loses it the moment
 * the terminal buffer scrolls. Redaction happens in oneLine(), upstream of both
 * sinks, so the file and the terminal hold the same bytes.
 */
const scratchDir = resolveScratchDir()
const transcriptPath = path.join(scratchDir, 'minimax-video-fidelity-probe-transcript.log')
const clipPath = path.join(scratchDir, 'minimax-video-fidelity-clip.mp4')
const transcript: string[] = []
const emit = (line: string): void => {
  console.log(line)
  transcript.push(line)
}

test('minimax understand fidelity: a real CC0 clip, uploaded once and described once', async () => {
  // Module-level guards, not reminders. A second PUT is a second write the brief
  // forbids and a second understanding call is a second possible charge; the only
  // way to be sure neither happens is to make it impossible in code.
  let uploaded = false
  let understood = false

  await fs.mkdir(scratchDir, { recursive: true })
  emit('[probe] scratch=' + scratchDir)

  const pool = new MinimaxCodeAccountPool({ store: new MinimaxCodeCredentialStore() })
  let credentials: { accessToken: string; region: MinimaxCodeRegion }
  try {
    const picked = await pool.getCredentialAccount(fetchFn)
    credentials = { accessToken: picked.credentials.accessToken, region: picked.credentials.region }
  } catch (error) {
    emit('[probe] NO CREDENTIAL - fidelity is unmeasurable: '
      + oneLine(error instanceof Error ? error.message : String(error), 300))
    await fs.writeFile(transcriptPath, transcript.join('\n') + '\n', 'utf8')
    return
  }
  const { accessToken, region } = credentials
  emit('[probe] region=' + region)
  emit('[probe] token=<present:len=' + accessToken.length + '> (never printed)')

  // =========================================================================
  // STEP 0 - obtain the real clip and prove what it is
  // =========================================================================

  emit('')
  emit('[probe] ===== STEP 0: the material (a free GET, not a generation) =====')
  let clip: Buffer | undefined
  let chosen: Candidate | undefined
  for (const candidate of CANDIDATES) {
    emit('[probe]   trying ' + candidate.id + ' ' + describeUrl(candidate.url))
    try {
      const started = Date.now()
      // redirect: 'follow' - a CDN mirror may move, and this is a public CC0
      // asset with no credential in the URL, so following is safe here in a way
      // it would not be for a signed target.
      const response = await fetchFn(candidate.url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      }) as unknown as Response
      const bytes = Buffer.from(await response.arrayBuffer())
      emit('[probe]   http=' + response.status
        + ' content-type=' + JSON.stringify(response.headers.get('content-type') ?? '(none)')
        + ' bytes=' + bytes.length
        + ' ms=' + (Date.now() - started)
        + ' final-url=' + describeUrl(response.url === '' ? candidate.url : response.url))
      // A real video, not an error page: an ISO BMFF file carries 'ftyp' at
      // offset 4. An HTML refusal fails that test, and uploading one would
      // measure the wrong thing while looking like a successful run.
      const brand = bytes.length >= 12 ? bytes.subarray(4, 8).toString('latin1') : ''
      if (!response.ok || brand !== 'ftyp' || bytes.length < 100_000) {
        emit('[probe]   REJECTED as material: http=' + response.status
          + ' ftyp=' + JSON.stringify(brand) + ' bytes=' + bytes.length
          + ' (an error page or a stub is not a video)')
        continue
      }
      clip = bytes
      chosen = candidate
      break
    } catch (error) {
      emit('[probe]   download failed: ' + oneLine(error instanceof Error ? error.message : String(error), 240))
    }
  }

  if (clip === undefined || chosen === undefined) {
    emit('[probe] NO MATERIAL - every candidate was refused, so nothing can be uploaded and no fidelity '
      + 'verdict is possible. That is a fact about the network, not about the service.')
    await fs.writeFile(transcriptPath, transcript.join('\n') + '\n', 'utf8')
    return
  }

  await fs.writeFile(clipPath, clip)
  const digest = crypto.createHash('sha256').update(clip).digest('hex')
  const boxes: string[] = []
  for (let offset = 0; offset + 8 <= clip.length;) {
    const size = clip.readUInt32BE(offset)
    const type = clip.subarray(offset + 4, offset + 8).toString('latin1')
    boxes.push(type + '@' + offset + '=' + size)
    if (size < 8) break
    offset += size
  }
  emit('')
  emit('[probe] ===== the material, identified by content =====')
  emit('[probe]   chosen=' + chosen.id + ' source=' + describeUrl(chosen.url))
  emit('[probe]   expected content (established by looking at the frames): ' + chosen.expect)
  emit('[probe]   clip bytes=' + clip.length
    + ' sha256=' + digest
    + ' head16=' + clip.subarray(0, 16).toString('hex')
    + ' brand=' + JSON.stringify(clip.subarray(4, 8).toString('latin1')))
  emit('[probe]   top-level boxes: ' + boxes.join(' '))
  emit('[probe]   saved to ' + clipPath + ' so the exact bytes stay re-inspectable')

  // ---- 0b. technical provenance, when a decoder exists ---------------------
  const ffmpeg = await findFfmpeg()
  if (ffmpeg === undefined) {
    emit('[probe]   no ffmpeg on this machine - duration/codec not read. The fingerprints above still '
      + 'identify the file; the visual description is recorded as a constant.')
  } else {
    emit('[probe]   ffmpeg=' + ffmpeg)
    const probeRun = await run(ffmpeg, ['-hide_banner', '-i', clipPath])
    for (const line of probeRun.output.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.startsWith('Duration:') || trimmed.includes('Stream #')) {
        emit('[probe]   ffmpeg| ' + oneLine(trimmed, 220))
      }
    }
    // One frame, at the midpoint, written beside the transcript: the evidence
    // that the described thing really is in the pixels is a PICTURE.
    const framePath = path.join(scratchDir, 'minimax-video-fidelity-frame.jpg')
    const frameRun = await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', '2.0', '-i', clipPath, '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2', framePath,
    ])
    emit('[probe]   frame@2.0s: '
      + (frameRun.code === 0 ? 'written to ' + framePath : 'not extracted (code=' + frameRun.code + ')'))
  }

  // =========================================================================
  // STEP 1 - ask the broker for a target
  // =========================================================================

  emit('')
  emit('[probe] ===== STEP 1: get_upload_url =====')
  const uploadBody = { filename: path.basename(clipPath), mime_type: 'video/mp4', size_bytes: clip.length }
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
    emit('[probe]   top-level keys: ['
      + (granted === undefined ? '(not a JSON object)' : Object.keys(granted).join(',')) + ']')
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

  // ---- the task_id discipline ---------------------------------------------
  //
  // A task_id on THIS route would mean the call was queued as a GENERATION. The
  // brief forbids generating, and a queued generation is a charge this probe was
  // never authorised to make, so the run stops here rather than continuing to a
  // PUT whose object nothing would ever read.
  if (hasTaskId(granted)) {
    emit('[probe] ABORT: step 1 answered with a task_id. That is a generation task, and this probe must '
      + 'not spend generation quota. No PUT, no understanding call.')
    await fs.writeFile(transcriptPath, transcript.join('\n') + '\n', 'utf8')
    return
  }

  const putUrl = firstString(granted, ['put_url'])
  const cdnUrl = firstString(granted, ['cdn_url'])
  const echoContentType = firstString(granted, ['content_type'])
  emit('[probe] put_url: ' + (putUrl === undefined ? '(MISSING)' : describeUrl(putUrl)))
  emit('[probe] cdn_url: ' + (cdnUrl === undefined ? '(MISSING)' : describeUrl(cdnUrl)))
  emit('[probe] content_type echoed by the broker: ' + JSON.stringify(echoContentType))
  emit('[probe] expires_in: ' + JSON.stringify(granted?.expires_in))

  // =========================================================================
  // STEP 2 - one real PUT of the real bytes
  // =========================================================================

  let readback = 'skipped (no cdn_url)'
  if (putUrl === undefined || cdnUrl === undefined) {
    emit('')
    emit('[probe] ===== STEP 2: PUT - SKIPPED =====')
    emit('[probe] the broker did not return both put_url and cdn_url, so there is nothing to write to and '
      + 'nothing to cite. Steps 2 and 3 cannot run, and that is a verdict in itself.')
  } else if (uploaded) {
    throw new Error('a PUT already happened; refusing to write twice')
  } else {
    uploaded = true
    emit('')
    emit('[probe] ===== STEP 2: PUT (the one real write) =====')
    // The broker echoes the content type it expects; the declared one is the
    // fallback, which is exactly what uploadLocalVideo() does.
    const putContentType = echoContentType ?? uploadBody.mime_type
    emit('[probe]   PUT ' + describeUrl(putUrl) + ' content-type=' + JSON.stringify(putContentType)
      + ' bytes=' + clip.length + ' (a real clip, ~' + Math.round(clip.length / 1024) + ' KiB)')
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
    // Free, and it proves the CDN copy is BYTE-IDENTICAL to the file measured
    // above. Without it a wrong answer could be explained away as "the upload
    // mangled the clip", and this probe would have no way to say which side was
    // at fault.
    emit('')
    emit('[probe] ---- 2b. read-back over cdn_url (no auth) ----')
    try {
      const back = await fetchFn(cdnUrl, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(READBACK_TIMEOUT_MS),
      }) as unknown as Response
      const backBytes = Buffer.from(await back.arrayBuffer().catch(() => new ArrayBuffer(0)))
      const backDigest = crypto.createHash('sha256').update(backBytes).digest('hex')
      readback = 'http=' + back.status
        + ' content-type=' + JSON.stringify(back.headers.get('content-type') ?? '(none)')
        + ' content-length=' + JSON.stringify(back.headers.get('content-length') ?? '(none)')
        + ' bytes=' + backBytes.length
        + ' sha256=' + backDigest
        + ' matches-upload=' + (backDigest === digest)
      emit('[probe]   ' + readback)
    } catch (error) {
      readback = 'transport failure: ' + oneLine(error instanceof Error ? error.message : String(error), 200)
      emit('[probe]   read-back failed: ' + readback)
    }
  }

  // =========================================================================
  // STEP 3 - one understanding call over the real clip
  // =========================================================================

  let description = ''
  let successValue: unknown
  let sourceValue = ''
  let errorValue = ''
  let status = 0

  if (cdnUrl === undefined) {
    emit('')
    emit('[probe] ===== STEP 3: videos_understand - SKIPPED (no cdn_url) =====')
  } else if (understood) {
    throw new Error('an understanding call already happened; refusing to ask twice')
  } else {
    understood = true
    await wait(BETWEEN_CALLS_MS)
    emit('')
    emit('[probe] ===== STEP 3: videos_understand over cdn_url (the one possibly-billed call) =====')
    const body = { video_info: [{ url: cdnUrl, prompt: PROMPT }] }
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
      status = response.status
      const raw = await response.text().catch(() => '')
      emit('[probe]   http=' + response.status
        + ' content-type=' + JSON.stringify(response.headers.get('content-type') ?? '(none)')
        + ' ms=' + (Date.now() - started) + ' bodyBytes=' + Buffer.byteLength(raw))
      let parsed: unknown
      try {
        parsed = raw.trim() === '' ? undefined : JSON.parse(raw) as unknown
      } catch {
        parsed = undefined
      }
      const parsedBody = asRecord(parsed)
      const base = baseRespOf(parsed)
      emit('[probe]   top-level keys: ['
        + (parsedBody === undefined ? '(not a JSON object)' : Object.keys(parsedBody).join(',')) + ']')
      emit('[probe]   base_resp: ' + (base.statusCode === undefined && base.statusMsg === undefined
        ? '(absent)'
        : 'status_code=' + JSON.stringify(base.statusCode) + ' status_msg=' + JSON.stringify(base.statusMsg)))
      emit('[probe]   top-level code: ' + JSON.stringify(parsedBody?.code))
      emit('[probe]   raw body (scrubbed, urls shaped): ' + oneLine(raw, 1200))

      if (hasTaskId(parsedBody)) {
        emit('[probe] ABORT: videos_understand answered with a task_id. This route is synchronous, so a '
          + 'task_id means something other than a reading is running - and it may be billable. Stopping.')
        await fs.writeFile(transcriptPath, transcript.join('\n') + '\n', 'utf8')
        return
      }

      const results = parsedBody?.results
      const first = Array.isArray(results) ? asRecord(results[0]) : undefined
      if (parsedBody !== undefined) {
        for (const field of fieldsOf(parsedBody)) {
          emit('[probe]     ' + field.path + ': ' + field.type + (field.value === '' ? '' : ' = ' + field.value))
        }
      }
      successValue = first?.success
      description = typeof first?.description === 'string' ? first.description : ''
      errorValue = typeof first?.error === 'string' ? first.error : ''
      sourceValue = typeof first?.source === 'string' ? first.source : ''
      emit('[probe]   results[0].success=' + JSON.stringify(successValue))
      emit('[probe]   results[0].error=' + JSON.stringify(oneLine(errorValue, 500)))
      emit('[probe]   results[0].source='
        + JSON.stringify(isUrl(sourceValue) ? describeUrl(sourceValue) : oneLine(sourceValue, 120)))
      if (first !== undefined) {
        emit('[probe]   results[0] COMPLETE, every key verbatim (scrubbed): '
          + echoBody(Object.fromEntries(Object.entries(first).map(([key, value]) => [
            key,
            typeof value === 'string' && value.length > 1200 ? oneLine(value, 1200) : value,
          ]))))
      }
    } catch (error) {
      emit('[probe]   transport failure: ' + oneLine(error instanceof Error ? error.message : String(error), 240))
    }
  }

  // =========================================================================
  // THE VERDICT - is the description TRUE OF THE CLIP?
  // =========================================================================

  emit('')
  emit('[probe] ===== FIDELITY: does the description match the clip? =====')
  emit('[probe]   results[0].success=' + JSON.stringify(successValue)
    + '  (reported, but this flag is NOT the verdict - it was already measured true for filler bytes)')
  emit('[probe]   the clip really is: ' + MATERIAL_DESCRIPTION)
  emit('[probe]   the service said:    ' + (description === '' ? '(empty)' : oneLine(description, 900)))

  if (description === '') {
    emit('[probe]   VERDICT: NO DESCRIPTION RETURNED. Nothing can be judged faithful or unfaithful; the call '
      + 'produced no reading to compare. error=' + JSON.stringify(oneLine(errorValue, 400)))
  } else {
    const expected = hits(description, EXPECTED_TOKENS)
    const impossible = hits(description, IMPOSSIBLE_TOKENS)
    emit('[probe]   content words that COULD come from this clip: [' + expected.join(',') + '] ('
      + expected.length + ' of ' + EXPECTED_TOKENS.length + ')')
    emit('[probe]   content words that CANNOT come from this clip: [' + impossible.join(',') + '] ('
      + impossible.length + ')')
    emit('[probe]   NOTE: these counts are an AID, not the verdict. A correct paraphrase can score zero, '
      + 'and a model can say "flower" from the prompt alone. The verdict is a human reading the sentence '
      + 'above against the sentence above that.')
    emit('[probe]   A description naming people, a stage, a street, a kitchen or an animal did not come from '
      + 'these pixels: that is fabrication, and it would be the same finding the garbage-byte runs produced, '
      + 'now measured on REAL footage.')
  }

  // =========================================================================
  // Summary
  // =========================================================================

  emit('')
  emit('[probe] ===== summary =====')
  emit('[probe] MATERIAL: ' + chosen.id + ' ' + clip.length + ' bytes sha256=' + digest)
  emit('[probe] STEP 1 get_upload_url: put_url='
    + (putUrl === undefined ? 'MISSING' : 'present:' + describeUrl(putUrl))
    + ' cdn_url=' + (cdnUrl === undefined ? 'MISSING' : 'present:' + describeUrl(cdnUrl)))
  emit('[probe] STEP 2 PUT: ' + (uploaded ? 'attempted once (see the http= line above)' : 'not attempted'))
  emit('[probe] STEP 2b read-back: ' + readback)
  emit('[probe] STEP 3 understand: http=' + status
    + ' success=' + JSON.stringify(successValue)
    + ' descriptionChars=' + description.length)
  emit('[probe] writes=' + (uploaded ? 1 : 0) + ' understanding-calls=' + (understood ? 1 : 0)
    + ' generations=0 (each at most once, nothing retried)')
  emit('[probe] transcript: ' + transcriptPath)

  // Written LAST so a crash mid-run still leaves the lines that already happened;
  // the doc is rebuilt from this file, never from a copy-paste of a terminal.
  await fs.writeFile(transcriptPath, transcript.join('\n') + '\n', 'utf8')
}, 300_000)
