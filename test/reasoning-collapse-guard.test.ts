import { readFileSync } from 'node:fs'
import { adoptSessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../src/host/common/llm-compat.ts'
import {
  DEFAULT_GUARD_OPTIONS,
  RESUME_HINT,
  RESUME_HINT_STRICT,
  collapseScore,
  distinctSentenceRatio,
  installReasoningCollapseGuard,
  resolveGuardOptions,
  semanticRecurrence,
  splitSentences,
  type GuardAgentEventListener,
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
const PARAPHRASED_LOOP = fixture('paraphrased-loop-reasoning.txt')

interface RecordingAgent extends GuardAgentLike {
  readonly id: string
  readonly cancels: Array<{ cause: unknown; options: unknown }>
  readonly steers: unknown[]
  /** Set by a test to prove a failed resume is reported instead of dropped. */
  steerError?: Error
}

function recordingAgent(id = 'session-a'): RecordingAgent {
  const cancels: Array<{ cause: unknown; options: unknown }> = []
  const steers: unknown[] = []
  // A real method, not an arrow: `steer` reads its own receiver so a test can
  // arm `steerError` on the same object the guard was handed.
  const agent: RecordingAgent = {
    id,
    cancels,
    steers,
    cancel(cause, options) { cancels.push({ cause, options }) },
    steer(message) {
      if (this.steerError !== undefined) throw this.steerError
      steers.push(message)
    },
  }
  return agent
}

/** A loop-built request: it names the session whose Agent owns the stream. */
function turnRequest(
  signal: AbortSignal,
  extra: { model?: string; sessionId?: string; purpose?: string } = {},
): GuardStreamOptions {
  return { model: 'm', sessionId: 'session-a', ...extra, signal }
}

interface HarnessOptions {
  /** Omit the `ctx.agents` service, as a host without the registry would. */
  readonly registry?: boolean
}

interface Harness {
  readonly ctx: ReasoningCollapseContext
  readonly warnings: string[]
  readonly source: () => AsyncIterable<GuardChunk>
  /** Dispatch one `llm/stream` waterfall the way the harness runtime does. */
  readonly dispatch: (options: GuardStreamOptions) => AsyncIterable<GuardChunk>
  /** Number of listeners still registered on each event. */
  readonly listeners: () => { stream: number; agent: number }
  /** Deliver `agent/created` once, at creation, as the harness does. */
  readonly created: (agent: RecordingAgent) => void
  /** Deliver `agent/disposed` once, as the harness does. */
  readonly disposed: (agent: RecordingAgent) => void
}

function harness(
  script: GuardChunk[][],
  agents?: RecordingAgent | RecordingAgent[],
  options: HarnessOptions = {},
): Harness {
  const queue = [...script]
  const warnings: string[] = []
  // Agents handed to the harness already exist: the guard under test is
  // installed after they were created, exactly like a plugin load that follows
  // an open session.
  const live = new Set<RecordingAgent>(agents === undefined ? [] : Array.isArray(agents) ? agents : [agents])
  const streams = new Set<GuardStreamListener>()
  const created = new Set<GuardAgentEventListener>()
  const disposed = new Set<GuardAgentEventListener>()
  const ctx: ReasoningCollapseContext = {
    on(event, listener) {
      if (event === 'llm/stream') {
        const typed = listener as GuardStreamListener
        streams.add(typed)
        return () => { streams.delete(typed) }
      }
      // The harness reports an agent once, when it is created, and never
      // replays it to a listener that subscribes later — so a guard installed
      // after the session started must still resolve that agent another way.
      const lifecycle = event === 'agent/disposed' ? disposed : created
      const typed = listener as GuardAgentEventListener
      lifecycle.add(typed)
      return () => { lifecycle.delete(typed) }
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
    ...options.registry === false ? {} : {
      agents: { get: (id: unknown) => [...live].find(agent => agent.id === id) },
    },
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
    listeners: () => ({ stream: streams.size, agent: created.size + disposed.size }),
    created: (agent: RecordingAgent) => {
      live.add(agent)
      for (const cb of created) cb({ agent })
    },
    disposed: (agent: RecordingAgent) => {
      live.delete(agent)
      for (const cb of disposed) cb({ agent })
    },
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

describe('splitSentences', () => {
  it('breaks on Chinese terminators with nothing after them', () => {
    expect(splitSentences('第一句。第二句！第三句？')).toEqual(['第一句。', '第二句！', '第三句？'])
  })

  it('breaks Latin sentences only on whitespace, so decimals and file names survive', () => {
    expect(splitSentences('Look at selectors.test.ts:745 and the value 3.14 here.')).toEqual([
      'look at selectors.test.ts:745 and the value 3.14 here.',
    ])
    expect(splitSentences('One. Two! Three?')).toEqual(['one.', 'two!', 'three?'])
  })

  it('reads a CJK and Latin mix as one stream', () => {
    expect(splitSentences('先看 selectors.test.ts:745。Then the value 3.14 changes.')).toEqual([
      '先看 selectors.test.ts:745。',
      'then the value 3.14 changes.',
    ])
  })

  it('drops blank segments and folds case and spacing', () => {
    expect(splitSentences('One.   Two.')).toEqual(['one.', 'two.'])
    expect(splitSentences('')).toEqual([])
  })
})

describe('semanticRecurrence', () => {
  /** The trailing window the guard scores, which is not the whole fixture. */
  function tail(text: string, chars = DEFAULT_GUARD_OPTIONS.windowChars): string {
    return text.slice(-chars)
  }

  it('keeps every healthy fixture far below the default semantic threshold', () => {
    for (const [label, text] of [
      ['healthy-long', HEALTHY_LONG],
      ['healthy-prose', HEALTHY_PROSE],
      ['healthy-enumerative', HEALTHY_ENUMERATIVE],
      ['short-repetitive', SHORT_REPETITIVE],
    ] as const) {
      expect(semanticRecurrence(tail(text), 6), label).toBeLessThan(0.35)
    }
  })

  it('peaks far below the threshold on every streaming prefix of a healthy trace', () => {
    // The guard scores every few dozen characters, so the number that matters
    // is the worst prefix, not the final window. A single early spike would
    // fire the signal on text that never repeats at all.
    for (const [label, text] of [
      ['healthy-long', HEALTHY_LONG],
      ['healthy-prose', HEALTHY_PROSE],
      ['healthy-enumerative', HEALTHY_ENUMERATIVE],
    ] as const) {
      let worst = 0
      for (let end = 360; end <= text.length; end += 64) {
        const score = semanticRecurrence(text.slice(Math.max(0, end - 4096), end), 6)
        if (score > worst) worst = score
      }
      expect(worst, label).toBeLessThan(0.35)
    }
  })

  it('sees a verbatim loop and a paraphrased loop alike', () => {
    expect(semanticRecurrence(tail(COLLAPSED), 6)).toBeGreaterThan(0.35)
    expect(semanticRecurrence(tail(PARAPHRASED_LOOP), 6)).toBeGreaterThan(0.35)
  })

  it('reads a list that changes what it reports as recurrence too, which is why it needs a second gate', () => {
    // Measured, not assumed: a list of findings shares one frame and differs in
    // a couple of tokens, which is near-total recurrence by any wording metric.
    // Nothing here can tell that list from a loop on wording alone, which is
    // exactly why recurrence is allowed to vote but never to act by itself —
    // see the guard-level test that a varied list is not cut.
    const dims = ['simplicity', 'maintainability', 'decoupling', 'coverage', 'naming', 'structure']
    const scores = ['92', '88', '95', '71', '84', '90']
    const enumerated = Array.from({ length: 24 }, (_, i) =>
      `Round ${i + 1} judged ${dims[i % 6]} at ${scores[(i * 5) % 6]} for that row.`,
    ).join(' ')
    expect(semanticRecurrence(enumerated, 6)).toBeGreaterThan(0.35)
    // What keeps that list alive is the other signal, not this one.
    expect(collapseScore(enumerated, 8)).toBeLessThan(0.85)
  })

  it('reads the same repetition as recurrence once it is pushed away', () => {
    const moves = [
      'Let me look at the failing assertion one more time.',
      'The pane string is wrong and the test keeps reporting it.',
      'I should check how the pane variable is built before comparing.',
      'The runtime selector resolves to a longer string than expected.',
      'Appending the missing combinator should settle the comparison.',
      'Running the test again will tell us whether that worked.',
    ]
    const looped = Array.from({ length: 12 }, () => moves.join(' ')).join(' ')
    expect(semanticRecurrence(looped, 6)).toBeGreaterThan(0.35)
  })

  it('returns zero below one full lag of sentences', () => {
    expect(semanticRecurrence('One. Two. Three.', 6)).toBe(0)
    expect(semanticRecurrence('', 6)).toBe(0)
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

  it('fails loud on a semantic threshold outside (0, 1)', () => {
    expect(() => resolveGuardOptions({ semanticThreshold: 0 })).toThrow(/invalid semanticThreshold/)
    expect(() => resolveGuardOptions({ semanticThreshold: 1 })).toThrow(/invalid semanticThreshold/)
  })

  it('fails loud on a non-integer or too-small semantic lag', () => {
    expect(() => resolveGuardOptions({ semanticLag: 0 })).toThrow(/invalid semanticLag/)
    expect(() => resolveGuardOptions({ semanticLag: 1.5 })).toThrow(/invalid semanticLag/)
  })

  it('fails loud when the semantic floor exceeds the window', () => {
    expect(() => resolveGuardOptions({ windowChars: 1000, semanticMinChars: 2000 }))
      .toThrow(/must not exceed windowChars/)
  })

  it('fails loud on a semantic minimum below two sentences', () => {
    expect(() => resolveGuardOptions({ semanticMinSentences: 1 })).toThrow(/invalid semanticMinSentences/)
  })

  it('fails loud on a non-positive confirmation count', () => {
    expect(() => resolveGuardOptions({ semanticConfirmations: 0 })).toThrow(/invalid semanticConfirmations/)
  })

  it('keeps an explicit semantic override', () => {
    const resolved = resolveGuardOptions({
      semanticThreshold: 0.6,
      semanticLag: 4,
      semanticMinChars: 200,
      semanticMinSentences: 5,
      semanticConfirmations: 2,
    })
    expect(resolved.semanticThreshold).toBe(0.6)
    expect(resolved.semanticLag).toBe(4)
    expect(resolved.semanticMinChars).toBe(200)
    expect(resolved.semanticMinSentences).toBe(5)
    expect(resolved.semanticConfirmations).toBe(2)
  })

  it('fails loud on a literal floor outside (0, 1)', () => {
    expect(() => resolveGuardOptions({ semanticLiteralFloor: 0 })).toThrow(/invalid semanticLiteralFloor/)
    expect(() => resolveGuardOptions({ semanticLiteralFloor: 1 })).toThrow(/invalid semanticLiteralFloor/)
  })

  it('fails loud on a strict threshold outside (0, 1)', () => {
    expect(() => resolveGuardOptions({ semanticStrictThreshold: 0 })).toThrow(/invalid semanticStrictThreshold/)
    expect(() => resolveGuardOptions({ semanticStrictThreshold: 1 })).toThrow(/invalid semanticStrictThreshold/)
  })

  it('fails loud on a distinct ceiling outside (0, 1)', () => {
    expect(() => resolveGuardOptions({ semanticDistinctCeiling: 0 })).toThrow(/invalid semanticDistinctCeiling/)
    expect(() => resolveGuardOptions({ semanticDistinctCeiling: 1 })).toThrow(/invalid semanticDistinctCeiling/)
  })

  it('fails loud on a non-positive strict confirmation count', () => {
    expect(() => resolveGuardOptions({ semanticStrictConfirmations: 0 })).toThrow(/invalid semanticStrictConfirmations/)
  })

  it('keeps an explicit low-literal override', () => {
    const resolved = resolveGuardOptions({
      semanticLiteralFloor: 0.5,
      semanticStrictThreshold: 0.6,
      semanticDistinctCeiling: 0.4,
      semanticStrictConfirmations: 8,
    })
    expect(resolved.semanticLiteralFloor).toBe(0.5)
    expect(resolved.semanticStrictThreshold).toBe(0.6)
    expect(resolved.semanticDistinctCeiling).toBe(0.4)
    expect(resolved.semanticStrictConfirmations).toBe(8)
  })

  it('holds the low-literal path stricter than the high one under any configuration', () => {
    // Derived rather than validated, so no configuration can flatten the
    // gradient — including the one a caller reaches for when switching a path
    // off by moving the other path's threshold past it.
    for (const options of [
      {},
      { semanticThreshold: 0.9 },
      { semanticConfirmations: 7 },
      { semanticThreshold: 0.999999, semanticConfirmations: 6 },
      { semanticStrictThreshold: 0.2, semanticStrictConfirmations: 1 },
      { threshold: 0.4 },
    ] satisfies GuardOptions[]) {
      const resolved = resolveGuardOptions(options)
      expect(resolved.semanticStrictThreshold, JSON.stringify(options))
        .toBeGreaterThanOrEqual(resolved.semanticThreshold)
      expect(resolved.semanticStrictConfirmations, JSON.stringify(options))
        .toBeGreaterThan(resolved.semanticConfirmations)
      expect(resolved.semanticLiteralFloor, JSON.stringify(options))
        .toBeLessThanOrEqual(resolved.threshold)
    }
  })

  it('empties the low-literal band rather than inverting it', () => {
    // A caller who lowers `threshold` below the shipped floor gets a band that
    // cannot be entered, not a band that swallows the high path.
    const resolved = resolveGuardOptions({ threshold: 0.4 })
    expect(resolved.semanticLiteralFloor).toBe(0.4)
  })
  it('keeps the semantic floor independent of the literal one', () => {
    // The literal floor stays where it has always been and still governs the
    // literal signal, which is what makes the short-reasoning case reachable
    // without changing any existing literal-detection behaviour.
    expect(DEFAULT_GUARD_OPTIONS.minWindowChars).toBe(1500)
    expect(DEFAULT_GUARD_OPTIONS.semanticMinChars).toBeLessThan(DEFAULT_GUARD_OPTIONS.minWindowChars)
    expect(DEFAULT_GUARD_OPTIONS.threshold).toBe(0.85)
    expect(DEFAULT_GUARD_OPTIONS.semanticThreshold).toBeLessThan(DEFAULT_GUARD_OPTIONS.threshold)
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

    const chunks = await run(test, turnRequest(new AbortController().signal, { model: 'test-model' }))

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

    await run(test, turnRequest(new AbortController().signal))
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

    await run(test, turnRequest(new AbortController().signal))
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
      id: 'session-a',
      cancels: [],
      steers: [],
      cancel: (cause, options) => { order.push('cancel'); agent.cancels.push({ cause, options }) },
      steer: (message) => { order.push('steer'); agent.steers.push(message) },
    }
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    const iterator = test.dispatch(turnRequest(new AbortController().signal))

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

    await run(test, turnRequest(signal))
    await settle()
    await run(test, turnRequest(signal))
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
      await run(test, turnRequest(signal))
      await settle()
    }

    expect(agent.cancels).toHaveLength(2)
  })

  it('gives a fresh turn a fresh budget', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(COLLAPSED), reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { maxBreaksPerTurn: 1, now: () => 0 })

    await run(test, turnRequest(new AbortController().signal))
    await run(test, turnRequest(new AbortController().signal))

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

      const chunks = await run(test, turnRequest(new AbortController().signal))

      expect(chunks.some(chunk => chunk.type === 'finish'), label).toBe(true)
      expect(agent.cancels, label).toHaveLength(0)
      expect(agent.steers, label).toHaveLength(0)
    }
  })

  it('does not fire on short repetitive reasoning below the minimum window', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(SHORT_REPETITIVE)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    await run(test, turnRequest(new AbortController().signal))

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

    await run(test, turnRequest(new AbortController().signal))

    expect(agent.cancels).toHaveLength(1)
  })

  it('still stops a collapse when the host reports no agent', async () => {
    const test = harness([reasoningChunks(COLLAPSED)])
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    const chunks = await run(test, turnRequest(new AbortController().signal))

    // Without an agent there is nothing to resume, but the runaway is still cut
    // short rather than left to burn the budget.
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(false)
  })
})

/**
 * One logical answer repeated around a fixed frame, the way a report is
 * written. Recurrence votes for it; the other two signals are what stop it.
 */
function variedList(): string {
  const dims = ['simplicity', 'maintainability', 'decoupling', 'coverage', 'naming', 'structure']
  const scores = ['92', '88', '95', '71', '84', '90']
  return Array.from({ length: 24 }, (_, i) =>
    `Round ${i + 1} judged ${dims[i % 6]} at ${scores[(i * 5) % 6]} for that row.`,
  ).join(' ')
}

describe('dual signal gradient', () => {
  it('stops a paraphrased loop once both signals agree on consecutive windows', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(PARAPHRASED_LOOP)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    const chunks = await run(test, turnRequest(new AbortController().signal))

    // The fixture loops in paraphrase long before it repeats verbatim, so the
    // semantic signal sees it first and the literal one only later.
    expect(semanticRecurrence(PARAPHRASED_LOOP.slice(1200, 3200), 6)).toBeGreaterThan(0.35)
    expect(collapseScore(PARAPHRASED_LOOP.slice(1200, 3200), 8)).toBeLessThan(0.85)
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(false)
    expect(agent.cancels).toHaveLength(1)
    expect(test.warnings.join(' ')).toContain('stopped degenerate reasoning')
  })

  it('reports a paraphrase loop the low-literal path is not cleared for', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(paraphraseLoop())], agent)
    // The floor is raised past this sample's literal score, so the low path
    // is out of reach, and the score never reaches `threshold` either. What is
    // left is the semantic signal on its own, which is logged and released.
    installReasoningCollapseGuard(test.ctx, { semanticLiteralFloor: 0.99, now: () => 0 })

    const chunks = await run(test, turnRequest(new AbortController().signal))

    const tail = paraphraseLoop().slice(-4096)
    expect(collapseScore(tail, 8)).toBeLessThan(0.85)
    expect(semanticRecurrence(tail, 6)).toBeGreaterThan(0.45)
    expect(test.warnings.join(' ')).toContain('observed the semantic signal alone')
    expect(agent.cancels).toHaveLength(0)
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)
  })

  it('does not act on a varied list that only the semantic signal objects to', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(variedList())], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    const chunks = await run(test, turnRequest(new AbortController().signal))

    // Recurrence is high on this text and the guard still leaves it alone,
    // because the literal signal never agrees. That is the conservative mode
    // doing its job: enumeration looks repetitive and reads as progress.
    expect(semanticRecurrence(variedList(), 6)).toBeGreaterThan(0.35)
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)
    expect(agent.cancels).toHaveLength(0)
    expect(agent.steers).toHaveLength(0)
  })

  it('does not act on the literal signal alone', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    // A recurrence threshold no text reaches, which is exactly what a literal
    // signal on its own would be left with.
    installReasoningCollapseGuard(test.ctx, { semanticThreshold: 0.999999, now: () => 0 })

    const chunks = await run(test, turnRequest(new AbortController().signal))

    expect(collapseScore(COLLAPSED, 8)).toBeGreaterThan(0.85)
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)
    expect(agent.cancels).toHaveLength(0)
    expect(test.warnings.join(' ')).toContain('observed the literal signal alone')
  })

  it('needs the configured number of consecutive windows before it acts', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    // Two confirmations is still more than a single window, and the stream is
    // hundreds of windows long, so this must still stop.
    installReasoningCollapseGuard(test.ctx, { semanticConfirmations: 2, now: () => 0 })

    await run(test, turnRequest(new AbortController().signal))
    await settle()

    expect(agent.cancels).toHaveLength(1)
    expect(test.warnings.join(' ')).toContain('both signals hold in window 1/2')
  })

  it('does not act on a lone confirmed window', async () => {
    const agent = recordingAgent()
    // A stream that collapses, clears, and collapses again: the two bursts are
    // separated by a window in which the signals disagree, so neither streak
    // ever reaches the confirmation count.
    const chatter = 'Thinking about the next step in the plan.\n\n'
    const script = [
      [
        { type: 'block-start' } as GuardChunk,
        ...slices(COLLAPSED.slice(0, 3000)).map(part => ({ type: 'reasoning-delta' as const, text: part })),
        ...slices(chatter.repeat(400)).map(part => ({ type: 'reasoning-delta' as const, text: part })),
        { type: 'finish' } as GuardChunk,
      ],
    ]
    const test = harness(script, agent)
    installReasoningCollapseGuard(test.ctx, { semanticConfirmations: 6, now: () => 0 })

    const chunks = await run(test, turnRequest(new AbortController().signal))

    // The collapse runs for far more windows than the streak requires, so this
    // asserts the opposite of what it looks like: the count is over windows
    // where both signals held, and both must hold this many times in a row.
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(false)
    expect(agent.cancels).toHaveLength(1)
    expect(test.warnings.join(' ')).toContain('both signals hold in window 5/6')
  })

  it('requires the agreeing windows to be consecutive, not merely numerous', async () => {
    const agent = recordingAgent()
    // Three reasoning blocks, each scored on its own output: two of them
    // collapse hard enough for both signals to agree, and the one between
    // them is ordinary work that disagrees.
    const dims = ['simplicity', 'maintainability', 'decoupling', 'coverage', 'naming', 'structure']
    const scores = ['92', '88', '95', '71', '84', '90']
    const ordinary = Array.from({ length: 24 }, (_, i) =>
      `Round ${i + 1} judged ${dims[i % 6]} at ${scores[(i * 5) % 6]} for that row.`,
    ).join(' ')
    const chunks: GuardChunk[] = []
    for (const [index, text] of [COLLAPSED.slice(0, 1700), ordinary, COLLAPSED.slice(0, 1700)].entries()) {
      chunks.push({ type: 'block-start' })
      for (const part of slices(text)) chunks.push({ type: 'reasoning-delta', text: part })
      if (index === 0) chunks.push({ type: 'block-end' })
    }
    chunks.push({ type: 'finish' })
    const test = harness([chunks], agent)
    // Six windows agree across this stream, more than the four this guard is
    // allowed to act on — but they arrive as two runs of three, and a run has
    // to reach the count on its own before anything is stopped.
    installReasoningCollapseGuard(test.ctx, { semanticConfirmations: 4, now: () => 0 })

    const drained = await run(test, turnRequest(new AbortController().signal))

    expect(drained.some(chunk => chunk.type === 'finish')).toBe(true)
    expect(agent.cancels).toHaveLength(0)
    expect(agent.steers).toHaveLength(0)
    const warnings = test.warnings.join(' ')
    // Six windows in which both signals held, split into two runs of three by
    // the ordinary block. Counting them rather than adding them up is the
    // whole assertion: an accumulating counter would reach 4/4 here and stop
    // the stream, so the absence of a fourth window is what proves the reset.
    expect(warnings.match(/both signals hold/g)).toHaveLength(6)
    expect(warnings).toContain('both signals hold in window 3/4')
    expect(warnings).toContain('stopped agreeing after 3 of 4 windows')
    expect(warnings).not.toContain('window 4/4')
  })
  it('scores short reasoning even when the literal gate is still shut', async () => {
    const agent = recordingAgent()
    const moves = [
      'Let me look at the failing assertion again.',
      'The pane string is wrong.',
      'I should check how the pane variable is built.',
      'The resolved selector is longer than expected.',
      'Appending the missing combinator should help.',
      'Running the test again will tell us.',
    ]
    // Four passes of a six-sentence cycle: long enough for recurrence to be
    // measurable, short enough that the literal signal is never computed.
    const shortLoop = Array.from({ length: 24 }, (_, i) => moves[i % moves.length]!).join(' ')
    const test = harness([reasoningChunks(shortLoop)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    await run(test, turnRequest(new AbortController().signal))

    // Far below minWindowChars, so the literal signal was never computed at
    // all. The semantic one has its own floor precisely so that a trace which
    // never emits 1500 characters in one step is still examined.
    expect(shortLoop.length).toBeLessThan(1500)
    expect(semanticRecurrence(shortLoop, 6)).toBeGreaterThan(0.35)
    expect(test.warnings.join(' ')).toContain('observed the semantic signal alone')
    expect(test.warnings.join(' ')).toContain('literal not scored')
    expect(agent.cancels).toHaveLength(0)
  })

  it('keeps the literal floor on the literal signal and the lower floor on the semantic one', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(SHORT_REPETITIVE)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    await run(test, turnRequest(new AbortController().signal))

    // Below semanticMinSentences as well as minWindowChars, so neither signal
    // has anything to say and the guard stays silent rather than guessing.
    expect(splitSentences(SHORT_REPETITIVE).length).toBeLessThan(8)
    expect(test.warnings).toHaveLength(0)
    expect(agent.cancels).toHaveLength(0)
  })
})
/**
 * A model restating the same twelve conclusions in two different sets of
 * words, over and over. At six or more cycles it measures 0.692 literally,
 * which clears the low-literal floor and can never reach `threshold`, so the
 * high-literal path is structurally closed to it.
 *
 * The cycle count is a parameter because the length decides how many windows
 * clear the low-literal bars, and a test that needs the streak to stop short
 * of its confirmation count has to be able to choose that length.
 */
