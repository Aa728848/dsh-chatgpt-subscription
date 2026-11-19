import { describe, expect, it, vi } from 'vitest'
import { RelayOneQuotaReader, RELAYONE_STATUS_URL, RELAYONE_TOKEN_USAGE_URL } from '../src/host/relayone/quota.ts'
import type { RelayOneCredentialStore, RelayOneCredentials } from '../src/host/relayone/token-store.ts'
import type { RelayOneStatusDto } from '../src/shared/relayone-contracts.ts'
import { selectRelayOneBadgeFacts } from '../src/client/relayone/RelayOneComposerQuota.tsx'

function credentialStore(initial = 'sk-quota') {
  let credentials: RelayOneCredentials | null = { apiKey: initial, authenticatedAt: 1 }
  return {
    store: { read: async () => credentials } as unknown as RelayOneCredentialStore,
    setKey(value: string) { credentials = { apiKey: value, authenticatedAt: 2 } },
  }
}
function usage(overrides: Record<string, unknown> = {}): Response {
  return Response.json({ code: true, data: {
    object: 'token_usage', total_granted: 1000000, total_used: 250000,
    total_available: 750000, unlimited_quota: false, expires_at: 0, ...overrides,
  } })
}
function fetchFor(handler?: (url: string, key: string) => Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const key = new Headers(init?.headers).get('authorization') ?? ''
    if (handler !== undefined) return handler(url, key)
    if (url === RELAYONE_TOKEN_USAGE_URL) return usage()
    if (url === RELAYONE_STATUS_URL) return Response.json({ success: true, data: { quota_per_unit: 500000 } })
    throw new Error('unexpected ' + url)
  }) as unknown as typeof fetch
}

describe('RelayOne token quota', () => {
  it('tolerates a legacy host status with no quota field', () => {
    expect(selectRelayOneBadgeFacts({ authenticated: true } as RelayOneStatusDto)).toBeNull()
  })
  it('maps granted/used/available, percent and USD into the composer badge', async () => {
    const store = credentialStore()
    const reader = new RelayOneQuotaReader(store.store, { fetchFn: fetchFor() })
    await reader.refresh(true)
    const quota = reader.snapshot()
    expect(quota).toMatchObject({ state: 'ready', totalAvailable: 750000, remainingPercent: 75, quotaPerUnit: 500000 })
    const facts = selectRelayOneBadgeFacts({ authenticated: true, quota } as RelayOneStatusDto)
    expect(facts).toMatchObject({ text: '75%', level: 'normal' })
    expect(facts).not.toHaveProperty('percent')
    expect(facts?.tooltip).toContain('$1.500')
    expect(facts?.tooltip).toContain('$0.500')
  })
  it('uses the smaller of token and owner balances when user_quota is present', async () => {
    const store = credentialStore()
    const fetchFn = fetchFor(async url => url === RELAYONE_TOKEN_USAGE_URL
      ? usage({ user_quota: { total_available: 400000 } })
      : Response.json({ data: { quota_per_unit: 500000 } }))
    const reader = new RelayOneQuotaReader(store.store, { fetchFn })
    await reader.refresh(true)
    expect(reader.snapshot().totalAvailable).toBe(400000)
    expect(reader.snapshot().remainingPercent).toBe(40)
  })
  it('distinguishes unlimited tokens, finite owner balance and zero granted', async () => {
    const store = credentialStore()
    const reader = new RelayOneQuotaReader(store.store, { fetchFn: fetchFor(async url => url === RELAYONE_TOKEN_USAGE_URL
      ? usage({ unlimited_quota: true, total_available: 0, total_granted: 0 })
      : Response.json({ data: { quota_per_unit: 500000 } })) })
    await reader.refresh(true)
    expect(reader.snapshot()).toMatchObject({ state: 'unlimited', totalAvailable: null, remainingPercent: null })
    expect(selectRelayOneBadgeFacts({ authenticated: true, quota: reader.snapshot() } as RelayOneStatusDto)).toMatchObject({ text: '∞' })
    const finite = new RelayOneQuotaReader(store.store, { fetchFn: fetchFor(async url => url === RELAYONE_TOKEN_USAGE_URL
      ? usage({ unlimited_quota: true, total_available: 0, total_granted: 250000, user_quota: { total_available: 200000 } })
      : Response.json({ data: { quota_per_unit: 500000 } })) })
    await finite.refresh(true)
    expect(finite.snapshot()).toMatchObject({ state: 'ready', totalAvailable: 200000, remainingPercent: null })
  })
  it('keeps stale facts after a refresh error instead of inventing zero', async () => {
    const store = credentialStore()
    const mock = fetchFor()
    const reader = new RelayOneQuotaReader(store.store, { fetchFn: mock })
    await reader.refresh(true)
    ;(mock as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response('down', { status: 500 }))
    await reader.refresh(true)
    expect(reader.snapshot()).toMatchObject({ state: 'stale', totalAvailable: 750000, remainingPercent: 75 })
    expect(reader.snapshot().error).toContain('500')
  })
  it('keeps the last unlimited key fact on failure without exposing a credential echoed by the gateway', async () => {
    const key = 'opaque-fixture-credential'
    const store = credentialStore(key)
    let fail = false
    const reader = new RelayOneQuotaReader(store.store, { fetchFn: fetchFor(async url =>
      url === RELAYONE_STATUS_URL ? Response.json({ data: { quota_per_unit: 500000 } })
        : fail ? Response.json({ code: false, message: 'denied: ' + key })
          : usage({ unlimited_quota: true, total_available: 0 })) })
    await reader.refresh(true)
    fail = true
    await reader.refresh(true)
    const quota = reader.snapshot()
    expect(quota.state).toBe('stale')
    expect(JSON.stringify(quota)).not.toContain(key)
    const badge = selectRelayOneBadgeFacts({ authenticated: true, quota } as RelayOneStatusDto, key => key)
    expect(badge).toMatchObject({ text: '∞' })
    expect(badge?.tooltip).toContain('quotaStale')
  })
  it('drops an in-flight response when the credential changes', async () => {
    const store = credentialStore('sk-old')
    let resolveOld: ((value: Response) => void) | undefined
    const oldUsage = new Promise<Response>(resolve => { resolveOld = resolve })
    const fetchFn = fetchFor(async (url, key) => {
      if (url === RELAYONE_STATUS_URL) return Response.json({ data: { quota_per_unit: 500000 } })
      if (key === 'Bearer sk-old') return oldUsage
      return usage({ total_available: 200000, total_granted: 400000, total_used: 200000 })
    })
    const reader = new RelayOneQuotaReader(store.store, { fetchFn })
    const old = reader.refresh(true)
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled())
    store.setKey('sk-new')
    const fresh = reader.refresh(true)
    await fresh
    resolveOld?.(usage())
    await old
    expect(reader.snapshot()).toMatchObject({ state: 'ready', totalAvailable: 200000, remainingPercent: 50 })
  })
})
