/**
 * Cross-turn ACP session reuse: the fix for "every user message opens a new
 * conversation and replays the whole history".
 *
 * The scripted server below records every protocol frame it receives into a JSONL
 * file, so these tests assert on what the agent actually saw - how many
 * conversations were opened, which prompt text reached the same session, and
 * whether a model switch was applied as a config option instead of a new session.
 * A boot record per process makes "did a new `agy` have to start" observable too.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AntigravityAcpAdapter } from '../src/host/antigravity-acp/adapter.ts'
import { AntigravityAcpSettingsStore } from '../src/host/antigravity-acp/settings.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'

const SERVER = `
import { appendFileSync } from 'node:fs'
const log = process.argv[2]
const record = (event) => appendFileSync(log, JSON.stringify(event) + '\\n')
record({ kind: 'boot', pid: process.pid })
let buffer = ''
process.stdin.setEncoding('utf8')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const notify = (params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params }) + '\\n')
let sessions = 0
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.id === undefined) {
      record({ kind: 'notify', method: request.method, sessionId: (request.params || {}).sessionId })
      continue
    }
    if (request.method === 'initialize') {
      reply(request.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} },
        },
        authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
      })
      continue
    }
    if (request.method === 'session/new') {
      sessions += 1
      const mcp = (request.params.mcpServers || [])[0]
      record({ kind: 'session/new', sessionId: 'session-' + sessions, bridge: mcp ? mcp.url : null })
      reply(request.id, {
        sessionId: 'session-' + sessions,
        availableModels: [{ modelId: 'gemini-4-carbon-low' }, { modelId: 'gemini-4-carbon-high' }, { modelId: 'gemini-4-hydrogen-xhigh' }],
        configOptions: [
          { id: 'model', type: 'select', currentValue: 'gemini-4-carbon', options: [{ value: 'gemini-4-carbon' }, { value: 'gemini-4-hydrogen' }] },
          { id: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] },
        ],
      })
      continue
    }
    if (request.method === 'session/set_config_option') {
      record({ kind: 'set_config_option', sessionId: request.params.sessionId, configId: request.params.configId, value: request.params.value })
      reply(request.id, { configOptions: [{ id: 'thought_level', type: 'select', options: [{ value: 'low' }, { value: 'high' }] }] })
      continue
    }
    if (request.method === 'session/prompt') {
      const texts = request.params.prompt.map((block) => String(block.text || ''))
      record({ kind: 'prompt', sessionId: request.params.sessionId, texts })
      notify({ sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok:' + request.params.sessionId } } })
      const slow = texts.join(' ').includes('SLOW')
      if (slow) setTimeout(() => reply(request.id, { stopReason: 'end_turn' }), 1500)
      else reply(request.id, { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } })
      continue
    }
    reply(request.id, {})
  }
})
`

interface Events {
  boot(): number
  of(kind: string): Array<Record<string, unknown>>
  prompts(): string[][]
}

interface Harness {
  adapter: AntigravityAcpAdapter
  events: Events
  dispose(): void
}

function adapterHarness(overrides: Partial<Record<string, unknown>> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'acp-reuse-test-'))
  const logPath = join(dir, 'events.jsonl')
  const server = join(dir, 'server.mjs')
  writeFileSync(server, SERVER, 'utf8')
  writeFileSync(logPath, '', 'utf8')
  const settings = new AntigravityAcpSettingsStore(join(dir, 'settings.json'))
  const adapter = new AntigravityAcpAdapter({
    settings,
    resolveLaunch: async () => ({ command: process.execPath, args: [server, logPath] }),
    loadCatalog: async () => ({ models: [], synced: true }),
    ...overrides,
  })
  return {
    adapter,
    events: {
      boot: () => readEvents(logPath).filter((event) => event.kind === 'boot').length,
      of: (kind: string) => readEvents(logPath).filter((event) => event.kind === kind),
      prompts: () => readEvents(logPath)
        .filter((event) => event.kind === 'prompt')
        .map((event) => (event.texts as string[] | undefined) ?? []),
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function readEvents(logPath: string): Array<Record<string, unknown>> {
  const text = readFileSync(logPath, 'utf8')
  const events: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // A partially flushed line is not an event worth failing a test over.
    }
  }
  return events
}

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] })

function optionsOf(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'antigravity-acp',
    model: 'gemini-4-carbon',
    messages: [user('first request')],
    ...overrides,
  } as GenerateOptions
}

const TOOL_A = { name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: {} } }
const TOOL_B = { name: 'write_file', description: 'write a file', parameters: { type: 'object', properties: {} } }

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** The prompt text the agent received, as one string per prompt. */
function promptTexts(events: Events): string[] {
  return events.prompts().map((texts) => texts.join('\n'))
}

