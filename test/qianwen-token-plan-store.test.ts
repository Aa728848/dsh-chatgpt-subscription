import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CredentialStore } from '../src/host/token-store.ts'
import {
  QianwenCredentialStore,
  QianwenSettingsStore,
  defaultQianwenSettings,
  mergeQianwenSettings,
  parseQianwenSettings,
  type QianwenCredentials,
} from '../src/host/qianwen-token-plan/token-store.ts'
import { getQianwenTokenPlanWebStatus } from '../src/host/qianwen-token-plan/routes.ts'
import { cacheWarmupBudget } from '../src/host/cache-warmup/budget.ts'
import { isWarmupHitReport, recordCacheWarmupUsage, resetCacheWarmupForTests } from '../src/host/cache-warmup/usage.ts'

const temporary: string[] = []
afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    const names = await fs.readdir(directory).catch(() => [] as string[])
    for (const name of names) await fs.unlink(path.join(directory, name)).catch(() => undefined)
    await fs.rmdir(directory).catch(() => undefined)
  }
})
class MemoryBackend implements CredentialStore<QianwenCredentials> {
  value: QianwenCredentials | null = null
  async load(): Promise<QianwenCredentials | null> { return this.value }
  async save(value: QianwenCredentials): Promise<void> { this.value = value }
  async clear(): Promise<void> { this.value = null }
}

describe('Qwen settings persistence', () => {
  it('distinguishes a missing selection from an explicit empty one', () => {
    expect(parseQianwenSettings({}).enabledModelIds).toBeNull()
    expect(parseQianwenSettings({ enabledModelIds: [] }).enabledModelIds).toEqual([])
  })
  it('migrates only the unedited three-model v1 default and preserves explicit choices', () => {
    expect(parseQianwenSettings({ enabledModelIds: ['qwen4-max', 'qwen4-max-preview', 'qwen4.0-max-preview'] }).enabledModelIds).toBeNull()
    expect(parseQianwenSettings({ enabledModelIds: [] }).enabledModelIds).toEqual([])
    expect(parseQianwenSettings({ enabledModelIds: ['qwen4-max'] }).enabledModelIds).toEqual(['qwen4-max'])
    expect(parseQianwenSettings({ selectionVersion: 2, enabledModelIds: ['qwen4-max', 'qwen4-max-preview', 'qwen4.0-max-preview'] }).enabledModelIds).toHaveLength(3)
  })
  it('preserves TTL, exact effort, visual settings and null context override semantics', () => {
    const current = { ...defaultQianwenSettings(), contextWindowOverrides: { 'qwen4-max': 512_000 } }
    const next = mergeQianwenSettings(current, { cacheTtl: '1h', defaultReasoningEffort: 'minimal', imageDetail: 'high', maxPixels: 1_048_576, contextWindowOverrides: { 'qwen4-max': null } })
    expect(next).toMatchObject({ cacheTtl: '1h', defaultReasoningEffort: 'minimal', imageDetail: 'high', maxPixels: 1_048_576, contextWindowOverrides: {} })
  })
  it('round-trips the production writer, including an explicit empty selection', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-settings-')); temporary.push(directory)
    const store = new QianwenSettingsStore(path.join(directory, 'settings.json'))
    await store.updateSettings({ enabledModelIds: [], cacheTtl: '1h', defaultReasoningEffort: 'max' })
    const restarted = new QianwenSettingsStore(path.join(directory, 'settings.json'))
    expect(await restarted.read()).toMatchObject({ enabledModelIds: [], cacheTtl: '1h', defaultReasoningEffort: 'max' })
  })
  it('uses the observed Qwen TTL and never applies Kimi block heuristics', () => {
    resetCacheWarmupForTests()
    try {
      const base = { sessionId: 'qwen-warm', provider: 'qianwen-token-plan', outputTokens: 0, blockAlignedContinuation: false as const }
      recordCacheWarmupUsage({ ...base, inputTokens: 0, cacheReadTokens: 4096, totalTokens: 4096, at: 1000, cacheTtlMs: 300_000 })
      recordCacheWarmupUsage({ ...base, inputTokens: 0, cacheReadTokens: 4096, totalTokens: 4096, at: 2000, cacheTtlMs: 300_000 })
      expect(cacheWarmupBudget('qwen-warm', 3000, undefined, 'qianwen-token-plan').maxChars).toBe(8000)
      expect(cacheWarmupBudget('qwen-warm', 302_001, undefined, 'qianwen-token-plan').maxChars).toBe(1200)
      expect(isWarmupHitReport(
        { ...base, inputTokens: 100, cacheReadTokens: 1900, totalTokens: 2000, at: 3000 },
        { ...base, inputTokens: 100, cacheReadTokens: 1900, totalTokens: 2000, at: 2000 },
      )).toBe(false)
    } finally { resetCacheWarmupForTests() }
  })
  it('persists the migration marker through the production writer', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-settings-')); temporary.push(directory)
    const file = path.join(directory, 'settings.json')
    await fs.writeFile(file, JSON.stringify({ enabledModelIds: ['qwen4-max', 'qwen4-max-preview', 'qwen4.0-max-preview'] }), 'utf8')
    const store = new QianwenSettingsStore(file)
    expect((await store.read()).enabledModelIds).toBeNull()
    const disk = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(disk).toMatchObject({ selectionVersion: 2, enabledModelIds: null })
  })
  it('writes and verifies an encrypted-store credential without leaking it into status', async () => {
    const backend = new MemoryBackend()
    const credentials = new QianwenCredentialStore('/tmp/qwen-test', backend)
    await credentials.write({ apiKey: 'sk-sp-never-public', authenticatedAt: 1 })
    expect((await credentials.read())?.apiKey).toBe('sk-sp-never-public')
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-settings-')); temporary.push(directory)
    const settings = new QianwenSettingsStore(path.join(directory, 'settings.json'))
    const status = await getQianwenTokenPlanWebStatus(credentials, settings)
    expect(status.authenticated).toBe(true)
    expect(JSON.stringify(status)).not.toContain('sk-sp-never-public')
  })
})
