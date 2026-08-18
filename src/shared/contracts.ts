export interface SanitizedAccountDto {
  email: string | null
  planType: string | null
  accountIdSuffix: string | null
  tokenExpiresAt: number
}

export type CredentialStorageKind =
  | 'windows-dpapi'
  | 'linux-file'
  | 'memory'

export interface CredentialStorageDto {
  kind: CredentialStorageKind
  encrypted: boolean
  available: boolean
}

export interface PluginStatusDto {
  authenticated: boolean
  account: SanitizedAccountDto | null
  storage: CredentialStorageDto
  login: {
    active: boolean
    loginId: string | null
    expiresAt: number | null
  }
  quota: QuotaStatusDto
  error?: PublicErrorDto
}

export type OAuthStatusDto = Omit<PluginStatusDto, 'quota'>

export interface QuotaWindowDto {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export interface QuotaBucketDto {
  id: 'codex' | 'code-review'
  name: string
  planType: string | null
  primary: QuotaWindowDto | null
  secondary: QuotaWindowDto | null
}

export interface QuotaStatusDto {
  state: 'signed-out' | 'empty' | 'ready' | 'stale' | 'error'
  buckets: QuotaBucketDto[]
  fetchedAt: number | null
  stale: boolean
  error?: PublicErrorDto
}

export interface ConnectionTestDto {
  connected: true
  latencyMs: number
  checkedAt: number
}

export interface LoginStartDto {
  loginId: string
  authUrl: string
  expiresAt: number
}

export type LoginEventDto =
  | { type: 'pending'; loginId: string }
  | { type: 'completed'; loginId: string }
  | { type: 'cancelled'; loginId: string }
  | { type: 'failed'; loginId: string; error: PublicErrorDto }

export interface PublicErrorDto {
  code:
    | 'bad-request'
    | 'csrf-rejected'
    | 'login-active'
    | 'login-cancelled'
    | 'login-expired'
    | 'oauth-callback-invalid'
    | 'oauth-token-exchange-failed'
    | 'not-authenticated'
    | 'refresh-failed'
    | 'storage-failed'
    | 'connection-failed'
    | 'quota-failed'
    | 'rate-limited'
    | 'internal'
  message: string
}

export type ApiEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: PublicErrorDto }
