import { describe, expect, it } from 'vitest'
import { parseResponsesStream } from '../src/host/responses-client.ts'
import { closeStream, createStreamState, processStreamLine } from '../src/host/workbuddy/mapper.ts'

async function usage(response: unknown): Promise<{ inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }> {
  const body = 'data: ' + JSON.stringify({ type: 'response.completed', response: { usage: response } }) + '\n\n'
  const chunks = []
  for await (const chunk of parseResponsesStream(new Response(body))) chunks.push(chunk)
  const found = chunks.find(chunk => chunk.type === 'usage')
  return found === undefined ? { inputTokens: 0 } : (found as { usage: typeof found extends never ? never : any }).usage
}

describe('cache accounting stays disjoint', () => {
  it('reports codex cache writes apart from reads and from plain input', async () => {
    const reported = await usage({
      input_tokens: 1000,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 },
    })

    // 1000 total input = 200 plain + 700 read + 100 written.
    expect(reported).toEqual({ inputTokens: 200, cacheReadTokens: 700, cacheWriteTokens: 100, outputTokens: 20 })
  })

  it('does not invent a cache write when the service omits the field', async () => {
    const reported = await usage({ input_tokens: 100, input_tokens_details: { cached_tokens: 40 } })

    expect(reported).toMatchObject({ inputTokens: 60, cacheReadTokens: 40 })
    expect('cacheWriteTokens' in reported).toBe(false)
  })

  it('reports workbuddy cache writes as their own bucket', () => {
    const state = createStreamState()
    const out = [
      ...processStreamLine(
        'data: ' + JSON.stringify({
          usage: {
            prompt_tokens: 500,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 50 },
          },
        }),
        state,
      ),
      ...closeStream(state),
    ]

    const found = out.find(chunk => chunk.type === 'usage') as { usage: Record<string, number> } | undefined
    expect(found?.usage).toMatchObject({ inputTokens: 250, cacheReadTokens: 200, cacheWriteTokens: 50 })
  })
})