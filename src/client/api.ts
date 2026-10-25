import { ROUTE_PREFIX } from '../compat.ts'
import type {
  ApiEnvelope,
  DeviceLoginStartDto,
  LoginEventDto,
  LoginStartDto,
  PluginStatusDto,
  QuotaStatusDto,
  ConnectionTestDto,
  SubscriptionPreferencesDto,
  SubscriptionPreferencesUpdateDto,
  CompactionCandidatesDto,
} from '../shared/contracts.ts'

export class SubscriptionApi {
  status(): Promise<PluginStatusDto> {
    return request<PluginStatusDto>(`${ROUTE_PREFIX}/status`)
  }

  startLogin(): Promise<LoginStartDto> {
    return post<LoginStartDto>(`${ROUTE_PREFIX}/login/start`, {})
  }

  /**
   * Start a device-code sign-in instead of the browser callback.
   *
   * The answer already carries what the panel shows — the code, the page, the
   * deadline — so the card does not have to ask the status route for it, and the
   * wait for confirmation arrives on the same event stream as any other login.
   */
  startDeviceLogin(): Promise<DeviceLoginStartDto> {
    return post<DeviceLoginStartDto>(`${ROUTE_PREFIX}/login/device/start`, {})
  }

  cancelLogin(loginId: string): Promise<{ cancelled: boolean }> {
    return post(`${ROUTE_PREFIX}/login/cancel`, { loginId })
  }

  /** Sign out one pooled account; without an id, the active one. */
  logout(accountId?: string): Promise<{ authenticated: false }> {
    return post(`${ROUTE_PREFIX}/logout`, accountId === undefined ? {} : { accountId })
  }

  /**
   * One account-pool action, returning the refreshed status.
   *
   * The host answers with the same envelope the status route uses, so the card
   * never has to guess what the pool looks like after a change.
   */
  accountAction(action: 'set-primary' | 'set-alias' | 'delete' | 'clear-cooldown' | 'strategy' | 'relogin', body: { accountId?: string; alias?: string; strategy?: string } = {}): Promise<PluginStatusDto> {
    return post<PluginStatusDto>(`${ROUTE_PREFIX}/accounts`, { action, ...body })
  }

  /**
   * Import this machine's Codex CLI sign-in, answering with the refreshed status.
   *
   * The body names the source rather than the URL carrying it, so the host can
   * refuse a sign-in it does not import with a sentence instead of a silent
   * no-op. The type is 'codex' alone on purpose: Claude Code and MiniMax Code are
   * imported from their own provider settings, and a union here would invite a
   * call the host always answers with a 400.
   */
  adoptLocalLogin(source: 'codex'): Promise<PluginStatusDto> {
    return post<PluginStatusDto>(`${ROUTE_PREFIX}/adopt`, { source })
  }

  /** Forget every imported snapshot. The CLIs' own files are never touched. */
  disableAdoptedLocalLogins(): Promise<PluginStatusDto> {
    return post<PluginStatusDto>(`${ROUTE_PREFIX}/adopt/disable`, {})
  }

  /**
   * Choose the account-pool store, answering with the refreshed status.
   *
   * The host persists the choice before resolving again, so the status that comes
   * back already names the store the pools will read and write from here on.
   */
  setPoolStorage(mode: 'keyring' | 'credentials'): Promise<PluginStatusDto> {
    return post<PluginStatusDto>(`${ROUTE_PREFIX}/storage`, { mode })
  }

  refresh(): Promise<PluginStatusDto> {
    return post(`${ROUTE_PREFIX}/token/refresh`, {})
  }

  refreshQuota(): Promise<QuotaStatusDto> {
    return post(`${ROUTE_PREFIX}/quota/refresh`, {})
  }

  useResetCredit(): Promise<QuotaStatusDto> {
    return post(`${ROUTE_PREFIX}/quota/reset-credit/use`, {})
  }

  testConnection(): Promise<ConnectionTestDto> {
    return post(`${ROUTE_PREFIX}/connection/test`, {})
  }

  updatePreferences(patch: SubscriptionPreferencesUpdateDto): Promise<SubscriptionPreferencesDto> {
    return post(`${ROUTE_PREFIX}/preferences/update`, patch)
  }

  /** Every route a compaction summary may be pointed at, read per call. */
  compactionCandidates(): Promise<CompactionCandidatesDto> {
    return post<CompactionCandidatesDto>(`${ROUTE_PREFIX}/compaction/candidates`, {})
  }

  events(loginId: string): EventSource {
    return new EventSource(`${ROUTE_PREFIX}/login/events?loginId=${encodeURIComponent(loginId)}`)
  }
}

async function post<T>(url: string, body: object): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin' })
  const envelope = await response.json() as ApiEnvelope<T>
  if (!response.ok || !envelope.ok) {
    throw new Error(envelope.ok ? `Request failed (${response.status})` : envelope.error.message)
  }
  return envelope.value
}

export function parseLoginEvent(event: MessageEvent<string>): LoginEventDto | null {
  try {
    const value = JSON.parse(event.data) as LoginEventDto
    return typeof value === 'object' && value !== null && typeof value.type === 'string' ? value : null
  } catch {
    return null
  }
}
