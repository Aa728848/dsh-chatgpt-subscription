import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { registerAntigravityRoutes } from '../src/host/antigravity/routes.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/antigravity/token-store.ts'

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
