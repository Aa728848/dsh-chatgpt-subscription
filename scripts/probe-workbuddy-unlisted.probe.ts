/**
 * One-shot probe: characterize a model the gateway serves but does not publish
 * in `/v3/config`, by asking the live endpoint directly.
 *
 * Each fact is settled by the gateway's own answer rather than by the name:
 *   reasoning ladder \u2014 every level this route can name is tried; the ones the
 *     model rejects answer 400 `code 11150`, which is how the ladder is read
 *     off a model that publishes none
 *   image support \u2014 a 1x1 PNG the model either accepts or rejects
 *   output cap \u2014 the largest `max_tokens` the model accepts, found by asking
 *     for more than it serves until it says no
 *
 * Nothing but a model id, a status and a short structural snippet is ever
 * printed \u2014 never a token.
 *
 * Run: npx vitest run --config vitest.probe.config.ts scripts/probe-workbuddy-unlisted.probe.ts
 */
import { test } from 'vitest'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { WorkBuddyAccountPool } from '../src/host/workbuddy/account-pool.ts'
import { workBuddyHeaders, refreshCredentials } from '../src/host/workbuddy/client.ts'
import { CHAT_PATH, CLIENT_USER_AGENT, ERROR_CODE } from '../src/host/workbuddy/types.ts'

const MODELS = process.env.PROBE_MODELS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

interface Verdict {
  label: string
  model: string
  status: number | string
  code?: number
  note: string
}

function codeOf(text: string): number | undefined {
  const match = /\"code\":(\d+)/.exec(text)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

test('characterize a model served but not published in /v3/config', async () => {
  const pool = new WorkBuddyAccountPool()
  const data = await pool.read()
  const verdicts: Verdict[] = []
  for (const account of data.accounts) {
    let credentials = account.credentials
    if (credentials.expiresAt && credentials.expiresAt < Date.now() + 60_000) {
      credentials = await refreshCredentials(credentials, { fetchFn }).catch(() => credentials)
    }
    if (credentials.region !== (process.env.PROBE_REGION ?? 'intl')) continue

    const ask = async (model: string, extra: Record<string, unknown>, label: string): Promise<void> => {
      try {
        const response = await fetchFn(`${credentials.backend}${CHAT_PATH}`, {
          method: 'POST',
          headers: workBuddyHeaders(credentials, { accept: 'text/event-stream', 'user-agent': CLIENT_USER_AGENT }),
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: 'You are a helpful assistant.' },
              { role: 'user', content: 'ping' },
            ],
            stream: true,
            ...extra,
          }),
          signal: AbortSignal.timeout(40_000),
        })
        const text = await response.text().catch(() => '')
        verdicts.push({
          label, model, status: response.status,
          code: codeOf(text),
          note: text.replace(/\s+/g, ' ').slice(0, 140),
        })
      } catch (error) {
        verdicts.push({ label, model, status: 'error', note: error instanceof Error ? error.message : String(error) })
      }
    }

    for (const model of MODELS) {
      for (const effort of EFFORTS) await ask(model, { max_tokens: 64, reasoning_effort: effort }, `effort=${effort}`)
      await ask(model, {
        max_tokens: 64,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: [{ type: 'text', text: 'what is in this image?' }, { type: 'image_url', image_url: { url: TINY_PNG } }] },
        ],
      }, 'image')
      for (const maxTokens of [131072, 128000, 64000, 32768, 16000]) await ask(model, { max_tokens: maxTokens }, `max_tokens=${maxTokens}`)
    }
    break
  }
  for (const verdict of verdicts) console.log(JSON.stringify(verdict))
  proxy.dispose()
})
