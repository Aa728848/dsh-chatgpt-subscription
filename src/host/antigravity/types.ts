export const PROVIDER_NAME = 'Antigravity'
export const PROVIDER_ID = 'antigravity'

/**
 * Idle ceiling for one streaming response before it is declared stalled.
 *
 * Strictly inside the transport's own 300 s stream timeout; see
 * `host/common/idle-watchdog.ts` for the measured basis.
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/**
 * Budget for the wait before this route's FIRST chunk, when that wait is thinking
 * rather than a dead connection.
 *
 * The shared two-minute budget stays in force for the gaps between chunks — there
 * silence really is a stall. This route serves models that reason before they
 * speak: with `thinkingConfig.includeThoughts` set (see `mapper.ts`), thought
 * parts arrive only as the model chooses to emit them, and `gemini-4-carbon`
 * (`-medium` / `-high`, the catalog's own `defaultAgentModelId`) answers a long
 * prompt after minutes of silence. Under the shared budget those turns were
 * reported as stalled streams and retried from the beginning, which pays the
 * prefill again and arrives at the same silence.
 *
 * 240 s is the largest round value that still leaves a full minute inside the
 * transport's own 300 s stream deadline, so a genuinely dead connection is still
 * this route's verdict to report rather than undici's. It is a chosen bound, not
 * a measurement of carbon: no per-model first-chunk timing has been recorded for
 * this route yet, and the deployment can override it with
 * `antigravityFirstOutputTimeoutMs`.
 */
export const STREAM_FIRST_OUTPUT_TIMEOUT_MS = 240_000
export const DISCOVERY_TIMEOUT_MS = 8_000
export const PROJECT_CACHE_TTL_MS = 30 * 60 * 1000
export const MODEL_CACHE_TTL_MS = 30 * 60 * 1000
export const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

export const DEFAULT_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
// 官方 Antigravity 客户端的调用顺序是 daily 在前、prod 兜底。
export const DAILY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com'
export const ENDPOINT_FALLBACKS = [
  DAILY_ENDPOINT,
  DEFAULT_ENDPOINT,
]

export const FREE_TIER_ID = 'free-tier'

/**
 * The `project` a request names when discovery returned nothing.
 *
 * The native client always names a real project. The placeholder this route
 * used before, `antigravity-default`, names nothing any client ever sends, so
 * every request that fell through discovery announced itself as a
 * reimplementation by that string alone. This is the default project the wider
 * Code Assist ecosystem falls back to in the same situation: a request carrying
 * it reads as one whose project is unresolved, not as one from another client.
 */
export const FALLBACK_PROJECT_ID = 'rising-fact-p41fc'

export const ONBOARD_TIMEOUT_MS = 30_000
export const ONBOARD_POLL_INTERVAL_MS = 1_000

/**
 * The Hub release reported when the updater manifest has not been read yet.
 *
 * Cloud Code gates its model catalogue and its Gemini quota buckets on this
 * version, so it is the *floor* of what this route may claim: keep it at or
 * above the reference implementations' minimum, and refresh it together with
 * `HUB_RELEASE_CHANGELISTS` (see `client-version.ts`).
 */
export const DEFAULT_ANTIGRAVITY_VERSION = '2.31.0'
export const DEFAULT_ANTIGRAVITY_CL = '1017595969'

/**
 * The two identity fields the Hub adds on `onboardUser` control-plane calls.
 *
 * Onboarding is not served by the same surface as inference: the Hub appends a
 * Node API client to its User-Agent there and states an X-Goog-Api-Client, while
 * content requests carry neither.
 */
export const HUB_ONBOARD_UA_SUFFIX = 'google-api-nodejs-client/10.3.0'
export const HUB_ONBOARD_API_CLIENT = 'gl-node/22.21.1'

/**
 * Headers the native Antigravity client never sends, but Node's fetch adds itself.
 *
 * `sec-fetch-mode` and `accept-language` are browser idioms: undici's `fetch` adds
 * them to every request and offers no way to suppress them, so the only seam is
 * the dispatcher underneath. The native client is a Go HTTP client and sends
 * neither, which makes them a shape difference an upstream can match on without
 * any TLS inspection.
 *
 * `connection: keep-alive` is deliberately NOT listed: undici's HTTP/1.1 writer
 * re-adds it regardless of what the dispatcher is handed.
 */
export const ANTIGRAVITY_ABSENT_HEADERS = ['sec-fetch-mode', 'accept-language'] as const

