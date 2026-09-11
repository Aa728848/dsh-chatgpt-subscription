import { describe, expect, it, vi } from 'vitest'
import { createCodexFetchProvider } from '../src/host/codex-fetch.ts'

describe('createCodexFetchProvider', () => {
  it('fetches and decodes HTML content', async () => {
    const fetchFn = vi.fn(async () => new Response('<html><body><h1>Hello World</h1></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }))

    const provider = createCodexFetchProvider({
      fetchFn: fetchFn as never,
      resolveHostAddresses: async () => ['93.184.216.34'],
    })
    const result = await provider.fetch({ url: 'https://example.com' })

    expect(result.statusCode).toBe(200)
    expect(result.body.kind).toBe('html')
    expect(result.body.content).toBe('<html><body><h1>Hello World</h1></body></html>')
    expect(result.truncated).toBe(false)
  })

  it('rejects invalid schemes', async () => {
    const provider = createCodexFetchProvider()
    await expect(provider.fetch({ url: 'ftp://example.com' })).rejects.toThrow('unsupported URL scheme')
  })

  it('fetches a name whose answer is the proxy fake-ip range', async () => {
    const fetchFn = vi.fn(async () => new Response('proxied', { headers: { 'content-type': 'text/plain' } }))
    const resolveHostAddresses = vi.fn(async () => ['198.18.0.17'])
    const provider = createCodexFetchProvider({ fetchFn: fetchFn as never, resolveHostAddresses })

    await expect(provider.fetch({ url: 'https://api.github.com/zen' })).resolves.toMatchObject({ statusCode: 200 })
    expect(resolveHostAddresses).toHaveBeenCalledWith('api.github.com')
    expect(fetchFn).toHaveBeenCalledWith('https://api.github.com/zen', expect.objectContaining({ method: 'GET' }))
  })

  it('refuses a stated non-public address without calling the transport', async () => {
    const fetchFn = vi.fn()
    const provider = createCodexFetchProvider({ fetchFn: fetchFn as never })

    await expect(provider.fetch({ url: 'http://127.0.0.1:3080/api/status' }))
      .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
    await expect(provider.fetch({ url: 'http://[::1]:3080/' }))
      .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses a name this machine resolves into private space', async () => {
    const fetchFn = vi.fn()
    const provider = createCodexFetchProvider({
      fetchFn: fetchFn as never,
      resolveHostAddresses: async () => ['169.254.169.254'],
    })

    await expect(provider.fetch({ url: 'http://metadata.example/latest/meta-data/' }))
      .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('leaves an unresolvable name to the proxy instead of failing the fetch', async () => {
    const fetchFn = vi.fn(async () => new Response('proxied', { headers: { 'content-type': 'text/plain' } }))
    const provider = createCodexFetchProvider({ fetchFn: fetchFn as never, resolveHostAddresses: async () => [] })

    await expect(provider.fetch({ url: 'https://proxy-only.example/page' })).resolves.toMatchObject({ statusCode: 200 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
