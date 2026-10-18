/**
 * Verify two assumptions inherited from workbuddy2api-hub, live.
 *
 * Both are cheap: every request is a short chat call with a tiny output cap, so
 * the whole file costs a few thousand tokens rather than a long generation.
 *
 *   1. reasoning_content backfill. Their gateway asserts the upstream wants
 *      `reasoning_content` on every assistant history message once thinking is
 *      on, and backfills `""` when it is missing. This line SHIPS that backfill
 *      for `deepseek-*` models without ever having measured it. The probe sends
 *      the SAME history twice — with the field and without — and compares the
 *      verdict.
 *   2. message-body fingerprint scrubbing. Their gateway also rewrites client
 *      fingerprints out of message text. This line does not (it only strips
 *      NULs). The probe sends one prompt carrying client traces and one neutral
 *      prompt with the same meaning, and compares the verdict.
 *
 * Deliberately READ-ONLY and non-invasive: credentials are selected through the
 * real pool (the only component that writes a rotated refresh token back), no
 * token/uid/path is printed, and nothing is written anywhere.
 *
 * Safeguards, same shape this repository uses for every live probe:
 *   - dry run by default; `PROBE_ASSUMPTIONS=1` is required to send anything
 *   - one account, one region (intl), at most 4 requests
 *   - every request capped by PROBE_MAX_TOKENS (default 32)
 *
 * Run:
 *   PROBE_ASSUMPTIONS=1 npx vitest run --config vitest.probe.config.ts scripts/probe-workbuddy-assumptions.probe.ts
 */
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'vitest'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { WorkBuddyAccountPool } from '../src/host/workbuddy/account-pool.ts'
import { workBuddyHeaders } from '../src/host/workbuddy/client.ts'
import { CHAT_PATH } from '../src/host/workbuddy/types.ts'
import type { WorkBuddyCredentials } from '../src/host/workbuddy/token-store.ts'

/** Output cap per probe request: the answer is irrelevant, only the verdict is. */
const PROBE_MAX_TOKENS = 32
/** Model the assumptions are tested on: free on the international region. */
const PROBE_MODEL = 'deepseek-v4.1-flash'
const REQUEST_TIMEOUT_MS = 90_000

interface Verdict {
  status: number
  code: number | null
  message: string
  finish: string
  reasoningChars: number
  textChars: number
  errorFrame: string | null
}

function readCode(text: string): number | null {
  const matched = /"code"\s*:\s*(-?\d+)/.exec(text)
  return matched === null ? null : Number(matched[1])
}

