/**
 * Kimi Code membership API key sign-in.
 *
 * Besides the OAuth device code, a Kimi Code member can create an API key in the
 * Kimi Code console (https://www.kimi.com/code) for third-party tools. That key
 * authenticates against the SAME coding endpoint and the same membership quota
 * as the device-code token (`https://api.kimi.com/coding/v1`, bearer on the
 * OpenAI-compatible surface, `x-api-key` on the Anthropic-compatible one — see
 * the facts in `types.ts`), so it is stored as an ordinary credential whose
 * access token is the key itself and whose `authKind` is `api-key`.
 *
 * It is NOT a Moonshot Open Platform key: those are billed per token on a
 * different host and the coding endpoint refuses them with a 401, which is why
 * a pasted key is verified before anything is stored.
 *
 * Left unverified (no live key was exercised for this change): that `/usages`
 * and `/me` answer for an API key the way they answer for an OAuth token. Both
 * are therefore treated as enrichment — a refusal there never rejects the key
 * nor takes the account out of rotation; only the model listing decides.
 */

import type { KimiCodeRegion } from '../../shared/kimi-code-contracts.ts'
import { DISCOVERY_TIMEOUT_MS, OPENAI_API_PREFIX, codingBaseUrl, oauthHost } from './types.ts'
import type { KimiCodeCredentials } from './token-store.ts'
import { MODELS_PATH, kimiCodeHeaders } from './client.ts'

/** Longest key accepted; a real key is far shorter, this only bounds garbage. */
export const KIMI_CODE_API_KEY_MAX_LENGTH = 512

/** A key the route refuses, with the HTTP status the refusal is answered with. */
export class KimiCodeApiKeyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'KimiCodeApiKeyError'
  }
}

/**
 * Clean up what a user pasted into the key field.
 *
 * Copying from a console or a shell snippet often brings surrounding blanks,
 * quotes or a `Bearer ` prefix with it; those are removed. Anything that still
 * contains blanks or non-printable characters is not a key, and is refused here
 * rather than sent to the service as a header value.
 */
export function normalizeKimiCodeApiKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new KimiCodeApiKeyError('Paste a Kimi Code API key first.', 400)
  let key = raw.trim()
  if (key.length >= 2 && (key[0] === '"' || key[0] === "'") && key[key.length - 1] === key[0]) {
    key = key.slice(1, -1).trim()
  }
  key = key.replace(/^bearer\s+/i, '').trim()
  if (key === '') throw new KimiCodeApiKeyError('Paste a Kimi Code API key first.', 400)
  if (key.length > KIMI_CODE_API_KEY_MAX_LENGTH || /[^\x21-\x7E]/.test(key)) {
    throw new KimiCodeApiKeyError('That does not look like an API key: it contains spaces or characters a key never has.', 400)
  }
  return key
}

/** The credential one verified API key is stored as. */
export function kimiCodeApiKeyCredentials(
  apiKey: string,
  region: KimiCodeRegion,
  now: number = Date.now(),
): KimiCodeCredentials {
  return {
    authKind: 'api-key',
    accessToken: apiKey,
    refreshToken: '',
    expiresAt: 0,
    expiresIn: 0,
    region,
    oauthHost: oauthHost(region),
    baseUrl: codingBaseUrl(region),
    authenticatedAt: now,
  }
}

function otherRegion(region: KimiCodeRegion): KimiCodeRegion {
  return region === 'global' ? 'mainland-cn' : 'global'
}

/**
 * Prove a key authenticates, and name the region that accepted it.
 *
 * The probe is the model listing: it is what every OpenAI-compatible client asks
 * first, it costs no quota, and a 401 there is the service's own verdict on the
 * key. The preferred region is asked first; only when it refuses the key is the
 * other regional host asked, because a key belongs to the deployment it was
 * created on. A pinned base URL (`KIMI_CODE_BASE_URL`) leaves a single host, so
 * nothing else is tried.
 */
export async function verifyKimiCodeApiKey(
  apiKey: string,
  options: { region: KimiCodeRegion; fetchFn?: typeof fetch },
): Promise<KimiCodeRegion> {
  const fetchFn = options.fetchFn ?? fetch
  const candidates: KimiCodeRegion[] = [options.region]
  const alternate = otherRegion(options.region)
  if (codingBaseUrl(alternate) !== codingBaseUrl(options.region)) candidates.push(alternate)

  for (const region of candidates) {
    let status: number
    try {
      const response = await fetchFn(codingBaseUrl(region) + OPENAI_API_PREFIX + MODELS_PATH, {
        headers: await kimiCodeHeaders(apiKey, 'openai'),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      })
      status = response.status
      // The listing itself is not needed; drain it so the connection is reused.
      await response.text().catch(() => '')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new KimiCodeApiKeyError(`Could not reach Kimi Code to verify the API key: ${reason}`, 502)
    }
    if (status >= 200 && status < 300) return region
    if (status === 401 || status === 403) continue
    throw new KimiCodeApiKeyError(`Kimi Code could not verify the API key right now (HTTP ${status}). Try again shortly.`, 502)
  }
  throw new KimiCodeApiKeyError(
    'Kimi Code rejected this API key (401). Use a key created in the Kimi Code console (kimi.com/code); Moonshot Open Platform keys do not work on this line.',
    400,
  )
}
