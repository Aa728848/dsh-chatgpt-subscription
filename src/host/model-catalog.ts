import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'

export const PROVIDER_ID = 'codex-chatgpt' as const
export const PROVIDER_NAME = 'Codex（ChatGPT 订阅）' as const

const MODEL_IDS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.2',
] as const

type ModelId = typeof MODEL_IDS[number]

const STANDARD_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const
const GPT_56_REASONING_EFFORTS = [...STANDARD_REASONING_EFFORTS, 'max'] as const

const MODEL_REASONING = {
  'gpt-5.6-sol': { efforts: GPT_56_REASONING_EFFORTS, defaultEffort: 'medium' },
  'gpt-5.6-terra': { efforts: GPT_56_REASONING_EFFORTS, defaultEffort: 'medium' },
  'gpt-5.6-luna': { efforts: GPT_56_REASONING_EFFORTS, defaultEffort: 'medium' },
  'gpt-5.5': { efforts: STANDARD_REASONING_EFFORTS, defaultEffort: 'medium' },
  'gpt-5.4': { efforts: STANDARD_REASONING_EFFORTS, defaultEffort: 'none' },
  'gpt-5.4-mini': { efforts: STANDARD_REASONING_EFFORTS, defaultEffort: 'none' },
  'gpt-5.2': { efforts: STANDARD_REASONING_EFFORTS, defaultEffort: 'none' },
} as const satisfies Record<ModelId, {
  efforts: readonly string[]
  defaultEffort: string
}>

export function listCodexModels(): LlmModelInfo[] {
  return MODEL_IDS.map((id) => ({
    provider: PROVIDER_ID,
    id,
    name: id,
    inputModalities: ['text', 'image'],
  }))
}

export function resolveCodexModel(model: string): LlmResolvedModelInfo {
  const reasoning = MODEL_REASONING[model as ModelId] ?? MODEL_REASONING['gpt-5.6-sol']
  return {
    provider: PROVIDER_ID,
    id: model,
    name: model,
    inputModalities: ['text', 'image'],
    context: { contextWindow: 272_000 },
    defaultMaxTokens: 32_768,
    reasoning: {
      efforts: reasoning.efforts.map((effort) => ({
        id: ReasoningEffortId(effort),
        name: effort,
      })),
      defaultEffort: ReasoningEffortId(reasoning.defaultEffort),
    },
  }
}
