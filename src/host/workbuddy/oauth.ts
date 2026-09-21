import {
  CLIENT_PRODUCT,
  CLIENT_USER_AGENT,
  HEADER_DOMAIN,
  HEADER_IDE_NAME,
  HEADER_PRODUCT,
  HEADER_REQUESTED_WITH,
  LOGIN_PENDING_CODE,
  LOGIN_PLATFORM,
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_STATE_PATH,
  LOGIN_TIMEOUT_MS,
  LOGIN_TOKEN_PATH,
  PROVIDER_NAME,
  backendForDomain,
  regionForDomain,
} from './types.ts'
import { FileCredentialStore, workBuddyAccountId, type WorkBuddyCredentials } from './token-store.ts'
import { withResolvedIdentity, type WorkBuddyTokenIdentity } from './identity.ts'
import { fetchAccountIdentity } from './client.ts'
import type { WorkBuddyRegion } from '../../shared/workbuddy-contracts.ts'

export type WorkBuddyLoginStatus = 'idle' | 'pending' | 'complete' | 'error'

export interface WorkBuddyLoginFlowState {
  status: WorkBuddyLoginStatus
  region?: WorkBuddyRegion
  authUrl?: string
  progress?: string
  accountId?: string
  startedAt?: number
  completedAt?: number
  error?: string
}

let flow: WorkBuddyLoginFlowState = { status: 'idle' }
let controller: AbortController | null = null

export function getWebLoginStatus(): WorkBuddyLoginFlowState {
  return { ...flow }
}

