/**
 * One-shot probe: where does MiniMax-M3 actually put its reasoning in the
 * response stream, and does the shape of the request change that channel?
 *
 * Two bodies (baseline vs upstream's `thinking:{type:'adaptive'}`), same prompt.
 * The SSE is walked generically: every string-bearing path is recorded with its
 * length, so the channel carrying the reasoning is discovered rather than assumed.
 *
 * Run: npx vitest run --config vitest.probe.config.ts probe-minimax-thinking-channels
 */
import { test } from 'vitest'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { MinimaxCodeCredentialStore } from '../src/host/minimax-code/token-store.ts'
import { MinimaxCodeAccountPool } from '../src/host/minimax-code/account-pool.ts'
import { modelRequestHeaders } from '../src/host/minimax-code/client.ts'
import { messagesUrl } from '../src/host/minimax-code/types.ts'
import { buildMinimaxRequest } from '../src/host/minimax-code/mapper.ts'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'

const TIMEOUT_MS = 180_000
const MODEL = (process.env.PROBE_MINIMAX_MODEL || 'MiniMax-M3').trim()
const MAX_TOKENS = Number(process.env.PROBE_MINIMAX_MAX_TOKENS || 1500)

const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

const PROMPT =
  'A robot moves from (0,0) to (3,3) on a 4x4 grid, each step either right or down. ' +
  'Exactly 3 of the 6 intermediate cells are obstacles, placed uniformly at random among them. ' +
  'What is the expected number of obstacle-free monotone paths from (0,0) to (3,3)? ' +
  'Show the reasoning and give the final number.'

function probeOptions(model: string = MODEL): GenerateOptions {
  return {
    model,
    maxTokens: MAX_TOKENS,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] } as Message],
  } as GenerateOptions
}

interface StringPath { path: string; chars: number; sample: string }

function collect(value: unknown, path: string, out: Map<string, StringPath>, depth = 0): void {
  if (depth > 6) return
  if (typeof value === 'string') {
    if (value.length === 0) return
    const existing = out.get(path)
    if (existing === undefined) {
      out.set(path, { path, chars: value.length, sample: value.slice(0, 160) })
    } else {
      existing.chars += value.length
      if (existing.sample.length < 160) existing.sample = (existing.sample + value).slice(0, 160)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collect(item, path + '[' + index + ']', out, depth + 1))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collect(child, path === '' ? key : path + '.' + key, out, depth + 1)
    }
  }
}

async function dump(label: string, url: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<void> {
  const started = Date.now()
  const response = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const raw = await response.text().catch(() => '')
  console.log('[probe] ' + label + ' http=' + response.status + ' ms=' + (Date.now() - started))
  if (!response.ok) {
    console.log('[probe]   error: ' + raw.replace(/\s+/g, ' ').slice(0, 300))
    return
  }
  const paths = new Map<string, StringPath>()
  const eventTypes = new Map<string, number>()
  for (const rawLine of raw.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed.startsWith('data:')) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>
    } catch {
      continue
    }
    const type = typeof event.type === 'string' ? event.type : '(none)'
    eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1)
    collect(event, '', paths)
  }
  console.log('[probe]   event types: ' + JSON.stringify([...eventTypes.entries()]))
  const rows = [...paths.values()].sort((a, b) => b.chars - a.chars).slice(0, 14)
  for (const row of rows) {
    console.log('[probe]   ' + row.path + '  chars=' + row.chars + '  sample=' + JSON.stringify(row.sample))
  }
}

test('minimax M3 reasoning channel', async () => {
  // The pool, not the bare store: the native MiniMax Code auth directory is
  // gone on this machine, and the plugin's own pool still holds the sessions.
  const pool = new MinimaxCodeAccountPool({ store: new MinimaxCodeCredentialStore() })
  const credentials = await pool.getFreshCredential(undefined, fetchFn)
  const url = messagesUrl(credentials.region)
  const headers = modelRequestHeaders(credentials.accessToken)

  // A: the OLD shape - the thinking object stripped off what the mapper
  // builds, which is exactly what this line used to send.
  const withoutThinking = (body: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...body }
    delete copy.thinking
    return copy
  }
  await dump('A M3 without the thinking object (the old shape)', url, headers, withoutThinking(buildMinimaxRequest(probeOptions())))
  await dump('B M3 as the mapper builds it now', url, headers, buildMinimaxRequest(probeOptions()))
  await dump('C M3.1 as the mapper builds it now (no thinking object)', url, headers, buildMinimaxRequest(probeOptions('MiniMax-M3.1-Flash')))
}, 600_000)
