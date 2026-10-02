import type { AccountPoolStatusDto, PoolAccountSummaryDto } from './account-pool-contracts.ts'

// Wire contracts for the Ollama tab's settings API.
//
// Deliberately narrower than the other lines' DTOs, because Ollama is a
// narrower line. There is no plan, no quota, no token expiry, and no identity
// beyond the key: the service returns a bare key and nothing else, so a status
// payload carrying invented plan or usage fields would claim something the
// upstream cannot support.

// What one pooled key has consumed, counted locally from the service's own
// per-response token numbers. This is spend, not quota: Ollama publishes no
// account limit or remaining balance anywhere in its API, so no figure here
// can say how much is left.
export interface OllamaUsageDto {
  inputTokens: number
  outputTokens: number
  requestCount: number
  /** Unix milliseconds the last completed turn was counted. */
  lastCountedAt?: number
}

/** One account as the Ollama card renders it. Never carries the key. */
export interface OllamaAccountSummaryDto extends PoolAccountSummaryDto {
  /** Model id this account last served, when the adapter recorded one. */
  lastModelId?: string
  usage?: OllamaUsageDto
}

/** The whole pool slice the card needs. */
export interface OllamaPoolStatusDto {
  accounts: OllamaAccountSummaryDto[]
  activeAccountId?: string
  rotationStrategy: AccountPoolStatusDto['rotationStrategy']
}

/** Everything the settings card renders for the Ollama tab. */
export interface OllamaWebStatus {
  pool: OllamaPoolStatusDto
  /** Model ids synced from the service's own tag list. */
  models: { id: string; name?: string }[]
  // Which of them the user has switched on. Empty means 'no filter', i.e. every
  // model in the list: modelling it that way means a model the service adds
  // later is not silently hidden by a selection made before it existed.
  enabledModelIds: string[]
  /** True when at least one account can currently serve a request. */
  usable: boolean
  // Distinct from an empty models list: 'never synced' and 'synced, the
  // service returned nothing' are different states, and the card words them
  // differently.
  catalogSynced: boolean
}

/** Actions the accounts endpoint accepts. */
export type OllamaAccountAction =
  | 'add'
  | 'set-primary'
  | 'set-alias'
  | 'delete'
  | 'clear-cooldown'
  | 'strategy'