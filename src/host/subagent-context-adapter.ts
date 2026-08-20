import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * A private provider route that delegates streaming to a selected registered
 * provider while exposing a user-selected effective context window to DSH.
 */
export class SubagentContextAdapter extends LlmAdapter {
  static readonly provider = 'dsh-subagent-model-override'

  constructor(
    private readonly llm: Context['llm'],
    private readonly selection: () => { provider: string; model: string; contextWindow: number },
  ) {
    super()
  }

  providerInfo(): { id: string; name: string } {
    return { id: SubagentContextAdapter.provider, name: 'Subagent model override' }
  }

  async listModels(): Promise<readonly LlmModelInfo[]> {
    const selected = this.selection()
    return [{ provider: SubagentContextAdapter.provider, id: selected.model, name: selected.model }]
  }

  async resolveModel(_provider: string, _model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const selected = this.selection()
    const resolved = await this.llm.resolveModelInfo(selected.provider, selected.model, signal)
    return {
      ...resolved,
      provider: SubagentContextAdapter.provider,
      id: selected.model,
      context: { contextWindow: selected.contextWindow },
    }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const selected = this.selection()
    const { preparedCall: _preparedCall, ...forwarded } = options as GenerateOptions & { preparedCall?: unknown }
    return this.llm.stream({ ...forwarded, provider: selected.provider, model: selected.model })
  }
}
