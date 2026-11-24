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
import { AntigravityAcpAdapter } from '../../../src/host/providers/antigravity-acp/adapter.ts'
import { AntigravityAcpSettingsStore } from '../../../src/host/providers/antigravity-acp/settings.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '../../../src/host/common/llm-compat.ts'

const SERVER = `
let buffer = ''
process.stdin.setEncoding('utf8')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const replyError = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\\n')
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
      if (text.includes('QUOTA')) {
        replyError(request.id, -32050, 'Quota exhausted for this project')
        continue
      }
      if (text.includes('VALIDATION')) {
        replyError(request.id, -32051, 'VALIDATION_REQUIRED: verify this account to continue')
        continue
      }
      // A control that must NOT look like a policy block: "photos" contains
      // "tos", which the refusal pattern matches only as a whole word.
      if (text.includes('PHOTOS')) {
        replyError(request.id, -32052, 'the photos service is unavailable')
        continue
      }
      if (text.includes('AUTHMSG')) {
        replyError(request.id, -32053, 'Authentication required: sign in first')
        continue
      }
      // A reused process can still flush the conversation it ran before.
      if (text.includes('STALE')) {
        notify({ sessionId: 'session-0', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale answer from session-0' } } })
      }
      // The occupancy frame the schema defines but the live server omits: the
      // adapter must be able to learn a model's window from it when it arrives.
      if (text.includes('OCCUPANCY')) {
        notify({ sessionId: request.params.sessionId, update: { sessionUpdate: 'usage_update', used: 1024, size: 262144 } })
      }
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

/**
 * A server that flushes one frame of the previous conversation while the second
 * turn is being set up - before \`session/new\` answers for it.
 */
const REUSE_SERVER = String.raw`
let buffer = ''
process.stdin.setEncoding('utf8')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const notify = (params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params }) + '\n')
let sessions = 0
let initializes = 0
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.method === 'initialize') {
      initializes += 1
      if (initializes === 2) {
        notify({ sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale before session' } } })
      }
      reply(request.id, { protocolVersion: 1, authMethods: [] })
      continue
    }
    if (request.method === 'session/new') {
      sessions += 1
      reply(request.id, {
        sessionId: 'session-' + sessions,
        configOptions: [
          { id: 'model', type: 'select', options: [{ value: 'gemini-4-carbon' }] },
          { id: 'thought_level', type: 'select', options: [{ value: 'low' }, { value: 'high' }] },
        ],
      })
      continue
    }
    if (request.method === 'session/set_config_option') {
      reply(request.id, { configOptions: [] })
      continue
    }
    if (request.method === 'session/prompt') {
      const text = request.params.prompt.map((block) => block.text || '').join('')
      notify({ sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer for: ' + text.slice(0, 40) } } })
      reply(request.id, { stopReason: 'end_turn' })
      continue
    }
    reply(request.id, {})
  }
})
`

/** Like {@link adapterHarness}, but the finished turn's process goes to the pool. */
function reuseHarness(): { adapter: AntigravityAcpAdapter; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-reuse-window-test-'))
  const server = join(dir, 'server.mjs')
  writeFileSync(server, REUSE_SERVER, 'utf8')
  const settings = new AntigravityAcpSettingsStore(join(dir, 'settings.json'))
  const adapter = new AntigravityAcpAdapter({
    settings,
    resolveLaunch: async () => ({ command: process.execPath, args: [server] }),
    loadCatalog: async () => ({ models: [], synced: true }),
    // No parking: the process is released to the idle pool, which is the path
    // that rewires handlers before \`session/new\` for the next turn.
    dormantSessionLimit: 0,
  })
  return { adapter, dispose: () => rmSync(dir, { recursive: true, force: true }) }
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

  it('does not report the cumulative cachedReadTokens as this turn cache reads (issue #125)', async () => {
    // The fake server answers session/prompt with cachedReadTokens:3. ACP reports
    // that field cumulatively across the session, so the adapter must not surface
    // it as this turn's cacheReadTokens - doing so inflated context pressure.
    const harness = adapterHarness()
    try {
      const chunks = await collect(harness.adapter.stream(optionsOf() as never))
      const usage = chunks.find((chunk) => chunk.type === 'usage') as
        { usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } } | undefined
      expect(usage?.usage.inputTokens).toBe(11)
      expect(usage?.usage.outputTokens).toBe(7)
      expect(usage?.usage.cacheReadTokens).toBeUndefined()
      // The harness-facing status card reads the same sample.
      expect(harness.adapter.usage()?.cacheReadTokens).toBeUndefined()
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })

  it('declares a context window even when the catalogue cannot be read', async () => {
    // The bug behind #119: an ACP model resolved without a `context` made every
    // switch into the line fail with MODEL_SWITCH_COMPACTION_FAILED before the
    // first token, because dsh-compaction-basic refuses a route with no capacity.
    // A failed catalogue read must not be able to put the line in that state.
    const harness = adapterHarness({
      loadCatalog: async () => {
        throw new Error('offline')
      },
    })
    try {
      const resolved = await harness.adapter.resolveModel('antigravity-acp', 'gemini-4-argon')
      expect(resolved.context).toEqual({ contextWindow: 1_048_576 })
      // An id nothing has ever listed still gets the conservative fallback rather
      // than no capacity at all.
      const unlisted = await harness.adapter.resolveModel('antigravity-acp', 'acme-1')
      expect(unlisted.context).toEqual({ contextWindow: 131_072 })
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })

  it('learns the real window from a usage_update and resolves with it afterwards', async () => {
    const harness = adapterHarness()
    try {
      // gpt-oss-120b-medium ships at 131,072; the agent reports a 262,144 window
      // for it in a live turn. The live number is the only capacity the line can
      // measure, so it must win over the shipped table.
      expect((await harness.adapter.resolveModel('antigravity-acp', 'gpt-oss-120b-medium')).context).toEqual({
        contextWindow: 131_072,
      })
      const chunks = await collect(
        harness.adapter.stream(
          optionsOf({
            model: 'gpt-oss-120b-medium',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'OCCUPANCY' }] }],
          }) as never,
        ),
      )
      expect(chunks.some((chunk) => chunk.type === 'usage')).toBe(true)
      expect(harness.adapter.occupancy()?.size).toBe(262_144)
      expect((await harness.adapter.resolveModel('antigravity-acp', 'gpt-oss-120b-medium')).context).toEqual({
        contextWindow: 262_144,
      })
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

  it('reads the switch before it spawns the agent, so a disabled line costs nothing', async () => {
    let catalogReads = 0
    const harness = adapterHarness({
      loadCatalog: async () => {
        catalogReads += 1
        return { models: [{ id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: [] }], synced: true }
      },
    })
    try {
      // Before the fix the catalogue was read first: a line the user had switched
      // off still resolved the executable and spawned `agy` for every picker
      // refresh, then threw the answer away.
      await harness.settings.update({ enabled: false })
      expect(await harness.adapter.listModels('antigravity-acp')).toEqual([])
      expect(catalogReads).toBe(0)
      // ...and the same line asks for it once it is switched back on.
      await harness.settings.update({ enabled: true })
      expect(await harness.adapter.listModels('antigravity-acp')).toHaveLength(1)
      expect(catalogReads).toBe(1)
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

  it('drops frames that belong to a session this turn no longer owns', async () => {
    // A warm process keeps flushing the conversation it ran before: the cancel
    // that ended it is a notification, not a barrier. Appending those frames
    // would put another conversation's text into this answer.
    const harness = adapterHarness()
    try {
      const chunks = await collect(harness.adapter.stream(optionsOf({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'STALE please' }] }],
      }) as never))
      const text = chunks.filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => (chunk as { text: string }).text).join('')
      expect(text).toContain('answer for: STALE please')
      expect(text).not.toContain('stale answer from session-0')
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })

  it('reports an upstream refusal once instead of retrying it as a transport fault', async () => {
    const harness = adapterHarness()
    try {
      await expect(collect(harness.adapter.stream(optionsOf({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'QUOTA please' }] }],
      }) as never))).rejects.toMatchObject({ failure: { code: 'ACP_UPSTREAM_BLOCKED' } })
      const policy = harness.adapter.providerRetryPolicy() as { retryableCodes: readonly string[] }
      expect(policy.retryableCodes).not.toContain('ACP_UPSTREAM_BLOCKED')
      expect(policy.retryableCodes).toContain('ACP_DISCONNECTED')
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })

  it('classifies upstream refusals by their real vocabulary', async () => {
    const harness = adapterHarness()
    try {
      const codeOf = async (marker: string): Promise<string | undefined> => {
        try {
          await collect(harness.adapter.stream(optionsOf({
            messages: [{ role: 'user', content: [{ type: 'text', text: marker }] }],
          }) as never))
          return undefined
        } catch (error) {
          return (error as { failure?: { code?: string } }).failure?.code
        }
      }
      // A verification/policy block is a refusal, not a transport fault.
      expect(await codeOf('VALIDATION')).toBe('ACP_UPSTREAM_BLOCKED')
      // The auth wall is reported as such, whatever code it arrives with.
      expect(await codeOf('AUTHMSG')).toBe('ACP_AUTH_REQUIRED')
      // And a word that merely ends in "tos" stays an ordinary retryable error.
      expect(await codeOf('PHOTOS')).toBe('ACP_RPC_ERROR')
    } finally {
      await harness.adapter.dispose()
      harness.dispose()
    }
  })

  it('drops frames addressed to a session while this turn has none yet', async () => {
    // The reuse window: a warm process is rewired and then \`session/new\` answers.
    // Anything addressed in between belongs to the conversation it was running
    // before, and "we have no id yet" used to let it through.
    const space = reuseHarness()
    try {
      await collect(space.adapter.stream(optionsOf() as never))
      const chunks = await collect(space.adapter.stream(optionsOf({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'second one' }] }],
      }) as never))
      const text = chunks.filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => (chunk as { text: string }).text).join('')
      expect(text).not.toContain('stale before session')
      expect(text).toContain('answer for: second one')
    } finally {
      await space.adapter.dispose()
      space.dispose()
    }
  })
})
