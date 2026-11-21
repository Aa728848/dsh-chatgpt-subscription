import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CLAUDE_API_DEFAULT_BASE_URL,
  normalizeClaudeApiBaseUrl,
} from '../src/shared/claude-api-contracts.ts'
import {
  CLAUDE_API_DEFAULT_CLI_VERSION,
  claudeApiBillingBlock,
  claudeApiFingerprint,
} from '../src/host/claude-api/types.ts'
import {
  ClaudeApiSettingsStore,
  claudeApiCredentialFingerprint,
  defaultClaudeApiSettings,
  mergeClaudeApiSettings,
  parseClaudeApiSettings,
  type ClaudeApiSettingsPatch,
} from '../src/host/claude-api/token-store.ts'
import {
  CLAUDE_API_MODELS,
  claudeApiFallbackEntries,
  convergeClaudeApiSelection,
  parseClaudeApiModelListing,
  parsePersistedClaudeApiModelEntries,
  persistedClaudeApiModelRecord,
} from '../src/host/claude-api/model-catalog.ts'
import {
  catalogSnapshotName,
  catalogSnapshotPath,
  flushCatalogSnapshots,
  readCatalogSnapshot,
  writeCatalogSnapshot,
} from '../src/host/common/catalog-snapshot.ts'
import {
  ClaudeApiClientVersionResolver,
  parseClaudeApiClientVersion,
  serializeClaudeApiClientVersion,
} from '../src/host/claude-api/client-version.ts'

let home = ''
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-api-core-'))
  vi.stubEnv('DSH_HOME', home)
})
afterEach(async () => {
  await flushCatalogSnapshots()
  vi.unstubAllEnvs()
  await fs.rm(home, { recursive: true, force: true })
})

describe('normalizeClaudeApiBaseUrl', () => {
  it.each([
    ['https://api.anthropic.com', 'https://api.anthropic.com'],
    ['https://api.anthropic.com/', 'https://api.anthropic.com'],
    ['https://api.anthropic.com/v1', 'https://api.anthropic.com'],
    ['https://api.anthropic.com/v1/', 'https://api.anthropic.com'],
    ['  https://api.anthropic.com  ', 'https://api.anthropic.com'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['https://gw.example/api/', 'https://gw.example/api'],
    ['https://gw.example/api/v1', 'https://gw.example/api'],
  ])('accepts %s', (input, value) => {
    expect(normalizeClaudeApiBaseUrl(input)).toEqual({ ok: true, value })
  })
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    [null, 'empty'],
    [42, 'empty'],
    ['not a url', 'invalid'],
    ['ftp://gw.example', 'scheme'],
    ['https://user:pass@gw.example', 'credentials'],
    ['https://gw.example/?key=1', 'query'],
    ['https://gw.example/#fragment', 'query'],
  ])('rejects %s as %s', (input, reason) => {
    expect(normalizeClaudeApiBaseUrl(input)).toEqual({ ok: false, reason })
  })
})

