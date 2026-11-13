/**
 * The ACP stdio client: framing, correlation and classification.
 *
 * Everything here runs against a real spawned Node process rather than a fake
 * object, because the two things most likely to break are both process-level:
 * a frame split across chunk boundaries, and a child that dies mid-request.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpClient, AcpError } from '../src/host/antigravity-acp/acp-client.ts'

const READ_LINE_SERVER = `
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.method === 'split') {
      // One response, emitted in three pieces with no newline until the end:
      // a decoder that split on chunk boundaries would lose it.
      const payload = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { text: 'AB' + 'CD' } })
      process.stdout.write(payload.slice(0, 8))
      setTimeout(() => process.stdout.write(payload.slice(8, 20)), 10)
      setTimeout(() => process.stdout.write(payload.slice(20) + '\\n'), 20)
      continue
    }
    if (request.method === 'notify-first') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'delta' } } },
      }) + '\\n')
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n')
      continue
    }
    if (request.method === 'boom') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Authentication required' } }) + '\\n')
      continue
    }
    if (request.method === 'die') {
      process.exit(3)
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n')
  }
})
`

describe('AcpClient', () => {
  it('reassembles one JSON-RPC response split across chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-client-test-'))
    const file = join(dir, 'server.mjs')
    writeFileSync(file, READ_LINE_SERVER, 'utf8')
    const client = new AcpClient({ command: process.execPath, args: [file], cwd: process.cwd() })
    try {
      // Three writes, one newline at the very end: a decoder that assumed one
      // chunk is one frame would answer undefined here.
      await expect(client.request('split', {})).resolves.toEqual({ text: 'ABCD' })
    } finally {
      await client.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('routes a notification to the handler without consuming the response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-client-test-'))
    const file = join(dir, 'server.mjs')
    writeFileSync(file, READ_LINE_SERVER, 'utf8')
    const updates: string[] = []
    const client = new AcpClient(
      { command: process.execPath, args: [file], cwd: process.cwd() },
      { onSessionUpdate: (_sessionId, update) => updates.push(String(update.sessionUpdate)) },
    )
    try {
      const result = await client.request('notify-first', { sessionId: 's1' })
      expect(result).toEqual({ ok: true })
      expect(updates).toEqual(['agent_message_chunk'])
    } finally {
      await client.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects one response with its own code rather than killing the stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-client-test-'))
    const file = join(dir, 'server.mjs')
    writeFileSync(file, READ_LINE_SERVER, 'utf8')
    const client = new AcpClient({ command: process.execPath, args: [file], cwd: process.cwd() })
    try {
      await expect(client.request('boom', {})).rejects.toMatchObject({ code: -32000 })
      expect(client.alive).toBe(true)
    } finally {
      await client.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails every pending request when the child exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-client-test-'))
    const file = join(dir, 'server.mjs')
    writeFileSync(file, READ_LINE_SERVER, 'utf8')
    const client = new AcpClient({ command: process.execPath, args: [file], cwd: process.cwd() })
    try {
      const pending = client.request('die', {})
      await expect(pending).rejects.toBeInstanceOf(AcpError)
      expect(client.alive).toBe(false)
    } finally {
      await client.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
