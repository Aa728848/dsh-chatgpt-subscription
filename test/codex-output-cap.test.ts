import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'
import { buildResponsesPayload } from '../src/host/responses-mapper.ts'

const unusedAttachments = () => ({
  readImage: async () => { throw new Error('unused') },
})

// The Responses request body IS the contract with the subscription backend, and
// that backend rejects unknown parameters instead of ignoring them. This pins the
// whole request against the class of bug that has now happened twice: a field
// added for a reason that expired is not a no-op, it is a 400 on every turn.
// First /alpha/search (issue #28), then the chat path (issue #29).
describe('codex responses request body', () => {
  const build = (overrides: Partial<GenerateOptions>) => buildResponsesPayload(
    { provider: 'codex-chatgpt', model: 'gpt-6-sol', messages: [], ...overrides } as unknown as GenerateOptions,
    unusedAttachments(),
  )

  it('never sends max_output_tokens, even when the caller asks for one', async () => {
    // Regression, named directly so the failure says what broke: the backend
    // answers 400 Unsupported parameter: max_output_tokens on the accounts in
    // #29 (gpt-6-sol / gpt-6.1-sol), and the official CLI's ResponsesApiRequest
    // struct has no such field at all. Removing the field restored the
    // conversation on the affected account with nothing else changed.
    const withoutRequest = await build({})
    const withRequest = await build({ maxTokens: 4096 })

    for (const payload of [withoutRequest, withRequest]) {
      expect(
        payload,
        'the subscription Responses endpoint rejects max_output_tokens with a 400 '
          + '(Unsupported parameter). Do not add an output cap to this request; the '
          + 'service applies its own default. The adapter defaultMaxTokens is a local '
          + 'compaction reservation and must not become a wire field.',
      ).not.toHaveProperty('max_output_tokens')
    }
  })

  it('still sends the fields this endpoint does require', async () => {
    // ...so the removal above cannot be satisfied by emptying the body.
    const payload = await build({})

    expect(payload.model).toBe('gpt-6-sol')
    expect(payload.stream).toBe(true)
    expect(payload.store).toBe(false)
    expect(payload.include).toEqual(['reasoning.encrypted_content'])
    expect(Array.isArray(payload.input)).toBe(true)
  })
})
