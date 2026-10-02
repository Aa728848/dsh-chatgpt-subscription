import { describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
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

  // The request body IS the contract with /alpha/search, and that endpoint
  // rejects unknown parameters rather than ignoring them. A field added here
  // for a reason that has since expired is not a no-op: it is a 400 on every
  // subscription search, which is what happened to the hard-coded
  // `max_output_tokens: 4096`. Asserting the whole body, rather than one
  // field's absence, is what makes the next one of these loud.
  it('sends exactly the body the search endpoint accepts, and no output cap', async () => {
    const oauth = { credentials: vi.fn(async () => ({ accessToken: 'secret', expiresAt: Date.now() + 10_000 })) } as never
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ sources: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await createCodexSearchProvider(oauth, { fetchFn: fetchFn as never }).search({ query: 'a query' })

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>

    // The regression this pins, named directly so the failure says what broke.
    expect(
      body,
      '/alpha/search rejects max_output_tokens (400 Unsupported parameter). Do not add an '
        + 'output cap to this request; let the service apply its own default.',
    ).not.toHaveProperty('max_output_tokens')

    // ...and the fields that endpoint does require, so the removal above cannot
    // be satisfied by emptying the body.
    expect(url).toContain('/alpha/search')
    expect(init.method).toBe('POST')
    expect(body.input).toBe('a query')
    expect(body.commands).toEqual({ search_query: [{ q: 'a query' }] })
    expect(body.settings).toEqual({ allowed_callers: ['direct'], external_web_access: true })
    expect(typeof body.id).toBe('string')
    expect(typeof body.model).toBe('string')
  })

  it('asks for a credential as a tool, not as a metered request', async () => {
    // Regression: search used to ask as a request, so a Codex quota cooldown
    // disabled web search with a "credentials are required" message.
    const credentials = vi.fn(async () => ({ accessToken: 'secret', expiresAt: Date.now() + 10_000 }))
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ sources: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const oauth = { credentials } as never

    await createCodexSearchProvider(oauth, { fetchFn: fetchFn as never }).search({ query: 'anything' })

    expect(credentials).toHaveBeenCalledWith(false, { purpose: 'tool' })
  })

  it('retries a 401 once with a forced refresh', async () => {
    const credentials = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'stale', expiresAt: Date.now() + 10_000 })
      .mockResolvedValueOnce({ accessToken: 'fresh', expiresAt: Date.now() + 10_000 })
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sources: [{ url: 'https://example.com/a' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))

    const result = await createCodexSearchProvider({ credentials } as never, { fetchFn: fetchFn as never })
      .search({ query: 'anything' })

    expect(credentials).toHaveBeenLastCalledWith(true, { purpose: 'tool' })
    expect(result.sources[0]?.url).toBe('https://example.com/a')
  })

  describe('credential failure reporting', () => {
    /** The error a search raises when the credential lookup fails this way. */
    async function searchFailure(error: unknown): Promise<{ code?: string; message: string }> {
      const provider = createCodexSearchProvider(
        { credentials: async () => { throw error } } as never,
        { fetchFn: (async () => new Response('{}', { status: 200 })) as never },
      )
      try {
        await provider.search({ query: 'anything' })
      } catch (caught) {
        return caught as { code?: string; message: string }
      }
      throw new Error('expected the search to fail')
    }

    it('reports a rate-limited account as rate limited, not as a missing credential', async () => {
      // The two failures need opposite actions: refill the quota vs. sign in.
      const caught = await searchFailure(new LlmError('全部 1 个 ChatGPT 账号均处于配额限制或冷却中 (429)。', 'RATE_LIMIT', { status: 429 }))

      expect(caught.code).toBe('WEB_PROVIDER_RATE_LIMITED')
      expect(caught.message).toContain('rate limited')
      // The provider's own reason survives, so the card is actionable.
      expect(caught.message).toContain('配额限制或冷却中')
    })

    it('reports a rejected sign-in as a missing credential', async () => {
      const caught = await searchFailure(new LlmError('ChatGPT sign-in has expired.', 'AUTH', { status: 401 }))

      expect(caught.code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING')
      expect(caught.message).toContain('Sign in with ChatGPT')
    })

    it('names an unclassified storage failure in the credential message', async () => {
      const caught = await searchFailure(new Error('DPAPI credential read failed'))

      expect(caught.code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING')
      expect(caught.message).toBe('ChatGPT subscription credentials are required for Codex search. (DPAPI credential read failed)')
    })
  })
})