function paraphraseLoop(cycles = 8): string {
    const first = [
      'Let me go back to the selector that the runtime actually resolves.',
      'The value at line 745 keeps disagreeing with the string the helper builds.',
      'So the mismatch is real, and it is not coming from the assertion itself.',
      'The pane variable is supposed to name the sidebar container, nothing more.',
      'That is where the combinator has to be inserted before anything else.',
      'Concatenating the pane with the tail reproduces the resolved selector.',
      'Applying that to the helper should settle the comparison.',
      'Running the test once more will tell us whether the change is correct.',
      'If it still fails I will dump both strings and diff them.',
      'The difference ought to be a single combinator if the markup reads right.',
      'Fixing the helper is still the shortest path to a green run.',
      'Let me make that edit now and re-run the suite.',
    ]
    const second = [
      'Back to the selector the runtime resolves for that assertion.',
      'What line 745 resolves to disagrees with the string the helper assembles.',
      'The mismatch is genuine and it does not originate in the assertion.',
      'The pane variable ought to reference the sidebar container and nothing beyond it.',
      'Which is exactly where the combinator belongs, ahead of everything else.',
      'Joining the pane with the tail reproduces the resolved selector byte for byte.',
      'Making that change in the helper ought to settle the comparison.',
      'Another run of the test shows whether the edit is the right one.',
      'Should it fail again I will print both strings and compare them.',
      'If the markup reads as I think, the difference is a single combinator.',
      'Editing the helper is still the quickest route to a passing run.',
      'I will apply that edit now and re-run the suite.',
    ]
  return Array.from({ length: cycles }, (_, i) => (i % 2 === 0 ? first : second).join(' ')).join(' ')
}

