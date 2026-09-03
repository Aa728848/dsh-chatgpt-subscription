export declare const PROVIDER_NAME = "Antigravity";
export declare const PROVIDER_ID = "antigravity";
export declare const STREAM_IDLE_TIMEOUT_MS = 300000;
export declare const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
export declare const DISCOVERY_TIMEOUT_MS = 8000;
export declare const PROJECT_CACHE_TTL_MS: number;
export declare const MODEL_CACHE_TTL_MS: number;
export declare const OAUTH_CALLBACK_TIMEOUT_MS: number;
export declare const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export declare const ENDPOINT_FALLBACKS: string[];
export declare const REDIRECT_PATH = "/oauth-callback";
export declare const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export declare const TOKEN_URL = "https://oauth2.googleapis.com/token";
export declare const SCOPES: string[];
export declare const DEFAULT_CLIENT_ID: string;
export declare const DEFAULT_CLIENT_SECRET: string;
export declare const ANTIGRAVITY_SYSTEM_INSTRUCTION: string;
export declare const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION = "CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists, or thinking/personality preambles in the final response. Output only the final response.";
export declare const GEMINI_ROLE: {
    readonly user: "user";
    readonly model: "model";
};
export declare const TOOL_CALLING_MODE: {
    readonly none: "NONE";
    readonly any: "ANY";
    readonly auto: "AUTO";
    readonly validated: "VALIDATED";
};
export interface AntigravityRoutingEntry {
    off: string;
    routing: Record<string, string>;
    defaultRequestId: string;
    fallbackCandidates?: string[];
}
export declare const ROUTING: Record<string, AntigravityRoutingEntry>;
export declare const RUNTIME_MAX_OUTPUT_TOKENS: Record<string, number>;
export interface AntigravityModelDef {
    id: string;
    name: string;
    inputModalities: Array<'text' | 'image'>;
    contextWindow: number;
    maxTokens: number;
    reasoningEfforts?: string[];
}
export declare const MODELS: AntigravityModelDef[];
//# sourceMappingURL=types.d.ts.map