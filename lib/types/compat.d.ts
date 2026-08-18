/**
 * Compatibility constants for the ChatGPT-backed Codex flow. The backend and
 * OAuth parameters are not a public third-party API contract, so every such
 * value is isolated here for review and rollback.
 */
export declare const CHATGPT_OAUTH_ISSUER: "https://auth.openai.com";
export declare const CHATGPT_OAUTH_CLIENT_ID: "app_EMoamEEZ73f0CkXaXp7hrann";
export declare const OAUTH_CALLBACK_HOST: "localhost";
export declare const OAUTH_CALLBACK_PORT: 1455;
export declare const OAUTH_CALLBACK_PATH: "/auth/callback";
export declare const OAUTH_REDIRECT_URI: "http://localhost:1455/auth/callback";
export declare const OAUTH_SCOPE: "openid profile email offline_access";
export declare const OAUTH_ORIGINATOR: "opencode";
export declare const OAUTH_LOGIN_TIMEOUT_MS: number;
export declare const TOKEN_REFRESH_MARGIN_MS = 60000;
export declare const ROUTE_PREFIX: "/api/dsh-chatgpt-subscription";
export declare const PLUGIN_VERSION: "0.1.0-alpha.0";
export declare const CODEX_CHATGPT_PROVIDER_ID: "codex-chatgpt";
export declare const CODEX_API_BASE: "https://chatgpt.com/backend-api/codex";
export declare const CODEX_RESPONSES_URL: "https://chatgpt.com/backend-api/codex/responses";
export declare const CODEX_IMAGE_GENERATION_URL: "https://chatgpt.com/backend-api/codex/images/generations";
export declare const CODEX_SEARCH_URL: "https://chatgpt.com/backend-api/codex/alpha/search";
export declare const CODEX_USAGE_URL: "https://chatgpt.com/backend-api/wham/usage";
export declare const CODEX_ORIGINATOR: "opencode";
export declare const CODEX_ENHANCED_ORIGINATOR: "pi";
export declare const CODEX_IMAGE_TOOL_NAME: "codex_image_generate";
export declare const CODEX_IMAGE_MODEL: "gpt-image-2";
export declare const CODEX_SEARCH_PROVIDER_ID: "codex-subscription";
export declare const QUOTA_CACHE_MS = 60000;
export declare const QUOTA_MIN_UPSTREAM_INTERVAL_MS = 15000;
export declare const OAUTH_AUTHORIZE_URL: "https://auth.openai.com/oauth/authorize";
export declare const OAUTH_TOKEN_URL: "https://auth.openai.com/oauth/token";
//# sourceMappingURL=compat.d.ts.map