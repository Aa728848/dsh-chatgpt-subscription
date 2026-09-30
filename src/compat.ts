/**
 * Compatibility constants for the ChatGPT-backed Codex flow. The backend and
 * OAuth parameters are not a public third-party API contract, so every such
 * value is isolated here for review and rollback.
 */
export const CHATGPT_OAUTH_ISSUER = 'https://auth.openai.com' as const
export const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann' as const
export const OAUTH_CALLBACK_HOST = 'localhost' as const
export const OAUTH_CALLBACK_PORT = 1455 as const
export const OAUTH_CALLBACK_PATH = '/auth/callback' as const
export const OAUTH_REDIRECT_URI = `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}` as const
export const OAUTH_SCOPE = 'openid profile email offline_access' as const
/**
 * The single `originator` this line presents to the Codex backend on every
 * request, and the one OAuth sends during sign-in.
 *
 * This used to be three different values - `opencode` for chat and sign-in,
 * `pi` for the image and search endpoints - which was an archaeological record
 * of when each endpoint was reverse-engineered, not a decision. The Codex
 * backend keys behaviour off this value (`codex_cli_rs` is what the official
 * CLI sends) and treats it as one client identity, so splitting it across three
 * files meant three unrelated failure signatures for one account. Both spellings
 * are known-good against the backend; `opencode` is kept because it is the value
 * the OAuth flow has always presented, and changing the sign-in originator is a
 * different risk from changing the request originator.
 */
export const CODEX_ORIGINATOR = 'opencode' as const
/** OAuth presents the same identity the request path does (see above). */
export const OAUTH_ORIGINATOR = CODEX_ORIGINATOR
export const OAUTH_LOGIN_TIMEOUT_MS = 5 * 60_000
export const TOKEN_REFRESH_MARGIN_MS = 60_000
export const ROUTE_PREFIX = '/api/dsh-chatgpt-subscription' as const
export const PLUGIN_VERSION = '0.1.0-alpha.0' as const
export const CODEX_CHATGPT_PROVIDER_ID = 'codex-chatgpt' as const

//
// MiniMax Code subscription line.
//
// The provider id and the route prefix are re-exported from the frozen shared
// contract rather than restated here, so the two halves of the line cannot drift
// apart. This line's settings routes live under its own `/minimax-code/api`
// prefix like every other subscription line, NOT under the Codex
// `/api/dsh-chatgpt-subscription` prefix below, which belongs to that one route
// table alone. Exposing the constant here keeps the mounted prefixes discoverable
// from the compatibility seam.
//
export { MINIMAX_CODE_PROVIDER_ID, MINIMAX_CODE_ROUTE_PREFIX } from './shared/minimax-code-contracts.ts'

export const CODEX_API_BASE = 'https://chatgpt.com/backend-api/codex' as const
export const CODEX_RESPONSES_URL = `${CODEX_API_BASE}/responses` as const
export const CODEX_IMAGE_GENERATION_URL = `${CODEX_API_BASE}/images/generations` as const
export const CODEX_SEARCH_URL = `${CODEX_API_BASE}/alpha/search` as const
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage' as const
/**
 * The live model listing the subscription serves.
 *
 * Unlike the public `/v1/models`, this endpoint answers the *subscription*
 * entitlement: which models this plan can call, their real context window, and
 * the reasoning levels each one accepts. `client_version` is required and is the
 * same value the official CLI sends.
 */
export const CODEX_CLIENT_VERSION = '0.99.0' as const
export const CODEX_MODELS_URL = `${CODEX_API_BASE}/models?client_version=${CODEX_CLIENT_VERSION}` as const
/**
 * Beta gate the Codex backend expects on every responses request.
 *
 * The subscription backend is served under a beta flag, not as stable API:
 * without this header the endpoint is a different (and, on older builds,
 * rejected) surface. Kept as a single constant so the value is reviewable in
 * one place with the rest of the wire contract in `wire-auth.ts`.
 */
export const CODEX_OPENAI_BETA = 'responses=experimental' as const
export const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits' as const
export const CODEX_RESET_CREDITS_CONSUME_URL = `${CODEX_RESET_CREDITS_URL}/consume` as const
export const CODEX_IMAGE_TOOL_NAME = 'codex_image_generate' as const
export const CODEX_IMAGE_MODEL = 'gpt-image-2' as const
export const CODEX_SEARCH_PROVIDER_ID = 'codex-subscription' as const
export const CODEX_FETCH_PROVIDER_ID = 'codex-subscription' as const
export const QUOTA_CACHE_MS = 60_000
export const QUOTA_MIN_UPSTREAM_INTERVAL_MS = 15_000

export const OAUTH_AUTHORIZE_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/authorize` as const
export const OAUTH_TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token` as const
