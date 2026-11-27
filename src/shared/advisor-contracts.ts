/** Public Advisor contracts shared by Host and Web; never include credentials or transcript content. */
export const CONSULT_ADVISOR_TOOL_NAME = 'consult_advisor'
export const ADVISOR_STATE_PATH = '/advisor/state'
export const ADVISOR_DEFAULT_TIMEOUT_MS = 300_000
export const ADVISOR_DEFAULT_MAX_TOKENS = 4_096
export const ADVISOR_DEFAULT_CONTEXT_TOKENS = 100_000
export const ADVISOR_DEFAULT_SESSION_TOKEN_BUDGET = 200_000

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
  /** Cumulative advisor tokens one conversation may spend before consultations stop. */
  sessionTokenBudget: number
}
/** Cumulative advisor spend for one conversation, reported separately from main-model usage. */
export interface AdvisorUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** How many consultations were actually answered. */
  calls: number
}
export interface AdvisorStateDto {
  sessionId: string
  enabled: boolean
  selection: AdvisorRoute | null
  defaultEnabled: boolean
  defaultSelection: AdvisorRoute | null
  /** True when this conversation inherits the user-level default rather than an explicit choice. */
  inherited: boolean
  limits: AdvisorLimits
  usage: AdvisorUsage
}
export type AdvisorResultStatus = 'ok' | 'truncated' | 'declined' | 'disabled' | 'unconfigured' | 'unavailable' | 'cancelled' | 'budget-exhausted'
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