export const REDIRECT_PATH = '/oauth-callback'
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const SCOPES = [
  'https://www.googleapis.com/auth/aicode',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

export const DEFAULT_CLIENT_ID = Buffer.from(
  'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc' +
    'C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==',
  'base64',
).toString('utf8')

export const DEFAULT_CLIENT_SECRET = Buffer.from(
  'R09DU1BYLUs1OEZXUjQ' + '4NkxkTEoxbUxCOHNYQzR6NnFEQWY=',
  'base64',
).toString('utf8')

/**
 * The Antigravity persona, as the native client states it.
 *
 * Only these two opening sentences are attested — they are the part captured
 * `language_server` traffic and the reference reimplementations quote. The
 * capture's tail is a truncated fragment (`**Absolute paths only****
 * Proactiveness**`), so nothing past these sentences is reconstructed here: a
 * guessed continuation would be one more thing only this route sends.
 */
export const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team ' +
  'working on Advanced Agentic Coding. You are pair programming with a USER to solve their coding task.'

export const GEMINI_ROLE = {
  user: 'user',
  model: 'model',
} as const

export const TOOL_CALLING_MODE = {
  none: 'NONE',
  any: 'ANY',
  auto: 'AUTO',
  validated: 'VALIDATED',
} as const

/**
 * How one selectable model reaches its runtime ids.
 *
 * Every entry resolves to exactly ONE runtime id per request. There is
 * deliberately no fallback list: retrying a failed request on a different
 * model (3.8 → 3.7 → 3.6, Pro High → Pro Low) served the user a model they
 * did not pick without telling them, which the official client never does. A
 * runtime id the service rejects now surfaces as that rejection.
 *
 * The runtime ids are the ones `fetchAvailableModels` lists (verified through
 * 2026-11-11, clients 2.29.0 / 2.31.0); the display names it publishes beside
 * them are quoted where the mapping is not obvious.
 */
export interface AntigravityRoutingEntry {
  off: string
  routing: Record<string, string>
  defaultRequestId: string
}

export const ROUTING: Record<string, AntigravityRoutingEntry> = {
  // Verified against fetchAvailableModels (clients 2.29.0 / 2.31.0): Gemini 4
  // Carbon has no bare or `-tiered` runtime (both return 404); the catalog lists
  // the three suffixed tiers (`maxOutputTokens: 262144`) and names
  // `gemini-4-carbon-medium` as `defaultAgentModelId`.
  'gemini-4-carbon': {
    off: 'gemini-4-carbon-low',
    routing: {
      minimal: 'gemini-4-carbon-low',
      low: 'gemini-4-carbon-low',
      medium: 'gemini-4-carbon-medium',
      high: 'gemini-4-carbon-high',
      xhigh: 'gemini-4-carbon-high',
    },
    defaultRequestId: 'gemini-4-carbon-medium',
  },
  // Verified against fetchAvailableModels (client 2.23.0): Gemini 4 Argon has
  // no `-tiered` runtime; the catalog lists the three suffixed tiers and names
  // `gemini-4-argon-medium` as `defaultAgentModelId`.
  'gemini-4-argon': {
    off: 'gemini-4-argon-low',
    routing: {
      minimal: 'gemini-4-argon-low',
      low: 'gemini-4-argon-low',
      medium: 'gemini-4-argon-medium',
      high: 'gemini-4-argon-high',
      xhigh: 'gemini-4-argon-high',
    },
    defaultRequestId: 'gemini-4-argon-medium',
  },
  'gemini-3.8-flash': {
    off: 'gemini-3.8-flash-tiered',
    routing: {
      minimal: 'gemini-3.8-flash-tiered',
      low: 'gemini-3.8-flash-tiered',
      medium: 'gemini-3.8-flash-tiered',
      high: 'gemini-3.8-flash-tiered',
      xhigh: 'gemini-3.8-flash-tiered',
    },
    defaultRequestId: 'gemini-3.8-flash-tiered',
  },
  // Verified against fetchAvailableModels: Claude 5.5 encodes effort in the runtime ID.
  'claude-opus-5-5': {
    off: 'claude-opus-5-5-low',
    routing: {
      off: 'claude-opus-5-5-low',
      none: 'claude-opus-5-5-low',
      minimal: 'claude-opus-5-5-low',
      low: 'claude-opus-5-5-low',
      medium: 'claude-opus-5-5-medium',
      high: 'claude-opus-5-5-high',
      xhigh: 'claude-opus-5-5-high',
    },
    defaultRequestId: 'claude-opus-5-5-medium',
  },
  'claude-sonnet-5-5': {
    off: 'claude-sonnet-5-5-low',
    routing: {
      off: 'claude-sonnet-5-5-low',
      none: 'claude-sonnet-5-5-low',
      minimal: 'claude-sonnet-5-5-low',
      low: 'claude-sonnet-5-5-low',
      medium: 'claude-sonnet-5-5-medium',
      high: 'claude-sonnet-5-5-high',
      xhigh: 'claude-sonnet-5-5-high',
    },
    defaultRequestId: 'claude-sonnet-5-5-medium',
  },
  'gemini-3.5-flash-lite': {
    off: 'gemini-3.5-flash-lite',
    routing: {
      minimal: 'gemini-3.5-flash-lite',
      low: 'gemini-3.5-flash-lite',
      medium: 'gemini-3.5-flash-lite',
      high: 'gemini-3.5-flash-lite',
      xhigh: 'gemini-3.5-flash-lite',
    },
    defaultRequestId: 'gemini-3.5-flash-lite',
  },
  'gemini-3.1-flash-lite': {
    off: 'gemini-3.1-flash-lite',
    routing: {
      minimal: 'gemini-3.1-flash-lite',
      low: 'gemini-3.1-flash-lite',
      medium: 'gemini-3.1-flash-lite',
      high: 'gemini-3.1-flash-lite',
      xhigh: 'gemini-3.1-flash-lite',
    },
    defaultRequestId: 'gemini-3.1-flash-lite',
  },
  'gemini-3-flash': {
    off: 'gemini-3-flash',
    routing: {
      minimal: 'gemini-3-flash',
      low: 'gemini-3-flash',
      medium: 'gemini-3-flash',
      high: 'gemini-3-flash',
      xhigh: 'gemini-3-flash',
    },
    defaultRequestId: 'gemini-3-flash',
  },
  'gemini-2.5-pro': {
    off: 'gemini-2.5-pro',
    routing: {
      minimal: 'gemini-2.5-pro',
      low: 'gemini-2.5-pro',
      medium: 'gemini-2.5-pro',
      high: 'gemini-2.5-pro',
      xhigh: 'gemini-2.5-pro',
    },
    defaultRequestId: 'gemini-2.5-pro',
  },
  'gemini-2.5-flash': {
    off: 'gemini-2.5-flash',
    routing: {
      minimal: 'gemini-2.5-flash',
      low: 'gemini-2.5-flash',
      medium: 'gemini-2.5-flash',
      high: 'gemini-2.5-flash',
      xhigh: 'gemini-2.5-flash',
    },
    defaultRequestId: 'gemini-2.5-flash',
  },
  'gpt-oss-120b': {
    off: 'gpt-oss-120b-medium',
    routing: {
      minimal: 'gpt-oss-120b-medium',
      low: 'gpt-oss-120b-medium',
      medium: 'gpt-oss-120b-medium',
      high: 'gpt-oss-120b-medium',
      xhigh: 'gpt-oss-120b-medium',
    },
    defaultRequestId: 'gpt-oss-120b-medium',
  },
}

export const RUNTIME_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'gemini-4-carbon': 262144,
  'gemini-4-carbon-low': 262144,
  'gemini-4-carbon-medium': 262144,
  'gemini-4-carbon-high': 262144,
  'gemini-4-argon': 65536,
  'gemini-4-argon-low': 65536,
  'gemini-4-argon-medium': 65536,
  'gemini-4-argon-high': 65536,
  'gemini-3.8-flash': 65536,
  'gemini-3.8-flash-tiered': 65536,
  'gemini-3.5-flash-lite': 65536,
  'gemini-3.1-flash-lite': 65536,
  'claude-opus-5-5': 128000,
  'claude-opus-5-5-low': 128000,
  'claude-opus-5-5-medium': 128000,
  'claude-opus-5-5-high': 128000,
  'claude-sonnet-5-5': 128000,
  'claude-sonnet-5-5-low': 128000,
  'claude-sonnet-5-5-medium': 128000,
  'claude-sonnet-5-5-high': 128000,
  'gpt-oss-120b': 32768,
  'gpt-oss-120b-medium': 32768,
}

