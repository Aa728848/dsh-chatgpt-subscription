/**
 * Delegated runs: the model they are told to use, and how many may run at once.
 *
 * Both used to be missing. The backend advertises `agentOptions` now, which is what
 * makes the host willing to pass a model selection at all, and every run spawns a
 * whole official agent, so a burst of delegation is bounded like the main turns.
 */
import { describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider } from '../../../src/host/providers/antigravity-acp/subagent.ts'
import { AntigravityAcpSettingsStore } from '../../../src/host/providers/antigravity-acp/settings.ts'

const SERVER = String.raw`
import { appendFileSync } from 'node:fs'
const log = process.argv[2]
const record = (event) => appendFileSync(log, JSON.stringify(event) + '\n')
let buffer = ''
process.stdin.setEncoding('utf8')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    if (request.method === 'initialize') {
      record({ kind: 'initialize' })
      reply(request.id, { protocolVersion: 1, authMethods: [] })
      continue
    }
    if (request.method === 'session/new') {
      record({ kind: 'session/new' })
      reply(request.id, { sessionId: 'child-1' })
      continue
    }
    if (request.method === 'session/set_config_option') {
      record({ kind: 'set_config_option', configId: request.params.configId, value: request.params.value })
      reply(request.id, { configOptions: [] })
      continue
    }
    if (request.method === 'session/prompt') {
      record({ kind: 'prompt' })
      const text = request.params.prompt.map((block) => block.text || '').join('')
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'child-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child answer' } } },
      }) + '\n')
      if (text.includes('HOLD')) setTimeout(() => reply(request.id, { stopReason: 'end_turn' }), 1200)
      else reply(request.id, { stopReason: 'end_turn' })
      continue
    }
    reply(request.id, {})
  }
})
`

interface Space {
  provider: ReturnType<typeof createProvider>
  events(): Array<Record<string, unknown>>
  dispose(): void
}

function space(overrides: { maxActiveRuns?: number } = {}): Space {
  const dir = mkdtempSync(join(tmpdir(), 'acp-subagent-runs-'))
  const server = join(dir, 'server.mjs')
  const log = join(dir, 'events.jsonl')
  writeFileSync(server, SERVER, 'utf8')
  writeFileSync(log, '', 'utf8')
  const settings = new AntigravityAcpSettingsStore(join(dir, 'settings.json'))
  const provider = createProvider({
    resolveLaunch: async () => ({ command: process.execPath, args: [server, log] }),
    settings,
    ...overrides,
  })
  return {
    provider,
    events: () => readFileSync(log, 'utf8').split('\n').filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('antigravity subagent runs', () => {
  it('selects the requested model and thinking level before the prompt', async () => {
    const harness = space()
    try {
      const run = await harness.provider.start({
        cwd: process.cwd(),
        prompt: [{ type: 'text', text: 'do the thing' }],
        agentOptions: { model: 'gemini-4-hydrogen', reasoningEffort: 'high' },
      } as never)
      await run.result
      const events = harness.events()
      const configs = events.filter((event) => event.kind === 'set_config_option')
      expect(configs).toContainEqual({ kind: 'set_config_option', configId: 'model', value: 'gemini-4-hydrogen' })
      expect(configs).toContainEqual({ kind: 'set_config_option', configId: 'thought_level', value: 'high' })
      const kinds = events.map((event) => event.kind)
      expect(kinds.indexOf('prompt')).toBeGreaterThan(kinds.lastIndexOf('set_config_option'))
      await run.dispose()
    } finally {
      harness.dispose()
    }
  })

  it('refuses a run beyond its own concurrency budget', async () => {
    const harness = space({ maxActiveRuns: 1 })
    try {
      const first = await harness.provider.start({
        cwd: process.cwd(),
        prompt: [{ type: 'text', text: 'HOLD the prompt' }],
      } as never)
      await expect(harness.provider.start({
        cwd: process.cwd(),
        prompt: [{ type: 'text', text: 'second task' }],
      } as never)).rejects.toMatchObject({ failure: { code: 'ACP_SESSION_LIMIT' } })
      const result = await first.result
      expect(result.stopReason).toBe('completed')
      await first.dispose()
      // The budget is handed back with the run, so the next delegation is allowed.
      const third = await harness.provider.start({
        cwd: process.cwd(),
        prompt: [{ type: 'text', text: 'third task' }],
      } as never)
      await third.result
      await third.dispose()
    } finally {
      harness.dispose()
    }
  })
})
