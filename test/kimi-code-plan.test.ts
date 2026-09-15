import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  accountFromCredentials,
  buildModelOptions,
  clearCachedQuota,
  fetchAccountQuota,
  fetchProfile,
  membershipLevelName,
  parsePlanName,
} from '../src/host/kimi-code/client.ts'
import { FileCredentialStore, type KimiCodeCredentials } from '../src/host/kimi-code/token-store.ts'
import { KIMI_CODE_MODELS } from '../src/host/kimi-code/model-catalog.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function creds(overrides: Partial<KimiCodeCredentials> = {}): KimiCodeCredentials {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 3_600_000,
    expiresIn: 3_600,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
    ...overrides,
  }
}

afterEach(() => {
  clearCachedQuota()
  vi.restoreAllMocks()
})

describe('membershipLevelName', () => {
  it('maps every documented level code to its marketing name', () => {
    // \`/usages\` dropped \`user_level_name\`, so the code is often all there is;
    // without this the card would render a raw enum.
    expect(membershipLevelName('LEVEL_STANDARD')).toBe('Moderato')
    expect(membershipLevelName('LEVEL_MODERATO')).toBe('Moderato')
    expect(membershipLevelName('LEVEL_INTERMEDIATE')).toBe('Allegretto')
    expect(membershipLevelName('LEVEL_ADVANCED')).toBe('Allegro')
    expect(membershipLevelName('LEVEL_PREMIUM')).toBe('Vivace')
  })

  it('still maps the older codes', () => {
    expect(membershipLevelName('LEVEL_FREE')).toBe('Adagio')
    expect(membershipLevelName('LEVEL_ANDANTE')).toBe('Andante')
  })

  it('is case-insensitive and passes an unknown code through', () => {
    expect(membershipLevelName('level_premium')).toBe('Vivace')
    expect(membershipLevelName('LEVEL_SOMETHING_NEW')).toBe('LEVEL_SOMETHING_NEW')
  })

  it('returns nothing for an absent value', () => {
    expect(membershipLevelName(null)).toBeNull()
    expect(membershipLevelName('')).toBeNull()
    expect(membershipLevelName(undefined)).toBeNull()
  })
})

describe('parsePlanName', () => {
  it('prefers a display name when the service sends one', () => {
    expect(parsePlanName({ user_level_name: 'Vivace' })).toBe('Vivace')
  })

  it('falls back to mapping the machine level', () => {
    expect(parsePlanName({ user: { membership: { level: 'LEVEL_INTERMEDIATE' } } })).toBe('Allegretto')
  })

  it('prefers an explicit level name over the code', () => {
    expect(parsePlanName({ user: { membership: { level: 'LEVEL_X', level_name: 'Custom' } } })).toBe('Custom')
  })

  it('returns nothing when the payload names no tier', () => {
    expect(parsePlanName({ usages: {} })).toBeNull()
  })
})

describe('accountFromCredentials', () => {
  it('takes the plan from the profile, which is its only source', () => {
    const account = accountFromCredentials(
      creds({ accessToken: jwt({ user_id: 'u_1' }) }),
      { usages: {} },
      { user_level_name: 'Allegretto', user_level: 40 },
    )
    expect(account.planName).toBe('Allegretto')
    expect(account.planLevel).toBe('40')
    expect(account.userId).toBe('u_1')
  })

  it('falls back to the usages payload when no profile was read', () => {
    const account = accountFromCredentials(creds(), { user_level_name: 'Moderato' })
    expect(account.planName).toBe('Moderato')
  })

  it('uses the stored plan when neither payload names one', () => {
    expect(accountFromCredentials(creds({ planName: 'Vivace' }), {}).planName).toBe('Vivace')
  })

  it('reads the nickname from the profile', () => {
    expect(accountFromCredentials(creds(), undefined, { nickname: 'moonwalker' }).nickname).toBe('moonwalker')
  })
})

