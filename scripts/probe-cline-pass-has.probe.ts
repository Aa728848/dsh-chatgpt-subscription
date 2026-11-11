/**
 * Explicit live probe for Cline's automatic route. Reads the normal pooled
 * account; never prints or persists the credential or sends routing overrides.
 * Run: npx vitest run --config vitest.probe.config.ts scripts/probe-cline-pass-has.probe.ts
 */
import { expect, test } from 'vitest'
import { ClinePassAccountPool } from '../src/host/cline-pass/account-pool.ts'
import { bearerFor } from '../src/host/cline-pass/token-store.ts'
import { chatCompletion } from '../src/host/cline-pass/client.ts'
import { errorText, parseRouting, unwrapEnvelope } from '../src/host/cline-pass/protocol.ts'

test('cline-pass automatic route without client routing fields', async () => {
  const model = 'cline-pass/deepseek-v4.1-flash-1017'
  const pool = new ClinePassAccountPool()
  const effective = await pool.getEffectiveCredential(new Set(), fetch)
  const apiKey = bearerFor(effective.credentials)
  const baseURL = effective.credentials.baseURL?.trim() || 'https://api.cline.bot/api/v1'
  console.log('[probe] account =', effective.account.alias || effective.account.id)
  console.log('[probe] baseURL =', baseURL)

  const body = {
    model,
    messages: [{ role: 'user', content: 'Reply with the word OK' }],
    max_tokens: 256,
  }
  expect(body).not.toHaveProperty('provider')
  expect(body).not.toHaveProperty('providerOptions')
  const started = Date.now()
  const result = await chatCompletion({ fetchFn: fetch, baseURL, apiKey, body, timeoutMs: 120_000 })
  const payload = unwrapEnvelope(result.json)
  const routing = parseRouting(payload)
  console.log(JSON.stringify({
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
})
