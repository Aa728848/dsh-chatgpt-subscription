export const PROVIDER_NAME = 'Antigravity'
export const PROVIDER_ID = 'antigravity'

export const STREAM_IDLE_TIMEOUT_MS = 300_000
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
export const DISCOVERY_TIMEOUT_MS = 8_000
export const PROJECT_CACHE_TTL_MS = 30 * 60 * 1000
export const MODEL_CACHE_TTL_MS = 30 * 60 * 1000
export const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

export const DEFAULT_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
export const ENDPOINT_FALLBACKS = [
  DEFAULT_ENDPOINT,
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
]

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

export interface AntigravityRoutingEntry {
  off: string
  routing: Record<string, string>
  defaultRequestId: string
  fallbackCandidates?: string[]
}

export const ROUTING: Record<string, AntigravityRoutingEntry> = {
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
    fallbackCandidates: ['gemini-3.7-flash-tiered', 'gemini-3.6-flash-low'],
  },
  'claude-opus-4-6': {
    off: 'claude-opus-4-6-thinking',
    routing: {
      minimal: 'claude-opus-4-6-thinking',
      low: 'claude-opus-4-6-thinking',
      medium: 'claude-opus-4-6-thinking',
      high: 'claude-opus-4-6-thinking',
      xhigh: 'claude-opus-4-6-thinking',
    },
    defaultRequestId: 'claude-opus-4-6-thinking',
    fallbackCandidates: ['claude-sonnet-4-6'],
  },
  'claude-sonnet-4-6': {
    off: 'claude-sonnet-4-6',
    routing: {
      minimal: 'claude-sonnet-4-6',
      low: 'claude-sonnet-4-6',
      medium: 'claude-sonnet-4-6',
      high: 'claude-sonnet-4-6',
      xhigh: 'claude-sonnet-4-6',
    },
    defaultRequestId: 'claude-sonnet-4-6',
  },
  'gemini-3.7-flash': {
    off: 'gemini-3.7-flash-tiered',
    routing: {
      minimal: 'gemini-3.7-flash-tiered',
      low: 'gemini-3.7-flash-tiered',
      medium: 'gemini-3.7-flash-tiered',
      high: 'gemini-3.7-flash-tiered',
      xhigh: 'gemini-3.7-flash-tiered',
    },
    defaultRequestId: 'gemini-3.7-flash-tiered',
    fallbackCandidates: ['gemini-3.6-flash-low'],
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
  'gemini-3.5-flash': {
    off: 'gemini-3.5-flash-extra-low',
    routing: {
      minimal: 'gemini-3.5-flash-extra-low',
      low: 'gemini-3.5-flash-low',
      medium: 'gemini-3.5-flash-low',
      high: 'gemini-3-flash-agent',
      xhigh: 'gemini-3-flash-agent',
    },
    defaultRequestId: 'gemini-3-flash-agent',
  },
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
  'gemini-3.1-flash-image': {
    off: 'gemini-3.1-flash-image',
    routing: {
      minimal: 'gemini-3.1-flash-image',
      low: 'gemini-3.1-flash-image',
      medium: 'gemini-3.1-flash-image',
      high: 'gemini-3.1-flash-image',
      xhigh: 'gemini-3.1-flash-image',
    },
    defaultRequestId: 'gemini-3.1-flash-image',
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
  'gemini-3.8-flash': 65536,
  'gemini-3.8-flash-tiered': 65536,
  'gemini-3.7-flash': 65536,
  'gemini-3.7-flash-tiered': 65536,
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
  'gemini-3.1-pro': 65535,
  'gemini-3.1-pro-low': 65535,
  'gemini-3.1-pro-high': 65535,
  'gemini-pro-agent': 65535,
  'claude-opus-4-6': 64000,
  'claude-opus-4-6-thinking': 64000,
  'claude-sonnet-4-6': 64000,
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
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 65535,
    reasoningEfforts: ['low', 'high'],
  },
  {
    id: 'gemini-3.1-flash-image',
    name: 'Gemini 3.1 Flash Image',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 8192,
  },
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
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    inputModalities: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 64000,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
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
