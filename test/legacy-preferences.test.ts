import fsp from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { afterAll, describe, expect, it } from 'vitest'
import { FilePreferencesStore } from '../src/host/common/file-preferences.ts'
import { readLegacyPreferences } from '../src/host/common/legacy-preferences.ts'

const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-legacy-preferences-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

/** One settings document with the plugin's section between two of another plugin's. */
function document(body: string): string {
  return `ui-theme:\n  dark: true\ndsh-chatgpt-subscription:\n${body}\nother-plugin:\n  keep: 1\n`
}

describe('legacy preference import', () => {
  it('reads the section earlier releases wrote into settings.yaml', async () => {
    const file = path.join(home, 'settings.yaml')
    await fsp.writeFile(file, document([
      '  contextWindowOverrides:',
      '    gpt-6-astra: 500000',
      '    gpt-5.6-luna: 272000',
      '  quickQuotaVisible: true',
      '  fastMode: false',
      '  searchProvider: codex',
      '  proxyMode: custom',
      '  visibleModelIds:',
      '    - gpt-6-astra',
      '    - gpt-5.6-sol',
      '  customProxyUrl: "https://user:pa#ss@proxy.example:8080"   # lives in the value',
      "  reasoningSummary: 'auto'",
      '  enabled: true',
    ].join('\n')), 'utf8')

    expect(await readLegacyPreferences(home)).toEqual({
      contextWindowOverrides: { 'gpt-6-astra': 500000, 'gpt-5.6-luna': 272000 },
      quickQuotaVisible: true,
      fastMode: false,
      searchProvider: 'codex',
      proxyMode: 'custom',
      visibleModelIds: ['gpt-6-astra', 'gpt-5.6-sol'],
      customProxyUrl: 'https://user:pa#ss@proxy.example:8080',
      reasoningSummary: 'auto',
      enabled: true,
    })
  })

  it('reads the renamed document a migrating harness left behind', async () => {
    const migrated = mkdtempSync(path.join(home, 'migrated-'))
    await fsp.writeFile(
      path.join(migrated, 'settings.yaml.imported'),
      document('  fastMode: true\n  outputVerbosity: high\n  proxyMode: direct\n'),
      'utf8',
    )
    expect(await readLegacyPreferences(migrated)).toEqual({
      fastMode: true,
      outputVerbosity: 'high',
      proxyMode: 'direct',
    })
  })

  it('reads inline lists, quoted scalars, and nulls', async () => {
    const inline = mkdtempSync(path.join(home, 'inline-'))
    await fsp.writeFile(
      path.join(inline, 'settings.yaml'),
      document("  visibleModelIds: [gpt-6-astra, 'gpt-5.6-sol']\n  reasoningSummary: null\n  customProxyUrl: ~\n"),
      'utf8',
    )
    expect(await readLegacyPreferences(inline)).toEqual({
      visibleModelIds: ['gpt-6-astra', 'gpt-5.6-sol'],
      reasoningSummary: null,
      customProxyUrl: null,
    })
  })

  it('imports nothing from an empty section or a document without one', async () => {
    const empty = mkdtempSync(path.join(home, 'empty-'))
    await fsp.writeFile(path.join(empty, 'settings.yaml'), document('  # only a comment\n'), 'utf8')
    expect(await readLegacyPreferences(empty)).toBeUndefined()

    const absent = mkdtempSync(path.join(home, 'absent-'))
    expect(await readLegacyPreferences(absent)).toBeUndefined()
  })

  it('stops a sequence entry that is a mapping rather than a value', async () => {
    const nested = mkdtempSync(path.join(home, 'nested-'))
    await fsp.writeFile(
      path.join(nested, 'settings.yaml'),
      document('  visibleModelIds:\n    - id: gpt-6-astra\n  fastMode: true\n'),
      'utf8',
    )
    expect(await readLegacyPreferences(nested)).toEqual({ fastMode: true })
  })
})

describe('seeding the plugin document from the legacy section', () => {
  const schema = z.object({
    fastMode: z.boolean().default(false),
    retries: z.number().min(0).max(3).default(1),
  })

  type Settings = { fastMode: boolean; retries: number }

  it('seeds a missing document and keeps the import for the next start', async () => {
    const file = path.join(home, 'seeded.json')
    const first = new FilePreferencesStore<Settings>(schema, file, async () => ({ fastMode: true }))
    await first.hydrate()
    expect(first.get()).toEqual({ fastMode: true, retries: 1 })
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual({ fastMode: true, retries: 1 })

    let consulted = 0
    const second = new FilePreferencesStore<Settings>(schema, file, async () => {
      consulted += 1
      return { fastMode: false }
    })
    await second.hydrate()
    expect(second.get()).toEqual({ fastMode: true, retries: 1 })
    expect(consulted).toBe(0)
  })

  it('seeds a document that only carries defaults', async () => {
    const file = path.join(home, 'defaults.json')
    await fsp.writeFile(file, JSON.stringify({ fastMode: false, retries: 1 }), 'utf8')
    const store = new FilePreferencesStore<Settings>(schema, file, async () => ({ retries: 2 }))
    await store.hydrate()
    expect(store.get()).toEqual({ fastMode: false, retries: 2 })
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual({ fastMode: false, retries: 2 })
  })

  it('never overrides a document that already carries values', async () => {
    const file = path.join(home, 'kept.json')
    await fsp.writeFile(file, JSON.stringify({ fastMode: true, retries: 3 }), 'utf8')
    let consulted = 0
    const store = new FilePreferencesStore<Settings>(schema, file, async () => {
      consulted += 1
      return { fastMode: false, retries: 0 }
    })
    await store.hydrate()
    expect(store.get()).toEqual({ fastMode: true, retries: 3 })
    expect(consulted).toBe(0)
  })

  it('ignores a legacy value the schema rejects', async () => {
    const file = path.join(home, 'rejected.json')
    const store = new FilePreferencesStore<Settings>(schema, file, async () => ({ retries: 9 }))
    await store.hydrate()
    expect(store.get()).toEqual({ fastMode: false, retries: 1 })
    await expect(fsp.readFile(file, 'utf8')).rejects.toThrow()
  })

  it('tells a watcher about the imported values', async () => {
    const file = path.join(home, 'watched.json')
    const store = new FilePreferencesStore<Settings>(schema, file, async () => ({ fastMode: true }))
    const seen: boolean[] = []
    store.watch((next) => { seen.push(next.fastMode) })
    await store.hydrate()
    expect(seen).toEqual([true])
  })
})
