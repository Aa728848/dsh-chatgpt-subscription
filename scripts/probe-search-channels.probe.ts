/**
 * One-shot probe: which sibling line can actually serve a web search / fetch
 * channel, measured against the credentials this machine already stores.
 *
 * Read-only with respect to the repository and the credential files. Every
 * request is minimal and every printed value is a status, a URL, or a short
 * structural snippet — never a token.
 *
 * Run: npx vitest run --config vitest.probe.config.ts
 * Narrow it down with: $env:PROBE_ONLY='kimi'; npx vitest run --config vitest.probe.config.ts
 */
import { existsSync } from 'node:fs'
import { test } from 'vitest'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { FileCredentialStore as KimiStore, credentialPath as kimiCredentialPath } from '../src/host/kimi-code/token-store.ts'
import { ensureAccessToken } from '../src/host/kimi-code/oauth.ts'
import { modelRequestHeaders, requestUrl } from '../src/host/kimi-code/client.ts'

const TIMEOUT_MS = 45_000
const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

interface ProbeResult {
  probe: string
  status: 'ok' | 'rejected' | 'no-credentials' | 'error'
  httpStatus?: number
  evidence: string
}

const results: ProbeResult[] = []

function note(probe: string, status: ProbeResult['status'], evidence: string, httpStatus?: number): void {
  results.push({ probe, status, evidence: evidence.slice(0, 400), ...(httpStatus === undefined ? {} : { httpStatus }) })
}

/** Collapse a body to a short, secret-free structural snippet. */
function snippet(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 400)
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  return { status: response.status, text: text.slice(0, 20_000) }
}

async function probeKimi(): Promise<void> {
  if (!existsSync(`${kimiCredentialPath()}.dpapi`)) {
    note('kimi', 'no-credentials', 'no stored Kimi Code credential file')
    return
  }
  let credentials
  try {
    credentials = await ensureAccessToken(new KimiStore(), { fetchFn })
  } catch (error) {
    note('kimi:credentials', 'error', error instanceof Error ? error.message : String(error))
    return
  }
  const region = credentials.region
  const model = 'k3'

  // Documented Moonshot shape: declare the builtin search tool on the OpenAI surface.
  try {
    const headers = await modelRequestHeaders(credentials.accessToken, 'openai')
    const { status, text } = await post(requestUrl('openai', region), { ...headers, accept: 'application/json' }, {
      model,
      max_tokens: 64,
      messages: [{ role: 'user', content: '用一句话回答：今天的日期是什么？（需要联网确认）' }],
      tools: [{ type: 'builtin_function', function: { name: '$web_search' } }],
    })
    const mentionsBuiltin = text.includes('$web_search')
    note('kimi:openai builtin_function $web_search', status === 200 && mentionsBuiltin ? 'ok' : status === 200 ? 'rejected' : 'error',
      `http=${status} mentionsBuiltin=${mentionsBuiltin} body=${snippet(text)}`, status)
  } catch (error) {
    note('kimi:openai builtin_function $web_search', 'error', error instanceof Error ? error.message : String(error))
  }

  // Anthropic-native server tool shape on the Messages surface.
  try {
    const headers = await modelRequestHeaders(credentials.accessToken, 'anthropic')
    const { status, text } = await post(requestUrl('anthropic', region), headers, {
      model,
      max_tokens: 64,
      messages: [{ role: 'user', content: '用一句话回答：今天的日期是什么？（需要联网确认）' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    })
    note('kimi:anthropic web_search_20250305', status === 200 ? 'ok' : 'rejected', `http=${status} body=${snippet(text)}`, status)
  } catch (error) {
    note('kimi:anthropic web_search_20250305', 'error', error instanceof Error ? error.message : String(error))
  }

  // Anthropic's server-side fetch tool, if this surface proxies it too.
  try {
    const headers = await modelRequestHeaders(credentials.accessToken, 'anthropic')
    const { status, text } = await post(requestUrl('anthropic', region), headers, {
      model,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Fetch https://example.com and answer with its page title in one short sentence.' }],
      tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 1 }],
    })
    const fetched = text.includes('web_fetch_tool_result') || text.includes('server_tool_use')
    note('kimi:anthropic web_fetch_20250910', status === 200 && fetched ? 'ok' : status === 200 ? 'rejected' : 'error',
      `http=${status} fetched=${fetched} body=${snippet(text)}`, status)
  } catch (error) {
    note('kimi:anthropic web_fetch_20250910', 'error', error instanceof Error ? error.message : String(error))
  }
}

test('probe sibling search channels', async () => {
  const only = (process.env.PROBE_ONLY ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  const wanted = (name: string): boolean => only.length === 0 || only.includes(name)

  if (wanted('kimi')) await probeKimi()

  proxy.dispose()
  for (const result of results) console.log(JSON.stringify(result))
})