describe('ACP session reuse across turns', () => {
  it('sends the next user message as an increment on the same conversation', async () => {
    const harness = adapterHarness()
    try {
      await collect(harness.adapter.stream(optionsOf() as never))
      expect(harness.events.of('session/new')).toHaveLength(1)

      await collect(harness.adapter.stream(optionsOf({
        messages: [user('first request'), assistant('finished the earlier work'), user('now the second one')],
      }) as never))

      // No second conversation: the whole point of the fix.
      expect(harness.events.of('session/new')).toHaveLength(1)
      // One process, reused, rather than a fresh `agy` per message.
      expect(harness.events.boot()).toBe(1)
      const prompts = promptTexts(harness.events)
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toContain('first request')
      // The increment carries the new turn only; the first request is not replayed.
      // (The assistant echo is there - it is the answer the agent itself produced,
      // and the harness records it as part of the history it sends back.)
      expect(prompts[1]).toContain('now the second one')
      expect(prompts[1]).not.toContain('first request')
      // And the session id it was sent on is the one the conversation was created with.
      expect(harness.events.prompts().map((_, index) => harness.events.of('prompt')[index]?.sessionId))
        .toEqual(['session-1', 'session-1'])
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })

  it('applies a model switch on the same conversation instead of starting another', async () => {
    const harness = adapterHarness()
    try {
      // `reasoningEffort` is a branded id on the harness type; the adapter only
      // reads the level name, which is what these literals carry.
      await collect(harness.adapter.stream(optionsOf({ reasoningEffort: 'low' as never }) as never))
      await collect(harness.adapter.stream(optionsOf({
        model: 'gemini-4-hydrogen',
        reasoningEffort: 'high' as never,
        messages: [user('first request'), assistant('answer'), user('switch to hydrogen')],
      }) as never))

      expect(harness.events.of('session/new')).toHaveLength(1)
      const configs = harness.events.of('set_config_option')
      const switched = configs.filter((event) => event.value === 'gemini-4-hydrogen')
      expect(switched).toHaveLength(1)
      expect(switched[0]?.sessionId).toBe('session-1')
      expect(configs.some((event) => event.configId === 'thought_level' && event.value === 'high')).toBe(true)
      expect(promptTexts(harness.events)[1]).toContain('switch to hydrogen')
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })

  it('replays the whole history behind a boundary marker when the prefix was rewritten', async () => {
    const harness = adapterHarness()
    try {
      await collect(harness.adapter.stream(optionsOf() as never))
      // What a compaction looks like to this adapter: the history no longer begins
      // with what the agent was told, so the parked session cannot be trusted.
      await collect(harness.adapter.stream(optionsOf({
        messages: [user('[summary] earlier work'), assistant('summary read'), user('carry on')],
      }) as never))

      expect(harness.events.of('session/new')).toHaveLength(2)
      const replay = promptTexts(harness.events)[1] ?? ''
      expect(replay).toContain('[summary] earlier work')
      // A replayed transcript ends with the boundary sentence, so the agent reads
      // it as history rather than as a fresh queue of requests.
      expect(replay).toContain('[history boundary]')
      expect(replay).toContain('The current request is the LAST user message')
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })

  it('opens a new session when the tool catalogue changed', async () => {
    const harness = adapterHarness()
    try {
      await collect(harness.adapter.stream(optionsOf({ tools: [TOOL_A] }) as never))
      await collect(harness.adapter.stream(optionsOf({
        tools: [TOOL_B],
        messages: [user('first request'), assistant('answer'), user('use the other tool')],
      }) as never))

      // The agent listed the bridge's tools once and the bridge publishes no change
      // feed, so a different catalogue cannot reach the parked session.
      expect(harness.events.of('session/new')).toHaveLength(2)
      expect(promptTexts(harness.events)[1]).toContain('use the other tool')
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })

  it('cancels the prompt and keeps the process after a turn is aborted', async () => {
    const harness = adapterHarness()
    const controller = new AbortController()
    try {
      const stream = harness.adapter.stream(optionsOf({
        messages: [user('SLOW first request')],
        signal: controller.signal,
      }) as never)
      await expect((async (): Promise<void> => {
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') controller.abort()
        }
      })()).rejects.toMatchObject({ failure: { code: 'ABORTED' } })

      // The process survives: the next message costs a session, not a spawn.
      await collect(harness.adapter.stream(optionsOf({ messages: [user('unrelated follow-up')] }) as never))
      expect(harness.events.boot()).toBe(1)
      expect(harness.events.of('session/new')).toHaveLength(2)

      // The running prompt was cancelled rather than silently abandoned. Asserted
      // after the second generation on purpose: `session/cancel` is a fire-and-forget
      // notification, and it shares the child's stdin with the frames of the turn
      // that follows, so by the time that turn has answered the server has already
      // read it. Reading the log straight after the abort is a race the Linux
      // runner loses even when the client behaved correctly.
      const cancels = harness.events.of('notify').filter((event) => event.method === 'session/cancel')
      expect(cancels).toHaveLength(1)
      expect(cancels[0]?.sessionId).toBe('session-1')
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })

  it('leaves the parked conversation alone when an auxiliary request reuses its session id', async () => {
    const harness = adapterHarness()
    try {
      await collect(harness.adapter.stream(optionsOf() as never))
      // What a session title looks like on the wire: the same DSH session id, with
      // a history of its own. Consuming or replacing the parked conversation here
      // would put the user's next message back on a cold replay.
      await collect(harness.adapter.stream(optionsOf({
        purpose: 'session-title',
        messages: [user('name this conversation')],
      }) as never))
      await collect(harness.adapter.stream(optionsOf({
        messages: [user('first request'), assistant('answer'), user('carry on')],
      }) as never))

      const prompts = harness.events.of('prompt')
      expect(prompts).toHaveLength(3)
      expect(prompts[2]?.sessionId).toBe('session-1')
      expect(promptTexts(harness.events)[2]).toContain('carry on')
      expect(promptTexts(harness.events)[2]).not.toContain('first request')
      // The parked session pins its own process, so the auxiliary turn runs on a
      // second one - and the real conversation still sees no new session.
      expect(harness.events.of('session/new')).toHaveLength(2)
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })

  it('recycles a parked session when parking is switched off', async () => {
    const harness = adapterHarness({ dormantSessionLimit: 0 })
    try {
      await collect(harness.adapter.stream(optionsOf() as never))
      await collect(harness.adapter.stream(optionsOf({
        messages: [user('first request'), assistant('answer'), user('second one')],
      }) as never))

      expect(harness.events.of('session/new')).toHaveLength(2)
      // The process is still warm even though the conversation was not kept.
      expect(harness.events.boot()).toBe(1)
      expect(promptTexts(harness.events)[1]).toContain('second one')
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })
})