describe('fetchProfile and the plan name', () => {
  it('requests /me and reports the tier it names', async () => {
    const store = new FileCredentialStore(tmp('kc-me'))
    vi.spyOn(store, 'read').mockResolvedValue(creds())
    const write = vi.spyOn(store, 'write').mockResolvedValue(undefined)
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string | URL) => {
      seen.push(String(url))
      if (String(url).endsWith('/me')) {
        return Response.json({ user_id: 'u_1', user_level_name: 'Allegretto', nickname: 'walker' })
      }
      return Response.json({ usages: { limit_5h: { used_ratio: 0.1 } } })
    }) as unknown as typeof fetch

    const quota = await fetchAccountQuota(store, { fetchFn: fetchMock, force: true })
    expect(seen.some((url) => url.endsWith('/me'))).toBe(true)
    expect(quota?.account.planName).toBe('Allegretto')
    // The tier is remembered so the status fallback can show it too.
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ planName: 'Allegretto' }))
  })

  it('still returns the account when the profile call fails', async () => {
    const store = new FileCredentialStore(tmp('kc-me-fail'))
    vi.spyOn(store, 'read').mockResolvedValue(creds({ accessToken: jwt({ user_id: 'u_9' }), refreshToken: jwt({}) }))
    vi.spyOn(store, 'write').mockResolvedValue(undefined)
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/me')) return new Response('nope', { status: 500 })
      return Response.json({ usages: {} })
    }) as unknown as typeof fetch

    const quota = await fetchAccountQuota(store, { fetchFn: fetchMock, force: true })
    // A profile is enrichment; the identity still comes from the token.
    expect(quota?.account.userId).toBe('u_9')
  })

  it('returns null rather than throwing when the profile is unreachable', async () => {
    const store = new FileCredentialStore(tmp('kc-me-null'))
    vi.spyOn(store, 'read').mockResolvedValue(creds())
    const fetchMock = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    await expect(fetchProfile(store, { fetchFn: fetchMock })).resolves.toBeNull()
  })
})

describe('buildModelOptions capabilities', () => {
  it('reports video input and the plan requirement from the registry', () => {
    // These were hardcoded to false/null, which discarded what the catalog knows.
    const options = buildModelOptions(
      [{ id: 'k3', contextWindow: 262_144 }],
      ['k3'],
      {},
    )
    const k3 = options[0]!
    expect(k3.supportsVideo).toBe(true)
    expect(k3.minimumPlan).toBe('Moderato')
    expect(k3.description).toContain('flagship')
  })

  it('keeps k3-256k as image-only, matching the official table', () => {
    const options = buildModelOptions([{ id: 'k3-256k', contextWindow: 262_144 }], ['k3-256k'], {})
    expect(options[0]?.supportsVideo).toBe(false)
  })

  it('prefers a live-catalog capability flag when it reports one', () => {
    const options = buildModelOptions(
      [{ id: 'k3', contextWindow: 262_144, supportsVideo: false, description: 'from catalog' }],
      ['k3'],
      {},
    )
    expect(options[0]?.supportsVideo).toBe(false)
    expect(options[0]?.description).toBe('from catalog')
  })

  it('never declares video as a sendable modality, because DSH cannot send it', () => {
    // DSH's modality vocabulary is text|image only; advertising video would make
    // DSH hand the route bytes it cannot deliver.
    const options = buildModelOptions(KIMI_CODE_MODELS.map((m) => ({ id: m.id, contextWindow: m.contextWindow })), ['k3'], {})
    for (const option of options) {
      expect(option.reasoningEfforts === undefined || Array.isArray(option.reasoningEfforts)).toBe(true)
    }
    const all = KIMI_CODE_MODELS
    expect(all.find((m) => m.id === 'k3')?.inputModalities).toContain('video')
    expect(all.find((m) => m.id === 'k3-256k')?.inputModalities).not.toContain('video')
  })
})
