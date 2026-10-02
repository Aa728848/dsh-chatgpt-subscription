// @vitest-environment jsdom
/**
 * The Ollama tab counts what each key has spent.
 *
 * These pin the distinction the card depends on: Ollama reports token counts per
 * response but publishes no account quota anywhere, so the card may show what has
 * been consumed and must not imply a remaining balance it cannot know.
 */
import { describe, expect, it } from 'vitest'
import { startChat, type OllamaStreamEvent } from '../src/host/ollama/client.ts'
import { formatTokens } from '../src/client/ollama/OllamaSection.tsx'
import { zh, en } from '../src/client/ollama/locales.ts'

const key = { apiKey: 'sk-test' }

function sse(lines: string[]): Response {
  return new Response(lines.map(line => 'data: ' + line + '\n\n').join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(fetchFn: unknown): Promise<OllamaStreamEvent[]> {
  const call = startChat(fetchFn as typeof fetch, key, 'openai', {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
  })
  const events: OllamaStreamEvent[] = []
  for await (const event of call.events) events.push(event)
  return events
}

describe('Ollama token accounting', () => {
  it('reads the counts Ollama documents on the OpenAI-shaped response', async () => {
    const events = await collect(vi.fn(async () => sse([
      JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 174, completion_tokens: 18 } }),
      '[DONE]',
    ])))
    const usage = events.find(event => event.type === 'usage')
    expect(usage).toBeDefined()
    expect(usage && usage.type === 'usage' && usage.usage).toEqual({ inputTokens: 174, outputTokens: 18 })
  })

  it('also reads the native field names, so the fallback surface is counted too', async () => {
    // The native surface names the same two counts differently, and this line
    // falls back to it. A reader that only knew the OpenAI names would show a
    // permanent zero on exactly the requests that took the fallback path.
    const events = await collect(vi.fn(async () => sse([
      JSON.stringify({ message: { content: 'hi' }, done: true, prompt_eval_count: 42, eval_count: 7 }),
      '[DONE]',
    ])))
    const usage = events.find(event => event.type === 'usage')
    expect(usage && usage.type === 'usage' && usage.usage).toEqual({ inputTokens: 42, outputTokens: 7 })
  })

  it('reports no usage for a content chunk, so a turn is not counted twice', async () => {
    const events = await collect(vi.fn(async () => sse([
      JSON.stringify({ choices: [{ delta: { content: 'one' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'two' } }] }),
      '[DONE]',
    ])))
    expect(events.filter(event => event.type === 'usage')).toHaveLength(0)
  })

  it('ignores a negative or non-finite count rather than lowering a total', async () => {
    const events = await collect(vi.fn(async () => sse([
      JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: -5, completion_tokens: Number.NaN } } as never),
      '[DONE]',
    ])))
    // Malformed numbers must not become a negative contribution to a running total.
    const usage = events.find(event => event.type === 'usage')
    expect(usage === undefined || (usage.type === 'usage' && usage.usage.inputTokens === 0)).toBe(true)
  })
})

describe('Ollama card wording', () => {
  it('cites the upstream issues rather than claiming a quota was checked for', () => {
    // The previous wording asserted an absence as if it were verified. These
    // issues ARE the evidence, so the card points at them.
    expect(zh.limitUsage).toContain('#15132')
    expect(en.limitUsage).toContain('#15663')
  })

  it('says consumed, never remaining — nothing can know a balance', () => {
    // Scoped to the USAGE labels only. The limits section legitimately says it
    // cannot show what is left, and matching that string would fail for the right
    // reason while hiding the real check.
    expect(zh.usageTitle).toContain('消耗')
    expect(en.usageTitle).toContain('Consumed')
    for (const label of [zh.usageTitle, zh.usageInput, zh.usageOutput, zh.usageRequests, zh.usageHint]) {
      expect(/剩余|remain/i.test(label)).toBe(false)
    }
    for (const label of [en.usageTitle, en.usageInput, en.usageOutput, en.usageRequests, en.usageHint]) {
      expect(/remaining|left|balance/i.test(label)).toBe(false)
    }
  })
})

describe('formatTokens', () => {
  it('stays readable as a running total grows', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_500)).toBe('1.5K')
    expect(formatTokens(250_000)).toBe('250K')
    expect(formatTokens(2_400_000)).toBe('2.4M')
  })

  it('refuses to render a number it cannot trust', () => {
    expect(formatTokens(Number.NaN)).toBe('—')
    expect(formatTokens(-1)).toBe('—')
  })
})

import { vi } from 'vitest'