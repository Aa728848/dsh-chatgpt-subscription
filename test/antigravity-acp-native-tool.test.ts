/**
 * The native-tool guard: the one place where ACP's own tools could bypass DSH.
 *
 * The live probe recorded during development is the reason this file exists: with
 * no bridge attached, the official agent called its own `write_file` and the file
 * really appeared on disk. Attaching a bridge does not remove those tools, and
 * ACP has no way to unload them - so the client can only decide what to do once
 * one is reported.
 *
 * Two behaviours are covered here, because both are shipped:
 *
 * - `nativeToolPolicy: 'allow'` (the default) writes one visible note into the
 *   answer and lets the turn continue. This is the fix for the failure that made
 *   a working multi-step task look like an empty round: the model reached for
 *   `run_command`, the client cancelled, and nothing was ever executed.
 * - `nativeToolPolicy: 'cancel'` keeps the older strict behaviour and fails the
 *   turn at the first such call.
 *
 * The permission request is the other half. A bridge call is a DSH tool call and
 * must reach the harness whatever `permissionPolicy` says; a built-in tool is
 * governed by that policy because nothing downstream of it is.
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
      notify({ sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'n1', name: 'run_command', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'echo hi' }, title: 'echo hi' } })
      notify({ sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'n1', status: 'completed' } })
      reply(request.id, { stopReason: 'end_turn' })
      continue
    }
    reply(request.id, {})
  }
})
`

/**
 * A server that asks permission for one tool, then reports the answer it got.
 *
 * The answer is echoed back as an agent message chunk because that is the only
 * channel this test can read without reaching into the child's stderr.
 */
const permissionServer = (toolName: string): string => `
let buffer = ''
process.stdin.setEncoding('utf8')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const notify = (params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params }) + '\\n')
let promptId = null
let toolName = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') { reply(message.id, { protocolVersion: 1, authMethods: [] }); continue }
    if (message.method === 'session/new') { reply(message.id, { sessionId: 's1', models: { availableModels: [] }, configOptions: [] }); continue }
    if (message.method === 'session/set_config_option') { reply(message.id, {}); continue }
    if (message.method === 'session/prompt') {
      promptId = message.id
      toolName = ${JSON.stringify(toolName)}
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: 900, method: 'session/request_permission',
        params: {
          sessionId: 's1',
          toolCall: { toolCallId: 'c1', name: toolName },
          options: [
            { optionId: 'allow-1', kind: 'allow_once' },
            { optionId: 'deny-1', kind: 'reject_once' },
          ],
        },
      }) + '\\n')
      continue
    }
    if (message.id === 900 && promptId !== null) {
      const outcome = message.result && message.result.outcome ? message.result.outcome : {}
      const shown = outcome.outcome === 'selected' ? 'selected:' + outcome.optionId : 'cancelled'
      notify({ sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PERMISSION=' + shown } } })
      reply(promptId, { stopReason: 'end_turn' })
      promptId = null
      continue
    }
    reply(message.id, {})
  }
})
`

interface Harness {
  adapter: AntigravityAcpAdapter
  settings: AntigravityAcpSettingsStore
  dispose(): void
}

function harness(serverSource = NATIVE_SERVER): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'acp-native-tool-test-'))
  const server = join(dir, 'server.mjs')
  writeFileSync(server, serverSource, 'utf8')
  const settings = new AntigravityAcpSettingsStore(join(dir, 'settings.json'))
  const adapter = new AntigravityAcpAdapter({
    settings,
    resolveLaunch: async () => ({ command: process.execPath, args: [server] }),
    loadCatalog: async () => ({ models: [{ id: 'gemini-4-carbon', name: 'G', efforts: [] }], synced: true }),
  })
  return { adapter, settings, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const REQUEST = {
  provider: 'antigravity-acp',
  model: 'gemini-4-carbon',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'run a command' }] }],
  tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }],
}

describe('native tool policy', () => {
  it('records a native call in the answer and lets the turn continue by default', async () => {
    const h = harness()
    try {
      const chunks = await collect(h.adapter.stream(REQUEST as never))
      const note = chunks
        .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
        .map((chunk) => chunk.text)
        .join('')
      // The name and its arguments both appear: a note that only said "something
      // happened" would leave the user unable to judge what it did.
      expect(note).toContain('run_command')
      expect(note).toContain('echo hi')
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    } finally {
      await h.adapter.dispose()
      h.dispose()
    }
  })

  it('mentions the call once, not once per status update', async () => {
    const h = harness()
    try {
      const chunks = await collect(h.adapter.stream(REQUEST as never))
      const notes = chunks
        .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
        .filter((chunk) => chunk.text.includes('run_command'))
      expect(notes).toHaveLength(1)
    } finally {
      await h.adapter.dispose()
      h.dispose()
    }
  })

  it('cancels the turn when the strict policy is set', async () => {
    const h = harness()
    try {
      await h.settings.update({ nativeToolPolicy: 'cancel' })
      const run = collect(h.adapter.stream(REQUEST as never))
      await expect(run).rejects.toMatchObject({ failure: { code: 'ACP_NATIVE_TOOLS_UNSUPPORTED' } })
      await expect(run).rejects.toThrow(/run_command/)
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

describe('permission requests', () => {
  it('always approves a bridge call, even when the policy rejects', async () => {
    // The bridge hands the call to DSH, which applies its own permission preset.
    // Answering "cancelled" here refused the route instead of governing it, and a
    // default install therefore never completed a single tool round.
    const h = harness(permissionServer('mcp_dsh-bridge_read_file'))
    try {
      const text = await collect(h.adapter.stream(REQUEST as never)).then((chunks) => chunks
        .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
        .map((chunk) => chunk.text)
        .join(''))
      expect(text).toContain('PERMISSION=selected:allow-1')
    } finally {
      await h.adapter.dispose()
      h.dispose()
    }
  })

  it('leaves a built-in tool call to the policy: allowed by default, refused when set to reject', async () => {
    // The default is "allow" so a multi-step task finishes; the strict answer is
    // one setting away and must still be reachable.
    const allowed = harness(permissionServer('run_command'))
    try {
      const text = await collect(allowed.adapter.stream(REQUEST as never)).then((chunks) => chunks
        .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
        .map((chunk) => chunk.text)
        .join(''))
      expect(text).toContain('PERMISSION=selected:allow-1')
    } finally {
      await allowed.adapter.dispose()
      allowed.dispose()
    }
    const refused = harness(permissionServer('run_command'))
    try {
      await refused.settings.update({ permissionPolicy: 'reject' })
      const text = await collect(refused.adapter.stream(REQUEST as never)).then((chunks) => chunks
        .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
        .map((chunk) => chunk.text)
        .join(''))
      expect(text).toContain('PERMISSION=cancelled')
    } finally {
      await refused.adapter.dispose()
      refused.dispose()
    }
  })
})
