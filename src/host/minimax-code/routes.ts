/**
 * Web routes for the MiniMax Code line.
 *
 * The six routes below are the frozen contract the client half consumes (brief
 * section 3). Their paths, request bodies and verdicts are therefore not free:
 * this file implements them as specified rather than as this line might prefer.
 *
 * Response envelope: every route answers \`{ ok: true, value: <payload> }\`, which is
 * what the sibling lines in this package use. The three routes whose contract names
 * a top-level key as well (\`/login/start\` -> \`login\`, \`/login/poll\` -> \`status\` and
 * \`account\`, \`/test\` -> \`ok\`/\`model\`/\`error\`) carry that key at the top level too,
 * so a client written against either reading resolves. \`/test\` is the one route
 * where the envelope's \`ok\` cannot double as the payload's: its contract defines
 * \`ok\` as the probe verdict, so the envelope there is the verdict itself and the
 * duplicate lives under \`value\`.
 *
 * Mounting: the routes are registered under BOTH the contract prefix and the
 * sibling-line convention, because the two disagree in this repository and the
 * client half must not be able to miss them for that reason alone.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../common/same-origin.ts'
import {
  MINIMAX_CODE_PROVIDER_ID,
  MINIMAX_CODE_ROUTE_PREFIX,
  type MinimaxCodeRegion,
  type MinimaxCodeWebLogin,
  type MinimaxCodeWebStatus,
} from '../../shared/minimax-code-contracts.ts'
import { PROVIDER_ID, isRegion } from './types.ts'
import { MinimaxCodeCredentialStore } from './token-store.ts'
import {
  accountFromCredentials,
  beginWebLogin,
  cancelWebLogin,
  ensureAccessToken,
  getWebLogin,
  pollWebLogin,
  revokeToken,
  MinimaxCodeAccessDeniedError,
  MinimaxCodeUnauthorizedError,
} from './oauth.ts'
import { listModelIds, testConnection } from './client.ts'

/** Path the sibling lines register (\`/kimi-code/api\`, \`/workbuddy/api\`). */
const SIBLING_PREFIX = '/minimax-code/api'

const MAX_BODY_BYTES = 64 * 1024

/** The last sign-in this process started, so /status can render it. */
let latestLogin: MinimaxCodeWebLogin | null = null

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendMethodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { ok: false, error: 'Method Not Allowed' })
}

function sendCrossOrigin(response: ServerResponse): void {
  sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    request.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Malformed JSON request'))
      }
    })
    request.on('error', reject)
  })
}

/** The sub-path one request addresses, whichever prefix it arrived under. */
export function subPathOf(requestUrl: string): string {
  const pathname = new URL(requestUrl || '/', 'http://dsh.local').pathname
  for (const prefix of [MINIMAX_CODE_ROUTE_PREFIX, SIBLING_PREFIX]) {
    if (pathname === prefix) return ''
    if (pathname.startsWith(prefix + '/')) return pathname.slice(prefix.length + 1)
  }
  return pathname.replace(/^\/+/, '')
}

export interface MinimaxCodeStatusOptions {
  fetchFn?: typeof fetch
  /** Whether this plugin currently owns the provider route; re-read on every status. */
  serving?: boolean | (() => boolean)
  /** Diagnostic when another plugin owns the provider route; re-read on every status. */
  conflict?: string | null | (() => string | null)
}

/** Everything the settings card renders. */
export async function getMinimaxCodeWebStatus(
  store: MinimaxCodeCredentialStore,
  options: MinimaxCodeStatusOptions = {},
): Promise<MinimaxCodeWebStatus> {
  const credentials = await store.read()
  const source = await store.activeSource().catch(() => 'file' as const)
  const path = await store.activePath().catch(() => store.path())
  const region: MinimaxCodeRegion = credentials?.region ?? 'cn'
  return {
    authenticated: credentials !== null,
    providerId: PROVIDER_ID,
    region,
    // The kind reports which file the credential in force came from, so a user can
    // see whether the plugin is riding the desktop app's session or its own.
    storage: { kind: source, path },
    ...(credentials === null ? {} : { account: accountFromCredentials(credentials) }),
    ...(latestLogin === null ? {} : { login: latestLogin }),
    // The hardcoded directory. Nothing here calls /v1/models, which is unavailable
    // on this endpoint (503 direct_route_not_configured).
    models: listModelIds(),
    // quota is deliberately absent: no quota endpoint was measured for this
    // subscription, and the frozen contract defines its absence as the graceful
    // degradation the card must handle.
  }
}

