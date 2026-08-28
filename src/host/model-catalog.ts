import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { CODEX_CHATGPT_PROVIDER_ID } from '../compat.ts'
import { CODEX_MODEL_CATALOG, isConfigurableContextModelId, reasoningEffortsForModel, resolveCodexCatalogEntry } from '../shared/model-catalog.ts'
import type { SubscriptionPreferenceStore } from './preferences.ts'

export const PROVIDER_ID = CODEX_CHATGPT_PROVIDER_ID
export const PROVIDER_NAME = 'Codex（ChatGPT 订阅）' as const

export function listCodexModels(preferences?: SubscriptionPreferenceStore): LlmModelInfo[] {
  const visible = new Set(preferences?.status().visibleModelIds ?? CODEX_MODEL_CATALOG.map(entry => entry.id))
  return CODEX_MODEL_CATALOG.filter(entry => visible.has(entry.id)).map((entry) => ({
    provider: PROVIDER_ID,
    id: entry.id,
    name: entry.name,
    inputModalities: [...entry.inputModalities],
  }))
}

export function resolveCodexModel(model: string, preferences?: SubscriptionPreferenceStore): LlmResolvedModelInfo {
  const entry = resolveCodexCatalogEntry(model)
  const status = preferences?.status()
  const configuredContextWindow = isConfigurableContextModelId(model)
    ? status?.contextWindowOverrides[model]
    : undefined
  const efforts = reasoningEffortsForModel(model)
  const customEffort = status?.subagentReasoningEffort
  const effectiveDefaultEffort = customEffort && (efforts as readonly string[]).includes(customEffort)
    ? customEffort
    : entry.defaultReasoningEffort
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
      defaultEffort: ReasoningEffortId(effectiveDefaultEffort),
    },
  }
}
