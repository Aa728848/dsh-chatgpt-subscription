/**
 * One-shot probe: does the MiniMax Code subscription endpoint honour explicit
 * `cache_control` breakpoints on its Anthropic Messages dialect?
 *
 * The mapper now sends breakpoints by default, but the subscription endpoint
 * (`/mavis/api/v1/llm/v1/messages`) is not the public API, and its caching
 * behaviour has never been measured. This probe settles it with two identical
 * live requests: the first should CREATE the cache, the second should READ it.
 * Both bodies are built by the real `buildMinimaxRequest`, so the probe also
 * exercises the exact bytes the adapter sends.
 *
 * Read-only with respect to the repository and the credential files (a token
 * refresh, when due, is written back the same way the adapter writes it).
 * Printed values are statuses and usage counters only — never a token.
 *
 * Run: npx vitest run --config vitest.probe.config.ts probe-minimax-cache
 */
import { test } from 'vitest'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { MinimaxCodeCredentialStore } from '../src/host/minimax-code/token-store.ts'
import { ensureAccessToken } from '../src/host/minimax-code/oauth.ts'
import { modelRequestHeaders } from '../src/host/minimax-code/client.ts'
import { messagesUrl } from '../src/host/minimax-code/types.ts'
import { buildMinimaxRequest } from '../src/host/minimax-code/mapper.ts'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'

const TIMEOUT_MS = 120_000
const MODEL = (process.env.PROBE_MINIMAX_MODEL || 'MiniMax-M3.1-Flash-Preview').trim()

const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

/**
 * A stable, comfortably oversized system prompt. MiniMax documents a minimum
 * input size before caching applies at all, so the filler must clear any
 * plausible threshold (Anthropic's own floor is 1024 tokens).
 */
const SYSTEM_FILLER =
  'You are a careful measurement subject in a cache probe. This sentence exists only to give the prefix size. '
const SYSTEM = SYSTEM_FILLER.repeat(300)

function probeOptions(): GenerateOptions {
  return {
    model: MODEL,
    system: SYSTEM,
    maxTokens: 64,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ok' }] } as Message,
    ],
    tools: [
      {
        name: 'probe_noop',
        description: 'A no-op tool that exists so the probe can mark the tool table with a cache breakpoint.',
        parameters: { type: 'object', properties: {} },
      },
    ],
  } as GenerateOptions
}

interface UsageReport {
  messageStartUsage: unknown
  messageDeltaUsage: unknown
  sawCacheFieldsInBody: boolean
}

/** Send one body and collect the raw usage objects out of its SSE stream. */
async function sendOnce(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; report: UsageReport; errorBody: string }> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  const report: UsageReport = { messageStartUsage: null, messageDeltaUsage: null, sawCacheFieldsInBody: false }
  if (!response.ok) {
    return { status: response.status, report, errorBody: text.replace(/\s+/g, ' ').slice(0, 400) }
  }
  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed.startsWith('data:')) continue
    if (trimmed.includes('cache')) report.sawCacheFieldsInBody = true
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>
    } catch {
      continue
    }
    if (event.type === 'message_start') {
      const message = event.message as Record<string, unknown> | undefined
      if (message?.usage !== undefined) report.messageStartUsage = message.usage
    }
    if (event.type === 'message_delta' && event.usage !== undefined) {
      report.messageDeltaUsage = event.usage
    }
  }
  return { status: response.status, report, errorBody: '' }
}

function fmt(label: string, value: unknown): string {
  return label + ': ' + JSON.stringify(value)
}

test('minimax subscription endpoint honours explicit cache_control breakpoints', async () => {
  const store = new MinimaxCodeCredentialStore()
  const credentials = await ensureAccessToken(store, { fetchFn })
  const url = messagesUrl(credentials.region)
  const headers = modelRequestHeaders(credentials.accessToken)

  const withMarkers = JSON.stringify(buildMinimaxRequest(probeOptions(), undefined, { cacheControl: true }))

  console.log('[probe] model=' + MODEL + ' url=' + url)
  console.log('[probe] request carries cache_control markers: ' + withMarkers.includes('cache_control'))

  const first = await sendOnce(url, headers, withMarkers)
  console.log('[probe] request 1 (cache WRITE expected) http=' + first.status)
  if (first.errorBody !== '') console.log('[probe] request 1 error: ' + first.errorBody)
  console.log('[probe]   ' + fmt('message_start.usage', first.report.messageStartUsage))
  console.log('[probe]   ' + fmt('message_delta.usage', first.report.messageDeltaUsage))

  const second = await sendOnce(url, headers, withMarkers)
  console.log('[probe] request 2 (cache READ expected) http=' + second.status)
  if (second.errorBody !== '') console.log('[probe] request 2 error: ' + second.errorBody)
  console.log('[probe]   ' + fmt('message_start.usage', second.report.messageStartUsage))
  console.log('[probe]   ' + fmt('message_delta.usage', second.report.messageDeltaUsage))

  const usageOf = (report: UsageReport): Record<string, number> => {
    // The endpoint sends a zero stub at message_start and the real counters at
    // message_delta, so the delta wins when it exists.
    return ((report.messageDeltaUsage ?? report.messageStartUsage) ?? {}) as Record<string, number>
  }
  const read1 = usageOf(first.report).cache_read_input_tokens ?? 0
  const write1 = usageOf(first.report).cache_creation_input_tokens ?? 0
  const read2 = usageOf(second.report).cache_read_input_tokens ?? 0

  console.log('[probe] verdict: write#1=' + write1 + ' read#1=' + read1 + ' read#2=' + read2)
  if (read2 > 0) {
    console.log('[probe] OK: the endpoint created the cache and the second request hit it.')
  } else if (write1 > 0) {
    console.log('[probe] PARTIAL: a cache was created but the identical follow-up did not read it.')
  } else if (first.status === 200 && second.status === 200) {
    console.log('[probe] NO: both requests succeeded but no cache counters came back - the endpoint ignores the markers.')
  } else {
    console.log('[probe] REJECTED: the endpoint did not answer 200 - see the error bodies above.')
  }
}, 300_000)
