/** Second authorized live batch: remaining personal models, 1h cache and real adapter replay. */
import { test, expect } from 'vitest'
import { QianwenCredentialStore, QianwenSettingsStore } from '../../src/host/providers/qianwen-token-plan/token-store.ts'
import { QIANWEN_CHAT_COMPLETIONS_URL, QIANWEN_MODELS_URL, PROVIDER_ID, qianwenHeaders } from '../../src/host/providers/qianwen-token-plan/types.ts'
import { QianwenTokenPlanAdapter } from '../../src/host/providers/qianwen-token-plan/adapter.ts'

const MAX_CALLS = 18
let calls = 0
let apiKey = ''
const results: Array<{ name: string; ok: boolean; detail: string }> = []
const record = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); console.log('[qwen-live-2] ' + (ok ? 'PASS ' : 'FAIL ') + name + ' :: ' + detail) }
const redact = (text: string) => text.replace(/sk-sp-[A-Za-z0-9_-]+/g, '[redacted-key]').slice(0, 260)
const contentOf = (payload: any): string => typeof payload?.choices?.[0]?.message?.content === 'string' ? payload.choices[0].message.content : ''
async function post(body: Record<string, unknown>) {
  if (calls >= MAX_CALLS) throw new Error('second-batch generation budget exhausted')
  calls += 1
  const response = await fetch(QIANWEN_CHAT_COMPLETIONS_URL, { method: 'POST', headers: qianwenHeaders(apiKey), body: JSON.stringify(body), signal: AbortSignal.timeout(100_000) })
  const text = await response.text(); let payload: any
  try { payload = JSON.parse(text) } catch { payload = undefined }
  if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + redact(payload?.error?.message ?? text))
  if (payload === undefined) throw new Error('non-JSON response ' + redact(text))
  return payload
}
const cacheUsage = (payload: any) => {
  const usage = payload?.usage ?? {}; const details = usage.prompt_tokens_details ?? {}
  return { cached: details.cached_tokens, write: details.cache_write_tokens, write5m: details.cache_creation?.ephemeral_5m_input_tokens, write1h: details.cache_creation?.ephemeral_1h_input_tokens }
}

test('remaining personal models, 1h cache and real adapter', async () => {
  const store = new QianwenCredentialStore(); const credentials = await store.read()
  expect(credentials).not.toBeNull(); apiKey = credentials!.apiKey
  const settingsStore = new QianwenSettingsStore()
  const listingResponse = await fetch(QIANWEN_MODELS_URL, { headers: qianwenHeaders(apiKey), signal: AbortSignal.timeout(30_000) })
  const listing = await listingResponse.json() as any
  const available = new Set<string>((listing?.data ?? []).map((entry: any) => entry.id))
  const remaining = ['qwen3.7-max','qwen3.7-plus','qwen3.6-flash','glm-5.2','deepseek-v4-pro','deepseek-v4-flash-0731','qwen3.8-max','deepseek-v4-pro-0813','deepseek-v4.1-flash','glm-5.3','auto','deepseek-v4.1-flash-1017']
  for (const model of remaining) {
    if (!available.has(model)) { record('catalog-' + model, false, 'not present in this personal key /models listing'); continue }
    try {
      const payload = await post({ model, messages: [{ role: 'user', content: 'Reply briefly.' }], stream: false, max_completion_tokens: 32 })
      record('model-' + model, Array.isArray(payload?.choices) && payload.choices.length > 0, 'HTTP 200 answer=' + redact(contentOf(payload)))
    } catch (error) { record('model-' + model, false, redact(error instanceof Error ? error.message : String(error))) }
  }
  try {
    const payload = await post({ model: 'qwen4.0-max-preview', messages: [{ role: 'user', content: 'Reply with only OK.' }], stream: false, max_completion_tokens: 16 })
    record('model-qwen4.0-max-preview-alias', Array.isArray(payload?.choices) && payload.choices.length > 0, 'answer=' + redact(contentOf(payload)))
  } catch (error) { record('model-qwen4.0-max-preview-alias', false, redact(error instanceof Error ? error.message : String(error))) }

  const salt = Date.now().toString(36)
  const filler = Array.from({ length: 130 }, (_, index) => 'One hour cache sentence ' + index + ' keeps one stable prefix.').join(' ')
  const body = { model: 'qwen4-max', messages: [{ role: 'user', content: salt + ' ' + filler + ' Reply only OK.' }], stream: false, enable_thinking: false, max_completion_tokens: 8, prompt_cache_options: { mode: 'implicit', ttl: '1h' } }
  try {
    const cold = await post(body); const warm = await post(body)
    const coldUsage = cacheUsage(cold); const warmUsage = cacheUsage(warm)
    record('cache-1h-cold-write', (coldUsage.write1h ?? 0) >= 1024, JSON.stringify(coldUsage))
    record('cache-1h-warm-read', (warmUsage.cached ?? 0) >= 1024 && (warmUsage.write ?? 0) === 0, JSON.stringify(warmUsage))
  } catch (error) { record('cache-1h', false, redact(error instanceof Error ? error.message : String(error))) }

  try {
    const adapter = new QianwenTokenPlanAdapter(store, settingsStore, { fetchFn: fetch })
    const sessionId = 'live-adapter-' + Date.now().toString(36)
    const firstUser = { role: 'user', content: [{ type: 'text', text: 'Calculate 6 * 7. Think briefly and reply with only the number.' }] }
    const run = async (messages: unknown[]) => {
      const chunks: any[] = []
      for await (const chunk of adapter.stream({ provider: PROVIDER_ID, model: 'qwen4-max', messages, sessionId, reasoningEffort: 'low', maxTokens: 512 } as any)) chunks.push(chunk)
      return chunks
    }
    const first = await run([firstUser])
    const blocks = first.filter(chunk => chunk.type === 'block-end').sort((a,b) => a.index - b.index).map(chunk => chunk.block)
    const firstFinish = first.find(chunk => chunk.type === 'finish')
    const firstAnswer = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
    const cipherSeen = JSON.stringify(firstFinish?.replayState ?? {}).includes('encrypted')
    record('adapter-first-stream', firstAnswer.includes('42') && cipherSeen, 'answer=' + redact(firstAnswer) + ' encryptedReplay=' + String(cipherSeen))
    const assistant = { role: 'assistant', content: blocks, source: { kind: 'qwen-live-probe', provider: PROVIDER_ID, replayState: firstFinish?.replayState } }
    const second = await run([firstUser, assistant, { role: 'user', content: [{ type: 'text', text: 'Add 1 to the previous result. Reply with only the number.' }] }])
    const secondBlocks = second.filter(chunk => chunk.type === 'block-end').sort((a,b) => a.index - b.index).map(chunk => chunk.block)
    const secondAnswer = secondBlocks.filter(block => block.type === 'text').map(block => block.text).join('')
    const secondUsage = second.find(chunk => chunk.type === 'usage')?.usage
    record('adapter-second-encrypted-replay', secondAnswer.includes('43'), 'answer=' + redact(secondAnswer) + ' usage=' + JSON.stringify(secondUsage))
  } catch (error) { record('adapter-live-stream-replay', false, redact(error instanceof Error ? error.message : String(error))) }

  console.log(JSON.stringify({ calls, results }, null, 2))
  expect(results.filter(result => !result.ok), 'remaining live failures').toEqual([])
}, 360_000)
