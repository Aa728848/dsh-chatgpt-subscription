import { describe, expect, it } from 'vitest'
import {
  compactionRoutesImages,
  compactionSkipReason,
} from '../src/shared/compaction-route.ts'
import {
  installCompactionRoute,
  payloadNeeds,
  withoutOutputCap,
  type CompactionChunk,
  type CompactionModelInfo,
  type CompactionRouteContext,
  type CompactionStreamListener,
  type CompactionStreamOptions,
} from '../src/host/compaction-route/index.ts'

const TARGET = { provider: 'other-line', model: 'cheap-model' }
const SESSION = { provider: 'kimi-code', model: 'k3.1-pro' }

const OK_FINISH: CompactionChunk = { type: 'finish', reason: { kind: 'stop' } }
const TEXT_CHUNK: CompactionChunk = { type: 'text-delta' }

async function* chunks(...items: CompactionChunk[]): AsyncIterable<CompactionChunk> {
  for (const item of items) yield item
}

interface Harness {
  readonly ctx: CompactionRouteContext
  readonly warnings: string[]
  /** The listener the installer registered; throws when none was. */
  listener(): CompactionStreamListener
}

function harness(): Harness {
  let listener: CompactionStreamListener | undefined
  const warnings: string[] = []
  const ctx: CompactionRouteContext = {
    on: (_event, registered) => {
      listener = registered
      return () => { listener = undefined }
    },
    logger: { warn: (message) => warnings.push(message) },
  }
  return {
    ctx,
    warnings,
    listener: () => {
      if (listener === undefined) throw new Error('the router registered no llm/stream listener')
      return listener
    },
  }
}