export function resetWebLogin(): void {
  controller?.abort('login reset')
  controller = null
  flow = { status: 'idle' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function numberOf(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function domainForRegion(region: WorkBuddyRegion): string {
  return region === 'intl' ? 'www.workbuddy.ai' : 'copilot.tencent.com'
}

function loginHeaders(domain: string): Record<string, string> {
  const backend = backendForDomain(domain)
  const intl = regionForDomain(domain) === 'intl'
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    [HEADER_DOMAIN]: domain,
    [HEADER_PRODUCT]: CLIENT_PRODUCT,
    [HEADER_IDE_NAME]: 'CodeBuddyIDE',
    [HEADER_REQUESTED_WITH]: 'XMLHttpRequest',
    'user-agent': CLIENT_USER_AGENT,
    ...(intl ? { origin: backend, referer: `${backend}/` } : {}),
  }
}

export interface WorkBuddyLoginAttempt {
  state: string
  authUrl: string
  region: WorkBuddyRegion
  domain: string
}

export async function requestLoginState(
  region: WorkBuddyRegion,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<WorkBuddyLoginAttempt> {
  const domain = domainForRegion(region)
  const backend = backendForDomain(domain)
  const response = await fetchFn(`${backend}${LOGIN_STATE_PATH}?platform=${LOGIN_PLATFORM}`, {
    method: 'POST',
    headers: loginHeaders(domain),
    body: '{}',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  })
  const text = await response.text().catch(() => '')
  let root: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(text) as unknown
    root = isRecord(parsed) ? parsed : undefined
  } catch {
    root = undefined
  }
  if (!response.ok || root?.code !== 0 || !isRecord(root.data)) {
    throw new Error(`${PROVIDER_NAME} 登录初始化失败（HTTP ${response.status}）：${stringOf(root ?? {}, 'msg') ?? text.slice(0, 160)}`)
  }
  const state = stringOf(root.data, 'state')
  const authUrl = stringOf(root.data, 'authUrl')
  if (!state || !authUrl) throw new Error(`${PROVIDER_NAME} 登录响应缺少 state 或 authUrl`)
  return { state, authUrl, region, domain }
}

/** Parse the successful token-poll shape while accepting the two observed wrappers. */
export function parseLoginCredential(payload: unknown, attempt: WorkBuddyLoginAttempt): WorkBuddyCredentials | null {
  if (!isRecord(payload)) throw new Error(`${PROVIDER_NAME} 登录轮询响应无效`)
  const code = numberOf(payload, 'code')
  if (code === LOGIN_PENDING_CODE) return null
  if (code !== 0) throw new Error(`${PROVIDER_NAME} 登录失败：${stringOf(payload, 'msg') ?? `code ${String(code)}`}`)
  const data = isRecord(payload.data) ? payload.data : payload
  const auth = isRecord(data.auth) ? data.auth : data
  const account = isRecord(data.account) ? data.account
    : isRecord(auth.account) ? auth.account
      : isRecord(data.user) ? data.user
        : isRecord(auth.user) ? auth.user
          : {}
  const accessToken = stringOf(auth, 'accessToken') ?? stringOf(auth, 'access_token')
    ?? stringOf(data, 'token')
  if (!accessToken) throw new Error(`${PROVIDER_NAME} 登录成功响应缺少 access token`)
  const domain = stringOf(auth, 'domain') ?? attempt.domain
  const expiresIn = numberOf(auth, 'expiresIn') ?? numberOf(auth, 'expires_in')
  const expiresAt = numberOf(auth, 'expiresAt') ?? numberOf(auth, 'expires_at')
    ?? (expiresIn === undefined ? Date.now() + 60 * 60 * 1000 : Date.now() + expiresIn * 1000)
  return {
    accessToken,
    refreshToken: stringOf(auth, 'refreshToken') ?? stringOf(auth, 'refresh_token')
      ?? stringOf(data, 'refreshToken') ?? stringOf(data, 'refresh_token') ?? '',
    expiresAt,
    region: regionForDomain(domain),
    domain,
    backend: backendForDomain(domain),
    uid: stringOf(account, 'uid') ?? stringOf(data, 'uid'),
    nickname: stringOf(account, 'nickname') ?? stringOf(account, 'name') ?? stringOf(data, 'nickname'),
    uin: stringOf(account, 'uin') ?? stringOf(data, 'uin'),
    accountType: stringOf(account, 'type') ?? stringOf(data, 'accountType'),
    enterpriseId: stringOf(account, 'enterpriseId') ?? stringOf(data, 'enterpriseId'),
    sourceFile: '',
    sourceMtimeMs: 0,
    source: 'managed',
  }
}

export async function pollLogin(
  attempt: WorkBuddyLoginAttempt,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<WorkBuddyCredentials | null> {
  const backend = backendForDomain(attempt.domain)
  const response = await fetchFn(
    `${backend}${LOGIN_TOKEN_PATH}?platform=${LOGIN_PLATFORM}&state=${encodeURIComponent(attempt.state)}`,
    {
      headers: loginHeaders(attempt.domain),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    },
  )
  const text = await response.text().catch(() => '')
  if (!response.ok) throw new Error(`${PROVIDER_NAME} 登录轮询失败（HTTP ${response.status}）：${text.slice(0, 160)}`)
  let payload: unknown
  try { payload = JSON.parse(text) as unknown } catch { throw new Error(`${PROVIDER_NAME} 登录轮询返回了非 JSON 响应`) }
  return parseLoginCredential(payload, attempt)
}

/** Where a completed sign-in is written; the default is this line's own store. */
export interface WorkBuddyLoginOptions {
  /**
   * Persist the completed credential.
   *
   * The account pool owns routing, so it is what a completed sign-in must reach;
   * the default writes to the credential store alone, which is what a caller
   * running without a pool needs.
   */
  onSave?: (credentials: WorkBuddyCredentials) => Promise<unknown>
  /**
   * Resolve the signed-in account's identity before it is saved.
   *
   * The token response does not say which account it belongs to, so the default
   * reads it from the account endpoint; a test can replace this, and a caller
   * that already knows the identity can skip the extra request.
   */
  resolveIdentity?: (credentials: WorkBuddyCredentials) => Promise<WorkBuddyTokenIdentity | null>
}

/**
 * Settle the identity of a completed sign-in.
 *
 * Both sources are applied, in the order that keeps them from disagreeing: the
 * token's own claims first, because they are what the credential store keys on,
 * then the account record for anything the claims did not state. Reading the
 * account is best-effort — a deployment that will not answer the extra request
 * must still be able to complete a sign-in.
 */
async function resolveLoginIdentity(
  credentials: WorkBuddyCredentials,
  resolve: WorkBuddyLoginOptions['resolveIdentity'],
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<WorkBuddyCredentials> {
  const resolved = withResolvedIdentity(credentials)
  const identity = await (resolve ?? ((current) => fetchAccountIdentity(current, { fetchFn, ...(signal === undefined ? {} : { signal }) })))(resolved)
    .catch(() => null)
  if (identity === null) return resolved
  return withResolvedIdentity({
    ...resolved,
    ...(identity.uid === undefined ? {} : { uid: identity.uid }),
    ...(identity.nickname === undefined ? {} : { nickname: identity.nickname }),
    ...(identity.uin === undefined ? {} : { uin: identity.uin }),
    ...(identity.enterpriseId === undefined ? {} : { enterpriseId: identity.enterpriseId }),
  })
}

export async function beginWebLogin(
  store: FileCredentialStore,
  region: WorkBuddyRegion,
  fetchFn: typeof fetch = fetch,
  options: WorkBuddyLoginOptions = {},
): Promise<WorkBuddyLoginFlowState> {
  resetWebLogin()
  const active = new AbortController()
  controller = active
  const attempt = await requestLoginState(region, fetchFn, active.signal)
  const startedAt = Date.now()
  flow = { status: 'pending', region, authUrl: attempt.authUrl, progress: '等待浏览器授权…', startedAt }

  void (async () => {
    const deadline = startedAt + LOGIN_TIMEOUT_MS
    try {
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_INTERVAL_MS))
        if (active.signal.aborted) return
        const credentials = await pollLogin(attempt, fetchFn, active.signal)
        if (credentials === null) {
          flow = { ...flow, progress: `等待浏览器授权…（${Math.floor((Date.now() - startedAt) / 1000)} 秒）` }
          continue
        }
        // The identity is settled before anything is persisted, so the id the
        // card pins and the id the credential store computes are the same one:
        // saving first and correcting later is what left the same account
        // stored under both its name and its uid.
        const resolved = await resolveLoginIdentity(credentials, options.resolveIdentity, fetchFn, active.signal)
        if (options.onSave !== undefined) await options.onSave(resolved)
        else await store.addManaged(resolved)
        flow = { status: 'complete', region: resolved.region, accountId: workBuddyAccountId(resolved), startedAt, completedAt: Date.now(), progress: '授权完成' }
        return
      }
      flow = { status: 'error', region, startedAt, completedAt: Date.now(), error: '登录超时，请重新添加账号。' }
    } catch (error) {
      if (active.signal.aborted) return
      flow = { status: 'error', region, startedAt, completedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (controller === active) controller = null
    }
  })()

  return getWebLoginStatus()
}
