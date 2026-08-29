import { describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import { CODEX_FETCH_PROVIDER_ID } from '../src/compat.ts'
import { createCodexFetchProvider } from '../src/host/codex-fetch.ts'

describe('Codex fetch provider', () => {
  it('fetches an HTML webpage successfully with custom headers and user-agent', async () => {
    const fetchFn = vi.fn(async () => new Response('<!DOCTYPE html><html><body><h1>Hello World</h1></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }))

    const provider = createCodexFetchProvider({ fetchFn: fetchFn as typeof fetch })
    expect(provider.id).toBe(CODEX_FETCH_PROVIDER_ID)
    expect(provider.available()).toBe(true)

    const result = await provider.fetch({ url: 'https://developer.mozilla.org/en-US/docs/Web' })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [targetUrl, init] = fetchFn.mock.calls[0]!
    expect(targetUrl).toBe('https://developer.mozilla.org/en-US/docs/Web')
    expect(init?.headers).toMatchObject({
      'User-Agent': expect.stringContaining('Mozilla/5.0'),
      Accept: expect.stringContaining('text/html'),
    })
    expect(result).toEqual({
      url: 'https://developer.mozilla.org/en-US/docs/Web',
      statusCode: 200,
      body: {
        kind: 'html',
        content: '<!DOCTYPE html><html><body><h1>Hello World</h1></body></html>',
      },
      truncated: false,
    })
  })

  it('fetches a plain text resource', async () => {
    const fetchFn = vi.fn(async () => new Response('Plain text response', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }))

    const provider = createCodexFetchProvider({ fetchFn: fetchFn as typeof fetch })
    const result = await provider.fetch({ url: 'https://github.com/robots.txt' })

    expect(result).toEqual({
      url: 'https://github.com/robots.txt',
      statusCode: 200,
      body: {
        kind: 'text',
        content: 'Plain text response',
      },
      truncated: false,
    })
  })

  it('truncates content when exceeding maxBodyLength', async () => {
    const fetchFn = vi.fn(async () => new Response('1234567890', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }))

    const provider = createCodexFetchProvider({ fetchFn: fetchFn as typeof fetch, maxBodyLength: 5 })
    const result = await provider.fetch({ url: 'https://example.com/large' })

    expect(result.truncated).toBe(true)
    expect(result.body.content).toBe('12345')
  })

  it('rejects invalid or non-HTTP URLs', async () => {
    const provider = createCodexFetchProvider()
    await expect(provider.fetch({ url: 'file:///etc/passwd' })).rejects.toThrow(WebError)
    await expect(provider.fetch({ url: 'invalid-url' })).rejects.toThrow(WebError)
  })

  it('wraps network errors into WebError', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('Connection refused')
    })
    const provider = createCodexFetchProvider({ fetchFn: fetchFn as typeof fetch })

    await expect(provider.fetch({ url: 'https://example.com' })).rejects.toThrow(WebError)
  })
})
