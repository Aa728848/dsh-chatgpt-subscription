/**
 * One-shot probe: can the ChatGPT subscription responses backend carry a tool
 * change mid-conversation, and does each candidate shape leave the prefix cache
 * intact?
 *
 * What it asks, in order:
 *
 * 1. Baseline: one request with a single tool, then the SAME request again. The
 *    second answer must report `cached_tokens > 0`, or the backend is not
 *    caching this shape at all and nothing below means anything.
 * 2. `additional_tools`: an input item of that type carrying a tool that the
 *    head of the request never declares. A 4xx means the subscription backend
 *    does not implement the public Responses field; a 2xx means it does, and the
 *    follow-up turn tells us whether the model can actually call the tool.
 * 3. `tool_search` + `defer_loading: true`: the other public shape. Same reading.
 * 4. Cache under `additional_tools`: one more turn in the same session, to see
 *    whether the earlier prefix (including the item) is still read from cache.
 *
 * Run: npx vitest run --config vitest.probe.config.ts scripts/probe-codex-tool-updates.probe.ts
 *
 * Reads the real `~/.dsh` credentials: the probe config deliberately omits the
 * isolated-home setup. Prints status codes, error codes, usage counters and the
 * shape of any tool call. It never prints a credential, a header, or a body.
 */
import { test } from 'vitest'
import { OAuthService } from '../src/host/oauth-service.ts'
import { createPlatformTokenStore } from '../src/host/platform-token-store.ts'
import { codexHeaders, codexRoutingHint, CODEX_ROUTING_HINT_HEADER } from '../src/host/wire-auth.ts'
import { CODEX_RESPONSES_URL } from '../src/compat.ts'
import { loadCodexCatalog } from '../src/host/codex-catalog.ts'

type Credentials = Awaited<ReturnType<OAuthService['credentials']>>

const FN_BASE = {
  type: 'function',
  description: 'Look up a probe value by key.',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
  strict: true,
} as const

function fn(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...FN_BASE, name, ...extra }
}

interface ProbeResult {
  readonly status: number
  readonly errorCode?: string
  readonly usage?: Record<string, unknown>
  readonly toolCalls: string[]
  readonly text: string
}

/** Reads the JSON of every `data:` frame and keeps the completed response. */
function readSse(body: string): { usage?: Record<string, unknown>; toolCalls: string[]; text: string } {
  const toolCalls: string[] = []
  let text = ''
  let usage: Record<string, unknown> | undefined
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const raw = trimmed.slice('data:'.length).trim()
    if (raw === '' || raw === '[DONE]') continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(raw) as Record<string, unknown>
    } catch {
      continue
    }
    const response = event['response'] as Record<string, unknown> | undefined
    if (response !== undefined) {
      if (typeof response['usage'] === 'object' && response['usage'] !== null) {
        usage = response['usage'] as Record<string, unknown>
      }
      const output = response['output']
      if (Array.isArray(output)) {
        for (const item of output as Record<string, unknown>[]) {
          if (item['type'] === 'function_call' && typeof item['name'] === 'string') toolCalls.push(item['name'])
          if (item['type'] === 'message') {
            const content = item['content']
            if (Array.isArray(content)) {
              for (const block of content as Record<string, unknown>[]) {
                if (typeof block['text'] === 'string') text += block['text']
              }
            }
          }
        }
      }
    }
    if (event['type'] === 'error') {
      return { toolCalls, text }
    }
  }
  return { usage, toolCalls, text }
}

async function probe(
  credentials: Credentials,
  body: Record<string, unknown>,
  sessionId: string,
  label: string,
): Promise<ProbeResult> {
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: {
      ...codexHeaders(credentials, sessionId),
      'content-type': 'application/json',
      accept: 'text/event-stream',
      [CODEX_ROUTING_HINT_HEADER]: codexRoutingHint(String(body['model'] ?? '')),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    let errorCode: string | undefined
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const error = parsed['error'] as Record<string, unknown> | undefined
      errorCode = typeof error?.['code'] === 'string' ? error['code'] : undefined
    } catch {
      /* the backend sometimes answers with plain text */
    }
    console.log(`[probe] ${label}: HTTP ${response.status} code=${errorCode ?? 'n/a'} body=${text.slice(0, 240)}`)
    return { status: response.status, errorCode, toolCalls: [], text: '' }
  }
  const parsed = readSse(text)
  const usage = parsed.usage
  const cached = usage?.['input_tokens_details'] as Record<string, unknown> | undefined
  console.log(
    `[probe] ${label}: HTTP ${response.status} input=${String(usage?.['input_tokens'] ?? '?')} cached=${String(cached?.['cached_tokens'] ?? '?')} calls=[${parsed.toolCalls.join(',')}] text=${JSON.stringify(parsed.text.slice(0, 60))}`,
  )
  return { status: response.status, usage, toolCalls: parsed.toolCalls, text: parsed.text }
}

function user(text: string): Record<string, unknown> {
  return { role: 'user', content: [{ type: 'input_text', text }] }
}