export interface AntigravityModelDef {
  id: string
  name: string
  inputModalities: Array<'text' | 'image'>
  contextWindow: number
  maxTokens: number
  reasoningEfforts?: string[]
}

export const MODELS: AntigravityModelDef[] = [
  {
    id: 'gemini-4-carbon',
    name: 'Gemini 4 Carbon',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 262144,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash Lite',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: 'gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash Lite',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  // `gemini-3.1-flash-image` is deliberately absent although the catalog lists
  // it. Its value is the image it generates, and the harness accepts text-only
  // assistant output (dsh-llm `ImageBlock`: "the current production adapters
  // declare text-only output"), so a chat route could only discard the picture.
  // It belongs behind an image-generation tool, the way Codex images are served.
  {
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 65535,
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  // Verified against fetchAvailableModels (client 2.31.0, 2026-11-11):
  // Claude Opus 5.5 / Sonnet 5.5 advertise maxTokens 1000000 and maxOutputTokens
  // 128000; gpt-oss-120b-medium advertises maxTokens 131072 and maxOutputTokens
  // 32768. Claude Opus 4.6 / Sonnet 4.6 were removed earlier when the catalog
  // dropped them in favour of 5.5.
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    inputModalities: ['text', 'image'],
    contextWindow: 1000000,
    maxTokens: 128000,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    inputModalities: ['text', 'image'],
    contextWindow: 1000000,
    maxTokens: 128000,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gpt-oss-120b',
    name: 'GPT-OSS 120B',
    inputModalities: ['text'],
    contextWindow: 131072,
    maxTokens: 32768,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
]