export function registerMinimaxCodeRoutes(
  ctx: Context,
  store: MinimaxCodeCredentialStore = new MinimaxCodeCredentialStore(),
  options: MinimaxCodeStatusOptions = {},
): () => void {
  const fetchFn = options.fetchFn ?? fetch

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = subPathOf(request.url ?? '/')
    const method = request.method ?? 'GET'

    try {
      if (path === '' || path === 'status') {
        if (method !== 'GET') return sendMethodNotAllowed(response)
        const value = await getMinimaxCodeWebStatus(store, options)
        return sendJson(response, 200, { ok: true, value })
      }

      if (path === 'login/start') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const body = await readRequestJson(request)
        const requested = isRegion(body.region) ? body.region : undefined
        const login = await beginWebLogin({
          fetchFn,
          ...(requested === undefined ? {} : { region: requested }),
        })
        latestLogin = login
        return sendJson(response, 200, { ok: true, value: login, login })
      }

      if (path === 'login/poll') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const body = await readRequestJson(request)
        const loginId = typeof body.loginId === 'string' ? body.loginId : ''
        if (loginId === '') {
          return sendJson(response, 400, { ok: false, error: 'loginId is required.' })
        }
        const outcome = await pollWebLogin(store, loginId, { fetchFn })
        if (outcome.status !== 'pending') latestLogin = null
        return sendJson(response, 200, {
          ok: true,
          status: outcome.status,
          ...(outcome.account === undefined ? {} : { account: outcome.account }),
          value: outcome,
        })
      }

      if (path === 'login/cancel') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const body = await readRequestJson(request)
        const loginId = typeof body.loginId === 'string' ? body.loginId : ''
        if (loginId === '') {
          return sendJson(response, 400, { ok: false, error: 'loginId is required.' })
        }
        cancelWebLogin(loginId)
        if (latestLogin?.loginId === loginId) latestLogin = null
        return sendJson(response, 200, { ok: true, value: { ok: true } })
      }

      if (path === 'logout') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        // The refresh token is revoked at the service first, so the session really
        // ends; the local delete is best effort and never blocks the sign-out.
        const credentials = await store.read().catch(() => null)
        if (credentials !== null) {
          await revokeToken(credentials.refreshToken, { fetchFn, region: credentials.region })
        }
        await store.delete()
        latestLogin = null
        return sendJson(response, 200, { ok: true, value: { ok: true } })
      }

      if (path === 'test') {
        if (method !== 'POST') return sendMethodNotAllowed(response)
        if (!isSameOriginMutation(request)) return sendCrossOrigin(response)
        const probe = await testConnection(store, { fetchFn })
        // HTTP 200 either way: the verdict is the payload, not the status line, so a
        // failed probe is not mistaken for a broken route by the card.
        return sendJson(response, 200, {
          ok: probe.ok,
          ...(probe.model === undefined ? {} : { model: probe.model }),
          ...(probe.error === undefined ? {} : { error: probe.error }),
          latencyMs: probe.latencyMs,
          ...(probe.usage === undefined ? {} : { usage: probe.usage }),
          value: probe,
        })
      }

      return sendJson(response, 404, { ok: false, error: 'Route not found.' })
    } catch (error) {
      if (error instanceof MinimaxCodeUnauthorizedError) {
        return sendJson(response, 401, { ok: false, error: error.message })
      }
      if (error instanceof MinimaxCodeAccessDeniedError) {
        return sendJson(response, 403, { ok: false, error: error.message })
      }
      return sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const disposers: Array<() => void> = []
  disposers.push(ctx.webServer.register({ kind: 'prefix', path: MINIMAX_CODE_ROUTE_PREFIX, handler }))
  try {
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: SIBLING_PREFIX, handler }))
  } catch (error) {
    // The contract prefix is the one that matters; a harness that refuses the
    // second mount must not take the line down with it.
    ctx.logger?.warn(
      '[dsh-chatgpt-subscription] minimax-code: could not also mount ' + SIBLING_PREFIX + ' ('
      + (error instanceof Error ? error.message : String(error)) + ')',
    )
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** Test seam: forget which sign-in the status route reports. */
export function resetLatestLogin(): void {
  latestLogin = null
}

export { MINIMAX_CODE_PROVIDER_ID, getWebLogin, ensureAccessToken }
