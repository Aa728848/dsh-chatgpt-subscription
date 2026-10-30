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
/**
 * The device-code grant: the one sign-in path a headless host can finish.
 *
 * The browser flow redirects to a *fixed* `http://localhost:1455/auth/callback`
 * registered against this OAuth client, so it cannot be completed from a server:
 * nothing listens on that loopback port there, and an HTTPS page cannot reach it
 * anyway (mixed content). The device grant takes the redirect out of the
 * picture — the user types a short code on a page on their own machine and this
 * process polls for the result.
 *
 * Same client id as the browser flow, because it is the same registration. These
 * are that registration's device endpoints, verified against the live service.
 */
export const OAUTH_DEVICE_USERCODE_URL = `${CHATGPT_OAUTH_ISSUER}/api/accounts/deviceauth/usercode` as const
export const OAUTH_DEVICE_TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/api/accounts/deviceauth/token` as const
export const OAUTH_DEVICE_VERIFY_URL = `${CHATGPT_OAUTH_ISSUER}/codex/device` as const
/**
 * The redirect the device grant redeems its authorization code against.
 *
 * Nothing listens on it: the device endpoint hands the code to this process
 * directly and the token endpoint only checks it against the grant.
 */
export const OAUTH_DEVICE_REDIRECT_URI = `${CHATGPT_OAUTH_ISSUER}/deviceauth/callback` as const
/** Deadline used when a grant states no usable `expires_at` (the live one is ~15 min out). */
export const OAUTH_DEVICE_GRANT_LIFETIME_MS = 15 * 60_000
/** Poll interval used when a grant states no usable `interval` (the live one answers `"5"`). */
export const OAUTH_DEVICE_POLL_INTERVAL_SECONDS = 5
/**
 * Floor for a fractional poll interval (a grant answering `"0.2"`), so it cannot
 * turn the loop into a spin. `"0"`, a negative or an unparseable value never get
 * this far: `parseGrantInterval` already replaced them with the 5 s default.
 */
export const OAUTH_DEVICE_MIN_POLL_INTERVAL_MS = 1_000
export const TOKEN_REFRESH_MARGIN_MS = 60_000
export const ROUTE_PREFIX = '/api/dsh-chatgpt-subscription' as const
/**
 * Version this line presents to the Codex backend in its `user-agent`.
 *
 * It must equal `package.json`'s version: a stale value here reports a plugin
 * version that no release ever shipped, and nothing else in the build notices.
 * `test/responses-client.test.ts` asserts the two agree, so a release that
 * forgets this constant fails the suite instead of shipping quietly.
 */
export const PLUGIN_VERSION = '0.47.0' as const
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
/**
 * The Antigravity image tool and the runtime it calls.
 *
 * `gemini-3.1-flash-image` is listed by `fetchAvailableModels`, but its product
 * is an image and the harness accepts text-only assistant output, so it is
 * served as a tool (like Codex images) rather than as a chat model.
 */
export const ANTIGRAVITY_IMAGE_TOOL_NAME = 'antigravity_image_generate' as const
export const ANTIGRAVITY_IMAGE_MODEL = 'gemini-3.1-flash-image' as const
export const CODEX_SEARCH_PROVIDER_ID = 'codex-subscription' as const
export const CODEX_FETCH_PROVIDER_ID = 'codex-subscription' as const
export const QUOTA_CACHE_MS = 60_000
export const QUOTA_MIN_UPSTREAM_INTERVAL_MS = 15_000

export const OAUTH_AUTHORIZE_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/authorize` as const
export const OAUTH_TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token` as const
