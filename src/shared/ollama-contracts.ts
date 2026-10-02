import type { AccountPoolStatusDto, PoolAccountSummaryDto } from './account-pool-contracts.ts'

// Wire contracts for the Ollama tab's settings API.
//
// Deliberately narrower than the other lines' DTOs, because Ollama is a
// narrower line. There is no plan, no quota, no token expiry, and no identity
// beyond the key: the service returns a bare key and nothing else, so a status
// payload carrying invented plan or usage fields would claim something the
// upstream cannot support.

/** One account as the Ollama card renders it. Never carries the key. */
export interface OllamaAccountSummaryDto extends PoolAccountSummaryDto {
  /** Model this account last served, when the adapter recorded one. */
  lastModelId?: string
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