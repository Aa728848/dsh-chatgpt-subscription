import { ROUTE_PREFIX } from '../compat.ts'
import type {
  ApiEnvelope,
  LoginEventDto,
  LoginStartDto,
  PluginStatusDto,
  QuotaStatusDto,
  SubagentModelCatalogDto,
  ConnectionTestDto,
  SubscriptionPreferencesDto,
  SubscriptionPreferencesUpdateDto,
} from '../shared/contracts.ts'

export class SubscriptionApi {
  status(): Promise<PluginStatusDto> {
    return request<PluginStatusDto>(`${ROUTE_PREFIX}/status`)
  }

  models(): Promise<SubagentModelCatalogDto> {
    return request<SubagentModelCatalogDto>(`${ROUTE_PREFIX}/models`)
  }

  startLogin(): Promise<LoginStartDto> {
    return post<LoginStartDto>(`${ROUTE_PREFIX}/login/start`, {})
  }

  cancelLogin(loginId: string): Promise<{ cancelled: boolean }> {
    return post(`${ROUTE_PREFIX}/login/cancel`, { loginId })
  }

  logout(): Promise<{ authenticated: false }> {
    return post(`${ROUTE_PREFIX}/logout`, {})
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
