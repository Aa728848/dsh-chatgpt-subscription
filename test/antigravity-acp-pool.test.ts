/**
 * Process reuse and the per-process session cap.
 *
 * The idle pool used to be write-only: `release()` parked a process and started a
 * five-minute expiry timer, but no caller ever took one out, so every generation
 * paid a cold start and the pool only ever grew until it expired. These tests pin
 * the two properties that fix has to keep: a warm process is actually reused, and
 * one that has opened its session budget is disposed instead of handed back.
 *
 * `spawnClient` is the seam: it counts how many agent processes a sequence of
 * turns actually created, which is the only externally visible difference between
 * "reuse" and "spawn every time".
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AntigravityAcpAdapter } from '../src/host/antigravity-acp/adapter.ts'
import { AntigravityAcpSettingsStore } from '../src/host/antigravity-acp/settings.ts'
import { AcpClient } from '../src/host/antigravity-acp/acp-client.ts'

const SERVER = `
let buffer = ''
process.stdin.setEncoding('utf8')
let sessions = 0
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.method === 'initialize') { reply(request.id, { protocolVersion: 1, authMethods: [] }); continue }
    if (request.method === 'session/new') {
      sessions += 1
      reply(request.id, { sessionId: 's' + sessions, models: { availableModels: [] }, configOptions: [] })
      continue
    }
    if (request.method === 'session/set_config_option') { reply(request.id, {}); continue }
    if (request.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } }) + '\\n')
      reply(request.id, { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })
      continue
    }
    reply(request.id, {})
  }
})
`

interface Harness {
  adapter: AntigravityAcpAdapter
  /** How many agent processes were spawned so far. */
  spawned(): number
  dispose(): void
}

function harness(maxSessionsPerProcess?: number): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'acp-pool-test-'))
  const server = join(dir, 'server.mjs')
  writeFileSync(server, SERVER, 'utf8')
  const settings = new AntigravityAcpSettingsStore(join(dir, 'settings.json'))
  let count = 0
  const adapter = new AntigravityAcpAdapter({
    settings,
    maxSessionsPerProcess,
    resolveLaunch: async () => ({ command: process.execPath, args: [server] }),
    loadCatalog: async () => ({ models: [{ id: 'gemini-4-carbon', name: 'G', efforts: [] }], synced: true }),
    spawnClient: (launch, cwd, handlers) => {
      count += 1
      return new AcpClient({ command: launch.command, args: launch.args, cwd }, handlers)
    },
  })
  return { adapter, spawned: () => count, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

async function turn(adapter: AntigravityAcpAdapter, text: string): Promise<void> {
  for await (const _chunk of adapter.stream({
    provider: 'antigravity-acp',
    model: 'gemini-4-carbon',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  } as never)) { /* consume */ }
}

describe('process reuse', () => {
  it('reuses one warm process across several turns when the cap allows it', async () => {
    const h = harness(100)
    try {
      await turn(h.adapter, 'first')
      await turn(h.adapter, 'second')
      await turn(h.adapter, 'third')
      // The whole point of the pool: three generations, one cold start.
      expect(h.spawned()).toBe(1)
    } finally {
      await h.adapter.dispose()
      h.dispose()
    }
  })

  it('starts a new process once the old one reached its session budget', async () => {
    const h = harness(1)
    try {
      await turn(h.adapter, 'first')
      await turn(h.adapter, 'second')
      // A process that has opened its only permitted session is disposed, not
      // handed back - that is what bounds agent-side session growth.
      expect(h.spawned()).toBe(2)
    } finally {
      await h.adapter.dispose()
      h.dispose()
    }
  })
})
