import { readFileSync } from 'node:fs'
import { adoptSessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../src/host/common/llm-compat.ts'
import {
  DEFAULT_GUARD_OPTIONS,
  RESUME_HINT,
  RESUME_HINT_STRICT,
  collapseScore,
  installReasoningCollapseGuard,
  resolveGuardOptions,
  type GuardAgentLike,
  type GuardChunk,
  type GuardOptions,
  type GuardStreamListener,
  type GuardStreamOptions,
  type ReasoningCollapseContext,
} from '../src/host/reasoning-collapse-guard/index.ts'

/** The `notice` summary the guard stamps on every resume message. */
const RESUME_SUMMARY = 'Reasoning collapsed; the attempt was stopped and resumed.'

/**
 * Add the random identity the message factory assigns, so an assertion can state
 * the whole message without pinning a generated uuid.
 */
function identify(message: Record<string, unknown>): Record<string, unknown> {
  return { ...message, id: expect.any(String) }
}

const FIXTURE_DIR = new URL('./fixtures/reasoning-collapse/', import.meta.url)

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIR), 'utf8')
}

/** Slice text into the deltas a stream would deliver. */
function slices(text: string, size = 64): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

const COLLAPSED = fixture('collapsed-reasoning.txt')
const HEALTHY_LONG = fixture('healthy-long-reasoning.txt')
const HEALTHY_PROSE = fixture('healthy-prose-reasoning.txt')
const HEALTHY_ENUMERATIVE = fixture('healthy-enumerative-reasoning.txt')
const SHORT_REPETITIVE = fixture('short-repetitive-reasoning.txt')

interface RecordingAgent extends GuardAgentLike {
  readonly cancels: Array<{ cause: unknown; options: unknown }>
  readonly steers: unknown[]
}

function recordingAgent(): RecordingAgent {
  const cancels: Array<{ cause: unknown; options: unknown }> = []
  const steers: unknown[] = []
  return {
    cancels,
    steers,
    cancel: (cause, options) => { cancels.push({ cause, options }) },
    steer: (message) => { steers.push(message) },
  }
}

interface Harness {
  readonly ctx: ReasoningCollapseContext
  readonly warnings: string[]
  readonly source: () => AsyncIterable<GuardChunk>
  /** Dispatch one `llm/stream` waterfall the way the harness runtime does. */
  readonly dispatch: (options: GuardStreamOptions) => AsyncIterable<GuardChunk>
  /** Number of listeners still registered on each event. */
  readonly listeners: () => { stream: number; agent: number }
}

