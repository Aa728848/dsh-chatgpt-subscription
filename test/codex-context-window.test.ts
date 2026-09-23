import fsp from 'node:fs/promises'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ROUTE_PREFIX } from '../src/compat.ts'
import { CodexChatGptAdapter, PROVIDER_ID } from '../src/host/adapter.ts'
import { preferencesPath } from '../src/host/common/file-preferences.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { registerPreferenceStore } from '../src/host/preferences.ts'
import { registerRoutes } from '../src/host/routes.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { UsageService } from '../src/host/usage-service.ts'

/**
 * The ChatGPT tab's context window setting driven end to end: the real route,
 * the real plugin-owned preference document, and the real adapter resolution
 * the harness reads.
 *
 * The route test next door stubs the preference store, and the client tests
 * mock the host, so this is the one place that proves a restored default really
 * leaves the document and that a model outside the default-visible six reaches
 * the model DSH resolves.
 */
const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-codex-context-'))

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('context window overrides through the real preference document', () => {
  it('applies an override from the route and clears it back to the catalog value', async () => {
    process.env.DSH_HOME = home
    await fsp.rm(path.join(home, 'storages'), { recursive: true, force: true })
    const store = registerPreferenceStore(undefined)
    await store.hydrate()

    const routes: Array<{ kind: string; path: string; handler: http.RequestListener }> = []
    const oauth = new OAuthService(new MemoryTokenStore(), { logger: { info: () => undefined, warn: () => undefined } })
    const usage = new UsageService(oauth, { fetchFn: async () => Response.json({ plan_type: 'plus' }) })
    const ctx = {
      emit: vi.fn(),
      llm: {
        listProviders: () => [],
        listModels: async () => [],
        resolveModelInfo: async () => ({}),
      },
      webServer: {
        register(route: { kind: string; path: string; handler: http.RequestListener }) {
          routes.push(route)
          return () => undefined
        },
      },
    }
    registerRoutes(ctx as never, oauth, usage, store)
    const server = http.createServer(routes.find((route) => route.kind === 'prefix')!.handler)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    const origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`

    const override = async (contextWindowOverrides: Record<string, number | null>): Promise<number> => {
      const response = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ contextWindowOverrides }),
      })
      return response.status
    }
    const storedOverrides = async (): Promise<unknown> =>
      JSON.parse(await fsp.readFile(preferencesPath(), 'utf8')).contextWindowOverrides
    const adapter = new CodexChatGptAdapter({ stream: () => { throw new Error('unused') } } as never, store)

    try {
      // A model outside the default-visible six starts at its catalog value.
      expect((await adapter.resolveModel(PROVIDER_ID, 'gpt-5.4')).context).toEqual({ contextWindow: 272_000 })

      expect(await override({ 'gpt-5.4': 400_000 })).toBe(200)
      expect((await adapter.resolveModel(PROVIDER_ID, 'gpt-5.4')).context).toEqual({ contextWindow: 400_000 })
      expect(await storedOverrides()).toEqual({ 'gpt-5.4': 400_000 })

      expect(await override({ 'gpt-5.4': null })).toBe(200)
      expect(store.status().contextWindowOverrides).toEqual({})
      expect((await adapter.resolveModel(PROVIDER_ID, 'gpt-5.4')).context).toEqual({ contextWindow: 272_000 })
      // Restoring the default deletes the key instead of storing the catalog value.
      expect(await storedOverrides()).toEqual({})

      expect(await override({ 'gpt-9-unknown': 100_000 })).toBe(400)
      expect(await override({ 'gpt-6-astra': 872_001 })).toBe(400)
    } finally {
      oauth.dispose()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
