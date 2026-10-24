export const PROVIDER_NAME = 'Antigravity'
export const PROVIDER_ID = 'antigravity'

export const STREAM_IDLE_TIMEOUT_MS = 300_000
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
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
export const ONBOARD_TIMEOUT_MS = 30_000
export const ONBOARD_POLL_INTERVAL_MS = 1_000

export const DEFAULT_ANTIGRAVITY_VERSION = '2.23.0'
export const DEFAULT_ANTIGRAVITY_CL = '998057262'

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

export const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  'You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. ' +
  'You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.'

export const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
  'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists, or thinking/personality preambles in the final response. Output only the final response.'

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
 * The runtime ids are the ones `fetchAvailableModels` lists (snapshot of
 * 2026-10-14, client 2.23.0); the display names it publishes beside them are
 * quoted where the mapping is not obvious.
 */
export interface AntigravityRoutingEntry {
  off: string
  routing: Record<string, string>
  defaultRequestId: string
}

export const ROUTING: Record<string, AntigravityRoutingEntry> = {
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
  // The catalog lists no `gemini-3.7-flash-tiered`; it lists the three suffixed
  // tiers, so 3.7 routes like 3.6 rather than through an id the service no
  // longer advertises.
  'gemini-3.7-flash': {
    off: 'gemini-3.7-flash-low',
    routing: {
      minimal: 'gemini-3.7-flash-low',
      low: 'gemini-3.7-flash-low',
      medium: 'gemini-3.7-flash-medium',
      high: 'gemini-3.7-flash-high',
      xhigh: 'gemini-3.7-flash-high',
    },
    defaultRequestId: 'gemini-3.7-flash-medium',
  },
  'gemini-3.6-flash': {
    off: 'gemini-3.6-flash-low',
    routing: {
      minimal: 'gemini-3.6-flash-low',
      low: 'gemini-3.6-flash-low',
      medium: 'gemini-3.6-flash-medium',
      high: 'gemini-3.6-flash-high',
      xhigh: 'gemini-3.6-flash-high',
    },
    defaultRequestId: 'gemini-3.6-flash-high',
  },
  // The 3.5 runtime ids are offset by one from their names. The catalog
  // publishes `gemini-3.5-flash-extra-low` as "Gemini 3.5 Flash (Low)",
  // `gemini-3.5-flash-low` as "(Medium)" and `gemini-3-flash-agent` as "(High)",
  // so each effort is routed by the published display name, not by the suffix.
  'gemini-3.5-flash': {
    off: 'gemini-3.5-flash-extra-low',
    routing: {
      minimal: 'gemini-3.5-flash-extra-low',
      low: 'gemini-3.5-flash-extra-low',
      medium: 'gemini-3.5-flash-low',
      high: 'gemini-3-flash-agent',
      xhigh: 'gemini-3-flash-agent',
    },
    defaultRequestId: 'gemini-3-flash-agent',
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
  // `gemini-pro-agent` is published as "Gemini 3.1 Pro (High)".
  'gemini-3.1-pro': {
    off: 'gemini-3.1-pro-low',
    routing: {
      minimal: 'gemini-3.1-pro-low',
      low: 'gemini-3.1-pro-low',
      medium: 'gemini-pro-agent',
      high: 'gemini-pro-agent',
      xhigh: 'gemini-pro-agent',
    },
    defaultRequestId: 'gemini-pro-agent',
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
  'gemini-4-argon': 65536,
  'gemini-4-argon-low': 65536,
  'gemini-4-argon-medium': 65536,
  'gemini-4-argon-high': 65536,
  'gemini-3.8-flash': 65536,
  'gemini-3.8-flash-tiered': 65536,
  'gemini-3.7-flash': 65536,
  'gemini-3.7-flash-low': 65536,
  'gemini-3.7-flash-medium': 65536,
  'gemini-3.7-flash-high': 65536,
  'gemini-3.6-flash': 65536,
  'gemini-3.6-flash-low': 65536,
  'gemini-3.6-flash-medium': 65536,
  'gemini-3.6-flash-high': 65536,
  'gemini-3.5-flash': 65536,
  'gemini-3.5-flash-extra-low': 65536,
  'gemini-3.5-flash-low': 65536,
  'gemini-3-flash-agent': 65536,
  'gemini-3.5-flash-lite': 65536,
  'gemini-3.1-flash-lite': 65536,
  'gemini-3.1-pro': 65535,
  'gemini-3.1-pro-low': 65535,
  'gemini-3.1-pro-high': 65535,
  'gemini-pro-agent': 65535,
  'claude-opus-5-5': 64000,
  'claude-opus-5-5-low': 64000,
  'claude-opus-5-5-medium': 64000,
  'claude-opus-5-5-high': 64000,
  'claude-sonnet-5-5': 64000,
  'claude-sonnet-5-5-low': 64000,
  'claude-sonnet-5-5-medium': 64000,
  'claude-sonnet-5-5-high': 64000,
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
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
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
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 65535,
    reasoningEfforts: ['low', 'high'],
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
  // Retain the existing Antigravity Claude window/output defaults until the
  // service publishes limits for 5.5; these are not direct-Anthropic limits.
  // Claude Opus 4.6 / Sonnet 4.6 were removed: the catalog of 2026-10-12 lists
  // only the 5.5 runtime ids for the Claude family.
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 64000,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 64000,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gpt-oss-120b',
    name: 'GPT-OSS 120B',
    inputModalities: ['text'],
    contextWindow: 262144,
    maxTokens: 32768,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
]
