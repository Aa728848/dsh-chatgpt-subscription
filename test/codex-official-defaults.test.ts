import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'
import { buildResponsesPayload } from '../src/host/responses-mapper.ts'
import { CODEX_MODEL_CATALOG, codexDefaultOutputVerbosity } from '../src/shared/model-catalog.ts'

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

    expect(payload.reasoning).toEqual({ effort: 'high' })
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

    expect(payload.reasoning).toEqual({ effort: 'high', summary: 'detailed' })
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

  it('invents no verbosity for a model the catalog does not record', () => {
    // Silence is not evidence: an unknown id falls back to the default entry's
    // capabilities elsewhere, which must not be read as verbosity support.
    expect(codexDefaultOutputVerbosity('gpt-99-unheard-of')).toBeUndefined()
  })
})
