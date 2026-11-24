/**
 * Authorized live Qwen Token Plan smoke. At most ten small generation calls.
 * Run: npx vitest run --config vitest.probe.config.ts scripts/probe-qianwen-token-plan.probe.ts
 * Never prints the API key, ciphertext, full prompts, or full response bodies.
 */
import { test, expect } from 'vitest'
import { deflateSync } from 'node:zlib'
import { QianwenCredentialStore, QianwenSettingsStore } from '../../src/host/providers/qianwen-token-plan/token-store.ts'
import { QIANWEN_CHAT_COMPLETIONS_URL, QIANWEN_MODELS_URL, qianwenHeaders } from '../../src/host/providers/qianwen-token-plan/types.ts'

const MAX_CALLS = 10
let calls = 0
let apiKey = ''
const results: Array<{ name: string; ok: boolean; detail: string }> = []
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail })
  console.log('[qwen-live] ' + (ok ? 'PASS ' : 'FAIL ') + name + ' :: ' + detail)
}
const redact = (text: string) => text.replace(/sk-sp-[A-Za-z0-9_-]+/g, '[redacted-key]').replace(/"encrypted_content"\s*:\s*"[^"]*"/g, '"encrypted_content":"[redacted]"').slice(0, 300)
const contentOf = (payload: any): string => typeof payload?.choices?.[0]?.message?.content === 'string' ? payload.choices[0].message.content : ''
const usageOf = (payload: any) => {
  const usage = payload?.usage
  if (usage === undefined) return undefined
  const details = usage.prompt_tokens_details ?? {}
  return {
    prompt: usage.prompt_tokens, completion: usage.completion_tokens, cached: details.cached_tokens,
    write: details.cache_write_tokens, write5m: details.cache_creation?.ephemeral_5m_input_tokens,
    write1h: details.cache_creation?.ephemeral_1h_input_tokens, reasoning: usage.completion_tokens_details?.reasoning_tokens,
  }
}
async function post(label: string, body: Record<string, unknown>) {
  if (calls >= MAX_CALLS) throw new Error('generation call budget exhausted at ' + label)
  calls += 1
  const started = Date.now()
  const response = await fetch(QIANWEN_CHAT_COMPLETIONS_URL, {
    method: 'POST', headers: qianwenHeaders(apiKey), body: JSON.stringify(body), signal: AbortSignal.timeout(100_000),
  })
  const text = await response.text()
  let payload: any = undefined
  try { payload = JSON.parse(text) } catch { /* handled below */ }
  if (!response.ok) throw new Error(label + ' HTTP ' + response.status + ' ' + redact(payload?.error?.message ?? text))
  if (payload === undefined) throw new Error(label + ' returned non-JSON: ' + redact(text))
  return { payload, latencyMs: Date.now() - started }
}
function pngRed32(): string {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
  const crc = (bytes: Uint8Array) => { let c = 0xffffffff; for (const byte of bytes) c = table[(c ^ byte) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (name: string, data: Uint8Array) => {
    const type = Buffer.from(name, 'ascii'); const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0); type.copy(out, 4); Buffer.from(data).copy(out, 8)
    out.writeUInt32BE(crc(Buffer.concat([type, Buffer.from(data)])), 8 + data.length); return out
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(32, 0); ihdr.writeUInt32BE(32, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc(32 * (1 + 32 * 4))
  for (let y = 0; y < 32; y += 1) { const row = y * 129; raw[row] = 0; for (let x = 0; x < 32; x += 1) { raw[row + 1 + x * 4] = 255; raw[row + 4 + x * 4] = 255 } }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',new Uint8Array())]).toString('base64')
}

test('authorized Qwen Token Plan live smoke', async () => {
  const store = new QianwenCredentialStore()
  const credentials = await store.read()
  expect(credentials, 'No Qwen Token Plan API key is configured in the real host store').not.toBeNull()
  apiKey = credentials!.apiKey
  const settings = await new QianwenSettingsStore().read()
  console.log('[qwen-live] local settings: ttl=' + settings.cacheTtl + ' effort=' + String(settings.defaultReasoningEffort) + ' models=' + String(settings.enabledModelIds?.length ?? 'default-all'))

  const listing = await fetch(QIANWEN_MODELS_URL, { headers: qianwenHeaders(apiKey), signal: AbortSignal.timeout(30_000) })
  const listingText = await listing.text()
  if (listing.ok) {
    try {
      const parsed = JSON.parse(listingText)
      const ids = Array.isArray(parsed?.data) ? parsed.data.map((entry: any) => entry?.id).filter((id: unknown) => typeof id === 'string') : []
      console.log('[qwen-live] GET /models HTTP ' + listing.status + ' ids=' + JSON.stringify(ids))
    } catch { console.log('[qwen-live] GET /models HTTP ' + listing.status + ' non-JSON') }
  } else console.log('[qwen-live] GET /models HTTP ' + listing.status + ' (catalog endpoint not assumed)')

  try {
    const connected = await post('connection', { model: 'qwen4-max', messages: [{ role: 'user', content: 'Reply with only OK.' }], stream: false, enable_thinking: false, max_completion_tokens: 8 })
    record('connection-qwen4-max', contentOf(connected.payload).includes('OK'), 'latency=' + connected.latencyMs + 'ms answer=' + redact(contentOf(connected.payload)))
  } catch (error) {
    record('connection-qwen4-max', false, redact(error instanceof Error ? error.message : String(error)))
    console.log(JSON.stringify({ calls, results }, null, 2))
    throw error
  }

  const salt = Date.now().toString(36)
  const filler = Array.from({ length: 180 }, (_, index) => 'Cache probe sentence ' + index + ' preserves stable repository context.').join(' ')
  const cacheBody = { model: 'qwen4-max', messages: [{ role: 'user', content: salt + ' ' + filler + ' Reply with only OK.' }], stream: false, enable_thinking: false, max_completion_tokens: 8, prompt_cache_options: { mode: 'implicit', ttl: '5m' } }
  try {
    const cold = await post('cache-cold', cacheBody)
    const warm = await post('cache-warm', cacheBody)
    const coldUsage = usageOf(cold.payload); const warmUsage = usageOf(warm.payload)
    record('explicit-cache-cold-write', (coldUsage?.write ?? 0) >= 1024, JSON.stringify(coldUsage))
    record('explicit-cache-warm-read', (warmUsage?.cached ?? 0) >= 1024 && (warmUsage?.write ?? 0) === 0, JSON.stringify(warmUsage))
  } catch (error) { record('explicit-cache', false, redact(error instanceof Error ? error.message : String(error))) }

  const thinking = { enable_thinking: true, reasoning_effort: 'low', thinking_display: 'summarized', preserve_thinking: true }
  try {
    const question = 'Calculate 17 * 23. Think briefly and reply with only the number.'
    const first = await post('cot-first', { model: 'qwen4-max', messages: [{ role: 'user', content: question }], stream: false, max_completion_tokens: 1024, ...thinking })
    const message = first.payload?.choices?.[0]?.message
    const cipher = typeof message?.encrypted_content === 'string' ? message.encrypted_content : ''
    record('cot-ciphertext-returned', cipher !== '', 'cipherBytes=' + cipher.length + ' summaryChars=' + String(message?.reasoning_content?.length ?? 0) + ' usage=' + JSON.stringify(usageOf(first.payload)))
    if (cipher !== '') {
      const second = await post('cot-replay', { model: 'qwen4-max', messages: [
        { role: 'user', content: question },
        { role: 'assistant', content: contentOf(first.payload), encrypted_content: cipher },
        { role: 'user', content: 'Add 9 to the previous result. Reply with only the number.' },
      ], stream: false, max_completion_tokens: 1024, ...thinking })
      record('cot-encrypted-replay', contentOf(second.payload).includes('400'), 'answer=' + redact(contentOf(second.payload)) + ' usage=' + JSON.stringify(usageOf(second.payload)))
    }
  } catch (error) { record('cot-summary-replay', false, redact(error instanceof Error ? error.message : String(error))) }

  const weatherTool = { type: 'function', function: { name: 'get_current_weather', description: 'Get current weather for one city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }
  try {
    const user = { role: 'user', content: 'Use get_current_weather to find Beijing weather. Do not answer from your own knowledge.' }
    const first = await post('tool-call', { model: 'qwen4-max', messages: [user], tools: [weatherTool], tool_choice: 'auto', stream: false, enable_thinking: false, max_completion_tokens: 256 })
    const message = first.payload?.choices?.[0]?.message
    const toolCall = message?.tool_calls?.[0]
    record('function-call-emitted', typeof toolCall?.id === 'string', 'name=' + String(toolCall?.function?.name ?? 'none'))
    if (typeof toolCall?.id === 'string') {
      const second = await post('tool-result', { model: 'qwen4-max', messages: [user, message, { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ temperatureC: 21, condition: 'clear' }) }], tools: [weatherTool], stream: false, enable_thinking: false, max_completion_tokens: 128 })
      record('tool-result-integrated', contentOf(second.payload).includes('21'), 'answer=' + redact(contentOf(second.payload)))
    }
  } catch (error) { record('function-calling', false, redact(error instanceof Error ? error.message : String(error))) }

  try {
    const vision = await post('vision', { model: 'qwen4-max', messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + pngRed32(), detail: 'low' }, max_pixels: 65_536 },
      { type: 'text', text: 'What is the dominant color? Reply with one English word.' },
    ] }], stream: false, enable_thinking: false, max_completion_tokens: 32 })
    record('vision-inline-image', /red/i.test(contentOf(vision.payload)), 'answer=' + redact(contentOf(vision.payload)) + ' usage=' + JSON.stringify(usageOf(vision.payload)))
  } catch (error) { record('vision-inline-image', false, redact(error instanceof Error ? error.message : String(error))) }

  for (const model of ['qwen4-max-preview', 'qwen3.8-flash']) {
    if (calls >= MAX_CALLS) break
    try {
      const reply = await post('model-' + model, { model, messages: [{ role: 'user', content: 'Reply with only OK.' }], stream: false, enable_thinking: false, max_completion_tokens: 16 })
      record('model-' + model, reply.payload?.choices?.length > 0, 'answer=' + redact(contentOf(reply.payload)) + ' usage=' + JSON.stringify(usageOf(reply.payload)))
    } catch (error) { record('model-' + model, false, redact(error instanceof Error ? error.message : String(error))) }
  }

  console.log(JSON.stringify({ calls, results }, null, 2))
  expect(results.filter(result => !result.ok), 'live smoke failures').toEqual([])
}, 360_000)