test('codex backend: mid-conversation tool shapes and their cache effect', async () => {
  const store = createPlatformTokenStore()
  const oauth = new OAuthService(store, { logger: { info: () => {}, warn: console.warn } })
  let credentials: Credentials
  try {
    credentials = await oauth.credentials()
  } catch (error) {
    console.log('[probe] no usable credential, skipping:', error instanceof Error ? error.message : String(error))
    return
  }
  // The subscription listing is the only authority on what this plan serves: a
  // model id from the shipped floor table can still answer `model_not_found`.
  let model = process.env.PROBE_MODEL ?? ''
  if (model === '') {
    const catalog = await loadCodexCatalog(credentials, { force: true })
    console.log('[probe] catalog =', catalog.map((entry) => entry.id).join(','))
    model = catalog[0]?.id ?? ''
  }
  if (model === '') {
    console.log('[probe] no model available, skipping')
    return
  }
  console.log('[probe] model =', model, 'endpoint =', CODEX_RESPONSES_URL)

  const sessionId = 'probe-tool-updates-' + Date.now().toString(36)
  const baseInput = [user('Reply with the single word OK.')]
  const baseBody: Record<string, unknown> = {
    model,
    input: baseInput,
    tools: [fn('probe_lookup')],
    stream: true,
    store: false,
    parallel_tool_calls: false,
  }

  // 1. Baseline, twice. The second must read a cached prefix, or caching is off
  //    for this shape and the rest of the probe cannot be interpreted.
  const first = await probe(credentials, baseBody, sessionId, 'baseline#1')
  if (first.status !== 200) {
    console.log('[probe] baseline rejected; stopping')
    return
  }
  await probe(credentials, baseBody, sessionId, 'baseline#2')

  // 2. additional_tools: a tool the head of the request never declares.
  const withAddition: Record<string, unknown> = {
    ...baseBody,
    input: [
      user('Reply with the single word OK.'),
      { type: 'additional_tools', role: 'developer', tools: [fn('probe_extra')] },
      user('Now call probe_extra with key "x". Do not explain.'),
    ],
  }
  const addition = await probe(credentials, withAddition, sessionId, 'additional_tools')

  // 3. tool_search + defer_loading: the other public shape.
  const withSearch: Record<string, unknown> = {
    ...baseBody,
    input: [user('Find a tool that looks up a probe value, then call it with key "x". Do not explain.')],
    tools: [{ type: 'tool_search' }, fn('probe_deferred', { defer_loading: true })],
  }
  const search = await probe(credentials, withSearch, sessionId, 'tool_search+defer_loading')

  // 4. Cache across the additional_tools item: append one more turn only.
  if (addition.status === 200) {
    const followUp: Record<string, unknown> = {
      ...withAddition,
      input: [
        ...(withAddition['input'] as unknown[]),
        user('Reply with the single word DONE.'),
      ],
    }
    await probe(credentials, followUp, sessionId, 'additional_tools#2')
  }

  console.log(
    '[probe] summary:',
    JSON.stringify({
      baselineCached:
        ((first.usage?.['input_tokens_details'] as Record<string, unknown> | undefined)?.['cached_tokens'] ?? null),
      additionalToolsStatus: addition.status,
      additionalToolsError: addition.errorCode ?? null,
      additionalToolsCalled: addition.toolCalls,
      toolSearchStatus: search.status,
      toolSearchError: search.errorCode ?? null,
      toolSearchCalled: search.toolCalls,
      note: 'the baseline prompt is below the minimum cacheable length, so cached=0 here proves nothing',
    }),
  )
})

/**
 * The cache half of the question, at a size the cache can actually engage.
 *
 * A prompt under the minimum cacheable length reports `cached_tokens: 0` no
 * matter how identical it is, which the first test runs into. This one carries a
 * deterministic filler prefix above that floor and then asks three things:
 *
 * - `pad#1` -> `pad#2`: identical requests. The second must report a cached
 *   prefix, otherwise this backend does not cache and nothing else is readable.
 * - `pad+addition`: the same head with an `additional_tools` item appended after
 *   it. If the head is still read from cache, the item landed at the tail and
 *   the prefix survived.
 * - `pad+addition#2`: that request again. The whole thing should then be cached.
 */
test('codex backend: does an additional_tools item leave the prefix cached', async () => {
  const store = createPlatformTokenStore()
  const oauth = new OAuthService(store, { logger: { info: () => {}, warn: console.warn } })
  let credentials: Credentials
  try {
    credentials = await oauth.credentials()
  } catch {
    console.log('[probe] no usable credential, skipping cache test')
    return
  }
  let model = process.env.PROBE_MODEL ?? ''
  if (model === '') {
    const catalog = await loadCodexCatalog(credentials, { force: true })
    model = catalog[0]?.id ?? ''
  }
  if (model === '') return

  // Deterministic filler: identical bytes every run, so a miss means the backend
  // declined to reuse rather than that the text differed.
  const filler: string[] = []
  for (let index = 0; index < 120; index += 1) {
    filler.push(
      `Line ${index}: the stationary reference paragraph keeps this prefix stable across requests so a cache entry can be measured without the payload changing between calls.`,
    )
  }
  const preface = filler.join('\n')

  const sessionId = 'probe-cache-' + Date.now().toString(36)
  const head = [
    { role: 'user', content: [{ type: 'input_text', text: preface }] },
    { role: 'user', content: [{ type: 'input_text', text: 'Reply with the single word OK.' }] },
  ]
  const padBody: Record<string, unknown> = {
    model,
    input: head,
    tools: [fn('probe_lookup')],
    stream: true,
    store: false,
    parallel_tool_calls: false,
  }

  await probe(credentials, padBody, sessionId, 'pad#1')
  await probe(credentials, padBody, sessionId, 'pad#2')

  const padded = {
    ...padBody,
    input: [
      ...head,
      { type: 'additional_tools', role: 'developer', tools: [fn('probe_extra')] },
      user('Reply with the single word READY.'),
    ],
  }
  await probe(credentials, padded, sessionId, 'pad+addition')
  await probe(credentials, padded, sessionId, 'pad+addition#2')
})
