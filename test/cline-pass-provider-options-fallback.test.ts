import { describe, expect, it } from 'vitest'
import { ClinePassEngine } from '../src/host/cline-pass/engine.ts'
import type { ClinePassAccountPool } from '../src/host/cline-pass/account-pool.ts'
import { createClinePassStore } from '../src/host/cline-pass/store.ts'
import { defaultPin } from '../src/host/cline-pass/types.ts'
import { injectPrefs, isAuthenticationError, isProviderOptionsRoutingUnsupported } from '../src/host/cline-pass/protocol.ts'

const MODEL = 'cline-pass/deepseek-v4.1-flash-1017'
const REFUSAL = 'Error 403: client-supplied "providerOptions" model routing is not supported'

function engineWith(fetchFn: typeof fetch, store: ReturnType<typeof createClinePassStore>): ClinePassEngine {
  const accountPool = {
    async getEffectiveCredential() {
      return {
        account: { id: 'main', alias: 'Main' },
        credentials: { apiKey: 'sk-test-only' },
      }
    },
  } as unknown as ClinePassAccountPool
  return new ClinePassEngine({
    fetchFn,
    accountPool,
    store,
    pinFor: (model) => defaultPin(model),
    baseURL: () => 'https://api.cline.bot/api/v1',
  })
}

function plannerStore(): ReturnType<typeof createClinePassStore> {
  const store = createClinePassStore()
  store.learn(MODEL, { pipeline: 'planner', upstreams: ['deepseek'], channels: { planner: ['deepseek'], direct: ['deepseek'] } })
  return store
}

function policyThenDirect(fetchBodies: Array<Record<string, unknown>>): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    fetchBodies.push(body)
    if (body.providerOptions !== undefined) {
      return Response.json({ error: { message: REFUSAL } }, { status: 403 })
    }
    return Response.json({ provider: 'DeepSeek', choices: [{ message: { content: 'OK' } }] })
  }) as typeof fetch
}

describe('Cline Pass providerOptions policy recovery', () => {
  it('writes only OpenRouter fields in recovery mode and never calls the refusal authentication', () => {
    const body = injectPrefs({ model: 'm' }, { pipeline: 'planner' }, {
      upstream: 'deepseek', orderRest: [], excludeList: [], strict: true, sort: null,
      has: ['vision'], spelling: 'openrouter',
    })
    expect(body.provider).toEqual({ only: ['deepseek'] })
    expect(body.providerOptions).toBeUndefined()
    expect(isProviderOptionsRoutingUnsupported(REFUSAL)).toBe(true)
    expect(isAuthenticationError(REFUSAL, 403)).toBe(false)
    expect(isAuthenticationError('Error 403: forbidden', 403)).toBe(true)
  })

  it('retries validation with only provider and accepts the direct DeepSeek answer', async () => {
    const calls: Array<Record<string, unknown>> = []
    const outcome = await engineWith(policyThenDirect(calls), plannerStore()).validate(MODEL)

    expect(outcome.summary).toMatchObject({ ok: 1, auth: 0, bad: 0 })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.providerOptions).toBeDefined()
    expect(calls[1]?.providerOptions).toBeUndefined()
    expect(calls[1]?.provider).toEqual({ only: ['deepseek'] })
  })

  it('recovers the normal model test through the same direct request path', async () => {
    const calls: Array<Record<string, unknown>> = []
    const outcome = await engineWith(policyThenDirect(calls), plannerStore()).test(MODEL, {
      upstreams: ['deepseek'],
      has: ['vision'],
    })

    expect(outcome).toMatchObject({ ok: true, actual: 'deepseek', adherence: 'adopted', account: 'Main' })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.providerOptions).toBeUndefined()
    expect(calls[1]?.provider).toEqual({ only: ['deepseek'] })
  })

  it('does not retry or misclassify an ordinary account 403', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      return Response.json({ error: { message: 'Error 403: forbidden' } }, { status: 403 })
    }) as typeof fetch
    const outcome = await engineWith(fetchFn, plannerStore()).validate(MODEL)

    expect(outcome.summary).toMatchObject({ ok: 0, auth: 1 })
    expect(calls).toBe(1)
  })
})
