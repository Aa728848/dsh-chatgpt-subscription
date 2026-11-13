/**
 * Tool results that carry pixels: does a `read_image` result actually reach the agent?
 *
 * The bridge hands a DSH tool call to the harness and answers the ACP agent with
 * whatever the harness produced. A `read_image` produces an image block, and an
 * image block has no text part - so a result path that keeps only text answered
 * with an empty result, which an agent reports as "the tool returned nothing".
 * Users read that as the model being unable to see images.
 *
 * This test drives the whole round trip against a scripted ACP server that really
 * calls the bridge over HTTP: the server reads the descriptor out of
 * `session/new`, posts a `tools/call`, and prints what came back. Nothing is
 * mocked, so a regression in either half shows up here.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AntigravityAcpAdapter } from '../src/host/antigravity-acp/adapter.ts'
import { AntigravityAcpSettingsStore } from '../src/host/antigravity-acp/settings.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const SERVER = `
let buffer = ''
process.stdin.setEncoding('utf8')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const notify = (params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params }) + '\\n')
let bridge = null
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
      const servers = request.params.mcpServers || []
      bridge = servers[0] || null
      reply(request.id, { sessionId: 's1', models: { availableModels: [] }, configOptions: [] })
      continue
    }
    if (request.method === 'session/set_config_option') { reply(request.id, {}); continue }
    if (request.method === 'session/prompt') {
      const promptId = request.id
      void (async () => {
        let shown = 'NO_BRIDGE'
        if (bridge) {
          const authorization = (bridge.headers || []).map((h) => h.name + ': ' + h.value).join('\\n')
          const response = await fetch(bridge.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: (bridge.headers || [])[0] ? (bridge.headers || [])[0].value : '' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 42,
              method: 'tools/call',
              params: { name: 'read_image', arguments: { path: 'shot.png' } },
            }),
          })
          const answered = await response.json()
          const content = (((answered.result || {}).content) || [])
          shown = content.map((block) => {
            if (block.type === 'image') return 'image:' + block.mimeType + ':' + block.data
            return 'text:' + String(block.text || '')
          }).join('|')
        }
        notify({ sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GOT=' + shown } } })
        reply(promptId, { stopReason: 'end_turn' })
      })()
      continue
    }
    reply(request.id, {})
  }
})
`

/** One fake attachment store: a 1x1 PNG, verified and readable. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function harness(): { adapter: AntigravityAcpAdapter; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-image-result-test-'))
  const server = join(dir, 'server.mjs')
  writeFileSync(server, SERVER, 'utf8')
  const settings = new AntigravityAcpSettingsStore(join(dir, 'settings.json'))
  const adapter = new AntigravityAcpAdapter({
    settings,
    resolveLaunch: async () => ({ command: process.execPath, args: [server] }),
    loadCatalog: async () => ({ models: [{ id: 'gemini-4-carbon', name: 'G', efforts: [] }], synced: true }),
  })
  return { adapter, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

interface Collected {
  text: string
  /** Ids the harness must answer, as the stream spelled them. */
  callIds: string[]
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<Collected> {
  const parts: string[] = []
  const callIds: string[] = []
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') parts.push(chunk.text)
    if (chunk.type === 'tool-call-delta') callIds.push(String(chunk.id))
  }
  return { text: parts.join(''), callIds }
}

// An inline image block: no attachment store is configured in this test, and an
// inline payload is what a tool that returns pixels hands back most often.
const IMAGE = { type: 'image', mediaType: 'image/png', data: PNG_BASE64 }

describe('a tool result that carries an image', () => {
  it('hands the pixels to the agent instead of an empty result', async () => {
    const h = harness()
    try {
      const first = await collect(h.adapter.stream({
        provider: 'antigravity-acp',
        model: 'gemini-4-carbon',
        sessionId: 'session-image-1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'look at shot.png' }] }],
        tools: [{ name: 'read_image', description: 'read an image', parameters: { type: 'object', properties: {} } }],
      } as never))
      // The turn parked the bridge call and handed it to the harness. The id the
      // stream handed out is what the answer has to be keyed by.
      expect(first.callIds).toHaveLength(1)
      const callId = first.callIds[0]!

      const second = await collect(h.adapter.stream({
        provider: 'antigravity-acp',
        model: 'gemini-4-carbon',
        sessionId: 'session-image-1',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'look at shot.png' }] },
          { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'read_image', arguments: '{}' }] },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, content: [IMAGE] }] },
        ],
        tools: [{ name: 'read_image', description: 'read an image', parameters: { type: 'object', properties: {} } }],
      } as never))
      // The server echoes what the bridge answered. An image block means the
      // pixels survived the round trip; a bare text block with an empty string is
      // exactly the bug this test exists for.
      expect(second.text).toContain('GOT=')
      expect(second.text).toContain('image:image/png:')
      expect(second.text).toContain(PNG_BASE64.slice(0, 24))
    } finally {
      await h.adapter.dispose()
      h.dispose()
    }
  })
})