describe('ClaudeApiSettings', () => {
  it('ships the documented defaults', () => {
    expect(defaultClaudeApiSettings()).toEqual({
      enabled: true,
      baseUrl: CLAUDE_API_DEFAULT_BASE_URL,
      enabledModelIds: null,
      contextWindowOverrides: {},
      defaultReasoningEffort: null,
      cacheTtl: '5m',
      fastMode: false,
      serverCompaction: true,
      deviceId: '',
    })
  })
  it('keeps unset, empty and explicit selections apart', () => {
    expect(parseClaudeApiSettings({}).enabledModelIds).toBeNull()
    expect(parseClaudeApiSettings({ enabledModelIds: [] }).enabledModelIds).toEqual([])
    expect(parseClaudeApiSettings({ enabledModelIds: ['a', 'a', ' b '] }).enabledModelIds).toEqual(['a', 'b'])
    const unset = defaultClaudeApiSettings()
    expect(mergeClaudeApiSettings(unset, {}).enabledModelIds).toBeNull()
    expect(mergeClaudeApiSettings(unset, { enabledModelIds: [] }).enabledModelIds).toEqual([])
    expect(mergeClaudeApiSettings({ ...unset, enabledModelIds: [] }, {}).enabledModelIds).toEqual([])
    expect(mergeClaudeApiSettings({ ...unset, enabledModelIds: [] }, { enabledModelIds: ['claude-opus-5-5'] }).enabledModelIds).toEqual(['claude-opus-5-5'])
  })
  it('never lets a patch change the device id', async () => {
    const deviceId = 'a'.repeat(64)
    const current = { ...defaultClaudeApiSettings(), deviceId }
    const hostile = { enabled: false, deviceId: 'b'.repeat(64) } as unknown as ClaudeApiSettingsPatch
    expect(mergeClaudeApiSettings(current, hostile).deviceId).toBe(deviceId)
    const store = new ClaudeApiSettingsStore(path.join(home, 'storages', 'settings.json'))
    await store.write(current)
    await store.update(hostile)
    expect((await store.read()).deviceId).toBe(deviceId)
    expect(await store.ensureDeviceId()).toBe(deviceId)
    const generated = await new ClaudeApiSettingsStore(path.join(home, 'storages', 'fresh.json')).ensureDeviceId()
    expect(generated).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('convergeClaudeApiSelection', () => {
  const fallback = claudeApiFallbackEntries()
  const live = parseClaudeApiModelListing({ data: [{ id: 'gateway-only', display_name: 'Gateway Only' }] })
  it('does not filter the fallback table through a live-catalog whitelist', () => {
    const settings = { enabledModelIds: ['gateway-only'] }
    expect([...convergeClaudeApiSelection(fallback, settings, false)]).toEqual(fallback.map(entry => entry.id))
    expect([...convergeClaudeApiSelection(fallback, settings, true)]).toEqual([])
    expect([...convergeClaudeApiSelection(live, settings, true)]).toEqual(['gateway-only'])
  })
  it('lets an explicit all-off win in both phases, and unset mean everything', () => {
    for (const isLive of [false, true]) {
      expect(convergeClaudeApiSelection(fallback, { enabledModelIds: [] }, isLive).size).toBe(0)
      expect(convergeClaudeApiSelection(live, { enabledModelIds: [] }, isLive).size).toBe(0)
      expect(convergeClaudeApiSelection(fallback, { enabledModelIds: null }, isLive).size).toBe(fallback.length)
    }
  })
})

describe('catalog snapshot codec', () => {
  it('round-trips what the production writer emits', async () => {
    const credentials = { apiKey: 'sk-codec', authenticatedAt: 1 }
    const name = catalogSnapshotName('claude-api', claudeApiCredentialFingerprint(credentials, CLAUDE_API_DEFAULT_BASE_URL))
    const entries = [
      ...claudeApiFallbackEntries(),
      ...parseClaudeApiModelListing({ data: [{ id: 'claude-future-9', display_name: 'Claude Future 9' }] }),
    ]
    await writeCatalogSnapshot(name, entries.map(persistedClaudeApiModelRecord), 4242)
    await flushCatalogSnapshots()
    await expect(fs.access(catalogSnapshotPath(name))).resolves.toBeUndefined()
    const restored = await readCatalogSnapshot(name, parsePersistedClaudeApiModelEntries)
    expect(restored?.fetchedAt).toBe(4242)
    expect(restored?.models).toEqual(entries)
    // A different endpoint is a different scope, so it must not read this file.
    const other = catalogSnapshotName('claude-api', claudeApiCredentialFingerprint(credentials, 'https://gw.example'))
    expect(other).not.toBe(name)
    expect(await readCatalogSnapshot(other, parsePersistedClaudeApiModelEntries)).toBeUndefined()
  })
})

describe('ClaudeApiClientVersionResolver', () => {
  const file = () => path.join(home, 'storages', 'client-version.json')
  function registry(version: unknown, ok = true): typeof fetch {
    return vi.fn(async () => new Response(JSON.stringify({ version }), { status: ok ? 200 : 503 })) as unknown as typeof fetch
  }
  const offline = vi.fn(async () => { throw new Error('registry unreachable') }) as unknown as typeof fetch

  it('uses and persists the fetched value', async () => {
    const resolver = new ClaudeApiClientVersionResolver({ fetchFn: registry('2.2.0'), filePath: file(), env: {}, now: () => 1000 })
    expect(await resolver.refresh({ force: true })).toEqual({ value: '2.2.0', source: 'npm', fetchedAt: 1000, pending: null })
    const written = await fs.readFile(file(), 'utf8')
    expect(written).toBe(serializeClaudeApiClientVersion({ version: '2.2.0', fetchedAt: 1000 }))
    expect(parseClaudeApiClientVersion(JSON.parse(written))).toEqual({ version: '2.2.0', fetchedAt: 1000 })
  })
  it('keeps the persisted value when the registry is unreachable', async () => {
    const persisted = serializeClaudeApiClientVersion({ version: '2.1.9', fetchedAt: 5 })
    await fs.mkdir(path.dirname(file()), { recursive: true })
    await fs.writeFile(file(), persisted, 'utf8')
    const resolver = new ClaudeApiClientVersionResolver({ fetchFn: offline, filePath: file(), env: {} })
    expect(await resolver.refresh({ force: true })).toEqual({ value: '2.1.9', source: 'cached', fetchedAt: 5, pending: null })
    expect(await fs.readFile(file(), 'utf8')).toBe(persisted)
  })
  it('falls back to the shipped default when nothing is persisted', async () => {
    const resolver = new ClaudeApiClientVersionResolver({ fetchFn: offline, filePath: file(), env: {} })
    expect(await resolver.refresh({ force: true })).toEqual({ value: CLAUDE_API_DEFAULT_CLI_VERSION, source: 'default', fetchedAt: null, pending: null })
  })
  it('lets the operator pin win over a fetched value', async () => {
    const resolver = new ClaudeApiClientVersionResolver({
      fetchFn: registry('2.2.0'), filePath: file(), env: { DSH_CLAUDE_API_CLI_VERSION: '2.0.1' },
    })
    await resolver.refresh({ force: true })
    expect(resolver.current()).toEqual({ value: '2.0.1', source: 'env', fetchedAt: null, pending: null })
  })
  it('ignores a malformed payload without overwriting the file', async () => {
    const persisted = serializeClaudeApiClientVersion({ version: '2.1.9', fetchedAt: 5 })
    await fs.mkdir(path.dirname(file()), { recursive: true })
    await fs.writeFile(file(), persisted, 'utf8')
    for (const payload of ['2.2.0-beta.1', 'latest', 220, null]) {
      const resolver = new ClaudeApiClientVersionResolver({ fetchFn: registry(payload), filePath: file(), env: {} })
      expect(await resolver.refresh({ force: true })).toEqual({ value: '2.1.9', source: 'cached', fetchedAt: 5, pending: null })
      expect(await fs.readFile(file(), 'utf8')).toBe(persisted)
    }
    const broken = new ClaudeApiClientVersionResolver({
      fetchFn: vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
      filePath: file(), env: {},
    })
    expect((await broken.refresh({ force: true })).value).toBe('2.1.9')
    expect(await fs.readFile(file(), 'utf8')).toBe(persisted)
  })
  it('adopts a newly fetched version immediately when no activity was recorded', async () => {
    await fs.mkdir(path.dirname(file()), { recursive: true })
    await fs.writeFile(file(), serializeClaudeApiClientVersion({ version: '2.1.9', fetchedAt: 5 }), 'utf8')
    const resolver = new ClaudeApiClientVersionResolver({ fetchFn: registry('2.2.0'), filePath: file(), env: {} })
    expect(await resolver.refresh({ force: true })).toEqual({ value: '2.2.0', source: 'npm', fetchedAt: expect.any(Number), pending: null })
  })
  it('defers a fetched version while the line is active and adopts it after the ttl of inactivity', async () => {
    let clock = 1000
    const fetchFn = registry('2.2.0')
    const resolver = new ClaudeApiClientVersionResolver({ fetchFn, filePath: file(), env: {}, now: () => clock })
    await resolver.refresh({ force: true })
    resolver.noteActivity('5m')
    ;(fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(JSON.stringify({ version: '2.3.0' }), { status: 200 }))
    await resolver.refresh({ force: true })
    clock += 4 * 60_000
    expect(resolver.current()).toEqual({ value: '2.2.0', source: 'npm', fetchedAt: 1000, pending: '2.3.0' })
    expect(resolver.current().value).toBe('2.2.0')
    clock += 60_000
    expect(resolver.current()).toEqual({ value: '2.3.0', source: 'npm', fetchedAt: 1000, pending: null })
  })
  it('holds a pending version for the full hour after 1h activity, even when later requests use 5m', async () => {
    let clock = 0
    const fetchFn = registry('2.2.0')
    const resolver = new ClaudeApiClientVersionResolver({ fetchFn, filePath: file(), env: {}, now: () => clock })
    await resolver.refresh({ force: true })
    resolver.noteActivity('1h')
    ;(fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(JSON.stringify({ version: '2.3.0' }), { status: 200 }))
    await resolver.refresh({ force: true })
    clock = 30 * 60_000
    resolver.noteActivity('5m')
    expect(resolver.current()).toMatchObject({ value: '2.2.0', pending: '2.3.0' })
    clock = 59 * 60_000
    expect(resolver.current()).toMatchObject({ value: '2.2.0', pending: '2.3.0' })
    clock = 90 * 60_000
    expect(resolver.current()).toMatchObject({ value: '2.3.0', pending: null })
  })
  it('resets the remembered ttl to five minutes when a pending version is adopted', async () => {
    let clock = 0
    const fetchFn = registry('2.2.0')
    const resolver = new ClaudeApiClientVersionResolver({ fetchFn, filePath: file(), env: {}, now: () => clock })
    await resolver.refresh({ force: true })
    resolver.noteActivity('1h')
    ;(fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(JSON.stringify({ version: '2.3.0' }), { status: 200 }))
    await resolver.refresh({ force: true })
    clock = 61 * 60_000
    expect(resolver.current().value).toBe('2.3.0')
    resolver.noteActivity('5m')
    ;(fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(JSON.stringify({ version: '2.4.0' }), { status: 200 }))
    await resolver.refresh({ force: true })
    clock = 65 * 60_000
    expect(resolver.current()).toMatchObject({ value: '2.3.0', pending: '2.4.0' })
    clock = 66 * 60_000
    expect(resolver.current()).toMatchObject({ value: '2.4.0', pending: null })
  })
  it('applies an env pin immediately despite activity and a pending candidate', async () => {
    let clock = 0
    const fetchFn = registry('2.2.0')
    const resolver = new ClaudeApiClientVersionResolver({ fetchFn, filePath: file(), env: { DSH_CLAUDE_API_CLI_VERSION: '2.0.1' }, now: () => clock })
    await resolver.refresh({ force: true })
    resolver.noteActivity('1h')
    ;(fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(JSON.stringify({ version: '2.3.0' }), { status: 200 }))
    await resolver.refresh({ force: true })
    expect(resolver.current()).toEqual({ value: '2.0.1', source: 'env', fetchedAt: null, pending: null })
  })
  it('answers a disk-cached value after warm, before any network', async () => {
    await fs.mkdir(path.dirname(file()), { recursive: true })
    await fs.writeFile(file(), serializeClaudeApiClientVersion({ version: '2.1.9', fetchedAt: 5 }), 'utf8')
    const fetchFn = vi.fn(async () => { throw new Error('must not fetch') }) as unknown as typeof fetch
    const resolver = new ClaudeApiClientVersionResolver({ fetchFn, filePath: file(), env: {} })
    await resolver.warm()
    expect(resolver.current()).toEqual({ value: '2.1.9', source: 'cached', fetchedAt: 5, pending: null })
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it('never rejects a refresh', async () => {
    const resolver = new ClaudeApiClientVersionResolver({ fetchFn: offline, filePath: file(), env: {} })
    await expect(resolver.refresh({ force: true })).resolves.toMatchObject({ source: 'default' })
    await expect(resolver.refresh()).resolves.toMatchObject({ source: 'default' })
    const httpError = new ClaudeApiClientVersionResolver({ fetchFn: registry('2.2.0', false), filePath: file(), env: {} })
    await expect(httpError.refresh({ force: true })).resolves.toMatchObject({ source: 'default' })
  })
})

describe('capture-backed attribution constants', () => {
  it('reproduces the captured fingerprint and billing block', async () => {
    expect(claudeApiFingerprint('Reply with exactly: OK', '2.1.330')).toBe('9e1')
    const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/claude-api/request-2.1.330.json', import.meta.url), 'utf8')) as {
      requests: Array<{ body: { system: Array<{ text: string }> } }>
    }
    const captured = fixture.requests[0]!.body.system[0]!.text.replaceAll('sdk-cli', 'cli')
    expect(claudeApiBillingBlock('2.1.330', 'Reply with exactly: OK')).toBe(captured)
    expect(CLAUDE_API_MODELS.length).toBeGreaterThan(0)
  })
})
