import { describe, expect, it, vi } from 'vitest'
import { fetchWithContextBudgetRecovery } from '../src/host/common/context-budget-fetch.ts'

const diagnostic = "This model's maximum context length is 1048576 tokens. However, you requested 1059229 tokens (803229 in the messages, 256000 in the completion). Please reduce the length of the messages or completion."
const refused = (message = diagnostic, status = 400) => new Response(JSON.stringify({ error: { message } }), { status })

describe('provider-confirmed output budget recovery', () => {
  it.each(['max_tokens', 'max_completion_tokens', 'max_output_tokens'])(
    'recovers the screenshot budget by reducing %s without changing history', async key => {
      const body = { model: 'test', messages: [{ role: 'user', content: 'complete history' }], tools: [{ name: 'read' }], [key]: 256000 }
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(refused()).mockResolvedValueOnce(new Response('summary'))
      const signal = new AbortController().signal
      const response = await fetchWithContextBudgetRecovery(fetchFn)('https://provider.test', {
        method: 'POST', body: JSON.stringify(body), headers: { authorization: 'test' }, signal,
      })
      expect(response.ok).toBe(true)
      expect(fetchFn).toHaveBeenCalledTimes(2)
      const retry = JSON.parse(fetchFn.mock.calls[1]![1]!.body as string)
      expect(retry[key]).toBe(244323)
      expect({ ...retry, [key]: 256000 }).toEqual(body)
      expect(fetchFn.mock.calls[1]![1]!.signal).toBe(signal)
      expect(fetchFn.mock.calls[1]![1]!.headers).toEqual({ authorization: 'test' })
    })

  it('never retries more than once and leaves the final refusal readable', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => refused())
    const response = await fetchWithContextBudgetRecovery(fetchFn)('https://provider.test', {
      method: 'POST', body: JSON.stringify({ max_tokens: 256000 }),
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(await response.json()).toEqual({ error: { message: diagnostic } })
  })

  it.each([401, 403, 413, 429, 500])('does not retry HTTP %s', async status => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(refused(diagnostic, status))
    const response = await fetchWithContextBudgetRecovery(fetchFn)('https://provider.test', { body: JSON.stringify({ max_tokens: 256000 }) })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(await response.text()).toContain('maximum context length')
  })

  it.each([
    { message: 'context_length_exceeded', body: { max_tokens: 256000 } },
    { message: diagnostic, body: {} }, // Codex: no supported wire output control.
    { message: diagnostic, body: { max_tokens: 65536 } }, // Upstream ignored the requested cap.
    { message: diagnostic.replace('803229', '1100000'), body: { max_tokens: 256000 } },
    { message: diagnostic.replace('1059229', '999999'), body: { max_tokens: 256000 } },
    { message: diagnostic, body: { max_tokens: 256000, max_output_tokens: 256000 } },
  ])('does not guess a budget from ambiguous/inconsistent evidence %#', async ({ message, body }) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(refused(message))
    const response = await fetchWithContextBudgetRecovery(fetchFn)('https://provider.test', { body: JSON.stringify(body) })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(await response.text()).toContain(message)
  })

  it('does not scan echoed requests for recovery instructions', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'invalid schema' }, request: { message: diagnostic } }), { status: 400 }))
    await fetchWithContextBudgetRecovery(fetchFn)('https://provider.test', { body: JSON.stringify({ max_tokens: 256000 }) })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it.each([422, 400])('accepts a structured counted rejection with status %s', async status => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(refused(diagnostic, status)).mockResolvedValueOnce(new Response('ok'))
    expect((await fetchWithContextBudgetRecovery(fetchFn)('https://provider.test', { body: JSON.stringify({ max_tokens: 256000 }) })).ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('does not lower max_tokens below an explicit thinking budget', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(refused())
    await fetchWithContextBudgetRecovery(fetchFn)('https://provider.test', {
      body: JSON.stringify({ max_tokens: 256000, thinking: { type: 'enabled', budget_tokens: 250000 } }),
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('does not consume or retry a successful stream carrying an in-band error', async () => {
    const response = new Response('data: ' + JSON.stringify({ error: { message: diagnostic } }))
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response)
    expect(await fetchWithContextBudgetRecovery(fetchFn)('https://provider.test', { body: JSON.stringify({ max_tokens: 256000 }) })).toBe(response)
    expect(response.bodyUsed).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('bounds diagnostic reads and preserves an oversized refusal for its owner', async () => {
    const content = JSON.stringify({ error: { message: 'x'.repeat(17000) + diagnostic } })
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(content, { status: 400 }))
    const response = await fetchWithContextBudgetRecovery(fetchFn)('https://provider.test', { body: JSON.stringify({ max_tokens: 256000 }) })
    expect(await response.text()).toBe(content)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('honors cancellation before a corrected request', async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(); return refused() })
    await expect(fetchWithContextBudgetRecovery(fetchFn)('https://provider.test', {
      body: JSON.stringify({ max_tokens: 256000 }), signal: controller.signal,
    })).rejects.toThrow()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
