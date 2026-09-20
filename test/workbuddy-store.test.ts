import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  isExpired,
  parseCredentialFile,
  scanCredentials,
} from '../src/host/workbuddy/token-store.ts'
import { FALLBACK_MODELS, modelsForRegion, resolveWorkBuddyModel } from '../src/host/workbuddy/model-catalog.ts'
import { backendForDomain, isIntlDomain, regionForDomain, refreshSourceForDomain } from '../src/host/workbuddy/types.ts'

const temporaryDirs: string[] = []

async function makeAuthDir(files: Record<string, unknown | string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-auth-'))
  temporaryDirs.push(dir)
  for (const [name, value] of Object.entries(files)) {
    const body = typeof value === 'string' ? value : JSON.stringify(value)
    await fs.writeFile(path.join(dir, name), body, 'utf8')
  }
  return dir
}

function credentialFile(options: {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  domain?: string
  uid?: string
  nickname?: string
  uin?: string
} = {}): unknown {
  return {
    account: {
      uid: options.uid ?? 'uid-1',
      nickname: options.nickname ?? 'tester',
      uin: options.uin ?? '100000000001',
      type: 'personal',
    },
    auth: {
      accessToken: options.accessToken ?? 'token-abc',
      refreshToken: options.refreshToken ?? 'refresh-abc',
      expiresAt: options.expiresAt ?? Date.now() + 3_600_000,
      domain: options.domain ?? 'copilot.tencent.com',
    },
  }
}

