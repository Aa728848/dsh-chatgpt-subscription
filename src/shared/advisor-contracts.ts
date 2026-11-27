/** Public Advisor contracts shared by Host and Web; never include credentials or transcript content. */
export const CONSULT_ADVISOR_TOOL_NAME = 'consult_advisor'
export const ADVISOR_STATE_PATH = '/advisor/state'
export const ADVISOR_DEFAULT_TIMEOUT_MS = 300_000
export const ADVISOR_DEFAULT_MAX_TOKENS = 4_096
export const ADVISOR_DEFAULT_CONTEXT_TOKENS = 100_000

export type AdvisorFocus = 'plan' | 'stuck' | 'direction' | 'completion' | 'other'
export interface AdvisorRoute {
  provider: string
  model: string
  reasoningEffort?: string
}
export interface AdvisorLimits {
  maxTokens: number
  timeoutMs: number
  maxRetries: number
  contextTokenBudget: number
}
export interface AdvisorSelection extends AdvisorRoute { enabled: boolean }
export interface AdvisorStateDto {
  sessionId: string
  enabled: boolean
  selection: AdvisorRoute | null
  defaultEnabled: boolean
  defaultSelection: AdvisorRoute | null
  limits: AdvisorLimits
}
export type AdvisorResultStatus = 'ok' | 'truncated' | 'disabled' | 'unconfigured' | 'unavailable' | 'cancelled'
export interface AdvisorTokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}
export interface AdvisorResult {
  status: AdvisorResultStatus
  advice: string
  advisor?: AdvisorRoute
  usage?: AdvisorTokenUsage
  omittedMessages?: number
  detail?: string
}