import { describe, expect, it, vi } from 'vitest'
import { CODEX_OPENAI_BETA, CODEX_ORIGINATOR, OAUTH_ORIGINATOR } from '../src/compat.ts'
import { CODEX_TURN_STATE_HEADER, codexHeaders } from '../src/host/wire-auth.ts'
import { parseListing } from '../src/host/codex-catalog.ts'
import { ResponsesClient } from '../src/host/responses-client.ts'
import { buildAuthorizationUrl } from '../src/host/oauth-service.ts'

const creds = { accessToken: 'secret', accountId: 'acc-1', refreshToken: 'r', expiresAt: Date.now() + 60_000 }

describe('codex wire headers', () => {
  it('presents the beta gate the subscription backend requires', () => {
    // Regression: the subscription backend is served under a beta flag. The
    // official CLI has always sent this header, and a request without it is not
    // the same surface — so its absence is a future 400/403, not a no-op.
    const headers = codexHeaders(creds as never, 'sess')

    expect(headers['openai-beta']).toBe(CODEX_OPENAI_BETA)
    expect(CODEX_OPENAI_BETA).toBe('responses=experimental')
  })

  it('carries the account id and one single originator', () => {
    const headers = codexHeaders(creds as never)

    expect(headers['chatgpt-account-id']).toBe('acc-1')
    expect(headers.originator).toBe(CODEX_ORIGINATOR)
  })

  it('omits the account id when the credential states none', () => {
    const headers = codexHeaders({ accessToken: 'secret', expiresAt: Date.now() + 60_000 } as never)

    expect(headers['chatgpt-account-id']).toBeUndefined()
  })

  it('replays turn state only when the previous turn supplied one', () => {
    expect(codexHeaders(creds as never, 'sess')['x-codex-turn-state']).toBeUndefined()
    expect(codexHeaders(creds as never, 'sess', { turnState: 'opaque-1' })['x-codex-turn-state']).toBe('opaque-1')
    expect(codexHeaders(creds as never, 'sess', { turnState: '' })['x-codex-turn-state']).toBeUndefined()
  })

  it('signs in with the same originator it requests with', () => {
    // One identity across the whole line: the request path and the OAuth flow
    // used to be able to disagree, which produced two failure signatures for
    // one account.
    expect(OAUTH_ORIGINATOR).toBe(CODEX_ORIGINATOR)
    const url = new URL(buildAuthorizationUrl('verifier', 'state'))
    expect(url.searchParams.get('originator')).toBe(CODEX_ORIGINATOR)
  })
})

describe('parseListing', () => {
  it('reads the documented envelope', () => {
    const models = parseListing({
      models: [{
        slug: 'gpt-6-astra',
        display_name: '6 Astra',
        context_window: 400_000,
        input_modalities: ['text', 'image'],
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      }],
    })

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'gpt-6-astra',
      name: '6 Astra',
      contextWindow: 400_000,
      inputModalities: ['text', 'image'],
      reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'medium',
    })
  })

  it('accepts a bare array as well as the envelope', () => {
    expect(parseListing([{ slug: 'gpt-6-sol' }])).toHaveLength(1)
  })

  it('keeps a model it has never heard of, with conservative capabilities', () => {
    // The listing is the authority on what the account may call, so an unknown
    // id is served rather than dropped — but it must not inherit invented
    // capabilities: text only, and no reasoning levels stated.
    const [entry] = parseListing({ models: [{ slug: 'gpt-99-unheard-of' }] })

    expect(entry).toBeDefined()
    expect(entry.id).toBe('gpt-99-unheard-of')
    expect(entry.name).toBe('gpt-99-unheard-of')
    expect(entry.inputModalities).toEqual(['text'])
    expect(entry.reasoningEfforts).toBeUndefined()
  })

  it('falls back to the shipped table for a known model it states nothing about', () => {
    const [entry] = parseListing({ models: [{ slug: 'gpt-6-sol' }] })

    expect(entry.inputModalities).toEqual(['text', 'image'])
    expect(entry.defaultReasoningEffort).toBe('medium')
  })

  it('reads effort levels written as bare strings as well as objects', () => {
    const [entry] = parseListing({ models: [{ slug: 'x', supported_reasoning_levels: ['low', 'high'] }] })

    expect(entry.reasoningEfforts).toEqual(['low', 'high'])
  })

  it('returns nothing for a shape it cannot read', () => {
    expect(parseListing(null)).toEqual([])
    expect(parseListing({ models: 'nope' })).toEqual([])
    expect(parseListing({ models: [{ display_name: 'no slug' }] })).toEqual([])
  })
})