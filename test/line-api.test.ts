import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLineApi } from '../src/client/common/line-api.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function respond(body: string, init: ResponseInit = {}): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    calls.push({ url: String(input), init: requestInit })
    return new Response(body, { status: 200, ...init })
  }) as typeof fetch
  return calls
}

describe('line api', () => {
  it('unwraps the { ok, value } envelope every sibling line answers with', async () => {
    respond(JSON.stringify({ ok: true, value: { enabled: true } }))
    const api = createLineApi('/claude/api', 'Claude')
    await expect(api.get<{ enabled: boolean }>('/status')).resolves.toEqual({ enabled: true })
  })

  it('reads a plain string error, which is the sibling lines\' shape', async () => {
    respond(JSON.stringify({ ok: false, error: 'Method Not Allowed' }), { status: 405 })
    const api = createLineApi('/kimi-code/api', 'Kimi Code')
    await expect(api.post('/settings')).rejects.toThrow('Method Not Allowed')
  })

  it('reads the structured error shape instead of printing "[object Object]"', async () => {
    // The ChatGPT routes answer `{ ok: false, error: { code, message } }`. Nine
    // hand-rolled readers interpolated that object into an Error and rendered
    // "[object Object]" in the settings card.
    respond(JSON.stringify({ ok: false, error: { code: 'bad-request', message: 'Malformed JSON request.' } }), { status: 400 })
    const api = createLineApi('/api/dsh-chatgpt-subscription', 'ChatGPT')
    await expect(api.request('/preferences/update', { method: 'POST' })).rejects.toThrow('Malformed JSON request.')
  })

  it('names the line and the stale-host cause when the route answers with nothing', async () => {
    // A route that is not mounted answers with an empty body, which is exactly
    // what a browser bundle newer than the host process produces.
    respond('', { status: 404 })
    const api = createLineApi('/workbuddy/api', 'WorkBuddy')
    await expect(api.get('/status')).rejects.toThrow(/WorkBuddy settings route did not answer.*restart DSH/)
  })

  it('reports a non-JSON body with the beginning of what arrived', async () => {
    respond('<html>gateway</html>', { status: 502 })
    const api = createLineApi('/command-code/api', 'Command Code')
    await expect(api.get('/status')).rejects.toThrow(/Command Code settings route returned a non-JSON body.*<html>/)
  })

  it('returns a payload that documents itself instead of an envelope', async () => {
    // MiniMax Code's own route table returns the DTO directly; the reader must
    // not demand an envelope that never arrives.
    respond(JSON.stringify({ enabled: true, models: [] }))
    const api = createLineApi('/minimax-code/api', 'MiniMax Code')
    await expect(api.get<{ enabled: boolean }>('/status')).resolves.toMatchObject({ enabled: true })
  })

  it('treats ok:false as a failure even when the transport succeeded', async () => {
    respond(JSON.stringify({ ok: false, error: 'nope' }), { status: 200 })
    const api = createLineApi('/antigravity/api', 'Antigravity')
    await expect(api.get('/status')).rejects.toThrow('nope')
  })

  it('sends same-origin credentials and a JSON content type on every call', async () => {
    const calls = respond(JSON.stringify({ ok: true, value: null }))
    const api = createLineApi('/claude/api', 'Claude')
    await api.post('/settings', { enabled: false })
    expect(calls[0]?.url).toBe('/claude/api/settings')
    expect(calls[0]?.init?.credentials).toBe('same-origin')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.body).toBe('{"enabled":false}')
    expect((calls[0]?.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('falls back to the status code when the failure states no message at all', async () => {
    respond(JSON.stringify({ ok: false }), { status: 503 })
    const api = createLineApi('/kimi-code/api', 'Kimi Code')
    await expect(api.get('/status')).rejects.toThrow('HTTP 503')
  })
})
