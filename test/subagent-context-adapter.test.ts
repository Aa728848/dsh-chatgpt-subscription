import { describe, expect, it, vi } from 'vitest'
import { SubagentContextAdapter } from '../src/host/subagent-context-adapter.ts'

describe('SubagentContextAdapter', () => {
  it('exposes the selected effective context and delegates the actual model stream', async () => {
    const stream = vi.fn(() => ({ async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'completed' } } } }))
    const llm = {
      resolveModelInfo: vi.fn(async () => ({
        provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash',
        context: { contextWindow: 128_000 },
        reasoning: { efforts: [{ id: 'high', name: 'high' }], defaultEffort: 'high' },
      })),
      stream,
    }
    const adapter = new SubagentContextAdapter(llm as never, () => ({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 96_000,
    }))
    await expect(adapter.resolveModel(SubagentContextAdapter.provider, 'deepseek-v4-flash')).resolves.toMatchObject({
      provider: SubagentContextAdapter.provider,
      id: 'deepseek-v4-flash',
      context: { contextWindow: 96_000 },
      reasoning: { efforts: [{ id: 'high' }] },
    })
    const output = []
    for await (const chunk of adapter.stream({ provider: SubagentContextAdapter.provider, model: 'deepseek-v4-flash', messages: [] } as never)) output.push(chunk)
    expect(output).toHaveLength(1)
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }))
  })
})
