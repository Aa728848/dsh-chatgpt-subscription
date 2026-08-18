import { describe, expect, it, vi } from 'vitest'
import { CODEX_ENHANCED_ORIGINATOR, CODEX_SEARCH_PROVIDER_ID, CODEX_SEARCH_URL } from '../src/compat.ts'
import { createCodexSearchProvider } from '../src/host/codex-search.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'

describe('Codex search provider', () => {
  it('sends a Codex search request and normalizes citeable sources', async () => {
    const store = new MemoryTokenStore()
    await store.save({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'account-id',
    })
    const oauth = new OAuthService(store)
    const fetchFn = vi.fn(async () => Response.json({
      results: [
        { url: 'https://example.com/a', title: 'A', snippet: 'First' },
        { url: 'https://example.com/a', title: 'Duplicate' },
        { link: 'https://example.com/b', name: 'B' },
      ],
      output_text: 'summary',
    }))
    const provider = createCodexSearchProvider(oauth, { fetchFn: fetchFn as typeof fetch, idFactory: () => 'search-id' })

    const result = await provider.search({ query: 'Codex subscription search', maxResults: 1 })

    expect(provider.id).toBe(CODEX_SEARCH_PROVIDER_ID)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe(CODEX_SEARCH_URL)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer access-token',
      'chatgpt-account-id': 'account-id',
      originator: CODEX_ENHANCED_ORIGINATOR,
    })
    expect(JSON.parse(String(init?.body))).toMatchObject({
      id: 'search-id',
      input: 'Codex subscription search',
      commands: { search_query: [{ q: 'Codex subscription search' }] },
    })
    expect(result).toEqual({
      content: 'summary',
      sources: [{ url: 'https://example.com/a', title: 'A', snippet: 'First' }],
      truncated: true,
    })
    oauth.dispose()
  })
})
