/**
 * Verification probe: does the NEW request shape (the one the mapper now
 * builds) actually put the reasoning in the thinking channel, and does the
 * off switch still turn thinking off?
 *
 * The bodies come from the real `buildMinimaxRequest` with no hand-patching,
 * so what is measured is exactly what the adapter would send.
 *
 * Run: npx vitest run --config vitest.probe.config.ts probe-minimax-new-shape
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
const MAX_TOKENS = Number(process.env.PROBE_MINIMAX_MAX_TOKENS || 1200)

const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

const PROMPT =
  'A robot moves from (0,0) to (3,3) on a 4x4 grid, each step either right or down. ' +
  'Exactly 3 of the 6 intermediate cells are obstacles, placed uniformly at random among them. ' +
  'What is the expected number of obstacle-free monotone paths from (0,0) to (3,3)? ' +
  'Show the reasoning and give the final number.'

function options(model: string, reasoningEffort?: string): GenerateOptions {
  return {
    model,
    maxTokens: MAX_TOKENS,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] } as Message],
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as never }),
  } as GenerateOptions
}

async function run(url: string, headers: Record<string, string>, label: string, body: Record<string, unknown>): Promise<void> {
  const started = Date.now()
  const response = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const raw = await response.text().catch(() => '')
  if (!response.ok) {
    console.log('[probe] ' + label + ' http=' + response.status + ' error=' + raw.replace(/\s+/g, ' ').slice(0, 240))
    return
  }
  const blocks = new Map<string, number>()
  const deltas = new Map<string, number>()
  let outTokens = 0
  let stop = ''
  for (const rawLine of raw.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed.startsWith('data:')) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>
    } catch {
      continue
    }
    if (event.type === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined
      const type = typeof block?.type === 'string' ? block.type : '(none)'
      blocks.set(type, (blocks.get(type) ?? 0) + 1)
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined
      const type = typeof delta?.type === 'string' ? delta.type : '(none)'
      deltas.set(type, (deltas.get(type) ?? 0) + 1)
    }
    if (event.type === 'message_delta') {
      const usage = event.usage as Record<string, unknown> | undefined
      if (usage && typeof usage.output_tokens === 'number') outTokens = usage.output_tokens
      const delta = event.delta as Record<string, unknown> | undefined
      if (delta && typeof delta.stop_reason === 'string') stop = delta.stop_reason
    }
  }
  console.log(
    '[probe] ' + label
    + ' | request=' + JSON.stringify({ thinking: body.thinking, output_config: body.output_config })
    + ' | http=200'
    + ' | blocks=' + JSON.stringify([...blocks.entries()])
    + ' | deltas=' + JSON.stringify([...deltas.entries()])
    + ' | out_tokens=' + outTokens
    + ' | stop=' + stop
    + ' | ms=' + (Date.now() - started),
  )
}

test('the new minimax request shape end to end', async () => {
  // The pool, not the bare store: the native MiniMax Code auth directory is
  // gone on this machine, and the plugin's own pool still holds the sessions.
  const pool = new MinimaxCodeAccountPool({ store: new MinimaxCodeCredentialStore() })
  const credentials = await pool.getFreshCredential(undefined, fetchFn)
  const url = messagesUrl(credentials.region)
  const headers = modelRequestHeaders(credentials.accessToken)

  await run(url, headers, 'M3 default', buildMinimaxRequest(options('MiniMax-M3')))
  await run(url, headers, 'M3 low', buildMinimaxRequest(options('MiniMax-M3', 'low')))
  await run(url, headers, 'M3 off', buildMinimaxRequest(options('MiniMax-M3', 'none')))
  await run(url, headers, 'M3.1 default', buildMinimaxRequest(options('MiniMax-M3.1-Flash')))
}, 600_000)
