import { ClinePassEngine } from '../src/host/cline-pass/engine.ts'
import type { ClinePassAccountPool } from '../src/host/cline-pass/account-pool.ts'
import type { ClinePassStore } from '../src/host/cline-pass/store.ts'
import type { ClinePassModelSettingsStore } from '../src/host/cline-pass/token-store.ts'
import { defaultPin } from '../src/host/cline-pass/types.ts'

/**
 * A real engine over an in-memory pool and store, with the network seam a
 * double. The settings routes never reach the network on a status read, so a
 * test that only reads status can use this without defining any response.
 */
export function createClinePassEngine(options: {
  pool: ClinePassAccountPool
  store: ClinePassStore
  settings: ClinePassModelSettingsStore
}): ClinePassEngine {
  return new ClinePassEngine({
    fetchFn: (async () => new Response('{}')) as typeof fetch,
    accountPool: options.pool,
    store: options.store,
    pinFor: (model) => ({
      ...(options.settings.status().pins[model] ?? defaultPin()),
      spelling: options.settings.status().pinSpelling,
    }),
    baseURL: () => options.settings.status().baseURL,
  })
}
