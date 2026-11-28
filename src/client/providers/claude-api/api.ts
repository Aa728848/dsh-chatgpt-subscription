import { CLAUDE_API_PROVIDER_NAME, CLAUDE_API_ROUTE_PREFIX } from '../../../shared/claude-api-contracts.ts'
import { createLineApi } from '../../common/line-api.ts'

/**
 * Client half of the line's route table. The host keeps the mirror; compare the two
 * whenever either side changes, because a mismatch only shows up as a 404 at runtime.
 *
 *   GET    /status            -> ClaudeApiStatusDto
 *   POST   /settings          ClaudeApiSettingsUpdateDto -> ClaudeApiStatusDto
 *   POST   /accounts          account CRUD and rotation strategy
 *   POST   /key               legacy primary-account key update
 *   DELETE /key               legacy primary-account delete
 *   POST   /test              -> ClaudeApiConnectionDto
 *   POST   /catalog/refresh
 */
export const CLAUDE_API_CLIENT_ROUTES = {
  status: '/status',
  settings: '/settings',
  accounts: '/accounts',
  key: '/key',
  test: '/test',
  catalogRefresh: '/catalog/refresh',
} as const

const api = createLineApi(CLAUDE_API_ROUTE_PREFIX, CLAUDE_API_PROVIDER_NAME)
export const get = api.get
export const post = api.post
export const request = api.request
export const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)
