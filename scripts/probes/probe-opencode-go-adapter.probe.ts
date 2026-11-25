import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenCodeGoAdapter } from '../../src/host/providers/opencode-go/adapter.ts'
import { OpenCodeGoAccountPool } from '../../src/host/providers/opencode-go/account-pool.ts'
import { OpenCodeGoCatalogManager } from '../../src/host/providers/opencode-go/model-catalog.ts'
import { defaultOpenCodeGoSettings, type OpenCodeGoSettingsStore } from '../../src/host/providers/opencode-go/token-store.ts'
import { fetchOpenCodeGoUsage } from '../../src/host/providers/opencode-go/client.ts'

const apiKey = (process.env.OPENCODE_API_KEY ?? '').trim()
const model = (process.env.OPENCODE_GO_MODEL ?? 'deepseek-v4.1-flash').trim()
const sessions: string[] = []
const liveFetch: typeof fetch = async (input, init) => {
  const headers = (init?.headers ?? {}) as Record<string, string>
  if (headers['x-opencode-session'] !== undefined) sessions.push(headers['x-opencode-session'])
  return fetch(input, init)
}

function memoryBackend() {
  let data: any = null
  return { async load() { return data }, async save(value: any) { data = structuredClone(value) }, async clear() { data = null } }
}
const settingsStore = { read: async () => defaultOpenCodeGoSettings() } as unknown as OpenCodeGoSettingsStore
const options = (messages: unknown[], tools?: unknown[]) => ({ provider: 'opencode-go', model, sessionId: 'opencode-adapter-live', messages, ...(tools === undefined ? {} : { tools }) } as never)
async function collect(stream: AsyncIterable<any>): Promise<any[]> { const chunks: any[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
function textOf(chunks: any[]): string { return chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('') }

test('formal OpenCodeGoAdapter live smoke', { timeout: 300_000 }, async () => {
  if (apiKey === '') throw new Error('OPENCODE_API_KEY is required')
  const pool = new OpenCodeGoAccountPool({ backend: memoryBackend() })
  const target = await pool.addAccount({ apiKey, authenticatedAt: Date.now() }, 'Live probe')
  const adapter = new OpenCodeGoAdapter(settingsStore, new OpenCodeGoCatalogManager(), { accountPool: pool, fetchFn: liveFetch })

  const firstCall = await adapter.prepareCall('opencode-go', model)
  const first = await collect(firstCall.stream(options([{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly OK and nothing else.' }] }])))
  assert.match(textOf(first), /OK/i)
  console.log('[adapter] PASS streaming ' + JSON.stringify({ text: textOf(first), canonicalId: firstCall.model.id }))

  const tool = { name: 'probe_echo', description: 'Return the supplied probe value.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }
  const user = { role: 'user', content: [{ type: 'text', text: 'Call probe_echo exactly once with value opencode-go-ok. After its tool result arrives, reply with exactly TOOL_OK and nothing else.' }] }
  const calledCall = await adapter.prepareCall('opencode-go', model)
  const called = await collect(calledCall.stream(options([user], [tool])))
  const toolBlock = called.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.ok(toolBlock, 'missing tool call block')
  assert.equal(toolBlock.block.name, 'probe_echo')
  assert.deepEqual(JSON.parse(toolBlock.block.arguments), { value: 'opencode-go-ok' })
  const callId = toolBlock.block.id
  console.log('[adapter] PASS tool call ' + JSON.stringify({ name: toolBlock.block.name, arguments: toolBlock.block.arguments }))

  const continuedCall = await adapter.prepareCall('opencode-go', model)
  const continued = await collect(continuedCall.stream(options([
    user,
    { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'probe_echo', arguments: toolBlock.block.arguments }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify({ echo: 'opencode-go-ok' }) }] }] },
  ], [tool])))
  assert.match(textOf(continued), /TOOL_OK/i)
  assert.equal(sessions.length, 3)
  assert.equal(new Set(sessions).size, 1)
  console.log('[adapter] PASS continued session ' + JSON.stringify({ requests: sessions.length, stableHeader: true, text: textOf(continued) }))

  const quota = await fetchOpenCodeGoUsage(target.id, { apiKey, authenticatedAt: Date.now() }, liveFetch)
  assert.deepEqual(quota.windows.map(window => window.key), ['rolling', 'weekly', 'monthly'])
  console.log('[adapter] PASS quota ' + JSON.stringify(quota.windows))
  console.log('[adapter] RESULT ' + JSON.stringify({ verdict: 'PASS', model, checks: ['streaming', 'tool-call', 'continued-session', 'quota'] }))
})
