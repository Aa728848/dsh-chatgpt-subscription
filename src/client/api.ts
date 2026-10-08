import { ROUTE_PREFIX } from '../compat.ts'
import type {
  ApiEnvelope,
  LoginEventDto,
  LoginStartDto,
  PluginStatusDto,
  QuotaStatusDto,
  ConnectionTestDto,
  SubscriptionPreferencesDto,
  SubscriptionPreferencesUpdateDto,
} from '../shared/contracts.ts'

export class SubscriptionApi {
  status(): Promise<PluginStatusDto> {
    return request<PluginStatusDto>(`${ROUTE_PREFIX}/status`)
  }

  startLogin(): Promise<LoginStartDto> {
    return post<LoginStartDto>(`${ROUTE_PREFIX}/login/start`, {})
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