function harness(script: GuardChunk[][], agent?: RecordingAgent): Harness {
  const queue = [...script]
  const warnings: string[] = []
  const streams = new Set<GuardStreamListener>()
  const created = new Set<(payload: { agent: unknown }) => void>()
  const ctx: ReasoningCollapseContext = {
    on(event, listener) {
      if (event === 'llm/stream') {
        const typed = listener as GuardStreamListener
        streams.add(typed)
        return () => { streams.delete(typed) }
      }
      const typed = listener as (payload: { agent: unknown }) => void
      created.add(typed)
      // The harness reports the agent before any plugin subscribes, so a
      // `agent/created` listener registered afterwards still receives it.
      if (agent !== undefined) typed({ agent })
      return () => { created.delete(typed) }
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
  }
  // One scripted response per `next` *call*, not per stream: the guard invokes
  // `next()` itself, and a factory that shifted the queue would hand the
  // iterator a different (empty) response than the guard scored.
  const source = (): AsyncIterable<GuardChunk> => {
    const chunks = queue.shift() ?? []
    return (async function* () { yield* chunks })()
  }
  // The runtime enters the waterfall itself; a listener either calls `next()`
  // or short-circuits the chain, exactly like `ctx.waterfall(ctx, 'llm/stream', …)`.
  const dispatch = (options: GuardStreamOptions): AsyncIterable<GuardChunk> => {
    const listeners = [...streams]
    const terminal = (): AsyncIterable<GuardChunk> => source()
    let next = terminal
    for (const listener of listeners.reverse()) {
      const downstream = next
      next = () => listener(options, downstream)
    }
    return next()
  }
  return {
    ctx,
    warnings,
    source,
    dispatch,
    listeners: () => ({ stream: streams.size, agent: created.size }),
  }
}

/** A complete reasoning block followed by an answer and a finish. */
function reasoningChunks(text: string): GuardChunk[] {
  const chunks: GuardChunk[] = [{ type: 'block-start' }]
  for (const part of slices(text)) chunks.push({ type: 'reasoning-delta', text: part })
  chunks.push({ type: 'text-delta', text: 'answer' }, { type: 'finish' })
  return chunks
}

async function drain(stream: AsyncIterable<GuardChunk>): Promise<GuardChunk[]> {
  const out: GuardChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/**
 * Run one scripted response through the guarded stream.
 *
 * The real runtime hands the guard a `next` that starts the model stream, and
 * the guard calls it once per attempt. The harness therefore dequeues one
 * response per `run`, and `next` replays that same response on any repeat call.
 */
async function run(test: Harness, options: GuardStreamOptions): Promise<GuardChunk[]> {
  return drain(test.dispatch(options))
}

/** Let the queued resume microtask run. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
describe('collapseScore', () => {
  it('keeps healthy real-world reasoning far below the default threshold', () => {
    for (const [label, text] of [
      ['healthy-long', HEALTHY_LONG],
      ['healthy-prose', HEALTHY_PROSE],
      ['healthy-enumerative', HEALTHY_ENUMERATIVE],
    ] as const) {
      expect(collapseScore(text, 8), label).toBeLessThan(0.6)
    }
  })

  it('scores the real collapsed stream above the default threshold', () => {
    expect(collapseScore(COLLAPSED, 8)).toBeGreaterThan(0.85)
  })

  it('separates the collapsed fixture from every healthy fixture', () => {
    const worstHealthy = Math.max(
      collapseScore(HEALTHY_LONG, 8),
      collapseScore(HEALTHY_PROSE, 8),
      collapseScore(HEALTHY_ENUMERATIVE, 8),
      collapseScore(SHORT_REPETITIVE, 8),
    )
    expect(collapseScore(COLLAPSED, 8)).toBeGreaterThan(worstHealthy * 2)
  })

  it('is zero for a window shorter than the n-gram', () => {
    expect(collapseScore('short', 8)).toBe(0)
  })
})

describe('option validation', () => {
  it('fills in the shipped defaults', () => {
    expect(resolveGuardOptions()).toEqual({ ...DEFAULT_GUARD_OPTIONS, now: expect.any(Function) })
  })

  it('keeps an explicit override', () => {
    expect(resolveGuardOptions({ threshold: 0.5 }).threshold).toBe(0.5)
  })

  it('fails loud on a threshold outside (0, 1)', () => {
    expect(() => resolveGuardOptions({ threshold: 0 })).toThrow(/invalid threshold/)
    expect(() => resolveGuardOptions({ threshold: 1 })).toThrow(/invalid threshold/)
  })

  it('fails loud when minWindowChars exceeds windowChars', () => {
    expect(() => resolveGuardOptions({ windowChars: 100, minWindowChars: 200 })).toThrow(/must not exceed windowChars/)
  })

  it('fails loud when the window is smaller than the n-gram', () => {
    expect(() => resolveGuardOptions({ windowChars: 4, ngramSize: 8, minWindowChars: 4 })).toThrow(/smaller than ngramSize/)
  })

  it('fails loud on a non-positive break budget', () => {
    expect(() => resolveGuardOptions({ maxBreaksPerTurn: 0 })).toThrow(/invalid maxBreaksPerTurn/)
  })

  it('fails loud on a negative cooldown', () => {
    expect(() => resolveGuardOptions({ cooldownMs: -1 })).toThrow(/invalid cooldownMs/)
  })

  it('fails loud on a non-string model list', () => {
    expect(() => resolveGuardOptions({ includeModels: [1] as unknown as string[] })).toThrow(/array of strings/)
  })
})
describe('detection', () => {
  it('stops a collapsed stream and records the abort', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    const chunks = await run(test, { model: 'test-model', signal: new AbortController().signal })

    // The stream ends before its finish chunk: the truncated attempt is what
    // stops the runaway, not the output-token ceiling.
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(false)
    expect(agent.cancels).toHaveLength(1)
    expect(agent.cancels[0]!.cause).toEqual({ kind: 'hook', reason: 'reasoning-collapse-guard' })
    expect(agent.cancels[0]!.options).toEqual({ keepInbox: true })
    expect(test.warnings.join(' ')).toContain('stopped degenerate reasoning')
  })

  it('queues exactly one resume for the aborted turn', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    await run(test, { model: 'm', signal: new AbortController().signal })
    await settle()

    expect(agent.steers).toHaveLength(1)
    expect(agent.steers[0]).toEqual(identify({
      role: 'user',
      content: [{ type: 'text', text: RESUME_HINT }],
      source: {
        kind: PLUGIN_MESSAGE_SOURCE_KIND,
        form: 'notice',
        summary: RESUME_SUMMARY,
      },
    }))
  })

  it('queues a resume the harness session accepts, so a collapse resumes instead of poisoning the log', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    await run(test, { model: 'm', signal: new AbortController().signal })
    await settle()

    // The guard's own steer call cannot fail silently: the harness validates
    // every admitted message in `session.append` and throws before logging a
    // message that is not identified, has no source, or has the wrong role. The
    // pre-fix literal `{ role: 'user', content }` was refused exactly there —
    // after the abort had already been taken — which ended the turn with a
    // repairable splice violation and no answer. Reproduce that boundary
    // directly instead of asserting the shape the guard happens to build.
    const resume = agent.steers[0] as Record<string, unknown>
    expect(() => adoptSessionEvent({
      type: 'user/message',
      seq: 0 as never,
      time: 0,
      // The harness appends an admitted prompt exactly this way.
      surfaceOp: 'append',
      data: resume as never,
    } as never)).not.toThrow()
  })

  it('defers the resume past the abort, so a turn unwinding cannot discard it', async () => {
    const order: string[] = []
    const agent: RecordingAgent = {
      cancels: [],
      steers: [],
      cancel: (cause, options) => { order.push('cancel'); agent.cancels.push({ cause, options }) },
      steer: (message) => { order.push('steer'); agent.steers.push(message) },
    }
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    const iterator = test.dispatch({ model: 'm', signal: new AbortController().signal })

    await drain(iterator)
    await settle()

    // The abort is raised while the stream is still being drained; the resume is
    // queued on a microtask and therefore lands after it.
    expect(order).toEqual(['cancel', 'steer'])
  })

  it('escalates the resume text on a second break in one turn', async () => {
    const agent = recordingAgent()
    const signal = new AbortController().signal
    const test = harness([reasoningChunks(COLLAPSED), reasoningChunks(COLLAPSED)], agent)
    // A zero cooldown lets the two attempts of one turn each be judged; the
    // shipped default would treat the second as part of the first incident.
    installReasoningCollapseGuard(test.ctx, { cooldownMs: 0, now: () => 0 })

    await run(test, { model: 'm', signal })
    await settle()
    await run(test, { model: 'm', signal })
    await settle()

    expect(agent.cancels).toHaveLength(2)
    expect(agent.steers.at(-1)).toEqual(identify({
      role: 'user',
      content: [{ type: 'text', text: RESUME_HINT_STRICT }],
      source: {
        kind: PLUGIN_MESSAGE_SOURCE_KIND,
        form: 'notice',
        summary: RESUME_SUMMARY,
      },
    }))
  })

  it('stops resuming once the break budget is spent', async () => {
    const agent = recordingAgent()
    const signal = new AbortController().signal
    const script = [1, 2, 3, 4].map(() => reasoningChunks(COLLAPSED))
    const test = harness(script, agent)
    installReasoningCollapseGuard(test.ctx, { maxBreaksPerTurn: 2, cooldownMs: 0, now: () => 0 })

    for (let i = 0; i < 4; i++) {
      await run(test, { model: 'm', signal })
      await settle()
    }

    expect(agent.cancels).toHaveLength(2)
  })

  it('gives a fresh turn a fresh budget', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(COLLAPSED), reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { maxBreaksPerTurn: 1, now: () => 0 })

    await run(test, { model: 'm', signal: new AbortController().signal })
    await run(test, { model: 'm', signal: new AbortController().signal })

    expect(agent.cancels).toHaveLength(2)
  })

  it('never fires on healthy long reasoning', async () => {
    for (const [label, text] of [
      ['healthy-long', HEALTHY_LONG],
      ['healthy-prose', HEALTHY_PROSE],
      ['healthy-enumerative', HEALTHY_ENUMERATIVE],
    ] as const) {
      const agent = recordingAgent()
      const test = harness([reasoningChunks(text)], agent)
      installReasoningCollapseGuard(test.ctx, { now: () => 0 })

      const chunks = await run(test, { model: 'm', signal: new AbortController().signal })

      expect(chunks.some(chunk => chunk.type === 'finish'), label).toBe(true)
      expect(agent.cancels, label).toHaveLength(0)
      expect(agent.steers, label).toHaveLength(0)
    }
  })

  it('does not fire on short repetitive reasoning below the minimum window', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(SHORT_REPETITIVE)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    await run(test, { model: 'm', signal: new AbortController().signal })

    expect(agent.cancels).toHaveLength(0)
  })

  it('scores each content block on its own output', async () => {
    const agent = recordingAgent()
    const chunks: GuardChunk[] = [
      { type: 'block-start' },
      ...slices(HEALTHY_LONG).map(part => ({ type: 'reasoning-delta' as const, text: part })),
      { type: 'block-end' },
      { type: 'block-start' },
      ...slices(COLLAPSED).map(part => ({ type: 'reasoning-delta' as const, text: part })),
      { type: 'finish' },
    ]
    const test = harness([chunks], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    await run(test, { model: 'm', signal: new AbortController().signal })

    expect(agent.cancels).toHaveLength(1)
  })

  it('still stops a collapse when the host reports no agent', async () => {
    const test = harness([reasoningChunks(COLLAPSED)])
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    const chunks = await run(test, { model: 'm', signal: new AbortController().signal })

    // Without an agent there is nothing to resume, but the runaway is still cut
    // short rather than left to burn the budget.
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(false)
  })
})
describe('model scope', () => {
  it('ignores models outside includeModels', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { includeModels: ['some-other-model'], now: () => 0 })

    const chunks = await run(test, { model: 'm', signal: new AbortController().signal })

    expect(agent.cancels).toHaveLength(0)
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)
  })

  it('watches every model when includeModels is empty', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    await run(test, { model: 'any-model', signal: new AbortController().signal })

    expect(agent.cancels).toHaveLength(1)
  })
})

describe('cooldown and disposal', () => {
  it('does not stop a second collapse inside the cooldown', async () => {
    const agent = recordingAgent()
    const signal = new AbortController().signal
    const test = harness([reasoningChunks(COLLAPSED), reasoningChunks(COLLAPSED)], agent)
    let clock = 0
    installReasoningCollapseGuard(test.ctx, { cooldownMs: 30_000, now: () => clock })

    await run(test, { model: 'm', signal })
    clock = 1000
    await run(test, { model: 'm', signal })

    expect(agent.cancels).toHaveLength(1)
  })

  it('stops again once the cooldown has elapsed', async () => {
    const agent = recordingAgent()
    const signal = new AbortController().signal
    const test = harness([reasoningChunks(COLLAPSED), reasoningChunks(COLLAPSED)], agent)
    let clock = 0
    installReasoningCollapseGuard(test.ctx, { cooldownMs: 30_000, now: () => clock })

    await run(test, { model: 'm', signal })
    clock = 31_000
    await run(test, { model: 'm', signal })

    expect(agent.cancels).toHaveLength(2)
  })

  it('removes both listeners on disposal', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    const dispose = installReasoningCollapseGuard(test.ctx, { now: () => 0 })!

    expect(test.listeners()).toEqual({ stream: 1, agent: 1 })
    dispose()
    expect(test.listeners()).toEqual({ stream: 0, agent: 0 })

    await run(test, { model: 'm', signal: new AbortController().signal })
    expect(agent.cancels).toHaveLength(0)
  })
})

describe('installation', () => {
  it('is inert when the host exposes no event bus', () => {
    expect(installReasoningCollapseGuard({ logger: { warn: () => undefined } })).toBeUndefined()
  })

  it('leaves a context with neither an event bus nor a logger alone', () => {
    expect(installReasoningCollapseGuard({})).toBeUndefined()
  })

  it('never rewrites the published stream method on a context that has one', async () => {
    // `ctx.llm.stream` is a one-argument method on every supported harness
    // generation. Reassigning it with a two-argument wrapper breaks every
    // caller that dispatches it, because `next` arrives undefined — the
    // exact failure this guard is being fixed for. Installing must leave the
    // published method both same and callable with one argument.
    const runtime = { stream(_options: GuardStreamOptions): AsyncIterable<GuardChunk> {
      return (async function* () { yield { type: 'finish' } as GuardChunk })()
    } }
    const test = harness([reasoningChunks(COLLAPSED)])
    // The published service is not part of the guard's declared surface, so
    // a real Context still carries it at runtime.
    const ctx = { ...test.ctx, llm: runtime } as unknown as ReasoningCollapseContext
    const before = runtime.stream
    installReasoningCollapseGuard(ctx)

    expect(runtime.stream).toBe(before)
    const chunks: GuardChunk[] = []
    for await (const chunk of runtime.stream({ model: 'm' })) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'finish' }])
  })
})

/** The public option type must stay assignable from a plain object literal. */
const _optionsTypecheck: GuardOptions = { threshold: 0.9, includeModels: ['m'] }
void _optionsTypecheck