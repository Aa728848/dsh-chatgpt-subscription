/**
 * The native-tool guard: the one place where ACP's own tools could bypass DSH.
 *
 * The live probe recorded during development is the reason this file exists: with
 * no bridge attached, the official agent called its own `write_file` and the file
 * really appeared on disk. Attaching a bridge does not remove those tools, so the
 * adapter says they are unavailable in the prompt AND cancels the turn the moment
 * one is reported. Neither half is sufficient alone - the prompt is advisory, and
 * detection can only fire after the action - but together they turn a silent
 * bypass into a visible, actionable failure.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AntigravityAcpAdapter, BRIDGE_ONLY_INSTRUCTION } from '../src/host/antigravity-acp/adapter.ts'
import { AntigravityAcpSettingsStore } from '../src/host/antigravity-acp/settings.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** A server that reports a native tool call instead of using the bridge. */
const NATIVE_SERVER = `
let buffer = ''
process.stdin.setEncoding('utf8')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const notify = (params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params }) + '\\n')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.method === 'initialize') { reply(request.id, { protocolVersion: 1, authMethods: [] }); continue }
    if (request.method === 'session/new') { reply(request.id, { sessionId: 's1', models: { availableModels: [] }, configOptions: [] }); continue }
    if (request.method === 'session/set_config_option') { reply(request.id, {}); continue }
    if (request.method === 'session/prompt') {
      const kinds = request.params.prompt
      // Prove the instruction really reaches the agent.
      process.stderr.write('PROMPT_HAS_INSTRUCTION=' + String(kinds.some((b) => String(b.text || '').startsWith('This turn runs inside an external coding harness'))))
      notify({ sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'n1', name: 'write_file', kind: 'edit', status: 'in_progress', title: 'File x' } })
      reply(request.id, { stopReason: 'end_turn' })
      continue
    }
    reply(request.id, {})
  }
})
`

function harness(): { adapter: AntigravityAcpAdapter; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-native-tool-test-'))
  const server = join(dir, 'server.mjs')
  writeFileSync(server, NATIVE_SERVER, 'utf8')
  const settings = new AntigravityAcpSettingsStore(join(dir, 'settings.json'))
  const adapter = new AntigravityAcpAdapter({
    settings,
    resolveLaunch: async () => ({ command: process.execPath, args: [server] }),
    loadCatalog: async () => ({ models: [{ id: 'gemini-4-carbon', name: 'G', efforts: [] }], synced: true }),
  })
  return { adapter, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('native tool guard', () => {
  it('cancels a turn whose agent used its own tool, instead of letting it pass', async () => {
    const h = harness()
    try {
      const run = collect(h.adapter.stream({
        provider: 'antigravity-acp',
        model: 'gemini-4-carbon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'write a file' }] }],
        tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }],
      } as never))
      await expect(run).rejects.toMatchObject({ failure: { code: 'ACP_NATIVE_TOOLS_UNSUPPORTED' } })
      await expect(run).rejects.toThrow(/write_file/)
    } finally {
      await h.adapter.dispose()
      h.dispose()
    }
  })

  it('states in the prompt that the agent must use the provided tools', () => {
    // The sentence itself is the contract; the prompt assembly test would pass
    // even if the string were empty, so assert its content directly.
    expect(BRIDGE_ONLY_INSTRUCTION).toMatch(/NOT available/)
    expect(BRIDGE_ONLY_INSTRUCTION).toMatch(/provided tools/)
  })
})