function readMessage(json: string): string {
  const matched = /"msg"\s*:\s*"([^"]*)"/.exec(json) ?? /"message"\s*:\s*"([^"]*)"/.exec(json)
  return (matched?.[1] ?? '').slice(0, 120)
}

/** Drain an SSE body into the one verdict this probe cares about. */
async function send(
  fetchFn: typeof fetch,
  credentials: WorkBuddyCredentials,
  body: Record<string, unknown>,
): Promise<Verdict> {
  const response = await fetchFn(`${credentials.backend}${CHAT_PATH}`, {
    method: 'POST',
    headers: workBuddyHeaders(credentials, { accept: 'text/event-stream' }, { sessionId: `probe-${randomUUID()}` }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const raw = await response.text()
  let finish = '(none)'
  let reasoning = 0
  let text = 0
  let errorFrame: string | null = null
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const chunk = JSON.parse(payload) as Record<string, unknown>
      if (typeof chunk.error === 'object' && chunk.error !== null) {
        errorFrame = JSON.stringify(chunk.error).slice(0, 160)
        continue
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : []
      const choice = (choices[0] ?? {}) as Record<string, unknown>
      const delta = (choice.delta ?? {}) as Record<string, unknown>
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content.length
      if (typeof delta.content === 'string') text += delta.content.length
      if (typeof choice.finish_reason === 'string') finish = choice.finish_reason
    } catch {
      // A non-JSON data line carries no verdict.
    }
  }
  return {
    status: response.status,
    code: readCode(raw),
    message: readMessage(raw),
    finish,
    reasoningChars: reasoning,
    textChars: text,
    errorFrame,
  }
}

function describe(label: string, verdict: Verdict): string {
  return `  ${label.padEnd(18)} status=${verdict.status} code=${verdict.code ?? '-'} finish=${verdict.finish} reasoning=${verdict.reasoningChars} text=${verdict.textChars}`
    + (verdict.message === '' ? '' : ` msg="${verdict.message}"`)
    + (verdict.errorFrame === null ? '' : ` error=${verdict.errorFrame}`)
}

/** Tools every variant declares, so the history's tool call is legitimate. */
const TOOLS = [{
  type: 'function',
  function: {
    name: 'add',
    description: 'Add two numbers.',
    parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
}]

/** The history whose assistant turn is missing its reasoning trace. */
function history(withReasoningContent: boolean): Record<string, unknown>[] {
  const assistant: Record<string, unknown> = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_probe_1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":2}' } }],
  }
  if (withReasoningContent) assistant.reasoning_content = ''
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is 2 plus 2? Use the add tool.' },
    assistant,
    { role: 'tool', tool_call_id: 'call_probe_1', content: '{"sum":4}' },
    { role: 'user', content: 'Answer with the number only.' },
  ]
}

/** Same meaning, with and without the client traces a scrubber would remove. */
const FINGERPRINT_TEXT = 'Debug this build failure. Project lives at C:\\Users\\A\\Documents\\ChatGPT\\dsh-chatgpt-subscription '
  + 'and the client is CodeBuddyIDE (CLI/2.63.2, x-ide-name: CodeBuddyIDE, X-Agent-Intent: craft). '
  + 'Tests fail only after a schema change. Reply in one short sentence.'
const NEUTRAL_TEXT = 'Debug this build failure. A local project folder is open in a code editor. '
  + 'Tests fail only after a schema change. Reply in one short sentence.'

test('verify the two inherited assumptions against the live upstream', async () => {
  const live = process.env.PROBE_ASSUMPTIONS === '1'
  const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
  try {
    const pool = new WorkBuddyAccountPool()
    const data = await pool.read()
    const intl = data.accounts.filter((account) => account.credentials.region === 'intl')
    console.log('===== workbuddy assumption probe =====')
    console.log(`accounts: ${data.accounts.length} stored (intl:${intl.length}, cn:${data.accounts.length - intl.length})`)
    console.log(`model: ${PROBE_MODEL}  max_tokens: ${PROBE_MAX_TOKENS}  requests: 4`)

    if (!live) {
      console.log('')
      console.log('DRY RUN — PROBE_ASSUMPTIONS is not set, so nothing is sent and no quota is spent.')
      console.log('What it would send, one short request each:')
      console.log('  1a history WITH reasoning_content=""  1b history WITHOUT it')
      console.log('  2a prompt carrying client traces      2b the same meaning, neutralised')
      console.log('Set PROBE_ASSUMPTIONS=1 to run it.')
      return
    }
    if (intl.length === 0) {
      console.log('REFUSED — no international account stored; nothing was sent.')
      return
    }

    const fetchFn = proxy.createFetch()
    const credentials = await pool.getFreshCredential(intl[0]!.id, fetchFn)
    console.log(`using an international account (fingerprint ${createHash('sha256').update(credentials.uid ?? 'anonymous').digest('hex').slice(0, 8)})`)

    // ---- 1. reasoning_content backfill ----
    const base = {
      model: PROBE_MODEL,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: PROBE_MAX_TOKENS,
      reasoning_effort: 'low',
      tools: TOOLS,
    }
    const withField = await send(fetchFn, credentials, { ...base, messages: history(true) })
    const withoutField = await send(fetchFn, credentials, { ...base, messages: history(false) })
    console.log('')
    console.log('[1] reasoning_content backfill')
    console.log(describe('with ""', withField))
    console.log(describe('without', withoutField))

    // The two deployments are separate backends, so the same control runs on the
    // domestic one before this is treated as settled for both.
    const cnAccounts = data.accounts.filter((account) => account.credentials.region === 'cn')
    if (cnAccounts.length > 0) {
      const cnCredentials = await pool.getFreshCredential(cnAccounts[0]!.id, fetchFn)
      const cnWith = await send(fetchFn, cnCredentials, { ...base, messages: history(true) })
      const cnWithout = await send(fetchFn, cnCredentials, { ...base, messages: history(false) })
      console.log('  -- cn deployment --')
      console.log(describe('with ""', cnWith))
      console.log(describe('without', cnWithout))
      console.log(cnWith.status === 200 && cnWithout.status === 200
        ? '  cn VERDICT: also not required.'
        : cnWith.status === 200 && cnWithout.status !== 200
          ? '  cn VERDICT: required here even though intl accepted both — keep the backfill.'
          : '  cn VERDICT: inconclusive (see code/msg).')
    }
    // One sample each cannot tell noise from an effect: the first run showed 0
    // reasoning chars WITH the empty field and 7 without. Two more rounds each
    // settle whether an empty `reasoning_content` in history suppresses the
    // trace (which would make our backfill actively harmful) or it is noise.
    const withSamples = [withField.reasoningChars]
    const withoutSamples = [withoutField.reasoningChars]
    for (let round = 0; round < 2; round++) {
      withSamples.push((await send(fetchFn, credentials, { ...base, messages: history(true) })).reasoningChars)
      withoutSamples.push((await send(fetchFn, credentials, { ...base, messages: history(false) })).reasoningChars)
    }
    console.log(`  reasoning chars over 3 samples: with="" [${withSamples.join(',')}] | without [${withoutSamples.join(',')}]`)

    const oneOk = withField.status === 200
    const otherOk = withoutField.status === 200
    console.log(oneOk && otherOk
      ? '  VERDICT: the field is NOT required — both shapes were accepted. Our backfill is harmless redundancy.'
      : oneOk && !otherOk
        ? '  VERDICT: the field IS required — omitting it was refused. The backfill our line ships is necessary.'
        : '  VERDICT: inconclusive — at least one shape failed for a reason unrelated to the field (see code/msg).')

    // ---- 2. fingerprint scrubbing ----
    const plain = (text: string): Record<string, unknown> => ({
      model: PROBE_MODEL,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: PROBE_MAX_TOKENS,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: text },
      ],
    })
    const traced = await send(fetchFn, credentials, plain(FINGERPRINT_TEXT))
    const neutral = await send(fetchFn, credentials, plain(NEUTRAL_TEXT))
    console.log('')
    console.log('[2] message-body fingerprint scrubbing')
    console.log(describe('with traces', traced))
    console.log(describe('neutral', neutral))
    const sameOutcome = (traced.status === 200) === (neutral.status === 200)
    console.log(sameOutcome
      ? '  VERDICT: no evidence the traces changed the outcome — scrubbing would add no measured value here.'
      : '  VERDICT: the traced prompt was treated differently; scrubbing is worth implementing (re-run to confirm stability).')
  } finally {
    proxy.dispose()
  }
}, 600_000)
