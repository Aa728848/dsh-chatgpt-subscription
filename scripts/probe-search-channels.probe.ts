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
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { test } from 'vitest'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { FileCredentialStore as KimiStore, credentialPath as kimiCredentialPath } from '../src/host/kimi-code/token-store.ts'
import { ensureAccessToken } from '../src/host/kimi-code/oauth.ts'
import { modelRequestHeaders, requestUrl } from '../src/host/kimi-code/client.ts'
import { FileCredentialStore as AntigravityStore, modelSettingsPath as antigravityModelSettingsPath } from '../src/host/antigravity/token-store.ts'
import { ensureApiKey } from '../src/host/antigravity/oauth.ts'
import { AccountPoolStore as AntigravityPool } from '../src/host/antigravity/account-pool.ts'
import { antigravityHeaders, endpointCandidates } from '../src/host/antigravity/client.ts'
import { buildRequest } from '../src/host/antigravity/mapper.ts'
import { MODELS } from '../src/host/antigravity/types.ts'
import { WorkBuddyAccountPool } from '../src/host/workbuddy/account-pool.ts'
import { workBuddyHeaders, refreshCredentials } from '../src/host/workbuddy/client.ts'

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

async function probeAntigravity(): Promise<void> {
  let token: string
  let projectId: string | undefined
  try {
    const pool = new AntigravityPool()
    const data = await pool.read().catch(() => null)
    if (data && data.accounts.length > 0) {
      const effective = await pool.getEffectiveAccount(new Set(), fetchFn)
      token = effective.token
      projectId = effective.projectId
    } else {
      const legacy = await ensureApiKey(new AntigravityStore(), fetchFn)
      token = legacy.token
      projectId = legacy.projectId
    }
  } catch (error) {
    note('antigravity:credentials', 'error', error instanceof Error ? error.message : String(error))
    return
  }

  const modelDef = MODELS.find((entry) => entry.id === 'gemini-3.1-pro') ?? MODELS[0]
  const baseOptions = (text: string): Record<string, unknown> => ({
    provider: 'antigravity',
    model: modelDef.id,
    system: 'You are a helpful assistant. You must use the available tool and answer in one short sentence.',
    messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
  })

  // The baseline is the plugin's own request builder, so the envelope is
  // known-good (a retired model id already answered 200 through it) and the
  // only open question is which runtime model this account may actually use.
  const build = (runtimeModel: string, text: string, mutate?: (request: Record<string, unknown>) => void): Record<string, unknown> => {
    const body = buildRequest(baseOptions(text) as never, modelDef, projectId || 'antigravity-default', runtimeModel) as Record<string, unknown>
    mutate?.(body.request as Record<string, unknown>)
    return body
  }

  const models = [
    process.env.AG_MODEL?.trim(),
    'gemini-3.1-pro-high',
    'gemini-3.8-flash-low',
  ].filter((entry): entry is string => typeof entry === 'string' && entry !== '')

  const usable: string[] = []
  for (const model of models) {
    const statuses = await antigravityRequest(token, model, { label: 'antigravity:baseline', body: build(model, 'Answer in one short sentence: what is 2+2?') })
    if (statuses.includes(200)) usable.push(model)
  }

  const variant = process.env.AG_VARIANT?.trim() || 'all'
  if (variant === 'url' || variant === 'search') {
    const model = process.env.AG_MODEL?.trim() || 'gemini-3.8-flash-low'
    await antigravityRequest(token, model, variant === 'url'
      ? {
          label: 'antigravity:urlContext',
          body: build(model, 'Fetch https://example.com and answer with its page title in one short sentence.', (request) => { request.tools = [{ urlContext: {} }] }),
          populated: true,
        }
      : {
          label: 'antigravity:googleSearch',
          body: build(model, SEARCH_TEXT, (request) => { request.tools = [{ googleSearch: {} }] }),
          populated: true,
        })
    return
  }

  for (const model of usable) {
    await antigravityRequest(token, model, {
      label: 'antigravity:googleSearch',
      body: build(model, SEARCH_TEXT, (request) => { request.tools = [{ googleSearch: {} }] }),
      populated: true,
    })
    await antigravityRequest(token, model, {
      label: 'antigravity:urlContext',
      body: build(model, 'Fetch https://example.com and answer with its page title in one short sentence.', (request) => { request.tools = [{ urlContext: {} }] }),
      populated: true,
    })
  }
}

const SEARCH_TEXT = 'Search the web for today\'s date and the name of the current US president, then answer in one short sentence.'

