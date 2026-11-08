import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HUB_MANIFEST_URL,
  HUB_RELEASE_CHANGELISTS,
  currentHubVersion,
  hubChangelist,
  parseHubManifestVersion,
  refreshHubVersion,
  resetHubVersionCache,
} from '../src/host/antigravity/client-version.ts'
import { defaultUserAgent, loadCodeAssistDetail } from '../src/host/antigravity/client.ts'
import { DEFAULT_ANTIGRAVITY_CL, DEFAULT_ANTIGRAVITY_VERSION } from '../src/host/antigravity/types.ts'

/**
 * The Hub release this route claims.
 *
 * Cloud Code gates its model catalogue and its Gemini quota buckets on the
 * version in the User-Agent, so this is not cosmetic: a stale constant is a
 * worse client for the same account. The manifest is the only authority on
 * what the official app currently reports.
 */

const MANIFEST = `version: 2.25.0
files:
  - url: antigravity-hub-2.25.0-arm64-mac.zip
    sha512: not-a-real-hash
    size: 123
path: antigravity-hub-2.25.0-arm64-mac.zip
releaseDate: '2026-11-02T00:00:00.000Z'
`

const HOUR = 60 * 60 * 1000

describe('Antigravity Hub release discovery', () => {
  beforeEach(() => {
    resetHubVersionCache()
    vi.unstubAllEnvs()
  })
  afterEach(() => {
    resetHubVersionCache()
    vi.unstubAllEnvs()
  })

  it('reads the release out of an electron-builder manifest', () => {
    expect(parseHubManifestVersion(MANIFEST)).toBe('2.25.0')
    expect(parseHubManifestVersion('version: "2.24.0"\n')).toBe('2.24.0')
    expect(parseHubManifestVersion('no version here')).toBeUndefined()
  })

  it('reports the manifest release, and omits an unknown changelist', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(HUB_MANIFEST_URL)
      // The updater is an electron-builder client and says so; sending the Hub
      // agent here would be this plugin's invention.
      expect(new Headers(init?.headers as HeadersInit).get('user-agent')).toBe('electron-builder')
      return new Response(MANIFEST, { status: 200 })
    }) as unknown as typeof fetch

    await refreshHubVersion(fetchFn)

    expect(currentHubVersion()).toBe('2.25.0')
    // A release with no known build changelist states no `cl=` at all, which is
    // what the official client does for a build it does not know.
    expect(hubChangelist()).toBeUndefined()
    expect(defaultUserAgent()).toContain('antigravity/hub/2.25.0')
    expect(defaultUserAgent()).not.toContain('cl=')
  })

  it('falls back to the built-in release when the manifest cannot be read', async () => {
    const failing = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch

    await refreshHubVersion(failing)

    expect(currentHubVersion()).toBe(DEFAULT_ANTIGRAVITY_VERSION)
    expect(hubChangelist()).toBe(DEFAULT_ANTIGRAVITY_CL)
    expect(defaultUserAgent()).toContain(`cl=${DEFAULT_ANTIGRAVITY_CL}`)
  })

  it('keeps a known release for the documented window, then reads again', async () => {
    const fetchFn = vi.fn(async () => new Response(MANIFEST, { status: 200 })) as unknown as typeof fetch

    await refreshHubVersion(fetchFn, 1_000)
    await refreshHubVersion(fetchFn, 1_000 + HOUR)
    expect(fetchFn).toHaveBeenCalledTimes(1)

    await refreshHubVersion(fetchFn, 1_000 + 6 * HOUR + 1)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('lets an explicit version pin win over discovery', async () => {
    vi.stubEnv('DSH_ANTIGRAVITY_VERSION', '2.24.0')
    const fetchFn = vi.fn(async () => new Response(MANIFEST, { status: 200 })) as unknown as typeof fetch

    await refreshHubVersion(fetchFn)

    expect(fetchFn).not.toHaveBeenCalled()
    expect(currentHubVersion()).toBe('2.24.0')
    expect(hubChangelist()).toBe('1000335682')
  })

  it('keeps the release table in step with the built-in release', () => {
    expect(HUB_RELEASE_CHANGELISTS[DEFAULT_ANTIGRAVITY_VERSION]).toBe(DEFAULT_ANTIGRAVITY_CL)
  })

  it('asks loadCodeAssist with ideType alone, as the Hub does', async () => {
    const bodies: unknown[] = []
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ currentTier: { id: 'free-tier' } })
    }) as unknown as typeof fetch

    await loadCodeAssistDetail('tok', fetchFn)

    // Platform and plugin type are hub-side concepts; the values this route used
    // to send (MACOS/WINDOWS) are not valid Cloud Code platform members.
    expect(bodies[0]).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } })
  })
})
