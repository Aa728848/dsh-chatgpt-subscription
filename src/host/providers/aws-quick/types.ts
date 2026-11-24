import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { AwsQuickEffort, AwsQuickModelDto } from '../../../shared/aws-quick-contracts.ts'

export const PROVIDER_ID = 'aws-quick'
export const PROVIDER_NAME = 'AWS Quick'
/** Quick publishes no model window. This is a conservative DSH budget, not an upstream claim. */
export const QUICK_CONTEXT_WINDOW = 131_072
export const QUICK_MODELS: AwsQuickModelDto[] = [
  { id: 'quick-fast', name: 'Quick Fast', mode: 'fast', efforts: ['off'], contextWindow: QUICK_CONTEXT_WINDOW },
  { id: 'quick-balanced', name: 'Quick Balanced', mode: 'balanced', efforts: ['off', 'low', 'medium', 'high'], contextWindow: QUICK_CONTEXT_WINDOW },
  { id: 'quick-smart', name: 'Quick Smart', mode: 'smart', efforts: ['off', 'low', 'medium', 'high'], contextWindow: QUICK_CONTEXT_WINDOW },
]

export function findQuickModel(id: string): AwsQuickModelDto {
  return QUICK_MODELS.find((model) => model.id === id) ?? {
    id, name: id, mode: 'balanced', efforts: ['off', 'low', 'medium', 'high'], contextWindow: QUICK_CONTEXT_WINDOW,
  }
}

export function toQuickModelInfo(provider: string, model: AwsQuickModelDto): LlmModelInfo {
  return { provider, id: model.id, name: model.name, inputModalities: ['text', 'image'] }
}

export function toQuickResolvedModel(provider: string, model: AwsQuickModelDto): LlmResolvedModelInfo {
  return {
    ...toQuickModelInfo(provider, model),
    context: { contextWindow: model.contextWindow },
    reasoning: {
      efforts: model.efforts.map((id) => ({ id: id as never, name: id })),
      defaultEffort: (model.efforts.includes('medium') ? 'medium' : model.efforts[0]) as never,
    },
  }
}

export function normalizeQuickEffort(value: unknown): AwsQuickEffort | undefined {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high' ? value : undefined
}
