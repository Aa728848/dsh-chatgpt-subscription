/**
 * The settings document: a tri-state model selection, a permission policy that
 * must never default to "allow", and an atomic write.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AntigravityAcpSettingsStore,
  defaultAntigravityAcpSettings,
  parseAntigravityAcpSettings,
  SETTINGS_VERSION,
} from '../src/host/antigravity-acp/settings.ts'

function storeInTemp(): { store: AntigravityAcpSettingsStore; file: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-settings-test-'))
  const file = join(dir, 'settings.json')
  return { store: new AntigravityAcpSettingsStore(file), file, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('parseAntigravityAcpSettings', () => {
  it('keeps the three model-selection states apart', () => {
    expect(parseAntigravityAcpSettings({ enabledModelIds: null }).enabledModelIds).toBeNull()
    expect(parseAntigravityAcpSettings({ enabledModelIds: [] }).enabledModelIds).toEqual([])
    expect(parseAntigravityAcpSettings({ enabledModelIds: ['a'] }).enabledModelIds).toEqual(['a'])
  })

  it('never turns a corrupt permission policy into allow', () => {
    expect(parseAntigravityAcpSettings({ permissionPolicy: 'yes please' }).permissionPolicy).toBe('reject')
    expect(parseAntigravityAcpSettings({ permissionPolicy: 42 }).permissionPolicy).toBe('reject')
    expect(parseAntigravityAcpSettings({ permissionPolicy: 'allow' }).permissionPolicy).toBe('allow')
  })

  it('falls back to the defaults for a payload that is not an object', () => {
    expect(parseAntigravityAcpSettings(null)).toEqual(defaultAntigravityAcpSettings())
    expect(parseAntigravityAcpSettings([])).toEqual(defaultAntigravityAcpSettings())
  })
})

describe('AntigravityAcpSettingsStore', () => {
  it('round-trips through its own writer', async () => {
    const { store, dispose } = storeInTemp()
    try {
      await store.update({ enabledModelIds: [], permissionPolicy: 'allow', binaryPath: 'C:/agy.exe' })
      const reread = new AntigravityAcpSettingsStore((store as unknown as { filePath: string }).filePath)
      const loaded = await reread.read()
      expect(loaded.enabledModelIds).toEqual([])
      expect(loaded.permissionPolicy).toBe('allow')
      expect(loaded.binaryPath).toBe('C:/agy.exe')
    } finally {
      dispose()
    }
  })

  it('writes the schema version beside the settings', async () => {
    const { store, file, dispose } = storeInTemp()
    try {
      await store.update({ defaultReasoningEffort: 'high' })
      const written = JSON.parse(readFileSync(file, 'utf8')) as { version?: number }
      expect(written.version).toBe(SETTINGS_VERSION)
    } finally {
      dispose()
    }
  })

  it('treats an unreadable file as "no settings yet" rather than failing the host', async () => {
    const { file, dispose } = storeInTemp()
    try {
      writeFileSync(file, 'not json', 'utf8')
      const store = new AntigravityAcpSettingsStore(file)
      await expect(store.read()).resolves.toEqual(defaultAntigravityAcpSettings())
    } finally {
      dispose()
    }
  })
})
