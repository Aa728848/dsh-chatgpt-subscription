export type CodexModelModality = 'text' | 'image'

export const GPT_56_MAX_CONTEXT_WINDOW = 1_000_000
// Codex subscription limit from the model catalog; the public API has a different limit.
export const GPT_6_ASTRA_MAX_CONTEXT_WINDOW = 872_000

export interface CodexModelCatalogEntry {
  id: string
  name: string
  contextWindow: number
  inputModalities: readonly CodexModelModality[]
  defaultReasoningEffort: string
  reasoningProfile: 'standard' | 'gpt-5.6' | 'gpt-6-astra'
  supportsReasoningSummary: boolean
  fallbackModelId?: string
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
    fallbackModelId: 'gpt-5.6-terra',
  },
  {
    id: 'gpt-6-astra',
    name: '6 Astra',
    contextWindow: 272_000,
    inputModalities: ['text', 'image'],
    defaultReasoningEffort: 'medium',
    reasoningProfile: 'gpt-6-astra',
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
    fallbackModelId: 'gpt-5.5',
  },
  {
    id: 'gpt-5.6-luna',
    name: '5.6 Luna',
    contextWindow: 272_000,
    inputModalities: ['text', 'image'],
    defaultReasoningEffort: 'medium',
    reasoningProfile: 'gpt-5.6',
    supportsReasoningSummary: true,
    fallbackModelId: 'gpt-5.5',
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
    fallbackModelId: 'gpt-5.4-mini',
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

export const DEFAULT_VISIBLE_CODEX_MODEL_IDS = [
  'gpt-5.6-sol',
  'gpt-6-astra',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
] as const satisfies readonly CodexModelId[]

export const DEFAULT_CODEX_MODEL = CODEX_MODEL_CATALOG[0]

export const CONFIGURABLE_CONTEXT_MODEL_IDS = [
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
] as const satisfies readonly CodexModelId[]

export type ConfigurableContextModelId = typeof CONFIGURABLE_CONTEXT_MODEL_IDS[number]

export const STANDARD_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const
export const GPT_56_REASONING_EFFORTS = [...STANDARD_REASONING_EFFORTS, 'max'] as const
// Ultra in Codex also controls subagent orchestration; expose the Responses efforts here.
export const GPT_6_ASTRA_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type CodexReasoningEffort = typeof GPT_56_REASONING_EFFORTS[number]

export function reasoningEffortsForModel(model: string): readonly CodexReasoningEffort[] {
  const profile = resolveCodexCatalogEntry(model).reasoningProfile
  if (profile === 'gpt-6-astra') return GPT_6_ASTRA_REASONING_EFFORTS
  return profile === 'gpt-5.6'
    ? GPT_56_REASONING_EFFORTS
    : STANDARD_REASONING_EFFORTS
}

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === 'string' && GPT_56_REASONING_EFFORTS.some((effort) => effort === value)
}

export function modelSupportsReasoningEffort(model: string, effort: unknown): effort is CodexReasoningEffort {
  return isCodexReasoningEffort(effort) && reasoningEffortsForModel(model).some((candidate) => candidate === effort)
}

export function isCodexModelId(model: unknown): model is CodexModelId {
  return typeof model === 'string' && CODEX_MODEL_CATALOG.some((entry) => entry.id === model)
}

export function isConfigurableContextModelId(model: unknown): model is ConfigurableContextModelId {
  return typeof model === 'string' && CONFIGURABLE_CONTEXT_MODEL_IDS.some((id) => id === model)
}

export function contextWindowLimitForModel(model: ConfigurableContextModelId): number {
  return model === 'gpt-6-astra' ? GPT_6_ASTRA_MAX_CONTEXT_WINDOW : GPT_56_MAX_CONTEXT_WINDOW
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

export function resolveCodexFallbackModel(model: string): CodexModelCatalogEntry | undefined {
  const entry = resolveCodexCatalogEntry(model)
  if (!entry.fallbackModelId) return undefined
  return CODEX_MODEL_CATALOG.find((cand) => cand.id === entry.fallbackModelId)
}