/** Response keys that would prove the service ran the grounding tool itself. */
const MARKERS = [
  'groundingMetadata',
  'groundingChunks',
  'webSearchQueries',
  'urlContextMetadata',
  'url_context_metadata',
  'urlMetadata',
  'functionCall',
]

async function antigravityRequest(
  token: string,
  model: string,
  probe: { label: string; body: Record<string, unknown>; populated?: boolean },
): Promise<number[]> {
  const statuses: number[] = []
  // Every endpoint is tried: a 400 here is about the model, not the host, and
  // stopping at the first would hide a host that would have accepted it.
  for (const endpoint of endpointCandidates()) {
    try {
      const response = await fetchFn(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: antigravityHeaders(token),
        body: JSON.stringify(probe.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      statuses.push(response.status)
      const text = (await response.text().catch(() => '')).slice(0, 60_000)
      // A tool that is merely accepted leaves `groundingMetadata` empty; only a
      // populated chunk list proves the service actually ran the lookup.
      const populated = /groundingChunks\\?"\s*:\s*\[\s*\{/.test(text) || /urlMetadata\\?"\s*:\s*\{/.test(text)
      const markers = MARKERS.filter((marker) => text.includes(marker))
      note(`${probe.label} ${endpoint} model=${model}`,
        response.ok && (probe.populated !== true || populated) ? 'ok' : response.ok ? 'rejected' : 'error',
        `http=${response.status} populated=${populated} markers=[${markers.join(',')}] body=${snippet(text)}`, response.status)
    } catch (error) {
      note(`${probe.label} ${endpoint}`, 'error', error instanceof Error ? error.message : String(error))
    }
  }
  return statuses
}

async function antigravityProbeModel(): Promise<string> {
  try {
    const raw = await readFile(antigravityModelSettingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as { enabledModelIds?: string[]; catalogModels?: Array<{ id: string }> }
    const enabled = parsed.enabledModelIds?.[0]
    if (enabled) return enabled
    // The stored catalog is what the service currently serves; a retired id
    // answers 200 with a "switch to a newer model" notice and no grounding.
    const live = parsed.catalogModels?.find((entry) => /^gemini-3\.\d-pro-high$/.test(entry.id))?.id
    if (live) return live
  } catch {
    // fall through to a conservative default
  }
  return 'gemini-3.1-pro-high'
}

async function probeWorkBuddy(): Promise<void> {
  let credentials
  try {
    const pool = new WorkBuddyAccountPool()
    const data = await pool.read()
    const account = data.accounts[0]
    if (!account) {
      note('workbuddy:search', 'no-credentials', 'no pooled WorkBuddy account')
      return
    }
    credentials = account.credentials
    if (credentials.expiresAt && credentials.expiresAt < Date.now() + 60_000) {
      credentials = await refreshCredentials(credentials, { fetchFn }).catch(() => credentials)
    }
  } catch (error) {
    note('workbuddy:credentials', 'error', error instanceof Error ? error.message : String(error))
    return
  }

  const backend = credentials.backend
  for (const path of ['/agenttool/v1/search', '/v1/web_search', '/v1/search']) {
    try {
      const { status, text } = await post(`${backend}${path}`, workBuddyHeaders(credentials), { query: 'dsh probe', keyword: 'dsh probe' })
      note(`workbuddy:${path}`, status === 200 ? 'ok' : 'rejected', `http=${status} body=${snippet(text)}`, status)
      if (status === 200) break
    } catch (error) {
      note(`workbuddy:${path}`, 'error', error instanceof Error ? error.message : String(error))
    }
  }

  // A reader/fetch sibling of the search endpoint, if this backend has one.
  for (const path of ['/agenttool/v1/fetch', '/agenttool/v1/reader', '/agenttool/v1/web_fetch', '/agenttool/v1/browse']) {
    try {
      const { status, text } = await post(`${backend}${path}`, workBuddyHeaders(credentials), { url: 'https://example.com', urls: ['https://example.com'] })
      note(`workbuddy:${path}`, status === 200 ? 'ok' : 'rejected', `http=${status} body=${snippet(text)}`, status)
    } catch (error) {
      note(`workbuddy:${path}`, 'error', error instanceof Error ? error.message : String(error))
    }
  }
}

test('probe sibling search channels', async () => {
  const only = (process.env.PROBE_ONLY ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  const wanted = (name: string): boolean => only.length === 0 || only.includes(name)

  if (wanted('kimi')) await probeKimi()
  if (wanted('antigravity')) await probeAntigravity()
  if (wanted('workbuddy')) await probeWorkBuddy()

  proxy.dispose()
  for (const result of results) console.log(JSON.stringify(result))
})
