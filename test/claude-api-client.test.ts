import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import {
  buildClaudeApiHeaders,
  listClaudeApiModels,
  parseClaudeApiError,
  testClaudeApiConnection,
} from '../src/host/claude-api/client.ts'
import { CLAUDE_API_BASE_BETAS, CLAUDE_API_STAINLESS_HEADERS } from '../src/host/claude-api/types.ts'
import { TEST_FIRST_PARTY_CONTEXT } from './claude-api-fixtures.ts'

const SESSION = '7e8e116a-f1b6-4569-a4a3-362e8b9a38cb'
const KEY = 'sk-client-test'

async function capture(): Promise<{ pairs: Array<[string, string]>; stream: boolean }> {
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/claude-api/request-2.1.330.json', import.meta.url), 'utf8')) as {
    requests: Array<{ headers: Array<[string, string]>; body: { stream: boolean } }>
  }
  return { pairs: fixture.requests[0]!.headers, stream: fixture.requests[0]!.body.stream }
}

describe('buildClaudeApiHeaders', () => {
  it('sends exactly the captured header names, in lower case', async () => {
    const { pairs, stream } = await capture()
    expect(stream).toBe(true)
    const headers = buildClaudeApiHeaders({ apiKey: KEY, version: '2.1.330', sessionUuid: SESSION, betas: CLAUDE_API_BASE_BETAS, stream: true, firstParty: TEST_FIRST_PARTY_CONTEXT })
    expect(Object.keys(headers).sort()).toEqual(pairs.map(([name]) => name.toLowerCase()).sort())
    expect(Object.keys(headers).every(name => name === name.toLowerCase())).toBe(true)
    // The captured client streams with accept: application/json, not text/event-stream.
    const captured = new Map(pairs.map(([name, value]) => [name.toLowerCase(), value]))
    expect(captured.get('accept')).toBe('application/json')
    expect(headers.accept).toBe('application/json')
    expect(headers['anthropic-version']).toBe(captured.get('anthropic-version'))
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe(captured.get('anthropic-dangerous-direct-browser-access'))
    expect(headers['x-app']).toBe(captured.get('x-app'))
    for (const [name, value] of Object.entries(CLAUDE_API_STAINLESS_HEADERS)) expect(headers[name]).toBe(value)
    for (const [name, value] of Object.entries(CLAUDE_API_STAINLESS_HEADERS)) expect(headers[name]).toBe(captured.get(name))
  })
  it('keeps accept: application/json for every stream intent and reports the interactive entrypoint', () => {
    for (const stream of [undefined, false, true]) {
      const headers = buildClaudeApiHeaders({ apiKey: KEY, version: '9.9.9', sessionUuid: SESSION, betas: CLAUDE_API_BASE_BETAS, ...(stream === undefined ? {} : { stream }) })
      expect(headers.accept).toBe('application/json')
      expect(headers['user-agent']).toBe('claude-cli/9.9.9 (external, cli)')
      expect(headers['x-claude-code-session-id']).toBe(SESSION)
      expect(headers['x-api-key']).toBe(KEY)
      expect(headers['anthropic-beta']).toBe(CLAUDE_API_BASE_BETAS.join(','))
    }
    const derived = buildClaudeApiHeaders({ apiKey: KEY, version: '2.1.330', sessionUuid: SESSION, betas: [...CLAUDE_API_BASE_BETAS, 'compact-2026-09-04', 'compact-2026-09-04', ''] })
    expect(derived['anthropic-beta']).toBe([...CLAUDE_API_BASE_BETAS, 'compact-2026-09-04'].join(','))
  })
})

