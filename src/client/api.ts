import { ROUTE_PREFIX } from '../compat.ts'
import type {
  ApiEnvelope,
  LoginEventDto,
  LoginStartDto,
  PluginStatusDto,
  QuotaStatusDto,
  ConnectionTestDto,
  MultiProviderStatusDto,
  ProviderAuthorizationDto,
} from '../shared/contracts.ts'

export class SubscriptionApi {
  private providerCsrfToken: string | null = null
  status(): Promise<PluginStatusDto> {
    return request<PluginStatusDto>(`${ROUTE_PREFIX}/status`)
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

  testConnection(): Promise<ConnectionTestDto> {
    return post(`${ROUTE_PREFIX}/connection/test`, {})
  }

  events(loginId: string): EventSource {
    return new EventSource(`${ROUTE_PREFIX}/login/events?loginId=${encodeURIComponent(loginId)}`)
  }

  async providers(): Promise<MultiProviderStatusDto> {
    const status = await request<MultiProviderStatusDto>(`${ROUTE_PREFIX}/providers`)
    this.providerCsrfToken = status.csrfToken
    return status
  }

  scanProvider(providerId?: string): Promise<ProviderOperationDto> {
    return this.providerPost(`${ROUTE_PREFIX}/providers/scan`, providerId ? { providerId } : {})
  }

  importProviderCandidate(providerId: string, candidateId: string): Promise<ProviderOperationDto> {
    return this.providerPost(`${ROUTE_PREFIX}/providers/candidate/import`, { providerId, candidateId })
  }

  startProviderLogin(providerId: string): Promise<ProviderOperationDto<ProviderAuthorizationDto>> {
    return this.providerPost(`${ROUTE_PREFIX}/providers/login/start`, { providerId })
  }

  pollProviderLogin(providerId: string, sessionId: string): Promise<ProviderOperationDto<ProviderAuthorizationDto>> {
    return this.providerPost(`${ROUTE_PREFIX}/providers/login/poll`, { providerId, sessionId })
  }

  submitProviderCode(providerId: string, sessionId: string, code: string): Promise<ProviderOperationDto<ProviderAuthorizationDto>> {
    return this.providerPost(`${ROUTE_PREFIX}/providers/login/code`, { providerId, sessionId, code })
  }

  cancelProviderLogin(providerId: string, sessionId: string): Promise<ProviderOperationDto<ProviderAuthorizationDto>> {
    return this.providerPost(`${ROUTE_PREFIX}/providers/login/cancel`, { providerId, sessionId })
  }

  refreshProvider(providerId?: string): Promise<ProviderOperationDto> {
    return this.providerPost(`${ROUTE_PREFIX}/providers/refresh`, providerId ? { providerId } : {})
  }

  removeProviderAccount(providerId: string, accountId: string): Promise<ProviderOperationDto> {
    return this.providerPost(`${ROUTE_PREFIX}/providers/account/remove`, { providerId, accountId })
  }


  private async providerPost<T>(url: string, body: Record<string, unknown>): Promise<T> {
    if (!this.providerCsrfToken) await this.providers()
    return post<T>(url, body, { 'x-dsh-csrf-token': this.providerCsrfToken! })
  }
}

export interface ProviderOperationDto<T = unknown> {
  result: T
  snapshot: MultiProviderStatusDto
}


async function post<T>(url: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
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
