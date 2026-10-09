import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  ManagedCredentialStore,
  isExpired,
  parseCredentialFile,
  scanCredentials,
  workBuddyAccountId,
} from '../src/host/workbuddy/token-store.ts'
import { createWorkBuddyStore } from './support/workbuddy-fixtures.ts'
import {
  FALLBACK_MODELS,
  groupWorkBuddyModelsByVendor,
  modelsForRegion,
  resolveWorkBuddyModel,
  workBuddyModelVendor,
} from '../src/host/workbuddy/model-catalog.ts'
import { backendForDomain, isIntlDomain, regionForDomain, refreshSourceForDomain } from '../src/host/workbuddy/types.ts'

const temporaryDirs: string[] = []

/** Build an unsigned JWT-shaped token carrying the claims under test. */
function jwtToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`
}

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
    const file = path.join(dir, 'workbuddy-desktop.info')
    const store = createWorkBuddyStore(dir, 60_000)
    expect((await store.read())?.accessToken).toBe('first')

    // The change detector compares mtimes, and a filesystem timestamp is coarse:
    // two writes inside one tick are recorded with the SAME value, so a rewrite
    // that lands in the same tick as the scan is invisible to it. Measured on
    // Windows, that is 2 writes in 3 at sub-millisecond spacing, which is why
    // this assertion used to fail intermittently in CI. The rewrite therefore
    // states its modification time explicitly instead of racing the clock - the
    // behaviour under test (a file the store can SEE changed is rescanned without
    // `force`) is unchanged.
    const scannedAt = (await fs.stat(file)).mtimeMs
    await fs.writeFile(file, JSON.stringify(credentialFile({ accessToken: 'second' })), 'utf8')
    await fs.utimes(file, new Date(scannedAt + 5_000), new Date(scannedAt + 5_000))
    // The cached read notices the file changed and rescans on its own.
    expect((await store.read())?.accessToken).toBe('second')

    await fs.writeFile(file, JSON.stringify(credentialFile({ accessToken: 'third' })), 'utf8')
    expect((await store.read({ force: true }))?.accessToken).toBe('third')
  })

  it('reports no credential for an empty directory', async () => {
    const dir = await makeAuthDir({})
    const store = createWorkBuddyStore(dir)
    expect(await store.read()).toBeNull()
  })

  it('deduplicates snapshots and selects a requested China or international account', async () => {
    const dir = await makeAuthDir({
      'cn-live.info': credentialFile({ accessToken: 'cn-live', uid: 'cn-user', domain: 'copilot.tencent.com', expiresAt: Date.now() + 5_000_000 }),
      'cn-old.info': credentialFile({ accessToken: 'cn-old', uid: 'cn-user', domain: 'copilot.tencent.com', expiresAt: Date.now() + 1_000_000 }),
      'intl-live.info': credentialFile({ accessToken: 'intl-live', uid: 'intl-user', domain: 'www.workbuddy.ai', expiresAt: Date.now() + 4_000_000 }),
    })
    const store = createWorkBuddyStore(dir)
    const accounts = await store.list()
    expect(accounts).toHaveLength(2)
    expect(accounts.map(workBuddyAccountId)).toEqual(['cn:cn-user', 'intl:intl-user'])
    expect((await store.read({ accountId: 'intl:intl-user' }))?.accessToken).toBe('intl-live')
    expect(await store.read({ accountId: 'intl:missing' })).toBeNull()
  })
})

describe('WorkBuddy managed credential store', () => {
  it('adds, replaces, and deletes credentials through the encrypted backend contract', async () => {
    let value: any = null
    const backend = {
      load: async () => value === null ? null : structuredClone(value),
      save: async (next: any) => { value = structuredClone(next) },
      clear: async () => { value = null },
    }
    const managed = new ManagedCredentialStore(path.join(os.tmpdir(), `wb-managed-${Date.now()}.json`), backend)
    const first = parseCredentialFile(credentialFile({ uid: 'managed-user', accessToken: 'first' }), '/tmp/a.info', 1)
    first.source = 'managed'
    first.sourceFile = ''
    await managed.add(first)
    expect((await managed.list())[0]?.accessToken).toBe('first')
    await managed.add({ ...first, accessToken: 'second' })
    expect(await managed.list()).toHaveLength(1)
    expect((await managed.list())[0]?.accessToken).toBe('second')
    expect(await managed.delete('cn:managed-user')).toBe(true)
    expect(await managed.list()).toEqual([])
  })

  it('keys a login-only credential and the IDE file for one account to the same id', async () => {
    // The reported defect: browser login returns a display name with no uid,
    // while the IDE's own file for the same account carries the uuid. Keying
    // the login on the name produced a second account row for one account.
    const uuid = 'd5721ab0-4d3a-42b4-ade1-f80f7381e2ca'
    const dir = await makeAuthDir({
      'workbuddy-desktop.info': {
        account: { uid: uuid, nickname: '快跑', uin: '330101607075' },
        auth: { accessToken: 'file-token', domain: 'copilot.tencent.com', expiresAt: Date.now() + 3_600_000 },
      },
    })
    let value: any = null
    const backend = {
      load: async () => value === null ? null : structuredClone(value),
      save: async (next: any) => { value = structuredClone(next) },
      clear: async () => { value = null },
    }
    const managed = new ManagedCredentialStore(path.join(os.tmpdir(), `wb-dedupe-${Date.now()}.json`), backend)
    // Exactly what the login path hands over: a token whose claims name the
    // account, and the display name the response did carry.
    await managed.add({
      accessToken: jwtToken({ sub: uuid, preferred_username: '快跑' }),
      refreshToken: 'login-refresh',
      expiresAt: Date.now() + 3_600_000,
      region: 'cn',
      domain: 'copilot.tencent.com',
      backend: 'https://copilot.tencent.com',
      nickname: '快跑',
      sourceFile: '',
      sourceMtimeMs: 0,
      source: 'managed',
    })
    const store = new FileCredentialStore(dir, 60_000, managed)
    const accounts = await store.list()
    // One account, keyed by the uuid both paths agree on.
    expect(accounts).toHaveLength(1)
    expect(accounts.map(workBuddyAccountId)).toEqual([`cn:${uuid}`])
  })

  it('recovers the uid of a managed row stored under a display name', async () => {
    // A row written by the old name-fallback still holds the real uid in its
    // own token, which is what lets the heal re-key it without re-login.
    const uuid = '1fb74d2b-3883-43b2-a3a3-417e04e49531'
    let value: any = {
      version: 1,
      accounts: [{
        accessToken: jwtToken({ sub: uuid, preferred_username: 'cchen2422@gmail.com' }),
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3_600_000,
        region: 'intl',
        domain: 'www.workbuddy.ai',
        backend: 'https://www.workbuddy.ai',
        uid: 'cchen2422@gmail.com',
        nickname: 'cchen2422@gmail.com',
        sourceFile: '',
        sourceMtimeMs: 0,
        source: 'managed',
      }],
    }
    const backend = {
      load: async () => structuredClone(value),
      save: async (next: any) => { value = structuredClone(next) },
      clear: async () => { value = null },
    }
    const managed = new ManagedCredentialStore(path.join(os.tmpdir(), `wb-heal-${Date.now()}.json`), backend)
    const healed = (await managed.list())[0]!
    expect(healed.uid).toBe(uuid)
    expect(healed.nickname).toBe('cchen2422@gmail.com')
    expect(workBuddyAccountId(healed)).toBe(`intl:${uuid}`)
  })

  it('reuses a cached managed account instead of statting an empty source path', async () => {
    let value: any = null
    const backend = {
      load: async () => value === null ? null : structuredClone(value),
      save: async (next: any) => { value = structuredClone(next) },
      clear: async () => { value = null },
    }
    const managed = new ManagedCredentialStore(path.join(os.tmpdir(), `wb-cache-${Date.now()}.json`), backend)
    const credential = parseCredentialFile(credentialFile({ uid: 'cache-user' }), '/tmp/a.info', 1)
    await managed.add({ ...credential, source: 'managed', sourceFile: '' })
    const store = new FileCredentialStore(await makeAuthDir({}), 60_000, managed)
    const first = await store.read({ accountId: 'cn:cache-user' })
    await managed.delete('cn:cache-user')
    const cached = await store.read({ accountId: 'cn:cache-user' })
    expect(first?.uid).toBe('cache-user')
    expect(cached?.uid).toBe('cache-user')
  })
})

describe('WorkBuddy credential refresh bookkeeping', () => {
  it('refreshes once and writes the token back to the IDE file', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': credentialFile({ expiresAt: Date.now() - 1000 }) })
    const store = createWorkBuddyStore(dir)
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
    // The replacement temporary holds the same tokens, so it must be gone.
    expect((await fs.readdir(dir)).filter((name) => name.includes('.tmp.'))).toEqual([])
  })
  it('keeps the credential file private when a refresh is written back', async () => {
    if (process.platform === 'win32') return
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': credentialFile({ expiresAt: Date.now() - 1000 }) })
    const file = path.join(dir, 'workbuddy-desktop.info')
    await fs.chmod(file, 0o600)
    const store = createWorkBuddyStore(dir)
    const stale = (await store.read())!
    await store.ensureFresh(stale, async (current) => ({
      ...current,
      accessToken: 'refreshed',
      expiresAt: Date.now() + 3_600_000,
    }))
    // The replacement is renamed over the IDE's own file, so it must carry the
    // original mode rather than the process umask.
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  it('shares one refresh between concurrent callers', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': credentialFile({ expiresAt: Date.now() - 1000 }) })
    const store = createWorkBuddyStore(dir)
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
    const store = createWorkBuddyStore(dir)
    const current = (await store.read())!
    let calls = 0
    await store.ensureFresh(current, async (c) => { calls += 1; return c })
    expect(calls).toBe(0)
  })

  it('survives an unwritable credential file', async () => {
    const dir = await makeAuthDir({ 'workbuddy-desktop.info': credentialFile() })
    const store = createWorkBuddyStore(dir)
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
    expect(settings.selectedAccountId).toBeNull()
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

    // `null` is the restore-default patch: it deletes the key on disk rather
    // than storing a null the card would have to special-case.
    const restored = await store.updateSettings({ contextWindowOverrides: { 'glm-5.3': null, 'kimi-k3': 400_000 } })
    expect(restored.contextWindowOverrides).toEqual({ 'kimi-k3': 400_000 })
    expect((await store.read()).contextWindowOverrides).toEqual({ 'kimi-k3': 400_000 })
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
    // A model the gateway describes with only `{ effort }` accepts the standard
    // three, not every level this route can name: shipping the wide set put
    // `minimal`/`xhigh` in DSH's picker on models that have neither.
    expect(resolveWorkBuddyModel('deepseek-v4.1-flash').reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(resolveWorkBuddyModel('deepseek-v4.1-flash').defaultReasoningEffort).toBe('high')
    expect(resolveWorkBuddyModel('glm-5.3').supportsImage).toBe(true)
    expect(resolveWorkBuddyModel('kimi-k2-thinking').supportsImage).toBe(false)
  })

  it('resolves every model default onto a level its own ladder exposes', () => {
    // The transcribed table keeps the gateway's own `effort` value verbatim
    // (`medium` for a dozen entries that expose only low/high/max), and the
    // gateway itself routes such a value onto the nearest rung. Resolution is
    // the choke point that guarantees what reaches a request is a real level:
    // a default outside the ladder would otherwise be dropped, leaving the
    // request with no `reasoning_effort` and the model with empty reasoning.
    const violations = FALLBACK_MODELS
      .map((model) => resolveWorkBuddyModel(model.id))
      .filter((model) => model.defaultReasoningEffort !== null
        && !model.reasoningEfforts.includes(model.defaultReasoningEffort))
    expect(violations).toEqual([])
    // The transcribed value is what the gateway declared; convergence is what
    // turns it into a level the request can carry.
    expect(FALLBACK_MODELS.find((m) => m.id === 'minimax-m3')!.defaultReasoningEffort).toBe('medium')
    expect(resolveWorkBuddyModel('minimax-m3').defaultReasoningEffort).toBe('high')
  })

  it('filters the catalog by region, since a wrong-region call is a 400', () => {
    const cn = modelsForRegion('cn').map((m) => m.id)
    const intl = modelsForRegion('intl').map((m) => m.id)
    expect(intl).toContain('gemini-3.5-flash')
    expect(cn).not.toContain('gemini-3.5-flash')
    // intl started serving GLM-5.3-Flash alongside cn; asking a region for a
    // model it dropped is the 400 `code 11102` this filter exists to avoid.
    expect(intl).toContain('glm-5.3-flash')
    expect(cn).toContain('glm-5.3-flash')
    expect(intl).toContain('kimi-k3')
    expect(cn).toContain('kimi-k3-1')
  })

  it('reconciles a model the two regions serve with different figures', () => {
    // One entry has to cover both regions, so where the live `/v3/config` reads
    // disagree the smaller served default and the smaller output cap win: this
    // route sends no explicit context length, and over-declaring either figure
    // is a request the gateway rejects, while under-declaring only compresses a
    // conversation earlier than needed and stays overridable per model.
    const flash = resolveWorkBuddyModel('glm-5.3-flash')
    expect(flash.contextWindow).toBe(300000)
    expect(flash.maxContextWindow).toBe(1000000)
    expect(flash.maxTokens).toBe(32000)
    expect(resolveWorkBuddyModel('glm-5.3').maxTokens).toBe(48000)
    expect(resolveWorkBuddyModel('glm-5.2').maxTokens).toBe(48000)
    expect(resolveWorkBuddyModel('kimi-k2.8-preview').maxTokens).toBe(32000)
  })

  it('groups the picker by vendor, since the gateway interleaves them', () => {
    // Measured on the international backend, `/v3/config` lists a DeepSeek row,
    // then GPT-6-Astra, then two Hunyuan rows, then Kimi, then three more GPT
    // rows — so the six OpenAI models never appear together in catalog order.
    const vendors = modelsForRegion('intl').map((m) => workBuddyModelVendor(m.id))
    // Every family is contiguous: seeing one vendor again after another means
    // the list went back to interleaving.
    const firstSeen = vendors.filter((vendor, index) => vendors.indexOf(vendor) === index)
    expect(new Set(firstSeen).size).toBe(firstSeen.length)
    expect(firstSeen.length).toBeGreaterThan(3)
    // Hunyuan reaches this line under two spellings; they are one vendor.
    expect(workBuddyModelVendor('hy3')).toBe(workBuddyModelVendor('hy4-preview-f'))
    expect(workBuddyModelVendor('hunyuan-chat')).toBe(workBuddyModelVendor('hy4-preview'))
    expect(workBuddyModelVendor('hy4-preview')).toBe(workBuddyModelVendor('hy3'))
    // An id no rule claims is its own family, not swept into a shared bucket.
    expect(workBuddyModelVendor('some-future-model')).toBe('some-future-model')
    // Within a family the newest generation leads. Catalog order alone put the
    // appended unlisted models at the bottom of their own group: gpt-6-sol
    // rendered below gpt-5.4.
    const openai = modelsForRegion('intl')
      .filter((m) => workBuddyModelVendor(m.id) === 'openai')
      .map((m) => m.id)
    expect(openai.indexOf('gpt-6-sol')).toBeLessThan(openai.indexOf('gpt-5.6-sol'))
    expect(openai.indexOf('gpt-5.6-sol')).toBeLessThan(openai.indexOf('gpt-5.4'))
    // Versions compare as numbers, so 6.0 is not read as newer than 6.6.
    expect(groupWorkBuddyModelsByVendor([{ id: 'gpt-6.6' }, { id: 'gpt-6.10' }]).map((m) => m.id))
      .toEqual(['gpt-6.10', 'gpt-6.6'])
    // An id with no readable version stays put rather than being guessed at.
    expect(groupWorkBuddyModelsByVendor([{ id: 'primary-model' }, { id: 'deep-model' }]).map((m) => m.id))
      .toEqual(['primary-model', 'deep-model'])
    // Ties keep catalog order, so the sg sibling still follows its base model.
    const deepseek = modelsForRegion('intl')
      .filter((m) => workBuddyModelVendor(m.id) === 'deepseek')
      .map((m) => m.id)
    expect(deepseek.indexOf('deepseek-v4.1-flash')).toBeLessThan(deepseek.indexOf('deepseek-v4.1-flash-sg'))
  })

  it('offers the models the gateway serves but never publishes', () => {
    // Measured on the international backend: these answer a normal streaming
    // completion with 200 while being absent from `/v3/config`. They have to be
    // in the shipped table, because that is what a first run before sign-in,
    // and any gateway failure, falls back to.
    const intl = modelsForRegion('intl').map((m) => m.id)
    const cn = modelsForRegion('cn').map((m) => m.id)
    for (const id of ['gpt-6-sol', 'gpt-6-luna', 'gemini-3.8-flash']) {
      expect(intl).toContain(id)
      expect(cn).not.toContain(id)
    }
    // The reasoning ladder was measured, not read off the name: gpt-6-sol takes
    // exactly the levels gpt-6-astra publishes and refuses `minimal`.
    expect(resolveWorkBuddyModel('gpt-6-sol').reasoningEfforts)
      .toEqual(resolveWorkBuddyModel('gpt-6-astra').reasoningEfforts)
    expect(resolveWorkBuddyModel('gpt-6-luna').reasoningEfforts).not.toContain('minimal')
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
