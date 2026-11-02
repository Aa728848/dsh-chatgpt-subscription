import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'
import { buildResponsesPayload } from '../src/host/responses-mapper.ts'
import { CODEX_MODEL_CATALOG, codexDefaultOutputVerbosity, codexModelUsesResponsesLite } from '../src/shared/model-catalog.ts'

const unusedAttachments = () => ({
  readImage: async () => { throw new Error('unused') },
})

const payloadFor = (options: Record<string, unknown>) => buildResponsesPayload(
  { provider: 'codex-chatgpt', model: 'gpt-6-sol', messages: [], ...options } as unknown as GenerateOptions,
  unusedAttachments(),
)

// Both defaults below are read from the official catalog, and the official
// client's own behaviour, rather than chosen here. The catalog in question is
// `codex-rs/models-manager/models.json` (also served as the account-scoped
// `GET /backend-api/codex/models` listing): every model it lists declares
// `default_reasoning_summary: "none"` and `default_verbosity: "low"`.
describe('official Codex request defaults', () => {
  it('omits the reasoning summary the provider default does not ask for', async () => {
    // `summary` is omitted, not sent as "none"/"auto". Asking for "auto" is
    // what this line used to do, and it buys tokens the official client never
    // spends: the summary is generated output, billed with the answer.
    const payload = await payloadFor({ reasoningEffort: 'high' })

    // The model is a Lite one, so the block also asks for the whole
    // conversation as reasoning context.
    expect(payload.reasoning).toEqual({ effort: 'high', context: 'all_turns' })
  })

  it('still sends a summary the user explicitly chose', async () => {
    // Only the default is aligned; an explicit choice keeps its meaning.
    const payload = await buildResponsesPayload(
      { provider: 'codex-chatgpt', model: 'gpt-6-sol', reasoningEffort: 'high', messages: [] } as unknown as GenerateOptions,
      unusedAttachments(),
      {},
      null,
      false,
      'detailed',
    )

    expect(payload.reasoning).toEqual({ effort: 'high', summary: 'detailed', context: 'all_turns' })
  })

  it('sends the catalog default verbosity rather than omitting the field', async () => {
    // Omitting `text` is not "follow the provider": the server then applies its
    // own implicit medium, so the user silently gets longer, costlier answers
    // than the official client produces for the same prompt.
    const payload = await payloadFor({})

    expect(payload.text).toEqual({ verbosity: 'low' })
  })

  it('declares verbosity support for every model the official catalog lists', () => {
    // A model added to this table without the flag would lose the field and
    // silently drift back to the server default.
    const gpt6 = CODEX_MODEL_CATALOG.filter((entry) => entry.reasoningProfile === 'gpt-6')

    expect(gpt6.length).toBeGreaterThan(0)
    for (const entry of gpt6) {
      expect(codexDefaultOutputVerbosity(entry.id), entry.id).toBe('low')
    }
  })

  it('carries the base instructions as a developer message instead of a top-level field', async () => {
    // The official request has no `instructions` field any more: the base
    // instructions are an ordinary input item at the head of the conversation,
    // marked as the model's own instructions so the backend can tell them apart
    // from any other developer message.
    const payload = await buildResponsesPayload(
      { provider: 'codex-chatgpt', model: 'gpt-6-sol', system: 'Be precise.', messages: [] } as unknown as GenerateOptions,
      unusedAttachments(),
    )
    const message = payload.input.find(item => item.type === 'message')

    expect(payload).not.toHaveProperty('instructions')
    expect(message).toMatchObject({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Be precise.' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    })
    expect(String(message?.id)).toMatch(/^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('states the catalog facts the official 0.166.0 catalog states', () => {
    // The shipped table is what answers when the live listing cannot be read, so
    // it has to carry the official facts: the window each model really has and
    // the reasoning level it starts at.
    for (const [model, contextWindow, defaultEffort] of [
      ['gpt-6-astra', 272_000, 'low'],
      ['gpt-6.1-sol', 272_000, 'low'],
      ['gpt-6.1-terra', 500_000, 'low'],
      ['gpt-6-sol', 272_000, 'medium'],
      ['gpt-6-luna', 272_000, 'medium'],
      ['gpt-5.6-sol', 272_000, 'low'],
    ] as const) {
      const entry = CODEX_MODEL_CATALOG.find(candidate => candidate.id === model)

      expect(entry, model).toBeDefined()
      expect(entry?.contextWindow, model).toBe(contextWindow)
      expect(entry?.defaultReasoningEffort, model).toBe(defaultEffort)
    }
  })

  it('marks the Lite models the official catalog marks, and only those', () => {
    // Every model the official 0.166.0 catalog lists but 5.5 speaks the Lite
    // protocol.
    for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(codexModelUsesResponsesLite(model), model).toBe(true)
    }
    expect(codexModelUsesResponsesLite('gpt-5.5')).toBe(false)
    // A model nothing states a protocol for is not Lite.
    expect(codexModelUsesResponsesLite('gpt-99-unheard-of')).toBe(false)
  })
  it('invents no verbosity for a model the catalog does not record', () => {
    // Silence is not evidence: an unknown id falls back to the default entry's
    // capabilities elsewhere, which must not be read as verbosity support.
    expect(codexDefaultOutputVerbosity('gpt-99-unheard-of')).toBeUndefined()
  })
})