describe('parseClaudeApiError', () => {
  it('reads the official error envelope', () => {
    const body = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Number of requests has exceeded the limit.', details: { error_code: 'rate_limit_exceeded' } },
      request_id: 'req_1',
    })
    const parsed = parseClaudeApiError(429, body)
    expect(parsed.type).toBe('rate_limit_error')
    expect(parsed.code).toBe('rate_limit_exceeded')
    expect(parsed.message).toContain('Number of requests has exceeded the limit.')
    expect(parsed.message).toContain('429')
  })
  it('reads the gateway envelope', () => {
    const parsed = parseClaudeApiError(402, JSON.stringify({ error: { message: 'quota exhausted', type: 'insufficient_quota' }, type: 'error' }))
    expect(parsed).toMatchObject({ type: 'insufficient_quota', code: null })
    expect(parsed.message).toContain('quota exhausted')
  })
  it('reads the bare code/message shape', () => {
    expect(parseClaudeApiError(403, JSON.stringify({ code: 'balance_exhausted', message: 'Insufficient balance' })))
      .toMatchObject({ type: null, code: 'balance_exhausted' })
    expect(parseClaudeApiError(403, JSON.stringify({ code: 40201, message: 'Insufficient balance' })).code).toBe('40201')
    expect(parseClaudeApiError(500, 'upstream exploded').message).toContain('upstream exploded')
    expect(parseClaudeApiError(500, '').message).toContain('500')
  })
  it('redacts the API key from the public message', () => {
    const body = JSON.stringify({ error: { message: 'invalid key ' + KEY + ' supplied' } })
    const redacted = parseClaudeApiError(401, body, KEY)
    expect(redacted.message).toContain('[REDACTED]')
    expect(redacted.message).not.toContain(KEY)
    expect(parseClaudeApiError(401, body).message).toContain(KEY)
  })
})

describe('listClaudeApiModels', () => {
  const input = { baseUrl: 'https://gw.example/prefix', apiKey: KEY, version: '2.1.330' }
  it('follows has_more/last_id with after_id and de-duplicates ids', async () => {
    const urls: string[] = []
    const fetchFn = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request)
      urls.push(url)
      if (url.includes('after_id=m2')) return Response.json({ data: [{ id: 'claude-haiku-5-5' }], has_more: false })
      if (url.includes('after_id=m1')) return Response.json({ data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }], has_more: true, last_id: 'm2' })
      return Response.json({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-opus-5-5' }], has_more: true, last_id: 'm1' })
    }) as unknown as typeof fetch
    const entries = await listClaudeApiModels({ ...input, fetchFn })
    expect(urls).toEqual([
      'https://gw.example/prefix/v1/models?limit=1000',
      'https://gw.example/prefix/v1/models?limit=1000&after_id=m1',
      'https://gw.example/prefix/v1/models?limit=1000&after_id=m2',
    ])
    expect(entries.map(entry => entry.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe(KEY)
    expect(headers['anthropic-beta']).toBe(CLAUDE_API_BASE_BETAS.join(','))
    expect(headers['user-agent']).toBe('claude-cli/2.1.330 (external, cli)')
  })
  it('stops after ten pages even when the gateway always claims more', async () => {
    let page = 0
    const fetchFn = vi.fn(async () => {
      page += 1
      return Response.json({ data: [{ id: 'claude-page-' + page }], has_more: true, last_id: 'cursor-' + page })
    }) as unknown as typeof fetch
    const entries = await listClaudeApiModels({ ...input, fetchFn })
    expect(fetchFn).toHaveBeenCalledTimes(10)
    expect(entries).toHaveLength(10)
  })
  it('throws the parsed and redacted upstream message on a non-2xx answer', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid key ' + KEY } }), { status: 401 })) as unknown as typeof fetch
    await expect(listClaudeApiModels({ ...input, fetchFn })).rejects.toThrow(/invalid key \[REDACTED\]/)
    const broken = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
    await expect(listClaudeApiModels({ ...input, fetchFn: broken })).rejects.toThrow(/malformed JSON/)
  })
})

describe('testClaudeApiConnection', () => {
  const input = { baseUrl: 'https://gw.example', apiKey: KEY, version: '2.1.330', now: () => 5000 }
  it('reports a successful listing without throwing', async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }] })) as unknown as typeof fetch
    expect(await testClaudeApiConnection({ ...input, fetchFn })).toEqual({ connected: true, latencyMs: 0, checkedAt: 5000, modelCount: 2 })
  })
  it('reports a failure as a DTO and redacts the key', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('socket closed for ' + KEY) }) as unknown as typeof fetch
    const result = await testClaudeApiConnection({ ...input, fetchFn })
    expect(result.connected).toBe(false)
    expect(result.modelCount).toBe(0)
    expect(result.error).toContain('[REDACTED]')
    expect(result.error).not.toContain(KEY)
    const refused = vi.fn(async () => new Response(JSON.stringify({ code: 'balance_exhausted', message: 'Insufficient balance' }), { status: 403 })) as unknown as typeof fetch
    const denied = await testClaudeApiConnection({ ...input, fetchFn: refused })
    expect(denied.connected).toBe(false)
    expect(denied.error).toContain('Insufficient balance')
  })
})
