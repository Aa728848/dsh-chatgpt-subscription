import { describe, expect, it, vi } from 'vitest'
import { createCodexFetchProvider } from '../src/host/codex-fetch.ts'

describe('createCodexFetchProvider', () => {
  it('fetches and decodes HTML content', async () => {
    const fetchFn = vi.fn(async () => new Response('<html><body><h1>Hello World</h1></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }))

    const provider = createCodexFetchProvider({ fetchFn: fetchFn as never })
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
})
