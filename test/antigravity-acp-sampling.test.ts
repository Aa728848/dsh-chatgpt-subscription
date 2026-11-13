/**
 * Sampling controls: what is refused, and what is only dropped.
 *
 * ACP's `session/prompt` carries content only. A control that changes *what the
 * model produces* - `temperature`, `stop` - is refused rather than dropped,
 * because the caller would otherwise get an answer to a different question.
 *
 * `maxTokens` is not in that group. It bounds an answer the caller still reads in
 * full, and the harness's own auxiliary calls always send one: session titles ask
 * for a small cap and compaction asks for a headroom cap. Refusing it made every
 * session title on this line fail, so the cap is dropped and the turn runs.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AntigravityAcpAdapter } from '../src/host/antigravity-acp/adapter.ts'
import { AntigravityAcpSettingsStore } from '../src/host/antigravity-acp/settings.ts'
import { ACP_ERROR_CODES, acpError, isAcpErrorCode } from '../src/host/antigravity-acp/errors.ts'

const SERVER = `
let buffer = ''
process.stdin.setEncoding('utf8')
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
    if (request.method === 'session/new') { reply(request.id, { sessionId: 's1', models: { availableModels: [] }, configOptions: [] }); continue }
    if (request.method === 'session/set_config_option') { reply(request.id, {}); continue }
    if (request.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } }) + '\\n')
      reply(request.id, { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })
      continue
    }
    reply(request.id, {})
  }
})
`

function harness(): { adapter: AntigravityAcpAdapter; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-sampling-test-'))
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

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* consume */ }
}

describe('sampling controls are refused', () => {
  it.each([
    ['temperature', { temperature: 0.2 }],
    ['stop', { stop: ['\n\nHuman:'] }],
  ])('rejects a request carrying %s', async (_label, control) => {
    const h = harness()
    try {
      const run = drain(h.adapter.stream({
        provider: 'antigravity-acp',
        model: 'gemini-4-carbon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        ...control,
      } as never))
      await expect(run).rejects.toMatchObject({ failure: { code: 'ACP_UNSUPPORTED_OPTION' } })
      await expect(run).rejects.toThrow(/temperature|stop/)
    } finally {
      await h.adapter.dispose()
      h.dispose()
    }
  })

  it('runs a request whose only control is maxTokens, dropping the cap', async () => {
    // The session-title service asks for 64 output tokens. ACP cannot express a
    // cap, so the request runs uncapped rather than failing: a title that costs
    // more tokens than asked is better than a title that never appears.
    const h = harness()
    try {
      await expect(drain(h.adapter.stream({
        provider: 'antigravity-acp',
        model: 'gemini-4-carbon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        maxTokens: 64,
      } as never))).resolves.toBeUndefined()
    } finally {
      await h.adapter.dispose()
      h.dispose()
    }
  })

  it('still runs a request that carries none of them', async () => {
    const h = harness()
    try {
      await expect(drain(h.adapter.stream({
        provider: 'antigravity-acp',
        model: 'gemini-4-carbon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never))).resolves.toBeUndefined()
    } finally {
      await h.adapter.dispose()
      h.dispose()
    }
  })
})

describe('the error vocabulary', () => {
  it('covers every condition with an actionable sentence', () => {
    for (const [code, sentence] of Object.entries(ACP_ERROR_CODES)) {
      expect(code.startsWith('ACP_'), code).toBe(true)
      expect(sentence.length, code).toBeGreaterThan(20)
    }
  })

  it('builds a line-specific LlmError carrying its code', () => {
    const error = acpError('ACP_DISCONNECTED', 'retry')
    expect(error.failure.code).toBe('ACP_DISCONNECTED')
    expect(error.failure.message).toContain('retry')
  })

  it('recognises only its own codes', () => {
    expect(isAcpErrorCode('ACP_REFUSAL')).toBe(true)
    expect(isAcpErrorCode('TRANSPORT')).toBe(false)
  })
})
