/**
 * Which media tools the plugin actually registers.
 *
 * The two MiniMax tools are the expensive half of this plugin's tool list, and
 * they are only useful to a deployment that serves the MiniMax Code route. The
 * gate is read once, during load, from the line's own settings — so what these
 * tests pin is the decision, not a hypothetical about reloading: a disabled
 * line must not put its schemas on every request.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type z from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import * as platformStore from '../src/host/platform-token-store.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { MINIMAX_CODE_PREFERENCES_NAMESPACE } from '../src/host/minimax-code/token-store.ts'
import { PREFERENCES_NAMESPACE } from '../src/shared/preferences.ts'

type SettingsValue = Record<string, unknown>

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * Mount the whole plugin against a fake host.
 *
 * @param minimaxSettings - the persisted document the MiniMax settings scope
 *   answers with, so a test can start the plugin with the line already off.
 * @returns every tool name the plugin registered, in registration order.
 */
function mountPlugin(minimaxSettings: SettingsValue): string[] {
  const registeredTools: string[] = []
  const adapters = new Map<string, LlmAdapter>()
  const services: Record<string, unknown> = {}
  const ctx = {
    effect: (setup: () => () => void) => { disposers.push(setup()) },
    inject: (_deps: string[], setup: (scope: Context) => void): void => setup(ctx as unknown as Context),
    get: (name: string) => services[name],
    on: () => () => undefined,
    settings: {
      register(namespace: string, schema: z<SettingsValue>) {
        const value = schema(namespace === PREFERENCES_NAMESPACE
          ? { proxyMode: 'direct' }
          : namespace === MINIMAX_CODE_PREFERENCES_NAMESPACE
            ? minimaxSettings
            : {})
        return {
          get: () => value,
          update: async () => value,
          watch: () => () => undefined,
        }
      },
    },
    llm: {
      registerAdapter(providers: string[], adapter: LlmAdapter) {
        for (const provider of providers) adapters.set(provider, adapter)
        return () => { for (const provider of providers) adapters.delete(provider) }
      },
    },
    webServer: { host: '127.0.0.1', port: 3000, register: () => () => undefined },
    tools: {
      register(tool: { name: string }) {
        registeredTools.push(tool.name)
        return () => undefined
      },
    },
    web: { registerSearchProvider: () => () => undefined, registerFetchProvider: () => () => undefined },
    attachments: {},
    loader: { entries: () => [] },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  Object.assign(services, {
    llm: ctx.llm,
    webServer: ctx.webServer,
    tools: ctx.tools,
    attachments: ctx.attachments,
    loader: ctx.loader,
    settings: { installSection: () => undefined },
  })

  const codexStore = new MemoryTokenStore()
  void codexStore.save({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 })
  vi.spyOn(platformStore, 'createPlatformTokenStore').mockReturnValue(codexStore)

  apply(ctx as unknown as Context)
  expect(adapters.size).toBeGreaterThan(0)
  return registeredTools
}

describe('MiniMax media tools follow the line switch', () => {
  it('registers both video tools while the line is enabled', () => {
    const tools = mountPlugin({ enabled: true })
    expect(tools).toContain('minimax_generate_video')
    expect(tools).toContain('minimax_understand_video')
    // The other always-on tools are independent of this switch. `progress_update`
    // is NOT among them any more: it moved to its own component row
    // (`entry-progress-updates.ts`), so this row must not claim it.
    expect(tools).not.toContain('progress_update')
    expect(tools).toContain('codex_image_generate')
  })

  it('registers neither when the line is switched off, and keeps the rest', () => {
    const tools = mountPlugin({ enabled: false })
    expect(tools).not.toContain('minimax_generate_video')
    expect(tools).not.toContain('minimax_understand_video')
    // A disabled line must cost nothing, but it must not take the rest with it:
    // The server-side image routes serve every deployment.
    expect(tools).not.toContain('progress_update')
    expect(tools).toContain('codex_image_generate')
    expect(tools).toContain('antigravity_image_generate')
    expect(tools).toContain('kimi_attach_video')
  })

  it('treats a document with no explicit switch as enabled', () => {
    const tools = mountPlugin({})
    expect(tools).toContain('minimax_generate_video')
    expect(tools).toContain('minimax_understand_video')
  })
})
