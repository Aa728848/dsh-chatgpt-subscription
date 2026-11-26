/**
 * A compaction summary follows the session's own thinking level on Antigravity.
 *
 * ACP carries the level as a `session/set_config_option` on `thought_level`
 * rather than in a request body, so an unnamed compaction must set the level the
 * main turn set, not fall back to the settings default.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AntigravityAcpAdapter } from '../../../src/host/providers/antigravity-acp/adapter.ts'
import { AntigravityAcpSettingsStore } from '../../../src/host/providers/antigravity-acp/settings.ts'
import type { GenerateOptions as HarnessGenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

// A scripted ACP server that appends every session/set_config_option to a log
// file (given as argv[2]) so the test can read what level each turn set.
const SERVER = `
import { appendFileSync } from 'node:fs'
const log = process.argv[2]
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
      reply(request.id, { protocolVersion: 1, authMethods: [] })
      continue
    }
    if (request.method === 'session/new') {
      session += 1
      reply(request.id, {
        sessionId: 'session-' + session,
        configOptions: [
          { id: 'model', type: 'select', options: [{ value: 'gemini-4-carbon' }] },
          { id: 'thought_level', type: 'select', options: [{ value: 'low' }, { value: 'high' }] },
        ],
      })
      continue
    }
    if (request.method === 'session/set_config_option') {
      appendFileSync(log, JSON.stringify({ configId: request.params.configId, value: request.params.value }) + '\\n')
      reply(request.id, { configOptions: [{ id: 'thought_level', type: 'select', options: [{ value: 'low' }, { value: 'high' }] }] })
      continue
    }
    if (request.method === 'session/prompt') {
      notify({ sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } })
      reply(request.id, { stopReason: 'end_turn' })
      continue
    }
    reply(request.id, {})
  }
})
`

function harness(): { adapter: AntigravityAcpAdapter; logPath: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-effort-test-'))
  const server = join(dir, 'server.mjs')
  const logPath = join(dir, 'config.log')
  writeFileSync(server, SERVER, 'utf8')
  writeFileSync(logPath, '', 'utf8')
  const settings = new AntigravityAcpSettingsStore(join(dir, 'settings.json'))
  const adapter = new AntigravityAcpAdapter({
    settings,
    resolveLaunch: async () => ({ command: process.execPath, args: [server, logPath] }),
    loadCatalog: async () => ({
      models: [{ id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: ['low', 'high'] }],
      synced: true,
    }),
  })
  return { adapter, logPath, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

async function send(adapter: AntigravityAcpAdapter, overrides: Record<string, unknown> = {}): Promise<void> {
  const options = {
    provider: 'antigravity-acp',
    model: 'gemini-4-carbon',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...overrides,
  } as unknown as HarnessGenerateOptions
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  expect(chunks.length).toBeGreaterThan(0)
}

/** The thought_level values the ACP server was asked to set, in order. */
function thoughtLevels(logPath: string): unknown[] {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { configId: string; value: unknown })
    .filter((entry) => entry.configId === 'thought_level')
    .map((entry) => entry.value)
}

describe('Antigravity auxiliary request effort', () => {
  it('sets a compaction at the session main-turn thought level', async () => {
    const h = harness()
    try {
      await send(h.adapter, { sessionId: 'sess-a', reasoningEffort: 'high' })
      await send(h.adapter, { sessionId: 'sess-a', purpose: 'compaction' })
      expect(thoughtLevels(h.logPath)).toEqual(['high', 'high'])
    } finally {
      await h.adapter.dispose()
      h.dispose()
    }
  })

  it('keeps a level the auxiliary request names itself', async () => {
    const h = harness()
    try {
      await send(h.adapter, { sessionId: 'sess-b', reasoningEffort: 'high' })
      await send(h.adapter, { sessionId: 'sess-b', purpose: 'compaction', reasoningEffort: 'low' })
      expect(thoughtLevels(h.logPath)).toEqual(['high', 'low'])
    } finally {
      await h.adapter.dispose()
      h.dispose()
    }
  })
})