describe('low-literal path', () => {
  it('is a sample the high-literal path cannot reach', () => {
    // Everything below depends on this holding: if the paraphrase cleared
    // `threshold`, every other assertion here would be testing the old path.
    const tail = paraphraseLoop().slice(-4096)
    expect(collapseScore(tail, 8)).toBeGreaterThan(DEFAULT_GUARD_OPTIONS.semanticLiteralFloor)
    expect(collapseScore(tail, 8)).toBeLessThan(DEFAULT_GUARD_OPTIONS.threshold)
    expect(semanticRecurrence(tail, 6)).toBeGreaterThan(DEFAULT_GUARD_OPTIONS.semanticStrictThreshold)
  })

  it('stops a paraphrase loop that the high-literal path is closed to', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(paraphraseLoop())], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    const chunks = await run(test, turnRequest(new AbortController().signal))

    // The log has to name the path, because the two paths have different
    // thresholds and a reader cannot otherwise tell which rule fired.
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(false)
    expect(agent.cancels).toHaveLength(1)
    expect(test.warnings.join(' ')).toContain('stopped degenerate reasoning on the low-literal path')
  })

  it('leaves the high-literal path named as such when that is the one that fires', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    await run(test, turnRequest(new AbortController().signal))
    await settle()

    expect(collapseScore(COLLAPSED.slice(-4096), 8)).toBeGreaterThan(DEFAULT_GUARD_OPTIONS.threshold)
    expect(test.warnings.join(' ')).toContain('stopped degenerate reasoning on the high-literal path')
  })

  it('does not act when the literal score is in the band but the semantic one is not strong enough', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(paraphraseLoop())], agent)
    // The low band is open, and the semantic score clears the high bar, but
    // not the stricter one this path demands.
    installReasoningCollapseGuard(test.ctx, { semanticStrictThreshold: 0.999999, now: () => 0 })

    const chunks = await run(test, turnRequest(new AbortController().signal))

    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)
    expect(agent.cancels).toHaveLength(0)
    expect(test.warnings.join(' ')).not.toContain('low-literal bars hold')
  })

  it('does not act when the semantic score is strong but the literal one is under the floor', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(paraphraseLoop())], agent)
    // The mirror image: strong semantics, and literal evidence the floor
    // refuses. A low score is not a weak score, it is no score.
    installReasoningCollapseGuard(test.ctx, { semanticLiteralFloor: 0.99, now: () => 0 })

    const chunks = await run(test, turnRequest(new AbortController().signal))

    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)
    expect(agent.cancels).toHaveLength(0)
    expect(test.warnings.join(' ')).not.toContain('low-literal bars hold')
  })

  it('waits longer on the low-literal path than on the high one', async () => {
    // The two paths are measured against the same sample, and the difference
    // is the gradient itself rather than an assertion about the defaults.
    const high = DEFAULT_GUARD_OPTIONS.semanticConfirmations
    const low = DEFAULT_GUARD_OPTIONS.semanticStrictConfirmations
    expect(low).toBeGreaterThan(high)

    // A run cleared for the low path but not yet for the high one. The streak
    // passes the high count and keeps going, and nothing is stopped, because
    // the fuse this path carries is the longer one.
    const agent = recordingAgent()
    const test = harness([reasoningChunks(paraphraseLoop(6))], agent)
    installReasoningCollapseGuard(test.ctx, { semanticStrictConfirmations: 25, now: () => 0 })

    const chunks = await run(test, turnRequest(new AbortController().signal))

    const warnings = test.warnings.join(' ')
    expect(warnings).toContain('low-literal bars hold in window 3/25')
    expect(agent.cancels).toHaveLength(0)
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)
  })

  it('does not act on a list whose sentences are all new', async () => {
    // The false positive this path could have introduced. A list reuses its
    // frame as hard as a loop does and scores higher on recurrence, so
    // recurrence cannot save it; the distinct ratio can.
    const agent = recordingAgent()
    const test = harness([reasoningChunks(variedList())], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    const drained = await run(test, turnRequest(new AbortController().signal))

    const tail = variedList().slice(-4096)
    expect(semanticRecurrence(tail, 6)).toBeGreaterThan(DEFAULT_GUARD_OPTIONS.semanticStrictThreshold)
    expect(collapseScore(tail, 8)).toBeGreaterThan(DEFAULT_GUARD_OPTIONS.semanticLiteralFloor)
    // Every line is a sentence that has not been written before, which is
    // what the low path is barred from acting on.
    expect(distinctSentenceRatio(variedList())).toBe(1)
    expect(test.warnings.join(' ')).not.toContain('low-literal bars hold')
    expect(drained.some(chunk => chunk.type === 'finish')).toBe(true)
    expect(agent.cancels).toHaveLength(0)
  })

  it('keeps the healthy fixtures clear of both paths', async () => {
    for (const [label, text] of [
      ['healthy-long', HEALTHY_LONG],
      ['healthy-prose', HEALTHY_PROSE],
      ['healthy-enumerative', HEALTHY_ENUMERATIVE],
    ] as const) {
      const agent = recordingAgent()
      const test = harness([reasoningChunks(text)], agent)
      installReasoningCollapseGuard(test.ctx, { now: () => 0 })

      const drained = await run(test, turnRequest(new AbortController().signal))

      expect(drained.some(chunk => chunk.type === 'finish'), label).toBe(true)
      expect(agent.cancels, label).toHaveLength(0)
      expect(test.warnings.join(' '), label).not.toContain('low-literal bars hold')
    }
  })
})
describe('agent resolution', () => {
  it('resumes the session that owns the stream, not the newest agent', async () => {
    // The reported failure: a host runs one Agent per session plus one per
    // subagent, so "the last agent created" is usually a different
    // conversation. The runaway was cut and the resume went elsewhere, which
    // reads to the user as a turn that simply stops.
    const root = recordingAgent('session-a')
    const child = recordingAgent('session-b')
    const test = harness([reasoningChunks(COLLAPSED)], [root, child])
    // The child is created last, so the fallback map's newest entry is the one
    // that must NOT be addressed.
    test.created(child)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    await run(test, turnRequest(new AbortController().signal))
    await settle()

    expect(root.cancels).toHaveLength(1)
    expect(root.steers).toHaveLength(1)
    expect(child.cancels).toHaveLength(0)
    expect(child.steers).toHaveLength(0)
  })

  it('resumes an agent that already existed when the guard was installed', async () => {
    // `agent/created` fires once per agent and is never replayed, so an agent
    // that started before the plugin loaded can only be found through the
    // registry. Without it the break cut the runaway and resumed nothing.
    const agent = recordingAgent('session-a')
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    await run(test, turnRequest(new AbortController().signal))
    await settle()

    expect(agent.cancels).toHaveLength(1)
    expect(agent.steers).toHaveLength(1)
  })

  it('picks up a registry that only appears after the guard was installed', async () => {
    // A Cordis context throws when a service is not injected yet, so a plugin
    // that loads before the agent registry must still find it later. Reading
    // the registry once at install would have lost it for good.
    const agent = recordingAgent('session-a')
    const test = harness([reasoningChunks(COLLAPSED)], undefined, { registry: false })
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })
    const base = test.ctx as { agents?: unknown }
    expect(base.agents).toBeUndefined()
    base.agents = { get: (id: unknown) => (id === agent.id ? agent : undefined) }

    await run(test, turnRequest(new AbortController().signal))
    await settle()

    expect(agent.steers).toHaveLength(1)
  })

  it('falls back to the agent/created map on a host with no registry', async () => {
    const agent = recordingAgent('session-a')
    const test = harness([reasoningChunks(COLLAPSED)], agent, { registry: false })
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })
    // The guard was installed first, so the map is empty until the agent is
    // announced — the only way a registry-less host can be addressed.
    test.created(agent)

    await run(test, turnRequest(new AbortController().signal))
    await settle()

    expect(agent.steers).toHaveLength(1)
  })

  it('stops resuming an agent the host has disposed', async () => {
    const agent = recordingAgent('session-a')
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })
    test.disposed(agent)

    const chunks = await run(test, turnRequest(new AbortController().signal))
    await settle()

    // A disposed session is not a live one to steer: still cut, never resumed.
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(false)
    expect(agent.cancels).toHaveLength(0)
    expect(agent.steers).toHaveLength(0)
  })

  it('leaves auxiliary calls alone', async () => {
    for (const purpose of ['compaction', 'session-title']) {
      const agent = recordingAgent('session-a')
      const test = harness([reasoningChunks(COLLAPSED)], agent)
      installReasoningCollapseGuard(test.ctx, { now: () => 0 })

      const chunks = await run(test, turnRequest(new AbortController().signal, { purpose }))

      // A one-shot call owns no turn to resume, and truncating it is a hard
      // error rather than a runaway.
      expect(chunks.some(chunk => chunk.type === 'finish'), purpose).toBe(true)
      expect(agent.cancels, purpose).toHaveLength(0)
    }
  })

  it('reports a resume it could not build instead of dropping it', async () => {
    const agent = recordingAgent('session-a')
    agent.steerError = new Error('inbox is sealed')
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    await run(test, turnRequest(new AbortController().signal))
    await settle()

    // The break is already taken; a steer that throws must be reported on top
    // of it, not surface as an unhandled rejection.
    expect(test.warnings.join(' ')).toContain('could not queue the resume')
    expect(test.warnings.join(' ')).toContain('inbox is sealed')
  })

  it('names the session and the failed resume in the log', async () => {
    const owned = harness([reasoningChunks(COLLAPSED)], recordingAgent('session-a'))
    installReasoningCollapseGuard(owned.ctx, { now: () => 0 })
    await run(owned, turnRequest(new AbortController().signal))

    const orphan = harness([reasoningChunks(COLLAPSED)])
    installReasoningCollapseGuard(orphan.ctx, { now: () => 0 })
    await run(orphan, turnRequest(new AbortController().signal, { sessionId: 'session-gone' }))

    expect(owned.warnings.join(' ')).toContain('session session-a')
    expect(owned.warnings.join(' ')).not.toContain('no agent to resume')
    // A break that cannot resume is otherwise indistinguishable from a turn
    // that simply stopped, so the log has to say which one happened.
    expect(orphan.warnings.join(' ')).toContain('session session-gone, no agent to resume')
  })
})
describe('model scope', () => {
  it('ignores models outside includeModels', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { includeModels: ['some-other-model'], now: () => 0 })

    const chunks = await run(test, turnRequest(new AbortController().signal))

    expect(agent.cancels).toHaveLength(0)
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)
  })

  it('watches every model when includeModels is empty', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    installReasoningCollapseGuard(test.ctx, { now: () => 0 })

    await run(test, turnRequest(new AbortController().signal, { model: 'any-model' }))

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

    await run(test, turnRequest(signal))
    clock = 1000
    await run(test, turnRequest(signal))

    expect(agent.cancels).toHaveLength(1)
  })

  it('stops again once the cooldown has elapsed', async () => {
    const agent = recordingAgent()
    const signal = new AbortController().signal
    const test = harness([reasoningChunks(COLLAPSED), reasoningChunks(COLLAPSED)], agent)
    let clock = 0
    installReasoningCollapseGuard(test.ctx, { cooldownMs: 30_000, now: () => clock })

    await run(test, turnRequest(signal))
    clock = 31_000
    await run(test, turnRequest(signal))

    expect(agent.cancels).toHaveLength(2)
  })

  it('removes every listener on disposal', async () => {
    const agent = recordingAgent()
    const test = harness([reasoningChunks(COLLAPSED)], agent)
    const dispose = installReasoningCollapseGuard(test.ctx, { now: () => 0 })!

    // One stream listener plus the two agent lifecycle listeners.
    expect(test.listeners()).toEqual({ stream: 1, agent: 2 })
    dispose()
    expect(test.listeners()).toEqual({ stream: 0, agent: 0 })

    await run(test, turnRequest(new AbortController().signal))
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