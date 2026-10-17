import { describe, expect, it } from 'vitest'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../src/host/common/llm-compat.ts'
import {
  DEFAULT_NO_ANSWER_RESUME_OPTIONS,
  NO_ANSWER_RESUME,
  installNoAnswerResume,
  resolveNoAnswerResumeOptions,
  type NoAnswerResumeContext,
  type ResumeAgentEventListener,
  type ResumeAgentLike,
  type ResumeChunk,
  type ResumeStreamListener,
  type ResumeStreamOptions,
} from '../src/host/no-answer-resume/index.ts'

const SESSION = 'session-1'

/** The failure the reporting line emits for a turn that produced no answer. */
function answerlessFinish(): ResumeChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: 'PROVIDER_ERROR',
        message: 'MiniMax Code ended the turn without an answer or a tool call — the response stopped before it did anything '
          + '(finishReason: end_turn, stream ended by: message_stop)',
      },
    },
  }
}

/** A reasoning-only response, which is the shape that failure describes. */
const ANSWERLESS: ResumeChunk[] = [
  { type: 'block-start', blockType: 'reasoning' },
  { type: 'reasoning-delta', text: 'Let me read lines 130-160 of the upstream preset.' },
  { type: 'block-end' },
  answerlessFinish(),
]

/** A healthy response that carried text. */
const ANSWERED: ResumeChunk[] = [
  { type: 'block-start', blockType: 'text' },
  { type: 'text-delta', text: 'Done.' },
  { type: 'block-end' },
  { type: 'finish', reason: { kind: 'stop' } },
]

interface Harness {
  ctx: NoAnswerResumeContext
  listener: () => ResumeStreamListener
  /** The registry the hook resolves Agents through, so a test can swap one in. */
  agents: Map<string, ResumeAgentLike>
  /** Deliver `agent/disposed`, as the harness does when a session closes. */
  disposed: (agent: ResumeAgentLike) => void
  /** Listeners still registered on each event. */
  listeners: () => { stream: number; disposed: number }
  warns: string[]
  infos: string[]
}

function makeHarness(agents: Map<string, ResumeAgentLike>): Harness {
  const streams: ResumeStreamListener[] = []
  const disposals: ResumeAgentEventListener[] = []
  const warns: string[] = []
  const infos: string[] = []
  const drop = <T>(list: T[], item: T): (() => void) => () => {
    const at = list.indexOf(item)
    if (at >= 0) list.splice(at, 1)
  }
  return {
    agents,
    ctx: {
      on: (event, listener) => {
        if (event === 'llm/stream') {
          const stream = listener as ResumeStreamListener
          streams.push(stream)
          return drop(streams, stream)
        }
        const disposal = listener as ResumeAgentEventListener
        disposals.push(disposal)
        return drop(disposals, disposal)
      },
      logger: { warn: (message) => warns.push(message), info: (message) => infos.push(message) },
      get: (name) => (name === 'agents' ? { get: (id: unknown) => agents.get(String(id)) } : undefined),
    },
    listener: () => {
      const found = streams[0]
      if (found === undefined) throw new Error('no llm/stream listener was registered')
      return found
    },
    disposed: (agent) => {
      for (const notify of [...disposals]) notify({ agent })
    },
    listeners: () => ({ stream: streams.length, disposed: disposals.length }),
    warns,
    infos,
  }
}

function makeAgent(id: string): { agent: ResumeAgentLike; steered: unknown[]; goIdle: () => void } {
  const steered: unknown[] = []
  let release: () => void = () => undefined
  // Re-armed on every release, because one Agent runs turn after turn: a resume
  // queued by one turn has to reach it before the next turn is allowed to queue
  // a resume of its own.
  let idle = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    agent: {
      id,
      whenIdle: () => idle,
      steer: (message) => {
        steered.push(message)
      },
    },
    steered,
    goIdle: () => {
      release()
      idle = new Promise<void>((resolve) => {
        release = resolve
      })
    },
  }
}

async function run(
  listener: ResumeStreamListener,
  chunks: ResumeChunk[],
  options: ResumeStreamOptions = { sessionId: SESSION },
): Promise<ResumeChunk[]> {
  const seen: ResumeChunk[] = []
  const source = async function* () {
    for (const chunk of chunks) yield chunk
  }
  for await (const chunk of listener(options, source)) seen.push(chunk)
  return seen
}

