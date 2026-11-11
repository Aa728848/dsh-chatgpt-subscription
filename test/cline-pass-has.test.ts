import { describe, expect, it } from 'vitest'
import { ClinePassEngine } from '../src/host/cline-pass/engine.ts'
import type { ClinePassAccountPool } from '../src/host/cline-pass/account-pool.ts'
import { createClinePassStore } from '../src/host/cline-pass/store.ts'
import { parseClinePassModelSettings } from '../src/host/cline-pass/token-store.ts'

const MODEL = 'cline-pass/deepseek-v4.1-flash-1017'

describe('Cline Pass without client-side upstream pinning', () => {
  it('ignores legacy pin values while retaining their catalog migration clue', () => {
    const parsed = parseClinePassModelSettings({
      enabledModelIds: [],
      pins: { 'gateway/custom-model': { upstreams: ['deepseek'], has: ['vision'] } },
      pinSpelling: 'detected',
      catalogModels: [{ id: 'gateway/custom-model' }, { id: 'gateway/unused-model' }],
    })
    expect('pins' in parsed).toBe(false)
    expect('pinSpelling' in parsed).toBe(false)
    expect(parsed.catalogModels.find((model) => model.id === 'gateway/custom-model')?.origin).toBe('custom')
    expect(parsed.catalogModels.find((model) => model.id === 'gateway/unused-model')?.origin).toBeUndefined()
  })

  it('sends an ordinary model test without provider or providerOptions', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const accountPool = {
      async getEffectiveCredential() {
        return {
          account: { id: 'main', alias: 'Main' },
          credentials: { apiKey: 'sk-test-only' },
        }
      },
    } as unknown as ClinePassAccountPool
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({ provider: 'DeepSeek', choices: [{ message: { content: 'OK' } }] })
    }) as typeof fetch
    const engine = new ClinePassEngine({
      fetchFn,
      accountPool,
      store: createClinePassStore(),
      baseURL: () => 'https://api.cline.bot/api/v1',
    })

    const result = await engine.test(MODEL)
    expect(result).toMatchObject({ ok: true, actual: 'deepseek', account: 'Main' })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toHaveProperty('provider')
    expect(bodies[0]).not.toHaveProperty('providerOptions')
  })
})
