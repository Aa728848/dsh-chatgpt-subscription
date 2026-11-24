/**
 * Real Kimi cache-write smoke: what does the service actually state?
 *
 * The settings card reads the write side from two body fields (chat:
 * `prompt_tokens_details.cache_write_tokens`; Anthropic:
 * `cache_creation_input_tokens`) and from the tier response headers. This probe
 * asks the live service four times and prints the RAW usage object and the
 * cache-related response headers, so a card that shows 0 can be told apart from
 * a parser that drops a field the service does send.
 *
 * No credential or message body is printed.
 *
 * Run:
 *   npx vitest run --config vitest.probe.config.ts scripts/probe-kimi-cache-write.probe.ts
 */
import { test } from 'vitest'
import { ensureAccessToken } from '../../src/host/providers/kimi-code/oauth.ts'
import { modelRequestHeaders, requestUrl } from '../../src/host/providers/kimi-code/client.ts'
import { FileCredentialStore, resolveRegion } from '../../src/host/providers/kimi-code/token-store.ts'
import type { KimiCodeWire } from '../../src/shared/kimi-code-contracts.ts'

const NL = String.fromCharCode(10)
const MODEL = process.env.PROBE_MODEL ?? 'k3.1-pro'
const FILLER = Array.from({ length: 200 }, (_, index) => 'Cache write probe filler sentence number ' + index + '.').join(' ')
const SALT = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

interface ProbeReply {
  status: number
  usage: Record<string, unknown> | undefined
  cacheHeaders: Array<[string, string]>
  bodyHead: string
}

function cacheHeadersOf(response: Response): Array<[string, string]> {
  const out: Array<[string, string]> = []
  response.headers.forEach((value, key) => {
    if (/cache|usage|token|msh-/i.test(key)) out.push([key, value])
  })
  return out
}

async function send(
  wire: KimiCodeWire,
  token: string,
  region: Awaited<ReturnType<typeof resolveRegion>>,
  salt: string,
  suffix?: string,
): Promise<ProbeReply> {
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: 'You are a cache-write probe. Reply with the single word OK. ' + salt + ' ' + FILLER },
    { role: 'user', content: 'Create this probe prefix. Reply OK.' },
  ]
  if (suffix !== undefined) {
    messages.push(
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'One more line follows. Reply OK.' + NL + suffix },
    )
  }
  const body = wire === 'anthropic'
    ? {
        model: MODEL,
        stream: true,
        max_tokens: 16,
        system: [{ type: 'text', text: 'You are a cache-write probe. Reply with the single word OK. ' + salt + ' ' + FILLER }],
        messages: messages.slice(1),
      }
    : {
        model: MODEL,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 16,
        messages,
      }
  const response = await fetch(requestUrl(wire, region), {
    method: 'POST',
    headers: await modelRequestHeaders(token, wire),
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let usage: Record<string, unknown> | undefined
  for (const line of text.split(NL)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      const message = parsed.message as Record<string, unknown> | undefined
      const candidate = parsed.usage ?? message?.usage
      if (candidate !== undefined && candidate !== null) usage = candidate as Record<string, unknown>
      if (parsed.type === 'message_delta' && candidate !== undefined && candidate !== null) usage = candidate as Record<string, unknown>
    } catch {
      // Keep-alive frame.
    }
  }
  return { status: response.status, usage, cacheHeaders: cacheHeadersOf(response), bodyHead: text.slice(0, 300) }
}

test('the live service states (or omits) cache-write tokens on both wires', async () => {
  const credentials = await ensureAccessToken(new FileCredentialStore())
  const region = await resolveRegion()

  for (const wire of ['openai', 'anthropic'] as KimiCodeWire[]) {
    const cold = await send(wire, credentials.accessToken, region, wire + '-cold-' + SALT)
    console.log('[probe] ' + wire + ' cold  status=' + String(cold.status) + ' usage=' + JSON.stringify(cold.usage))
    console.log('[probe] ' + wire + ' cold  headers=' + JSON.stringify(cold.cacheHeaders))
    if (cold.status !== 200) console.log('[probe] ' + wire + ' body=' + cold.bodyHead)

    const warm = await send(wire, credentials.accessToken, region, wire + '-cold-' + SALT, 'appended line ' + SALT)
    console.log('[probe] ' + wire + ' warm  status=' + String(warm.status) + ' usage=' + JSON.stringify(warm.usage))
    console.log('[probe] ' + wire + ' warm  headers=' + JSON.stringify(warm.cacheHeaders))
    if (warm.status !== 200) console.log('[probe] ' + wire + ' body=' + warm.bodyHead)
  }
}, 240_000)
