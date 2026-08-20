import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { CODEX_CHATGPT_PROVIDER_ID } from '../compat.ts'
import { CODEX_MODEL_CATALOG, isConfigurableContextModelId, resolveCodexCatalogEntry } from '../shared/model-catalog.ts'
import type { SubscriptionPreferenceStore } from './preferences.ts'

export const PROVIDER_ID = CODEX_CHATGPT_PROVIDER_ID
export const PROVIDER_NAME = 'Codex（ChatGPT 订阅）' as const

const STANDARD_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const
const GPT_56_REASONING_EFFORTS = [...STANDARD_REASONING_EFFORTS, 'max'] as const

const MODEL_REASONING = {
  standard: STANDARD_REASONING_EFFORTS,
  'gpt-5.6': GPT_56_REASONING_EFFORTS,
} as const satisfies Record<(typeof CODEX_MODEL_CATALOG)[number]['reasoningProfile'], readonly string[]>

export function listCodexModels(): LlmModelInfo[] {
  return CODEX_MODEL_CATALOG.map((entry) => ({
    provider: PROVIDER_ID,
    id: entry.id,
    name: entry.name,
    inputModalities: [...entry.inputModalities],
  }))
}

export function resolveCodexModel(model: string, preferences?: SubscriptionPreferenceStore): LlmResolvedModelInfo {
  const entry = resolveCodexCatalogEntry(model)
  const configuredContextWindow = isConfigurableContextModelId(model)
    ? preferences?.status().contextWindowOverrides[model]
    : undefined
  const efforts = MODEL_REASONING[entry.reasoningProfile]
  return {
    provider: PROVIDER_ID,
    id: model,
    name: entry.id === model ? entry.name : model,
    inputModalities: [...entry.inputModalities],
    context: { contextWindow: configuredContextWindow ?? entry.contextWindow },
    defaultMaxTokens: 32_768,
    reasoning: {
      efforts: efforts.map((effort) => ({
        id: ReasoningEffortId(effort),
        name: effort,
      })),
      defaultEffort: ReasoningEffortId(entry.defaultReasoningEffort),
    },
  }
}