function compactionOptions(overrides: Partial<CompactionStreamOptions> = {}): CompactionStreamOptions {
  return {
    provider: SESSION.provider,
    model: SESSION.model,
    purpose: 'compaction',
    maxTokens: 65_536,
    sessionId: 'session-1',
    messages: [{ content: [{ type: 'text' }] }],
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<CompactionChunk>): Promise<CompactionChunk[]> {
  const out: CompactionChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

function install(options: {
  target?: { provider: string; model: string } | null
  models?: readonly CompactionModelInfo[]
  attempt?: () => AsyncIterable<CompactionChunk>
  /** The line the setting is scoped to; kimi-code unless a case says otherwise. */
  scope?: string
}) {
  const probe = harness()
  const issued: CompactionStreamOptions[] = []
  const handle = installCompactionRoute(probe.ctx, {
    stream: (request) => {
      issued.push(request)
      return options.attempt === undefined
        ? chunks(TEXT_CHUNK, OK_FINISH)
        : options.attempt()
    },
    listModels: async () => options.models ?? [],
    scopeProvider: options.scope ?? SESSION.provider,
    readTarget: () => options.target ?? null,
  })
  return { probe, handle, issued }
}

describe('compaction capability rules', () => {
  it('treats an undisclosed modality list as unknown rather than negative', () => {
    expect(compactionSkipReason({}, { image: true, video: true })).toBeUndefined()
  })

  it('refuses video on a target that discloses no video support', () => {
    expect(compactionSkipReason({ modalities: ['text', 'image'] }, { image: false, video: true }))
      .toBe('target-accepts-no-video')
  })

  it('accepts video on a target that declares it', () => {
    expect(compactionSkipReason({ modalities: ['text', 'image', 'video'] }, { image: false, video: true }))
      .toBeUndefined()
  })

  it('keeps an image-only payload admissible: the harness projects images for text models', () => {
    expect(compactionSkipReason({ modalities: ['text'] }, { image: true, video: false })).toBeUndefined()
    expect(compactionRoutesImages({ modalities: ['text'] })).toBe(false)
    expect(compactionRoutesImages({ modalities: undefined })).toBe(true)
  })

  it('reads the blocks the payload actually carries', () => {
    expect(payloadNeeds({ messages: [{ content: [{ type: 'text' }] }] })).toEqual({ image: false, video: false })
    expect(payloadNeeds({ messages: [{ content: [{ type: 'image' }] }] })).toEqual({ image: true, video: false })
    expect(payloadNeeds({ messages: [{ content: [{ type: 'video' }] }] })).toEqual({ image: false, video: true })
    expect(payloadNeeds({})).toEqual({ image: false, video: false })
  })

  it('drops the host output cap and keeps everything else', () => {
    const routed = withoutOutputCap(compactionOptions(), TARGET)
    expect(routed).not.toHaveProperty('maxTokens')
    expect(routed.provider).toBe(TARGET.provider)
    expect(routed.model).toBe(TARGET.model)
    expect(routed.messages).toEqual(compactionOptions().messages)
  })
})

describe('compaction routing listener', () => {
  it('leaves a conversation turn alone', async () => {
    const { probe, issued } = install({ target: TARGET })
    const seen = await collect(probe.listener()!(compactionOptions({ purpose: undefined }), () => chunks(OK_FINISH)))
    expect(seen).toEqual([OK_FINISH])
    expect(issued).toHaveLength(0)
  })

  it('leaves a compaction alone until a target is configured', async () => {
    const { probe, issued, handle } = install({ target: null })
    await collect(probe.listener()!(compactionOptions(), () => chunks(OK_FINISH)))
    expect(issued).toHaveLength(0)
    expect(handle?.status()).toBeNull()
  })

  it('leaves a compaction alone when the target is the conversation model', async () => {
    const { probe, issued } = install({ target: SESSION })
    await collect(probe.listener()!(compactionOptions(), () => chunks(OK_FINISH)))
    expect(issued).toHaveLength(0)
  })

  it('re-routes the summary to the configured target without the output cap', async () => {
    const { probe, issued, handle } = install({ target: TARGET })
    const seen = await collect(probe.listener()!(compactionOptions(), () => chunks({ type: 'finish', reason: { kind: 'error' } })))
    expect(issued).toHaveLength(1)
    expect(issued[0]).toMatchObject({ provider: TARGET.provider, model: TARGET.model })
    expect(issued[0]).not.toHaveProperty('maxTokens')
    expect(seen).toEqual([TEXT_CHUNK, OK_FINISH])
    expect(handle?.status()).toMatchObject({ kind: 'routed', provider: TARGET.provider, model: TARGET.model })
  })

  it('falls back to the conversation model when the target finishes with an error', async () => {
    const { probe, handle } = install({
      target: TARGET,
      attempt: () => chunks({ type: 'finish', reason: { kind: 'error' } }),
    })
    const seen = await collect(probe.listener()!(compactionOptions(), () => chunks(OK_FINISH)))
    expect(seen).toEqual([OK_FINISH])
    expect(handle?.status()).toMatchObject({ kind: 'fell-back', reason: 'error', provider: SESSION.provider })
  })

  it('discards a partial summary and falls back', async () => {
    const { probe, handle } = install({
      target: TARGET,
      attempt: () => chunks(TEXT_CHUNK, { type: 'finish', reason: { kind: 'error' } }),
    })
    const seen = await collect(probe.listener()!(compactionOptions(), () => chunks(OK_FINISH)))
    expect(seen).toEqual([OK_FINISH])
    expect(handle?.status()).toMatchObject({ kind: 'fell-back' })
  })

  it('falls back when the target throws before streaming', async () => {
    const { probe, handle } = install({
      target: TARGET,
      attempt: () => { throw new Error('quota exhausted') },
    })
    const seen = await collect(probe.listener()!(compactionOptions(), () => chunks(OK_FINISH)))
    expect(seen).toEqual([OK_FINISH])
    expect(handle?.status()).toMatchObject({ kind: 'fell-back', reason: 'quota exhausted' })
  })

  it('leaves a compaction on another line alone even when a target is configured', async () => {
    // The setting is offered on the kimi-code tab only, so a session on another
    // line must keep its own model: re-routing it would spend a quota its owner
    // never configured anything for.
    const { probe, issued, handle } = install({ target: TARGET })
    const seen = await collect(probe.listener()!(
      compactionOptions({ provider: 'other-line', model: 'other-model' }),
      () => chunks(OK_FINISH),
    ))
    expect(seen).toEqual([OK_FINISH])
    expect(issued).toHaveLength(0)
    expect(handle?.status()).toBeNull()
  })

  it('refuses to send a video payload to a target that discloses no video support', async () => {
    const { probe, issued, handle } = install({
      target: TARGET,
      models: [{ provider: TARGET.provider, id: TARGET.model, inputModalities: ['text', 'image'] }],
    })
    const seen = await collect(probe.listener()!(
      compactionOptions({ messages: [{ content: [{ type: 'video' }] }] }),
      () => chunks(OK_FINISH),
    ))
    expect(seen).toEqual([OK_FINISH])
    expect(issued).toHaveLength(0)
    expect(handle?.status()).toMatchObject({ kind: 'skipped', reason: 'target-accepts-no-video' })
  })

  it('reports image projection when the target cannot take images inline', async () => {
    const { probe, handle } = install({
      target: TARGET,
      models: [{ provider: TARGET.provider, id: TARGET.model, inputModalities: ['text'] }],
    })
    await collect(probe.listener()!(
      compactionOptions({ messages: [{ content: [{ type: 'image' }] }] }),
      () => chunks(OK_FINISH),
    ))
    expect(handle?.status()).toMatchObject({ kind: 'routed', imagesProjected: true })
  })
})
