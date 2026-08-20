export type CodexModelModality = 'text' | 'image'

export const GPT_56_MAX_CONTEXT_WINDOW = 1_000_000

export interface CodexModelCatalogEntry {
  id: string
  name: string
  contextWindow: number
  inputModalities: readonly CodexModelModality[]
  defaultReasoningEffort: string
  reasoningProfile: 'standard' | 'gpt-5.6'
  supportsReasoningSummary: boolean
}

export const CODEX_MODEL_CATALOG = [
  {
    id: 'gpt-5.6-sol',
    name: '5.6 Sol',
    contextWindow: 272_000,
    inputModalities: ['text', 'image'],
    defaultReasoningEffort: 'medium',
    reasoningProfile: 'gpt-5.6',
    supportsReasoningSummary: true,
  },
  {
    id: 'gpt-5.6-terra',
    name: '5.6 Terra',
    contextWindow: 272_000,
    inputModalities: ['text', 'image'],
    defaultReasoningEffort: 'medium',
    reasoningProfile: 'gpt-5.6',
    supportsReasoningSummary: true,
  },
  {
    id: 'gpt-5.6-luna',
    name: '5.6 Luna',
    contextWindow: 272_000,
    inputModalities: ['text', 'image'],
    defaultReasoningEffort: 'medium',
    reasoningProfile: 'gpt-5.6',
    supportsReasoningSummary: true,
  },
  {
    id: 'gpt-5.5',
    name: '5.5',
    contextWindow: 272_000,
    inputModalities: ['text', 'image'],
    defaultReasoningEffort: 'medium',
    reasoningProfile: 'standard',
    supportsReasoningSummary: true,
  },
  {
    id: 'gpt-5.4',
    name: '5.4',
    contextWindow: 272_000,
    inputModalities: ['text', 'image'],
    defaultReasoningEffort: 'none',
    reasoningProfile: 'standard',
    supportsReasoningSummary: true,
  },
  {
    id: 'gpt-5.4-mini',
    name: '5.4 Mini',
    contextWindow: 272_000,
    inputModalities: ['text', 'image'],
    defaultReasoningEffort: 'none',
    reasoningProfile: 'standard',
    supportsReasoningSummary: true,
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: '5.3 Codex Spark',
    contextWindow: 258_000,
    inputModalities: ['text'],
    defaultReasoningEffort: 'high',
    reasoningProfile: 'standard',
    supportsReasoningSummary: false,
  },
] as const satisfies readonly CodexModelCatalogEntry[]

export type CodexModelId = typeof CODEX_MODEL_CATALOG[number]['id']

export const DEFAULT_CODEX_MODEL = CODEX_MODEL_CATALOG[0]

export const CONFIGURABLE_CONTEXT_MODEL_IDS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
] as const satisfies readonly CodexModelId[]

export type ConfigurableContextModelId = typeof CONFIGURABLE_CONTEXT_MODEL_IDS[number]

export function isCodexModelId(model: unknown): model is CodexModelId {
  return typeof model === 'string' && CODEX_MODEL_CATALOG.some((entry) => entry.id === model)
}

export function isConfigurableContextModelId(model: unknown): model is ConfigurableContextModelId {
  return typeof model === 'string' && CONFIGURABLE_CONTEXT_MODEL_IDS.some((id) => id === model)
}

export function resolveCodexCatalogEntry(model: string): CodexModelCatalogEntry {
  return CODEX_MODEL_CATALOG.find((entry) => entry.id === model) ?? DEFAULT_CODEX_MODEL
}

export function codexModelSupportsImageInput(model: string): boolean {
  return resolveCodexCatalogEntry(model).inputModalities.includes('image')
}

export function codexModelSupportsReasoningSummary(model: string): boolean {
  return resolveCodexCatalogEntry(model).supportsReasoningSummary
}