afterEach(async () => {
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('WorkBuddy region resolution', () => {
  it('routes .ai domains to the international backend and everything else domestic', () => {
    expect(isIntlDomain('www.workbuddy.ai')).toBe(true)
    expect(isIntlDomain('www.codebuddy.ai')).toBe(true)
    expect(isIntlDomain('copilot.tencent.com')).toBe(false)
    expect(isIntlDomain('')).toBe(false)

    expect(backendForDomain('www.workbuddy.ai')).toBe('https://www.workbuddy.ai')
    expect(backendForDomain('www.codebuddy.ai')).toBe('https://www.codebuddy.ai')
    expect(backendForDomain('copilot.tencent.com')).toBe('https://copilot.tencent.com')
    expect(backendForDomain('www.codebuddy.cn')).toBe('https://copilot.tencent.com')
  })

  it('classifies the region and picks the matching refresh source', () => {
    expect(regionForDomain('www.workbuddy.ai')).toBe('intl')
    expect(regionForDomain('copilot.tencent.com')).toBe('cn')
    // Measured: only the workbuddy.ai apex uses the `workbuddy` marker.
    expect(refreshSourceForDomain('www.workbuddy.ai')).toBe('workbuddy')
    expect(refreshSourceForDomain('www.codebuddy.ai')).toBe('plugin')
    expect(refreshSourceForDomain('copilot.tencent.com')).toBe('plugin')
  })
})

describe('WorkBuddy credential parsing', () => {
  it('reads the fields the plugin needs and derives the backend', () => {
    const parsed = parseCredentialFile(credentialFile({ domain: 'www.workbuddy.ai' }), '/tmp/a.info', 42)
    expect(parsed.accessToken).toBe('token-abc')
    expect(parsed.refreshToken).toBe('refresh-abc')
    expect(parsed.region).toBe('intl')
    expect(parsed.backend).toBe('https://www.workbuddy.ai')
    expect(parsed.uid).toBe('uid-1')
    expect(parsed.nickname).toBe('tester')
    expect(parsed.uin).toBe('100000000001')
    expect(parsed.sourceFile).toBe('/tmp/a.info')
    expect(parsed.sourceMtimeMs).toBe(42)
  })

  it('rejects a payload without an auth block or an access token', () => {
    expect(() => parseCredentialFile({ account: {} }, '/tmp/a.info')).toThrow(/auth block/)
    expect(() => parseCredentialFile({ auth: { refreshToken: 'r' } }, '/tmp/a.info')).toThrow(/access token/)
    expect(() => parseCredentialFile(null, '/tmp/a.info')).toThrow(/not an object/)
  })

  it('treats a token as expired one minute early', () => {
    const now = Date.now()
    expect(isExpired({ expiresAt: now + 120_000 } as any, now)).toBe(false)
    expect(isExpired({ expiresAt: now + 30_000 } as any, now)).toBe(true)
    // A credential that reports no expiry is not treated as expired.
    expect(isExpired({ expiresAt: 0 } as any, now)).toBe(false)
  })
})

describe('WorkBuddy credential scanning', () => {
  it('prefers the canonical desktop file over timestamped snapshots', async () => {
    const dir = await makeAuthDir({
      'workbuddy-desktop.2026-09-10T04-35-05-729Z.123.info': credentialFile({ accessToken: 'snapshot', expiresAt: Date.now() + 9_000_000 }),
      'workbuddy-desktop.info': credentialFile({ accessToken: 'live', expiresAt: Date.now() + 1_000_000 }),
    })
    const found = await scanCredentials(dir)
    expect(found.map((c) => c.accessToken)).toEqual(['live', 'snapshot'])
  })

  it('breaks a tie among snapshots by remaining validity', async () => {
    const dir = await makeAuthDir({
      'workbuddy-desktop.2026-01-01T00-00-00-000Z.1.info': credentialFile({ accessToken: 'older', expiresAt: Date.now() + 1_000_000 }),
      'workbuddy-desktop.2026-02-01T00-00-00-000Z.2.info': credentialFile({ accessToken: 'newer', expiresAt: Date.now() + 5_000_000 }),
    })
    const found = await scanCredentials(dir)
    expect(found.map((c) => c.accessToken)).toEqual(['newer', 'older'])
  })

  it('skips malformed files instead of failing the whole scan', async () => {
    const dir = await makeAuthDir({
      'broken.info': '{not json',
      'no-token.info': JSON.stringify({ auth: { refreshToken: 'x' } }),
      'good.info': credentialFile({ accessToken: 'good' }),
    })
    const found = await scanCredentials(dir)
    expect(found.map((c) => c.accessToken)).toEqual(['good'])
  })

  it('returns an empty list for a missing directory rather than throwing', async () => {
    expect(await scanCredentials(path.join(os.tmpdir(), 'wb-does-not-exist-xyz'))).toEqual([])
  })

  it('caches a scan but re-reads when forced', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': credentialFile({ accessToken: 'first' }) })
    const store = new FileCredentialStore(dir, 60_000)
    expect((await store.read())?.accessToken).toBe('first')

    await fs.writeFile(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify(credentialFile({ accessToken: 'second' })), 'utf8')
    // The cached read notices the file changed and rescans on its own.
    expect((await store.read())?.accessToken).toBe('second')

    await fs.writeFile(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify(credentialFile({ accessToken: 'third' })), 'utf8')
    expect((await store.read({ force: true }))?.accessToken).toBe('third')
  })

  it('reports no credential for an empty directory', async () => {
    const dir = await makeAuthDir({})
    const store = new FileCredentialStore(dir)
    expect(await store.read()).toBeNull()
  })
})

describe('WorkBuddy credential refresh bookkeeping', () => {
  it('refreshes once and writes the token back to the IDE file', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': credentialFile({ expiresAt: Date.now() - 1000 }) })
    const store = new FileCredentialStore(dir)
    const stale = (await store.read())!

    let calls = 0
    const fresh = await store.ensureFresh(stale, async (current) => {
      calls += 1
      return { ...current, accessToken: 'refreshed', refreshToken: 'rotated', expiresAt: Date.now() + 3_600_000 }
    })

    expect(calls).toBe(1)
    expect(fresh.accessToken).toBe('refreshed')

    // The IDE must not lose its session, so the refreshed token is persisted.
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'workbuddy-desktop.info'), 'utf8'))
    expect(onDisk.auth.accessToken).toBe('refreshed')
    expect(onDisk.auth.refreshToken).toBe('rotated')
    // Account bookkeeping the plugin does not own is preserved.
    expect(onDisk.account.uid).toBe('uid-1')
  })

  it('shares one refresh between concurrent callers', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': credentialFile({ expiresAt: Date.now() - 1000 }) })
    const store = new FileCredentialStore(dir)
    const stale = (await store.read())!

    let calls = 0
    const refresh = async (current: typeof stale) => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { ...current, accessToken: `refreshed-${calls}`, expiresAt: Date.now() + 3_600_000 }
    }

    const [a, b] = await Promise.all([
      store.ensureFresh(stale, refresh),
      store.ensureFresh(stale, refresh),
    ])
    // The refresh token rotates, so two refreshes would invalidate each other.
    expect(calls).toBe(1)
    expect(a.accessToken).toBe(b.accessToken)
  })

  it('does not refresh a credential that is still valid', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': credentialFile({ expiresAt: Date.now() + 3_600_000 }) })
    const store = new FileCredentialStore(dir)
    const current = (await store.read())!
    let calls = 0
    await store.ensureFresh(current, async (c) => { calls += 1; return c })
    expect(calls).toBe(0)
  })

  it('survives an unwritable credential file', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': credentialFile() })
    const store = new FileCredentialStore(dir)
    const current = (await store.read())!
    // A locked or read-only profile must not fail the in-flight request.
    await expect(store.writeBack({ ...current, sourceFile: path.join(dir, 'nope', 'x.info') })).resolves.toBeUndefined()
  })
})

