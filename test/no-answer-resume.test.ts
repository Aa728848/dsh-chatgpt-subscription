import { describe, expect, it } from 'vitest'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../src/host/common/llm-compat.ts'
import {
  DEFAULT_NO_ANSWER_RESUME_OPTIONS,
  NO_ANSWER_RESUME,
  installNoAnswerResume,
  resolveNoAnswerResumeOptions,
  type NoAnswerResumeContext,
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
  warns: string[]
  infos: string[]
}

function makeHarness(agents: Map<string, ResumeAgentLike>): Harness {
  const listeners: ResumeStreamListener[] = []
  const warns: string[] = []
  const infos: string[] = []
  return {
    ctx: {
      on: (_event, listener) => {
        listeners.push(listener as ResumeStreamListener)
        return () => undefined
      },
      logger: { warn: (message) => warns.push(message), info: (message) => infos.push(message) },
      get: (name) => (name === 'agents' ? { get: (id: unknown) => agents.get(String(id)) } : undefined),
    },
    listener: () => {
      const found = listeners[0]
      if (found === undefined) throw new Error('no llm/stream listener was registered')
      return found
    },
    warns,
    infos,
  }
}

function makeAgent(id: string): { agent: ResumeAgentLike; steered: unknown[]; goIdle: () => void } {
  const steered: unknown[] = []
  let release: () => void = () => undefined
  const idle = new Promise<void>((resolve) => {
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
    goIdle: release,
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
    for (let turn = 0; turn < 3; turn += 1) {
      await run(harness.listener(), ANSWERLESS)
      await settle()
    }
    goIdle()
    await settle()
    expect(steered).toHaveLength(2)
    expect(harness.warns.join(' ')).toContain('gave up after 2 answerless turns in a row')
  })

  it('clears the streak once a turn answers', async () => {
    const { agent, steered, goIdle } = makeAgent(SESSION)
    const harness = makeHarness(new Map([[SESSION, agent]]))
    installNoAnswerResume(harness.ctx, { maxResumes: 2 })
    await run(harness.listener(), ANSWERLESS)
    await run(harness.listener(), ANSWERED)
    await run(harness.listener(), ANSWERLESS)
    await run(harness.listener(), ANSWERLESS)
    goIdle()
    await settle()
    // Three answerless turns, never two in a row: the budget never runs out.
    expect(steered).toHaveLength(3)
    expect(harness.warns).toEqual([])
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
    const dispose = installNoAnswerResume(harness.ctx)
    expect(typeof dispose).toBe('function')
    expect(() => dispose?.()).not.toThrow()
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
