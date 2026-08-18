export type CodexModelModality = 'text' | 'image'

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

export function resolveCodexCatalogEntry(model: string): CodexModelCatalogEntry {
  return CODEX_MODEL_CATALOG.find((entry) => entry.id === model) ?? DEFAULT_CODEX_MODEL
}

export function codexModelSupportsImageInput(model: string): boolean {
  return resolveCodexCatalogEntry(model).inputModalities.includes('image')
}

export function codexModelSupportsReasoningSummary(model: string): boolean {
  return resolveCodexCatalogEntry(model).supportsReasoningSummary
}
