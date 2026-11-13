/**
 * "Nothing synced" vs "nothing selected" - two empty states that used to collapse
 * into one, with a dead end behind it.
 *
 * The card shows the model checklist only when the status carries models. The
 * status used to carry the FILTERED list, so a user who had cleared every model
 * (`enabledModelIds: []`) got `models: []` back, the checklist disappeared, and
 * the empty message claimed the list had never been synced - with no control left
 * to select anything again.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readStatus } from '../src/host/antigravity-acp/routes.ts'
import { AntigravityAcpSettingsStore } from '../src/host/antigravity-acp/settings.ts'

const MODELS = [
  { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low'] },
]

function harness(enabledModelIds: string[] | null) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-status-test-'))
  const settings = new AntigravityAcpSettingsStore(join(dir, 'settings.json'))
  const options = {
    settings,
    catalog: {
      rehydrate: async () => ({ models: MODELS, fromSnapshot: false, fetchedAt: Date.now() }),
      read: async () => undefined,
      invalidate: () => undefined,
    },
    resolveBinary: async () => ({ binary: { path: '/usr/local/bin/agy', kind: 'local-cli' as const, version: '1.5.3' } }),
    login: async () => ({ started: true }),
    auth: async () => ({ authenticated: true }),
    usage: () => undefined,
    conflict: () => null,
  }
  return { options, settings, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('readStatus carries the full catalogue', () => {
  it('still lists every model when the selection is empty', async () => {
    const h = harness([])
    try {
      await h.settings.update({ enabledModelIds: [] })
      const status = await readStatus(h.options as never)
      // The card needs these rows to render the checklist at all.
      expect(status.models.map((model) => model.id)).toEqual(['gemini-4-carbon', 'claude-opus-5-5'])
      expect(status.enabledModelIds).toEqual([])
      // ...and it is synced, so the empty-selection message - not the
      // "never synced" message - is the honest one.
      expect(status.catalogSynced).toBe(true)
    } finally {
      h.dispose()
    }
  })

  it('reports an unfiltered selection as null', async () => {
    const h = harness(null)
    try {
      const status = await readStatus(h.options as never)
      expect(status.models).toHaveLength(2)
      expect(status.enabledModelIds).toBeNull()
    } finally {
      h.dispose()
    }
  })
})
