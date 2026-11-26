/**
 * A compaction summary follows the session's own effort.
 *
 * The harness names no effort on a compaction request, and this line falls back to
 * the configured default (none here). The effort is part of the request body the
 * upstream caches against, and the body is a reversible codec, so it can be decoded
 * and compared directly: the compaction must carry the same `reasoning_effort` the
 * main turn sent, not an empty one.
 */
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QoderAdapter } from '../../../src/host/providers/qoder/adapter.ts'
import { QoderAccountPool } from '../../../src/host/providers/qoder/account-pool.ts'
import { QoderCredentialStore, QoderModelSettingsStore, type QoderCredentials } from '../../../src/host/providers/qoder/token-store.ts'
import { QODER_BODY_ALPHABET, QODER_BODY_PADDING_CHAR, QODER_STD_ALPHABET } from '../../../src/host/providers/qoder/types.ts'

class MemoryBackend<T> {
  private data: unknown = null
  async load(): Promise<T | null> { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T }
  async save(data: T): Promise<void> { this.data = JSON.parse(JSON.stringify(data)) }
  async clear(): Promise<void> { this.data = null }
}

function credentials(): QoderCredentials {
  return {
    accessToken: 'jt-test', refreshToken: 'jrt-test', expiresAt: Date.now() + 24 * 3_600_000,
    region: 'global', origin: 'device', uid: 'u-1', email: 'me@qoder.com', accountName: 'Me',
    personalToken: null, organizationId: null, organizationTags: [], dataPolicyAgreed: false,
    authenticatedAt: Date.now(),
  }
}

function frame(inner: unknown): string {
  return 'data:' + JSON.stringify({
    headers: { 'Content-Type': ['application/json'] }, body: JSON.stringify(inner),
    statusCodeValue: 200, statusCode: 'OK',
  }) + '\n'
}
const ANSWER_SSE = frame({ id: 'rsp-1', model: 'ultimate', choices: [{ delta: { content: 'ok' } }] })
  + frame({ id: 'rsp-1', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } })
  + 'data:[DONE]\n'

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** Reverse of `encodeQoderBody`: alphabet map then the (involutive) three-way swap. */
function decodeQoderBody(encoded: string): Record<string, unknown> {
  const reverse = new Map<string, string>()
  for (let i = 0; i < QODER_STD_ALPHABET.length; i++) reverse.set(QODER_BODY_ALPHABET[i]!, QODER_STD_ALPHABET[i]!)
  reverse.set(QODER_BODY_PADDING_CHAR, '=')
  let std = ''
  for (const char of encoded) std += reverse.get(char) ?? char
  const n = std.length
  const third = Math.floor(n / 3)
  const original = std.slice(n - third) + std.slice(third, n - third) + std.slice(0, third)
  return JSON.parse(Buffer.from(original, 'base64').toString('utf8')) as Record<string, unknown>
}

afterEach(() => { vi.restoreAllMocks() })

/** An adapter whose configured default effort is null, recording every request body. */
async function buildAdapter(bodies: Array<Record<string, unknown>>): Promise<QoderAdapter> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-effort-'))
  const pool = new QoderAccountPool({ backend: new MemoryBackend() as never })
  await pool.addAccount(credentials())
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(decodeQoderBody(typeof init?.body === 'string' ? init.body : ''))
    return sseResponse(ANSWER_SSE)
  }) as unknown as typeof fetch
  return new QoderAdapter(
    new QoderCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend() as never),
    new QoderModelSettingsStore(path.join(dir, 'models.json')),
    undefined,
    { accountPool: pool, fetchFn },
  )
}

async function send(adapter: QoderAdapter, overrides: Record<string, unknown>): Promise<void> {
  const options = {
    provider: 'qoder', model: 'Ultimate',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], ...overrides,
  } as never
  for await (const _chunk of adapter.stream(options)) { /* drain */ }
}

function effortOf(body: Record<string, unknown>): unknown {
  return (body.parameters as { reasoning_effort?: unknown } | undefined)?.reasoning_effort
}

describe('Qoder auxiliary request effort', () => {
  it('sends a compaction at the session main-turn effort', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const adapter = await buildAdapter(bodies)
    await send(adapter, { sessionId: 'qoder-sess', reasoningEffort: 'high' })
    await send(adapter, { sessionId: 'qoder-sess', purpose: 'compaction' })

    expect(bodies.map(effortOf)).toEqual(['high', 'high'])
  })

  it('sends no effort with no session main turn', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const adapter = await buildAdapter(bodies)
    await send(adapter, { sessionId: 'qoder-none', purpose: 'compaction' })
    expect(effortOf(bodies[0]!)).toBeUndefined()
  })
})
