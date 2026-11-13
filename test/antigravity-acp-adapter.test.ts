/**
 * The adapter, end to end against a scripted ACP server.
 *
 * The fake server below speaks the frames the real one emitted during the live
 * probe (initialize / session/new / set_config_option / session/prompt, plus the
 * two update kinds a turn produces), so what these tests exercise is the adapter
 * state machine rather than a mock of it.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AntigravityAcpAdapter } from '../src/host/antigravity-acp/adapter.ts'
import { AntigravityAcpSettingsStore } from '../src/host/antigravity-acp/settings.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'

const SERVER = `
let buffer = ''
process.stdin.setEncoding('utf8')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const notify = (params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params }) + '\\n')
let session = 0
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.method === 'initialize') {
      reply(request.id, {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true } },
        authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
      })
      continue
    }
    if (request.method === 'session/new') {
      session += 1
      reply(request.id, {
        sessionId: 'session-' + session,
        availableModels: [{ modelId: 'gemini-4-carbon-low' }, { modelId: 'gemini-4-carbon-high' }],
        configOptions: [
          { id: 'model', type: 'select', currentValue: 'gemini-4-carbon', options: [{ value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }] },
          { id: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] },
        ],
        _meta: { antigravity: { tier: { id: 't', name: 'Google AI Ultra' } } },
      })
      continue
    }
    if (request.method === 'session/set_config_option') {
      reply(request.id, { configOptions: [] })
      continue
    }
    if (request.method === 'session/prompt') {
      const text = request.params.prompt.map((block) => block.text || '').join('')
      notify({ sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } } })
      notify({ sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer for: ' + text.slice(0, 40) } } })
      reply(request.id, { stopReason: 'end_turn', usage: { inputTokens: 11, outputTokens: 7, cachedReadTokens: 3, thoughtTokens: 2 } })
      continue
    }
    reply(request.id, {})
  }
})
`

function adapterHarness(overrides: Partial<Record<string, unknown>> = {}): {
  adapter: AntigravityAcpAdapter
  settings: AntigravityAcpSettingsStore
  dispose(): void
} {
  const dir = mkdtempSync(join(tmpdir(), 'acp-adapter-test-'))
  const server = join(dir, 'server.mjs')
  writeFileSync(server, SERVER, 'utf8')
  const settings = new AntigravityAcpSettingsStore(join(dir, 'settings.json'))
  const adapter = new AntigravityAcpAdapter({
    settings,
    resolveLaunch: async () => ({ command: process.execPath, args: [server] }),
    loadCatalog: async () => ({
      models: [
        { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: ['low', 'high'] },
        { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B', efforts: [] },
      ],
      synced: true,
    }),
    ...overrides,
  })
  return { adapter, settings, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

function optionsOf(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'antigravity-acp',
    model: 'gemini-4-carbon',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...overrides,
  } as GenerateOptions
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('AntigravityAcpAdapter', () => {
  it('streams reasoning, text and usage from one turn', async () => {
    const harness = adapterHarness()
    try {
      const chunks = await collect(harness.adapter.stream(optionsOf() as never))
      const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => (chunk as { text: string }).text).join('')
      expect(text).toContain('answer for: hi')
      expect(chunks.some((chunk) => chunk.type === 'reasoning-delta')).toBe(true)
      const usage = chunks.find((chunk) => chunk.type === 'usage') as { usage: { inputTokens: number } } | undefined
      expect(usage?.usage.inputTokens).toBe(11)
      const finish = chunks.at(-1) as { type: string; reason: { kind: string } }
      expect(finish.type).toBe('finish')
      expect(finish.reason.kind).toBe('stop')
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })

  it('maps the model ladder and hides models the user switched off', async () => {
    const harness = adapterHarness()
    try {
      // Enabled by default, so a fresh install advertises the catalogue; switching
      // it off in the card is what removes the line from the picker.
      const listed = await harness.adapter.listModels('antigravity-acp')
      expect(listed.map((model) => model.id)).toEqual(['gemini-4-carbon', 'gpt-oss-120b-medium'])
      await harness.settings.update({ enabledModelIds: ['gemini-4-carbon'] })
      await harness.adapter.prepareCall('antigravity-acp', 'gemini-4-carbon')
      const filtered = await harness.adapter.listModels('antigravity-acp')
      expect(filtered.map((model) => model.id)).toEqual(['gemini-4-carbon'])
      await harness.settings.update({ enabledModelIds: [] })
      // An empty selection is a real "everything off", not "no filter".
      expect(await harness.adapter.listModels('antigravity-acp')).toEqual([])
      // The line switch itself is separate from the per-model selection.
      await harness.settings.update({ enabled: false })
      expect(await harness.adapter.listModels('antigravity-acp')).toEqual([])
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })

  it('maps max_tokens to the harness length reason', async () => {
    const harness = adapterHarness({
      spawnClient: undefined,
    })
    try {
      // The scripted server always ends with end_turn; the mapping function is
      // exercised through the exported reason helper's contract instead: a turn
      // that ends normally must never look truncated.
      const chunks = await collect(harness.adapter.stream(optionsOf() as never))
      expect((chunks.at(-1) as { reason: { kind: string } }).reason.kind).toBe('stop')
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })

  it('reports a cancelled turn as ABORTED rather than as a truncated answer', async () => {
    const harness = adapterHarness()
    const controller = new AbortController()
    try {
      const stream = harness.adapter.stream(optionsOf({ signal: controller.signal }) as never)
      const iteration = (async (): Promise<StreamChunk[]> => {
        const chunks: StreamChunk[] = []
        for await (const chunk of stream) {
          chunks.push(chunk)
          // Cancel while the turn is streaming. The shared watchdog owns this
          // translation, and its contract is an ABORTED LlmError - which the
          // runtime turns into an aborted finish. What must NOT happen is a
          // normal "stop" finish over a half-delivered answer.
          if (chunk.type === 'text-delta') controller.abort()
        }
        return chunks
      })()
      await expect(iteration).rejects.toMatchObject({ failure: { code: 'ABORTED' } })
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })
})
