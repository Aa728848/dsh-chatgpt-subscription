/** Side-effect-free contracts for the AWS Quick line. */
export const AWS_QUICK_PROVIDER_ID = 'aws-quick'
export const AWS_QUICK_ROUTE_PREFIX = '/aws-quick/api'
export const AWS_QUICK_MODES = ['fast', 'balanced', 'smart'] as const
export const AWS_QUICK_EFFORTS = ['off', 'low', 'medium', 'high'] as const

export type AwsQuickMode = typeof AWS_QUICK_MODES[number]
export type AwsQuickEffort = typeof AWS_QUICK_EFFORTS[number]
export type AwsQuickAccountProvider = 'social' | 'enterprise'

export interface AwsQuickModelDto {
  id: string
  name: string
  mode: AwsQuickMode
  efforts: AwsQuickEffort[]
  contextWindow: number
}

export interface AwsQuickAuthDto {
  authenticated: boolean
  provider?: string
  accountName?: string
  email?: string
  region?: string
  error?: string
}

export interface AwsQuickAgentDto {
  kind: 'installed' | 'custom' | 'missing'
  path?: string
  version?: string
  error?: string
}

export interface AwsQuickLoginDto {
  state: 'idle' | 'pending' | 'complete' | 'error'
  error?: string
}

export interface AwsQuickToolsDto {
  state: 'not_initialized' | 'pending' | 'ready' | 'approval_required' | 'error'
  detail?: string
}

export interface AwsQuickStatusDto {
  enabled: boolean
  agent: AwsQuickAgentDto
  auth: AwsQuickAuthDto
  models: AwsQuickModelDto[]
  enabledModelIds: string[] | null
  accountProvider: AwsQuickAccountProvider
  region: string | null
  defaultMode: AwsQuickMode
  defaultReasoningEffort: AwsQuickEffort | null
  login: AwsQuickLoginDto
  tools?: AwsQuickToolsDto
  routeConflict?: string
}

export interface AwsQuickSettingsUpdateDto {
  enabled?: boolean
  enabledModelIds?: string[] | null
  binaryPath?: string | null
  accountProvider?: AwsQuickAccountProvider
  region?: string | null
  defaultMode?: AwsQuickMode
  defaultReasoningEffort?: AwsQuickEffort | null
}
