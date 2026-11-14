/**
 * Host routes: the settings surface of this line, and the four states a card can
 * be in (no binary, signed out, synced catalogue, a write that changes nothing).
 */
import { describe, expect, it } from 'vitest'
import { readSettingsUpdate, readStatus, visibleModels } from '../src/host/antigravity-acp/routes.ts'
import { AntigravityAcpSettingsStore, defaultAntigravityAcpSettings } from '../src/host/antigravity-acp/settings.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A route-options object whose pieces are trivial fakes. */
function options(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-routes-test-'))
  const settings = new AntigravityAcpSettingsStore(join(dir, 'settings.json'))
  const base = {
    settings,
    catalog: {
      rehydrate: async () => ({
        models: [{ id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: ['low'] }],
        fromSnapshot: false,
        fetchedAt: 1,
      }),
      read: async () => undefined,
      invalidate: () => undefined,
    },
    resolveBinary: async () => ({ binary: { path: '/usr/local/bin/agy', kind: 'local-cli' as const, version: '1.5.3' } }),
    login: async () => ({ started: true }),
    auth: async () => ({ authenticated: true, tier: { id: 't', name: 'Google AI Ultra' } }),
    usage: () => undefined,
    conflict: () => null,
    ...overrides,
  }
  return { options: base, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('readStatus', () => {
  it('reports the executable, the tier and the catalogue', async () => {
    const harness = options()
    try {
      const status = await readStatus(harness.options as never)
      expect(status.binary).toMatchObject({ kind: 'local-cli', version: '1.5.3' })
      expect(status.auth.authenticated).toBe(true)
      expect(status.models).toHaveLength(1)
      expect(status.catalogSynced).toBe(true)
      expect(status.permissionPolicy).toBe('allow')
    } finally {
      harness.dispose()
    }
  })

  it('states a missing binary with an actionable sentence and claims no sign-in', async () => {
    const harness = options({
      resolveBinary: async () => ({ error: 'no archive for this platform' }),
      auth: async () => {
        throw new Error('should not be asked')
      },
    })
    try {
      const status = await readStatus(harness.options as never)
      expect(status.binary.kind).toBe('missing')
      expect(status.binary.error).toContain('no archive for this platform')
      expect(status.auth.authenticated).toBe(false)
    } finally {
      harness.dispose()
    }
  })

  it('answers a disabled line from settings alone, without resolving or probing anything', async () => {
    // The hub overview and the composer badge poll this route; a line the user
    // switched off must not launch `agy` behind their back just to decorate a card.
    const harness = options({
      resolveBinary: async () => {
        throw new Error('a disabled line must not resolve the executable')
      },
      auth: async () => {
        throw new Error('a disabled line must not probe the sign-in')
      },
    })
    try {
      await harness.options.settings.update({ enabled: false })
      const status = await readStatus(harness.options as never)
      expect(status.enabled).toBe(false)
      expect(status.binary).toEqual({ kind: 'missing' })
      expect(status.auth).toEqual({ authenticated: false })
      expect(status.models).toEqual([])
      expect(status.catalogSynced).toBe(false)
      // The user's own choices are still reported, so the card renders the switch
      // and the selection it will apply once it is switched back on.
      expect(status.permissionPolicy).toBe('allow')
    } finally {
      harness.dispose()
    }
  })

  it('reports the switch as off while the probe is still in flight elsewhere', async () => {
    // The card must never render a disabled line as "signed in, 3 models": the
    // switch is the user's statement about the line, and every other field is a
    // fact about a process that is not running.
    const harness = options()
    try {
      const enabledStatus = await readStatus(harness.options as never)
      expect(enabledStatus.enabled).toBe(true)
      expect(enabledStatus.auth.authenticated).toBe(true)
      await harness.options.settings.update({ enabled: false })
      const disabledStatus = await readStatus(harness.options as never)
      expect(disabledStatus.enabled).toBe(false)
      expect(disabledStatus.auth.authenticated).toBe(false)
      expect(disabledStatus.models).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  it('surfaces a route conflict without hiding the rest of the card', async () => {
    const harness = options({ conflict: () => 'route already owned' })
    try {
      const status = await readStatus(harness.options as never)
      expect(status.routeConflict).toBe('route already owned')
      expect(status.models).toHaveLength(1)
    } finally {
      harness.dispose()
    }
  })
})

describe('readSettingsUpdate', () => {
  it('keeps null and [] apart for the model selection', () => {
    expect(readSettingsUpdate({ enabledModelIds: null })).toEqual({ enabledModelIds: null })
    expect(readSettingsUpdate({ enabledModelIds: [] })).toEqual({ enabledModelIds: [] })
    expect(readSettingsUpdate({ enabledModelIds: ['a'] })).toEqual({ enabledModelIds: ['a'] })
  })

  it('refuses a half-valid body rather than applying the valid half', () => {
    expect(readSettingsUpdate({ enabled: true, permissionPolicy: 'yes' })).toBeUndefined()
    expect(readSettingsUpdate({ enabledModelIds: ['a', 2] })).toBeUndefined()
  })

  it('accepts only the two permission policies', () => {
    expect(readSettingsUpdate({ permissionPolicy: 'reject' })).toEqual({ permissionPolicy: 'reject' })
    expect(readSettingsUpdate({ permissionPolicy: 'allow' })).toEqual({ permissionPolicy: 'allow' })
    expect(readSettingsUpdate({ permissionPolicy: 'always' })).toBeUndefined()
    expect(readSettingsUpdate({ nativeToolPolicy: 'cancel' })).toEqual({ nativeToolPolicy: 'cancel' })
    expect(readSettingsUpdate({ nativeToolPolicy: 'sometimes' })).toBeUndefined()
  })
})

describe('visibleModels', () => {
  const models = [
    { id: 'a', name: 'A', efforts: [] },
    { id: 'b', name: 'B', efforts: [] },
  ]

  it('treats null as no filter and an empty list as none selected', () => {
    expect(visibleModels(models, { ...defaultAntigravityAcpSettings(), enabledModelIds: null })).toHaveLength(2)
    expect(visibleModels(models, { ...defaultAntigravityAcpSettings(), enabledModelIds: [] })).toHaveLength(0)
    expect(visibleModels(models, { ...defaultAntigravityAcpSettings(), enabledModelIds: ['b'] }).map((model) => model.id)).toEqual(['b'])
  })
})
