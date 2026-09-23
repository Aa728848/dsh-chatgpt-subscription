import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { registerAntigravityRoutes } from '../src/host/antigravity/routes.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  registerAntigravityPreferenceStore,
  type AntigravityPreferenceStore,
} from '../src/host/antigravity/token-store.ts'

/**
 * A registered route pair over a private credential/settings file, so a test
 * can POST a settings body and read the response the card would receive.
 */
function antigravityRouteHarness(preferences?: AntigravityPreferenceStore): {
  settings: FileModelSettingsStore
  post: (url: string, body: unknown) => Promise<{ status: number; body: Record<string, any> }>
} {
  let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined
  const ctx = {
    emit: vi.fn(),
    webServer: { register(route: { handler: typeof handler }) { handler = route.handler; return () => undefined } },
  } as unknown as Context
  const store = new FileCredentialStore(path.join(os.tmpdir(), `anti-cred-${Math.random()}.json`))
  vi.spyOn(store, 'read').mockResolvedValue(null)
  const settings = new FileModelSettingsStore(path.join(os.tmpdir(), `anti-models-${Math.random()}.json`))
  registerAntigravityRoutes(ctx, store, settings, preferences)

  const post = async (url: string, body: unknown): Promise<{ status: number; body: Record<string, any> }> => {
    const listeners = new Map<string, (data?: unknown) => void>()
    const request = {
      url, method: 'POST',
      on(event: string, listener: (data?: unknown) => void) { listeners.set(event, listener); return this },
      destroy() {},
    } as unknown as IncomingMessage
    const captured: { status: number; body: Record<string, any> } = { status: 0, body: {} }
    const response = {
      writeHead(status: number) { captured.status = status },
      end(raw?: string) { captured.body = raw === undefined ? {} : JSON.parse(raw) },
    } as unknown as ServerResponse
    const done = handler!(request, response)
    listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
    listeners.get('end')?.()
    await done
    return captured
  }

  return { settings, post }
}

describe('Antigravity model settings routes', () => {
  it.each(['/antigravity/api/models', '/antigravity/api/settings'])('invalidates the picker after saving %s', async (url) => {
    const emit = vi.fn()
    let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined
    const ctx = {
      emit,
      webServer: { register(route: { handler: typeof handler }) { handler = route.handler; return () => undefined } },
    } as unknown as Context
    const store = new FileCredentialStore(path.join(os.tmpdir(), `anti-cred-${Math.random()}.json`))
    vi.spyOn(store, 'read').mockResolvedValue(null)
    const settings = new FileModelSettingsStore(path.join(os.tmpdir(), `anti-models-${Math.random()}.json`))
    registerAntigravityRoutes(ctx, store, settings)
    const listeners = new Map<string, (data?: unknown) => void>()
    const request = {
      url, method: 'POST',
      on(event: string, listener: (data?: unknown) => void) { listeners.set(event, listener); return this },
      destroy() {},
    } as unknown as IncomingMessage
    const response = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse
    const done = handler!(request, response)
    listeners.get('data')?.(Buffer.from(JSON.stringify({ enabledModelIds: ['gemini-2.5-pro'] })))
    listeners.get('end')?.()
    await done
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.anything())
    expect(emit).toHaveBeenCalledWith('llm/adapters-updated')
  })
})

describe('Antigravity context window overrides', () => {
  it('clears a stored override when the card posts null', async () => {
    const { settings, post } = antigravityRouteHarness()
    await settings.updateSettings({ contextWindowOverrides: { 'gemini-2.5-pro': 500_000 } })

    const { status, body } = await post('/antigravity/api/models', { contextWindowOverrides: { 'gemini-2.5-pro': null } })

    expect(status).toBe(200)
    expect((await settings.read()).contextWindowOverrides).toEqual({})
    expect(body.value.contextWindowOverrides).toEqual({})
    // Back to the catalog window rather than the deleted override.
    const model = body.value.models.find((entry: { id: string }) => entry.id === 'gemini-2.5-pro')
    expect(model.contextWindow).toBe(model.defaultContextWindow)
  })

  it('writes one override and deletes another in the same patch', async () => {
    const { settings, post } = antigravityRouteHarness()
    await settings.updateSettings({ contextWindowOverrides: { 'gemini-2.5-pro': 500_000, 'claude-sonnet-4-6': 900_000 } })

    const { status, body } = await post('/antigravity/api/settings', {
      contextWindowOverrides: { 'gemini-2.5-pro': null, 'claude-sonnet-4-6': 600_000 },
    })

    expect(status).toBe(200)
    expect((await settings.read()).contextWindowOverrides).toEqual({ 'claude-sonnet-4-6': 600_000 })
    expect(body.value.contextWindowOverrides).toEqual({ 'claude-sonnet-4-6': 600_000 })
    const gemini = body.value.models.find((entry: { id: string }) => entry.id === 'gemini-2.5-pro')
    expect(gemini.contextWindow).toBe(gemini.defaultContextWindow)
    expect(body.value.models.find((entry: { id: string }) => entry.id === 'claude-sonnet-4-6').contextWindow).toBe(600_000)
  })

  it('deletes through the settings namespace without persisting a null', async () => {
    // A harness with the register seam stores into the schema-validated
    // namespace, which only accepts numbers.
    let value: Record<string, unknown> = { contextWindowOverrides: { 'gemini-2.5-pro': 500_000 } }
    const fallback = new FileModelSettingsStore(path.join(os.tmpdir(), `anti-models-${Math.random()}.json`))
    const preferences = registerAntigravityPreferenceStore({
      register(_namespace: unknown, schema: (input: unknown) => Record<string, unknown>) {
        value = schema(value)
        return {
          get: () => value,
          update: async (patch: object) => { value = schema({ ...value, ...patch }) },
        }
      },
    }, fallback)
    const { post } = antigravityRouteHarness(preferences)
    expect(preferences.status().contextWindowOverrides).toEqual({ 'gemini-2.5-pro': 500_000 })

    const { status, body } = await post('/antigravity/api/models', {
      contextWindowOverrides: { 'gemini-2.5-pro': null, 'claude-sonnet-4-6': 600_000 },
    })

    expect(status).toBe(200)
    expect(preferences.status().contextWindowOverrides).toEqual({ 'claude-sonnet-4-6': 600_000 })
    expect(body.value.contextWindowOverrides).toEqual({ 'claude-sonnet-4-6': 600_000 })
    // The fallback document is written in the background; it must merge the
    // same way, so the deleted key cannot survive on disk as a null.
    await vi.waitFor(async () => {
      const written = JSON.parse(await fs.readFile(fallback.path(), 'utf8')) as { contextWindowOverrides: unknown }
      expect(written.contextWindowOverrides).toEqual({ 'claude-sonnet-4-6': 600_000 })
    })
  })
})
