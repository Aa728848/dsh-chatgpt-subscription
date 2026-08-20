import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { CODEX_CHATGPT_PROVIDER_ID } from '../compat.ts'
import { CODEX_MODEL_CATALOG, isConfigurableContextModelId, reasoningEffortsForModel, resolveCodexCatalogEntry } from '../shared/model-catalog.ts'
import type { SubscriptionPreferenceStore } from './preferences.ts'

export const PROVIDER_ID = CODEX_CHATGPT_PROVIDER_ID
export const PROVIDER_NAME = 'Codex（ChatGPT 订阅）' as const

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
  const efforts = reasoningEffortsForModel(model)
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
