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
export const OAUTH_ORIGINATOR = 'opencode' as const
export const OAUTH_LOGIN_TIMEOUT_MS = 5 * 60_000
export const TOKEN_REFRESH_MARGIN_MS = 60_000
export const ROUTE_PREFIX = '/api/dsh-chatgpt-subscription' as const
export const PLUGIN_VERSION = '0.1.0-alpha.0' as const
export const CODEX_CHATGPT_PROVIDER_ID = 'codex-chatgpt' as const

export const CODEX_API_BASE = 'https://chatgpt.com/backend-api/codex' as const
export const CODEX_RESPONSES_URL = `${CODEX_API_BASE}/responses` as const
export const CODEX_IMAGE_GENERATION_URL = `${CODEX_API_BASE}/images/generations` as const
export const CODEX_SEARCH_URL = `${CODEX_API_BASE}/alpha/search` as const
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage' as const
export const CODEX_ORIGINATOR = 'opencode' as const
export const CODEX_ENHANCED_ORIGINATOR = 'pi' as const
export const CODEX_IMAGE_TOOL_NAME = 'codex_image_generate' as const
export const CODEX_IMAGE_MODEL = 'gpt-image-2' as const
export const CODEX_SEARCH_PROVIDER_ID = 'codex-subscription' as const
export const QUOTA_CACHE_MS = 60_000
export const QUOTA_MIN_UPSTREAM_INTERVAL_MS = 15_000

export const OAUTH_AUTHORIZE_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/authorize` as const
export const OAUTH_TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token` as const
