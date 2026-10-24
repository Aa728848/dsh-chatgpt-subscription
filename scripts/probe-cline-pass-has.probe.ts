/**
 * Live A/B probe for the Cline gateway's providerOptions.gateway.has filter.
 * Reads the normal pooled account; never prints or persists the credential.
 * Run: npx vitest run --config vitest.probe.config.ts scripts/probe-cline-pass-has.probe.ts
 */
import { test } from 'vitest'
import { ClinePassAccountPool } from '../src/host/cline-pass/account-pool.ts'
import { bearerFor } from '../src/host/cline-pass/token-store.ts'
import { chatCompletion } from '../src/host/cline-pass/client.ts'
import { errorText, parseRouting, unwrapEnvelope } from '../src/host/cline-pass/protocol.ts'

test('cline-pass 1017 only versus only+has', async () => {
  const MODEL = 'cline-pass/deepseek-v4.1-flash-1017'
  const pool = new ClinePassAccountPool()
  const effective = await pool.getEffectiveCredential(new Set(), fetch)
  const apiKey = bearerFor(effective.credentials)
  const baseURL = effective.credentials.baseURL?.trim() || 'https://api.cline.bot/api/v1'
  console.log('[probe] account =', effective.account.alias || effective.account.id)
  console.log('[probe] baseURL =', baseURL)

  const cases = [
    { label: 'only-deepseek', gateway: { only: ['deepseek'] } },
    { label: 'only-deepseek+has', gateway: { only: ['deepseek'], has: ['vision', 'implicit-caching'] } },
    { label: 'only-deepseek-repeat', gateway: { only: ['deepseek'] } },
    { label: 'only-deepseek+has-repeat', gateway: { only: ['deepseek'], has: ['vision', 'implicit-caching'] } },
    { label: 'invalid+has', gateway: { only: ['__probe__'], has: ['vision', 'implicit-caching'] } },
  ] as const

  for (const item of cases) {
    const body = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with the word OK' }],
      max_tokens: 256,
      providerOptions: { gateway: item.gateway },
    }
    const started = Date.now()
    try {
      const result = await chatCompletion({ fetchFn: fetch, baseURL, apiKey, body, timeoutMs: 120_000 })
      const payload = unwrapEnvelope(result.json)
      const routing = parseRouting(payload)
      console.log(JSON.stringify({
        case: item.label,
        http: result.status,
        ok: result.ok,
        ms: Date.now() - started,
        finalProvider: routing.finalProvider,
        canonicalSlug: routing.canonicalSlug,
        fingerprint: routing.fingerprint,
        anonymous: routing.anonymous,
        plan: routing.plan,
        error: errorText(payload.error).slice(0, 500),
        content: (routing.content ?? '').slice(0, 60),
      }))
    } catch (error) {
      console.log(JSON.stringify({ case: item.label, ms: Date.now() - started, transportError: String(error).slice(0, 500) }))
    }
  }
})

test('engine integration uses stored has for probe and test', async () => {
  const { ClinePassEngine } = await import('../src/host/cline-pass/engine.ts')
  const { ClinePassModelSettingsStore } = await import('../src/host/cline-pass/token-store.ts')
  const { createClinePassStore } = await import('../src/host/cline-pass/store.ts')
  const { defaultPin } = await import('../src/host/cline-pass/types.ts')
  const MODEL = 'cline-pass/deepseek-v4.1-flash-1017'
  const settings = new ClinePassModelSettingsStore()
  settings.readSync()
  const pool = new ClinePassAccountPool({ baseURL: () => settings.status().baseURL })
  const store = createClinePassStore()
  const engine = new ClinePassEngine({
    fetchFn: fetch,
    accountPool: pool,
    store,
    pinFor: (model) => ({
      ...(settings.status().pins[model] ?? defaultPin(model)),
      spelling: settings.status().pinSpelling,
    }),
    baseURL: () => settings.status().baseURL,
  })
  console.log('[probe] stored pin =', JSON.stringify(engine.pinOf(MODEL)))
  const probed = await engine.probe(MODEL)
  console.log('[probe] engine.probe =', JSON.stringify({
    ok: probed.ok,
    pipeline: probed.pipeline,
    pinnable: probed.pinnable,
    upstreams: probed.upstreams,
    availableProviders: probed.availableProviders,
    lastProvider: probed.lastProvider,
    fingerprint: probed.fingerprint,
    anonymous: probed.anonymous,
    error: probed.error,
  }))
  const tested = await engine.test(MODEL)
  console.log('[probe] engine.test =', JSON.stringify({
    ok: tested.ok,
    actual: tested.actual,
    adherence: tested.adherence,
    has: tested.has,
    fingerprint: tested.fingerprint,
    anonymous: tested.anonymous,
    plan: tested.plan,
    error: tested.error,
    trace: tested.trace,
  }))
})
