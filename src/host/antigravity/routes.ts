import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { FileCredentialStore, FileModelSettingsStore, type AntigravityPreferenceStore } from './token-store.ts'
import { AccountPoolStore } from './account-pool.ts'
import { beginWebLogin, getWebLoginStatus } from './oauth.ts'
import { ANTIGRAVITY_QUOTA_CACHE_TTL_MS, clearCachedQuota, fetchAccountQuota, getCachedQuota } from './client.ts'
import { MODELS } from './types.ts'
import type { AntigravityModelOption, AntigravityWebStatus } from '../../shared/antigravity-contracts.ts'

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendMethodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { ok: false, error: 'Method Not Allowed' })
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += String(chunk)
      if (raw.length > 64 * 1024) {
        reject(new Error('Request body too large'))
      }
    })
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    request.on('error', reject)
  })
}

export async function getAntigravityWebStatus(
  store: FileCredentialStore,
  modelSettings: FileModelSettingsStore,
  preferences?: AntigravityPreferenceStore,
  accountPool = new AccountPoolStore(undefined, undefined, store),
): Promise<AntigravityWebStatus> {
  const credentials = await store.read()
  const settings = preferences ? preferences.status() : await modelSettings.read()
  const quota = getCachedQuota()
  const enabledSet = new Set(settings.enabledModelIds)
  const overrides = settings.contextWindowOverrides || {}

  const models: AntigravityModelOption[] = MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    enabled: enabledSet.has(m.id),
    defaultContextWindow: m.contextWindow,
    contextWindow: overrides[m.id] || m.contextWindow,
    reasoningEfforts: m.reasoningEfforts,
  }))

  const accounts = await accountPool.listAccounts().catch(() => [])
  const poolData = await accountPool.read().catch(() => null)
  const activeAccount = accounts.find((a) => a.id === poolData?.activeAccountId) || accounts[0]

  return {
    enabled: settings.enabled !== false,
    authenticated: accounts.length > 0 || !!(credentials?.access || credentials?.access_token),
    email: activeAccount?.email || credentials?.email,
    projectId: activeAccount?.projectId || credentials?.projectId,
    hasCredentials: accounts.length > 0 || !!credentials,
    storagePath: store.path(),
    lastFetchedAt: quota?.fetchedAt,
    quota,
    models,
    contextWindowOverrides: overrides,
    defaultReasoningEffort: settings.defaultReasoningEffort || null,
    accounts,
    activeAccountId: poolData?.activeAccountId || activeAccount?.id,
    rotationStrategy: poolData?.rotationStrategy || 'sequential',
  }
}

export function registerAntigravityRoutes(
  ctx: Context,
  store: FileCredentialStore,
  modelSettings: FileModelSettingsStore,
  preferences?: AntigravityPreferenceStore,
  fetchFn: typeof fetch = fetch,
  accountPool = new AccountPoolStore(undefined, undefined, store),
): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/antigravity/api',
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url || '/', 'http://dsh.local')
      const path = url.pathname.replace(/^\/antigravity\/api\/?/, '')

      try {
        if (path === 'status' || path === '') {
          if (request.method !== 'GET') return sendMethodNotAllowed(response)
          const credentials = await store.read()
          const authenticated = !!(credentials?.access || credentials?.access_token)
          const cached = getCachedQuota()
          if (authenticated && (!cached || Date.now() - (cached.fetchedAt || 0) > ANTIGRAVITY_QUOTA_CACHE_TTL_MS)) {
            await fetchAccountQuota(store, modelSettings, fetchFn).catch(() => undefined)
          }
          const value = await getAntigravityWebStatus(store, modelSettings, preferences, accountPool)
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'login' || path === 'accounts/login') {
          if (request.method !== 'POST') return sendMethodNotAllowed(response)
          const value = await beginWebLogin(store, fetchFn, undefined, async (creds) => {
            await accountPool.addAccount(creds)
          })
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'login/status') {
          if (request.method !== 'GET') return sendMethodNotAllowed(response)
          const value = getWebLoginStatus()
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'accounts') {
          if (request.method === 'GET') {
            const list = await accountPool.listAccounts()
            return sendJson(response, 200, { ok: true, value: list })
          }
          if (request.method === 'POST') {
            const body = await readRequestJson(request)
            const action = String(body.action || '')

            if (action === 'set-primary' && typeof body.accountId === 'string') {
              await accountPool.setPrimary(body.accountId)
            } else if (action === 'set-alias' && typeof body.accountId === 'string' && typeof body.alias === 'string') {
              await accountPool.setAlias(body.accountId, body.alias)
            } else if (action === 'delete' && typeof body.accountId === 'string') {
              await accountPool.deleteAccount(body.accountId)
            } else if (action === 'strategy' && (body.strategy === 'sequential' || body.strategy === 'round-robin')) {
              await accountPool.setStrategy(body.strategy)
            } else if (action === 'clear-cooldown' && typeof body.accountId === 'string') {
              await accountPool.clearCooldown(body.accountId)
            }

            const value = await getAntigravityWebStatus(store, modelSettings, preferences, accountPool)
            return sendJson(response, 200, { ok: true, value })
          }
          return sendMethodNotAllowed(response)
        }

        if (path === 'quota') {
          if (request.method !== 'GET' && request.method !== 'POST') return sendMethodNotAllowed(response)
          const quota = await fetchAccountQuota(store, modelSettings, fetchFn, true)
          const status = await getAntigravityWebStatus(store, modelSettings, preferences, accountPool)
          return sendJson(response, 200, { ok: true, value: { ...status, quota } })
        }

        if (path === 'settings') {
          if (request.method !== 'POST') return sendMethodNotAllowed(response)
          const body = await readRequestJson(request)
          if (preferences) {
            await preferences.update(body)
          } else {
            await modelSettings.updateSettings(body)
          }
          const value = await getAntigravityWebStatus(store, modelSettings, preferences, accountPool)
          return sendJson(response, 200, { ok: true, value })
        }

        if (path === 'models') {
          if (request.method === 'GET') {
            const status = await getAntigravityWebStatus(store, modelSettings, preferences, accountPool)
            return sendJson(response, 200, { ok: true, value: status.models })
          }
          if (request.method === 'POST') {
            const body = await readRequestJson(request)
            if (Array.isArray(body.enabledModelIds) || body.enabled !== undefined || body.contextWindowOverrides || body.defaultReasoningEffort !== undefined) {
              if (preferences) {
                await preferences.update(body)
              } else {
                await modelSettings.updateSettings(body)
              }
            }
            const status = await getAntigravityWebStatus(store, modelSettings, preferences, accountPool)
            return sendJson(response, 200, { ok: true, value: status })
          }
          return sendMethodNotAllowed(response)
        }

        if (path === 'logout') {
          if (request.method !== 'POST') return sendMethodNotAllowed(response)
          const body = (await readRequestJson(request).catch(() => ({}))) as Record<string, unknown>
          const targetId = typeof body.accountId === 'string' ? body.accountId : undefined
          if (targetId) {
            await accountPool.deleteAccount(targetId)
          } else {
            const poolData = await accountPool.read().catch(() => null)
            if (poolData?.activeAccountId) {
              await accountPool.deleteAccount(poolData.activeAccountId)
            } else {
              await store.delete()
            }
          }
          clearCachedQuota()
          const value = await getAntigravityWebStatus(store, modelSettings, preferences, accountPool)
          return sendJson(response, 200, { ok: true, value })
        }

        return sendJson(response, 404, { ok: false, error: 'not-found' })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        return sendJson(response, 500, { ok: false, error })
      }
    },
  })
}
