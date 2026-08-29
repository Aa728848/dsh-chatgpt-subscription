import { describe, expect, it, vi } from 'vitest'
import { createCodexSearchProvider } from '../src/host/codex-search.ts'

describe('createCodexSearchProvider', () => {
  it('searches Codex and formats content and sources', async () => {
    const oauth = { credentials: vi.fn(async () => ({ accessToken: 'secret', accountId: 'acc', planType: 'plus', expiresAt: Date.now() + 10000 })) } as never
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      output_text: 'Search summary for query',
      sources: [
        { url: 'https://example.com/item1', title: 'Item 1', snippet: 'Snippet 1' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const provider = createCodexSearchProvider(oauth, { fetchFn: fetchFn as never })
    const result = await provider.search({ query: 'test query' })

    expect(result.content).toBe('Search summary for query')
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0].url).toBe('https://example.com/item1')
  })
})
