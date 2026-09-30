import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'
import { buildResponsesPayload } from '../src/host/responses-mapper.ts'
import { codexModelMaxTokens } from '../src/shared/model-catalog.ts'

const unusedAttachments = () => ({
  readImage: async () => { throw new Error('unused') },
})

describe('codex output cap', () => {
  it.each(['gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.5'])('always sends the model ceiling for %s', async (model) => {
    // Regression: the catalog DECLARED a ceiling (and resolveCodexModel reported
    // it as defaultMaxTokens) while the request never carried it, so the
    // backend applied a default this line could neither predict nor report — a
    // turn that hit it looked like an ordinary short answer.
    const payload = await buildResponsesPayload(
      { provider: 'codex-chatgpt', model, messages: [] } as unknown as GenerateOptions,
      unusedAttachments(),
    )

    expect(payload.max_output_tokens).toBe(codexModelMaxTokens(model))
  })

  it('sends a smaller request when the caller asks for one', async () => {
    const payload = await buildResponsesPayload(
      { provider: 'codex-chatgpt', model: 'gpt-6-sol', maxTokens: 4096, messages: [] } as unknown as GenerateOptions,
      unusedAttachments(),
    )

    expect(payload.max_output_tokens).toBe(4096)
  })

  it('never sends a cap the model does not accept', async () => {
    // A caller (or a stale setting) asking for more than the model supports
    // must be clamped down, not passed through: that is the request the backend
    // rejects outright. Same guard as the antigravity mapper.
    const payload = await buildResponsesPayload(
      { provider: 'codex-chatgpt', model: 'gpt-5.5', maxTokens: 1_000_000, messages: [] } as unknown as GenerateOptions,
      unusedAttachments(),
    )

    expect(payload.max_output_tokens).toBe(codexModelMaxTokens('gpt-5.5'))
  })

  it('sends the cap for a model the shipped table does not know', async () => {
    // A model only the live listing named still gets a cap rather than falling
    // through to an unsent field; the table's pre-GPT-6 default applies.
    const payload = await buildResponsesPayload(
      { provider: 'codex-chatgpt', model: 'gpt-99-unheard-of', messages: [] } as unknown as GenerateOptions,
      unusedAttachments(),
    )

    expect(payload.max_output_tokens).toBe(codexModelMaxTokens('gpt-99-unheard-of'))
  })
})