describe('WorkBuddy model settings store', () => {
  it('returns the shipped defaults when the file is absent', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'wb-set-')), 'models.json')
    const store = new FileModelSettingsStore(file)
    const settings = await store.read()
    expect(settings.enabled).toBe(true)
    expect(settings.defaultReasoningEffort).toBeNull()
    expect(settings.enabledModelIds.length).toBeGreaterThan(0)
  })

  it('round-trips an update and merges context overrides', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'wb-set-')), 'models.json')
    const store = new FileModelSettingsStore(file)
    await store.updateSettings({ enabledModelIds: ['glm-5.3'], defaultReasoningEffort: 'high', contextWindowOverrides: { 'glm-5.3': 500_000 } })
    await store.updateSettings({ contextWindowOverrides: { 'kimi-k3': 300_000 } })
    const settings = await store.read()
    expect(settings.enabledModelIds).toEqual(['glm-5.3'])
    expect(settings.defaultReasoningEffort).toBe('high')
    expect(settings.contextWindowOverrides).toEqual({ 'glm-5.3': 500_000, 'kimi-k3': 300_000 })
  })

  it('ignores an unknown reasoning level on disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-set-'))
    const file = path.join(dir, 'models.json')
    await fs.writeFile(file, JSON.stringify({ defaultReasoningEffort: 'nonsense' }), 'utf8')
    expect((await new FileModelSettingsStore(file).read()).defaultReasoningEffort).toBeNull()
  })
})

describe('WorkBuddy fallback catalog', () => {
  it('carries the gateway-reported context windows, not vendor guesses', () => {
    // These two were wrong in an earlier hand-written revision: the gateway
    // serves GLM-5.3 and Kimi K3 at 1M, not 200K/256K.
    expect(resolveWorkBuddyModel('glm-5.3').contextWindow).toBe(1_000_000)
    expect(resolveWorkBuddyModel('kimi-k3').contextWindow).toBe(1_000_000)
  })

  it('distinguishes the served default from the model maximum', () => {
    // The gateway serves deepseek-v4.1-flash at 300K by default while allowing
    // 1M; DSH must size its overflow decisions against the served default.
    const entry = resolveWorkBuddyModel('deepseek-v4.1-flash')
    expect(entry.contextWindow).toBe(300_000)
    expect(entry.maxContextWindow).toBe(1_000_000)
  })

  it('records the per-model reasoning ladder and image support', () => {
    expect(resolveWorkBuddyModel('glm-5.3').reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(resolveWorkBuddyModel('gpt-6-astra').reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(resolveWorkBuddyModel('glm-5.3').supportsImage).toBe(true)
    expect(resolveWorkBuddyModel('kimi-k2-thinking').supportsImage).toBe(false)
  })

  it('filters the catalog by region, since a wrong-region call is a 400', () => {
    const cn = modelsForRegion('cn').map((m) => m.id)
    const intl = modelsForRegion('intl').map((m) => m.id)
    expect(intl).toContain('gemini-3.5-flash')
    expect(cn).not.toContain('gemini-3.5-flash')
    expect(cn).toContain('glm-5.3-flash')
    expect(intl).not.toContain('glm-5.3-flash')
    expect(intl).toContain('kimi-k3')
    expect(cn).toContain('kimi-k3-1')
  })

  it('resolves an unknown id to a text-only entry rather than a real model', () => {
    // Reporting a real model's capabilities for an id it does not describe
    // would declare image support the endpoint then rejects.
    const unknown = resolveWorkBuddyModel('totally-made-up')
    expect(unknown.id).toBe('totally-made-up')
    expect(unknown.supportsImage).toBe(false)
    expect(unknown.reasoningEfforts).toEqual([])
  })

  it('never lists the image-generation tools as chat models', () => {
    expect(FALLBACK_MODELS.some((m) => m.id.includes('image-alpha'))).toBe(false)
  })
})