/** Let every already-queued microtask and promise callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

/** A completed turn that failed for a reason the provider did not describe. */
const TIMEOUT: ResumeChunk[] = [
  { type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT', message: 'the request timed out' } } },
]

/** Run one completed turn and let the resume it queued reach the Agent. */
async function runTurn(
  listener: ResumeStreamListener,
  chunks: ResumeChunk[],
  goIdle: () => void,
  options: ResumeStreamOptions = { sessionId: SESSION },
): Promise<void> {
  await run(listener, chunks, options)
  await settle()
  goIdle()
  await settle()
}

/**
 * Read part of a response and then walk away from it, the way the harness
 * agent-loop does when the user presses Stop: the iterator is closed mid-answer
 * and the finish chunk the stream was about to deliver never arrives.
 */
async function abandon(
  listener: ResumeStreamListener,
  chunks: ResumeChunk[],
  count: number,
  options: ResumeStreamOptions = { sessionId: SESSION },
): Promise<ResumeChunk[]> {
  const seen: ResumeChunk[] = []
  const source = async function* () {
    for (const chunk of chunks) yield chunk
  }
  const iterator = listener(options, source)[Symbol.asyncIterator]()
  for (let i = 0; i < count; i += 1) {
    const next = await iterator.next()
    if (next.done === true) return seen
    seen.push(next.value)
  }
  await iterator.return?.(undefined)
  return seen
}

/** Read part of a response that then fails upstream, mid-answer. */
async function failMidStream(
  listener: ResumeStreamListener,
  chunks: ResumeChunk[],
  count: number,
  options: ResumeStreamOptions = { sessionId: SESSION },
): Promise<ResumeChunk[]> {
  const seen: ResumeChunk[] = []
  const source = async function* () {
    for (const chunk of chunks.slice(0, count)) yield chunk
    throw new Error('upstream reset')
  }
  for await (const chunk of listener(options, source)) seen.push(chunk)
  return seen
}

describe('no-answer resume', () => {
  it('passes every chunk through unchanged', async () => {
    const harness = makeHarness(new Map())
    installNoAnswerResume(harness.ctx)
    expect(await run(harness.listener(), ANSWERED)).toEqual(ANSWERED)
  })

  it('steers one continuation once the Agent is idle', async () => {
    const { agent, steered, goIdle } = makeAgent(SESSION)
    const harness = makeHarness(new Map([[SESSION, agent]]))
    installNoAnswerResume(harness.ctx)

    await run(harness.listener(), ANSWERLESS)
    await settle()
    // A steer spliced in while the turn is still unwinding is never woken,
    // so it would sit unread in the inbox.
    expect(steered).toHaveLength(0)

    goIdle()
    await settle()
    expect(steered).toHaveLength(1)
    const message = steered[0] as { content: { text: string }[]; source: { kind: string } }
    expect(message.content[0]?.text).toBe(NO_ANSWER_RESUME)
    expect(message.source.kind).toBe(PLUGIN_MESSAGE_SOURCE_KIND)
    expect(harness.infos.join(' ')).toContain('resumed attempt 1/2')
  })

  it('leaves a turn that answered alone', async () => {
    const { agent, steered } = makeAgent(SESSION)
    const harness = makeHarness(new Map([[SESSION, agent]]))
    installNoAnswerResume(harness.ctx)
    await run(harness.listener(), ANSWERED)
    await settle()
    expect(steered).toHaveLength(0)
    expect(harness.warns).toEqual([])
  })

  it('leaves an auxiliary call alone even when it ends answerless', async () => {
    const { agent, steered } = makeAgent(SESSION)
    const harness = makeHarness(new Map([[SESSION, agent]]))
    installNoAnswerResume(harness.ctx)
    await run(harness.listener(), ANSWERLESS, { sessionId: SESSION, purpose: 'compaction' })
    await settle()
    expect(steered).toHaveLength(0)
  })

  it('ignores a PROVIDER_ERROR that is not the answerless failure', async () => {
    const { agent, steered } = makeAgent(SESSION)
    const harness = makeHarness(new Map([[SESSION, agent]]))
    installNoAnswerResume(harness.ctx)
    await run(harness.listener(), [
      { type: 'finish', reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: 'upstream refused' } } },
    ])
    await settle()
    expect(steered).toHaveLength(0)
  })

  it('stops after maxResumes answerless turns in a row', async () => {
    const { agent, steered, goIdle } = makeAgent(SESSION)
    const harness = makeHarness(new Map([[SESSION, agent]]))
    installNoAnswerResume(harness.ctx, { maxResumes: 2 })
    // One turn per wake: a session holds a single queued resume, so the Agent
    // goes idle between turns or the third one would never be reached.
    for (let turn = 0; turn < 3; turn += 1) await runTurn(harness.listener(), ANSWERLESS, goIdle)
    expect(steered).toHaveLength(2)
    expect(harness.warns.join(' ')).toContain('gave up after 2 answerless turns in a row')
  })

  it('clears the streak once a turn answers', async () => {
    const { agent, steered, goIdle } = makeAgent(SESSION)
    const harness = makeHarness(new Map([[SESSION, agent]]))
    installNoAnswerResume(harness.ctx, { maxResumes: 2 })
    await runTurn(harness.listener(), ANSWERLESS, goIdle)
    await run(harness.listener(), ANSWERED)
    await runTurn(harness.listener(), ANSWERLESS, goIdle)
    await runTurn(harness.listener(), ANSWERLESS, goIdle)
    // Three answerless turns, never two in a row: the budget never runs out.
    expect(steered).toHaveLength(3)
    expect(harness.warns).toEqual([])
  })

  it('keeps the streak when a stream that already answered is abandoned', async () => {
    const { agent, steered, goIdle } = makeAgent(SESSION)
    const harness = makeHarness(new Map([[SESSION, agent]]))
    installNoAnswerResume(harness.ctx, { maxResumes: 2 })
    await runTurn(harness.listener(), ANSWERLESS, goIdle)
    // Stop pressed mid-answer: the text delta crossed, the finish chunk never
    // did, and the turn proves nothing either way.
    expect(await abandon(harness.listener(), ANSWERED, 2)).toHaveLength(2)
    await runTurn(harness.listener(), ANSWERLESS, goIdle)
    await run(harness.listener(), ANSWERLESS)
    await settle()
    // Had the abandoned stream cleared the streak, this would be a third resume
    // and no give-up at all.
    expect(steered).toHaveLength(2)
    expect(harness.warns.join(' ')).toContain('gave up after 2 answerless turns in a row')
  })

  it('does not spend the budget on an abandoned stream', async () => {
    const { agent, steered, goIdle } = makeAgent(SESSION)
    const harness = makeHarness(new Map([[SESSION, agent]]))
    installNoAnswerResume(harness.ctx, { maxResumes: 2 })
    // The chunks look like the answerless turn right up to the one the caller
    // walked away from.
    expect(await abandon(harness.listener(), ANSWERLESS, 3)).toHaveLength(3)
    await runTurn(harness.listener(), ANSWERLESS, goIdle)
    await runTurn(harness.listener(), ANSWERLESS, goIdle)
    expect(steered).toHaveLength(2)
    // Only the third completed answerless turn finds the budget spent.
    await run(harness.listener(), ANSWERLESS)
    await settle()
    expect(harness.warns.join(' ')).toContain('gave up after 2 answerless turns in a row')
  })

  it('ends the streak on a completed turn that neither answered nor went answerless', async () => {
    const { agent, steered, goIdle } = makeAgent(SESSION)
    const harness = makeHarness(new Map([[SESSION, agent]]))
    installNoAnswerResume(harness.ctx, { maxResumes: 2 })
    await runTurn(harness.listener(), ANSWERLESS, goIdle)
    await run(harness.listener(), TIMEOUT)
    await runTurn(harness.listener(), ANSWERLESS, goIdle)
    await runTurn(harness.listener(), ANSWERLESS, goIdle)
    await run(harness.listener(), ANSWERLESS)
    await settle()
    // The timeout broke the run, so the three turns after it were never three in
    // a row: all of them are resumed, and only the second adjacent pair is not.
    expect(steered).toHaveLength(3)
    expect(harness.warns.filter((line) => line.includes('gave up'))).toHaveLength(1)
    expect(harness.warns.join(' ')).toContain('gave up after 2 answerless turns in a row')
  })

  it('ignores a stream that throws mid-iteration', async () => {
    const { agent, steered, goIdle } = makeAgent(SESSION)
    const harness = makeHarness(new Map([[SESSION, agent]]))
    installNoAnswerResume(harness.ctx, { maxResumes: 2 })
    await runTurn(harness.listener(), ANSWERLESS, goIdle)
    await expect(failMidStream(harness.listener(), ANSWERED, 2)).rejects.toThrow(/upstream reset/)
    // A thrown response is an interrupted one: it neither resets nor spends,
    // and it is not a give-up worth logging.
    expect(harness.warns).toEqual([])
    await runTurn(harness.listener(), ANSWERLESS, goIdle)
    await run(harness.listener(), ANSWERLESS)
    await settle()
    expect(steered).toHaveLength(2)
    expect(harness.warns.join(' ')).toContain('gave up after 2 answerless turns in a row')
  })

  it('forgets a session state when its Agent is disposed', async () => {
    const first = makeAgent(SESSION)
    const harness = makeHarness(new Map([[SESSION, first.agent]]))
    installNoAnswerResume(harness.ctx, { maxResumes: 1 })
    await runTurn(harness.listener(), ANSWERLESS, first.goIdle)
    await run(harness.listener(), ANSWERLESS)
    await settle()
    expect(first.steered).toHaveLength(1)
    expect(harness.warns.join(' ')).toContain('gave up after 1 answerless turns in a row')

    // The session closes and the same id is opened again. A streak that outlived
    // its Agent would greet the new conversation with an exhausted budget.
    harness.disposed(first.agent)
    const second = makeAgent(SESSION)
    harness.agents.set(SESSION, second.agent)
    await runTurn(harness.listener(), ANSWERLESS, second.goIdle)
    expect(second.steered).toHaveLength(1)
    expect(harness.infos.join(' ')).toContain('resumed attempt 1/1')
  })

  it('does not steer a resume queued before disposal', async () => {
    const { agent, steered, goIdle } = makeAgent(SESSION)
    const harness = makeHarness(new Map([[SESSION, agent]]))
    const dispose = installNoAnswerResume(harness.ctx)
    await run(harness.listener(), ANSWERLESS)
    await settle()
    // Queued on the Agent's idleness, which has not arrived.
    expect(steered).toHaveLength(0)
    dispose?.()
    goIdle()
    await settle()
    expect(steered).toHaveLength(0)
    expect(harness.infos).toEqual([])
    expect(harness.warns).toEqual([])
  })

  it('queues one resume for two turns that settle before the Agent is idle', async () => {
    const { agent, steered, goIdle } = makeAgent(SESSION)
    const harness = makeHarness(new Map([[SESSION, agent]]))
    installNoAnswerResume(harness.ctx)
    await run(harness.listener(), ANSWERLESS)
    await run(harness.listener(), ANSWERLESS)
    await settle()
    expect(steered).toHaveLength(0)
    goIdle()
    await settle()
    // One failure in flight is one continuation: two wakes for it would spend
    // the budget twice and double-steer the same turn boundary.
    expect(steered).toHaveLength(1)
    expect(harness.infos.join(' ')).toContain('resumed attempt 1/2')
  })

  it('warns when the host cannot report idleness', async () => {
    const steered: unknown[] = []
    const agent: ResumeAgentLike = { id: SESSION, steer: (message) => steered.push(message) }
    const harness = makeHarness(new Map([[SESSION, agent]]))
    installNoAnswerResume(harness.ctx)
    await run(harness.listener(), ANSWERLESS)
    await settle()
    expect(steered).toHaveLength(1)
    expect(harness.warns.join(' ')).toContain('cannot report when the Agent is idle')
  })

  it('warns and does not throw when no Agent can be resolved', async () => {
    const harness = makeHarness(new Map())
    installNoAnswerResume(harness.ctx)
    await run(harness.listener(), ANSWERLESS)
    await settle()
    expect(harness.warns.join(' ')).toContain('no Agent to resume')
  })

  it('is inert on a host with no event bus', () => {
    expect(installNoAnswerResume({})).toBeUndefined()
  })

  it('returns a disposer', () => {
    const harness = makeHarness(new Map())
    expect(harness.listeners()).toEqual({ stream: 0, disposed: 0 })
    const dispose = installNoAnswerResume(harness.ctx)
    expect(harness.listeners()).toEqual({ stream: 1, disposed: 1 })
    expect(typeof dispose).toBe('function')
    expect(() => dispose?.()).not.toThrow()
    expect(harness.listeners()).toEqual({ stream: 0, disposed: 0 })
  })
})

describe('no-answer resume options', () => {
  it('fills in the shipped defaults', () => {
    expect(resolveNoAnswerResumeOptions()).toEqual(DEFAULT_NO_ANSWER_RESUME_OPTIONS)
    expect(resolveNoAnswerResumeOptions({})).toEqual(DEFAULT_NO_ANSWER_RESUME_OPTIONS)
  })

  it('keeps an explicit budget and continuation', () => {
    expect(resolveNoAnswerResumeOptions({ maxResumes: 5, text: 'keep going' }))
      .toEqual({ maxResumes: 5, text: 'keep going' })
  })

  it('fails loud on a budget that would disable the hook', () => {
    expect(() => resolveNoAnswerResumeOptions({ maxResumes: 0 })).toThrow(/maxResumes/)
    expect(() => resolveNoAnswerResumeOptions({ maxResumes: 1.5 })).toThrow(/maxResumes/)
  })

  it('fails loud on a continuation with nothing to act on', () => {
    expect(() => resolveNoAnswerResumeOptions({ text: '   ' })).toThrow(/text/)
  })
})
