/**
 * One-shot probe: what the live international gateway actually does with the
 * conversation header group, and what its `11128` means there.
 *
 * Why this probe reports instead of asserting a fix: issue #56 claims the
 * gateway refuses every chat request that omits the conversation headers
 * (`X-Conversation-ID` and friends) with `400 code 11128`, and that they are the
 * minimal sufficient set. Measured on the machine this was developed on, that
 * did NOT reproduce — the pre-fix header set was already accepted — so the
 * honest output is the differential itself, not a green tick that would read as
 * "the fix works" either way.
 *
 * It therefore prints, against the real `www.workbuddy.ai` endpoint:
 *   1. the request with the pre-fix header set (identity only),
 *   2. the same request with the conversation group added,
 *   3. a user-first history, which is the reading of `11128` that IS live here.
 *
 * If (1) and (2) both answer 200 the gate is not being applied to this account,
 * and the header group is an alignment with the official client rather than a
 * reproduced fix. If (1) answers 400 `conversation id missing` and (2) answers
 * 200, the report is confirmed on this account.
 *
 * Reads a live credential from the real auth directory and sends one-token
 * requests, so it never runs in the normal suite or in CI.
 *
 * Run: npx vitest run --config vitest.probe.config.ts scripts/probe-workbuddy-channel.probe.ts
 */
import { test } from 'vitest'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { scanCredentials } from '../src/host/workbuddy/token-store.ts'
import { workBuddyHeaders } from '../src/host/workbuddy/client.ts'
import { CHAT_PATH, isIntlDomain } from '../src/host/workbuddy/types.ts'

const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

/** The five headers issue #56 reports as the minimal sufficient set. */
const CONVERSATION_HEADERS = [
  'x-conversation-id',
  'x-conversation-request-id',
  'x-conversation-message-id',
  'x-request-id',
  'acp-connection-id',
] as const

const SYSTEM_FIRST = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'ping' },
]
const USER_FIRST = [{ role: 'user', content: 'ping' }]

test('report the live channel verdict for the conversation header group', async () => {
  const credentials = (await scanCredentials()).find((entry) => isIntlDomain(entry.domain))
  if (credentials === undefined) {
    console.log('no international credential in the auth directory; probe skipped')
    proxy.dispose()
    return
  }

  const post = async (label: string, messages: unknown[], headers: Record<string, string>): Promise<string> => {
    const response = await fetchFn(`${credentials.backend}${CHAT_PATH}`, {
      method: 'POST',
      headers: { ...headers, accept: 'text/event-stream' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages, stream: true, max_tokens: 1 }),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text().catch(() => '')
    const code = /"code"\s*:\s*(\d+)/.exec(text)?.[1] ?? '-'
    const msg = /"msg"\s*:\s*"([^"]*)"/.exec(text)?.[1] ?? '-'
    const verdict = `status=${response.status} code=${code} msg=${msg}`
    console.log(`${label.padEnd(34)} ${verdict}`)
    return verdict
  }

  // The pre-fix header set is reconstructed by deleting the group off the fixed
  // builder, so the two differ in exactly the five headers under test.
  const withGroup = workBuddyHeaders(credentials, { 'user-agent': 'CLI/2.63.2 CodeBuddy/2.63.2' }, { sessionId: 'probe-1' })
  const withoutGroup: Record<string, string> = { ...withGroup }
  for (const name of CONVERSATION_HEADERS) delete withoutGroup[name]

  console.log(`\n===== ${credentials.backend}${CHAT_PATH} =====`)
  const baseline = await post('system-first, pre-fix headers', SYSTEM_FIRST, withoutGroup)
  const fixed = await post('system-first, conversation group', SYSTEM_FIRST, withGroup)
  await post('user-first, pre-fix headers', USER_FIRST, withoutGroup)

  // A second turn of the same session: the scoped ids must repeat, which is the
  // part of the official client's behaviour the fix mirrors.
  const secondTurn = workBuddyHeaders(credentials, { 'user-agent': 'CLI/2.63.2 CodeBuddy/2.63.2' }, { sessionId: 'probe-1' })
  await post('same session, second turn', SYSTEM_FIRST, secondTurn)
  console.log(`conversation id stable across turns: ${withGroup['x-conversation-id'] === secondTurn['x-conversation-id']}`)
  console.log(`per-request id fresh across turns:   ${withGroup['x-request-id'] !== secondTurn['x-request-id']}`)
  console.log(
    baseline.startsWith('400') && fixed.startsWith('200')
      ? 'VERDICT: the gate is applied to this account — report #56 reproduced.'
      : 'VERDICT: the gate is NOT applied to this account — #56 did not reproduce; the group is alignment only.',
  )

  proxy.dispose()
})
